import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api-client";
import { Card, EmptyState } from "@/components/ledger-ui";
import { MfgBadge, SectionTitle, INPUT_CLS, BTN_PRIMARY, BTN_GHOST, fmtNum, freshKey } from "./workflow-shared";

/** Quality Control: inspections, decisions (hold / release / rework), corrective actions. */
export function QualityTab({ filter }: { filter?: string }) {
  const qc = useQueryClient();
  const batchesQ = useQuery({ queryKey: ["manufacturing-batches"], queryFn: () => api.manufacturing.batches.list(), retry: false });
  const inspQ = useQuery({ queryKey: ["mfg-inspections"], queryFn: () => api.manufacturing.inspections.list(), retry: false });
  const caQ = useQuery({ queryKey: ["mfg-corrective"], queryFn: () => api.manufacturing.correctiveActions.list(), retry: false });
  const batches: any[] = Array.isArray(batchesQ.data) ? batchesQ.data : [];
  const inspections: any[] = Array.isArray(inspQ.data) ? inspQ.data : [];
  const actions: any[] = Array.isArray(caQ.data) ? caQ.data : [];
  const [selectedId, setSelectedId] = useState<string | null>(filter ?? null);
  const reviewable = batches.filter((b) => ["completed", "quality_review", "on_hold", "rework"].includes(b.status) || b.qualityStatus === "Hold");
  const selected = batches.find((b) => b.id === (selectedId ?? filter)) ?? reviewable[0];
  const refresh = () => { qc.invalidateQueries({ queryKey: ["mfg-inspections"] }); qc.invalidateQueries({ queryKey: ["mfg-corrective"] }); qc.invalidateQueries({ queryKey: ["manufacturing-batches"] }); qc.invalidateQueries({ queryKey: ["mfg-workflow"] }); };

  if (batchesQ.isLoading) return <p className="text-sm text-muted-foreground">Loading quality control…</p>;

  return (
    <div className="space-y-4">
      <Card title="Batches awaiting quality decision">
        {reviewable.length === 0 && <p className="text-xs text-muted-foreground">No batches pending review. Completed production appears here — completion never releases stock by itself.</p>}
        <div className="space-y-1">
          {reviewable.map((b) => (
            <button key={b.id} onClick={() => setSelectedId(b.id)}
              className={`flex w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs hover:border-primary/40 ${selected?.id === b.id ? "border-primary/50 bg-primary/[0.04]" : "border-border"}`}>
              <span className="font-bold">{b.batchNumber}</span>
              <MfgBadge value={b.qualityStatus} prefix="Quality" />
              <MfgBadge value={b.status} />
              <span className="text-muted-foreground">Good {fmtNum(b.producedGoodQty)} · Rejects {fmtNum(b.rejectedQty)} · Released {fmtNum(b.releasedQty)}</span>
            </button>
          ))}
        </div>
      </Card>

      {selected && <InspectionPanel key={selected.id} batch={selected} inspections={inspections.filter((i) => i.batchId === selected.id)} onChanged={refresh} />}

      <Card title={`Corrective actions (${actions.length})`}>
        {actions.length === 0 && <EmptyState title="No corrective actions" description="Holds and rework create corrective actions tracked to verification." />}
        <div className="space-y-1.5">
          {actions.slice(0, 20).map((c) => (
            <CorrectiveRow key={c.id} c={c} onChanged={refresh} />
          ))}
        </div>
      </Card>

      {inspections.length > 0 && (
        <Card title={`All inspections (${inspections.length})`}>
          <div className="space-y-1">
            {inspections.slice(0, 20).map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-2 text-xs">
                <MfgBadge value={i.outcome} />
                <span className="font-semibold">{i.batchNumber}</span>
                <span className="text-muted-foreground">Inspected {fmtNum(i.inspectedQty)} · Accepted {fmtNum(i.acceptedQty)} · Rejected {fmtNum(i.rejectedQty)} · Rework {fmtNum(i.reworkQty ?? 0)}</span>
                {i.inspector && <span className="text-muted-foreground">· {String(i.inspector).slice(0, 8)}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function InspectionPanel({ batch, inspections, onChanged }: { batch: any; inspections: any[]; onChanged: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ inspectedQty: "", acceptedQty: "", rejectedQty: "0", reworkQty: "0", defects: "", remarks: "" });
  const [decide, setDecide] = useState({ inspectionId: "", outcome: "released", releaseQty: "", remarks: "", caTitle: "", caAssignee: "" });

  const create = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.manufacturing.inspections.create({
        batchId: batch.id,
        inspectedQty: Number(form.inspectedQty),
        acceptedQty: Number(form.acceptedQty),
        rejectedQty: Number(form.rejectedQty || 0),
        reworkQty: Number(form.reworkQty || 0),
        defectCategories: form.defects.split(",").map((s) => s.trim()).filter(Boolean),
        remarks: form.remarks || null,
      });
      setForm({ inspectedQty: "", acceptedQty: "", rejectedQty: "0", reworkQty: "0", defects: "", remarks: "" });
      setMsg("Inspection recorded (pending decision).");
      onChanged();
    } catch (e: any) { setMsg(e.message || "Failed"); } finally { setBusy(false); }
  };

  const runDecision = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.manufacturing.inspections.decide(decide.inspectionId, {
        outcome: decide.outcome,
        releaseQty: decide.releaseQty ? Number(decide.releaseQty) : null,
        remarks: decide.remarks || undefined,
        idempotencyKey: freshKey(),
      });
      if ((decide.outcome === "hold" || decide.outcome === "rework") && decide.caTitle.trim()) {
        await api.manufacturing.correctiveActions.create({
          batchId: batch.id,
          inspectionId: decide.inspectionId,
          title: decide.caTitle.trim(),
          assignee: decide.caAssignee || null,
        });
      }
      setMsg(`Decision saved: ${decide.outcome}.`);
      onChanged();
    } catch (e: any) { setMsg(e.message || "Decision failed"); } finally { setBusy(false); }
  };

  return (
    <Card title={`${batch.batchNumber} — quality review`} action={<MfgBadge value={batch.qualityStatus} prefix="Quality" />}>
      <SectionTitle>Record inspection (reconciled against good output {fmtNum(batch.producedGoodQty)})</SectionTitle>
      <div className="grid gap-2 md:grid-cols-4">
        <input type="number" value={form.inspectedQty} onChange={(e) => setForm({ ...form, inspectedQty: e.target.value })} placeholder="Inspected qty" className={INPUT_CLS} />
        <input type="number" value={form.acceptedQty} onChange={(e) => setForm({ ...form, acceptedQty: e.target.value })} placeholder="Accepted qty" className={INPUT_CLS} />
        <input type="number" value={form.rejectedQty} onChange={(e) => setForm({ ...form, rejectedQty: e.target.value })} placeholder="Rejected" className={INPUT_CLS} />
        <input type="number" value={form.reworkQty} onChange={(e) => setForm({ ...form, reworkQty: e.target.value })} placeholder="Rework" className={INPUT_CLS} />
        <input value={form.defects} onChange={(e) => setForm({ ...form, defects: e.target.value })} placeholder="Defect categories (comma separated)" className={`${INPUT_CLS} md:col-span-2`} />
        <input value={form.remarks} onChange={(e) => setForm({ ...form, remarks: e.target.value })} placeholder="Remarks" className={`${INPUT_CLS} md:col-span-2`} />
      </div>
      <button onClick={create} disabled={busy || !form.inspectedQty || !form.acceptedQty} className={`${BTN_PRIMARY} mt-2`}>Record inspection</button>

      {inspections.length > 0 && (
        <div className="mt-4">
          <SectionTitle>Quality decision (quality role required)</SectionTitle>
          <div className="grid gap-2 md:grid-cols-4">
            <select value={decide.inspectionId} onChange={(e) => setDecide({ ...decide, inspectionId: e.target.value })} className={INPUT_CLS}>
              <option value="">Select inspection…</option>
              {inspections.map((i: any) => (
                <option key={i.id} value={i.id}>{String(i.createdAt).slice(0, 10)} · acc {i.acceptedQty}/{i.inspectedQty} · {i.outcome}</option>
              ))}
            </select>
            <select value={decide.outcome} onChange={(e) => setDecide({ ...decide, outcome: e.target.value })} className={INPUT_CLS}>
              <option value="released">Released</option>
              <option value="hold">Hold</option>
              <option value="rework">Rework</option>
            </select>
            <input type="number" value={decide.releaseQty} onChange={(e) => setDecide({ ...decide, releaseQty: e.target.value })} placeholder="Release qty (blank = all reconciled)" className={INPUT_CLS} />
            <input value={decide.remarks} onChange={(e) => setDecide({ ...decide, remarks: e.target.value })} placeholder="Decision remarks" className={INPUT_CLS} />
            <input value={decide.caTitle} onChange={(e) => setDecide({ ...decide, caTitle: e.target.value })} placeholder="Corrective action title (for hold/rework)" className={`${INPUT_CLS} md:col-span-2`} />
            <input value={decide.caAssignee} onChange={(e) => setDecide({ ...decide, caAssignee: e.target.value })} placeholder="Corrective owner" className={INPUT_CLS} />
          </div>
          <button onClick={runDecision} disabled={busy || !decide.inspectionId} className={`${BTN_PRIMARY} mt-2`}>Apply decision</button>
          <p className="mt-1 text-[11px] text-muted-foreground">Release is reconciled (≤ accepted, ≤ unreleased good output) and idempotent — retries never double-post stock.</p>
        </div>
      )}
      {msg && <p className="mt-2 text-xs text-muted-foreground">{msg}</p>}
    </Card>
  );
}

export function CorrectiveRow({ c, onChanged }: { c: any; onChanged: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const move = async (to: string) => {
    setMsg(null);
    try { await api.manufacturing.correctiveActions.setStatus(c.id, to); onChanged(); }
    catch (e: any) { setMsg(e.message || "Failed"); }
  };
  const nexts: Record<string, string[]> = { open: ["in_progress"], in_progress: ["done", "open"], done: ["verified", "in_progress"], verified: [] };
  return (
    <div className="rounded-lg border border-border px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <MfgBadge value={c.status} />
        <span className="font-bold">{c.title}</span>
        {c.assignee && <span className="text-muted-foreground">· {c.assignee}</span>}
        {c.dueDate && <span className="text-muted-foreground">· due {String(c.dueDate).slice(0, 10)}</span>}
        <span className="ml-auto flex gap-1">
          {(nexts[c.status] ?? []).map((n) => (
            <button key={n} onClick={() => move(n)} className={BTN_GHOST}>→ {n.replace("_", " ")}</button>
          ))}
        </span>
      </div>
      {c.description && <p className="mt-1 text-muted-foreground">{c.description}</p>}
      {msg && <p className="mt-1 text-red-600">{msg}</p>}
    </div>
  );
}

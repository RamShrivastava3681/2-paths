import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Factory, Plus } from "lucide-react";
import api from "@/lib/api-client";
import { PageHeader, Card, EmptyState, fmtDate } from "@/components/ledger-ui";
import { OverviewTab, OverviewHeader } from "@/components/manufacture/overview-tab";
import { MaterialsTab } from "@/components/manufacture/materials-tab";
import { QualityTab } from "@/components/manufacture/quality-tab";
import { DispatchTab } from "@/components/manufacture/dispatch-tab";
import { TallyTab } from "@/components/manufacture/tally-tab";
import { WorkflowStepper, stepsForBatch, BatchHeadline } from "@/components/manufacture/workflow-stepper";
import { MfgBadge, INPUT_CLS, BTN_PRIMARY, BTN_GHOST, fmtNum, freshKey } from "@/components/manufacture/workflow-shared";

export const Route = createFileRoute("/app/manufacturer-workbench")({
  component: ManufacturerWorkbenchPage,
});

type Tab = "overview" | "batches" | "materials" | "issues" | "quality" | "dispatch" | "tally";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "batches", label: "Batches" },
  { id: "materials", label: "Materials & Planning" },
  { id: "issues", label: "Factory Issues" },
  { id: "quality", label: "Quality Control" },
  { id: "dispatch", label: "Dispatch Readiness" },
  { id: "tally", label: "Tally Export" },
];

function ManufacturerWorkbenchPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [tabFilter, setTabFilter] = useState<string | undefined>(undefined);
  const qc = useQueryClient();

  const goto = (t: string, filter?: string) => {
    setTab((TABS.some((x) => x.id === t) ? t : "overview") as Tab);
    setTabFilter(filter);
  };
  const gotoBatch = (id: string) => {
    setTab("batches");
    setTabFilter(id);
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["manufacturer-overview"] });
    qc.invalidateQueries({ queryKey: ["mfg-workflow"] });
    qc.invalidateQueries({ queryKey: ["manufacturing-batches"] });
    qc.invalidateQueries({ queryKey: ["factory-issues"] });
    qc.invalidateQueries({ queryKey: ["mfg-inspections"] });
    qc.invalidateQueries({ queryKey: ["mfg-corrective"] });
    qc.invalidateQueries({ queryKey: ["mfg-handoffs"] });
    qc.invalidateQueries({ queryKey: ["tally-export-preview"] });
  };

  return (
    <div className="space-y-4">
      <OverviewHeader onRefresh={refresh} />

      <div className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => { setTab(t.id); setTabFilter(undefined); }}
            className={`whitespace-nowrap px-3.5 py-2 text-sm font-semibold ${
              tab === t.id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab onGoto={goto} />}
      {tab === "batches" && <BatchesTab filter={tabFilter} onChanged={refresh} />}
      {tab === "materials" && <MaterialsTab filter={tabFilter} onGotoBatch={gotoBatch} />}
      {tab === "issues" && <IssuesTab filter={tabFilter} onChanged={refresh} />}
      {tab === "quality" && <QualityTab filter={tabFilter} />}
      {tab === "dispatch" && <DispatchTab filter={tabFilter} />}
      {tab === "tally" && <TallyTab filter={tabFilter} />}

      <Card title="Reused trading flows">
        <div className="flex flex-wrap gap-2 text-xs">
          <Link to="/app/sales-orders" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">Sales orders</Link>
          <Link to="/app/purchase-orders" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">Purchase orders</Link>
          <Link to="/app/grn" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">GRNs (stock IN on confirm)</Link>
          <Link to="/app/dispatches" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">Dispatches (stock OUT on confirm)</Link>
          <Link to="/app/products" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">Product catalogue</Link>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Stock rule unchanged: only a confirmed GRN creates stock IN, only a
          confirmed dispatch creates stock OUT. Draft / cancelled documents never count.
          Batch completion and quality release never post inventory directly.
        </p>
      </Card>
    </div>
  );
}

/* ─── Batches ─── */

const NEXTS: Record<string, string[]> = {
  draft: ["planned", "cancelled"],
  planned: ["ready_to_start", "cancelled"],
  ready_to_start: ["in_progress", "on_hold", "cancelled"],
  in_progress: ["completed", "on_hold", "cancelled"],
  completed: ["quality_review"],
  quality_review: ["on_hold", "rework", "rejected", "cancelled"],
  released: ["closed", "on_hold"],
  on_hold: ["in_progress", "ready_to_start", "rework", "quality_review", "cancelled"],
  rework: ["in_progress", "quality_review", "rejected", "cancelled"],
  rejected: ["closed"],
  cancelled: [],
  closed: [],
};

function BatchesTab({ filter, onChanged }: { filter?: string; onChanged: () => void }) {
  const batchesQ = useQuery({
    queryKey: ["manufacturing-batches"],
    queryFn: () => api.manufacturing.batches.list(),
    retry: false,
  });
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(filter && !filter.includes(":") && filter !== "atrisk" ? filter : null);
  const [search, setSearch] = useState(filter && !filter.includes(":") && filter !== "atrisk" ? filter : "");
  const [statusF, setStatusF] = useState(filter && filter.startsWith("status:") ? filter.slice(7) : "");
  const [lineF, setLineF] = useState("");
  const [atRiskOnly, setAtRiskOnly] = useState(filter === "atrisk");

  const batches: any[] = Array.isArray(batchesQ.data) ? batchesQ.data : [];
  const lines = useMemo(() => [...new Set(batches.map((b) => b.lineName).filter(Boolean))], [batches]);
  const filtered = batches.filter((b) => {
    if (statusF && b.status !== statusF) return false;
    if (lineF && b.lineName !== lineF) return false;
    if (atRiskOnly) {
      if (["released", "closed", "cancelled", "rejected"].includes(b.status) || !b.deliveryDate) return false;
      if (new Date(b.deliveryDate).getTime() - Date.now() >= 7 * 86400000) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const hay = `${b.batchNumber} ${b.productName ?? ""} ${b.sku ?? ""} ${b.salesOrderNumber ?? ""} ${b.supervisor ?? ""}`.toLowerCase();
      if (!hay.includes(q) && b.id !== search) return false;
    }
    return true;
  });

  if (batchesQ.isLoading) return <p className="text-sm text-muted-foreground">Loading batches…</p>;
  if (batchesQ.isError) return <EmptyState title="Batches unavailable" description="Could not load manufacturing batches." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search batch, product, order, supervisor…" className={`${INPUT_CLS} w-64`} />
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className={INPUT_CLS}>
          <option value="">All statuses</option>
          {Object.keys(NEXTS).map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
        </select>
        <select value={lineF} onChange={(e) => setLineF(e.target.value)} className={INPUT_CLS}>
          <option value="">All lines</option>
          {lines.map((l: string) => <option key={l} value={l}>{l}</option>)}
        </select>
        <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <input type="checkbox" checked={atRiskOnly} onChange={(e) => setAtRiskOnly(e.target.checked)} className="h-3.5 w-3.5" />
          At risk only
        </label>
        <button onClick={() => setShowCreate((s) => !s)} className={`${BTN_PRIMARY} ml-auto !px-4 !py-2`}>
          <Plus className="mr-1 inline h-4 w-4" /> New batch
        </button>
      </div>
      {showCreate && <CreateBatchForm onDone={() => { setShowCreate(false); onChanged(); }} />}
      {filtered.length === 0 && <EmptyState title="No production batches" description="Create a batch linked to a sales order, product, target quantity and line. Multiple batches may serve one order." />}
      <div className="grid gap-3">
        {filtered.map((b) => (
          <Card
            key={b.id}
            title={`${b.batchNumber} — ${b.productName ?? b.sku ?? "Unnamed product"}`}
            action={
              <button onClick={() => setSelectedId(selectedId === b.id ? null : b.id)} className="text-xs font-semibold text-primary hover:underline">
                {selectedId === b.id ? "Hide details" : "View details"}
              </button>
            }
          >
            <BatchHeadline b={b} />
            {selectedId === b.id && <BatchDetail batchId={b.id} onChanged={onChanged} />}
          </Card>
        ))}
      </div>
    </div>
  );
}

function CreateBatchForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ salesOrderNumber: "", productName: "", sku: "", targetQty: "1000", lineName: "Line 1", supervisor: "", deliveryDate: "", priority: "normal", notes: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api.manufacturing.batches.create({
        salesOrderNumber: form.salesOrderNumber || null,
        productName: form.productName || null,
        sku: form.sku || null,
        targetQty: Number(form.targetQty),
        lineName: form.lineName || null,
        supervisor: form.supervisor || null,
        deliveryDate: form.deliveryDate || null,
        priority: form.priority || null,
        notes: form.notes || null,
      });
      onDone();
    } catch (e: any) { setError(e.message || "Could not create batch"); } finally { setBusy(false); }
  };
  return (
    <Card title="New production batch">
      <div className="grid gap-2.5 md:grid-cols-3">
        {([["salesOrderNumber", "Sales order no.", "SO-XXXXXXXX"], ["productName", "Product name", "e.g. Cotton Shirt (M)"], ["sku", "SKU", "SKU-…"], ["targetQty", "Planned qty", "1000"], ["lineName", "Production line", "Line 1"], ["supervisor", "Supervisor", "Name"], ["deliveryDate", "Delivery date", "YYYY-MM-DD"], ["notes", "Notes", ""]] as const).map(([k, label, ph]) => (
          <label key={k} className="text-xs font-semibold">{label}
            <input value={(form as any)[k]} onChange={set(k)} placeholder={ph} className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-normal" />
          </label>
        ))}
        <label className="text-xs font-semibold">Priority
          <select value={form.priority} onChange={set("priority")} className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-normal">
            <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option>
          </select>
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <button onClick={submit} disabled={busy} className={`${BTN_PRIMARY} mt-3 !px-4 !py-2`}>{busy ? "Creating…" : "Create batch"}</button>
    </Card>
  );
}

function BatchDetail({ batchId, onChanged }: { batchId: string; onChanged: () => void }) {
  const qc = useQueryClient();
  const detailQ = useQuery({ queryKey: ["manufacturing-batch", batchId], queryFn: () => api.manufacturing.batches.get(batchId), retry: false });
  const readinessQ = useQuery({ queryKey: ["mfg-readiness", batchId], queryFn: () => api.manufacturing.batches.readiness(batchId), retry: false });
  const issuesQ = useQuery({ queryKey: ["factory-issues"], queryFn: () => api.manufacturing.issues.list(), retry: false, staleTime: 30_000 });
  const inspQ = useQuery({ queryKey: ["mfg-inspections", batchId], queryFn: () => api.manufacturing.inspections.list(batchId), retry: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [updateForm, setUpdateForm] = useState({ stage: "Dipping", qtyGood: "", qtyRejected: "0", qtyRework: "0", remarks: "" });
  const [allocQty, setAllocQty] = useState("");
  const [relQty, setRelQty] = useState("");
  const [bomLines, setBomLines] = useState<Array<{ productId: string; qtyPerUnit: string; category: string }>>([]);
  const [showBom, setShowBom] = useState(false);

  const refetchAll = () => { detailQ.refetch(); readinessQ.refetch(); inspQ.refetch(); qc.invalidateQueries({ queryKey: ["mfg-workflow"] }); onChanged(); };
  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label); setMsg(null);
    try {
      const r = await fn();
      setMsg(r?.duplicate ? "Duplicate ignored — not double-counted." : "Saved.");
      refetchAll();
    } catch (e: any) { setMsg(e.message || "Action failed"); } finally { setBusy(null); }
  };

  if (detailQ.isLoading) return <p className="mt-3 text-xs text-muted-foreground">Loading details…</p>;
  if (detailQ.isError || !detailQ.data) return <p className="mt-3 text-xs text-red-600">Could not load batch.</p>;
  const b = detailQ.data;
  const updates: any[] = Array.isArray(b.updates) ? b.updates : [];
  const linkedIssues: any[] = (Array.isArray(issuesQ.data) ? issuesQ.data : []).filter((i: any) => i.affectedBatchId === b.id && i.status !== "closed");
  const nexts: string[] = NEXTS[b.status] ?? [];

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      <WorkflowStepper steps={stepsForBatch(b, readinessQ.data)} />
      <p className="rounded-lg bg-muted/60 px-3 py-1.5 text-[11px] text-muted-foreground" title="Dispatch decrements Trading stock; batch allocatedQty is the link and never rewrites released history.">
        Reconciliation: produced ({fmtNum((b.producedGoodQty ?? 0) + (b.rejectedQty ?? 0) + (b.reworkQty ?? 0))}) = good ({fmtNum(b.producedGoodQty)}) + rejected ({fmtNum(b.rejectedQty)}) + rework ({fmtNum(b.reworkQty ?? 0)}) ·
        available ({fmtNum(b.availableQty ?? 0)}) = released ({fmtNum(b.releasedQty)}) − allocated ({fmtNum(b.allocatedQty)}), visible only while Released.
      </p>

      {linkedIssues.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs">
          <span className="font-bold text-red-700">{linkedIssues.length} open issue(s) affect this batch:</span>
          <span className="text-red-600"> {linkedIssues.map((i: any) => `${i.title} (${i.status}${i.severity === "critical" ? ", CRITICAL" : ""})`).join(" · ")}</span>
          <span className="text-red-600"> Resolving an issue never auto-resumes the batch — a supervisor must restart it.</span>
        </div>
      )}

      {/* Lifecycle */}
      <div>
        <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Lifecycle</div>
        <div className="flex flex-wrap gap-1.5">
          {nexts.length === 0 && <span className="text-xs text-muted-foreground">Terminal state ({b.status}).</span>}
          {nexts.map((n) => (
            <button key={n} disabled={busy !== null} onClick={() => run(n, () => api.manufacturing.batches.transition(b.id, n))} className={BTN_GHOST}>
              → {n.replace(/_/g, " ")}
            </button>
          ))}
          <button disabled={busy !== null} onClick={() => run("complete", () => api.manufacturing.batches.complete(b.id))} className={BTN_GHOST}>Complete (→ quality review)</button>
        </div>
      </div>

      {/* Materials / BOM */}
      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Materials</span>
          <MfgBadge value={readinessQ.data?.materialStatus ?? b.materialStatus ?? "blocked"} prefix="Readiness" />
          <button onClick={() => { setShowBom((s) => !s); if (bomLines.length === 0 && Array.isArray(b.bom)) setBomLines(b.bom.map((l: any) => ({ productId: l.productId, qtyPerUnit: String(l.qtyPerUnit), category: l.category ?? "other" }))); }} className="text-xs font-semibold text-primary hover:underline">
            {showBom ? "Hide BOM editor" : "Edit BOM"}
          </button>
        </div>
        {(readinessQ.data?.lines ?? []).length > 0 && (
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {(readinessQ.data.lines as any[]).map((l: any) => (
              <span key={l.productId}>{l.productName ?? l.sku ?? l.productId}: need <b className="font-mono">{fmtNum(l.required)}</b>, have <b className="font-mono">{fmtNum(l.available)}</b>{l.shortage > 0 && <b className="font-mono text-red-600"> · short {fmtNum(l.shortage)}</b>}</span>
            ))}
          </div>
        )}
        {showBom && (
          <div className="space-y-1.5">
            {bomLines.map((l, i) => (
              <div key={i} className="flex flex-wrap gap-1.5">
                <input value={l.productId} onChange={(e) => setBomLines((a) => a.map((x, j) => j === i ? { ...x, productId: e.target.value } : x))} placeholder="Raw product ID" className={`${INPUT_CLS} w-44`} />
                <input type="number" value={l.qtyPerUnit} onChange={(e) => setBomLines((a) => a.map((x, j) => j === i ? { ...x, qtyPerUnit: e.target.value } : x))} placeholder="Qty per unit" className={`${INPUT_CLS} w-28`} />
                <select value={l.category} onChange={(e) => setBomLines((a) => a.map((x, j) => j === i ? { ...x, category: e.target.value } : x))} className={INPUT_CLS}>
                  <option value="fabric">Fabric</option><option value="trim">Trim</option><option value="packaging">Packaging</option><option value="other">Other</option>
                </select>
                <button onClick={() => setBomLines((a) => a.filter((_, j) => j !== i))} className={BTN_GHOST}>Remove</button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <button onClick={() => setBomLines((a) => [...a, { productId: "", qtyPerUnit: "1", category: "other" }])} className={BTN_GHOST}>+ Add line</button>
              <button disabled={busy !== null} onClick={() => run("bom", () => api.manufacturing.batches.setBom(b.id, bomLines.map((l) => ({ productId: l.productId, qtyPerUnit: Number(l.qtyPerUnit), category: l.category }))))} className={BTN_PRIMARY}>Save BOM</button>
            </div>
          </div>
        )}
      </div>

      {/* Production updates */}
      <div>
        <div className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">Production updates ({updates.length})</div>
        <div className="grid gap-1.5 md:grid-cols-5">
          <input value={updateForm.stage} onChange={(e) => setUpdateForm({ ...updateForm, stage: e.target.value })} placeholder="Stage" className={INPUT_CLS} />
          <input type="number" value={updateForm.qtyGood} onChange={(e) => setUpdateForm({ ...updateForm, qtyGood: e.target.value })} placeholder="Good (since last)" className={INPUT_CLS} />
          <input type="number" value={updateForm.qtyRejected} onChange={(e) => setUpdateForm({ ...updateForm, qtyRejected: e.target.value })} placeholder="Rejects" className={INPUT_CLS} />
          <input type="number" value={updateForm.qtyRework} onChange={(e) => setUpdateForm({ ...updateForm, qtyRework: e.target.value })} placeholder="Rework" className={INPUT_CLS} />
          <input value={updateForm.remarks} onChange={(e) => setUpdateForm({ ...updateForm, remarks: e.target.value })} placeholder="Remarks" className={INPUT_CLS} />
        </div>
        <button disabled={busy !== null} onClick={() => run("update", () => api.manufacturing.updates.record({ batchId: b.id, stage: updateForm.stage, qtyGood: Number(updateForm.qtyGood), qtyRejected: Number(updateForm.qtyRejected || 0), qtyRework: Number(updateForm.qtyRework || 0), remarks: updateForm.remarks || null, idempotencyKey: freshKey() }))} className={`${BTN_GHOST} mt-1.5`}>
          {busy === "update" ? "Saving…" : "Record update"}
        </button>
        <div className="mt-2 space-y-1">
          {updates.map((u) => (
            <div key={u.id} className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{u.stage}</span>
              <span>+{u.qtyGood} good</span><span>{u.qtyRejected} rejects</span>{u.qtyRework ? <span>{u.qtyRework} rework</span> : null}
              <span>{u.lineStatus}</span>{u.remarks && <span>“{u.remarks}”</span>}<span>{fmtDate(u.createdAt)}</span>
            </div>
          ))}
          {updates.length === 0 && <p className="text-xs text-muted-foreground">No updates yet.</p>}
        </div>
      </div>

      {/* Quality + release + allocation */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button disabled={busy !== null} onClick={() => run("hold", () => api.manufacturing.batches.hold(b.id))} className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50">Hold</button>
        <span className="inline-flex items-center gap-1 text-xs">
          <input type="number" value={relQty} onChange={(e) => setRelQty(e.target.value)} placeholder="Release qty (blank = all)" className={`${INPUT_CLS} w-40`} />
          <button disabled={busy !== null} onClick={() => run("release", () => api.manufacturing.batches.release(b.id, undefined, relQty ? Number(relQty) : null, freshKey()))} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">Release (quality role)</button>
        </span>
        <span className="inline-flex items-center gap-1 text-xs">
          <input type="number" value={allocQty} onChange={(e) => setAllocQty(e.target.value)} placeholder="Allocate qty" className={`${INPUT_CLS} w-28`} />
          <button disabled={busy !== null || !allocQty} onClick={() => run("allocate", () => api.manufacturing.batches.allocate(b.id, Number(allocQty)))} className={`${BTN_PRIMARY}`}>Allocate</button>
        </span>
      </div>
      {b.qualityStatus !== "Released" && <p className="text-xs text-amber-600">Allocation is blocked while quality is {b.qualityStatus} — only Released stock can be allocated or dispatched.</p>}
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      {(inspQ.data as any[] | undefined)?.length ? (
        <p className="text-xs text-muted-foreground">Inspections: {(inspQ.data as any[]).map((i: any) => `${i.outcome} (acc ${i.acceptedQty}/${i.inspectedQty})`).join(" · ")}</p>
      ) : null}
      {Array.isArray(b.qualityReviews) && b.qualityReviews.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Quality history: </span>
          {b.qualityReviews.map((q: any, i: number) => <span key={i}>{q.from} → {q.to} ({fmtDate(q.at)}){i < b.qualityReviews.length - 1 ? "; " : ""}</span>)}
        </div>
      )}
      {Array.isArray(b.statusHistory) && b.statusHistory.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Audit: </span>
          {b.statusHistory.slice(-8).map((h: any, i: number) => <span key={i}>{h.from} → {h.to} ({fmtDate(h.at)}){i < Math.min(8, b.statusHistory.length) - 1 ? "; " : ""}</span>)}
        </div>
      )}
    </div>
  );
}

/* ─── Factory issues ─── */

function IssuesTab({ filter, onChanged }: { filter?: string; onChanged: () => void }) {
  const qc = useQueryClient();
  const issuesQ = useQuery({ queryKey: ["factory-issues"], queryFn: () => api.manufacturing.issues.list(), retry: false });
  const batchesQ = useQuery({ queryKey: ["manufacturing-batches"], queryFn: () => api.manufacturing.batches.list(), retry: false, staleTime: 30_000 });
  const [form, setForm] = useState({ type: "stoppage", title: "", owner: "", lineName: "", batchId: "", severity: "medium", expectedResolutionAt: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusF, setStatusF] = useState(filter && filter.startsWith("status:") ? filter.slice(7) : "");
  const [overdueOnly, setOverdueOnly] = useState(filter === "overdue");
  const [openOnly, setOpenOnly] = useState(filter === "open");
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      await api.manufacturing.issues.create({
        type: form.type, title: form.title, owner: form.owner || null, lineName: form.lineName || null,
        affectedBatchId: form.batchId || null, severity: form.severity,
        expectedResolutionAt: form.expectedResolutionAt || null,
      });
      setForm({ type: "stoppage", title: "", owner: "", lineName: "", batchId: "", severity: "medium", expectedResolutionAt: "" });
      onChanged();
    } catch (e: any) { setError(e.message || "Could not raise issue"); } finally { setBusy(false); }
  };
  const move = async (id: string, to: string) => {
    setMsg(null);
    try { await api.manufacturing.issues.setStatus(id, to as any); qc.invalidateQueries({ queryKey: ["factory-issues"] }); onChanged(); }
    catch (e: any) { setMsg(e.message || "Failed"); }
  };

  if (issuesQ.isLoading) return <p className="text-sm text-muted-foreground">Loading issues…</p>;
  if (issuesQ.isError) return <EmptyState title="Issues unavailable" description="Could not load factory issues." />;
  const issues: any[] = Array.isArray(issuesQ.data) ? issuesQ.data : [];
  const batches: any[] = Array.isArray(batchesQ.data) ? batchesQ.data : [];
  const isOverdue = (i: any) => i.status !== "closed" && i.expectedResolutionAt && new Date(i.expectedResolutionAt).getTime() < Date.now();
  const shown = issues.filter((i) =>
    (!statusF || i.status === statusF) &&
    (!overdueOnly || isOverdue(i)) &&
    (!openOnly || i.status !== "closed") &&
    (!filter || filter === "open" || filter === "overdue" || filter.startsWith("status:") || i.id === filter || i.affectedBatchId === filter)
  );
  const NEXT_I: Record<string, string[]> = { open: ["assigned", "closed"], assigned: ["in_progress", "closed"], in_progress: ["resolved", "closed"], resolved: ["closed", "in_progress"], closed: [] };

  return (
    <div className="space-y-4">
      <Card title="Raise factory issue">
        <div className="grid gap-2 md:grid-cols-4">
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={INPUT_CLS}>
            <option value="stoppage">Machine breakdown</option><option value="maintenance">Maintenance</option><option value="staffing">Staffing shortage</option><option value="utility">Utility interruption</option><option value="material">Material issue</option>
          </select>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title (e.g. Line-1 conveyor jam)" className={INPUT_CLS} />
          <input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="Owner" className={INPUT_CLS} />
          <input value={form.lineName} onChange={(e) => setForm({ ...form, lineName: e.target.value })} placeholder="Line" className={INPUT_CLS} />
          <select value={form.batchId} onChange={(e) => setForm({ ...form, batchId: e.target.value })} className={INPUT_CLS}>
            <option value="">No batch link…</option>
            {batches.map((b: any) => <option key={b.id} value={b.id}>{b.batchNumber} — {b.productName ?? b.sku}</option>)}
          </select>
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })} className={INPUT_CLS}>
            <option value="low">Severity: low</option><option value="medium">Severity: medium</option><option value="high">Severity: high</option><option value="critical">Severity: critical</option>
          </select>
          <input type="date" value={form.expectedResolutionAt} onChange={(e) => setForm({ ...form, expectedResolutionAt: e.target.value })} className={INPUT_CLS} />
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <button onClick={submit} disabled={busy || !form.title.trim()} className={`${BTN_PRIMARY} mt-2 !px-4 !py-2`}>{busy ? "Raising…" : "Raise issue"}</button>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)} className={INPUT_CLS}>
          <option value="">All states</option><option value="open">Open</option><option value="assigned">Assigned</option><option value="in_progress">In progress</option><option value="resolved">Resolved</option><option value="closed">Closed</option>
        </select>
        <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} className="h-3.5 w-3.5" />
          Open only
        </label>
        <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} className="h-3.5 w-3.5" />
          Overdue only
        </label>
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>

      {shown.length === 0 && <EmptyState title="No factory issues" description="Breakdowns, staffing, utility and material issues appear here with owner, severity and deadline." />}
      {shown.map((i) => (
        <Card key={i.id} title={`${i.title} — ${i.type}`}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <MfgBadge value={i.status} />
            <MfgBadge value={i.severity ?? "medium"} prefix="Severity" />
            {isOverdue(i) && <MfgBadge value="overdue" />}
            {i.owner && <span>Owner: <span className="font-semibold text-foreground">{i.owner}</span></span>}
            {i.lineName && <span>Line: {i.lineName}</span>}
            {i.affectedBatchNumber && <span>Batch: {i.affectedBatchNumber}</span>}
            {i.expectedResolutionAt && <span>Due: {String(i.expectedResolutionAt).slice(0, 10)}</span>}
            <span>{fmtDate(i.createdAt)}</span>
            <span className="ml-auto flex gap-1">
              {(NEXT_I[i.status] ?? []).map((n: string) => (
                <button key={n} onClick={() => move(i.id, n)} className={BTN_GHOST}>→ {n.replace("_", " ")}</button>
              ))}
            </span>
          </div>
          {i.correctiveAction && <p className="mt-1 text-xs">Corrective: {i.correctiveAction}</p>}
          {i.resolutionNotes && <p className="mt-1 text-xs text-muted-foreground">Resolution: {i.resolutionNotes}</p>}
        </Card>
      ))}
    </div>
  );
}

export function FactoryIcon() {
  return <Factory className="h-5 w-5" />;
}

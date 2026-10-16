import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api-client";
import { Card, EmptyState } from "@/components/ledger-ui";
import { MfgBadge, SectionTitle, INPUT_CLS, BTN_PRIMARY, BTN_GHOST, freshKey } from "./workflow-shared";

/** Tally Export + accounting handoffs: prepare, send, retry, cancel — real outcomes only. */
export function TallyTab() {
  const qc = useQueryClient();
  const previewQ = useQuery({ queryKey: ["tally-export-preview"], queryFn: () => api.manufacturing.tallyPreview(), retry: false });
  const hoQ = useQuery({ queryKey: ["mfg-handoffs"], queryFn: () => api.manufacturing.handoffs.list(), retry: false });
  const handoffs: any[] = Array.isArray(hoQ.data) ? hoQ.data : [];
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ kind: "tally", docType: "invoice", docId: "", docNumber: "", batchId: "", customer: "", amount: "", voucherType: "Sales" });
  const refresh = () => { qc.invalidateQueries({ queryKey: ["mfg-handoffs"] }); qc.invalidateQueries({ queryKey: ["mfg-workflow"] }); };

  const prepare = async () => {
    setMsg(null);
    try {
      const r = await api.manufacturing.handoffs.prepare({
        kind: form.kind,
        docType: form.docType,
        docId: form.docId,
        docNumber: form.docNumber || null,
        batchId: form.batchId || null,
        customer: form.customer || null,
        amount: form.amount ? Number(form.amount) : null,
        voucherType: form.voucherType || null,
        idempotencyKey: freshKey(),
      });
      setMsg(r.duplicate ? "Handoff already exists (duplicate ignored)." : `Prepared (${r.status}).`);
      refresh();
    } catch (e: any) { setMsg(e.message || "Failed"); }
  };

  const send = async (id: string, forceFail?: boolean) => {
    setMsg(null);
    try {
      const r = await api.manufacturing.handoffs.send(id, forceFail ? { forceFail: true } : undefined);
      setMsg(r.status === "success" ? `Confirmed ref ${r.externalRef} (SIMULATED).` : `Attempt recorded: ${r.status} — ${r.lastError ?? ""}`);
      refresh();
    } catch (e: any) { setMsg(e.message || "Failed"); }
  };

  const cancel = async (id: string) => {
    setMsg(null);
    try { await api.manufacturing.handoffs.cancel(id); setMsg("Cancelled."); refresh(); }
    catch (e: any) { setMsg(e.message || "Failed"); }
  };

  const p = previewQ.data;

  return (
    <div className="space-y-4">
      <Card
        title="Accounting handoff queue"
        action={<span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Sandbox adapter · always labelled</span>}
      >
        <SectionTitle>Prepare handoff</SectionTitle>
        <div className="grid gap-2 md:grid-cols-4">
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={INPUT_CLS}>
            <option value="tally">Tally voucher</option>
            <option value="irn">IRN</option>
            <option value="ewaybill">E-way bill</option>
          </select>
          <input value={form.docId} onChange={(e) => setForm({ ...form, docId: e.target.value })} placeholder="Document ID (invoice/dispatch)" className={INPUT_CLS} />
          <input value={form.docNumber} onChange={(e) => setForm({ ...form, docNumber: e.target.value })} placeholder="Doc number" className={INPUT_CLS} />
          <input value={form.customer} onChange={(e) => setForm({ ...form, customer: e.target.value })} placeholder="Customer" className={INPUT_CLS} />
          <input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="Amount (e-way bill ≥ ₹50k)" className={INPUT_CLS} />
          <input value={form.batchId} onChange={(e) => setForm({ ...form, batchId: e.target.value })} placeholder="Batch ID (optional)" className={INPUT_CLS} />
          <input value={form.voucherType} onChange={(e) => setForm({ ...form, voucherType: e.target.value })} placeholder="Voucher type" className={INPUT_CLS} />
        </div>
        <button onClick={prepare} disabled={!form.docId} className={`${BTN_PRIMARY} mt-2`}>Prepare</button>

        <div className="mt-3 space-y-1.5">
          {handoffs.length === 0 && <p className="text-xs text-muted-foreground">No handoffs yet. Pending, failed and successful attempts are all tracked with an audit trail.</p>}
          {handoffs.map((h: any) => (
            <div key={h.id} className="rounded-lg border border-border px-3 py-2 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <MfgBadge value={h.status} />
                <span className="font-bold uppercase">{h.kind}</span>
                <span className="font-semibold">{h.docNumber ?? h.docId.slice(0, 8)}</span>
                {h.simulated && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700">Simulated</span>}
                {h.externalRef && <span className="font-mono text-muted-foreground">{h.externalRef}</span>}
                <span className="text-muted-foreground">· {h.attempts} attempt(s)</span>
                <span className="ml-auto flex gap-1">
                  {(h.status === "pending" || h.status === "failed") && (
                    <>
                      <button onClick={() => send(h.id)} className={BTN_PRIMARY}>{h.status === "failed" ? "Retry" : "Send"}</button>
                      <button onClick={() => cancel(h.id)} className={BTN_GHOST}>Cancel</button>
                    </>
                  )}
                </span>
              </div>
              {h.lastError && <p className="mt-1 text-red-600">{h.lastError}</p>}
              {Array.isArray(h.history) && h.history.length > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {h.history.map((x: any, i: number) => (
                    <span key={i}>{x.status} ({String(x.at).slice(0, 16).replace("T", " ")}){i < h.history.length - 1 ? " → " : ""}</span>
                  ))}
                </p>
              )}
            </div>
          ))}
        </div>
        {msg && <p className="mt-2 text-xs text-muted-foreground">{msg}</p>}
      </Card>

      <Card title="Tally export preview (released batches)">
        {previewQ.isLoading && <p className="text-xs text-muted-foreground">Loading preview…</p>}
        {previewQ.isError && <EmptyState title="Preview unavailable" description="Could not load the Tally preview." />}
        {p && (
          <>
            <p className="text-xs text-muted-foreground">
              <span className="mr-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700">{p.simulated ? "Simulated" : "Live-test"}</span>
              {p.label}
            </p>
            {(p.vouchers ?? []).map((v: any) => (
              <div key={v.batchNumber} className="mt-2 flex flex-wrap gap-3 border-b border-border pb-2 text-xs last:border-0">
                <span className="font-semibold">{v.batchNumber}</span>
                <span>{v.productName ?? v.sku}</span>
                <span>Released {v.releasedQty}</span>
                <span>Allocated {v.allocatedQty}</span>
                {v.salesOrderNumber && <span>Order {v.salesOrderNumber}</span>}
              </div>
            ))}
            {(p.vouchers ?? []).length === 0 && <p className="mt-2 text-xs text-muted-foreground">No released batches to hand off yet.</p>}
          </>
        )}
      </Card>
    </div>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api-client";
import { Card, EmptyState } from "@/components/ledger-ui";
import { MfgBadge, SectionTitle, TradeLink, INPUT_CLS, BTN_PRIMARY, BTN_GHOST, fmtNum, freshKey } from "./workflow-shared";

/** Materials & Planning: readiness per batch, reservations, procurement links. */
export function MaterialsTab({ filter, onGotoBatch }: { filter?: string; onGotoBatch: (id: string) => void }) {
  const batchesQ = useQuery({ queryKey: ["manufacturing-batches"], queryFn: () => api.manufacturing.batches.list(), retry: false });
  const batches: any[] = Array.isArray(batchesQ.data) ? batchesQ.data : [];
  const [selectedId, setSelectedId] = useState<string | null>(filter ?? null);
  const active = batches.filter((b) => !["closed", "cancelled", "rejected"].includes(b.status));
  const selected = batches.find((b) => b.id === (selectedId ?? filter)) ?? active.find((b) => (b.totalShortage ?? 0) > 0) ?? active[0];

  if (batchesQ.isLoading) return <p className="text-sm text-muted-foreground">Loading materials…</p>;
  if (batchesQ.isError) return <EmptyState title="Materials unavailable" description="Could not load batches." />;

  return (
    <div className="space-y-4">
      <Card title="Production orders — material readiness">
        {active.length === 0 && <p className="text-xs text-muted-foreground">No active batches. Create one in the Batches tab.</p>}
        <div className="space-y-1">
          {active.map((b) => (
            <button
              key={b.id}
              onClick={() => setSelectedId(b.id)}
              className={`flex w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs hover:border-primary/40 ${selected?.id === b.id ? "border-primary/50 bg-primary/[0.04]" : "border-border"}`}
            >
              <span className="font-bold">{b.batchNumber}</span>
              <span className="text-muted-foreground">{b.productName ?? b.sku}</span>
              <MfgBadge value={b.materialStatus ?? "blocked"} prefix="Materials" />
              <MfgBadge value={b.status} />
              {b.salesOrderNumber && <span className="text-muted-foreground">· {b.salesOrderNumber}</span>}
            </button>
          ))}
        </div>
      </Card>
      {selected && <ReadinessPanel key={selected.id} batch={selected} onGotoBatch={onGotoBatch} />}
    </div>
  );
}

function ReadinessPanel({ batch, onGotoBatch }: { batch: any; onGotoBatch: (id: string) => void }) {
  const rQ = useQuery({ queryKey: ["mfg-readiness", batch.id], queryFn: () => api.manufacturing.batches.readiness(batch.id), retry: false });
  const resQ = useQuery({ queryKey: ["mfg-reservations", batch.id], queryFn: () => api.manufacturing.reservations.list(batch.id), retry: false });
  const [msg, setMsg] = useState<string | null>(null);
  const [resForm, setResForm] = useState({ productId: "", qty: "" });
  const r = rQ.data;
  const lines: any[] = Array.isArray(r?.lines) ? r.lines : [];
  const reservations: any[] = Array.isArray(resQ.data) ? resQ.data : [];

  const reserve = async () => {
    setMsg(null);
    try {
      await api.manufacturing.reservations.create({ batchId: batch.id, productId: resForm.productId, qty: Number(resForm.qty) });
      setResForm({ productId: "", qty: "" });
      setMsg("Reserved.");
      rQ.refetch(); resQ.refetch();
    } catch (e: any) { setMsg(e.message || "Reservation failed"); }
  };
  const releaseRes = async (id: string, consumed: boolean) => {
    setMsg(null);
    try {
      await api.manufacturing.reservations.release(id, consumed);
      setMsg(consumed ? "Marked consumed." : "Reservation released.");
      rQ.refetch(); resQ.refetch();
    } catch (e: any) { setMsg(e.message || "Failed"); }
  };
  void freshKey;

  return (
    <Card
      title={`${batch.batchNumber} — material check`}
      action={<MfgBadge value={r?.materialStatus ?? batch.materialStatus ?? "blocked"} prefix="Decision" />}
    >
      {rQ.isLoading && <p className="text-xs text-muted-foreground">Evaluating required vs available…</p>}
      {rQ.isError && <p className="text-xs text-red-600">Could not compute readiness.</p>}
      {r && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                  <th className="py-1.5 pr-2">Material</th>
                  <th className="py-1.5 pr-2 text-right">Required</th>
                  <th className="py-1.5 pr-2 text-right" title="Physical confirmed stock">Physical</th>
                  <th className="py-1.5 pr-2 text-right">Reserved</th>
                  <th className="py-1.5 pr-2 text-right" title="Usable = physical − reserved (single balance, reservations only mark stock)">Usable</th>
                  <th className="py-1.5 pr-2 text-right">Incoming PO</th>
                  <th className="py-1.5 text-right">Shortage</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.productId} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 pr-2 font-semibold">{l.productName ?? l.sku ?? l.productId} <span className="font-normal text-muted-foreground">· {l.category}</span></td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(l.required)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(l.available)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(l.reserved)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono font-bold">{fmtNum(Math.max(0, Number(l.available || 0) - Number(l.reserved || 0)))}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(l.incoming)}</td>
                    <td className={`py-1.5 text-right font-mono font-bold ${l.shortage > 0 ? "text-red-600" : "text-emerald-600"}`}>{fmtNum(l.shortage)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {lines.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No BOM on this batch — add materials in the Batches tab to evaluate readiness.</p>}
          {(r.totalShortage ?? 0) > 0 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs">
              <span className="font-bold text-amber-800">Shortage of {fmtNum(r.totalShortage)} units.</span>
              <span className="text-amber-700"> Raise a purchase order — stock only increases on confirmed GRN, never on PO creation. </span>
              <span className="mt-1.5 flex gap-1.5">
                <TradeLink to="/app/purchase-orders">Open purchase orders</TradeLink>
                <TradeLink to="/app/grn">Open GRNs</TradeLink>
              </span>
            </div>
          )}
        </>
      )}

      <div className="mt-4">
        <SectionTitle>Reserve material (soft allocation — never moves stock)</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <input value={resForm.productId} onChange={(e) => setResForm({ ...resForm, productId: e.target.value })} placeholder="Raw product ID" className={`${INPUT_CLS} w-44`} />
          <input type="number" value={resForm.qty} onChange={(e) => setResForm({ ...resForm, qty: e.target.value })} placeholder="Qty" className={`${INPUT_CLS} w-24`} />
          <button onClick={reserve} disabled={!resForm.productId || !resForm.qty} className={BTN_PRIMARY}>Reserve</button>
        </div>
        {reservations.length > 0 && (
          <div className="mt-2 space-y-1">
            {reservations.map((rv: any) => (
              <div key={rv.id} className="flex flex-wrap items-center gap-2 text-xs">
                <MfgBadge value={rv.status} />
                <span className="font-semibold">{rv.productId}</span>
                <span className="font-mono">{fmtNum(rv.qty)}</span>
                {rv.status === "active" && (
                  <>
                    <button onClick={() => releaseRes(rv.id, false)} className={BTN_GHOST}>Release</button>
                    <button onClick={() => releaseRes(rv.id, true)} className={BTN_GHOST}>Mark consumed</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {msg && <p className="mt-2 text-xs text-muted-foreground">{msg}</p>}
      <div className="mt-3">
        <button onClick={() => onGotoBatch(batch.id)} className="text-xs font-semibold text-primary hover:underline">Open batch details →</button>
      </div>
    </Card>
  );
}

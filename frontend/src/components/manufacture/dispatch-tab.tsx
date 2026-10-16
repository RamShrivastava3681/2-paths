import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api-client";
import { Card, EmptyState } from "@/components/ledger-ui";
import { MfgBadge, TradeLink, fmtNum } from "./workflow-shared";

/** Dispatch Readiness: released stock vs orders, validated before dispatch. */
export function DispatchTab({ filter }: { filter?: string }) {
  const batchesQ = useQuery({ queryKey: ["manufacturing-batches"], queryFn: () => api.manufacturing.batches.list(), retry: false });
  const dispQ = useQuery({ queryKey: ["goods-dispatches"], queryFn: () => api.goodsDispatches.list(), retry: false, staleTime: 30_000 });
  const batches: any[] = Array.isArray(batchesQ.data) ? batchesQ.data : [];
  const dispatches: any[] = Array.isArray(dispQ.data) ? dispQ.data : [];
  const rows = batches.filter((b) => (b.producedGoodQty ?? 0) > 0 || (b.releasedQty ?? 0) > 0 || b.id === filter);

  if (batchesQ.isLoading) return <p className="text-sm text-muted-foreground">Loading dispatch readiness…</p>;
  if (batchesQ.isError) return <EmptyState title="Readiness unavailable" description="Could not load batches." />;

  return (
    <div className="space-y-4">
      <Card title="Released finished stock by batch">
        {rows.length === 0 && <p className="text-xs text-muted-foreground">No finished output yet. Only released, accepted quantities appear as available — held, pending and rejected stock is excluded.</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="py-1.5 pr-2">Batch</th>
                <th className="py-1.5 pr-2">Order</th>
                <th className="py-1.5 pr-2 text-right">Produced</th>
                <th className="py-1.5 pr-2 text-right">Released</th>
                <th className="py-1.5 pr-2 text-right">Held/pending</th>
                <th className="py-1.5 pr-2 text-right">Rejected</th>
                <th className="py-1.5 pr-2 text-right">Allocated</th>
                <th className="py-1.5 pr-2 text-right">Available</th>
                <th className="py-1.5 text-right">Readiness</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => {
                const held = Math.max(0, (b.producedGoodQty ?? 0) - (b.releasedQty ?? 0));
                const ready = (b.availableQty ?? 0) > 0;
                return (
                  <tr key={b.id} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 pr-2 font-semibold">{b.batchNumber}</td>
                    <td className="py-1.5 pr-2 text-muted-foreground">{b.salesOrderNumber ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(b.producedGoodQty)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(b.releasedQty)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(held)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(b.rejectedQty)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(b.allocatedQty)}</td>
                    <td className="py-1.5 pr-2 text-right font-mono font-bold">{fmtNum(b.availableQty ?? 0)}</td>
                    <td className="py-1.5 text-right">
                      {ready ? <MfgBadge value="ready" prefix="Dispatch" /> : b.qualityStatus === "Hold" || b.status === "on_hold" ? <MfgBadge value="hold" prefix="Blocked" /> : <MfgBadge value="awaiting_inspection" prefix="Waiting" />}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Dispatch validates both eligible released stock and the outstanding order quantity in the Dispatch module.
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <TradeLink to="/app/dispatches">Open dispatches</TradeLink>
          <TradeLink to="/app/sales-orders">Open sales orders</TradeLink>
          <TradeLink to="/app/invoices">Open invoices</TradeLink>
        </div>
      </Card>

      <Card title={`Recent dispatches (${dispatches.length})`}>
        {dispQ.isError && <p className="text-xs text-muted-foreground">Dispatch list unavailable.</p>}
        {dispatches.slice(0, 15).map((x: any) => (
          <div key={x.id} className="flex flex-wrap items-center gap-2 border-b border-border/60 py-1.5 text-xs last:border-0">
            <span className="font-semibold">{x.dispatchNumber ?? x.id.slice(0, 8)}</span>
            <MfgBadge value={x.status ?? "draft"} />
            {x.salesOrderNumber && <span className="text-muted-foreground">Order {x.salesOrderNumber}</span>}
            {x.dispatchDate && <span className="text-muted-foreground">{String(x.dispatchDate).slice(0, 10)}</span>}
          </div>
        ))}
        {dispatches.length === 0 && !dispQ.isError && <p className="text-xs text-muted-foreground">No dispatches yet.</p>}
      </Card>
    </div>
  );
}

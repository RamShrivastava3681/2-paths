import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api-client";
import { PageHeader, Card, EmptyState } from "@/components/ledger-ui";
import { Factory, RefreshCw } from "lucide-react";
import { KpiCard, SectionTitle, MfgBadge, fmtNum, Tone } from "./workflow-shared";

const PIPELINE_LABELS: Record<string, string> = {
  awaiting_materials: "Awaiting materials",
  ready_for_planning: "Ready for planning",
  planned: "Planned",
  in_production: "In production",
  production_completed: "Production completed",
  awaiting_quality: "Awaiting quality",
  quality_hold: "Quality hold",
  released: "Released",
  ready_for_dispatch: "Ready for dispatch",
  dispatched: "Dispatched",
};

const STAGE_TAB: Record<string, string> = {
  awaiting_materials: "materials",
  ready_for_planning: "batches",
  planned: "batches",
  in_production: "batches",
  production_completed: "quality",
  awaiting_quality: "quality",
  quality_hold: "quality",
  released: "dispatch",
  ready_for_dispatch: "dispatch",
  dispatched: "dispatch",
};

export function OverviewTab({ onGoto }: { onGoto: (tab: string, filter?: string) => void }) {
  const wfQ = useQuery({ queryKey: ["mfg-workflow"], queryFn: () => api.manufacturing.workflow(), staleTime: 15_000, retry: false });
  const d = wfQ.data;

  if (wfQ.isLoading) return <p className="text-sm text-muted-foreground">Loading control center…</p>;
  if (wfQ.isError || !d) {
    return <EmptyState title="Control center unavailable" description="Could not load manufacturing workflow data. Check the backend is running." />;
  }
  const k = d.kpis ?? {};
  const attention: any[] = Array.isArray(d.attention) ? d.attention : [];
  const activity: any[] = Array.isArray(d.activity) ? d.activity : [];
  const pipeline: any[] = Array.isArray(d.pipeline) ? d.pipeline : [];

  const kpis: Array<{ label: string; key: string; tab: string; filter?: string; tone?: string }> = [
    { label: "Open batches", key: "openBatches", tab: "batches" },
    { label: "Material shortages", key: "materialShortages", tab: "materials", tone: (k.materialShortages ?? 0) > 0 ? "text-red-600" : undefined },
    { label: "Good output", key: "goodOutput", tab: "batches" },
    { label: "Rejects", key: "rejects", tab: "batches" },
    { label: "Open issues", key: "openIssues", tab: "issues", filter: "open", tone: (k.openIssues ?? 0) > 0 ? "text-amber-600" : undefined },
    { label: "Overdue issues", key: "overdueIssues", tab: "issues", filter: "overdue", tone: (k.overdueIssues ?? 0) > 0 ? "text-red-600" : undefined },
    { label: "Held / pending qty", key: "heldPendingQty", tab: "quality", tone: (k.heldPendingQty ?? 0) > 0 ? "text-amber-600" : undefined },
    { label: "Awaiting review", key: "awaitingReview", tab: "quality", tone: (k.awaitingReview ?? 0) > 0 ? "text-amber-600" : undefined },
    { label: "Released stock", key: "releasedStock", tab: "dispatch", tone: "text-emerald-600" },
    { label: "Ready for dispatch", key: "readyDispatch", tab: "dispatch" },
    { label: "Pending handoffs", key: "pendingHandoffs", tab: "tally", filter: "status:pending" },
    { label: "Failed handoffs", key: "failedHandoffs", tab: "tally", filter: "status:failed", tone: (k.failedHandoffs ?? 0) > 0 ? "text-red-600" : undefined },
    { label: "Orders at risk", key: "atRiskOrders", tab: "batches", filter: "atrisk", tone: (k.atRiskOrders ?? 0) > 0 ? "text-red-600" : undefined },
  ];

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {kpis.map((c) => (
          <KpiCard key={c.label} label={c.label} value={fmtNum(k[c.key])} tone={c.tone} onClick={() => onGoto(c.tab, c.filter)} />
        ))}
      </div>

      <Card title="Production pipeline">
        <div className="flex flex-wrap gap-1.5">
          {pipeline.map((p) => (
            <button
              key={p.stage}
              onClick={() => onGoto(STAGE_TAB[p.stage] ?? "batches")}
              title={`Open ${(PIPELINE_LABELS[p.stage] ?? p.stage)} records`}
              className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs hover:border-primary/40"
            >
              <span className="font-semibold text-foreground">{PIPELINE_LABELS[p.stage] ?? p.stage}</span>
              <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono font-bold text-primary">{p.count}</span>
            </button>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Requires attention (${attention.length})`}>
          {attention.length === 0 && <p className="text-xs text-muted-foreground">Nothing needs action. Shortages, holds, overdue issues and failed handoffs will appear here.</p>}
          <div className="max-h-96 space-y-1.5 overflow-y-auto">
            {attention.slice(0, 20).map((a: any, i: number) => (
              <button
                key={i}
                onClick={() => onGoto(a.link?.tab ?? "batches", a.batchId ?? a.link?.filter)}
                className="block w-full rounded-lg border border-border px-3 py-2 text-left hover:border-primary/40"
              >
                <span className="flex items-center gap-2">
                  <Tone tone={a.severity === "critical" ? "red" : a.severity === "warning" ? "amber" : "blue"}>
                    {a.severity}
                  </Tone>
                  <span className="truncate text-xs font-bold text-foreground">{a.title}</span>
                </span>
                {a.detail && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{a.detail}</span>}
              </button>
            ))}
          </div>
        </Card>

        <Card title="Recent activity">
          {activity.length === 0 && <p className="text-xs text-muted-foreground">No workflow activity yet. Batch moves, issues, quality decisions and handoffs are recorded here.</p>}
          <div className="max-h-96 space-y-1 overflow-y-auto">
            {activity.slice(0, 25).map((e: any, i: number) => (
              <div key={i} className="flex gap-2 border-b border-border/60 py-1.5 text-xs last:border-0">
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{String(e.at ?? "").slice(0, 16).replace("T", " ")}</span>
                <span className="min-w-0">
                  <span className="text-foreground">{e.text}</span>
                  {e.batchNumber && <span className="text-muted-foreground"> · {e.batchNumber}</span>}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <PerformanceSection />
    </div>
  );
}

function PerformanceSection() {
  const q = useQuery({ queryKey: ["manufacturing-batches"], queryFn: () => api.manufacturing.batches.list(), staleTime: 15_000, retry: false });
  const batches: any[] = Array.isArray(q.data) ? q.data : [];
  const rows = batches.filter((b) => Number(b.targetQty) > 0).slice(0, 12);
  if (rows.length === 0) return null;
  return (
    <Card title="Planned vs actual">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              <th className="py-1.5 pr-2">Batch</th>
              <th className="py-1.5 pr-2 text-right">Planned</th>
              <th className="py-1.5 pr-2 text-right">Accepted</th>
              <th className="py-1.5 pr-2 text-right">Rejected</th>
              <th className="py-1.5 pr-2 text-right">Rework</th>
              <th className="py-1.5 pr-2 text-right">Complete</th>
              <th className="py-1.5 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => {
              const p = b.progress ?? { completionPct: 0, accepted: b.producedGoodQty ?? 0, remaining: 0 };
              return (
                <tr key={b.id} className="border-b border-border/60 last:border-0">
                  <td className="py-1.5 pr-2 font-semibold">{b.batchNumber}</td>
                  <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(b.targetQty)}</td>
                  <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(p.accepted ?? b.producedGoodQty)}</td>
                  <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(b.rejectedQty)}</td>
                  <td className="py-1.5 pr-2 text-right font-mono">{fmtNum(b.reworkQty ?? 0)}</td>
                  <td className="py-1.5 pr-2 text-right font-mono font-bold">{p.completionPct ?? 0}%</td>
                  <td className="py-1.5 text-right"><MfgBadge value={b.status} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function OverviewHeader({ onRefresh }: { onRefresh: () => void }) {
  return (
    <PageHeader
      title="Manufacturing"
      description="Orders, materials, batches, issues, quality, stock, accounting and dispatch — one control center."
      icon={<Factory className="h-5 w-5" />}
      actions={
        <button onClick={onRefresh} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
      }
    />
  );
}

import { MfgBadge } from "./workflow-shared";

/** Compact lifecycle tracker: order → materials → production → quality → release → dispatch. */

export type StepState = "done" | "active" | "awaiting" | "blocked" | "hold" | "failed";

export interface FlowStep {
  id: string;
  label: string;
  state: StepState;
  detail?: string | null;
  action?: string | null;
}

const DOT: Record<StepState, string> = {
  done: "bg-emerald-500",
  active: "bg-blue-600",
  awaiting: "bg-slate-300",
  blocked: "bg-red-500",
  hold: "bg-amber-500",
  failed: "bg-red-600",
};

export function stepStateTone(s: StepState): string {
  return s === "done" ? "emerald" : s === "active" ? "blue" : s === "awaiting" ? "slate" : s === "hold" ? "amber" : "red";
}

/** Derive per-batch workflow steps from real batch + readiness state. */
export function stepsForBatch(b: any, readiness?: any): FlowStep[] {
  const st = String(b.status ?? "planned");
  const q = String(b.qualityStatus ?? "Pending");
  const mat = String(b.materialStatus ?? readiness?.materialStatus ?? "blocked");
  const short = Number(readiness?.totalShortage ?? 0);
  const done = (label: string, detail?: string | null): FlowStep => ({ id: label, label, state: "done", detail });
  const terminal = ["cancelled", "rejected", "closed"].includes(st);

  const steps: FlowStep[] = [];
  steps.push(done("Order", b.salesOrderNumber ?? "direct batch"));
  // Material check
  if (mat === "ready") steps.push(done("Material check", "all lines covered"));
  else if (mat === "partial") steps.push({ id: "Material check", label: "Material check", state: "active", detail: `${short} short — partial`, action: "Procure / receive" });
  else if (mat === "awaiting_inspection") steps.push({ id: "Material check", label: "Material check", state: "awaiting", detail: "no BOM yet", action: "Add BOM" });
  else steps.push({ id: "Material check", label: "Material check", state: "blocked", detail: `${short} short`, action: "Procure / receive" });
  // Planning / start
  if (["ready_to_start", "in_progress", "completed", "quality_review", "released", "on_hold", "rework"].includes(st)) steps.push(done("Planning"));
  else if (terminal) steps.push({ id: "Planning", label: "Planning", state: "failed", detail: st });
  else steps.push({ id: "Planning", label: "Planning", state: mat === "ready" ? "active" : "awaiting", action: mat === "ready" ? "Mark ready to start" : "Awaiting materials" });
  // Production
  const prog = b.progress ?? null;
  if (["in_progress", "rework"].includes(st)) steps.push({ id: "Production", label: "Production", state: "active", detail: prog ? `${prog.completionPct}% · ${prog.accepted}/${prog.planned}` : undefined, action: "Record update" });
  else if (["completed", "quality_review", "released", "on_hold"].includes(st) || (b.producedGoodQty ?? 0) > 0) steps.push(done("Production", prog ? `${prog.accepted} accepted · ${prog.rejected} rejected` : undefined));
  else steps.push({ id: "Production", label: "Production", state: "awaiting" });
  // Quality
  if (q === "Released") steps.push(done("Quality review", `released ${b.releasedQty ?? 0}`));
  else if (q === "Hold" || st === "on_hold") steps.push({ id: "Quality review", label: "Quality review", state: "hold", detail: "corrective action + re-review", action: "Inspect / decide" });
  else if (["completed", "quality_review"].includes(st)) steps.push({ id: "Quality review", label: "Quality review", state: "active", detail: "output pending inspection", action: "Inspect" });
  else steps.push({ id: "Quality review", label: "Quality review", state: "awaiting" });
  // Release
  if ((b.releasedQty ?? 0) > 0 && q === "Released") steps.push(done("Stock release", `${b.availableQty ?? 0} available`));
  else steps.push({ id: "Stock release", label: "Stock release", state: q === "Released" ? "active" : "awaiting", action: q === "Released" ? "Release qty" : undefined });
  // Dispatch
  if (st === "released" || st === "closed") steps.push(done("Dispatch", `allocated ${b.allocatedQty ?? 0}`));
  else if ((b.availableQty ?? 0) > 0) steps.push({ id: "Dispatch", label: "Dispatch", state: "active", detail: `${b.availableQty} ready`, action: "Prepare dispatch" });
  else steps.push({ id: "Dispatch", label: "Dispatch", state: "awaiting" });
  return steps;
}

export function WorkflowStepper({ steps, onSelect }: { steps: FlowStep[]; onSelect?: (s: FlowStep) => void }) {
  return (
    <div className="flex items-stretch gap-0 overflow-x-auto pb-1">
      {steps.map((s, i) => (
        <div key={s.id} className="flex min-w-0 flex-1 items-stretch">
          <button
            onClick={() => onSelect?.(s)}
            className="flex min-w-[104px] flex-1 flex-col gap-1 rounded-lg border border-border bg-card px-2.5 py-2 text-left shadow-sm hover:border-primary/40"
            title={s.detail ?? s.label}
          >
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[s.state]}`} />
              <span className="truncate text-[11px] font-bold text-foreground">{s.label}</span>
            </span>
            {s.detail && <span className="truncate text-[10px] text-muted-foreground">{s.detail}</span>}
            {s.action && <span className="truncate text-[10px] font-semibold text-primary">{s.action} →</span>}
          </button>
          {i < steps.length - 1 && <span className="mx-0.5 self-center text-slate-300">›</span>}
        </div>
      ))}
    </div>
  );
}

export function BatchHeadline({ b }: { b: any }) {
  const hist: any[] = Array.isArray(b.statusHistory) ? b.statusHistory : [];
  const last = hist[hist.length - 1];
  const avail = Number(b.availableQty ?? 0);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <MfgBadge value={b.status} prefix="Production" />
      <MfgBadge value={b.qualityStatus} prefix="Quality" />
      <MfgBadge value={b.materialStatus ?? "blocked"} prefix="Materials" />
      <span className="text-muted-foreground">
        Target {b.targetQty} · Good {b.producedGoodQty} · Rejects {b.rejectedQty}
        {b.reworkQty ? ` · Rework ${b.reworkQty}` : ""} · Released {b.releasedQty}
      </span>
      <span
        title="Available = released − allocated (only while Released)"
        className={`rounded-md px-1.5 py-0.5 font-mono font-bold ${avail > 0 ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}
      >
        Available {avail}
      </span>
      {b.salesOrderNumber && <span className="text-muted-foreground">· Order {b.salesOrderNumber}</span>}
      {b.lineName && <span className="text-muted-foreground">· {b.lineName}</span>}
      {b.deliveryDate && <span className="text-muted-foreground">· Due {String(b.deliveryDate).slice(0, 10)}</span>}
      {last && (
        <span className="text-muted-foreground" title={`${last.from} → ${last.to}${last.notes ? ` — ${last.notes}` : ""}`}>
          · Updated by {String(last.by ?? "—").slice(0, 8)} · {String(last.at ?? "").slice(0, 16).replace("T", " ")}
        </span>
      )}
    </div>
  );
}

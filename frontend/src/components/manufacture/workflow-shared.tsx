import { Link } from "@tanstack/react-router";

/** Shared bits for the Manufacturing Control Center (blue/white ERP theme). */

const TONES: Record<string, string> = {
  emerald: "bg-emerald-100 text-emerald-700",
  red: "bg-red-100 text-red-700",
  amber: "bg-amber-100 text-amber-700",
  blue: "bg-blue-100 text-blue-700",
  slate: "bg-slate-100 text-slate-600",
  violet: "bg-violet-100 text-violet-700",
};

export function Tone({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${TONES[tone] ?? TONES.slate}`}>
      {children}
    </span>
  );
}

function toneFor(value: string): string {
  const v = String(value ?? "").toLowerCase();
  if (["released", "closed", "resolved", "success", "ready", "verified", "done"].includes(v)) return "emerald";
  if (["hold", "blocked", "failed", "rejected", "cancelled", "overdue", "critical"].includes(v)) return "red";
  if (["pending", "awaiting_inspection", "partial", "on_hold", "in_progress", "processing", "assigned", "warning", "rework"].includes(v)) return "amber";
  if (["in_progress", "released", "open"].includes(v)) return "blue";
  return "slate";
}

export function MfgBadge({ value, prefix }: { value: string; prefix?: string }) {
  const label = String(value ?? "—").replace(/_/g, " ");
  return <Tone tone={toneFor(String(value))}>{prefix ? `${prefix}: ${label}` : label}</Tone>;
}

export function KpiCard({
  label,
  value,
  unit,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: string;
  onClick?: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className="rounded-xl border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/40 disabled:cursor-default"
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-xl font-bold ${tone ?? "text-foreground"}`}>
        {value}
        {unit && <span className="ml-1 text-xs font-semibold text-muted-foreground">{unit}</span>}
      </div>
    </button>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="text-sm font-bold text-foreground">{children}</h3>
      {action}
    </div>
  );
}

export function TradeLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link to={to} className="rounded-md border border-border px-2.5 py-1.5 text-xs font-semibold hover:bg-muted">
      {children}
    </Link>
  );
}

export function fmtNum(n: any): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString("en-IN") : "0";
}

/** Mint a fresh idempotency key per submission (no double-count on retry). */
export function freshKey(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch { /* fallback */ }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const INPUT_CLS = "rounded-md border border-border px-2 py-1.5 text-xs bg-background";
export const BTN_PRIMARY = "rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50";
export const BTN_GHOST = "rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50";

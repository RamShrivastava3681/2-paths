import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import api from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { BUSINESS_MODE_LS_KEY, useBusinessMode } from "@/lib/business-mode";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Check,
  Factory,
  Loader2,
  Lock,
  Mail,
  ShieldCheck,
  Store,
} from "lucide-react";

export const Route = createFileRoute("/auth")({
  validateSearch: z.object({
    mode: z.enum(["signin", "signup"]).optional(),
    businessType: z.enum(["trading", "manufacturer"]).optional(),
  }),
  component: AuthPage,
});

const PERKS = [
  "Advance against approved invoices in hours",
  "Live customer risk, aging and alerts in real time",
  "Audit-ready accounting built in",
];

const STATS: [string, string][] = [
  ["₹2B+", "Invoices funded"],
  ["48h", "Average advance"],
  ["SOC 2", "Certified platform"],
];

const TRACKS = [
  {
    id: "trading" as const,
    icon: Store,
    title: "Trading",
    tagline: "Buy · Stock · Sell · Collect",
    points: ["Purchase orders, GRNs & suppliers", "Sales orders, dispatches & invoices", "Inventory, forecasting & finance"],
  },
  {
    id: "manufacturer" as const,
    icon: Factory,
    title: "Manufacturer",
    tagline: "Everything in Trading, plus the factory floor",
    points: ["Production batches linked to sales orders", "Live floor updates & factory issues", "Quality hold & release gating dispatch"],
  },
];

const INPUT_CLS =
  "h-11 w-full rounded-lg border border-border bg-input pl-10 pr-3.5 text-sm text-foreground placeholder:text-muted-foreground shadow-sm outline-none transition-all focus:border-primary focus:ring-2 focus:ring-primary/15";

function AuthPage() {
  const { mode: initialMode, businessType: initialTrack } = Route.useSearch();
  const [mode, setMode] = useState<"signin" | "signup">(initialMode ?? "signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [track, setTrack] = useState<"trading" | "manufacturer">(
    initialTrack ??
      (() => {
        try {
          const saved = window.localStorage.getItem(BUSINESS_MODE_LS_KEY);
          return saved === "manufacturer" ? "manufacturer" : "trading";
        } catch {
          return "trading";
        }
      })(),
  );
  const [loading, setLoading] = useState(false);
  const { user, refreshAuth } = useAuth();
  const { setMode: setBusinessMode } = useBusinessMode();
  const navigate = useNavigate();

  // Landing cards deep-link with ?businessType=… — honour it when it changes.
  useEffect(() => {
    if (initialTrack) setTrack(initialTrack);
  }, [initialTrack]);

  const landingFor = (t: "trading" | "manufacturer") =>
    t === "manufacturer" ? "/app/manufacturer-workbench" : "/app/dashboard";

  // Already signed in (e.g. back-button) — jump straight into the workflow.
  useEffect(() => {
    if (user) {
      const resolved: "trading" | "manufacturer" =
        user.businessMode === "trading" || user.businessMode === "manufacturer"
          ? user.businessMode
          : track;
      setBusinessMode(resolved);
      navigate({ to: landingFor(resolved), replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, navigate]);

  const persistTrack = (t: "trading" | "manufacturer") => {
    setTrack(t);
    setBusinessMode(t);
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === "signup") {
        await api.auth.signup({ email, password, companyName, businessType: track });
        persistTrack(track);
        toast.success(
          track === "manufacturer"
            ? "Manufacturer account created. Sign in to open the factory workflow."
            : "Trading account created. Sign in to open the trading workflow.",
        );
        setMode("signin");
      } else {
        // The server sets the session as an httpOnly cookie on success —
        // nothing to store client-side.
        const res = await api.auth.login(email, password);
        const serverMode = (res as any)?.user?.businessMode ?? (res as any)?.businessMode;
        // A tenant locked to one track always wins; a "both" tenant follows
        // the track the user just picked on this screen.
        const resolved: "trading" | "manufacturer" =
          serverMode === "trading" || serverMode === "manufacturer" ? serverMode : track;
        persistTrack(resolved);
        toast.success(
          resolved === "manufacturer" ? "Welcome back. Opening manufacturing." : "Welcome back.",
        );
        // Re-check auth context so AppLayout sees the user immediately
        await refreshAuth();
        navigate({ to: landingFor(resolved), replace: true });
      }
    } catch (err) {
      console.error("[Auth] Login error:", err);
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative grid min-h-screen overflow-hidden md:grid-cols-2">
      {/* ── Left brand panel ── */}
      <div className="relative hidden overflow-hidden border-r border-[#12314f] p-12 md:flex md:flex-col md:justify-between"
        style={{ background: "radial-gradient(90% 45% at 50% 0%, rgba(58,168,255,0.25), transparent 65%), linear-gradient(180deg, #0a2239 0%, #0b2743 55%, #0c2a47 100%)" }}>
        <div className="absolute inset-0 grid-lines opacity-10" aria-hidden />
        <div className="pointer-events-none absolute -left-20 top-1/3 h-72 w-72 rounded-full bg-sky-500/20 blur-3xl" aria-hidden />
        <div className="pointer-events-none absolute -right-16 bottom-10 h-64 w-64 rounded-full bg-blue-600/20 blur-3xl" aria-hidden />

        <Link to="/" className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-b from-sky-400 to-blue-600 text-base font-bold text-white shadow-lg ring-1 ring-white/20">
            W
          </span>
          <span className="leading-tight">
            <span className="block text-[17px] font-bold tracking-tight text-white">Whizunik Command</span>
            <span className="block text-[9px] font-bold uppercase tracking-[0.24em] text-sky-200/70">
              Executive control system
            </span>
          </span>
        </Link>

        <div className="relative">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-xs font-semibold text-sky-100 shadow-sm backdrop-blur">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            Vault access · SOC 2 certified
          </div>
          <h2 className="mt-5 max-w-md text-[36px] font-semibold leading-[1.12] tracking-[-0.02em] text-balance text-white">
            Capital moves at the speed of conviction.
          </h2>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-slate-300">
            Submit invoices, advance against them, and monitor the entire receivables book in one
            room.
          </p>
          <ul className="mt-8 space-y-3">
            {PERKS.map((perk) => (
              <li key={perk} className="flex items-center gap-2.5 text-sm font-medium text-slate-200">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/15 bg-white/10 text-emerald-300">
                  <Check className="h-3 w-3" />
                </span>
                {perk}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            {STATS.map(([value, label]) => (
              <div key={label} className="border-l-2 border-white/20 pl-4">
                <div className="font-mono text-xl font-bold text-white">{value}</div>
                <div className="mt-0.5 text-[11px] font-medium text-slate-400">{label}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex items-center gap-1.5 text-xs text-slate-400">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" /> SOC 2 · ISO 27001 · 256-bit at rest
          </div>
        </div>
      </div>

      {/* ── Right form panel ── */}
      <div className="relative flex items-center justify-center bg-gradient-to-b from-primary/[0.05] to-transparent p-6 md:p-12">
        <div className="w-full max-w-md animate-rise">
          <Link
            to="/"
            className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-muted-foreground shadow-xs transition-all hover:-translate-x-px hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to site
          </Link>

          <div className="rounded-3xl border border-border bg-card p-6 shadow-modal ring-1 ring-black/[0.03] md:p-8">
            {/* Mobile brand */}
            <div className="mb-6 flex items-center gap-2 md:hidden">
              <img
                src="/logo.png"
                alt="Whizunik Command"
                className="h-7 w-auto rounded-md object-contain"
              />
              <span className="text-lg font-semibold tracking-tight">Whizunik Command</span>
            </div>

            <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
              {mode === "signup" ? "Create your account" : "Welcome back"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {mode === "signup"
                ? "Pick your workflow, then create an account to get started."
                : "Pick your workflow to resume where you left off."}
            </p>

            {/* ── Trading | Manufacturer selector ── */}
            <div
              className="mt-6 grid grid-cols-2 gap-3"
              role="radiogroup"
              aria-label="Choose your workflow"
            >
              {TRACKS.map((t) => {
                const active = track === t.id;
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => persistTrack(t.id)}
                    className={`relative rounded-2xl border p-4 text-left transition-all ${
                      active
                        ? "border-primary bg-primary/[0.06] shadow-card ring-2 ring-primary/20"
                        : "border-border bg-background hover:border-primary/40 hover:shadow-card"
                    }`}
                  >
                    {active && (
                      <span className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-xl ${
                        active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      }`}
                    >
                      <Icon className="h-4.5 w-4.5" />
                    </span>
                    <span className="mt-3 block text-sm font-bold text-foreground">{t.title}</span>
                    <span className="mt-0.5 block text-[11px] font-medium leading-snug text-muted-foreground">
                      {t.tagline}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* Selected workflow detail — what this track unlocks */}
            <div className="mt-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
              <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
                {track === "manufacturer" ? "Manufacturer workflow" : "Trading workflow"} includes
              </p>
              <ul className="mt-2 space-y-1.5">
                {(TRACKS.find((t) => t.id === track)?.points ?? []).map((p) => (
                  <li key={p} className="flex items-start gap-2 text-xs font-medium text-foreground">
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" /> {p}
                  </li>
                ))}
              </ul>
            </div>

            <form onSubmit={onSubmit} className="mt-6 space-y-4">
              {mode === "signup" && (
                <Field label="Company name" icon={<Building2 className="h-4 w-4" />}>
                  <input
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    required
                    className={INPUT_CLS}
                    placeholder="Acme Manufacturing"
                  />
                </Field>
              )}
              <Field label="Email" icon={<Mail className="h-4 w-4" />}>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className={INPUT_CLS}
                  placeholder="you@company.com"
                />
              </Field>
              <Field label="Password" icon={<Lock className="h-4 w-4" />}>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={6}
                  className={INPUT_CLS}
                  placeholder="••••••••"
                />
              </Field>

              <button
                disabled={loading}
                type="submit"
                className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {mode === "signup"
                  ? `Create ${track === "manufacturer" ? "manufacturer" : "trading"} account`
                  : `Sign in to ${track === "manufacturer" ? "Manufacturing" : "Trading"}`}
                {!loading && <ArrowRight className="h-4 w-4" />}
              </button>
            </form>

            <div className="mt-6 border-t border-border pt-5 text-center text-sm text-muted-foreground">
              {mode === "signup" ? "Already have an account?" : "New here?"}{" "}
              <button
                onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {mode === "signup" ? "Sign in" : "Create account"}
              </button>
            </div>

            <p className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" /> Protected with 256-bit encryption
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <div className="relative">
        {icon && (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
            {icon}
          </span>
        )}
        {children}
      </div>
    </label>
  );
}

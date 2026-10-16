import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Factory, Plus, RefreshCw } from "lucide-react";
import api from "@/lib/api-client";
import { PageHeader, Card, EmptyState, StatusPill, fmtDate } from "@/components/ledger-ui";

export const Route = createFileRoute("/app/manufacturer-workbench")({
  component: ManufacturerWorkbenchPage,
});

type Tab = "overview" | "batches" | "issues" | "tally";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "batches", label: "Batches" },
  { id: "issues", label: "Factory Issues" },
  { id: "tally", label: "Tally Export" },
];

function ManufacturerWorkbenchPage() {
  const [tab, setTab] = useState<Tab>("overview");
  const qc = useQueryClient();

  const overviewQ = useQuery({
    queryKey: ["manufacturer-overview"],
    queryFn: () => api.manufacturing.overview(),
    staleTime: 15_000,
    retry: false,
  });
  const batchesQ = useQuery({
    queryKey: ["manufacturing-batches"],
    queryFn: () => api.manufacturing.batches.list(),
    enabled: tab === "batches" || tab === "overview",
    retry: false,
  });
  const issuesQ = useQuery({
    queryKey: ["factory-issues"],
    queryFn: () => api.manufacturing.issues.list(),
    enabled: tab === "issues" || tab === "overview",
    retry: false,
  });
  const tallyQ = useQuery({
    queryKey: ["tally-export-preview"],
    queryFn: () => api.manufacturing.tallyPreview(),
    enabled: tab === "tally",
    retry: false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["manufacturer-overview"] });
    qc.invalidateQueries({ queryKey: ["manufacturing-batches"] });
    qc.invalidateQueries({ queryKey: ["factory-issues"] });
    qc.invalidateQueries({ queryKey: ["tally-export-preview"] });
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manufacturing"
        description="Batches, live floor updates, factory issues and quality hold & release — on top of the existing trading flows."
        icon={<Factory className="h-5 w-5" />}
        actions={

          <button
            onClick={refresh}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        }
      />

      {/* In-page tabs (same workbench pattern as Procurement / Sales / Warehouse) */}
      <div className="flex gap-2 border-b border-border pb-px">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-semibold ${
              tab === t.id
                ? "border-b-2 border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <OverviewTab overviewQ={overviewQ} onChanged={refresh} />
      )}
      {tab === "batches" && (
        <BatchesTab batchesQ={batchesQ} onChanged={refresh} />
      )}
      {tab === "issues" && <IssuesTab issuesQ={issuesQ} onChanged={refresh} />}
      {tab === "tally" && <TallyTab tallyQ={tallyQ} />}

      {/* Reused trading flows — deep links, no duplication */}
      <Card title="Reused trading flows">
        <div className="flex flex-wrap gap-2 text-xs">
          <Link to="/app/sales-orders" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">
            Sales orders
          </Link>
          <Link to="/app/purchase-orders" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">
            Purchase orders
          </Link>
          <Link to="/app/grn" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">
            GRNs (stock IN on confirm)
          </Link>
          <Link to="/app/dispatches" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">
            Dispatches (stock OUT on confirm)
          </Link>
          <Link to="/app/products" className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-muted">
            Product catalogue
          </Link>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Stock rule unchanged: only a confirmed GRN creates stock IN, only a
          confirmed dispatch creates stock OUT. Draft / cancelled documents never count.
        </p>
      </Card>
    </div>
  );
}

/* ─── Overview ─── */

function OverviewTab({ overviewQ, onChanged }: { overviewQ: any; onChanged: () => void }) {
  const d = overviewQ.data;
  if (overviewQ.isLoading) return <p className="text-sm text-muted-foreground">Loading overview…</p>;
  if (overviewQ.isError)
    return (
      <EmptyState
        title="Overview unavailable"
        description="Could not load the manufacturer overview. Check the backend is running with the new manufacturing routes."
      />
    );
  void onChanged;
  return (
    <div className="grid gap-4 md:grid-cols-4">
      <StatCard label="Open batches" value={String(d.openBatchCount ?? 0)} to="/app/manufacturer-workbench" />
      <StatCard label="Good output" value={String(d.totalGood ?? 0)} />
      <StatCard label="Rejects" value={String(d.totalRejected ?? 0)} />
      <StatCard label="Open factory issues" value={String(d.openIssueCount ?? 0)} />
      <StatCard label="Held / pending qty" value={String(d.heldQty ?? 0)} tone="text-amber-600" />
      <StatCard label="Released & ready" value={String(d.releasedReady ?? 0)} tone="text-emerald-600" />
    </div>
  );
}

function StatCard({ label, value, to, tone }: { label: string; value: string; to?: string; tone?: string }) {
  const inner = (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${tone ?? "text-foreground"}`}>{value}</div>
    </div>
  );
  return to ? <Link to={to}>{inner}</Link> : inner;
}

/* ─── Batches ─── */

function BatchesTab({ batchesQ, onChanged }: { batchesQ: any; onChanged: () => void }) {
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (batchesQ.isLoading) return <p className="text-sm text-muted-foreground">Loading batches…</p>;
  if (batchesQ.isError)
    return <EmptyState title="Batches unavailable" description="Could not load manufacturing batches." />;
  const batches: any[] = Array.isArray(batchesQ.data) ? batchesQ.data : [];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setShowCreate((s) => !s)}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> New batch
        </button>
      </div>
      {showCreate && <CreateBatchForm onDone={() => { setShowCreate(false); onChanged(); }} />}
      {batches.length === 0 && (
        <EmptyState
          title="No production batches yet"
          description="Create a batch linked to a sales order, product, target quantity and line."
        />
      )}
      <div className="grid gap-4">
        {batches.map((b) => (
          <Card
            key={b.id}
            title={`${b.batchNumber} — ${b.productName ?? b.sku ?? "Unnamed product"}`}
            action={
              <button
                onClick={() => setSelectedId(selectedId === b.id ? null : b.id)}
                className="text-xs font-semibold text-primary hover:underline"
              >
                {selectedId === b.id ? "Hide details" : "View details"}
              </button>
            }
          >
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <StatusPill status={b.status} />
              <span
                className={`rounded-full px-2 py-0.5 font-bold uppercase tracking-wider ${
                  b.qualityStatus === "Released"
                    ? "bg-emerald-100 text-emerald-700"
                    : b.qualityStatus === "Hold"
                      ? "bg-red-100 text-red-700"
                      : "bg-amber-100 text-amber-700"
                }`}
              >
                Quality: {b.qualityStatus}
              </span>
              <span className="text-muted-foreground">
                Target {b.targetQty} · Good {b.producedGoodQty} · Rejects {b.rejectedQty} ·
                Released {b.releasedQty} · Available {b.availableQty}
              </span>
              {b.salesOrderNumber && (
                <span className="text-muted-foreground">· Order {b.salesOrderNumber}</span>
              )}
              {b.lineName && <span className="text-muted-foreground">· {b.lineName}</span>}
            </div>
            {selectedId === b.id && <BatchDetail batchId={b.id} onChanged={onChanged} />}
          </Card>
        ))}
      </div>
    </div>
  );
}

function CreateBatchForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    salesOrderNumber: "",
    productName: "",
    sku: "",
    targetQty: "10000",
    lineName: "Line 1",
    notes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: any) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.manufacturing.batches.create({
        salesOrderNumber: form.salesOrderNumber || null,
        productName: form.productName || null,
        sku: form.sku || null,
        targetQty: Number(form.targetQty),
        lineName: form.lineName || null,
        notes: form.notes || null,
      });
      onDone();
    } catch (e: any) {
      setError(e.message || "Could not create batch");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="New production batch">
      <div className="grid gap-3 md:grid-cols-3">
        <label className="text-xs font-semibold">Sales order no.
          <input value={form.salesOrderNumber} onChange={set("salesOrderNumber")} className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-normal" placeholder="SO-XXXXXXXX" />
        </label>
        <label className="text-xs font-semibold">Product name
          <input value={form.productName} onChange={set("productName")} className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-normal" placeholder="e.g. Latex Gloves (M)" />
        </label>
        <label className="text-xs font-semibold">SKU
          <input value={form.sku} onChange={set("sku")} className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-normal" placeholder="SKU-…" />
        </label>
        <label className="text-xs font-semibold">Target qty
          <input type="number" value={form.targetQty} onChange={set("targetQty")} className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-normal" />
        </label>
        <label className="text-xs font-semibold">Line
          <input value={form.lineName} onChange={set("lineName")} className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-normal" />
        </label>
        <label className="text-xs font-semibold">Notes
          <input value={form.notes} onChange={set("notes")} className="mt-1 w-full rounded-md border border-border px-2 py-1.5 font-normal" />
        </label>
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      <button
        onClick={submit}
        disabled={busy}
        className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
      >
        {busy ? "Creating…" : "Create batch"}
      </button>
    </Card>
  );
}

function BatchDetail({ batchId, onChanged }: { batchId: string; onChanged: () => void }) {
  const detailQ = useQuery({
    queryKey: ["manufacturing-batch", batchId],
    queryFn: () => api.manufacturing.batches.get(batchId),
    retry: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [updateForm, setUpdateForm] = useState({ stage: "Dipping", qtyGood: "", qtyRejected: "0", remarks: "" });
  const [allocQty, setAllocQty] = useState("");

  const run = async (label: string, fn: () => Promise<any>) => {
    setBusy(label);
    setMsg(null);
    try {
      const r = await fn();
      setMsg(typeof r?.duplicate !== "undefined" && r.duplicate ? "Duplicate ignored — not double-counted." : "Saved.");
      detailQ.refetch();
      onChanged();
    } catch (e: any) {
      setMsg(e.message || "Action failed");
    } finally {
      setBusy(null);
    }
  };

  if (detailQ.isLoading) return <p className="mt-3 text-xs text-muted-foreground">Loading details…</p>;
  if (detailQ.isError || !detailQ.data) return <p className="mt-3 text-xs text-red-600">Could not load batch.</p>;
  const b = detailQ.data;
  const updates: any[] = Array.isArray(b.updates) ? b.updates : [];

  return (
    <div className="mt-4 space-y-4 border-t border-border pt-4">
      {/* Production updates */}
      <div>
        <h4 className="text-sm font-bold">Production updates ({updates.length})</h4>
        <div className="mt-2 grid gap-2 md:grid-cols-4">
          <input value={updateForm.stage} onChange={(e) => setUpdateForm({ ...updateForm, stage: e.target.value })} placeholder="Stage" className="rounded-md border border-border px-2 py-1.5 text-xs" />
          <input type="number" value={updateForm.qtyGood} onChange={(e) => setUpdateForm({ ...updateForm, qtyGood: e.target.value })} placeholder="Good qty (since last)" className="rounded-md border border-border px-2 py-1.5 text-xs" />
          <input type="number" value={updateForm.qtyRejected} onChange={(e) => setUpdateForm({ ...updateForm, qtyRejected: e.target.value })} placeholder="Rejects" className="rounded-md border border-border px-2 py-1.5 text-xs" />
          <input value={updateForm.remarks} onChange={(e) => setUpdateForm({ ...updateForm, remarks: e.target.value })} placeholder="Remarks" className="rounded-md border border-border px-2 py-1.5 text-xs" />
        </div>
        <button
          disabled={busy !== null}
          onClick={() =>
            run("update", () =>
              api.manufacturing.updates.record({
                batchId: b.id,
                stage: updateForm.stage,
                qtyGood: Number(updateForm.qtyGood),
                qtyRejected: Number(updateForm.qtyRejected || 0),
                remarks: updateForm.remarks || null,
                // Mint a fresh idempotency key per submission so refresh /
                // double-click can never double-count the same entry.
                idempotencyKey: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
              })
            )
          }
          className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50"
        >
          {busy === "update" ? "Saving…" : "Record update"}
        </button>
        <div className="mt-2 space-y-1">
          {updates.map((u) => (
            <div key={u.id} className="flex flex-wrap gap-3 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">{u.stage}</span>
              <span>+{u.qtyGood} good</span>
              <span>{u.qtyRejected} rejects</span>
              <span>{u.lineStatus}</span>
              {u.remarks && <span>“{u.remarks}”</span>}
              <span>{fmtDate(u.createdAt)}</span>
            </div>
          ))}
          {updates.length === 0 && <p className="text-xs text-muted-foreground">No updates yet.</p>}
        </div>
      </div>

      {/* Quality + allocation */}
      <div className="flex flex-wrap items-center gap-2">
        <button disabled={busy !== null} onClick={() => run("complete", () => api.manufacturing.batches.complete(b.id))} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted disabled:opacity-50">
          Complete batch
        </button>
        <button disabled={busy !== null} onClick={() => run("hold", () => api.manufacturing.batches.hold(b.id))} className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50">
          Hold
        </button>
        <button disabled={busy !== null} onClick={() => run("release", () => api.manufacturing.batches.release(b.id))} className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50">
          Release (quality role)
        </button>
        <span className="inline-flex items-center gap-1 text-xs">
          <input type="number" value={allocQty} onChange={(e) => setAllocQty(e.target.value)} placeholder="Allocate qty" className="w-28 rounded-md border border-border px-2 py-1.5" />
          <button disabled={busy !== null || !allocQty} onClick={() => run("allocate", () => api.manufacturing.batches.allocate(b.id, Number(allocQty)))} className="rounded-lg bg-primary px-3 py-1.5 font-semibold text-primary-foreground disabled:opacity-50">
            Allocate
          </button>
        </span>
      </div>
      {b.qualityStatus !== "Released" && (
        <p className="text-xs text-amber-600">
          Allocation is blocked while quality is {b.qualityStatus} — only Released stock can be allocated or dispatched.
        </p>
      )}
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      {Array.isArray(b.qualityReviews) && b.qualityReviews.length > 0 && (
        <div className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">Quality history: </span>
          {b.qualityReviews.map((q: any, i: number) => (
            <span key={i}>{q.from} → {q.to} ({fmtDate(q.at)}){i < b.qualityReviews.length - 1 ? "; " : ""}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Factory issues ─── */

function IssuesTab({ issuesQ, onChanged }: { issuesQ: any; onChanged: () => void }) {
  const [form, setForm] = useState({ type: "stoppage", title: "", owner: "", lineName: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.manufacturing.issues.create({
        type: form.type,
        title: form.title,
        owner: form.owner || null,
        lineName: form.lineName || null,
      });
      setForm({ type: "stoppage", title: "", owner: "", lineName: "" });
      onChanged();
    } catch (e: any) {
      setError(e.message || "Could not raise issue");
    } finally {
      setBusy(false);
    }
  };

  const close = async (id: string) => {
    try {
      await api.manufacturing.issues.close(id);
      onChanged();
    } catch (e: any) {
      setError(e.message || "Could not close issue");
    }
  };

  if (issuesQ.isLoading) return <p className="text-sm text-muted-foreground">Loading issues…</p>;
  if (issuesQ.isError) return <EmptyState title="Issues unavailable" description="Could not load factory issues." />;
  const issues: any[] = Array.isArray(issuesQ.data) ? issuesQ.data : [];

  return (
    <div className="space-y-4">
      <Card title="Raise factory issue">
        <div className="grid gap-2 md:grid-cols-4">
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="rounded-md border border-border px-2 py-1.5 text-xs">
            <option value="stoppage">Line stoppage</option>
            <option value="maintenance">Maintenance</option>
            <option value="staffing">Staffing</option>
            <option value="utility">Utility</option>
            <option value="material">Material</option>
          </select>
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title (e.g. Line-1 conveyor jam)" className="rounded-md border border-border px-2 py-1.5 text-xs" />
          <input value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} placeholder="Owner" className="rounded-md border border-border px-2 py-1.5 text-xs" />
          <input value={form.lineName} onChange={(e) => setForm({ ...form, lineName: e.target.value })} placeholder="Line" className="rounded-md border border-border px-2 py-1.5 text-xs" />
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        <button onClick={submit} disabled={busy || !form.title.trim()} className="mt-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-50">
          {busy ? "Raising…" : "Raise issue"}
        </button>
      </Card>
      {issues.length === 0 && <EmptyState title="No factory issues" description="Stoppages, maintenance and material issues will appear here with owner and status." />}
      {issues.map((i) => (
        <Card key={i.id} title={`${i.title} — ${i.type}`}>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusPill status={i.status} />
            {i.owner && <span>Owner: <span className="font-semibold text-foreground">{i.owner}</span></span>}
            {i.lineName && <span>Line: {i.lineName}</span>}
            {i.affectedBatchNumber && <span>Batch: {i.affectedBatchNumber}</span>}
            <span>{fmtDate(i.createdAt)}</span>
            {i.status === "open" && (
              <button onClick={() => close(i.id)} className="ml-auto rounded-md border border-border px-2 py-1 font-semibold hover:bg-muted">
                Mark closed
              </button>
            )}
          </div>
        </Card>
      ))}
    </div>
  );
}

/* ─── Tally ─── */

function TallyTab({ tallyQ }: { tallyQ: any }) {
  if (tallyQ.isLoading) return <p className="text-sm text-muted-foreground">Loading Tally preview…</p>;
  if (tallyQ.isError) return <EmptyState title="Tally preview unavailable" description="Could not load the Tally handoff preview." />;
  const d = tallyQ.data;
  return (
    <Card
      title="Tally handoff"
      action={
        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-700">
          {d.simulated ? "Simulated" : "Live-test"}
        </span>
      }
    >
      <p className="text-xs text-muted-foreground">{d.label} — generated {d.generatedAt ? fmtDate(d.generatedAt) : "just now"}</p>
      {(d.vouchers ?? []).length === 0 && (
        <p className="mt-2 text-sm text-muted-foreground">No released batches to hand off yet. Release a batch first.</p>
      )}
      {(d.vouchers ?? []).map((v: any) => (
        <div key={v.batchNumber} className="mt-2 flex flex-wrap gap-3 border-b border-border pb-2 text-xs last:border-0">
          <span className="font-semibold">{v.batchNumber}</span>
          <span>{v.productName ?? v.sku}</span>
          <span>Released {v.releasedQty}</span>
          <span>Allocated {v.allocatedQty}</span>
          {v.salesOrderNumber && <span>Order {v.salesOrderNumber}</span>}
        </div>
      ))}
    </Card>
  );
}

import { v4 as uuid } from "uuid";
import * as db from "../dynamodb.js";

/**
 * Reusable manufacturing modules (NOT customer-specific).
 * Generic names only — never hard-code a customer (e.g. RFB) here.
 * RFB specifics live in ManufacturingConfig seed data per tenant.
 *
 * Entities:
 *  - ManufacturingBatch  : production batch linked to a sales order + product
 *  - ProductionUpdate    : incremental floor entries (idempotent, no double-count)
 *  - FactoryIssue        : line stoppage / maintenance / staffing / utility / material
 *  - ManufacturingConfig : per-tenant lines, shifts, stages, quality roles, tally mode
 *  - BusinessMode        : per-tenant 'trading' | 'manufacturer' | 'both'
 */

export type BusinessMode = "trading" | "manufacturer" | "both";

export type BatchStatus = "planned" | "in_progress" | "completed" | "closed";
export type QualityStatus = "Pending" | "Hold" | "Released";

// ---------------------------------------------------------------------------
// Business mode (tenant-level switch driving nav + dashboard variant)
// ---------------------------------------------------------------------------

export interface BusinessModeRecord {
  pk: string;
  sk: string;
  entityType: "BusinessMode";
  id: string;
  clientId: string;
  mode: BusinessMode;
  updatedAt: string;
}

const modePk = (clientId: string) => `BUSMODE#${clientId}`;

export async function getBusinessMode(clientId: string): Promise<BusinessMode> {
  const item = (await db.getItem(modePk(clientId))) as BusinessModeRecord | null;
  if (item?.mode === "trading" || item?.mode === "manufacturer" || item?.mode === "both") {
    return item.mode;
  }
  return "both";
}

export async function setBusinessMode(clientId: string, mode: BusinessMode): Promise<BusinessModeRecord> {
  if (mode !== "trading" && mode !== "manufacturer" && mode !== "both") {
    throw new Error("mode must be trading | manufacturer | both");
  }
  const item: BusinessModeRecord = {
    pk: modePk(clientId),
    sk: modePk(clientId),
    entityType: "BusinessMode",
    id: clientId,
    clientId,
    mode,
    updatedAt: db.nowISO(),
  };
  await db.putItem(item);
  return item;
}

// ---------------------------------------------------------------------------
// ManufacturingConfig — per-tenant manufacturing vocabulary (data, not code)
// ---------------------------------------------------------------------------

export interface ManufacturingConfig {
  pk: string;
  sk: string;
  entityType: "ManufacturingConfig";
  id: string;
  clientId: string;
  lines: Array<{ id: string; name: string }>;
  shifts: Array<{ id: string; name: string }>;
  stages: string[];
  /** roles allowed to Release a batch (in addition to factor_admin/super_admin) */
  qualityRoles: string[];
  tallyMode: "simulated" | "live-test";
  updatedAt: string;
}

const cfgPk = (clientId: string) => `MFGCONFIG#${clientId}`;

export const DEFAULT_STAGES = ["Dipping", "Washing", "Drying", "Stripping", "Packing"];

export async function getConfig(clientId: string): Promise<ManufacturingConfig> {
  const item = (await db.getItem(cfgPk(clientId))) as ManufacturingConfig | null;
  if (item) return item;
  const now = db.nowISO();
  return {
    pk: cfgPk(clientId),
    sk: cfgPk(clientId),
    entityType: "ManufacturingConfig",
    id: clientId,
    clientId,
    lines: [{ id: "line-1", name: "Line 1" }],
    shifts: [
      { id: "day", name: "Day" },
      { id: "night", name: "Night" },
    ],
    stages: [...DEFAULT_STAGES],
    qualityRoles: ["checker"],
    tallyMode: "simulated",
    updatedAt: now,
  };
}

export async function updateConfig(
  clientId: string,
  updates: Partial<Pick<ManufacturingConfig, "lines" | "shifts" | "stages" | "qualityRoles" | "tallyMode">>
): Promise<ManufacturingConfig> {
  const current = await getConfig(clientId);
  const patch: Record<string, any> = { updatedAt: db.nowISO() };
  for (const k of ["lines", "shifts", "stages", "qualityRoles", "tallyMode"] as const) {
    if (updates[k] !== undefined) patch[k] = updates[k];
  }
  if (tallyModeInvalid(patch.tallyMode ?? current.tallyMode)) {
    throw new Error("tallyMode must be simulated | live-test");
  }
  if (current.pk && (await db.getItem(current.pk))) {
    await db.updateItem(current.pk, current.sk, patch);
    return getConfig(clientId);
  }
  const item: ManufacturingConfig = { ...current, ...patch } as ManufacturingConfig;
  await db.putItem(item);
  return item;
}

function tallyModeInvalid(m: unknown) {
  return m !== "simulated" && m !== "live-test";
}

// ---------------------------------------------------------------------------
// ManufacturingBatch
// ---------------------------------------------------------------------------

export interface QualityReview {
  by: string;
  at: string;
  from: QualityStatus;
  to: QualityStatus;
  remarks: string | null;
}

export interface ManufacturingBatch {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "ManufacturingBatch";
  id: string;
  clientId: string;
  batchNumber: string;
  salesOrderId: string | null;
  salesOrderNumber: string | null;
  productId: string | null;
  sku: string | null;
  productName: string | null;
  targetQty: number;
  lineId: string | null;
  lineName: string | null;
  shiftId: string | null;
  status: BatchStatus;
  qualityStatus: QualityStatus;
  qualityReviews: QualityReview[];
  /** derived from production updates */
  producedGoodQty: number;
  rejectedQty: number;
  /** set on release */
  releasedQty: number;
  /** set on allocate */
  allocatedQty: number;
  notes: string | null;
  isDemoData: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const batchPk = (id: string) => `MFGBATCH#${id}`;

export async function listBatches(clientId: string): Promise<ManufacturingBatch[]> {
  const { items } = await db.queryByGSI1(clientId, { entityType: "ManufacturingBatch", limit: 500 });
  return (items as ManufacturingBatch[]).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
}

export async function getBatch(id: string): Promise<ManufacturingBatch | null> {
  return (await db.getItem(batchPk(id))) as ManufacturingBatch | null;
}

export async function createBatch(
  data: {
    clientId: string;
    salesOrderId?: string | null;
    salesOrderNumber?: string | null;
    productId?: string | null;
    sku?: string | null;
    productName?: string | null;
    targetQty: number;
    lineId?: string | null;
    lineName?: string | null;
    shiftId?: string | null;
    notes?: string | null;
    isDemoData?: boolean;
    createdBy?: string | null;
  }
): Promise<ManufacturingBatch> {
  const qty = Number(data.targetQty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("targetQty must be > 0");
  const id = uuid();
  const now = db.nowISO();
  const item: ManufacturingBatch = {
    pk: batchPk(id),
    sk: batchPk(id),
    gsi1pk: `CLIENT#${data.clientId}`,
    gsi1sk: `ManufacturingBatch#${now}#${id}`,
    entityType: "ManufacturingBatch",
    id,
    clientId: data.clientId,
    batchNumber: `BATCH-${id.slice(0, 8).toUpperCase()}`,
    salesOrderId: data.salesOrderId ?? null,
    salesOrderNumber: data.salesOrderNumber ?? null,
    productId: data.productId ?? null,
    sku: data.sku ?? null,
    productName: data.productName ?? null,
    targetQty: qty,
    lineId: data.lineId ?? null,
    lineName: data.lineName ?? null,
    shiftId: data.shiftId ?? null,
    status: "planned",
    qualityStatus: "Pending",
    qualityReviews: [],
    producedGoodQty: 0,
    rejectedQty: 0,
    releasedQty: 0,
    allocatedQty: 0,
    notes: data.notes ?? null,
    isDemoData: !!data.isDemoData,
    createdBy: data.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putItem(item);
  return item;
}

/** Re-sum produced/rejected quantities from saved production updates. */
export async function recalcBatchTotals(batchId: string): Promise<ManufacturingBatch | null> {
  const batch = await getBatch(batchId);
  if (!batch) return null;
  const updates = await listUpdates(batchId);
  const good = updates.reduce((s, u) => s + Number(u.qtyGood || 0), 0);
  const rej = updates.reduce((s, u) => s + Number(u.qtyRejected || 0), 0);
  const patch: Record<string, any> = {
    producedGoodQty: good,
    rejectedQty: rej,
    updatedAt: db.nowISO(),
  };
  if (batch.status === "planned" && updates.length > 0) patch.status = "in_progress";
  await db.updateItem(batch.pk, batch.sk, patch);
  return getBatch(batchId);
}

export function availableQty(b: ManufacturingBatch): number {
  return Math.max(0, Number(b.releasedQty || 0) - Number(b.allocatedQty || 0));
}

/** Generic gate shared by allocate + (later) dispatch confirm. */
export function assertBatchReleasable(b: ManufacturingBatch): void {
  if (b.qualityStatus !== "Released") {
    throw Object.assign(
      new Error(`Batch ${b.batchNumber} is ${b.qualityStatus} — only Released stock can be allocated/dispatched`),
      { statusCode: 409, code: "BATCH_NOT_RELEASED" }
    );
  }
}

/** Released-but-unallocated finished stock for a batch (dispatch-ready qty). */
export function releasableQty(b: ManufacturingBatch): number {
  if (b.qualityStatus !== "Released") return 0;
  return availableQty(b);
}

/**
 * Step 12: complete a batch. Good output enters an explicit quality-pending
 * state (qualityStatus stays Pending, releasedQty stays 0 → availableQty 0),
 * rejects remain unavailable, and the batch can no longer take updates.
 */
export async function completeBatch(id: string, clientId: string): Promise<ManufacturingBatch | null> {
  const b = await getBatch(id);
  if (!b || b.clientId !== clientId) return null;
  if (b.status === "completed") return b;
  const { updateItem } = await import("../dynamodb.js");
  await updateItem(b.pk, b.sk, { status: "completed", updatedAt: db.nowISO() });
  return getBatch(id);
}

// ---------------------------------------------------------------------------
// MaterialIssue — raw-material consumption per batch (manufacture workflow)
// Step 9 of the E2E plan: issue 100 units → raw stock −100, linked to batch,
// over-issue blocked, repeat submission idempotent.
// ---------------------------------------------------------------------------

export interface MaterialIssue {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "MaterialIssue";
  id: string;
  clientId: string;
  batchId: string;
  batchNumber: string | null;
  productId: string;
  sku: string | null;
  productName: string | null;
  qty: number;
  lot: string | null;
  warehouse: string | null;
  idempotencyKey: string;
  movementId: string | null;
  createdBy: string | null;
  createdAt: string;
}

const matIssuePk = (id: string) => `MFGISSUE-MAT#${id}`;

export async function findMaterialIssueByKey(
  clientId: string,
  key: string
): Promise<MaterialIssue | null> {
  const all = await db.scanByType("MaterialIssue", { limit: 2000 });
  return (
    ((all as MaterialIssue[]).find(
      (i) => i.clientId === clientId && i.idempotencyKey === key
    ) as MaterialIssue) ?? null
  );
}

export async function listMaterialIssues(
  clientId: string,
  batchId?: string
): Promise<MaterialIssue[]> {
  const { items } = await db.queryByGSI1(clientId, { entityType: "MaterialIssue", limit: 500 });
  const all = items as MaterialIssue[];
  const filtered = batchId ? all.filter((i) => i.batchId === batchId) : all;
  return filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Issue raw material to a batch. Writes a confirmed `out` stock movement so
 * raw stock drops immediately, and records the issue row for traceability.
 * Idempotent per (clientId, idempotencyKey). Over-issue → 409.
 */
export async function issueMaterial(data: {
  clientId: string;
  batchId: string;
  productId: string;
  qty: number;
  lot?: string | null;
  warehouse?: string | null;
  sku?: string | null;
  productName?: string | null;
  idempotencyKey: string;
  createdBy?: string | null;
}): Promise<{ issue: MaterialIssue; duplicate: boolean }> {
  if (!data.idempotencyKey) throw new Error("idempotencyKey is required");
  const existing = await findMaterialIssueByKey(data.clientId, data.idempotencyKey);
  if (existing) return { issue: existing, duplicate: true };

  const qty = Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("qty must be > 0");
  if (!data.productId) throw new Error("productId is required");

  const batch = await getBatch(data.batchId);
  if (!batch) throw new Error("Batch not found");
  if (batch.clientId !== data.clientId)
    throw Object.assign(new Error("Access denied"), { statusCode: 403 });
  if (batch.status === "closed" || batch.status === "completed")
    throw Object.assign(new Error("Batch is completed — no further material issues"), { statusCode: 409 });

  // Available raw stock = Σ confirmed movements for this product.
  const { list: listMovements, getBalance, create: createMovement } = await import(
    "./stock-movement.js"
  );
  const movements = await listMovements(data.clientId);
  const balance = await getBalance(data.productId, movements);
  if (qty > balance) {
    throw Object.assign(
      new Error(`Insufficient stock — ${balance} available, ${qty} requested`),
      { statusCode: 409, code: "INSUFFICIENT_STOCK" }
    );
  }

  const movement = await createMovement({
    clientId: data.clientId,
    direction: "out",
    productId: data.productId,
    itemName: data.productName ?? data.productId,
    sku: data.sku ?? null,
    quantity: qty,
    warehouse: data.warehouse ?? null,
    reason: "Material issue",
    linkedDocumentType: "ManufacturingBatch",
    linkedDocumentNumber: batch.batchNumber,
    status: "confirmed",
    notes: `Issued to ${batch.batchNumber}${data.lot ? ` · lot ${data.lot}` : ""}`,
  });

  const id = uuid();
  const now = db.nowISO();
  const item: MaterialIssue = {
    pk: matIssuePk(id),
    sk: matIssuePk(id),
    gsi1pk: `CLIENT#${data.clientId}`,
    gsi1sk: `MaterialIssue#${now}#${id}`,
    entityType: "MaterialIssue",
    id,
    clientId: data.clientId,
    batchId: data.batchId,
    batchNumber: batch.batchNumber,
    productId: data.productId,
    sku: data.sku ?? null,
    productName: data.productName ?? null,
    qty,
    lot: data.lot ?? null,
    warehouse: data.warehouse ?? null,
    idempotencyKey: data.idempotencyKey,
    movementId: (movement as any).id ?? null,
    createdBy: data.createdBy ?? null,
    createdAt: now,
  };
  await db.putItem(item);
  return { issue: item, duplicate: false };
}

// ---------------------------------------------------------------------------
// ProductionUpdate — incremental, idempotent
// ---------------------------------------------------------------------------

export interface ProductionUpdate {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "ProductionUpdate";
  id: string;
  clientId: string;
  batchId: string;
  stage: string;
  /** incremental good output since last update */
  qtyGood: number;
  qtyRejected: number;
  lineStatus: "running" | "stopped" | "maintenance";
  remarks: string | null;
  idempotencyKey: string;
  createdBy: string | null;
  createdAt: string;
}

const updPk = (id: string) => `MFGUPDATE#${id}`;

export async function listUpdates(batchId: string): Promise<ProductionUpdate[]> {
  const all = await db.scanByType("ProductionUpdate", { limit: 2000 });
  return (all as ProductionUpdate[])
    .filter((u) => u.batchId === batchId)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function findUpdateByKey(clientId: string, key: string): Promise<ProductionUpdate | null> {
  const all = await db.scanByType("ProductionUpdate", { limit: 2000 });
  return (
    ((all as ProductionUpdate[]).find((u) => u.clientId === clientId && u.idempotencyKey === key) as ProductionUpdate) ??
    null
  );
}

export async function recordUpdate(
  data: {
    clientId: string;
    batchId: string;
    stage: string;
    qtyGood: number;
    qtyRejected?: number;
    lineStatus?: ProductionUpdate["lineStatus"];
    remarks?: string | null;
    idempotencyKey: string;
    createdBy?: string | null;
  }
): Promise<{ update: ProductionUpdate; duplicate: boolean }> {
  if (!data.idempotencyKey) throw new Error("idempotencyKey is required");
  const existing = await findUpdateByKey(data.clientId, data.idempotencyKey);
  if (existing) return { update: existing, duplicate: true };

  const good = Number(data.qtyGood);
  const rej = Number(data.qtyRejected ?? 0);
  if (!Number.isFinite(good) || good < 0) throw new Error("qtyGood must be >= 0");
  if (!Number.isFinite(rej) || rej < 0) throw new Error("qtyRejected must be >= 0");
  if (good === 0 && rej === 0) throw new Error("Enter a good quantity or rejects");
  const lineStatus = data.lineStatus ?? "running";
  if (!["running", "stopped", "maintenance"].includes(lineStatus)) throw new Error("Invalid lineStatus");

  const batch = await getBatch(data.batchId);
  if (!batch) throw new Error("Batch not found");
  if (batch.clientId !== data.clientId) throw Object.assign(new Error("Access denied"), { statusCode: 403 });
  if (batch.status === "closed") throw new Error("Batch is closed — no further updates");

  const id = uuid();
  const now = db.nowISO();
  const item: ProductionUpdate = {
    pk: updPk(id),
    sk: updPk(id),
    gsi1pk: `CLIENT#${data.clientId}`,
    gsi1sk: `ProductionUpdate#${now}#${id}`,
    entityType: "ProductionUpdate",
    id,
    clientId: data.clientId,
    batchId: data.batchId,
    stage: data.stage,
    qtyGood: good,
    qtyRejected: rej,
    lineStatus,
    remarks: data.remarks ?? null,
    idempotencyKey: data.idempotencyKey,
    createdBy: data.createdBy ?? null,
    createdAt: now,
  };
  await db.putItem(item);
  await recalcBatchTotals(data.batchId);
  return { update: item, duplicate: false };
}

// ---------------------------------------------------------------------------
// FactoryIssue
// ---------------------------------------------------------------------------

export type FactoryIssueType = "stoppage" | "maintenance" | "staffing" | "utility" | "material";

/** Step 11 lifecycle: Open → Assigned → In Progress → Resolved → Closed. */
export type FactoryIssueStatus = "open" | "assigned" | "in_progress" | "resolved" | "closed";

const ISSUE_TRANSITIONS: Record<FactoryIssueStatus, FactoryIssueStatus[]> = {
  open: ["assigned", "closed"],
  assigned: ["in_progress", "closed"],
  in_progress: ["resolved", "closed"],
  resolved: ["closed", "in_progress"],
  closed: [],
};

export interface FactoryIssue {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "FactoryIssue";
  id: string;
  clientId: string;
  type: FactoryIssueType;
  lineId: string | null;
  lineName: string | null;
  affectedBatchId: string | null;
  affectedBatchNumber: string | null;
  title: string;
  description: string | null;
  owner: string | null;
  expectedResolutionAt: string | null;
  status: FactoryIssueStatus;
  statusHistory: Array<{ from: FactoryIssueStatus; to: FactoryIssueStatus; by: string | null; at: string }>;
  closedAt: string | null;
  closedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const issuePk = (id: string) => `MFGISSUE#${id}`;

const ISSUE_TYPES: FactoryIssueType[] = ["stoppage", "maintenance", "staffing", "utility", "material"];

export async function listIssues(clientId: string): Promise<FactoryIssue[]> {
  const { items } = await db.queryByGSI1(clientId, { entityType: "FactoryIssue", limit: 500 });
  return (items as FactoryIssue[]).sort((a, b) =>
    String(b.createdAt).localeCompare(String(a.createdAt))
  );
}

export async function createIssue(
  data: {
    clientId: string;
    type: FactoryIssueType;
    lineId?: string | null;
    lineName?: string | null;
    affectedBatchId?: string | null;
    title: string;
    description?: string | null;
    owner?: string | null;
    expectedResolutionAt?: string | null;
    createdBy?: string | null;
  }
): Promise<FactoryIssue> {
  if (!ISSUE_TYPES.includes(data.type)) throw new Error("Invalid issue type");
  if (!data.title?.trim()) throw new Error("Title is required");
  let batchNumber: string | null = null;
  if (data.affectedBatchId) {
    const b = await getBatch(data.affectedBatchId);
    if (!b) throw new Error("Affected batch not found");
    if (b.clientId !== data.clientId) throw Object.assign(new Error("Access denied"), { statusCode: 403 });
    batchNumber = b.batchNumber;
  }
  const id = uuid();
  const now = db.nowISO();
  const item: FactoryIssue = {
    pk: issuePk(id),
    sk: issuePk(id),
    gsi1pk: `CLIENT#${data.clientId}`,
    gsi1sk: `FactoryIssue#${now}#${id}`,
    entityType: "FactoryIssue",
    id,
    clientId: data.clientId,
    type: data.type,
    lineId: data.lineId ?? null,
    lineName: data.lineName ?? null,
    affectedBatchId: data.affectedBatchId ?? null,
    affectedBatchNumber: batchNumber,
    title: data.title.trim(),
    description: data.description ?? null,
    owner: data.owner ?? null,
    expectedResolutionAt: data.expectedResolutionAt ?? null,
    status: "open",
    statusHistory: [],
    closedAt: null,
    closedBy: null,
    createdBy: data.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putItem(item);
  return item;
}

async function getIssue(id: string, clientId: string): Promise<FactoryIssue | null> {
  const all = await db.scanByType("FactoryIssue", { limit: 2000 });
  return (
    ((all as FactoryIssue[]).find((i) => i.id === id && i.clientId === clientId) as FactoryIssue) ??
    null
  );
}

/**
 * Move a factory issue forward through its lifecycle. Only the listed
 * transitions are allowed; closing stamps closedAt/closedBy, reopening
 * (resolved → in_progress) clears them.
 */
export async function transitionIssue(
  id: string,
  clientId: string,
  to: FactoryIssueStatus,
  actor: string | null,
  owner?: string | null
): Promise<FactoryIssue | null> {
  const item = await getIssue(id, clientId);
  if (!item) return null;
  const allowed = ISSUE_TRANSITIONS[item.status] ?? [];
  if (!allowed.includes(to)) {
    throw Object.assign(
      new Error(`Cannot move issue from ${item.status} to ${to}`),
      { statusCode: 409, code: "INVALID_ISSUE_TRANSITION" }
    );
  }
  const now = db.nowISO();
  const patch: Record<string, any> = {
    status: to,
    statusHistory: [
      ...(item.statusHistory || []),
      { from: item.status, to, by: actor, at: now },
    ],
    updatedAt: now,
  };
  if (owner !== undefined) patch.owner = owner;
  if (to === "closed") {
    patch.closedAt = now;
    patch.closedBy = actor;
  }
  if (item.status === "closed" || to === "in_progress") {
    if (to !== "closed") {
      patch.closedAt = null;
      patch.closedBy = null;
    }
  }
  await db.updateItem(item.pk, item.sk, patch);
  return getIssue(id, clientId);
}

export async function closeIssue(id: string, clientId: string, closedBy: string | null): Promise<FactoryIssue | null> {
  const item = await getIssue(id, clientId);
  if (!item) return null;
  // Close directly from any non-closed state (back-compat shortcut).
  if (item.status === "closed") return item;
  const now = db.nowISO();
  await db.updateItem(item.pk, item.sk, {
    status: "closed",
    statusHistory: [
      ...(item.statusHistory || []),
      { from: item.status, to: "closed" as FactoryIssueStatus, by: closedBy, at: now },
    ],
    closedAt: now,
    closedBy: closedBy ?? null,
    updatedAt: now,
  });
  return getIssue(id, clientId);
}

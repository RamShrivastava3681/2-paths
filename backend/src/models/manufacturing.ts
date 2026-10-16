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

/**
 * Full batch lifecycle (workflow spec §D):
 * Draft → Planned → Ready to Start → In Progress → Completed →
 * Quality Review → Released, plus On Hold / Rework / Rejected / Cancelled.
 * The legacy values (planned/in_progress/completed/closed) remain valid so
 * existing records and callers keep working.
 */
export type BatchStatus =
  | "draft"
  | "planned"
  | "ready_to_start"
  | "in_progress"
  | "completed"
  | "quality_review"
  | "released"
  | "on_hold"
  | "rework"
  | "rejected"
  | "cancelled"
  | "closed";
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
  /** release idempotency key — retried releases dedupe on this */
  idempotencyKey?: string | null;
}

/** One BOM line: qty of a raw material per finished unit. */
export interface BOMLine {
  productId: string;
  sku?: string | null;
  productName?: string | null;
  /** material units consumed per finished unit */
  qtyPerUnit: number;
  /** FB/TRIM/PACK category for the material-check stage */
  category?: "fabric" | "trim" | "packaging" | "other";
}

/** Stage-C material status for a batch/order. */
export type MaterialStatus = "ready" | "partial" | "blocked" | "awaiting_inspection";

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
  /** order snapshot carried onto the plan (Stage D) */
  priority?: "low" | "normal" | "high" | "urgent" | null;
  deliveryDate?: string | null;
  supervisor?: string | null;
  plannedStartAt?: string | null;
  plannedEndAt?: string | null;
  actualStartAt?: string | null;
  actualEndAt?: string | null;
  /** bill of materials + evaluated readiness (Stages B–C) */
  bom: BOMLine[];
  materialStatus: MaterialStatus;
  status: BatchStatus;
  /** lifecycle audit: every status move, who + when */
  statusHistory: Array<{ from: BatchStatus; to: BatchStatus; by: string | null; at: string; notes?: string | null }>;
  qualityStatus: QualityStatus;
  qualityReviews: QualityReview[];
  /** derived from production updates */
  producedGoodQty: number;
  rejectedQty: number;
  reworkQty: number;
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
    priority?: "low" | "normal" | "high" | "urgent" | null;
    deliveryDate?: string | null;
    supervisor?: string | null;
    plannedStartAt?: string | null;
    plannedEndAt?: string | null;
    bom?: BOMLine[];
  }
): Promise<ManufacturingBatch> {
  const qty = Number(data.targetQty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("targetQty must be > 0");
  const bom = validateBom(data.bom ?? []);
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
    priority: data.priority ?? null,
    deliveryDate: data.deliveryDate ?? null,
    supervisor: data.supervisor ?? null,
    plannedStartAt: data.plannedStartAt ?? null,
    plannedEndAt: data.plannedEndAt ?? null,
    actualStartAt: null,
    actualEndAt: null,
    bom,
    materialStatus: bom.length === 0 ? "awaiting_inspection" : "blocked",
    status: "planned",
    statusHistory: [],
    qualityStatus: "Pending",
    qualityReviews: [],
    producedGoodQty: 0,
    rejectedQty: 0,
    reworkQty: 0,
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

function validateBom(lines: BOMLine[]): BOMLine[] {
  return (lines ?? []).map((l) => {
    const q = Number((l as any).qtyPerUnit);
    if (!l.productId) throw new Error("BOM line productId is required");
    if (!Number.isFinite(q) || q <= 0) throw new Error("BOM qtyPerUnit must be > 0");
    return {
      productId: l.productId,
      sku: (l as any).sku ?? null,
      productName: (l as any).productName ?? null,
      qtyPerUnit: q,
      category: (l as any).category ?? "other",
    };
  });
}

/** Replace the BOM on a batch that has not started production. */
export async function setBatchBom(
  id: string,
  clientId: string,
  lines: BOMLine[]
): Promise<ManufacturingBatch | null> {
  const b = await getBatch(id);
  if (!b || b.clientId !== clientId) return null;
  if (["in_progress", "completed", "quality_review", "released", "closed"].includes(b.status)) {
    throw Object.assign(new Error("BOM cannot change after production has started"), {
      statusCode: 409,
      code: "BOM_LOCKED",
    });
  }
  const bom = validateBom(lines);
  await db.updateItem(b.pk, b.sk, {
    bom,
    materialStatus: bom.length === 0 ? "awaiting_inspection" : b.materialStatus,
    updatedAt: db.nowISO(),
  });
  return getBatch(id);
}

// ---------------------------------------------------------------------------
// Batch lifecycle transitions (Stage D + G)
// ---------------------------------------------------------------------------

const BATCH_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  draft: ["planned", "cancelled"],
  planned: ["ready_to_start", "cancelled"],
  ready_to_start: ["in_progress", "on_hold", "cancelled"],
  in_progress: ["completed", "on_hold", "cancelled"],
  completed: ["quality_review", "cancelled"],
  quality_review: ["on_hold", "rework", "rejected", "cancelled"],
  released: ["closed", "on_hold"],
  on_hold: ["in_progress", "ready_to_start", "rework", "cancelled", "quality_review"],
  rework: ["in_progress", "quality_review", "rejected", "cancelled"],
  rejected: ["closed", "cancelled"],
  cancelled: [],
  closed: [],
};

/**
 * Move a batch through its lifecycle. Guards:
 * - ready_to_start requires materialStatus ready (materials reserved/available)
 * - released requires qualityStatus Released (quality-release process)
 * - starting stamps actualStartAt; completing stamps actualEndAt + quality_review
 */
export async function transitionBatch(
  id: string,
  clientId: string,
  to: BatchStatus,
  actor: string | null,
  notes?: string | null
): Promise<ManufacturingBatch | null> {
  const b = await getBatch(id);
  if (!b || b.clientId !== clientId) return null;
  const allowed = BATCH_TRANSITIONS[b.status] ?? [];
  if (!allowed.includes(to)) {
    throw Object.assign(new Error(`Cannot move batch from ${b.status} to ${to}`), {
      statusCode: 409,
      code: "INVALID_BATCH_TRANSITION",
    });
  }
  if (to === "ready_to_start" && b.materialStatus !== "ready") {
    throw Object.assign(
      new Error(`Materials are ${b.materialStatus} — reserve materials before starting production`),
      { statusCode: 409, code: "MATERIALS_NOT_READY" }
    );
  }
  if (to === "released" && b.qualityStatus !== "Released") {
    throw Object.assign(new Error("Batch must pass quality release first"), {
      statusCode: 409,
      code: "QUALITY_NOT_RELEASED",
    });
  }
  const now = db.nowISO();
  const patch: Record<string, any> = {
    status: to,
    statusHistory: [
      ...(b.statusHistory || []),
      { from: b.status, to, by: actor, at: now, notes: notes ?? null },
    ],
    updatedAt: now,
  };
  if (to === "in_progress" && !b.actualStartAt) patch.actualStartAt = now;
  if (to === "completed") {
    patch.actualEndAt = now;
    // Completion initiates quality review — never releases stock.
    patch.status = "quality_review";
    patch.statusHistory = [
      ...(b.statusHistory || []),
      { from: b.status, to: "completed" as BatchStatus, by: actor, at: now, notes: notes ?? null },
      { from: "completed" as BatchStatus, to: "quality_review" as BatchStatus, by: actor, at: now, notes: "Auto: completion initiates quality review" },
    ];
  }
  await db.updateItem(b.pk, b.sk, patch);
  return getBatch(id);
}

/** Re-sum produced/rejected quantities from saved production updates. */
export async function recalcBatchTotals(batchId: string): Promise<ManufacturingBatch | null> {
  const batch = await getBatch(batchId);
  if (!batch) return null;
  const updates = await listUpdates(batchId);
  const good = updates.reduce((s, u) => s + Number(u.qtyGood || 0), 0);
  const rej = updates.reduce((s, u) => s + Number(u.qtyRejected || 0), 0);
  const rework = updates.reduce((s, u) => s + Number((u as any).qtyRework || 0), 0);
  const patch: Record<string, any> = {
    producedGoodQty: good,
    rejectedQty: rej,
    reworkQty: rework,
    updatedAt: db.nowISO(),
  };
  if ((batch.status === "planned" || batch.status === "ready_to_start") && updates.length > 0) {
    patch.status = "in_progress";
    if (!batch.actualStartAt) patch.actualStartAt = db.nowISO();
  }
  await db.updateItem(batch.pk, batch.sk, patch);
  return getBatch(batchId);
}

/**
 * Dispatch-eligible finished stock. Only Released batches expose stock —
 * Held / Pending / review states always report zero, so held goods can never
 * flow into allocation or dispatch even though releasedQty is retained.
 */
export function availableQty(b: ManufacturingBatch): number {
  if (b.qualityStatus !== "Released") return 0;
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
  return availableQty(b);
}

/** Planned vs actual, accepted vs rejected, completion % — never fabricated. */
export function batchProgress(b: ManufacturingBatch): {
  planned: number;
  accepted: number;
  rejected: number;
  rework: number;
  remaining: number;
  completionPct: number;
} {
  const planned = Number(b.targetQty || 0);
  const accepted = Number(b.producedGoodQty || 0);
  const rejected = Number(b.rejectedQty || 0);
  const rework = Number((b as any).reworkQty || 0);
  return {
    planned,
    accepted,
    rejected,
    rework,
    remaining: Math.max(0, planned - accepted),
    completionPct: planned > 0 ? Math.min(100, Math.round((accepted / planned) * 1000) / 10) : 0,
  };
}

/**
 * Quality release with partial-release support. Adds `qty` (default: all
 * unreleased good output) to the cumulative releasedQty, capped at produced
 * good output. Idempotent per idempotencyKey — a retried release never
 * double-posts stock. Rejected / rework quantities are never releasable.
 */
export async function releaseBatch(data: {
  id: string;
  clientId: string;
  qty?: number | null;
  idempotencyKey: string;
  by: string | null;
  remarks?: string | null;
}): Promise<{ batch: ManufacturingBatch; duplicate: boolean; releasedNow: number }> {
  if (!data.idempotencyKey) throw new Error("idempotencyKey is required");
  const b = await getBatch(data.id);
  if (!b || b.clientId !== data.clientId) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  const prior = (b.qualityReviews || []).find(
    (r) => (r as any).idempotencyKey === data.idempotencyKey && r.to === "Released"
  );
  if (prior) return { batch: b, duplicate: true, releasedNow: 0 };
  const good = Number(b.producedGoodQty || 0);
  const already = Number(b.releasedQty || 0);
  const releasable = Math.max(0, good - already);
  const qty = data.qty == null ? releasable : Number(data.qty);
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("Release quantity must be > 0");
  if (qty > releasable) {
    throw Object.assign(
      new Error(`Only ${releasable} unreleased good units available (produced ${good}, released ${already})`),
      { statusCode: 409, code: "RELEASE_EXCEEDS_OUTPUT" }
    );
  }
  const now = db.nowISO();
  const review: QualityReview = {
    by: data.by,
    at: now,
    from: b.qualityStatus,
    to: "Released",
    remarks: data.remarks ?? null,
    idempotencyKey: data.idempotencyKey,
  } as QualityReview;
  const patch: Record<string, any> = {
    qualityStatus: "Released",
    releasedQty: already + qty,
    qualityReviews: [...(b.qualityReviews || []), review],
    updatedAt: now,
  };
  if (b.status === "quality_review" || b.status === "completed" || b.status === "on_hold" || b.status === "rework") {
    patch.status = Number(b.releasedQty || 0) + qty >= good ? "released" : "quality_review";
    patch.statusHistory = [
      ...(b.statusHistory || []),
      { from: b.status, to: patch.status as BatchStatus, by: data.by, at: now, notes: data.remarks ?? null },
    ];
  }
  await db.updateItem(b.pk, b.sk, patch);
  return { batch: (await getBatch(data.id))!, duplicate: false, releasedNow: qty };
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
  /** quantity sent for rework (kept separate from accepted + rejected) */
  qtyRework: number;
  lineStatus: "running" | "stopped" | "maintenance";
  machineStatus?: string | null;
  staffingStatus?: string | null;
  utilityStatus?: string | null;
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
    qtyRework?: number;
    lineStatus?: ProductionUpdate["lineStatus"];
    machineStatus?: string | null;
    staffingStatus?: string | null;
    utilityStatus?: string | null;
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
  const rework = Number(data.qtyRework ?? 0);
  if (!Number.isFinite(good) || good < 0) throw new Error("qtyGood must be >= 0");
  if (!Number.isFinite(rej) || rej < 0) throw new Error("qtyRejected must be >= 0");
  if (!Number.isFinite(rework) || rework < 0) throw new Error("qtyRework must be >= 0");
  if (good === 0 && rej === 0 && rework === 0) throw new Error("Enter a good, rejected or rework quantity");
  const lineStatus = data.lineStatus ?? "running";
  if (!["running", "stopped", "maintenance"].includes(lineStatus)) throw new Error("Invalid lineStatus");

  const batch = await getBatch(data.batchId);
  if (!batch) throw new Error("Batch not found");
  if (batch.clientId !== data.clientId) throw Object.assign(new Error("Access denied"), { statusCode: 403 });
  if (batch.status === "closed" || batch.status === "cancelled" || batch.status === "rejected") {
    throw new Error("Batch is closed — no further updates");
  }
  if (["completed", "quality_review", "released"].includes(batch.status)) {
    throw Object.assign(new Error("Production is complete — updates stop at completion; use rework flow for corrections"), {
      statusCode: 409,
      code: "PRODUCTION_COMPLETE",
    });
  }

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
    qtyRework: rework,
    lineStatus,
    machineStatus: data.machineStatus ?? null,
    staffingStatus: data.staffingStatus ?? null,
    utilityStatus: data.utilityStatus ?? null,
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
  severity: "low" | "medium" | "high" | "critical";
  correctiveAction: string | null;
  resolutionNotes: string | null;
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
    severity?: "low" | "medium" | "high" | "critical";
    correctiveAction?: string | null;
    resolutionNotes?: string | null;
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
    severity: data.severity ?? "medium",
    correctiveAction: data.correctiveAction ?? null,
    resolutionNotes: data.resolutionNotes ?? null,
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
  owner?: string | null,
  extra?: { severity?: FactoryIssue["severity"]; correctiveAction?: string | null; resolutionNotes?: string | null }
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
  if (extra?.severity && ["low", "medium", "high", "critical"].includes(extra.severity)) patch.severity = extra.severity;
  if (extra?.correctiveAction !== undefined) patch.correctiveAction = extra.correctiveAction;
  if (extra?.resolutionNotes !== undefined) patch.resolutionNotes = extra.resolutionNotes;
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

// ---------------------------------------------------------------------------
// MaterialReservation — soft-allocate raw stock to a batch/order (Stages B–C)
// Reservations never move stock; confirmed GRNs (IN) and material issues
// (OUT) remain the only stock writers. Over-reservation is blocked.
// ---------------------------------------------------------------------------

export interface MaterialReservation {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "MaterialReservation";
  id: string;
  clientId: string;
  batchId: string | null;
  salesOrderNumber: string | null;
  productId: string;
  sku: string | null;
  qty: number;
  status: "active" | "released" | "consumed";
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const resPk = (id: string) => `MFGRESV#${id}`;

export async function listReservations(clientId: string, batchId?: string): Promise<MaterialReservation[]> {
  const { items } = await db.queryByGSI1(clientId, { entityType: "MaterialReservation", limit: 500 });
  const all = items as MaterialReservation[];
  const filtered = batchId ? all.filter((r) => r.batchId === batchId) : all;
  return filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function reservedForProduct(clientId: string, productId: string, excludeBatchId?: string | null): Promise<number> {
  const all = await listReservations(clientId);
  return all
    .filter((r) => r.productId === productId && r.status === "active" && (!excludeBatchId || r.batchId !== excludeBatchId))
    .reduce((s, r) => s + Number(r.qty || 0), 0);
}

export async function reserveMaterial(data: {
  clientId: string;
  batchId?: string | null;
  salesOrderNumber?: string | null;
  productId: string;
  sku?: string | null;
  qty: number;
  createdBy?: string | null;
}): Promise<MaterialReservation> {
  const qty = Number(data.qty);
  if (!data.productId) throw new Error("productId is required");
  if (!Number.isFinite(qty) || qty <= 0) throw new Error("qty must be > 0");
  const { list: listMovements, getBalance } = await import("./stock-movement.js");
  const movements = await listMovements(data.clientId);
  const balance = await getBalance(data.productId, movements);
  const reserved = await reservedForProduct(data.clientId, data.productId, data.batchId ?? null);
  const free = balance - reserved;
  if (qty > free) {
    throw Object.assign(
      new Error(`Cannot reserve ${qty} — only ${Math.max(0, free)} unreserved units available (stock ${balance}, reserved ${reserved})`),
      { statusCode: 409, code: "OVER_RESERVATION" }
    );
  }
  const id = uuid();
  const now = db.nowISO();
  const item: MaterialReservation = {
    pk: resPk(id),
    sk: resPk(id),
    gsi1pk: `CLIENT#${data.clientId}`,
    gsi1sk: `MaterialReservation#${now}#${id}`,
    entityType: "MaterialReservation",
    id,
    clientId: data.clientId,
    batchId: data.batchId ?? null,
    salesOrderNumber: data.salesOrderNumber ?? null,
    productId: data.productId,
    sku: data.sku ?? null,
    qty,
    status: "active",
    createdBy: data.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putItem(item);
  return item;
}

export async function releaseReservation(id: string, clientId: string, consumed = false): Promise<MaterialReservation | null> {
  const all = await db.scanByType("MaterialReservation", { limit: 2000 });
  const item = (all as MaterialReservation[]).find((r) => r.id === id && r.clientId === clientId);
  if (!item) return null;
  await db.updateItem(item.pk, item.sk, {
    status: consumed ? "consumed" : "released",
    updatedAt: db.nowISO(),
  });
  return (await db.getItem(item.pk)) as MaterialReservation | null;
}

export interface ReadinessLine {
  productId: string;
  sku: string | null;
  productName: string | null;
  category: string;
  required: number;
  available: number;
  reserved: number;
  incoming: number;
  shortage: number;
}

export interface BatchReadiness {
  batchId: string;
  batchNumber: string;
  materialStatus: MaterialStatus;
  lines: ReadinessLine[];
  totalShortage: number;
}

/**
 * Stage B/C decision input: required (BOM × target) vs available confirmed
 * stock vs active reservations (others) vs incoming PO qty (read-only info).
 * Persists the evaluated materialStatus on the batch.
 */
export async function computeReadiness(clientId: string, batchId: string): Promise<BatchReadiness> {
  const b = await getBatch(batchId);
  if (!b || b.clientId !== clientId) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  const { list: listMovements, getBalance } = await import("./stock-movement.js");
  const movements = await listMovements(clientId);
  // Incoming = sum of pending PO lines for these products (info only — a PO
  // never increases stock; only a confirmed GRN does).
  let poLines: Array<{ productId: string; outstanding: number }> = [];
  try {
    const GPO = await import("./goods-purchase-order.js");
    const pos = await GPO.list(clientId);
    for (const po of pos as any[]) {
      if (["cancelled", "fully_received"].includes(String(po.status))) continue;
      for (const ln of po.lines ?? []) {
        const outstanding = Number(ln.qty ?? ln.quantity ?? 0) - Number(ln.receivedQty ?? 0);
        if (outstanding > 0) poLines.push({ productId: String(ln.productId ?? ""), outstanding });
      }
    }
  } catch {
    /* trading module unavailable — incoming stays 0 */
  }
  const lines: ReadinessLine[] = [];
  for (const bom of b.bom ?? []) {
    const required = Number(bom.qtyPerUnit || 0) * Number(b.targetQty || 0);
    const available = await getBalance(bom.productId, movements);
    const reserved = await reservedForProduct(clientId, bom.productId, b.id);
    const incoming = poLines.filter((p) => p.productId === bom.productId).reduce((s, p) => s + p.outstanding, 0);
    lines.push({
      productId: bom.productId,
      sku: bom.sku ?? null,
      productName: bom.productName ?? null,
      category: bom.category ?? "other",
      required,
      available,
      reserved,
      incoming,
      shortage: Math.max(0, required - Math.max(0, available - reserved)),
    });
  }
  const totalShortage = lines.reduce((s, l) => s + l.shortage, 0);
  const materialStatus: MaterialStatus =
    (b.bom ?? []).length === 0
      ? "awaiting_inspection"
      : totalShortage === 0
        ? "ready"
        : lines.some((l) => l.available - l.reserved >= l.required * 0.5)
          ? "partial"
          : "blocked";
  if (materialStatus !== b.materialStatus) {
    await db.updateItem(b.pk, b.sk, { materialStatus, updatedAt: db.nowISO() });
  }
  return { batchId: b.id, batchNumber: b.batchNumber, materialStatus, lines, totalShortage };
}

// ---------------------------------------------------------------------------
// QualityInspection + CorrectiveAction (Stage H)
// ---------------------------------------------------------------------------

export interface InspectionCheck {
  item: string;
  result: "pass" | "fail" | "na";
  notes?: string | null;
}

export type InspectionOutcome = "pending" | "hold" | "released" | "rework";

export interface QualityInspection {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "QualityInspection";
  id: string;
  clientId: string;
  batchId: string;
  batchNumber: string | null;
  plannedQty: number;
  inspectedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  reworkQty: number;
  defectCategories: string[];
  checklist: InspectionCheck[];
  docs: Array<{ name: string; url: string }>;
  outcome: InspectionOutcome;
  inspector: string | null;
  inspectedAt: string | null;
  remarks: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const inspPk = (id: string) => `MFGINSP#${id}`;

export async function listInspections(clientId: string, batchId?: string): Promise<QualityInspection[]> {
  const { items } = await db.queryByGSI1(clientId, { entityType: "QualityInspection", limit: 500 });
  const all = items as QualityInspection[];
  const filtered = batchId ? all.filter((i) => i.batchId === batchId) : all;
  return filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function createInspection(data: {
  clientId: string;
  batchId: string;
  inspectedQty: number;
  acceptedQty: number;
  rejectedQty?: number;
  reworkQty?: number;
  defectCategories?: string[];
  checklist?: InspectionCheck[];
  docs?: Array<{ name: string; url: string }>;
  remarks?: string | null;
  createdBy?: string | null;
}): Promise<QualityInspection> {
  const b = await getBatch(data.batchId);
  if (!b || b.clientId !== data.clientId) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  const inspected = Number(data.inspectedQty);
  const accepted = Number(data.acceptedQty);
  const rejected = Number(data.rejectedQty ?? 0);
  const rework = Number(data.reworkQty ?? 0);
  if (!Number.isFinite(inspected) || inspected <= 0) throw new Error("inspectedQty must be > 0");
  for (const [k, v] of [["acceptedQty", accepted], ["rejectedQty", rejected], ["reworkQty", rework]] as const) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`${k} must be >= 0`);
  }
  if (accepted + rejected + rework > inspected) {
    throw new Error("accepted + rejected + rework cannot exceed inspected quantity");
  }
  if (accepted > Number(b.producedGoodQty || 0)) {
    throw Object.assign(
      new Error(`Accepted ${accepted} exceeds produced good output ${b.producedGoodQty}`),
      { statusCode: 409, code: "INSPECTION_EXCEEDS_OUTPUT" }
    );
  }
  const id = uuid();
  const now = db.nowISO();
  const item: QualityInspection = {
    pk: inspPk(id),
    sk: inspPk(id),
    gsi1pk: `CLIENT#${data.clientId}`,
    gsi1sk: `QualityInspection#${now}#${id}`,
    entityType: "QualityInspection",
    id,
    clientId: data.clientId,
    batchId: data.batchId,
    batchNumber: b.batchNumber,
    plannedQty: Number(b.targetQty || 0),
    inspectedQty: inspected,
    acceptedQty: accepted,
    rejectedQty: rejected,
    reworkQty: rework,
    defectCategories: data.defectCategories ?? [],
    checklist: data.checklist ?? [],
    docs: data.docs ?? [],
    outcome: "pending",
    inspector: null,
    inspectedAt: null,
    remarks: data.remarks ?? null,
    createdBy: data.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putItem(item);
  return item;
}

/**
 * Decide an inspection. hold → batch Hold + corrective loop; released →
 * additive partial release capped at acceptedQty; rework → batch rework.
 */
export async function decideInspection(data: {
  id: string;
  clientId: string;
  outcome: InspectionOutcome;
  releaseQty?: number | null;
  inspector: string | null;
  remarks?: string | null;
  idempotencyKey?: string | null;
}): Promise<QualityInspection> {
  const all = await db.scanByType("QualityInspection", { limit: 2000 });
  const item = (all as QualityInspection[]).find((i) => i.id === data.id && i.clientId === data.clientId);
  if (!item) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  if (!["pending", "hold", "released", "rework"].includes(data.outcome)) throw new Error("Invalid outcome");
  const b = await getBatch(item.batchId);
  if (!b) throw Object.assign(new Error("Batch not found"), { statusCode: 404 });
  const now = db.nowISO();
  const { updateItem } = await import("../dynamodb.js");

  if (data.outcome === "released") {
    // Released qty is reconciled: ≤ accepted, ≤ unreleased good output.
    const cap = Math.min(Number(item.acceptedQty || 0), Number(b.producedGoodQty || 0) - Number(b.releasedQty || 0));
    const qty = data.releaseQty == null ? cap : Number(data.releaseQty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error("Release quantity must be > 0");
    if (qty > cap) {
      throw Object.assign(
        new Error(`Cannot release ${qty} — reconciled cap is ${cap} (accepted ${item.acceptedQty}, unreleased good ${Number(b.producedGoodQty || 0) - Number(b.releasedQty || 0)})`),
        { statusCode: 409, code: "RELEASE_EXCEEDS_INSPECTION" }
      );
    }
    await releaseBatch({
      id: b.id,
      clientId: data.clientId,
      qty,
      idempotencyKey: data.idempotencyKey ?? `insp-${item.id}-release`,
      by: data.inspector,
      remarks: data.remarks ?? `Inspection ${item.id}`,
    });
    // Move batch out of review when fully released.
    const fresh = await getBatch(b.id);
    if (fresh && Number(fresh.releasedQty || 0) >= Number(fresh.producedGoodQty || 0) && ["quality_review", "on_hold", "rework"].includes(fresh.status)) {
      await updateItem(fresh.pk, fresh.sk, {
        status: "released",
        statusHistory: [...(fresh.statusHistory || []), { from: fresh.status, to: "released" as BatchStatus, by: data.inspector, at: now, notes: "Fully released via inspection" }],
        updatedAt: now,
      });
    }
  } else if (data.outcome === "hold") {
    const review: QualityReview = { by: data.inspector ?? "", at: now, from: b.qualityStatus, to: "Hold", remarks: data.remarks ?? `Inspection ${item.id} hold` };
    await updateItem(b.pk, b.sk, {
      qualityStatus: "Hold",
      qualityReviews: [...(b.qualityReviews || []), review],
      status: ["in_progress", "quality_review", "released"].includes(b.status) ? "on_hold" : b.status,
      statusHistory: [...(b.statusHistory || []), { from: b.status, to: "on_hold" as BatchStatus, by: data.inspector, at: now, notes: data.remarks ?? null }],
      updatedAt: now,
    });
  } else if (data.outcome === "rework") {
    await updateItem(b.pk, b.sk, {
      status: "rework",
      statusHistory: [...(b.statusHistory || []), { from: b.status, to: "rework" as BatchStatus, by: data.inspector, at: now, notes: data.remarks ?? null }],
      updatedAt: now,
    });
  }

  await updateItem(item.pk, item.sk, {
    outcome: data.outcome,
    inspector: data.inspector,
    inspectedAt: now,
    remarks: data.remarks ?? item.remarks,
    updatedAt: now,
  });
  return ((await db.getItem(item.pk)) as QualityInspection | null)!;
}

export type CorrectiveActionStatus = "open" | "in_progress" | "done" | "verified";

export interface CorrectiveAction {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "CorrectiveAction";
  id: string;
  clientId: string;
  batchId: string | null;
  inspectionId: string | null;
  issueId: string | null;
  title: string;
  description: string | null;
  assignee: string | null;
  dueDate: string | null;
  status: CorrectiveActionStatus;
  notes: string | null;
  history: Array<{ from: CorrectiveActionStatus; to: CorrectiveActionStatus; by: string | null; at: string }>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const caPk = (id: string) => `MFGCA#${id}`;

const CA_TRANSITIONS: Record<CorrectiveActionStatus, CorrectiveActionStatus[]> = {
  open: ["in_progress"],
  in_progress: ["done", "open"],
  done: ["verified", "in_progress"],
  verified: [],
};

export async function listCorrectiveActions(clientId: string, batchId?: string): Promise<CorrectiveAction[]> {
  const { items } = await db.queryByGSI1(clientId, { entityType: "CorrectiveAction", limit: 500 });
  const all = items as CorrectiveAction[];
  const filtered = batchId ? all.filter((c) => c.batchId === batchId) : all;
  return filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function createCorrectiveAction(data: {
  clientId: string;
  batchId?: string | null;
  inspectionId?: string | null;
  issueId?: string | null;
  title: string;
  description?: string | null;
  assignee?: string | null;
  dueDate?: string | null;
  createdBy?: string | null;
}): Promise<CorrectiveAction> {
  if (!data.title?.trim()) throw new Error("Title is required");
  const id = uuid();
  const now = db.nowISO();
  const item: CorrectiveAction = {
    pk: caPk(id),
    sk: caPk(id),
    gsi1pk: `CLIENT#${data.clientId}`,
    gsi1sk: `CorrectiveAction#${now}#${id}`,
    entityType: "CorrectiveAction",
    id,
    clientId: data.clientId,
    batchId: data.batchId ?? null,
    inspectionId: data.inspectionId ?? null,
    issueId: data.issueId ?? null,
    title: data.title.trim(),
    description: data.description ?? null,
    assignee: data.assignee ?? null,
    dueDate: data.dueDate ?? null,
    status: "open",
    notes: null,
    history: [],
    createdBy: data.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putItem(item);
  return item;
}

export async function transitionCorrectiveAction(
  id: string,
  clientId: string,
  to: CorrectiveActionStatus,
  actor: string | null,
  notes?: string | null
): Promise<CorrectiveAction | null> {
  const all = await db.scanByType("CorrectiveAction", { limit: 2000 });
  const item = (all as CorrectiveAction[]).find((c) => c.id === id && c.clientId === clientId);
  if (!item) return null;
  if (!(CA_TRANSITIONS[item.status] ?? []).includes(to)) {
    throw Object.assign(new Error(`Cannot move corrective action from ${item.status} to ${to}`), {
      statusCode: 409,
      code: "INVALID_CA_TRANSITION",
    });
  }
  const now = db.nowISO();
  await db.updateItem(item.pk, item.sk, {
    status: to,
    notes: notes ?? item.notes,
    history: [...(item.history || []), { from: item.status, to, by: actor, at: now }],
    updatedAt: now,
  });
  return (await db.getItem(item.pk)) as CorrectiveAction | null;
}

// ---------------------------------------------------------------------------
// AccountingHandoff — Tally / IRN / e-way bill queue (Stage K)
// Sandbox adapter is ALWAYS labelled simulated unless manufacturing-config
// tallyMode is live-test AND a live connector responds. Never mark success
// without a confirmed response. Idempotent per idempotencyKey.
// ---------------------------------------------------------------------------

export type HandoffKind = "tally" | "irn" | "ewaybill";
export type HandoffStatus = "pending" | "processing" | "success" | "failed" | "not_required" | "cancelled";

export interface AccountingHandoff {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  entityType: "AccountingHandoff";
  id: string;
  clientId: string;
  kind: HandoffKind;
  docType: string;
  docId: string;
  docNumber: string | null;
  batchId: string | null;
  customer: string | null;
  amount: number | null;
  voucherType: string | null;
  status: HandoffStatus;
  simulated: boolean;
  externalRef: string | null;
  lastError: string | null;
  attempts: number;
  idempotencyKey: string;
  history: Array<{ status: HandoffStatus; at: string; by: string | null; detail?: string | null }>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

const hoPk = (id: string) => `MFGHO#${id}`;

export async function listHandoffs(clientId: string, status?: string): Promise<AccountingHandoff[]> {
  const { items } = await db.queryByGSI1(clientId, { entityType: "AccountingHandoff", limit: 500 });
  const all = items as AccountingHandoff[];
  const filtered = status ? all.filter((h) => h.status === status) : all;
  return filtered.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function prepareHandoff(data: {
  clientId: string;
  kind: HandoffKind;
  docType: string;
  docId: string;
  docNumber?: string | null;
  batchId?: string | null;
  customer?: string | null;
  amount?: number | null;
  voucherType?: string | null;
  idempotencyKey: string;
  createdBy?: string | null;
}): Promise<{ handoff: AccountingHandoff; duplicate: boolean }> {
  if (!["tally", "irn", "ewaybill"].includes(data.kind)) throw new Error("Invalid kind");
  if (!data.idempotencyKey) throw new Error("idempotencyKey is required");
  const { items } = await db.queryByGSI1(data.clientId, { entityType: "AccountingHandoff", limit: 500 });
  const existing = (items as AccountingHandoff[]).find((h) => h.idempotencyKey === data.idempotencyKey);
  if (existing) return { handoff: existing, duplicate: true };
  // Eligibility: e-way bills apply at/above the statutory threshold; IRN only
  // when the tenant opts in via tallyMode live-test, else not_required.
  const cfg = await getConfig(data.clientId);
  let status: HandoffStatus = "pending";
  if (data.kind === "ewaybill" && (data.amount ?? 0) < 50000) status = "not_required";
  const id = uuid();
  const now = db.nowISO();
  const item: AccountingHandoff = {
    pk: hoPk(id),
    sk: hoPk(id),
    gsi1pk: `CLIENT#${data.clientId}`,
    gsi1sk: `AccountingHandoff#${now}#${id}`,
    entityType: "AccountingHandoff",
    id,
    clientId: data.clientId,
    kind: data.kind,
    docType: data.docType,
    docId: data.docId,
    docNumber: data.docNumber ?? null,
    batchId: data.batchId ?? null,
    customer: data.customer ?? null,
    amount: data.amount ?? null,
    voucherType: data.voucherType ?? (data.kind === "tally" ? "Sales" : null),
    status,
    simulated: cfg.tallyMode !== "live-test",
    externalRef: null,
    lastError: null,
    attempts: 0,
    idempotencyKey: data.idempotencyKey,
    history: [{ status, at: now, by: data.createdBy ?? null, detail: "Prepared" }],
    createdBy: data.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.putItem(item);
  return { handoff: item, duplicate: false };
}

/**
 * Send (or retry) a handoff through the sandbox adapter. The adapter honours
 * `forceFail` for the failed-then-retry demo scenario; every attempt is
 * recorded and only a confirmed adapter response marks success.
 */
export async function sendHandoff(
  id: string,
  clientId: string,
  actor: string | null,
  opts?: { forceFail?: boolean; failReason?: string }
): Promise<AccountingHandoff> {
  const item = ((await db.getItem(hoPk(id))) as AccountingHandoff | null);
  if (!item || item.clientId !== clientId) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  if (item.status === "success") return item;
  if (item.status === "cancelled" || item.status === "not_required") {
    throw Object.assign(new Error(`Handoff is ${item.status}`), { statusCode: 409 });
  }
  const now = db.nowISO();
  const attempts = Number(item.attempts || 0) + 1;
  await db.updateItem(item.pk, item.sk, {
    status: "processing",
    attempts,
    history: [...(item.history || []), { status: "processing" as HandoffStatus, at: now, by: actor, detail: `Attempt ${attempts}` }],
    updatedAt: now,
  });
  // Sandbox adapter: deterministic, labelled, retryable.
  if (opts?.forceFail) {
    const reason = opts.failReason ?? "Sandbox adapter rejected the voucher (simulated failure)";
    await db.updateItem(item.pk, item.sk, {
      status: "failed",
      lastError: reason,
      history: [...(item.history || []), { status: "processing" as HandoffStatus, at: now, by: actor, detail: `Attempt ${attempts}` }, { status: "failed" as HandoffStatus, at: now, by: actor, detail: reason }],
      updatedAt: now,
    });
  } else {
    const ref = `SANDBOX-${item.kind.toUpperCase()}-${item.id.slice(0, 8).toUpperCase()}-A${attempts}`;
    await db.updateItem(item.pk, item.sk, {
      status: "success",
      externalRef: ref,
      lastError: null,
      history: [...(item.history || []), { status: "processing" as HandoffStatus, at: now, by: actor, detail: `Attempt ${attempts}` }, { status: "success" as HandoffStatus, at: now, by: actor, detail: `Confirmed ref ${ref} (SIMULATED)` }],
      updatedAt: now,
    });
  }
  return ((await db.getItem(item.pk)) as AccountingHandoff | null)!;
}

export async function cancelHandoff(id: string, clientId: string, actor: string | null): Promise<AccountingHandoff | null> {
  const item = ((await db.getItem(hoPk(id))) as AccountingHandoff | null);
  if (!item || item.clientId !== clientId) return null;
  if (item.status === "success") throw Object.assign(new Error("Successful handoffs cannot be cancelled"), { statusCode: 409 });
  await db.updateItem(item.pk, item.sk, {
    status: "cancelled",
    history: [...(item.history || []), { status: "cancelled", at: db.nowISO(), by: actor }],
    updatedAt: db.nowISO(),
  });
  return (await db.getItem(item.pk)) as AccountingHandoff | null;
}

// ---------------------------------------------------------------------------
// workflowOverview — real-data control-center aggregation (Stage M)
// Every number derives from stored records; nothing is fabricated. Optional
// trading-module reads (orders/dispatches/POs) are best-effort and never
// break the manufacturing overview.
// ---------------------------------------------------------------------------

export type PipelineStage =
  | "awaiting_materials"
  | "ready_for_planning"
  | "planned"
  | "in_production"
  | "production_completed"
  | "awaiting_quality"
  | "quality_hold"
  | "released"
  | "ready_for_dispatch"
  | "dispatched";

function pipelineStageOf(b: ManufacturingBatch): PipelineStage {
  if (b.status === "released" || b.status === "closed") return "dispatched";
  if (b.qualityStatus === "Released" && availableQty(b) > 0) return "ready_for_dispatch";
  if (b.qualityStatus === "Released") return "released";
  if (b.qualityStatus === "Hold" || b.status === "on_hold") return "quality_hold";
  if (b.status === "quality_review" || b.status === "completed") return "awaiting_quality";
  if (b.status === "in_progress" || b.status === "rework") return "in_production";
  if (b.status === "planned" || b.status === "draft") {
    return b.materialStatus === "ready" ? "ready_for_planning" : "awaiting_materials";
  }
  if (b.status === "ready_to_start") return "ready_for_planning";
  return "planned";
}

export interface AttentionItem {
  severity: "critical" | "warning" | "info";
  title: string;
  detail: string | null;
  batchId: string | null;
  batchNumber: string | null;
  link: { tab: string; filter?: string };
}

export interface ActivityEvent {
  at: string;
  kind: string;
  text: string;
  by: string | null;
  batchId: string | null;
  batchNumber: string | null;
}

export async function workflowOverview(clientId: string): Promise<{
  kpis: Record<string, number>;
  pipeline: Array<{ stage: PipelineStage; count: number }>;
  attention: AttentionItem[];
  activity: ActivityEvent[];
  generatedAt: string;
}> {
  const [batches, issues, inspections, actions, handoffs] = await Promise.all([
    listBatches(clientId),
    listIssues(clientId),
    listInspections(clientId),
    listCorrectiveActions(clientId),
    listHandoffs(clientId),
  ]);
  const { list: listMovements, getBalance } = await import("./stock-movement.js");
  const movements = await listMovements(clientId).catch(() => []);
  const now = Date.now();
  const soonMs = 7 * 24 * 3600 * 1000;

  // Material shortages: required (BOM × target) minus free stock, per batch.
  const reservations = await listReservations(clientId).catch(() => []);
  const reservedByProduct = new Map<string, number>();
  for (const r of reservations) {
    if (r.status !== "active") continue;
    reservedByProduct.set(r.productId, (reservedByProduct.get(r.productId) ?? 0) + Number(r.qty || 0));
  }
  const balanceByProduct = new Map<string, number>();
  const balanceOf = async (pid: string) => {
    if (!balanceByProduct.has(pid)) balanceByProduct.set(pid, await getBalance(pid, movements));
    return balanceByProduct.get(pid)!;
  };
  let materialShortages = 0;
  const batchShortage = new Map<string, number>();
  for (const b of batches) {
    if (["released", "closed", "cancelled", "rejected"].includes(b.status)) continue;
    let short = 0;
    for (const line of b.bom ?? []) {
      const required = Number(line.qtyPerUnit || 0) * Number(b.targetQty || 0);
      const free = (await balanceOf(line.productId)) - (reservedByProduct.get(line.productId) ?? 0);
      short += Math.max(0, required - Math.max(0, free));
    }
    batchShortage.set(b.id, short);
    if (short > 0) materialShortages++;
  }

  const openIssues = issues.filter((i) => i.status !== "closed");
  const overdueIssues = openIssues.filter((i) => i.expectedResolutionAt && new Date(i.expectedResolutionAt).getTime() < now);
  const heldPendingQty = batches
    .filter((b) => b.qualityStatus !== "Released")
    .reduce((s, b) => s + Math.max(0, Number(b.producedGoodQty || 0) - Number(b.releasedQty || 0)), 0);
  const awaitingReview = batches.filter((b) =>
    ["completed", "quality_review"].includes(b.status) && b.qualityStatus === "Pending"
  ).length;
  const releasedStock = batches.reduce((s, b) => s + availableQty(b), 0);
  const readyDispatch = batches.filter((b) => availableQty(b) > 0).length;
  const openBatches = batches.filter((b) => !["closed", "cancelled", "rejected"].includes(b.status)).length;
  const good = batches.reduce((s, b) => s + Number(b.producedGoodQty || 0), 0);
  const rejected = batches.reduce((s, b) => s + Number(b.rejectedQty || 0), 0);
  const failedHandoffs = handoffs.filter((h) => h.status === "failed").length;
  const pendingHandoffs = handoffs.filter((h) => h.status === "pending" || h.status === "processing").length;
  let atRisk = 0;
  for (const b of batches) {
    if (["released", "closed", "cancelled", "rejected"].includes(b.status) || !b.deliveryDate) continue;
    if (new Date(b.deliveryDate).getTime() - now < soonMs) atRisk++;
  }

  const kpis: Record<string, number> = {
    openBatches,
    materialShortages,
    goodOutput: good,
    rejects: rejected,
    openIssues: openIssues.length,
    overdueIssues: overdueIssues.length,
    heldPendingQty,
    awaitingReview,
    releasedStock,
    readyDispatch,
    pendingHandoffs,
    failedHandoffs,
    atRiskOrders: atRisk,
  };

  const stages: PipelineStage[] = [
    "awaiting_materials", "ready_for_planning", "planned", "in_production",
    "production_completed", "awaiting_quality", "quality_hold", "released",
    "ready_for_dispatch", "dispatched",
  ];
  const counts = new Map<PipelineStage, number>(stages.map((s) => [s, 0]));
  for (const b of batches) {
    if (["cancelled", "rejected"].includes(b.status)) continue;
    const st = pipelineStageOf(b);
    counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  // production_completed is folded into awaiting_quality via completion flow;
  // surface completed-but-not-yet-reviewed explicitly for the pipeline.
  const completedOnly = batches.filter((b) => b.status === "completed").length;
  counts.set("production_completed", completedOnly);

  const attention: AttentionItem[] = [];
  for (const b of batches) {
    const short = batchShortage.get(b.id) ?? 0;
    if (short > 0 && !["released", "closed", "cancelled", "rejected"].includes(b.status)) {
      attention.push({
        severity: b.materialStatus === "blocked" ? "critical" : "warning",
        title: `Material shortage blocks ${b.batchNumber}`,
        detail: `${short} units short across BOM lines`,
        batchId: b.id,
        batchNumber: b.batchNumber,
        link: { tab: "materials", filter: b.id },
      });
    }
    if (b.deliveryDate && !["released", "closed", "cancelled", "rejected"].includes(b.status)) {
      const dt = new Date(b.deliveryDate).getTime() - now;
      if (dt < 0) {
        attention.push({ severity: "critical", title: `${b.batchNumber} is past its delivery date`, detail: b.deliveryDate, batchId: b.id, batchNumber: b.batchNumber, link: { tab: "batches", filter: b.id } });
      } else if (dt < soonMs) {
        attention.push({ severity: "warning", title: `${b.batchNumber} delivery due within 7 days`, detail: b.deliveryDate, batchId: b.id, batchNumber: b.batchNumber, link: { tab: "batches", filter: b.id } });
      }
    }
    if ((b.qualityStatus === "Hold" || b.status === "on_hold") && !["closed", "cancelled"].includes(b.status)) {
      attention.push({ severity: "critical", title: `${b.batchNumber} is on quality hold`, detail: "Corrective action + re-review required", batchId: b.id, batchNumber: b.batchNumber, link: { tab: "quality", filter: b.id } });
    }
    if (["completed", "quality_review"].includes(b.status) && b.qualityStatus === "Pending") {
      attention.push({ severity: "warning", title: `${b.batchNumber} awaits quality review`, detail: `${b.producedGoodQty} good units pending inspection`, batchId: b.id, batchNumber: b.batchNumber, link: { tab: "quality", filter: b.id } });
    }
    if (availableQty(b) > 0) {
      attention.push({ severity: "info", title: `${b.batchNumber} has ${availableQty(b)} released units awaiting dispatch`, detail: null, batchId: b.id, batchNumber: b.batchNumber, link: { tab: "dispatch", filter: b.id } });
    }
  }
  for (const i of overdueIssues) {
    attention.push({ severity: "critical", title: `Overdue issue: ${i.title}`, detail: `Line ${i.lineName ?? "—"} · batch ${i.affectedBatchNumber ?? "—"}`, batchId: i.affectedBatchId, batchNumber: i.affectedBatchNumber, link: { tab: "issues", filter: i.id } });
  }
  for (const h of handoffs.filter((h) => h.status === "failed")) {
    attention.push({ severity: "critical", title: `${h.kind} handoff failed (${h.docNumber ?? h.docId})`, detail: h.lastError, batchId: h.batchId, batchNumber: null, link: { tab: "tally", filter: h.id } });
  }
  const sevRank = { critical: 0, warning: 1, info: 2 };
  attention.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  const activity: ActivityEvent[] = [];
  for (const b of batches) {
    activity.push({ at: b.createdAt, kind: "batch_created", text: `Batch ${b.batchNumber} created (target ${b.targetQty})`, by: b.createdBy, batchId: b.id, batchNumber: b.batchNumber });
    for (const h of b.statusHistory ?? []) {
      activity.push({ at: h.at, kind: "batch_status", text: `Batch ${b.batchNumber}: ${h.from} → ${h.to}`, by: h.by, batchId: b.id, batchNumber: b.batchNumber });
    }
    for (const r of b.qualityReviews ?? []) {
      activity.push({ at: r.at, kind: "quality", text: `Batch ${b.batchNumber}: quality ${r.from} → ${r.to}${r.remarks ? ` — ${r.remarks}` : ""}`, by: r.by, batchId: b.id, batchNumber: b.batchNumber });
    }
  }
  for (const i of issues) {
    activity.push({ at: i.createdAt, kind: "issue", text: `Issue reported: ${i.title} (${i.type})`, by: i.createdBy, batchId: i.affectedBatchId, batchNumber: i.affectedBatchNumber });
    for (const h of (i as any).statusHistory ?? []) {
      activity.push({ at: h.at, kind: "issue", text: `Issue ${i.title}: ${h.from} → ${h.to}`, by: h.by, batchId: i.affectedBatchId, batchNumber: i.affectedBatchNumber });
    }
  }
  for (const h of handoffs) {
    const last = (h.history ?? [])[(h.history ?? []).length - 1];
    if (last) activity.push({ at: last.at, kind: "handoff", text: `${h.kind} handoff ${h.docNumber ?? h.docId}: ${last.status}${last.detail ? ` — ${last.detail}` : ""}`, by: last.by, batchId: h.batchId, batchNumber: null });
  }
  for (const c of actions.filter((c) => c.status === "verified" || c.status === "done")) {
    activity.push({ at: c.updatedAt, kind: "corrective", text: `Corrective action ${c.status}: ${c.title}`, by: null, batchId: c.batchId, batchNumber: null });
  }
  activity.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return {
    kpis,
    pipeline: stages.map((stage) => ({ stage, count: counts.get(stage) ?? 0 })),
    attention: attention.slice(0, 50),
    activity: activity.slice(0, 50),
    generatedAt: new Date().toISOString(),
  };
}

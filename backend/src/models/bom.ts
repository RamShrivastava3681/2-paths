import { v4 as uuid } from "uuid";
import * as db from "../dynamodb.js";
import * as Product from "./product.js";

/** One raw-material line on a Bill of Materials. */
export interface BOMLine {
  /** Raw material product (catalogue SKU). */
  productId: string;
  sku?: string | null;
  productName?: string | null;
  /** Material units consumed per finished unit. */
  qtyPerUnit: number;
  /** Unit of measure (piece, metre, carton, …). Validated against the material product's unitOfMeasure. */
  unitOfMeasure: string;
  /** Wastage percentage (0–100) applied to this line only. Default 0. */
  wastagePct: number;
  /** Optional size this line applies to. Null = applies to all sizes of the style. */
  size?: string | null;
  /** Optional colour this line applies to. Null = applies to all colours of the style. */
  color?: string | null;
  /** FB/TRIM/PACK category for readability. */
  category?: "fabric" | "trim" | "packaging" | "other";
}

/** Approval lifecycle for a BOM. */
export type BOMStatus = "draft" | "approved" | "archived";

export interface BillOfMaterial {
  pk: string;
  sk: string;
  gsi1pk: string;
  gsi1sk: string;
  gsi2pk: string;
  gsi2sk: string;
  entityType: "BillOfMaterial";
  id: string;
  clientId: string;
  /** The finished product / style this BOM belongs to (parent or variant product). */
  productId: string;
  sku?: string | null;
  productName?: string | null;
  /** Integer version, starting at 1. Only one BOM per product may be "approved" at a time. */
  version: number;
  status: BOMStatus;
  lines: BOMLine[];
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
}

const bomPk = (id: string) => `BOM#${id}`;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function validateLine(line: any, allProducts: Map<string, any>): BOMLine {
  if (!line.productId) throw new Error("BOM line productId is required");
  const qty = Number(line.qtyPerUnit);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error(`BOM line qtyPerUnit must be > 0 (product ${line.productId})`);
  }
  const wastage = Number(line.wastagePct ?? 0);
  if (!Number.isFinite(wastage) || wastage < 0 || wastage > 100) {
    throw new Error(`BOM line wastagePct must be 0–100 (product ${line.productId})`);
  }
  const uom = String(line.unitOfMeasure ?? "piece").trim() || "piece";
  const product = allProducts.get(line.productId);
  if (product) {
    // Unit must be compatible with the material product's catalogue unit.
    const catalogueUom = String(product.unitOfMeasure || "piece").trim();
    if (uom.toLowerCase() !== catalogueUom.toLowerCase()) {
      throw new Error(
        `Unit of measure "${uom}" is incompatible with material "${line.productId}" (catalogue unit: ${catalogueUom})`,
      );
    }
    if (!line.sku) line.sku = product.sku ?? null;
    if (!line.productName) line.productName = product.name ?? null;
  }
  return {
    productId: line.productId,
    sku: line.sku ?? null,
    productName: line.productName ?? null,
    qtyPerUnit: qty,
    unitOfMeasure: uom,
    wastagePct: wastage,
    size: line.size ?? null,
    color: line.color ?? null,
    category: (line.category ?? "other") as BOMLine["category"],
  };
}

function validateLines(lines: any[], allProducts: Map<string, any>): BOMLine[] {
  const out: BOMLine[] = [];
  const seen = new Set<string>();
  for (const line of lines ?? []) {
    const normalized = validateLine(line, allProducts);
    // Duplicate material lines: same product + size + color = duplicate.
    const key = `${normalized.productId}|${normalized.size ?? ""}|${normalized.color ?? ""}`.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate material line for ${normalized.productId} (size=${normalized.size ?? "any"}, color=${normalized.color ?? "any"})`);
    }
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export async function list(clientId: string): Promise<BillOfMaterial[]> {
  const { items } = await db.queryByGSI1(clientId, {
    entityType: "BillOfMaterial",
    limit: 500,
  });
  return (items as BillOfMaterial[]).sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt))
  );
}

export async function get(id: string): Promise<BillOfMaterial | null> {
  return (await db.getItem(bomPk(id))) as BillOfMaterial | null;
}
export async function getByProduct(clientId: string, productId: string): Promise<BillOfMaterial[]> {
  const all = await list(clientId);
  return all.filter((b) => b.productId === productId);
}

/** Find the single approved BOM for a product, or null. */
export async function getApprovedByProduct(
  clientId: string,
  productId: string,
): Promise<BillOfMaterial | null> {
  const all = await getByProduct(clientId, productId);
  const approved = all.filter((b) => b.status === "approved");
  if (approved.length === 0) return null;
  // Return the highest approved version.
  return approved.sort((a, b) => (b.version || 0) - (a.version || 0))[0];
}

export async function create(data: {
  clientId: string;
  productId: string;
  sku?: string | null;
  productName?: string | null;
  lines: any[];
  createdBy?: string | null;
}): Promise<BillOfMaterial> {
  const clientId = data.clientId;
  const product = await Product.get(data.productId);
  if (!product) throw Object.assign(new Error("Product not found"), { statusCode: 404 });
  if (product.clientId !== clientId) throw Object.assign(new Error("Access denied"), { statusCode: 403 });

  // All products (to validate units / snapshot names).
  const allProducts = new Map<string, any>();
  for (const p of await Product.list()) {
    allProducts.set(p.id, p);
  }

  const lines = validateLines(data.lines, allProducts);
  if (lines.length === 0) throw new Error("A BOM must have at least one material line");

  // Next version for this product (1 if none exist).
  const existing = await getByProduct(clientId, data.productId);
  const nextVersion = Math.max(0, ...existing.map((b) => Number(b.version || 0))) + 1;

  const id = uuid();
  const now = db.nowISO();
  const item: BillOfMaterial = {
    pk: bomPk(id),
    sk: bomPk(id),
    gsi1pk: `CLIENT#${clientId}`,
    gsi1sk: `BillOfMaterial#${now}#${id}`,
    gsi2pk: `PRODUCT#${data.productId}`,
    gsi2sk: `BillOfMaterial#${nextVersion}#${now}`,
    entityType: "BillOfMaterial",
    id,
    clientId,
    productId: data.productId,
    sku: data.sku ?? product.sku ?? null,
    productName: data.productName ?? product.name ?? null,
    version: nextVersion,
    status: "draft",
    lines,
    createdBy: data.createdBy ?? null,
    createdAt: now,
    updatedBy: data.createdBy ?? null,
    updatedAt: now,
    approvedBy: null,
    approvedAt: null,
  };
  await db.putItem(item);
  return item;
}

export async function update(
  id: string,
  clientId: string,
  updates: { lines?: any[]; productName?: string | null; sku?: string | null },
  actor?: string | null,
): Promise<BillOfMaterial | null> {
  const current = await get(id);
  if (!current || current.clientId !== clientId) return null;
  if (current.status !== "draft") {
    throw Object.assign(new Error("Only a draft BOM can be edited"), {
      statusCode: 409,
      code: "BOM_NOT_DRAFT",
    });
  }

  const allProducts = new Map<string, any>();
  for (const p of await Product.list()) {
    allProducts.set(p.id, p);
  }

  const patch: Record<string, any> = { updatedBy: actor ?? null, updatedAt: db.nowISO() };
  if (updates.lines !== undefined) {
    patch.lines = validateLines(updates.lines, allProducts);
    if (patch.lines.length === 0) throw new Error("A BOM must have at least one material line");
  }
  if (updates.productName !== undefined) patch.productName = updates.productName;
  if (updates.sku !== undefined) patch.sku = updates.sku;
  return db.updateItem(current.pk, current.sk, patch) as unknown as BillOfMaterial | null;
}

export async function remove(id: string, clientId: string): Promise<boolean> {
  const current = await get(id);
  if (!current || current.clientId !== clientId) return false;
  if (current.status === "approved") {
    throw Object.assign(new Error("An approved BOM cannot be deleted — archive it instead"), {
      statusCode: 409,
      code: "BOM_APPROVED",
    });
  }
  await db.deleteItem(current.pk, current.sk);
  return true;
}

export async function archive(id: string, clientId: string, actor?: string | null): Promise<BillOfMaterial | null> {
  const current = await get(id);
  if (!current || current.clientId !== clientId) return null;
  if (current.status === "archived") return current;
  return db.updateItem(current.pk, current.sk, {
    status: "archived",
    updatedBy: actor ?? null,
    updatedAt: db.nowISO(),
  }) as unknown as BillOfMaterial | null;
}

/**
 * Approve a BOM. Only one approved BOM per product may exist at a time.
 * Approving drafts a new version when an approved BOM already exists (version++).
 * Idempotent: re-approving the same approved BOM is a no-op.
 */
export async function approve(
  id: string,
  clientId: string,
  actor: string | null,
): Promise<BillOfMaterial | null> {
  const current = await get(id);
  if (!current || current.clientId !== clientId) return null;
  if (current.status === "approved") return current;

  // Demote any other approved BOM for this product.
  const existing = await getByProduct(clientId, current.productId);
  const toDemote = existing.filter((b) => b.status === "approved" && b.id !== current.id);
  for (const b of toDemote) {
    await db.updateItem(b.pk, b.sk, {
      status: "archived",
      updatedBy: actor ?? null,
      updatedAt: db.nowISO(),
    });
  }

  // The version is assigned at draft creation (create()). Approving simply
  // promotes the draft to the approved slot, demoting any prior approved BOM
  // for the same product to archived. The version stays as created so the
  // approved BOM always carries the version it was created with.
  const nextVersion = current.version;

  const now = db.nowISO();
  await db.updateItem(current.pk, current.sk, {
    status: "approved",
    version: nextVersion,
    approvedBy: actor ?? null,
    approvedAt: now,
    updatedBy: actor ?? null,
    updatedAt: now,
  });
  return get(id);
}

/**
 * Calculate material requirements for a confirmed Sales Order.
 * Returns per-line requirements aggregated by material SKU + UoM, with a
 * product-level breakdown and a flag when a variant has no approved BOM.
 */
export interface SoMaterialLine {
  materialProductId: string;
  materialSku: string | null;
  materialName: string | null;
  unitOfMeasure: string;
  size?: string | null;
  color?: string | null;
  category: string;
  baseQty: number; // orderedQty * qtyPerUnit
  wastageQty: number; // baseQty * wastagePct / 100
  totalQty: number; // base + wastage
  sourceLines: Array<{
    salesOrderId: string;
    soNumber: string | null;
    productId: string;
    productName: string | null;
    size: string | null;
    color: string | null;
    orderedQty: number;
    bomVersion: number;
    qtyPerUnit: number;
  }>;
}

export interface SoMaterialResult {
  salesOrderId: string;
  soNumber: string | null;
  bomMissing: Array<{
    productId: string;
    productName: string | null;
    sku: string | null;
    size: string | null;
    color: string | null;
    orderedQty: number;
  }>;
  lines: SoMaterialLine[];
  totalLines: number;
}

export async function calculateSoMaterialRequirements(
  clientId: string,
  salesOrderId: string,
): Promise<SoMaterialResult> {
  const GoodsSO = await import("./goods-sales-order.js");
  const so = await GoodsSO.get(salesOrderId);
  if (!so || so.clientId !== clientId) {
    throw Object.assign(new Error("Sales order not found"), { statusCode: 404 });
  }

  // Group SO lines by product + size + color.
  const bomMissing: SoMaterialResult["bomMissing"] = [];
  const materialMap = new Map<string, SoMaterialLine>();

  const allProducts = new Map<string, any>();
  for (const p of await Product.list()) {
    allProducts.set(p.id, p);
  }

  for (const line of so.lines ?? []) {
    if (!line.productId) continue;
    const product = allProducts.get(line.productId);
    const orderedQty = Number(line.orderedQty ?? 0);
    if (orderedQty <= 0) continue;

    const bom = await getApprovedByProduct(clientId, line.productId);
    if (!bom) {
      bomMissing.push({
        productId: line.productId,
        productName: line.name ?? product?.name ?? null,
        sku: line.sku ?? product?.sku ?? null,
        size: line.size ?? null,
        color: line.color ?? null,
        orderedQty,
      });
      continue;
    }

    for (const bomLine of bom.lines ?? []) {
      // Size/color match: a BOM line applies if its size/color is null (any) or equals the ordered variant.
      if (bomLine.size !== null && bomLine.size !== undefined && String(bomLine.size) !== String(line.size ?? "")) continue;
      if (bomLine.color !== null && bomLine.color !== undefined && String(bomLine.color) !== String(line.color ?? "")) continue;

      const baseQty = round4(orderedQty * bomLine.qtyPerUnit);
      const wastageQty = round4(baseQty * (bomLine.wastagePct || 0) / 100);
      const totalQty = round4(baseQty + wastageQty);

      const key = `${bomLine.productId}|${bomLine.unitOfMeasure}|${bomLine.size ?? ""}|${bomLine.color ?? ""}`.toLowerCase();
      const existing = materialMap.get(key);
      const sourceEntry = {
        salesOrderId: so.id,
        soNumber: so.soNumber ?? null,
        productId: line.productId,
        productName: line.name ?? null,
        size: line.size ?? null,
        color: line.color ?? null,
        orderedQty,
        bomVersion: bom.version,
        qtyPerUnit: bomLine.qtyPerUnit,
      };
      if (existing) {
        existing.baseQty = round4(existing.baseQty + baseQty);
        existing.wastageQty = round4(existing.wastageQty + wastageQty);
        existing.totalQty = round4(existing.totalQty + totalQty);
        existing.sourceLines.push(sourceEntry);
      } else {
        const matProduct = allProducts.get(bomLine.productId);
        materialMap.set(key, {
          materialProductId: bomLine.productId,
          materialSku: bomLine.sku ?? matProduct?.sku ?? null,
          materialName: bomLine.productName ?? matProduct?.name ?? null,
          unitOfMeasure: bomLine.unitOfMeasure,
          size: bomLine.size ?? null,
          color: bomLine.color ?? null,
          category: bomLine.category ?? "other",
          baseQty,
          wastageQty,
          totalQty,
          sourceLines: [sourceEntry],
        });
      }
    }
  }

  const lines = Array.from(materialMap.values());
  return {
    salesOrderId: so.id,
    soNumber: so.soNumber ?? null,
    bomMissing,
    lines,
    totalLines: lines.length,
  };
}

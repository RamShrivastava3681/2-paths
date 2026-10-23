import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import * as Mfg from "../models/manufacturing.js";
import * as GoodsSO from "../models/goods-sales-order.js";
import * as GoodsPO from "../models/goods-purchase-order.js";
import * as GoodsDispatch from "../models/goods-dispatch.js";
import * as Bom from "../models/bom.js";

const router = Router();

router.use(authMiddleware);

function errStatus(err: any): number {
  if (err?.statusCode && Number.isFinite(err.statusCode)) return err.statusCode;
  return 500;
}

// ---------------------------------------------------------------------------
// Business mode + manufacturing config (tenant-level, drives nav + dashboard)
// ---------------------------------------------------------------------------

router.get("/business-mode", async (req, res) => {
  try {
    const mode = await Mfg.getBusinessMode(req.user!.userId);
    res.json({ mode });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/business-mode", async (req, res) => {
  try {
    const item = await Mfg.setBusinessMode(req.user!.userId, req.body?.mode);
    res.json(item);
  } catch (err: any) {
    res.status(errStatus(err) === 500 ? 400 : errStatus(err)).json({ error: err.message });
  }
});

router.get("/manufacturing-config", async (req, res) => {
  try {
    res.json(await Mfg.getConfig(req.user!.userId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/manufacturing-config", async (req, res) => {
  try {
    res.json(await Mfg.updateConfig(req.user!.userId, req.body ?? {}));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

router.get("/manufacturing-batches", async (req, res) => {
  try {
    const batches = await Mfg.listBatches(req.user!.userId);
    res.json(batches.map((b) => ({ ...b, availableQty: Mfg.availableQty(b) })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/manufacturing-batches", async (req, res) => {
  try {
    const b = await Mfg.createBatch({
      clientId: req.user!.userId,
      salesOrderId: req.body?.salesOrderId ?? null,
      salesOrderNumber: req.body?.salesOrderNumber ?? null,
      productId: req.body?.productId ?? null,
      sku: req.body?.sku ?? null,
      productName: req.body?.productName ?? null,
      targetQty: req.body?.targetQty,
      lineId: req.body?.lineId ?? null,
      lineName: req.body?.lineName ?? null,
      shiftId: req.body?.shiftId ?? null,
      notes: req.body?.notes ?? null,
      isDemoData: !!req.body?.isDemoData,
      createdBy: req.user!.userId,
    });
    res.status(201).json({ ...b, availableQty: Mfg.availableQty(b) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/manufacturing-batches/:id", async (req, res) => {
  try {
    const b = await Mfg.getBatch(req.params.id);
    if (!b || b.clientId !== req.user!.userId) return res.status(404).json({ error: "Not found" });
    const updates = await Mfg.listUpdates(b.id);
    res.json({ ...b, availableQty: Mfg.availableQty(b), updates });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function ownBatch(b: Mfg.ManufacturingBatch | null, clientId: string) {
  if (!b || b.clientId !== clientId) return false;
  return true;
}

router.post("/manufacturing-batches/:id/complete", async (req, res) => {
  try {
    const fresh = await Mfg.completeBatch(req.params.id, req.user!.userId);
    if (!fresh) return res.status(404).json({ error: "Not found" });
    res.json({ ...fresh, availableQty: Mfg.availableQty(fresh!) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Lifecycle transition: draft → planned → ready_to_start → in_progress →
// completed (auto quality_review) → released, plus on_hold / rework /
// rejected / cancelled. Guards (materials ready, quality released) enforced.
router.post("/manufacturing-batches/:id/transition", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const to = req.body?.status;
    if (typeof to !== "string") return res.status(400).json({ error: "status is required" });
    const fresh = await Mfg.transitionBatch(
      req.params.id,
      req.user!.userId,
      to as Mfg.BatchStatus,
      req.user!.userId,
      req.body?.notes ?? null
    );
    if (!fresh) return res.status(404).json({ error: "Not found" });
    res.json({ ...fresh, availableQty: Mfg.availableQty(fresh), progress: Mfg.batchProgress(fresh) });
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Replace the BOM on a batch that has not started production.
router.put("/manufacturing-batches/:id/bom", async (req, res) => {
  try {
    const fresh = await Mfg.setBatchBom(req.params.id, req.user!.userId, req.body?.bom ?? []);
    if (!fresh) return res.status(404).json({ error: "Not found" });
    res.json(fresh);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// Bill of Materials (one approved BOM per product style, basic versioning)
// ---------------------------------------------------------------------------

router.get("/boms", async (req, res) => {
  try {
    const boms = await Bom.list(req.user!.userId);
    res.json(boms);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/boms/product/:productId", async (req, res) => {
  try {
    const boms = await Bom.getByProduct(req.user!.userId, req.params.productId);
    res.json(boms);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/boms", async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.productId) return res.status(400).json({ error: "productId is required" });
    if (!Array.isArray(body.lines) || body.lines.length === 0) {
      return res.status(400).json({ error: "lines must be a non-empty array" });
    }
    const item = await Bom.create({
      clientId: req.user!.userId,
      productId: body.productId,
      sku: body.sku ?? null,
      productName: body.productName ?? null,
      lines: body.lines,
      createdBy: req.user!.userId,
    });
    res.status(201).json(item);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

router.put("/boms/:id", async (req, res) => {
  try {
    const fresh = await Bom.update(
      req.params.id,
      req.user!.userId,
      { lines: req.body?.lines, productName: req.body?.productName, sku: req.body?.sku },
      req.user!.userId,
    );
    if (!fresh) return res.status(404).json({ error: "Not found" });
    res.json(fresh);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

router.post("/boms/:id/approve", async (req, res) => {
  try {
    const fresh = await Bom.approve(req.params.id, req.user!.userId, req.user!.userId);
    if (!fresh) return res.status(404).json({ error: "Not found" });
    res.json(fresh);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

router.post("/boms/:id/archive", async (req, res) => {
  try {
    const fresh = await Bom.archive(req.params.id, req.user!.userId, req.user!.userId);
    if (!fresh) return res.status(404).json({ error: "Not found" });
    res.json(fresh);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

router.delete("/boms/:id", async (req, res) => {
  try {
    const ok = await Bom.remove(req.params.id, req.user!.userId);
    if (!ok) return res.status(404).json({ error: "Not found" });
    res.json({ success: true });
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// Sales Order → automatic material requirement calculation (approved BOM)
// ---------------------------------------------------------------------------

router.get("/sales-orders/:soId/material-requirements", async (req, res) => {
  try {
    const result = await Bom.calculateSoMaterialRequirements(req.user!.userId, req.params.soId);
    res.json(result);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    res.status(status).json({ error: err.message });
  }
});

// Create a manufacturing batch from a confirmed SO, populated from the
// product's approved BOM (version frozen onto the batch).
router.post("/manufacturing-demand/create-batch-from-approved-bom", async (req, res) => {
  try {
    const body = req.body || {};
    const salesOrderId = body.salesOrderId;
    const productId = body.productId;
    const targetQty = Number(body.targetQty);
    if (!salesOrderId || !productId) {
      return res.status(400).json({ error: "salesOrderId and productId are required" });
    }
    if (!Number.isFinite(targetQty) || targetQty <= 0) {
      return res.status(400).json({ error: "targetQty must be > 0" });
    }

    // Prevent duplicate batch for same SO + product.
    const existing = await Mfg.findExistingBatchForDemand(req.user!.userId, salesOrderId, productId);
    if (existing) {
      return res.status(409).json({
        error: `Batch ${existing.batchNumber} already exists for SO ${salesOrderId} and product ${productId}`,
        existingBatch: existing,
      });
    }

    const so = await GoodsSO.get(salesOrderId);
    if (!so || so.clientId !== req.user!.userId) {
      return res.status(404).json({ error: "Sales order not found" });
    }

    const line = (so.lines ?? []).find((l: any) => l.productId === productId);
    if (!line) {
      return res.status(400).json({ error: "Product not found on this Sales Order" });
    }

    const result = await Mfg.createBatchFromApprovedBOM({
      clientId: req.user!.userId,
      salesOrderId: so.id,
      salesOrderNumber: so.soNumber ?? null,
      productId: line.productId,
      sku: line.sku ?? null,
      productName: line.name ?? null,
      targetQty,
      deliveryDate: so.expectedDeliveryDate ?? null,
      priority: null,
      createdBy: req.user!.userId,
    });

    if (result.missingBom) {
      return res.status(409).json({
        error: `No approved BOM for product ${productId} — create and approve a BOM before planning production`,
        missingBom: true,
        productId,
        productName: line.name ?? null,
      });
    }

    res.status(201).json({ ...result.batch, availableQty: Mfg.availableQty(result.batch!) });
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Material readiness decision (Stages B–C): required vs available vs
// reserved vs incoming PO qty → ready | partial | blocked.
router.get("/manufacturing-batches/:id/readiness", async (req, res) => {
  try {
    res.json(await Mfg.computeReadiness(req.user!.userId, req.params.id));
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 500;
    res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Material reservations — soft-allocate raw stock (never moves stock)
// ---------------------------------------------------------------------------

router.get("/material-reservations", async (req, res) => {
  try {
    const batchId = typeof req.query.batchId === "string" ? req.query.batchId : undefined;
    res.json(await Mfg.listReservations(req.user!.userId, batchId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/material-reservations", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const qty = Number(req.body?.qty);
    const item = await Mfg.reserveMaterial({
      clientId: req.user!.userId,
      batchId: req.body?.batchId ?? null,
      salesOrderNumber: req.body?.salesOrderNumber ?? null,
      productId: req.body?.productId,
      sku: req.body?.sku ?? null,
      qty,
      createdBy: req.user!.userId,
    });
    res.status(201).json(item);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

router.post("/material-reservations/:id/release", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const item = await Mfg.releaseReservation(req.params.id, req.user!.userId, !!req.body?.consumed);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

async function requireQuality(req: any, res: any): Promise<boolean> {
  const roles: string[] = req.user!.roles || [];
  const cfg = await Mfg.getConfig(req.user!.userId);
  const canQuality =
    roles.includes("factor_admin") ||
    roles.includes("super_admin") ||
    cfg.qualityRoles.some((r) => roles.includes(r));
  if (!canQuality) {
    res.status(403).json({ error: "Only an authorised quality role can hold or release a batch" });
    return false;
  }
  return true;
}

// Operations gate: restart authority, reservations, issues, updates and
// handoffs are supervisor-level writes. Reads stay open to all authed users;
// sales_rep / client roles are read-only on these endpoints.
const OPS_ROLES = ["operations", "factor_admin", "super_admin"];

async function requireOps(req: any, res: any): Promise<boolean> {
  const roles: string[] = req.user!.roles || [];
  if (!OPS_ROLES.some((r) => roles.includes(r))) {
    res.status(403).json({ error: "Requires an operations supervisor role (operations, factor_admin, super_admin)" });
    return false;
  }
  return true;
}

async function requireOpsOrQuality(req: any, res: any): Promise<boolean> {
  const roles: string[] = req.user!.roles || [];
  if (OPS_ROLES.some((r) => roles.includes(r))) return true;
  const cfg = await Mfg.getConfig(req.user!.userId);
  if (cfg.qualityRoles.some((r) => roles.includes(r))) return true;
  res.status(403).json({ error: "Requires an operations or quality role" });
  return false;
}

async function transitionQuality(
  req: any,
  res: any,
  to: Mfg.QualityStatus
) {
  try {
    const b = await Mfg.getBatch(req.params.id);
    if (!ownBatch(b, req.user!.userId)) return res.status(404).json({ error: "Not found" });
    if (!(await requireQuality(req, res))) return;
    if (to === "Released") {
      // Partial-release aware + idempotent: pass qty + key through.
      const qty = req.body?.qty ?? null;
      const key = req.body?.idempotencyKey ?? `release-${b!.id}-${Date.now()}`;
      try {
        const { batch, duplicate, releasedNow } = await Mfg.releaseBatch({
          id: b!.id,
          clientId: req.user!.userId,
          qty,
          idempotencyKey: key,
          by: req.user!.userId,
          remarks: req.body?.remarks ?? null,
        });
        return res.status(duplicate ? 200 : 201).json({ ...batch, availableQty: Mfg.availableQty(batch), duplicate, releasedNow });
      } catch (err: any) {
        return res.status(err?.statusCode ?? 400).json({ error: err.message, code: err.code });
      }
    }
    const review: Mfg.QualityReview = {
      by: req.user!.userId,
      at: new Date().toISOString(),
      from: b!.qualityStatus,
      to,
      remarks: req.body?.remarks ?? null,
    };
    const { updateItem } = await import("../dynamodb.js");
    // Hold retains releasedQty history — availableQty() reports zero while
    // qualityStatus is not Released, so held goods can never allocate.
    const patch: Record<string, any> = {
      qualityStatus: to,
      qualityReviews: [...(b!.qualityReviews || []), review],
      updatedAt: new Date().toISOString(),
    };
    await updateItem(b!.pk, b!.sk, patch);
    const fresh = await Mfg.getBatch(b!.id);
    res.json({ ...fresh, availableQty: Mfg.availableQty(fresh!) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}

router.post("/manufacturing-batches/:id/hold", (req, res) => transitionQuality(req, res, "Hold"));
router.post("/manufacturing-batches/:id/release", (req, res) => transitionQuality(req, res, "Released"));

router.post("/manufacturing-batches/:id/allocate", async (req, res) => {
  try {
    const b = await Mfg.getBatch(req.params.id);
    if (!ownBatch(b, req.user!.userId)) return res.status(404).json({ error: "Not found" });
    try {
      Mfg.assertBatchReleasable(b!);
    } catch (gate: any) {
      return res.status(gate.statusCode ?? 409).json({ error: gate.message, code: gate.code });
    }
    const qty = Number(req.body?.qty);
    if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ error: "qty must be > 0" });
    if (qty > Mfg.availableQty(b!)) {
      return res.status(400).json({ error: `Only ${Mfg.availableQty(b!)} released units available` });
    }
    const { updateItem } = await import("../dynamodb.js");
    await updateItem(b!.pk, b!.sk, {
      allocatedQty: Number(b!.allocatedQty || 0) + qty,
      updatedAt: new Date().toISOString(),
    });
    const fresh = await Mfg.getBatch(b!.id);
    res.json({ ...fresh, availableQty: Mfg.availableQty(fresh!) });
  } catch (err: any) {
    res.status(errStatus(err)).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Production updates (incremental, idempotent)
// ---------------------------------------------------------------------------

router.get("/production-updates", async (req, res) => {
  try {
    const batchId = String(req.query.batchId || "");
    if (!batchId) return res.status(400).json({ error: "batchId is required" });
    const b = await Mfg.getBatch(batchId);
    if (!ownBatch(b, req.user!.userId)) return res.status(404).json({ error: "Not found" });
    res.json(await Mfg.listUpdates(batchId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/production-updates", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const { update, duplicate } = await Mfg.recordUpdate({
      clientId: req.user!.userId,
      batchId: req.body?.batchId,
      stage: req.body?.stage,
      qtyGood: req.body?.qtyGood,
      qtyRejected: req.body?.qtyRejected ?? 0,
      qtyRework: req.body?.qtyRework ?? 0,
      lineStatus: req.body?.lineStatus ?? "running",
      machineStatus: req.body?.machineStatus ?? null,
      staffingStatus: req.body?.staffingStatus ?? null,
      utilityStatus: req.body?.utilityStatus ?? null,
      remarks: req.body?.remarks ?? null,
      idempotencyKey: req.body?.idempotencyKey,
      createdBy: req.user!.userId,
    });
    res.status(duplicate ? 200 : 201).json({ ...update, duplicate });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Material issues — raw-material consumption per batch (Step 9)
// ---------------------------------------------------------------------------

router.get("/material-issues", async (req, res) => {
  try {
    const batchId = typeof req.query.batchId === "string" ? req.query.batchId : undefined;
    res.json(await Mfg.listMaterialIssues(req.user!.userId, batchId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/material-issues", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const { issue, duplicate } = await Mfg.issueMaterial({
      clientId: req.user!.userId,
      batchId: req.body?.batchId,
      productId: req.body?.productId,
      qty: req.body?.qty,
      lot: req.body?.lot ?? null,
      warehouse: req.body?.warehouse ?? null,
      sku: req.body?.sku ?? null,
      productName: req.body?.productName ?? null,
      idempotencyKey: req.body?.idempotencyKey,
      createdBy: req.user!.userId,
    });
    res.status(duplicate ? 200 : 201).json({ ...issue, duplicate });
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// Factory issues
// ---------------------------------------------------------------------------

router.get("/factory-issues", async (req, res) => {
  try {
    res.json(await Mfg.listIssues(req.user!.userId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/factory-issues", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const issue = await Mfg.createIssue({
      clientId: req.user!.userId,
      type: req.body?.type,
      lineId: req.body?.lineId ?? null,
      lineName: req.body?.lineName ?? null,
      affectedBatchId: req.body?.affectedBatchId ?? null,
      title: req.body?.title,
      description: req.body?.description ?? null,
      owner: req.body?.owner ?? null,
      expectedResolutionAt: req.body?.expectedResolutionAt ?? null,
      severity: req.body?.severity ?? "medium",
      correctiveAction: req.body?.correctiveAction ?? null,
      resolutionNotes: req.body?.resolutionNotes ?? null,
      createdBy: req.user!.userId,
    });
    res.status(201).json(issue);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/factory-issues/:id/close", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const closed = await Mfg.closeIssue(req.params.id, req.user!.userId, req.user!.userId);
    if (!closed) return res.status(404).json({ error: "Not found" });
    res.json(closed);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Step 11 lifecycle: Open → Assigned → In Progress → Resolved → Closed.
router.post("/factory-issues/:id/status", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const to = req.body?.status;
    if (!["open", "assigned", "in_progress", "resolved", "closed"].includes(to)) {
      return res.status(400).json({ error: "status must be open | assigned | in_progress | resolved | closed" });
    }
    const updated = await Mfg.transitionIssue(
      req.params.id,
      req.user!.userId,
      to,
      req.user!.userId,
      req.body?.owner ?? undefined,
      {
        severity: req.body?.severity,
        correctiveAction: req.body?.correctiveAction,
        resolutionNotes: req.body?.resolutionNotes,
      }
    );
    if (!updated) return res.status(404).json({ error: "Not found" });
    res.json(updated);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// Manufacturer overview (dashboard aggregation from saved records)
// ---------------------------------------------------------------------------

router.get("/manufacturer-overview", async (req, res) => {
  try {
    const clientId = req.user!.userId;
    const [batches, issues] = await Promise.all([Mfg.listBatches(clientId), Mfg.listIssues(clientId)]);
    const openIssues = issues.filter((i) => i.status !== "closed");
    const heldQty = batches
      .filter((b) => b.qualityStatus === "Hold" || b.qualityStatus === "Pending")
      .reduce((s, b) => s + Math.max(0, Number(b.producedGoodQty || 0) - Number(b.releasedQty || 0)), 0);
    const releasedReady = batches.reduce((s, b) => s + Mfg.availableQty(b), 0);
    res.json({
      batches: batches.map((b) => ({ ...b, availableQty: Mfg.availableQty(b), progress: Mfg.batchProgress(b) })),
      openBatchCount: batches.filter((b) => !["closed", "cancelled", "rejected", "released"].includes(b.status)).length,
      totalGood: batches.reduce((s, b) => s + Number(b.producedGoodQty || 0), 0),
      totalRejected: batches.reduce((s, b) => s + Number(b.rejectedQty || 0), 0),
      heldQty,
      releasedReady,
      openIssues,
      openIssueCount: openIssues.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Control-center aggregation: real-data KPIs + pipeline + attention + activity.
router.get("/manufacturer-workflow", async (req, res) => {
  try {
    res.json(await Mfg.workflowOverview(req.user!.userId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Quality inspections + corrective actions (Stage H)
// ---------------------------------------------------------------------------

router.get("/quality-inspections", async (req, res) => {
  try {
    const batchId = typeof req.query.batchId === "string" ? req.query.batchId : undefined;
    res.json(await Mfg.listInspections(req.user!.userId, batchId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/quality-inspections", async (req, res) => {
  try {
    if (!(await requireOpsOrQuality(req, res))) return;
    const item = await Mfg.createInspection({
      clientId: req.user!.userId,
      batchId: req.body?.batchId,
      inspectedQty: req.body?.inspectedQty,
      acceptedQty: req.body?.acceptedQty,
      rejectedQty: req.body?.rejectedQty ?? 0,
      reworkQty: req.body?.reworkQty ?? 0,
      defectCategories: req.body?.defectCategories ?? [],
      checklist: req.body?.checklist ?? [],
      docs: req.body?.docs ?? [],
      remarks: req.body?.remarks ?? null,
      createdBy: req.user!.userId,
    });
    res.status(201).json(item);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Quality decision — quality-role gated. released reconciles against accepted
// output and performs the (partial) release; hold opens the corrective loop.
router.post("/quality-inspections/:id/decide", async (req, res) => {
  try {
    if (!(await requireQuality(req, res))) return;
    const item = await Mfg.decideInspection({
      id: req.params.id,
      clientId: req.user!.userId,
      outcome: req.body?.outcome,
      releaseQty: req.body?.releaseQty ?? null,
      inspector: req.user!.userId,
      remarks: req.body?.remarks ?? null,
      idempotencyKey: req.body?.idempotencyKey ?? null,
    });
    res.json(item);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

router.get("/corrective-actions", async (req, res) => {
  try {
    const batchId = typeof req.query.batchId === "string" ? req.query.batchId : undefined;
    res.json(await Mfg.listCorrectiveActions(req.user!.userId, batchId));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/corrective-actions", async (req, res) => {
  try {
    if (!(await requireOpsOrQuality(req, res))) return;
    const item = await Mfg.createCorrectiveAction({
      clientId: req.user!.userId,
      batchId: req.body?.batchId ?? null,
      inspectionId: req.body?.inspectionId ?? null,
      issueId: req.body?.issueId ?? null,
      title: req.body?.title,
      description: req.body?.description ?? null,
      assignee: req.body?.assignee ?? null,
      dueDate: req.body?.dueDate ?? null,
      createdBy: req.user!.userId,
    });
    res.status(201).json(item);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/corrective-actions/:id/status", async (req, res) => {
  try {
    if (!(await requireOpsOrQuality(req, res))) return;
    const item = await Mfg.transitionCorrectiveAction(
      req.params.id,
      req.user!.userId,
      req.body?.status,
      req.user!.userId,
      req.body?.notes ?? null
    );
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// Accounting handoffs — Tally / IRN / e-way bill queue (Stage K)
// ---------------------------------------------------------------------------

router.get("/accounting-handoffs", async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await Mfg.listHandoffs(req.user!.userId, status));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/accounting-handoffs", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const { handoff, duplicate } = await Mfg.prepareHandoff({
      clientId: req.user!.userId,
      kind: req.body?.kind,
      docType: req.body?.docType ?? "invoice",
      docId: req.body?.docId,
      docNumber: req.body?.docNumber ?? null,
      batchId: req.body?.batchId ?? null,
      customer: req.body?.customer ?? null,
      amount: req.body?.amount ?? null,
      voucherType: req.body?.voucherType ?? null,
      idempotencyKey: req.body?.idempotencyKey,
      createdBy: req.user!.userId,
    });
    res.status(duplicate ? 200 : 201).json({ ...handoff, duplicate });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Send / retry through the sandbox adapter. forceFail supports the
// fail-then-retry demo; production retries omit it.
router.post("/accounting-handoffs/:id/send", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const item = await Mfg.sendHandoff(req.params.id, req.user!.userId, req.user!.userId, {
      forceFail: !!req.body?.forceFail,
      failReason: req.body?.failReason,
    });
    res.json(item);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message });
  }
});

router.post("/accounting-handoffs/:id/cancel", async (req, res) => {
  try {
    if (!(await requireOps(req, res))) return;
    const item = await Mfg.cancelHandoff(req.params.id, req.user!.userId, req.user!.userId);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Tally handoff preview — SIMULATED unless manufacturing-config says live-test,
// and even then clearly labelled. No live Tally integration in the demo build.
// ---------------------------------------------------------------------------

router.get("/tally-export-preview", async (req, res) => {
  try {
    const clientId = req.user!.userId;
    const cfg = await Mfg.getConfig(clientId);
    const batches = await Mfg.listBatches(clientId);
    const released = batches.filter((b) => b.qualityStatus === "Released");
    res.json({
      mode: cfg.tallyMode,
      simulated: cfg.tallyMode !== "live-test",
      label:
        cfg.tallyMode === "live-test"
          ? "LIVE-TEST integration — verify before pilot sign-off"
          : "SIMULATED — sample export for demo only",
      vouchers: released.map((b) => ({
        batchNumber: b.batchNumber,
        productName: b.productName,
        sku: b.sku,
        releasedQty: b.releasedQty,
        allocatedQty: b.allocatedQty,
        salesOrderNumber: b.salesOrderNumber,
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sales Order → Manufacturing Demand Automation
// ---------------------------------------------------------------------------

// Get outstanding manufacturing demand for a product (confirmed SO qty − dispatched − allocated).
router.get("/manufacturing-demand/outstanding", async (req, res) => {
  try {
    const productId = req.query.productId as string | undefined;
    if (!productId) return res.status(400).json({ error: "productId is required" });
    const demand = await Mfg.getOutstandingDemand(req.user!.userId, productId);
    res.json(demand);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Suggest batches for all confirmed SO lines with outstanding demand and no existing batch.
router.get("/manufacturing-demand/suggest-batches", async (req, res) => {
  try {
    const suggestions = await Mfg.suggestBatchesForDemand(req.user!.userId);
    res.json(suggestions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Create a manufacturing batch pre-filled from a confirmed Sales Order.
router.post("/manufacturing-demand/create-batch-from-so", async (req, res) => {
  try {
    const body = req.body || {};
    const salesOrderId = body.salesOrderId;
    const productId = body.productId;
    const targetQty = Number(body.targetQty);
    if (!salesOrderId || !productId) {
      return res.status(400).json({ error: "salesOrderId and productId are required" });
    }
    if (!Number.isFinite(targetQty) || targetQty <= 0) {
      return res.status(400).json({ error: "targetQty must be > 0" });
    }

    // Prevent duplicate batch for same SO + product.
    const existing = await Mfg.findExistingBatchForDemand(req.user!.userId, salesOrderId, productId);
    if (existing) {
      return res.status(409).json({
        error: `Batch ${existing.batchNumber} already exists for SO ${salesOrderId} and product ${productId}`,
        existingBatch: existing,
      });
    }

    const so = await GoodsSO.get(salesOrderId);
    if (!so || so.clientId !== req.user!.userId) {
      return res.status(404).json({ error: "Sales order not found" });
    }

    const line = (so.lines ?? []).find((l: any) => l.productId === productId);
    if (!line) {
      return res.status(400).json({ error: "Product not found on this Sales Order" });
    }

    const batch = await Mfg.createBatchFromSO({
      clientId: req.user!.userId,
      salesOrderId: so.id,
      salesOrderNumber: so.soNumber ?? null,
      productId: line.productId,
      sku: line.sku ?? null,
      productName: line.name ?? null,
      targetQty,
      deliveryDate: so.expectedDeliveryDate ?? null,
      priority: null,
      createdBy: req.user!.userId,
    });
    res.status(201).json(batch);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Recalculate demand after a Sales Order is confirmed, amended, or cancelled.
router.post("/manufacturing-demand/recalculate", async (req, res) => {
  try {
    const salesOrderId = req.body?.salesOrderId as string | undefined;
    if (!salesOrderId) return res.status(400).json({ error: "salesOrderId is required" });
    const results = await Mfg.recalculateDemandOnSOChange(req.user!.userId, salesOrderId);
    res.json({ salesOrderId, demands: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Material Readiness Automation
// ---------------------------------------------------------------------------

// Refresh material readiness for all batches using a product (called after stock changes).
router.post("/material-readiness/refresh", async (req, res) => {
  try {
    const productId = req.body?.productId as string | undefined;
    if (!productId) return res.status(400).json({ error: "productId is required" });
    const affected = await Mfg.refreshReadinessOnStockChange(req.user!.userId, productId);
    res.json({ productId, affectedBatches: affected });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-transition a batch to ready_to_start when materials are ready.
router.post("/material-readiness/auto-transition/:batchId", async (req, res) => {
  try {
    const batch = await Mfg.autoTransitionToReadyToStart(req.params.batchId, req.user!.userId);
    if (!batch) return res.status(400).json({ error: "Batch not found or materials not ready" });
    res.json(batch);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// PO → GRN Automation
// ---------------------------------------------------------------------------

// Get outstanding POs for a product (helps procurement identify what to receive).
router.get("/manufacturing/po-outstanding", async (req, res) => {
  try {
    const productId = req.query.productId as string | undefined;
    if (!productId) return res.status(400).json({ error: "productId is required" });
    const outstanding = await GoodsPO.getOutstandingPOsForProduct(req.user!.userId, productId);
    res.json(outstanding);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get overdue POs that affect production (outstanding qty on products used in active batches).
router.get("/manufacturing/po-overdue", async (req, res) => {
  try {
    const clientId = req.user!.userId;
    const pos = await GoodsPO.list(clientId);
    const overdue: Array<{
      poId: string;
      poNumber: string | null;
      supplierId: string | null;
      supplierName: string | null;
      warehouse: string | null;
      expectedDeliveryDate: string | null;
      status: string;
      outstandingQty: number;
      isOverdue: boolean;
    }> = [];

    for (const po of pos as GoodsPO.GoodsPurchaseOrder[]) {
      if (po.status === "cancelled" || po.status === "fully_received") continue;
      if (!GoodsPO.isPOOverdue(po)) continue;
      const outstanding = GoodsPO.poOutstandingQty(po);
      if (outstanding <= 0) continue;
      overdue.push({
        poId: po.id,
        poNumber: po.poNumber ?? null,
        supplierId: po.supplierId ?? null,
        supplierName: po.supplierName ?? null,
        warehouse: po.warehouse ?? null,
        expectedDeliveryDate: po.expectedDeliveryDate ?? null,
        status: po.status,
        outstandingQty: outstanding,
        isOverdue: true,
      });
    }

    overdue.sort((a, b) => {
      const da = a.expectedDeliveryDate ? new Date(a.expectedDeliveryDate).getTime() : Infinity;
      const db = b.expectedDeliveryDate ? new Date(b.expectedDeliveryDate).getTime() : Infinity;
      return da - db;
    });

    res.json(overdue);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Material Requirement Automation
// ---------------------------------------------------------------------------

// Get outstanding material requirement for a batch (BOM qty × target − confirmed issues).
router.get("/material-requirement/:batchId", async (req, res) => {
  try {
    const requirement = await Mfg.getOutstandingMaterialRequirement(req.params.batchId);
    res.json(requirement);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// Production Progress Automation
// ---------------------------------------------------------------------------

// Get stalled batches (in_progress with no recent production update).
router.get("/production/stalled", async (req, res) => {
  try {
    const thresholdHours = req.query.thresholdHours
      ? Number(req.query.thresholdHours)
      : undefined;
    const stalled = await Mfg.getStalledBatches(req.user!.userId, thresholdHours);
    res.json(stalled);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get production interruptions (stopped/maintenance lines on in-progress batches).
router.get("/production/interruptions", async (req, res) => {
  try {
    const interruptions = await Mfg.getProductionInterruptions(req.user!.userId);
    res.json(interruptions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Pre-fill quality inspection values from a batch.
router.get("/quality-inspection/prefill/:batchId", async (req, res) => {
  try {
    const prefill = await Mfg.prefillInspection(req.params.batchId, req.user!.userId);
    res.json(prefill);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// ---------------------------------------------------------------------------
// Finished Stock Allocation Automation
// ---------------------------------------------------------------------------

// Suggest allocations of released stock to confirmed Sales Orders.
router.get("/allocation/suggestions", async (req, res) => {
  try {
    const suggestions = await Mfg.suggestAllocations(req.user!.userId);
    res.json(suggestions);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dispatch Automation
// ---------------------------------------------------------------------------

// Pre-fill dispatch values from a Sales Order.
router.get("/dispatch/prefill/:soId", async (req, res) => {
  try {
    const prefill = await GoodsDispatch.prefillDispatch(req.user!.userId, req.params.soId);
    res.json(prefill);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Validate dispatch quantities against outstanding SO quantities.
router.post("/dispatch/validate", async (req, res) => {
  try {
    const body = req.body || {};
    const soId = body.soId;
    const lines = body.lines;
    if (!soId || !Array.isArray(lines)) return res.status(400).json({ error: "soId and lines are required" });
    const validation = await GoodsDispatch.validateDispatchQuantities(req.user!.userId, soId, lines);
    res.json(validation);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Get dispatches stuck in a pipeline stage beyond the threshold.
router.get("/dispatch/stale", async (req, res) => {
  try {
    const thresholdHours = req.query.thresholdHours
      ? Number(req.query.thresholdHours)
      : undefined;
    const stale = await GoodsDispatch.getStaleDispatches(req.user!.userId, thresholdHours);
    res.json(stale);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sales Invoice Automation
// ---------------------------------------------------------------------------

import * as Invoice from "../models/invoice.js";

// Get dispatched quantities not yet invoiced.
router.get("/invoice/uninvoiced", async (req, res) => {
  try {
    const uninvoiced = await Invoice.getUninvoicedDispatches(req.user!.userId);
    res.json(uninvoiced);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Pre-fill invoice from a dispatched Sales Order.
router.get("/invoice/prefill/:soId", async (req, res) => {
  try {
    const prefill = await Invoice.prefillInvoiceFromSO(req.user!.userId, req.params.soId);
    res.json(prefill);
  } catch (err: any) {
    const status = err?.statusCode && Number.isFinite(err.statusCode) ? err.statusCode : 400;
    res.status(status).json({ error: err.message, code: err.code });
  }
});

// Check for duplicate invoice (same SO + product + qty).
router.post("/invoice/check-duplicate", async (req, res) => {
  try {
    const body = req.body || {};
    const salesOrderId = body.salesOrderId;
    const productId = body.productId;
    const qty = Number(body.qty);
    if (!salesOrderId || !productId || !Number.isFinite(qty)) {
      return res.status(400).json({ error: "salesOrderId, productId and qty are required" });
    }
    const duplicate = await Invoice.isDuplicateInvoice(req.user!.userId, salesOrderId, productId, qty);
    res.json({ duplicate });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import * as Mfg from "../models/manufacturing.js";

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
    const b = await Mfg.getBatch(req.params.id);
    if (!ownBatch(b, req.user!.userId)) return res.status(404).json({ error: "Not found" });
    const { updateItem } = await import("../dynamodb.js");
    await updateItem(b!.pk, b!.sk, { status: "completed", updatedAt: new Date().toISOString() });
    const fresh = await Mfg.getBatch(b!.id);
    res.json({ ...fresh, availableQty: Mfg.availableQty(fresh!) });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

async function transitionQuality(
  req: any,
  res: any,
  to: Mfg.QualityStatus
) {
  try {
    const b = await Mfg.getBatch(req.params.id);
    if (!ownBatch(b, req.user!.userId)) return res.status(404).json({ error: "Not found" });
    const roles: string[] = req.user!.roles || [];
    const cfg = await Mfg.getConfig(req.user!.userId);
    const canQuality =
      roles.includes("factor_admin") ||
      roles.includes("super_admin") ||
      cfg.qualityRoles.some((r) => roles.includes(r));
    if (to === "Released" && !canQuality) {
      return res.status(403).json({ error: "Only an authorised quality role can release a batch" });
    }
    const review: Mfg.QualityReview = {
      by: req.user!.userId,
      at: new Date().toISOString(),
      from: b!.qualityStatus,
      to,
      remarks: req.body?.remarks ?? null,
    };
    const { updateItem } = await import("../dynamodb.js");
    const patch: Record<string, any> = {
      qualityStatus: to,
      qualityReviews: [...(b!.qualityReviews || []), review],
      updatedAt: new Date().toISOString(),
    };
    // Release snapshots the produced good quantity as releasable stock.
    if (to === "Released") patch.releasedQty = Number(b!.producedGoodQty || 0);
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
    const { update, duplicate } = await Mfg.recordUpdate({
      clientId: req.user!.userId,
      batchId: req.body?.batchId,
      stage: req.body?.stage,
      qtyGood: req.body?.qtyGood,
      qtyRejected: req.body?.qtyRejected ?? 0,
      lineStatus: req.body?.lineStatus ?? "running",
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
      createdBy: req.user!.userId,
    });
    res.status(201).json(issue);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/factory-issues/:id/close", async (req, res) => {
  try {
    const closed = await Mfg.closeIssue(req.params.id, req.user!.userId, req.user!.userId);
    if (!closed) return res.status(404).json({ error: "Not found" });
    res.json(closed);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Manufacturer overview (dashboard aggregation from saved records)
// ---------------------------------------------------------------------------

router.get("/manufacturer-overview", async (req, res) => {
  try {
    const clientId = req.user!.userId;
    const [batches, issues] = await Promise.all([Mfg.listBatches(clientId), Mfg.listIssues(clientId)]);
    const openIssues = issues.filter((i) => i.status === "open");
    const heldQty = batches
      .filter((b) => b.qualityStatus === "Hold" || b.qualityStatus === "Pending")
      .reduce((s, b) => s + Number(b.producedGoodQty || 0), 0);
    const releasedReady = batches.reduce((s, b) => s + Mfg.availableQty(b), 0);
    res.json({
      batches: batches.map((b) => ({ ...b, availableQty: Mfg.availableQty(b) })),
      openBatchCount: batches.filter((b) => b.status === "planned" || b.status === "in_progress").length,
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

export default router;

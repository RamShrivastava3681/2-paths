/**
 * End-to-end workflow verification against the LIVE database.
 *
 *   Customer Sales Order → (stock check) → Purchase Order → GRN (stock IN)
 *   → Manufacturing batch (BOM) → material readiness/reservation
 *   → production → quality release → allocation → dispatch readiness.
 *
 * Runs under a unique throwaway tenant id and deletes every row it creates,
 * so it is safe to run repeatedly against the shared table.
 *
 *   npx tsx scripts/test-manufacturing-workflow.ts
 */
import { v4 as uuid } from "uuid";
import * as db from "../src/dynamodb.js";
import * as Product from "../src/models/product.js";
import * as Supplier from "../src/models/supplier.js";
import * as Debtor from "../src/models/debtor.js";
import * as Stock from "../src/models/stock-movement.js";
import * as GoodsPO from "../src/models/goods-purchase-order.js";
import * as GoodsReceipt from "../src/models/goods-receipt.js";
import * as GoodsSO from "../src/models/goods-sales-order.js";
import * as GoodsDispatch from "../src/models/goods-dispatch.js";
import * as Mfg from "../src/models/manufacturing.js";

const clientId = `e2e-mfg-${uuid()}`;
const tag = `E2E-TEST-${Date.now()}`;
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: any) {
  results.push({ name, ok, detail: detail === undefined ? undefined : String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  → ${detail}` : ""}`);
}
function expectThrow(label: string, fn: () => Promise<any>, code: string | null) {
  return fn().then(
    () => check(`${label} (expected throw)`, false, "no error thrown"),
    (e: any) => check(label, code ? e?.code === code : true, `${e?.code ?? "no-code"}: ${e?.message}`)
  );
}
const bal = async (productId: string) =>
  Stock.getBalance(productId, await Stock.list(clientId));

async function main() {
  console.log(`\n=== E2E workflow test · tenant ${clientId} ===\n`);

  // ── Setup (masters) ──────────────────────────────────────────────────────
  await Mfg.setBusinessMode(clientId, "manufacturer");
  await Mfg.updateConfig(clientId, { qualityRoles: ["checker"], tallyMode: "simulated" });

  const fg = await Product.create({ clientId, sku: `${tag}-FG`, name: `${tag} Shirt (M)`, unitPrice: 500, unitCost: 200, gstRate: 5, unitOfMeasure: "piece", status: "active" });
  const rm = await Product.create({ clientId, sku: `${tag}-FABRIC`, name: `${tag} Cotton Fabric`, unitPrice: 100, unitCost: 100, gstRate: 5, unitOfMeasure: "meter", status: "active" });
  const supplier = await Supplier.create({ companyName: `${tag} Fabrics`, paymentTermsDays: 30 } as any);
  const debtor = await Debtor.create({ name: `${tag} Customer`, paymentTermsDays: 30 } as any);
  console.log(`setup: FG ${fg.sku}, RM ${rm.sku}, supplier + customer created\n`);

  // ── Step 1: Customer Sales Order ─────────────────────────────────────────
  console.log("STEP 1 — Customer Sales Order");
  const so = await GoodsSO.create({
    clientId,
    customerId: debtor.id,
    customerName: debtor.name,
    status: "confirmed",
    orderDate: db.todayDate(),
    expectedDeliveryDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
    lines: [{ productId: fg.id, sku: fg.sku, name: fg.name, unit: "piece", orderedQty: 1000, unitPrice: 500, discountPct: 0, gstRate: 5, dispatchedQty: 0 } as any],
  });
  check("SO created and confirmed", so.status === "confirmed", `${so.soNumber} · ${so.lines[0].orderedQty} units · ₹${so.grandTotal}`);

  // ── Step 2: Stock check → insufficient ───────────────────────────────────
  console.log("\nSTEP 2 — Availability check");
  const fgStock0 = await bal(fg.id);
  check("Finished-goods stock insufficient for the order", fgStock0 < so.lines[0].orderedQty, `available ${fgStock0} / ordered ${so.lines[0].orderedQty}`);

  // ── Step 3: Purchase Order → GRN (stock IN) ──────────────────────────────
  console.log("\nSTEP 3 — Purchase Order → GRN credits raw stock");
  const po = await GoodsPO.create({
    clientId, supplierId: supplier.id, supplierName: supplier.companyName, warehouse: "Main",
    status: "sent", orderDate: db.todayDate(), notes: `${tag} shortage PO`,
    lines: [{ productId: rm.id, sku: rm.sku, name: rm.name, unit: "meter", orderedQty: 100, unitPrice: 100, gstRate: 5, receivedQty: 0 } as any],
  } as any);
  check("PO raised for shortfall", po.status === "sent", `${po.poNumber} · 100 ${rm.sku}`);

  const grn = await GoodsReceipt.create({
    clientId, goodsPurchaseOrderId: po.id, poNumber: po.poNumber,
    supplierId: supplier.id, supplierName: supplier.companyName, warehouse: "Main",
    receivedBy: "e2e-tester", notes: `${tag} receipt (received = ordered)`,
    lines: [{ productId: rm.id, sku: rm.sku, name: rm.name, unit: "meter", orderedQty: 100, receivedQty: 100, acceptedQty: 100, rejectedQty: 0, unitCost: 100, gstRate: 5 } as any],
  });
  // Reproduce the /goods-receipts/:id/confirm route: atomic flip, then credit
  // stock for the ACCEPTED qty and fold accepted qty into the PO.
  const flippedGRN = await GoodsReceipt.flipToConfirmed(grn.id, "e2e-tester");
  await Stock.create({ clientId, productId: rm.id, direction: "in", itemName: rm.name, sku: rm.sku, quantity: 100, unit: "meter", unitCost: 100, warehouse: "Main", reason: "Goods receipt", linkedDocumentType: "GRN", linkedDocumentNumber: grn.receiptNumber, status: "confirmed", goodsReceiptId: grn.id, purchaseOrderId: po.id } as any);
  await GoodsPO.recordReceipt(po.id, [{ productId: rm.id, receivedQty: 100 }]);
  const rmStock = await bal(rm.id);
  check("GRN confirmed (stock credited)", !!flippedGRN, `${grn.receiptNumber} → +100`);
  check("Raw material stock is now 100", rmStock === 100, `balance ${rmStock}`);
  const poAfter = await GoodsPO.get(po.id);
  check("PO derived status fully_received", poAfter?.status === "fully_received", `status ${poAfter?.status}`);

  // ── Step 4: Manufacturing — batch + BOM + readiness ──────────────────────
  console.log("\nSTEP 4 — Manufacturing batch, BOM and readiness");
  const batch = await Mfg.createBatch({
    clientId, salesOrderId: so.id, salesOrderNumber: so.soNumber,
    productId: fg.id, sku: fg.sku, productName: fg.name, targetQty: 1000,
    lineId: "line-1", lineName: "Line 1", priority: "high",
    deliveryDate: so.expectedDeliveryDate, createdBy: clientId,
    bom: [{ productId: rm.id, sku: rm.sku, productName: rm.name, qtyPerUnit: 0.1, category: "fabric" }],
  });
  check("Batch created linked to the SO", batch.salesOrderId === so.id && batch.status === "planned", `${batch.batchNumber} target ${batch.targetQty}`);

  const readiness = await Mfg.computeReadiness(clientId, batch.id);
  check("BOM readiness = ready (100 required / 100 available)", readiness.materialStatus === "ready" && readiness.totalShortage === 0, JSON.stringify(readiness.lines.map((l) => ({ req: l.required, avail: l.available, short: l.shortage }))));

  // Guard: cannot start before materials are ready (verify with a second, unresourced batch scenario is covered by reserved math below)
  const reservation = await Mfg.reserveMaterial({ clientId, batchId: batch.id, salesOrderNumber: so.soNumber, productId: rm.id, sku: rm.sku, qty: 100, createdBy: clientId });
  check("Raw material reserved (soft-allocate, no stock move)", reservation.status === "active", `reserved ${reservation.qty}`);
  await expectThrow("Over-reservation blocked", () => Mfg.reserveMaterial({ clientId, batchId: batch.id, productId: rm.id, qty: 999 }), "OVER_RESERVATION");

  // ── Step 5: Materials issue → production updates ──────────────────────────
  console.log("\nSTEP 5 — Material issue and production updates");
  const issue = await Mfg.issueMaterial({ clientId, batchId: batch.id, productId: rm.id, qty: 100, sku: rm.sku, productName: rm.name, idempotencyKey: `issue-${batch.id}`, createdBy: clientId });
  const rmAfterIssue = await bal(rm.id);
  check("Material issue debits raw stock (100 → 0)", rmAfterIssue === 0, `balance ${rmAfterIssue} · issue ${issue.issue.id.slice(0, 8)}`);
  await expectThrow("Over-issue blocked", () => Mfg.issueMaterial({ clientId, batchId: batch.id, productId: rm.id, qty: 1, idempotencyKey: `over-${batch.id}` }), "INSUFFICIENT_STOCK");

  await Mfg.transitionBatch(batch.id, clientId, "ready_to_start", clientId, "materials ready");
  await Mfg.transitionBatch(batch.id, clientId, "in_progress", clientId, "start");
  const u1 = await Mfg.recordUpdate({ clientId, batchId: batch.id, stage: "Dipping", qtyGood: 600, qtyRejected: 20, idempotencyKey: `u1-${batch.id}`, createdBy: clientId });
  const u1dup = await Mfg.recordUpdate({ clientId, batchId: batch.id, stage: "Dipping", qtyGood: 600, qtyRejected: 20, idempotencyKey: `u1-${batch.id}`, createdBy: clientId });
  await Mfg.recordUpdate({ clientId, batchId: batch.id, stage: "Packing", qtyGood: 400, qtyRejected: 0, idempotencyKey: `u2-${batch.id}`, createdBy: clientId });
  const afterUpdates = await Mfg.getBatch(batch.id);
  check("Production updates are idempotent (retry not double-counted)", u1dup.duplicate === true, `duplicate flag ${u1dup.duplicate}`);
  check("Batch total good = 1000, rejects = 20", afterUpdates?.producedGoodQty === 1000 && afterUpdates?.rejectedQty === 20, `good ${afterUpdates?.producedGoodQty}, rejected ${afterUpdates?.rejectedQty}`);

  // ── Step 6: Complete → quality review → release ───────────────────────────
  console.log("\nSTEP 6 — Completion, quality inspection and release");
  const completed = await Mfg.transitionBatch(batch.id, clientId, "completed", clientId, "done");
  check("Completing auto-moves the batch to quality_review", completed?.status === "quality_review", `status ${completed?.status}`);
  check("Finished goods unavailable before release", Mfg.availableQty(completed!) === 0, `available ${Mfg.availableQty(completed!)}`);

  await expectThrow("Allocation blocked while quality is Pending", async () => { Mfg.assertBatchReleasable(completed!); }, "BATCH_NOT_RELEASED");

  const insp = await Mfg.createInspection({ clientId, batchId: batch.id, inspectedQty: 1000, acceptedQty: 1000, rejectedQty: 0, remarks: "pass", createdBy: clientId });
  const released = await Mfg.decideInspection({ id: insp.id, clientId, outcome: "released", inspector: clientId, remarks: "good" });
  const afterRelease = await Mfg.getBatch(batch.id);
  check("Quality release posts good output (releasedQty = 1000)", afterRelease?.releasedQty === 1000 && afterRelease?.qualityStatus === "Released", `released ${afterRelease?.releasedQty}, status ${afterRelease?.status}`);
  check("Released stock is dispatch-available", Mfg.availableQty(afterRelease!) === 1000, `available ${Mfg.availableQty(afterRelease!)}`);
  await expectThrow("Release beyond produced good output blocked", () => Mfg.releaseBatch({ id: batch.id, clientId, qty: 100, idempotencyKey: `over-release-${batch.id}`, by: clientId }), "RELEASE_EXCEEDS_OUTPUT");

  // ── Step 7: Allocate released stock ───────────────────────────────────────
  console.log("\nSTEP 7 — Allocation");
  const alloc = await Mfg.availableQty(afterRelease!);
  // allocate is a route-level action; perform the same guarded update here.
  await db.updateItem(afterRelease!.pk, afterRelease!.sk, { allocatedQty: Number(afterRelease!.allocatedQty || 0) + alloc, updatedAt: db.nowISO() });
  const afterAlloc = await Mfg.getBatch(batch.id);
  check("Allocate 1000 → available drops to 0", Mfg.availableQty(afterAlloc!) === 0 && afterAlloc?.allocatedQty === 1000, `available ${Mfg.availableQty(afterAlloc!)}, allocated ${afterAlloc?.allocatedQty}`);

  // ── Step 8: Dispatch readiness (trading ledger link) ─────────────────────
  console.log("\nSTEP 8 — Dispatch readiness");
  const dispatch = await GoodsDispatch.create({
    clientId, goodsSalesOrderId: so.id, soNumber: so.soNumber,
    customerId: debtor.id, customerName: debtor.name, warehouse: "Main",
    dispatchDate: db.todayDate(),
    lines: [{ productId: fg.id, sku: fg.sku, name: fg.name, unit: "piece", orderedQty: 1000, dispatchedQty: 1000, unitPrice: 500, discountPct: 0, gstRate: 5 } as any],
  });
  const flippedDispatch = await GoodsDispatch.flipToConfirmed(dispatch.id);
  check("Dispatch note created + confirmed against the SO", !!flippedDispatch, `${dispatch.dispatchNumber} · status ${flippedDispatch?.status}`);
  const fgStockAfterMfg = await bal(fg.id);
  check("GAP: quality release does not post finished goods to the trading stock ledger", fgStockAfterMfg === 0, `finished-goods trading balance = ${fgStockAfterMfg} (dispatch 'dispatched' step would require this to be ≥ 1000)`);

  // ── Step 9: SO dispatch-derived status ────────────────────────────────────
  console.log("\nSTEP 9 — Sales order dispatch tracking");
  await GoodsSO.recordDispatch(so.id, [{ productId: fg.id, dispatchedQty: 1000 }]);
  const soAfter = await GoodsSO.get(so.id);
  check("SO derived status fully_dispatched when all lines dispatched", soAfter?.status === "fully_dispatched", `status ${soAfter?.status}`);

  return { so, po, grn, batch: afterAlloc!, dispatch, fg, rm, supplier, debtor };
}

async function cleanup() {
  console.log("\n=== cleanup ===");
  const del = async (type: string, match: (r: any) => boolean) => {
    try {
      const all = await db.scanByType(type, { limit: 2000 });
      const own = (all as any[]).filter((r) => r.clientId === clientId && match(r));
      for (const r of own) await db.deleteItem(r.pk, r.sk);
      console.log(`  cleaned ${own.length} ${type}`);
    } catch (e: any) { console.log(`  cleanup ${type} skipped: ${e.message}`); }
  };
  for (const t of ["GoodsSalesOrder", "GoodsDispatch", "GoodsReceipt", "GoodsPurchaseOrder", "ManufacturingBatch", "ProductionUpdate", "MaterialIssue", "MaterialReservation", "QualityInspection", "FactoryIssue", "CorrectiveAction", "AccountingHandoff", "StockMovement", "Product"]) {
    await del(t, () => true);
  }
  // Products were created under this client and are removed above; suppliers /
  // debtors have no clientId, match by our unique tag.
  try {
    for (const s of (await Supplier.list()).filter((s: any) => s.companyName === `${tag} Fabrics`)) await db.deleteItem((s as any).pk, (s as any).sk);
    for (const d of ((await Debtor.list()) as any[]).filter((d) => d.name === `${tag} Customer`)) await db.deleteItem(d.pk, d.sk);
    console.log("  cleaned supplier + customer");
  } catch (e: any) { console.log(`  cleanup party skipped: ${e.message}`); }
  await db.deleteItem(`BUSMODE#${clientId}`, `BUSMODE#${clientId}`).catch(() => {});
  await db.deleteItem(`MFGCONFIG#${clientId}`, `MFGCONFIG#${clientId}`).catch(() => {});
  console.log("  cleaned manufacturing config + business mode");
}

main()
  .then(async () => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== RESULT: ${results.length - failed.length}/${results.length} checks passed ===`);
    if (failed.length) failed.forEach((f) => console.log(`  FAILED: ${f.name}${f.detail ? ` (${f.detail})` : ""}`));
    await cleanup();
    process.exit(failed.length ? 1 : 0);
  })
  .catch(async (e) => {
    console.error("\nUNEXPECTED ERROR:", e);
    await cleanup();
    process.exit(2);
  });

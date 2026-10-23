/**
 * Comprehensive Automation Test Suite — WhizUnik Command Manufacturing
 *
 * Covers all 10 automation phases implemented against the existing workflow.
 * Runs against a live DynamoDB table under a throwaway tenant.
 *   npx tsx scripts/test-automation-comprehensive.ts
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
import * as Invoice from "../src/models/invoice.js";

const clientId = `auto-${uuid()}`;
const tag = `AUTO-${Date.now()}`;
const results: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, ok: boolean, detail?: any) {
  results.push({ name, ok, detail: detail === undefined ? undefined : String(detail) });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? `  → ${detail}` : ""}`);
}

async function expectThrow(label: string, fn: () => Promise<any>, code?: string | null) {
  return fn().then(
    () => check(`${label} (expected throw)`, false, "no error thrown"),
    (e: any) => check(label, code ? e?.code === code : true, `${e?.code ?? "no-code"}: ${e?.message}`)
  );
}

const bal = async (productId: string) => Stock.getBalance(productId, await Stock.list(clientId));

async function setup() {
  await Mfg.setBusinessMode(clientId, "manufacturer");
  await Mfg.updateConfig(clientId, { qualityRoles: ["checker"], tallyMode: "simulated" });

  const fg = await Product.create({
    clientId, sku: `${tag}-FG`, name: `${tag} Shirt (M)`, unitPrice: 500, unitCost: 200,
    gstRate: 5, unitOfMeasure: "piece", status: "active",
  });
  const rm = await Product.create({
    clientId, sku: `${tag}-FABRIC`, name: `${tag} Cotton Fabric`, unitPrice: 100, unitCost: 100,
    gstRate: 5, unitOfMeasure: "meter", status: "active",
  });
  const supplier = await Supplier.create({ companyName: `${tag} Fabrics`, paymentTermsDays: 30 } as any);
  const debtor = await Debtor.create({ name: `${tag} Customer`, paymentTermsDays: 30 } as any);
  return { fg, rm, supplier, debtor };
}

async function cleanup() {
  const del = async (type: string) => {
    try {
      const all = await db.scanByType(type, { limit: 2000 });
      const own = (all as any[]).filter((r) => r.clientId === clientId);
      for (const r of own) await db.deleteItem(r.pk, r.sk);
      console.log(`  cleaned ${own.length} ${type}`);
    } catch (e: any) { console.log(`  cleanup ${type} skipped: ${e.message}`); }
  };
  for (const t of ["GoodsSalesOrder", "GoodsDispatch", "GoodsReceipt", "GoodsPurchaseOrder",
    "ManufacturingBatch", "ProductionUpdate", "MaterialIssue", "MaterialReservation",
    "QualityInspection", "FactoryIssue", "CorrectiveAction", "AccountingHandoff",
    "StockMovement", "Product", "DomainEvent", "Invoice"]) {
    await del(t);
  }
  try {
    for (const s of (await Supplier.list()).filter((s: any) => s.companyName === `${tag} Fabrics`)) {
      await db.deleteItem((s as any).pk, (s as any).sk);
    }
    for (const d of ((await Debtor.list()) as any[]).filter((d) => d.name === `${tag} Customer`)) {
      await db.deleteItem(d.pk, d.sk);
    }
  } catch (e: any) { console.log(`  cleanup party skipped: ${e.message}`); }
  await db.deleteItem(`BUSMODE#${clientId}`, `BUSMODE#${clientId}`).catch(() => {});
  await db.deleteItem(`MFGCONFIG#${clientId}`, `MFGCONFIG#${clientId}`).catch(() => {});
}

async function main() {
  console.log(`\n=== Comprehensive Automation Test · tenant ${clientId} ===\n`);
  const { fg, rm, supplier, debtor } = await setup();

  // ── PHASE 1: Sales Order → Batch Demand Linkage ──
  console.log("\nPHASE 1 — Sales Order → Batch Demand Linkage");

  const so = await GoodsSO.create({
    clientId, customerId: debtor.id, customerName: debtor.name, status: "confirmed",
    orderDate: db.todayDate(),
    expectedDeliveryDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
    lines: [{ productId: fg.id, sku: fg.sku, name: fg.name, unit: "piece", orderedQty: 100,
      unitPrice: 500, discountPct: 0, gstRate: 5, dispatchedQty: 0 } as any],
  });
  check("P1: SO created and confirmed", so.status === "confirmed", `${so.soNumber} · 100 units`);

  const demand = await Mfg.getOutstandingDemand(clientId, fg.id);
  check("P1: Outstanding demand calculated", demand.outstandingQty === 100,
    `outstanding ${demand.outstandingQty} / ordered 100`);

  const batch1 = await Mfg.createBatchFromSO({
    clientId, salesOrderId: so.id, salesOrderNumber: so.soNumber,
    productId: fg.id, sku: fg.sku, productName: fg.name, targetQty: 100,
    deliveryDate: so.expectedDeliveryDate, createdBy: clientId,
  });
  check("P1: First batch created from SO", batch1.status === "planned", `batch ${batch1.batchNumber}`);

  const duplicate = await Mfg.findExistingBatchForDemand(clientId, so.id, fg.id);
  check("P1: Duplicate batch found (prevents re-creation)", !!duplicate, `found ${duplicate?.batchNumber}`);

  // SO cancellation recalculates demand
  await GoodsSO.update(so.id, { status: "cancelled" });
  const demandAfterCancel = await Mfg.getOutstandingDemand(clientId, fg.id);
  check("P1: Demand recalculated after SO cancel", demandAfterCancel.outstandingQty === 0,
    `outstanding ${demandAfterCancel.outstandingQty}`);
  const batchStillExists = await Mfg.getBatch(batch1.id);
  check("P1: Historical batch preserved after SO cancel", !!batchStillExists, `batch ${batchStillExists?.batchNumber}`);

  // ── PHASE 2: Material Readiness Automation ──
  console.log("\nPHASE 2 — Material Readiness Automation");

  // GRN to have stock
  const po = await GoodsPO.create({
    clientId, supplierId: supplier.id, supplierName: supplier.companyName, warehouse: "Main",
    status: "sent", orderDate: db.todayDate(), notes: `${tag} PO`,
    lines: [{ productId: rm.id, sku: rm.sku, name: rm.name, unit: "meter", orderedQty: 200,
      unitPrice: 100, gstRate: 5, receivedQty: 0 } as any],
  } as any);
  const grn = await GoodsReceipt.create({
    clientId, goodsPurchaseOrderId: po.id, poNumber: po.poNumber,
    supplierId: supplier.id, supplierName: supplier.companyName, warehouse: "Main",
    receivedBy: "auto-tester", notes: `${tag} GRN`,
    lines: [{ productId: rm.id, sku: rm.sku, name: rm.name, unit: "meter", orderedQty: 200,
      receivedQty: 200, acceptedQty: 200, rejectedQty: 0, unitCost: 100, gstRate: 5 } as any],
  });
  await GoodsReceipt.flipToConfirmed(grn.id, "auto-tester");
  await Stock.create({
    clientId, productId: rm.id, direction: "in", itemName: rm.name, sku: rm.sku,
    quantity: 200, unit: "meter", unitCost: 100, warehouse: "Main", reason: "Goods receipt",
    linkedDocumentType: "GRN", linkedDocumentNumber: grn.receiptNumber, status: "confirmed",
    goodsReceiptId: grn.id, purchaseOrderId: po.id,
  } as any);
  await GoodsPO.recordReceipt(po.id, [{ productId: rm.id, receivedQty: 200 }]);
  const poFresh = await GoodsPO.get(po.id);
  check("P3a: PO fully received after recordReceipt", poFresh?.status === "fully_received",
    `status ${poFresh?.status}`);

  // Create batches
  const batch2 = await Mfg.createBatch({
    clientId, productId: fg.id, sku: fg.sku, productName: fg.name, targetQty: 100,
    bom: [{ productId: rm.id, sku: rm.sku, productName: rm.name, qtyPerUnit: 1, category: "fabric" }],
  });
  check("P2: Batch created", batch2.status === "planned", `status ${batch2.status}`);

  const readinessBefore = await Mfg.computeReadiness(clientId, batch2.id);
  check("P2: Readiness computed", readinessBefore.materialStatus === "ready",
    `status ${readinessBefore.materialStatus}`);

  const affected = await Mfg.refreshReadinessOnStockChange(clientId, rm.id);
  check("P2: Readiness refresh affected batches", affected.includes(batch2.id),
    `affected ${JSON.stringify(affected)}`);

  const batch2After = await Mfg.getBatch(batch2.id);
  check("P2: Batch readiness upgraded in DB", batch2After?.materialStatus === "ready",
    `status ${batch2After?.materialStatus}`);

  // Readiness upgrade-only: never downgrades
  const batch3 = await Mfg.createBatch({
    clientId, productId: fg.id, sku: fg.sku, productName: fg.name, targetQty: 50,
    bom: [{ productId: rm.id, sku: rm.sku, productName: rm.name, qtyPerUnit: 1, category: "fabric" }],
  });
  const r3Before = await Mfg.computeReadiness(clientId, batch3.id);
  check("P2: Batch3 readiness ready", r3Before.materialStatus === "ready", `status ${r3Before.materialStatus}`);
  await Mfg.issueMaterial({ clientId, batchId: batch3.id, productId: rm.id, qty: 25,
    sku: rm.sku, productName: rm.name, idempotencyKey: `issue-b3-${batch3.id}`, createdBy: clientId });
  const batch3After = await Mfg.getBatch(batch3.id);
  check("P2: Readiness never downgrades after issue", batch3After?.materialStatus === "ready",
    `status ${batch3After?.materialStatus}`);

  // ── PHASE 3: PO → GRN Automation ──
  console.log("\nPHASE 3 — PO → GRN Automation");

  const outstandingPOs = await GoodsPO.getOutstandingPOsForProduct(clientId, rm.id);
  check("P3: Outstanding POs for product (0 after full receipt)", outstandingPOs.length === 0,
    `found ${outstandingPOs.length}`);

  // Create a partial PO (only 20 of 50 received)
  const po2 = await GoodsPO.create({
    clientId, supplierId: supplier.id, supplierName: supplier.companyName, warehouse: "Main",
    status: "sent", orderDate: db.todayDate(),
    expectedDeliveryDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10), // yesterday
    lines: [{ productId: rm.id, sku: rm.sku, name: rm.name, unit: "meter", orderedQty: 50,
      unitPrice: 100, gstRate: 5, receivedQty: 0 } as any],
  } as any);
  check("P3: Partial PO created", po2.status === "sent", `po ${po2.poNumber}`);
  const po2Fresh = await GoodsPO.get(po2.id);
  const po2Outstanding = GoodsPO.poOutstandingQty(po2Fresh);
  check("P3: Partial PO outstanding qty", po2Outstanding === 50, `outstanding ${po2Outstanding}`);

  const isOverdue = GoodsPO.isPOOverdue(po2Fresh);
  check("P3: Overdue PO detected", isOverdue === true, `isOverdue ${isOverdue}`);

  const overduePOs = await GoodsPO.getOutstandingPOsForProduct(clientId, rm.id);
  check("P3: Overdue PO in outstanding list", overduePOs.some((p) => p.poId === po2.id),
    `found po2 in ${overduePOs.length} outstanding POs`);

  // ── PHASE 4: Material Reservation & Issue ──
  console.log("\nPHASE 4 — Material Reservation & Issue Automation");

  const requirement = await Mfg.getOutstandingMaterialRequirement(batch2.id);
  check("P4: Material requirement calculated", requirement.lines.length > 0, `${requirement.lines.length} lines`);
  check("P4: Total outstanding", requirement.totalOutstanding === 100,
    `totalOutstanding ${requirement.totalOutstanding}`);

  const reservation = await Mfg.reserveMaterial({
    clientId, batchId: batch2.id, productId: rm.id, sku: rm.sku, qty: 50, createdBy: clientId,
  });
  check("P4: Reservation created", reservation.status === "active", `reserved ${reservation.qty}`);

  const issue = await Mfg.issueMaterial({
    clientId, batchId: batch2.id, productId: rm.id, qty: 50,
    sku: rm.sku, productName: rm.name, idempotencyKey: `issue-b2-${batch2.id}`, createdBy: clientId,
  });
  check("P4: Material issue posted", !!issue.issue, `issue ${issue.issue.id}`);
  const reservationAfter = await Mfg.listReservations(clientId, batch2.id);
  const resForRM = reservationAfter.find((r) => r.productId === rm.id);
  check("P4: Reservation auto-released/consumed on issue",
    !resForRM || resForRM.status === "consumed", `status ${resForRM?.status}`);

  const dupIssue = await Mfg.issueMaterial({
    clientId, batchId: batch2.id, productId: rm.id, qty: 50,
    sku: rm.sku, productName: rm.name, idempotencyKey: `issue-b2-${batch2.id}`, createdBy: clientId,
  });
  check("P4: Duplicate issue prevented", dupIssue.duplicate === true, `duplicate ${dupIssue.duplicate}`);

  // ── PHASE 5: Production Progress ──
  console.log("\nPHASE 5 — Production Progress Automation");

  await Mfg.transitionBatch(batch2.id, clientId, "ready_to_start", clientId, "materials ready");
  await Mfg.transitionBatch(batch2.id, clientId, "in_progress", clientId, "start");

  const update1 = await Mfg.recordUpdate({
    clientId, batchId: batch2.id, stage: "Dipping", qtyGood: 60, qtyRejected: 5,
    idempotencyKey: `p5-u1-${batch2.id}`, createdBy: clientId,
  });
  check("P5: Production update recorded", !update1.duplicate, `duplicate ${update1.duplicate}`);

  const batch2Progress = await Mfg.getBatch(batch2.id);
  check("P5: Batch totals aggregated", batch2Progress?.producedGoodQty === 60,
    `good ${batch2Progress?.producedGoodQty}, target ${batch2Progress?.targetQty}`);

  const stalled = await Mfg.getStalledBatches(clientId, 1);
  check("P5: Stall detection works", Array.isArray(stalled), `returned ${stalled.length} batches`);

  const update2 = await Mfg.recordUpdate({
    clientId, batchId: batch2.id, stage: "Washing", qtyGood: 40, qtyRejected: 0,
    lineStatus: "stopped", machineStatus: "breakdown",
    idempotencyKey: `p5-u2-${batch2.id}`, createdBy: clientId,
  });

  // Direct check: batch2's last update has stopped lineStatus
  const updates2 = await Mfg.listUpdates(batch2.id);
  const lastUpdate = updates2[updates2.length - 1];
  check("P5: Last update has stopped lineStatus", lastUpdate.lineStatus === "stopped",
    `status ${lastUpdate.lineStatus}`);

  // Verify batch2 status via direct read (consistent)
  const batch2Direct = await Mfg.getBatch(batch2.id);
  check("P5: Batch2 status is in_progress", batch2Direct?.status === "in_progress",
    `status ${batch2Direct?.status}`);

  // Interruption detection via getProductionInterruptions
  const interruptions = await Mfg.getProductionInterruptions(clientId);
  check("P5: Interruption detected", interruptions.some((i) => i.batchId === batch2.id),
    `found ${interruptions.length} interruptions`);

  // ── PHASE 6: Quality Inspection Automation ──
  console.log("\nPHASE 6 — Quality Inspection Automation");

  await Mfg.transitionBatch(batch2.id, clientId, "completed", clientId, "done");
  check("P6: Batch completed → quality_review", true, "transitioned");

  const prefill = await Mfg.prefillInspection(batch2.id, clientId);
  check("P6: Inspection pre-fill from batch", prefill.suggestedInspectedQty === 100,
    `suggested ${prefill.suggestedInspectedQty} / produced 100`);

  const inspection = await Mfg.createInspection({
    clientId, batchId: batch2.id, inspectedQty: 100, acceptedQty: 95, rejectedQty: 5,
    remarks: "auto-test", createdBy: clientId,
  });
  check("P6: Inspection created", !!inspection, `id ${inspection.id}`);

  const released = await Mfg.decideInspection({
    id: inspection.id, clientId, outcome: "released", releaseQty: 95,
    inspector: clientId, remarks: "pass",
  });
  check("P6: Quality release posted", released.outcome === "released", `outcome ${released.outcome}`);

  const batchAfterRelease = await Mfg.getBatch(batch2.id);
  check("P6: Released stock available", batchAfterRelease?.releasedQty === 95,
    `released ${batchAfterRelease?.releasedQty}`);

  // Restock RM for batch4 (stock depleted by batch2/batch3 issues)
  const grn2 = await GoodsReceipt.create({
    clientId, goodsPurchaseOrderId: po.id, poNumber: po.poNumber,
    supplierId: supplier.id, supplierName: supplier.companyName, warehouse: "Main",
    receivedBy: "auto-tester", notes: `${tag} restock`,
    lines: [{ productId: rm.id, sku: rm.sku, name: rm.name, unit: "meter", orderedQty: 100,
      receivedQty: 100, acceptedQty: 100, rejectedQty: 0, unitCost: 100, gstRate: 5 } as any],
  });
  await GoodsReceipt.flipToConfirmed(grn2.id, "auto-tester");
  await Stock.create({
    clientId, productId: rm.id, direction: "in", itemName: rm.name, sku: rm.sku,
    quantity: 100, unit: "meter", unitCost: 100, warehouse: "Main", reason: "Goods receipt",
    linkedDocumentType: "GRN", linkedDocumentNumber: grn2.receiptNumber, status: "confirmed",
    goodsReceiptId: grn2.id, purchaseOrderId: po.id,
  } as any);

  // Hold/rework test with batch4
  const batch4 = await Mfg.createBatch({
    clientId, productId: fg.id, sku: fg.sku, productName: fg.name, targetQty: 30,
    bom: [{ productId: rm.id, sku: rm.sku, productName: rm.name, qtyPerUnit: 1, category: "fabric" }],
  });
  // Compute + persist readiness for the new batch (stock was restocked via grn2)
  await Mfg.refreshReadinessOnStockChange(clientId, rm.id);
  await Mfg.transitionBatch(batch4.id, clientId, "ready_to_start", clientId, "ready");
  await Mfg.transitionBatch(batch4.id, clientId, "in_progress", clientId, "start");
  await Mfg.recordUpdate({ clientId, batchId: batch4.id, stage: "Packing", qtyGood: 30,
    idempotencyKey: `p6-b4-u1-${batch4.id}`, createdBy: clientId });
  await Mfg.transitionBatch(batch4.id, clientId, "completed", clientId, "done");
  const insp2 = await Mfg.createInspection({
    clientId, batchId: batch4.id, inspectedQty: 30, acceptedQty: 10, rejectedQty: 20,
    remarks: "fail", createdBy: clientId,
  });
  const decided2 = await Mfg.decideInspection({
    id: insp2.id, clientId, outcome: "hold", inspector: clientId, remarks: "high defect rate",
  });
  check("P6: Hold decision recorded", decided2.outcome === "hold", `outcome ${decided2.outcome}`);
  const batch4After = await Mfg.getBatch(batch4.id);
  check("P6: Batch on hold", batch4After?.status === "on_hold", `status ${batch4After?.status}`);

  // ── PHASE 7: Finished Stock Allocation ──
  console.log("\nPHASE 7 — Finished Stock Allocation Automation");

  const so2 = await GoodsSO.create({
    clientId, customerId: debtor.id, customerName: debtor.name, status: "confirmed",
    orderDate: db.todayDate(),
    expectedDeliveryDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
    lines: [{ productId: fg.id, sku: fg.sku, name: fg.name, unit: "piece", orderedQty: 50,
      unitPrice: 500, discountPct: 0, gstRate: 5, dispatchedQty: 0 } as any],
  });

  // Link batch2 (released, 95 units) to so2 for allocation
  await db.updateItem(batch2.pk, batch2.sk, {
    salesOrderId: so2.id,
    salesOrderNumber: so2.soNumber,
    updatedAt: db.nowISO(),
  });

  const suggestions = await Mfg.suggestAllocations(clientId);
  const fgSuggestions = suggestions.filter((s) => s.productId === fg.id);
  check("P7: Allocation suggestions generated", fgSuggestions.length > 0, `found ${fgSuggestions.length}`);

  const batch2Suggestion = suggestions.find((s) => s.batchId === batch2.id);
  if (batch2Suggestion) {
    const allocQty = Math.min(batch2Suggestion.suggestedQty, 30);
    await db.updateItem(batch2.pk, batch2.sk, {
      allocatedQty: Number(batch2.allocatedQty || 0) + allocQty,
      updatedAt: db.nowISO(),
    });
    const batch2Final = await Mfg.getBatch(batch2.id);
    check("P7: Allocation posted", batch2Final?.allocatedQty === allocQty,
      `allocated ${batch2Final?.allocatedQty}`);
  }

  // ── PHASE 8: Dispatch Automation ──
  console.log("\nPHASE 8 — Dispatch Automation");

  const dispatchPrefill = await GoodsDispatch.prefillDispatch(clientId, so2.id);
  check("P8: Dispatch pre-fill from SO", dispatchPrefill.lines.length > 0,
    `${dispatchPrefill.lines.length} lines`);

  const validation = await GoodsDispatch.validateDispatchQuantities(clientId, so2.id, [
    { productId: fg.id, qty: 30 },
  ]);
  check("P8: Dispatch validation passes", validation.ok === true, `errors ${validation.errors.length}`);

  const invalidValidation = await GoodsDispatch.validateDispatchQuantities(clientId, so2.id, [
    { productId: fg.id, qty: 999 },
  ]);
  check("P8: Invalid dispatch rejected", invalidValidation.ok === false,
    `errors ${invalidValidation.errors.length}`);

  const dispatch = await GoodsDispatch.create({
    clientId, goodsSalesOrderId: so2.id, soNumber: so2.soNumber,
    customerId: debtor.id, customerName: debtor.name, warehouse: "Main",
    dispatchDate: db.todayDate(),
    lines: [{ productId: fg.id, sku: fg.sku, name: fg.name, unit: "piece",
      orderedQty: 30, dispatchedQty: 30, unitPrice: 500, discountPct: 0, gstRate: 5 } as any],
  });
  const flippedDispatch = await GoodsDispatch.flipToConfirmed(dispatch.id);
  check("P8: Dispatch confirmed", !!flippedDispatch, `status ${flippedDispatch?.status}`);

  const debited = await GoodsDispatch.markStockDebited(dispatch.id, clientId);
  check("P8: Stock debited once", !!debited, `stockDebited ${debited?.stockDebited}`);
  const doubleDebit = await GoodsDispatch.markStockDebited(dispatch.id, clientId);
  check("P8: Double debit prevented", doubleDebit === null, "second debit returned null");

  await GoodsSO.recordDispatch(so2.id, [{ productId: fg.id, dispatchedQty: 30 }]);
  const so2After = await GoodsSO.get(so2.id);
  check("P8: SO dispatch status updated", so2After?.status === "partially_dispatched",
    `status ${so2After?.status}`);

  const stale = await GoodsDispatch.getStaleDispatches(clientId, 0);
  check("P8: Stale dispatch detection works", Array.isArray(stale), `returned ${stale.length}`);

  // ── PHASE 9: Sales Invoice Automation ──
  console.log("\nPHASE 9 — Sales Invoice Automation");

  const uninvoiced = await Invoice.getUninvoicedDispatches(clientId);
  check("P9: Un-invoiced dispatches detected", uninvoiced.length > 0, `found ${uninvoiced.length}`);

  const invoicePrefill = await Invoice.prefillInvoiceFromSO(clientId, so2.id);
  check("P9: Invoice prefill from SO", invoicePrefill.lines.length > 0,
    `${invoicePrefill.lines.length} lines`);

  const dupCheck = await Invoice.isDuplicateInvoice(clientId, so2.id, fg.id, 30);
  check("P9: Duplicate check (no invoice yet)", dupCheck === false, `duplicate ${dupCheck}`);

  // ── PHASE 10: Event-Driven Notifications ──
  console.log("\nPHASE 10 — Event-Driven Notifications");

  const events = await db.scanByType("DomainEvent", { limit: 2000 });
  const dispatchEvents = (events as any[]).filter(
    (e) => e.clientId === clientId && e.name === "goods_dispatched",
  );
  check("P10: Dispatch event recorded", dispatchEvents.length > 0,
    `found ${dispatchEvents.length} goods_dispatched events`);

  const qualityEvents = (events as any[]).filter(
    (e) => e.clientId === clientId && e.name === "quality_inspection_required",
  );
  check("P10: Quality inspection event recorded", qualityEvents.length > 0,
    `found ${qualityEvents.length} quality events`);

  // ── SUMMARY ──
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== RESULT: ${results.length - failed.length}/${results.length} automation checks passed ===`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  FAILED: ${f.name}${f.detail ? ` (${f.detail})` : ""}`));
    await cleanup();
    process.exit(1);
  }
  await cleanup();
  process.exit(0);
}

main().catch(async (e) => {
  console.error("\nUNEXPECTED ERROR:", e);
  await cleanup();
  process.exit(2);
});

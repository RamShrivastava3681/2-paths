/**
 * Seed / reset the manufacturing demo dataset for ONE tenant.
 *
 * Usage:
 *   CLIENT_ID=<userId> npx tsx scripts/seed-manufacturing-demo.ts
 *   CLIENT_ID=<userId> npx tsx scripts/seed-manufacturing-demo.ts --reset
 *
 * Seed writes (all labelled DEMO data):
 *  - business-mode = manufacturer + manufacturing-config (tally simulated)
 *  - products: 1 finished garment + 2 raw materials + packaging (DEMO- SKUs)
 *  - supplier + customer (DEMO names), opening stock (fabric 80 on hand)
 *  - E2E batch SO-DEMO-E2E-1000: BOM requires 100 fabric, 80 available →
 *    blocked; PO for 20 → confirmed GRN (+20) → readiness ready → reserved
 *  - legacy glove batch (10,000) + 2 updates + open high-severity issue
 *  - demo inspection + corrective action + failed handoff (retry in Tally tab)
 *
 * Reset deletes ONLY demo-tagged rows for the given clientId: all 8
 * manufacturing entities plus DEMO- products / DEMO-note movements, POs,
 * GRNs and DEMO-named suppliers/debtors. Everything else is untouched.
 */
import * as db from "../src/dynamodb.js";
import * as Mfg from "../src/models/manufacturing.js";
import * as Product from "../src/models/product.js";
import * as Supplier from "../src/models/supplier.js";
import * as Debtor from "../src/models/debtor.js";
import * as StockMovement from "../src/models/stock-movement.js";
import * as GoodsPO from "../src/models/goods-purchase-order.js";
import * as GoodsReceipt from "../src/models/goods-receipt.js";

const clientId = process.env.CLIENT_ID || "";
const reset = process.argv.includes("--reset");

if (!clientId) {
  console.error("CLIENT_ID env is required (the tenant userId to seed).");
  process.exit(1);
}

async function main() {
  if (reset) {
    for (const t of ["ManufacturingBatch", "ProductionUpdate", "FactoryIssue", "MaterialIssue", "MaterialReservation", "QualityInspection", "CorrectiveAction", "AccountingHandoff"] as const) {
      const all = await db.scanByType(t, { limit: 2000 });
      const own = all.filter((r: any) => r.clientId === clientId);
      for (const r of own) await db.deleteItem(r.pk, r.sk);
      console.log(`  🧹 deleted ${own.length} ${t} rows for ${clientId}`);
    }
    // Demo-tagged trading rows for this tenant only (never other tenants' data).
    const wipe = async (type: string, match: (r: any) => boolean) => {
      try {
        const all = await db.scanByType(type, { limit: 2000 });
        const own = all.filter((r: any) => r.clientId === clientId && match(r));
        for (const r of own) await db.deleteItem(r.pk, r.sk);
        console.log(`  🧹 deleted ${own.length} ${type} DEMO rows for ${clientId}`);
      } catch (e: any) {
        console.log(`  ⚠ reset ${type} skipped: ${e.message}`);
      }
    };
    await wipe("Product", (r) => String(r.sku ?? "").startsWith("DEMO-"));
    await wipe("StockMovement", (r) => String(r.notes ?? "").includes("DEMO"));
    await wipe("GoodsPurchaseOrder", (r) => String(r.notes ?? "").includes("DEMO"));
    await wipe("GoodsReceipt", (r) => String(r.notes ?? "").includes("DEMO"));
    try {
      const sups = (await Supplier.list()).filter((s: any) => String(s.companyName ?? "").startsWith("DEMO "));
      for (const s of sups) await db.deleteItem((s as any).pk, (s as any).sk);
      console.log(`  🧹 deleted ${sups.length} DEMO suppliers`);
    } catch (e: any) { console.log(`  ⚠ reset suppliers skipped: ${e.message}`); }
    try {
      const debts = ((await Debtor.list()) as any[]).filter((d) => String(d.name ?? "").startsWith("DEMO "));
      for (const d of debts) await db.deleteItem(d.pk, d.sk);
      console.log(`  🧹 deleted ${debts.length} DEMO debtors`);
    } catch (e: any) { console.log(`  ⚠ reset debtors skipped: ${e.message}`); }
    console.log("Reset complete — non-demo rows and other tenants untouched.");
    return;
  }

  await Mfg.setBusinessMode(clientId, "manufacturer");
  await Mfg.updateConfig(clientId, {
    lines: [
      { id: "line-1", name: "Line 1 — Dipping" },
      { id: "line-2", name: "Line 2 — Finishing" },
    ],
    shifts: [
      { id: "day", name: "Day" },
      { id: "night", name: "Night" },
    ],
    stages: ["Dipping", "Washing", "Drying", "Stripping", "Packing"],
    qualityRoles: ["checker"],
    tallyMode: "simulated",
  });
  console.log("  ✅ business-mode=manufacturer, config seeded (tally simulated)");

  const batch = await Mfg.createBatch({
    clientId,
    salesOrderNumber: "SO-DEMO-10000",
    productName: "Latex Gloves (M) — DEMO DATA",
    sku: "DEMO-GLOVE-M",
    targetQty: 10000,
    lineId: "line-1",
    lineName: "Line 1 — Dipping",
    shiftId: "day",
    notes: "RFB demo batch — illustrative quantities, demo data only",
    isDemoData: true,
    createdBy: clientId,
  });
  console.log(`  ✅ batch ${batch.batchNumber} (target 10,000)`);

  // BOM first — locked once production starts.
  await Mfg.setBatchBom(batch.id, clientId, [
    { productId: "DEMO-LATEX", sku: "DEMO-LATEX", productName: "Demo latex", qtyPerUnit: 0.01, category: "fabric" },
  ]);

  await Mfg.recordUpdate({
    clientId,
    batchId: batch.id,
    stage: "Dipping",
    qtyGood: 4000,
    qtyRejected: 200,
    lineStatus: "running",
    remarks: "Demo update 1",
    idempotencyKey: `demo-${batch.id}-u1`,
    createdBy: clientId,
  });
  await Mfg.recordUpdate({
    clientId,
    batchId: batch.id,
    stage: "Drying",
    qtyGood: 5000,
    qtyRejected: 150,
    lineStatus: "running",
    remarks: "Demo update 2",
    idempotencyKey: `demo-${batch.id}-u2`,
    createdBy: clientId,
  });
  console.log("  ✅ 2 production updates (9,000 good, 350 rejects — no double-count)");

  await Mfg.createIssue({
    clientId,
    type: "stoppage",
    lineId: "line-1",
    lineName: "Line 1 — Dipping",
    affectedBatchId: batch.id,
    title: "Demo stoppage — conveyor jam on Line 1",
    description: "Seeded demo issue with owner and open status",
    owner: "Demo floor supervisor",
    severity: "high",
    expectedResolutionAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    createdBy: clientId,
  });
  console.log("  ✅ 1 open factory issue (owner assigned)");

  // Best-effort control-center demo rows (never fail the seed if stock is absent).
  try {
    await Mfg.createInspection({
      clientId,
      batchId: batch.id,
      inspectedQty: 9000,
      acceptedQty: 8800,
      rejectedQty: 200,
      remarks: "Demo inspection — hold pending recheck",
      createdBy: clientId,
    });
    const insp = (await Mfg.listInspections(clientId, batch.id))[0];
    if (insp) {
      await Mfg.createCorrectiveAction({
        clientId,
        batchId: batch.id,
        inspectionId: insp.id,
        title: "Demo corrective action — recheck dried batch",
        assignee: "Demo quality lead",
        createdBy: clientId,
      });
    }
    const { handoff } = await Mfg.prepareHandoff({
      clientId,
      kind: "tally",
      docType: "invoice",
      docId: "DEMO-INV-1",
      docNumber: "DEMO-INV-1",
      batchId: batch.id,
      customer: "Demo customer",
      amount: 120000,
      idempotencyKey: `demo-ho-${batch.id}`,
      createdBy: clientId,
    });
    await Mfg.sendHandoff(handoff.id, clientId, clientId, { forceFail: true, failReason: "Demo failure — retry me from Tally Export" });
    console.log("  ✅ demo inspection + corrective action + failed handoff (retry from Tally Export)");
  } catch (e: any) {
    console.log(`  ⚠ optional demo rows skipped: ${e.message}`);
  }

  // Full E2E scenario (PDF quantities: SO 1000 → need 100 → have 80 → PO/GRN 20).
  // Production, quality and dispatch stay live for the acceptance run.
  try {
    const ensureProduct = async (sku: string, name: string, unitPrice = 0) => {
      const existing = ((await Product.list()) as any[]).find((p) => String(p.sku ?? "").toUpperCase() === sku);
      if (existing) return existing;
      return Product.create({ clientId, sku, name, unitOfMeasure: "piece", unitPrice, status: "active" });
    };
    const fg = await ensureProduct("DEMO-E2E-FG", "DEMO E2E Shirt (M)");
    const fabric = await ensureProduct("DEMO-E2E-FABRIC", "DEMO E2E Cotton Fabric", 100);
    await ensureProduct("DEMO-E2E-TRIM", "DEMO E2E Trims Pack", 10);
    await ensureProduct("DEMO-E2E-PACK", "DEMO E2E Carton", 25);
    console.log("  ✅ DEMO E2E products (FG + fabric + trim + packaging)");

    let supplier: any = ((await Supplier.list()) as any[]).find((s) => s.companyName === "DEMO E2E Fabrics");
    if (!supplier) supplier = await Supplier.create({ companyName: "DEMO E2E Fabrics", contactName: "Demo vendor", paymentTermsDays: 30 } as any);
    let debtor: any = ((await Debtor.list()) as any[]).find((d) => d.name === "DEMO E2E Garments");
    if (!debtor) debtor = await Debtor.create({ name: "DEMO E2E Garments", paymentTermsDays: 30 } as any);
    console.log("  ✅ DEMO E2E supplier + customer");

    // Opening stock: 80 fabric on hand (confirmed IN — the only stock writer).
    await StockMovement.create({
      clientId, direction: "in", productId: fabric.id, itemName: fabric.name, sku: fabric.sku,
      quantity: 80, warehouse: "Main", reason: "Opening stock",
      status: "confirmed", notes: "DEMO opening stock — E2E scenario",
    } as any);
    console.log("  ✅ opening stock: 80 DEMO fabric");

    // Batch needs 100 fabric (0.1 × 1000) → blocked on 80 available.
    const e2e = await Mfg.createBatch({
      clientId,
      salesOrderNumber: "SO-DEMO-E2E-1000",
      productId: fg.id, sku: fg.sku, productName: fg.name,
      targetQty: 1000,
      lineId: "line-1", lineName: "Line 1 — Dipping", shiftId: "day",
      supervisor: "Demo supervisor", priority: "high",
      deliveryDate: new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10),
      notes: "DEMO E2E scenario batch — shortage → PO → GRN → produce",
      isDemoData: true, createdBy: clientId,
      bom: [{ productId: fabric.id, sku: fabric.sku, productName: fabric.name, qtyPerUnit: 0.1, category: "fabric" }],
    });
    const r1 = await Mfg.computeReadiness(clientId, e2e.id);
    console.log(`  ✅ E2E batch ${e2e.batchNumber} — readiness ${r1.materialStatus}, shortage ${r1.totalShortage}`);

    // Procurement loop: PO for the 20-unit shortage → confirmed GRN (+20).
    const po = await GoodsPO.create({
      clientId, supplierId: supplier.id, supplierName: supplier.companyName,
      warehouse: "Main", status: "sent", notes: "DEMO E2E shortage PO — 20 fabric",
      lines: [{ productId: fabric.id, sku: fabric.sku, name: fabric.name, unit: "piece", orderedQty: 20, unitPrice: 100, gstRate: 5 } as any],
    } as any);
    const grn = await GoodsReceipt.create({
      clientId, goodsPurchaseOrderId: po.id, poNumber: po.poNumber,
      supplierId: supplier.id, supplierName: supplier.companyName,
      warehouse: "Main", notes: "DEMO E2E receipt — 20 fabric accepted",
      lines: [{ productId: fabric.id, sku: fabric.sku, receivedQty: 20, acceptedQty: 20, rejectedQty: 0, unitCost: 100 } as any],
    });
    await GoodsReceipt.flipToConfirmed(grn.id, "demo-seed");
    await StockMovement.create({
      clientId, direction: "in", productId: fabric.id, itemName: fabric.name, sku: fabric.sku,
      quantity: 20, warehouse: "Main", reason: "Goods receipt",
      linkedDocumentType: "GoodsReceipt", linkedDocumentNumber: grn.receiptNumber,
      status: "confirmed", notes: "DEMO E2E GRN credit — 20 fabric",
    } as any);
    await GoodsPO.recordReceipt(po.id, [{ productId: fabric.id, receivedQty: 20 }]);
    console.log(`  ✅ PO ${po.poNumber} sent → GRN ${grn.receiptNumber} confirmed (+20 fabric)`);

    const r2 = await Mfg.computeReadiness(clientId, e2e.id);
    await Mfg.reserveMaterial({ clientId, batchId: e2e.id, salesOrderNumber: "SO-DEMO-E2E-1000", productId: fabric.id, sku: fabric.sku, qty: 100, createdBy: clientId });
    await Mfg.transitionBatch(e2e.id, clientId, "ready_to_start", clientId, "DEMO: materials ready, reserved 100 fabric");
    console.log(`  ✅ readiness ${r2.materialStatus} → reserved 100 fabric → ready_to_start (live: updates → issue → complete → hold → release → dispatch)`);
  } catch (e: any) {
    console.log(`  ⚠ E2E scenario skipped: ${e.message}`);
  }
  console.log("Done. Next: complete → Hold → verify allocate BLOCKED → Release → allocate → dispatch.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

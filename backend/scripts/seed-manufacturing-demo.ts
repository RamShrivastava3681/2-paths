/**
 * Seed / reset the manufacturing demo dataset for ONE tenant.
 *
 * Usage:
 *   CLIENT_ID=<userId> npx tsx scripts/seed-manufacturing-demo.ts
 *   CLIENT_ID=<userId> npx tsx scripts/seed-manufacturing-demo.ts --reset
 *
 * Seed writes (all labelled demo data, generic modules only):
 *  - business-mode = manufacturer
 *  - manufacturing-config: latex lines / shifts / dipping stages / quality roles / tally simulated
 *  - 1 demo ManufacturingBatch (10,000 gloves) + 2 production updates + 1 open factory issue
 *
 * Reset deletes ONLY ManufacturingBatch / ProductionUpdate / FactoryIssue rows
 * for the given clientId. Core trading documents are never touched.
 */
import * as db from "../src/dynamodb.js";
import * as Mfg from "../src/models/manufacturing.js";

const clientId = process.env.CLIENT_ID || "";
const reset = process.argv.includes("--reset");

if (!clientId) {
  console.error("CLIENT_ID env is required (the tenant userId to seed).");
  process.exit(1);
}

async function main() {
  if (reset) {
    for (const t of ["ManufacturingBatch", "ProductionUpdate", "FactoryIssue"] as const) {
      const all = await db.scanByType(t, { limit: 2000 });
      const own = all.filter((r: any) => r.clientId === clientId);
      for (const r of own) await db.deleteItem(r.pk, r.sk);
      console.log(`  🧹 deleted ${own.length} ${t} rows for ${clientId}`);
    }
    console.log("Reset complete — other tenants and trading documents untouched.");
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
    createdBy: clientId,
  });
  console.log("  ✅ 1 open factory issue (owner assigned)");
  console.log("Done. Next: complete → Hold → verify allocate BLOCKED → Release → allocate → dispatch.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

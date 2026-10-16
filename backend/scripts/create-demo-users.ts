/**
 * Create the manufacturing demo tenant + role test users (ONE-TIME setup).
 *
 * Usage:
 *   npx tsx scripts/create-demo-users.ts
 *
 * Creates (skipped if the email already exists):
 *  - demo.mfg@test.local (factor_admin) — the demo TENANT; seed data with
 *    CLIENT_ID=<its id> npx tsx scripts/seed-manufacturing-demo.ts
 *  - role users for permission tests (each is its own tenant; used to verify
 *    nav gating + API 403s, not shared data):
 *    demo.sales@test.local (sales_rep), demo.purchase@test.local (operations),
 *    demo.stores@test.local (operations), demo.production@test.local (operations),
 *    demo.supervisor@test.local (operations), demo.quality@test.local (checker),
 *    demo.finance@test.local (treasury), demo.checker@test.local (checker)
 *
 * All get the password printed at the end. TEST ACCOUNTS ONLY — rotate or
 * delete after the client demo.
 */
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import * as db from "../src/dynamodb.js";

const PASSWORD = "Demo@1234";

const USERS: Array<{ email: string; contactName: string; roles: string[] }> = [
  { email: "demo.mfg@test.local", contactName: "DEMO Mfg Admin", roles: ["factor_admin"] },
  { email: "demo.sales@test.local", contactName: "DEMO Sales", roles: ["sales_rep"] },
  { email: "demo.purchase@test.local", contactName: "DEMO Purchase", roles: ["operations"] },
  { email: "demo.stores@test.local", contactName: "DEMO Stores", roles: ["operations"] },
  { email: "demo.production@test.local", contactName: "DEMO Production", roles: ["operations"] },
  { email: "demo.supervisor@test.local", contactName: "DEMO Supervisor", roles: ["operations"] },
  { email: "demo.quality@test.local", contactName: "DEMO Quality", roles: ["checker"] },
  { email: "demo.finance@test.local", contactName: "DEMO Finance", roles: ["treasury"] },
  { email: "demo.checker@test.local", contactName: "DEMO Checker", roles: ["checker"] },
];

async function main() {
  const existing = (await db.scanByType("User", { limit: 500 })) as any[];
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  for (const u of USERS) {
    const found = existing.find((x: any) => String(x.email || "").toLowerCase() === u.email);
    if (found) {
      console.log(`  ⏭ exists ${u.email} id=${found.id} roles=${(found.roles || []).join(",")}`);
      continue;
    }
    const id = uuid();
    const now = db.nowISO();
    await db.putItem({
      pk: `USER#${id}`,
      sk: `USER#${id}`,
      gsi1pk: `CLIENT#${id}`,
      gsi1sk: `User#${now}`,
      gsi2pk: "User",
      gsi2sk: `User#${id}`,
      entityType: "User",
      id,
      email: u.email,
      passwordHash,
      companyName: "DEMO Tenant — delete after client demo",
      contactName: u.contactName,
      photoUrl: null,
      address: null,
      phone: null,
      roles: u.roles,
      reportingManagerId: null,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`  ✅ created ${u.email} id=${id} roles=${u.roles.join(",")}`);
  }
  console.log(`Done. Shared password for all demo accounts: ${PASSWORD} (rotate/delete after demo).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

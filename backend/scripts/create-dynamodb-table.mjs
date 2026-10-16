// Creates the DynamoDB single table used by this backend.
// Run from backend/:  node scripts/create-dynamodb-table.mjs
// Reads region/credentials/table name from backend/.env
//
// Schema (must match src/dynamodb.ts):
//   - Partition key: pk (S), Sort key: sk (S)
//   - GSI1: gsi1pk (HASH) + gsi1sk (RANGE)  — client-scoped queries (CLIENT#<id>)
//   - GSI2: gsi2pk (HASH) + gsi2sk (RANGE)  — entity listings
//   - Pay-per-request billing (no capacity planning needed)

import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { readFileSync } from "fs";

const env = {};
for (const line of readFileSync(".env", "utf-8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i === -1) continue;
  env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

const region = env.AWS_REGION || "ap-south-1";
const tableName = env.DYNAMODB_TABLE;
const accessKeyId = env.AWS_ACCESS_KEY_ID;
const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;

if (!accessKeyId || !secretAccessKey) {
  console.error("❌ AWS credentials not found in .env");
  process.exit(1);
}
if (!tableName) {
  console.error("❌ DYNAMODB_TABLE not set in .env");
  process.exit(1);
}

const client = new DynamoDBClient({ region, credentials: { accessKeyId, secretAccessKey } });

async function exists() {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (e) {
    if (e?.__type?.includes("ResourceNotFoundException")) return false;
    throw e;
  }
}

if (await exists()) {
  console.log(`Table "${tableName}" already exists — nothing to do.`);
  process.exit(0);
}

console.log(`Creating table "${tableName}" in ${region} ...`);
await client.send(
  new CreateTableCommand({
    TableName: tableName,
    BillingMode: "PAY_PER_REQUEST",
    AttributeDefinitions: [
      { AttributeName: "pk", Type: "S" },
      { AttributeName: "sk", Type: "S" },
      { AttributeName: "gsi1pk", Type: "S" },
      { AttributeName: "gsi1sk", Type: "S" },
      { AttributeName: "gsi2pk", Type: "S" },
      { AttributeName: "gsi2sk", Type: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "GSI1",
        KeySchema: [
          { AttributeName: "gsi1pk", KeyType: "HASH" },
          { AttributeName: "gsi1sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
      {
        IndexName: "GSI2",
        KeySchema: [
          { AttributeName: "gsi2pk", KeyType: "HASH" },
          { AttributeName: "gsi2sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
  })
);

console.log(`✅ Table "${tableName}" created. Waiting until ACTIVE ...`);
for (;;) {
  const d = await client.send(new DescribeTableCommand({ TableName: tableName }));
  if (d.Table?.TableStatus === "ACTIVE") break;
  await new Promise((r) => setTimeout(r, 3000));
}
console.log("✅ Table is ACTIVE. Restart the backend so it can seed the admin user.");

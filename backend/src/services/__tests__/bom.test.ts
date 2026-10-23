import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────────────────
const products: any[] = [];
const boms: any[] = [];
let nextItem: any = null;

vi.mock("../../models/product.js", () => ({
  list: vi.fn(() => Promise.resolve(products)),
  get: vi.fn((id: string) => Promise.resolve(products.find((p) => p.id === id) ?? null)),
}));

vi.mock("../../models/goods-sales-order.js", () => ({
  get: vi.fn((id: string) =>
    Promise.resolve(boms.find((so: any) => so.id === id) ?? null),
  ),
}));

vi.mock("../../dynamodb.js", () => ({
  getItem: vi.fn((pk: string) => {
    if (pk.startsWith("BOM#")) {
      const id = pk.replace("BOM#", "");
      return Promise.resolve(boms.find((b) => b.id === id) ?? null);
    }
    return Promise.resolve(null);
  }),
  putItem: vi.fn((item: any) => {
    boms.push(item);
    nextItem = item;
    return Promise.resolve(item);
  }),
  updateItem: vi.fn((pk: string, _sk: string, updates: any) => {
    const id = pk.replace("BOM#", "");
    const idx = boms.findIndex((b) => b.id === id);
    if (idx === -1) return Promise.resolve(null);
    boms[idx] = { ...boms[idx], ...updates };
    return Promise.resolve(boms[idx]);
  }),
  deleteItem: vi.fn((pk: string) => {
    const id = pk.replace("BOM#", "");
    const idx = boms.findIndex((b) => b.id === id);
    if (idx !== -1) boms.splice(idx, 1);
    return Promise.resolve();
  }),
  nowISO: vi.fn(() => new Date().toISOString()),
  queryByGSI1: vi.fn((_clientId: string, opts: any) => {
    if (opts.entityType === "BillOfMaterial") {
      return Promise.resolve({ items: boms, lastKey: undefined });
    }
    return Promise.resolve({ items: [], lastKey: undefined });
  }),
}));

// ── Import after mocks ─────────────────────────────────────────────────────
import * as Bom from "../../models/bom.js";
import * as Product from "../../models/product.js";

function reset() {
  products.length = 0;
  boms.length = 0;
  nextItem = null;
  vi.clearAllMocks();
}

beforeEach(reset);

function product(overrides: any = {}) {
  const p = {
    id: "prod-1",
    clientId: "client-1",
    sku: "SHIRT-001",
    name: "Men's Shirt",
    unitOfMeasure: "piece",
    status: "active",
    ...overrides,
  };
  products.push(p);
  return p;
}

let matCounter = 0;
function material(overrides: any = {}) {
  matCounter += 1;
  const m = {
    id: `mat-${matCounter}`,
    clientId: "client-1",
    sku: `FABRIC-${matCounter}`,
    name: `Material ${matCounter}`,
    unitOfMeasure: "piece",
    status: "active",
    ...overrides,
  };
  products.push(m);
  return m;
}

describe("Bill of Materials", () => {
  it("creates a draft BOM with version 1 and validates lines", async () => {
    const p = product();
    const fabric = material({ unitOfMeasure: "metre", name: "Main Fabric" });
    const collar = material({ unitOfMeasure: "metre", name: "Collar Fabric" });
    const bom = await Bom.create({
      clientId: "client-1",
      productId: p.id,
      productName: p.name,
      lines: [
        { productId: fabric.id, qtyPerUnit: 1.6, unitOfMeasure: "metre", wastagePct: 3, category: "fabric" },
        { productId: collar.id, qtyPerUnit: 0.25, unitOfMeasure: "metre", wastagePct: 0, category: "fabric" },
      ],
      createdBy: "user-1",
    });
    expect(bom.status).toBe("draft");
    expect(bom.version).toBe(1);
    expect(bom.lines).toHaveLength(2);
    expect(bom.lines[0].qtyPerUnit).toBe(1.6);
    expect(bom.lines[0].wastagePct).toBe(3);
    expect(bom.lines[0].unitOfMeasure).toBe("metre");
  });

  it("rejects duplicate material lines", async () => {
    const p = product();
    const m = material();
    await expect(
      Bom.create({
        clientId: "client-1",
        productId: p.id,
        lines: [
          { productId: m.id, qtyPerUnit: 1, unitOfMeasure: "piece" },
          { productId: m.id, qtyPerUnit: 1, unitOfMeasure: "piece" },
        ],
      })
    ).rejects.toThrow(/duplicate/i);
  });

  it("rejects incompatible unit of measure", async () => {
    const p = product();
    const m = material({ unitOfMeasure: "metre" });
    await expect(
      Bom.create({
        clientId: "client-1",
        productId: p.id,
        lines: [{ productId: m.id, qtyPerUnit: 1, unitOfMeasure: "piece" }],
      })
    ).rejects.toThrow(/incompatible/i);
  });

  it("rejects zero or negative qtyPerUnit", async () => {
    const p = product();
    const m = material();
    await expect(
      Bom.create({
        clientId: "client-1",
        productId: p.id,
        lines: [{ productId: m.id, qtyPerUnit: 0, unitOfMeasure: "piece" }],
      })
    ).rejects.toThrow(/qtyPerUnit must be > 0/i);
  });

  it("rejects wastage outside 0-100", async () => {
    const p = product();
    const m = material();
    await expect(
      Bom.create({
        clientId: "client-1",
        productId: p.id,
        lines: [{ productId: m.id, qtyPerUnit: 1, unitOfMeasure: "piece", wastagePct: 110 }],
      })
    ).rejects.toThrow(/0–100/i);
  });

  it("approves a BOM and demotes prior approved BOMs", async () => {
    const p = product();
    const m = material();
    const bom1 = await Bom.create({
      clientId: "client-1",
      productId: p.id,
      lines: [{ productId: m.id, qtyPerUnit: 1, unitOfMeasure: "piece" }],
    });
    await Bom.approve(bom1.id, "client-1", "user-1");
    expect((await Bom.get(bom1.id))!.status).toBe("approved");
    expect((await Bom.get(bom1.id))!.version).toBe(1);

    // A second BOM for the same product, approved → version 2, first archived.
    const bom2 = await Bom.create({
      clientId: "client-1",
      productId: p.id,
      lines: [{ productId: m.id, qtyPerUnit: 2, unitOfMeasure: "piece" }],
    });
    await Bom.approve(bom2.id, "client-1", "user-1");
    expect((await Bom.get(bom1.id))!.status).toBe("archived");
    expect((await Bom.get(bom2.id))!.status).toBe("approved");
    expect((await Bom.get(bom2.id))!.version).toBe(2);
  });

  it("getApprovedByProduct returns the highest approved version", async () => {
    const p = product();
    const m = material();
    const b1 = await Bom.create({ clientId: "client-1", productId: p.id, lines: [{ productId: m.id, qtyPerUnit: 1, unitOfMeasure: "piece" }] });
    await Bom.approve(b1.id, "client-1", "user-1");
    const b2 = await Bom.create({ clientId: "client-1", productId: p.id, lines: [{ productId: m.id, qtyPerUnit: 1, unitOfMeasure: "piece" }] });
    await Bom.approve(b2.id, "client-1", "user-1");
    const approved = await Bom.getApprovedByProduct("client-1", p.id);
    expect(approved?.id).toBe(b2.id);
    expect(approved?.version).toBe(2);
  });

  it("returns null when no approved BOM exists", async () => {
    const p = product();
    const m = material();
    await Bom.create({ clientId: "client-1", productId: p.id, lines: [{ productId: m.id, qtyPerUnit: 1, unitOfMeasure: "piece" }] });
    expect(await Bom.getApprovedByProduct("client-1", p.id)).toBeNull();
  });
});

describe("Sales Order material requirements", () => {
  it("calculates requirements with wastage for one product", async () => {
    const p = product({ sku: "SHIRT-001", name: "Men's Shirt" });
    const fabric = material({ sku: "FAB-001", name: "Main Fabric", unitOfMeasure: "metre" });
    const buttons = material({ sku: "BTN-001", name: "Buttons", unitOfMeasure: "piece" });

    const bom = await Bom.create({
      clientId: "client-1",
      productId: p.id,
      productName: p.name,
      lines: [
        { productId: fabric.id, qtyPerUnit: 1.6, unitOfMeasure: "metre", wastagePct: 3, category: "fabric" },
        { productId: buttons.id, qtyPerUnit: 8, unitOfMeasure: "piece", wastagePct: 0, category: "trim" },
      ],
    });
    await Bom.approve(bom.id, "client-1", "user-1");

    // Register a sales order in the boms array (mocked GoodsSO.get reads boms).
    const so = {
      id: "so-1",
      clientId: "client-1",
      soNumber: "SO-001",
      lines: [
        { productId: p.id, sku: p.sku, name: p.name, size: null, color: null, orderedQty: 1000, unitPrice: 0, unit: "piece" },
      ],
    };
    boms.push(so);

    const result = await Bom.calculateSoMaterialRequirements("client-1", "so-1");
    expect(result.bomMissing).toHaveLength(0);
    const fabLine = result.lines.find((l) => l.materialProductId === fabric.id)!;
    expect(fabLine.baseQty).toBe(1600);
    expect(fabLine.wastageQty).toBe(48); // 1600 * 3%
    expect(fabLine.totalQty).toBe(1648);
    const btnLine = result.lines.find((l) => l.materialProductId === buttons.id)!;
    expect(btnLine.totalQty).toBe(8000);
  });

  it("handles fractional quantities", async () => {
    const p = product();
    const fabric = material({ unitOfMeasure: "metre" });
    const bom = await Bom.create({
      clientId: "client-1",
      productId: p.id,
      lines: [{ productId: fabric.id, qtyPerUnit: 0.05, unitOfMeasure: "metre", wastagePct: 0 }],
    });
    await Bom.approve(bom.id, "client-1", "user-1");
    boms.push({
      id: "so-2", clientId: "client-1", soNumber: "SO-002",
      lines: [{ productId: p.id, sku: p.sku, name: p.name, size: null, color: null, orderedQty: 3, unitPrice: 0, unit: "piece" }],
    });
    const result = await Bom.calculateSoMaterialRequirements("client-1", "so-2");
    expect(result.lines[0].totalQty).toBe(0.15);
  });

  it("flags missing / unapproved BOM", async () => {
    const p = product();
    boms.push({
      id: "so-3", clientId: "client-1", soNumber: "SO-003",
      lines: [{ productId: p.id, sku: p.sku, name: p.name, size: null, color: null, orderedQty: 100, unitPrice: 0, unit: "piece" }],
    });
    const result = await Bom.calculateSoMaterialRequirements("client-1", "so-3");
    expect(result.bomMissing).toHaveLength(1);
    expect(result.bomMissing[0].productId).toBe(p.id);
  });

  it("supports size/color variant-specific BOM lines", async () => {
    const p = product({ name: "Shirt (M Red)" });
    const fabricM = material({ name: "Fabric M", unitOfMeasure: "metre" });
    const bom = await Bom.create({
      clientId: "client-1",
      productId: p.id,
      lines: [
        { productId: fabricM.id, qtyPerUnit: 2, unitOfMeasure: "metre", wastagePct: 0, size: "M", color: "Red", category: "fabric" },
        { productId: fabricM.id, qtyPerUnit: 1.5, unitOfMeasure: "metre", wastagePct: 0, size: null, color: null, category: "fabric" },
      ],
    });
    await Bom.approve(bom.id, "client-1", "user-1");
    boms.push({
      id: "so-4", clientId: "client-1", soNumber: "SO-004",
      lines: [{ productId: p.id, sku: p.sku, name: p.name, size: "M", color: "Red", orderedQty: 10, unitPrice: 0, unit: "piece" }],
    });
    const result = await Bom.calculateSoMaterialRequirements("client-1", "so-4");
    // Only the M/Red-specific line (2 m/unit) should apply, not the generic 1.5.
    expect(result.lines[0].totalQty).toBe(20);
  });
});

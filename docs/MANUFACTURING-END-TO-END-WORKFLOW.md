# Manufacturing — Complete End-to-End Workflow Guide

**Purpose:** A plain-language walkthrough of how a customer order becomes a finished, dispatched product. It covers the customer sales order, the shortfall check, the purchase of missing material, and the full manufacturing run — with a worked example at every step.

**The single rule that governs everything:**

> A document never touches stock. Only a *confirmed* goods document does.
> - Purchase side: a confirmed **GRN** is the only thing that puts stock **in**.
> - Sales side: a **dispatch** that reaches the *Dispatched* stage is the only thing that takes stock **out**.
> - Live stock = (all confirmed stock-in) − (all confirmed stock-out). Drafts and cancelled records never count.

---

## 1. The big picture

```
CUSTOMER
   │
   ▼
[1] SALES ORDER (confirmed)                ← we promise to supply
   │
   ▼
[2] STOCK CHECK  ── enough? ── yes ──► DISPATCH (stock OUT)
   │
   no
   │
   ▼
[3] PURCHASE ORDER (sent)                  ← we buy what is missing
   │
   ▼
[4] GRN confirmed (stock IN)               ← material physically arrives
   │
   ▼
[5] MANUFACTURING
      batch → BOM → readiness → reservation
      → material issue → production → completion
      → quality release → allocation
   │
   ▼
[6] DISPATCH (stock OUT) → DELIVERY → INVOICE → PAYMENT
```

Two ways to cover a shortfall:
- **Trading path:** buy the *finished product* and dispatch it (steps 3–4 for the finished SKU).
- **Manufacturing path:** buy *raw material*, then produce the finished product (steps 3–5).

---

## 2. Step 1 — Create the Customer Sales Order

**What it is:** the customer's confirmed commitment to buy. It records customer, addresses, delivery dates, payment terms and one line per product.

**What it does to stock:** nothing.

**Statuses:** `draft → warehouse_pending → warehouse_approved → checker_pending → confirmed → partially_dispatched → fully_dispatched` (or `cancelled`).

**Example**

| Field | Value |
|---|---|
| Customer | Acme Retail Ltd |
| Product | Cotton Shirt (M) |
| Ordered quantity | 1,000 pieces |
| Unit price | ₹500 |
| Line total | ₹500,000 |
| Expected delivery | 10 days from today |
| Status after confirmation | confirmed |

The order exists and is agreed, but no inventory has moved.

---

## 3. Step 2 — Stock check

**What it is:** compare the ordered quantity against the live stock of that product.

**Result of the example**

| Item | Value |
|---|---|
| Ordered | 1,000 |
| On hand (finished shirt) | 0 |
| Shortfall | 1,000 |

Because the finished product is not on hand, the order cannot be dispatched yet. We now either buy finished goods or manufacture them. This guide follows the manufacturing path, which needs raw material.

---

## 4. Step 3 — Create the Purchase Order

**What it is:** a commitment to a supplier to buy material. It records supplier, delivery date, payment terms and one line per material.

**What it does to stock:** nothing. A PO is a promise, not a receipt.

**Statuses:** `draft → approved → sent → partially_received → fully_received` (or `cancelled`). Only a *sent* PO can be received against.

**Example**

| Field | Value |
|---|---|
| Supplier | Weave Mills Pvt Ltd |
| Material | Cotton Fabric |
| Ordered quantity | 100 metres |
| Unit price | ₹100 |
| Status | sent |

**Why 100 metres?** The shirt's Bill of Materials uses 0.1 metres of fabric per shirt. For 1,000 shirts the requirement is 1,000 × 0.1 = **100 metres**.

---

## 5. Step 4 — GRN (Goods Received Note) — stock IN

**What it is:** the record made when material physically arrives. It captures what was received, how much was **accepted** into stock, and how much was rejected.

**What it does to stock:** on **confirm**, it credits the accepted quantity into inventory. This is the *only* purchase document that changes stock.

**Statuses:** `draft → confirmed → cancelled`.

**Example**

| Field | Value |
|---|---|
| Against PO | PO for Cotton Fabric |
| Received | 100 metres |
| Accepted | 100 metres |
| Rejected | 0 |
| Stock change | +100 metres |
| PO result | fully_received |

After confirming: raw material on hand = **100 metres**. The order's material requirement is now fully covered.

---

## 6. Step 5 — The complete manufacturing process

The manufacturing lifecycle is:

```
planned → ready_to_start → in_progress → completed
                                          │ (auto)
                                          ▼
                                     quality_review ─► released
     side states: on_hold · rework · rejected · cancelled
```

### 5.1 Create the production batch

A batch is one production run, linked to the sales order and the product to make. Several batches can serve one order.

**Example**

| Field | Value |
|---|---|
| Linked sales order | SO for 1,000 shirts |
| Product | Cotton Shirt (M) |
| Target quantity | 1,000 |
| Production line | Line 1 |
| Priority | high |
| Status | planned |

### 5.2 Define the Bill of Materials (BOM)

The BOM lists, per finished unit, how much of each raw material is consumed.

**Example**

| Material | Quantity per finished unit | Needed for 1,000 |
|---|---|---|
| Cotton Fabric | 0.1 metre | 100 metres |
| Buttons | 6 | 6,000 |
| Carton | 0.01 | 10 |

The BOM is locked once production starts — it cannot be changed after that.

### 5.3 Material readiness check

The system compares what is required against what is free (on hand minus anything already reserved for other jobs).

**Readiness states**

| State | Meaning |
|---|---|
| ready | Everything required is available |
| partial | Some lines covered |
| blocked | Little or nothing available |
| awaiting_inspection | No BOM yet |

**Example result**

| Material | Required | Available | Reserved | Shortage |
|---|---|---|---|---|
| Cotton Fabric | 100 | 100 | 0 | 0 |
| Result | | | | **ready** |

If a shortage existed, the loop would go back to Step 3 (raise a PO) and Step 4 (receive a GRN) until readiness is `ready`.

### 5.4 Reserve materials

Reservation soft-allocates raw stock to the batch. It is a marker, not a movement — stock does not change. Reserving more than is free is blocked.

**Example:** reserve 100 metres of fabric for the batch. On hand stays 100; unreserved free drops to 0.

### 5.5 Start production

A batch may only move to **ready_to_start** when its material status is `ready`, then to **in_progress**. Starting stamps the actual start time and the batch can no longer take BOM changes.

**Example:** planned → ready_to_start → in_progress.

### 5.6 Issue materials (raw stock OUT)

Issuing consumes reserved raw material and *does* reduce raw stock. Issuing more than is on hand is blocked.

**Example**

| Item | Before | Issued | After |
|---|---|---|---|
| Cotton Fabric | 100 | 100 | 0 |

### 5.7 Record production updates

Floor teams log incremental output: good, rejected and rework quantities, plus line/machine/staffing status. Totals are always derived from these entries, and each submission carries an idempotency key so a retry never double-counts.

**Example**

| Update | Stage | Good | Rejected |
|---|---|---|---|
| 1 | Dipping | 600 | 20 |
| 2 | Packing | 400 | 0 |
| **Total** | | **1,000** | **20** |

### 5.8 Complete the batch

Marking the batch complete records the end time and automatically moves it to **quality_review**. Finished goods are **not** available yet.

### 5.9 Quality inspection and release

Quality inspects the output and records accepted, rejected and rework quantities, then makes a decision:

| Decision | Effect |
|---|---|
| release | Accepted quantity becomes released stock |
| hold | Batch goes on hold; stock stays unavailable |
| rework | Batch returns for rework |

Only **Released** stock is available for allocation or dispatch. Held, pending and rejected quantities never become available. The released quantity can never exceed the accepted/produced quantity.

**Example**

| Item | Value |
|---|---|
| Inspected | 1,000 |
| Accepted | 1,000 |
| Rejected | 0 |
| Decision | release |
| Released stock | 1,000 |
| Batch status | released |

**Worked quantities (always shown on the batch):**
- available = released − allocated (only while Released; otherwise 0)
- held / pending = produced good − released
- rejects and rework are never releasable

### 5.10 Allocate released stock

Allocation ties released finished stock to the order it will fulfil. It reduces availability and is blocked while the batch is not Released.

**Example:** allocate 1,000 shirts → released 1,000, allocated 1,000, available 0.

---

## 7. Step 6 — Dispatch, delivery, invoice, payment

**Dispatch note:** created against the confirmed sales order. Confirming it releases the goods for picking but does **not** change stock. Stock is debited exactly once when the pipeline reaches **Dispatched**.

**Shipping pipeline:** `picking → packed → awaiting_pick → dispatched → in_transit → delivered`.

**What happens at Dispatched:** stock-out movements are created for the dispatched quantity and the sales order is updated to `partially_dispatched` or `fully_dispatched`.

**Then:**
- **Delivery** records delivered quantity (no further stock effect).
- **Returns** credit stock back and reopen the order for re-dispatch.
- **Sales invoice** bills the customer (no stock effect).
- **Payment** closes the receivable.

**Example end state**

| Item | Value |
|---|---|
| Ordered | 1,000 |
| Dispatched | 1,000 |
| Sales order status | fully_dispatched |
| Deliverable stock at start of dispatch | 1,000 (batch release) |

---

## 8. Complete worked example, end to end

| # | Stage | What happens | Stock effect |
|---|---|---|---|
| 1 | Sales order | Acme orders 1,000 shirts @ ₹500, confirmed | none |
| 2 | Stock check | 0 on hand vs 1,000 needed → shortfall | none |
| 3 | Purchase order | Buy 100 m fabric @ ₹100, sent to supplier | none |
| 4 | GRN confirmed | 100 m accepted | fabric +100 |
| 5.1 | Batch created | Target 1,000 shirts, linked to SO | none |
| 5.2 | BOM | 0.1 m fabric per shirt → 100 m required | none |
| 5.3 | Readiness | 100 required vs 100 available → ready | none |
| 5.4 | Reserve | 100 m reserved for the batch | none |
| 5.5 | Start | planned → ready_to_start → in_progress | none |
| 5.6 | Issue | 100 m issued to the batch | fabric −100 |
| 5.7 | Production | 1,000 good, 20 rejected logged | none |
| 5.8 | Complete | Batch → quality_review | none |
| 5.9 | Quality release | 1,000 accepted and released | finished goods released |
| 5.10 | Allocate | 1,000 allocated to the order | availability → 0 |
| 6 | Dispatch to Dispatched | Goods leave | finished goods −1,000 |
| 6 | Delivery | Received by customer | none |
| 6 | Invoice + payment | Billed and settled | none |

---

## 9. Guards and rules to remember

- A PO, purchase invoice, quotation, sales order and sales invoice **never** change stock.
- A GRN credits stock only on **confirm**, only for the **accepted** quantity.
- A dispatch debits stock only when the pipeline reaches **Dispatched**, exactly once.
- You cannot start production (`ready_to_start`) until materials are `ready`.
- You cannot issue or reserve more than is available (over-issue and over-reservation are blocked).
- You cannot allocate or dispatch goods that are not **Released**.
- You cannot release more than was produced and accepted.
- Production totals are always derived from the logged updates; retries never double-count.
- Cancelling a GRN or dispatch reverses its own stock effect; cancelled records drop out of the balance.

---

## 10. Known gap to be aware of

When quality releases a batch, the released quantity is tracked on the batch but is **not** automatically posted into the trading stock ledger. As a result, dispatching the goods through the normal dispatch pipeline (which reads the trading ledger) can report zero available even though the batch shows released stock. Until this is closed, either the released finished goods must also be credited to inventory, or dispatch readiness must read batch availability directly.

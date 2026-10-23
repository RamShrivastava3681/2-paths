# Manufacturing Workflow Automation Plan — WhizUnik Command

## Audit Summary

### Existing Automation (Reused, Not Rebuilt)

| Area | What Already Exists | File |
|---|---|---|
| Stock atomicity | `updateItemIf` conditional flips for draft→confirmed, stockDebited flag | `dynamodb.ts`, `stock-movement.ts`, `goods-dispatch.ts` |
| GRN → stock IN | Confirmed GRN posts `StockMovement` direction `in` | `goods-receipt.ts` |
| Dispatch → stock OUT | `stockDebited` flag prevents double-debit | `goods-dispatch.ts` |
| SO dispatch tracking | `recordDispatch()` folds qty into SO lines + recomputeStatus | `goods-sales-order.ts` |
| Material issue idempotency | `idempotencyKey` dedupe on `MaterialIssue` | `manufacturing.ts` |
| Production update idempotency | `idempotencyKey` dedupe on `ProductionUpdate` | `manufacturing.ts` |
| Quality release idempotency | `idempotencyKey` dedupe on release | `manufacturing.ts` |
| Over-reservation blocked | Reservation balance check before create | `manufacturing.ts` |
| Batch lifecycle guards | `BATCH_TRANSITIONS` map with material/quality guards | `manufacturing.ts` |
| `stockVersion` optimistic concurrency | Added in Stage 1 | `product.ts`, `manufacturing.ts` |
| Dashboard KPIs + attention | `workflowOverview()` real-data aggregation | `manufacturing.ts` |
| Domain events | Fire-and-forget named events | `domain-event.ts` |
| Accounting handoff retry | `prepareHandoff`/`sendHandoff` with attempts | `manufacturing.ts` |

### Automation Gaps to Address

| Section | Gap | Impact |
|---|---|---|
| 2. Sales Order | No automatic batch pre-fill or demand linkage from confirmed SO | Manual re-entry of SO data into batch |
| 2. Sales Order | No duplicate batch prevention for same outstanding requirement | Potential duplicate batches |
| 2. Sales Order | No recalculation when SO changes/cancels | Stale demand |
| 3. Material Readiness | Readiness not auto-recalculated on stock/GRN/reservation changes | Stale `materialStatus` authorizes production incorrectly |
| 3. Material Readiness | No automatic `ready_to_start` transition when ready | Manual transition even when conditions met |
| 4. PO/GRN | No automatic field pre-fill from PO to GRN | Manual re-entry |
| 4. PO/GRN | No automatic PO status update after GRN confirmation | Manual PO status management |
| 4. PO/GRN | No readiness refresh after accepted GRN | Stale shortage calculations |
| 4. PO/GRN | No overdue/partial receipt flagging for production impact | Missed production delays |
| 5. Material Issue | No outstanding requirement calculation from BOM + issues | Manual material planning |
| 5. Material Issue | No auto-recalc of readiness after issue | Stale availability |
| 6. Production Progress | No auto-completion % from target vs good output | Manual calculation |
| 6. Production Progress | No stall detection (no updates for configurable period) | Missed stalled batches |
| 6. Production Progress | No supervisor notification on stalled/at-risk production | Missed escalations |
| 7. Quality Inspection | No auto-pre-fill from batch production quantities | Manual re-entry |
| 7. Quality Inspection | No auto-notification to inspector on quality_review | Missed inspections |
| 7. Quality Inspection | No supervisor notification on hold/rework | Missed escalations |
| 8. Allocation | No auto-suggestion of allocations against SOs | Manual allocation matching |
| 8. Allocation | No duplicate allocation prevention across SOs | Over-allocation risk |
| 9. Dispatch | No auto-pre-fill from SO allocations | Manual re-entry |
| 9. Dispatch | No delay notification in shipping pipeline | Missed SLA breaches |
| 9. Dispatch | No auto SO status update after dispatch (partially exists) | Manual SO status |
| 10. Invoice | No auto-pre-fill from dispatched SO quantities | Manual re-entry |
| 10. Invoice | No un-invoiced dispatched quantity identification | Missed billing |
| 10. Invoice | No finance notification for dispatched awaiting invoice | Missed billing |
| 11. Event-Driven | No reliable event outbox; domain events are fire-and-forget | Failed automations not retried |
| 12. Notifications | No duplicate notification prevention | Notification spam |
| 12. Notifications | No escalation for unresolved events | Missed actions |

---

## Implementation Plan

### Phase 1: Sales Order → Batch Demand Linkage (Week 1)

**Goal:** When SO is confirmed, its demand is available to manufacturing planning. Batch fields pre-fill from SO. Duplicate batches prevented.

**Backend changes:**
- `backend/src/models/manufacturing.ts`:
  - Add `getOutstandingDemand(clientId, productId)` — calculates net manufacturing demand from confirmed SOs minus already dispatched/allocated quantities
  - Add `findExistingBatchForDemand(clientId, salesOrderId, productId)` — prevents duplicate batches for same SO/product
  - Modify `createBatch()` to accept optional `salesOrderId` and auto-pre-fill `productId`, `sku`, `productName`, `targetQty`, `deliveryDate`, `priority` from the SO
  - Add `recalculateDemandOnSOChange(salesOrderId)` — called when SO is confirmed, amended, or cancelled; recalculates outstanding requirement without deleting historical batches or reversing posted stock

**Frontend changes:**
- `frontend/src/routes/app.manufacturer-workbench.tsx` — BatchesTab: when `filter` comes from SO context, pre-fill create form with SO data
- `frontend/src/lib/api-client.ts` — Add `manufacturing.demand.outstanding(productId)` and `manufacturing.demand.existingBatch(salesOrderId, productId)` endpoints

**Tests:**
- `backend/src/services/__tests__/so-demand.test.ts` — SO confirm creates demand, duplicate batch prevention, SO cancel recalculates

---

### Phase 2: Material Readiness Automation (Week 2)

**Goal:** Readiness auto-recalculates on inventory changes. Batch auto-transitions to `ready_to_start` when conditions met. Stale results blocked.

**Backend changes:**
- `backend/src/models/manufacturing.ts`:
  - Add `refreshReadinessOnStockChange(clientId, productId)` — called after GRN confirm, material issue, reservation release; recomputes readiness for affected batches
  - Add `autoTransitionToReadyToStart(batchId, clientId)` — called after readiness refresh; transitions to `ready_to_start` only if `materialStatus === ready` and existing transition rules pass
  - Add `isReadinessStale(batch)` — checks if readiness was computed before a relevant stock change; blocks production start if stale

**Frontend changes:**
- `frontend/src/routes/app.manufacturer-workbench.tsx` — MaterialsTab: show "stale" warning if readiness computed before recent stock change; auto-refresh button
- `frontend/src/lib/api-client.ts` — Add `manufacturing.batches.refreshReadiness(batchId)` endpoint

**Tests:**
- `backend/src/services/__tests__/readiness-automation.test.ts` — Readiness recalculates after GRN, issue, reservation; auto-transition to ready_to_start; stale readiness blocked

---

### Phase 3: PO → GRN Automation (Week 3)

**Goal:** GRN pre-fills from PO. PO status auto-updates after GRN. Readiness refreshes after accepted stock. Overdue/partial receipts flagged.

**Backend changes:**
- `backend/src/models/goods-receipt.ts`:
  - Modify `create()` to auto-populate `supplierId`, `supplierName`, `warehouse`, `poNumber`, `goodsPurchaseOrderId` from linked PO
  - Add `outstandingQty` calculation per line: `orderedQty - sum(confirmed acceptedQty)`
- `backend/src/models/goods-purchase-order.ts`:
  - Modify `recordReceipt()` to auto-update PO status: `partially_received` if any line outstanding, `fully_received` if all lines received
- `backend/src/models/manufacturing.ts`:
  - Call `refreshReadinessOnStockChange()` after GRN confirm in `flipToConfirmed()`
- `backend/src/routes/manufacturing.ts` (or existing GRN route):
  - Add endpoint to flag POs overdue or partially received when outstanding affects production

**Frontend changes:**
- `frontend/src/routes/app.grn.tsx` — Auto-fill PO fields when PO selected
- `frontend/src/routes/app.purchase-orders.tsx` — Show overdue/partial receipt flags

**Tests:**
- `backend/src/services/__tests__/po-grn-automation.test.ts` — GRN pre-fill from PO, PO status auto-update, readiness refresh after GRN, overdue/partial flagging

---

### Phase 4: Material Reservation & Issue Automation (Week 4)

**Goal:** Outstanding material requirement auto-calculated from BOM + issues. Reservations validated. Concurrent issues safe.

**Backend changes:**
- `backend/src/models/manufacturing.ts`:
  - Add `getOutstandingMaterialRequirement(batchId)` — BOM qty × targetQty minus confirmed material issues
  - Modify `reserveMaterial()` to validate against available stock + active reservations (already exists, enhance with stockVersion check)
  - Add `autoReleaseReservationOnIssue(batchId, productId, issuedQty)` — when material is issued, reduce corresponding reservation qty or mark consumed
  - Enhance `issueMaterial()` with `stockVersion` optimistic concurrency (already done in Stage 1)

**Frontend changes:**
- `frontend/src/routes/app.manufacturer-workbench.tsx` — MaterialsTab: show outstanding requirement per BOM line; auto-suggest reservation qty

**Tests:**
- `backend/src/services/__tests__/material-automation.test.ts` — Outstanding requirement calc, reservation validation, concurrent issue safety, duplicate prevention

---

### Phase 5: Production Progress Automation (Week 5)

**Goal:** Completion % auto-calculated. Stalls detected. Supervisors notified.

**Backend changes:**
- `backend/src/models/manufacturing.ts`:
  - Add `getStalledBatches(clientId, thresholdHours)` — batches in `in_progress` with no updates beyond threshold (use `ManufacturingConfig` for threshold if available, default 24h)
  - Add `flagProductionInterruption(batchId, reason)` — when `lineStatus` is `stopped`/`maintenance` in a production update
  - Modify `recordUpdate()` to auto-update batch completion % and trigger completion transition when good output >= target AND existing rules permit
  - Add `notifySupervisorOnStall(batchId)` — queue notification (reuse existing notification-log or domain-event)

**Frontend changes:**
- `frontend/src/routes/app.manufacturer-workbench.tsx` — OverviewTab: show stalled batches in attention list; BatchesTab: highlight stalled batches

**Tests:**
- `backend/src/services/__tests__/production-progress.test.ts` — Completion % calc, stall detection, interruption flagging, completion transition guard

---

### Phase 6: Quality Inspection Automation (Week 6)

**Goal:** Inspection pre-fills from batch. Inspector notified on quality_review. Hold/rework supervisor notified.

**Backend changes:**
- `backend/src/models/manufacturing.ts`:
  - Modify `createInspection()` to auto-pre-fill `plannedQty` from `targetQty`, `inspectedQty` from `producedGoodQty`, `acceptedQty` from `producedGoodQty` (user can override)
  - Add `notifyInspectorOnQualityReview(batchId)` — queue notification when batch enters `quality_review`
  - Add `notifySupervisorOnHoldOrRework(batchId, outcome)` — queue notification
  - Enhance `decideInspection()` with duplicate release prevention (already exists via idempotencyKey)

**Frontend changes:**
- `frontend/src/routes/app.manufacturer-workbench.tsx` — QualityTab: auto-fill form from batch data; show pending inspections requiring inspector action

**Tests:**
- `backend/src/services/__tests__/quality-automation.test.ts` — Inspection pre-fill, quantity validation, inspector notification, hold/rework notification, duplicate release prevention

---

### Phase 7: Finished Stock Allocation Automation (Week 7)

**Goal:** Auto-suggest allocations against SOs. Prevent duplicate allocation.

**Backend changes:**
- `backend/src/models/manufacturing.ts`:
  - Add `suggestAllocations(clientId)` — for each released batch with `availableQty > 0`, find confirmed SOs with outstanding qty, sorted by delivery date then priority
  - Add `validateAllocation(batchId, qty)` — revalidate stock and allocation balance immediately before commit (already exists, enhance)
  - Add `preventDuplicateAllocation(batchId, soId, qty)` — check if same qty already allocated to same SO from same batch

**Frontend changes:**
- `frontend/src/routes/app.manufacturer-workbench.tsx` — DispatchTab: show auto-suggested allocations; one-click allocate

**Tests:**
- `backend/src/services/__tests__/allocation-automation.test.ts` — Allocation suggestions, duplicate prevention, stock revalidation before commit

---

### Phase 8: Dispatch Automation (Week 8)

**Goal:** Dispatch pre-fills from SO allocations. SO status auto-updates. Delay notifications.

**Backend changes:**
- `backend/src/models/goods-dispatch.ts`:
  - Modify `create()` to auto-pre-fill from SO lines and existing allocations
  - Add `validateDispatchQty(soId, productId, qty)` — against allocated and outstanding quantities
  - Add `flagDelayedDispatches(clientId)` — dispatches in pipeline stages beyond configured threshold
- `backend/src/models/goods-sales-order.ts`:
  - Ensure `recordDispatch()` auto-updates SO status (already exists, verify)

**Frontend changes:**
- `frontend/src/routes/app.dispatches.tsx` — Auto-fill from SO; show delayed dispatch flags

**Tests:**
- `backend/src/services/__tests__/dispatch-automation.test.ts` — Dispatch pre-fill, qty validation, SO status update, duplicate stock deduction prevention, partial dispatch handling

---

### Phase 9: Sales Invoice Automation (Week 9)

**Goal:** Invoice pre-fills from dispatched SO. Un-invoiced qty identified. Finance notified.

**Backend changes:**
- `backend/src/models/invoice.ts`:
  - Add `getUninvoicedDispatchedQty(clientId, soId)` — dispatched qty minus invoiced qty
  - Modify `create()` to auto-pre-fill from SO: customer, lines, quantities, prices, taxes
  - Add `preventDuplicateInvoicing(soId, productId, qty)` — check existing invoices for same SO/product/qty
- `backend/src/models/journal.ts` / `chart-of-account.ts` — Reuse existing (no changes)

**Frontend changes:**
- `frontend/src/routes/app.finance-workbench.tsx` — Sales Invoices tab: show dispatched awaiting invoicing; one-click create invoice

**Tests:**
- `backend/src/services/__tests__/invoice-automation.test.ts` — Invoice pre-fill, un-invoiced qty, duplicate prevention, credit limit validation

---

### Phase 10: Event-Driven Architecture & Notifications (Week 10)

**Goal:** Reliable event-driven execution. Duplicate notification prevention. Retryable notifications.

**Backend changes:**
- `backend/src/models/event-outbox.ts` (NEW — only if strictly needed; otherwise reuse `domain-event.ts`):
  - Transactional outbox: events stored in same DB transaction as business data
  - Status: `pending | published | failed | dead-letter`
  - Idempotency keys, correlation IDs, retry count, last error
- `backend/src/models/event-dispatcher.ts` (NEW):
  - Polls outbox, publishes events, marks success/failure
  - Retry policy with exponential backoff
  - Dead-letter handling
- `backend/src/models/notification-log.ts` (reuse existing):
  - Add `hasNotification(eventKey, clientId)` — duplicate prevention
  - Add `createNotification(eventKey, clientId, userId, type, message, retryable)`

**Events to wire:**
- `sales_order.confirmed` → `refreshReadinessOnStockChange`, `createBatch` suggestion
- `goods_receipt.confirmed` → `refreshReadinessOnStockChange`, `updatePOStatus`
- `material_issue.posted` → `refreshReadinessOnStockChange`
- `production_update.created` → `checkCompletion`, `flagStall`
- `batch.completed` → `notifyInspectorOnQualityReview`
- `quality.decision` → `refreshAllocation`, `notifySupervisor`
- `allocation.created` → `refreshDispatchReadiness`
- `dispatch.status_changed` → `updateSOStatus`, `flagDelay`
- `dispatch.confirmed` → `notifyFinanceAwaitingInvoice`

**Tests:**
- `backend/src/services/__tests__/event-automation.test.ts` — Outbox idempotency, retry, dead-letter, duplicate notification prevention

---

### Phase 11: Testing & Validation (Week 11-12)

**Tests to add:**
- `backend/src/services/__tests__/so-demand.test.ts`
- `backend/src/services/__tests__/readiness-automation.test.ts`
- `backend/src/services/__tests__/po-grn-automation.test.ts`
- `backend/src/services/__tests__/material-automation.test.ts`
- `backend/src/services/__tests__/production-progress.test.ts`
- `backend/src/services/__tests__/quality-automation.test.ts`
- `backend/src/services/__tests__/allocation-automation.test.ts`
- `backend/src/services/__tests__/dispatch-automation.test.ts`
- `backend/src/services/__tests__/invoice-automation.test.ts`
- `backend/src/services/__tests__/event-automation.test.ts`

**Run:**
- `npm run typecheck` (backend + frontend)
- `npx tsx scripts/test-manufacturing-workflow.ts` (existing E2E — must still pass 24/24)
- `npx tsx src/services/__tests__/stabilise.test.ts` (existing stabilisation — must still pass 18/18)
- All new test files

---

## File Summary

### New Backend Files (2)
```
backend/src/models/event-outbox.ts
backend/src/models/event-dispatcher.ts
```

### Modified Backend Files (10)
```
backend/src/models/manufacturing.ts       — SO demand linkage, readiness refresh, auto-transition, material req, stall detection, quality notification, allocation suggestions
backend/src/models/goods-receipt.ts       — PO pre-fill, outstanding qty, readiness refresh after confirm
backend/src/models/goods-purchase-order.ts — Auto PO status update after receipt
backend/src/models/goods-dispatch.ts      — SO pre-fill, qty validation, delay flagging
backend/src/models/goods-sales-order.ts   — SO status auto-update after dispatch (verify existing)
backend/src/models/invoice.ts             — Un-invoiced qty, duplicate prevention, SO pre-fill
backend/src/models/product.ts             — Already has stockVersion (Stage 1)
backend/src/models/stock-movement.ts      — Already has atomic confirm (Stage 1)
backend/src/routes/manufacturing.ts       — New endpoints for demand, readiness refresh, allocation suggestions
backend/src/routes/index.ts               — Mount new routes if needed
```

### Modified Frontend Files (6)
```
frontend/src/routes/app.manufacturer-workbench.tsx  — BatchesTab pre-fill, MaterialsTab outstanding qty, QualityTab auto-fill, DispatchTab allocation suggestions
frontend/src/routes/app.grn.tsx                     — PO pre-fill
frontend/src/routes/app.purchase-orders.tsx         — Overdue/partial flags
frontend/src/routes/app.dispatches.tsx              — SO pre-fill, delay flags
frontend/src/routes/app.finance-workbench.tsx       — Un-invoiced dispatched qty, invoice pre-fill
frontend/src/lib/api-client.ts                      — New API namespaces/methods
```

### New Test Files (10)
```
backend/src/services/__tests__/so-demand.test.ts
backend/src/services/__tests__/readiness-automation.test.ts
backend/src/services/__tests__/po-grn-automation.test.ts
backend/src/services/__tests__/material-automation.test.ts
backend/src/services/__tests__/production-progress.test.ts
backend/src/services/__tests__/quality-automation.test.ts
backend/src/services/__tests__/allocation-automation.test.ts
backend/src/services/__tests__/dispatch-automation.test.ts
backend/src/services/__tests__/invoice-automation.test.ts
backend/src/services/__tests__/event-automation.test.ts
```

---

## Restrictions Honored

| Restriction | How Plan Complies |
|---|---|
| No new features/modules/tabs/screens | Only improves existing workflow screens and backend logic |
| No new database models except event outbox/dispatcher | event-outbox.ts and event-dispatcher.ts are infrastructure, not business capabilities |
| No new dependencies | Uses existing uuid, aws-sdk, vitest |
| No new APIs unless strictly necessary | New endpoints are for existing workflow automation (demand, readiness refresh, allocation suggestions) |
| Preserve existing UI design | Only adds auto-fill, flags, and suggestions to existing screens |
| Preserve existing permissions | All new backend logic uses existing `requireOps`/`requireQuality` role gates |
| No mock data/hardcoded values | All calculations from real records |
| Don't change business rules | Status transitions, stock rules, financial calcs unchanged |
| Don't replace working logic | Enhances existing functions, doesn't rewrite them |

---

## Next Steps

1. Review this plan with the user
2. Begin Phase 1 implementation (SO → Batch demand linkage)
3. Run `npm run typecheck` in backend and frontend after each phase
4. Run existing E2E + stabilisation tests after each phase to verify no regressions
5. Add new test files per phase
# Manufacturing workflow contract (frozen)

Applies to the Manufacturing Control Center only. Trading flows and stock rules are unchanged.

## Statuses and permitted transitions

Batch: `draft → planned → ready_to_start → in_progress → completed`
(completing auto-moves to `quality_review`) `→ released`, plus
`on_hold / rework / rejected / cancelled / closed` per `BATCH_TRANSITIONS`
in `backend/src/models/manufacturing.ts`. Every move is validated server-side
(`transitionBatch`) — the UI cannot bypass it, and neither can a direct API call.

Factory issue: `open → assigned → in_progress → resolved → closed`
(`transitionIssue`). Corrective action: `open → in_progress → done → verified`.

## Guards (all enforced in the model, with error codes)

- `ready_to_start` requires `materialStatus === "ready"` (`MATERIALS_NOT_READY`).
- `released` (via transition) requires `qualityStatus === "Released"` (`QUALITY_NOT_RELEASED`).
- Allocate/dispatch-eligible stock requires Released (`BATCH_NOT_RELEASED`).
- Over-issue → `INSUFFICIENT_STOCK`; over-reservation → `OVER_RESERVATION`;
  release beyond good output → `RELEASE_EXCEEDS_OUTPUT`; release beyond an
  inspection's accepted qty → `RELEASE_EXCEEDS_INSPECTION`;
  re-deciding a released inspection to hold/rework → `INSPECTION_ALREADY_RELEASED`
  (record a new inspection instead).

## Role permissions

- Reads: any authenticated user.
- Writes (transitions incl. `on_hold → in_progress` restart, material
  issues/reservations, production updates, factory-issue writes, handoff
  prepare/send/cancel): `operations`, `factor_admin`, `super_admin`.
- Inspection recording: operations or quality roles.
- Hold / release / quality decide: quality roles (`manufacturing-config`
  `qualityRoles`, default `checker`) plus factor/super admins.
- Everyone else (sales_rep, client, treasury, …) is read-only here. 403s carry
  the required role in the message.

## Quantity formulas (shown on the batch detail screen)

- `produced = good + rejected + rework` (sums of incremental updates).
- `available = released − allocated`, reported only while Released
  (otherwise 0 — held goods never allocate).
- `held/pending = produced_good − released`. Rejects and rework are never releasable.
- Dispatch decrements Trading stock; it never rewrites batch numbers —
  batch `allocatedQty` is the link.
- Updates submit incremental quantities; totals are derived. Retried
  submissions dedupe per idempotency key (`duplicate:true`, no double count).

## Reservation semantics

Reservation marks, never moves. One balance (confirmed stock movements), one
reservation table. Readiness columns: Physical / Reserved /
Usable (= physical − reserved) / Incoming PO (info only — a PO never adds
stock) / Shortage.

## Handoff states

`pending → processing → success` (stored external ref required),
`failed → retry` (same idempotency key — no duplicate voucher/IRN/e-way bill),
plus `not_required` (e.g. e-way bill under ₹50k) and `cancelled`.
The sandbox adapter is always labelled SIMULATED unless the tenant opts into
live-test and a live connector confirms.

## Audit

Every transition stores actor, timestamp, from → to, quantities, linked
record, and remarks. Released decisions, confirmed GRNs, shipped dispatches
and successful handoffs are never silently edited — corrections use new
records (new inspection, reversal, retry).

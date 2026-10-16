"""Generate detailed Trading vs Manufacturer plan PDF."""
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor, white, black
from reportlab.platypus import (SimpleDocTemplate, Paragraph, Spacer, Table,
                                TableStyle, PageBreak, HRFlowable, ListFlowable,
                                ListItem, KeepTogether)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY

OUT = "docs/WhizUnik-Trading-Manufacturer-Detailed-Plan.pdf"

NAVY = HexColor("#0f3557")
ACCENT = HexColor("#1b7fb8")
LIGHT = HexColor("#eef4f8")
GREY = HexColor("#5b6b7a")
GREEN = HexColor("#1a7f4b")
RED = HexColor("#b42318")
AMBER = HexColor("#92690e")

styles = getSampleStyleSheet()
sTitle = ParagraphStyle("Title2", parent=styles["Title"], fontSize=26, leading=30,
                        textColor=NAVY, alignment=TA_CENTER, spaceAfter=6)
sSub = ParagraphStyle("Sub", parent=styles["Normal"], fontSize=11, leading=15,
                      textColor=GREY, alignment=TA_CENTER, spaceAfter=2)
sH1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=16, leading=20,
                     textColor=NAVY, spaceBefore=16, spaceAfter=8,
                     borderPadding=(0, 0, 4, 0))
sH2 = ParagraphStyle("H2", parent=styles["Heading2"], fontSize=12.5, leading=16,
                     textColor=ACCENT, spaceBefore=10, spaceAfter=6)
sH3 = ParagraphStyle("H3", parent=styles["Heading3"], fontSize=10.5, leading=14,
                     textColor=NAVY, spaceBefore=8, spaceAfter=4)
sBody = ParagraphStyle("Body", parent=styles["Normal"], fontSize=9.5, leading=14,
                       alignment=TA_JUSTIFY, spaceAfter=5)
sBullet = ParagraphStyle("Bullet", parent=sBody, leftIndent=16, bulletIndent=6,
                         alignment=TA_LEFT)
sCell = ParagraphStyle("Cell", parent=styles["Normal"], fontSize=8.2, leading=10.5)
sCellH = ParagraphStyle("CellH", parent=sCell, textColor=white, fontName="Helvetica-Bold")
sCap = ParagraphStyle("Cap", parent=styles["Normal"], fontSize=8, leading=10,
                      textColor=GREY, alignment=TA_CENTER, spaceAfter=6)
sFooter = ParagraphStyle("Footer", parent=styles["Normal"], fontSize=7.5,
                         textColor=white, alignment=TA_CENTER)

def P(t, s=sBody):
    return Paragraph(t, s)

def bullets(items):
    return ListFlowable([ListItem(P(x, sBullet), leftIndent=16) for x in items],
                        bulletType="bullet", leftIndent=16, bulletFontSize=8)

def table(headers, rows, widths=None):
    data = [[P(f"<b>{h}</b>", sCellH) for h in headers]]
    for r in rows:
        data.append([P(str(c), sCell) for c in r])
    t = Table(data, colWidths=widths, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), white),
        ("BACKGROUND", (0, 1), (-1, -1), white),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [white, LIGHT]),
        ("GRID", (0, 0), (-1, -1), 0.5, HexColor("#c8d4de")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t

def header_footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, A4[1] - 14*mm, A4[0], 14*mm, fill=1, stroke=0)
    canvas.setFillColor(white)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawCentredString(A4[0]/2, A4[1] - 8.5*mm,
        "WhizUnik — Trading vs Manufacturer (RFB Latex Demo) — Detailed Implementation Plan")
    canvas.setFillColor(NAVY)
    canvas.setFont("Helvetica", 7.5)
    canvas.drawCentredString(A4[0]/2, 12*mm,
        f"Confidential — Product & Engineering  |  Status: Proposed  |  Page {doc.page}")
    canvas.restoreState()

def cover_footer(canvas, doc):
    if doc.page == 1:
        canvas.saveState()
        canvas.setFillColor(NAVY)
        canvas.rect(0, 0, A4[0], 16*mm, fill=1, stroke=0)
        canvas.setFillColor(white)
        canvas.setFont("Helvetica", 7.5)
        canvas.drawCentredString(A4[0]/2, 9*mm,
            "Owner: Product & Engineering   •   Scope: RFB demo preparation   •   Core rule: documents never touch stock — only confirmed goods documents do")
        canvas.setFont("Helvetica", 7)
        canvas.drawCentredString(A4[0]/2, 4.5*mm, "Page 1")
        canvas.restoreState()
    else:
        header_footer(canvas, doc)

doc = SimpleDocTemplate(OUT, pagesize=A4,
                        leftMargin=16*mm, rightMargin=16*mm,
                        topMargin=20*mm, bottomMargin=16*mm,
                        title="WhizUnik Trading vs Manufacturer Detailed Plan",
                        author="Product & Engineering")
story = []

# COVER
story.append(Spacer(1, 22*mm))
story.append(P("WhizUnik Command", ParagraphStyle("brand", parent=sSub, fontSize=12,
              textColor=ACCENT, fontName="Helvetica-Bold")))
story.append(P("Trading vs Manufacturer", sTitle))
story.append(P("Two options on the landing page / dashboard — detailed implementation plan<br/>with RFB Latex Demo flow (10,000 gloves, demo data)", sSub))
story.append(Spacer(1, 4*mm))
story.append(HRFlowable(width="100%", thickness=1, color=ACCENT))
story.append(Spacer(1, 4*mm))
story.append(table(["Item", "Detail"], [
    ["Purpose", "Add a <b>Manufacturer</b> mode alongside existing <b>Trading</b> mode without destabilising core WhizUnik. Reuse trading flows; add generic manufacturing modules; configure RFB specifics as data."],
    ["Entry point", "Public landing (/) shows two cards: <b>Trading &amp; Distribution</b> and <b>Manufacturing</b>. Post-login dashboard (/app/dashboard) has a persistent <b>[ Trading | Manufacturer ]</b> toggle stored per tenant + user."],
    ["Product structure", "L1 Core WhizUnik (stable) → L2 Reusable manufacturing modules (generic names) → L3 Customer configuration (RFB lines, stages, shifts, sizes, roles, Tally settings). No RFB code fork."],
    ["Stock invariant", "PO / PI never create stock — only <b>confirmed GRN</b> creates stock IN. SO / invoice never reduce stock — only <b>confirmed dispatch</b> creates stock OUT. Draft/cancelled never count."],
    ["Demo scope", "One sample order of <b>10,000 gloves</b> (labelled DEMO DATA). Material shortage → PO → GRN → batch → 2 production updates → factory stoppage → Pending → Hold (blocked) → Release → allocate → dispatch readiness → Tally handoff (simulated, labelled)."],
], widths=[28*mm, 132*mm]))
story.append(Spacer(1, 4*mm))
story.append(P("How to read this document: §2 is the mode comparison. §3–§4 are the exact flows. §5–§7 are build-ready specs (models, APIs, UI). §8 is the click-by-click demo script. §9–§11 are acceptance, phases and non-goals.", sCap))

# 1
story.append(P("1 &nbsp; Guiding principles (must remain unchanged)", sH1))
story.append(bullets([
    "Existing customer workflows and screens continue to work. Trading mode is byte-for-byte the current product.",
    "A purchase order or purchase invoice must <b>not</b> increase stock. Only a <b>confirmed GRN</b> creates stock IN.",
    "A sales order or sales invoice must <b>not</b> reduce stock. Only a <b>shipped/confirmed dispatch</b> creates stock OUT.",
    "Draft and cancelled documents never affect stock: live stock = SUM(confirmed IN) − SUM(confirmed OUT).",
    "Finance, IRN and e-way bill responsibilities remain as currently implemented unless a later agreed change says otherwise.",
    "No RFB-specific <font face=\"Helvetica-Bold\">if (client === 'RFB')</font> conditions scattered through the codebase. RFB = configuration + seed data + generic modules.",
    "Every simulated Tally / compliance step is visibly labelled SIMULATED / SAMPLE EXPORT.",
]))
story.append(P("Decision rule for every future RFB request: <b>Core?</b> (needed by most customers → build in core) · <b>Reusable module?</b> (needed by a class → build generically) · <b>Setting?</b> (one tenant → configure as data). If it would change core stock, finance or document behaviour — stop and review impact first.", sBody))

# 2
story.append(P("2 &nbsp; The two options — what each mode contains", sH1))
story.append(P("2.1 Mode selector behaviour", sH2))
story.append(bullets([
    "<b>Public landing (/):</b> two cards — <i>Trading &amp; Distribution: buy, stock, sell, collect</i> and <i>Manufacturing: everything in Trading plus batches, live floor updates, factory issues, quality hold/release</i>. Cards route to /auth?mode=trading | ?mode=manufacturer and set a default; auth logic itself is unchanged.",
    "<b>Post-login (real switch):</b> persistent toggle in the topbar + dashboard header. Stored as <b>tenantSettings.businessMode</b> ('trading' | 'manufacturer' | 'both') with per-user override <b>user.lastMode</b>. Sidebar builder <b>buildNavSections(roles, mode)</b> filters nav: trading hides Manufacturing; manufacturer shows it. Same URLs, same permissions, no URL fork.",
    "Demo tenant shows a <b>DEMO DATA</b> badge and a <b>Reset demo</b> button scoped to that tenant only (clientId = RFB-DEMO).",
]))
story.append(P("2.2 Feature matrix", sH2))
story.append(table(["Area", "Trading (existing — unchanged)", "Manufacturer (reuse + additions)"],
    [
        ["Dashboard", "Command Centre: cash, receivables/payables, sales MTD, procurement, inventory intelligence, funnel", "Manufacturer Command: open orders, batch progress, good/reject, factory issues, held qty, released-ready qty. Every tile links to its source list"],
        ["Catalogue", "app/products: SKU, pricing, GST, reorder, margin", "Reuse as-is. Configure glove sizes as <i>size</i> values, category = Latex Gloves. No schema change"],
        ["Customers / Suppliers", "app/debtors, app/suppliers", "Reuse as-is. Seed 1 demo customer + 1 latex supplier"],
        ["Purchase flow", "procurement-workbench: proforma → PO → PI → GRN → stock IN", "Reuse 100% for raw-material shortage (latex, chemicals). Stock rule untouched"],
        ["Sales flow", "sales-workbench: quotation → SO → dispatch → invoice + NOA", "Reuse 100%. SO for 10,000 gloves. Dispatch confirm adds one generic guard: batch must be Released"],
        ["Inventory", "warehouse-workbench, stock-movement ledger, forecast", "Reuse ledger. Finished gloves enter via existing IN path (reason = 'Production receipt', linked to batch). No parallel ledger"],
        ["Production Batch (NEW)", "Hidden", "ManufacturingBatch → SO + product + target qty + line. planned → in_progress → completed → closed"],
        ["Live updates (NEW)", "Hidden", "ProductionUpdate: incremental entries (stage, qty since last, rejects, line status, remarks, user, time). Idempotency key blocks double-count"],
        ["Factory issues (NEW)", "Hidden", "FactoryIssue: stoppage / maintenance / staffing / utility / material. Line + affected batch + owner + expected resolution + open/closed"],
        ["Quality (NEW)", "Hidden", "qualityStatus Pending → Hold → Released, separate from production status. Only quality role can Release. Pending/Hold cannot be allocated"],
        ["Dispatch readiness", "Soft stock check (warn)", "Hardened: only Released stock allocatable. Pending/Hold → blocked message + link to quality page"],
        ["Finance / IRN / e-way", "finance-workbench, journals, e-way bill", "Reuse unchanged"],
        ["Tally", "tallyVoucherRef display", "Same + SIMULATED sample export button on manufacturer dashboard. No new live integration"],
    ], widths=[28*mm, 66*mm, 66*mm]))

# 3
story.append(P("3 &nbsp; Trading flow (reference — do not rebuild)", sH1))
story.append(P("Supplier proforma → Purchase Order → Purchase Invoice → <b>GRN (confirm = stock IN)</b> → stock. &nbsp; Quotation → Sales Order → <b>Dispatch (confirm = stock OUT)</b> → Sales Invoice → NOA / reminders / payment. Manual movements (opening, adjustment, damage, samples, customer/supplier returns) start as draft and affect stock only on confirm. System movements from GRN/dispatch are immutable from the ledger (manage from the source document). Cancel reverses its own effect (GRN cancel → reversing OUT + PO revoke; dispatch cancel → reversing IN + SO revoke). Maker–checker gates (quote→SO needs approval; proforma→PO needs approval; invoice issue needs confirmed SO; PI needs approved+sent PO; over-receipt needs admin/checker flag) stay enforced server-side.", sBody))
story.append(table(["Document", "Stock effect", "When"],
    [["Purchase Order (PO)", "None", "—"],
     ["Supplier proforma (purchase)", "None", "—"],
     ["Purchase Invoice (PI)", "None", "—"],
     ["GRN", "Stock IN (accepted qty)", "On Confirm only"],
     ["Quotation / Sales Order / Sales Invoice", "None", "—"],
     ["Dispatch note", "Stock OUT (dispatched qty)", "On Confirm only"],
     ["Customer return", "Stock IN", "On Record Return"],
     ["Manual movement", "IN / OUT", "On Confirm only"]],
    widths=[60*mm, 55*mm, 45*mm]))

# 4
story.append(P("4 &nbsp; Manufacturer flow (reused functions + additions)", sH1))
story.append(P("4.1 End-to-end chain", sH2))
story.append(P("Customer order (SO, 10,000 gloves, due date) → material check → <b>shortage → PO → GRN → raw-material stock IN</b> (existing) → <b>create ManufacturingBatch</b> (SO + product + target + line) → <b>live ProductionUpdates</b> (incremental, idempotent; dashboard progress/good/rejects) → <b>FactoryIssue</b> if stoppage (owner, line, batch, open/closed) → <b>complete batch → quality Pending → Hold → allocation attempt BLOCKED</b> → <b>quality Release (authorised role)</b> → <b>allocate Released stock → dispatch readiness</b> → dispatch confirm (existing stock OUT) → invoice (existing) → <b>Tally handoff (simulated, labelled)</b>.", sBody))
story.append(P("4.2 What is reused vs what is new", sH2))
story.append(table(["Step", "Reuse (exact route / model)", "New (generic module)"],
    [
        ["Order in", "goods-sales-orders (SO-XXXXXXXX), debtors", "—"],
        ["Material in", "goods-purchase-orders, goods-receipts confirm, stock-movements IN", "—"],
        ["Make", "—", "manufacturing-batches + production-updates (recalculate batch & order progress)"],
        ["Interruptions", "—", "factory-issues (owner, expected resolution, open/closed)"],
        ["Quality gate", "—", "qualityStatus Pending/Hold/Released + reviewer/time/remarks; allocation guard"],
        ["Finished stock", "stock-movements (reason = Production receipt, linked batchId)", "Derived views: batch qty / rejected / released / available"],
        ["Ship & bill", "goods-dispatches confirm (stock OUT), invoices, e-way, journals", "Dispatch-readiness checklist (balance + document checklist)"],
        ["Report", "Existing reporting + forecast (flows through naturally)", "manufacturer-overview aggregation; tally-export-preview (simulated)"],
    ], widths=[24*mm, 68*mm, 68*mm]))
story.append(P("4.3 Key invariants for manufacturing", sH2))
story.append(bullets([
    "Quality status is <b>separate</b> from production status. A batch can be production-completed yet quality-Held — and still unshippable.",
    "Good output + rejects = recorded production movement per update (validated server-side; rejects never silently dropped).",
    "Held / Pending batches <b>cannot</b> be allocated or dispatched — enforced in <b>both</b> allocate API and dispatch confirm (assertBatchReleasable).",
    "Only an authorised quality role (quality_manager / checker / admin) can Release; every transition writes reviewer, timestamp, remarks + audit log.",
    "Dashboard counts come from saved records (manufacturer-overview) and each tile deep-links to its source list.",
    "Refreshing the page never loses an update (server-persisted immediately); re-submitting the same idempotency key never double-counts.",
]))

# 5
story.append(P("5 &nbsp; Data design (generic names — never Rfb*)", sH1))
story.append(P("5.1 manufacturing-batch", sH2))
story.append(P("id, clientId, batchNumber (BATCH-XXXXXXXX), salesOrderId, salesOrderNumber, productId, sku, productName, targetQty, lineId, shiftId, status (planned | in_progress | completed | closed), qualityStatus (Pending | Hold | Released, default Pending), qualityReview[] {by, at, remarks}, producedGoodQty (derived), rejectedQty (derived), releasedQty, allocatedQty, availableQty (derived = released − allocated), notes, createdBy, timestamps, isDemoData.", sBody))
story.append(P("5.2 production-update (incremental, idempotent)", sH2))
story.append(P("id, clientId, batchId, stage (config-driven: e.g. Dipping / Washing / Drying / Stripping / Packing), qtySinceLastUpdate (&gt; 0), rejectedQty (≥ 0), lineStatus (running | stopped | maintenance), remarks, createdBy, createdAt, <b>idempotencyKey</b> (UUID minted when the form opens; unique index per client — duplicate POST returns the original row, credits nothing). Server re-sums parent batch after each insert; concurrent confirms use conditional writes.", sBody))
story.append(P("5.3 factory-issue", sH2))
story.append(P("id, clientId, type (stoppage | maintenance | staffing | utility | material), lineId, affectedBatchId, title, description, owner (userId), expectedResolutionAt, status (open | closed), closedAt, closedBy, createdBy, timestamps. Dashboard shows owner + affected line/batch + status.", sBody))
story.append(P("5.4 manufacturing-config (per tenant — this is where RFB lives)", sH2))
story.append(P("clientId, lines[] {id, name} (e.g. Line-1, Line-2), shifts[] {id, name} (Day / Night), stages[] (dipping → packing), sizes[] (S / M / L / XL as product size values), qualityRoles[] (who may Release), tallyMode (simulated | live-test), dashboardLabels. Seed script writes the RFB values here — zero code branches.", sBody))
story.append(P("5.5 Finished-stock view (no parallel ledger)", sH2))
story.append(P("Batch quantity / rejected / released / available are <b>derived</b>: production updates feed producedGoodQty + rejectedQty; Release sets releasedQty; allocate sets allocatedQty; production receipts and dispatch issues flow through the existing <b>stock-movement</b> table (linked via batchId + linkedDocumentType). Live sellable stock for a SKU remains SUM(confirmed IN) − SUM(confirmed OUT).", sBody))

# 6
story.append(P("6 &nbsp; API, routes and navigation", sH1))
story.append(P("6.1 New APIs (same auth + tenant middleware as existing)", sH2))
story.append(table(["Method + path", "Purpose", "Guards"],
    [
        ["GET/POST /manufacturing-batches", "Create batch (SO + product + target + line); list", "SO must be confirmed; product active"],
        ["GET/PUT /manufacturing-batches/:id", "Batch detail / edit while planned|in_progress", "Lines with released qty are protected"],
        ["POST /manufacturing-batches/:id/complete", "production status → completed (quality stays Pending)", "All updates persisted; idempotent"],
        ["POST /manufacturing-batches/:id/hold|release", "qualityStatus transitions + reviewer/time/remarks", "Release: quality role only; audit logged"],
        ["GET/POST /production-updates", "Incremental update (idempotencyKey required)", "qty>0; duplicate key returns original"],
        ["GET/POST /factory-issues; POST /:id/close", "Raise / resolve stoppages", "Close records closedBy/At"],
        ["POST /manufacturing-batches/:id/allocate", "Allocate Released stock to SO", "409 BLOCKED unless Released; qty ≤ available"],
        ["GET /manufacturer-overview", "Dashboard aggregation (orders, progress, issues, held, ready)", "Server-computed from saved records"],
        ["GET/PUT /manufacturing-config", "Lines, shifts, stages, roles, Tally mode", "Admin / ops"],
        ["GET /tally-export-preview", "Simulated CSV/JSON handoff", "Always labelled SIMULATED unless live-test verified"],
    ], widths=[58*mm, 62*mm, 40*mm]))
story.append(P("6.2 Frontend routes (same workbench pattern as Procurement / Sales / Warehouse)", sH2))
story.append(bullets([
    "New shell <b>app.manufacturer-workbench.tsx</b> with tabs: <i>Overview | Batches | Production Updates | Factory Issues | Quality | Dispatch Readiness | Tally Export</i>. Batches/Updates/Issues/Quality are new pages; Dispatch Readiness embeds the existing dispatch flow plus the release guard and checklist.",
    "Mode filter added to <b>app.tsx buildNavSections(roles, mode)</b>: trading hides the Manufacturing entry; manufacturer shows it. Route wall extended with manufacturing paths per role (quality pages require quality role).",
    "Public landing <b>index.tsx</b>: two cards (Trading / Manufacturing) setting ?mode for the post-login default. Dashboard <b>app.dashboard.tsx</b> branches: existing Command Centre vs new Manufacturer Command (same URL).",
]))

# 7
story.append(P("7 &nbsp; Dashboard specifications", sH1))
story.append(P("7.1 Trading dashboard — unchanged", sH2))
story.append(P("Current Command Centre (cash, receivables/payables with ageing, sales MTD, purchases MTD, gross profit, inventory value/SKUs/low/out, business-performance chart, sales funnel Enquiry → Paid, procurement delayed POs, operations dispatch queue, cash-flow command, insights, attention list, cross-functional priorities). No edits.", sBody))
story.append(P("7.2 Manufacturer dashboard — new (all tiles link to source)", sH2))
story.append(table(["Tile", "Shows", "Source / link"],
    [
        ["Order card", "SO number, 10,000 gloves, due date, balance = ordered − allocatedReleased", "goods-sales-orders detail"],
        ["Batch progress", "producedGood / target bar, good output, rejects, % complete", "manufacturing-batch detail"],
        ["Factory issues", "Open count; each: line, affected batch, owner, expected resolution, open/closed", "factory-issues list"],
        ["Quality gate", "Pending (amber) / Hold (red, blocked) / Released (green, ready qty); Allocate button demonstrates BLOCKED on Hold", "quality tab + audit"],
        ["Dispatch readiness", "Checklist: Released ≥ balance? SO confirmed? Invoice? E-way? Tally export?", "dispatches + invoices"],
        ["Tally handoff", "SIMULATED badge, sample export download, status log", "tally-export-preview"],
    ], widths=[30*mm, 70*mm, 60*mm]))

# 8
story.append(P("8 &nbsp; RFB demo script — click by click (10,000 gloves, DEMO DATA)", sH1))
story.append(table(["#", "Action", "Expected result"],
    [
        ["1", "Log in → switch to Manufacturer → confirm DEMO DATA badge", "Seed tenant RFB-DEMO isolated; Reset demo visible"],
        ["2", "Open the sample customer order", "SO shows 10,000 gloves + due date + balance 10,000"],
        ["3", "Show material shortage → open/create PO → record receipt (GRN confirm)", "Raw-material stock IN via existing GRN rule; PO status partially/fully_received derived"],
        ["4", "Create production Batch-B1 (SO + glove product + target 10,000 + Line-1)", "Batch planned → in_progress; appears on dashboard at 0%"],
        ["5", "Enter production update #1 (e.g. 4,000 good + 200 reject, Dipping)", "Dashboard ~40%, good 4,000, rejects 200"],
        ["6", "Enter production update #2 (e.g. 5,000 good + 150 reject)", "Dashboard ~90% with no double-count; refresh + resubmit-safe"],
        ["7", "Record factory stoppage (Line-1, Batch-B1, owner, expected resolution)", "Open-issue tile shows owner + line + batch + status open"],
        ["8", "Complete batch (quality Pending) → set Hold → click Allocate", "Allocation BLOCKED with message + audit entry; dispatch confirm also refuses"],
        ["9", "As authorised quality user: Release batch → allocate to order", "Released qty available; balance falls; dispatch readiness turns green"],
        ["10", "Confirm dispatch (existing flow) → show invoice + Tally handoff", "Stock OUT on dispatch confirm only; Tally card labelled SIMULATED sample export"],
    ], widths=[10*mm, 75*mm, 75*mm]))

# 9
story.append(P("9 &nbsp; Acceptance checks (must pass before showing RFB)", sH1))
story.append(bullets([
    "Refreshing the page loses no production or factory update (server-persisted).",
    "Submitting an update twice does not double-count (idempotency key).",
    "Good output + rejects equals the recorded production movement per update.",
    "Held or Pending batches cannot be allocated or dispatched (both APIs refuse with 409).",
    "Only an authorised quality role can Release (others get 403 + audit).",
    "Every factory issue shows owner, affected line/batch and open/closed status.",
    "Dashboard counts match underlying records and open the correct source lists.",
    "Existing GRN / dispatch / stock balances still follow current rules (regression on trading flows).",
    "Demo tenant resets without touching other tenants.",
    "Every simulated Tally / compliance step is visibly labelled.",
]))

# 10
story.append(P("10 &nbsp; Build phases", sH1))
story.append(table(["Step", "Developer action", "Output"],
    [
        ["1. Inspect", "Map existing routes, APIs, models, permissions, stock calculations against the workflow guide", "Reuse / Configure / Build / Defer matrix (this document)"],
        ["2. Isolate", "Tenant feature flag businessMode + manufacturing-config + seed/reset script (seed-rfb-demo.mjs)", "RFB demo cannot alter other customer data"],
        ["3. Reuse", "Use current product / supplier / order / GRN / inventory / dispatch flows; add mode toggle + workbench shell", "No duplicate core workflows"],
        ["4. Extend", "Add generic ManufacturingBatch, ProductionUpdate, FactoryIssue (+ quality transitions) only where missing", "Reusable module capability"],
        ["5. Configure", "RFB products, stages, lines, shifts, sizes, roles, dashboard labels, Tally simulated mode as data", "RFB behaviour without code fork"],
        ["6. Verify", "Run full 10k-glove flow + regression on core trading paths + acceptance checks", "Working demo with evidence core is unchanged"],
    ], widths=[22*mm, 75*mm, 63*mm]))

# 11
story.append(P("11 &nbsp; Keep out of the demo build", sH1))
story.append(P("Do not add detailed formulations/BOM explosion, automatic MRP, machine/IoT integration, advanced laboratory test plans, sterilisation management, full export compliance, advanced costing, or a new live Tally integration before RFB agrees the pilot scope. Record these as later discovery items.", sBody))
story.append(P("Roles & gates summary", sH2))
story.append(table(["Role", "Can"],
    [["Client (maker)", "Create/edit drafts, submit, mark PO sent, draft receipts/dispatches, record production updates & issues"],
     ["Quality (checker / quality_manager)", "Hold / Release batches, approve quotations & proformas & POs, allow over-receipt with flag"],
     ["Treasury / Admin", "Record payments, fund proformas, full access, reset demo tenant"],
     ["Sales rep", "Read-only on PO/SO/dispatch; write quotations; view manufacturer overview"],
    ], widths=[45*mm, 115*mm]))
story.append(Spacer(1, 6*mm))
story.append(HRFlowable(width="100%", thickness=0.7, color=ACCENT))
story.append(Spacer(1, 3*mm))
story.append(P("Owner: Product and Engineering. &nbsp; Scope: RFB demo preparation. &nbsp; Status: proposed implementation guide. &nbsp; Next: approve → Phase 1 (mode toggle + config + seed) → Phase 3 (batches / updates / issues / quality).", sCap))

doc.build(story, onFirstPage=cover_footer, onLaterPages=header_footer)
print(f"WROTE {OUT}")

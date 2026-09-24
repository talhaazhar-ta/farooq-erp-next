# Parity log

Two parts: (1) the legacy-module checklist — one row per module in `projectFarooqAndCoTraders/public_html/ERP/
erp-upgrade/`, status tracked as this project ports it; (2) the change log — one line per old-ERP change made
*after* this project started, so nothing lands in the old app without a note here (old repo's `CLAUDE.md` has
the matching two-line rule to append here on every change).

Status values: **not started** (old app is still the only implementation) / **ported** (built here, not yet
reconciled against real data) / **verified** (reconciliation shows 0 differences on a real nightly backup, or
for non-money modules, a person walked through it in headless Chrome and it matches).

## Legacy module checklist

| Module | What it is | Status | New-project home |
|---|---|---|---|
| 00a-preboot.js | Pre-boot shims/polyfills | not started | — |
| 00-bridge.js | Base app / module loader bridge | not started | apps/web bootstrap |
| 01-db.js | IndexedDB schema + migrations | ported (schema S1; sequences + backup load S2; **money in whole paisa and quantities rounded to 3 decimals — held as integer thousandths — S6**; invoice lines, stock tables and the full invoice header S6) | Drizzle schema (packages/db) + packages/import |
| 01b-server-db.js | Server-side data backend, stale-window poll | not started | apps/api |
| 02-services.js | Core business services (incl. Payments, Ledger) | **Ledger ported (S2)**; **Payments ported (S3)**, screens walked in headless Chrome (S5) — not *verified* (no person has used them, no reconciliation after real use); **`Calc` (line + invoice totals, `paymentStatus`) ported (S6) and reconciled on the real backups** (every invoice recomputes from its lines to its stored total); **`Inventory` quantity part (movements, levels, kinds) ported as data + reconciliation (S6)** — `costOf` / `carriedCost` ported as a read (S7), `avgCostP` maintenance not started (M4); **`Invoices` operations (save draft / post / edit / cancel / duplicate / change shop) ported (S7)** with `Validate.invoice` and `Inventory.costOf` as a read — service + API proven by rule tests and a ledger bridge, no screen yet (S9), not *verified*; Returns operations not started | Ledger: `packages/import` (`LegacyLedger`) + `packages/db/src/ledger.ts` (shared posting builder); Payments: `apps/api/src/payments/`; Invoices: `apps/api/src/invoices/` |
| 03-docx.js | Document/Word export | not started | — |
| 04-documents.js | Documents module | **payment receipt / voucher ported (S4 model, S5 print layout)** — `GET /payments/:id/receipt` → A4 print page, one page for every voucher in the e2e dataset; **sales invoice print model ported (S8)** — `GET /invoices/:id/print`, classic + standard from one model (layout S9); purchase print not started **Invoice print layouts drawn (S9)** — classic and standard. | `apps/api/src/statements/` (`loadReceipt`); `apps/web/src/routes/receipt.tsx`; `apps/api/src/invoices/invoices.print.ts` |
| 05-ui-builder.js | UI builder helpers (incl. the invoice builder and invoice list screen) | **invoice list server side ported (S8)** — the four cards, columns, the CSV (`LIST.exportCsv`) and paging as `GET /invoices` / `export.csv`; builder and screens not started **List screen ported (S9)** (`/invoices`: cards, filters, "read as" lines, hints, paging, CSV button). **Builder ported (S10)** — new / draft / edit / post / edit-posted with live totals, product search (in-stock first), plain-list fallback, region → shop, header warehouse rewriting the lines, shortage warning, Amount Paid, charges, the errors banner, double-submit guard, Discard / Save Draft / Post. **Ported, not verified** (no person has used it). | `apps/api/src/invoices/invoices.list.ts`, `invoices.csv.ts`; `apps/web/src/routes/invoice-builder.tsx`, `components/invoice-builder-parts.tsx`, `lib/invoice-form.ts` |
| 06-wiring.js | Page wiring (partly superseded by 38) | **Payments panels ported (S5)** — Receive payment, Pay supplier, Pay a shop, Reverse, Edit amount; the rest of the wiring not started **Invoice cancel / discard / duplicate / Change shop screens ported (S9).** **Region clears shop, header warehouse rewrites lines and the edit-a-confirmed-invoice question ported (S10).** | `apps/web/src/components/payment-panels.tsx`, `correction-dialogs.tsx`; routing `apps/web/src/router.tsx` |
| 07-transactions.js | Transaction posting (stock documents) | movement **kinds / ref types / buckets** ported as the stock vocabulary (S6, `packages/db/src/stock.ts`) and imported with their effect on stock; the documents themselves (RECEIVE / DISPATCH / TRANSFER / ADJUST) not started (M4) | `packages/db/src/stock.ts`, `stock_movements`; documents M4 |
| 08-classic-invoice.js | Classic invoice print template (live setting `invoiceTemplate: classic`) | **model ported (S8)** — `classicBlock` (`SLV-` number, last six ledger rows up to the invoice, the Gross / Opening / Total / Cash / Balance box, Urdu labels verbatim); print screen S9 **Print screen ported (S9)** (`/invoices/:id/print`, both layouts from the one model, A4 one page, PDF read back; not yet seen on paper). | `apps/api/src/invoices/invoices.print.ts`; print screen M2 (S9) |
| 09-paperwork.js | Paperwork/printing | not started | — |
| 10-mobile.js | Mobile layout, sidebar collapse | not started | apps/web layout |
| 11-search.js | Generic search | `normalize` ported (S4) as `foldSearch` (JS) + `fold_search` (SQL, parity-proven for every code point); the command palette / fuzzy scoring not started | `packages/shared/src/fold.ts`; migration 0004 |
| 12-invoice-editor.js | "Edit before printing" (print-only overrides in `documentEdits`; creation is in 05/06) | not started — **deferred beyond M2** (store stays deferred) | later |
| 13-reports.js | Reports engine | not started | — |
| 14-reports-ui.js | Reports UI | not started | — |
| 15-export-flow.js | Export flow | not started | — |
| 16-khata.js | Khata (ledger book) view | ledger feed ported (S2); **statement API ported (S4)** — OPENING-first order, adjustments; **screen ported (S5)** | `packages/import`; `apps/api/src/statements/ledger.ts`; `apps/web/src/routes/statements.tsx` |
| 17-profit.js | Profit/Profit.totals | **per-invoice profit ported (S8)** with ONE documented definition (goods margin net of the discount given; charges and tax excluded; unknown cost never free) and the legacy `Profit.invoice` figure held in tests; price hints (S9) and reports not started **Per-invoice profit block on the view page (S9)** — DOM absent without `PROFIT_VIEW`. **Builder price hints ported (S10)** — below cost / below the minimum / low margin (5 %, fixed: the screen cannot see the `lowMarginWarnPct` setting) only for `PROFIT_VIEW`; the below-minimum hint is always on (the `warnBelowMinPrice` setting is not visible to the screen). | `packages/shared/src/profit.ts`; `GET /invoices/:id/profit`; hints M2 (S9), reports later |
| 18-master-data.js | Areas/regions/master data (soft-delete pattern) | regions read-only list + customer lookup by region (S4); CRUD not started | `GET /regions`, `GET /customers?regionId` |
| 19-collection-rbac.js | Roles & permissions | not started | packages/shared (S1) |
| 20-integrity.js | Data integrity checks / migration path | not started | packages/import (S2) |
| 21-settings.js | Settings incl. product prices panel, extra cost/bag | company profile imported verbatim + read-only display whitelist (S4, `GET /company`); **product prices (`Prices.of` precedence) imported into `products.*_p` (S6, tested from both the `…P` and the legacy rupee source)**; the panel / editing not started | `packages/import`, `apps/api/src/statements/` |
| 22-users.js | User/company accounts management | not started | apps/api auth (S1) |
| 23-workbench.js | Workbench | not started | — |
| 24-client-changes.js | Label overrides repainted every render | statement row *descriptions* (typed "Description / تفصیل", auto text, invoice-line summaries) not ported in S4 (needed invoice lines); **ported in S8** as additive `detail` / `qtyInfo` / `qtyLabel` on invoice rows — see "Invoice search, print model, profit, statement detail — ported in S8" below **Statement Description / Qty column drawn (S9)** on screen, CSV, print and the phone cards. | statement descriptions / Qty column ported in S8 (server: `detail`, `qtyInfo`, `qtyLabel`; screens S9) |
| 25-options.js | Options | not started | — |
| 26-landed-cost.js | Landed cost | not started | M6 |
| 27-landed-ui.js | Landed cost UI | not started | M6 |
| 28-areawise.js | Area-wise reporting | not started | — |
| 29-statement-of-account.js | Shop/supplier statement | **statement API ported (S4)** — `GET /customers|suppliers/:id/statement` (proved against `LegacyLedger` for every party, real backup 409 + 35); **screen + print ported (S5)**, on-screen rows / totals / closing proved equal to the API in Chrome | `apps/api/src/statements/`; `apps/web/src/routes/statements.tsx` |
| 30-payroll.js | Payroll | not started | M7 |
| 31-auth.js | Sign-in, sessions, heartbeat, lockout | not started | apps/api auth (S1) |
| 32-milling.js | Milling / stock at mills | ledger feed ported (job issue/received/fee rows) and shown on the supplier statement (S4); rest not started | `packages/import`; rest M8 |
| 33-invoice-search.js | Invoice search (day-first dates) | its reusable engine ported (S4): `parse` (typed dates), `norm`/`joinN`/`compact`/`hasTerm`/`dateText`, strict money parsing; **the invoice search itself ported (S8)** — `GET /invoices`, proven equal to a literal JS reference on three datasets **List screen ported (S9).** | `packages/shared` (`search-query.ts`, `fold.ts`); `apps/api/src/invoices/invoices.search.ts`; screen M2 (S9) |
| 34-accounts.js | Accounts | not started | — |
| 35-topbar.js | Top bar (user/db chips, sign-out) | not started | apps/web shell (S1) |
| 36-ui-kit.js | UI kit (Promise-based confirm/prompt/alert) | not started | apps/web (shadcn/ui) |
| 37-stock-value.js | Stock value report | not started | M4 |
| 38-payment-search.js | Payment search, replaces 06's PAGES.payments | **search + CSV ported on the server (S4)** — same ids in the same order as the legacy algorithm on the fixture, a ~300-payment synthetic backup and the real backup; **screen ported (S5)** — search box, scopes, tabs with facet counts, filters, "read as" line, paging, CSV button | `apps/api/src/payments/payments.search.ts`, `payments.csv.ts`; `apps/web/src/routes/payments.tsx` |
| 39-warehouse-server.js | Warehouse PWA server sync | not started | M9 |
| 40-nav.js | Nav / icon set (window.I, window.P) | not started | apps/web shell |
| 41-notifications.js | Notifications / bell panel | not started | — |
| 42-layout.js | Long-list paging (fc-lim) | not started | apps/web (TanStack Table) |
| 43-remember-page.js | Reload-stays-on-screen | not started | apps/web router state |

Ledger rules ported in S2, each with a green test (`packages/import/test/`; hand-computed from `fixtures/build-fixture.ts`):

- Invoice posts unless DRAFT/CANCELLED; **DRAFT purchases and DRAFT returns DO post** (only CANCELLED is skipped) — `import-fixture`, `legacy-ledger`.
- REVERSED payment/adjustment: skipped by the legacy ledger; here original + reversal entry net to zero — `import-fixture`.
- Customer refund (OUT to a shop) is a debit; refund + supplier-payment + return + opening rows carry no `createdAt` (sort first within a day) — `legacy-ledger`.
- Customer statement puts the OPENING row first whatever its date (16-khata.js); supplier opening sorts by its date — `legacy-ledger`.
- Milling `FEE_ONLY` jobs post the fee only, even with a nonzero issued value; CANCELLED jobs post nothing — `import-fixture`, `legacy-ledger`.
- Negative opening balances (a credit) — `import-fixture`.
- Paper-book `legacy*` figures are NOT posted (needs an owner cutover date) — `import-fixture`.

## Search, statements, receipts — ported in S4

`38-payment-search.js`, `33-invoice-search.js` (parse / index helpers), `11-search.js` (`normalize`), `04-documents.js` `receipt`,
`16-khata.js` / `29-statement-of-account.js` (via `LegacyLedger`) — ported to `packages/shared` (pure helpers), migration `0004`
(SQL twins) and `apps/api/src/{payments,statements}/`. Status **ported**, not *verified* (no human has used it; the real backup has only 7
payments and no returns / reversals / adjustments / milling). Every "Proof" row compares two independently built implementations.

| Rule | Test(s) |
|---|---|
| **`normalize` folding** (lower-case, Urdu letter variants, harakat, digits, punctuation → one space) — JS and SQL are the same function | `shared` › `fold.test`; `fold-search-parity` (**every Unicode code point** JS vs SQL, a 30-string corpus, the `search_*` helpers vs the legacy forms) |
| Typed dates are a **filter, not text**: ISO, day-first `12/09/2026` (month-first only when it is the sole valid reading), `12 Sep 2026`, `Sep 12, 2026`, `Sep 2026`, `2026-09`, `09/2026` (but never the tail of `INV-2026-12`), 2-digit years, 1990–2100, Urdu digits; an impossible date stays text | `shared` › `search-query.test` (legacy D1–D19); `payments-search-parity`; `s4-reads` › `interpreted` |
| Every word must be found (AND, any order), substring; a phrase also matches with its spaces removed | `payments-search-parity` (incl. the spaces-removed cases); `shared` › `fold.test` (`hasTerm`) |
| Scopes: number (+ compact) · party (snapshot name/owner/region **and** current name/owner/phone/code/region) · reference (+ compact) · invoice/purchase numbers applied to · amount (all typed forms) · notes & other; "everything" adds the date forms | `payments-search-parity` (every scope, wrong-scope-finds-nothing cases); `fold-search-parity` (amount and date forms) |
| A shop renamed since is found by the printed name **and** the new one; the voucher keeps printing the old name (snapshots) | `receipt` › snapshots; `s4-reads` › rename; `payments-search-parity` (renamed shops) |
| Direction / method / region / date range / amount range / 4 sorts (ties: date → entry time → receipt number → id); paging stitches to the full list | `payments-search-parity` (3 datasets, ~60 queries each, + paging); `s4-reads` |
| Inputs that can never match are **said**: From after To, minimum above maximum (list empty on purpose) | `payments-search-parity`; `s4-reads` › problems |
| Facets: counts + sums by kind under every filter except direction / status; a reversed voucher is in `reversed` only | `payments-search-parity`; `s4-reads` › facets |
| CSV: legacy columns, every match, UTF-8 **with BOM**, RFC 4180, formula-injection guard, Urdu intact, business-date filename | `payments-csv` |
| Statement = journal-derived, equals `LegacyLedger` for **every customer and supplier** — closing balance, row multiset (date, kind, number, description, signed amount), full range and mid-range windows, running balances telescope | `statements-proof` (fixture: 6 + 5 parties; real backup: 409 + 35) |
| Statement order: date → entry time → id; customer OPENING first whatever its date; supplier OPENING first within its day; the legacy "rows without createdAt sort first" artefact **not** copied | `statements-rules` |
| Reversed payments/adjustments (original + reversal) are omitted and counted; an edited voucher is one row at its current amount | `statements-rules` |
| Receipt model: legacy titles/labels verbatim, snapshots, allocations, amount in words **with paisa**, previous/remaining balance = running balance around the voucher's own row (stable on reprint), reversed => stamped, no balances | `receipt` (imported fixture vouchers with hand-computed balances + service vouchers) |
| Strict money entry (>2 decimals refused, never through floats), Indian-grouping words, `formatPaisa` = legacy `Money.fmt` | `shared` › `money.test` |
| Company block = a whitelist of the imported settings document, never the whole bag; nothing credential-looking is ever imported | `receipt` › company; `s4-reads` › `/company`; `import` › `company-and-snapshots` |
| Permissions on every new endpoint: INVENTORY 403, SALES read-only, unauthenticated / forged cookie 401 | `s4-permissions` |

**Different from the legacy (deliberate):** search punctuation is a separator, never a wildcard (S3's LIKE replaced); receipts print the balance
**around this voucher's row** (legacy: a stale stored `balanceBefore` and the *current* balance); amount in words says the paisa (legacy rounded);
money entry refuses >2 decimals (legacy rounded); Greek final sigma is not context-sensitive in the fold (irrelevant to Urdu/English).

**Known gaps (not ported, on purpose):** the display-time statement decoration of `24-client-changes.js` (typed description, "Cash received against
outstanding balance", invoice-line summaries / Qty column — needs invoice items, M2); the printed layout of statements and receipts is ported (S5).

## Payments screens — ported in S5

`apps/web` (React 19 + TanStack) on the S3 / S4 API. Status **ported**, not *verified*: walked in headless Chrome on synthetic data only, no person has used it.
Unit tests are `apps/web/src/**/*.test.ts(x)`; browser tests are `apps/e2e/tests/*.spec.ts`.

| Rule | Proof |
|---|---|
| Money screens never pre-select a party ("— Choose a shop —"); Save is refused without a party **and** a valid amount; typing in the party box un-chooses it | `panels.test`; `receive.spec` › nothing is pre-selected |
| Amount entry is strict (`parseRupees`: > 2 decimals refused, Urdu digits and commas accepted); rupees become paisa only at the edge | `panels.test`; `payment-filters.test`; `receive.spec`; `correct.spec` |
| Oldest-first allocation preview equals the server's rule (never over-allocates, conserves the money, stops when it runs out); manual boxes are capped per invoice and in total; manual with nothing entered is refused (an empty list would silently mean automatic) | `allocation.test` (2,000 + 1,000 seeded cases); `receive.spec` › automatic / manual allocation |
| Double-click Save posts one voucher (in-flight guard + idempotency key) | `panels.test`; `receive.spec` › double-clicking |
| A refusal is shown verbatim, every `errors[]` line; the form stays open | `api.test`; `receive.spec` › the server has the last word |
| A shop refund says the balance it leaves and never blocks on it | `panels.test`; `receive.spec` › Pay a shop |
| Reverse states its effect first and requires a reason; a second reverse is impossible; edit-amount refusals are shown disabled with the server's reason | `correct.spec` |
| Dates: default is the Karachi business date whatever the browser's zone; presets computed from it (week = Monday..today, last month, 30 / 90 / 365 days) | `periods.test`; `receive.spec` › Karachi business date |
| Screen state lives in the address (filters, page, sort, panel, statement party / dates); a hand-edited address never breaks the screen | `payment-filters.test`; `payments-list.spec` › paging |
| Role behaviour: OWNER / MANAGER / ACCOUNTANT everything; SALES receives but no pay-out / reverse / edit; INVENTORY has no Payments / Statements and gets the "Not available for the Warehouse role" panel | `access.test`; `auth-nav.spec`; `correct.spec` › SALES |
| Receipt prints on one A4 page with paper colours in any theme, no app chrome; reversed voucher stamped, no balances; statement header repeats per page | `receipt-print.spec` (the PDF read back with pdf.js) |
| Statement balances in words, never a bare negative ("Cr" / "Dr") | `api.test`; `statements.spec` |
| No page-level horizontal scroll and no console errors on every screen at 1280 px, 390 px and in the dark theme | `visual.spec` |

**Different from the legacy (deliberate):** every tab also asks the server for `status`, so a tab's number and its rows are the same set (the legacy kept reversed rows out of the three lists too);
"Leave on account" is not offered as a separate mode (the API treats an empty allocation list as automatic); the panel has no "Description / تفصیل" box (the API has no such field);
Reverse / Edit amount live on the voucher page, not on list rows (only the detail knows what the server will allow); edit-amount is offered only for money paid out (legacy rule), so a received voucher shows it disabled with the server's reason.

## Payments rules ported in S3

`Payments` (`02-services.js` ~1257-1442), `Invoices.paidFor / outstanding / refreshPaymentState` (~835-860), `Calc.paymentStatus`
(~280) and `FDB.nextNumber` (`01-db.js` ~294) — ported to `apps/api/src/payments/`. Status **ported**, not *verified*.
Tests are in `apps/api/test/` (hand-computed expectations; wording verbatim from the legacy). "Mutation-checked" = the rule
was deliberately broken and the named tests went red (see STATUS).

| Rule | Test(s) |
|---|---|
| `receive` amount must be an integer > 0 (`Enter an amount greater than zero.`), shop must exist (`Choose a shop.`) | `payments-http` › request validation; `payments-receive` |
| Auto-allocation: oldest invoice first, non-DRAFT/CANCELLED, outstanding > 0, other shops' invoices skipped; excess stays an unallocated advance | `payments-receive` › auto-allocation is oldest invoice first…, skips invoices with nothing outstanding |
| Tie-break the legacy left unstable: business date → created_at → invoice number → id | `payments-receive` › breaks a tie…; `payments-units` › byOldestFirst |
| `Invoices.outstanding` = total − allocations − credit of non-CANCELLED linked returns (DRAFT return counts) | `payments-receive` › outstanding subtracts linked returns; outstanding-invoices read |
| `refreshPaymentState`: CONFIRMED / PARTIALLY_PAID / PAID from allocations only (returns credit not subtracted); CANCELLED, DRAFT, RETURNED, PARTIALLY_RETURNED left alone | `payments-receive` › invoice status; `payments-units` › invoiceStatusFor; `payments-ledger-bridge` › invoice statuses |
| `pay`: supplier must exist (`Choose a supplier.`), `PV-` number, optional purchase allocations, `purchases.status` never touched | `payments-pay-refund` › pay |
| `refund`: OUT to a CUSTOMER, `is_refund`, `PV-` number, no allocations | `payments-pay-refund` › refund |
| Receipt numbers `REC-`/`PV-<current year>-<6 digits>`, taken inside the voucher's transaction (a rolled-back save does not consume one) | `payments-concurrency` › numbering |
| `reverse`: status REVERSED + reason, invoices' paid/status recomputed, audit row | `payments-reverse-edit` › reverse |
| `editAmountCheck` refusals in the legacy order and wording: not found / REVERSED / not OUT-to-shop-or-supplier / has allocations / cash side of a customer return's REFUND | `payments-reverse-edit` › editAmount eligibility refusals; `payments-ledger-bridge` › imported vouchers' refusals |
| `editAmount`: amount > 0 and different from the current one; corrects in place | `payments-reverse-edit` › corrects in place… |
| Journal posting: IN = DR CASH / CR RECEIVABLES; refund = DR RECEIVABLES / CR CASH; supplier payment = DR PAYABLES / CR CASH — one builder shared by importer and service | `payments-*` (entry line assertions); `payments-ledger-bridge`; importer's 88 tests unchanged |
| **The bridge:** import the fixture, run receive/pay/refund/reverse/edits through the service, mirror them by hand on the legacy JSON, `LegacyLedger` == journal for every party, real reconciliation on the result | `payments-ledger-bridge` |

**Stricter than / different from the legacy (deliberate — each is an owner-visible behaviour change):**

1. **Explicit allocations are capped on the server** (legacy trusted the UI): each invoice must exist, belong to this shop, not be
   DRAFT/CANCELLED, appear once and receive ≤ its outstanding; Σ allocations ≤ the amount. Same guards for a supplier payment's purchases.
2. **A second `reverse` of the same voucher is refused** (legacy reversed it again).
3. **`reverse` keeps the allocation rows** (legacy deleted them); paid/outstanding count POSTED payments only. The reconciliation's
   `paymentAllocations` count therefore differs by design after a reversal (asserted in `payments-ledger-bridge`).
4. **New permission `PAYMENT_PAYOUT`** gates `pay` and `refund`: OWNER, MANAGER, ACCOUNTANT — **not SALES** (legacy: SALES' `PAYMENT_CREATE`
   could record cash paid out — old repo open item 7). **Owner decision:** flip it by adding `"PAYMENT_PAYOUT"` to SALES in `packages/shared/src/permissions.ts`.
5. **`idempotency_key`**: a repeated POST with the same key returns the first voucher (200) instead of writing a second (legacy had no guard).
6. Receipt numbers are taken inside the voucher's transaction — same as the legacy for payments; S1's note that "gaps mean an attempt happened" was wrong for payments and is corrected in STATUS.
7. `editAmount` refuses a REFUND-tied voucher if the FK `returns.refund_payment_id` **or** the legacy note/reference heuristic matches (never looser than the legacy).
8. Every request object rejects unknown fields; amounts are integer paisa capped at 10^13; dates must be real calendar days.

Money-critical rules to port with a dedicated test each (from the old project's "learned the hard way" list —
see `projectFarooqAndCoTraders/CLAUDE.md`), tracked here as they're picked up in S3/S4 and beyond:

- Stock cost: `avgCostP` only moves on `PURCHASE_IN`/`MILL_RECEIPT_IN`; `costOf` falls back to carried cost,
  preferring a warehouse's own carried cost over another warehouse's average — not started (M4).
- Money screens never pre-select a party; Save refuses without one — **ported (S5)**: `panels.test` (unit) and `receive.spec` (Chrome).
- Edit-amount voucher correction: refused for reversed / allocated / customer-return-REFUND-tied vouchers —
  **ported (S3)**, see "Payments rules ported in S3" below.
- Purchase edit: money only ever added, line ids stable, stock guard on net change; no cancel/delete — not
  started (M3).
- Change shop moves the shop and its wholly-applied receipts only; refused with a return or a split receipt; needs TRANSACTION_CORRECT — **ported in S7** (see "Invoices service — ported in S7").
- Only one draft invoice can exist (unique invoiceNumber, drafts save '') — **legacy bug, fixed by the schema in S6**: drafts carry NULL and the unique index is partial (`WHERE invoice_number IS NOT NULL`); tests `invoice-lines-stock` › "many DRAFTS can exist…" and "the importer accepts a backup with several numberless drafts…".

### M2 (Invoices) — owner decisions and legacy quirks to fix (planned 2026-09-24; each needs a test in S6/S7)

Owner decisions: (1) cancel with a POSTED receipt allocated → refused until reversed (legacy left the shop in silent credit); (2) create/draft/post =
`SALES_CREATE`, edit posted / cancel / change shop = `TRANSACTION_CORRECT`, payment at sale also `PAYMENT_CREATE` (legacy checked none but change shop);
(3) edit posted = net correction, refused once a return or dispatch exists, never back to draft.

Legacy quirks being fixed, not ported: one-draft limit; cancel restocks already-returned bags; edit regenerates line ids (breaks return links, allows
returning the same bags twice); "Save draft" un-posts a posted invoice; edit's stock check ignores the invoice's own bags; per-line (not per-product)
stock check; negative discounts/charges accepted; lowering "Paid" leaves allocations and the invoice disagreeing; editing a migrated invoice returns
stock that was never taken; `SALES_CREATE` never enforced. Ported as-is: `Calc` totals, `previousBalance` frozen at first posting, number taken inside
the posting transaction with the current year, receipt for the paid delta only, DR RECEIVABLES / CR SALES (no COGS until M4).
Found in the live ERP too — reported to the owner 2026-09-24; not changed there.
- Dates: local business date, never `toISOString()` — enforced as a project-wide rule, see `CLAUDE.md` rule 6.

## Invoice lines, full header, stock quantities — ported in S6

`Calc` (`02-services.js` ~242-285), `Invoices.buildRecord / snapshotItem / customerFields` (~409-483), the stock part of `Invoices.save` / `cancel`
(~549-568, ~620-646), `Inventory.apply` and the movement kinds, `Prices.of` (`21-settings.js` ~66-108) and the old app's invoice migration (~2140-2215) — ported to
`packages/shared/src/invoice-totals.ts`, migration `0005`, `packages/db/src/{ledger,stock}.ts` and `packages/import`. Status **ported and reconciled** on the two newest real
nightlies (0 differences) — not *verified* as a service or a screen (S7-S9). Tests: `packages/shared/src/invoice-totals.test.ts`,
`packages/import/test/{invoice-lines-stock,invoice-stock-fail-loudly,invoice-stock-safety-net,real-backups}.test.ts`.

| Rule | Test(s) |
|---|---|
| `Calc.line` / `Calc.invoice` / `Calc.paymentStatus` exactly: gross = round(unit × qty) per line, line discount capped at the gross, invoice discount capped at (subtotal − item discounts), charges after the discounts, tax on the taxable amount, UNPAID when the total is ≤ 0 — quantities as integer thousandths | `invoice-totals.test` (legacy T1 / T2 / T4 cases by hand + 3,000 random invoices against an independent re-typing + invariants) |
| Every non-draft invoice's total, sub-totals, discount amount, tax, quantity, line count and each line total recompute from its lines — **17 / 17 real invoices** (18 lines, 910 bags) | `invoice-lines-stock` › header + lines; `real-backups`; `invoice-stock-safety-net` › totals (11 bite tests) |
| `stock_levels` = legacy `inventory` = Σ `stock_movements` per product × warehouse × bucket (stock / damaged) — **15 rows, 48 movements** real | `invoice-lines-stock` › stock levels; `real-backups`; safety-net › stock (6 bite tests) |
| An invoice's SALE_OUT + edit reversals + cancel reversals net to −Σ its lines (a full reverse-and-re-deduct edit nets out; a cancelled or drafted invoice nets 0); migrated invoices are skipped, not failed | `invoice-lines-stock` › reconciliation; safety-net › invoice <-> stock (6 bite tests) |
| Migrated invoices (`migrated: true`, stockApplied without SALE_OUT) import as-is, are flagged (`invoices.migrated`) and listed — S7 must never "reverse" their stock | `invoice-lines-stock` › the migrated invoice (none in the real data) |
| Prices-panel precedence (`Prices.of`): `…P` wins when set, else the legacy rupee field when truthy, else never set; `minSellP` 0 falls to `min`; rupees through the strict parser | `invoice-lines-stock` › product catalogue + the Prices panel |
| Fail loudly: unknown kind / refType / bucket, dangling item / movement ids, a 4-decimal quantity, a fractional paisa, a discount above the gross, duplicate ids / numbers / inventory pairs, new unclassified fields | `invoice-stock-fail-loudly` (each case leaves the database untouched) |
| `stock_movements` is append-only for the app role; CHECKs refuse a zero movement, an unknown bucket, a zero-quantity line and a discount above the gross | `invoice-lines-stock` › what the database itself enforces |

**Different from the legacy (deliberate):** a number identifies one invoice (the legacy allowed duplicates and one draft only); a quantity with more than 3 decimals is refused at import (the legacy rounded);
a price never set is `null`, not 0; `weight_kg`, the percentages and `reorder` are `double precision` (not money). **No COGS / inventory journal until M4** — a sale is still DR RECEIVABLES / CR SALES only.
**Not ported here:** the stock-document store (M4), `costOf` / `avgCostP` maintenance (M4), purchase lines (M3), return lines (M5), the statement Qty column (S8).

## Invoices service — ported in S7

`Invoices.save / confirm / cancel / reassignCheck / changeCustomer / toDraft / duplicate` (`02-services.js` ~488-860), `Validate.invoice` (~291-325), `Inventory.costOf` /
`carriedCost` (~131-169), `06-wiring.js` edit / duplicate / cancel prompts (~1214-1274) and the spec `test-invoice-change-shop.mjs` — ported to `apps/api/src/invoices/`
(`invoices.service.ts`, `validate.ts`, `rules.ts`, `stock.ts`, `invoices.queries.ts`, `invoices.controller.ts`), `packages/shared/src/schemas/invoices.ts`, `packages/db/src/ledger.ts`
(`INVOICE_CANCEL`) and migration `0006` (request keys). Status **ported**; proven against the fixture by the ledger bridge (0 balance / statement / invoice-total / stock / invoice-stock
differences). Not *verified*: no screen (S9), no person has used it. Owner decisions 1-3 enforced (see the M2 section above).

| Rule | Test(s) |
|---|---|
| `Validate.invoice`: every legacy message verbatim, collected in the legacy order (shop, warehouse, at least one line, product exists, quantity > 0, negative rate, rate required unless draft, discount ≤ line amount, stock "Only X bags…", paid < 0, paid > total) | `invoices-validate` (22 tests, one per message) |
| Post = ONE transaction: number `INV-<year>-<6>` from the live counter (gap-free: a refused save consumes none), lines with snapshots, `SALE_OUT` per line + level, DR RECEIVABLES / CR SALES entry, receipt for the paid amount, audit `Invoice created`; hand-computed 2,742,500 | `invoices-post` › hand-computed…; › numbers continue…; › the number's year… |
| Status from paid: CONFIRMED / PARTIALLY_PAID / PAID; a 0 total stays UNPAID | `invoices-post` › status follows the legacy paymentStatus |
| `previousBalance` = the shop's live journal balance AT POSTING (excluding the invoice), frozen on edit; negative when the shop is in credit; a draft posted later takes it at that moment | `invoices-post` › previous_balance_p…; › a credit balance…; › posting a draft…; `invoices-edit` › previous_balance_p is frozen |
| Snapshots of shop / region / warehouse / product stamped and re-taken on every save (`customerFields`, `snapshotItem`); a later rename does not change an old invoice | `invoices-post` › the shop's, region's and warehouse's details…; `invoices-edit` › every save re-takes the snapshots |
| Drafts: any number (**legacy bug: one draft — fixed**), no number / stock / journal / payment, relaxed validation (short stock, zero rate), audit `Draft invoice saved` / `Invoice edited`; a draft posts through the same path | `invoices-post` › drafts — … (4 tests) |
| **Stricter:** stock checked per product × godown TOTALLED across lines (legacy per line); negative discounts / charges refused; a quantity with more than 3 decimals refused | `invoices-validate` › STRICTER…; `invoices-post` › stock is checked per product × godown TOTALLED |
| Stock check honours `allowNegativeStock` (imported company settings) and skips drafts and migrated invoices | `invoices-post` › the company setting…; `invoices-validate` › a draft, the setting… |
| Payment at sale = the SAME code as `PaymentsService.receive` (extracted `writeReceipt`); receipt dated the invoice date, note "Received with invoice N", one allocation; capped by S3's rules; needs `PAYMENT_CREATE` (403, whole save refused) | `invoices-post` › payment at the time of sale…; `invoices-edit` › the extra receipt needs PAYMENT_CREATE; › the same for taking money on a new invoice; S3's payment tests unchanged |
| Edit posted = net correction: the movement is the DIFFERENCE per product × godown (`SALE_OUT` / `SALE_REVERSAL_IN`, `INVOICE_EDIT`, invoice date), the one journal entry rewritten (amount and date), the shop's balance moves by the difference (legacy: reverse everything + re-deduct — same net) | `invoices-edit` › edit posted — stock and balance move by the difference (UP, DOWN, per product × godown, date) |
| **Fixed:** an edit's stock check counts the invoice's own bags back in (legacy bug 5) | `invoices-edit` › the invoice's own previously deducted bags… |
| Edit posted: raising `paid` takes a receipt for the difference only; **lowering it below what is allocated is refused** naming the receipt (legacy let them disagree); the total cannot drop below what was received | `invoices-edit` › the money taken with the sale (5 tests) |
| Edit refused: cancelled ("A cancelled invoice cannot be edited. Duplicate it instead."), a return exists, a dispatch exists, a different shop (legacy wording pointing to Change shop), back to draft, stale revision, missing revision, a foreign line id | `invoices-edit` › what is refused… (11 tests) |
| Edit keeps line ids stable; dropped lines deleted, new lines added | `invoices-edit` › lines that stay keep their ids |
| **Migrated invoices never get stock movements** on edit or cancel (legacy returned bags that were never taken) | `invoices-edit` › a MIGRATED invoice…; `invoices-cancel` › a MIGRATED invoice posts no stock movement on cancel |
| Cancel: stock back per product × godown Σ qty, `SALE_REVERSAL_IN` / `INVOICE_CANCEL` dated TODAY; journal: a reversing `INVOICE_CANCEL` entry dated the invoice's own date; number kept; reason required; second cancel refused | `invoices-cancel` › hand-computed…; › stock comes back per PRODUCT × GODOWN; › the reason is required |
| **Owner decision 1:** cancel refused while POSTED receipts are allocated (lists them); allowed after the receipt is reversed; refused with a non-cancelled return (**legacy double-restock bug fixed**) | `invoices-cancel` › cancel — refused while money received… (2 tests); › a non-cancelled return blocks the cancel |
| Statements omit a cancelled invoice AND its cancelling entry (`omittedCancelled`, additive); the reconciliation's independent statement builder agrees | `invoices-cancel` › the statement leaves out BOTH entries…; `invoices-ledger-bridge` › the REAL reconciliation… |
| Duplicate = new draft, today's date, paid 0, due date / order / dispatch / reference blank (a fixed line tax is carried — the legacy dropped it) | `invoices-reads-duplicate` › duplicate — a fresh draft (3 tests) |
| Change shop: `reassignCheck` messages verbatim (cancelled, draft, no / same shop, return, split receipt); effects: snapshots, journal party lines, wholly-applied receipts (+ their snapshots), `previousBalance` = the new shop's balance the day before, stock / number untouched; a REVERSED receipt stays; a draft changes shop through an ordinary save | `invoices-change-shop` (16 tests; cases A1-A12, B0-B6, C1-C12, D10, G3, R3, X1-X4 of the legacy spec) |
| `costOf` fallback order: row average → own godown's carried cost (weighted, carried kinds only, stock bucket, cost > 0) → another godown's average → list buy price → 0; the line's `costSnapshot` is that figure; `avgCostP` never written | `invoices-cost` (10 tests) |
| Permissions: create / draft / post / duplicate `SALES_CREATE`; edit posted / cancel / change shop `TRANSACTION_CORRECT`; INVENTORY none; ACCOUNTANT can correct but not create; cost fields only with `PROFIT_VIEW`; 401 without a session or CSRF token | `invoices-permissions` (9 tests); `invoices-reads-duplicate` › GET /invoices/:id, `actions` |
| Concurrency: two saves racing for the last bags → one wins; opposite line orders never deadlock; numbers unique and consecutive; one idempotency key = one invoice; two editors of one revision → one wins | `invoices-concurrency` (7 tests) |
| Idempotency: a repeated POST / PUT / duplicate with the same key returns the first result and writes nothing more | `invoices-post` › idempotency; `invoices-edit` › a repeated PUT…; `invoices-concurrency` |
| **Ledger bridge:** import the fixture, run 11 scripted operations, mirror them on the legacy JSON, `LegacyLedger` = journal for every shop, levels = Σ movements = hand-computed bags, reconciliation 0 differences | `invoices-ledger-bridge` (8 tests) |

**Different from the legacy (deliberate, S7):** the owner decisions above; a draft cannot carry an amount paid (nothing is stored for it — refused with a plain message instead of silently dropped);
the "discount is larger than the line amount" message is not repeated for a line whose quantity is already invalid; `SALES` cannot cancel even its own draft (`TRANSACTION_CORRECT` — owner decision 2);
an edit posts the difference where the legacy posted a full reverse and a full re-deduct (same level, fewer movements — the reconciliation's stock and invoice ↔ stock checks are satisfied either way).
**Not ported here:** search / CSV / print / profit (S8), screens (S9), returns (M5), dispatch and stock documents (M4), average-cost maintenance and COGS (M4), sale orders (M9).

## Invoice search, print model, profit, statement detail — ported in S8

`33-invoice-search.js` (whole), `05-ui-builder.js` §37-39 (cards, columns, CSV), `04-documents.js` `DocModel.invoice`, `08-classic-invoice.js` `classicBlock`, `17-profit.js` `Profit.line / invoice`, `24-client-changes.js` (`Desc.fromLines`, `qtyOf`, `qtyLabel`, `decorate`) —
ported to `apps/api/src/invoices/{invoices.search,invoices.list,invoices.csv,invoices.print}.ts`, `packages/shared/src/{profit,line-summary}.ts`, `schemas/{invoice-list,invoice-print}.ts` and migration `0007`. Status **ported**; proven equal to the legacy algorithm by `invoices-search-parity` (a literal JS port
of the legacy search, run over the fixture, a seeded ~300-invoice synthetic backup with lines and the newest real nightly — same ids, same order, same totals / cards / status counts / hints; each dataset reconciles with 0 differences). Not *verified*: no screen (S9), no person has used it, no sheet has been printed.

| Rule | Test(s) |
|---|---|
| Every word must be found (AND, any order), substring, Urdu / English folding; a phrase also matches with its spaces removed; the shop is matched by the name PRINTED on the invoice and by its CURRENT text (a rename is found at once) | `invoices-search-parity` (all datasets); `invoices-list` › the shop's CURRENT name… |
| Seven scopes (Everything / number / customer / product / amount / receipt-payment ref. / notes & other) look at the legacy fields: number = invoice number + compact + order / dispatch / the invoice's own reference; customer = shop, owner, mobile (+ compact), region as printed; product = English name, name, brand per line; amount = every typed form; notes = notes, description, salesperson, method, warehouse, the status words | `invoices-search-parity` › every query…; `invoices-list` › search words and scopes |
| **A receipt NUMBER is found only with the "Receipt / payment ref." scope, never in Everything** (it has an invoice number's shape); Everything sees a receipt's cheque / transaction REFERENCE only; a REVERSED receipt is not searched | `invoices-list` › the receipt NUMBER is found only…; › a REVERSED receipt is not searched; `invoices-search-parity` (receipt cases on every dataset) |
| A date typed into the box is a date filter (day-first, month-first only when the only valid reading), replaces from / to, is echoed in `interpreted`; From after To and min above max are said out loud and the list is empty on purpose | `invoices-list` › a date typed into the box…; › inputs that can never match…; parity date cases |
| Filters: status (eight legacy strings), region printed on the invoice, warehouse, from / to, total from / to; sorts newest / oldest / high / low / **due** (outstanding descending, **drafts and cancelled last**, ties newest first) | `invoices-list` › sorts, › filters; parity |
| The four cards over the WHOLE filtered list, **excluding DRAFT and CANCELLED**; the drafts card counts every draft on file; counts per status ignore the status filter | `invoices-list` › the four cards…; › counts per status…; parity (cards and facets compared on every query) |
| Row hints ("why it matched"): matching product lines with bags (max 3, "+N more") and receipts ("Paid by REC… (ref)"), only for words the number and the shop do not already explain; Everything sees references only | `invoices-search-parity` › every row's hint…; `invoices-list` › 'why it matched'; › a word the shop already explains… |
| Row figures: paid = POSTED receipts' allocations, balance = total − paid − non-cancelled return credit, discount = item + invoice discount, charges = freight + loading + other + tax | `invoices-list` › each row carries…; parity › the response says what is on file… |
| CSV: legacy columns and file name, every match, BOM, CRLF, all cells quoted, injection guard, a draft's number cell says DRAFT | `invoices-csv` |
| Print model: draft → "DRAFT" no number; cancelled → flag; totals rows only when not zero (one test per rule); grand total / paid / balance on this invoice; amount in words; receipts applied; frozen previous balance and live current balance; classic: `SLV-` + serial to six digits (prefix a setting), last six ledger rows up to and including this invoice, the box; labels verbatim | `invoices-print` (16 tests); `invoices-labels-verbatim` |
| Profit: goods margin net of the discount actually given; tax and charges excluded; unknown cost flagged and never free; legacy figure held beside it; `PROFIT_VIEW` only — 403 and **no key in any other response** | `shared/profit.test`; `invoices-profit` |
| Statement rows: `detail` = typed description, else one-line / "N items — X total qty", else "Sale invoice <number>"; `qtyInfo` with "(mixed units)"; payment rows none; `description` unchanged; Receive panel `lineSummary` | `shared/line-summary.test`; `statements-invoice-detail` |
| Journal entries of one transaction never tie (`created_at` = `clock_timestamp()`), so an invoice precedes its own sale receipt on a statement and in the classic block | `statements-invoice-detail` › the invoice row comes before its own sale receipt; `invoices-print` |
| Draft discard: `SALES_CREATE` **or** `TRANSACTION_CORRECT` may cancel a DRAFT; a posted invoice needs `TRANSACTION_CORRECT` (owner decision 2026-09-24) | `invoices-cancel` › who may; `invoices-permissions`; `invoices-reads-duplicate` |

**Different from the legacy (deliberate, S8):** profit is one definition instead of two (see STATUS "Profit definition"); the payment-status word is derived from the receipts at query time; statement `detail` is a new field (the ledger `description` is unchanged); `paid` and the receipts listed are POSTED only
(the legacy deleted a reversed receipt's allocations); same-day ties in a sort fall to the number then the id; CSV money is plain rupees with paisa only when present; the `created_at` fix above.
**Not ported here:** screens, print CSS, the standard-vs-classic switch UI, Word export, WhatsApp / SMS text (S9 / out of scope); profit reports, price hints and the below-cost warnings (S9 / later); saved searches and fuzzy matching (the legacy did not have them either).

## Invoice list, view, print, corrections — screens ported in S9

`05-ui-builder.js` list (§37-39, 731-936), `06-wiring.js` (cancel / duplicate prompts 1240-1274, `PANELS.changeshop` 463-529), `04-documents.js` standard layout, `08-classic-invoice.js` classic layout, `17-profit.js` (per-invoice), `24-client-changes.js` (statement Description / Qty) —
ported to `apps/web/src/{routes/invoices,invoice-detail,invoice-print}.tsx`, `components/{invoice-dialogs,invoice-paper}.tsx`, `invoice-paper.css`, `lib/{invoice-filters,invoice-view}.ts` and the statements screen. Status: **ported** (screens built, driven in headless Chrome by 69 new Playwright tests); **none is "verified"** — that needs a person's walkthrough, a printed sheet and real use.

| Rule | Test(s) |
|---|---|
| The list is the server's answer, drawn as it comes: cards, counts per status, "n of N match", hints, the "read as" sentence and problems; nothing re-derived | `invoices-list.spec` (15), `web/routes/invoices.test`, `web/lib/invoice-filters.test` |
| Screen state (filters, sort, page) lives in the address; defaults leave it; a hostile address is sanitised; a preset is the screen's arithmetic on the business date sent as from / to; amounts typed in rupees go as paisa | `invoice-filters.test`, `invoices-list.spec` › paging / preset |
| Actions are drawn from the server's `actions.*` with its own reason on a disabled button; Cancel is offered to `TRANSACTION_CORRECT`, Discard (draft) to `SALES_CREATE` too | `invoices-view.spec` (7 statuses), `invoices-corrections.spec` › SALES discards, `invoices.test` |
| Cancel: effect stated first, reason required, receipts listed with links when money blocks it; after reversing the receipt the cancel works, the statement omits the invoice, the bags are back | `invoice-dialogs.test`, `invoices-corrections.spec` (first test) |
| Change shop: never pre-selected, Save off until a different shop, before → after = the ledger's balances, receipts move with the invoice, refusals verbatim | `invoice-dialogs.test`, `invoice-view.test`, `invoices-corrections.spec` (last two) |
| Print: one model, both layouts, A4 portrait one page, fixed paper colours in any theme, Urdu labels from the constants, DRAFT / CANCELLED ribbons, empty meta rows skipped, header repeats on a long invoice, no app chrome | `invoices-print.spec` (11) |
| Profit block only when the key exists (SALES has no trace in the DOM, table or cards); "cost unknown", never 0 | `invoices.test`, `invoices-view.spec` › profit |
| Statement: Description = `detail ?? description`, Qty column on screen / CSV / print / phone cards; Receive panel shows `lineSummary` | `statements.spec` (S5 tests changed deliberately, see STATUS), `invoices-view.spec` |

**Not ported here:** returns, dispatch, purchases, stock documents, sale orders, Word export, WhatsApp / SMS.

## Invoice builder — ported in S10

`05-ui-builder.js` builder (49-54, 123-136, 149-214, 241-275, 411-590, 692), `06-wiring.js` (region clears shop, header warehouse rewrites the lines 1005-1010; "Edit a confirmed invoice?" 1214-1229), `17-profit.js` (`marginNote`, per-line hints), `24-client-changes.js` ("Amount Paid" wording) —
ported to `apps/web/src/{routes/invoice-builder.tsx,components/invoice-builder-parts.tsx,components/unsaved-guard.tsx,lib/invoice-form.ts}` and, on the server, one additive `ids` parameter on `GET /products` and the CORS methods fix (`apps/api/src/cors.ts`). **Ported = a test encodes the rule and is green; "verified" needs a person using it, and that has not happened.**

| Rule | Test(s) |
|---|---|
| The shop is never pre-selected; Region → Shop; changing the region clears the shop; a card shows owner / mobile / region / current balance; on a posted invoice both are locked with the "use Change shop" hint | `invoice-form.test` (reducer), `invoice-builder.test`, `invoices-builder.spec` (region → shop, edit up and down) |
| The header warehouse rewrites every line's warehouse; a line's own warehouse changes only that line | `invoice-form.test`, `invoice-builder.test` |
| Product search: words in name / Urdu name / brand / category / SKU / bag size, in-stock first for the warehouse, the plain-list fallback; adding a line starts the rate at the set price, else the last rate, and focuses Qty | `invoices-builder.spec` (search, price hints / last rate), `invoice-form.test` (`defaultRateText`), `invoice-builder.test` |
| Quantities: at most 3 decimals, Urdu digits, read as text into thousandths; money typed as rupees, at most 2 decimals; unreadable text is named by line and never sent | `invoice-form.test` (parse tables, request errors), `invoices-builder.spec` (fractional / Urdu digits) |
| Live totals are the shared `invoiceTotals`: equal an independent copy of the legacy arithmetic on 2,000 seeded invoices, and equal the server's total to the paisa on a discounted, charged and a taxed invoice | `invoice-form.test`, `invoices-builder.spec` (live totals) |
| Draft → form → request is ONE pair of functions; nothing is lost (200 random invoices round-trip: ids, quantities, rates, discounts, fixed taxes, charges) | `invoice-form.test` |
| Stock hints: per product × warehouse TOTALLED across lines, own deducted bags counted back on an edit, a warning never a block; the server's stock message shown verbatim, the form kept | `invoice-form.test`, `invoice-builder.test`, `invoices-builder.spec` (stock refusals, zero stock) |
| Price hints (below cost / below minimum / low margin / no cost) only for `PROFIT_VIEW`; no cost figure in the page or the `/products` answers for SALES | `invoice-form.test`, `invoices-builder.spec` (price hints) |
| Amount Paid: disabled without `PAYMENT_CREATE`; a draft cannot hold a payment (the server's refusal shown); editing a posted invoice starts at what is received and the hint says it cannot go lower | `invoice-builder.test`, `invoices-builder.spec` (golden path) |
| Save: double click = one request; a refused save keeps the same idempotency key, a successful one takes a new one; a network failure keeps the form and the retry makes one invoice | `invoice-builder.test`, `invoices-builder.spec` (double click / network failure) |
| Editing a posted invoice: the question first, the revision as loaded is sent, a stale revision shows the server's words and offers Reload, no Save-draft; stock and balance move by the difference; refused after a return / dispatch / cancel with the server's reason | `invoice-builder.test`, `invoices-builder.spec` (edit up and down, refused, stale) |
| Permissions: New invoice / Post for `SALES_CREATE`; Edit drawn from `actions.edit` (disabled with the server's reason, never hidden); the accountant corrects but does not start invoices; the warehouse role gets nothing | `access.test`, `invoices.test`, `invoices-builder.spec` (roles), `invoices-access.spec` |
| Unsaved changes: the form compared with the last saved snapshot; in-app navigation and closing the tab are guarded; a saved draft's Discard does not ask afterwards | `invoice-form.test`, `invoice-builder.test`, `invoices-builder.spec` (guard) |
| Post a draft from its page: effect stated first, one PUT with paid 0 and the revision as loaded, the server's refusal shown in the dialog | `invoice-dialogs.test`, `invoices-builder.spec` |
| CORS answers PUT (found by the browser tests: every invoice edit failed before reaching the server) | `api/cors.test` |

**Different from the legacy (deliberate, S10):** Enter in a line box moves to the next box (the legacy had no Enter handling); the product list closes after a product is added (the legacy kept it open); a draft with an amount in Amount Paid is refused with the server's sentence (the legacy stored it on the draft); no tax entry on a line (the legacy builder had none either — a saved line's fixed tax is carried); the low-margin threshold is fixed at 5 % and the below-minimum hint is always on (the two settings are invisible to the screen).
**Not ported here:** returns (M5), dispatch and stock documents (M4), purchases (M3), sale orders (M9), average-cost maintenance and COGS (M4), "edit before printing", Word export, WhatsApp / SMS.

## Change log (old-ERP changes since this project started)

Format: `YYYY-MM-DD` — commit `<hash>` in `projectFarooqAndCoTraders` — what changed — affected module(s) above.

- 2026-09-23 — repo created; log starts here. Old-repo commits before this date are covered by the module
  checklist above, not logged individually.
- 2026-09-24 — (no old-repo hash: found by the S6 importer, not logged by the old repo) the 2026-09-23 nightly has three fields the 2026-09-22 one lacked: `regions.updatedAt`,
  `customers.salesmanId`, `customers.limit` — the importer aborted on them as designed; now classified `docOnly` (kept in `legacy_doc`, unused) — master data (18-master-data.js).

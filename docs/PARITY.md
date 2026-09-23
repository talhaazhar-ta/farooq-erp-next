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
| 01-db.js | IndexedDB schema + migrations | ported (schema S1; sequences + backup load S2) | Drizzle schema (packages/db) + packages/import |
| 01b-server-db.js | Server-side data backend, stale-window poll | not started | apps/api |
| 02-services.js | Core business services (incl. Payments, Ledger) | **Ledger ported (S2)**; Payments/Returns operations not started | Ledger: `packages/import` (`LegacyLedger` + journal posting); operations: apps/api services (S3) |
| 03-docx.js | Document/Word export | not started | — |
| 04-documents.js | Documents module | not started | — |
| 05-ui-builder.js | UI builder helpers | not started | apps/web |
| 06-wiring.js | Page wiring (partly superseded by 38) | not started | apps/web routing |
| 07-transactions.js | Transaction posting | not started | apps/api (ledger, S1/S3) |
| 08-classic-invoice.js | Classic invoice screen | not started | M2 |
| 09-paperwork.js | Paperwork/printing | not started | — |
| 10-mobile.js | Mobile layout, sidebar collapse | not started | apps/web layout |
| 11-search.js | Generic search | not started | — |
| 12-invoice-editor.js | Invoice editor | not started | M2 |
| 13-reports.js | Reports engine | not started | — |
| 14-reports-ui.js | Reports UI | not started | — |
| 15-export-flow.js | Export flow | not started | — |
| 16-khata.js | Khata (ledger book) view | ledger feed ported (account adjustments, OPENING-first order); screen not started | `packages/import`; statement screen S4 |
| 17-profit.js | Profit/Profit.totals | not started | — |
| 18-master-data.js | Areas/regions/master data (soft-delete pattern) | not started | — |
| 19-collection-rbac.js | Roles & permissions | not started | packages/shared (S1) |
| 20-integrity.js | Data integrity checks / migration path | not started | packages/import (S2) |
| 21-settings.js | Settings incl. product prices panel, extra cost/bag | not started | — |
| 22-users.js | User/company accounts management | not started | apps/api auth (S1) |
| 23-workbench.js | Workbench | not started | — |
| 24-client-changes.js | Label overrides repainted every render | not started | — |
| 25-options.js | Options | not started | — |
| 26-landed-cost.js | Landed cost | not started | M6 |
| 27-landed-ui.js | Landed cost UI | not started | M6 |
| 28-areawise.js | Area-wise reporting | not started | — |
| 29-statement-of-account.js | Shop/supplier statement | not started | apps/web (S4) |
| 30-payroll.js | Payroll | not started | M7 |
| 31-auth.js | Sign-in, sessions, heartbeat, lockout | not started | apps/api auth (S1) |
| 32-milling.js | Milling / stock at mills | ledger feed ported (job issue/received/fee rows); rest not started | `packages/import`; rest M8 |
| 33-invoice-search.js | Invoice search (day-first dates) | not started | M2 |
| 34-accounts.js | Accounts | not started | — |
| 35-topbar.js | Top bar (user/db chips, sign-out) | not started | apps/web shell (S1) |
| 36-ui-kit.js | UI kit (Promise-based confirm/prompt/alert) | not started | apps/web (shadcn/ui) |
| 37-stock-value.js | Stock value report | not started | M4 |
| 38-payment-search.js | Payment search, replaces 06's PAGES.payments | not started | apps/web Payments (S4) |
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

Money-critical rules to port with a dedicated test each (from the old project's "learned the hard way" list —
see `projectFarooqAndCoTraders/CLAUDE.md`), tracked here as they're picked up in S3/S4 and beyond:

- Stock cost: `avgCostP` only moves on `PURCHASE_IN`/`MILL_RECEIPT_IN`; `costOf` falls back to carried cost,
  preferring a warehouse's own carried cost over another warehouse's average — not started (M4).
- Money screens never pre-select a party; Save refuses without one — not started (S4).
- Edit-amount voucher correction: refused for reversed / allocated / customer-return-REFUND-tied vouchers —
  not started (S3).
- Purchase edit: money only ever added, line ids stable, stock guard on net change; no cancel/delete — not
  started (M3).
- Change shop moves the shop only; needs TRANSACTION_CORRECT — not started (M2).
- Only one draft invoice can exist (unique invoiceNumber, drafts save '') — not started (M2).
- Dates: local business date, never `toISOString()` — enforced as a project-wide rule, see `CLAUDE.md` rule 6.

## Change log (old-ERP changes since this project started)

Format: `YYYY-MM-DD` — commit `<hash>` in `projectFarooqAndCoTraders` — what changed — affected module(s) above.

- 2026-09-23 — repo created; log starts here. Old-repo commits before this date are covered by the module
  checklist above, not logged individually.

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
| 02-services.js | Core business services (incl. Payments, Ledger) | **Ledger ported (S2)**; **Payments ported (S3)** — not yet *verified* (needs the S4 walkthrough + a reconciliation after real use); Returns operations not started | Ledger: `packages/import` (`LegacyLedger`) + `packages/db/src/ledger.ts` (shared posting builder); Payments: `apps/api/src/payments/` |
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
- Money screens never pre-select a party; Save refuses without one — not started (S4).
- Edit-amount voucher correction: refused for reversed / allocated / customer-return-REFUND-tied vouchers —
  **ported (S3)**, see "Payments rules ported in S3" below.
- Purchase edit: money only ever added, line ids stable, stock guard on net change; no cancel/delete — not
  started (M3).
- Change shop moves the shop only; needs TRANSACTION_CORRECT — not started (M2).
- Only one draft invoice can exist (unique invoiceNumber, drafts save '') — not started (M2).
- Dates: local business date, never `toISOString()` — enforced as a project-wide rule, see `CLAUDE.md` rule 6.

## Change log (old-ERP changes since this project started)

Format: `YYYY-MM-DD` — commit `<hash>` in `projectFarooqAndCoTraders` — what changed — affected module(s) above.

- 2026-09-23 — repo created; log starts here. Old-repo commits before this date are covered by the module
  checklist above, not logged individually.

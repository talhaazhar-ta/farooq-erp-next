# Roadmap

Milestones are ported from the live ERP one functional area at a time, least-changed areas first (cheapest
while both projects run side by side — see `CLAUDE.md` → "Two projects side by side"). A milestone isn't done
until its data reconciles to the paisa against a real nightly backup (`CLAUDE.md` rule 8) and its screens have
been walked through in headless Chrome.

## M1 — Foundation + Payments (complete — S5 done 2026-09-24)

The system is **not used by staff in M1**. Goal: prove the stack, the importer/reconciliation loop, and the
Payments module (money in/out, the most rule-heavy legacy area) end to end.

| Session | Scope | Done when |
|---|---|---|
| **S1: scaffold + DB + auth** | pnpm workspace, NestJS/Fastify API, React/Vite shell, shared package (permissions, Zod), Drizzle schema + migrations + balance trigger, embedded-postgres test harness, sessions/CSRF/roles guard, owner seed, CI | CI green; sign-in works in headless Chrome; unbalanced journal insert is rejected by the DB |
| **S2: importer + reconciliation** | backup JSON → Postgres, legacy ledger port, reconciliation report, synthetic fixture test | run on a real nightly backup: **0 balance differences** for every shop and supplier (numbers go in STATUS) |
| **S3: Payments service + API** | receive/pay/refund/reverse/editAmount with the server-side guards, journal + audit, tests for each legacy rule | all service tests green; forbidden roles get 403 |
| **S4: search v2, statements, receipt model, company profile (server + shared)** | server-side payment search (port of module 38) + CSV, statement endpoints on the journal, receipt model, snapshots, `business` import, shared fold/date-parse/money/words helpers | search parity vs a JS reference; statements equal `LegacyLedger`; reconciliation still 0 differences |
| **S5: Payments UI + statements screen + e2e** | list/filters, the 5 actions, receipt print, statement screen, Playwright e2e (split from the original S4 — too big for one session) | e2e green; screenshots reviewed; "not seen by a person" list in STATUS; M1 complete |

## M2 — Invoices (current — planned 2026-09-24)

Sales invoices end to end: lines, stock quantities, posting, payment at the time of sale, edit/cancel/change shop, search, print, profit,
screens. **Stock quantities (movements + levels) are pulled forward from M4** — an invoice cannot be correct without them; M4 keeps stock
documents, stock value, average-cost maintenance and the COGS journal. Not used by staff; the live ERP stays the system of record.

**Owner decisions (asked and answered 2026-09-24):**
1. Cancelling an invoice that has money received against it is **refused until the receipts are reversed** (legacy silently left the shop in credit).
2. Create / draft / post = `SALES_CREATE`; edit a posted invoice, cancel, change shop = `TRANSACTION_CORRECT`; payment at sale also needs `PAYMENT_CREATE`
   (legacy enforced nothing but Change shop).
3. Editing a posted invoice = **net correction** of stock and balance in one transaction, **refused once there is a return or a dispatch**; a posted
   invoice never goes back to draft (legacy: full reverse + re-deduct, returns unprotected, "Save draft" un-posted it).

| Session | Scope | Done when |
|---|---|---|
| **S6: invoice lines + stock quantities (data, import)** | migration (invoice lines, full header, `stock_movements`, `stock_levels`, product catalogue/prices), shared `invoiceTotals` (port of `Calc`), invoice posting builder in `ledger.ts`, importer + reconciliation of totals and stock | fixture + real backups: 0 balance / invoice-total / stock differences |
| **S7: Invoices service + API ✓** | draft (many), post (number, stock, cost snapshot, payment at sale, journal), edit posted (net), cancel, duplicate, change shop, verbatim validation, permissions, concurrency, ledger bridge | rule tests + 403s + bridge green; reconciliation 0 |
| **S8: search, print model, profit, statement detail (server) ✓** | port of module 33 + CSV, printed invoice model (classic + standard from one model), per-invoice profit (`PROFIT_VIEW`), statement description/Qty from module 24; SALES may discard a draft | search parity vs JS reference on three datasets; print/profit tests; reconciliation 0 |
| **S9: invoice list, view, print, corrections + e2e** | list/search/cards/CSV, view page, print (classic + standard, A4), discard / cancel / duplicate / change shop, profit block, statement Qty + Receive-panel detail; Playwright; screenshots reviewed | e2e green; screenshots reviewed; reconciliation 0 |
| **S10: invoice builder + e2e — closes M2** | new / edit / post, live totals, stock and price hints, payment at sale, edit posted (net, stale revision), unsaved-changes guard, phone layout; Playwright; M2 summary | e2e green; "not seen by a person" list; M2 complete |

## After M2 (not yet broken into sessions)

Planned order, subject to change once the parity log shows which legacy areas actually moved the most:

2. **M3 — Purchases** (purchase edit-only-adds rule, no cancel/delete, no change-supplier; purchase lines + `PURCHASE_IN` on the M2 stock ledger)
3. **M4 — Stock / warehouses** (stock documents receive/dispatch/transfer/adjust, avgCostP vs carriedCost maintenance, stock value, brand conversion, COGS journal — quantities already exist from M2)
4. **M5 — Returns** (customer returns incl. REFUND-tied cash, supplier returns)
5. **M6 — Landed cost**
6. **M7 — Payroll** (staff pay never through Expenses; reverse-never-delete)
7. **M8 — Milling** (AT_MILL default, concurrent-window guard rows, goods-at-mills shown beside stock value)
8. **M9 — Warehouse PWA** (receive/dispatch; avoid the double-count trap — bill entered with Received = 0)
9. **Hosting choice** (VPS vs managed; `docker-compose.yml` already in the repo for this)
10. **Per-module cutover**, one at a time: freeze in the old ERP → final import → 0-diff reconciliation →
    staff switch → old module read-only.

Each milestone above will get its own session breakdown (like M1's S1–S5) written just before it starts, based
on `docs/STATUS.md` and `docs/PARITY.md` at that time — not written in advance, since the old ERP keeps
changing underneath this plan.

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

## M2 — Invoices (**complete — S6–S10, 2026-09-24**; ported and tested, not yet used by staff)

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
| **S9: invoice list, view, print, corrections + e2e ✓** | list/search/cards/CSV, view page, print (classic + standard, A4), discard / cancel / duplicate / change shop, profit block, statement Qty + Receive-panel detail; Playwright; screenshots reviewed | e2e green; screenshots reviewed; reconciliation 0 |
| **S10: invoice builder + e2e — closes M2 ✓** | new / edit / post, live totals, stock and price hints, payment at sale, edit posted (net, stale revision), unsaved-changes guard, phone layout; Playwright; M2 summary | e2e green; "not seen by a person" list; M2 complete |

## M3 — Purchases (planned 2026-09-25; **S11, S12 and S13 done 2026-09-25**, S14 parity catch-up final, S15 builder draft)

Supplier bills end to end: lines (ordered / received per line, per-line warehouse), `PURCHASE_IN` on the M2 stock ledger, the payment made with the purchase,
edit (money only ever added, stable line ids, net stock guard, supplier locked once anything is attached), **average-cost maintenance**, list / search / print, the builder.
Not used by staff; the live ERP stays the system of record.

**User decisions (2026-09-25):**
1. **Average cost is maintained in M3** — ported from the legacy purchase-history average (`17-profit.js` `Cost.weightedAverage`; `26-landed-cost.js`
   `Landed.weightedAverage` under the `LANDED` basis, which the real data uses). The operational share of a landed cost is kept on the line (M6 writes it).
2. Create = `PURCHASE_CREATE`; edit = `PURCHASE_CREATE` or `TRANSACTION_CORRECT` (legacy); paying with the purchase also needs `PAYMENT_PAYOUT`.
3. Legacy bugs fixed: paid > total / negative on a new purchase; line discount above the line amount; part-delivery unit cost (÷ ordered, not ÷ received);
   the print's "Bags received" showing ordered bags.
4. No drafts, cancel, delete, separate Change supplier or `receiveMore` (the legacy has none reachable).
5. S11 (data only) may start before the M1 + M2 walkthrough by a person; S13 / S15 (screens) wait for it (S13: waived by the user; S15: not waived — decided 2026-09-25).

| Session | Scope | Done when |
|---|---|---|
| **S11: purchase lines + full header + average cost (data, import)** | migration `0008` (header columns, `purchase_items`, unique number), `ledger.ts` purchase builder, shared `purchase-cost.ts` (`allocateCharges`, `weightedAverage`), importer maps lines, reconciliation of purchase totals, purchase ↔ stock and average cost | fixture + v710 + v692: 0 differences on every check — **done (S11)** |
| **S12: Purchases service + API ✓** | create, edit (net), payment with the purchase (shared payout core), average-cost writes, permissions, idempotency, concurrency, ledger bridge | rule tests + 403s + bridge green; reconciliation 0 |
| **S13: list, view, print ✓** | search / filters / cards / CSV, view page, A4 print (server + screens), Playwright | e2e green; screenshots and PDF reviewed — **done (S13; the M1 + M2 walkthrough was waived by the user for it)** |
| **S14: parity catch-up** (added 2026-09-25) | the live ERP's 2026-09-25 changes: sale cost = stock cost + extra cost per bag (`c78659b`), `RECEIPT_EDIT_OUT` in the importer and `carriedCost` (`b2b0778`), real-data proofs pinned to the pre-wipe v692 + v710 (live test data wiped) | rule tests + mutations; reconciliation 0 on v692 / v710 / the post-wipe nightly |
| **S15: builder — closes M3** | new / edit purchase builder, phone layout, Playwright, M3 summary | e2e green; M3 complete |

## After M3 (not yet broken into sessions)

Planned order, subject to change once the parity log shows which legacy areas actually moved the most:

3. **M4 — Stock / warehouses** (stock documents receive/dispatch/transfer/adjust, carriedCost for non-purchase receipts, stock value, brand conversion, COGS journal — quantities exist from M2, purchase-kept average cost from M3)
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

# Roadmap

Milestones are ported from the live ERP one functional area at a time, least-changed areas first (cheapest
while both projects run side by side — see `CLAUDE.md` → "Two projects side by side"). A milestone isn't done
until its data reconciles to the paisa against a real nightly backup (`CLAUDE.md` rule 8) and its screens have
been walked through in headless Chrome.

## M1 — Foundation + Payments (current)

The system is **not used by staff in M1**. Goal: prove the stack, the importer/reconciliation loop, and the
Payments module (money in/out, the most rule-heavy legacy area) end to end.

| Session | Scope | Done when |
|---|---|---|
| **S1: scaffold + DB + auth** | pnpm workspace, NestJS/Fastify API, React/Vite shell, shared package (permissions, Zod), Drizzle schema + migrations + balance trigger, embedded-postgres test harness, sessions/CSRF/roles guard, owner seed, CI | CI green; sign-in works in headless Chrome; unbalanced journal insert is rejected by the DB |
| **S2: importer + reconciliation** | backup JSON → Postgres, legacy ledger port, reconciliation report, synthetic fixture test | run on a real nightly backup: **0 balance differences** for every shop and supplier (numbers go in STATUS) |
| **S3: Payments service + API** | receive/pay/refund/reverse/editAmount with the server-side guards, journal + audit, tests for each legacy rule | all service tests green; forbidden roles get 403 |
| **S4: search v2, statements, receipt model, company profile (server + shared)** | server-side payment search (port of module 38) + CSV, statement endpoints on the journal, receipt model, snapshots, `business` import, shared fold/date-parse/money/words helpers | search parity vs a JS reference; statements equal `LegacyLedger`; reconciliation still 0 differences |
| **S5: Payments UI + statements screen + e2e** | list/filters, the 5 actions, receipt print, statement screen, Playwright e2e (split from the original S4 — too big for one session) | e2e green; screenshots reviewed; "not seen by a person" list in STATUS; M1 complete |

## After M1 (not yet broken into sessions)

Planned order, subject to change once M1's parity log shows which legacy areas actually moved the most while
M1 was in flight:

1. **M2 — Invoices** (sales documents, invoice search, draft-invoice uniqueness rule, change-shop)
2. **M3 — Purchases** (purchase edit-only-adds rule, no cancel/delete, no change-supplier)
3. **M4 — Stock / warehouses** (Inventory.apply, avgCostP vs carriedCost split, stock value, brand conversion)
4. **M5 — Returns** (customer returns incl. REFUND-tied cash, supplier returns)
5. **M6 — Landed cost**
6. **M7 — Payroll** (staff pay never through Expenses; reverse-never-delete)
7. **M8 — Milling** (AT_MILL default, concurrent-window guard rows, goods-at-mills shown beside stock value)
8. **M9 — Warehouse PWA** (receive/dispatch; avoid the double-count trap — bill entered with Received = 0)
9. **Hosting choice** (VPS vs managed; `docker-compose.yml` already in the repo for this)
10. **Per-module cutover**, one at a time: freeze in the old ERP → final import → 0-diff reconciliation →
    staff switch → old module read-only.

Each milestone above will get its own session breakdown (like M1's S1–S4) written just before it starts, based
on `docs/STATUS.md` and `docs/PARITY.md` at that time — not written in advance, since the old ERP keeps
changing underneath this plan.

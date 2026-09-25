# Status

**Last updated:** 2026-09-24 (S10 session; trimmed by the planning hub the same day). **Milestones 1 (Payments) and 2 (Invoices) are complete. M3 — Purchases is planned (2026-09-25): next is S11 (data + import); a person walks the M1 + M2 screens before S13.**
Nothing is deployed; the live ERP is untouched and is still the only system of record. **No member of staff has used any screen.**

**How this file works:** it holds only the *current* state — where we are, the baseline numbers, the rules still in force, open questions, the next step. Each session's full write-up (what was built, verification tables,
mutation checks, deviations, findings, screenshots) lives in `docs/history/` (verbatim, never summarised): `S6.md` … `S10.md` (M2), `M1-S5.md` (the M1 close-out) and `S1.md` … `S4.md` (STATUS exactly as it stood at the end of each of those sessions; S3 / S4 hold the payment endpoint tables).
**Grep `docs/history/` before re-deriving anything.** At the end of your session: move your own section to `docs/history/S<N>.md`, then update only the header, "Baseline", "Rules in force" (durable rules only), "Open questions" and "Next step" here.
Keep this file under ~150 lines.

## Where we are

- **M1 — Payments (S1–S5):** importer + reconciliation, the payments service (receive / pay / refund / reverse / edit amount), server-side search (port of module 38) + CSV, statements, receipt model, the screens, browser tests.
- **M2 — Invoices (S6–S10):** invoice lines and stock quantities imported and reconciled; the invoices service (drafts, post, net edit, cancel, duplicate, change shop); search (port of module 33) + CSV + print model (classic and standard) + profit + statement detail; list / view / print / corrections screens; the builder (new, draft, edit, post, edit posted).
- **Reconciliation is the definition of "correct"** (`pnpm test` re-runs it; so does e2e global setup). Newest real nightly (2026-09-23, v692): 409 customers / 35 suppliers, **0 balance differences** (receivables 2,234,290,000 = 2,234,290,000 paisa; payables 554,000,000 / 604,000,000), trial balance 42 entries BALANCED, 444 statements 0 mismatches, 17 invoices / 18 lines / 910 bags **0 total mismatches**, 15 stock rows / 48 movements **0 stock mismatches**, 17 invoices vs 24 movements **0 mismatches**. The 2026-09-22 nightly, the fixture, S8's 300-invoice synthetic backup and the e2e dataset also reconcile with 0.
- **What M1 + M2 do not claim:** no staff use; no receipt or invoice printed on paper (only the PDF Chromium prints was read back); thin real data (17 invoices, 20 payments, 409 shops); no returns, dispatch, purchases, stock documents, COGS or average-cost maintenance yet; hosting undecided.

## Baseline (run before you change anything)

`pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` — all green, 0 lint warnings, **and check the exit code** (until S8, CI could not fail on a failing test).
`pnpm test`: **1,109 tests** (shared 151, web 209, import 224, api 525; 2 import tests + the real-backup datasets skip without `data/`). `pnpm e2e`: **165 Playwright tests** (~7.5 min). CI: S10 green (run 36023883386), S9 green (run 36010060366).

## Repo map

```
apps/api         NestJS 11 + Fastify. src/{auth, payments, statements, invoices}/ (+ cors.ts). Controllers declare permissions; tests in test/ (+ helpers/: synthetic-payments, synthetic-invoices, legacy-*-search references)
apps/web         React 19 + Vite + TanStack Router/Query. src/lib (pure logic + tests), src/components, src/routes. Vitest + Testing Library
apps/e2e         Playwright. setup/ (throwaway Postgres -> import dataset -> reconcile -> users -> built api + web), tests/*.spec.ts, tests/fixtures.ts (postInvoice, stockBasics, ...)
packages/shared  permissions/roles, Zod schemas (auth, payments, statements, invoices, invoice-list, invoice-print), business dates, fold / search-query / money, invoice-totals (Calc), line-summary, profit
packages/db      Drizzle schema, migrations 0000-0007, ledger.ts (posting builders), stock.ts, test harness (@farooq/db/testing)
packages/import  importer, classification.ts, LegacyLedger, prepare, load, reconcile, company, CLI, fixtures/ (build-fixture.ts = the hand-computed numbers)
docs/            ROADMAP.md, PARITY.md (legacy modules + rule -> test tables + old-ERP change log), sessions/S<N>.md (plans), history/ (write-ups)
```

## Rules in force (durable; the details and the tests that pin each are in `docs/history/` and `docs/PARITY.md`)

**Money, dates, quantities.** Money = `bigint` paisa in Postgres, plain JS `number` in the app, integers only. Quantities = integer thousandths (`qtyMilli`, at most 3 decimals). Business dates = `YYYY-MM-DD` in `Asia/Karachi` via `businessDateOf`, **never `toISOString()`**.
Entry is strict: `parseRupees` refuses more than 2 decimals and never goes through floating point; amount in words says the paisa. Enum-shaped columns are plain `text` validated at the app boundary (payments / allocations also have CHECKs).

**Ledger.** Every posted document has exactly ONE journal entry found by `(source_type, source_id)`; the S1 trigger refuses an unbalanced entry. Reversal / cancel entries (`PAYMENT_REVERSAL`, `INVOICE_CANCEL`) carry the **original document's date**, so the pair cancels at every date; **statements omit both** (counts: `omittedReversed`, `omittedCancelled`).
An edit rewrites the entry in place (audit `before` / `after` is the trail). `journal_entries.created_at` is `clock_timestamp()` (an invoice sorts before the receipt taken with it). Invoice lists come from `invoices` + allocations, **never the journal**. Statement order: business date -> `created_at` -> id; a customer's OPENING row first. Receipt balances = the running balance around the voucher's own row.

**Payments (M1).** `PAYMENT_PAYOUT` gates pay and refund (Owner / Manager / Accountant; not Sales). Explicit allocations are capped on the server; a second reverse is refused; reverse keeps allocation rows; "paid" counts POSTED vouchers only; vouchers keep name / owner / region snapshots.
Numbers `REC` / `PV` / `INV`: `nextNumber` inside the transaction, gap-free, year = current business year. `idempotencyKey` (8-100 chars) on every create: same key = the first result (HTTP 200).

**Invoices (M2).** Any number of drafts (partial unique index on `invoice_number`). Post = number + `SALE_OUT` per line + stock level + one `INVOICE` entry + a receipt for the money taken (through the shared receive core, `payments/receipt-core.ts`). `previous_balance_p` is frozen at posting. Edit of a posted invoice = net difference per product x godown; refused after cancel / return / dispatch, when the shop differs, when going back to draft, or on a stale `revision`; lowering "Paid" below the money received is refused.
Cancel is refused while POSTED receipts or returns exist; a draft can be discarded by anyone with `SALES_CREATE`. Migrated invoices (`migrated = true`) never get stock movements on edit / cancel. Invoice saves are idempotent through `request_keys`. **Owner decisions (2026-09-24):** cancel with receipts refused; create / draft / post / discard-draft = `SALES_CREATE`, edit posted / cancel posted / change shop = `TRANSACTION_CORRECT`, payment at sale also `PAYMENT_CREATE`; net edit.
**Profit** = goods margin: (line total minus its tax) minus cost snapshot x qty, minus the invoice discount; charges and tax are not margin; an unknown cost is never counted as free; the `profit` keys exist **only** for `PROFIT_VIEW` (absent, not null).

**Stock (M2 part).** `stock_movements` is append-only for the app role; `stock_levels` change in the same transaction, rows locked in a fixed order; `costOf` / `carriedCost` are **reads** of imported rows; average cost is **not maintained** and there is **no COGS / inventory journal** until M4 (a sale is DR RECEIVABLES / CR SALES).

**API conventions.** Requests are `.strict()` Zod schemas from `@farooq/shared`; refusals are HTTP 422 `{message, errors[]}` (404 same shape; 401 = no session / bad CSRF (`x-csrf-token`); 403 = role); legacy wording is kept verbatim (constants in shared; a test proves labels occur in the legacy source when the old repo sits next to this one). Payment / statement reads need any of `PAYMENT_CREATE | COLLECTION_VIEW | FINANCIAL_REPORT_VIEW`; invoice reads any of `SALES_CREATE | TRANSACTION_CORRECT | COLLECTION_VIEW | FINANCIAL_REPORT_VIEW`; the warehouse role (INVENTORY) gets 403 on both; pickers need `MASTER_DATA_VIEW` (every role).
Auth: 5 wrong passwords lock the account 15 min plus a per-IP throttle; 12 h session, no idle timeout (owner's request); CORS methods are configured in `apps/api/src/cors.ts` (S10 found that PUT was missing — add new verbs there).

**Search.** Server-side on generated stored columns + the SQL function `fold_search`, proven identical to the JS `foldSearch` for every Unicode code point; if a Node upgrade changes Unicode tables the parity test names the code points -> re-run `packages/shared/scripts/generate-fold-sql.mjs` into a NEW migration. Punctuation is a separator, never a wildcard; no Postgres extensions. Invoice "Everything" never searches receipt numbers (only the receipt scope does). A date typed in the box is a filter, echoed back in `interpreted`.

**Importer.** Local Postgres only; wipes business + ledger tables (never `users` / `sessions` / `role_permissions` / `audit_log` / `accounts`); aborts on any unknown store or field (`classification.ts` — a newer backup adding a field is exactly how you find out); deterministic UUIDv5 row ids; the old paper-book `legacy*` figures are **not** posted; `users` is never read; `business` loads verbatim with a credential-name guard.

**Web.** Screen state lives in the URL (plain `URLSearchParams` codec; `useSearch` returns the RAW address, so re-parse it). A party is never pre-selected on a money screen. Server reasons are shown verbatim (every `errors[]` line; a disabled button carries `actions.*.reason`). One representation (table OR cards) in the DOM. No external fonts, no emoji, print = A4 with fixed paper colours.
Rupees / dates only via `parseRupees` / `formatPaisa` / `businessDateOf`. The idempotency key is kept after a failed save and renewed after a success. Hand-rolled primitives (`components/ui.tsx`), not shadcn.

**Testing and tooling.** Run `pnpm build` before `pnpm test` (packages build to `dist/`). Packages test one at a time; the api tests share one database, so **a test that reads shared tables must scope its query to its own rows**. Embedded Postgres clusters must be UTF8. e2e specs run strictly in file order on one database; money-moving specs each own a shop; a killed e2e run leaves postgres on :55433 and node on :3100 / :4173 (kill them). Real-backup tests skip without `data/`.
Editing tools decode `\uXXXX` and shell heredocs / `node -e` mangle backticks and backslashes: write such files with the Write tool and edit CRLF files with the Edit tool.

## Owner-visible changes vs the live ERP (all deliberate; the owner should know)

Sales cannot pay out or refund (`PAYMENT_PAYOUT`); explicit allocations are capped; a second reverse is refused; money entry refuses > 2 decimals; amount in words includes paisa; same-day statement rows appear in the order entered; receipt balances are position-based (a reprint is stable);
invoices: cancel refused while receipts stand, net edit refused after a return / dispatch, no un-posting, many drafts, negative discounts / charges refused, stock checked per product x godown across lines, Sales may discard drafts; profit = goods margin (not "grand total minus cost"); a duplicate keeps a fixed line tax. The new wording the builder shows is listed in `docs/history/S10.md` ("Owner-visible sentences that are new").

## Open questions (owner / user)

1. **Paper-book balances / cutover date** — the 409 customers carry old paper-book figures the ERP ignores; new balances equal what the old ERP shows (old repo `CLAUDE.md` open item 1).
2. Should **Sales be able to pay out** (`PAYMENT_PAYOUT` is Owner / Manager / Accountant only)? Should the **warehouse role** see the customer list and `/company` (every role holds `MASTER_DATA_VIEW`)?
3. **Which profit figure** the owner wants shown (adopted: goods margin; the legacy also counts tax and charges and treats an unknown cost as free). Should the low-margin / below-minimum settings be readable by the screen (now fixed 5 % / always on)?
4. Review the **new sentences** in `docs/history/S10.md`.
5. **Hosting** (VPS vs managed) — nothing deploys until decided (`docker-compose.yml` exists for it).

## Not yet seen by a person

Every screen. In particular a real phone (only a 390 px emulated viewport); a **printed** invoice / receipt on the shop's printer and the classic layout next to the shop's paper sheet; Firefox / Safari / Edge; Urdu fonts on other machines; keyboard-only and screen-reader use; a busy day (a 30-line invoice under time pressure; the product picker against the real catalogue of hundreds — the dataset has 19; lists with thousands of invoices); an invoice with a return through the screens (returns cannot be made yet).

## Next step

1. **S11 — purchase lines, full header, average cost** (`docs/sessions/S11.md`, final). Data / import / reconciliation only — it may start now.
2. **A person walks the M1 + M2 screens on a real machine and a real phone, and prints one receipt and one invoice** (compare the classic invoice with the shop's paper sheet). This blocks **S13 / S14** (the M3 screens), not S11 / S12.
3. M3 plan: `docs/ROADMAP.md` → M3 (user decisions 2026-09-25: average cost maintained in M3; create `PURCHASE_CREATE`, edit `PURCHASE_CREATE` | `TRANSACTION_CORRECT`, paying also `PAYMENT_PAYOUT`; four legacy bugs fixed). S12–S14 are drafts until the hub finalises each.
4. Old-ERP changes: none since 2026-09-24 (checked 2026-09-25). The newest nightly `data/business-20260924-210002-v710-449d.json` holds the **first real landed cost** — S11 must reconcile it.

## CI

S10 commit `d5e6ca5`: **green** — run 36023883386: build, typecheck, lint, test (1,109) and the Playwright job (165) all succeeded on the Linux runner (confirmed per step by the planning hub; the S10 session had ended while it was still running).

# farooq-erp-next — Project Reference

Auto-loaded every session. This is the **rebuild** of the Farooq & Co Traders ERP on a new stack. It is a
**separate project** from `D:\projectFarooqAndCoTraders` (the live ERP) — different repo, different rules,
nothing here deploys anywhere yet.

## Read this first, every session

1. **Read `docs/STATUS.md`.** It says what is done, how it was verified, and what the next step is.
2. **Read the session plan you were given** (`docs/sessions/S<N>.md`). It is self-contained: goal, files, steps,
   definition of done, out of scope. Don't start work outside that scope — flag it in STATUS instead.
3. When you finish: **update `docs/STATUS.md`** (what's done, real verification numbers, deviations, known
   issues, next step), commit, push to `main`. That file is the only hand-off between sessions — don't assume
   the next session remembers this conversation.

## What this is

A rebuild of the ERP at `erp.farooqandcotraders.online` (currently 46 vanilla-JS patch modules injected into one
1.9 MB HTML file, IndexedDB/JSON-document storage, browser-only permission checks) on:

- **API:** NestJS 11 + Fastify adapter, Drizzle ORM, Zod validation, PostgreSQL.
- **Web:** React 19 + Vite, TanStack Router/Query, Tailwind v4 with hand-rolled primitives (no shadcn CLI was needed — see STATUS S5 deviations).
- **Shared:** Zod schemas, types, permission names used by both api and web.
- **Import:** legacy backup JSON → Postgres importer + reconciliation report (the "100%" safety net — see below).

Hosting is **not decided yet** — build and test locally, no spending. The live ERP stays the only system of
record until a module is explicitly cut over (see "Two projects side by side" below).

## Repo layout (pnpm workspace)

```
farooq-erp-next/
  apps/api        NestJS 11, Fastify adapter, Drizzle ORM, Zod
  apps/web        React 19 + Vite, TanStack Router/Query, hand-rolled Tailwind v4 primitives (native <dialog>, ARIA combobox); Vitest + Testing Library
  apps/e2e        Playwright browser tests (S5): built api + built web against a throwaway Postgres loaded with synthetic data
  packages/shared Zod schemas + types + permission names shared by api & web
  packages/db     Drizzle schema, migrations, client, dev-DB launcher and the embedded-postgres test harness
                  (`@farooq/db`, `@farooq/db/testing`) — shared by apps/api and packages/import
  packages/import legacy backup JSON → Postgres importer, LegacyLedger, reconciliation report
  docker-compose.yml, .github/workflows/ci.yml, docs/
```

## Hard rules

1. **Git: no branches, no PRs.** Work on `main`, commit, push to `origin main`. Nothing left
   uncommitted/unpushed at the end of a session. **No Claude attribution in commit messages** (GitHub identity
   is the user's own — same as the old project).
2. **Never deploy anything.** No Hostinger, no VPS, no spending, no DNS. This project builds and tests locally
   (embedded Postgres for dev/test) until a hosting decision is made explicitly by the user.
3. **Never write to the live ERP or its database.** The importer only ever *reads* a nightly backup JSON file
   over read-only SSH (`~/backups/nightly/*.json` on the old project's server) or a file the user hands you.
   Never connect to `u943531942_facotraders` or `u943531942_erpauth` from this project.
4. **Business data never goes in git.** Backup JSON files and anything derived from real customer/supplier/
   financial data live under `/data/`, which is gitignored. Only synthetic/fixture data is committed.
5. **Money is integer paisa (`bigint`)**, matching the old app's `amountP`. Never floats for money.
6. **Dates are local business dates**, never built from `toISOString()` (UTC) — same trap as the old project
   (Pakistan is UTC+5; `toISOString()` says yesterday until 05:00 local).
7. **Every business rule ported from the old ERP needs a test that encodes the rule**, not just a test that
   the code runs. `docs/PARITY.md` lists the rules; check a rule off only when a test for it is green.
8. **The importer's reconciliation report is the definition of "correct".** A screen or service isn't done
   because it compiles or the UI looks right — it's done when reconciliation shows 0 balance differences for
   every shop and supplier on a real nightly backup, and STATUS.md records the actual numbers.
9. **Confirm with the user first** before anything hard to reverse: force-push, deleting data, changing the
   hosting/stack decision, or touching the old project's repo (only the `docs/PARITY.md`-log line belongs to
   this project's workflow — everything else about the old repo is out of scope here).

## Two projects side by side

- **Old project stays live and keeps improving:** `D:\projectFarooqAndCoTraders` → `erp.farooqandcotraders.online`.
  Nothing about its build, deploy or rules changes because this project exists. Client requests keep landing
  there as usual.
- **This project never deploys** until a later milestone's cutover, module by module.
- **How they stay in step:**
  1. **Parity log** (`docs/PARITY.md`): every legacy module/rule with status not started / ported / verified.
     Whenever the old ERP gets a change, the old repo's `CLAUDE.md` rule appends one line here: commit hash +
     what changed + which module here it affects.
  2. **Data stays in step automatically**: this project always re-imports the latest nightly backup, so new
     live records arrive without manual work. If an old-side change adds a store/field the importer doesn't
     know about, the importer **fails loudly** on the unmapped field — it never silently drops data.
  3. **Cutover per module** (later, one at a time): freeze the module in the old ERP → final import →
     reconciliation shows 0 differences → staff switch → old module becomes read-only.

## How to build / test locally

Requires Node >=20 and `pnpm` (`npm install -g pnpm` if missing — no Docker needed for local dev/test).

```
pnpm install
pnpm build        # topological: packages/shared + packages/db first, then apps/api + apps/web + packages/import
pnpm typecheck
pnpm lint
pnpm test          # apps/api and packages/import each spin up a throwaway embedded-postgres per run (@farooq/db/testing); apps/web runs Vitest (jsdom)
pnpm e2e           # S5: Playwright in Chromium — needs `pnpm build` first and Chromium installed once (below)
```

All five must be clean before pushing. Run `pnpm build` before `pnpm test` — the packages import each other's
built `dist/`. The tests use `embedded-postgres` (no system Postgres or Docker required); CI instead points them at
a real Postgres service container via `EXTERNAL_TEST_DATABASE_URL` (see `.github/workflows/ci.yml`) — both paths run
the same migrations and the same tests. `pnpm test` runs the workspace **one package at a time**
(`--workspace-concurrency=1`) on purpose: the importer's tests TRUNCATE the business tables and both suites share one
test database/port. Test Postgres clusters are created with `--encoding=UTF8` (Windows' default WIN1252 cannot store
Urdu shop names) — keep it that way for any new cluster.

**apps/api tests** (S3) also import `@farooq/import` (the ledger-bridge test imports the synthetic fixture through the real importer),
so `pnpm build` must have run first; `pnpm --filter @farooq/api typecheck` covers `test/` too (`tsconfig.test.json`). Tests seed their own
uniquely-named shops/suppliers and never truncate, except `payments-ledger-bridge`, which runs the importer (it wipes the business tables).
Payment / search / statement / receipt endpoints, the Zod schemas the UI imports, and the permission model are listed in `docs/STATUS.md`.
The S4 parity / proof tests (`payments-search-parity`, `statements-proof`, `receipt`, `s4-reads`) **import a backup**, which wipes the business tables — every other test seeds its own uniquely named rows. The real-backup datasets in those tests run only when `data/business-20260922-210002-v505-6a81.json` exists (never in CI).

**Invoice service tests (S7)** live in `apps/api/test/invoices-*.test.ts` (validate, post, edit, cancel, change-shop, reads/duplicate, cost, permissions, concurrency, and `invoices-ledger-bridge`, which imports the fixture, runs 11 scripted operations through the HTTP API, mirrors them on the legacy JSON and runs the real reconciliation). They seed uniquely named shops / products / godowns (`test/helpers/invoices.ts`) and never truncate, except the bridge, which runs the importer. The API is `apps/api/src/invoices/`; `PaymentsService.receive` and an invoice saved with money taken both call `writeReceipt` (`apps/api/src/payments/receipt-core.ts`). Migration `0006` adds `request_keys` (idempotency for invoice saves).

**Invoice read tests (S8)** live in `apps/api/test/invoices-{search-parity,list,csv,print,profit,s8-permissions,labels-verbatim}.test.ts` and `statements-invoice-detail.test.ts`; the API is `apps/api/src/invoices/invoices.{search,list,csv,print}.ts`. `invoices-list` / `invoices-csv` import the committed fixture first (that wipes the business tables — they own the database, so global numbers like the cards can be asserted); every other test seeds its own uniquely named shops and scopes its queries to them.
`invoices-search-parity` runs the legacy search algorithm (`test/helpers/legacy-invoice-search.ts`, a literal port that imports nothing from the code under test) against `GET /invoices` over the fixture, a seeded ~300-invoice synthetic backup (`test/helpers/synthetic-invoices.ts`, which itself reconciles with 0 differences) and the newest real `data/business-*.json` when present (never in CI). `invoices-labels-verbatim` reads the old repo's `erp-upgrade` folder (next to this repo, or `LEGACY_ERP_DIR`) and is skipped where it is absent. Migration `0007` adds the invoice search columns (generated, like S4's) and makes `journal_entries.created_at` default to `clock_timestamp()`.
**Editing tools decode `\r`, `\n`, `\t` and `\uXXXX` inside shell / Python heredocs** — write source with the Write / Edit tools and check new files with `grep -P '[\x00-\x08\x0b\x0c\x0e-\x1f\xa0]'`.

**Importer tests (S6)** also cover invoice lines and stock: `invoice-lines-stock` (hand-computed numbers), `invoice-stock-fail-loudly`, `invoice-stock-safety-net` (every reconciliation check proven to bite) and `real-backups`, which imports + reconciles the **two newest** `data/business-*.json` nightlies (skipped when there are none; never in CI; prints counts only). Reconciliation now also proves **invoice totals** (recomputed from the lines with `@farooq/shared`'s `invoiceTotals`), **stock** (legacy inventory = `stock_levels` = Σ `stock_movements`) and **invoice ↔ stock**, and exits non-zero on any mismatch. `stock_movements` is append-only for the app role. Migration `0005` is hand-appended (REVOKE + comments) after the generated part.
Migration `0004` contains generated SQL (`fold_search`): regenerate with `node packages/shared/scripts/generate-fold-sql.mjs` (after `pnpm build`) into a **new** migration if `fold-search-parity` ever goes red after a Node upgrade.

**Running the app locally** (manual/browser checks, not CI):

```
pnpm --filter @farooq/api db:dev        # starts a persistent local embedded-postgres on :54329, prints the URLs
# in another terminal, after copying apps/api/.env.example -> apps/api/.env and filling it in:
pnpm --filter @farooq/api db:migrate
pnpm --filter @farooq/api db:seed        # role_permissions + the OWNER user from OWNER_* env vars
pnpm --filter @farooq/api dev             # NestJS on :3000
pnpm --filter @farooq/web dev             # Vite on :5173
```

`apps/web/.env.example` has `VITE_API_URL` (defaults to `http://localhost:3000`).

**Importing a legacy backup + reconciliation** (S2; local Postgres only — the importer refuses any non-local host; the database must be migrated through `0005`, the importer checks):

```
# with the dev DB from above running and migrated:
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54329/farooq_erp pnpm --filter @farooq/import run import ../../data/<backup>.json
```

(PowerShell: `$env:DATABASE_URL="..."; pnpm ...`.) Use `run import` — a bare `pnpm import` is pnpm's own built-in command. The importer wipes the business + ledger
tables (never `users`/`sessions`/`role_permissions`/`audit_log`/`accounts`), loads the backup in one transaction,
prints the reconciliation report and writes `data/reconciliation-<timestamp>.json` (gitignored). **Exit code is
non-zero if any shop/supplier balance, the trial balance, a row count or a statement differs.** `DATABASE_URL` is the
admin connection (TRUNCATE needs it). An unknown store or field in the backup aborts the import naming it — classify it
in `packages/import/src/classification.ts`. `pnpm --filter @farooq/import fixture` regenerates the committed synthetic
fixture (a test checks it hasn't drifted).

**Browser tests (`pnpm e2e`, S5).** One-time: `pnpm --filter @farooq/e2e exec playwright install chromium` (or set `CHROME_CHANNEL=chrome` to use an installed
Google Chrome). Global setup (`apps/e2e/setup/global-setup.ts`) starts a throwaway Postgres (embedded on :55433, or CI's service container), imports the e2e dataset
(S4's seeded ~300-payment synthetic backup + a few hand-made shops, `setup/dataset.ts`) through the real importer and reconciles it, creates one user per role with
**generated** passwords (only in the gitignored `apps/e2e/.run/state.json`), starts the built API (:3100) and a fresh build of the web app served by `vite preview` (:4173),
and signs each role in once (storage states). Specs run one at a time, in file order, on that one database — each test that moves money uses its own shop from the dataset.
- one spec: `pnpm --filter @farooq/e2e exec playwright test tests/receive.spec.ts` (one test: add `-g "part of its name"`; `--headed` to watch; `--ui` for the inspector).
- `pnpm --filter @farooq/e2e run serve` starts that same stack and leaves it running for a person or a scratch script to look at (Ctrl+C stops it; if a run is killed, an orphaned
  postgres on :55433 and a node on :3100 / :4173 must be stopped by hand before the next run).
- Screenshots (desktop / phone / dark) and the PDFs the print tests read back are written to `apps/e2e/e2e-artifacts/` (gitignored) by `tests/visual.spec.ts` / `receipt-print.spec.ts` — open them and look.
- Any `console.error` fails a golden-path test (a test that provokes a refusal sets `allowConsoleErrors`). Sign-in specs spend real login attempts (the API throttles 20 / 15 min / IP), everything else reuses the storage states.

## Roadmap

See `docs/ROADMAP.md` for the full milestone list. **M1 — Foundation + Payments is complete** (S1–S5).
Current milestone: **M2 — Invoices** (**S6 invoice lines + stock quantities ✓** → **S7 Invoices service + API ✓** → **S8 search/print/profit server side ✓** →
S9 screens + e2e). The owner's three M2 decisions (cancel with receipts refused; permissions; net edit of posted invoices) are in `docs/ROADMAP.md` → M2.

## Where to look for more detail

- `docs/STATUS.md` — current state, written by the last session to touch this repo. Read first, every time.
- `docs/ROADMAP.md` — all milestones and sessions, in order.
- `docs/PARITY.md` — legacy-module checklist + the log of old-ERP changes since this project started.
- `docs/sessions/S<N>.md` — the plan for one implementation session.

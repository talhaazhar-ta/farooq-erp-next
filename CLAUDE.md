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
- **Web:** React 19 + Vite, TanStack Router/Query/Table, shadcn/ui + Tailwind.
- **Shared:** Zod schemas, types, permission names used by both api and web.
- **Import:** legacy backup JSON → Postgres importer + reconciliation report (the "100%" safety net — see below).

Hosting is **not decided yet** — build and test locally, no spending. The live ERP stays the only system of
record until a module is explicitly cut over (see "Two projects side by side" below).

## Repo layout (pnpm workspace)

```
farooq-erp-next/
  apps/api        NestJS 11, Fastify adapter, Drizzle ORM, Zod
  apps/web        React 19 + Vite, TanStack Router/Query/Table, shadcn/ui + Tailwind
  packages/shared Zod schemas + types + permission names shared by api & web
  packages/import legacy backup JSON → Postgres importer + reconciliation report
  docker-compose.yml, .github/workflows/ci.yml, docs/
```

None of `apps/`, `packages/` or `docker-compose.yml` exist yet as of this scaffold — S1 creates them.

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

Not yet set up — S1 creates the pnpm workspace, the embedded-postgres test harness, and the exact commands.
This section gets filled in as part of S1's definition of done; don't hand-write commands here until they exist
and have been run.

## Roadmap

See `docs/ROADMAP.md` for the full milestone list. Current milestone: **M1 — Foundation + Payments**
(S1 scaffold+DB+auth → S2 importer+reconciliation → S3 Payments service+API → S4 Payments UI+statements).

## Where to look for more detail

- `docs/STATUS.md` — current state, written by the last session to touch this repo. Read first, every time.
- `docs/ROADMAP.md` — all milestones and sessions, in order.
- `docs/PARITY.md` — legacy-module checklist + the log of old-ERP changes since this project started.
- `docs/sessions/S<N>.md` — the plan for one implementation session.

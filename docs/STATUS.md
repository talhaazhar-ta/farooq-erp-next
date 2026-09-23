# Status

**Last updated:** 2026-09-23, by the S1 session (scaffold + DB + auth).

## Current state

S1 is done. The pnpm workspace, NestJS API, React web shell, shared permissions/schema package, Drizzle
Postgres schema with a balance-enforcing trigger, embedded-postgres test harness, session/CSRF/role auth, an
owner seed user, and CI all exist and are green. No business screens — sign-in + an empty authenticated shell
is the whole UI surface, as scoped.

### Repo layout (as built)

```
apps/api        NestJS 11 + Fastify adapter, Drizzle ORM (postgres-js), Zod
apps/web        React 19 + Vite, TanStack Router/Query/Table (code-based router, no file-based codegen),
                 Tailwind v4 + hand-rolled components (no shadcn CLI run — see "Deviations")
packages/shared  Permission/role constants + Zod schemas, built to dist/ (not raw-TS exports)
packages/import  Empty stub (package.json + src/index.ts) — S2 fills it in
docker-compose.yml   Postgres service for a future VPS — not used yet, not required for dev/test
.github/workflows/ci.yml   install -> build -> typecheck -> lint -> test, Postgres service container
```

## Verification

Run from repo root (Node >=20, pnpm; no Docker needed):

```
pnpm install
pnpm build       # -> all 4 packages build clean (shared, api, web, import)
pnpm typecheck   # -> all 4 packages clean
pnpm lint        # -> all 4 packages clean, 0 warnings (--max-warnings=0)
pnpm test        # -> 3 test files, 15 tests, all passing (see below)
```

Actual output at the end of this session:

- `pnpm build`: shared, import, api, web all `Done` (web: vite build, 406.92 kB / gzip 124.67 kB bundle).
- `pnpm typecheck`: all 4 packages `Done`, no errors.
- `pnpm lint`: all 4 packages `Done`, 0 errors/0 warnings.
- `pnpm test`:
  - `packages/shared`: `src/permissions.test.ts` — 4 tests passed (OWNER has every permission; INVENTORY/
    warehouse role can't see profit or payments, ported from legacy `19-collection-rbac.js`; no non-owner role
    has `PAYROLL_MANAGE`; every role's permissions are known `PERMISSIONS` entries).
  - `apps/api`: 3 test files, 11 tests, **all passed**:
    - `test/balance-trigger.test.ts` (2 tests) — a balanced `journal_entries`/`journal_lines` transaction
      commits; **`fails at commit when an entry's lines don't sum debit == credit` — PASSED** (this is the
      definition-of-done requirement: inserting an unbalanced entry inside a transaction fails at commit, with
      Postgres raising `journal_entries <id> is unbalanced: debit <n> <> credit <n>`).
    - `test/permission-guard.test.ts` (5 tests) — deny-by-default on an undecorated route; `@Public()` bypass;
      INVENTORY denied `PAYMENT_CREATE` (ported from legacy RBAC); MANAGER allowed `PAYMENT_CREATE`;
      `@SessionOnly()` bypass.
    - `test/auth.e2e.test.ts` (4 tests) — bad password rejected (401); correct password sets session cookie +
      `/auth/me` works; a mutating request without a matching CSRF header is rejected (401); **5 wrong
      passwords lock the account** (`lockedUntil` set, further attempts 401 "Account locked" even with the
      right password).
  - `apps/web`, `packages/import`: no tests yet (`echo` placeholders) — intentional for S1's scope, not a gap.
  - Duration: shared ~1s, api ~15-21s (embedded-postgres init + start dominates).

**Fresh migrate from empty, owner seed, trigger active** — verified manually against a persistent local
embedded-postgres (`pnpm --filter @farooq/api db:dev`, port 54329):
`pnpm db:migrate` then `pnpm db:seed` produced `role_permissions seeded: 37 rows across 4 non-owner roles, 21
known permissions.` and `Owner user created: owner (id 47aab688-...)`. A follow-up query confirmed one `users`
row (`owner`, role `OWNER`, active) and the `journal_lines_balance_check` trigger present in `pg_trigger`.

**Browser sign-in check** — done, not skipped. The Claude-in-Chrome extension wasn't connected in this
environment, so the `run` skill's Playwright fallback was used instead (see "Local-preview pattern" below):
started `pnpm --filter @farooq/api dev` (:3000) and `pnpm --filter @farooq/web dev` (:5173) against the
seeded dev DB, drove a headless Chromium to `http://localhost:5173`, filled in `owner` / the seeded owner
password, submitted, and landed on the authenticated shell (sidebar nav, top bar with role chip "Owner ·
Owner", dark-mode toggle, sign-out button, "Welcome" card). Screenshots confirmed real Tailwind styling, not
an unstyled scaffold. Two console messages appeared: an expected 401 (the app's own `/auth/me` probe before
sign-in, by design) and a 404 (the dev server has no `favicon.ico` — cosmetic, not a functional issue).

### Local-preview pattern (established this session, for future sessions to reuse)

No project skill existed for running this app. Established pattern, documented in `CLAUDE.md` under "How to
build / test locally":
1. `pnpm --filter @farooq/api db:dev` — persistent local embedded-postgres (separate from the throwaway
   per-test-run one), prints connection strings.
2. Copy `apps/api/.env.example` -> `.env` (and `apps/web/.env.example` -> `.env` if needed), fill in.
3. `db:migrate`, `db:seed`, then `apps/api dev` and `apps/web dev`.
4. Browser check: `npx playwright install chromium` once, then a short throwaway script
   (`chromium.launch()` -> `goto` -> fill `#username`/`#password` -> submit -> assert on shell text/screenshot)
   run from a scratch location, never committed. On this machine the npm-installed Playwright's expected
   browser revision didn't match the one already cached under `ms-playwright/`; passing `executablePath`
   pointing at the cached `chromium-*/chrome-win64/chrome.exe` worked around it — future sessions should just
   run `npx playwright install chromium` fresh and won't need that workaround.

## Deviations from the S1 plan (and why)

- **`packages/shared` builds to `dist/`, not raw TS exports.** Simpler and more robust than importing `.ts`
  directly from `node_modules` across NestJS's tsc build and Vite's dependency pre-bundling in a pnpm
  workspace. `dev` script (`tsc --watch`) added for local iteration.
- **shadcn/ui CLI was not run.** Given "no business screens yet," the sign-in page and shell use hand-rolled
  Tailwind v4 components (no Radix primitives needed yet — no dialogs/dropdowns/tables in this session's UI
  surface). shadcn's CLI (and its registry fetch) can be introduced in the session that first needs a
  Radix-backed component (dialog, combobox, data table) rather than scaffolding it unused now.
- **TanStack Router is code-based, not file-based.** No route-tree codegen step; `src/router.tsx` defines two
  routes directly. Simpler for two routes; revisit file-based routing if the route count grows enough to
  matter.
- **CSRF is a server-held synchronizer token, not a classic double-submit cookie.** Login returns `csrfToken`
  in the response body (never in a JS-readable cookie); the client holds it in memory and replays it via an
  `x-csrf-token` header on mutating requests, checked against the session row in Postgres. Reload re-hydrates
  it via a new `GET /auth/csrf` endpoint (`@SessionOnly()`, safe method, needs no CSRF header itself).
- **Login lockout: kept old behaviour, added a new layer rather than changing it.** Old app: 5 wrong
  passwords locks the *account* for 15 minutes, from any IP — a known, deliberately-not-fixed flaw, since
  `owner` is a guessable username and a stranger can lock the real owner out. Ported that exactly
  (`LOGIN_MAX_ATTEMPTS=5`, `LOGIN_LOCKOUT_MS=15min`, `users.failed_attempts`/`locked_until`). Added a
  **per-IP** throttle on `POST /auth/login` (20 attempts / 15 min, in-memory `LoginRateLimitGuard`) as the
  improvement the plan asked for — chosen over *replacing* per-account lockout with per-IP-only, because
  per-IP-only doesn't fix the guessable-username flaw either (an attacker with many IPs still locks the
  account) and would be a strictly different trade-off, not a strict improvement. Documented so a future
  session can revisit if the owner wants a different trade-off (e.g. CAPTCHA after N failures instead of a
  hard lock).
- **Session lifetime matches the old app's owner-requested behaviour, not "fixed."** 12h absolute cap
  (`SESSION_ABSOLUTE_TTL_MS`), **no idle timeout** — `last_seen_at` is updated on every request but never
  checked. This was a deliberate owner request in the old app (`idle_ttl_min = 0`); not contradicted here.
- **Receipt/document numbering (`sequences` table) is gap-meaningful, not a Postgres `SEQUENCE`.** Checked the
  old app's `FDB.nextNumber` (`erp-upgrade/01-db.js`): it increments a per-kind-per-year counter and the
  number is consumed even if the parent record then fails to save, so gaps in a printed number mean "an
  attempt happened," which the old app treats as acceptable/expected. Matched exactly: `sequences(kind, year,
  n)`, callers must increment under `SELECT ... FOR UPDATE` in the same transaction as the record being
  numbered. No caller exists yet (S1 has no invoice/purchase creation) — the table exists, the locking
  contract is documented as a code comment in `apps/api/src/db/schema.ts`, first real caller is S3/S4.
  Not yet covered by a test (nothing calls it yet); add one when the first caller lands.
- **`role` and other enum-shaped columns (`status`, `type`, `party_type`, `kind`) are plain `text`, not
  Postgres enums or CHECK constraints.** Avoids a second, DB-level copy of the role/permission list that could
  drift from `packages/shared`. Validated at the application boundary (Zod) instead. Noted as an intentional
  gap — a `CHECK` constraint mirroring the Zod enum would be a reasonable S2+ hardening if this bites us.
- **Money columns are Postgres `bigint`, JS `number` (not `bigint`) at the app layer.** CLAUDE.md rule #5 says
  "integer paisa (bigint), matching the old app's `amountP`" — the old app's `amountP` is itself a plain JS
  number of paisa. Paisa amounts for this business are nowhere near `Number.MAX_SAFE_INTEGER` (9e15), so
  Drizzle's `bigint({mode:'number'})` was used rather than JS `BigInt`, which would need serialization
  handling everywhere (JSON.stringify can't serialize BigInt) for no real safety benefit at this scale.
- **`@Inject(Reflector)` / `@Inject(AuthService)` used explicitly on guards and the auth controller**, instead
  of relying on TypeScript's emitted `design:paramtypes` metadata for implicit constructor-parameter DI.
  Vitest's esbuild-based TS transform does not reliably emit `emitDecoratorMetadata` output the way `tsc`
  does, so implicit-type injection silently resolved to `undefined` under the *test* runner (worked fine under
  `tsc`-built production code, but broke DI in `Test.createTestingModule(...)`-based e2e tests). Making the
  token explicit everywhere sidesteps the transform difference entirely — a real Nest+Vitest interaction, not
  a workaround for one test.
- **`fastify` is pinned to the exact version `@nestjs/platform-fastify` depends on (`5.11.3`)**, not a caret
  range. Without pinning, pnpm's non-hoisted install resolved two different `fastify` versions in the tree
  (ours vs. Nest's internal one), and `@fastify/cookie`'s `FastifyInstance` type didn't structurally match
  Nest's, breaking `tsc` builds. Pin + re-dedupe fixed it; revisit the pin when bumping `@nestjs/platform-fastify`.

## Known issues

- No component/e2e tests for `apps/web` yet (placeholder `test` script). Acceptable for S1 (no business logic
  in the UI yet beyond auth wiring, which is exercised indirectly by the manual browser check); should not
  stay a placeholder once real screens land in S2+.
- `packages/import` is an empty stub — by design, S2's job.
- The web bundle (406.92 kB / 124.67 kB gzip) is unsplit (single chunk) — fine at this size; revisit route-
  based code-splitting once there are enough routes for it to matter.
- CI (`.github/workflows/ci.yml`) has **not been run on GitHub yet** — this environment has no `gh`
  authentication / push access configured to verify a live Actions run. The workflow was written to mirror
  exactly what was run and verified locally (`install` -> `build` -> `typecheck` -> `lint` -> `test`, Postgres
  service container via `EXTERNAL_TEST_DATABASE_URL`), and the local `pnpm test` run using
  `EXTERNAL_TEST_DATABASE_URL` (pointed at the same locally-running dev Postgres, skipping the
  embedded-postgres bootstrap) was spot-checked to confirm that code path also works, but "CI is green on the
  pushed commit" specifically could not be confirmed from inside this session. **Next session (or the user)
  should check the Actions tab on the first push and report back if it's red.**

## Next step

Start **S2: importer + reconciliation** (`docs/sessions/S2.md` — not yet written; per `docs/ROADMAP.md` this
is the next session in M1). Bring this file's contents back to the planning-hub session first so S2's plan can
be written with accurate context of what S1 actually built (schema shape, auth patterns, the local-preview
pattern) — in particular the importer will need to map legacy IDs onto the `legacy_id` columns already present
on `users`, `customers`, `suppliers`, `regions`, `products`, `warehouses`, `invoices`, `purchases`, `returns`.

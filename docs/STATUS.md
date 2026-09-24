# Status

**Last updated:** 2026-09-24, by the **S6 session** (M2 part 1: invoice lines + stock quantities — data model, import, reconciliation). Milestone 1 is complete; **M2 (Invoices) is under way: S6 done, next S7.**

## S6 — what was done (M2 part 1)

Data only: no service, no endpoint, no screen changed. The database can now hold a sales invoice **as the legacy app has it** — full header, lines, and the stock it moved — and the importer proves the import is exact.

- **`@farooq/shared` `invoice-totals.ts`** — literal port of `Calc.line` / `Calc.invoice` / `Calc.paymentStatus` (`lineTotals`, `invoiceTotals`, `paymentStatusOf`, `grossOf`, `qtyToMilli` / `milliToQty`). Paisa in / out; **quantities are integer thousandths (`qtyMilli`)** so the legacy 3-decimal rounding is exact. One function for the importer's check, S7's service and S9's live preview.
- **Migration `0005_s6_invoice_lines_stock`** (generated part + hand-appended REVOKE / comments): `invoices` gains the whole header (charges, sub-totals, snapshots, `stock_applied`, **`migrated`**, `revision`, …) and a **partial unique index on `invoice_number`** (drafts NULL → any number of drafts); new `invoice_items`, `stock_movements` (**append-only** for `farooq_app`), `stock_levels` (product × warehouse × bucket, `stock` / `damaged`); `products` gains catalogue fields and the Prices-panel prices (`buy_p … reorder`, null = never set). CHECKs: qty > 0, money ≥ 0, discount ≤ gross, movement ≠ 0, bucket values.
- **`packages/db`** — `ledger.ts`: `INVOICE_SOURCE`, `invoiceLines`, `invoiceMemo`, `invoicePosts` (the importer now uses them; S7 will too). New `stock.ts`: movement kinds / ref types / buckets. No COGS / inventory journal (M4) — a sale is DR RECEIVABLES / CR SALES only.
- **Importer** — `invoiceItems`, `inventory`, `stockMovements` are now **imported**; `stockDocs` / `stockDocItems` stay deferred (their stock effect is already in the movements). Invoice header fields moved from `docOnly` to `mapped`; product catalogue + price fields mapped (mirrors `Prices.of`: `…P` wins when set, else the legacy rupee field through the strict parser). Fails loudly on an unknown kind / refType / bucket, dangling item / movement ids or invoice / purchase numbers, a quantity with more than 3 decimals, a fractional paisa, a discount above the gross, duplicate numbers / inventory pairs, zero movements. Movements link to their invoice / purchase by number (`source_type` / `source_id`); other ref types are carried by name. Migrated invoices are flagged and reported.
- **Reconciliation** gained three checks (same report, same non-zero exit): **invoice totals** (every non-draft invoice recomputed from its lines with the shared `invoiceTotals` vs the header and each line total), **stock** (legacy `inventory` = `stock_levels` = Σ `stock_movements`, per product × warehouse × bucket; the legacy `balanceAfter` chain gaps are informational), **invoice ↔ stock** (SALE_OUT + edit / cancel reversals net to −Σ lines; migrated invoices skipped). Real numbers are printed.
- **Fixture** — 8 invoices now have 11 lines (item discounts, an invoice discount, freight / loading / other, a taxed line, a fractional 2.5-bag line, two godowns), a DRAFT with lines and no number, a CANCELLED one whose bags came back, an EDITED one (reverse + re-deduct), a MIGRATED one without movements, DISPATCHED and PARTIALLY_RETURNED invoices (`returnedQty` 0.6), a damaged-bucket movement, a second warehouse, 4 inventory rows, 24 movements, and products with the panel fields / with only legacy rupee fields / with nothing. **Every S2–S4 hand-computed number is unchanged** (invoice grand totals kept; receivables 2,935,000, trial balance 9,305,000, 35 entries).

### S6 verification

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` all green locally, 0 lint warnings. **`pnpm test`: 687 tests** (541 before S6): `packages/shared` 132 (+34 `invoice-totals`), `apps/web` 62, `packages/import` **224** (+112), `apps/api` 269 (unchanged). **`pnpm e2e`: 70 passed** (3.1 min). Of the import total, 2 are `real-backups` (skipped without `data/`, so CI runs 222).

| new file | tests | what it pins |
|---|---|---|
| `shared/invoice-totals.test` | 34 | legacy T1 / T2 / T4 by hand, caps, tax rounding, fractional quantities, `paymentStatus` table, **3,000 random invoices vs an independent re-typing of the legacy formulas**, non-negativity / cap invariants |
| `import/invoice-lines-stock.test` | 34 | hand-computed header per invoice, every line field, draft / cancelled / edited / migrated / fractional / dispatched cases, product prices (both sources), stock levels and movements (kinds, links, costs), the printed report, DB rules (many drafts, unique number, CHECKs, **append-only `stock_movements` for the app role**), idempotent re-import, RETURNED invoice, balance-chain unit tests |
| `import/invoice-stock-fail-loudly.test` | 53 | every abort above, each leaving the database untouched |
| `import/invoice-stock-safety-net.test` | 23 | **every new check proven to bite**: a changed line price / discount / tax / line total / quantity / line count / legacy `discountAmount`, a cancelled invoice, a stock level, a movement changed / stray / re-pointed / deleted, the damaged bucket, a missing level, `stock_applied` flipped — each names the invoice or product and exits 1; drafts and migrated invoices are shown *not* to fail |
| `import/real-backups.test` | 2 | both newest real nightlies, local only |

**Mutation-style evidence:** the bite tests are the mutation checks for the reconciliation (damage the data, confirm red, the report names it). The importer classification was itself exercised by the real data: the first run on the 2026-09-23 nightly **aborted on three new fields** (see Findings) — the fail-loudly guarantee working on real change.

**Real backups** (throwaway Postgres, `runImport` + `reconcile`; counts and totals only):

| | 2026-09-22 nightly (v505) | **2026-09-23 nightly (v692, newest)** |
|---|---|---|
| customers / suppliers, balance differences | 409 / 35, **0** | **409 / 35, 0** |
| receivables old = new | 92,390,000 | **2,234,290,000** |
| payables old = new (net / owed > 0) | 604,000,000 / 604,000,000 | **554,000,000 / 604,000,000** |
| trial balance | 24 entries, 48 lines, 1,146,390,000 BALANCED | **42 entries, 84 lines, 3,673,410,200 BALANCED** |
| statements | 444 parties, 0 mismatches | **444 parties, 0 mismatches** |
| invoices checked / lines / bags / **total mismatches** | 12 / 13 / 330 / **0** | **17 / 18 / 910 / 0** (0 drafts, 0 without lines, 0 migrated) |
| stock rows / movements / bags in stock + damaged / **mismatches** | 12 / 38 / 2,811 + 0 / **0** | **15 / 48 / 17,331 + 0 / 0** |
| invoice ↔ stock: invoices / invoice movements / **mismatches** | 12 / 17 / **0** | **17 / 24 / 0** (the 3 `INVOICE_EDIT` reversals net out) |
| legacy balance-chain gaps (informational) | 0 | 0 |
| store counts | all imported stores match | all match (invoiceItems 18, inventory 15, stockMovements 48) |

So the planner's targets hold: on the newest real backup **0 balance / 0 invoice-total / 0 stock / 0 invoice ↔ stock differences**. (The 09-23 nightly has 5 more invoices and 13 more payments than 09-22, so its receivables are larger — same on both sides of the comparison.)

### S6 deviations from the plan

1. **`weight_kg`, `discount_pct`, `tax_pct`, `reorder` are `double precision`**, not `numeric`: this drizzle version's `numeric` returns strings, and none of them is money. Prices stay `bigint` paisa.
2. **`stock_movements` has no line-level source column** (the plan's "`INVOICE_ITEM` line id where known"): `source_id` is the invoice id. S7 can add `source_item_id` if it needs it (recorded in `docs/sessions/S7.md`).
3. **Movements from other documents** (stock receipts, transfers, returns, milling, write-offs, the old `moveStock` labels) are imported with `ref_type` / `source_type` and **no linked id** — those documents are M4 / M5 / M8. Only invoices and purchases resolve, and an unresolvable reference aborts.
4. **`invoices.migrated` (boolean) added** (not in the plan's column list) so S7 can tell migrated invoices from a flag instead of inferring it from missing movements.
5. **A mismatch on a migrated invoice is informational** (listed, not failed): its totals came from the old single-product sale record, never from `Calc`. None exist in the real data. Non-migrated mismatches fail.
6. **The invoice ↔ stock check also covers cancelled invoices and drafts** (expected net 0), not only "posted, stockApplied": a cancelled invoice whose bags did not come back is caught.
7. **Legacy movement `unitCostP` 0 is stored NULL** ("no cost recorded"), which is the legacy `!(unitCostP > 0)`; a line's `costSnapshot` 0 stays 0.
8. **`customerReturnItems` reason text** now says M5 (returns), as the roadmap does; still deferred.
9. **e2e / API synthetic backup** (`apps/api/test/helpers/synthetic-payments.ts`) also empties `stockMovements` (it inherited the fixture's movements, whose invoices it replaces). Its balances are unchanged. Its 96 invoices have no lines (listed, not failed); S9 will need a richer e2e dataset.

### S6 findings worth knowing

- **The 2026-09-23 nightly has three fields the 09-22 one lacked** — `regions.updatedAt`, `customers.salesmanId`, `customers.limit` (old-ERP master-data work). The importer aborted on them, naming store + field, exactly as designed; they are now `docOnly` (kept in `legacy_doc`, unused). Logged in `docs/PARITY.md`. The old repo did not log them there.
- **Two of my own hand counts were wrong** while writing the tests (SALE_OUT 11 not 8; costed movements 5 not 7); the importer's numbers were right and the independent recount confirmed them — the tests now say the recounted values.
- **Tooling:** shell heredocs / `node -e` still mangle backticks, apostrophes and `\`; write scripts with the Write tool and edit CRLF files (`prepare.ts`, `classification.ts`, …) through the Edit tool or a CRLF-aware helper. One `sed` with a backtick pattern prefixed a backtick to every line of `prepare.ts` (caught by `git diff`, reverted).
- `invoiceTotals` uses `Math.round(unit × (qtyMilli / 1000))` (the legacy float multiply) rather than exact integer arithmetic, on purpose: it reproduces the legacy result even in a half-paisa float edge; the DB CHECK on discount ≤ gross uses exact arithmetic (equal except in a pathological one-paisa float case, which would abort the import loudly).

### S6 not done / known issues

- Not seen by a person, not a service: nothing creates or edits an invoice yet (S7). `costOf`, `avgCostP` maintenance, COGS (M4); purchase lines (M3); return lines (M5); stock documents (M4) are all still deferred and only counted.
- The reconciliation's stock check relies on the legacy `inventory` rows being *right*; it proves the import is faithful, not that the old app's stock was correct.
- `pnpm test` in CI runs 222 import tests (the 2 real-backup tests skip).

## Current state (as of S5 — screens; S6 added no UI)

S1 (scaffold, DB, auth), S2 (importer + reconciliation), S3 (Payments service + API), S4 (search / statements / receipt model, server) and **S5 (the screens and the
browser tests)** are done. A signed-in person can now, in `apps/web`:

- **Payments** (`/payments`): search box (words in any order, Urdu letter variants, typed dates — the server reads the box and the screen says how: "“12/09/2026” is read as 12 Sep 2026 (day / month / year)"),
  "Search in" scope, sort, five tabs with server counts (All / Received from shops / Paid to shops / Paid to suppliers / Reversed), Date presets + custom range, method, region, amount from-to,
  50 per page, the "n of N payments match" line, **Export CSV** (every match), empty / error / loading states. Cards on a phone, a table from 768 px.
- **Five actions:** Receive payment (shop picker that starts on "— Choose a shop —", live oldest-first allocation preview, or manual per-invoice amounts capped at each outstanding),
  Pay supplier, Pay a shop (says the balance it will leave), Reverse (states its effect first, reason required), Edit amount (refusals shown disabled with the server's own reason).
- **Voucher page** (`/payments/:id`) with the corrections, and the **printable receipt / voucher** (`/payments/:id/receipt`): company header, party block, allocations, amount and amount in words,
  previous / remaining balance, signature lines, a REVERSED stamp. **A4 portrait, one page**, paper colours fixed in any theme, Urdu labels, no external fonts.
- **Statements** (`/statements`): shop / supplier toggle, area, party picker, date presets, opening / rows / totals / closing in words ("Shop owes us …", "We owe the shop … (credit)", "Cr" / "Dr" marks),
  "n reversed vouchers are not shown", print layout (header repeats per page), Download CSV. Cards on a phone.
- Role behaviour: OWNER / MANAGER / ACCOUNTANT everything; SALES receives but has no pay-out / reverse / edit; INVENTORY has no Payments / Statements in the nav and gets
  "Not available for the Warehouse role" on a direct URL. Modules that do not exist yet show as disabled "Soon".

Nothing is deployed; the live ERP is untouched.

### Repo layout (as built)

```
apps/api         NestJS 11 + Fastify (S1-S4). S5 change: CORS now exposes Content-Disposition (see Findings).
apps/web         React 19 + Vite + TanStack Router / Query. src/lib (pure logic + tests), src/components, src/routes. Vitest + Testing Library (S5).
apps/e2e         NEW (S5). Playwright: setup/ (throwaway Postgres → import → users → built API + built web), tests/*.spec.ts. Gitignored: .run/, e2e-artifacts/.
packages/shared  Permissions, Zod schemas, business-date helpers, fold / search-query / money; S6: invoice-totals (Calc port).
packages/db      Drizzle schema, migrations 0000-0005 (S6: invoice lines, stock), client, test harness; ledger.ts + stock.ts.
packages/import  importer, LegacyLedger, reconciliation (S6: invoice totals + stock checks), fixtures.
```

## Verification

From the repo root: `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` — **all green, 0 lint warnings.**

- `pnpm test`: **541 tests** (479 before S5): `packages/shared` 98, `packages/import` 112, `apps/api` 269 (all unchanged) and **`apps/web` 62 new**:

  | file | tests | what it pins |
  |---|---|---|
  | `lib/allocation.test` | 13 | preview = server rule; **2,000-case seeded property** (never over-allocates, conserves the money, oldest first, equals an independent copy of the server rule); manual caps; 1,000-case property |
  | `lib/payment-filters.test` | 15 | URL ↔ filters (defaults leave the address, hostile addresses sanitised, router-parsed numbers), filters → API query (status on every tab, paisa via `parseRupees`, presets, export = same filters without paging), "read as" sentence |
  | `lib/periods.test` | 6 | week = Monday..today, last month (incl. Feb / leap / January, the legacy Jul 31–Aug 30 bug), 30 / 90 / 365 days |
  | `lib/access.test` | 5 | permission matrix in the UI: nav per role, canReceive / canPayOut / canCorrect |
  | `components/panels.test` | 12 | **never pre-selected**, Save off until party AND valid amount, typing un-chooses the party, live preview, manual cap + "manual needs at least one amount", double-click → one POST with an idempotency key, 422 shown line by line, refund confirmation line, Urdu shop |
  | `lib/api.test` | 11 | 422 `{message, errors[]}` keeps every line, network failure, 401 handling, CSRF header, schema-mismatch fails loudly, error renderer, balances in words |

- `pnpm e2e`: **70 Playwright tests in Chromium, all passing** (~2.8 min), against the built API + a fresh build of the web app + a throwaway Postgres loaded with the e2e dataset
  (S4's seeded 300-payment synthetic backup + 10 hand-made shops with known invoices; the importer **reconciles it before any screen test runs**):

  | spec | tests | covers |
  |---|---|---|
  | `auth-nav` | 7 | real sign-in for each role, nav per role, "Soon" entries disabled, INVENTORY blocked on 4 URLs, wrong password, sign-out, session ended mid-use → back to sign-in |
  | `payments-list` | 14 | tab counts = server facets, paging (address survives reload / Back), sorts in server order, multi-word AND, Urdu ک/ك ی/ي, typed day-first date + "replaces the date filter", scopes, amount range, "can never match" banners, debounce (≤ 2 requests), Clear filters, empty state, region, **CSV (BOM, file name, rows = API)**, Urdu names |
  | `receive` | 10 | nothing pre-selected / Save refused; **auto allocation (preview = server result = receipt = statement closing)**; manual allocation caps; API-level over-cap refusal + UI shows a refusal verbatim; **double-click Save → one voucher**; idempotency replay; default date = Karachi business date under a New York browser clock; Pay supplier; Pay a shop; SALES receives but gets no pay-out |
  | `correct` | 5 | Reverse (effect stated, reason required, balance restored, statement omits it, Reversed tab +1, second reverse impossible in UI and API), Edit amount, refusals with the server's reasons (reversed / money received / allocated supplier payment), SALES has no corrections (API 403), unknown voucher |
  | `receipt-print` | 6 | **PDF read back with pdf.js**: one page, number / amount / amount in words / company / balances present, app chrome absent; dark-theme screen still prints black-on-white; supplier voucher; reversed voucher stamped without balances; every voucher of the fullest + Urdu-named ones = one page; statement header repeats |
  | `statements` | 7 | on-screen rows / totals / opening / closing **equal the API** (full range and a window), supplier statement, credit balance in words + "Cr", omitted-reversed note, area filter + address state + Clear + bad range, preset = 365 days, CSV |
  | `visual` | 21 | 20 screens × (desktop 1280, phone 390, dark, phone-dark): no page-level horizontal scroll, nothing sticking out of the phone screen outside a scroll box, dialogs inside the viewport, **no console errors**; + sign-in |

- **Mutation checks** (broke a rule, confirmed red, restored, re-ran green): allocation takes full outstanding instead of `min`; manual cap loosened; week starting Sunday; last month end wrong; a tab asking `direction` instead of `status`;
  Save enabled without a party; typing not un-choosing the party; `balanceCell` treating zero as a credit (**not caught at first — a real gap, test added**); the debounced search using stale filters (caught by `payments-list › 'Search in'`; the bug was real, see Findings).
  One mutant survives on purpose: removing the in-flight `busy` ref from Save — the disabled button + the idempotency key still make a second post impossible (defence in depth, not separately observable).
- **Importer + reconciliation regression** (throwaway Postgres, `runImport` + `reconcile`, exit code 0 both times; the real file is `data/business-20260922-210002-v505-6a81.json`, the newest on this machine):

  | | fixture (synthetic) | real backup (2026-09-22 nightly) |
  |---|---|---|
  | customers / suppliers | 6 / 5, **0 differences** | **409 / 35, 0 differences** |
  | receivables old = new | 2,935,000 | 92,390,000 |
  | payables old = new (net) | 1,312,000 | 604,000,000 |
  | journal / trial balance | 35 entries, 70 lines, 9,305,000 = 9,305,000 BALANCED | 24 entries, 48 lines, 1,146,390,000 = 1,146,390,000 BALANCED |

  Identical to S2-S4. The e2e dataset (≈ 300 payments + the hand-made shops) also reconciles in global setup on every run. **Caveat carried from S2:** the real backup has 7 payments, no returns / reversals /
  adjustments / milling — those branches are proven by the fixture and tests, not real data.

### Milestone 1 in one paragraph (for a fresh reader)

The legacy ERP's money-in / money-out area now exists on the new stack end to end: `packages/import` reads a nightly backup and its reconciliation shows **0 balance differences for all 409 shops and 35 suppliers**
(receivables 92,390,000 and payables 604,000,000 paisa equal on both sides, trial balance balanced) — S2. The API posts every payment as a balanced journal entry with the legacy rules and tests (S3), searches / totals / prints them
from the journal, and every statement equals the legacy ledger on the fixture and on the real backup (S4). S5 put screens on it and proved them in a real browser. **What M1 does not claim:** no person has used it, the real backup is thin,
nothing is deployed, and the old ERP remains the only system of record.

## Screenshots reviewed (`apps/e2e/e2e-artifacts/`, gitignored; 86 PNGs + the PDFs) — what I saw and fixed

I opened: payments list (desktop, phone), receive panel (phone-dark), receipt (dark desktop, A4 print preview, reversed print preview), statement (phone, three iterations), voucher page (phone-dark), reverse dialog (phone).
Defects found by looking, all fixed and re-shot:
1. **Phone payments table** showed only receipt / date / party — the amount was off-screen to the right → replaced by **one card per payment** on < 768 px.
2. **Phone statement** had the same problem, then a squeezed version broke words and split amounts across two lines → replaced by **entry cards** (date, description, ref, debit / credit, running balance) under 640 px; the table stays for ≥ 640 px and for print; `.num` never wraps.
3. **Receipt printed a bare "PKR -2,940.00"** for a credit → now "PKR 2,940.00 Cr" (customer) / "Dr" (supplier); the words line beside it stays.
4. Urdu names right-aligned inside left-aligned blocks (receipt, statement, voucher page) → `text-left` with `dir="auto"`, so the block stays tidy and the Urdu still shapes correctly.
5. Receipt numbers wrapped in the table ("REC-2026-\n000133") → `nowrap`; empty Method / Reference / Note on the voucher page now show "—".
Not defects: a dialog's dark backdrop covers only the first screenful in a *full-page* screenshot (a capture artefact); the Urdu glyphs render (a font with Arabic-script coverage exists on this machine — see "not seen").

## What S5 built

- **Web foundations:** typed API client (`lib/api.ts`: Zod-checked answers, `ApiError.lines` = every `errors[]` line, 401 → sign-in, network failure → a retry message, CSRF), typed queries (`lib/queries.ts`), TanStack Query with
  `keepPreviousData` (the table keeps its rows while the next answer loads) and request cancellation. Screen state lives in the **URL** (`?q=&tab=&page=&sort=…`, `?type=&partyId=&from=&to=` for statements): reload and Back keep the screen.
  Primitives are hand-rolled (`components/ui.tsx`): buttons, fields (the error sits outside the `<label>` so it never pollutes the accessible name), banners, badges, native `<dialog>` (focus trap, Esc, inert page), toasts, ARIA combobox.
- **Money / date at the edge only:** rupees ↔ paisa via `parseRupees` / `formatPaisa*`; "today" via `businessDateOf`; presets by calendar arithmetic (`lib/periods.ts`), never `toISOString()`; idempotency key from `crypto.randomUUID` with a `getRandomValues` fallback (http on a LAN has no `randomUUID`).
- **Files:** `apps/web/src/{router.tsx, lib/*, components/{ui,party-combobox,payment-panels,correction-dialogs,guard}.tsx, routes/{shell,dashboard,payments,payment-detail,receipt,statements}.tsx}`, `apps/e2e/**`, CI steps (Chromium install, `pnpm e2e`, artifact upload).

## Deviations from the S5 plan / the legacy

Owner-visible behaviour is marked **(owner)**.

1. **No shadcn CLI:** hand-rolled Tailwind primitives (native `<dialog>`, ARIA combobox). Same accessibility goals (focus-trapped dialogs, visible focus rings, labels tied to inputs); fewer moving parts. `CLAUDE.md` updated.
2. **Tabs ask for `status` too**, so a tab's number and its rows are always the same set; reversed vouchers appear only under **Reversed** (rows struck, "Reversed" badge). All = the three POSTED kinds.
3. **Reverse / Edit amount live on the voucher page**, not on list rows: only the detail knows what the server will allow. **(owner)** The list has "Open" and "Receipt / Voucher" links.
4. **"Leave on account" is not offered** as a separate Apply-to mode: the API treats an empty allocation list as *automatic*, so it cannot be expressed. Manual mode with nothing entered is refused for the same reason. Money beyond the invoices stays on account automatically.
5. **No "Description / تفصیل" box** on the panels: the API has no such field (S4 deviation 5). **No supplier purchase allocation** in Pay supplier (plan: default off; the API supports it — a later UX decision).
6. **Edit amount is only for money paid out** (the legacy rule): a received voucher shows the button disabled with the server's reason ("Only a voucher paid to a shop or a supplier can have its amount corrected here."). My first e2e draft assumed otherwise and failed — the app was right.
7. **Statements need a shop / supplier first** (nothing shown until chosen); an impossible custom range shows a banner and asks the server nothing (the picker then has no name to show after a reload — it is named by the statement it loads).
8. **Receipt = A4 portrait** (`@page A4`, 12 mm margins). Statement print = same page setup; the table header repeats per page.
9. **API change (small, needed by the UI):** `enableCors({ exposedHeaders: ["Content-Disposition"] })` so the browser can read the CSV's file name across origins. Found by the e2e download test.
10. `apps/e2e` is a new workspace package (not in the original layout); `pnpm e2e` at the root runs it.

## Findings worth knowing

- **Stale-closure bug caught by e2e:** a debounced search box captured the filters of the render it was set in, so changing "Search in" within 250 ms of typing was silently undone when the timer fired. Fixed with a `latest` ref; covered by `payments-list › 'Search in'`.
- **CORS hides `Content-Disposition`** from `fetch` unless exposed — the CSV came down as `download.csv` until fixed.
- **Editing tools decode `\uXXXX`** (S4 finding, hit again): a raw BOM ended up in `statements.tsx`; it now builds it with `String.fromCharCode(0xfeff)`, and `grep` for zero-width characters in `apps/web/src` is clean. Also: shell heredocs / `node -e` strings mangle backticks and `\` — write files with the Write tool.
- **Router:** TanStack's default search-param codec JSON-encodes values (a search for `123` becomes a number). The app uses a plain `URLSearchParams` codec; each screen parses its own address.
- **Playwright quirks:** `page.getByLabel("From")` also matches "Amount from" (use `exact`); `getByRole("option")` also matches `<select>` options (scope to the listbox); a `<label>` that contains its error message names the control wrongly.
- Specs run **strictly one at a time in file order on one database** and each money-moving test owns a shop, because the receive test's exact balances (60,000 → 35,000) broke once when another spec paid Alpha. The API's login throttle (20 / 15 min / IP) is why sign-in specs are few and everything else reuses storage states.
- A killed e2e run leaves postgres on :55433 and node on :3100 / :4173 — stop them by hand (documented in `CLAUDE.md`).

## Not yet seen by a person (explicit)

- **Any real staff use**; a real phone (only a 390 px emulated viewport); **Firefox, Safari**, Edge.
- **Real printer output.** The PDF Chromium prints was read back (one page, text present) and the A4 preview screenshot was looked at, but no sheet has been printed and looked at. The A4 page layout has not been checked against the shop's printer.
- **The Urdu font on other machines.** The stack is system fonts only (`system-ui, Segoe UI, Tahoma, Noto Naskh Arabic, Noto Nastaliq Urdu…`); on this Windows machine the glyphs render, but a phone or a machine without an Arabic-script font could show boxes in print and screen.
- A **real nightly with returns, reversals, adjustments, milling** through the screens (the real backup has none; those flows are proven by the fixture / API tests and, for reversals, the e2e dataset).
- A person's walk-through of the **owner-visible changes** above, and of what a busy day's list feels like (the dataset has 300 payments, the business a few dozen a week).
- Keyboard-only and screen-reader use were designed for (native dialog, ARIA combobox, labels, `role=alert`) but not audited with assistive technology.

## Known issues / not done

- The web bundle is one 505 kB chunk (no code splitting yet; Vite warns). Fine for now.
- Statement rows use the legacy `Ledger` descriptions; the display-time decoration of `24-client-changes.js` and the Qty column remain unported (S4 deviation 5; needs invoice items, M2).
- A statement's picker shows no name after a reload while the range is impossible (deviation 7).
- The three provisional accounts and the deferred `auditLog` store are unchanged from S4. Scale notes from S4 stand (comfortable to thousands of vouchers).
- Owner decisions still open: paper-book figures / cutover date (old repo's `CLAUDE.md` item 1); S3 items 1 / 2 / 9 below; whether INVENTORY should see `/company`; whether SALES should pay out.
- `docs/PARITY.md`: Payments / search / statement / receipt rows are **ported**; none is **verified** — verified needs a person's walk-through or a reconciliation after real use, and neither has happened for the screens.

### Carried from S3 / S4 (still in force)

1. **(owner) `PAYMENT_PAYOUT`** gates pay and refund; SALES can receive but not pay out (add `"PAYMENT_PAYOUT"` to SALES in `packages/shared/src/permissions.ts` to restore). 2. **(owner)** explicit allocations are capped on the server.
3. **(owner)** a second reverse is refused. 4. Reverse keeps allocation rows. 5. Idempotency key (8-100 chars; same key ⇒ first voucher, HTTP 200). 6. `editAmount` rewrites the voucher's one journal entry in place.
7. Reversal entry dated like the original; no period locking. 8. Reversing a customer-return refund voucher is allowed. 9. Picker lookups need `MASTER_DATA_VIEW`.
10. `receivedBy` = the session user's name, default method `Cash`, prefixes `REC` / `PV`. 11. Zod failures are HTTP 422 `{message, errors}`. 12. Statement order, reversed-voucher omission, receipt balances = running balance around the voucher's own row,
snapshots, search punctuation is a separator — see `docs/PARITY.md` "Search, statements, receipts — ported in S4".
- Money is `bigint` in Postgres and a plain JS `number` of paisa in the app. Login lockout = 5 wrong passwords / 15 min plus a per-IP throttle; 12 h session cap; CSRF header `x-csrf-token`. Guards / controllers use explicit `@Inject(...)`.
  `packages/*` build to `dist/` — **run `pnpm build` before `pnpm test`**. Windows embedded-postgres clusters must be UTF8. The importer wipes business + ledger tables, is local-only and aborts on any unknown store / field. CRLF warnings from git are normal here.

## CI run

**S6: green** on commit `1e8364f`: [run 35961659523](https://github.com/talhaazhar-ta/farooq-erp-next/actions/runs/35961659523) — install, build, typecheck, lint, test (real Postgres service container; the 2 real-backup tests skip), Chromium, `pnpm e2e` (70) all passed.

Earlier — **green** on the S5 commit `45fc437`: [run 35952737035](https://github.com/talhaazhar-ta/farooq-erp-next/actions/runs/35952737035) — install, build, typecheck, lint, test (541 tests, real Postgres service container via `EXTERNAL_TEST_DATABASE_URL`), Chromium install, **`pnpm e2e` (70 Playwright tests on ubuntu-latest, same container)** and the artifact upload all passed. The real-backup datasets are skipped in CI (the file is gitignored); the e2e dataset is synthetic.

## Next step

**S7 — Invoices service + API** (`docs/sessions/S7.md`, corrected to S6's real schema; the hub should re-read this file and finalise it first). It builds on `invoiceTotals`, `ledger.ts` `invoiceLines`, `stock_levels` / `stock_movements`, the `migrated` flag and the reconciliation checks. Still open from M1: a person walking the screens and printing a receipt, and the owner questions listed above.

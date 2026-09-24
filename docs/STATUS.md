# Status

**Last updated:** 2026-09-24, by the **S8 session** (M2 part 3: invoice search, print model, profit, statement detail — server + shared). Milestone 1 is complete; **M2 (Invoices) is under way: S6, S7 and S8 done, next S9 (the screens).**

## S8 — what was done (M2 part 3: reading invoices — server side only, no screen changed)

A person with the right role can now, through the HTTP API, list and search invoices exactly as the legacy list did (module 33), export the list as the legacy CSV, get the printed invoice as one document model that both layouts render
(classic first — it is the live setting — and the standard one, from the same model), and see an invoice's profit if they hold `PROFIT_VIEW`. Statement rows and the Receive panel's outstanding invoices say what an invoice was for. The live ERP is untouched; nothing is deployed.

**Step 0 (its own commit, `ac5fb37`)** — owner decision 2026-09-24: anyone holding `SALES_CREATE` may **discard a DRAFT** (`POST /invoices/:id/cancel` needs `SALES_CREATE` **or** `TRANSACTION_CORRECT` for a draft; a posted invoice still needs `TRANSACTION_CORRECT`;
`actions.cancel` follows the same rule). INVENTORY is still refused; a draft has no stock, journal or money, so nothing else moved. The S7 tests that assumed the old rule were changed deliberately (`invoices-cancel` › who may — now three tests, `invoices-permissions` › a new draft-discard matrix, `invoices-reads-duplicate` › `actions.cancel` for SALES on a draft and on a posted invoice).

### What exists now

- **`GET /invoices`** (`apps/api/src/invoices/invoices.search.ts` + `invoices.list.ts`): words (AND, any order), typed dates (a date in the box is a filter, replaces from / to, and is echoed in `interpreted`), the seven scopes (`all number customer product amount payment notes`), filters (`status regionId warehouseId from to minP maxP`), the five sorts
  (`newest oldest high low due`), paging, `interpreted` + `problems` (a From after To or a min above max is said out loud and the list is empty on purpose), the four **cards** (`kpis`: count / invoiced / received / outstanding over the whole filtered list, **drafts and cancelled left out; `drafts` counts every draft on file**), **counts per status** under every filter except the status one (`statusFacets`),
  `onFile`, and per row `hits` ("why it matched": product lines with bags, "Paid by REC…"). Source is `invoices` + allocations — never the journal. `paidP` / `outstandingP` use the same definition as the detail and S3 (POSTED receipts; minus non-cancelled return credit).
- **`GET /invoices/export.csv`** — the legacy columns and file name (`farooq-co-invoices-<business date>.csv`), every match (no paging), BOM, CRLF, all cells quoted, spreadsheet-injection guard, plain-rupee money; the same `csvCell` as the payments CSV.
- **`GET /invoices/:id/print?template=classic|standard`** (`invoices.print.ts`) — ONE model (`invoicePrintSchema`) that both layouts render: company block, bill-to as printed, meta rows, lines with the legacy text ("5 Bags", "1 Bag", "—"), totals rows only when not zero, grand total / amount paid / balance on this invoice with the Urdu labels, amount in words (the shared `amountInWords`),
  receipts applied (POSTED only), the previous balance (frozen) and the current outstanding (live), signatures, footer / terms / bank details from the settings, **and the classic block**: `InvNo` = `<salesDocPrefix>-` + the trailing digits to six places, the shop's **last six ledger rows up to and including this invoice** (from the S4 statement builder — not a second implementation), and the totals box
  (Gross / Opening / Total / Cash / blank / Balance). A draft prints as "DRAFT" with no number (`hasNumber: false`), a cancelled invoice has `cancelled: true` for the stamp. **Built: both layouts** (classic first; the standard one costs nothing extra because the legacy classic layout is a block on the same model). `template` is the one asked for, else the business's `invoiceTemplate` setting, else `classic`.
  All labels and Urdu strings are constants in `@farooq/shared` (`INVOICE_PRINT_LABELS`, `CLASSIC_LABELS`, `INVOICE_STATUS_LABELS`, …) and a test proves each occurs verbatim in the legacy source.
- **Profit** — `GET /invoices/:id/profit` (`PROFIT_VIEW` only: 403 otherwise) and a `profit` block in `GET /invoices/:id` **present only for a role with `PROFIT_VIEW` — the key does not exist in the JSON for anyone else**. Definition in `packages/shared/src/profit.ts` (see "Profit definition" below).
- **Statement rows** (additive, S5 untouched): an invoice row gains `detail` (what was typed, else "200 × Name pack @ PKR 2,700" / "N items — X total qty", else "Sale invoice <number>"), `qtyInfo {total, mixed}` and `qtyLabel` ("500", "500 (mixed units)", "—"); every other row has `detail: null`, `qtyInfo: null`, `qtyLabel: "—"`.
  **`outstanding-invoices`** rows gain `lineSummary` (same wording).
- **Migration `0007`** (`packages/db/migrations/0007_s8_invoice_search.sql`, generated by drizzle-kit plus a hand-written head): the six-argument `search_join`; generated stored columns `invoices.search_numbers / search_customer / search_amount / search_date / search_other` and `invoice_items.search_text`; and `journal_entries.created_at` now defaults to `clock_timestamp()` (see Findings — a real bug).
- **`@farooq/shared`**: `line-summary.ts` (`lineSummary`, `qtyInfoOf`, `qtyLabelOf`, `invoiceRowDetail`, `cleanDescription`, `formatQtyMilli`), `profit.ts` (`profitOfLine`, `profitOfInvoice`), `schemas/invoice-list.ts`, `schemas/invoice-print.ts`.

### Profit definition (owner-visible; adopted per planner decision 3, both numbers documented)

- **Adopted:** goods margin net of the discount actually given. Line revenue = line total **minus its tax** (= gross − line discount); line cost = `round(cost snapshot × qty)`; invoice profit = Σ (revenue − cost) − invoice discount. Freight / loading / other charges and tax are not margin.
  A line with an unknown cost (`cost_snapshot_p` null or 0) is `costKnown: false`, has **no** profit / margin / markup (never "as if it cost nothing"), stays out of the margin %, and the invoice discount is shared over the known lines in proportion to their revenue (all of it when every cost is known); `complete` / `unknownCostLines` say so. No line with a known cost → `profitP: null`.
- **Legacy `Profit.invoice`:** grand total − Σ cost (unknown = 0). Kept only as `legacyProfitP` inside `profitOfInvoice` for tests; the API never sends it (test: no "legacy" in the response).
- **Where they differ (hand-computed in `profit.test`, `invoices-profit`):** on a fully-costed invoice legacy − adopted is **exactly tax + freight + loading + other charges** (the planner's note said the legacy "ignores the invoice discount" — it does not: the grand total already has it subtracted); with an unknown-cost line the legacy counts those bags as free profit (example: 3,450,000 − 2,400,000 = 1,050,000 against an honest 514,286 on the known goods).
- **Deviation from the plan's formula text:** the plan wrote "Σ (`lineTotal` − cost × qty) − invoice discount" but also "charges and tax are excluded"; `lineTotal` includes the line tax, so the literal formula would count tax. I followed the stated intent (tax excluded). One-line change in `profitOfLine` if the owner wants the other.

### S8 verification

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` all green locally, 0 lint warnings. **`pnpm test`: 954 tests** (844 before S8): `packages/shared` **151** (+17), `apps/web` 62, `packages/import` 224, `apps/api` **517** (+93). **`pnpm e2e`: 70 passed** (2.7 min; no screen changed, the S5 screens read the additive statement fields without a change). 222 of the import tests run in CI (2 real-backup tests skip without `data/`); in `apps/api` the real-backup datasets of `invoices-search-parity` and the whole `invoices-labels-verbatim` file (needs the old repo checked out next to this one) skip in CI.

| new / changed file | tests | what it pins |
|---|---|---|
| `api/invoices-search-parity` | 21 | **the proof**: `GET /invoices` = the legacy algorithm (a literal JS port in `helpers/legacy-invoice-search.ts`, importing nothing from the code under test) — same ids, same order, same totals, same four cards, same status counts, same reading of the box, **same "why it matched" hints** — over three datasets, each imported through the real importer; the paging walk; row figures; **and each dataset reconciles (0 differences)** |
| `api/invoices-list` | 18 | the fixture's 8 invoices worked out by hand: cards (6 live / 3,550,000 invoiced / 950,000 received / 2,460,000 owed / 1 draft), counts per status, every sort incl. `due` (drafts and cancelled last), every filter, the problems, a typed date replacing from / to, current-name vs printed-name search, **the receipt-number-only-in-its-scope rule** (`000003` finds the cancelled INV-…03 in Everything and the receipt-paid INV-…05 only in the payment scope), reversed receipts not searched, hints; plus invoices made through the API (cheque reference in Everything, receipt number only in its scope, reversed receipt stops being found, cancelled leaves the cards, a word the shop explains is not "why") |
| `api/invoices-csv` | 6 | columns, file name (business date), BOM / CRLF / quoting, hand-computed rows for draft / cancelled / dispatched / fractional, filters and "every match", injection guard, quotes / commas / Urdu, 422s |
| `api/invoices-print` | 16 | one hand-computed shop (I1 1,000,000; receipt 300,000; I2 347,000 with every charge and 47,000 paid at the sale; I3): identity, bill-to, meta, company / footer, columns and rows ("5 Bags", "1 Bag", "—"), **the totals rows one rule per row**, words, receipts (reversed not listed), ledger box (frozen vs live), classic serial / `SLV-` / prefix setting, "Nil" contact, **the last-six ledger rows up to this invoice**, the totals box, draft, cancelled, template choice, 404s, no cost/profit key |
| `api/invoices-profit` | 8 | adopted numbers by hand (514,286 / 17.65 %, unknown-cost line flagged), tax and charges excluded, snapshot re-taken on edit only, `legacyProfitP` never sent, **403 for SALES / INVENTORY and the JSON keys absent — the detail, print, list and CSV header scanned for cost / profit / margin keys** |
| `api/statements-invoice-detail` | 9 | `detail` / `qtyInfo` / `qtyLabel` for one line, fractional + paisa rate, typed description (cleaned), several lines, mixed units, imported invoice without lines, payment rows show none, cancelled invoice has no row; **invoice before its own sale receipt, six times over**; Receive panel `lineSummary` |
| `api/invoices-s8-permissions` | 8 | list / CSV / print: OWNER, MANAGER, ACCOUNTANT, SALES yes, INVENTORY 403, no session 401; profit: OWNER, MANAGER, ACCOUNTANT; 422 for unknown / bad query fields; hostile search text |
| `api/invoices-labels-verbatim` | 4 | every print / classic / status / scope / sort / problem label and the CSV header occurs character for character in the legacy source (skipped when the old repo is not next to this one) |
| `api/invoices-cancel`, `invoices-permissions`, `invoices-reads-duplicate` | +2, +1, +1 assertion | step 0: draft discard both ways |
| `shared/profit.test`, `shared/line-summary.test` | 10, 7 | the profit definition against the legacy figure (hand-computed), `Desc.fromLines` / `qtyOf` / `qtyLabel` / `cleanDesc`, `formatQtyMilli` = `toLocaleString` |

**Search parity numbers** (`console.log`ged by the test): fixture — 86 queries, 74 with matches, 8 invoices; synthetic — **101 queries, 91 with matches, 300 invoices** (`helpers/synthetic-invoices.ts`, seeded, every status, Urdu / English names with letter variants, renamed shops, receipts incl. reversed, credit notes, two godowns, 752 lines, and its own stock so the importer's whole reconciliation runs on it);
**real nightly backup (2026-09-23, v692) — 72 queries, 58 with matches, 17 invoices: same ids, same order, same totals, cards, facets, hints.**

**Reconciliation (importer, unchanged by S8):** fixture — 6 shops / 5 suppliers, 0 balance, statement, invoice-total, stock, invoice ↔ stock differences; synthetic ~300 invoices — 40 shops / 7 suppliers, 0 everywhere; **real 2026-09-23 nightly — 409 / 35 parties, 0 balance differences, receivables 2,234,290,000 = 2,234,290,000, payables 554,000,000 / 604,000,000 (net / owed > 0) equal on both sides, trial balance 42 entries BALANCED, 444 statements 0 mismatches, 17 invoices / 18 lines / 910 bags 0 total mismatches, 15 stock rows / 48 movements 0 mismatches, 17 invoices vs 24 movements 0 mismatches.**
2026-09-22 nightly: 409 / 35, 0 everywhere (unchanged from S6 / S7). On the real backup **0 of 17 invoices store a `paymentStatus` different from the one the receipts give** (the search derives it; the legacy stored it).

**Mutation checks** (broke a rule, confirmed red in the named file, restored, re-ran green — 33 of 33 caught): receipt NUMBER searchable in Everything (parity ×3 + list ×2); reversed receipts searched (parity + list ×2); payment-status word dropped from "notes & other" (parity ×3 + list); shop's current text not searched (parity ×3 + list ×2); any word instead of every word (parity + list ×3); cards count drafts and cancelled (parity ×2 + list ×2);
`due` sort puts drafts / cancelled first (parity ×2 + list); "why it matched" counts words the shop explains (parity ×2 **and**, added after the first pass showed only parity caught it, an API-level hand test); status counts honour the status filter (parity ×3 + list); profit: tax counted as revenue, invoice discount ignored, unknown cost counted as free (shared ×2-3, API ×2), discount not shared over known lines (API ×2);
**profit key sent to every role** (JSON test); **profit endpoint open to any reader** (2 files); print: freight row always drawn, classic shows 5 rows not 6, account block ignores "up to this invoice", cancelled not flagged, opening = live balance not frozen; CSV draft cell empty; statement detail: mixed units not marked, typed description ignored; Receive panel loses its summary; the warehouse role may read invoices (5);
**journal entries tie again** (`created_at` default back to `now()`: 2 files); **draft discard both ways** (step 0: the service lets SALES cancel a posted invoice — 4 red; the controller requires `TRANSACTION_CORRECT` for a draft — 3 red).
(One check I did not trust at first: my own "labels are verbatim" test passed vacuously — a regexp built in a template literal lost its backslashes; caught by mutating a label and seeing it stay green, rewritten without regexps.)

### S8 deviations from the plan (all deliberate; each has a test)

1. **Statement rows keep `description` ("Sales invoice") and gain `detail`** instead of overwriting `description`: S4's `statements-proof` and S5's screens compare `description` against the ledger wording. The legacy display-time text lives in `detail`.
2. **Profit revenue excludes the line tax** (see above). **`GET /invoices/:id/profit` exists as well as the `profit` block in the detail.**
3. **Search columns:** the plan named `search_customer / amount / date / other` and `search_text`; I added **`search_numbers`** (the legacy number field also holds the order number, dispatch number and the invoice's own reference — S4's `search_number` only has the invoice number and its compact form, and its payment search must not change) and the six-argument `search_join`. **Category is not indexed for products** — the legacy indexes English name, name and brand only (parity is the goal). The payment-status word ("Unpaid" / "Partly paid" / "Paid") is derived from the receipts **at query time**, not stored — a stored column cannot follow receipts.
4. **Presets are not on the server:** the list takes `from` / `to` (as `GET /payments` does); "this week" is the screen's arithmetic (S5's `lib/periods.ts`).
5. **CSV money is plain rupees with paisa only when present ("1234.50")** — the same helper and the same S4 deviation as the payments CSV; the legacy wrote `String(number)` ("1234.5"). Rows end CRLF (the legacy "\n").
6. **Sort ties:** the legacy left same-date-same-moment invoices to array order; here they fall to the number (byte order, drafts last when newest first), then the id. The datasets never tie further.
7. **Receipts listed on a printed invoice, and "paid", are POSTED only** (the legacy deleted a reversed receipt's allocation rows; this database keeps them as history).
8. **The statement CSV / print Qty column is not added** — those are screens (S5 builds the statement CSV in the browser); S9 adds the column with the model fields now available.
9. **Both templates in one model** — the plan allowed "standard only if classic is done"; both are one model here (the classic block is additive), so both are done and `template` only picks which the business wants by default.

### S8 findings worth knowing

- **CI could not fail on a failing `apps/api` / `packages/import` / e2e-setup test — a hole since S2, found in S8 and fixed.** My first push of S8 showed 21 failed API tests in the CI log (`invoices-cancel`, `invoices-reads-duplicate`) and **the run still concluded "success"**: `embedded-postgres` registers an `async-exit-hook` the moment it is *imported*, and that hook's `beforeExit`
  handler calls `process.exit(0)`, overriding vitest's exit code 1. `@farooq/db/testing` imported it at the top, so every process that loaded the harness — including CI's, which never uses embedded Postgres — exited 0 whatever failed. Proven: a one-line failing test exited 0 locally and in a CI-like run, and 1 in `packages/shared` (no harness).
  **Fix (`packages/db/src/testing.ts`):** `embedded-postgres` is now imported lazily, only when no `EXTERNAL_TEST_DATABASE_URL` is set (so never in CI), and after the teardown stops the cluster the listeners it added are removed. Verified: failing test → exit 1, passing → 0, on both paths; `pnpm test` and `pnpm e2e` still green. Every earlier "CI green" entry in this file rested on a person reading the log, not on the exit code — nothing was found wrong (all tests did pass locally in those sessions), but the guarantee was missing until now.
- **Which failure it hid — a real order dependence in the tests:** the S4 synthetic payments backup (`helpers/synthetic-payments.ts`, also the e2e dataset) imports 90 invoices numbered `INV-2026-000001…` but loaded **no `INV` counter**, so any invoice test that ran after `payments-search-parity` was handed `INV-2026-000001` again (unique violation → 500). CI's file order (no vitest duration cache) put them after it; local runs never did. The backup now loads an `INV` counter (`n` = the highest number); the suite passes with the cache removed and under two random file orders (`--sequence.shuffle.files --sequence.seed=3 / 11`), 517 / 517 each.
- **A real ordering bug, found by the print test:** `journal_entries.created_at` defaulted to `now()`, which in Postgres is the **transaction's** start time. An invoice and the receipt taken with it (one transaction) therefore had **identical** `created_at`, and a statement (and the classic print's account block) ordered them by a random entry id — a paid-at-sale receipt could appear *above* the invoice it pays. Balances were never wrong (closing is order-free), but running balances and "up to this invoice" were. Fixed in migration `0007` (`clock_timestamp()`), pinned by `statements-invoice-detail` › "the invoice row comes before its own sale receipt" (6 shops — 1.6 % chance of a false pass without the fix) and the print test.
- **The committed fixture stores a stale `paymentStatus` ("UNPAID") on every invoice** (nothing maintains it by hand); the search derives it from the receipts, so the reference derives it too. On the real backup and on the synthetic dataset stored and derived agree in 100 % of invoices.
- **A substring quirk is inherited on purpose:** "paid" matches "Unpaid" and "Partly paid" (the status words are searched as substrings). Documented in `invoices-list`; the parity test holds it.
- **The legacy "why it matched" uses ANY of the remaining words** for a product line (`want.some`), so a two-word query can list a line that holds only one of them — ported as is.
- **Tooling:** the shell / Python transport turns `\r`, `\n`, `\t`, `\u00XX` inside heredoc'd source into real characters (a CSV split on `"\r\n"` became a string with a raw line break; an NBSP regex became a raw NBSP that ESLint flagged). Use the Write / Edit tools for anything with a backslash; check `grep -P '[\x00-\x08\x0b\x0c\x0e-\x1f\xa0]'` on new files.
- **`fileParallelism: false` + a shared database** means a test that asserts a global number (a card total, "drafts on file") must own the database — the list / CSV tests import the fixture first (wipes the business tables) and the API-created tests scope by the shop's unique name.

### S8 not done / known issues

- **No screen** (S9): nothing draws the list, the print, the profit or the new statement columns. Not seen by a person; no real staff use; the API has never been driven from a browser; **no sheet has been printed** (the model has been proven, the CSS and A4 layout are S9).
- **Not proven at scale:** ~300 invoices and the real 17. The search scans the generated text columns with `strpos` (no index) and computes `paid` / `credit` with two lateral sums per invoice; comfortable to thousands, unmeasured beyond. `explain` on the real business's size (a few thousand a year) before cutover.
- The classic block's "last six rows" uses the customer's whole ledger per print (one full ledger load) — fine today, cacheable later.
- `costOf` / `avgCostP` maintenance, COGS (M4), returns (M5), dispatch (M4) unchanged; the profit uses the line's snapshot as the legacy did.
- Owner questions still open (paper-book figures / cutover date; SALES pay-out; INVENTORY and `/company`). **New:** which profit definition the owner wants shown (adopted: goods margin, tax and charges excluded, unknown cost never counted as free) — see above.

## S7 — what was done (M2 part 2: the Invoices service + API)

Server side only — **no screen changed** (S9). A person with the right role can now, through the HTTP API, save many drafts, post an invoice (number, lines, stock, journal, money taken at the sale — one transaction), edit a posted
invoice as a net correction, cancel, duplicate and change shop, with the legacy messages verbatim and the owner's three decisions enforced. The live ERP is untouched; nothing is deployed.

- **`apps/api/src/invoices/`** — `invoices.service.ts` (save / cancel / duplicate / changeShop, each ONE transaction), `validate.ts` (`Validate.invoice`, pure), `rules.ts` (what stops an edit / cancel / move — used by the service AND by the read model's `actions`),
  `stock.ts` (level locking in a fixed order, movement + level in one step, `costOf` / `carriedCost` as reads, the `allowNegativeStock` setting), `invoices.queries.ts` (detail, product picker, warehouses), `invoices.controller.ts` (+ `InvoiceLookupsController`).
- **API:** `POST /invoices` (`mode: draft | post`), `PUT /invoices/:id` (edit a draft, post a draft, edit a posted invoice — needs the `revision` the client loaded), `POST /invoices/:id/{cancel,duplicate,change-shop}`, `GET /invoices/:id`
  (header, shop snapshots, lines, receipts, stock movements, `actions {edit, cancel, changeShop, duplicate}` each `{allowed, reason}`), `GET /products?q&warehouseId&limit`, `GET /warehouses`. Shapes and the legacy wording are in
  `packages/shared/src/schemas/invoices.ts` (`INVOICE_MESSAGES`, `saveInvoiceSchema`, `invoiceDetailSchema`, …). Every request is `.strict()`; refusals are 422 `{message, errors}`.
- **Shared receive core (planner decision 7):** the write half of `PaymentsService.receive` moved, unchanged, to `apps/api/src/payments/receipt-core.ts` (`writeReceipt`, `loadShop`, `insertVoucher`, allocation checks). `PaymentsService.receive`
  and an invoice saved with money taken both call it; **S3's tests pass unchanged**.
- **`@farooq/db` `ledger.ts`:** `INVOICE_CANCEL_SOURCE`, `invoiceCancelLines`, `invoiceCancelMemo`, `setEntryDate`. **Migration `0006`** adds `request_keys` (idempotency for invoice saves — an invoice edit has no row of its own to carry a key); the importer wipes it with the business tables.
- **Statements:** a CANCELLED invoice and its `INVOICE_CANCEL` entry are both left out (like a reversed voucher); `omittedCancelled` added to the statement response **additively** (S5 screens unaffected). The importer's independent statement builder in the reconciliation got the same rule.
- **`@farooq/shared`:** `addDays` (calendar arithmetic on business dates) for "the day before the invoice date".

### The rules as built (details in `docs/PARITY.md` → "Invoices service — ported in S7")

Post: number `INV-<current business year>-<6>` from the live counter, gap-free; lines with product snapshots and `cost_snapshot_p` (`costOf` read); `SALE_OUT` per line and the level, one `INVOICE` journal entry, `previous_balance_p` = the shop's live balance at posting (frozen after),
receipt for the paid amount through the shared receive core (dated the invoice date, note "Received with invoice N"), audit `Invoice created`. Drafts: any number, no number / stock / journal / payment. Edit posted: movements for the DIFFERENCE per product × godown
(`INVOICE_EDIT`, invoice date), the one journal entry rewritten (amount and date), snapshots re-taken, line ids kept; refused when cancelled, a return or dispatch exists, the shop differs, back to draft, or the revision is stale; raising `paid` takes a receipt for the difference,
lowering it below what is received is refused naming the receipt. Cancel: stock back (Σ qty per product × godown, `INVOICE_CANCEL`, dated today), an `INVOICE_CANCEL` entry dated the invoice's own date; refused while money received against it stands (owner decision 1) or a return exists.
Change shop: `reassignCheck` messages verbatim, receipts wholly applied move with it, `previous_balance_p` = the new shop's balance the day before. Migrated invoices never get stock movements on edit or cancel.

### S7 verification

`pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm e2e` all green locally, 0 lint warnings. **`pnpm test`: 844 tests** (687 before S7): `packages/shared` **134** (+2 `addDays`), `apps/web` 62, `packages/import` 224, `apps/api` **424** (+155, all in the new files below).
**`pnpm e2e`: 70 passed** (2.7 min, unchanged — S7 has no screen). 222 of the import tests run in CI (2 real-backup tests skip without `data/`).

| new file (apps/api/test) | tests | what it pins |
|---|---|---|
| `invoices-validate` | 22 | every `Validate.invoice` message verbatim and in the legacy order; stricter rules (negative discounts / charges, > 3 decimals, per product × godown totalled stock check, absurd sizes) |
| `invoices-post` | 25 | hand-computed post (2,742,500), status, numbering (gap-free, year), past date, previous balance, snapshots, many drafts, draft edit / post, refusals write nothing, `allowNegativeStock`, payment at sale, rollback of the whole invoice when the receipt fails, idempotency |
| `invoices-edit` | 30 | UP / DOWN / per-pair / swapped product net movements, own bags counted back, date change, frozen previous balance, re-taken snapshots, stable line ids, the money rules (extra receipt, lowering refused, `PAYMENT_CREATE` 403), every refusal, stale / missing revision, foreign line id, replayed PUT, role gates, migrated and imported invoices |
| `invoices-cancel` | 12 | hand-computed cancel (stock today, journal on the invoice's date, both entries), statement omission + `omittedCancelled` windowing, per product × godown restock, refusal with receipts (and after reversing them) / with a return, drafts, importer-made and migrated invoices, roles |
| `invoices-change-shop` | 16 | the legacy 91-check spec's cases (A1-A12, B0-B6, C1-C12, D10, G3, R3, X1-X4) |
| `invoices-reads-duplicate` | 16 | detail schema, cost hidden without `PROFIT_VIEW`, `actions` matrix by role and state, duplicate (3), product picker (words, warehouse-first, price hints, roles), warehouses |
| `invoices-cost` | 10 | every branch of `costOf` / `carriedCost` by hand, line snapshot from the LINE's godown, `avg_cost_p` never written |
| `invoices-permissions` | 9 | every endpoint × all five roles, 401 without a session or CSRF token, cross-check with the shared permission model |
| `invoices-concurrency` | 7 | two saves racing for the last bags, six racing for ten, opposite line orders (no deadlock), consecutive numbers, one idempotency key = one invoice, two editors of one revision, receipt vs edit |
| `invoices-ledger-bridge` | 8 | see below |

**Ledger bridge** (`invoices-ledger-bridge`): import the fixture; 11 scripted operations through the HTTP API (post with money, post fractional, edit up with a raised paid, edit down, post + cancel, change shop of an unpaid invoice, change shop of a two-receipt invoice, duplicate → post, a two-godown taxed sale paid in full, a draft);
the same operations applied by hand to the legacy JSON (the legacy way: reverse + re-deduct on edit); **`LegacyLedger` = the journal for all 6 shops and 5 suppliers**; hand-computed final receivables (c1 1,900,000, c2 100,000, c3 470,000, c4 100,000, c5 450,000, c6 1,280,000; Σ 4,300,000 = 2,935,000 + 1,964,000 invoiced − 599,000 received) and bags
(p-1 74.5 / 30, p-2 50, p-3 38, damaged 0.6 untouched); levels = Σ movements; trial balance zero; each posted invoice has exactly one `INVOICE` entry (a cancelled one also one `INVOICE_CANCEL`); the real `reconcile()` reports 0 balance, statement, invoice-total, stock and invoice ↔ stock differences.
The one deliberate count difference: 35 movement documents in the legacy-shaped JSON vs 33 rows (an edit posts the difference where the legacy reversed and re-deducted).

**Mutation checks** (broke the rule, confirmed red, restored, re-ran green — 16 of 16 caught by the named file): edit posts the full new quantity instead of the difference (8 red); cancel journal dated today (3); stock check per line not totalled (1); own bags not counted back (1); cancel allowed with money received (2);
change shop leaves receipts behind (2); migrated invoice gets stock movements (2); idempotency key never matches (1); previous balance re-taken on edit (2); stock rows not locked (1 — the last-bags race); statements keep a cancelled invoice (3); stale revision accepted (1); cancel forgets to restock (5);
returned invoice still editable (1); `paid` lowerable below the receipts (1); cost falls straight to the list price (1). (One mutation was left applied in `rules.ts` by an interrupted run of my mutation script; found by `grep`, restored, and re-run before the final test run.)

**Real backups** (throwaway Postgres, `runImport` + `reconcile`, unchanged by S7 — the importer / reconciliation gained only the cancelled-invoice statement rule): 2026-09-23 nightly — 409 / 35 parties, **0** balance differences; trial balance 42 entries BALANCED; 444 statements, 0 mismatches;
17 invoices / 18 lines / 910 bags, **0** total mismatches; 15 stock rows / 48 movements, **0** mismatches; 17 invoices vs 24 movements, **0** mismatches. 2026-09-22 nightly: identical to S6's figures (0 everywhere).

### S7 deviations from the plan (all deliberate; each has a test)

1. **A draft cannot carry an amount paid** — nothing stores it (`paidAmount` is derived from receipts), so the plain message "Payment can only be taken when the invoice is posted…" is returned instead of silently dropping the figure (the legacy stored it on the draft and used it at confirmation).
2. **`request_keys` table (migration `0006`)** for idempotency: the plan said "like S3", but S3 keeps its key on the voucher row; an invoice EDIT has no row of its own, and a replayed POST / PUT / duplicate must not repeat the receipt or the stock.
3. **Duplicate carries a fixed line tax** (the legacy `toDraft` dropped it — a duplicate of a taxed invoice silently lost its tax). `salesperson` and `paymentMethod` are copied as in the legacy.
4. **"The discount is larger than the line amount" is not printed for a line whose quantity is already invalid** (the legacy printed both for a negative quantity; only noise).
5. **Change shop refuses a draft** (planner decision; the legacy UI refused, the legacy service did not) with the legacy UI's wording.
6. **`costOf` step 3** (another godown's recorded average) picks the **lowest godown id**, the legacy took the first in its own iteration order; the legacy's product-wide carried-cost step only applies with no godown, and a line always has one.
7. **Cancel of a DRAFT needs `TRANSACTION_CORRECT` too** (owner decision 2 taken literally): SALES cannot discard its own draft. **Owner question below — ANSWERED 2026-09-24 and done in S8 step 0: `SALES_CREATE` holders may discard a draft.**
8. **`request.revision` is required on every PUT** (a missing one is refused with its own message) and a NEW invoice starts at revision 1, as the legacy did (`clientRev + 1`).
9. **The cancel refusal for a dispatched invoice** is NOT applied (owner decision 3 only blocks *edit* once a dispatch exists); cancel is blocked by returns and money only.
10. `GET /invoices/:id` is readable by `SALES_CREATE | TRANSACTION_CORRECT | COLLECTION_VIEW | FINANCIAL_REPORT_VIEW` (INVENTORY: 403); `/products` and `/warehouses` need `MASTER_DATA_VIEW` (every role has it), cost figures only `PROFIT_VIEW`.

### S7 findings worth knowing

- **The payment-at-sale permission is unreachable through the real role matrix** (every role holding `SALES_CREATE` also holds `PAYMENT_CREATE`); it is defence in depth, and the tests remove the permission from one role in memory to prove the 403.
- **The receipt shared-code refactor found nothing** — S3's payment tests passed on the first run; the only S3-side change is that the code now lives in `receipt-core.ts`.
- **A test flake caught by the full run:** the product-search test matched imported real-backup products (an Urdu word, then a bag size "25" appearing inside a random tag). Tags are now letters only and every query carries the unique tag. The lesson (already in CLAUDE.md for other files): tests that read shared tables must scope their query to their own rows.
- **Editing tools / shell:** heredocs with apostrophes or backticks break the shell tool again (use the Write tool + a script file); `mutate.py` needs `encoding="utf-8"` on Windows; CRLF files (`load.ts`, `reconcile.ts`, `ledger.ts`, `payments.service.ts`) were edited through Python with newline handling or the Edit tool.
- The invoice **journal is not the source for an invoice list** (S8): it has both entries of a cancelled invoice. Lists use `invoices` + allocations.

### S7 not done / known issues

- No screen, no search / list / CSV / print / profit (S8, S9). `GET /invoices` does not exist yet.
- Not seen by a person; no real staff use; the API has never been driven from a browser.
- **(Resolved in S8 step 0 — SALES may now discard a draft.)** Was: SALES cannot cancel even its own draft (`TRANSACTION_CORRECT`, decision 2 taken literally) — so a salesperson has no way to discard a draft. Options: let `SALES_CREATE` holders cancel drafts only, or add a delete-draft action. Not changed; S9 should not offer "discard" to SALES until decided.
- Owner questions from earlier milestones still open (see below).
- `costOf` reads the movements each time (fine at today's scale — thousands of movements; an index on `(product_id, warehouse_id, bucket)` exists); the legacy capped its in-memory movement list at 8,000 recent rows, this reads all.
- `stock_levels` rows are created (at zero) for every product × godown a posting touches, as the legacy `Inventory.row` did.

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
apps/api         NestJS 11 + Fastify (S1-S4). S5 change: CORS now exposes Content-Disposition (see Findings). S7: src/invoices/ (service, validate, rules, stock, queries, controller), payments/receipt-core.ts. S8: invoices.search / list / csv / print.ts.
apps/web         React 19 + Vite + TanStack Router / Query. src/lib (pure logic + tests), src/components, src/routes. Vitest + Testing Library (S5).
apps/e2e         NEW (S5). Playwright: setup/ (throwaway Postgres → import → users → built API + built web), tests/*.spec.ts. Gitignored: .run/, e2e-artifacts/.
packages/shared  Permissions, Zod schemas, business-date helpers (S7: addDays), fold / search-query / money; S6: invoice-totals (Calc port); S7: schemas/invoices; S8: schemas/invoice-list + invoice-print, profit.ts, line-summary.ts.
packages/db      Drizzle schema, migrations 0000-0007 (S6: invoice lines, stock; S7: request_keys; S8: invoice search columns, journal created_at = clock_timestamp()), client, test harness; ledger.ts (S7: INVOICE_CANCEL) + stock.ts.
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

**S8: green** on commit `dbf8d0b`: [run 35988228177](https://github.com/talhaazhar-ta/farooq-erp-next/actions/runs/35988228177) — install, build, typecheck, lint, test (real Postgres service container: shared 151, web 62, import 221 + 1 skipped file, **api 499 passed + 4 skipped** — the 4 are `invoices-labels-verbatim`, which needs the old repo; the real-backup datasets are simply not defined without `data/`), Chromium, `pnpm e2e` (70) all passed — **and this time a failure would have failed the step** (see Findings: the first S8 push, `f9431af`, [run 35984948710](https://github.com/talhaazhar-ta/farooq-erp-next/actions/runs/35984948710), showed 21 failed API tests in its log and still concluded "success" — that run is not a green run).

Earlier — **S7: green** on commit `fd7bafa`: [run 35976238407](https://github.com/talhaazhar-ta/farooq-erp-next/actions/runs/35976238407) — install, build, typecheck, lint, test (real Postgres service container; the 2 real-backup tests skip), Chromium, `pnpm e2e` (70) all passed.

Earlier — **S6: green** on commit `1e8364f`: [run 35961659523](https://github.com/talhaazhar-ta/farooq-erp-next/actions/runs/35961659523) — install, build, typecheck, lint, test (real Postgres service container; the 2 real-backup tests skip), Chromium, `pnpm e2e` (70) all passed.

Earlier — **green** on the S5 commit `45fc437`: [run 35952737035](https://github.com/talhaazhar-ta/farooq-erp-next/actions/runs/35952737035) — install, build, typecheck, lint, test (541 tests, real Postgres service container via `EXTERNAL_TEST_DATABASE_URL`), Chromium install, **`pnpm e2e` (70 Playwright tests on ubuntu-latest, same container)** and the artifact upload all passed. The real-backup datasets are skipped in CI (the file is gitignored); the e2e dataset is synthetic.

## Next step

**S9 — invoice screens + browser tests** (`docs/sessions/S9.md`, corrected in S8 to the real API — its first two sections list every endpoint and shape the screens use; the hub may split it into S9a list / view / print / corrections and S9b the builder).
The whole M2 read + write API now exists (S7 writes, S8 reads); nothing draws it yet. The screens must render `actions.*`, `interpreted`, `hits`, `statusFacets` and the print model as they come, never re-derive them; the print CSS (A4, fixed paper colours, Urdu, one page) is the part nobody has seen.
Still open from M1 / M2: a person walking the screens and printing a receipt / invoice, and the owner questions above (paper-book figures / cutover date; SALES pay-out; INVENTORY and `/company`; which profit definition to show).

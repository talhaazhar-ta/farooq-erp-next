import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exitCodeFor, reconcile, runImport, type Backup } from "@farooq/import";
import { TEST_ADMIN_URL, minimumCountProblems, realBackups, type RealBackupRef } from "@farooq/db/testing";
import { INVOICE_STATUSES, type InvoiceListResponse } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { createLegacyInvoiceSearch, type InvoiceState, type LegacyInvoiceStore } from "./helpers/legacy-invoice-search.js";
import { buildSyntheticInvoices } from "./helpers/synthetic-invoices.js";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * INVOICE SEARCH PARITY (S8, the proof): `GET /invoices` returns the SAME invoices in the SAME order — with the same four
 * cards, the same counts per status, the same reading of the box and the same "why it matched" hints — as the legacy algorithm
 * (33-invoice-search.js: build + matcher + sortList + hitsFor + the cards of 05-ui-builder.js), ported literally in
 * helpers/legacy-invoice-search.ts, which imports nothing from the code under test. Three datasets, each imported through the
 * real importer first (so the importer, `fold_search`, the generated columns and the endpoint are all in the path):
 *   1. the committed synthetic fixture (8 invoices with lines, every ledger and stock branch),
 *   2. a deterministic ~300-invoice synthetic backup WITH LINES (every status, Urdu / English names with letter variants,
 *      renamed shops, receipts incl. reversed ones, credit notes, two godowns),
 *   3. the REAL nightlies, when present on this machine (gitignored business data: skipped in CI): the two last pre-wipe backups, pinned by name (v692, v710 — S14; the near-empty post-wipe one is not used here).
 * The query table is built FROM the data (words, numbers and dates that exist in it).
 */
const REAL_BACKUPS = realBackups().pinned; // v692 + v710, the pre-wipe nightlies (S14). The post-wipe "current" one is near-empty: it only has to import and reconcile (real-backups.test.ts) and would rightly fail the non-trivial-table guards here
/** A REAL dataset, pinned by name (S14, `realBackups` in @farooq/db/testing): a pinned file that holds fewer rows than it really has FAILS (it would pass anything). */
const loadReal = (ref: RealBackupRef) => (): Backup => {
  const b = JSON.parse(readFileSync(ref.path, "utf8")) as Backup;
  const short = minimumCountProblems(b.data as never, ref.minimums);
  if (short.length) throw new Error(`${ref.file}: ${short.join("; ")}`);
  return b;
};

interface Case {
  name: string;
  state: InvoiceState;
}

/** The legacy control state → the endpoint's query string (regions / warehouses are looked up by their legacy id). */
function toQuery(s: InvoiceState, ids: { region: Map<string, string>; wh: Map<string, string> }, extra: Record<string, string | number> = {}): string {
  const q = new URLSearchParams();
  if (s.q !== undefined) q.set("q", s.q);
  if (s.scope) q.set("scope", s.scope);
  if (s.status) q.set("status", s.status);
  if (s.region) q.set("regionId", ids.region.get(s.region)!);
  if (s.wh) q.set("warehouseId", ids.wh.get(s.wh)!);
  if (s.from) q.set("from", s.from);
  if (s.to) q.set("to", s.to);
  if (s.minP !== undefined) q.set("minP", String(s.minP));
  if (s.maxP !== undefined) q.set("maxP", String(s.maxP));
  if (s.sort) q.set("sort", s.sort);
  q.set("limit", "200");
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
}

const swapVariants = (s: string) => s.replace(/ک/g, "ك").replace(/ی/g, "ي").replace(/ہ/g, "ه").replace(/ھ/g, "ه");
const words = (s: string) => String(s).split(/\s+/).filter((w) => w.length > 1);

/** The query table, built from what the data holds. */
function casesFor(b: Backup): Case[] {
  const S = b.data as unknown as LegacyInvoiceStore;
  const cases: Case[] = [];
  const add = (name: string, state: InvoiceState) => cases.push({ name, state });
  const first = <T>(xs: T[], f: (x: T) => boolean): T | undefined => xs.find(f);
  const inv = S.invoices;
  const posted = inv.filter((i) => i.invoiceNumber);

  // ── unfiltered, and the five sorts
  add("no filter, newest first", {});
  for (const sort of ["oldest", "high", "low", "due"]) add(`no filter, sort ${sort}`, { sort });

  // ── status, region, warehouse
  for (const status of INVOICE_STATUSES) if (inv.some((i) => i.status === status)) add(`status ${status}`, { status });
  add("status PAID, sort due", { status: "PAID", sort: "due" });
  add("status CONFIRMED, sort due", { status: "CONFIRMED", sort: "due" });
  const regionId = inv.find((i) => i.regionId)?.regionId as string | undefined;
  if (regionId) {
    add("region filter", { region: regionId });
    add("region + status", { region: regionId, status: "CONFIRMED", sort: "oldest" });
  }
  for (const wh of [...new Set(inv.map((i) => i.warehouseId).filter(Boolean))].slice(0, 2)) add(`warehouse ${wh}`, { wh: wh as string, sort: "high" });

  // ── dates: ranges, typed dates, months
  const d0 = inv[Math.floor(inv.length / 2)]?.invoiceDate as string | undefined;
  if (d0) {
    const [y, m, d] = d0.split("-");
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m! - 1]!;
    add("range from-to", { from: d0, to: `${y}-12-31` });
    add("from only", { from: d0, sort: "oldest" });
    add("to only", { to: d0 });
    add("From after To is a problem, empty list", { from: `${y}-12-31`, to: `${y}-01-01` });
    add("typed ISO date", { q: d0 });
    add("typed day-first date", { q: `${d}/${m}/${y}` });
    add("typed 'D Mon YYYY'", { q: `${+d!} ${mon} ${y}` });
    add("typed month and year (Mon YYYY)", { q: `${mon} ${y}` });
    add("typed 'YYYY-MM'", { q: `${y}-${m}` });
    add("typed date replaces from/to", { q: d0, from: `${y}-01-01`, to: `${y}-01-02` });
    add("impossible date stays text", { q: "31/02/2026" });
    add("month name is text in the date forms", { q: mon.toLowerCase() });
    add("typed date + status", { q: `${d}/${m}/${y}`, status: "CONFIRMED" });
  }

  // ── totals
  add("min above max is a problem", { minP: 9_000_000, maxP: 100_000 });
  add("total range", { minP: 250_000, maxP: 25_000_000 });
  add("min only, low first", { minP: 4_000_000, sort: "low" });
  add("max only, high first", { maxP: 3_000_000, sort: "high" });
  const withPaisa = first(inv, (i) => i.grandTotal % 100 !== 0);
  const whole = first(inv, (i) => i.grandTotal % 100 === 0 && i.grandTotal >= 100_000);
  if (withPaisa) {
    const r = withPaisa.grandTotal / 100;
    add("total typed with paisa", { q: r.toFixed(2) });
    add("total typed grouped with paisa", { q: Number(r).toLocaleString("en-US", { minimumFractionDigits: 2 }) });
    add("total with paisa, scope amount", { q: r.toFixed(2), scope: "amount" });
  }
  if (whole) {
    const r = whole.grandTotal / 100;
    add("whole total", { q: String(r) });
    add("whole total grouped, scope amount", { q: r.toLocaleString("en-US"), scope: "amount" });
  }

  // ── numbers
  const anyInv = first(posted, () => true);
  if (anyInv) {
    const no = String(anyInv.invoiceNumber);
    add("invoice number", { q: no });
    add("invoice number lower-case without hyphens", { q: no.toLowerCase().replace(/-/g, "") });
    add("tail of an invoice number", { q: no.split("-").pop()! });
    add("invoice number, scope number", { q: no, scope: "number" });
    add("invoice number, scope product finds nothing", { q: no, scope: "product" });
    add("the prefix 'INV'", { q: "INV", sort: "oldest" });
  }
  const withOrder = first(inv, (i) => i.orderNumber);
  if (withOrder) {
    add("order number", { q: withOrder.orderNumber });
    add("order number, scope number", { q: withOrder.orderNumber, scope: "number" });
  }
  const withDispatch = first(inv, (i) => i.dispatchNumber);
  if (withDispatch) add("dispatch number", { q: withDispatch.dispatchNumber, scope: "number" });
  const withRefNo = first(inv, (i) => i.referenceNo);
  if (withRefNo) {
    add("the invoice's own reference", { q: withRefNo.referenceNo });
    add("the invoice's own reference, scope number", { q: withRefNo.referenceNo, scope: "number" });
  }

  // ── receipts: the number is found ONLY with the "Receipt / payment ref." scope, never in Everything
  const paidPairs = S.paymentAllocations.filter((a) => a.invoiceId).map((a) => ({ a, p: S.payments.find((p) => p.id === a.paymentId)! })).filter((x) => x.p);
  const livePair = paidPairs.find((x) => x.p.status !== "REVERSED");
  const revPair = paidPairs.find((x) => x.p.status === "REVERSED");
  if (livePair) {
    const rn = String(livePair.p.receiptNumber);
    add("receipt number in Everything finds nothing", { q: rn });
    add("receipt number, scope payment", { q: rn, scope: "payment" });
    add("receipt number lower-case without hyphens, scope payment", { q: rn.toLowerCase().replace(/-/g, ""), scope: "payment" });
    add("tail of a receipt number in Everything", { q: rn.split("-").pop()! });
    add("tail of a receipt number, scope payment", { q: rn.split("-").pop()!, scope: "payment" });
    add("receipt number, scope number finds nothing", { q: rn, scope: "number" });
    add("payment method, scope payment", { q: String(livePair.p.method), scope: "payment" });
  }
  const withRef = paidPairs.find((x) => x.p.reference && x.p.status !== "REVERSED");
  if (withRef) {
    const ref = String(withRef.p.reference);
    add("cheque / transaction reference in Everything", { q: ref });
    add("cheque / transaction reference compact", { q: ref.toLowerCase().replace(/[^a-z0-9]/g, "") });
    add("cheque / transaction reference, scope payment", { q: ref, scope: "payment" });
    add("cheque / transaction reference, scope customer finds nothing", { q: ref, scope: "customer" });
  }
  if (revPair) {
    add("a REVERSED receipt's number is not searched, scope payment", { q: String(revPair.p.receiptNumber), scope: "payment" });
    if (revPair.p.reference) add("a REVERSED receipt's reference is not searched", { q: String(revPair.p.reference) });
  }

  // ── products
  const itemsByInv = (id: string) => S.invoiceItems.filter((x) => x.invoiceId === id);
  const withItems = first(inv, (i) => itemsByInv(i.id).length >= 2);
  if (withItems) {
    const it = itemsByInv(withItems.id)[0]!;
    const en = String(it.descriptionEnSnapshot);
    add("product name", { q: en });
    add("product name words in reverse order", { q: [...words(en)].reverse().join(" ") });
    add("one word of a product name, scope product", { q: words(en)[0] ?? en, scope: "product" });
    add("product brand", { q: String(it.brandSnapshot), scope: "product" });
    add("product + shop: both must hold", { q: `${words(en)[0] ?? en} ${words(String(withItems.shopNameSnapshot))[0] ?? ""}` });
    if (/[؀-ۿ]/.test(String(it.descriptionSnapshot))) {
      add("Urdu product name", { q: String(it.descriptionSnapshot) });
      add("Urdu product name, letter variants typed differently", { q: swapVariants(String(it.descriptionSnapshot)) });
    }
    add("product word, scope customer finds only shops", { q: words(en)[0] ?? en, scope: "customer" });
    const a = itemsByInv(withItems.id)[0]!, b = itemsByInv(withItems.id)[1]!;
    add("two products of one invoice", { q: `${words(String(a.descriptionEnSnapshot))[0]} ${words(String(b.descriptionEnSnapshot))[0]}` });
  }
  add("a product word found in many invoices, sorted by due", { q: "flour", sort: "due" });

  // ── customers: printed name, current name, owner, phone, code, region, letter variants, renames
  const cust = first(S.customers, (c) => inv.some((i) => i.customerId === c.id) && String(c.sh).split(/\s+/).length >= 2) ?? S.customers.find((c) => inv.some((i) => i.customerId === c.id));
  if (cust) {
    const w = words(cust.sh);
    add("shop name", { q: cust.sh });
    add("shop name words in reverse order", { q: [...w].reverse().join(" ") });
    add("one word of a shop name, scope customer", { q: w[0] ?? cust.sh, scope: "customer" });
    if (cust.ph) {
      add("phone as stored", { q: cust.ph });
      add("phone without dashes", { q: String(cust.ph).replace(/\D/g, "") });
    }
    const long = w.find((x) => x.length >= 4);
    if (long) add("a word typed with a hyphen inside it still matches (spaces removed)", { q: `${long.slice(0, Math.ceil(long.length / 2))}-${long.slice(Math.ceil(long.length / 2))}` });
    if (cust.legacyCode) add("legacy code", { q: cust.legacyCode });
    if (cust.ow) add("owner", { q: cust.ow, scope: "customer" });
    const reg = S.regions.find((r) => r.id === cust.region);
    if (reg) add("region text (English)", { q: reg.en });
  }
  const urdu = first(S.customers, (c) => inv.some((i) => i.customerId === c.id) && /[؀-ۿ]/.test(c.sh) && swapVariants(c.sh) !== c.sh);
  if (urdu) {
    add("Urdu shop name, letter variants typed differently", { q: swapVariants(urdu.sh) });
    add("Urdu shop name, scope customer", { q: urdu.sh, scope: "customer" });
  }
  const renamed = first(S.customers, (c) => inv.some((i) => i.customerId === c.id && i.shopNameSnapshot && i.shopNameSnapshot !== c.sh));
  if (renamed) {
    const old = String(inv.find((i) => i.customerId === renamed.id)!.shopNameSnapshot);
    add("renamed shop found by the NEW name", { q: renamed.sh });
    add("renamed shop still found by the name printed on the invoice", { q: old });
    add("renamed shop by the old name, scope customer", { q: old, scope: "customer" });
  }

  // ── notes and the other fields, the words a status carries
  const withNote = first(inv, (i) => i.notes);
  if (withNote) {
    const w = words(withNote.notes)[0];
    if (w) {
      add("note word", { q: w });
      add("note word, scope notes", { q: w, scope: "notes" });
    }
  }
  const withDesc = first(inv, (i) => i.description);
  if (withDesc) add("description word, scope notes", { q: words(withDesc.description)[0] ?? "x", scope: "notes" });
  const withSales = first(inv, (i) => i.salesperson);
  if (withSales) add("salesperson, scope notes", { q: withSales.salesperson, scope: "notes" });
  add("warehouse name", { q: "second godown" });
  add("the words 'partly paid'", { q: "partly paid" });
  add("the word 'paid' (also in 'unpaid' and 'partly paid')", { q: "paid", scope: "notes" });
  add("the word 'unpaid'", { q: "unpaid" });
  add("the word 'draft'", { q: "draft" });
  add("the word 'cancelled', scope notes", { q: "cancelled", scope: "notes" });
  add("the word 'returned'", { q: "returned" });
  add("a word found nowhere", { q: "qqzzxxnothing" });
  add("punctuation only is no words at all", { q: "  - / ,  " });
  add("several filters at once", { q: "a", status: "CONFIRMED", minP: 100_000, sort: "due" });
  return cases;
}

/** Runs the whole table against one dataset. */
function defineTable(name: string, load: () => Backup, minCases: number): void {
  describe(`invoice search parity — ${name}`, () => {
    let h: Harness;
    let owner: Session;
    let backup: Backup;
    let legacyOf: Map<string, string>;
    let ids: { region: Map<string, string>; wh: Map<string, string> };
    let ref: ReturnType<typeof createLegacyInvoiceSearch>;
    let cases: Case[];

    beforeAll(async () => {
      backup = load();
      await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: `invoice-parity-${name}` });
      h = await createHarness();
      owner = await h.session("OWNER");
      legacyOf = new Map((await h.admin`SELECT id, legacy_id FROM invoices`).map((r) => [r.id as string, r.legacy_id as string]));
      ids = {
        region: new Map((await h.admin`SELECT id, legacy_id FROM regions`).map((r) => [r.legacy_id as string, r.id as string])),
        wh: new Map((await h.admin`SELECT id, legacy_id FROM warehouses`).map((r) => [r.legacy_id as string, r.id as string])),
      };
      ref = createLegacyInvoiceSearch(backup.data as unknown as LegacyInvoiceStore);
      cases = casesFor(backup);
    });
    afterAll(async () => {
      await h.close();
    });

    const call = async (state: InvoiceState, extra: Record<string, string | number> = {}): Promise<InvoiceListResponse> => {
      const res = await h.request(owner, "GET", `/invoices?${toQuery(state, ids, extra)}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as InvoiceListResponse;
    };
    /** Every match, walking the pages of 200 (the endpoint's maximum) — the reference has no page size. */
    const callAll = async (state: InvoiceState): Promise<InvoiceListResponse> => {
      const first = await call(state);
      const items = [...first.items];
      while (items.length < first.total) items.push(...(await call(state, { offset: items.length })).items);
      return { ...first, items };
    };

    it("the dataset itself reconciles (the importer's definition of correct): 0 balance, statement, invoice-total, stock and invoice-stock differences", async () => {
      const report = await reconcile(backup, TEST_ADMIN_URL);
      expect(report.failures).toEqual([]);
      expect(exitCodeFor(report)).toBe(0);
      expect(report.customers.differences).toEqual([]);
      expect(report.suppliers.differences).toEqual([]);
      expect(report.invoices.totalMismatches).toEqual([]);
      expect(report.stock.mismatches).toEqual([]);
      expect(report.invoiceStock.mismatches).toEqual([]);
      console.log(`[reconciliation — ${name}] ${report.customers.compared} shops / ${report.suppliers.compared} suppliers, ${report.invoices.totalMismatches.length} total, ${report.stock.mismatches.length} stock, ${report.invoiceStock.mismatches.length} invoice-stock mismatches; ok=${report.ok}`);
    }, 120_000);

    it("has a real table to run (the dataset feeds enough cases)", () => {
      expect(cases.length).toBeGreaterThanOrEqual(minCases);
    });

    it("every query returns the same ids in the same order, the same totals, cards, status counts and reading of the box", async () => {
      const failures: string[] = [];
      let nonEmpty = 0;
      for (const c of cases) {
        const want = ref.list(c.state).map((i) => i.id as string);
        const got = await callAll(c.state);
        const gotIds = got.items.map((i) => legacyOf.get(i.id)!);
        if (want.length) nonEmpty++;
        if (JSON.stringify(gotIds) !== JSON.stringify(want)) failures.push(`${c.name}: want [${want.slice(0, 12).join(",")}…${want.length}] got [${gotIds.slice(0, 12).join(",")}…${gotIds.length}]`);
        if (got.total !== want.length) failures.push(`${c.name}: total ${got.total} != ${want.length}`);
        const kpis = ref.kpis(c.state);
        if (JSON.stringify(got.kpis) !== JSON.stringify(kpis)) failures.push(`${c.name}: kpis ${JSON.stringify(got.kpis)} != ${JSON.stringify(kpis)}`);
        const facets = ref.statusFacets(c.state);
        if (JSON.stringify(got.statusFacets) !== JSON.stringify(facets)) failures.push(`${c.name}: statusFacets ${JSON.stringify(got.statusFacets)} != ${JSON.stringify(facets)}`);
        const said = ref.describe(c.state);
        if (JSON.stringify(got.interpreted.terms) !== JSON.stringify(said.terms)) failures.push(`${c.name}: terms ${JSON.stringify(got.interpreted.terms)} != ${JSON.stringify(said.terms)}`);
        if (JSON.stringify(got.interpreted.problems) !== JSON.stringify(said.problems)) failures.push(`${c.name}: problems differ`);
        if (JSON.stringify(got.interpreted.dates.map((d) => [d.from, d.to, d.label])) !== JSON.stringify(said.dates.map((d: any) => [d.from, d.to, d.label]))) failures.push(`${c.name}: dates differ`);
      }
      expect(failures).toEqual([]);
      console.log(`[invoice search parity — ${name}] ${cases.length} queries, ${nonEmpty} with matches, ${backup.data.invoices!.length} invoices with ${backup.data.invoiceItems!.length} lines on file`);
      // the table must actually find things — otherwise "same empty list" proves nothing
      expect(nonEmpty).toBeGreaterThanOrEqual(Math.floor(cases.length * 0.6));
    }, 300_000);

    it("the payment-status word the search derives equals the one the legacy kept on each invoice (counts only)", () => {
      const invs = backup.data.invoices as Record<string, any>[];
      const differing = invs.filter((i) => ref.paymentStatusOf(i) !== i.paymentStatus);
      console.log(`[payment status — ${name}] ${differing.length} of ${invs.length} invoices store a paymentStatus different from the one the receipts give`);
      // the committed fixture stores a stale "UNPAID" on every invoice (it is not maintained by hand); the other datasets keep it as the legacy did
      if (name !== "fixture") expect(differing.length).toBe(0);
    });

    it("every row's 'why it matched' hint equals the legacy hitsFor (product lines and receipts, Everything / Product / Receipt scopes)", async () => {
      const failures: string[] = [];
      let hinted = 0;
      for (const c of cases) {
        const hitsOf = ref.hitsFor(c.state);
        const got = await callAll(c.state);
        for (const item of got.items) {
          const want = hitsOf(backup.data.invoices!.find((i) => i.id === legacyOf.get(item.id))!);
          if (want) hinted++;
          if (JSON.stringify(item.hits) !== JSON.stringify(want)) failures.push(`${c.name} / ${legacyOf.get(item.id)}: hits ${JSON.stringify(item.hits)} != ${JSON.stringify(want)}`);
        }
      }
      expect(failures).toEqual([]);
      if (name !== "real nightly backup (local only)") expect(hinted).toBeGreaterThan(30);
    }, 300_000);

    it("paging stitches back to the full list, in order, with a stable total (offset / limit walk)", async () => {
      for (const state of [{}, { sort: "high" }, { sort: "due", status: "CONFIRMED" }, { q: "a" }] as InvoiceState[]) {
        const full = ref.list(state).map((i) => i.id as string);
        const stitched: string[] = [];
        for (let offset = 0; offset < Math.max(full.length, 1); offset += 7) {
          const page = await call(state, { limit: 7, offset });
          expect(page.total).toBe(full.length);
          expect(page.items.length).toBeLessThanOrEqual(7);
          stitched.push(...page.items.map((i) => legacyOf.get(i.id)!));
        }
        expect(stitched).toEqual(full);
      }
    }, 120_000);

    it("the response says what is on file, and each row carries what the list draws, equal to the legacy figures", async () => {
      const res = await call({});
      expect(res.onFile).toBe(backup.data.invoices!.length);
      for (const it of res.items.slice(0, 60)) {
        const legacy = (backup.data.invoices as Record<string, any>[]).find((i) => i.id === legacyOf.get(it.id))!;
        expect(it.number).toBe(legacy.invoiceNumber || null);
        expect(it.date).toBe(legacy.invoiceDate);
        expect(it.status).toBe(legacy.status);
        expect(it.totalP).toBe(legacy.grandTotal);
        expect(it.paidP).toBe(ref.paidFor(legacy.id));
        expect(it.outstandingP).toBe(ref.outstanding(legacy));
        expect(it.itemCount).toBe(legacy.lineCount);
        expect(it.shopName).toBe(legacy.shopNameSnapshot || null);
        expect(it.discountP).toBe(legacy.discountAmount);
        expect(it.chargesP).toBe(legacy.freightAmount + legacy.loadingAmount + legacy.otherCharges + legacy.taxAmount);
        expect(it.subtotalP).toBe(legacy.subtotal);
      }
    });
  });
}

defineTable("fixture", () => JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup, 45);
defineTable("synthetic ~300 invoices", () => buildSyntheticInvoices(), 100);
for (const ref of REAL_BACKUPS) defineTable(`real ${ref.label} ${ref.file} (local only)`, loadReal(ref), 25);

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, uuidV5, type Backup } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import type { PaymentListResponse } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { createLegacySearch, type LegacyState, type LegacyStore } from "./helpers/legacy-payment-search.js";
import { buildSyntheticBackup, FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * SEARCH PARITY (S4, the proof): `GET /payments` returns the SAME payments in the SAME order as the legacy algorithm
 * (38-payment-search.js: build + matcher + sortList, ported literally in helpers/legacy-payment-search.ts, which
 * imports nothing from the code under test) for a table of queries — run over three datasets:
 *   1. the committed synthetic fixture (7 payments, every ledger branch),
 *   2. a deterministic ~300-payment synthetic backup (every direction / method / status, allocations, Urdu and English
 *      names with letter variants, renamed shops, ties on date and entry time),
 *   3. the real nightly backup, when present on this machine (gitignored business data: skipped in CI).
 * Each dataset is imported through the real importer first, so the importer, `fold_search`, the SQL index and the
 * endpoint are all in the path. The query table is built FROM the data (words, numbers and dates that exist in it).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_BACKUP = path.join(here, "../../../data/business-20260922-210002-v505-6a81.json");

interface Case {
  name: string;
  state: LegacyState;
}

const KIND: Record<string, string> = { rec: "received", shops: "paidToShops", sup: "paidToSuppliers" };
const regionUuid = (legacyId: string) => uuidV5(`regions:${legacyId}`);

/** The legacy control state → the endpoint's query string. */
function toQuery(s: LegacyState, extra: Record<string, string | number> = {}): string {
  const q = new URLSearchParams();
  if (s.q !== undefined) q.set("q", s.q);
  if (s.scope) q.set("scope", s.scope);
  if (s.dir && s.dir !== "all") q.set("direction", KIND[s.dir]!);
  if (s.status) q.set("status", s.status);
  if (s.method) q.set("method", s.method);
  if (s.region) q.set("regionId", regionUuid(s.region));
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
const tsvWords = (s: string) => s.split(/\s+/).filter((w) => w.length > 1);

/** The query table, built from what the data holds. ~50 cases. */
function casesFor(b: Backup): Case[] {
  const S = b.data as unknown as LegacyStore;
  const cases: Case[] = [];
  const add = (name: string, state: LegacyState) => cases.push({ name, state });
  const first = <T>(xs: T[], f: (x: T) => boolean): T | undefined => xs.find(f);
  const pays = S.payments;

  // ── unfiltered, and the four sorts
  add("no filter, newest first", {});
  for (const sort of ["oldest", "high", "low"]) add(`no filter, sort ${sort}`, { sort });

  // ── kind, status, method
  for (const dir of ["rec", "shops", "sup"]) add(`direction ${dir}`, { dir });
  add("status REVERSED", { status: "REVERSED" });
  add("status POSTED, high", { status: "POSTED", sort: "high" });
  for (const m of [...new Set(pays.map((p) => p.method).filter(Boolean))].slice(0, 2)) add(`method ${m}`, { method: m });

  // ── dates: ranges, typed dates, months
  const d0 = pays[Math.floor(pays.length / 2)]?.paymentDate as string | undefined;
  if (d0) {
    const [y, m, d] = d0.split("-");
    const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m! - 1]!;
    add("range from-to", { from: d0, to: `${y}-${m}-28`.replace(/-28$/, +d! < 28 ? "-28" : `-${d}`) });
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
    add("typed date + direction", { q: `${d}/${m}/${y}`, dir: "rec" });
  }

  // ── amounts
  add("min above max is a problem", { minP: 900_000, maxP: 100_000 });
  add("amount range", { minP: 250_000, maxP: 2_500_000 });
  add("min only", { minP: 4_000_000, sort: "low" });
  add("max only", { maxP: 300_000, sort: "high" });
  const withPaisa = first(pays, (p) => p.amount % 100 !== 0);
  const whole = first(pays, (p) => p.amount % 100 === 0 && p.amount >= 100_000);
  if (withPaisa) {
    const r = withPaisa.amount / 100;
    add("amount typed with paisa", { q: r.toFixed(2) });
    add("amount typed grouped with paisa", { q: Number(r).toLocaleString("en-US", { minimumFractionDigits: 2 }) });
    add("amount, scope amount", { q: r.toFixed(2), scope: "amount" });
  }
  if (whole) {
    const r = whole.amount / 100;
    add("whole amount", { q: String(r) });
    add("whole amount grouped, scope amount", { q: r.toLocaleString("en-US"), scope: "amount" });
  }

  // ── numbers
  const anyRec = first(pays, (p) => p.direction === "IN") ?? pays[0];
  const anyPv = first(pays, (p) => p.direction === "OUT");
  if (anyRec) {
    add("receipt number", { q: anyRec.receiptNumber });
    add("receipt number lower-case without hyphens", { q: String(anyRec.receiptNumber).toLowerCase().replace(/-/g, "") });
    add("tail of a receipt number", { q: String(anyRec.receiptNumber).split("-").pop()! });
    add("receipt number, scope number", { q: anyRec.receiptNumber, scope: "number" });
    add("receipt number, scope reference finds nothing", { q: anyRec.receiptNumber, scope: "reference" });
  }
  if (anyPv) add("voucher prefix", { q: "PV" });

  // ── references and notes
  const withRef = first(pays, (p) => p.reference);
  if (withRef) {
    add("reference", { q: withRef.reference });
    add("reference compact", { q: String(withRef.reference).toLowerCase().replace(/[^a-z0-9]/g, "") });
    add("reference, scope reference", { q: withRef.reference, scope: "reference" });
    add("reference, scope party finds nothing", { q: withRef.reference, scope: "party" });
  }
  const withNote = first(pays, (p) => p.note);
  if (withNote) {
    const w = tsvWords(withNote.note)[0];
    if (w) {
      add("note word", { q: w });
      add("note word, scope notes", { q: w, scope: "notes" });
    }
  }
  const withDesc = first(pays, (p) => p.description);
  if (withDesc) add("description word (kept in legacy_doc)", { q: tsvWords(withDesc.description)[0] ?? "x", scope: "notes" });

  // ── parties: names, owner, phone, code, region, letter variants, renames
  const custIds = new Set(pays.filter((p) => p.partyType === "CUSTOMER").map((p) => p.partyId));
  const cust = first(S.customers, (c) => custIds.has(c.id) && String(c.sh).split(/\s+/).length >= 2) ?? S.customers.find((c) => custIds.has(c.id));
  if (cust) {
    const words = tsvWords(cust.sh);
    add("shop name", { q: cust.sh });
    add("shop name words in reverse order", { q: [...words].reverse().join(" ") });
    add("one word of a shop name", { q: words[0] ?? cust.sh, scope: "party" });
    add("shop name + a reference: both must hold", { q: `${cust.sh} ${withRef?.reference ?? "zzz"}` });
    if (cust.ph) {
      add("phone as stored", { q: cust.ph });
      add("phone without dashes", { q: String(cust.ph).replace(/\D/g, "") });
    }
    // a phrase term (a token joined by punctuation, which folds to two words) also matches with its spaces removed (legacy `hasTerm`): "trad-ers" finds "traders", "0300-1234567" finds a phone stored without a dash
    const long = words.find((w) => w.length >= 4);
    if (long) add("a word typed with a hyphen inside it still matches (spaces removed)", { q: `${long.slice(0, Math.ceil(long.length / 2))}-${long.slice(Math.ceil(long.length / 2))}` });
    const dashless = S.customers.find((c) => custIds.has(c.id) && c.ph && !String(c.ph).includes("-") && String(c.ph).length >= 8);
    if (dashless) add("a phone typed with a dash finds the dashless phone", { q: `${String(dashless.ph).slice(0, 4)}-${String(dashless.ph).slice(4)}` });
    if (cust.legacyCode) add("legacy code", { q: cust.legacyCode });
    if (cust.ow) add("owner", { q: cust.ow, scope: "party" });
    const reg = S.regions.find((r) => r.id === cust.region);
    if (reg) {
      add("region text (English)", { q: reg.en });
      add("region filter", { region: reg.id });
      add("region filter + direction", { region: reg.id, dir: "rec", sort: "oldest" });
    }
  }
  const urdu = first(S.customers, (c) => custIds.has(c.id) && /[؀-ۿ]/.test(c.sh) && swapVariants(c.sh) !== c.sh);
  if (urdu) {
    add("Urdu letter variants typed differently", { q: swapVariants(urdu.sh) });
    add("Urdu name, scope party", { q: urdu.sh, scope: "party" });
  }
  const renamedCust = first(S.customers, (c) => pays.some((p) => p.partyId === c.id && p.partyNameSnapshot && p.partyNameSnapshot !== c.sh));
  if (renamedCust) {
    const old = pays.find((p) => p.partyId === renamedCust.id)!.partyNameSnapshot as string;
    add("renamed shop found by the NEW name", { q: renamedCust.sh });
    add("renamed shop still found by the name printed on the voucher", { q: old });
    add("renamed shop by the old name, scope party", { q: old, scope: "party" });
  }
  const sup = first(S.suppliers, (s) => pays.some((p) => p.partyId === s.id));
  if (sup) {
    add("supplier name", { q: sup.co, scope: "party" });
    if (sup.ph) add("supplier phone", { q: String(sup.ph).replace(/\D/g, "") });
    if (sup.cp) add("supplier contact person", { q: sup.cp });
  }

  // ── invoices / purchases the voucher was applied to
  const alloc = first(S.paymentAllocations, (a) => a.invoiceId);
  const inv = alloc && S.invoices.find((i) => i.id === alloc.invoiceId);
  if (inv?.invoiceNumber) {
    add("invoice number", { q: inv.invoiceNumber });
    add("invoice number, scope invoice", { q: inv.invoiceNumber, scope: "invoice" });
    add("invoice number, wrong scope", { q: inv.invoiceNumber, scope: "reference" });
    add("invoice number compact", { q: String(inv.invoiceNumber).toLowerCase().replace(/-/g, "") });
  }
  const palloc = first(S.paymentAllocations, (a) => a.purchaseId);
  const pur = palloc && S.purchases.find((u) => u.id === palloc.purchaseId);
  if (pur?.purchaseNumber) add("purchase number, scope invoice", { q: pur.purchaseNumber, scope: "invoice" });

  // ── type words and reversed
  add("the word 'refund'", { q: "refund" });
  add("the word 'voucher'", { q: "voucher" });
  add("the word 'receipt'", { q: "receipt" });
  add("the words 'received from shop'", { q: "received from shop" });
  add("the word 'reversed'", { q: "reversed" });
  add("'cancelled' + a reason", { q: `cancelled ${pays.find((p) => p.reverseReason)?.reverseReason ?? "wrong"}` });
  add("a word found nowhere", { q: "qqzzxxnothing" });
  add("punctuation only is no words at all", { q: "  - / ,  " });
  return cases;
}

/** Runs the whole table against one dataset. */
function defineTable(name: string, backup: Backup): void {
  describe(`search parity — ${name}`, () => {
    let h: Harness;
    let owner: Session;
    let legacyOf: Map<string, string>;
    let ref: ReturnType<typeof createLegacySearch>;
    let cases: Case[];

    beforeAll(async () => {
      await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: `parity-${name}` });
      h = await createHarness();
      owner = await h.session("OWNER");
      legacyOf = new Map((await h.admin`SELECT id, legacy_id FROM payments`).map((r) => [r.id as string, r.legacy_id as string]));
      ref = createLegacySearch(backup.data as unknown as LegacyStore);
      cases = casesFor(backup);
    });
    afterAll(async () => {
      await h.close();
    });

    const call = async (state: LegacyState, extra: Record<string, string | number> = {}): Promise<PaymentListResponse> => {
      const res = await h.request(owner, "GET", `/payments?${toQuery(state, extra)}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as PaymentListResponse;
    };

    /** Every match, walking the pages of 200 (the endpoint's maximum) — the reference has no page size. */
    const callAll = async (state: LegacyState): Promise<PaymentListResponse> => {
      const first = await call(state);
      const items = [...first.items];
      while (items.length < first.total) items.push(...(await call(state, { offset: items.length })).items);
      return { ...first, items };
    };

    it("has a real table to run (the dataset feeds enough cases)", () => {
      expect(cases.length).toBeGreaterThanOrEqual(name === "fixture" ? 35 : 45);
    });

    it("every query returns the same ids in the same order, the same facets, the same reading of the box", async () => {
      const failures: string[] = [];
      let nonEmpty = 0;
      for (const c of cases) {
        const want = ref.list(c.state).map((p) => p.id as string);
        const got = await callAll(c.state);
        const gotIds = got.items.map((i) => legacyOf.get(i.id)!);
        if (want.length) nonEmpty++;
        if (JSON.stringify(gotIds) !== JSON.stringify(want)) failures.push(`${c.name}: want [${want.join(",")}] got [${gotIds.join(",")}]`);
        if (got.total !== want.length) failures.push(`${c.name}: total ${got.total} != ${want.length}`);
        const facets = ref.facets(c.state);
        if (JSON.stringify(got.facets) !== JSON.stringify(facets)) failures.push(`${c.name}: facets ${JSON.stringify(got.facets)} != ${JSON.stringify(facets)}`);
        const said = ref.describe(c.state);
        if (JSON.stringify(got.interpreted.terms) !== JSON.stringify(said.terms)) failures.push(`${c.name}: terms ${JSON.stringify(got.interpreted.terms)} != ${JSON.stringify(said.terms)}`);
        if (JSON.stringify(got.interpreted.problems) !== JSON.stringify(said.problems)) failures.push(`${c.name}: problems differ`);
        if (JSON.stringify(got.interpreted.dates.map((d) => [d.from, d.to, d.label])) !== JSON.stringify(said.dates.map((d) => [d.from, d.to, d.label]))) failures.push(`${c.name}: dates differ`);
      }
      expect(failures).toEqual([]);
      // the table must actually find things — otherwise "same empty list" proves nothing
      expect(nonEmpty).toBeGreaterThanOrEqual(Math.floor(cases.length * 0.6));
    }, 120_000);

    it("paging stitches back to the full list, in order, with a stable total (offset / limit walk)", async () => {
      for (const state of [{}, { sort: "high" }, { sort: "oldest", dir: "rec" }, { q: "a" }] as LegacyState[]) {
        const full = ref.list(state).map((p) => p.id as string);
        const stitched: string[] = [];
        for (let offset = 0; offset < Math.max(full.length, 1); offset += 7) {
          const page = await call(state, { limit: 7, offset });
          expect(page.total).toBe(full.length);
          expect(page.items.length).toBeLessThanOrEqual(7);
          stitched.push(...page.items.map((i) => legacyOf.get(i.id)!));
        }
        expect(stitched).toEqual(full);
      }
    });

    it("the response says what is on file, and each row carries what the screen draws", async () => {
      const res = await call({});
      expect(res.onFile).toBe(backup.data.payments!.length);
      const item = res.items[0]!;
      expect(item).toMatchObject({ kind: expect.stringMatching(/^(received|paidToShops|paidToSuppliers)$/) });
      for (const it of res.items.slice(0, 20)) {
        const legacy = (backup.data.payments as Record<string, any>[]).find((p) => p.id === legacyOf.get(it.id))!;
        expect(it.partyNameSnapshot).toBe(legacy.partyNameSnapshot || null);
        const applied = ref.entry(legacy.id).refs as string[];
        expect([...it.appliedTo].sort()).toEqual([...applied].sort());
        expect(it.unallocatedP).toBe(legacy.amount - (backup.data.paymentAllocations as Record<string, any>[]).filter((a) => a.paymentId === legacy.id).reduce((s, a) => s + a.amount, 0));
      }
    });
  });
}

defineTable("fixture", JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup);
defineTable("synthetic ~300 payments", buildSyntheticBackup());
if (existsSync(REAL_BACKUP)) defineTable("real nightly backup (local only)", JSON.parse(readFileSync(REAL_BACKUP, "utf8")) as Backup);

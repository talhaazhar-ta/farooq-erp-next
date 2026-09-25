import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exitCodeFor, reconcile, runImport, type Backup } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import type { PurchaseListResponse } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { legacyToolbar, purchaseReference, type LegacyPurchaseStore, type PurchaseState } from "./helpers/legacy-purchase-search.js";
import { buildSyntheticPurchases } from "./helpers/synthetic-purchases.js";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * PURCHASE SEARCH PARITY (S13, the proof), over three datasets imported through the real importer:
 *   1. the committed fixture (4 purchases: two godowns, a draft, a cancelled one, a part delivery, a voucher),
 *   2. a deterministic ~164-purchase synthetic backup (helpers/synthetic-purchases.ts — Urdu / English, a renamed supplier, charges,
 *      part deliveries, orders, cancelled bills, vouchers incl. reversed ones), which itself must reconcile with 0 differences,
 *   3. the newest real nightly backup, when present on this machine (never in CI).
 * For every case of a table built from the data:
 *   a. `GET /purchases` = the S13 rule written a second time (`purchaseReference`): the same ids in the same order, the same total,
 *      the same four cards, the same payment counts, the same reading of the box, the same "why it matched" lines;
 *   b. NOTHING the old Purchases page found is lost (one quirk excepted on purpose: a purchase with no godown at all passed every godown
 *      filter there): every purchase the legacy toolbar (`legacyToolbar`, a literal port of
 *      `PAGES.purchases` + `applyFilters` + `Mirror`) shows for the same box and filters is in the answer.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "../../../data");
const realBackups = existsSync(dataDir)
  ? readdirSync(dataDir)
      .filter((f) => /^business-.*\.json$/.test(f))
      .sort()
  : [];
const REAL_BACKUP = realBackups.length ? path.join(dataDir, realBackups[realBackups.length - 1]!) : null;

interface Case {
  name: string;
  state: PurchaseState;
}

const words = (s: unknown) => String(s ?? "").split(/\s+/).filter((w) => w.length > 1);
const swapVariants = (s: string) => s.replace(/ک/g, "ك").replace(/ی/g, "ي").replace(/ہ/g, "ه");

function casesFor(b: Backup): Case[] {
  const S = b.data as unknown as LegacyPurchaseStore;
  const out: Case[] = [];
  const add = (name: string, state: PurchaseState) => out.push({ name, state });
  const pur = S.purchases;
  const itemsOf = (id: string) => S.purchaseItems.filter((i) => i.purchaseId === id).sort((a, c) => a.sortOrder - c.sortOrder);
  const prod = (id: string) => S.products.find((p) => p.id === id);

  add("no filter", {});
  for (const sort of ["oldest", "high", "low", "due"] as const) add(`sort ${sort}`, { sort });
  for (const pay of ["PAID", "PARTIAL", "UNPAID"] as const) add(`payment ${pay}`, { pay });
  add("payment UNPAID, sort due", { pay: "UNPAID", sort: "due" });
  for (const wh of [...new Set([...pur.map((p) => p.warehouseId), ...S.purchaseItems.map((i) => i.warehouseId)].filter(Boolean))].slice(0, 3)) {
    add(`godown ${wh}`, { wh });
    add(`godown ${wh} + unpaid`, { wh, pay: "UNPAID", sort: "high" });
  }
  const cats = [...new Set(S.purchaseItems.map((i) => prod(i.productId)).map((p) => (p ? p.category || p.cat : null)).filter(Boolean))] as string[];
  for (const cat of cats.slice(0, 4)) add(`category ${cat}`, { cat });

  const d0 = pur[Math.floor(pur.length / 2)]?.purchaseDate as string | undefined;
  if (d0) {
    const [y, m, d] = d0.split("-");
    add("range", { from: d0, to: `${y}-12-31` });
    add("to only", { to: d0, sort: "oldest" });
    add("From after To", { from: `${y}-12-31`, to: `${y}-01-01` });
    add("typed ISO date", { q: d0 });
    add("typed day-first date", { q: `${d}/${m}/${y}` });
    add("typed date replaces from/to", { q: `${d}/${m}/${y}`, from: `${y}-01-01`, to: `${y}-01-02` });
    add("typed month", { q: `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m! - 1]} ${y}` });
  }

  // the words the data holds: number, bill, vehicle, driver, notes, supplier printed / now, products, amounts
  const sample = pur.filter((_, i) => i % Math.max(1, Math.floor(pur.length / 12)) === 0).slice(0, 14);
  for (const p of sample) {
    if (p.purchaseNumber) {
      add(`number ${p.purchaseNumber}`, { q: p.purchaseNumber });
      add(`number tail ${p.purchaseNumber}`, { q: String(p.purchaseNumber).slice(-6) });
    }
    if (p.supplierInvoiceNo) add(`bill ${p.supplierInvoiceNo}`, { q: p.supplierInvoiceNo });
    if (p.vehicleNo) add(`vehicle ${p.vehicleNo}`, { q: String(p.vehicleNo).replace(/[^A-Za-z0-9؀-ۿ]/g, "") });
    if (p.driver) add(`driver ${p.driver}`, { q: p.driver });
    if (p.notes) add(`note word`, { q: words(p.notes)[0] ?? p.notes });
    if (p.supplierNameSnapshot) add(`supplier printed`, { q: p.supplierNameSnapshot });
    const total = p.grandTotal / 100;
    add(`amount ${total}`, { q: Number(total).toLocaleString("en-US") });
    const its = itemsOf(p.id);
    for (const it of its.slice(0, 2)) {
      if (it.descriptionEnSnapshot) add(`product ${it.descriptionEnSnapshot}`, { q: it.descriptionEnSnapshot });
      if (it.descriptionSnapshot) add(`Urdu product, letter variants`, { q: swapVariants(String(it.descriptionSnapshot)) });
      const pr = prod(it.productId);
      if (pr?.sku) add(`sku ${pr.sku}`, { q: pr.sku });
      if (pr?.kg) add(`bag weight ${pr.kg}`, { q: String(pr.kg), pay: "UNPAID" });
    }
    if (its.length > 1) add("two products of one purchase", { q: `${words(its[0]!.descriptionEnSnapshot)[0]} ${words(its[1]!.descriptionEnSnapshot)[0]}` });
    if (p.supplierNameSnapshot && its[0]) add("supplier + product", { q: `${words(p.supplierNameSnapshot)[0]} ${words(its[0].descriptionEnSnapshot)[0] ?? ""}` });
  }
  for (const s of S.suppliers.filter((x) => pur.some((p) => p.supplierId === x.id)).slice(0, 6)) {
    add(`supplier now ${s.co}`, { q: s.co });
    add(`supplier now, one word, sort due`, { q: words(s.co)[0] ?? s.co, sort: "due" });
  }
  for (const cat of cats.slice(0, 3)) add(`category word typed`, { q: cat });
  add("a word found nowhere", { q: "qqzzxxnothing" });
  add("punctuation only", { q: "  - / ,  " });
  add("several at once", { q: "a", pay: "UNPAID", sort: "due" });
  return out;
}

function toQuery(s: PurchaseState, wh: Map<string, string>, extra: Record<string, string | number> = {}): string {
  const q = new URLSearchParams();
  if (s.q !== undefined) q.set("q", s.q);
  if (s.wh) q.set("warehouseId", wh.get(s.wh)!);
  if (s.cat) q.set("category", s.cat);
  if (s.pay) q.set("paymentStatus", s.pay);
  if (s.from) q.set("from", s.from);
  if (s.to) q.set("to", s.to);
  if (s.sort) q.set("sort", s.sort);
  q.set("limit", "200");
  for (const [k, v] of Object.entries(extra)) q.set(k, String(v));
  return q.toString();
}

function defineTable(name: string, load: () => Backup, minCases: number): void {
  describe(`purchase search parity — ${name}`, () => {
    let h: Harness;
    let owner: Session;
    let backup: Backup;
    let legacyOf: Map<string, string>;
    let wh: Map<string, string>;
    let cases: Case[];

    beforeAll(async () => {
      backup = load();
      await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: `purchase-parity-${name}` });
      h = await createHarness();
      owner = await h.session("OWNER");
      legacyOf = new Map((await h.admin`SELECT id, legacy_id FROM purchases`).map((r) => [r.id as string, r.legacy_id as string]));
      wh = new Map((await h.admin`SELECT id, legacy_id FROM warehouses`).map((r) => [r.legacy_id as string, r.id as string]));
      cases = casesFor(backup);
    });
    afterAll(async () => {
      await h.close();
    });

    const callAll = async (state: PurchaseState): Promise<PurchaseListResponse> => {
      const get = async (offset: number) => {
        const res = await h.request(owner, "GET", `/purchases?${toQuery(state, wh, { offset })}`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as PurchaseListResponse;
      };
      const first = await get(0);
      const items = [...first.items];
      while (items.length < first.total) items.push(...(await get(items.length)).items);
      return { ...first, items };
    };

    it("the dataset reconciles (0 balance, statement, stock, purchase total, purchase-stock and average-cost differences)", async () => {
      const report = await reconcile(backup, TEST_ADMIN_URL);
      expect(report.failures).toEqual([]);
      expect(exitCodeFor(report)).toBe(0);
      expect(report.suppliers.differences).toEqual([]);
    });

    it("GET /purchases = the S13 rule (ids, order, total, cards, payment counts, reading, why) for every case", async () => {
      expect(cases.length).toBeGreaterThanOrEqual(minCases);
      const S = backup.data as unknown as LegacyPurchaseStore;
      const wrong: string[] = [];
      let withMatches = 0;
      for (const c of cases) {
        const api = await callAll(c.state);
        const ref = purchaseReference(S, c.state);
        const got = api.items.map((i) => legacyOf.get(i.id));
        if (got.length) withMatches++;
        if (JSON.stringify(got) !== JSON.stringify(ref.ids)) wrong.push(`${c.name}: ids ${JSON.stringify(got)} vs ${JSON.stringify(ref.ids)}`);
        if (api.total !== ref.ids.length) wrong.push(`${c.name}: total ${api.total} vs ${ref.ids.length}`);
        if (JSON.stringify(api.kpis) !== JSON.stringify(ref.kpis)) wrong.push(`${c.name}: kpis ${JSON.stringify(api.kpis)} vs ${JSON.stringify(ref.kpis)}`);
        if (JSON.stringify(api.payFacets) !== JSON.stringify(ref.payFacets)) wrong.push(`${c.name}: facets ${JSON.stringify(api.payFacets)} vs ${JSON.stringify(ref.payFacets)}`);
        if (JSON.stringify(api.interpreted.problems) !== JSON.stringify(ref.problems)) wrong.push(`${c.name}: problems`);
        for (const it of api.items) {
          const want = ref.hits.get(legacyOf.get(it.id)!) ?? [];
          const have = it.hits ? it.hits.lines.map((l) => l.name) : [];
          if (JSON.stringify(have) !== JSON.stringify(want.slice(0, 3)) || (it.hits?.more ?? 0) !== Math.max(0, want.length - 3)) wrong.push(`${c.name}: hits of ${legacyOf.get(it.id)} ${JSON.stringify(have)} vs ${JSON.stringify(want)}`);
        }
      }
      console.log(`purchase parity ${name}: ${cases.length} cases, ${withMatches} with matches, ${backup.data.purchases?.length ?? 0} purchases`);
      expect(wrong).toEqual([]);
    });

    it("nothing the old Purchases page found is lost (legacy toolbar ⊆ GET /purchases) for every case", async () => {
      const S = backup.data as unknown as LegacyPurchaseStore;
      const lost: string[] = [];
      let compared = 0;
      let quirk = 0;
      // the one legacy quirk NOT ported: a purchase with no godown at all (old header-only records) passed EVERY godown filter
      // (`!d.wh`); here it passes none
      const noGodown = new Set(S.purchases.filter((p) => !p.warehouseId && !S.purchaseItems.some((i) => i.purchaseId === p.id)).map((p) => p.id as string));
      for (const c of cases) {
        if (c.state.q && /\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}|^\d{4}-\d{2}|[A-Z][a-z]{2} \d{4}/.test(c.state.q)) continue; // a typed date: the old page searched it as text, here it is a filter
        const legacy = legacyToolbar(S, c.state);
        const got = new Set((await callAll(c.state)).items.map((i) => legacyOf.get(i.id)));
        compared++;
        for (const idL of legacy) {
          if (got.has(idL)) continue;
          if (c.state.wh && noGodown.has(idL)) quirk++;
          else lost.push(`${c.name}: ${idL}`);
        }
      }
      console.log(`purchase parity ${name}: legacy toolbar compared on ${compared} cases; ${quirk} rows left out on purpose (no godown, godown filter)`);
      expect(lost).toEqual([]);
    });
  });
}

defineTable("fixture", () => JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup, 25);
defineTable("synthetic ~164 purchases", () => buildSyntheticPurchases(), 80);
if (REAL_BACKUP) defineTable(`real ${path.basename(REAL_BACKUP)}`, () => JSON.parse(readFileSync(REAL_BACKUP, "utf8")) as Backup, 25);

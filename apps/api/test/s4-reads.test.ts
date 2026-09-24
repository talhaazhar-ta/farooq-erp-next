import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, uuidV5, type Backup } from "@farooq/import";
import { customers, regions } from "@farooq/db";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { companyProfileSchema, paymentListResponseSchema, regionSchema, COMPANY_DISPLAY_FIELDS, type PaymentListResponse } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * The S4 reads that are not the parity / proof tests: the company profile, regions, the lookup filter, and the rules
 * of the payment list's contract (how the box was read, the facets, the compatibility of S3's parameters).
 * The fixture is imported first, so every number below is the fixture's, worked out on paper (see build-fixture.ts).
 */
let h: Harness;
let owner: Session;
const backup = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup;
const cust = (l: string) => uuidV5(`customers:${l}`);

beforeAll(async () => {
  await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "s4-reads" });
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

const list = async (qs = ""): Promise<PaymentListResponse> => {
  const res = await h.request(owner, "GET", `/payments${qs ? `?${qs}` : ""}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return paymentListResponseSchema.parse(res.body);
};
const nos = (r: PaymentListResponse) => r.items.map((i) => i.receiptNumber);

describe("GET /company — the whitelist, from the imported settings document", () => {
  it("returns exactly the display fields (and validates against the shared schema)", async () => {
    const res = await h.request(owner, "GET", "/company");
    expect(res.status).toBe(200);
    const c = companyProfileSchema.parse(res.body);
    expect(Object.keys(res.body).sort()).toEqual([...COMPANY_DISPLAY_FIELDS].sort());
    expect(c).toMatchObject({ businessName: "Fixture & Co", tagline: "Wholesale Dealer", taglineUr: "ہول سیل ڈیلر", logoText: "F&C", currencyLabel: "PKR", city: "Testville", bankDetails: "Fixture Bank 0000" });
  });
  it("never leaks the rest of the settings bag", async () => {
    const blob = JSON.stringify((await h.request(owner, "GET", "/company")).body);
    for (const k of ["invoicePrefix", "receiptPrefix", "smsProvider", "smsSenderId", "requirePinOnSwitch", "autoBackup", "categories", "units", "terms", "invoiceFooter", "updatedAt", "taxEnabled"]) {
      expect(blob, k).not.toContain(`"${k}"`);
    }
  });
  it("with no settings document at all: nulls and the legacy defaults", async () => {
    const [saved] = await h.admin`SELECT id, doc FROM company_profile`;
    await h.admin`DELETE FROM company_profile`;
    try {
      const c = (await h.request(owner, "GET", "/company")).body;
      expect(c).toMatchObject({ businessName: null, address: null, logoText: "F&C", currencyLabel: "PKR" });
    } finally {
      await h.admin`INSERT INTO company_profile (id, doc) VALUES (${saved!.id}, ${h.admin.json(saved!.doc)})`;
    }
  });
});

describe("GET /regions and the customer lookup's region", () => {
  it("lists the regions, by English name, with both names", async () => {
    const res = await h.request(owner, "GET", "/regions");
    expect(res.status).toBe(200);
    expect(res.body.map((r: unknown) => regionSchema.parse(r))).toEqual([
      { id: uuidV5("regions:rg-a"), nameEn: "Alpha Bazar", nameUr: "الفا بازار", active: true },
      { id: uuidV5("regions:rg-b"), nameEn: "Beta Mandi", nameUr: "بیٹا منڈی", active: true },
    ]);
  });

  it("GET /customers returns each shop's regionId and filters by it (suppliers have no region)", async () => {
    const all = (await h.request(owner, "GET", "/customers?limit=100")).body as { id: string; name: string; regionId: string | null; region: string | null }[];
    const bismillah = all.find((c) => c.id === cust("cust-2"))!;
    expect(bismillah).toMatchObject({ name: "Bismillah Store", region: "Beta Mandi", regionId: uuidV5("regions:rg-b") });
    const inB = (await h.request(owner, "GET", `/customers?regionId=${uuidV5("regions:rg-b")}`)).body as { id: string }[];
    expect(inB.map((c) => c.id)).toEqual([cust("cust-2")]);
    const inA = (await h.request(owner, "GET", `/customers?regionId=${uuidV5("regions:rg-a")}&limit=100`)).body as { id: string }[];
    expect(inA.map((c) => c.id).sort()).toEqual(["cust-1", "cust-3", "cust-4", "cust-5", "cust-6"].map(cust).sort());
    expect((await h.request(owner, "GET", `/suppliers?regionId=${uuidV5("regions:rg-a")}`)).body).toEqual([]);
    const suppliers = (await h.request(owner, "GET", "/suppliers")).body as { regionId: unknown }[];
    expect(suppliers.length).toBeGreaterThan(0);
    expect(suppliers.every((s) => s.regionId === null)).toBe(true);
    expect((await h.request(owner, "GET", "/customers?regionId=nope")).status).toBe(422);
  });
});

describe("GET /payments — the contract of the list", () => {
  it("`interpreted` says how the box was read: the folded words, the dates (label, range, what was typed, day-first)", async () => {
    const r = await list(`q=${encodeURIComponent("Al-Noor  05/02/2026")}`);
    expect(r.interpreted).toEqual({
      terms: ["al noor"],
      dates: [{ label: "05 Feb 2026", from: "2026-02-05", to: "2026-02-05", src: "05/02/2026", dayFirst: true }],
      dateFilterReplaced: false,
      problems: [],
    });
    expect(nos(r)).toEqual(["REC-2026-000001"]); // pay-1: Al-Noor's receipt of 2026-02-05
  });

  it("a typed date REPLACES from / to, and the response says it did", async () => {
    const r = await list(`q=2026-02-05&from=2026-01-01&to=2026-01-02`);
    expect(r.interpreted.dateFilterReplaced).toBe(true);
    expect(nos(r)).toEqual(["REC-2026-000001"]);
    expect((await list(`from=2026-02-05&to=2026-02-05`)).interpreted.dateFilterReplaced).toBe(false);
  });

  it("inputs that can never match are said in words, with an empty list on purpose", async () => {
    const dates = await list("from=2026-03-01&to=2026-02-01");
    expect(dates).toMatchObject({ items: [], total: 0, interpreted: { problems: ["The “From” date is after the “To” date, so no payment can match."] } });
    expect(dates.onFile).toBe(7); // the fixture's seven vouchers are still on file
    const amounts = await list("minP=500&maxP=100");
    expect(amounts.interpreted.problems).toEqual(["The minimum amount is above the maximum, so no payment can match."]);
    const both = await list("from=2026-03-01&to=2026-02-01&minP=500&maxP=100");
    expect(both.interpreted.problems).toHaveLength(2);
    expect(both.facets).toEqual({ received: { count: 0, totalP: 0 }, paidToShops: { count: 0, totalP: 0 }, paidToSuppliers: { count: 0, totalP: 0 }, reversed: { count: 0, totalP: 0 } });
  });

  it("facets count by kind under every filter EXCEPT direction / status — a reversed voucher is in `reversed` only", async () => {
    // fixture: received pay-1 700,000 · pay-6 250,000 | paid to shops pay-3 100,000 · pay-7 60,000 | paid to suppliers pay-4 250,000 | reversed pay-2 200,000 (IN) · pay-5 50,000 (OUT sup)
    const all = await list();
    expect(all.facets).toEqual({
      received: { count: 2, totalP: 950_000 },
      paidToShops: { count: 2, totalP: 160_000 },
      paidToSuppliers: { count: 1, totalP: 250_000 },
      reversed: { count: 2, totalP: 250_000 },
    });
    expect(all.total).toBe(7);
    // choosing a tab narrows the list but NOT the facets (so the tabs keep their numbers)
    const tab = await list("direction=paidToShops");
    expect(nos(tab).sort()).toEqual(["PV-2026-000001", "PV-2026-000004"]);
    expect(tab.total).toBe(2);
    expect(tab.facets).toEqual(all.facets);
    const rev = await list("status=REVERSED");
    expect(nos(rev).sort()).toEqual(["PV-2026-000003", "REC-2026-000002"]);
    expect(rev.facets).toEqual(all.facets);
    // …but a real filter (a method, a date) narrows the facets too
    const cash = await list("method=Cash");
    expect(cash.facets.received).toEqual({ count: 1, totalP: 250_000 }); // pay-1 is a Bank Transfer; pay-6 is Cash
    expect(cash.facets.paidToSuppliers).toEqual({ count: 0, totalP: 0 }); // pay-4 is JazzCash
    // and the words narrow them
    expect((await list("q=sunrise")).facets).toMatchObject({ paidToSuppliers: { count: 1, totalP: 250_000 }, received: { count: 0, totalP: 0 } });
  });

  it("S3's parameters still work: direction IN / OUT, partyType, partyId, status", async () => {
    // fixture vouchers: IN pay-1 REC-1 (02-05) · pay-2 REC-2 (02-06, reversed) · pay-6 REC-3 (02-12); OUT pay-3 PV-1 (02-14) · pay-7 PV-4 (02-16) · pay-4 PV-2 (02-20) · pay-5 PV-3 (02-22, reversed)
    expect((await list("direction=IN")).total).toBe(3);
    expect(nos(await list("direction=IN&sort=oldest"))).toEqual(["REC-2026-000001", "REC-2026-000002", "REC-2026-000003"]);
    expect(nos(await list("direction=OUT&sort=oldest"))).toEqual(["PV-2026-000001", "PV-2026-000004", "PV-2026-000002", "PV-2026-000003"]);
    expect(nos(await list("partyType=SUPPLIER&sort=oldest"))).toEqual(["PV-2026-000002", "PV-2026-000003"]);
    expect(nos(await list(`partyId=${cust("cust-1")}&sort=oldest`))).toEqual(["REC-2026-000001", "REC-2026-000002", "PV-2026-000004"]);
    expect(nos(await list("direction=all&status=POSTED&partyType=CUSTOMER&sort=oldest"))).toEqual(["REC-2026-000001", "REC-2026-000003", "PV-2026-000001", "PV-2026-000004"]);
  });

  it("each row carries what the screen draws: kind, snapshots, what it was applied to, the shop's region", async () => {
    const r = await list("q=REC-2026-000001");
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      kind: "received", partyName: "Al-Noor Traders", partyNameSnapshot: "Al-Noor Traders", partyOwnerSnapshot: "Noor", regionSnapshot: "الفا بازار — Alpha Bazar",
      appliedTo: ["INV-2026-000001", "INV-2026-000002"], allocationCount: 2, allocatedP: 700_000, unallocatedP: 0, regionId: uuidV5("regions:rg-a"), regionName: "Alpha Bazar", status: "POSTED",
    });
    const sup = (await list("q=PV-2026-000002")).items[0]!;
    expect(sup).toMatchObject({ kind: "paidToSuppliers", appliedTo: ["PUR-2026-000001"], regionId: null, regionName: null, partyName: "Sunrise Mills Ltd" });
    expect((await list("q=PV-2026-000001")).items[0]).toMatchObject({ kind: "paidToShops", appliedTo: [] });
  });

  it("a region filter keeps shops of that region and drops every supplier voucher", async () => {
    const b = await list(`regionId=${uuidV5("regions:rg-b")}`);
    expect(b.items.map((i) => i.partyName)).toEqual([]); // Bismillah Store has no payments in the fixture
    const a = await list(`regionId=${uuidV5("regions:rg-a")}`);
    expect(a.items.every((i) => i.partyType === "CUSTOMER")).toBe(true);
    expect(a.facets.paidToSuppliers.count).toBe(0);
  });

  it("untouched form fields (empty strings) are 'not set', not errors", async () => {
    const r = await list("q=&scope=&direction=&status=&method=&regionId=&from=&to=&minP=&maxP=&sort=&limit=&offset=");
    expect(r.total).toBe(7);
    expect(r.limit).toBe(50);
    expect(r.interpreted).toEqual({ terms: [], dates: [], dateFilterReplaced: false, problems: [] });
  });

  it("malformed parameters are 422 in words: unknown scope / sort / direction / kind, a bad uuid, a bad amount, a limit past 200", async () => {
    for (const qs of ["scope=everything", "sort=random", "direction=SIDEWAYS", "regionId=x", "minP=-5", "minP=1.5", "minP=abc", "limit=201", "limit=0", "offset=-1", "bogus=1", "from=13/13/2026"]) {
      const res = await h.request(owner, "GET", `/payments?${qs}`);
      expect(res.status, qs).toBe(422);
      expect(res.body.errors.length, qs).toBeGreaterThan(0);
    }
  });

  it("the words and the scope: 'notes' finds a note but not a party, 'party' a party but not a note", async () => {
    expect(nos(await list("q=refund&scope=notes&direction=paidToShops&sort=oldest"))).toEqual(["PV-2026-000001", "PV-2026-000004"]); // 'refund voucher' words of the type, and "Refund to shop" / "Refund against return"
    expect(nos(await list("q=sunrise&scope=notes"))).toEqual([]);
    expect(nos(await list("q=sunrise&scope=party"))).toEqual(["PV-2026-000002"]);
  });

  it("the search reads the party's phone through the compact form (0300-0000000 ⇄ 03000000000) for a current shop", async () => {
    // cust-5 has phone 0300-0000000; her only voucher is pay-3 (a refund)
    expect(nos(await list("q=03000000000"))).toEqual(["PV-2026-000001"]);
    expect(nos(await list("q=0300-0000000&scope=party"))).toEqual(["PV-2026-000001"]);
  });

  it("a newly recorded voucher is found at once (nothing is cached)", async () => {
    const shop = await h.seed.customer("Freshly Made Shop");
    const made = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 12_345, reference: "FRESH-77" } })).body;
    expect((await list("q=FRESH-77")).items.map((i) => i.id)).toEqual([made.id]);
    expect((await list("q=freshly%20made")).items.map((i) => i.id)).toEqual([made.id]);
    await h.request(owner, "POST", `/payments/${made.id}/reverse`, { body: { reason: "oops" } });
    const after = await list("q=FRESH-77");
    expect(after.items[0]).toMatchObject({ status: "REVERSED", kind: "received" });
    expect((await list("q=FRESH-77&status=POSTED")).total).toBe(0);
    expect((await list("q=cancelled%20oops")).items.map((i) => i.id)).toEqual([made.id]); // the reversal reason is searchable
  });

  it("a rename of the shop or its region is found at once, and what was printed on the voucher stays found (generated columns follow the row)", async () => {
    const [reg] = await h.db.insert(regions).values({ nameEn: "Zzregion", nameUr: "ژژ" }).returning();
    const [shop] = await h.db.insert(customers).values({ shopName: "Rename Probe One", regionId: reg!.id }).returning();
    const made = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop!.id, amountP: 500 } })).body;
    const ids = async (q: string) => (await list(`q=${encodeURIComponent(q)}`)).items.map((i) => i.id);
    expect(await ids("zzregion")).toEqual([made.id]);
    await h.admin`UPDATE regions SET name_en = 'Yyregion' WHERE id = ${reg!.id}`;
    await h.admin`UPDATE customers SET shop_name = 'Rename Probe Two' WHERE id = ${shop!.id}`;
    expect(await ids("yyregion")).toEqual([made.id]); // the shop's CURRENT region text
    expect(await ids("probe two")).toEqual([made.id]); // the shop's current name
    expect(await ids("probe one")).toEqual([made.id]); // the name printed on the voucher
    expect(await ids("zzregion")).toEqual([made.id]); // the region printed on the voucher ("ژژ — Zzregion")
    expect(await ids("yyregion probe one")).toEqual([made.id]); // words may come from the printed and the current text at once
    // the party scope reads the same two sources; a scope that is not the party's does not
    expect((await list("q=yyregion&scope=party")).items.map((i) => i.id)).toEqual([made.id]);
    expect((await list("q=yyregion&scope=notes")).total).toBe(0);
  });
});

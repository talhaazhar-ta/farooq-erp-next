import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, type Backup } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { purchaseListResponseSchema, type PurchaseListResponse } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * GET /purchases on the committed fixture (its header comment, "Purchases (S11)", has the lines), every number worked out by hand:
 *
 *   pur-1  PUR-2026-000001  sup-1 Sunrise Mills Ltd  20 Feb  RECEIVED            900,000  ordered 15 / received 15  paid 250,000 (PV-2026-000002)  → owes 650,000  PARTIAL
 *          L1 p-1 "Fixture Flour 50kg" (Flour) @ Main Godown 12 x 60,000;  L2 p-2 "Fixture Sugar 50kg" (Sugar) @ Second Godown 3 x 40,000
 *   pur-2  PUR-2026-000002  sup-2 Tariq Brothers     22 Feb 05:00  DRAFT         400,000  ordered 10 / received 0                                   → owes 400,000  UNPAID
 *          L1 p-3 "Fixture Rice" (Rice) @ Main Godown
 *   pur-3  PUR-2026-000003  sup-2 Tariq Brothers     22 Feb 06:00  CANCELLED     300,000  ordered 6 / received 6    (not owed)                          UNPAID
 *          L1 p-2 (Sugar) @ Main Godown
 *   pur-4  PUR-2026-000004  sup-4 الفلاح ملز          25 Feb  PARTIALLY_RECEIVED  100,000  ordered 100 / received 60                                → owes 100,000  UNPAID
 *          L1 p-3 (Rice) @ Second Godown
 *
 * Every header's godown is "Main Godown". The cards leave out the cancelled purchase: 3 purchases, 75 bags received of 125 ordered,
 * 1,400,000 of purchases, 1,150,000 owed, 3 suppliers all still owed. The payment counts include it (PARTIAL 1 / 900,000, UNPAID 3 / 800,000).
 */
let h: Harness;
let owner: Session;
let idOf: Map<string, string>;
let legacyOf: Map<string, string>;
let wh: Map<string, string>;
beforeAll(async () => {
  await runImport(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "purchases-list" });
  h = await createHarness();
  owner = await h.session("OWNER");
  const rows = await h.admin`SELECT id, legacy_id FROM purchases`;
  idOf = new Map(rows.map((r) => [r.legacy_id as string, r.id as string]));
  legacyOf = new Map(rows.map((r) => [r.id as string, r.legacy_id as string]));
  wh = new Map((await h.admin`SELECT id, legacy_id FROM warehouses`).map((r) => [r.legacy_id as string, r.id as string]));
});
afterAll(async () => {
  await h.close();
});

const list = async (qs = "", as: Session = owner): Promise<PurchaseListResponse> => {
  const res = await h.request(as, "GET", `/purchases?${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return purchaseListResponseSchema.parse(res.body);
};
const order = (r: PurchaseListResponse) => r.items.map((i) => legacyOf.get(i.id));
const q = (s: string) => `q=${encodeURIComponent(s)}`;

describe("the list, its cards and its counts (hand-computed)", () => {
  it("returns every purchase, newest first (date, then the moment it was entered), in the shared schema", async () => {
    const r = await list();
    expect(order(r)).toEqual(["pur-4", "pur-3", "pur-2", "pur-1"]);
    expect(r).toMatchObject({ total: 4, onFile: 4, limit: 50, offset: 0, interpreted: { terms: [], dates: [], dateFilterReplaced: false, problems: [] } });
  });

  it("the four cards cover the whole filtered list, cancelled left out; bags RECEIVED is not the ordered figure (fix 4)", async () => {
    expect((await list()).kpis).toEqual({ count: 3, receivedQuantity: 75, orderedQuantity: 125, valueP: 1_400_000, owedP: 1_150_000, suppliers: 3, suppliersOwed: 3 });
    // the cards follow every filter, the payment one too
    expect((await list("paymentStatus=PARTIAL")).kpis).toEqual({ count: 1, receivedQuantity: 15, orderedQuantity: 15, valueP: 900_000, owedP: 650_000, suppliers: 1, suppliersOwed: 1 });
    expect((await list(q("tariq"))).kpis).toEqual({ count: 1, receivedQuantity: 0, orderedQuantity: 10, valueP: 400_000, owedP: 400_000, suppliers: 1, suppliersOwed: 1 });
  });

  it("the payment counts ignore the payment filter (the picker shows them) and include a cancelled purchase", async () => {
    const expected = { PAID: { count: 0, totalP: 0 }, PARTIAL: { count: 1, totalP: 900_000 }, UNPAID: { count: 3, totalP: 800_000 } };
    expect((await list()).payFacets).toEqual(expected);
    expect((await list("paymentStatus=PAID")).payFacets).toEqual(expected);
  });

  it("a row: the first line (product, bag size, rate), ordered AND received bags, what POSTED vouchers paid, the derived payment status", async () => {
    const r = await list();
    const p1 = r.items.find((i) => legacyOf.get(i.id) === "pur-1")!;
    expect(p1).toMatchObject({
      number: "PUR-2026-000001",
      date: "2026-02-20",
      status: "RECEIVED",
      paymentStatus: "PARTIAL",
      supplierName: "Sunrise Mills Ltd",
      supplierCurrentName: null,
      warehouse: "Main Godown",
      firstLine: { name: "Fixture p-1", package: "50 KG", unitPriceP: 60_000 },
      lineCount: 2,
      orderedQuantity: 15,
      receivedQuantity: 15,
      totalP: 900_000,
      paidP: 250_000,
      balanceP: 650_000,
      hits: null,
    });
    const p4 = r.items.find((i) => legacyOf.get(i.id) === "pur-4")!;
    expect(p4).toMatchObject({ status: "PARTIALLY_RECEIVED", orderedQuantity: 100, receivedQuantity: 60, paymentStatus: "UNPAID", supplierName: "الفلاح ملز" });
    expect(r.items.find((i) => legacyOf.get(i.id) === "pur-3")!).toMatchObject({ status: "CANCELLED" });
    expect(r.categories).toEqual(["Flour", "Rice", "Sugar"]);
  });
});

describe("filters", () => {
  it("payment status: paid / partial / unpaid from the allocations", async () => {
    expect(order(await list("paymentStatus=PARTIAL"))).toEqual(["pur-1"]);
    expect(order(await list("paymentStatus=UNPAID"))).toEqual(["pur-4", "pur-3", "pur-2"]);
    expect(order(await list("paymentStatus=PAID"))).toEqual([]);
  });

  it("godown: the header's OR any line's (every header here is Main Godown; two lines went to the Second Godown)", async () => {
    expect(order(await list(`warehouseId=${wh.get("wh-2")}`))).toEqual(["pur-4", "pur-1"]);
    expect(order(await list(`warehouseId=${wh.get("wh-1")}`))).toEqual(["pur-4", "pur-3", "pur-2", "pur-1"]);
  });

  it("category: any line's product (pur-1's SECOND line is the sugar)", async () => {
    expect(order(await list("category=Sugar"))).toEqual(["pur-3", "pur-1"]);
    expect(order(await list("category=Rice"))).toEqual(["pur-4", "pur-2"]);
    expect(order(await list("category=Flour"))).toEqual(["pur-1"]);
    expect(order(await list("category=Nothing"))).toEqual([]);
  });

  it("dates: from / to; a From after To is said out loud and the list is empty on purpose", async () => {
    expect(order(await list("from=2026-02-21&to=2026-02-24"))).toEqual(["pur-3", "pur-2"]);
    const bad = await list("from=2026-02-24&to=2026-02-21");
    expect(bad.items).toEqual([]);
    expect(bad.interpreted.problems).toEqual(["The “From” date is after the “To” date, so no purchase can match."]);
  });

  it("the five sorts", async () => {
    expect(order(await list("sort=oldest"))).toEqual(["pur-1", "pur-2", "pur-3", "pur-4"]);
    expect(order(await list("sort=high"))).toEqual(["pur-1", "pur-2", "pur-3", "pur-4"]);
    expect(order(await list("sort=low"))).toEqual(["pur-4", "pur-3", "pur-2", "pur-1"]);
    // what is still owed; a cancelled purchase owes nothing and goes last
    expect(order(await list("sort=due"))).toEqual(["pur-1", "pur-2", "pur-4", "pur-3"]);
  });

  it("paging walks the same order", async () => {
    const a = await list("limit=3");
    const b = await list("limit=3&offset=3");
    expect([...order(a), ...order(b)]).toEqual(["pur-4", "pur-3", "pur-2", "pur-1"]);
    expect(b.total).toBe(4);
  });

  it("an unknown field or a bad value is refused (422)", async () => {
    for (const bad of ["status=RECEIVED", "paymentStatus=NOPE", "from=31-12-2026", "sort=best", "warehouseId=nope"]) {
      expect((await h.request(owner, "GET", `/purchases?${bad}`)).status, bad).toBe(422);
    }
  });
});

describe("search", () => {
  it("the supplier (printed), the number and its compact form, the amount, the product", async () => {
    expect(order(await list(q("sunrise")))).toEqual(["pur-1"]);
    expect(order(await list(q("TARIQ brothers")))).toEqual(["pur-3", "pur-2"]);
    expect(order(await list(q("PUR-2026-000004")))).toEqual(["pur-4"]);
    expect(order(await list(q("pur2026000004")))).toEqual(["pur-4"]);
    expect(order(await list(q("9,000")))).toEqual(["pur-1"]); // 900,000 paisa = Rs 9,000
    expect(order(await list(q("الفلاح")))).toEqual(["pur-4"]);
  });

  it("every word must be found, in any order, across fields", async () => {
    expect(order(await list(q("rice tariq")))).toEqual(["pur-2"]);
    expect(order(await list(q("tariq sunrise")))).toEqual([]);
  });

  it("a line's product is found by its CURRENT catalogue text (name, category, SKU, code) — the legacy toolbar's pTxt — and says which line", async () => {
    const r = await list(q("sugar"));
    expect(order(r)).toEqual(["pur-3", "pur-1"]);
    // pur-1's row shows its first line (the flour): the hint says the sugar line is why it is here
    expect(r.items.find((i) => legacyOf.get(i.id) === "pur-1")!.hits).toEqual({ lines: [{ name: "Fixture p-2", quantity: 3 }], more: 0 });
    expect(order(await list(q("SKU-p-3")))).toEqual(["pur-4", "pur-2"]);
    // a word the header explains is not "why" — even when a line holds it too ("Fixture p-1" is a line; the note says "fixture")
    expect((await list(q("sunrise"))).items[0]!.hits).toBeNull();
    await h.admin`UPDATE purchases SET notes = 'fixture delivery' WHERE legacy_id = 'pur-1'`;
    try {
      const r = await list(q("fixture"));
      expect(r.items.find((i) => legacyOf.get(i.id) === "pur-1")!.hits).toBeNull();
      expect(r.items.find((i) => legacyOf.get(i.id) === "pur-2")!.hits).toEqual({ lines: [{ name: "Fixture p-3", quantity: 10 }], more: 0 });
    } finally {
      await h.admin`UPDATE purchases SET notes = NULL WHERE legacy_id = 'pur-1'`;
    }
  });

  it("a typed date is a filter (it replaces from / to) and is echoed back, not searched as text", async () => {
    const r = await list(`${q("22/02/2026")}&from=2026-01-01&to=2026-01-31`);
    expect(order(r)).toEqual(["pur-3", "pur-2"]);
    expect(r.interpreted).toMatchObject({ terms: [], dateFilterReplaced: true, dates: [{ from: "2026-02-22", to: "2026-02-22", dayFirst: true }] });
  });

  it("vehicle, driver, supplier bill number and notes are searched", async () => {
    await h.admin`UPDATE purchases SET vehicle_no = 'LES-4471', driver = 'Aslam', supplier_invoice_no = 'SB/77', notes = 'گاڑی خراب' WHERE legacy_id = 'pur-4'`;
    for (const t of ["les4471", "LES-4471", "aslam", "SB/77", "sb77", "گاڑی"]) expect(order(await list(q(t))), t).toEqual(["pur-4"]);
    expect((await list(q("aslam"))).items[0]!.supplierInvoiceNo).toBe("SB/77");
    await h.admin`UPDATE purchases SET vehicle_no = NULL, driver = NULL, supplier_invoice_no = NULL, notes = NULL WHERE legacy_id = 'pur-4'`;
  });

  it("a renamed supplier is found by the new name AND by the name the bill printed; the row shows both", async () => {
    await h.admin`UPDATE suppliers SET company_name = 'Falah Flour Mills' WHERE legacy_id = 'sup-4'`;
    try {
      expect(order(await list(q("falah flour")))).toEqual(["pur-4"]);
      const r = await list(q("الفلاح"));
      expect(order(r)).toEqual(["pur-4"]);
      expect(r.items[0]).toMatchObject({ supplierName: "الفلاح ملز", supplierCurrentName: "Falah Flour Mills" });
    } finally {
      await h.admin`UPDATE suppliers SET company_name = 'الفلاح ملز' WHERE legacy_id = 'sup-4'`;
    }
  });

  it("nothing matching: an empty page, the count of what is on file still said", async () => {
    const r = await list(q("qqzznothing"));
    expect(r).toMatchObject({ items: [], total: 0, onFile: 4 });
    expect(r.kpis.count).toBe(0);
  });
});

describe("a reversed voucher stops counting (last: it changes the data)", () => {
  it("reversing PV-2026-000002 makes pur-1 unpaid again in the list, the cards and the counts", async () => {
    const [pv] = await h.admin`SELECT id FROM payments WHERE receipt_number = 'PV-2026-000002'`;
    const rev = await h.request(owner, "POST", `/payments/${pv!.id}/reverse`, { body: { reason: "entered twice" } });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const r = await list();
    expect(r.items.find((i) => legacyOf.get(i.id) === "pur-1")).toMatchObject({ paidP: 0, balanceP: 900_000, paymentStatus: "UNPAID" });
    expect(r.kpis.owedP).toBe(1_400_000);
    expect(r.payFacets.PARTIAL.count).toBe(0);
    expect(order(await list("paymentStatus=UNPAID"))).toEqual(["pur-4", "pur-3", "pur-2", "pur-1"]);
    expect(idOf.size).toBe(4);
  });
});

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImport, type Backup } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { invoiceListResponseSchema, type InvoiceListResponse } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { get, invBody, mkPosted, post, scenario, seedProduct, seedStock } from "./helpers/invoices.js";
import { FIXTURE_PATH } from "./helpers/synthetic-payments.js";

/**
 * GET /invoices on the committed fixture, every number worked out by hand (the fixture's header comment lists the invoices):
 *
 *   inv-1  INV-2026-000001  cust-1  01 Feb  CONFIRMED           1,000,000   paid 400,000                    → owes   600,000
 *   inv-2  INV-2026-000002  cust-1  01 Feb  PAID                  500,000   paid 300,000                    → owes   200,000   (a later entry than inv-1, same day)
 *   inv-3  (draft)          cust-1  03 Feb  DRAFT                 999,999
 *   inv-4  INV-2026-000003  cust-1  04 Feb  CANCELLED             888,888
 *   inv-5  INV-2026-000004  cust-2  10 Feb  DISPATCHED            300,000                                    → owes   300,000
 *   inv-6  INV-2026-000005  cust-3  11 Feb  PARTIALLY_PAID        750,000   paid 250,000, credit 30,000     → owes   470,000
 *   inv-7  INV-2026-000006  cust-5  12 Feb  CONFIRMED             400,000   credit 50,000                   → owes   350,000
 *   inv-8  INV-2026-000007  cust-1  15 Feb  PARTIALLY_RETURNED    600,000   credit 60,000                   → owes   540,000
 *
 * The four cards leave out the draft and the cancelled invoice: 6 invoices, 3,550,000 invoiced, 950,000 received, 2,460,000 owed;
 * the drafts card counts every draft on file (1).
 */
let h: Harness;
let owner: Session;
let idOf: Map<string, string>;
let legacyOf: Map<string, string>;
beforeAll(async () => {
  await runImport(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "invoices-list" });
  h = await createHarness();
  owner = await h.session("OWNER");
  const rows = await h.admin`SELECT id, legacy_id FROM invoices`;
  idOf = new Map(rows.map((r) => [r.legacy_id as string, r.id as string]));
  legacyOf = new Map(rows.map((r) => [r.id as string, r.legacy_id as string]));
});
afterAll(async () => {
  await h.close();
});

const list = async (qs = "", as: Session = owner): Promise<InvoiceListResponse> => {
  const res = await h.request(as, "GET", `/invoices?${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return invoiceListResponseSchema.parse(res.body);
};
const order = (r: InvoiceListResponse) => r.items.map((i) => legacyOf.get(i.id));

describe("the list, its cards and its counts (hand-computed)", () => {
  it("returns every invoice, newest first (date, then the moment it was entered), in the shared schema", async () => {
    const r = await list();
    expect(order(r)).toEqual(["inv-8", "inv-7", "inv-6", "inv-5", "inv-4", "inv-3", "inv-2", "inv-1"]);
    expect(r.total).toBe(8);
    expect(r.onFile).toBe(8);
    expect(r).toMatchObject({ limit: 50, offset: 0, interpreted: { terms: [], dates: [], dateFilterReplaced: false, problems: [] } });
  });

  it("the four cards leave out the draft and the cancelled invoice; the drafts card counts every draft on file", async () => {
    expect((await list()).kpis).toEqual({ count: 6, drafts: 1, invoicedP: 3_550_000, receivedP: 950_000, outstandingP: 2_460_000 });
    // a status filter narrows the cards to that status … but the drafts card is still "every draft"
    expect((await list("status=PAID")).kpis).toEqual({ count: 1, drafts: 1, invoicedP: 500_000, receivedP: 300_000, outstandingP: 200_000 });
    expect((await list("status=DRAFT")).kpis).toEqual({ count: 0, drafts: 1, invoicedP: 0, receivedP: 0, outstandingP: 0 });
    expect((await list("status=CANCELLED")).kpis).toEqual({ count: 0, drafts: 1, invoicedP: 0, receivedP: 0, outstandingP: 0 });
    // the cards cover the WHOLE filtered list, not the page
    expect((await list("limit=2")).kpis).toEqual({ count: 6, drafts: 1, invoicedP: 3_550_000, receivedP: 950_000, outstandingP: 2_460_000 });
    // a window: the two invoices of 1 Feb
    expect((await list("from=2026-02-01&to=2026-02-01")).kpis).toEqual({ count: 2, drafts: 1, invoicedP: 1_500_000, receivedP: 700_000, outstandingP: 800_000 });
  });

  it("counts per status ignore the status filter and honour every other one", async () => {
    const all = { DRAFT: 1, CONFIRMED: 2, DISPATCHED: 1, PARTIALLY_PAID: 1, PAID: 1, CANCELLED: 1, RETURNED: 0, PARTIALLY_RETURNED: 1 };
    const totals = { DRAFT: 999_999, CONFIRMED: 1_400_000, DISPATCHED: 300_000, PARTIALLY_PAID: 750_000, PAID: 500_000, CANCELLED: 888_888, RETURNED: 0, PARTIALLY_RETURNED: 600_000 };
    for (const qs of ["", "status=PAID", "status=DRAFT"]) {
      const f = (await list(qs)).statusFacets;
      for (const [s, n] of Object.entries(all)) expect(f[s as keyof typeof f], `${qs} ${s}`).toEqual({ count: n, totalP: totals[s as keyof typeof totals] });
    }
    // with a window of 1 Feb only inv-1 (CONFIRMED) and inv-2 (PAID) remain
    const f = (await list("from=2026-02-01&to=2026-02-01&status=DRAFT")).statusFacets;
    expect(f.CONFIRMED).toEqual({ count: 1, totalP: 1_000_000 });
    expect(f.PAID).toEqual({ count: 1, totalP: 500_000 });
    expect(f.DRAFT).toEqual({ count: 0, totalP: 0 });
  });

  it("each row carries the legacy list's figures: paid from the receipts, balance after credit notes, the totals split", async () => {
    const r = await list();
    const row = (legacy: string) => r.items.find((i) => i.id === idOf.get(legacy))!;
    expect(row("inv-1")).toMatchObject({ number: "INV-2026-000001", status: "CONFIRMED", paymentStatus: "PARTIAL", totalP: 1_000_000, paidP: 400_000, outstandingP: 600_000, itemCount: 1, quantity: 10 });
    expect(row("inv-2")).toMatchObject({ paidP: 300_000, outstandingP: 200_000, itemCount: 2, quantity: 6, paymentStatus: "PARTIAL" });
    expect(row("inv-6")).toMatchObject({ paidP: 250_000, outstandingP: 470_000, quantity: 2.5, paymentStatus: "PARTIAL" }); // 750,000 − 250,000 − the DRAFT credit note 30,000
    expect(row("inv-7")).toMatchObject({ paidP: 0, outstandingP: 350_000, paymentStatus: "UNPAID" }); // the CANCELLED credit note does not count, the POSTED one does
    expect(row("inv-8")).toMatchObject({ outstandingP: 540_000 });
    // inv-5: subtotal 3 × 100,000 + 2 × 50,000; discounts 15,000 + 110,000; charges 12,000 + 5,000 + 3,000 + tax 5,000
    expect(row("inv-5")).toMatchObject({ subtotalP: 400_000, discountP: 125_000, chargesP: 25_000, totalP: 300_000, outstandingP: 300_000 });
    // a draft has no number and no money; a cancelled invoice keeps its number
    expect(row("inv-3")).toMatchObject({ number: null, status: "DRAFT", paidP: 0 });
    expect(row("inv-4")).toMatchObject({ number: "INV-2026-000003", status: "CANCELLED" });
    // the region and warehouse printed on the invoice, and the shop's name as printed (the fixture prints none)
    expect(row("inv-5")).toMatchObject({ warehouse: "Second Godown" });
  });
});

describe("sorts", () => {
  it("oldest, highest total, lowest total — ties fall back to newest first", async () => {
    expect(order(await list("sort=oldest"))).toEqual(["inv-1", "inv-2", "inv-3", "inv-4", "inv-5", "inv-6", "inv-7", "inv-8"]);
    // 1,000,000 · 999,999 · 888,888 · 750,000 · 600,000 · 500,000 · 400,000 · 300,000
    expect(order(await list("sort=high"))).toEqual(["inv-1", "inv-3", "inv-4", "inv-6", "inv-8", "inv-2", "inv-7", "inv-5"]);
    expect(order(await list("sort=low"))).toEqual(["inv-5", "inv-7", "inv-2", "inv-8", "inv-6", "inv-4", "inv-3", "inv-1"]);
  });

  it("'Highest balance due': by what is still owed; a draft and a cancelled invoice come last (newest first among them)", async () => {
    // 600,000 · 540,000 · 470,000 · 350,000 · 300,000 · 200,000 — then the cancelled (04 Feb) and the draft (03 Feb)
    expect(order(await list("sort=due"))).toEqual(["inv-1", "inv-8", "inv-6", "inv-7", "inv-5", "inv-2", "inv-4", "inv-3"]);
  });
});

describe("filters", () => {
  it("status, region, warehouse, dates and totals", async () => {
    expect(order(await list("status=CONFIRMED"))).toEqual(["inv-7", "inv-1"]);
    expect(order(await list("status=DISPATCHED"))).toEqual(["inv-5"]);
    expect(order(await list("status=RETURNED"))).toEqual([]);
    const wh2 = (await h.admin`SELECT id FROM warehouses WHERE name = 'Second Godown'`)[0]!.id as string;
    expect(order(await list(`warehouseId=${wh2}`))).toEqual(["inv-5"]); // only inv-5 is a Second Godown invoice
    expect(order(await list("from=2026-02-10&to=2026-02-12"))).toEqual(["inv-7", "inv-6", "inv-5"]);
    expect(order(await list("from=2026-02-11"))).toEqual(["inv-8", "inv-7", "inv-6"]);
    expect(order(await list("to=2026-02-01&sort=oldest"))).toEqual(["inv-1", "inv-2"]);
    expect(order(await list("minP=600000&maxP=800000&sort=oldest"))).toEqual(["inv-6", "inv-8"]);
    expect(order(await list("minP=1000000"))).toEqual(["inv-1"]);
    const region = (await h.admin`SELECT id FROM regions WHERE name_en = 'Alpha Bazar'`)[0]!.id as string;
    expect((await list(`regionId=${region}`)).total).toBe(8); // every fixture invoice was made in the Alpha region
  });

  it("an empty box and blank controls are 'no filter' (an untouched form)", async () => {
    expect((await list("q=&scope=&status=&regionId=&warehouseId=&from=&to=&minP=&maxP=&sort=")).total).toBe(8);
  });

  it("inputs that can never match are said out loud and the list is empty on purpose", async () => {
    const a = await list("from=2026-12-31&to=2026-01-01");
    expect(a.items).toEqual([]);
    expect(a.interpreted.problems).toEqual(["The “From” date is after the “To” date, so no invoice can match."]);
    const b = await list("minP=900000&maxP=100000");
    expect(b.items).toEqual([]);
    expect(b.interpreted.problems).toEqual(["The minimum total is above the maximum, so no invoice can match."]);
    expect(b.kpis).toEqual({ count: 0, drafts: 1, invoicedP: 0, receivedP: 0, outstandingP: 0 });
    expect(b.onFile).toBe(8);
  });

  it("a date typed into the box is a date filter (and says how it was read); it replaces from / to", async () => {
    const r = await list(`q=${encodeURIComponent("12/02/2026")}&from=2026-01-01&to=2026-01-02`);
    expect(order(r)).toEqual(["inv-7"]);
    expect(r.interpreted).toMatchObject({ terms: [], dateFilterReplaced: true, dates: [{ label: "12 Feb 2026", from: "2026-02-12", to: "2026-02-12", src: "12/02/2026", dayFirst: true }] });
    expect(order(await list(`q=${encodeURIComponent("Feb 2026")}&sort=oldest`))).toHaveLength(8);
    expect((await list(`q=${encodeURIComponent("31/02/2026")}`)).total).toBe(0); // not a date: searched as text, found nowhere
  });
});

describe("search words and scopes", () => {
  it("every word must be found, in any order; the number, the total in every typed form, the product, the status word", async () => {
    expect(order(await list("q=INV-2026-000004"))).toEqual(["inv-5"]);
    expect(order(await list("q=000004+inv"))).toEqual(["inv-5"]);
    expect(order(await list("q=inv2026000004"))).toEqual(["inv-5"]); // compact form
    expect(order(await list("q=888888"))).toEqual([]); // the total is typed in rupees: 8,888.88
    expect(order(await list("q=8888.88"))).toEqual(["inv-4"]);
    expect(order(await list("q=8,888.88&scope=amount"))).toEqual(["inv-4"]);
    expect(order(await list("q=10,000"))).toEqual(["inv-1"]); // 1,000,000 paisa
    expect(order(await list("q=cancelled"))).toEqual(["inv-4"]);
    // "partly" AND "paid", each anywhere in the status words (the status and the payment status, as substrings): inv-1 / inv-2 / inv-6 are
    // "Partly paid" by their receipts, inv-8 is "Partly returned" and "Unpaid" (which contains "paid") — inv-7 is "Confirmed", "Unpaid"
    expect(order(await list("q=partly+paid&sort=oldest"))).toEqual(["inv-1", "inv-2", "inv-6", "inv-8"]);
  });

  it("the shop's CURRENT name is searched as well as the one printed on the invoice", async () => {
    // the fixture prints no name on its invoices, so only the current text can find these
    expect(order(await list("q=Bismillah+Store"))).toEqual(["inv-5"]);
    expect(order(await list("q=Bismillah&scope=customer"))).toEqual(["inv-5"]);
    expect(order(await list("q=Noor"))).toEqual(["inv-8", "inv-4", "inv-3", "inv-2", "inv-1"]); // Al-Noor Traders: cust-1's five invoices
    await h.admin`UPDATE invoices SET shop_name_snapshot = 'Old Printed Name Zed' WHERE legacy_id = 'inv-5'`;
    expect(order(await list("q=Old+Printed+Zed"))).toEqual(["inv-5"]); // found by what was printed …
    expect(order(await list("q=Bismillah"))).toEqual(["inv-5"]); // … and still by the current name
    await h.admin`UPDATE invoices SET shop_name_snapshot = NULL WHERE legacy_id = 'inv-5'`;
  });

  it("the receipt NUMBER is found only with the 'Receipt / payment ref.' scope, never in Everything", async () => {
    // REC-2026-000001 was applied to inv-1 and inv-2; REC-2026-000003 to inv-6
    expect(order(await list("q=REC-2026-000001"))).toEqual([]);
    expect(order(await list("q=REC-2026-000001&scope=payment"))).toEqual(["inv-2", "inv-1"]);
    expect(order(await list("q=rec2026000001&scope=payment"))).toEqual(["inv-2", "inv-1"]); // compact form
    expect(order(await list("q=REC-2026-000001&scope=number"))).toEqual([]);
    // the tail "000003" is INV-2026-000003 (cancelled inv-4) in Everything — NOT inv-6, which REC-2026-000003 paid; only the payment scope reaches inv-6
    expect(order(await list("q=000003"))).toEqual(["inv-4"]);
    expect(order(await list("q=000003&scope=payment"))).toEqual(["inv-6"]);
    // "000001": INV-2026-000001 (inv-1) and inv-5's dispatch note DSP-2026-000001 — but not inv-2, which REC-2026-000001 paid
    expect(order(await list("q=000001&sort=oldest"))).toEqual(["inv-1", "inv-5"]);
    expect(order(await list("q=000001&scope=payment&sort=oldest"))).toEqual(["inv-1", "inv-2"]);
    // the payment method of a receipt: also only in that scope
    expect(order(await list("q=Bank+Transfer&scope=payment"))).toEqual(["inv-2", "inv-1"]);
    expect(order(await list("q=Bank+Transfer"))).toEqual([]);
  });

  it("a REVERSED receipt is not searched at all", async () => {
    // pay-2 (REC-2026-000002, REVERSED) has no allocation in the fixture: give it one, as this database keeps a reversed receipt's allocations
    const [pay] = await h.admin`SELECT id FROM payments WHERE legacy_id = 'pay-2'`;
    await h.admin`INSERT INTO payment_allocations (payment_id, invoice_id, amount_p) VALUES (${pay!.id}, ${idOf.get("inv-7")!}, 1000)`;
    expect(order(await list("q=REC-2026-000002&scope=payment"))).toEqual([]);
    await h.admin`DELETE FROM payment_allocations WHERE payment_id = ${pay!.id}`;
  });

  it("'why it matched': the matching product lines (with bags) and receipts, only for words the number and the shop do not already explain", async () => {
    const r = await list("q=p-3&scope=product&sort=oldest");
    expect(order(r)).toEqual(["inv-2", "inv-7"]);
    expect(r.items[0]!.hits).toEqual({ lines: [{ name: "Fixture p-3", quantity: 2 }], more: 0, pays: [], morePays: 0 });
    expect(r.items[1]!.hits).toEqual({ lines: [{ name: "Fixture p-3", quantity: 5 }], more: 0, pays: [], morePays: 0 });
    // in Everything a word the shop already explains ("Noor") gets no hint; "Fixture" is only a product word, so every line that holds it is listed
    const e = await list("q=Fixture+Noor&sort=oldest");
    expect(order(e)).toEqual(["inv-1", "inv-2", "inv-3", "inv-4", "inv-8"]);
    expect(e.items.map((i) => i.hits?.lines.length)).toEqual([1, 2, 1, 1, 2]);
    // a receipt reached through its number: "Paid by REC-2026-000001"
    const p = await list("q=REC-2026-000001&scope=payment&sort=oldest");
    expect(p.items.map((i) => i.hits)).toEqual([
      { lines: [], more: 0, pays: ["REC-2026-000001"], morePays: 0 },
      { lines: [], more: 0, pays: ["REC-2026-000001"], morePays: 0 },
    ]);
    // no words, no hints; a scope with no hints has none
    expect((await list()).items.every((i) => i.hits === null)).toBe(true);
    expect((await list("q=INV-2026-000004&scope=number")).items[0]!.hits).toBeNull();
  });
});

describe("invoices made through the API are found by what a person types", () => {
  it("the cheque / transaction reference is found in Everything; the receipt number only in its own scope; the shop by name; the total in any form", async () => {
    const s = await scenario(h, { productOpts: { nameEn: "Tajwar Golden Basmati", brand: "Tajwar" } });
    const inv = await mkPosted(h, owner, s, { qty: 3, unitPriceP: 120_000, extra: { paymentMethod: "Cheque" } });
    const rec = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 100_000, method: "Cheque", reference: "CHQ-7788-QQ" } });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    const receipt = rec.body.receiptNumber as string;
    const tag = s.shop.shopName;

    // Everything looks at the reference: "why" = the receipt, with its reference
    const byRef = await list(`q=${encodeURIComponent(`${tag} chq 7788`)}`);
    expect(byRef.items.map((i) => i.id)).toEqual([inv.id]);
    expect(byRef.items[0]!.hits).toEqual({ lines: [], more: 0, pays: [`${receipt} (CHQ-7788-QQ)`], morePays: 0 });
    // … but not at the receipt NUMBER: with the shop's name as the only other word it finds nothing
    expect((await list(`q=${encodeURIComponent(`${tag} ${receipt}`)}`)).total).toBe(0);
    expect((await list(`q=${encodeURIComponent(receipt)}&scope=payment`)).items.map((i) => i.id)).toEqual([inv.id]);
    // the invoice's own payment method, and the product with its bags
    expect((await list(`q=${encodeURIComponent(`${tag} cheque`)}`)).items.map((i) => i.id)).toEqual([inv.id]);
    const prod = await list(`q=${encodeURIComponent(`${tag} golden tajwar`)}`);
    expect(prod.items[0]!.hits!.lines).toEqual([{ name: "Tajwar Golden Basmati", quantity: 3 }]);
    // 3 × 120,000 = 360,000 with 100,000 received; found by 3,600 typed in any form
    expect(prod.items[0]).toMatchObject({ totalP: 360_000, paidP: 100_000, outstandingP: 260_000, paymentStatus: "PARTIAL", status: "PARTIALLY_PAID" });
    expect((await list(`q=${encodeURIComponent(`${tag} 3,600`)}`)).items.map((i) => i.id)).toEqual([inv.id]);
    expect((await list(`q=${encodeURIComponent(`${tag} partly paid`)}`)).items.map((i) => i.id)).toEqual([inv.id]);
    // the detail agrees with the row
    const d = (await get(h, owner, inv.id)).body;
    expect([d.totalP, d.paidP, d.outstandingP]).toEqual([360_000, 100_000, 260_000]);
  });

  it("a word the shop already explains is not the reason a product line is shown: 'Tajwar' names the shop AND a line, only 'Golden' picks the line", async () => {
    const s = await scenario(h, { productOpts: { nameEn: "Tajwar Rice Special", brand: "Tajwar" } });
    const golden = await seedProduct(h, { nameEn: "Golden Flour Mill", brand: "Mill" });
    await seedStock(h, golden.id, s.wh.id, 100);
    const shop = await h.seed.customer(`Tajwar Stores ${s.shop.shopName}`);
    const r = await post(h, owner, invBody(shop.id, s.wh.id, [{ productId: s.product.id, quantity: 2, unitPriceP: 50_000 }, { productId: golden.id, quantity: 7, unitPriceP: 30_000 }]));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const res = await list(`q=${encodeURIComponent(`${s.shop.shopName} tajwar golden`)}`);
    expect(res.items.map((i) => i.id)).toEqual([r.body.id]);
    // "tajwar" and the tag are the shop's (its name); only "golden" is a product word → only the second line is why
    expect(res.items[0]!.hits).toEqual({ lines: [{ name: "Golden Flour Mill", quantity: 7 }], more: 0, pays: [], morePays: 0 });
    // asked for in the Product scope alone, every word counts (each word may be on a different line): both lines are why
    const only = await list(`q=${encodeURIComponent(`tajwar golden ${s.shop.shopName}`)}&scope=product`);
    expect(only.total).toBe(0); // the shop's tag is not a product word
    const both = (await list(`q=${encodeURIComponent("tajwar golden")}&scope=product`)).items.find((i) => i.id === r.body.id)!;
    expect(both.hits!.lines).toEqual([{ name: "Tajwar Rice Special", quantity: 2 }, { name: "Golden Flour Mill", quantity: 7 }]);
  });

  it("a reversed receipt stops being found; a cancelled invoice stays in the list but not in the cards", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 500_000 });
    const rec = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 500_000, reference: "TRX-991-ZZ" } });
    const q = `${s.shop.shopName} trx 991`;
    expect((await list(`q=${encodeURIComponent(q)}`)).items.map((i) => i.id)).toEqual([inv.id]);
    expect((await h.request(owner, "POST", `/payments/${rec.body.id}/reverse`, { body: { reason: "bounced" } })).status).toBe(200);
    expect((await list(`q=${encodeURIComponent(q)}`)).total).toBe(0);
    // cancel the invoice (its receipt is reversed, so it may): it is still listed, marked Cancelled, and leaves the cards
    const before = (await list(`q=${encodeURIComponent(s.shop.shopName)}`)).kpis;
    expect(before).toMatchObject({ count: 1, invoicedP: 500_000, receivedP: 0, outstandingP: 500_000 });
    expect((await h.request(owner, "POST", `/invoices/${inv.id}/cancel`, { body: { reason: "wrong shop" } })).status).toBe(200);
    const after = await list(`q=${encodeURIComponent(s.shop.shopName)}`);
    expect(after.items.map((i) => [i.id, i.status])).toEqual([[inv.id, "CANCELLED"]]);
    expect(after.kpis).toMatchObject({ count: 0, invoicedP: 0, receivedP: 0, outstandingP: 0 });
    expect(after.statusFacets.CANCELLED).toEqual({ count: 1, totalP: 500_000 });
  });
});

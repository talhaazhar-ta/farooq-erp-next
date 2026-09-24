import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { regions, customers } from "@farooq/db";
import { statementSchema } from "@farooq/shared";
import { createHarness, customerBalanceSql, entriesFor, trialBalance, type Harness, type Session } from "./helpers/harness.js";
import { changeShop, get, invBody, levelOf, mkPosted, movementsOf, post, put, editBody, scenario, seedWarehouse, seedProduct, seedStock, cancel } from "./helpers/invoices.js";

/**
 * Change shop — ported from the legacy `reassignCheck` / `changeCustomer` and its 91-check spec (test-invoice-change-shop.mjs).
 * The case ids in the test names (A1, B2, C5, ...) are that spec's. Base invoice: 1 bag × Rs 2,000 = 200,000 paisa, dated 2026-03-01.
 */
let h: Harness;
let owner: Session;
let sales: Session;
let accountant: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  sales = await h.session("SALES");
  accountant = await h.session("ACCOUNTANT");
});
afterAll(async () => {
  await h.close();
});

const stmt = async (customerId: string) => statementSchema.parse((await h.request(owner, "GET", `/customers/${customerId}/statement`)).body);

/** A shop with its own region, codes and contact details, so a snapshot can be told apart from another shop's. */
async function richShop(tag: string) {
  const [region] = await h.db.insert(regions).values({ nameEn: `Area ${tag}`, nameUr: `علاقہ ${tag}` }).returning();
  const [shop] = await h.db
    .insert(customers)
    .values({ shopName: `Shop ${tag}`, ownerName: `Owner ${tag}`, phone: `0300-${tag}`, regionId: region!.id, legacyCode: `C-${tag}`, legacyDoc: { wa: `wa-${tag}`, addr: `Addr ${tag}`, area: `Market ${tag}` } })
    .returning();
  return { shop: shop!, region: region! };
}

describe("A. an unpaid invoice — the plain case", () => {
  it("A1-A10: it lands on shop B with B's snapshots and B's previous balance; A's account is back to before; nothing else moved", async () => {
    const s = await scenario(h, { stock: 50 });
    const A = { shop: s.shop };
    const B = await richShop("B1");
    await h.seed.invoice(A.shop.id, { totalP: 300_000, date: "2026-02-02" }); // A owed 3,000 before the sale
    await h.seed.invoice(B.shop.id, { totalP: 777_700, date: "2026-02-01" }); // B owed 7,777 before the sale…
    await h.seed.invoice(B.shop.id, { totalP: 500_000, date: "2026-04-01" }); // …and bought again AFTER it
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 200_000, extra: { date: "2026-03-01" } });
    expect(inv.previousBalanceP).toBe(300_000);
    const balA = await customerBalanceSql(h.admin, A.shop.id); // 500,000
    const balB = await customerBalanceSql(h.admin, B.shop.id); // 1,277,700
    const movementsBefore = await movementsOf(h, inv.id);

    const r = await changeShop(h, owner, inv.id, B.shop.id, { reason: "picked the wrong shop" });
    expect(r.status).toBe(200);
    // A1 the invoice belongs to B; A2/A3 the snapshots are B's — exactly what a brand-new invoice for B carries
    expect(r.body.customerId).toBe(B.shop.id);
    expect(r.body.shop).toEqual({
      code: "C-B1", name: "Owner B1", shopName: "Shop B1", contactPerson: "Owner B1", mobile: "0300-B1", whatsapp: "wa-B1",
      address: "Addr B1", regionId: B.region.id, region: "علاقہ B1 — Area B1", market: "Market B1",
    });
    const fresh = await mkPosted(h, owner, { ...s, shop: B.shop }, { qty: 1, unitPriceP: 1_000 });
    expect(fresh.shop).toEqual(r.body.shop);
    // A4/A5 the accounts moved by exactly the invoice total
    expect(await customerBalanceSql(h.admin, A.shop.id)).toBe(balA - 200_000);
    expect(await customerBalanceSql(h.admin, B.shop.id)).toBe(balB + 200_000 + 1_000);
    // A6 number, date, total, status, lines untouched; A7 no stock moved, no new movement
    expect(r.body).toMatchObject({ number: inv.number, date: "2026-03-01", totalP: 200_000, status: "CONFIRMED", lineCount: 1, revision: inv.revision + 1 });
    expect(r.body.lines[0].id).toBe(inv.lines[0].id);
    expect(await movementsOf(h, inv.id)).toEqual(movementsBefore);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(48_000); // 50 − 1 (this invoice) − 1 (the fresh one for B)
    // A8 previous balance = B's balance the DAY BEFORE the invoice date: 7,777, not A's 3,000 and not counting B's April purchase
    expect(r.body.previousBalanceP).toBe(777_700);
    // A9 the audit log records who / what / why
    const [aud] = await h.admin`SELECT before, after, actor_id FROM audit_log WHERE entity_id = ${inv.id} AND action = 'Invoice moved to another shop'`;
    expect(aud!.actor_id).toBe(owner.userId);
    expect(aud!.before).toEqual({ customerId: A.shop.id, shop: A.shop.shopName });
    expect(aud!.after).toMatchObject({ customerId: B.shop.id, shop: "Shop B1", receiptsMoved: [], reason: "picked the wrong shop", ref: inv.number });
    // A10 on B's statement and not on A's; the journal entry's party line moved
    expect((await stmt(B.shop.id)).rows.map((x) => x.ref)).toContain(inv.number);
    expect((await stmt(A.shop.id)).rows.map((x) => x.ref)).not.toContain(inv.number);
    expect((await entriesFor(h.admin, "INVOICE", inv.id))[0]!.lines[0]).toMatchObject({ party_id: B.shop.id, debit: 200_000 });
    const tb = await trialBalance(h.admin);
    expect(tb.debit).toBe(tb.credit);
  });

  it("A12: a normal edit of the moved invoice keeps it on B and re-prices B's account", async () => {
    const s = await scenario(h);
    const B = await richShop("B2");
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 200_000 });
    const moved = await changeShop(h, owner, inv.id, B.shop.id);
    const r = await put(h, owner, inv.id, editBody(moved.body, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 2, unitPriceP: 200_000 }]));
    expect(r.status).toBe(200);
    expect(r.body.customerId).toBe(B.shop.id);
    expect(await customerBalanceSql(h.admin, B.shop.id)).toBe(400_000);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0);
  });

  it("R3: Change shop never touches stock, so an empty godown does not block it", async () => {
    const s = await scenario(h, { stock: 2 });
    const B = await richShop("B3");
    const inv = await mkPosted(h, owner, s, { qty: 2, unitPriceP: 1_000 });
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(0);
    expect((await changeShop(h, owner, inv.id, B.shop.id)).status).toBe(200);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(0);
  });
});

describe("B. receipts that belong wholly to the invoice go with it", () => {
  it("B0-B6: the receipt moves to C with C's name, both journal party lines move, A loses invoice AND receipt, C gains both", async () => {
    const s = await scenario(h);
    const C = await richShop("C1");
    await h.seed.invoice(C.shop.id, { totalP: 90_000, date: "2026-02-01" });
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 200_000, paidAmountP: 50_000, extra: { date: "2026-03-01" } });
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(150_000);
    const payId = inv.receipts[0].paymentId;

    const r = await changeShop(h, owner, inv.id, C.shop.id);
    expect(r.status).toBe(200);
    const [p] = await h.admin`SELECT party_id, party_name_snapshot, party_owner_snapshot, region_snapshot, amount_p::int AS a, status FROM payments WHERE id = ${payId}`;
    expect(p).toMatchObject({ party_id: C.shop.id, party_name_snapshot: "Shop C1", party_owner_snapshot: "Owner C1", region_snapshot: "علاقہ C1 — Area C1", a: 50_000, status: "POSTED" });
    expect((await entriesFor(h.admin, "PAYMENT", payId))[0]!.lines.find((l) => l.code === "RECEIVABLES")).toMatchObject({ party_id: C.shop.id, credit: 50_000 });
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0); // 15,000 off
    expect(await customerBalanceSql(h.admin, C.shop.id)).toBe(90_000 + 150_000);
    // B4 still 5,000 paid / 15,000 outstanding, allocation intact
    expect(r.body).toMatchObject({ paidP: 50_000, balanceP: 150_000, status: "PARTIALLY_PAID" });
    expect(r.body.receipts).toHaveLength(1);
    expect(r.body.receipts[0]).toMatchObject({ paymentId: payId, allocatedP: 50_000 });
    // B5 the receipt shows on C's statement, not A's
    expect((await stmt(C.shop.id)).rows.map((x) => x.ref)).toContain(inv.receipts[0].receiptNumber);
    expect((await stmt(s.shop.id)).rows.map((x) => x.ref)).not.toContain(inv.receipts[0].receiptNumber);
    // B6 the audit entry lists the receipt that moved
    const [aud] = await h.admin`SELECT after FROM audit_log WHERE entity_id = ${inv.id} AND action = 'Invoice moved to another shop'`;
    expect((aud!.after as { receiptsMoved: string[] }).receiptsMoved).toEqual([inv.receipts[0].receiptNumber]);
  });

  it("D10: two receipts on one invoice both move", async () => {
    const s = await scenario(h);
    const C = await richShop("C2");
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 200_000, paidAmountP: 50_000 });
    const second = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 30_000, allocations: [{ invoiceId: inv.id, amountP: 30_000 }] } });
    expect(second.status).toBe(201);
    const r = await changeShop(h, owner, inv.id, C.shop.id);
    expect(r.status).toBe(200);
    expect(r.body.receipts).toHaveLength(2);
    const parties = await h.admin`SELECT party_id FROM payments WHERE id IN (${inv.receipts[0].paymentId}, ${second.body.id})`;
    expect(parties.every((x) => x.party_id === C.shop.id)).toBe(true);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0);
    expect(await customerBalanceSql(h.admin, C.shop.id)).toBe(200_000 - 80_000);
  });

  it("C7: a REVERSED receipt does not block the move and stays on A untouched (its reversal pair still nets to 0 there)", async () => {
    const s = await scenario(h);
    const C = await richShop("C3");
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 200_000, paidAmountP: 50_000 });
    await h.request(owner, "POST", `/payments/${inv.receipts[0].paymentId}/reverse`, { body: { reason: "bounced" } });
    const r = await changeShop(h, owner, inv.id, C.shop.id);
    expect(r.status).toBe(200);
    const [p] = await h.admin`SELECT party_id FROM payments WHERE id = ${inv.receipts[0].paymentId}`;
    expect(p!.party_id).toBe(s.shop.id);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0);
    expect(await customerBalanceSql(h.admin, C.shop.id)).toBe(200_000);
  });
});

describe("C. what stops a move — the legacy messages verbatim, and nothing changes", () => {
  const unchanged = async (id: string, shopId: string) => expect((await get(h, owner, id)).body).toMatchObject({ customerId: shopId });

  it("C1: a receipt shared with another invoice blocks the move, naming the receipt", async () => {
    const s = await scenario(h);
    const C = await richShop("C4");
    const i1 = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 100_000, extra: { date: "2026-02-01" } });
    const i2 = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 100_000, extra: { date: "2026-02-02" } });
    const rec = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 150_000 } }); // 100,000 to i1, 50,000 to i2
    const r = await changeShop(h, owner, i2.id, C.shop.id);
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual([
      `Receipt ${rec.body.receiptNumber} (PKR 1,500) was also applied to other invoices or left partly on account, so it belongs to the shop, not to this one invoice. Reverse that receipt first, move the invoice, then record the money again against the right shop.`,
    ]);
    await unchanged(i2.id, s.shop.id);
    expect(await customerBalanceSql(h.admin, C.shop.id)).toBe(0);
    void i1;
  });

  it("C3: a receipt partly left on account blocks the move too", async () => {
    const s = await scenario(h);
    const C = await richShop("C5");
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 100_000 });
    const rec = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 130_000, allocations: [{ invoiceId: inv.id, amountP: 100_000 }] } });
    const r = await changeShop(h, owner, inv.id, C.shop.id);
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toContain(`Receipt ${rec.body.receiptNumber} (PKR 1,300) was also applied to other invoices or left partly on account`);
    await unchanged(inv.id, s.shop.id);
  });

  it("C5: a posted customer return blocks the move, naming the return and the current shop", async () => {
    const s = await scenario(h);
    const C = await richShop("C6");
    const inv = await mkPosted(h, owner, s, { qty: 2, unitPriceP: 10_000 });
    await h.seed.customerReturn(s.shop.id, inv.id, { totalP: 10_000, number: "CR-9" });
    const r = await changeShop(h, owner, inv.id, C.shop.id);
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual([
      `A return has been posted against this invoice (CR-9). Its credit note and any refund belong to ${s.shop.shopName}, so the invoice cannot be moved. Cancel the invoice and make a new one for the right shop instead.`,
    ]);
    await unchanged(inv.id, s.shop.id);
  });

  it("C8: a cancelled invoice cannot be moved", async () => {
    const s = await scenario(h);
    const C = await richShop("C7");
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    await cancel(h, owner, inv.id);
    const r = await changeShop(h, owner, inv.id, C.shop.id);
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual(["A cancelled invoice cannot be moved to another shop."]);
  });

  it("D1 (changed): a draft is refused with the legacy UI's wording — 'edit it and pick the other shop'", async () => {
    const s = await scenario(h);
    const C = await richShop("C8");
    const d = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
    const r = await changeShop(h, owner, d.body.id, C.shop.id);
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual(["This invoice is still a draft — edit it and pick the other shop."]);
  });

  it("G3: …and a DRAFT can change its shop through an ordinary save (nothing is posted yet)", async () => {
    const s = await scenario(h);
    const C = await richShop("C9");
    const d = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
    const r = await put(h, owner, d.body.id, editBody(d.body, { mode: "draft", customerId: C.shop.id }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ customerId: C.shop.id, status: "DRAFT" });
    expect(r.body.shop.shopName).toBe("Shop C9");
  });

  it("C9-C12: an unknown invoice, no shop, an unknown shop, and the same shop are refused (so a double-click cannot move it twice)", async () => {
    const s = await scenario(h);
    const C = await richShop("C10");
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    expect((await changeShop(h, owner, "00000000-0000-4000-8000-000000000000", C.shop.id)).body.message).toBe("Invoice not found.");
    expect((await h.request(owner, "POST", `/invoices/${inv.id}/change-shop`, { body: {} })).body.errors).toEqual(["Choose the shop this invoice belongs to."]);
    expect((await changeShop(h, owner, inv.id, "00000000-0000-4000-8000-000000000000")).body.errors).toEqual(["Choose the shop this invoice belongs to."]);
    expect((await changeShop(h, owner, inv.id, s.shop.id)).body.errors).toEqual(["That is already the shop on this invoice."]);
    const first = await changeShop(h, owner, inv.id, C.shop.id);
    expect(first.status).toBe(200);
    expect((await changeShop(h, owner, inv.id, C.shop.id)).body.errors).toEqual(["That is already the shop on this invoice."]);
  });

  it("every refusal is reported together (a cancelled invoice to the same shop lists both)", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    await cancel(h, owner, inv.id);
    const r = await changeShop(h, owner, inv.id, s.shop.id);
    expect(r.body.errors).toEqual(["A cancelled invoice cannot be moved to another shop.", "That is already the shop on this invoice."]);
  });
});

describe("X. who may (TRANSACTION_CORRECT)", () => {
  it("X1-X4: SALES gets 403 and nothing moves; the ACCOUNTANT can", async () => {
    const s = await scenario(h);
    const C = await richShop("X1");
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    expect((await changeShop(h, sales, inv.id, C.shop.id)).status).toBe(403);
    expect((await get(h, owner, inv.id)).body.customerId).toBe(s.shop.id);
    expect((await changeShop(h, accountant, inv.id, C.shop.id)).status).toBe(200);
  });
});

it("a moved invoice's stock and product are still its own: unrelated products/godowns are not disturbed by a move", async () => {
  const s = await scenario(h);
  const C = await richShop("Z1");
  const wh2 = await seedWarehouse(h);
  const p2 = await seedProduct(h, { buyP: 1 });
  await seedStock(h, p2.id, wh2.id, 9);
  const inv = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: p2.id, quantity: 3, unitPriceP: 1_000, warehouseId: wh2.id }]));
  expect(inv.status).toBe(201);
  await changeShop(h, owner, inv.body.id, C.shop.id);
  expect(await levelOf(h, p2.id, wh2.id)).toBe(6_000);
});

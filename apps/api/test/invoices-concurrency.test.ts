import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, customerBalanceSql, type Harness, type Session } from "./helpers/harness.js";
import { editBody, invBody, levelOf, mkPosted, movementSum, newKey, post, put, scenario, seedProduct, seedStock } from "./helpers/invoices.js";

/**
 * Concurrency: stock rows are locked in a fixed order, numbers come from one atomic counter, an idempotency key is claimed under an
 * advisory lock, and the revision check serialises two editors. Every test fires requests at the same time and checks what is left.
 */
let h: Harness;
let owner: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

describe("two saves racing for the last bags", () => {
  it("10 bags in the godown, two invoices of 10: exactly one is posted, the other gets the stock message; the level is 0, never negative", async () => {
    const s = await scenario(h, { stock: 10 });
    const shopB = await h.seed.customer();
    const results = await Promise.all([
      post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 10, unitPriceP: 1_000 }])),
      post(h, owner, invBody(shopB.id, s.wh.id, [{ productId: s.product.id, quantity: 10, unitPriceP: 1_000 }])),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    const refused = results.find((r) => r.status === 422)!;
    expect(refused.body.errors).toEqual([`Only 0 bags of ${s.product.nameEn} are available in ${s.wh.name}. Requested: 10.`]);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(0);
    expect(await movementSum(h, s.product.id, s.wh.id)).toBe(0);
  });

  it("six invoices of 3 bags against 10 bags: exactly three succeed (9 bags), level 1, Σ movements = level", async () => {
    const s = await scenario(h, { stock: 10 });
    const results = await Promise.all(
      Array.from({ length: 6 }, async () => post(h, owner, invBody((await h.seed.customer()).id, s.wh.id, [{ productId: s.product.id, quantity: 3, unitPriceP: 1_000 }]))),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 422)).toHaveLength(3);
    expect(codes.some((c) => c >= 500)).toBe(false);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(1_000);
    expect(await movementSum(h, s.product.id, s.wh.id)).toBe(1_000);
  });

  it("lines in opposite orders over two products never deadlock (rows are locked in one fixed order)", async () => {
    const s = await scenario(h, { stock: 500 });
    const other = await seedProduct(h, { buyP: 1 });
    await seedStock(h, other.id, s.wh.id, 500);
    const A = { productId: s.product.id, quantity: 1, unitPriceP: 1_000 };
    const B = { productId: other.id, quantity: 1, unitPriceP: 1_000 };
    const shops = await Promise.all(Array.from({ length: 12 }, () => h.seed.customer()));
    const results = await Promise.all(shops.map((shop, i) => post(h, owner, invBody(shop.id, s.wh.id, i % 2 ? [A, B] : [B, A]))));
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(201));
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(488_000);
    expect(await levelOf(h, other.id, s.wh.id)).toBe(488_000);
  });
});

describe("numbers, keys and revisions under contention", () => {
  it("eight simultaneous posts get eight distinct, consecutive numbers", async () => {
    const s = await scenario(h, { stock: 100 });
    const shops = await Promise.all(Array.from({ length: 8 }, () => h.seed.customer()));
    const results = await Promise.all(shops.map((shop) => post(h, owner, invBody(shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }]))));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const nums = results.map((r) => Number(r.body.number.slice(-6))).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(8);
    expect(nums[7]! - nums[0]!).toBe(7);
  });

  it("four simultaneous requests with the SAME idempotency key make one invoice, one receipt, one stock movement", async () => {
    const s = await scenario(h, { stock: 20 });
    const body = invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 2, unitPriceP: 100_000 }], { paidAmountP: 50_000, idempotencyKey: newKey() });
    const results = await Promise.all([post(h, owner, body), post(h, owner, body), post(h, owner, body), post(h, owner, body)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect((await h.admin`SELECT COUNT(*)::int AS c FROM invoices WHERE customer_id = ${s.shop.id}`)[0]!.c).toBe(1);
    expect((await h.admin`SELECT COUNT(*)::int AS c FROM payments WHERE party_id = ${s.shop.id}`)[0]!.c).toBe(1);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(18_000);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(150_000);
  });

  it("two editors save the same revision at once: one wins, the other is told the invoice changed (no lost update)", async () => {
    const s = await scenario(h, { stock: 100 });
    const inv = await mkPosted(h, owner, s, { qty: 10, unitPriceP: 1_000 });
    const edit = (qty: number) => put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: qty, unitPriceP: 1_000 }]));
    const results = await Promise.all([edit(15), edit(20)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    const loser = results.find((r) => r.status === 422)!;
    expect(loser.body.message).toBe("This invoice was changed by someone else since you opened it. Reload it and make your change again.");
    const winner = results.find((r) => r.status === 200)!;
    const final = winner.body.lines[0].quantity;
    expect([15, 20]).toContain(final);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe((100 - final) * 1_000);
    expect(await movementSum(h, s.product.id, s.wh.id)).toBe((100 - final) * 1_000);
  });

  it("a receipt and an edit of the same invoice at once never leave paid above the total", async () => {
    const s = await scenario(h, { stock: 100 });
    const inv = await mkPosted(h, owner, s, { qty: 10, unitPriceP: 1_000 }); // 10,000
    const receive = h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 9_000, allocations: [{ invoiceId: inv.id, amountP: 9_000 }] } });
    const shrink = put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 5, unitPriceP: 1_000 }])); // total 5,000
    const [r, e] = await Promise.all([receive, shrink]);
    const paid = Number((await h.admin`SELECT COALESCE(SUM(a.amount_p),0)::text AS p FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = ${inv.id} AND p.status = 'POSTED'`)[0]!.p);
    const total = Number((await h.admin`SELECT total_p::text AS t FROM invoices WHERE id = ${inv.id}`)[0]!.t);
    expect(paid).toBeLessThanOrEqual(total);
    expect([r.status, e.status].some((c) => c >= 500)).toBe(false);
    expect(r.status === 201 || e.status === 200).toBe(true);
  });
});

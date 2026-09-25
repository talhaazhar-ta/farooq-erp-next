import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, entriesFor, supplierBalanceSql, type Harness, type Session } from "./helpers/harness.js";
import { levelOf, movementSum } from "./helpers/invoices.js";
import { costsOf, mkPurchase, newKey, postPur, purBody, purEditBody, purScenario, putPur, vouchersFor } from "./helpers/purchases.js";

/**
 * The races the row locks exist for: purchase -> supplier -> stock levels (product, godown), and the payment numbers taken last.
 * Every test fires its requests together with Promise.all and asserts the outcome the locks must produce, never a lucky interleaving.
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

describe("races", () => {
  it("two edits of the SAME revision: one wins, the other is told it is stale; the stock reflects exactly one of them", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const pu = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const edit = (qty: number) => putPur(h, owner, pu.id, purEditBody(pu, {}, [{ id: pu.lines[0].id, productId: p.id, quantity: qty, unitPriceP: 100_000 }]));
    const [a, b] = await Promise.all([edit(15), edit(20)]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    const loser = a.status === 422 ? a : b;
    expect(loser.body.errors).toEqual(["This purchase was changed by someone else since you opened it. Reload it and make your change again."]);
    const winnerQty = a.status === 200 ? 15 : 20;
    expect(await levelOf(h, p.id, s.wh.id)).toBe(winnerQty * 1000);
    expect(await movementSum(h, p.id, s.wh.id)).toBe(winnerQty * 1000);
    expect((await h.request(owner, "GET", `/purchases/${pu.id}`)).body.revision).toBe(2);
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(winnerQty * 100_000);
    expect(await entriesFor(h.admin, "PURCHASE", pu.id)).toHaveLength(1);
  });

  it("N purchases created at once: N distinct, consecutive numbers", async () => {
    const s = await purScenario(h, 1);
    const N = 8;
    const rs = await Promise.all(Array.from({ length: N }, () => postPur(h, owner, purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 100_000 }]))));
    expect(rs.map((r) => r.status)).toEqual(Array(N).fill(201));
    const nums = rs.map((r) => Number(r.body.number.slice(-6))).sort((x, y) => x - y);
    expect(nums.slice(1).map((n, i) => n - nums[i]!)).toEqual(Array(N - 1).fill(1));
    expect(await levelOf(h, s.ps[0]!.id, s.wh.id)).toBe(N * 1000);
  });

  it("the same idempotency key sent 6 times at once: ONE purchase (201) and five replays (200)", async () => {
    const s = await purScenario(h, 1);
    const key = newKey();
    const body = purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 3, unitPriceP: 100_000 }], { idempotencyKey: key, paidAmountP: 50_000 });
    const rs = await Promise.all(Array.from({ length: 6 }, () => postPur(h, owner, body)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect(await levelOf(h, s.ps[0]!.id, s.wh.id)).toBe(3_000);
    expect(await vouchersFor(h, rs[0]!.body.id)).toHaveLength(1);
  });

  it("purchases of the same product x godown created together (and in opposite order of lines): no deadlock, the level is the sum, the average is the recomputed one", async () => {
    const s = await purScenario(h, 2);
    const [A, B] = s.ps as [typeof s.ps[number], typeof s.ps[number]];
    const forward = purBody(s.supplier.id, s.wh.id, [{ productId: A.id, quantity: 10, unitPriceP: 100_000 }, { productId: B.id, quantity: 10, unitPriceP: 100_000 }]);
    const backward = purBody(s.supplier.id, s.wh.id, [{ productId: B.id, quantity: 30, unitPriceP: 300_000 }, { productId: A.id, quantity: 30, unitPriceP: 300_000 }]);
    const rs = await Promise.all([postPur(h, owner, forward), postPur(h, owner, backward), postPur(h, owner, forward), postPur(h, owner, backward)]);
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    for (const p of [A, B]) {
      expect(await levelOf(h, p.id, s.wh.id)).toBe(80_000);
      expect(await movementSum(h, p.id, s.wh.id)).toBe(80_000);
      // (2 x 10 x 1,000 + 2 x 30 x 3,000) / 80 = 2,500
      expect((await costsOf(h, p.id, s.wh.id))!.avg).toBe(250_000);
    }
  });

  it("an edit racing an edit of ANOTHER purchase of the same product: both apply, the average is right whichever got the lock first", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const a = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const b = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const [ra, rb] = await Promise.all([
      putPur(h, owner, a.id, purEditBody(a, {}, [{ id: a.lines[0].id, productId: p.id, quantity: 10, unitPriceP: 200_000 }])),
      putPur(h, owner, b.id, purEditBody(b, {}, [{ id: b.lines[0].id, productId: p.id, quantity: 30, unitPriceP: 400_000 }])),
    ]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect(await levelOf(h, p.id, s.wh.id)).toBe(40_000);
    // (10 x 2,000 + 30 x 4,000) / 40 = 3,500 - the LAST writer recomputed from BOTH final lines, so the figure is right whichever ran last
    expect((await costsOf(h, p.id, s.wh.id))!.avg).toBe(350_000);
  });

  it("an edit that pays and a supplier payment allocated to the same purchase, at once: no deadlock, and together they never pay more than the bill", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const pu = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]); // 1,000,000
    const [edit, pay] = await Promise.all([
      putPur(h, owner, pu.id, purEditBody(pu, { paidAmountP: 700_000 })),
      h.request(owner, "POST", "/payments/pay", { body: { supplierId: s.supplier.id, amountP: 700_000, allocations: [{ purchaseId: pu.id, amountP: 700_000 }] } }),
    ]);
    // whichever takes the purchase's lock first: if the edit, it writes the 700,000 voucher and the payment (700,000 > the 300,000 left) is refused;
    // if the payment, the edit finds 700,000 already paid and, asking for 700,000 in all, writes no second voucher. Either way exactly 700,000 is paid.
    expect(edit.status).toBe(200);
    expect([201, 422]).toContain(pay.status);
    expect((await h.request(owner, "GET", `/purchases/${pu.id}`)).body.paidP).toBe(700_000);
    const posted = (await vouchersFor(h, pu.id)).filter((v) => v.status === "POSTED");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.allocated).toBe(700_000);
  });
});

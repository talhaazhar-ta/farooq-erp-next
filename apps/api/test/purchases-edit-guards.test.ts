import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, entriesFor, supplierBalanceSql, type Harness, type Session } from "./helpers/harness.js";
import { invBody, levelOf, post, seedProduct } from "./helpers/invoices.js";
import { withCostBasis } from "./helpers/cost-basis.js";
import { costsOf, mkPurchase, newKey, purAudit, purEditBody, purMovements, purScenario, putPur, vouchersFor, type PurScenario } from "./helpers/purchases.js";

/**
 * What an edit must REFUSE (the legacy `Purchases.editErrors`, `test-purchase-edit.mjs` F-J) — the wording is the legacy wording, every
 * time; a refused edit writes nothing at all (proved by a snapshot of everything an edit could touch).
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

const ok = (r: { status: number; body: any }) => {
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const refused = (r: { status: number; body: any }) => {
  expect(r.status, JSON.stringify(r.body)).toBe(422);
  return r.body.errors as string[];
};

/** Everything an edit could touch, for "…and nothing at all was written". */
const snap = async (s: PurScenario, id: string) =>
  JSON.stringify({
    pu: (await h.admin`SELECT revision, total_p::text, status, supplier_id FROM purchases WHERE id = ${id}`)[0],
    items: await h.admin`SELECT id, product_id, qty_milli::text, received_qty_milli::text, unit_price_p::text, operational_share_p::text FROM purchase_items WHERE purchase_id = ${id} ORDER BY sort_order`,
    mv: (await h.admin`SELECT count(*)::int AS n FROM stock_movements WHERE source_id = ${id}`)[0],
    levels: await h.admin`SELECT product_id, qty_milli::text, avg_cost_p::text, last_cost_p::text FROM stock_levels WHERE warehouse_id = ${s.wh.id} ORDER BY product_id, bucket`,
    pays: (await h.admin`SELECT count(*)::int AS n FROM payment_allocations WHERE purchase_id = ${id}`)[0],
    je: await h.admin`SELECT e.date::text, l.debit_p::text, l.credit_p::text FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.source_id = ${id} ORDER BY l.debit_p, l.credit_p`,
    audit: (await h.admin`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ${id}`)[0],
    owed: await supplierBalanceSql(h.admin, s.supplier.id),
  });

/* ══════════ F. the stock guard ══════════ */
describe("F the stock guard — bags that were sold cannot be un-received", () => {
  it("F0-F5: 100 bags bought, 80 sold, 20 left", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const shop = await h.seed.customer();
    const f0 = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 100, unitPriceP: 100_000 }]);
    const sale = await post(h, owner, invBody(shop.id, s.wh.id, [{ productId: p.id, quantity: 80, unitPriceP: 150_000 }]));
    expect(sale.status, JSON.stringify(sale.body)).toBe(201);
    expect(await levelOf(h, p.id, s.wh.id)).toBe(20_000); // F0

    const before = await snap(s, f0.id);
    const f1 = refused(await putPur(h, owner, f0.id, purEditBody(f0, {}, [{ id: f0.lines[0].id, productId: p.id, quantity: 30, unitPriceP: 100_000 }])));
    expect(f1).toEqual([`Only 20 bags of ${p.nameEn} are in ${s.wh.name} now, but this edit takes 70 fewer bags into stock than before. The rest of that delivery has already been sold or moved, so it cannot be reduced by that much.`]);
    expect(await snap(s, f0.id)).toBe(before); // F2: nothing at all was written

    // F3: cutting it by 15 (fits in the 20 left) is allowed
    const f3 = ok(await putPur(h, owner, f0.id, purEditBody(f0, {}, [{ id: f0.lines[0].id, productId: p.id, quantity: 85, unitPriceP: 100_000 }])));
    expect(await levelOf(h, p.id, s.wh.id)).toBe(5_000);
    expect((await purMovements(h, f0.id))[1]).toMatchObject({ kind: "PURCHASE_REVERSAL_OUT", q: -15_000, cost: null });

    // F4: changing only the note and the rate works while the bags are mostly sold — an untouched quantity never fails
    const f4 = ok(await putPur(h, owner, f0.id, purEditBody(f3, { notes: "only the note" }, [{ id: f3.lines[0].id, productId: p.id, quantity: 85, unitPriceP: 110_000 }])));
    expect(f4).toMatchObject({ notes: "only the note" });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(5_000);

    // F5: with "allow negative stock" on, the same cut goes through and the level goes below zero
    await withCostBasis(h, "LANDED", async () => {
      ok(await putPur(h, owner, f0.id, purEditBody(f4, {}, [{ id: f4.lines[0].id, productId: p.id, quantity: 10, unitPriceP: 110_000 }])));
    }, { allowNegativeStock: true });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(5_000 - 75_000);
  });

  it("moving a delivery to another godown is judged per product x godown: the old godown must be able to give the bags back", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const shop = await h.seed.customer();
    const wh2 = (await import("./helpers/invoices.js")).seedWarehouse;
    const other = await wh2(h);
    const f = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    expect((await post(h, owner, invBody(shop.id, s.wh.id, [{ productId: p.id, quantity: 8, unitPriceP: 150_000 }]))).status).toBe(201);
    const errs = refused(await putPur(h, owner, f.id, purEditBody(f, { warehouseId: other.id }, [{ id: f.lines[0].id, productId: p.id, quantity: 10, unitPriceP: 100_000, warehouseId: other.id }])));
    expect(errs[0]).toMatch(new RegExp(`^Only 2 bags of ${p.nameEn} are in ${s.wh.name} now, but this edit takes 10 fewer bags into stock than before`));
  });
});

/* ══════════ G. supplier returns ══════════ */
describe("G a line with bags sent back to the supplier cannot go away", () => {
  it("G0-G8", async () => {
    const s = await purScenario(h, 3);
    const [pG, pG2, pOther] = s.ps as [PurScenario["ps"][number], PurScenario["ps"][number], PurScenario["ps"][number]];
    const g0 = await mkPurchase(h, owner, s, [
      { productId: pG.id, quantity: 100, unitPriceP: 100_000 },
      { productId: pG2.id, quantity: 20, unitPriceP: 50_000 },
    ]);
    // 10 bags went back to the supplier against line 1 (M5 writes this; here the row a return would leave)
    await h.admin`UPDATE purchase_items SET returned_qty_milli = 10000 WHERE id = ${g0.lines[0].id}`;
    await h.admin`UPDATE purchases SET legacy_id = ${`legacy-${g0.id}`} WHERE id = ${g0.id}`;
    await h.admin`INSERT INTO returns (kind, party_id, return_number, date, total_p, status, legacy_doc) VALUES ('SUPPLIER', ${s.supplier.id}, 'SR-T-1', '2026-03-05', 1000000, 'POSTED', ${h.admin.json({ purchaseId: `legacy-${g0.id}` } as never)})`;
    const cur = (await h.request(owner, "GET", `/purchases/${g0.id}`)).body;
    expect(cur.lines[0].returnedQuantity).toBe(10);

    // G1-G2: raising the quantity on a returned line works, the line is the same record, the returned bags are still recorded against it
    const g1 = ok(await putPur(h, owner, g0.id, purEditBody(cur, {}, [
      { id: cur.lines[0].id, productId: pG.id, quantity: 150, unitPriceP: 110_000, warehouseId: s.wh.id },
      { id: cur.lines[1].id, productId: pG2.id, quantity: 20, unitPriceP: 50_000, warehouseId: s.wh.id },
    ])));
    expect(g1.lines[0]).toMatchObject({ id: cur.lines[0].id, quantity: 150, returnedQuantity: 10 });

    const before = await snap(s, g0.id);
    // G3: showing fewer bags received than were returned is refused
    const g3 = refused(await putPur(h, owner, g0.id, purEditBody(g1, {}, [{ id: g1.lines[0].id, productId: pG.id, quantity: 8, unitPriceP: 110_000 }, { id: g1.lines[1].id, productId: pG2.id, quantity: 20, unitPriceP: 50_000 }])));
    expect(g3).toEqual([`${pG.nameEn}: 10 bags were already returned to the supplier, so fewer than 10 cannot be shown as received.`]);
    // G4: removing that line is refused, saying why
    const g4 = refused(await putPur(h, owner, g0.id, purEditBody(g1, {}, [{ id: g1.lines[1].id, productId: pG2.id, quantity: 20, unitPriceP: 50_000 }])));
    expect(g4).toEqual([`${pG.nameEn}: 10 bags have been returned to the supplier, so this line cannot be removed. It can be reduced, but not below the bags already returned.`]);
    // G5: turning it into a different product is refused
    const g5 = refused(await putPur(h, owner, g0.id, purEditBody(g1, {}, [{ id: g1.lines[0].id, productId: pOther.id, quantity: 150, unitPriceP: 110_000 }, { id: g1.lines[1].id, productId: pG2.id, quantity: 20, unitPriceP: 50_000 }])));
    expect(g5).toEqual([`${pG.nameEn}: 10 bags have been returned to the supplier, so its product and warehouse cannot be changed.`]);
    // G6: moving the purchase to another supplier is refused — the return belongs to this one
    const sup2 = await h.seed.supplier();
    const g6 = refused(await putPur(h, owner, g0.id, purEditBody(g1, { supplierId: sup2.id })));
    expect(g6).toEqual(["A return to the supplier has been posted against this purchase (SR-T-1), so the supplier cannot be changed."]);
    expect(await snap(s, g0.id)).toBe(before); // G7: none of the refusals wrote anything

    // G8: a line WITHOUT returns can still be removed from the same purchase
    const g8 = ok(await putPur(h, owner, g0.id, purEditBody(g1, {}, [{ id: g1.lines[0].id, productId: pG.id, quantity: 150, unitPriceP: 110_000 }])));
    expect(g8.lines).toHaveLength(1);
    expect(g8.lines[0].id).toBe(g1.lines[0].id);
  });

  it("returned bags on a line lock the supplier even when no return document names the purchase (a purchase made here has no legacy id)", async () => {
    // S13: this half of the lock had no test of its own — removing it left every test green (the return row of G0-G8 locks on its own)
    const s = await purScenario(h, 1);
    const g = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 30, unitPriceP: 100_000 }]);
    await h.admin`UPDATE purchase_items SET returned_qty_milli = 5000 WHERE id = ${g.lines[0].id}`;
    const [row] = await h.admin<{ legacy_id: string | null }[]>`SELECT legacy_id FROM purchases WHERE id = ${g.id}`;
    expect(row!.legacy_id).toBeNull();
    const before = await snap(s, g.id);
    const sup2 = await h.seed.supplier();
    expect(refused(await putPur(h, owner, g.id, purEditBody(g, { supplierId: sup2.id })))).toEqual([
      "A return to the supplier has been posted against this purchase ((no number)), so the supplier cannot be changed.",
    ]);
    expect(await snap(s, g.id)).toBe(before);
  });

  it("a cancelled return does not lock the supplier", async () => {
    const s = await purScenario(h, 1);
    const g = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 5, unitPriceP: 100_000 }]);
    await h.admin`UPDATE purchases SET legacy_id = ${`legacy-${g.id}`} WHERE id = ${g.id}`;
    await h.admin`INSERT INTO returns (kind, party_id, return_number, date, total_p, status, legacy_doc) VALUES ('SUPPLIER', ${s.supplier.id}, 'SR-T-2', '2026-03-05', 1, 'CANCELLED', ${h.admin.json({ purchaseId: `legacy-${g.id}` } as never)})`;
    const sup2 = await h.seed.supplier();
    ok(await putPur(h, owner, g.id, purEditBody(g, { supplierId: sup2.id })));
  });
});

/* ══════════ H. landed costs ══════════ */
describe("H the landed-cost share stays with its line", () => {
  it("H0-H4", async () => {
    const s = await purScenario(h, 2);
    const [pH, pH2] = s.ps as [PurScenario["ps"][number], PurScenario["ps"][number]];
    const h0 = await mkPurchase(h, owner, s, [
      { productId: pH.id, quantity: 100, unitPriceP: 100_000 },
      { productId: pH2.id, quantity: 100, unitPriceP: 100_000 },
    ]);
    // a transport cost of 4,000 was spread over both lines by the landed-cost module (M6): 2,000 each = 200,000 paisa (a number written on the line)
    await h.admin`UPDATE purchase_items SET operational_share_p = 200000 WHERE purchase_id = ${h0.id}`;
    const cur = (await h.request(owner, "GET", `/purchases/${h0.id}`)).body;
    expect(cur.lines.map((l: any) => l.operationalShareP)).toEqual([200_000, 200_000]);

    // H1-H2: doubling the quantity keeps the SAME line and the SAME share; the landed unit is re-worked for 200 bags (share / 200, not / 100)
    const h1 = ok(await putPur(h, owner, h0.id, purEditBody(cur, {}, [
      { id: cur.lines[0].id, productId: pH.id, quantity: 200, unitPriceP: 100_000, warehouseId: s.wh.id },
      { id: cur.lines[1].id, productId: pH2.id, quantity: 100, unitPriceP: 100_000, warehouseId: s.wh.id },
    ])));
    expect(h1.lines[0]).toMatchObject({ id: cur.lines[0].id, operationalShareP: 200_000, goodsUnitCostP: 100_000, chargeShareP: 0, landedUnitCostP: 100_000 + 1_000 }); // 100,000 + round(200,000 / 200)
    expect(h1.lines[1]).toMatchObject({ operationalShareP: 200_000, landedUnitCostP: 100_000 + 2_000 }); // + round(200,000 / 100)
    expect(await costsOf(h, pH.id, s.wh.id)).toEqual({ avg: 101_000, last: 101_000 });
    expect(await costsOf(h, pH2.id, s.wh.id)).toEqual({ avg: 102_000, last: 102_000 });

    // H3: removing a line that carries landed costs is refused — cancel that entry first
    const before = await snap(s, h0.id);
    const h3 = refused(await putPur(h, owner, h0.id, purEditBody(h1, {}, [{ id: h1.lines[0].id, productId: pH.id, quantity: 200, unitPriceP: 100_000 }])));
    expect(h3).toEqual([`${pH2.nameEn}: landed costs have been spread over it, so this line cannot be removed. Cancel the landed-cost entry first.`]);
    // ... or turning it into another product
    const h3b = refused(await putPur(h, owner, h0.id, purEditBody(h1, {}, [{ id: h1.lines[0].id, productId: pH.id, quantity: 200, unitPriceP: 100_000 }, { id: h1.lines[1].id, productId: pH.id, quantity: 100, unitPriceP: 100_000 }])));
    expect(h3b).toEqual([`${pH2.nameEn}: landed costs have been spread over it, so its product and warehouse cannot be changed.`]);
    expect(await snap(s, h0.id)).toBe(before);

    // H4: once that entry is cancelled (the share is 0 — a real number, a cancelled landed cost leaves 0) the line can go
    await h.admin`UPDATE purchase_items SET operational_share_p = 0 WHERE id = ${h1.lines[1].id}`;
    const h4 = ok(await putPur(h, owner, h0.id, purEditBody(h1, {}, [{ id: h1.lines[0].id, productId: pH.id, quantity: 200, unitPriceP: 100_000 }])));
    expect(h4.lines).toHaveLength(1);
  });
});

/* ══════════ I. changing the supplier ══════════ */
describe("I the supplier can change only while nothing is attached to the purchase", () => {
  it("I0-I3: with nothing attached the bill moves from one account to the other; once money is paid against it the supplier is locked", async () => {
    const s = await purScenario(h, 1);
    const sup2 = await h.seed.supplier();
    const i0 = await mkPurchase(h, owner, s, [{ productId: s.ps[0]!.id, quantity: 10, unitPriceP: 100_000 }]);
    const owed1 = await supplierBalanceSql(h.admin, s.supplier.id);
    const owed2 = await supplierBalanceSql(h.admin, sup2.id);
    const i1 = ok(await putPur(h, owner, i0.id, purEditBody(i0, { supplierId: sup2.id })));
    expect(i1).toMatchObject({ supplierId: sup2.id, supplierName: sup2.companyName });
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(owed1 - 1_000_000);
    expect(await supplierBalanceSql(h.admin, sup2.id)).toBe(owed2 + 1_000_000);
    const [entry] = await entriesFor(h.admin, "PURCHASE", i0.id);
    expect(entry!.lines.find((l) => l.code === "PAYABLES")).toMatchObject({ party_id: sup2.id, credit: 1_000_000 });

    // I2: pay 1,000 with it (to the NEW supplier), then the supplier is locked
    const i2 = ok(await putPur(h, owner, i0.id, purEditBody(i1, { paidAmountP: 100_000 })));
    const v = await vouchersFor(h, i0.id);
    const back = refused(await putPur(h, owner, i0.id, purEditBody(i2, { supplierId: s.supplier.id })));
    expect(back).toEqual([`Money has already been paid against this purchase (${v[0]!.number}), and it belongs to this supplier — so the supplier cannot be changed here. Reverse that payment voucher first.`]);
    // ... but once that voucher is reversed nothing is attached any more
    const pay = (await h.request(owner, "GET", `/purchases/${i0.id}`)).body.payments[0];
    expect((await h.request(owner, "POST", `/payments/${pay.paymentId}/reverse`, { body: { reason: "wrong" } })).status).toBe(200);
    const cur = (await h.request(owner, "GET", `/purchases/${i0.id}`)).body;
    ok(await putPur(h, owner, i0.id, purEditBody(cur, { supplierId: s.supplier.id })));
  });
});

/* ══════════ J. double submission, validation ══════════ */
describe("J double submission and ordinary validation still apply to an edit", () => {
  it("J1 the very same form submitted twice (same idempotency key) is applied once", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const j0 = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const key = newKey();
    const body = purEditBody(j0, { idempotencyKey: key }, [{ id: j0.lines[0].id, productId: p.id, quantity: 12, unitPriceP: 100_000 }]);
    const a = ok(await putPur(h, owner, j0.id, body));
    const b = ok(await putPur(h, owner, j0.id, body));
    expect(b.revision).toBe(a.revision);
    expect(await levelOf(h, p.id, s.wh.id)).toBe(12_000);
    expect(await purMovements(h, j0.id)).toHaveLength(2);
  });

  it("J1b the same form WITHOUT a key, sent twice, is refused the second time as stale (it was edited since)", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const j0 = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const body = purEditBody(j0, {}, [{ id: j0.lines[0].id, productId: p.id, quantity: 12, unitPriceP: 100_000 }]);
    ok(await putPur(h, owner, j0.id, body));
    expect(refused(await putPur(h, owner, j0.id, body))).toEqual(["This purchase was changed by someone else since you opened it. Reload it and make your change again."]);
    expect(await levelOf(h, p.id, s.wh.id)).toBe(12_000);
  });

  it("J2-J3 quantity must be above zero; a supplier is still required; a product must be chosen; nothing else is written", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const j0 = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const before = await snap(s, j0.id);
    expect(refused(await putPur(h, owner, j0.id, purEditBody(j0, {}, [{ id: j0.lines[0].id, productId: p.id, quantity: 0, unitPriceP: 100_000 }])))).toContain("Line 1: quantity must be more than zero.");
    expect(refused(await putPur(h, owner, j0.id, purEditBody(j0, { supplierId: "" })))).toContain("Choose a supplier.");
    expect(refused(await putPur(h, owner, j0.id, purEditBody(j0, {}, [])))).toContain("Add at least one product line.");
    expect(refused(await putPur(h, owner, j0.id, purEditBody(j0, {}, [{ id: j0.lines[0].id, productId: p.id, quantity: 1, unitPriceP: -1 }])))).toContain("Line 1: invalid rate.");
    expect(await snap(s, j0.id)).toBe(before);
  });

  it("a line id that is not this purchase's is refused (no cross-purchase line theft)", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const a = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const b = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const errs = refused(await putPur(h, owner, a.id, purEditBody(a, {}, [{ id: b.lines[0].id, productId: p.id, quantity: 10, unitPriceP: 100_000 }])));
    expect(errs[0]).toMatch(/^Line 1: that line does not belong to this purchase/);
    // and the same line twice
    const dup = refused(await putPur(h, owner, a.id, purEditBody(a, {}, [{ id: a.lines[0].id, productId: p.id, quantity: 1, unitPriceP: 1 }, { id: a.lines[0].id, productId: p.id, quantity: 1, unitPriceP: 1 }])));
    expect(dup[0]).toMatch(/^Line 2: that line appears twice/);
  });
});

/* ══════════ new rules (owner decisions 2026-09-25) ══════════ */
describe("owner decisions: a line discount above the line amount is refused; the amount paid is bounded", () => {
  it("a discount larger than the line amount is refused on a new purchase and an edit", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const r = await h.request(owner, "POST", "/purchases", { body: { supplierId: s.supplier.id, warehouseId: s.wh.id, lines: [{ productId: p.id, quantity: 2, unitPriceP: 100_000, discountP: 200_001 }] } });
    expect(refused(r)).toEqual(["Line 1: the discount is larger than the line amount."]);
    const ok1 = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 2, unitPriceP: 100_000, discountP: 200_000 }]); // exactly the line amount is fine
    expect(ok1.totalP).toBe(0);
    expect(refused(await putPur(h, owner, ok1.id, purEditBody(ok1, {}, [{ id: ok1.lines[0].id, productId: p.id, quantity: 2, unitPriceP: 100_000, discountP: 200_001 }])))).toEqual(["Line 1: the discount is larger than the line amount."]);
  });

  it("negative discount / charges, more than 3 decimals, and an unknown product are refused with their own sentences", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const r = await h.request(owner, "POST", "/purchases", {
      body: { supplierId: s.supplier.id, warehouseId: s.wh.id, invoiceDiscountP: -1, freightP: -1, loadingP: -1, otherChargesP: -1, lines: [{ productId: p.id, quantity: 1.0005, unitPriceP: 100_000 }, { productId: "00000000-0000-4000-8000-000000000000", quantity: 1, unitPriceP: 1 }] },
    });
    const e = refused(r);
    expect(e).toEqual(
      expect.arrayContaining(["The discount cannot be negative.", "The freight cannot be negative.", "The loading charge cannot be negative.", "The other charges cannot be negative.", `Line 1 (${p.nameEn}): the quantity can have at most 3 decimal places.`, "Line 2: that product no longer exists."]),
    );
  });

  it("a warehouse that does not exist: 'Choose the destination warehouse.'", async () => {
    const s = await purScenario(h, 1);
    const r = await h.request(owner, "POST", "/purchases", { body: { supplierId: s.supplier.id, warehouseId: "00000000-0000-4000-8000-000000000000", lines: [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 1 }] } });
    expect(refused(r)).toContain("Choose the destination warehouse.");
  });
});

/* ══════════ concurrency-free edges of the edit path ══════════ */
describe("stale, cancelled and imported purchases", () => {
  it("an edit that does not say which version it edited is refused; a stale one is refused", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const a = await mkPurchase(h, owner, s, [{ productId: p.id, quantity: 10, unitPriceP: 100_000 }]);
    const noRev = { ...purEditBody(a) } as Record<string, unknown>;
    delete noRev.revision;
    expect(refused(await putPur(h, owner, a.id, noRev))).toEqual(["Reload the purchase and try again: the request did not say which version of the purchase was edited."]);
    expect(refused(await putPur(h, owner, a.id, purEditBody(a, { revision: a.revision + 5 })))).toEqual(["This purchase was changed by someone else since you opened it. Reload it and make your change again."]);
  });

  it("an imported CANCELLED purchase cannot be edited", async () => {
    const s = await purScenario(h, 1);
    const c = await h.seed.purchase(s.supplier.id, { totalP: 100_000, status: "CANCELLED" });
    const r = await putPur(h, owner, c.id, { supplierId: s.supplier.id, warehouseId: s.wh.id, revision: 0, lines: [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 1 }] });
    expect(refused(r)).toEqual(["A cancelled purchase cannot be edited."]);
  });

  it("an imported DRAFT purchase may be edited and becomes RECEIVED / PARTIALLY_RECEIVED / ORDERED from its bags; its ONE journal entry is rewritten", async () => {
    const s = await purScenario(h, 1);
    const p = s.ps[0]!;
    const d = await h.seed.purchase(s.supplier.id, { totalP: 300_000, status: "DRAFT", number: "PUR-OLD-DRAFT-1", date: "2026-02-10" });
    await h.admin`INSERT INTO purchase_items (purchase_id, product_id, warehouse_id, qty_milli, received_qty_milli, unit_price_p, line_total_p, sort_order) VALUES (${d.id}, ${p.id}, ${s.wh.id}, 3000, 0, 100000, 300000, 0)`;
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(300_000); // DRAFT purchases count on the account
    const line = (await h.admin`SELECT id FROM purchase_items WHERE purchase_id = ${d.id}`)[0]!.id as string;
    const r = ok(await putPur(h, owner, d.id, { supplierId: s.supplier.id, warehouseId: s.wh.id, revision: 0, date: "2026-02-10", lines: [{ id: line, productId: p.id, quantity: 3, unitPriceP: 120_000 }] }));
    expect(r).toMatchObject({ number: "PUR-OLD-DRAFT-1", status: "RECEIVED", totalP: 360_000, revision: 1, stockApplied: true });
    expect(await levelOf(h, p.id, s.wh.id)).toBe(3_000);
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(360_000);
    expect(await entriesFor(h.admin, "PURCHASE", d.id)).toHaveLength(1);
    expect((await purAudit(h, d.id)).map((a) => a.action)).toEqual(["Purchase edited"]);
  });

  it("an edit of an imported purchase with no lines yet keeps working: the first save gives it lines", async () => {
    const s = await purScenario(h, 1);
    const d = await h.seed.purchase(s.supplier.id, { totalP: 500_000, number: "PUR-OLD-NOLINES-1" });
    const r = ok(await putPur(h, owner, d.id, { supplierId: s.supplier.id, warehouseId: s.wh.id, revision: 0, lines: [{ productId: s.ps[0]!.id, quantity: 5, unitPriceP: 100_000 }] }));
    expect(r).toMatchObject({ number: "PUR-OLD-NOLINES-1", totalP: 500_000, lineCount: 1, status: "RECEIVED" });
    expect(await levelOf(h, s.ps[0]!.id, s.wh.id)).toBe(5_000);
  });
});

void seedProduct;

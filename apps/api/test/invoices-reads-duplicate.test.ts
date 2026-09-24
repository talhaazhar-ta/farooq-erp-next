import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { products } from "@farooq/db";
import { eq } from "drizzle-orm";
import { invoiceDetailSchema, productPickItemSchema, warehouseItemSchema } from "@farooq/shared";
import { createHarness, customerBalanceSql, entriesFor, type Harness, type Session } from "./helpers/harness.js";
import { cancel, duplicate, editBody, get, invBody, levelOf, mkPosted, movementsOf, newKey, post, put, scenario, seedProduct, seedStock, seedWarehouse } from "./helpers/invoices.js";

/**
 * GET /invoices/:id (the detail and its `actions`), the product / warehouse pickers, and duplicate.
 */
let h: Harness;
let owner: Session;
let sales: Session;
let accountant: Session;
let inventory: Session;
let manager: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  sales = await h.session("SALES");
  accountant = await h.session("ACCOUNTANT");
  inventory = await h.session("INVENTORY");
  manager = await h.session("MANAGER");
});
afterAll(async () => {
  await h.close();
});

describe("GET /invoices/:id", () => {
  it("returns the whole invoice in the shared schema; cost is shown only to PROFIT_VIEW roles; INVENTORY is refused", async () => {
    const s = await scenario(h, { buyP: 240_000 });
    const inv = await mkPosted(h, owner, s, { qty: 2, unitPriceP: 300_000, paidAmountP: 100_000 });
    for (const who of [owner, manager, accountant, sales]) {
      const r = await get(h, who, inv.id);
      expect(r.status, who.role).toBe(200);
      invoiceDetailSchema.parse(r.body);
    }
    expect((await get(h, owner, inv.id)).body.lines[0].costSnapshotP).toBe(240_000);
    expect((await get(h, accountant, inv.id)).body.lines[0].costSnapshotP).toBe(240_000); // ACCOUNTANT holds PROFIT_VIEW
    expect((await get(h, sales, inv.id)).body.lines[0].costSnapshotP).toBeNull();
    expect((await get(h, inventory, inv.id)).status).toBe(403);
    expect((await get(h, null, inv.id)).status).toBe(401);
  });

  it("shows the receipts (with a reversed one marked), the stock movements and paid / balance / outstanding", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 100_000, paidAmountP: 40_000 });
    const second = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 10_000, allocations: [{ invoiceId: inv.id, amountP: 10_000 }] } });
    await h.request(owner, "POST", `/payments/${second.body.id}/reverse`, { body: { reason: "x" } });
    await h.seed.customerReturn(s.shop.id, inv.id, { totalP: 5_000, number: "CR-R1" });
    const d = (await get(h, owner, inv.id)).body;
    expect(d.receipts.map((r: any) => [r.status, r.allocatedP])).toEqual([["POSTED", 40_000], ["REVERSED", 10_000]]);
    expect(d).toMatchObject({ paidP: 40_000, balanceP: 60_000, outstandingP: 55_000 }); // a return's credit note counts in outstanding, not in balance
    expect(d.stockMovements.map((m: any) => [m.kind, m.quantity])).toEqual([["SALE_OUT", -1]]);
  });

  it("a malformed id and an unknown id are 404", async () => {
    expect((await get(h, owner, "not-an-id")).status).toBe(404);
    const r = await get(h, owner, "00000000-0000-4000-8000-000000000000");
    expect(r.status).toBe(404);
    expect(r.body.message).toBe("Invoice not found.");
  });
});

describe("`actions` — what this role may do now, and the server's own reason when not", () => {
  it("a posted, unpaid invoice: the OWNER may do everything", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    expect((await get(h, owner, inv.id)).body.actions).toEqual({
      edit: { allowed: true, reason: null }, cancel: { allowed: true, reason: null }, changeShop: { allowed: true, reason: null }, duplicate: { allowed: true, reason: null },
    });
  });

  it("SALES may only duplicate a posted invoice; the ACCOUNTANT may not duplicate but may correct", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    const noCorrect = "You do not have permission to edit a posted invoice, cancel it or change its shop.";
    expect((await get(h, sales, inv.id)).body.actions).toEqual({
      edit: { allowed: false, reason: noCorrect }, cancel: { allowed: false, reason: noCorrect }, changeShop: { allowed: false, reason: noCorrect }, duplicate: { allowed: true, reason: null },
    });
    const a = (await get(h, accountant, inv.id)).body.actions;
    expect(a.edit.allowed && a.cancel.allowed && a.changeShop.allowed).toBe(true);
    expect(a.duplicate).toEqual({ allowed: false, reason: "You do not have permission to create or post invoices." });
  });

  it("money received: cancel is refused with the receipt named; edit and change shop stay allowed", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 100_000, paidAmountP: 30_000 });
    const a = (await get(h, owner, inv.id)).body.actions;
    expect(a.cancel.allowed).toBe(false);
    expect(a.cancel.reason).toContain(inv.receipts[0].receiptNumber);
    expect(a.edit.allowed).toBe(true);
    expect(a.changeShop.allowed).toBe(true);
  });

  it("a draft: SALES may edit it; change shop points to editing; a cancelled invoice: edit / cancel / change shop refused, duplicate allowed", async () => {
    const s = await scenario(h);
    const d = await post(h, sales, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
    const a = (await get(h, sales, d.body.id)).body.actions;
    expect(a.edit.allowed).toBe(true);
    const own = (await get(h, owner, d.body.id)).body.actions;
    expect(own.changeShop).toEqual({ allowed: false, reason: "This invoice is still a draft — edit it and pick the other shop." });

    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    await cancel(h, owner, inv.id);
    const c = (await get(h, owner, inv.id)).body.actions;
    expect(c.edit).toEqual({ allowed: false, reason: "A cancelled invoice cannot be edited. Duplicate it instead." });
    expect(c.cancel).toEqual({ allowed: false, reason: "This invoice is already cancelled." });
    expect(c.changeShop).toEqual({ allowed: false, reason: "A cancelled invoice cannot be moved to another shop." });
    expect(c.duplicate.allowed).toBe(true);
  });

  it("a return or a dispatch refuses edit (and a return refuses cancel and change shop) — with the reason", async () => {
    const s = await scenario(h);
    const r = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    await h.seed.customerReturn(s.shop.id, r.id, { totalP: 500, number: "CR-A1" });
    const a = (await get(h, owner, r.id)).body.actions;
    expect(a.edit.allowed || a.cancel.allowed || a.changeShop.allowed).toBe(false);
    expect(a.edit.reason).toContain("CR-A1");
    const d = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    await h.admin`UPDATE invoices SET dispatch_number = 'DSP-1' WHERE id = ${d.id}`;
    const b = (await get(h, owner, d.id)).body.actions;
    expect(b.edit.allowed).toBe(false);
    expect(b.cancel.allowed).toBe(true); // a dispatch does not block a cancel in the owner's decisions
  });
});

describe("duplicate — a fresh draft (legacy `duplicate`)", () => {
  it("copies shop, godown, lines, discounts, charges and notes; today's date; nothing paid; no number, due date, order, dispatch or reference", async () => {
    const s = await scenario(h);
    const inv = await post(
      h,
      owner,
      invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 2.5, unitPriceP: 100_000, discountP: 10_000, taxRatePct: 10, batchNo: "B1", notes: "fragile" }], {
        date: "2026-01-10", dueDate: "2026-02-10", orderNumber: "SO-7", referenceNo: "REF-1", invoiceDiscountP: 5_000, freightP: 3_000, loadingP: 2_000, otherChargesP: 1_000,
        paidAmountP: 50_000, paymentMethod: "Bank", notes: "urgent", description: "for Eid",
      }),
    );
    expect(inv.status).toBe(201);
    const levelBefore = await levelOf(h, s.product.id, s.wh.id);
    const r = await duplicate(h, sales, inv.body.id);
    expect(r.status).toBe(201);
    const d = r.body;
    expect(d.id).not.toBe(inv.body.id);
    expect(d).toMatchObject({
      status: "DRAFT", number: null, date: "2026-03-05", dueDate: null, orderNumber: null, referenceNo: null, dispatchNumber: null,
      customerId: s.shop.id, warehouseId: s.wh.id, invoiceDiscountP: 5_000, freightP: 3_000, loadingP: 2_000, otherChargesP: 1_000,
      paidP: 0, receipts: [], paymentMethod: "Bank", notes: "urgent", description: "for Eid", stockApplied: false, previousBalanceP: 0,
    });
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0]).toMatchObject({ quantity: 2.5, unitPriceP: 100_000, discountP: 10_000, taxP: inv.body.lines[0].taxP, batchNo: "B1", notes: "fragile", warehouseId: s.wh.id });
    expect(d.lines[0].id).not.toBe(inv.body.lines[0].id);
    // totals equal the original's (tax carried as a fixed amount)
    expect(d.totalP).toBe(inv.body.totalP);
    // no stock, no journal, the source untouched
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(levelBefore);
    expect(await movementsOf(h, d.id)).toEqual([]);
    expect(await entriesFor(h.admin, "INVOICE", d.id)).toEqual([]);
    expect((await get(h, owner, inv.body.id)).body).toMatchObject({ status: "PARTIALLY_PAID", number: inv.body.number, revision: 1 });
    const [aud] = await h.admin`SELECT action, after FROM audit_log WHERE entity_id = ${d.id}`;
    expect(aud!.action).toBe("Draft invoice saved");
    expect(aud!.after).toMatchObject({ duplicatedFrom: inv.body.number });
  });

  it("a duplicate of a CANCELLED invoice works (that is what the cancelled-edit message tells staff to do) and posts like any draft", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 3, unitPriceP: 10_000 });
    await cancel(h, owner, inv.id);
    const d = (await duplicate(h, owner, inv.id)).body;
    const posted = await put(h, owner, d.id, editBody(d));
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ status: "CONFIRMED", totalP: 30_000 });
    expect(posted.body.number).not.toBe(inv.number);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(30_000);
  });

  it("needs SALES_CREATE; an unknown invoice is a 404; the same idempotency key returns the same draft (200)", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    expect((await duplicate(h, accountant, inv.id)).status).toBe(403);
    expect((await duplicate(h, inventory, inv.id)).status).toBe(403);
    expect((await duplicate(h, owner, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    const key = newKey();
    const a = await duplicate(h, owner, inv.id, { idempotencyKey: key });
    const b = await duplicate(h, owner, inv.id, { idempotencyKey: key });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.id).toBe(a.body.id);
    expect((await h.admin`SELECT COUNT(*)::int AS c FROM invoices WHERE customer_id = ${s.shop.id} AND status = 'DRAFT'`)[0]!.c).toBe(1);
  });
});

const letters = (): string => Date.now().toString(36).replace(/[0-9]/g, "") + Math.random().toString(36).replace(/[0-9.]/g, "").slice(0, 6);

describe("GET /products — the invoice builder's product search", () => {
  const pick = async (as: Session, qs: string) => {
    const r = await h.request(as, "GET", `/products${qs}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    for (const p of r.body) productPickItemSchema.parse(p);
    return r.body as any[];
  };

  it("every typed word must match (name, Urdu name, brand, category, SKU, bag size); inactive products never appear", async () => {
    const tag = `zq${letters()}`; // letters only, so a bag-size word such as "25" can never match the tag by accident
    const a = await seedProduct(h, { nameEn: `${tag} Sella Golden`, nameUr: "سیلا گولڈن", brand: "Kisan", sku: `SKU-${tag}`, weightKg: 25 });
    const b = await seedProduct(h, { nameEn: `${tag} Basmati Super`, brand: "Kisan", weightKg: 50 });
    const gone = await seedProduct(h, { nameEn: `${tag} Old Stock` });
    await h.db.update(products).set({ active: false }).where(eq(products.id, gone.id));
    expect((await pick(owner, `?q=${tag}`)).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect((await pick(owner, `?q=${tag}%20kisan%2025`)).map((p) => p.id)).toEqual([a.id]); // brand AND "25 kg"
    expect((await pick(owner, `?q=${tag}%20${encodeURIComponent("گولڈن")}`)).map((p) => p.id)).toEqual([a.id]);
    expect((await pick(owner, `?q=SKU-${tag}`)).map((p) => p.id)).toEqual([a.id]);
    expect((await pick(owner, `?q=${tag}%20nomatchword`))).toEqual([]);
  });

  it("with a warehouse, products that are in stock THERE come first; `available` lists the godowns; limit is honoured", async () => {
    const tag = `zw${letters()}`;
    const wh = await seedWarehouse(h);
    const other = await seedWarehouse(h);
    const empty = await seedProduct(h, { nameEn: `${tag} A-first-by-name` });
    const stocked = await seedProduct(h, { nameEn: `${tag} Z-last-by-name` });
    await seedStock(h, stocked.id, wh.id, 7.5);
    await seedStock(h, stocked.id, other.id, 2);
    const r = await pick(owner, `?q=${tag}&warehouseId=${wh.id}`);
    expect(r.map((p) => p.id)).toEqual([stocked.id, empty.id]);
    expect(r[0].available.map((a: any) => [a.warehouseId, a.quantity]).sort()).toEqual([[wh.id, 7.5], [other.id, 2]].sort());
    expect((await pick(owner, `?q=${tag}&limit=1`))).toHaveLength(1);
  });

  it("price hints: the owner's set price and min price, and the last invoiced rate (posted only — a draft or a cancelled invoice is ignored)", async () => {
    const s = await scenario(h, { productOpts: { sellP: 275_000, minSellP: 260_000 } });
    expect((await pick(owner, `?q=${s.product.name}`))[0]).toMatchObject({ sellP: 275_000, minSellP: 260_000, lastRateP: null });
    const older = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 270_000, extra: { date: "2026-01-01" } });
    await mkPosted(h, owner, s, { qty: 1, unitPriceP: 281_000, extra: { date: "2026-02-01" } });
    const cancelled = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 999_000, extra: { date: "2026-02-20" } });
    await cancel(h, owner, cancelled.id);
    await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 555_000 }], { mode: "draft", date: "2026-02-25" }));
    expect((await pick(owner, `?q=${s.product.name}`))[0].lastRateP).toBe(281_000);
    void older;
  });

  it("cost and buy price only for PROFIT_VIEW; INVENTORY (MASTER_DATA_VIEW) may search; unauthenticated is 401", async () => {
    const s = await scenario(h, { buyP: 240_000 });
    const asOwner = (await pick(owner, `?q=${s.product.name}&warehouseId=${s.wh.id}`))[0];
    expect(asOwner).toMatchObject({ costP: 240_000, buyP: 240_000 });
    const asSales = (await pick(sales, `?q=${s.product.name}&warehouseId=${s.wh.id}`))[0];
    expect(asSales).toMatchObject({ costP: null, buyP: null });
    expect((await pick(inventory, `?q=${s.product.name}`))[0].costP).toBeNull();
    expect((await h.request(null, "GET", "/products")).status).toBe(401);
    expect((await h.request(owner, "GET", "/products?bogus=1")).status).toBe(422);
  });

  it("GET /warehouses lists them", async () => {
    const wh = await seedWarehouse(h, `Godown-list-${Date.now().toString(36)}`);
    const r = await h.request(sales, "GET", "/warehouses");
    expect(r.status).toBe(200);
    for (const w of r.body) warehouseItemSchema.parse(w);
    expect(r.body.some((w: any) => w.id === wh.id && w.name === wh.name)).toBe(true);
  });
});

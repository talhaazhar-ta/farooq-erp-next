import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companyProfile, customers, regions } from "@farooq/db";
import { createHarness, customerBalanceSql, entriesFor, invoiceStatus, trialBalance, type Harness, type Session } from "./helpers/harness.js";
import { invBody, levelOf, movementSum, movementsOf, newKey, post, put, get, scenario, seedProduct, seedStock, seedWarehouse } from "./helpers/invoices.js";

/**
 * Posting an invoice (and saving a draft) — every expectation is worked out by hand from the legacy rules
 * (`Invoices.save`, `Calc.invoice`, `Validate.invoice`, `Inventory.apply / costOf`), never read back from the code under test.
 * Amounts are paisa; 1 bag = 1000 milli.
 */
let h: Harness;
let owner: Session;
let sales: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  sales = await h.session("SALES");
});
afterAll(async () => {
  await h.close();
});

const nInv = (number: string): number => Number(number.slice(-6));
const auditOf = async (entityId: string) => h.admin`SELECT action, entity, before, after, actor_id FROM audit_log WHERE entity_id = ${entityId} ORDER BY at, id`;

describe("post — one transaction writes number, invoice, lines, stock, journal, payment and audit", () => {
  it("hand-computed: 10 bags × 2,700 − 500 line discount − 1,000 invoice discount + 5% tax + 600 charges, 10,000 paid", async () => {
    const { shop, wh, product } = await scenario(h, { stock: 100, buyP: 240_000 });
    await h.seed.invoice(shop.id, { totalP: 500_000 }); // the shop already owed 5,000
    const r = await post(
      h,
      owner,
      invBody(shop.id, wh.id, [{ productId: product.id, quantity: 10, unitPriceP: 270_000, discountP: 50_000, taxRatePct: 5 }], {
        invoiceDiscountP: 100_000,
        freightP: 30_000,
        loadingP: 20_000,
        otherChargesP: 10_000,
        paidAmountP: 1_000_000,
        paymentMethod: "Bank",
        referenceNo: "TRX-9",
        notes: "deliver by noon",
      }),
    );
    expect(r.status).toBe(201);
    const b = r.body;
    expect(b.number).toMatch(/^INV-2026-\d{6}$/);
    // header (paisa): subtotal 2,700,000; item discounts 50,000; invoice discount min(100,000, 2,650,000); tax 5% of 2,650,000 = 132,500
    expect(b).toMatchObject({
      subtotalP: 2_700_000, itemDiscountsP: 50_000, invoiceDiscountP: 100_000, discountAmountP: 150_000, taxP: 132_500,
      freightP: 30_000, loadingP: 20_000, otherChargesP: 10_000, totalP: 2_742_500, paidP: 1_000_000, balanceP: 1_742_500,
      status: "PARTIALLY_PAID", paymentStatus: "PARTIAL", paymentMethod: "Bank", referenceNo: "TRX-9", notes: "deliver by noon",
      date: "2026-03-05", totalQuantity: 10, lineCount: 1, stockApplied: true, migrated: false, revision: 1, invoiceType: "SALE",
      previousBalanceP: 500_000, salesperson: owner.name, createdBy: owner.userId,
    });
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toMatchObject({
      quantity: 10, qtyMilli: 10_000, unitPriceP: 270_000, discountP: 50_000, taxP: 132_500, lineTotalP: 2_782_500, // 2,700,000 − 50,000 + 132,500
      costSnapshotP: 240_000, // no recorded average, no carried cost, no other godown → the product's list buy price
      unit: "Bag", package: "50 KG", warehouseId: wh.id, sortOrder: 0,
    });

    // stock: one SALE_OUT of 10 bags, level 100 → 90, Σ movements = level
    expect(await levelOf(h, product.id, wh.id)).toBe(90_000);
    expect(await movementSum(h, product.id, wh.id)).toBe(90_000);
    expect(await movementsOf(h, b.id)).toEqual([
      { kind: "SALE_OUT", refType: "INVOICE", ref: b.number, date: "2026-03-05", q: -10_000, productId: product.id, warehouseId: wh.id, note: shop.shopName },
    ]);

    // journal: exactly one entry, DR RECEIVABLES(shop) / CR SALES for the grand total, dated the invoice date
    const entries = await entriesFor(h.admin, "INVOICE", b.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ date: "2026-03-05", memo: `Sales invoice ${b.number}`, created_by: owner.userId });
    expect(entries[0]!.lines).toEqual([
      { code: "RECEIVABLES", party_type: "CUSTOMER", party_id: shop.id, debit: 2_742_500, credit: 0 },
      { code: "SALES", party_type: null, party_id: null, debit: 0, credit: 2_742_500 },
    ]);
    // the shop owes 5,000 + 27,425 − 10,000 received
    expect(await customerBalanceSql(h.admin, shop.id)).toBe(500_000 + 2_742_500 - 1_000_000);

    // the receipt taken with the sale: same code path as PaymentsService.receive
    expect(b.receipts).toHaveLength(1);
    const [pay] = await h.admin`SELECT * FROM payments WHERE id = ${b.receipts[0].paymentId}`;
    expect(pay).toMatchObject({ direction: "IN", party_type: "CUSTOMER", party_id: shop.id, amount_p: "1000000", method: "Bank", reference: "TRX-9", status: "POSTED", received_by: owner.name });
    expect(pay!.note).toBe(`Received with invoice ${b.number}`);
    const [dated] = await h.admin`SELECT payment_date::text AS d FROM payments WHERE id = ${pay!.id}`;
    expect(dated!.d).toBe("2026-03-05");
    expect(pay!.receipt_number).toMatch(/^REC-2026-\d{6}$/);
    const allocs = await h.admin`SELECT invoice_id, amount_p::int AS a FROM payment_allocations WHERE payment_id = ${pay!.id}`;
    expect(allocs.map((a) => [a.invoice_id, a.a])).toEqual([[b.id, 1_000_000]]);
    const payEntries = await entriesFor(h.admin, "PAYMENT", pay!.id as string);
    expect(payEntries[0]!.lines).toEqual([
      { code: "CASH", party_type: null, party_id: null, debit: 1_000_000, credit: 0 },
      { code: "RECEIVABLES", party_type: "CUSTOMER", party_id: shop.id, debit: 0, credit: 1_000_000 },
    ]);

    // audit: 'Invoice created' (legacy wording) and 'Payment received', by the actor
    expect((await auditOf(b.id)).map((a) => a.action)).toEqual(["Invoice created"]);
    expect((await auditOf(pay!.id as string)).map((a) => a.action)).toEqual(["Payment received"]);
    const [created] = await auditOf(b.id);
    expect(created).toMatchObject({ entity: "Invoice", actor_id: owner.userId });
    expect(created!.after).toMatchObject({ ref: b.number, grandTotal: 2_742_500, lineCount: 1, status: "PARTIALLY_PAID" });
    expect((await trialBalance(h.admin)).debit).toBe((await trialBalance(h.admin)).credit);
  });

  it("status follows the legacy paymentStatus: nothing paid = CONFIRMED / UNPAID, paid in full = PAID, a total of 0 stays UNPAID", async () => {
    const { shop, wh, product } = await scenario(h);
    const line = { productId: product.id, quantity: 2, unitPriceP: 100_000 };
    const unpaid = await post(h, owner, invBody(shop.id, wh.id, [line]));
    expect(unpaid.body).toMatchObject({ status: "CONFIRMED", paymentStatus: "UNPAID", paidP: 0, receipts: [] });
    const paid = await post(h, owner, invBody(shop.id, wh.id, [line], { paidAmountP: 200_000 }));
    expect(paid.body).toMatchObject({ status: "PAID", paymentStatus: "PAID", paidP: 200_000, balanceP: 0 });
    const free = await post(h, owner, invBody(shop.id, wh.id, [{ ...line, discountP: 200_000 }]));
    expect(free.status).toBe(201);
    expect(free.body).toMatchObject({ totalP: 0, status: "CONFIRMED", paymentStatus: "UNPAID" });
  });

  it("numbers continue the INV counter and are gap-free: a refused save consumes none", async () => {
    const { shop, wh, product } = await scenario(h);
    const line = { productId: product.id, quantity: 1, unitPriceP: 1_000 };
    const a = await post(h, owner, invBody(shop.id, wh.id, [line]));
    const refused = await post(h, owner, invBody(shop.id, wh.id, [{ ...line, quantity: 5_000 }])); // not enough stock
    expect(refused.status).toBe(422);
    const b = await post(h, owner, invBody(shop.id, wh.id, [line]));
    expect(nInv(b.body.number)).toBe(nInv(a.body.number) + 1);
  });

  it("the number's year is the CURRENT business year, whatever the invoice date (legacy FDB.nextNumber)", async () => {
    const { shop, wh, product } = await scenario(h);
    const r = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 1_000 }], { date: "2025-12-31" }));
    expect(r.body.number).toMatch(/^INV-2026-/);
    expect(r.body.date).toBe("2025-12-31");
  });

  it("an invoice dated in the past posts its journal entry and its stock movement on THAT date", async () => {
    const { shop, wh, product } = await scenario(h);
    const r = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 3, unitPriceP: 10_000 }], { date: "2026-01-15" }));
    expect((await entriesFor(h.admin, "INVOICE", r.body.id))[0]!.date).toBe("2026-01-15");
    expect((await movementsOf(h, r.body.id))[0]!.date).toBe("2026-01-15");
  });

  it("SALES can post with money taken (PAYMENT_CREATE) and the salesperson defaults to the signed-in user", async () => {
    const { shop, wh, product } = await scenario(h);
    const r = await post(h, sales, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 50_000 }], { paidAmountP: 20_000 }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ paidP: 20_000, salesperson: sales.name, createdBy: sales.userId });
    // ...and a cost figure is hidden from a role without PROFIT_VIEW
    expect(r.body.lines[0].costSnapshotP).toBeNull();
    const [row] = await h.admin`SELECT cost_snapshot_p::int AS c FROM invoice_items WHERE invoice_id = ${r.body.id}`;
    expect(row!.c).toBe(240_000); // stored, just not shown
  });
});

describe("post — previous balance, snapshots and line snapshots", () => {
  it("previous_balance_p is the shop's journal balance AT POSTING, excluding this invoice, and is frozen (legacy: live balance at save time)", async () => {
    const { shop, wh, product } = await scenario(h);
    await h.seed.invoice(shop.id, { totalP: 300_000, date: "2026-02-01" });
    await h.seed.voucher({ direction: "IN", partyType: "CUSTOMER", partyId: shop.id, amountP: 100_000 }); // received 1,000 → owes 2,000
    const first = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 50_000 }], { date: "2026-01-01" })); // back-dated: still the LIVE balance
    expect(first.body.previousBalanceP).toBe(200_000);
    const second = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 70_000 }]));
    expect(second.body.previousBalanceP).toBe(250_000); // 200,000 + the first invoice's 50,000
  });

  it("a credit balance is carried as a negative previous balance", async () => {
    const { shop, wh, product } = await scenario(h);
    await h.seed.voucher({ direction: "IN", partyType: "CUSTOMER", partyId: shop.id, amountP: 75_000 }); // an advance
    const r = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 50_000 }]));
    expect(r.body.previousBalanceP).toBe(-75_000);
  });

  it("the shop's, region's and warehouse's details are stamped onto the invoice and a later rename does not change them", async () => {
    const [region] = await h.db.insert(regions).values({ nameEn: "Dir Bala", nameUr: "دیر بالا" }).returning();
    const [shop] = await h.db
      .insert(customers)
      .values({ shopName: "Gul Traders", ownerName: "Gul Khan", phone: "0300-1111111", regionId: region!.id, legacyCode: "C-77", legacyDoc: { wa: "0345-2222222", addr: "Main Bazar", area: "Bazar Road" } })
      .returning();
    const wh = await seedWarehouse(h, "Main Godown X");
    const product = await seedProduct(h, { nameEn: "Basmati", nameUr: "باسمتی", brand: "Sun", buyP: 1 });
    await seedStock(h, product.id, wh.id, 10);
    const r = await post(h, owner, invBody(shop!.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 5_000 }]));
    expect(r.body.shop).toEqual({
      code: "C-77", name: "Gul Khan", shopName: "Gul Traders", contactPerson: "Gul Khan", mobile: "0300-1111111", whatsapp: "0345-2222222",
      address: "Main Bazar", regionId: region!.id, region: "دیر بالا — Dir Bala", market: "Bazar Road",
    });
    expect(r.body.warehouseName).toBe("Main Godown X");
    expect(r.body.lines[0]).toMatchObject({ description: "باسمتی", descriptionEn: "Basmati", brand: "Sun", category: "Rice", package: "50 KG" });

    await h.db.update(customers).set({ shopName: "Renamed Shop" }).where((await import("drizzle-orm")).eq(customers.id, shop!.id));
    expect((await get(h, owner, r.body.id)).body.shop.shopName).toBe("Gul Traders");
  });
});

describe("drafts — any number of them, no number, no stock, no journal, no payment", () => {
  it("saves many drafts for the same shop (legacy bug: only one draft could exist)", async () => {
    const { shop, wh, product } = await scenario(h);
    const line = { productId: product.id, quantity: 4, unitPriceP: 10_000 };
    const levelBefore = await levelOf(h, product.id, wh.id);
    const made = [];
    for (let i = 0; i < 3; i++) made.push(await post(h, owner, invBody(shop.id, wh.id, [line], { mode: "draft" })));
    for (const d of made) {
      expect(d.status).toBe(201);
      expect(d.body).toMatchObject({ status: "DRAFT", number: null, stockApplied: false, totalP: 40_000, paidP: 0, previousBalanceP: 0, confirmedAt: null });
      expect(await movementsOf(h, d.body.id)).toEqual([]);
      expect(await entriesFor(h.admin, "INVOICE", d.body.id)).toEqual([]);
    }
    expect(new Set(made.map((d) => d.body.id)).size).toBe(3);
    expect(await levelOf(h, product.id, wh.id)).toBe(levelBefore); // a draft never touches stock
    expect(await customerBalanceSql(h.admin, shop.id)).toBe(0);
    expect((await auditOf(made[0]!.body.id)).map((a) => a.action)).toEqual(["Draft invoice saved"]);
  });

  it("a draft may be short of stock and have a zero rate — but not a missing shop, an empty line list or a payment", async () => {
    const { shop, wh, product } = await scenario(h, { stock: 2 });
    const ok = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 50, unitPriceP: 0 }], { mode: "draft" }));
    expect(ok.status).toBe(201);
    expect((await post(h, owner, invBody(shop.id, wh.id, [], { mode: "draft" }))).body.errors).toEqual(["Add at least one product line."]);
    const paid = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft", paidAmountP: 500 }));
    expect(paid.status).toBe(422);
    expect(paid.body.errors).toContain("Payment can only be taken when the invoice is posted. Clear the amount paid, or post the invoice.");
  });

  it("editing a draft keeps it a draft, keeps the ids of the lines that stay, drops the ones removed, and audits 'Invoice edited'", async () => {
    const { shop, wh, product } = await scenario(h);
    const p2 = await seedProduct(h, { buyP: 1 });
    await seedStock(h, p2.id, wh.id, 10);
    const d = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 1_000 }, { productId: p2.id, quantity: 2, unitPriceP: 2_000 }], { mode: "draft" }));
    const [l1] = d.body.lines;
    const e = await put(h, owner, d.body.id, invBody(shop.id, wh.id, [{ id: l1.id, productId: product.id, quantity: 3, unitPriceP: 1_500 }], { mode: "draft", revision: d.body.revision }));
    expect(e.status).toBe(200);
    expect(e.body.status).toBe("DRAFT");
    expect(e.body.lines).toHaveLength(1);
    expect(e.body.lines[0]).toMatchObject({ id: l1.id, quantity: 3, unitPriceP: 1_500, lineTotalP: 4_500 });
    expect(e.body.revision).toBe(d.body.revision + 1);
    const [cnt] = await h.admin`SELECT COUNT(*)::int AS n FROM invoice_items WHERE invoice_id = ${d.body.id}`;
    expect(cnt!.n).toBe(1);
    expect((await auditOf(d.body.id)).map((a) => a.action)).toEqual(["Draft invoice saved", "Invoice edited"]);
  });

  it("posting a draft gives it a number, takes its stock, posts its journal entry and takes the previous balance AT THAT MOMENT", async () => {
    const { shop, wh, product } = await scenario(h);
    await h.seed.invoice(shop.id, { totalP: 100_000 });
    const d = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 5, unitPriceP: 20_000 }], { mode: "draft" }));
    await h.seed.invoice(shop.id, { totalP: 200_000 }); // the shop's balance moves after the draft was saved
    const p = await put(h, owner, d.body.id, invBody(shop.id, wh.id, [{ id: d.body.lines[0].id, productId: product.id, quantity: 5, unitPriceP: 20_000 }], { revision: d.body.revision, paidAmountP: 30_000 }));
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ id: d.body.id, status: "PARTIALLY_PAID", stockApplied: true, previousBalanceP: 300_000, totalP: 100_000, paidP: 30_000 });
    expect(p.body.number).toMatch(/^INV-2026-\d{6}$/);
    expect(await levelOf(h, product.id, wh.id)).toBe(95_000);
    expect((await movementsOf(h, d.body.id)).map((m) => [m.kind, m.q, m.ref])).toEqual([["SALE_OUT", -5_000, p.body.number]]);
    expect(await entriesFor(h.admin, "INVOICE", d.body.id)).toHaveLength(1);
    expect((await auditOf(d.body.id)).map((a) => a.action)).toEqual(["Draft invoice saved", "Invoice edited"]); // legacy wording for a draft being posted
    expect(p.body.confirmedAt).not.toBeNull();
  });
});

describe("post — refusals write nothing", () => {
  it("every validation message comes back as a 422 {message, errors} and the database is untouched", async () => {
    const { shop, wh, product } = await scenario(h, { stock: 5 });
    const countInvoices = async () => Number((await h.admin`SELECT COUNT(*)::int AS n FROM invoices WHERE customer_id = ${shop.id}`)[0]!.n);
    const r = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 8, unitPriceP: 1_000 }], { paidAmountP: 999_999 }));
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual([
      `Only 5 bags of ${product.nameEn} are available in ${wh.name}. Requested: 8.`,
      "The amount paid is more than the invoice total. Record the extra as a separate payment on account.",
    ]);
    expect(r.body.message).toBe(r.body.errors[0]);
    expect(await countInvoices()).toBe(0);
    expect(await levelOf(h, product.id, wh.id)).toBe(5_000);
    expect(await movementSum(h, product.id, wh.id)).toBe(5_000);
  });

  it("stock is checked per product × godown TOTALLED across lines (6 + 6 of 10 refused; the legacy allowed it)", async () => {
    const { shop, wh, product } = await scenario(h, { stock: 10 });
    const l = { productId: product.id, quantity: 6, unitPriceP: 1_000 };
    const r = await post(h, owner, invBody(shop.id, wh.id, [l, l]));
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual([`Only 10 bags of ${product.nameEn} are available in ${wh.name}. Requested: 12.`]);
    expect(await levelOf(h, product.id, wh.id)).toBe(10_000);
  });

  it("a line can leave from a different godown than the header, and its stock is that godown's", async () => {
    const { shop, wh, product } = await scenario(h, { stock: 100 });
    const wh2 = await seedWarehouse(h);
    await seedStock(h, product.id, wh2.id, 2);
    const refused = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 3, unitPriceP: 1_000, warehouseId: wh2.id }]));
    expect(refused.body.errors).toEqual([`Only 2 bags of ${product.nameEn} are available in ${wh2.name}. Requested: 3.`]);
    const ok = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 2, unitPriceP: 1_000, warehouseId: wh2.id }]));
    expect(ok.status).toBe(201);
    expect(await levelOf(h, product.id, wh2.id)).toBe(0);
    expect(await levelOf(h, product.id, wh.id)).toBe(100_000);
    expect(ok.body.lines[0].warehouseId).toBe(wh2.id);
  });

  it("the company setting 'Allow selling below zero stock' lets a sale go negative (read from the imported settings)", async () => {
    const { shop, wh, product } = await scenario(h, { stock: 1 });
    await h.db.insert(companyProfile).values({ id: "0-test-negative-stock", doc: { allowNegativeStock: true } });
    try {
      const r = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 4, unitPriceP: 1_000 }]));
      expect(r.status).toBe(201);
      expect(await levelOf(h, product.id, wh.id)).toBe(-3_000);
      expect(await movementSum(h, product.id, wh.id)).toBe(-3_000);
    } finally {
      await h.admin`DELETE FROM company_profile WHERE id = '0-test-negative-stock'`;
    }
  });

  it("a shop or a warehouse that does not exist, and unknown request fields, are refused", async () => {
    const { shop, wh, product } = await scenario(h);
    const line = { productId: product.id, quantity: 1, unitPriceP: 1_000 };
    expect((await post(h, owner, invBody("00000000-0000-4000-8000-000000000000", wh.id, [line]))).body.errors).toEqual(["Choose a shop to invoice."]);
    expect((await post(h, owner, invBody(shop.id, "00000000-0000-4000-8000-000000000000", [line]))).body.errors).toContain("Choose the warehouse the bags leave from.");
    expect((await post(h, owner, { ...invBody(shop.id, wh.id, [line]), surprise: 1 })).status).toBe(422);
    expect((await post(h, owner, invBody(undefined as never, wh.id, [line]))).body.errors).toEqual(["Choose a shop to invoice."]);
  });

  it("money in the request must be a whole number of paisa, and a tax rate is a percent", async () => {
    const { shop, wh, product } = await scenario(h);
    expect((await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 10.5 }]))).status).toBe(422);
    expect((await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 1_000, taxRatePct: 150 }]))).status).toBe(422);
  });
});

describe("post — payment at the time of sale goes through the SAME code as PaymentsService.receive", () => {
  it("the receipt is capped like any other: paid can never exceed the total, and a negative paid is refused", async () => {
    const { shop, wh, product } = await scenario(h);
    const line = { productId: product.id, quantity: 1, unitPriceP: 100_000 };
    const over = await post(h, owner, invBody(shop.id, wh.id, [line], { paidAmountP: 100_001 }));
    expect(over.body.errors).toEqual(["The amount paid is more than the invoice total. Record the extra as a separate payment on account."]);
    const neg = await post(h, owner, invBody(shop.id, wh.id, [line], { paidAmountP: -1 }));
    expect(neg.body.errors).toEqual(["The amount paid cannot be negative."]);
  });

  it("the receipt takes the invoice date, the invoice's method and reference, and its number continues the REC counter", async () => {
    const { shop, wh, product } = await scenario(h);
    const r1 = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 100_000 }], { date: "2026-02-20", paidAmountP: 40_000 }));
    const r2 = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 100_000 }], { paidAmountP: 40_000 }));
    expect(r1.body.receipts[0]).toMatchObject({ date: "2026-02-20", method: "Cash", reference: null, allocatedP: 40_000, status: "POSTED" });
    expect(nInv(r2.body.receipts[0].receiptNumber)).toBe(nInv(r1.body.receipts[0].receiptNumber) + 1);
  });

  it("if the receipt cannot be written the WHOLE invoice rolls back (no number, no stock, no journal)", async () => {
    const { shop, wh, product } = await scenario(h);
    // make the receipt fail at its unique receipt number: plant a voucher that owns the next number (removed again below)
    await h.admin`INSERT INTO sequences (kind, year, n) VALUES ('REC', 2026, 0) ON CONFLICT (kind, year) DO NOTHING`;
    const [seq] = await h.admin`SELECT n::int AS n FROM sequences WHERE kind = 'REC' AND year = 2026`;
    const planted = `REC-2026-${String(seq!.n + 1).padStart(6, "0")}`;
    await h.admin`INSERT INTO payments (direction, party_type, party_id, amount_p, payment_date, status, receipt_number) VALUES ('IN', 'CUSTOMER', ${shop.id}, 1, '2026-03-05', 'POSTED', ${planted})`;
    try {
      const before = { level: await levelOf(h, product.id, wh.id), inv: (await h.admin`SELECT COUNT(*)::int AS c FROM invoices`)[0]!.c, invSeq: (await h.admin`SELECT n::int AS n FROM sequences WHERE kind = 'INV' AND year = 2026`)[0]?.n ?? 0 };
      const r = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 2, unitPriceP: 100_000 }], { paidAmountP: 10_000 }));
      expect(r.status).toBe(500); // the unique index on the receipt number refuses it
      expect(await levelOf(h, product.id, wh.id)).toBe(before.level);
      expect((await h.admin`SELECT COUNT(*)::int AS c FROM invoices`)[0]!.c).toBe(before.inv);
      expect((await h.admin`SELECT n::int AS n FROM sequences WHERE kind = 'INV' AND year = 2026`)[0]?.n ?? 0).toBe(before.invSeq); // the invoice number rolled back too
      expect(await customerBalanceSql(h.admin, shop.id)).toBe(0); // no invoice entry, no payment entry
    } finally {
      await h.admin`DELETE FROM payments WHERE receipt_number = ${planted}`;
    }
  });
});

describe("idempotency — a repeated request returns the first invoice and writes nothing more", () => {
  it("the same key twice → HTTP 200 the first time's invoice, one invoice, one receipt, stock moved once", async () => {
    const { shop, wh, product } = await scenario(h);
    const key = newKey();
    const body = invBody(shop.id, wh.id, [{ productId: product.id, quantity: 3, unitPriceP: 100_000 }], { paidAmountP: 50_000, idempotencyKey: key });
    const a = await post(h, owner, body);
    const b = await post(h, owner, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.number).toBe(a.body.number);
    expect((await h.admin`SELECT COUNT(*)::int AS c FROM invoices WHERE customer_id = ${shop.id}`)[0]!.c).toBe(1);
    expect((await h.admin`SELECT COUNT(*)::int AS c FROM payments WHERE party_id = ${shop.id}`)[0]!.c).toBe(1);
    expect(await levelOf(h, product.id, wh.id)).toBe(97_000);
  });

  it("a malformed key is refused", async () => {
    const { shop, wh, product } = await scenario(h);
    const r = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 1_000 }], { idempotencyKey: "short" }));
    expect(r.status).toBe(422);
  });
});

it("a posted invoice's status is refreshed by later receipts exactly as before S7 (S3's rule, unchanged)", async () => {
  const { shop, wh, product } = await scenario(h);
  const r = await post(h, owner, invBody(shop.id, wh.id, [{ productId: product.id, quantity: 1, unitPriceP: 100_000 }]));
  expect(await invoiceStatus(h.admin, r.body.id)).toBe("CONFIRMED");
  const rec = await h.request(owner, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 100_000 } });
  expect(rec.body.allocations.map((a: { documentNumber: string }) => a.documentNumber)).toEqual([r.body.number]);
  expect(await invoiceStatus(h.admin, r.body.id)).toBe("PAID");
});

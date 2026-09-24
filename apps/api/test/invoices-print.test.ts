import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { invoicePrintSchema, type InvoicePrint } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { cancel, invBody, mkPosted, post, scenario, seedProduct, seedStock } from "./helpers/invoices.js";

/**
 * GET /invoices/:id/print — the printed invoice model (legacy `DocModel.invoice` + the classic block of 08-classic-invoice.js).
 *
 * One shop, four invoices, worked out by hand (paisa; the shop starts at 0):
 *   I1  10 Jan   10 bags × 100,000                                                          = 1,000,000
 *   REC 15 Jan   300,000 received (applied to I1)
 *   I2  20 Jan   5 × 50,000 (discount 10,000, tax 5,000)  +  2.5 × 40,000                     subtotal 350,000, item discounts 10,000,
 *                invoice discount 20,000, tax 5,000, freight 15,000, loading 5,000, other 2,000   → grand total 347,000; 47,000 paid at the sale
 *                previous balance (frozen) = 1,000,000 − 300,000 = 700,000
 *   I3  1 Feb    1 bag × 100,000                                                            → the shop now owes 700,000 + 347,000 − 47,000 + 100,000 = 1,100,000
 */
let h: Harness;
let owner: Session;
let previousCompany: { id: string; doc: unknown }[] = [];
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  previousCompany = (await h.admin`SELECT id, doc FROM company_profile`) as unknown as typeof previousCompany;
});
afterAll(async () => {
  await h.admin`DELETE FROM company_profile`;
  for (const r of previousCompany) await h.admin`INSERT INTO company_profile (id, doc) VALUES (${r.id}, ${h.admin.json(r.doc as never)})`;
  await h.close();
});

const setCompany = async (doc: Record<string, unknown>) => {
  await h.admin`DELETE FROM company_profile`;
  await h.admin`INSERT INTO company_profile (id, doc) VALUES ('biz', ${h.admin.json(doc as never)})`;
};
const printOf = async (id: string, qs = "", as: Session = owner): Promise<InvoicePrint> => {
  const res = await h.request(as, "GET", `/invoices/${id}/print${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return invoicePrintSchema.parse(res.body);
};

const COMPANY = {
  businessName: "Print & Co Traders", tagline: "Wholesale Dealer", taglineUr: "ہول سیل ڈیلر", address: "Main Bazar, Chitral", phone: "0300-1112223",
  shopPhone: "0943-412345", proprietor: "Haji Print", logoText: "P&C", currencyLabel: "PKR", invoiceFooter: "Thanks for shopping with us.",
  terms: "Goods once sold are not returned.", bankDetails: "Print Bank 1234-5678",
};

let s: Awaited<ReturnType<typeof scenario>>;
let i1: any, i2: any, i3: any, receipt: any;
const regionUr = "پرنٹ بازار";
beforeAll(async () => {
  await setCompany({ ...COMPANY });
  s = await scenario(h, { stock: 100, productOpts: { nameEn: "Zam Zam Atta 20KG", nameUr: "زم زم آٹا", brand: "Zam Zam", weightKg: 20 } });
  const b = await seedProduct(h, { nameEn: "Taj Mahal Sella 25KG", nameUr: "تاج محل سیلا", brand: "Taj Mahal", weightKg: 25 });
  await seedStock(h, b.id, s.wh.id, 50);
  const [region] = await h.admin`INSERT INTO regions (name_en, name_ur) VALUES (${`Print Bazar ${Date.now()}`}, ${regionUr}) RETURNING id, name_en`;
  await h.admin`UPDATE customers SET owner_name = 'Haji Noor', phone = '0300-5551234', region_id = ${region!.id}, legacy_code = 'C77',
                legacy_doc = ${h.admin.json({ wa: "0300-5551234", addr: "Main Bazar Chitral", area: "Old Market" })} WHERE id = ${s.shop.id}`;
  i1 = await mkPosted(h, owner, s, { qty: 10, unitPriceP: 100_000, extra: { date: "2026-01-10" } });
  const rec = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 300_000, date: "2026-01-15", method: "Bank Transfer", reference: "TRX-1" } });
  expect(rec.status, JSON.stringify(rec.body)).toBe(201);
  receipt = rec.body;
  const r2 = await post(
    h,
    owner,
    invBody(
      s.shop.id,
      s.wh.id,
      [
        { productId: s.product.id, quantity: 5, unitPriceP: 50_000, discountP: 10_000, taxP: 5000 },
        { productId: b.id, quantity: 2.5, unitPriceP: 40_000 },
      ],
      { date: "2026-01-20", invoiceDiscountP: 20_000, freightP: 15_000, loadingP: 5000, otherChargesP: 2000, paidAmountP: 47_000, paymentMethod: "Cash", notes: "deliver at the shop", salesperson: "Ali" },
    ),
  );
  expect(r2.status, JSON.stringify(r2.body)).toBe(201);
  i2 = r2.body;
  i3 = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 100_000, extra: { date: "2026-02-01" } });
  expect(i2.totalP).toBe(347_000);
  expect(i2.previousBalanceP).toBe(700_000);
});

describe("the standard model (hand-computed invoice I2)", () => {
  it("identity, the bill-to block (as printed) and the meta rows", async () => {
    const m = await printOf(i2.id);
    expect(m).toMatchObject({ kind: "INVOICE", title: "INVOICE", invoiceId: i2.id, number: i2.number, hasNumber: true, status: "Partly paid", statusKey: "PARTIALLY_PAID", isDraft: false, cancelled: false, date: "2026-01-20" });
    expect(m.party).toEqual({
      label: "BILL TO", labelUr: "بنام", customerId: s.shop.id, shop: s.shop.shopName, owner: "Haji Noor", code: "C77", contact: "0300-5551234",
      whatsapp: "0300-5551234", address: "Main Bazar Chitral", region: expect.stringContaining(regionUr), market: "Old Market",
    });
    expect(m.metaLabel).toBe("INVOICE DETAILS");
    expect(m.meta).toEqual([
      { label: "Invoice No", value: i2.number, strong: true },
      { label: "Invoice type", value: "Sales invoice", strong: false },
      { label: "Invoice date", value: "20 Jan 2026", strong: false },
      { label: "Due date", value: "—", strong: false },
      { label: "Order No", value: "—", strong: false },
      { label: "Dispatch No", value: "", strong: false },
      { label: "Warehouse", value: expect.stringContaining("Godown"), strong: false },
      { label: "Payment status", value: "Partly paid", strong: false },
      { label: "Salesperson", value: "Ali", strong: false },
    ]);
    expect(m.strip).toEqual([
      { label: "Payment method", value: "Cash" },
      { label: "Reference", value: "—" },
      { label: "Region", value: expect.stringContaining(regionUr) },
      { label: "Items", value: "2" },
    ]);
    expect(m.notes).toBe("deliver at the shop");
  });

  it("the company block comes from the settings; the footer, terms and bank details from the settings too", async () => {
    const m = await printOf(i2.id);
    expect(m.company).toMatchObject({ businessName: "Print & Co Traders", phone: "0300-1112223", shopPhone: "0943-412345", proprietor: "Haji Print", logoText: "P&C", currencyLabel: "PKR" });
    expect(m.footer).toEqual({ thanks: "Thanks for shopping with us.", terms: "Goods once sold are not returned.", bank: "Print Bank 1234-5678" });
    expect(m.signatures).toEqual(["Prepared by", "Received by (shopkeeper)", "Authorised signature"]);
    // no footer set: the legacy default
    await setCompany({ businessName: "Bare Co" });
    expect((await printOf(i2.id)).footer).toEqual({ thanks: "Thank you for your business.", terms: "", bank: "" });
    await setCompany({ ...COMPANY });
  });

  it("the columns, and one row per line with the legacy text: quantity + unit + plural, plain rates, '—' for no discount", async () => {
    const m = await printOf(i2.id);
    expect(m.columns.map((c) => [c.key, c.label, c.align, c.width])).toEqual([
      ["sr", "SR", "center", 0.05], ["description", "Description", "left", 0.3], ["brand", "Brand", "left", 0.13], ["pack", "Package", "center", 0.09],
      ["qty", "Qty", "right", 0.08], ["rate", "Rate", "right", 0.11], ["discount", "Discount", "right", 0.11], ["amount", "Amount", "right", 0.13],
    ]);
    expect(m.rows).toEqual([
      { sr: 1, description: "Zam Zam Atta 20KG", descriptionUr: "زم زم آٹا", brand: "Zam Zam", pack: "20 KG", qty: "5 Bags", quantity: 5, rateP: 50_000, rate: "500.00", discountP: 10_000, discount: "100.00", amountP: 245_000, amount: "2,450.00", returned: 0, batch: "" },
      { sr: 2, description: "Taj Mahal Sella 25KG", descriptionUr: "تاج محل سیلا", brand: "Taj Mahal", pack: "25 KG", qty: "2.5 Bags", quantity: 2.5, rateP: 40_000, rate: "400.00", discountP: 0, discount: "—", amountP: 100_000, amount: "1,000.00", returned: 0, batch: "" },
    ]);
    // "1 Bag" — no plural for exactly one
    expect((await printOf(i3.id)).rows[0]).toMatchObject({ qty: "1 Bag", quantity: 1 });
    // Total — 2 lines · 7.5 Bags · subtotal − item discounts = 340,000
    expect(m.itemsFooter).toEqual({ description: "Total — 2 lines", qty: "7.5 Bags", amountP: 340_000, amount: "3,400.00" });
    expect((await printOf(i3.id)).itemsFooter.description).toBe("Total — 1 line");
  });

  it("the totals: subtotal, every non-zero charge in the legacy order, then grand total / amount paid / balance on this invoice", async () => {
    const m = await printOf(i2.id);
    expect(m.totals.map((t) => [t.key, t.label, t.labelUr, t.amountP, t.text, t.big, t.bold, t.rule])).toEqual([
      ["subtotal", "Subtotal", null, 350_000, "PKR 3,500", false, false, false],
      ["itemDiscounts", "Item discounts", null, 10_000, "− PKR 100", false, false, false],
      ["invoiceDiscount", "Invoice discount", null, 20_000, "− PKR 200", false, false, false],
      ["tax", "Tax", null, 5000, "PKR 50", false, false, false],
      ["freight", "Delivery / freight", null, 15_000, "PKR 150", false, false, false],
      ["loading", "Loading / unloading", null, 5000, "PKR 50", false, false, false],
      ["other", "Other charges", null, 2000, "PKR 20", false, false, false],
      ["grand", "Grand total", "ٹوٹل بل رقم", 347_000, "PKR 3,470", true, false, true],
      ["paid", "Amount Paid", "نقد وصول", 47_000, "PKR 470", false, false, false],
      ["balance", "Balance on this invoice", "بقایا رقم", 300_000, "PKR 3,000", false, true, false],
    ]);
    expect([m.totalP, m.paidP, m.balanceP]).toEqual([347_000, 47_000, 300_000]);
  });

  it("a row appears only when its amount is not zero — one test per rule", async () => {
    // I1: nothing but goods: subtotal, grand total, paid (300,000 applied by the receipt), balance
    const only = await printOf(i1.id);
    expect(only.totals.map((t) => t.key)).toEqual(["subtotal", "grand", "paid", "balance"]);
    expect(only.totals.find((t) => t.key === "paid")).toMatchObject({ amountP: 300_000, text: "PKR 3,000" });
    expect(only.totals.find((t) => t.key === "balance")).toMatchObject({ amountP: 700_000 });
    // each charge alone (on another shop, so this shop's balance stays as worked out above)
    const y = await scenario(h);
    for (const [field, key, label] of [
      ["freightP", "freight", "Delivery / freight"],
      ["loadingP", "loading", "Loading / unloading"],
      ["otherChargesP", "other", "Other charges"],
      ["invoiceDiscountP", "invoiceDiscount", "Invoice discount"],
    ] as const) {
      const inv = await mkPosted(h, owner, y, { qty: 1, unitPriceP: 100_000, extra: { [field]: 1000 } });
      const t = (await printOf(inv.id)).totals;
      expect(t.map((x) => x.key), field).toEqual(["subtotal", key, "grand", "paid", "balance"]);
      expect(t.find((x) => x.key === key)!.label).toBe(label);
    }
    // a line discount alone, and a line tax alone
    const disc = await post(h, owner, invBody(y.shop.id, y.wh.id, [{ productId: y.product.id, quantity: 1, unitPriceP: 100_000, discountP: 5000 }]));
    expect((await printOf(disc.body.id)).totals.map((x) => x.key)).toEqual(["subtotal", "itemDiscounts", "grand", "paid", "balance"]);
    const tax = await post(h, owner, invBody(y.shop.id, y.wh.id, [{ productId: y.product.id, quantity: 1, unitPriceP: 100_000, taxP: 5000 }]));
    expect((await printOf(tax.body.id)).totals.map((x) => x.key)).toEqual(["subtotal", "tax", "grand", "paid", "balance"]);
  });

  it("amount in words is the shared one (rupees and paisa), the receipts applied are listed, the ledger box uses the frozen previous balance and the LIVE balance", async () => {
    const m = await printOf(i2.id);
    expect(m.amountInWords).toBe("Three Thousand Four Hundred Seventy Rupees Only");
    expect(m.labels.words).toBe("Amount in words");
    expect(m.payments).toEqual([{ paymentId: expect.any(String), receiptNumber: expect.stringMatching(/^REC-/), date: "2026-01-20", method: "Cash", reference: null, amountP: 47_000, text: "PKR 470" }]);
    // previous balance 700,000 (frozen when it was posted) · +347,000 · −47,000 · now 1,100,000 (I3 has been posted since)
    expect(m.previousBalanceP).toBe(700_000);
    expect(m.currentBalanceP).toBe(1_100_000);
    expect(m.ledger).toEqual([
      { label: "Previous balance", labelUr: "سابقہ بقایا رقم", text: "PKR 7,000", amountP: 700_000 },
      { label: "This invoice", labelUr: "", text: "+ PKR 3,470", amountP: 347_000 },
      { label: "Payment received", labelUr: "", text: "− PKR 470", amountP: 47_000 },
      { label: "Current outstanding balance", labelUr: "بقایا رقم", text: "PKR 11,000", amountP: 1_100_000 },
    ]);
    // I1's receipt: the 300,000 receipt, listed with its method and reference
    expect((await printOf(i1.id)).payments).toEqual([{ paymentId: receipt.id, receiptNumber: receipt.receiptNumber, date: "2026-01-15", method: "Bank Transfer", reference: "TRX-1", amountP: 300_000, text: "PKR 3,000" }]);
  });

  it("a REVERSED receipt is not listed and does not count as paid", async () => {
    const x = await scenario(h);
    const inv = await mkPosted(h, owner, x, { qty: 1, unitPriceP: 100_000 });
    const rec = await h.request(owner, "POST", "/payments/receive", { body: { customerId: x.shop.id, amountP: 40_000 } });
    expect((await printOf(inv.id)).payments).toHaveLength(1);
    await h.request(owner, "POST", `/payments/${rec.body.id}/reverse`, { body: { reason: "wrong shop" } });
    const m = await printOf(inv.id);
    expect(m.payments).toEqual([]);
    expect([m.paidP, m.balanceP]).toEqual([0, 100_000]);
  });
});

describe("the classic block (08-classic-invoice.js)", () => {
  it("invoice numbers: the serial is the trailing digits; InvNo is SLV- and the serial to six digits", async () => {
    const m = await printOf(i2.id);
    const digits = /(\d+)$/.exec(i2.number)![1]!;
    expect(m.classic.serial).toBe(parseInt(digits, 10));
    expect(m.classic.invNo).toBe(`SLV-${digits.padStart(6, "0")}`);
    // the prefix is a business setting
    await setCompany({ ...COMPANY, salesDocPrefix: "FCT" });
    expect((await printOf(i2.id)).classic.invNo).toBe(`FCT-${digits.padStart(6, "0")}`);
    await setCompany({ ...COMPANY });
  });

  it("bill-to details: the shop's code, its mobile ('Nil' when none), the region in Urdu, the remarks", async () => {
    const m = await printOf(i2.id);
    expect(m.classic).toMatchObject({ idNo: "C77", contact: "0300-5551234", regionUr, remarks: "deliver at the shop", phones: ["موبائیل نمبر: 0300-1112223", "فون دکان: 0943-412345", "Haji Print"] });
    const bare = await scenario(h);
    const inv = await mkPosted(h, owner, bare, { qty: 1, unitPriceP: 100_000 });
    expect((await printOf(inv.id)).classic).toMatchObject({ contact: "Nil", regionUr: "", remarks: "" });
  });

  it("the account block: the shop's last rows up to and including THIS invoice — later entries and the sale's own receipt are not there", async () => {
    const m = await printOf(i2.id);
    // 10/01 invoice I1 Dr 10,000.00 · 15/01 receipt Cr 3,000.00 · 20/01 this invoice Dr 3,470.00 (the 470 paid at the sale posts just after it; I3 is later still)
    expect(m.classic.ledgerRows).toEqual([
      { date: "10/01/2026", drP: 1_000_000, crP: 0, dr: "10,000.00", cr: "0" },
      { date: "15/01/2026", drP: 0, crP: 300_000, dr: "0", cr: "3,000.00" },
      { date: "20/01/2026", drP: 347_000, crP: 0, dr: "3,470.00", cr: "0" },
    ]);
    expect(m.classic.ledgerTotals).toEqual({ drP: 1_347_000, crP: 300_000, dr: "13,470.00", cr: "3,000.00" });
    // I3 (the newest): all five earlier entries are before it, so they are all shown — six at most
    const last = await printOf(i3.id);
    expect(last.classic.ledgerRows.map((r) => r.date)).toEqual(["10/01/2026", "15/01/2026", "20/01/2026", "20/01/2026", "01/02/2026"]);
  });

  it("only the last six rows are shown", async () => {
    const x = await scenario(h);
    const made: any[] = [];
    for (let k = 1; k <= 8; k++) made.push(await mkPosted(h, owner, x, { qty: 1, unitPriceP: k * 10_000, extra: { date: `2026-03-0${k}` } }));
    const m = await printOf(made[7].id);
    expect(m.classic.ledgerRows.map((r) => r.date)).toEqual(["03/03/2026", "04/03/2026", "05/03/2026", "06/03/2026", "07/03/2026", "08/03/2026"]);
    expect(m.classic.ledgerRows.map((r) => r.drP)).toEqual([30_000, 40_000, 50_000, 60_000, 70_000, 80_000]);
    expect(m.classic.ledgerTotals.drP).toBe(330_000);
  });

  it("the totals box: Gross / Opening / Total / Cash / (blank) / Balance, with their Urdu labels", async () => {
    const m = await printOf(i2.id);
    expect(m.classic.box).toEqual([
      { label: "Gross Amounts:", labelUr: "سب ٹوٹل", amountP: 347_000, text: "3,470.00", big: false },
      { label: "Opening", labelUr: "سابقہ بقایا رقم", amountP: 700_000, text: "7,000.00", big: false },
      { label: "Total :", labelUr: "ٹوٹل بل رقم", amountP: 1_047_000, text: "10,470.00", big: true },
      { label: "Cash Amt:", labelUr: "نقد وصول", amountP: 47_000, text: "470.00", big: false },
      { label: "", labelUr: "", amountP: 0, text: "0.00", big: false },
      { label: "Balance", labelUr: "بقایا رقم", amountP: 1_000_000, text: "10,000.00", big: true },
    ]);
    expect(m.classic).toMatchObject({ qtyTotal: 7.5, lineTotalP: 347_000, lineTotal: "3,470.00" });
  });
});

describe("drafts, cancelled invoices, the template", () => {
  it("a DRAFT prints as DRAFT with no number and nothing invented", async () => {
    const d = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 2, unitPriceP: 30_000 }], { mode: "draft" }));
    expect(d.status).toBe(201);
    const m = await printOf(d.body.id);
    expect(m).toMatchObject({ number: "DRAFT", hasNumber: false, isDraft: true, cancelled: false, status: "Draft", statusKey: "DRAFT" });
    expect(m.meta[0]).toEqual({ label: "Invoice No", value: "Not issued (draft)", strong: true });
    expect(m.classic).toMatchObject({ serial: 0, invNo: "SLV-000000" });
    expect(m.labels.ribbon).toEqual({ cancelled: "CANCELLED", draft: "DRAFT" });
    expect(m.paidP).toBe(0);
    expect(m.payments).toEqual([]);
  });

  it("a CANCELLED invoice is marked (the stamp), keeps its number and lines, and drops out of the account block", async () => {
    const x = await scenario(h);
    const keep = await mkPosted(h, owner, x, { qty: 1, unitPriceP: 10_000, extra: { date: "2026-04-01" } });
    const gone = await mkPosted(h, owner, x, { qty: 2, unitPriceP: 20_000, extra: { date: "2026-04-02" } });
    expect((await cancel(h, owner, gone.id)).status).toBe(200);
    const m = await printOf(gone.id);
    expect(m).toMatchObject({ cancelled: true, status: "Cancelled", statusKey: "CANCELLED", number: gone.number, hasNumber: true });
    expect(m.rows).toHaveLength(1);
    // the shop's account never shows a cancelled invoice: only the one that stands
    expect(m.classic.ledgerRows.map((r) => r.drP)).toEqual([10_000]);
    expect((await printOf(keep.id)).classic.ledgerRows.map((r) => r.drP)).toEqual([10_000]);
  });

  it("template: classic unless asked otherwise; the business's own setting is the default; both layouts share one model", async () => {
    const a = await printOf(i2.id);
    expect(a.template).toBe("classic"); // the live setting when nothing is configured
    expect((await printOf(i2.id, "?template=standard")).template).toBe("standard");
    expect((await printOf(i2.id, "?template=classic")).template).toBe("classic");
    await setCompany({ ...COMPANY, invoiceTemplate: "standard" });
    expect((await printOf(i2.id)).template).toBe("standard");
    expect((await printOf(i2.id, "?template=classic")).template).toBe("classic");
    await setCompany({ ...COMPANY });
    // everything else is identical whichever layout is asked for
    const classic = await printOf(i2.id, "?template=classic");
    const standard = await printOf(i2.id, "?template=standard");
    expect({ ...classic, template: "same" }).toEqual({ ...standard, template: "same" });
    expect((await h.request(owner, "GET", `/invoices/${i2.id}/print?template=fancy`)).status).toBe(422);
    expect((await h.request(owner, "GET", `/invoices/${i2.id}/print?x=1`)).status).toBe(422);
  });

  it("reads are safe: unknown and malformed ids are 404; the model needs no PROFIT_VIEW and carries no cost or profit key for anyone", async () => {
    expect((await h.request(owner, "GET", "/invoices/00000000-0000-4000-8000-000000000000/print")).status).toBe(404);
    expect((await h.request(owner, "GET", "/invoices/not-a-uuid/print")).status).toBe(404);
    const sales = await h.session("SALES");
    const json = JSON.stringify((await h.request(sales, "GET", `/invoices/${i2.id}/print`)).body);
    expect(json).not.toMatch(/cost|profit|margin/i);
    expect(JSON.stringify((await h.request(owner, "GET", `/invoices/${i2.id}/print`)).body)).not.toMatch(/cost|profit|margin/i);
  });
});

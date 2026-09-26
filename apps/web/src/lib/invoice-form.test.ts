import { describe, expect, it } from "vitest";
import { rupeesText, type ProductPickItem } from "@farooq/shared";
import { IDS, invoiceDetail } from "../test/invoice-fixtures";
import {
  blankForm,
  defaultRateText,
  detailToForm,
  fingerprint,
  formReducer,
  formToSavePayload,
  formTotals,
  isDirty,
  lineNumberOf,
  newLineKey,
  ownBagsBack,
  pairKey,
  parseAmount,
  parseQuantity,
  postPayloadOf,
  priceHint,
  shortLineCount,
  splitErrors,
  stockByPair,
  type FormLine,
  type InvoiceForm,
} from "./invoice-form";

const WH1 = "55555555-5555-4555-8555-555555555555";
const WH2 = "55555555-5555-4555-8555-555555555556";

const line = (patch: Partial<FormLine> = {}): FormLine => ({
  key: newLineKey(), productId: IDS.product, quantity: "10", rate: "1500", discount: "", warehouseId: WH1, taxP: 0, unit: "Bag", batchNo: "", notes: "", ...patch,
});
const formWith = (patch: Partial<InvoiceForm> = {}): InvoiceForm => ({ ...blankForm(WH1, "2026-09-24"), ...patch });
const pick = (patch: Partial<ProductPickItem> = {}): ProductPickItem => ({
  id: IDS.product, name: "زم زم", nameEn: "Zam Zam", nameUr: "زم زم", brand: "Zam Zam", category: "Flour", unit: "Bag", weightKg: 20, sku: null,
  sellP: 150_000, minSellP: 140_000, lastRateP: 148_000, taxPct: null, available: [{ warehouseId: WH1, quantity: 100 }], costP: 120_000, buyP: 120_000, ...patch,
});

describe("reading bags: at most 3 decimals, read as text, Urdu digits accepted", () => {
  it.each([
    ["10", 10_000],
    ["2.5", 2_500],
    ["0.125", 125],
    [".5", 500],
    ["1,250", 1_250_000],
    ["۲.۵", 2_500], // Arabic-Indic / Persian digits
    ["٣", 3_000],
    ["  7  ", 7_000],
    ["", 0], // blank = not entered yet
    ["0", 0],
    ["007", 7_000],
  ])("%j → %d thousandths", (text, milli) => {
    expect(parseQuantity(text)).toMatchObject({ ok: true, qtyMilli: milli });
  });
  it.each(["2.5555", "1.0001", "abc", "1e3", "-2", "1.2.3", ".", "12 kg", "99999999"])("%j is refused", (text) => {
    expect(parseQuantity(text).ok).toBe(false);
  });
  it("never goes through a float: 0.3, 1.005 and 4.35 keep their exact thousandths", () => {
    expect(parseQuantity("0.3")).toMatchObject({ qtyMilli: 300, quantity: 0.3 });
    expect(parseQuantity("1.005")).toMatchObject({ qtyMilli: 1_005 });
    expect(parseQuantity("4.35")).toMatchObject({ qtyMilli: 4_350 });
  });
});

describe("reading rupees: blank is 0, more than two decimals is refused", () => {
  it("accepts 1,500 / 1500.50 / Rs 2,000 / Urdu digits, and blank as 0", () => {
    expect(parseAmount("1,500")).toEqual({ ok: true, paisa: 150_000 });
    expect(parseAmount("1500.50")).toEqual({ ok: true, paisa: 150_050 });
    expect(parseAmount("Rs 2,000")).toEqual({ ok: true, paisa: 200_000 });
    expect(parseAmount("۱۵۰۰")).toEqual({ ok: true, paisa: 150_000 });
    expect(parseAmount("")).toEqual({ ok: true, paisa: 0 });
    expect(parseAmount("   ")).toEqual({ ok: true, paisa: 0 });
  });
  it("refuses 1.005, -5 and words", () => {
    expect(parseAmount("1.005").ok).toBe(false);
    expect(parseAmount("-5").ok).toBe(false);
    expect(parseAmount("lots").ok).toBe(false);
  });
});

describe("the reducer", () => {
  it("a new form has no shop: it is never pre-selected", () => {
    expect(blankForm(WH1).customer).toBeNull();
  });

  it("adds, moves and removes lines; moving off either end does nothing", () => {
    const a = line({ productId: "a" });
    const b = line({ productId: "b" });
    const c = line({ productId: "c" });
    let f = formWith();
    for (const l of [a, b, c]) f = formReducer(f, { type: "addLine", line: l });
    expect(f.lines.map((l) => l.productId)).toEqual(["a", "b", "c"]);
    f = formReducer(f, { type: "move", key: c.key, direction: -1 });
    expect(f.lines.map((l) => l.productId)).toEqual(["a", "c", "b"]);
    f = formReducer(f, { type: "move", key: a.key, direction: -1 });
    expect(f.lines.map((l) => l.productId)).toEqual(["a", "c", "b"]);
    f = formReducer(f, { type: "move", key: b.key, direction: 1 });
    expect(f.lines.map((l) => l.productId)).toEqual(["a", "c", "b"]);
    f = formReducer(f, { type: "move", key: a.key, direction: 1 });
    expect(f.lines.map((l) => l.productId)).toEqual(["c", "a", "b"]);
    f = formReducer(f, { type: "remove", key: a.key });
    expect(f.lines.map((l) => l.productId)).toEqual(["c", "b"]);
  });

  it("changing the header warehouse rewrites EVERY line's warehouse (legacy), a line's own warehouse changes only that line", () => {
    const a = line({ warehouseId: WH1 });
    const b = line({ warehouseId: WH1 });
    let f = formWith({ lines: [a, b] });
    f = formReducer(f, { type: "line", key: a.key, patch: { warehouseId: WH2 } });
    expect(f.lines.map((l) => l.warehouseId)).toEqual([WH2, WH1]);
    f = formReducer(f, { type: "headerWarehouse", warehouseId: WH2 });
    expect(f.warehouseId).toBe(WH2);
    expect(f.lines.map((l) => l.warehouseId)).toEqual([WH2, WH2]);
  });

  it("changing the region clears the shop (legacy); choosing a shop does not touch the region", () => {
    const shop = { id: IDS.shop, name: "Alpha", contact: null, phone: null, region: "Drosh", regionId: null, active: true };
    let f = formReducer(formWith(), { type: "shop", customer: shop });
    expect(f.customer?.id).toBe(IDS.shop);
    f = formReducer(f, { type: "region", regionId: "r2" });
    expect(f.customer).toBeNull();
    expect(f.regionId).toBe("r2");
    f = formReducer(f, { type: "shop", customer: shop });
    expect(f.regionId).toBe("r2");
  });

  it("edits one line by key and leaves the others alone", () => {
    const a = line({ quantity: "1" });
    const b = line({ quantity: "2" });
    const f = formReducer(formWith({ lines: [a, b] }), { type: "line", key: b.key, patch: { quantity: "9", rate: "20" } });
    expect(f.lines.map((l) => [l.quantity, l.rate])).toEqual([["1", "1500"], ["9", "20"]]);
  });
});

/** An independent re-typing of the legacy `Calc.line` / `Calc.invoice` (float arithmetic, exactly as written in 02-services.js), so the screen's totals are checked against something that is not the shared function. */
function legacyTotal(o: { lines: { qty: number; rateP: number; discP: number; taxP: number }[]; invDiscP: number; freightP: number; loadingP: number; otherP: number }) {
  let subtotal = 0;
  let itemDisc = 0;
  let tax = 0;
  for (const l of o.lines) {
    const gross = Math.round(l.rateP * l.qty);
    const disc = Math.min(l.discP, gross);
    subtotal += gross;
    itemDisc += disc;
    tax += l.taxP;
  }
  const invDisc = Math.min(o.invDiscP, Math.max(0, subtotal - itemDisc));
  return { subtotal, itemDisc, invDisc, tax, grand: subtotal - itemDisc - invDisc + tax + o.freightP + o.loadingP + o.otherP };
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("live totals = the legacy arithmetic to the paisa (2,000 seeded invoices, typed as text)", () => {
  it("random lines, discounts, fixed taxes, charges and odd quantities", () => {
    const rand = mulberry32(20260924);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    for (let n = 0; n < 2000; n++) {
      const lines = Array.from({ length: int(0, 6) }, () => ({ qtyMilli: int(1, 250_000), rateP: int(0, 900_000), discP: rand() < 0.4 ? int(0, 400_000) : 0, taxP: rand() < 0.2 ? int(0, 90_000) : 0 }));
      const charges = { invDiscP: rand() < 0.5 ? int(0, 800_000) : 0, freightP: rand() < 0.4 ? int(0, 50_000) : 0, loadingP: rand() < 0.3 ? int(0, 20_000) : 0, otherP: rand() < 0.2 ? int(0, 20_000) : 0 };
      const form = formWith({
        lines: lines.map((l) => line({ quantity: (l.qtyMilli / 1000).toFixed(3).replace(/\.?0+$/, ""), rate: rupeesText(l.rateP), discount: l.discP ? rupeesText(l.discP) : "", taxP: l.taxP })),
        invoiceDiscount: charges.invDiscP ? rupeesText(charges.invDiscP) : "",
        freight: charges.freightP ? rupeesText(charges.freightP) : "",
        loading: charges.loadingP ? rupeesText(charges.loadingP) : "",
        otherCharges: charges.otherP ? rupeesText(charges.otherP) : "",
      });
      const want = legacyTotal({ lines: lines.map((l) => ({ qty: l.qtyMilli / 1000, rateP: l.rateP, discP: l.discP, taxP: l.taxP })), ...charges });
      const got = formTotals(form);
      expect([got.subtotalP, got.itemDiscountsP, got.invoiceDiscountP, got.taxP, got.grandTotalP], `case ${n}`).toEqual([want.subtotal, want.itemDisc, want.invDisc, want.tax, want.grand]);
    }
  });

  it("an unreadable box counts as 0 in the preview (the request then refuses it by name) and the amount paid never changes the total", () => {
    const f = formWith({ lines: [line({ quantity: "2x", rate: "100" }), line({ quantity: "3", rate: "10" })], paidAmount: "1,000" });
    const t = formTotals(f);
    expect(t.grandTotalP).toBe(3_000);
    expect(t.paidP).toBe(100_000);
    expect(t.balanceP).toBe(3_000 - 100_000);
  });

  it("a discount larger than the line is capped at the line, the invoice discount at what is left to discount", () => {
    const f = formWith({ lines: [line({ quantity: "2", rate: "100", discount: "500" })], invoiceDiscount: "900" });
    const t = formTotals(f);
    expect(t.itemDiscountsP).toBe(20_000);
    expect(t.invoiceDiscountP).toBe(0);
    expect(t.grandTotalP).toBe(0);
  });
});

describe("saved invoice → form → request: nothing is lost on the way (draft, edit, duplicate, direct post all use it)", () => {
  const rich = () =>
    invoiceDetail({
      lines: [
        { ...invoiceDetail().lines[0]!, quantity: 2.5, qtyMilli: 2_500, unitPriceP: 135_050, discountP: 12_345, taxP: 6_789, lineTotalP: 331_000, batchNo: "B-7", notes: "handle with care" },
        { ...invoiceDetail().lines[1]!, quantity: 10, qtyMilli: 10_000, unitPriceP: 4_250, discountP: 0, taxP: 0, lineTotalP: 42_500, warehouseId: WH2 },
      ],
      invoiceDiscountP: 5_000,
      freightP: 2_500,
      loadingP: 1_000,
      otherChargesP: 300,
      date: "2026-08-30",
      dueDate: "2026-09-30",
      orderNumber: "ORD-9",
      paymentMethod: "Cheque",
      referenceNo: "CH-1",
      description: "آٹا اور نمک",
      notes: "deliver friday",
    });

  it("keeps every line id, quantity, rate, discount, tax, warehouse and every charge, date and note", () => {
    const inv = rich();
    const r = formToSavePayload(detailToForm(inv), { mode: "post", idempotencyKey: "key-12345678", revision: inv.revision });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload;
    expect(p.lines.map((l) => l.id)).toEqual(inv.lines.map((l) => l.id));
    expect(p.lines.map((l) => [l.productId, l.quantity, l.unitPriceP, l.discountP ?? 0, l.taxP ?? 0, l.warehouseId])).toEqual(
      inv.lines.map((l) => [l.productId, l.quantity, l.unitPriceP, l.discountP, l.taxP, l.warehouseId]),
    );
    expect(p.lines[0]).toMatchObject({ batchNo: "B-7", notes: "handle with care", unit: "Bag" });
    expect([p.invoiceDiscountP, p.freightP, p.loadingP, p.otherChargesP]).toEqual([5_000, 2_500, 1_000, 300]);
    expect([p.date, p.dueDate, p.orderNumber, p.paymentMethod, p.referenceNo, p.description, p.notes]).toEqual(["2026-08-30", "2026-09-30", "ORD-9", "Cheque", "CH-1", "آٹا اور نمک", "deliver friday"]);
    expect([p.customerId, p.warehouseId, p.mode, p.revision, p.idempotencyKey]).toEqual([inv.customerId, inv.warehouseId, "post", inv.revision, "key-12345678"]);
  });

  it("and the totals of the round-tripped form equal the invoice's own (fixed line tax included)", () => {
    const inv = rich();
    const t = formTotals(detailToForm(inv));
    const expectedSubtotal = Math.round(135_050 * 2.5) + Math.round(4_250 * 10);
    expect(t.subtotalP).toBe(expectedSubtotal);
    expect(t.itemDiscountsP).toBe(12_345);
    expect(t.taxP).toBe(6_789);
    expect(t.grandTotalP).toBe(expectedSubtotal - 12_345 - 5_000 + 6_789 + 2_500 + 1_000 + 300);
  });

  it("a random saved invoice round-trips (200 cases): ids, quantities, rates, discounts, taxes, charges", () => {
    const rand = mulberry32(7);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    for (let n = 0; n < 200; n++) {
      const base = invoiceDetail();
      const lines = Array.from({ length: int(1, 5) }, (_, i) => {
        const qtyMilli = int(1, 90_000);
        return { ...base.lines[0]!, id: `66666666-6666-4666-8666-${String(n * 10 + i).padStart(12, "0")}`, quantity: qtyMilli / 1000, qtyMilli, unitPriceP: int(1, 500_000), discountP: rand() < 0.5 ? int(0, 1_000) : 0, taxP: rand() < 0.3 ? int(0, 900) : 0 };
      });
      const inv = invoiceDetail({ lines, invoiceDiscountP: int(0, 5_000), freightP: int(0, 5_000), loadingP: int(0, 500), otherChargesP: int(0, 500) });
      const r = formToSavePayload(detailToForm(inv), { mode: "draft", idempotencyKey: "key-12345678" });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.payload.lines.map((l) => [l.id, l.quantity, l.unitPriceP, l.discountP, l.taxP ?? 0])).toEqual(lines.map((l) => [l.id, l.quantity, l.unitPriceP, l.discountP, l.taxP]));
      expect([r.payload.invoiceDiscountP, r.payload.freightP, r.payload.loadingP, r.payload.otherChargesP]).toEqual([inv.invoiceDiscountP, inv.freightP, inv.loadingP, inv.otherChargesP]);
    }
  });

  it("a draft's form has no payment; a posted invoice's form starts at what is already received", () => {
    expect(detailToForm(invoiceDetail({ status: "DRAFT", number: null, paidP: 0 })).paidAmount).toBe("");
    expect(detailToForm(invoiceDetail({ status: "PARTIALLY_PAID", paidP: 400_050 })).paidAmount).toBe("4000.50");
    expect(detailToForm(invoiceDetail({ status: "CONFIRMED", paidP: 0 })).paidAmount).toBe("");
  });

  it("the shop is taken from what the invoice printed; a new line added here carries no id and no tax", () => {
    const f = detailToForm(invoiceDetail());
    expect(f.customer).toMatchObject({ id: IDS.shop, name: "Alpha Store", contact: "Noor", phone: "0300-1", region: "Drosh" });
    const r = formToSavePayload(formWith({ customer: f.customer, lines: [line()] }), { mode: "draft", idempotencyKey: "key-12345678" });
    expect(r.ok && r.payload.lines[0]).not.toHaveProperty("id");
    expect(r.ok && r.payload.lines[0]).not.toHaveProperty("taxP");
  });

  it("the direct Post of a draft: mode post, paid 0, the revision as loaded, the key given — built from the draft alone", () => {
    const draft = invoiceDetail({ status: "DRAFT", number: null, revision: 7, paidP: 0 });
    const r = postPayloadOf(draft, "post-key-123456");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({ mode: "post", paidAmountP: 0, revision: 7, idempotencyKey: "post-key-123456", customerId: IDS.shop });
    expect(r.payload.lines.map((l) => l.id)).toEqual(draft.lines.map((l) => l.id));
  });
});

describe("the request", () => {
  it("names the line whose box cannot be read, and sends nothing", () => {
    const r = formToSavePayload(formWith({ lines: [line(), line({ quantity: "2.5555" }), line({ rate: "12abc" }), line({ discount: "1.005" })] }), { mode: "post", idempotencyKey: "key-12345678" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(3);
    expect(r.errors[0]).toMatch(/^Line 2: Enter the number of bags/);
    expect(r.errors[1]).toMatch(/^Line 3, the rate:/);
    expect(r.errors[2]).toMatch(/^Line 4, the discount:/);
  });

  it("a blank quantity or rate is sent as 0 (the server says 'quantity must be more than zero' in its own words); no shop is an empty id (its words: 'Choose a shop to invoice.')", () => {
    const r = formToSavePayload(formWith({ lines: [line({ quantity: "", rate: "" })] }), { mode: "draft", idempotencyKey: "key-12345678" });
    expect(r.ok && r.payload.lines[0]).toMatchObject({ quantity: 0, unitPriceP: 0 });
    expect(r.ok && r.payload.customerId).toBe("");
  });

  it("optional text that is blank is left out; a due date that is blank is left out (an empty string is not a date)", () => {
    const r = formToSavePayload(formWith({ lines: [line()] }), { mode: "draft", idempotencyKey: "key-12345678" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const k of ["dueDate", "referenceNo", "description", "notes", "orderNumber", "revision"]) expect(r.payload).not.toHaveProperty(k);
    expect(r.payload.paymentMethod).toBe("Cash");
  });

  it("an unreadable amount paid or charge is named", () => {
    const r = formToSavePayload(formWith({ lines: [line()], paidAmount: "ten", freight: "1.234" }), { mode: "post", idempotencyKey: "key-12345678" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/The freight:/);
    expect(r.errors.join(" ")).toMatch(/The amount paid:/);
  });
});

describe("stock hints: per product × warehouse, TOTALLED across lines (the server's rule), own bags counted back on an edit", () => {
  const products = new Map([[IDS.product, pick({ available: [{ warehouseId: WH1, quantity: 10 }, { warehouseId: WH2, quantity: 4 }] })]]);

  it("two lines of one product from one godown are added before comparing", () => {
    const f = formWith({ lines: [line({ quantity: "6" }), line({ quantity: "6" })] });
    const s = stockByPair(f, products);
    expect(s.get(pairKey(IDS.product, WH1))).toEqual({ availableMilli: 10_000, requestedMilli: 12_000, shortMilli: 2_000 });
    expect(shortLineCount(f, s)).toBe(2); // both lines are marked, the header counts them
  });

  it("the same product from two godowns is two pairs", () => {
    const f = formWith({ lines: [line({ quantity: "8", warehouseId: WH1 }), line({ quantity: "8", warehouseId: WH2 })] });
    const s = stockByPair(f, products);
    expect(s.get(pairKey(IDS.product, WH1))!.shortMilli).toBe(0);
    expect(s.get(pairKey(IDS.product, WH2))!.shortMilli).toBe(4_000);
    expect(shortLineCount(f, s)).toBe(1);
  });

  it("exactly what is there is not short; a godown with no row has 0", () => {
    expect(stockByPair(formWith({ lines: [line({ quantity: "10" })] }), products).get(pairKey(IDS.product, WH1))!.shortMilli).toBe(0);
    const none = new Map([[IDS.product, pick({ available: [] })]]);
    expect(stockByPair(formWith({ lines: [line({ quantity: "1" })] }), none).get(pairKey(IDS.product, WH1))).toMatchObject({ availableMilli: 0, shortMilli: 1_000 });
  });

  it("fractions are exact: 2.5 asked of 2.4 is short by 0.1", () => {
    const p = new Map([[IDS.product, pick({ available: [{ warehouseId: WH1, quantity: 2.4 }] })]]);
    expect(stockByPair(formWith({ lines: [line({ quantity: "2.5" })] }), p).get(pairKey(IDS.product, WH1))!.shortMilli).toBe(100);
  });

  it("a product whose figures have not arrived is 'unknown', never 'short'", () => {
    const s = stockByPair(formWith({ lines: [line({ quantity: "999" })] }), new Map());
    expect(s.get(pairKey(IDS.product, WH1))).toEqual({ availableMilli: null, requestedMilli: 999_000, shortMilli: 0 });
  });

  it("editing a posted invoice counts its own deducted bags back in", () => {
    const posted = invoiceDetail({ status: "CONFIRMED", stockApplied: true, migrated: false });
    const own = ownBagsBack(posted);
    expect(own.get(pairKey(IDS.product, IDS.warehouse))).toBe(20_000);
    const p = new Map([[IDS.product, pick({ available: [{ warehouseId: IDS.warehouse, quantity: 5 }] })]]);
    const f = formWith({ lines: [line({ quantity: "24", warehouseId: IDS.warehouse })] });
    expect(stockByPair(f, p).get(pairKey(IDS.product, IDS.warehouse))!.shortMilli).toBe(19_000); // without the invoice's own 20 bags
    expect(stockByPair(f, p, own).get(pairKey(IDS.product, IDS.warehouse))).toEqual({ availableMilli: 25_000, requestedMilli: 24_000, shortMilli: 0 });
  });

  it("only stock that was really deducted comes back: a draft, a migrated or a cancelled invoice adds nothing", () => {
    expect(ownBagsBack(invoiceDetail({ status: "DRAFT", stockApplied: false })).size).toBe(0);
    expect(ownBagsBack(invoiceDetail({ status: "CONFIRMED", stockApplied: true, migrated: true })).size).toBe(0);
    expect(ownBagsBack(invoiceDetail({ status: "CANCELLED", stockApplied: false })).size).toBe(0);
    expect(ownBagsBack(invoiceDetail({ status: "CONFIRMED", stockApplied: false })).size).toBe(0);
  });
});

describe("price hints: below cost / below the minimum / low margin — only when the role may see cost", () => {
  const p = pick({ costP: 100_000, minSellP: 120_000 });
  const l = (rate: string, quantity = "10", discount = "") => ({ quantity, rate, discount });

  it("nothing at all for a role without PROFIT_VIEW, even when a cost figure is in the data", () => {
    expect(priceHint(false, p, l("500"))).toBeNull();
    expect(priceHint(false, undefined, l("500"))).toBeNull();
  });

  it("below cost says the loss on the line", () => {
    const h = priceHint(true, p, l("900"));
    expect(h?.kind).toBe("below-cost");
    expect(h?.text).toBe("Below cost. Cost PKR 1,000/bag against PKR 900 — a loss of PKR 1,000 on this line.");
  });

  it("a discount counts against the rate: 1,000 a bag less 1,000 on ten bags is 900 a bag, below the 1,000 cost", () => {
    expect(priceHint(true, p, l("1000", "10", "1000"))?.kind).toBe("below-cost");
    expect(priceHint(true, p, l("1000", "10", "0"))?.kind).toBe("below-min"); // 1,000 is at cost, under the 1,200 minimum
  });

  it("below the minimum price, then low margin (under 5%), then ok", () => {
    expect(priceHint(true, p, l("1100"))?.kind).toBe("below-min");
    expect(priceHint(true, pick({ costP: 100_000, minSellP: null }), l("1040"))?.kind).toBe("low-margin"); // 3.85%
    const ok = priceHint(true, pick({ costP: 100_000, minSellP: null }), l("1500"));
    expect(ok?.kind).toBe("ok");
    expect(ok?.text).toContain("margin 33.33%");
  });

  it("S14 (c78659b): the cost includes the extra cost per bag and the note shows the legacy breakdown — the client's 3,000 + 200", () => {
    const x = pick({ costP: 320_000, extraP: 20_000, stockCostP: 300_000, minSellP: null });
    const ok = priceHint(true, x, l("3400"));
    expect(ok?.kind).toBe("ok");
    expect(ok?.text).toBe("Cost PKR 3,200 (stock PKR 3,000 + extra PKR 200)/bag · profit PKR 2,000 · margin 5.88%.");
    expect(priceHint(true, x, l("3100"))?.text).toBe("Below cost. Cost PKR 3,200 (stock PKR 3,000 + extra PKR 200)/bag against PKR 3,100 — a loss of PKR 1,000 on this line.");
    // no extra: no breakdown
    expect(priceHint(true, pick({ costP: 300_000, extraP: 0, minSellP: null }), l("3400"))?.text).toBe("Cost PKR 3,000/bag · profit PKR 4,000 · margin 11.76%.");
  });

  it("no cost recorded is said, not treated as free", () => {
    expect(priceHint(true, pick({ costP: 0 }), l("1500"))?.kind).toBe("no-cost");
    expect(priceHint(true, pick({ costP: null }), l("1500"))?.kind).toBe("no-cost");
  });

  it("says nothing until there is a quantity and a rate to judge", () => {
    expect(priceHint(true, p, l("", "10"))).toBeNull();
    expect(priceHint(true, p, l("900", ""))).toBeNull();
    expect(priceHint(true, p, l("9x0", "10"))).toBeNull();
  });
});

describe("the starting rate: the owner's set price, else the last rate charged, else empty", () => {
  it("prefers sellP, falls back to lastRateP, then to nothing", () => {
    expect(defaultRateText({ sellP: 200_000, lastRateP: 150_000 })).toBe("2000");
    expect(defaultRateText({ sellP: null, lastRateP: 123_450 })).toBe("1234.50");
    expect(defaultRateText({ sellP: null, lastRateP: null })).toBe("");
    expect(defaultRateText({ sellP: 0, lastRateP: null })).toBe("");
  });
});

describe("unsaved changes = different from the snapshot, not 'a key was pressed'", () => {
  const start = formWith({ lines: [line({ quantity: "5" })] });
  it("the same form is not dirty; typing a character and deleting it again is not dirty", () => {
    expect(isDirty(start, start)).toBe(false);
    const typed = formReducer(start, { type: "line", key: start.lines[0]!.key, patch: { quantity: "55" } });
    expect(isDirty(typed, start)).toBe(true);
    const undone = formReducer(typed, { type: "line", key: start.lines[0]!.key, patch: { quantity: "5" } });
    expect(isDirty(undone, start)).toBe(false);
  });
  it("adding and removing the same line is not dirty; the React keys never count", () => {
    const extra = line();
    const added = formReducer(start, { type: "addLine", line: extra });
    expect(isDirty(added, start)).toBe(true);
    expect(isDirty(formReducer(added, { type: "remove", key: extra.key }), start)).toBe(false);
    const rekeyed = { ...start, lines: start.lines.map((l) => ({ ...l, key: "another-key" })) };
    expect(fingerprint(rekeyed)).toBe(fingerprint(start));
  });
  it("choosing a shop, changing the warehouse, a charge or the note are changes", () => {
    const shop = { id: IDS.shop, name: "A", contact: null, phone: null, region: null, regionId: null, active: true };
    expect(isDirty(formReducer(start, { type: "shop", customer: shop }), start)).toBe(true);
    expect(isDirty(formReducer(start, { type: "headerWarehouse", warehouseId: WH2 }), start)).toBe(true);
    expect(isDirty(formReducer(start, { type: "field", field: "freight", value: "1" }), start)).toBe(true);
    expect(isDirty(formReducer(start, { type: "field", field: "notes", value: "x" }), start)).toBe(true);
  });
  it("after a save the snapshot is the saved form: not dirty again", () => {
    const changed = formReducer(start, { type: "field", field: "notes", value: "x" });
    expect(isDirty(changed, changed)).toBe(false);
  });
});

describe("what the server refused", () => {
  it("reads the line number of 'Line 2 (Zam Zam): …' and 'Line 3: …', nothing else", () => {
    expect(lineNumberOf("Line 2 (Zam Zam): quantity must be more than zero.")).toBe(2);
    expect(lineNumberOf("Line 13: the rate cannot be negative.")).toBe(13);
    expect(lineNumberOf("Choose a shop to invoice.")).toBeNull();
    expect(lineNumberOf("Only 10 bags of Line 4 Flour are available")).toBeNull();
    expect(lineNumberOf("Baseline 2: nope")).toBeNull();
  });
  it("splits line messages (marked on their row) from the rest, and never drops one", () => {
    const all = ["Choose a shop to invoice.", "Line 1 (A): enter a rate per bag.", "Line 1: the discount is larger than the line amount.", "Line 3 (B): quantity must be more than zero.", "Only 3 bags of B are available in Main. Requested: 5."];
    const s = splitErrors(all);
    expect([...s.byLine.entries()]).toEqual([[1, [all[1], all[2]]], [3, [all[3]]]]);
    expect(s.general).toEqual([all[0], all[4]]);
    expect(s.general.length + [...s.byLine.values()].flat().length).toBe(all.length);
  });
});

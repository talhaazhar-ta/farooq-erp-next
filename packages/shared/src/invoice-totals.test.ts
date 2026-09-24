import { describe, expect, it } from "vitest";
import { grossOf, invoiceTotals, lineTotals, milliToQty, paymentStatusOf, qtyToMilli, type InvoiceInput } from "./invoice-totals.js";

const rs = (r: number): number => Math.round(r * 100); // rupees → paisa, test inputs only

describe("qty ↔ thousandths (the legacy Money.qty rounding, exact)", () => {
  it.each([[2.5, 2500], [10, 10_000], [0.3004, 300], [0.3005, 301], [0.1 + 0.2, 300], [1.0005, 1001], [0, 0], [NaN, 0]] as [number, number][])(
    "%f → %i thousandths",
    (q, milli) => expect(qtyToMilli(q)).toBe(milli),
  );
  it("milliToQty is the inverse for whole thousandths", () => {
    for (const m of [1, 250, 2500, 12_345, 1_000_000]) expect(qtyToMilli(milliToQty(m))).toBe(m);
  });
});

describe("lineTotals — Calc.line, hand-computed", () => {
  it("40 bags × 3,000 = 120,000 (legacy test T1.8)", () => {
    expect(lineTotals({ qtyMilli: 40_000, unitPriceP: rs(3000) })).toEqual({
      qtyMilli: 40_000, unitPriceP: 300_000, grossP: 12_000_000, discountP: 0, taxP: 0, lineTotalP: 12_000_000,
    });
  });
  it("a fractional quantity: 2.5 bags × 2,250.50 = 5,626.25 → 562,625 paisa", () => {
    expect(grossOf(225_050, 2500)).toBe(562_625);
  });
  it("gross is rounded to whole paisa, once per line (no whole-invoice rounding): 0.333 × 100.01", () => {
    // 10,001 paisa × 0.333 = 3,330.333 → 3,330
    expect(grossOf(10_001, 333)).toBe(3330);
    // 10,001 × 0.5 = 5,000.5 → rounds half up to 5,001
    expect(grossOf(10_001, 500)).toBe(5001);
  });
  it("the line discount is capped at the gross", () => {
    const t = lineTotals({ qtyMilli: 2000, unitPriceP: 1000, discountP: 5000 });
    expect(t).toMatchObject({ grossP: 2000, discountP: 2000, lineTotalP: 0 });
  });
  it("tax by rate is on the taxable amount (gross − discount), rounded: 10% of 9,000 − 500", () => {
    const t = lineTotals({ qtyMilli: 3000, unitPriceP: 3000, discountP: 500, taxRatePct: 10 });
    expect(t).toMatchObject({ grossP: 9000, discountP: 500, taxP: 850, lineTotalP: 9350 });
  });
  it("tax by rate wins over an explicit taxP; with no rate the saved taxP is used as it is", () => {
    expect(lineTotals({ qtyMilli: 1000, unitPriceP: 10_000, taxP: 123, taxRatePct: 5 }).taxP).toBe(500);
    expect(lineTotals({ qtyMilli: 1000, unitPriceP: 10_000, taxP: 123 }).taxP).toBe(123);
    expect(lineTotals({ qtyMilli: 1000, unitPriceP: 10_000, taxP: 123, taxRatePct: 0 }).taxP).toBe(123);
  });
  it("tax rounding: 7.5% of 10,001 = 750.075 → 750; 12.5% of 10,004 = 1,250.5 → 1,251", () => {
    expect(lineTotals({ qtyMilli: 1000, unitPriceP: 10_001, taxRatePct: 7.5 }).taxP).toBe(750);
    expect(lineTotals({ qtyMilli: 1000, unitPriceP: 10_004, taxRatePct: 12.5 }).taxP).toBe(1251);
  });
});

describe("invoiceTotals — Calc.invoice, hand-computed", () => {
  it("legacy test T2: five products, item + invoice discounts, freight + loading + other, partly paid", () => {
    const input: InvoiceInput = {
      lines: [
        { qtyMilli: 10_000, unitPriceP: rs(3000), discountP: rs(1000) },
        { qtyMilli: 20_000, unitPriceP: rs(2500) },
        { qtyMilli: 5000, unitPriceP: rs(7500), discountP: rs(500) },
        { qtyMilli: 12_000, unitPriceP: rs(4000) },
        { qtyMilli: 8000, unitPriceP: rs(6000) },
      ],
      invoiceDiscountP: rs(5000), freightP: rs(8000), loadingP: rs(2000), otherChargesP: rs(1000), paidP: rs(100_000),
    };
    const t = invoiceTotals(input);
    // 10×3000 + 20×2500 + 5×7500 + 12×4000 + 8×6000 = 30,000 + 50,000 + 37,500 + 48,000 + 48,000 = 213,500
    expect(t.subtotalP).toBe(rs(213_500));
    expect(t.itemDiscountsP).toBe(rs(1500));
    expect(t.invoiceDiscountP).toBe(rs(5000));
    expect(t.discountAmountP).toBe(rs(6500));
    expect(t.grandTotalP).toBe(rs(213_500 - 1500 - 5000 + 11_000)); // 218,000
    expect(t.balanceP).toBe(rs(118_000));
    expect(t.paymentStatus).toBe("PARTIAL");
    expect(t.totalQtyMilli).toBe(55_000);
    expect(t.lineCount).toBe(5);
    expect(t.lines.map((l) => l.lineTotalP)).toEqual([rs(29_000), rs(50_000), rs(37_000), rs(48_000), rs(48_000)]);
  });
  it("legacy test T4: 50 bags × 4,000 = 200,000, 75,000 received → 125,000 balance, PARTIAL", () => {
    const t = invoiceTotals({ lines: [{ qtyMilli: 50_000, unitPriceP: rs(4000) }], paidP: rs(75_000) });
    expect(t).toMatchObject({ grandTotalP: rs(200_000), balanceP: rs(125_000), paymentStatus: "PARTIAL" });
  });
  it("the invoice discount is capped at (subtotal − item discounts), never below zero", () => {
    const lines = [{ qtyMilli: 1000, unitPriceP: 10_000, discountP: 2000 }];
    expect(invoiceTotals({ lines, invoiceDiscountP: 999_999 })).toMatchObject({ invoiceDiscountP: 8000, grandTotalP: 0 });
    // a fully discounted line leaves nothing to discount further
    const free = [{ qtyMilli: 1000, unitPriceP: 10_000, discountP: 10_000 }];
    expect(invoiceTotals({ lines: free, invoiceDiscountP: 500 })).toMatchObject({ invoiceDiscountP: 0, grandTotalP: 0 });
  });
  it("charges are added after the discounts and are not capped", () => {
    const t = invoiceTotals({ lines: [{ qtyMilli: 1000, unitPriceP: 1000 }], invoiceDiscountP: 100, freightP: 50, loadingP: 30, otherChargesP: 20 });
    expect(t.grandTotalP).toBe(1000 - 100 + 100);
  });
  it("taxed lines add to the total; the header tax is the sum of the lines", () => {
    const t = invoiceTotals({
      lines: [{ qtyMilli: 2000, unitPriceP: 5000, taxRatePct: 10 }, { qtyMilli: 1000, unitPriceP: 3000, taxP: 45 }],
    });
    expect(t.taxP).toBe(1000 + 45);
    expect(t.grandTotalP).toBe(10_000 + 3000 + 1045);
  });
  it("no lines: everything zero, UNPAID", () => {
    expect(invoiceTotals({ lines: [] })).toMatchObject({ subtotalP: 0, grandTotalP: 0, lineCount: 0, totalQtyMilli: 0, paymentStatus: "UNPAID" });
  });
  it("fractional quantities sum exactly in thousandths (0.1 + 0.2 + 0.3 = 0.6, not 0.6000000000000001)", () => {
    const t = invoiceTotals({ lines: [100, 200, 300].map((q) => ({ qtyMilli: q, unitPriceP: 1000 })) });
    expect(t.totalQtyMilli).toBe(600);
    expect(t.subtotalP).toBe(100 + 200 + 300);
  });
});

describe("paymentStatusOf — Calc.paymentStatus", () => {
  it.each([
    [0, 0, "UNPAID"], [0, 500, "UNPAID"], [-5, 0, "UNPAID"], // a zero / negative grand total is UNPAID even when 'paid' (legacy)
    [1000, 0, "UNPAID"], [1000, 1, "PARTIAL"], [1000, 999, "PARTIAL"], [1000, 1000, "PAID"], [1000, 1500, "PAID"],
  ] as [number, number, string][])("grand %i, paid %i → %s", (g, p, s) => expect(paymentStatusOf(g, p)).toBe(s));
});

/* ── properties ─────────────────────────────────────────────────────────── */

/** mulberry32: a small seeded PRNG, so a failure names its seed and reproduces. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The legacy formulas, typed out again with the legacy's own float quantity, as an independent reference. */
function legacyReference(input: InvoiceInput) {
  const items = input.lines.map((l) => {
    const qty = Math.round((l.qtyMilli / 1000) * 1000) / 1000; // Money.qty
    const gross = Math.round((l.unitPriceP || 0) * (Number(qty) || 0)); // Money.mul
    const disc = Math.min(l.discountP ?? 0, gross);
    const taxable = gross - disc;
    const tax = l.taxRatePct ? Math.round((taxable * Number(l.taxRatePct)) / 100) : (l.taxP ?? 0);
    return { qty, gross, disc, tax, lineTotal: taxable + tax };
  });
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const subtotal = sum(items.map((i) => i.gross));
  const itemDiscounts = sum(items.map((i) => i.disc));
  const itemTax = sum(items.map((i) => i.tax));
  const invDiscount = Math.min(input.invoiceDiscountP ?? 0, Math.max(0, subtotal - itemDiscounts));
  const grand = subtotal - itemDiscounts - invDiscount + itemTax + (input.freightP ?? 0) + (input.loadingP ?? 0) + (input.otherChargesP ?? 0);
  return { items, subtotal, itemDiscounts, invDiscount, itemTax, grand };
}

function randomInvoice(next: () => number): InvoiceInput {
  const int = (max: number) => Math.floor(next() * (max + 1));
  const n = int(8);
  return {
    lines: Array.from({ length: n }, () => ({
      qtyMilli: 1 + int(200_000), // up to 200 bags, thousandths
      unitPriceP: int(2_000_000),
      discountP: next() < 0.5 ? int(3_000_000) : 0,
      ...(next() < 0.3 ? { taxRatePct: [5, 7.5, 12.5, 17][int(3)]! } : { taxP: next() < 0.3 ? int(50_000) : 0 }),
    })),
    invoiceDiscountP: next() < 0.5 ? int(5_000_000) : 0,
    freightP: int(100_000), loadingP: int(50_000), otherChargesP: int(20_000), paidP: int(10_000_000),
  };
}

describe("properties (seeded, 3,000 random valid invoices)", () => {
  it("equals an independent re-typing of the legacy formulas, line by line", () => {
    const next = rng(20260924);
    for (let i = 0; i < 3000; i++) {
      const input = randomInvoice(next);
      const t = invoiceTotals(input);
      const ref = legacyReference(input);
      const ctx = `case ${i} ${JSON.stringify(input)}`;
      expect(t.subtotalP, ctx).toBe(ref.subtotal);
      expect(t.itemDiscountsP, ctx).toBe(ref.itemDiscounts);
      expect(t.invoiceDiscountP, ctx).toBe(ref.invDiscount);
      expect(t.taxP, ctx).toBe(ref.itemTax);
      expect(t.grandTotalP, ctx).toBe(ref.grand);
      expect(t.lines.map((l) => l.lineTotalP), ctx).toEqual(ref.items.map((x) => x.lineTotal));
    }
  });
  it("never negative, discounts never exceed what they discount, the grand total is the sum of its parts", () => {
    const next = rng(7);
    for (let i = 0; i < 3000; i++) {
      const input = randomInvoice(next);
      const t = invoiceTotals(input);
      const ctx = `case ${i}`;
      for (const l of t.lines) {
        expect(l.discountP, ctx).toBeLessThanOrEqual(l.grossP);
        expect(l.discountP, ctx).toBeGreaterThanOrEqual(0);
        expect(l.lineTotalP, ctx).toBeGreaterThanOrEqual(0);
        expect(l.lineTotalP, ctx).toBe(l.grossP - l.discountP + l.taxP);
      }
      expect(t.invoiceDiscountP, ctx).toBeLessThanOrEqual(Math.max(0, t.subtotalP - t.itemDiscountsP));
      expect(t.grandTotalP, ctx).toBeGreaterThanOrEqual(0);
      expect(t.grandTotalP, ctx).toBe(t.lines.reduce((a, l) => a + l.lineTotalP, 0) - t.invoiceDiscountP + t.freightP + t.loadingP + t.otherChargesP);
      expect(t.balanceP, ctx).toBe(t.grandTotalP - t.paidP);
      expect(Number.isSafeInteger(t.grandTotalP), ctx).toBe(true);
    }
  });
  it("more discount never raises the total; more quantity never lowers the subtotal", () => {
    const next = rng(99);
    for (let i = 0; i < 1000; i++) {
      const input = randomInvoice(next);
      const more = { ...input, invoiceDiscountP: (input.invoiceDiscountP ?? 0) + 1000 };
      expect(invoiceTotals(more).grandTotalP).toBeLessThanOrEqual(invoiceTotals(input).grandTotalP);
      const bigger = { ...input, lines: input.lines.map((l) => ({ ...l, qtyMilli: l.qtyMilli + 1000 })) };
      expect(invoiceTotals(bigger).subtotalP).toBeGreaterThanOrEqual(invoiceTotals(input).subtotalP);
    }
  });
});

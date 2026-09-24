import { describe, expect, it } from "vitest";
import { invoiceTotals } from "./invoice-totals.js";
import { profitOfInvoice, profitOfLine } from "./profit.js";

/**
 * Profit on an invoice (S8 planner decision 3): goods margin net of the discount actually given; charges and tax are not margin;
 * an unknown cost is never counted as free. Every figure below is worked out by hand; the legacy `Profit.invoice` (grand total −
 * Σ cost) is held beside it to show exactly where the two disagree.
 */
describe("profitOfLine", () => {
  it("revenue is the line total without its tax; cost is round(cost × qty); margin is of the sale, markup of the cost", () => {
    // 10 bags at 100,000 cost 80,000
    expect(profitOfLine({ qtyMilli: 10_000, lineTotalP: 1_000_000, taxP: 0, costSnapshotP: 80_000 })).toEqual({
      revenueP: 1_000_000, costKnown: true, costP: 800_000, profitP: 200_000, marginPct: 20, markupPct: 25,
    });
    // tax is not revenue: line total 95,000 = 90,000 + 5,000 tax
    expect(profitOfLine({ qtyMilli: 2000, lineTotalP: 95_000, taxP: 5000, costSnapshotP: 30_000 })).toMatchObject({ revenueP: 90_000, costP: 60_000, profitP: 30_000, marginPct: 33.33, markupPct: 50 });
  });

  it("a fractional quantity: 2.5 bags at cost 80,000 costs 200,000; 0.3 bag at 33,333 rounds 9,999.9 to 10,000", () => {
    expect(profitOfLine({ qtyMilli: 2500, lineTotalP: 750_000, taxP: 0, costSnapshotP: 80_000 })).toMatchObject({ costP: 200_000, profitP: 550_000, marginPct: 73.33, markupPct: 275 });
    expect(profitOfLine({ qtyMilli: 300, lineTotalP: 30_000, taxP: 0, costSnapshotP: 33_333 }).costP).toBe(10_000);
  });

  it("an unknown cost (null or 0) is flagged and has NO profit, margin or markup — never 'as if it cost nothing'", () => {
    for (const costSnapshotP of [null, 0]) {
      expect(profitOfLine({ qtyMilli: 4000, lineTotalP: 400_000, taxP: 0, costSnapshotP })).toEqual({ revenueP: 400_000, costKnown: false, costP: null, profitP: null, marginPct: null, markupPct: null });
    }
  });

  it("selling below cost is a negative profit; a free line has revenue 0 and no margin", () => {
    expect(profitOfLine({ qtyMilli: 1000, lineTotalP: 70_000, taxP: 0, costSnapshotP: 80_000 })).toMatchObject({ profitP: -10_000, marginPct: -14.29, markupPct: -12.5 });
    expect(profitOfLine({ qtyMilli: 1000, lineTotalP: 0, taxP: 0, costSnapshotP: 80_000 })).toMatchObject({ profitP: -80_000, marginPct: null });
  });
});

describe("profitOfInvoice — the adopted definition against the legacy figure", () => {
  it("nothing but goods: the two definitions agree", () => {
    const p = profitOfInvoice({ lines: [{ qtyMilli: 10_000, lineTotalP: 1_000_000, taxP: 0, costSnapshotP: 80_000 }], invoiceDiscountP: 0, grandTotalP: 1_000_000 });
    expect(p).toMatchObject({ revenueP: 1_000_000, costP: 800_000, profitP: 200_000, marginPct: 20, complete: true, unknownCostLines: 0, legacyProfitP: 200_000 });
  });

  it("charges and tax are NOT margin: they lift the legacy figure and leave the adopted one alone; the invoice discount comes off", () => {
    // 2 bags × 50,000 = 100,000, line discount 10,000, line tax 5,000 → line total 95,000; cost 30,000 a bag; invoice discount 20,000; freight 15,000, loading 5,000
    const t = invoiceTotals({ lines: [{ qtyMilli: 2000, unitPriceP: 50_000, discountP: 10_000, taxP: 5000 }], invoiceDiscountP: 20_000, freightP: 15_000, loadingP: 5000 });
    expect(t.grandTotalP).toBe(95_000); // 100,000 − 10,000 − 20,000 + 5,000 + 15,000 + 5,000
    const p = profitOfInvoice({ lines: [{ qtyMilli: 2000, lineTotalP: t.lines[0]!.lineTotalP, taxP: t.lines[0]!.taxP, costSnapshotP: 30_000 }], invoiceDiscountP: t.invoiceDiscountP, grandTotalP: t.grandTotalP });
    // adopted: (95,000 − 5,000 tax) − 60,000 cost − 20,000 invoice discount = 10,000 ; margin of what was really charged for goods: 10,000 / (90,000 − 20,000)
    expect(p).toMatchObject({ revenueP: 90_000, costP: 60_000, profitP: 10_000, marginPct: 14.29, complete: true });
    // legacy: grand total 95,000 − cost 60,000 = 35,000 — the difference is exactly tax 5,000 + freight 15,000 + loading 5,000
    expect(p.legacyProfitP).toBe(35_000);
    expect(p.legacyProfitP - p.profitP!).toBe(5000 + 15_000 + 5000);
  });

  it("an unknown-cost line is left out of the profit and the margin; the invoice discount is shared by revenue; `complete` says so", () => {
    const p = profitOfInvoice({
      lines: [
        { qtyMilli: 1000, lineTotalP: 100_000, taxP: 0, costSnapshotP: 60_000 },
        { qtyMilli: 1000, lineTotalP: 50_000, taxP: 0, costSnapshotP: 0 },
      ],
      invoiceDiscountP: 30_000,
      grandTotalP: 120_000,
    });
    // the known line carries 100,000 / 150,000 of the discount = 20,000: 100,000 − 60,000 − 20,000 = 20,000 on a base of 80,000
    expect(p).toMatchObject({ revenueP: 150_000, costP: 60_000, profitP: 20_000, marginPct: 25, complete: false, unknownCostLines: 1 });
    expect(p.lines[1]).toMatchObject({ costKnown: false, profitP: null });
    // the legacy counted the unknown line's cost as zero: 120,000 − 60,000 = 60,000 — three times the honest figure
    expect(p.legacyProfitP).toBe(60_000);
  });

  it("no line with a known cost: no profit and no margin at all (the legacy would say the whole invoice was profit)", () => {
    const p = profitOfInvoice({ lines: [{ qtyMilli: 3000, lineTotalP: 300_000, taxP: 0, costSnapshotP: null }], invoiceDiscountP: 0, grandTotalP: 300_000 });
    expect(p).toMatchObject({ profitP: null, marginPct: null, costP: 0, complete: false, unknownCostLines: 1, legacyProfitP: 300_000 });
  });

  it("an invoice with no lines has nothing to report", () => {
    expect(profitOfInvoice({ lines: [], invoiceDiscountP: 0, grandTotalP: 0 })).toMatchObject({ revenueP: 0, profitP: null, marginPct: null, complete: true, legacyProfitP: 0 });
  });

  it("all costs known: the whole invoice discount comes off, however many lines", () => {
    const p = profitOfInvoice({
      lines: [
        { qtyMilli: 5000, lineTotalP: 500_000, taxP: 0, costSnapshotP: 60_000 },
        { qtyMilli: 2500, lineTotalP: 400_000, taxP: 0, costSnapshotP: 100_000 },
      ],
      invoiceDiscountP: 25_000,
      grandTotalP: 875_000,
    });
    // (500,000 − 300,000) + (400,000 − 250,000) − 25,000 = 325,000 on 875,000
    expect(p).toMatchObject({ profitP: 325_000, costP: 550_000, marginPct: 37.14, complete: true });
  });
});

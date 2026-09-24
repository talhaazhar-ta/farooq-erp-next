import { describe, expect, it } from "vitest";
import { cleanDescription, formatQtyMilli, invoiceRowDetail, lineSummary, qtyInfoOf, qtyLabelOf, type SummaryLine } from "./line-summary.js";

const line = (o: Partial<SummaryLine> = {}): SummaryLine => ({ descriptionEn: "Zam Zam 20KG", description: "زم زم", package: "Bag", qtyMilli: 200_000, unitPriceP: 270_000, ...o });

/** The legacy `Desc.fromLines` / `qtyOf` / `qtyLabel` (24-client-changes.js), by hand. */
describe("lineSummary", () => {
  it("one line: quantity × name @ rate — the pack only when it is not a Bag", () => {
    expect(lineSummary([line()])).toBe("200 × Zam Zam 20KG @ PKR 2,700");
    expect(lineSummary([line({ package: "50 KG" })])).toBe("200 × Zam Zam 20KG 50 KG @ PKR 2,700");
    expect(lineSummary([line({ qtyMilli: 1_250_000, unitPriceP: 100_050 })])).toBe("1,250 × Zam Zam 20KG @ PKR 1,000.50");
    expect(lineSummary([line({ qtyMilli: 2500 })])).toBe("2.5 × Zam Zam 20KG @ PKR 2,700");
    expect(lineSummary([line({ qtyMilli: 600 })])).toBe("0.6 × Zam Zam 20KG @ PKR 2,700");
  });

  it("the name falls back to the Urdu one, then 'item'; no rate, no '@'", () => {
    expect(lineSummary([line({ descriptionEn: null })])).toBe("200 × زم زم @ PKR 2,700");
    expect(lineSummary([line({ descriptionEn: "", description: "" })])).toBe("200 × item @ PKR 2,700");
    expect(lineSummary([line({ unitPriceP: 0 })])).toBe("200 × Zam Zam 20KG");
  });

  it("several lines: the count and the total quantity; no lines: nothing", () => {
    expect(lineSummary([line({ qtyMilli: 200_000 }), line({ qtyMilli: 250_000 }), line({ qtyMilli: 50_000 })])).toBe("3 items — 500 total qty");
    expect(lineSummary([line({ qtyMilli: 1500 }), line({ qtyMilli: 1000 })])).toBe("2 items — 2.5 total qty");
    expect(lineSummary([])).toBe("");
  });
});

describe("qtyInfoOf / qtyLabelOf", () => {
  it("total bags; lines in different packages are 'mixed' and labelled, never silently summed into one unit", () => {
    expect(qtyInfoOf([])).toBeNull();
    expect(qtyInfoOf([line({ qtyMilli: 200_000 }), line({ qtyMilli: 2500 })])).toEqual({ total: 202.5, mixed: false });
    expect(qtyInfoOf([line({ package: "Bag" }), line({ package: "50 KG" })])!.mixed).toBe(true);
    expect(qtyInfoOf([line({ package: null }), line({ package: "Bag" })])!.mixed).toBe(false); // no pack means Bag
    expect(qtyLabelOf(null)).toBe("—");
    expect(qtyLabelOf({ total: 0, mixed: false })).toBe("—");
    expect(qtyLabelOf({ total: 1250, mixed: false })).toBe("1,250");
    expect(qtyLabelOf({ total: 202.5, mixed: true })).toBe("202.5 (mixed units)");
  });
});

describe("cleanDescription and invoiceRowDetail", () => {
  it("line breaks and tabs become spaces, the ends are trimmed (NBSP too), the length is capped at 500", () => {
    const nbsp = String.fromCharCode(0xa0);
    expect(cleanDescription(`  a\r\nb\tc ${nbsp}${nbsp}`)).toBe("a b c");
    expect(cleanDescription(null)).toBe("");
    expect(cleanDescription("x".repeat(600))).toHaveLength(500);
  });

  it("what was typed wins; else the lines; else 'Sale invoice <number>'", () => {
    expect(invoiceRowDetail("Weekly stock", [line()], "INV-1")).toBe("Weekly stock");
    expect(invoiceRowDetail("   ", [line()], "INV-1")).toBe("200 × Zam Zam 20KG @ PKR 2,700");
    expect(invoiceRowDetail(null, [line(), line()], "INV-1")).toBe("2 items — 400 total qty");
    expect(invoiceRowDetail(null, [], "INV-2026-000009")).toBe("Sale invoice INV-2026-000009");
    expect(invoiceRowDetail("", [], null)).toBe("Sale invoice ");
  });
});

describe("formatQtyMilli", () => {
  it("is Number.toLocaleString('en-US') for every quantity of at most three decimals", () => {
    for (const milli of [0, 1, 10, 100, 500, 600, 1000, 2500, 12_345, 1_000_000, 1_234_567, 999_999_999, -1500]) {
      expect(formatQtyMilli(milli)).toBe((milli / 1000).toLocaleString("en-US"));
    }
  });
});

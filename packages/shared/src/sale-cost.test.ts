import { describe, expect, it } from "vitest";
import { extraOf, saleCostOf } from "./sale-cost.js";

/**
 * Old repo `c78659b` (02-services.js `Inventory.extraOf` / `saleCostOf`), the client's own example: purchase 3,000 + extra
 * 200 = a sale costed at 3,200 a bag. Figures in paisa.
 */
describe("extraOf — the product's extra cost per bag", () => {
  it("LANDED (the default and the real setting): the product's extra_p", () => {
    expect(extraOf(20_000, "LANDED")).toBe(20_000);
  });
  it("PURCHASE basis ('purchase price only'): never added", () => {
    expect(extraOf(20_000, "PURCHASE")).toBe(0);
  });
  it("unset, zero or negative: 0", () => {
    expect(extraOf(null, "LANDED")).toBe(0);
    expect(extraOf(undefined, "LANDED")).toBe(0);
    expect(extraOf(0, "LANDED")).toBe(0);
    expect(extraOf(-500, "LANDED")).toBe(0);
  });
});

describe("saleCostOf = stock cost + extra, only while the stock cost is known", () => {
  it("3,000 stock + 200 extra = 3,200 (breakdown kept)", () => {
    expect(saleCostOf(300_000, 20_000, "LANDED")).toEqual({ costP: 320_000, stockCostP: 300_000, extraP: 20_000 });
  });
  it("PURCHASE basis: the stock cost alone", () => {
    expect(saleCostOf(300_000, 20_000, "PURCHASE")).toEqual({ costP: 300_000, stockCostP: 300_000, extraP: 0 });
  });
  it("an unknown stock cost stays unknown — the extra alone is not a cost price", () => {
    expect(saleCostOf(0, 20_000, "LANDED")).toEqual({ costP: 0, stockCostP: 0, extraP: 0 });
  });
  it("no extra: unchanged", () => {
    expect(saleCostOf(300_000, null, "LANDED")).toEqual({ costP: 300_000, stockCostP: 300_000, extraP: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { allocateCharges, costBasisOf, unitCostForAverage, weightedAverage, type AllocLine, type AverageLine } from "./purchase-cost.js";

/**
 * Purchase costing: a port of the legacy `Cost.allocate`, `Cost.weightedAverage` and `Landed.weightedAverage`. Every figure is
 * worked out by hand. The one deliberate difference from the legacy (fix 3, part delivery) is pinned with the legacy figure
 * written out beside the fixed one.
 */
const line = (bags: number, receivedBags: number, unitPriceP: number, lineTotalP: number): AllocLine => ({
  qtyMilli: bags * 1000, receivedQtyMilli: receivedBags * 1000, unitPriceP, lineTotalP,
});
const avgLine = (o: Partial<AverageLine> & { bags: number }): AverageLine => ({
  qtyMilli: o.bags * 1000, receivedQtyMilli: o.receivedQtyMilli ?? o.bags * 1000, unitPriceP: o.unitPriceP ?? 0, lineTotalP: o.lineTotalP ?? 0,
  goodsUnitCostP: o.goodsUnitCostP ?? null, chargeShareP: o.chargeShareP ?? null, landedUnitCostP: o.landedUnitCostP ?? null, operationalShareP: o.operationalShareP ?? null,
});

describe("allocateCharges (legacy Cost.allocate)", () => {
  it("spreads freight + loading over the lines in proportion to their value, then per received bag (the fixture's PUR-1)", () => {
    // 12 bags at 60,000 = 720,000 and 3 bags at 40,000 = 120,000; freight 40,000 + loading 20,000 = 60,000; goods 840,000
    // shares: 60,000 x 720,000 / 840,000 = 51,428.57 -> 51,429; 60,000 x 120,000 / 840,000 = 8,571.43 -> 8,571 (they add up to 60,000)
    // landed: 60,000 + round(51,429 / 12 = 4,285.75) = 64,286;  40,000 + round(8,571 / 3 = 2,857) = 42,857
    expect(allocateCharges([line(12, 12, 60_000, 720_000), line(3, 3, 40_000, 120_000)], 60_000)).toEqual([
      { goodsUnitP: 60_000, chargeShareP: 51_429, landedUnitP: 64_286, basisMilli: 12_000 },
      { goodsUnitP: 40_000, chargeShareP: 8_571, landedUnitP: 42_857, basisMilli: 3_000 },
    ]);
  });

  it("no charges: the landed unit is the goods unit", () => {
    expect(allocateCharges([line(10, 10, 600_000, 6_000_000)], 0)).toEqual([{ goodsUnitP: 600_000, chargeShareP: 0, landedUnitP: 600_000, basisMilli: 10_000 }]);
  });

  it("a fractional quantity: 2.5 bags worth 750,000 is 300,000 a bag", () => {
    expect(allocateCharges([line(2.5, 2.5, 300_000, 750_000)], 0)[0]!.goodsUnitP).toBe(300_000);
  });

  it("FIX 3, part delivery: 100 bags ordered at 1,000 (line 100,000), 60 delivered — the unit cost is the price paid, not price x ordered / received", () => {
    const part = line(100, 60, 1_000, 100_000);
    // legacy Cost.allocate: basis = received || qty = 60, goodsUnit = round(100,000 / 60) = 1,667 (1,666.67): overstated by 100 / 60
    const legacyGoodsUnit = Math.round(part.lineTotalP / (part.receivedQtyMilli / 1000));
    expect(legacyGoodsUnit).toBe(1_667);
    // fixed: the bill is for the 100 ordered bags, so a bag costs 1,000 whatever arrived first
    expect(allocateCharges([part], 0)[0]).toEqual({ goodsUnitP: 1_000, chargeShareP: 0, landedUnitP: 1_000, basisMilli: 60_000 });
    // charges stay per RECEIVED bag: 6,000 over the 60 bags that arrived = 100 a bag (legacy landed would be 1,667 + 100 = 1,767)
    expect(allocateCharges([part], 6_000)[0]).toEqual({ goodsUnitP: 1_000, chargeShareP: 6_000, landedUnitP: 1_100, basisMilli: 60_000 });
  });

  it("a full delivery gives the legacy figure exactly (which is why fix 3 changes no real number)", () => {
    for (const [bags, total] of [[7, 100_000], [3, 100_000], [12.5, 999_999], [1, 1]] as const) {
      const l = line(bags, bags, 0, total);
      expect(allocateCharges([l], 0)[0]!.goodsUnitP).toBe(Math.round(total / bags));
    }
  });

  it("received 0 (an order nothing has arrived for): the charges are spread over the ordered bags, like the legacy `received || qty`", () => {
    // 10 bags ordered, none received, line 100,000, charges 10,000: goods 10,000 a bag; the share 10,000 / 10 = 1,000 a bag
    expect(allocateCharges([line(10, 0, 10_000, 100_000)], 10_000)[0]).toEqual({ goodsUnitP: 10_000, chargeShareP: 10_000, landedUnitP: 11_000, basisMilli: 10_000 });
  });

  it("charges with no value to spread over (every line free) are split evenly; a negative charge counts as none", () => {
    // 2 free lines, 5,001 of charges: round(5,001 / 2) = round(2,500.5) = 2,501 each (JS rounds .5 up, as the legacy did)
    expect(allocateCharges([line(1, 1, 0, 0), line(1, 1, 0, 0)], 5_001).map((a) => a.chargeShareP)).toEqual([2_501, 2_501]);
    expect(allocateCharges([line(1, 1, 5_000, 5_000)], -300)[0]!.chargeShareP).toBe(0);
  });

  it("property: the shares add up to the charges within half a paisa per line; nothing is negative; a full delivery's landed unit is never below its goods unit", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const n = 1 + rnd(5);
      const lines = Array.from({ length: n }, () => {
        const bags = 1 + rnd(200);
        const received = rnd(3) === 0 ? rnd(bags + 1) : bags;
        const total = 1 + rnd(5_000_000);
        return line(bags, received, 0, total);
      });
      const charges = rnd(400_000);
      const out = allocateCharges(lines, charges);
      const shares = out.reduce((a, o) => a + o.chargeShareP, 0);
      expect(Math.abs(shares - charges)).toBeLessThanOrEqual(n / 2);
      for (const o of out) {
        expect(o.goodsUnitP).toBeGreaterThanOrEqual(0);
        expect(o.chargeShareP).toBeGreaterThanOrEqual(0);
        expect(o.landedUnitP).toBeGreaterThanOrEqual(o.goodsUnitP);
      }
    }
  });
});

describe("weightedAverage (legacy Cost.weightedAverage / Landed.weightedAverage)", () => {
  it("LANDED: goods unit + round(charge share / bags) + round(operational share / bags) — the fixture's landed-cost line", () => {
    // 3 bags: goods 40,000; supplier charges 8,571 -> 2,857 a bag; a later landed-cost entry 9,000 -> 3,000 a bag = 45,857
    const l = avgLine({ bags: 3, goodsUnitCostP: 40_000, chargeShareP: 8_571, operationalShareP: 9_000 });
    expect(unitCostForAverage(l, "LANDED")).toBe(45_857);
    expect(weightedAverage([l], "LANDED")).toBe(45_857);
    // the PURCHASE basis ignores every charge
    expect(weightedAverage([l], "PURCHASE")).toBe(40_000);
  });

  it("weights each line by the bags RECEIVED: 12 bags at 64,286 and 8 at 70,000 average 66,572 (1,331,432 / 20 = 66,571.6)", () => {
    const a = avgLine({ bags: 12, goodsUnitCostP: 60_000, chargeShareP: 51_429 });
    const b = avgLine({ bags: 8, goodsUnitCostP: 70_000 });
    expect(weightedAverage([a, b], "LANDED")).toBe(66_572);
    // PURCHASE basis: (60,000 x 12 + 70,000 x 8) / 20 = 64,000
    expect(weightedAverage([a, b], "PURCHASE")).toBe(64_000);
  });

  it("a part delivery weighs by what arrived (60 of 100 ordered), a line that received nothing does not count", () => {
    const part = avgLine({ bags: 100, receivedQtyMilli: 60_000, goodsUnitCostP: 1_000 });
    const nothing = avgLine({ bags: 50, receivedQtyMilli: 0, goodsUnitCostP: 999_999 });
    expect(weightedAverage([part, nothing], "LANDED")).toBe(1_000);
  });

  it("the weights are the bags RECEIVED, not the bags ordered: a part delivery of 60 of 100 at 1,000 and a full 10 at 2,000 average 1,143 (80,000 / 70), not 1,091 (120,000 / 110)", () => {
    const part = avgLine({ bags: 100, receivedQtyMilli: 60_000, goodsUnitCostP: 1_000 });
    const full = avgLine({ bags: 10, goodsUnitCostP: 2_000 });
    expect(weightedAverage([part, full], "PURCHASE")).toBe(1_143);
    expect(weightedAverage([part, full], "LANDED")).toBe(1_143);
  });

  it("no bag received at all: null (\"keep the old average\" is the caller's rule), not 0 and not a made-up cost", () => {
    expect(weightedAverage([], "LANDED")).toBeNull();
    expect(weightedAverage([avgLine({ bags: 5, receivedQtyMilli: 0, goodsUnitCostP: 1_000 })], "PURCHASE")).toBeNull();
  });

  it("a line with no stored goods unit falls back to line total / ordered bags, then to the unit price (the legacy `||` chain, 0 counts as not stored)", () => {
    expect(unitCostForAverage(avgLine({ bags: 4, lineTotalP: 100_001, unitPriceP: 5 }), "PURCHASE")).toBe(25_000); // 25,000.25
    expect(unitCostForAverage(avgLine({ bags: 4, lineTotalP: 100_000, goodsUnitCostP: 0 }), "PURCHASE")).toBe(25_000);
    expect(unitCostForAverage({ ...avgLine({ bags: 1, unitPriceP: 777 }), qtyMilli: 0 }, "PURCHASE")).toBe(777);
  });

  it("property: with no charges and no operational share the LANDED and PURCHASE averages are the plain goods average", () => {
    let seed = 777;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const lines = Array.from({ length: 1 + rnd(6) }, () => avgLine({ bags: 1 + rnd(100), goodsUnitCostP: 1 + rnd(200_000) }));
      let q = 0;
      let v = 0;
      for (const l of lines) {
        q += l.receivedQtyMilli;
        v += l.goodsUnitCostP! * l.receivedQtyMilli;
      }
      const plain = Math.round(v / q);
      expect(weightedAverage(lines, "LANDED")).toBe(plain);
      expect(weightedAverage(lines, "PURCHASE")).toBe(plain);
    }
  });
});

describe("costBasisOf (the profitCostBasis setting)", () => {
  it("is PURCHASE only when the setting says so; missing or anything else is LANDED, the legacy default", () => {
    expect(costBasisOf("PURCHASE")).toBe("PURCHASE");
    expect(costBasisOf("LANDED")).toBe("LANDED");
    expect(costBasisOf(undefined)).toBe("LANDED");
    expect(costBasisOf(null)).toBe("LANDED");
    expect(costBasisOf("purchase")).toBe("LANDED");
  });
});

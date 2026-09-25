import { describe, expect, it } from "vitest";
import { canReadPurchases, visibleNav } from "./access";
import {
  bagsText,
  buildPurchasesQuery,
  DEFAULT_PURCHASE_FILTERS,
  hasActivePurchaseFilters,
  purchaseFiltersFromSearch,
  purchaseFiltersToSearch,
  purchaseHitsText,
} from "./purchase-filters";

const WH = "11111111-2222-4333-8444-555555555555";

describe("the Purchases list's address", () => {
  it("defaults leave the address empty; a hostile address is sanitised", () => {
    expect(purchaseFiltersToSearch(DEFAULT_PURCHASE_FILTERS)).toEqual({});
    expect(purchaseFiltersFromSearch({ pay: "EVERYTHING", warehouse: "<script>", sort: "best", page: "-3", period: "forever" })).toEqual(DEFAULT_PURCHASE_FILTERS);
  });

  it("round-trips every field; from / to only with a custom period", () => {
    const f = purchaseFiltersFromSearch({ q: "zam zam", pay: "PARTIAL", warehouse: WH, category: "چاول", period: "custom", from: "2026-09-01", to: "2026-09-20", sort: "due", page: "2" });
    expect(purchaseFiltersToSearch(f)).toEqual({ q: "zam zam", pay: "PARTIAL", warehouse: WH, category: "چاول", period: "custom", from: "2026-09-01", to: "2026-09-20", sort: "due", page: "2" });
    expect(purchaseFiltersToSearch({ ...f, period: "month" })).not.toHaveProperty("from");
    expect(hasActivePurchaseFilters(f)).toBe(true);
    expect(hasActivePurchaseFilters(DEFAULT_PURCHASE_FILTERS)).toBe(false);
  });
});

describe("filters → GET /purchases", () => {
  it("sends the box exactly as typed, the filters by their API names, paging", () => {
    const f = { ...DEFAULT_PURCHASE_FILTERS, q: "  Zam-Zam 20/09/2026 ", pay: "UNPAID", warehouse: WH, category: "Rice", sort: "high", page: 3 };
    expect(buildPurchasesQuery(f, "2026-09-25")).toEqual({ q: "  Zam-Zam 20/09/2026 ", paymentStatus: "UNPAID", warehouseId: WH, category: "Rice", sort: "high", limit: "50", offset: "100" });
  });
  it("a period preset becomes from / to from the business date; the CSV has no paging", () => {
    const q = buildPurchasesQuery({ ...DEFAULT_PURCHASE_FILTERS, period: "month" }, "2026-09-25", { paging: false });
    expect(q).toEqual({ from: "2026-09-01", to: "2026-09-25" });
  });
});

describe("words on the screen", () => {
  it("bags as the legacy wrote them, and the 'why it matched' line", () => {
    expect(bagsText(1250)).toBe("1,250");
    expect(bagsText(2.5)).toBe("2.5");
    expect(purchaseHitsText({ lines: [{ name: "Zam Zam Atta", quantity: 100 }], more: 2 })).toBe("Zam Zam Atta × 100 · +2 more");
    expect(purchaseHitsText(null)).toBe("");
  });
});

describe("who sees Purchases", () => {
  it("OWNER, MANAGER, ACCOUNTANT do; the warehouse role and Sales do not (kept closed on purpose)", () => {
    for (const r of ["OWNER", "MANAGER", "ACCOUNTANT"] as const) {
      expect(canReadPurchases(r)).toBe(true);
      expect(visibleNav(r).map((n) => n.label)).toContain("Purchases");
    }
    for (const r of ["INVENTORY", "SALES"] as const) {
      expect(canReadPurchases(r)).toBe(false);
      expect(visibleNav(r).map((n) => n.label)).not.toContain("Purchases");
    }
  });
});

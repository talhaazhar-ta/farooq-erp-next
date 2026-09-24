import { describe, expect, it } from "vitest";
import {
  buildInvoiceExportQuery,
  buildInvoicesQuery,
  DEFAULT_INVOICE_FILTERS,
  hasActiveInvoiceFilters,
  hitsText,
  invoiceFiltersFromSearch,
  invoiceFiltersToSearch,
  statusLabel,
  statusTone,
  type InvoiceFilters,
} from "./invoice-filters";
import { describeReadDate } from "./payment-filters";

const f = (patch: Partial<InvoiceFilters> = {}): InvoiceFilters => ({ ...DEFAULT_INVOICE_FILTERS, ...patch });
const WH = "0b6f3c1e-8a52-4a52-9a54-3e3f1b1c9e10";
const RG = "6a1e9c5f-2c67-4c26-bd6c-7f0b1e7f2c11";

describe("the address ↔ the filters", () => {
  it("a clean screen has a clean address, and defaults are left out", () => {
    expect(invoiceFiltersToSearch(f())).toEqual({});
    expect(invoiceFiltersToSearch(f({ q: "sella", sort: "due", status: "PAID", page: 3 }))).toEqual({ q: "sella", sort: "due", status: "PAID", page: "3" });
    expect(invoiceFiltersToSearch(f({ sort: "newest", scope: "all", page: 1 }))).toEqual({});
  });

  it("round-trips every field", () => {
    const filters = f({ q: "taj mahal", scope: "product", status: "PARTIALLY_PAID", region: RG, warehouse: WH, period: "custom", from: "2026-03-01", to: "2026-03-31", min: "1,000", max: "50000", sort: "high", page: 4 });
    expect(invoiceFiltersFromSearch(invoiceFiltersToSearch(filters))).toEqual(filters);
  });

  it("dates are dropped unless the period is custom", () => {
    expect(invoiceFiltersToSearch(f({ period: "week", from: "2026-01-01", to: "2026-01-02" }))).toEqual({ period: "week" });
  });

  it("a hostile or hand-edited address is sanitised, never trusted", () => {
    const got = invoiceFiltersFromSearch({
      scope: "<script>",
      status: "DROP TABLE",
      region: "not-a-uuid",
      warehouse: "'; --",
      period: "nextcentury",
      sort: "random",
      page: "-5",
      q: "x".repeat(500),
      min: "9".repeat(80),
    });
    expect(got.scope).toBe("all");
    expect(got.status).toBe("");
    expect(got.region).toBe("");
    expect(got.warehouse).toBe("");
    expect(got.period).toBe("all");
    expect(got.sort).toBe("newest");
    expect(got.page).toBe(1);
    expect(got.q).toHaveLength(200);
    expect(got.min).toHaveLength(30);
    expect(invoiceFiltersFromSearch({ page: "abc" }).page).toBe(1);
    expect(invoiceFiltersFromSearch({ page: "2" }).page).toBe(2);
    expect(invoiceFiltersFromSearch({ page: 3 }).page).toBe(3); // the router may hand a number
  });

  it("only real filters count as filtering (page and sort do not)", () => {
    expect(hasActiveInvoiceFilters(f())).toBe(false);
    expect(hasActiveInvoiceFilters(f({ sort: "low", page: 5, scope: "product" }))).toBe(false);
    for (const patch of [{ q: " a " }, { status: "PAID" }, { region: RG }, { warehouse: WH }, { period: "today" }, { min: "1" }, { max: "2" }]) {
      expect(hasActiveInvoiceFilters(f(patch))).toBe(true);
    }
    expect(hasActiveInvoiceFilters(f({ q: "   " }))).toBe(false);
  });
});

describe("filters → the API query", () => {
  it("defaults ask for the first page only", () => {
    expect(buildInvoicesQuery(f(), "2026-09-24").params).toEqual({ limit: "50", offset: "0" });
  });

  it("the box goes as typed; scope, status, region, warehouse and sort are passed through", () => {
    const { params } = buildInvoicesQuery(f({ q: "12/09/2026 karim", scope: "payment", status: "CANCELLED", region: RG, warehouse: WH, sort: "due" }), "2026-09-24");
    expect(params).toMatchObject({ q: "12/09/2026 karim", scope: "payment", status: "CANCELLED", regionId: RG, warehouseId: WH, sort: "due" });
  });

  it("the box is sent exactly as typed — the server reads words, letter variants and dates from it, the screen never rewrites it", () => {
    expect(buildInvoicesQuery(f({ q: "Taj  MAHAL 12/09/2026 كريم" }), "2026-09-24").params.q).toBe("Taj  MAHAL 12/09/2026 كريم");
    expect(buildInvoicesQuery(f({ q: "   " }), "2026-09-24").params.q).toBeUndefined();
  });

  it("a preset becomes from / to worked out from the business date (the server has no presets)", () => {
    // 2026-09-24 is a Thursday: this week = Monday 21st .. today
    expect(buildInvoicesQuery(f({ period: "week" }), "2026-09-24").params).toMatchObject({ from: "2026-09-21", to: "2026-09-24" });
    expect(buildInvoicesQuery(f({ period: "today" }), "2026-09-24").params).toMatchObject({ from: "2026-09-24", to: "2026-09-24" });
    expect(buildInvoicesQuery(f({ period: "lastmonth" }), "2026-09-24").params).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(buildInvoicesQuery(f({ period: "last30" }), "2026-09-24").params).toMatchObject({ from: "2026-08-25", to: "2026-09-24" });
    expect(buildInvoicesQuery(f({ period: "all" }), "2026-09-24").params.from).toBeUndefined();
  });

  it("a custom range is sent as typed", () => {
    expect(buildInvoicesQuery(f({ period: "custom", from: "2026-03-01" }), "2026-09-24").params).toMatchObject({ from: "2026-03-01" });
    expect(buildInvoicesQuery(f({ period: "custom", from: "2026-03-01" }), "2026-09-24").params.to).toBeUndefined();
  });

  it("amounts are typed in rupees and sent as integer paisa (parseRupees, never a float)", () => {
    const { params, errors } = buildInvoicesQuery(f({ min: "1,500", max: "20000.50" }), "2026-09-24");
    expect(params.minP).toBe("150000");
    expect(params.maxP).toBe("2000050");
    expect(errors).toEqual({});
  });

  it("a nonsense amount is a field problem and is not sent", () => {
    const { params, errors } = buildInvoicesQuery(f({ min: "abc", max: "1.234" }), "2026-09-24");
    expect(params.minP).toBeUndefined();
    expect(params.maxP).toBeUndefined();
    expect(errors.min).toBeTruthy();
    expect(errors.max).toBeTruthy();
  });

  it("paging: page n asks for offset (n-1)*50", () => {
    expect(buildInvoicesQuery(f({ page: 3 }), "2026-09-24").params).toMatchObject({ limit: "50", offset: "100" });
  });

  it("the CSV asks for every match: the same filters, no paging", () => {
    const filters = f({ q: "sella", status: "PAID", page: 4, min: "100" });
    const paged = buildInvoicesQuery(filters, "2026-09-24").params;
    const exported = buildInvoiceExportQuery(filters, "2026-09-24").params;
    expect(exported.limit).toBeUndefined();
    expect(exported.offset).toBeUndefined();
    const { limit, offset, ...rest } = paged;
    void limit;
    void offset;
    expect(exported).toEqual(rest);
  });
});

describe("how the box was read (the server's `interpreted`)", () => {
  it("says a typed date was read day-first and replaced the date filter", () => {
    const d = { label: "12 Sep 2026", from: "2026-09-12", to: "2026-09-12", src: "12/09/2026", dayFirst: true };
    expect(describeReadDate(d, true)).toBe("“12/09/2026” is read as 12 Sep 2026 (day / month / year) — this replaces the date filter.");
    expect(describeReadDate(d, false)).toBe("“12/09/2026” is read as 12 Sep 2026 (day / month / year).");
  });
});

describe("the 'why it matched' line under the invoice number", () => {
  it("draws product lines, '+n more' and the receipts, as the legacy did", () => {
    expect(hitsText({ lines: [{ name: "Taj Mahal Sella", quantity: 20 }], more: 1, pays: ["REC-2026-000031 (4471)"], morePays: 0 })).toBe(
      "Taj Mahal Sella × 20 · +1 more · Paid by REC-2026-000031 (4471)",
    );
  });
  it("fractional bags, several lines, several receipts", () => {
    expect(hitsText({ lines: [{ name: "A", quantity: 2.5 }, { name: "B", quantity: 1 }], more: 0, pays: ["REC-1", "REC-2"], morePays: 2 })).toBe("A × 2.5 · B × 1 · Paid by REC-1, REC-2 · +2 more receipts");
  });
  it("nothing to explain → nothing drawn", () => {
    expect(hitsText(null)).toBe("");
    expect(hitsText({ lines: [], more: 0, pays: [], morePays: 0 })).toBe("");
  });
});

describe("status words and colours", () => {
  it("uses the legacy words", () => {
    expect(statusLabel("PARTIALLY_PAID")).toBe("Partly paid");
    expect(statusLabel("PARTIALLY_RETURNED")).toBe("Partly returned");
    expect(statusLabel("DRAFT")).toBe("Draft");
    expect(statusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
  it("paid is green, cancelled red, part-anything amber", () => {
    expect(statusTone("PAID")).toBe("ok");
    expect(statusTone("CANCELLED")).toBe("danger");
    expect(statusTone("PARTIALLY_PAID")).toBe("warn");
    expect(statusTone("CONFIRMED")).toBe("neutral");
  });
});

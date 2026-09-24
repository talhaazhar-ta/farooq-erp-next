import { describe, expect, it } from "vitest";
import {
  buildExportQuery,
  buildPaymentsQuery,
  DEFAULT_FILTERS,
  describeReadDate,
  filtersFromSearch,
  filtersToSearch,
  hasActiveFilters,
  PAGE_SIZE,
} from "./payment-filters";

const TODAY = "2026-09-24"; // a Thursday

describe("URL state ↔ filters", () => {
  it("a clean screen has a clean address", () => {
    expect(filtersToSearch(DEFAULT_FILTERS)).toEqual({});
    expect(filtersFromSearch({})).toEqual(DEFAULT_FILTERS);
  });

  it("round-trips a busy screen", () => {
    const f = {
      ...DEFAULT_FILTERS,
      q: "karim 12/09/2026",
      scope: "party",
      tab: "received" as const,
      method: "Cash",
      region: "8b3c6f0e-0000-4000-8000-000000000001",
      period: "custom",
      from: "2026-01-01",
      to: "2026-02-01",
      min: "1,000",
      max: "5000",
      sort: "high",
      page: 3,
    };
    const search = filtersToSearch(f);
    expect(search).toMatchObject({ q: "karim 12/09/2026", scope: "party", tab: "received", sort: "high", page: "3", period: "custom" });
    expect(filtersFromSearch(search)).toEqual(f);
  });

  it("drops from / to when the period is not custom", () => {
    expect(filtersToSearch({ ...DEFAULT_FILTERS, period: "today", from: "2026-01-01", to: "2026-01-02" })).toEqual({ period: "today" });
  });

  it("a hand-edited or hostile address never breaks the screen", () => {
    const f = filtersFromSearch({ tab: "nonsense", scope: "x", sort: "y", period: "later", page: "-4", panel: "explode", q: "a".repeat(500) });
    expect(f.tab).toBe("all");
    expect(f.scope).toBe("all");
    expect(f.sort).toBe("newest");
    expect(f.period).toBe("all");
    expect(f.page).toBe(1);
    expect(f.panel).toBe("");
    expect(f.q).toHaveLength(200);
    expect(filtersFromSearch({ page: "2abc" }).page).toBe(2);
    expect(filtersFromSearch({ page: "NaN" }).page).toBe(1);
  });

  it("numbers that the router might parse as numbers still read as text", () => {
    expect(filtersFromSearch({ q: 123, min: 500 }).q).toBe("123");
    expect(filtersFromSearch({ q: 123, min: 500 }).min).toBe("500");
  });

  it("what counts as a filter (drives Clear filters); the open panel and the sort do not", () => {
    expect(hasActiveFilters(DEFAULT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, panel: "receive", sort: "high", page: 4 })).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_FILTERS, q: "  " })).toBe(false);
    for (const patch of [{ q: "x" }, { tab: "reversed" as const }, { method: "Cash" }, { region: "r" }, { period: "today" }, { min: "1" }, { max: "1" }]) {
      expect(hasActiveFilters({ ...DEFAULT_FILTERS, ...patch })).toBe(true);
    }
  });
});

describe("filters → API query", () => {
  it("sends the raw box as q (the server reads dates and words) and pages by 50", () => {
    const { params } = buildPaymentsQuery({ ...DEFAULT_FILTERS, q: "12/09/2026 karim", page: 3 }, TODAY);
    expect(params.q).toBe("12/09/2026 karim");
    expect(params.limit).toBe(String(PAGE_SIZE));
    expect(params.offset).toBe(String(2 * PAGE_SIZE));
  });

  it("every tab says status, so its count and its rows are the same set", () => {
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, tab: "all" }, TODAY).params).toMatchObject({ status: "POSTED" });
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, tab: "all" }, TODAY).params.direction).toBeUndefined();
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, tab: "paidToShops" }, TODAY).params).toMatchObject({ status: "POSTED", direction: "paidToShops" });
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, tab: "reversed" }, TODAY).params).toMatchObject({ status: "REVERSED" });
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, tab: "reversed" }, TODAY).params.direction).toBeUndefined();
  });

  it("amounts become integer paisa via parseRupees (Urdu digits, commas, paisa)", () => {
    const { params, errors } = buildPaymentsQuery({ ...DEFAULT_FILTERS, min: "1,500.50", max: "۲۰۰۰" }, TODAY);
    expect(params.minP).toBe("150050");
    expect(params.maxP).toBe("200000");
    expect(errors).toEqual({});
  });

  it("a bad amount is reported per field and not sent", () => {
    const { params, errors } = buildPaymentsQuery({ ...DEFAULT_FILTERS, min: "12.345", max: "abc" }, TODAY);
    expect(errors.min).toMatch(/2 decimal/);
    expect(errors.max).toBeTruthy();
    expect(params.minP).toBeUndefined();
    expect(params.maxP).toBeUndefined();
  });

  it("period presets become from / to from the business date; custom passes the typed dates", () => {
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, period: "today" }, TODAY).params).toMatchObject({ from: TODAY, to: TODAY });
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, period: "last30" }, TODAY).params).toMatchObject({ from: "2026-08-25", to: TODAY });
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, period: "custom", from: "2026-03-01", to: "2026-03-31" }, TODAY).params).toMatchObject({ from: "2026-03-01", to: "2026-03-31" });
    expect(buildPaymentsQuery({ ...DEFAULT_FILTERS, period: "all" }, TODAY).params.from).toBeUndefined();
  });

  it("the CSV export is the same filters with no paging", () => {
    const f = { ...DEFAULT_FILTERS, q: "noor", method: "Cash", tab: "received" as const, page: 4 };
    const list = buildPaymentsQuery(f, TODAY).params;
    const csv = buildExportQuery(f, TODAY).params;
    expect(csv.limit).toBeUndefined();
    expect(csv.offset).toBeUndefined();
    const rest = { ...list };
    delete rest.limit;
    delete rest.offset;
    expect(csv).toEqual(rest);
  });

  it("region and method map to the API names", () => {
    const { params } = buildPaymentsQuery({ ...DEFAULT_FILTERS, region: "rid", method: "Cheque", scope: "invoice", sort: "low" }, TODAY);
    expect(params).toMatchObject({ regionId: "rid", method: "Cheque", scope: "invoice", sort: "low" });
  });
});

describe("how the box was read", () => {
  const d = { label: "12 Sep 2026", from: "2026-09-12", to: "2026-09-12", src: "12/09/2026", dayFirst: true };
  it("says the reading in the legacy words", () => {
    expect(describeReadDate(d, false)).toBe("“12/09/2026” is read as 12 Sep 2026 (day / month / year).");
  });
  it("says when it replaced the date filter, and 'all of' for a month", () => {
    expect(describeReadDate({ ...d, label: "Sep 2026", from: "2026-09-01", to: "2026-09-30", src: "Sep 2026", dayFirst: false }, true)).toBe(
      "“Sep 2026” is read as all of Sep 2026 — this replaces the date filter.",
    );
  });
});

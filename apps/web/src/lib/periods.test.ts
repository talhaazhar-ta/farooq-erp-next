import { describe, expect, it } from "vitest";
import { addDays, periodRange } from "./periods";

describe("addDays (calendar arithmetic, no time zones)", () => {
  it("crosses month and year ends", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2024-03-01", -1)).toBe("2024-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26"); // a day some zones have 25 h — a calendar has none
  });
});

describe("periodRange (legacy ERP.Reports.range + module 33 presets)", () => {
  const T = "2026-09-24"; // Thursday
  it("today / yesterday", () => {
    expect(periodRange("today", T)).toEqual([T, T]);
    expect(periodRange("yesterday", T)).toEqual(["2026-09-23", "2026-09-23"]);
    expect(periodRange("yesterday", "2026-03-01")).toEqual(["2026-02-28", "2026-02-28"]);
  });
  it("this week runs Monday to today", () => {
    expect(periodRange("week", T)).toEqual(["2026-09-21", T]); // Thu → Mon
    expect(periodRange("week", "2026-09-21")).toEqual(["2026-09-21", "2026-09-21"]); // Monday
    expect(periodRange("week", "2026-09-27")).toEqual(["2026-09-21", "2026-09-27"]); // Sunday belongs to the week that began Monday
    expect(periodRange("week", "2026-01-01")).toEqual(["2025-12-29", "2026-01-01"]); // across the year
  });
  it("this month / last month, incl. February and January", () => {
    expect(periodRange("month", T)).toEqual(["2026-09-01", T]);
    expect(periodRange("lastmonth", T)).toEqual(["2026-08-01", "2026-08-31"]);
    expect(periodRange("lastmonth", "2026-03-15")).toEqual(["2026-02-01", "2026-02-28"]);
    expect(periodRange("lastmonth", "2024-03-15")).toEqual(["2024-02-01", "2024-02-29"]);
    expect(periodRange("lastmonth", "2026-01-10")).toEqual(["2025-12-01", "2025-12-31"]);
    expect(periodRange("lastmonth", "2026-10-31")).toEqual(["2026-09-01", "2026-09-30"]); // the legacy bug: "Jul 31 – Aug 30"
  });
  it("last 30 days, 3 months (90 days), this year, last 12 months (365 days)", () => {
    expect(periodRange("last30", T)).toEqual(["2026-08-25", T]);
    expect(periodRange("last90", T)).toEqual(["2026-06-26", T]);
    expect(periodRange("year", T)).toEqual(["2026-01-01", T]);
    expect(periodRange("lastyear", T)).toEqual(["2025-09-24", T]);
  });
  it("all / custom / unknown have no range of their own", () => {
    expect(periodRange("all", T)).toEqual([null, null]);
    expect(periodRange("custom", T)).toEqual([null, null]);
    expect(periodRange("nonsense", T)).toEqual([null, null]);
  });
});

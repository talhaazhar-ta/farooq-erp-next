import { describe, expect, it } from "vitest";
import { formatBusinessDate, parseSearchQuery } from "./search-query.js";

/** Ported from the legacy test-invoice-search.mjs (D1-D19) and test-payment-search.mjs (D1-D5). */
const dates = (q: string) => parseSearchQuery(q).dates.map((d) => [d.from, d.to]);

describe("parseSearchQuery — dates typed into the box (legacy `parse`)", () => {
  it("D1 05/03/2025 is day-first: 5 March, not 3 May", () => {
    expect(dates("05/03/2025")).toEqual([["2025-03-05", "2025-03-05"]]);
    expect(parseSearchQuery("05/03/2025").dates[0]).toMatchObject({ dayFirst: true, label: "05 Mar 2025", src: "05/03/2025" });
  });
  it("D2 2025-05-03 (ISO) is 3 May; slashes and dots work too", () => {
    expect(dates("2025-05-03")).toEqual([["2025-05-03", "2025-05-03"]]);
    expect(dates("2025/05/03")).toEqual([["2025-05-03", "2025-05-03"]]);
    expect(dates("2025.05.03")).toEqual([["2025-05-03", "2025-05-03"]]);
  });
  it("D3-D5 written days: '5 Mar 2025', '5th March, 2025', 'Mar 5 2025', 'Sep 12, 2026'", () => {
    expect(dates("5 Mar 2025")).toEqual([["2025-03-05", "2025-03-05"]]);
    expect(dates("5th March, 2025")).toEqual([["2025-03-05", "2025-03-05"]]);
    expect(dates("Mar 5 2025")).toEqual([["2025-03-05", "2025-03-05"]]);
    expect(dates("Sep 12, 2026")).toEqual([["2026-09-12", "2026-09-12"]]);
    expect(dates("12 September 2026")).toEqual([["2026-09-12", "2026-09-12"]]);
  });
  it("D6-D9 a month and year is the whole month: 'March 2025', '2026 Sep', '05/2025', '2024-12'", () => {
    expect(dates("March 2025")).toEqual([["2025-03-01", "2025-03-31"]]);
    expect(dates("2026 Sep")).toEqual([["2026-09-01", "2026-09-30"]]);
    expect(dates("05/2025")).toEqual([["2025-05-01", "2025-05-31"]]);
    expect(dates("2024-12")).toEqual([["2024-12-01", "2024-12-31"]]);
    expect(parseSearchQuery("Aug 2026").dates[0]!.label).toBe("Aug 2026");
  });
  it("February respects leap years", () => {
    expect(dates("Feb 2024")).toEqual([["2024-02-01", "2024-02-29"]]);
    expect(dates("Feb 2025")).toEqual([["2025-02-01", "2025-02-28"]]);
    expect(dates("29/02/2024")).toEqual([["2024-02-29", "2024-02-29"]]);
    expect(dates("29/02/2025")).toEqual([]);
    expect(dates("Feb 2100")).toEqual([["2100-02-01", "2100-02-28"]]); // 2100 is not a leap year
  });
  it("D10 a date plus a word: the date is a filter, the word stays a term", () => {
    const p = parseSearchQuery("05/03/2025 Zam Zam");
    expect(p.dates).toHaveLength(1);
    expect(p.terms).toEqual(["zam", "zam"]);
  });
  it("D12 a month name alone is still text", () => {
    const p = parseSearchQuery("march");
    expect(p.dates).toEqual([]);
    expect(p.terms).toEqual(["march"]);
  });
  it("D13/D14 a date that does not exist stays text and is not reported as a date", () => {
    const p = parseSearchQuery("31/02/2025");
    expect(p.dates).toEqual([]);
    expect(p.terms).toEqual(["31 02 2025"]);
  });
  it("D16/D17 the tail of a document number is not mistaken for a month", () => {
    for (const q of ["INV-2026-12", "REC-2026-09", "PV-2026-1"]) expect(parseSearchQuery(q).dates).toEqual([]);
    expect(parseSearchQuery("INV-2026-12").terms).toEqual(["inv 2026 12"]);
  });
  it("month-first only when day-first is impossible: 03/25/2025 is 25 March, 03/09/2026 is 3 September", () => {
    expect(parseSearchQuery("03/25/2025").dates[0]).toMatchObject({ from: "2025-03-25", dayFirst: false });
    expect(dates("03/09/2026")).toEqual([["2026-09-03", "2026-09-03"]]);
  });
  it("two-digit years are 20xx", () => {
    expect(dates("12-09-26")).toEqual([["2026-09-12", "2026-09-12"]]);
  });
  it("the year range is 1990-2100", () => {
    expect(dates("01/01/1989")).toEqual([]);
    expect(dates("01/01/1990")).toEqual([["1990-01-01", "1990-01-01"]]);
    expect(dates("01/01/2100")).toEqual([["2100-01-01", "2100-01-01"]]);
    expect(dates("01/01/2101")).toEqual([]);
  });
  it("D18/D19 Arabic-Indic and Persian digits are read as digits", () => {
    expect(dates("٠٥/٠٣/٢٠٢٥")).toEqual([["2025-03-05", "2025-03-05"]]);
    expect(parseSearchQuery("۰۵/۰۳/۲۰۲۵").dates[0]!.label).toBe("05 Mar 2025");
  });
  it("two dates in the box give two ranges, in the order the passes find them (ISO first, then day-first)", () => {
    expect(dates("05/03/2025 2026-09-12")).toEqual([
      ["2026-09-12", "2026-09-12"],
      ["2025-03-05", "2025-03-05"],
    ]);
  });
  it("words are folded, split on whitespace, and empty input gives nothing", () => {
    expect(parseSearchQuery("  CHQ-84711   Ali ").terms).toEqual(["chq 84711", "ali"]);
    expect(parseSearchQuery("").terms).toEqual([]);
    expect(parseSearchQuery(null)).toEqual({ terms: [], dates: [] });
  });
});

describe("formatBusinessDate", () => {
  it("prints DD Mon YYYY without going through Date", () => {
    expect(formatBusinessDate("2026-09-01")).toBe("01 Sep 2026");
    expect(formatBusinessDate("not a date")).toBe("not a date");
  });
});

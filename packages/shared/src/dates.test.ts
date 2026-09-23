import { describe, expect, it } from "vitest";
import { businessDateOf, isValidBusinessDate } from "./dates.js";

describe("businessDateOf — the business day is the Asia/Karachi (UTC+5) day, never the UTC day", () => {
  it("2026-01-01T20:00:00Z is already 2026-01-02 in Karachi (01:00 local)", () => {
    expect(businessDateOf(new Date("2026-01-01T20:00:00Z"))).toBe("2026-01-02");
  });
  it("2026-01-01T18:59:59Z is still 2026-01-01 (23:59:59 local); one second later it is the 2nd", () => {
    expect(businessDateOf(new Date("2026-01-01T18:59:59Z"))).toBe("2026-01-01");
    expect(businessDateOf(new Date("2026-01-01T19:00:00Z"))).toBe("2026-01-02");
  });
  it("crosses a year boundary correctly", () => {
    expect(businessDateOf(new Date("2026-12-31T19:30:00Z"))).toBe("2027-01-01");
  });
  it("the trap it avoids: toISOString() would say yesterday between 00:00 and 05:00 local", () => {
    const instant = new Date("2026-03-10T21:00:00Z"); // 02:00 on the 11th in Karachi
    expect(instant.toISOString().slice(0, 10)).toBe("2026-03-10");
    expect(businessDateOf(instant)).toBe("2026-03-11");
  });
});

describe("isValidBusinessDate", () => {
  it.each(["2026-01-01", "2026-02-28", "2028-02-29", "2100-12-31"])("accepts %s", (d) => {
    expect(isValidBusinessDate(d)).toBe(true);
  });
  it.each(["2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-04-31", "26-01-01", "2026-1-1", "2026/01/01", "", "1999-12-31", "2101-01-01", "2026-01-01T00:00:00Z"])(
    "rejects %s",
    (d) => {
      expect(isValidBusinessDate(d)).toBe(false);
    },
  );
});

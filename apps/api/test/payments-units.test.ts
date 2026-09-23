import { describe, expect, it } from "vitest";
import { byOldestFirst, invoiceStatusFor, type OutstandingRow } from "../src/payments/outstanding.js";
import { formatNumber } from "../src/payments/numbering.js";
import { BusinessRuleError, parseOrRefuse } from "../src/payments/errors.js";
import { receivePaymentSchema } from "@farooq/shared";

/** Pure functions, checked against hand-worked cases from the legacy `Calc.paymentStatus` / `autoAllocate` / `FDB.nextNumber`. */

describe("invoiceStatusFor — Calc.paymentStatus mapped onto the invoice status by refreshPaymentState", () => {
  it.each([
    // [grand, paid, status]
    [1_000_000, 0, "CONFIRMED"], // nothing paid
    [1_000_000, 1, "PARTIALLY_PAID"],
    [1_000_000, 999_999, "PARTIALLY_PAID"],
    [1_000_000, 1_000_000, "PAID"], // paid >= grand
    [1_000_000, 1_500_000, "PAID"], // overpaid still PAID
    [0, 0, "CONFIRMED"], // grand <= 0 -> UNPAID whatever was paid
    [0, 500, "CONFIRMED"],
    [-100, 0, "CONFIRMED"],
  ])("total %i paid %i -> %s", (total, paid, expected) => {
    expect(invoiceStatusFor(total, paid)).toBe(expected);
  });
});

describe("byOldestFirst — the allocation order, ties pinned down", () => {
  const row = (o: Partial<OutstandingRow> & { id: string }): OutstandingRow => ({
    number: null, date: "2026-02-01", status: "CONFIRMED", createdAt: new Date("2026-02-01T05:00:00Z"), totalP: 1, paidP: 0, creditP: 0, outstandingP: 1, ...o,
  });
  const order = (rows: OutstandingRow[]) => [...rows].sort(byOldestFirst).map((r) => r.id);

  it("business date first", () => {
    expect(order([row({ id: "b", date: "2026-02-02" }), row({ id: "a", date: "2026-02-01" })])).toEqual(["a", "b"]);
  });
  it("then created_at", () => {
    expect(order([row({ id: "late", createdAt: new Date("2026-02-01T09:00:00Z") }), row({ id: "early" })])).toEqual(["early", "late"]);
  });
  it("then invoice number, then id (fully deterministic)", () => {
    expect(order([row({ id: "x", number: "INV-2" }), row({ id: "y", number: "INV-1" })])).toEqual(["y", "x"]);
    expect(order([row({ id: "b" }), row({ id: "a" })])).toEqual(["a", "b"]);
  });
});

describe("formatNumber — KIND-YYYY-<6 digits>", () => {
  it("pads to six digits and never truncates", () => {
    expect(formatNumber("REC", 2026, 1)).toBe("REC-2026-000001");
    expect(formatNumber("PV", 2026, 42)).toBe("PV-2026-000042");
    expect(formatNumber("REC", 2027, 1_234_567)).toBe("REC-2027-1234567");
  });
});

describe("parseOrRefuse", () => {
  it("turns a Zod failure into a 422 BusinessRuleError listing each distinct message once", () => {
    try {
      parseOrRefuse(receivePaymentSchema, { customerId: "x", amountP: "y" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BusinessRuleError);
      expect((e as BusinessRuleError).getStatus()).toBe(422);
      expect((e as BusinessRuleError).errors).toEqual(["Choose a shop.", "Enter an amount greater than zero."]);
    }
  });
});

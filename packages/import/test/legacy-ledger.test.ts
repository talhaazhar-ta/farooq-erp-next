import { describe, expect, it } from "vitest";
import { createLegacyLedger } from "../src/index.js";
import { fixture } from "./helpers.js";

/**
 * Expected numbers are worked out BY HAND from fixtures/build-fixture.ts (see the header comment there),
 * never derived from the importer or the new ledger.
 */
const ledger = createLegacyLedger(fixture().data);

describe("LegacyLedger — closing balances (hand-computed from the fixture)", () => {
  it.each([
    // C1: opening +500,000; invoices +1,000,000 +500,000 (DRAFT 999,999 and CANCELLED 888,888 skipped);
    //     payment -700,000 (REVERSED 200,000 skipped); invoice +600,000; return -60,000; refund +60,000
    ["cust-1", 1_900_000],
    ["cust-2", 100_000], // opening -200,000 + invoice 300,000
    ["cust-3", 470_000], // 750,000 - 250,000 payment - 30,000 DRAFT return (drafts count!)
    ["cust-4", 15_000], // adjustments: +25,000 DEBIT -10,000 CREDIT; the REVERSED 99,000 is skipped
    ["cust-5", 450_000], // 400,000 + 100,000 refund - 50,000 return (CANCELLED 40,000 skipped)
    ["cust-6", 0], // no activity; the paper-book figures are NOT posted
  ])("customer %s owes %i paisa", (id, expected) => {
    expect(ledger.customer(id).closing).toBe(expected);
  });

  it.each([
    ["sup-1", 870_000], // opening 300,000 + purchase 900,000 - payment 250,000 - return 80,000
    ["sup-2", 390_000], // DRAFT purchase 400,000 counts; CANCELLED 300,000, REVERSED 50,000 payment and CANCELLED return skipped; DRAFT return -10,000 counts
    ["sup-3", -40_000], // negative opening: the supplier owes us
    ["sup-4", 92_000], // 100,000 purchase; job 1: -500,000 issued +450,000 received +30,000 fee; job 2 (FEE_ONLY): +12,000 (its 111,000 issued value is ignored); CANCELLED job skipped
    ["sup-5", 0],
  ])("we owe supplier %s %i paisa", (id, expected) => {
    expect(ledger.supplier(id).closing).toBe(expected);
  });

  it("counts the paper-book parties it deliberately does not post", () => {
    expect(ledger.paperBookParties()).toEqual({ customers: 1, suppliers: 1 });
  });
});

describe("LegacyLedger — statements", () => {
  it("customer statement: opening first, same-day rows by createdAt, refund rows (no createdAt) before same-day returns", () => {
    const rows = ledger.customer("cust-1").rows.map((r) => [r.iso, r.kind, r.ref, r.dr, r.cr, r.balance]);
    expect(rows).toEqual([
      ["2026-01-01", "OPENING", "OPENING", 500_000, 0, 500_000],
      ["2026-02-01", "INVOICE", "INV-2026-000001", 1_000_000, 0, 1_500_000],
      ["2026-02-01", "INVOICE", "INV-2026-000002", 500_000, 0, 2_000_000],
      ["2026-02-05", "PAYMENT", "REC-2026-000001", 0, 700_000, 1_300_000],
      ["2026-02-15", "INVOICE", "INV-2026-000007", 600_000, 0, 1_900_000],
      // quirk: the refund row has no createdAt, so it sorts BEFORE the return created earlier the same day
      ["2026-02-16", "REFUND", "PV-2026-000004", 60_000, 0, 1_960_000],
      ["2026-02-16", "RETURN", "CR-2026-000001", 0, 60_000, 1_900_000],
    ]);
  });

  it("a dated opening balance still leads a customer statement (16-khata.js sorts OPENING first)", () => {
    const first = ledger.customer("cust-2").rows[0]!;
    expect([first.kind, first.iso, first.dr, first.cr]).toEqual(["OPENING", "2000-01-01", -200_000, 0]);
  });

  it("supplier statement: a payment (no createdAt) sorts before a purchase created earlier the same day", () => {
    const rows = ledger.supplier("sup-1").rows.map((r) => [r.iso, r.kind, r.ref, r.balance]);
    expect(rows).toEqual([
      ["2026-01-05", "OPENING", "OPENING", 300_000],
      ["2026-02-20", "PAYMENT", "PV-2026-000002", 50_000],
      ["2026-02-20", "PURCHASE", "PUR-2026-000001", 950_000],
      ["2026-02-21", "RETURN", "SR-2026-000001", 870_000],
    ]);
  });

  it("mill statement: a job's three rows keep issue -> received -> fee order; FEE_ONLY posts the fee only", () => {
    const rows = ledger.supplier("sup-4").rows.map((r) => [r.iso, r.kind, r.ref, r.balance]);
    expect(rows).toEqual([
      ["2026-02-25", "PURCHASE", "PUR-2026-000004", 100_000],
      ["2026-02-26", "MILLING", "MIL-2026-000001", -400_000],
      ["2026-02-26", "MILLING", "MIL-2026-000001", 50_000],
      ["2026-02-26", "MILLING", "MIL-2026-000001", 80_000],
      ["2026-02-27", "MILLING", "MIL-2026-000002", 92_000],
    ]);
  });

  it("a period statement: opening = everything before the period, rows after it are left out", () => {
    const L = ledger.customer("cust-1", "2026-02-05", "2026-02-15");
    expect({ opening: L.opening, closing: L.closing, debit: L.debit, credit: L.credit, rows: L.rows.length }).toEqual({
      opening: 2_000_000, // opening 500,000 + 1,000,000 + 500,000
      closing: 1_900_000,
      debit: 600_000, // the 2026-02-15 invoice
      credit: 700_000, // the 2026-02-05 payment
      rows: 2,
    });
  });
});

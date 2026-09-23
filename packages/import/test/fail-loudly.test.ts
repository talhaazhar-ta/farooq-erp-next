import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImportError, runImport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";


/**
 * The importer never guesses and never silently drops: each of these aborts naming the store/field, and
 * leaves the database exactly as the previous good import left it (nothing written, nothing wiped).
 */
const sql = adminSql();

async function snapshot() {
  const [r] = await sql`
    SELECT (SELECT count(*) FROM customers)::int AS customers, (SELECT count(*) FROM invoices)::int AS invoices,
           (SELECT count(*) FROM payments)::int AS payments, (SELECT count(*) FROM journal_entries)::int AS entries,
           (SELECT count(*) FROM journal_lines)::int AS lines, (SELECT count(*) FROM sequences)::int AS sequences,
           (SELECT count(*) FROM audit_log WHERE action = 'IMPORT')::int AS imports`;
  return { ...r };
}

let before: Awaited<ReturnType<typeof snapshot>>;
beforeAll(async () => {
  await runImport(fixture(), IMPORT_OPTS);
  before = await snapshot();
  expect(before.customers).toBe(6); // a populated database, so "unchanged" is meaningful
});
afterAll(async () => {
  await sql.end();
});

const cases: [name: string, backup: () => unknown, message: RegExp][] = [
  ["an unknown store", () => mutate((b) => { b.data.gadgets = [{ id: "g1" }]; }), /Unknown store 'gadgets'/],
  ["an unclassified field on an imported store", () => mutate((b) => { b.data.customers[0].mysteryField = 1; }), /Store 'customers' has an unclassified field 'mysteryField'/],
  ["an unclassified field on payments", () => mutate((b) => { b.data.payments[0].surprise = true; }), /Store 'payments' has an unclassified field 'surprise'/],
  ["a non-integer money field", () => mutate((b) => { b.data.invoices[0].grandTotal = 1000.5; }), /invoices\[id=inv-1\]\.grandTotal: money must be an integer number of paisa, got 1000\.5/],
  ["a money field that is a string", () => mutate((b) => { b.data.payments[0].amount = "700000"; }), /payments\[id=pay-1\]\.amount: money must be a finite number/],
  ["a money field that is missing", () => mutate((b) => { delete b.data.purchases[0].grandTotal; }), /purchases\[id=pur-1\]\.grandTotal: money field is missing/],
  ["a negative payment amount", () => mutate((b) => { b.data.payments[0].amount = -5; }), /payments\[id=pay-1\]\.amount: money must not be negative/],
  ["a non-integer opening balance", () => mutate((b) => { b.data.customers[0].openingBalanceP = 0.5; }), /customers\[id=cust-1\]\.openingBalanceP: money must be an integer/],
  ["an invoice for a customer that doesn't exist", () => mutate((b) => { b.data.invoices[0].customerId = "ghost"; }), /invoices\[id=inv-1\]\.customerId: dangling reference — no customer with id ghost/],
  ["a payment to a supplier that doesn't exist", () => mutate((b) => { b.data.payments[3].partyId = "ghost"; }), /payments\[id=pay-4\]\.partyId: dangling reference — no supplier with id ghost/],
  ["an allocation to an invoice that doesn't exist", () => mutate((b) => { b.data.paymentAllocations[0].invoiceId = "ghost"; }), /paymentAllocations\[id=al-1\]\.invoiceId: dangling reference/],
  ["a milling job for a mill that doesn't exist", () => mutate((b) => { b.data.millingJobs[0].millId = "ghost"; }), /millingJobs\[id=mil-1\]\.millId: dangling reference/],
  ["a customer with a region that doesn't exist", () => mutate((b) => { b.data.customers[0].region = "rg-ghost"; }), /customers\[id=cust-1\]\.region: dangling reference/],
  ["a duplicate legacy id", () => mutate((b) => { b.data.customers.push({ ...b.data.customers[0] }); }), /Duplicate legacy id in 'customers': cust-1/],
  ["a duplicate receipt number", () => mutate((b) => { b.data.payments[1].receiptNumber = b.data.payments[0].receiptNumber; }), /Duplicate receipt number in 'payments': REC-2026-000001/],
  ["an unknown invoice status", () => mutate((b) => { b.data.invoices[0].status = "WEIRD"; }), /invoices\[id=inv-1\]\.status: unknown value "WEIRD"/],
  ["an unknown payment direction", () => mutate((b) => { b.data.payments[0].direction = "SIDEWAYS"; }), /payments\[id=pay-1\]\.direction: unknown value "SIDEWAYS"/],
  ["an unknown payment partyType", () => mutate((b) => { b.data.payments[0].partyType = "STAFF"; }), /payments\[id=pay-1\]\.partyType: unknown value "STAFF"/],
  ["an unknown return status", () => mutate((b) => { b.data.customerReturns[0].status = "MAYBE"; }), /customerReturns\[id=cr-1\]\.status: unknown value "MAYBE"/],
  ["an unknown return treatment", () => mutate((b) => { b.data.customerReturns[0].treatment = "BARTER"; }), /customerReturns\[id=cr-1\]\.treatment: unknown value "BARTER"/],
  ["a payment IN from a supplier (legacy filters disagree on it)", () => mutate((b) => { b.data.payments[0].partyType = "SUPPLIER"; b.data.payments[0].partyId = "sup-1"; }), /payments\[id=pay-1\]: direction IN with partyType SUPPLIER/],
  ["an allocation with both an invoice and a purchase", () => mutate((b) => { b.data.paymentAllocations[0].purchaseId = "pur-1"; }), /paymentAllocations\[id=al-1\]: exactly one of invoiceId \/ purchaseId/],
  ["an impossible calendar date", () => mutate((b) => { b.data.invoices[0].invoiceDate = "2026-02-30"; }), /invoices\[id=inv-1\]\.invoiceDate: not a real calendar date: 2026-02-30/],
  ["a date in the wrong shape", () => mutate((b) => { b.data.payments[0].paymentDate = "05/02/2026"; }), /payments\[id=pay-1\]\.paymentDate: expected a YYYY-MM-DD date/],
  ["a sequence whose key disagrees with kind/year", () => mutate((b) => { b.data.sequences[0].k = "INV:1999"; }), /sequences\[id=INV:1999\].*does not match INV:2026/],
  ["a duplicate sequence", () => mutate((b) => { b.data.sequences.push({ ...b.data.sequences[0] }); }), /Duplicate sequence INV:2026/],
  ["declared counts that disagree with the file", () => mutate((b) => { b.counts.invoices = 99; }, { recount: false }), /Store 'invoices': backup counts says 99 but the file holds 8 documents/],
  ["a file that is not a backup", () => ({ hello: "world" }), /Unexpected backup format/],
  ["an unsupported formatVersion", () => mutate((b) => { b.formatVersion = 2; }), /Unsupported backup formatVersion 2/],
];

describe("fail loudly — aborts naming the store/field and leaves the database untouched", () => {
  it.each(cases)("%s", async (_name, backup, message) => {
    const attempt = runImport(backup(), IMPORT_OPTS);
    await expect(attempt).rejects.toBeInstanceOf(ImportError);
    await expect(attempt).rejects.toThrow(message);
    expect(await snapshot()).toEqual(before);
  });

  it("rolls back everything — including the wipe — if anything fails after loading has started", async () => {
    await expect(
      runImport(fixture(), {
        ...IMPORT_OPTS,
        afterLoad: () => {
          throw new Error("simulated failure just before commit");
        },
      }),
    ).rejects.toThrow("simulated failure just before commit");
    expect(await snapshot()).toEqual(before);
  });

  it("a good import after failed ones still works and replaces cleanly", async () => {
    const result = await runImport(fixture(), IMPORT_OPTS);
    expect(result.journalEntries).toBe(35);
    const after = await snapshot();
    expect({ ...after, imports: before.imports }).toEqual(before); // same data; only the audit row count moved
  });
});

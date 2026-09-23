import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLegacyLedger, reconcile, runImport, uuidV5, type Backup, type ReconciliationReport } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { BusinessRuleError } from "../src/payments/errors.js";
import { createHarness, customerBalanceSql, supplierBalanceSql, trialBalance, type Harness, type Session } from "./helpers/harness.js";

/**
 * THE LEDGER BRIDGE — the test that ties S3 to the reconciliation (CLAUDE.md rule 8).
 *
 * 1. Import the synthetic fixture (S2's proof): every shop and supplier reconciles to the paisa.
 * 2. Run a scripted sequence of PaymentsService operations against that imported database.
 * 3. Apply THE SAME operations, by hand, to the fixture's legacy-shaped JSON — writing the documents the way the
 *    legacy `Payments` code would have written them (a payment doc, allocation docs, a reversal that deletes the
 *    voucher's allocation docs and refreshes the invoice, an in-place amount edit).
 * 4. Compare, for EVERY party, the old algorithm's balance (`LegacyLedger`, no database) with the new journal's,
 *    both against balances worked out on paper, and run the real reconciliation on the result.
 *
 * Expected numbers below were derived by hand from the fixture (see the header of
 * packages/import/fixtures/build-fixture.ts), not by running either implementation.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "../../../packages/import/fixtures/synthetic-backup.json");

let h: Harness;
let owner: Session;
let backup: Backup;
const id = (store: string, legacyId: string) => uuidV5(`${store}:${legacyId}`);
const cust = (l: string) => id("customers", l);
const sup = (l: string) => id("suppliers", l);

const receipts: Record<string, string> = {}; // op name -> receipt number the SERVICE issued
const vouchers: Record<string, string> = {}; // op name -> payment id

beforeAll(async () => {
  backup = JSON.parse(readFileSync(FIXTURE, "utf8"));
  await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "ledger-bridge" });
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

describe("ledger bridge: import the fixture, operate through the service, mirror by hand, compare", () => {
  it("0. before any operation: the imported journal already equals the hand-computed fixture balances", async () => {
    const before = { "cust-1": 1_900_000, "cust-2": 100_000, "cust-3": 470_000, "cust-4": 15_000, "cust-5": 450_000, "cust-6": 0 };
    for (const [l, p] of Object.entries(before)) expect(await customerBalanceSql(h.admin, cust(l)), l).toBe(p);
  });

  it("1. the scripted operations through PaymentsService", async () => {
    const actor = h.actor(owner);
    const svc = h.service;
    const inv = (l: string) => id("invoices", l);

    // Op1: a receipt from a shop with no invoices at all -> a pure advance
    const op1 = await svc.receive({ customerId: cust("cust-4"), amountP: 5_000 }, actor);
    // Op2: auto-allocation, oldest first, over inv-1 (600,000 due), inv-2 (200,000 due) and inv-8 (540,000 due after its 60,000 return)
    const op2 = await svc.receive({ customerId: cust("cust-1"), amountP: 900_000 }, actor);
    // Op3: explicit allocation (250,000 of inv-7's 350,000 outstanding after its 50,000 return); 50,000 stays an advance
    const op3 = await svc.receive({ customerId: cust("cust-5"), amountP: 300_000, allocations: [{ invoiceId: inv("inv-7"), amountP: 250_000 }] }, actor);
    // Op4: a supplier payment tied to a (DRAFT, still-counted) purchase
    const op4 = await svc.pay({ supplierId: sup("sup-2"), amountP: 100_000, allocations: [{ purchaseId: id("purchases", "pur-2"), amountP: 100_000 }] }, actor);
    // Op5: a refund to a shop
    const op5 = await svc.refund({ customerId: cust("cust-2"), amountP: 30_000 }, actor);
    // Op6: reverse Op3
    await svc.reverse(op3.payment.id, { reason: "wrong shop" }, actor);
    // Op7: two edits of Op5's refund
    await svc.editAmount(op5.payment.id, { amountP: 45_000 }, actor);
    await svc.editAmount(op5.payment.id, { amountP: 40_000, reason: "final figure" }, actor);
    // Op8: a plain supplier payment, then corrected
    const op8 = await svc.pay({ supplierId: sup("sup-3"), amountP: 20_000 }, actor);
    await svc.editAmount(op8.payment.id, { amountP: 25_000 }, actor);
    // Op9: correct an IMPORTED voucher (pay-3, the 100,000 refund to cust-5)
    await svc.editAmount(id("payments", "pay-3"), { amountP: 120_000 }, actor);

    Object.assign(vouchers, { op1: op1.payment.id, op2: op2.payment.id, op3: op3.payment.id, op4: op4.payment.id, op5: op5.payment.id, op8: op8.payment.id });
    Object.assign(receipts, {
      op1: op1.payment.receiptNumber, op2: op2.payment.receiptNumber, op3: op3.payment.receiptNumber,
      op4: op4.payment.receiptNumber, op5: op5.payment.receiptNumber, op8: op8.payment.receiptNumber,
    });

    // the numbers continue the fixture's live counters (REC 3, PV 4): REC-…-000004..6, PV-…-000005..7
    expect(receipts).toEqual({
      op1: "REC-2026-000004", op2: "REC-2026-000005", op3: "REC-2026-000006",
      op4: "PV-2026-000005", op5: "PV-2026-000006", op8: "PV-2026-000007",
    });
    expect(op2.payment.allocations.map((a) => [a.documentNumber, a.amountP])).toEqual([
      ["INV-2026-000001", 600_000], ["INV-2026-000002", 200_000], ["INV-2026-000007", 100_000],
    ]);
  });

  it("2. the imported vouchers' refusals: each of pay-1 / pay-2 / pay-4 / pay-7 cannot be edited, with the legacy wording", async () => {
    const edit = (legacy: string) => h.service.editAmount(id("payments", legacy), { amountP: 1 }, h.actor(owner));
    const message = async (legacy: string) => ((await edit(legacy).then(() => null, (e) => e)) as BusinessRuleError).errors[0];
    expect(await message("pay-1")).toBe("Only a voucher paid to a shop or a supplier can have its amount corrected here."); // an IN voucher
    expect(await message("pay-2")).toBe("A reversed voucher cannot be edited.");
    expect(await message("pay-4")).toBe("This payment is applied to an invoice or purchase; its amount can’t be changed here.");
    expect(await message("pay-7")).toBe("This voucher is the refund for a customer return — correct the return instead."); // tied by returns.refund_payment_id
  });

  it("3. invoice statuses follow the legacy refreshPaymentState (hand-computed)", async () => {
    const status = async (l: string) => (await h.admin`SELECT status FROM invoices WHERE id = ${id("invoices", l)}`)[0]!.status;
    expect(await status("inv-1")).toBe("PAID"); // 400,000 + 600,000 of 1,000,000
    expect(await status("inv-2")).toBe("PAID"); // 300,000 + 200,000 of 500,000
    expect(await status("inv-8")).toBe("PARTIALLY_RETURNED"); // 100,000 allocated, but PARTIALLY_RETURNED is left alone
    expect(await status("inv-7")).toBe("CONFIRMED"); // PARTIALLY_PAID by Op3, back to CONFIRMED when Op3 was reversed
    expect(await status("inv-6")).toBe("PARTIALLY_PAID"); // untouched by S3: 250,000 of 750,000 from the import
  });

  describe("4. the same operations applied BY HAND to the legacy-shaped JSON", () => {
    let legacy: Backup;
    beforeAll(() => {
      legacy = JSON.parse(JSON.stringify(backup));
      const d = legacy.data as Record<string, any[]>;
      const T = "2026-03-05T06:00:00.000Z";
      const pay = (idn: string, no: string, direction: string, partyType: string, partyId: string, amount: number, extra: object = {}) =>
        d.payments!.push({
          id: idn, receiptNumber: no, direction, partyId, partyType, isRefund: partyType === "CUSTOMER" && direction === "OUT",
          partyNameSnapshot: "", partyOwnerSnapshot: "", regionSnapshot: "", amount, method: "Cash", reference: "", paymentDate: "2026-03-05",
          note: "", receivedBy: "Bridge", status: "POSTED", createdAt: T, createdBy: "Bridge", balanceBefore: 0, balanceAfter: 0, ...extra,
        });
      const alloc = (idn: string, paymentId: string, target: object, amount: number) =>
        d.paymentAllocations!.push({ id: idn, paymentId, invoiceId: null, purchaseId: null, ...target, amount, createdAt: T });
      const invoice = (l: string) => d.invoices!.find((i) => i.id === l)!;
      const payment = (l: string) => d.payments!.find((p) => p.id === l)!;

      // Op1
      pay("n1", "REC-2026-000004", "IN", "CUSTOMER", "cust-4", 5_000);
      // Op2 (autoAllocate: oldest invoice first over the invoices with something outstanding)
      pay("n2", "REC-2026-000005", "IN", "CUSTOMER", "cust-1", 900_000);
      alloc("na-1", "n2", { invoiceId: "inv-1" }, 600_000);
      alloc("na-2", "n2", { invoiceId: "inv-2" }, 200_000);
      alloc("na-3", "n2", { invoiceId: "inv-8" }, 100_000);
      invoice("inv-1").status = "PAID";
      invoice("inv-2").status = "PAID"; // (refreshPaymentState leaves inv-8 PARTIALLY_RETURNED alone)
      // Op3
      pay("n3", "REC-2026-000006", "IN", "CUSTOMER", "cust-5", 300_000);
      alloc("na-4", "n3", { invoiceId: "inv-7" }, 250_000);
      invoice("inv-7").status = "PARTIALLY_PAID";
      // Op4
      pay("n4", "PV-2026-000005", "OUT", "SUPPLIER", "sup-2", 100_000);
      alloc("na-5", "n4", { purchaseId: "pur-2" }, 100_000);
      // Op5
      pay("n5", "PV-2026-000006", "OUT", "CUSTOMER", "cust-2", 30_000);
      // Op6: Payments.reverse — status REVERSED, the voucher's allocation docs are DELETED, the invoice is refreshed
      const n3 = payment("n3");
      n3.status = "REVERSED"; n3.reversedAt = T; n3.reverseReason = "wrong shop";
      d.paymentAllocations = d.paymentAllocations!.filter((a) => a.paymentId !== "n3");
      invoice("inv-7").status = "CONFIRMED";
      // Op7: Payments.editAmount changes `amount` in place (twice)
      payment("n5").amount = 45_000;
      payment("n5").amount = 40_000;
      // Op8
      pay("n8", "PV-2026-000007", "OUT", "SUPPLIER", "sup-3", 20_000);
      payment("n8").amount = 25_000;
      // Op9
      payment("pay-3").amount = 120_000;

      const counts = legacy.counts as Record<string, number>;
      for (const [store, docs] of Object.entries(d)) counts[store] = docs.length;
    });

    it("hand-computed expectations, per party (paper arithmetic — neither implementation involved)", () => {
      const ledger = createLegacyLedger(legacy.data);
      const expectedCustomers = {
        "cust-1": 1_000_000, // 1,900,000 - 900,000 receipt
        "cust-2": 140_000, //   100,000 + 40,000 refund (after the two edits)
        "cust-3": 470_000, //   untouched
        "cust-4": 10_000, //    15,000 - 5,000 advance
        "cust-5": 470_000, //   450,000 + 20,000 (imported refund corrected 100,000 -> 120,000); the reversed receipt nets to 0
        "cust-6": 0,
      };
      const expectedSuppliers = {
        "sup-1": 870_000, // untouched
        "sup-2": 290_000, // 390,000 - 100,000 payment
        "sup-3": -65_000, // -40,000 - 25,000 payment (after its correction)
        "sup-4": 92_000, //  untouched
        "sup-5": 0,
      };
      for (const [l, p] of Object.entries(expectedCustomers)) expect(ledger.customer(l).closing, `legacy ${l}`).toBe(p);
      for (const [l, p] of Object.entries(expectedSuppliers)) expect(ledger.supplier(l).closing, `legacy ${l}`).toBe(p);
    });

    it("EVERY party: the old algorithm's balance == the new journal's balance", async () => {
      const ledger = createLegacyLedger(legacy.data);
      expect(ledger.customerIds).toHaveLength(6);
      expect(ledger.supplierIds).toHaveLength(5);
      for (const l of ledger.customerIds) expect(await customerBalanceSql(h.admin, cust(l)), `customer ${l}`).toBe(ledger.customer(l).closing);
      for (const l of ledger.supplierIds) expect(await supplierBalanceSql(h.admin, sup(l)), `supplier ${l}`).toBe(ledger.supplier(l).closing);
    });

    it("the trial balance is still zero (Σ debit = Σ credit) after all of it", async () => {
      const t = await trialBalance(h.admin);
      expect(t.debit).toBe(t.credit);
      const unbalanced = await h.admin`
        SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_p) <> SUM(credit_p)`;
      expect(unbalanced).toHaveLength(0);
    });

    it("every S3 voucher has exactly one entry per source, findable by (source_type, source_id)", async () => {
      for (const [op, paymentId] of Object.entries(vouchers)) {
        const rows = await h.admin`SELECT source_type FROM journal_entries WHERE source_id = ${paymentId} ORDER BY source_type`;
        expect(rows.map((r) => r.source_type), op).toEqual(op === "op3" ? ["PAYMENT", "PAYMENT_REVERSAL"] : ["PAYMENT"]);
      }
    });

    it("the REAL reconciliation, run on the post-S3 database against the hand-updated JSON: 0 balance differences, statements match", async () => {
      const report: ReconciliationReport = await reconcile(legacy, TEST_ADMIN_URL);
      expect(report.customers).toEqual({ compared: 6, differences: [] });
      expect(report.suppliers).toEqual({ compared: 5, differences: [] });
      expect(report.statements.mismatches).toEqual([]);
      expect(report.trialBalance.balanced).toBe(true);
      // The single deliberate difference from the legacy: a reversal KEEPS the voucher's allocation rows (the legacy
      // deleted them). 8 allocation docs survive in the legacy JSON, 9 rows in the database. Nothing else may fail.
      expect(report.counts.filter((c) => c.class === "imported" && !c.match).map((c) => [c.store, c.backup, c.loaded])).toEqual([["paymentAllocations", 8, 9]]);
      expect(report.failures).toHaveLength(1);
    });
  });
});

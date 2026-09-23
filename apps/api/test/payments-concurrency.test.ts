import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAccountIds, paymentLines, payments, postJournalEntry } from "@farooq/db";
import { BusinessRuleError } from "../src/payments/errors.js";
import { formatNumber, nextNumber } from "../src/payments/numbering.js";
import { createHarness, customerBalanceSql, entriesFor, invoiceStatus, type Harness, type Session } from "./helpers/harness.js";

/**
 * Numbering, idempotency, dates and the races the row locks exist for. Years 2031-2033 are used for the numbering
 * tests so their `sequences` rows belong to no other test and exact numbers can be asserted.
 */
let h: Harness;
let owner: Session;
const run = randomUUID().slice(0, 8); // idempotency keys are unique per run, so the file is re-runnable on a persistent database
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  // the exact-number tests below own these far-future years; start them from nothing
  await h.admin`DELETE FROM sequences WHERE year >= 2031`;
});
afterAll(async () => {
  await h.close();
});

const at = (iso: string) => {
  h.clock.current = new Date(iso);
};
const restoreClock = () => at("2026-03-05T06:00:00Z");

describe("numbering — one atomic counter per (kind, year)", () => {
  it("N parallel receives get N distinct, gap-free, sequential numbers", async () => {
    at("2031-06-15T06:00:00Z");
    try {
      const c = await h.seed.customer();
      const N = 12;
      const results = await Promise.all(Array.from({ length: N }, () => h.service.receive({ customerId: c.id, amountP: 1_000 }, h.actor(owner))));
      const numbers = results.map((r) => r.payment.receiptNumber).sort();
      expect(numbers).toEqual(Array.from({ length: N }, (_, i) => formatNumber("REC", 2031, i + 1)));
      expect(numbers[0]).toBe("REC-2031-000001");
      const [seq] = await h.admin`SELECT n FROM sequences WHERE kind = 'REC' AND year = 2031`;
      expect(seq!.n).toBe(N);
    } finally {
      restoreClock();
    }
  });

  it("continues the live series: a counter loaded by the importer is the next number's predecessor", async () => {
    at("2034-01-10T06:00:00Z");
    try {
      await h.admin`INSERT INTO sequences (kind, year, n) VALUES ('REC', 2034, 41), ('PV', 2034, 7)`;
      const c = await h.seed.customer();
      const s = await h.seed.supplier();
      expect((await h.service.receive({ customerId: c.id, amountP: 1 }, h.actor(owner))).payment.receiptNumber).toBe("REC-2034-000042");
      expect((await h.service.pay({ supplierId: s.id, amountP: 1 }, h.actor(owner))).payment.receiptNumber).toBe("PV-2034-000008");
    } finally {
      restoreClock();
    }
  });

  it("the year is the CURRENT business year (Karachi), not the payment date's, and not the UTC year", async () => {
    // 2032-12-31 19:30 UTC is already 2033-01-01 00:30 in Karachi
    at("2032-12-31T19:30:00Z");
    try {
      const c = await h.seed.customer();
      const res = await h.service.receive({ customerId: c.id, amountP: 1_000, date: "2026-01-15" }, h.actor(owner));
      expect(res.payment.receiptNumber).toBe("REC-2033-000001");
      expect(res.payment.paymentDate).toBe("2026-01-15");
    } finally {
      restoreClock();
    }
  });

  it("a rolled-back save does NOT consume a number: the counter rolls back with the voucher", async () => {
    at("2035-02-01T06:00:00Z");
    try {
      const c = await h.seed.customer();
      // Force a failure AFTER the number was taken: a voucher already holds the very receipt number the next save will be given.
      const [blocker] = await h.db
        .insert(payments)
        .values({ direction: "IN", partyType: "CUSTOMER", partyId: c.id, amountP: 1, paymentDate: "2035-02-01", receiptNumber: "REC-2035-000001" })
        .returning();
      await expect(h.service.receive({ customerId: c.id, amountP: 500 }, h.actor(owner))).rejects.toThrow(/receipt_number/);
      const rows = await h.admin`SELECT n FROM sequences WHERE kind = 'REC' AND year = 2035`;
      expect(rows).toHaveLength(0); // the counter row itself was rolled back

      await h.admin`DELETE FROM payments WHERE id = ${blocker!.id}`;
      const ok = await h.service.receive({ customerId: c.id, amountP: 500 }, h.actor(owner));
      expect(ok.payment.receiptNumber).toBe("REC-2035-000001"); // the number was not burnt by the failed attempt
    } finally {
      restoreClock();
    }
  });

  it("nextNumber inside a transaction that throws leaves the counter untouched", async () => {
    await expect(
      h.db.transaction(async (tx) => {
        expect(await nextNumber(tx, "XT", 2040)).toBe("XT-2040-000001");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await h.db.transaction((tx) => nextNumber(tx, "XT", 2040))).toBe("XT-2040-000001");
  });
});

describe("idempotency — a repeated request returns the first voucher and writes nothing new", () => {
  it("the same key twice: 201 then 200, the same voucher, ONE payment, ONE journal entry, ONE audit row, ONE number", async () => {
    at("2036-03-01T06:00:00Z");
    try {
      const c = await h.seed.customer();
      const body = { customerId: c.id, amountP: 7_000, idempotencyKey: `key-double-click-1-${run}` };
      const first = await h.request(owner, "POST", "/payments/receive", { body });
      const second = await h.request(owner, "POST", "/payments/receive", { body });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(first.body.receiptNumber).toBe("REC-2036-000001");

      const [n] = await h.admin`SELECT count(*)::int AS n FROM payments WHERE party_id = ${c.id}`;
      expect(n!.n).toBe(1);
      expect(await entriesFor(h.admin, "PAYMENT", first.body.id)).toHaveLength(1);
      const audits = await h.admin`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ${first.body.id}`;
      expect(audits[0]!.n).toBe(1);
      expect(await customerBalanceSql(h.admin, c.id)).toBe(-7_000);
      const [seq] = await h.admin`SELECT n FROM sequences WHERE kind = 'REC' AND year = 2036`;
      expect(seq!.n).toBe(1);
    } finally {
      restoreClock();
    }
  });

  it("five simultaneous submissions with one key: exactly one voucher is written", async () => {
    const c = await h.seed.customer();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.service.receive({ customerId: c.id, amountP: 3_000, idempotencyKey: `key-five-at-once-${run}` }, h.actor(owner))),
    );
    expect(new Set(results.map((r) => r.payment.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    const [n] = await h.admin`SELECT count(*)::int AS n FROM payments WHERE idempotency_key = ${`key-five-at-once-${run}`}`;
    expect(n!.n).toBe(1);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(-3_000);
  });

  it("applies to pay and refund too; different keys make different vouchers; no key means no protection", async () => {
    const c = await h.seed.customer();
    const s = await h.seed.supplier();
    const a1 = await h.service.pay({ supplierId: s.id, amountP: 100, idempotencyKey: `key-pay-000001-${run}` }, h.actor(owner));
    const a2 = await h.service.pay({ supplierId: s.id, amountP: 100, idempotencyKey: `key-pay-000001-${run}` }, h.actor(owner));
    expect([a1.replayed, a2.replayed, a1.payment.id === a2.payment.id]).toEqual([false, true, true]);
    const r1 = await h.service.refund({ customerId: c.id, amountP: 100, idempotencyKey: `key-refund-0001-${run}` }, h.actor(owner));
    const r2 = await h.service.refund({ customerId: c.id, amountP: 100, idempotencyKey: `key-refund-0002-${run}` }, h.actor(owner));
    expect(r1.payment.id).not.toBe(r2.payment.id);
    const n1 = await h.service.receive({ customerId: c.id, amountP: 100 }, h.actor(owner));
    const n2 = await h.service.receive({ customerId: c.id, amountP: 100 }, h.actor(owner));
    expect(n1.payment.id).not.toBe(n2.payment.id);
  });

  it("a refused request does not claim its key: the corrected retry goes through", async () => {
    const c = await h.seed.customer();
    const bad = await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 100, idempotencyKey: `key-retry-after-422-${run}`, allocations: [{ invoiceId: "00000000-0000-4000-8000-000000000000", amountP: 100 }] } });
    expect(bad.status).toBe(422);
    const good = await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 100, idempotencyKey: `key-retry-after-422-${run}` } });
    expect(good.status).toBe(201);
  });
});

describe("business dates are Karachi dates (CLAUDE.md rule 6)", () => {
  it("2026-01-01T20:00:00Z is 2026-01-02 in Karachi: the default payment date, and the journal entry's date", async () => {
    at("2026-01-01T20:00:00Z");
    try {
      const c = await h.seed.customer();
      const res = await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 1_000 } });
      expect(res.body.paymentDate).toBe("2026-01-02");
      const [e] = await entriesFor(h.admin, "PAYMENT", res.body.id);
      expect(e!.date).toBe("2026-01-02");
    } finally {
      restoreClock();
    }
  });

  it("18:59 UTC is still today in Karachi; 19:00 UTC is tomorrow", async () => {
    const c = await h.seed.customer();
    at("2026-06-10T18:59:59Z");
    const a = await h.service.receive({ customerId: c.id, amountP: 1 }, h.actor(owner));
    at("2026-06-10T19:00:00Z");
    const b = await h.service.receive({ customerId: c.id, amountP: 1 }, h.actor(owner));
    restoreClock();
    expect([a.payment.paymentDate, b.payment.paymentDate]).toEqual(["2026-06-10", "2026-06-11"]);
  });
});

describe("races — the row locks", () => {
  it("two receipts racing for one invoice (explicit allocations) cannot both fill it: exactly one succeeds", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 1_000_000, number: "INV-RACE-1" });
    const attempt = () => h.service.receive({ customerId: c.id, amountP: 800_000, allocations: [{ invoiceId: inv.id, amountP: 800_000 }] }, h.actor(owner));
    const settled = await Promise.allSettled([attempt(), attempt()]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BusinessRuleError);
    expect((rejected.reason as BusinessRuleError).errors[0]).toBe("Invoice INV-RACE-1: Rs 8,000.00 is more than the Rs 2,000.00 outstanding.");
    const [a] = await h.admin`SELECT COALESCE(SUM(amount_p),0)::int AS n FROM payment_allocations WHERE invoice_id = ${inv.id}`;
    expect(a!.n).toBe(800_000);
  });

  it("two AUTO-allocated receipts racing for one invoice never over-allocate it (the loser's excess becomes an advance)", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 1_000_000 });
    const results = await Promise.all([
      h.service.receive({ customerId: c.id, amountP: 800_000 }, h.actor(owner)),
      h.service.receive({ customerId: c.id, amountP: 800_000 }, h.actor(owner)),
    ]);
    const [a] = await h.admin`SELECT COALESCE(SUM(amount_p),0)::int AS n FROM payment_allocations WHERE invoice_id = ${inv.id}`;
    expect(a!.n).toBe(1_000_000); // exactly the invoice total: never more
    expect(results.map((r) => r.payment.allocatedP).sort((x, y) => x - y)).toEqual([200_000, 800_000]);
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PAID");
    expect(await customerBalanceSql(h.admin, c.id)).toBe(1_000_000 - 1_600_000); // the advance still credits the shop
  });

  it("two concurrent reverses of one voucher: exactly one succeeds, one reversing entry", async () => {
    const c = await h.seed.customer();
    const r = await h.service.receive({ customerId: c.id, amountP: 9_000 }, h.actor(owner));
    const settled = await Promise.allSettled([
      h.service.reverse(r.payment.id, { reason: "a" }, h.actor(owner)),
      h.service.reverse(r.payment.id, { reason: "b" }, h.actor(owner)),
    ]);
    expect(settled.map((s) => s.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(((settled.find((s) => s.status === "rejected") as PromiseRejectedResult).reason as BusinessRuleError).errors).toEqual(["This voucher is already reversed."]);
    expect(await entriesFor(h.admin, "PAYMENT_REVERSAL", r.payment.id)).toHaveLength(1);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(0);
  });

  it("reversing two vouchers that touch the same invoices, in opposite orders, does not deadlock", async () => {
    const c = await h.seed.customer();
    const i1 = await h.seed.invoice(c.id, { totalP: 100_000, date: "2026-02-01" });
    const i2 = await h.seed.invoice(c.id, { totalP: 100_000, date: "2026-02-02" });
    const a = await h.service.receive({ customerId: c.id, amountP: 50_000, allocations: [{ invoiceId: i1.id, amountP: 25_000 }, { invoiceId: i2.id, amountP: 25_000 }] }, h.actor(owner));
    const b = await h.service.receive({ customerId: c.id, amountP: 50_000, allocations: [{ invoiceId: i2.id, amountP: 25_000 }, { invoiceId: i1.id, amountP: 25_000 }] }, h.actor(owner));
    const settled = await Promise.allSettled([
      h.service.reverse(a.payment.id, { reason: "x" }, h.actor(owner)),
      h.service.reverse(b.payment.id, { reason: "y" }, h.actor(owner)),
    ]);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    expect(await invoiceStatus(h.admin, i1.id)).toBe("CONFIRMED");
    expect(await invoiceStatus(h.admin, i2.id)).toBe("CONFIRMED");
  });

  it("an edit racing a reverse of the same voucher: they serialise (never a half-applied state)", async () => {
    const c = await h.seed.customer();
    const v = await h.service.refund({ customerId: c.id, amountP: 10_000 }, h.actor(owner));
    const settled = await Promise.allSettled([
      h.service.editAmount(v.payment.id, { amountP: 20_000 }, h.actor(owner)),
      h.service.reverse(v.payment.id, { reason: "race" }, h.actor(owner)),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    // whichever order won, the ledger is consistent: original entry + reversal entry cancel exactly
    const balance = await customerBalanceSql(h.admin, c.id);
    const [p] = await h.admin`SELECT status, amount_p::int AS amount FROM payments WHERE id = ${v.payment.id}`;
    expect(p!.status).toBe("REVERSED");
    expect(balance).toBe(0);
    expect(p!.amount === 10_000 || p!.amount === 20_000).toBe(true);
    const entries = [...(await entriesFor(h.admin, "PAYMENT", v.payment.id)), ...(await entriesFor(h.admin, "PAYMENT_REVERSAL", v.payment.id))];
    expect(entries).toHaveLength(2);
  });
});

describe("defence in depth — the database itself refuses an unbalanced entry (S1 trigger)", () => {
  it("a payment inserted directly through the repository with unbalanced lines cannot be committed", async () => {
    const c = await h.seed.customer();
    await expect(
      h.db.transaction(async (tx) => {
        const [p] = await tx
          .insert(payments)
          .values({ direction: "IN", partyType: "CUSTOMER", partyId: c.id, amountP: 1_000, paymentDate: "2026-03-05", receiptNumber: `BAD-${Date.now()}` })
          .returning();
        const acc = await loadAccountIds(tx);
        const lines = paymentLines({ direction: "IN", partyType: "CUSTOMER", partyId: c.id, amountP: 1_000 });
        lines[1]!.creditP = 900; // DR 1,000 / CR 900
        await postJournalEntry(tx, acc, { date: "2026-03-05", memo: "unbalanced", sourceType: "PAYMENT", sourceId: p!.id, createdBy: null, lines });
      }),
    ).rejects.toThrow(/unbalanced/i);
    const [n] = await h.admin`SELECT count(*)::int AS n FROM payments WHERE party_id = ${c.id}`;
    expect(n!.n).toBe(0); // the voucher rolled back with its entry
  });

  it("at most one entry per (source_type, source_id): a second PAYMENT entry for the same voucher is refused", async () => {
    const c = await h.seed.customer();
    const v = await h.service.refund({ customerId: c.id, amountP: 100 }, h.actor(owner));
    await expect(
      h.db.transaction(async (tx) => {
        const acc = await loadAccountIds(tx);
        await postJournalEntry(tx, acc, { date: "2026-03-05", memo: "dup", sourceType: "PAYMENT", sourceId: v.payment.id, createdBy: null, lines: paymentLines({ direction: "OUT", partyType: "CUSTOMER", partyId: c.id, amountP: 100 }) });
      }),
    ).rejects.toThrow(/journal_entries_source_uq|duplicate key/);
  });
});


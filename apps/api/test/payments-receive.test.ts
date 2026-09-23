import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entriesFor, createHarness, customerBalanceSql, invoiceStatus, type Harness, type Session } from "./helpers/harness.js";

/**
 * receive — money in from a shop. Every expectation below is worked out by hand from the legacy rules
 * (`Payments.receive / autoAllocate`, `Invoices.outstanding / refreshPaymentState`), never read back from the
 * code under test. Amounts are paisa.
 */
let h: Harness;
let owner: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

const receive = (customerId: string, amountP: number, extra: Record<string, unknown> = {}) =>
  h.request(owner, "POST", "/payments/receive", { body: { customerId, amountP, ...extra } });

describe("receive — auto-allocation is oldest invoice first (legacy autoAllocate)", () => {
  it("fills the oldest invoice first, ties on date broken by created_at, and leaves the excess as an unallocated advance", async () => {
    const c = await h.seed.customer();
    const other = await h.seed.customer();
    // same business date: I2 was entered an hour after I1 (I2 is inserted FIRST to prove it is not insertion order)
    const i2 = await h.seed.invoice(c.id, { number: "INV-A-2", date: "2026-02-01", totalP: 500_000, createdAt: "2026-02-01T06:00:00Z" });
    const i1 = await h.seed.invoice(c.id, { number: "INV-A-1", date: "2026-02-01", totalP: 1_000_000, createdAt: "2026-02-01T05:00:00Z" });
    const later = await h.seed.invoice(c.id, { number: "INV-A-3", date: "2026-02-10", totalP: 800_000 });
    // never collectable / not this shop's
    await h.seed.invoice(c.id, { number: null, date: "2026-01-01", totalP: 999_999, status: "DRAFT" });
    await h.seed.invoice(c.id, { number: "INV-A-X", date: "2026-01-02", totalP: 888_888, status: "CANCELLED" });
    await h.seed.invoice(other.id, { number: "INV-OTHER", date: "2026-01-03", totalP: 300_000 });

    // 1,600,000: I1 1,000,000 + I2 500,000 + 100,000 of the later invoice
    const res = await receive(c.id, 1_600_000);
    expect(res.status).toBe(201);
    expect(res.body.allocations.map((a: any) => [a.documentNumber, a.amountP])).toEqual([
      ["INV-A-1", 1_000_000],
      ["INV-A-2", 500_000],
      ["INV-A-3", 100_000],
    ]);
    expect(res.body.allocatedP).toBe(1_600_000);
    expect(res.body.unallocatedP).toBe(0);
    expect(await invoiceStatus(h.admin, i1.id)).toBe("PAID");
    expect(await invoiceStatus(h.admin, i2.id)).toBe("PAID");
    expect(await invoiceStatus(h.admin, later.id)).toBe("PARTIALLY_PAID");

    // 900,000 more: 700,000 finishes the later invoice, 200,000 has nothing left to absorb it (an advance)
    const res2 = await receive(c.id, 900_000);
    expect(res2.body.allocations.map((a: any) => [a.documentNumber, a.amountP])).toEqual([["INV-A-3", 700_000]]);
    expect(res2.body.unallocatedP).toBe(200_000);
    expect(await invoiceStatus(h.admin, later.id)).toBe("PAID");
    // the advance still credits the ledger: invoices 2,300,000 - receipts 2,500,000
    expect(await customerBalanceSql(h.admin, c.id)).toBe(-200_000);
  });

  it("breaks a tie on date AND created_at by invoice number (legacy sort was unstable there)", async () => {
    const c = await h.seed.customer();
    const stamp = "2026-02-01T05:00:00Z";
    await h.seed.invoice(c.id, { number: "INV-T-2", date: "2026-02-01", totalP: 100_000, createdAt: stamp });
    await h.seed.invoice(c.id, { number: "INV-T-1", date: "2026-02-01", totalP: 100_000, createdAt: stamp });
    const res = await receive(c.id, 100_000);
    expect(res.body.allocations.map((a: any) => a.documentNumber)).toEqual(["INV-T-1"]);
  });

  it("stops at what is outstanding and moves on: a partial payment first, then the rest", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 1_000_000 });
    await receive(c.id, 400_000);
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PARTIALLY_PAID");
    await receive(c.id, 600_000);
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PAID");
  });

  it("skips invoices with nothing outstanding — the whole amount becomes an advance", async () => {
    const c = await h.seed.customer();
    await h.seed.invoice(c.id, { totalP: 100_000, status: "DRAFT", number: null });
    const res = await receive(c.id, 50_000);
    expect(res.status).toBe(201);
    expect(res.body.allocations).toEqual([]);
    expect(res.body.unallocatedP).toBe(50_000);
  });
});

describe("receive — outstanding subtracts linked returns (legacy Invoices.outstanding)", () => {
  it("a POSTED and a DRAFT return count, a CANCELLED one does not; the STATUS ignores return credit", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { number: "INV-R-1", totalP: 600_000 });
    await h.seed.customerReturn(c.id, inv.id, { totalP: 60_000, status: "POSTED" });
    await h.seed.customerReturn(c.id, inv.id, { totalP: 80_000, status: "DRAFT" }); // DRAFT is "not CANCELLED": counts
    await h.seed.customerReturn(c.id, inv.id, { totalP: 999_000, status: "CANCELLED" }); // ignored
    // outstanding = 600,000 - 60,000 - 80,000 = 460,000

    const tooMuch = await receive(c.id, 500_000, { allocations: [{ invoiceId: inv.id, amountP: 500_000 }] });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.message).toBe("Invoice INV-R-1: Rs 5,000.00 is more than the Rs 4,600.00 outstanding.");

    const res = await receive(c.id, 1_000_000);
    expect(res.body.allocations.map((a: any) => a.amountP)).toEqual([460_000]);
    expect(res.body.unallocatedP).toBe(540_000);
    // status counts allocations only (460,000 of 600,000) -> PARTIALLY_PAID even though nothing is left to collect
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PARTIALLY_PAID");
  });

  it("the outstanding-invoices read endpoint uses the same formula", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { number: "INV-R-2", totalP: 600_000, date: "2026-02-02" });
    await h.seed.customerReturn(c.id, inv.id, { totalP: 140_000 });
    await receive(c.id, 100_000);
    const res = await h.request(owner, "GET", `/customers/${c.id}/outstanding-invoices`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({ id: inv.id, number: "INV-R-2", totalP: 600_000, paidP: 100_000, creditP: 140_000, outstandingP: 360_000 }),
    ]);
  });
});

describe("receive — invoice status (legacy refreshPaymentState)", () => {
  it("CONFIRMED → PARTIALLY_PAID → PAID", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 300_000, status: "CONFIRMED" });
    expect(await invoiceStatus(h.admin, inv.id)).toBe("CONFIRMED");
    await receive(c.id, 100_000, { allocations: [{ invoiceId: inv.id, amountP: 100_000 }] });
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PARTIALLY_PAID");
    await receive(c.id, 200_000, { allocations: [{ invoiceId: inv.id, amountP: 200_000 }] });
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PAID");
  });

  it("a DISPATCHED invoice is overwritten like any other status the legacy does not protect", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 300_000, status: "DISPATCHED" });
    await receive(c.id, 100_000);
    expect(await invoiceStatus(h.admin, inv.id)).toBe("PARTIALLY_PAID");
  });

  it("RETURNED and PARTIALLY_RETURNED stay as they are (still collectable, status untouched)", async () => {
    const c = await h.seed.customer();
    const returned = await h.seed.invoice(c.id, { totalP: 500_000, status: "RETURNED", date: "2026-02-01" });
    const partly = await h.seed.invoice(c.id, { totalP: 200_000, status: "PARTIALLY_RETURNED", date: "2026-02-02" });
    const res = await receive(c.id, 700_000);
    expect(res.body.allocatedP).toBe(700_000);
    expect(await invoiceStatus(h.admin, returned.id)).toBe("RETURNED");
    expect(await invoiceStatus(h.admin, partly.id)).toBe("PARTIALLY_RETURNED");
  });
});

describe("receive — explicit allocations are checked on the server (stricter than the legacy, which trusted the UI)", () => {
  it("accepts a valid explicit allocation, and the rest stays an advance", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 400_000, number: "INV-E-1" });
    const res = await receive(c.id, 500_000, { allocations: [{ invoiceId: inv.id, amountP: 250_000 }] });
    expect(res.status).toBe(201);
    expect(res.body.allocations.map((a: any) => [a.documentNumber, a.amountP])).toEqual([["INV-E-1", 250_000]]);
    expect(res.body.unallocatedP).toBe(250_000);
  });

  it("refuses more than the invoice's outstanding", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 400_000, number: "INV-E-2" });
    const res = await receive(c.id, 500_000, { allocations: [{ invoiceId: inv.id, amountP: 400_001 }] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["Invoice INV-E-2: Rs 4,000.01 is more than the Rs 4,000.00 outstanding."]);
  });

  it("refuses another shop's invoice", async () => {
    const c = await h.seed.customer();
    const other = await h.seed.customer();
    const theirs = await h.seed.invoice(other.id, { totalP: 100_000, number: "INV-E-3" });
    const res = await receive(c.id, 100_000, { allocations: [{ invoiceId: theirs.id, amountP: 100_000 }] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["Invoice INV-E-3 does not belong to this shop."]);
  });

  it("refuses DRAFT and CANCELLED invoices", async () => {
    const c = await h.seed.customer();
    const draft = await h.seed.invoice(c.id, { totalP: 100_000, number: null, status: "DRAFT" });
    const cancelled = await h.seed.invoice(c.id, { totalP: 100_000, number: "INV-E-4", status: "CANCELLED" });
    const a = await receive(c.id, 100_000, { allocations: [{ invoiceId: draft.id, amountP: 50_000 }] });
    expect(a.body.errors).toEqual(["Invoice (draft) is a draft and cannot be paid."]);
    const b = await receive(c.id, 100_000, { allocations: [{ invoiceId: cancelled.id, amountP: 50_000 }] });
    expect(b.body.errors).toEqual(["Invoice INV-E-4 is cancelled and cannot be paid."]);
  });

  it("refuses an invoice that does not exist, and a duplicated invoice", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 500_000, number: "INV-E-5" });
    const ghost = await receive(c.id, 100_000, { allocations: [{ invoiceId: "00000000-0000-4000-8000-000000000000", amountP: 100_000 }] });
    expect(ghost.body.errors).toEqual(["An invoice in the allocations does not exist."]);
    const dup = await receive(c.id, 200_000, {
      allocations: [
        { invoiceId: inv.id, amountP: 100_000 },
        { invoiceId: inv.id, amountP: 100_000 },
      ],
    });
    expect(dup.status).toBe(422);
    expect(dup.body.errors).toContain("The same invoice appears more than once in the allocations.");
  });

  it("refuses allocations that add up to more than the amount received", async () => {
    const c = await h.seed.customer();
    const a = await h.seed.invoice(c.id, { totalP: 500_000, number: "INV-E-6" });
    const b = await h.seed.invoice(c.id, { totalP: 500_000, number: "INV-E-7" });
    const res = await receive(c.id, 300_000, {
      allocations: [
        { invoiceId: a.id, amountP: 200_000 },
        { invoiceId: b.id, amountP: 200_000 },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(["The allocations total Rs 4,000.00, more than the Rs 3,000.00 received."]);
  });

  it("a refused receive writes nothing: no voucher, no allocation, no journal entry, no number consumed", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { totalP: 100_000 });
    const before = await customerBalanceSql(h.admin, c.id);
    const seqOf = async () => (await h.admin`SELECT COALESCE(MAX(n), 0)::int AS n FROM sequences WHERE kind = 'REC' AND year = 2026`)[0]!.n as number;
    const seqBefore = await seqOf();
    const res = await receive(c.id, 100_000, { allocations: [{ invoiceId: inv.id, amountP: 100_001 }] });
    expect(res.status).toBe(422);
    const [made] = await h.admin`SELECT count(*)::int AS n FROM payments WHERE party_id = ${c.id}`;
    expect(made!.n).toBe(0);
    expect(await customerBalanceSql(h.admin, c.id)).toBe(before);
    expect(await seqOf()).toBe(seqBefore);
  });
});

describe("receive — the voucher, its journal entry and its audit row", () => {
  it("writes a POSTED REC-<year>-<6 digits> voucher, one DR CASH / CR RECEIVABLES entry and one audit row", async () => {
    const c = await h.seed.customer("Audit Shop");
    const res = await receive(c.id, 123_456, { method: "  JazzCash ", reference: " TX-9 ", note: "" });
    expect(res.status).toBe(201);
    const v = res.body;
    expect(v.receiptNumber).toMatch(/^REC-2026-\d{6}$/);
    expect(v).toMatchObject({
      direction: "IN", partyType: "CUSTOMER", partyId: c.id, partyName: "Audit Shop", isRefund: false, amountP: 123_456,
      method: "JazzCash", reference: "TX-9", note: null, status: "POSTED", paymentDate: "2026-03-05", createdBy: owner.userId, receivedBy: owner.name,
    });

    const entries = await entriesFor(h.admin, "PAYMENT", v.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.date).toBe("2026-03-05");
    expect(entries[0]!.created_by).toBe(owner.userId);
    expect(entries[0]!.lines).toEqual([
      { code: "CASH", party_type: null, party_id: null, debit: 123_456, credit: 0 },
      { code: "RECEIVABLES", party_type: "CUSTOMER", party_id: c.id, debit: 0, credit: 123_456 },
    ]);

    const audit = await h.admin`SELECT actor_id, action, entity, after FROM audit_log WHERE entity = 'Payment' AND entity_id = ${v.id}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: owner.userId, action: "Payment received", entity: "Payment" });
    expect(audit[0]!.after).toMatchObject({ receiptNumber: v.receiptNumber, amountP: 123_456, party: "Audit Shop" });
  });

  it("defaults the method to Cash and the date to today; honours an explicit date", async () => {
    const c = await h.seed.customer();
    const a = await receive(c.id, 1_000);
    expect(a.body).toMatchObject({ method: "Cash", paymentDate: "2026-03-05" });
    const b = await receive(c.id, 1_000, { date: "2026-02-20" });
    expect(b.body.paymentDate).toBe("2026-02-20");
    const [e] = await entriesFor(h.admin, "PAYMENT", b.body.id);
    expect(e!.date).toBe("2026-02-20"); // the entry carries the voucher's business date
  });
});

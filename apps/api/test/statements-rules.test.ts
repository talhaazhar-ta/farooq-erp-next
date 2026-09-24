import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountAdjustments, custLine, loadAccountIds, plainLine, postJournalEntry, reversedLines, supLine, customers, regions, suppliers } from "@farooq/db";
import { statementSchema, type Statement } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";

/**
 * Statement rules, one test per rule (S4 decisions 1 and 2), each with hand-computed numbers.
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

const get = async (kind: "customers" | "suppliers", id: string, qs = ""): Promise<Statement> => {
  const res = await h.request(owner, "GET", `/${kind}/${id}/statement${qs}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return statementSchema.parse(res.body);
};

/** Pins the entry time of the journal entry of a document, so the order rule is tested with known clocks. */
async function setEntryTime(sourceType: string, sourceId: string, iso: string): Promise<void> {
  await h.admin`UPDATE journal_entries SET created_at = ${iso}::timestamptz WHERE source_type = ${sourceType} AND source_id = ${sourceId}`;
}

/** An opening-balance entry, as the importer posts it (CUSTOMER_OPENING: DR RECEIVABLES / CR OPENING_EQUITY). */
async function postOpening(kind: "CUSTOMER" | "SUPPLIER", partyId: string, date: string, amountP: number, createdAt: string): Promise<void> {
  await h.db.transaction(async (tx) => {
    const acc = await loadAccountIds(tx);
    await postJournalEntry(tx, acc, {
      date,
      memo: "Opening balance",
      sourceType: kind === "CUSTOMER" ? "CUSTOMER_OPENING" : "SUPPLIER_OPENING",
      sourceId: partyId,
      createdBy: null,
      lines: kind === "CUSTOMER" ? [custLine(partyId, amountP, 0), plainLine("OPENING_EQUITY", 0, amountP)] : [plainLine("OPENING_EQUITY", amountP, 0), supLine(partyId, 0, amountP)],
    });
  });
  await setEntryTime(kind === "CUSTOMER" ? "CUSTOMER_OPENING" : "SUPPLIER_OPENING", partyId, createdAt);
}

describe("statement order — business date, then entry time, then entry id", () => {
  it("rows on one day follow the ORDER THEY WERE ENTERED — a refund entered late is NOT hoisted above the invoice (the legacy artefact is not copied)", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { date: "2026-04-10", totalP: 100_000 });
    const pay = await h.seed.voucher({ direction: "IN", partyType: "CUSTOMER", partyId: c.id, amountP: 30_000, date: "2026-04-10" });
    const refund = await h.seed.voucher({ direction: "OUT", partyType: "CUSTOMER", partyId: c.id, amountP: 5_000, date: "2026-04-10" });
    // entered: invoice 09:00, payment 10:00, refund 11:00 (the legacy would list the refund first: its ledger row has no createdAt)
    await setEntryTime("INVOICE", inv.id, "2026-04-10T04:00:00Z");
    await setEntryTime("PAYMENT", pay.id, "2026-04-10T05:00:00Z");
    await setEntryTime("PAYMENT", refund.id, "2026-04-10T06:00:00Z");
    const s = await get("customers", c.id);
    expect(s.rows.map((r) => r.kind)).toEqual(["INVOICE", "PAYMENT", "REFUND"]);
    // hand-computed: 100,000 − 30,000 + 5,000
    expect(s.rows.map((r) => r.balanceP)).toEqual([100_000, 70_000, 75_000]);
    expect(s.closing).toBe(75_000);
  });

  it("an earlier date always lists first, whatever the entry time", async () => {
    const c = await h.seed.customer();
    const late = await h.seed.invoice(c.id, { date: "2026-04-12", totalP: 10_000 });
    const early = await h.seed.invoice(c.id, { date: "2026-04-11", totalP: 20_000 });
    await setEntryTime("INVOICE", late.id, "2026-04-01T00:00:00Z"); // entered long before, but dated later
    await setEntryTime("INVOICE", early.id, "2026-04-20T00:00:00Z");
    const s = await get("customers", c.id);
    expect(s.rows.map((r) => r.date)).toEqual(["2026-04-11", "2026-04-12"]);
  });

  it("rows with the same date AND entry time are ordered by entry id (stable, not arbitrary)", async () => {
    const c = await h.seed.customer();
    const a = await h.seed.invoice(c.id, { date: "2026-04-13", totalP: 1_000 });
    const b = await h.seed.invoice(c.id, { date: "2026-04-13", totalP: 2_000 });
    await setEntryTime("INVOICE", a.id, "2026-04-13T05:00:00Z");
    await setEntryTime("INVOICE", b.id, "2026-04-13T05:00:00Z");
    const ids = (await h.admin`SELECT id FROM journal_entries WHERE source_id IN (${a.id}, ${b.id}) ORDER BY id`).map((r) => r.id as string);
    const bySource = new Map((await h.admin`SELECT id, source_id FROM journal_entries WHERE source_id IN (${a.id}, ${b.id})`).map((r) => [r.id as string, r.source_id as string]));
    const s = await get("customers", c.id);
    expect(s.rows.map((r) => r.source.id)).toEqual(ids.map((id) => bySource.get(id)));
  });

  it("a CUSTOMER's OPENING row is first even when it is dated after everything else (legacy 16-khata)", async () => {
    const c = await h.seed.customer();
    await h.seed.invoice(c.id, { date: "2026-03-01", totalP: 40_000 });
    await postOpening("CUSTOMER", c.id, "2026-06-01", 500_000, "2026-06-01T00:00:00Z");
    const s = await get("customers", c.id);
    expect(s.rows.map((r) => [r.kind, r.date, r.balanceP])).toEqual([
      ["OPENING", "2026-06-01", 500_000],
      ["INVOICE", "2026-03-01", 540_000],
    ]);
    expect(s.rows[0]).toMatchObject({ ref: "OPENING", description: "Opening balance", debitP: 500_000, creditP: 0 });
    expect(s.closing).toBe(540_000);
  });

  it("…and with a `from`, opening + Σ rows = closing still holds (the legacy's own `opening` figure was inconsistent there)", async () => {
    const c = await h.seed.customer();
    await h.seed.invoice(c.id, { date: "2026-03-01", totalP: 40_000 });
    await postOpening("CUSTOMER", c.id, "2026-06-01", 500_000, "2026-06-01T00:00:00Z");
    // from 2026-04-01: the March invoice is BEFORE the window (opening = 40,000), the June OPENING row is IN it
    const s = await get("customers", c.id, "?from=2026-04-01");
    expect(s.opening).toBe(40_000);
    expect(s.rows.map((r) => [r.kind, r.balanceP])).toEqual([["OPENING", 540_000]]);
    expect(s.closing).toBe(540_000);
    expect(s.opening + s.rows.reduce((a, r) => a + r.debitP - r.creditP, 0)).toBe(s.closing);
  });

  it("a SUPPLIER's OPENING row leads its own day (the legacy gave it no createdAt, so it sorted first in the day) but not the whole statement", async () => {
    const sup = await h.seed.supplier();
    const pur = await h.seed.purchase(sup.id, { date: "2026-05-05", totalP: 70_000 });
    await postOpening("SUPPLIER", sup.id, "2026-05-05", 300_000, "2026-09-01T00:00:00Z"); // entered LATER than the purchase
    const early = await h.seed.purchase(sup.id, { date: "2026-05-01", totalP: 10_000 });
    const s = await get("suppliers", sup.id);
    expect(s.rows.map((r) => [r.kind, r.date, r.balanceP])).toEqual([
      ["PURCHASE", "2026-05-01", 10_000],
      ["OPENING", "2026-05-05", 310_000],
      ["PURCHASE", "2026-05-05", 380_000],
    ]);
    expect(s.rows[0]!.source.id).toBe(early.id);
    expect(s.rows[2]!.source.id).toBe(pur.id);
  });
});

describe("reversed vouchers", () => {
  it("a REVERSED payment is omitted with its reversal, `omittedReversed` counts it, and the balance is untouched", async () => {
    const c = await h.seed.customer();
    await h.seed.invoice(c.id, { date: "2026-03-01", totalP: 100_000 });
    h.clock.current = new Date("2026-03-05T06:00:00Z");
    const kept = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 20_000, date: "2026-03-02" } })).body;
    const gone = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 30_000, date: "2026-03-03" } })).body;
    expect((await h.request(owner, "POST", `/payments/${gone.id}/reverse`, { body: { reason: "wrong shop" } })).status).toBe(200);
    // the journal DOES hold both entries of the reversed voucher …
    const [n] = await h.admin`SELECT count(*)::int AS n FROM journal_entries WHERE source_id = ${gone.id}`;
    expect(n!.n).toBe(2);
    // … the statement shows neither
    const s = await get("customers", c.id);
    expect(s.rows.map((r) => r.ref)).toEqual([expect.stringMatching(/^INV-/), kept.receiptNumber]);
    expect(s.omittedReversed).toBe(1);
    expect(s.closing).toBe(80_000); // 100,000 − 20,000; the reversed 30,000 cancels out
    expect(s.rows.some((r) => r.ref === gone.receiptNumber)).toBe(false);
  });

  it("`omittedReversed` counts only vouchers inside the window", async () => {
    const c = await h.seed.customer();
    const a = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 1_000, date: "2026-01-10" } })).body;
    const b = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 2_000, date: "2026-02-10" } })).body;
    for (const p of [a, b]) await h.request(owner, "POST", `/payments/${p.id}/reverse`, { body: { reason: "test" } });
    expect((await get("customers", c.id)).omittedReversed).toBe(2);
    expect((await get("customers", c.id, "?from=2026-02-01")).omittedReversed).toBe(1);
    expect((await get("customers", c.id, "?from=2026-01-01&to=2026-01-31")).omittedReversed).toBe(1);
    expect((await get("customers", c.id, "?from=2026-03-01")).omittedReversed).toBe(0);
  });

  it("a supplier's reversed payment is omitted the same way", async () => {
    const sup = await h.seed.supplier();
    await h.seed.purchase(sup.id, { date: "2026-03-01", totalP: 90_000 });
    const p = (await h.request(owner, "POST", "/payments/pay", { body: { supplierId: sup.id, amountP: 40_000, date: "2026-03-02" } })).body;
    await h.request(owner, "POST", `/payments/${p.id}/reverse`, { body: { reason: "duplicate" } });
    const s = await get("suppliers", sup.id);
    expect(s.rows.map((r) => r.kind)).toEqual(["PURCHASE"]);
    expect(s.omittedReversed).toBe(1);
    expect(s.closing).toBe(90_000);
  });

  it("a reversed ADJUSTMENT (and its reversal entry) is omitted and counted too", async () => {
    const c = await h.seed.customer();
    const [adj] = await h.db
      .insert(accountAdjustments)
      .values({ adjustmentNumber: `ACC-T-${randomUUID().slice(0, 6)}`, customerId: c.id, date: "2026-03-04", direction: "DEBIT", amountP: 9_900, reason: "entered twice", status: "REVERSED" })
      .returning();
    await h.db.transaction(async (tx) => {
      const acc = await loadAccountIds(tx);
      const lines = [custLine(c.id, 9_900, 0), plainLine("ACCOUNT_ADJUSTMENTS", 0, 9_900)];
      await postJournalEntry(tx, acc, { date: "2026-03-04", memo: "Adjustment", sourceType: "ADJUSTMENT", sourceId: adj!.id, createdBy: null, lines });
      await postJournalEntry(tx, acc, { date: "2026-03-04", memo: "Reversal", sourceType: "ADJUSTMENT_REVERSAL", sourceId: adj!.id, createdBy: null, lines: reversedLines(lines) });
    });
    const s = await get("customers", c.id);
    expect(s.rows).toEqual([]);
    expect(s.omittedReversed).toBe(1);
    expect(s.closing).toBe(0);
  });
});

describe("an edited voucher is one row at its current amount", () => {
  it("editAmount rewrites the voucher's single entry — the statement never shows the old figure or two rows", async () => {
    const c = await h.seed.customer();
    const refund = (await h.request(owner, "POST", "/payments/refund", { body: { customerId: c.id, amountP: 8_000, date: "2026-03-05" } })).body;
    expect((await h.request(owner, "POST", `/payments/${refund.id}/edit-amount`, { body: { amountP: 6_500, reason: "typo" } })).status).toBe(200);
    const s = await get("customers", c.id);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ kind: "REFUND", ref: refund.receiptNumber, debitP: 6_500, creditP: 0, balanceP: 6_500 });
    expect(s.closing).toBe(6_500);
  });
});

describe("row wording (the legacy Ledger's) and kinds", () => {
  it("names the method on payments, refunds and supplier payments; documents carry their numbers", async () => {
    const c = await h.seed.customer();
    const inv = await h.seed.invoice(c.id, { date: "2026-03-01", number: "INV-T-100", totalP: 50_000 });
    const rec = (await h.request(owner, "POST", "/payments/receive", { body: { customerId: c.id, amountP: 10_000, method: "Bank Transfer", date: "2026-03-02" } })).body;
    const ref = (await h.request(owner, "POST", "/payments/refund", { body: { customerId: c.id, amountP: 1_000, method: "Cash", date: "2026-03-03" } })).body;
    const s = await get("customers", c.id);
    expect(s.rows.map((r) => [r.kind, r.ref, r.description, r.debitP, r.creditP, r.source.type])).toEqual([
      ["INVOICE", "INV-T-100", "Sales invoice", 50_000, 0, "INVOICE"],
      ["PAYMENT", rec.receiptNumber, "Payment received — Bank Transfer", 0, 10_000, "PAYMENT"],
      ["REFUND", ref.receiptNumber, "Refund paid — Cash", 1_000, 0, "PAYMENT"],
    ]);
    expect(s.rows[0]!.source.id).toBe(inv.id);

    const sup = await h.seed.supplier();
    await h.seed.purchase(sup.id, { date: "2026-03-01", number: "PUR-T-100", totalP: 80_000 });
    const paid = (await h.request(owner, "POST", "/payments/pay", { body: { supplierId: sup.id, amountP: 30_000, method: "JazzCash", date: "2026-03-02" } })).body;
    const ss = await get("suppliers", sup.id);
    expect(ss.rows.map((r) => [r.kind, r.ref, r.description, r.debitP, r.creditP])).toEqual([
      ["PURCHASE", "PUR-T-100", "Purchase invoice", 0, 80_000],
      ["PAYMENT", paid.receiptNumber, "Payment made — JazzCash", 30_000, 0],
    ]);
    expect(ss.closing).toBe(50_000);
  });

  it("a document type a later module posts is shown by its journal memo (kind OTHER), not hidden", async () => {
    const c = await h.seed.customer();
    await h.db.transaction(async (tx) => {
      const acc = await loadAccountIds(tx);
      await postJournalEntry(tx, acc, { date: "2026-03-09", memo: "Stock write-off", sourceType: "SOMETHING_NEW", sourceId: randomUUID(), createdBy: null, lines: [custLine(c.id, 700, 0), plainLine("SALES", 0, 700)] });
    });
    const s = await get("customers", c.id);
    expect(s.rows).toMatchObject([{ kind: "OTHER", ref: "", description: "Stock write-off", debitP: 700, balanceP: 700 }]);
  });

  it("the party block: name, owner, region (اردو — English), phone, legacy code", async () => {
    const [reg] = await h.db.insert(regions).values({ nameEn: "Drosh", nameUr: "دروش" }).returning();
    const [c] = await h.db.insert(customers).values({ shopName: "Al Noor", ownerName: "Noor", phone: "0300-1112223", regionId: reg!.id, legacyCode: "C77" }).returning();
    const [sup] = await h.db.insert(suppliers).values({ companyName: "Sunrise", phone: "0311", legacyDoc: { cp: "Mr Tariq", legacyCode: "S9" } }).returning();
    expect((await get("customers", c!.id)).party).toEqual({ type: "CUSTOMER", id: c!.id, name: "Al Noor", owner: "Noor", region: "دروش — Drosh", phone: "0300-1112223", legacyCode: "C77" });
    expect((await get("suppliers", sup!.id)).party).toEqual({ type: "SUPPLIER", id: sup!.id, name: "Sunrise", owner: "Mr Tariq", region: null, phone: "0311", legacyCode: "S9" });
  });

  it("an empty statement: no rows, zero everything", async () => {
    const c = await h.seed.customer();
    expect(await get("customers", c.id)).toMatchObject({ opening: 0, rows: [], totals: { debitP: 0, creditP: 0 }, closing: 0, omittedReversed: 0, from: null, to: null });
  });
});

describe("window and errors", () => {
  it("`from` / `to` are inclusive; opening is everything before `from`; rows after `to` are left out", async () => {
    const c = await h.seed.customer();
    for (const [d, amt] of [["2026-01-10", 1_000], ["2026-02-10", 2_000], ["2026-03-10", 4_000], ["2026-04-10", 8_000]] as const) await h.seed.invoice(c.id, { date: d, totalP: amt });
    const s = await get("customers", c.id, "?from=2026-02-10&to=2026-03-10");
    expect(s.opening).toBe(1_000);
    expect(s.rows.map((r) => [r.date, r.balanceP])).toEqual([["2026-02-10", 3_000], ["2026-03-10", 7_000]]);
    expect(s.closing).toBe(7_000); // through `to`, not the 15,000 of the whole history
    expect(s.totals).toEqual({ debitP: 6_000, creditP: 0 });
    expect(s).toMatchObject({ from: "2026-02-10", to: "2026-03-10" });
  });

  it("From after To is refused in words, not answered with an empty statement", async () => {
    const c = await h.seed.customer();
    const res = await h.request(owner, "GET", `/customers/${c.id}/statement?from=2026-05-01&to=2026-04-01`);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ message: "The “From” date is after the “To” date.", errors: ["The “From” date is after the “To” date."] });
  });

  it("unknown / malformed party → 404 in the shop / supplier wording; bad date or unknown parameter → 422", async () => {
    const ghost = "00000000-0000-4000-8000-000000000000";
    expect((await h.request(owner, "GET", `/customers/${ghost}/statement`)).body).toEqual({ message: "Shop not found.", errors: ["Shop not found."] });
    expect((await h.request(owner, "GET", `/suppliers/${ghost}/statement`)).status).toBe(404);
    expect((await h.request(owner, "GET", `/suppliers/not-a-uuid/statement`)).body.message).toBe("Supplier not found.");
    const c = await h.seed.customer();
    expect((await h.request(owner, "GET", `/customers/${c.id}/statement?from=2026-02-30`)).status).toBe(422);
    expect((await h.request(owner, "GET", `/customers/${c.id}/statement?bogus=1`)).status).toBe(422);
    expect((await h.request(owner, "GET", `/customers/${c.id}/statement?from=&to=`)).status).toBe(200); // untouched form fields
  });

  it("the customer and supplier routes do not cross: a customer id is not a supplier statement", async () => {
    const c = await h.seed.customer();
    expect((await h.request(owner, "GET", `/suppliers/${c.id}/statement`)).status).toBe(404);
  });
});

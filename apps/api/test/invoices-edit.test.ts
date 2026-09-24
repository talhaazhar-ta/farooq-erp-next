import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customers, products } from "@farooq/db";
import { ROLE_PERMISSIONS } from "@farooq/shared";
import { createHarness, customerBalanceSql, entriesFor, type Harness, type Session } from "./helpers/harness.js";
import { editBody, get, invBody, levelOf, mkPosted, movementSum, movementsOf, newKey, post, put, scenario, seedProduct, seedStock, type Scenario } from "./helpers/invoices.js";

/**
 * Editing a POSTED invoice — a net correction (owner decision 3): stock and the shop's balance move by the DIFFERENCE, in
 * one transaction. The legacy reversed everything and deducted again; the net is the same except for migrated invoices.
 * Hand-computed: the base invoice is 10 bags × Rs 2,000 = 2,000,000 paisa, 500,000 paid, on a godown holding 100 bags.
 */
let h: Harness;
let owner: Session;
let sales: Session;
let accountant: Session;
let manager: Session;
beforeAll(async () => {
  h = await createHarness();
  owner = await h.session("OWNER");
  sales = await h.session("SALES");
  accountant = await h.session("ACCOUNTANT");
  manager = await h.session("MANAGER");
});
afterAll(async () => {
  await h.close();
});

const auditActions = async (id: string) => (await h.admin`SELECT action FROM audit_log WHERE entity_id = ${id} AND entity = 'Invoice' ORDER BY at, id`).map((a) => a.action);

describe("edit posted — stock and balance move by the difference", () => {
  it("UP: 10 → 14 bags at the same rate: one SALE_OUT of the 4 extra bags, the ONE journal entry rewritten to 2,800,000", async () => {
    const s = await scenario(h, { stock: 100 });
    const inv = await mkPosted(h, owner, s, { paidAmountP: 500_000 });
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(90_000);

    const r = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 14, unitPriceP: 200_000 }]));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ totalP: 2_800_000, subtotalP: 2_800_000, paidP: 500_000, balanceP: 2_300_000, status: "PARTIALLY_PAID", revision: 2, number: inv.number, previousBalanceP: 0, stockApplied: true });
    expect(r.body.lines[0]).toMatchObject({ id: inv.lines[0].id, quantity: 14, lineTotalP: 2_800_000 });

    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(86_000);
    expect(await movementSum(h, s.product.id, s.wh.id)).toBe(86_000);
    expect((await movementsOf(h, inv.id)).map((m) => [m.kind, m.refType, m.q, m.ref, m.date])).toEqual([
      ["SALE_OUT", "INVOICE", -10_000, inv.number, "2026-03-05"],
      ["SALE_OUT", "INVOICE_EDIT", -4_000, inv.number, "2026-03-05"], // only the difference — not 10 back and 14 out
    ]);
    const entries = await entriesFor(h.admin, "INVOICE", inv.id);
    expect(entries).toHaveLength(1); // rewritten in place, not a second entry
    expect(entries[0]!.lines.map((l) => [l.code, l.debit, l.credit])).toEqual([
      ["RECEIVABLES", 2_800_000, 0],
      ["SALES", 0, 2_800_000],
    ]);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(2_800_000 - 500_000);
    expect(await auditActions(inv.id)).toEqual(["Invoice created", "Invoice edited"]);
    const [a] = await h.admin`SELECT before, after FROM audit_log WHERE entity_id = ${inv.id} AND action = 'Invoice edited'`;
    expect(a!.before).toEqual({ grandTotal: 2_000_000, lineCount: 1, status: "PARTIALLY_PAID" });
    expect(a!.after).toMatchObject({ grandTotal: 2_800_000, lineCount: 1, status: "PARTIALLY_PAID" });
  });

  it("DOWN: 10 → 6 bags: 4 bags come back as SALE_REVERSAL_IN / INVOICE_EDIT and the total falls to 1,200,000", async () => {
    const s = await scenario(h, { stock: 100 });
    const inv = await mkPosted(h, owner, s, { paidAmountP: 500_000 });
    const r = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 6, unitPriceP: 200_000 }]));
    expect(r.body).toMatchObject({ totalP: 1_200_000, balanceP: 700_000 });
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(94_000);
    expect((await movementsOf(h, inv.id)).map((m) => [m.kind, m.refType, m.q])).toEqual([
      ["SALE_OUT", "INVOICE", -10_000],
      ["SALE_REVERSAL_IN", "INVOICE_EDIT", 4_000],
    ]);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(1_200_000 - 500_000);
  });

  it("the difference is worked out per PRODUCT × GODOWN, not per line: 5 + 5 → 3 + 7 moves nothing; a swapped product moves both", async () => {
    const s = await scenario(h, { stock: 100 });
    const other = await seedProduct(h, { buyP: 100 });
    await seedStock(h, other.id, s.wh.id, 50);
    const inv = await post(
      h,
      owner,
      invBody(s.shop.id, s.wh.id, [
        { productId: s.product.id, quantity: 5, unitPriceP: 10_000 },
        { productId: s.product.id, quantity: 5, unitPriceP: 10_000 },
      ]),
    );
    expect(inv.status).toBe(201);
    expect((await movementsOf(h, inv.body.id)).length).toBe(2); // one SALE_OUT per line on posting
    const [l1, l2] = inv.body.lines;
    const same = await put(
      h,
      owner,
      inv.body.id,
      editBody(inv.body, {}, [
        { id: l1.id, productId: s.product.id, quantity: 3, unitPriceP: 10_000 },
        { id: l2.id, productId: s.product.id, quantity: 7, unitPriceP: 10_000 },
      ]),
    );
    expect(same.status).toBe(200);
    expect((await movementsOf(h, inv.body.id)).length).toBe(2); // no movement: the pair's total did not change
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(90_000);

    // now the second line becomes ANOTHER product (7 bags): product 1 gets 7 back, the other goes out 7
    const swap = await put(
      h,
      owner,
      inv.body.id,
      editBody(same.body, {}, [
        { id: l1.id, productId: s.product.id, quantity: 3, unitPriceP: 10_000 },
        { id: l2.id, productId: other.id, quantity: 7, unitPriceP: 10_000 },
      ]),
    );
    expect(swap.status).toBe(200);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(97_000);
    expect(await levelOf(h, other.id, s.wh.id)).toBe(43_000);
    expect(await movementSum(h, s.product.id, s.wh.id)).toBe(97_000);
    expect(await movementSum(h, other.id, s.wh.id)).toBe(43_000);
    const edits = (await movementsOf(h, inv.body.id)).filter((m) => m.refType === "INVOICE_EDIT");
    expect(edits).toHaveLength(2);
    expect(edits.map((m) => [m.productId === s.product.id ? "orig" : "other", m.kind, m.q])).toEqual(
      expect.arrayContaining([
        ["orig", "SALE_REVERSAL_IN", 7_000],
        ["other", "SALE_OUT", -7_000],
      ]),
    );
  });

  it("the invoice's own previously deducted bags count as available again (legacy bug 5: an edit could not even re-save the same quantity when the godown was empty)", async () => {
    const s = await scenario(h, { stock: 12 });
    const inv = await mkPosted(h, owner, s, { qty: 10, unitPriceP: 1_000 }); // godown now holds 2
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(2_000);
    const ok = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 12, unitPriceP: 1_000 }]));
    expect(ok.status).toBe(200); // 2 free + 10 already out = 12 available
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(0);
    const tooMany = await put(h, owner, inv.id, editBody(ok.body, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 13, unitPriceP: 1_000 }]));
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.errors).toEqual([`Only 12 bags of ${s.product.nameEn} are available in ${s.wh.name}. Requested: 13.`]);
    // and saving with no change at all on an emptied godown works
    const same = await put(h, owner, inv.id, editBody(ok.body));
    expect(same.status).toBe(200);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(0);
  });

  it("changing the invoice date moves its journal entry and its edit movements to the new date", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 4, unitPriceP: 10_000 });
    const r = await put(h, owner, inv.id, editBody(inv, { date: "2026-02-10" }, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 5, unitPriceP: 10_000 }]));
    expect(r.body.date).toBe("2026-02-10");
    expect((await entriesFor(h.admin, "INVOICE", inv.id))[0]).toMatchObject({ date: "2026-02-10" });
    expect((await movementsOf(h, inv.id)).find((m) => m.refType === "INVOICE_EDIT")).toMatchObject({ date: "2026-02-10", q: -1_000 });
  });

  it("previous_balance_p is frozen when the invoice is edited (only Change shop recomputes it)", async () => {
    const s = await scenario(h);
    await h.seed.invoice(s.shop.id, { totalP: 100_000 });
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 50_000 });
    expect(inv.previousBalanceP).toBe(100_000);
    await h.seed.invoice(s.shop.id, { totalP: 999_000 }); // the balance moves on
    const r = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 2, unitPriceP: 50_000 }]));
    expect(r.body.previousBalanceP).toBe(100_000);
  });

  it("every save re-takes the snapshots: the shop's new name and the product's new list cost (legacy customerFields / snapshotItem run on each save)", async () => {
    const s = await scenario(h, { buyP: 240_000 });
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 50_000 });
    expect(inv.shop.shopName).toBe(s.shop.shopName);
    await h.db.update(customers).set({ shopName: "Renamed Shop" }).where(eq(customers.id, s.shop.id));
    await h.db.update(products).set({ buyP: 260_000 }).where(eq(products.id, s.product.id));
    const r = await put(h, owner, inv.id, editBody(inv));
    expect(r.body.shop.shopName).toBe("Renamed Shop");
    expect(r.body.lines[0].costSnapshotP).toBe(260_000);
  });

  it("lines that stay keep their ids; a line dropped is deleted; a new line is added", async () => {
    const s = await scenario(h);
    const p2 = await seedProduct(h, { buyP: 1 });
    await seedStock(h, p2.id, s.wh.id, 30);
    const inv = await post(
      h,
      owner,
      invBody(s.shop.id, s.wh.id, [
        { productId: s.product.id, quantity: 1, unitPriceP: 1_000 },
        { productId: p2.id, quantity: 1, unitPriceP: 2_000 },
      ]),
    );
    const [a, b] = inv.body.lines;
    const p3 = await seedProduct(h, { buyP: 1 });
    await seedStock(h, p3.id, s.wh.id, 30);
    const r = await put(
      h,
      owner,
      inv.body.id,
      editBody(inv.body, {}, [
        { id: b.id, productId: p2.id, quantity: 1, unitPriceP: 2_000 },
        { productId: p3.id, quantity: 2, unitPriceP: 500 },
      ]),
    );
    expect(r.body.lines.map((l: any) => l.productId)).toEqual([p2.id, p3.id]);
    expect(r.body.lines[0].id).toBe(b.id);
    expect(r.body.lines.some((l: any) => l.id === a.id)).toBe(false);
    expect(r.body.totalP).toBe(3_000);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(100_000); // line a's bag came back
    expect(await levelOf(h, p3.id, s.wh.id)).toBe(28_000);
  });
});

describe("edit posted — the money taken with the sale", () => {
  it("raising 'paid' takes an EXTRA receipt for the difference only (legacy), through the same receive path; status follows", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { paidAmountP: 500_000 });
    const r = await put(h, owner, inv.id, editBody(inv, { paidAmountP: 2_000_000 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paidP: 2_000_000, balanceP: 0, status: "PAID", paymentStatus: "PAID" });
    expect(r.body.receipts.map((x: any) => x.allocatedP)).toEqual([500_000, 1_500_000]);
    const notes = await h.admin`SELECT note FROM payments WHERE id = ${r.body.receipts[1].paymentId}`;
    expect(notes[0]!.note).toBe(`Received with invoice ${inv.number}`);
    expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(0);
  });

  it("leaving 'paid' out keeps what was received: an edit that changes only the lines takes no new receipt", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { paidAmountP: 500_000 });
    const r = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 12, unitPriceP: 200_000 }]));
    expect(r.body.receipts).toHaveLength(1);
    expect(r.body).toMatchObject({ paidP: 500_000, totalP: 2_400_000 });
  });

  it("lowering 'paid' below what is allocated is REFUSED and names the receipt (the legacy silently let the two disagree)", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { paidAmountP: 500_000 });
    const r = await put(h, owner, inv.id, editBody(inv, { paidAmountP: 100_000 }));
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual([`The amount paid is less than the money already received on this invoice (${inv.receipts[0].receiptNumber}). Reverse the receipt first, then change the amount paid.`]);
    expect((await get(h, owner, inv.id)).body).toMatchObject({ paidP: 500_000, revision: 1 });
  });

  it("after the receipt is reversed, 'paid' can go to 0", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { paidAmountP: 500_000 });
    expect((await h.request(owner, "POST", `/payments/${inv.receipts[0].paymentId}/reverse`, { body: { reason: "wrong" } })).status).toBe(200);
    const r = await put(h, owner, inv.id, editBody(inv, { paidAmountP: 0 }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ paidP: 0, status: "CONFIRMED" });
  });

  it("shrinking the total below what was already received is refused with the overpay message", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { paidAmountP: 500_000 });
    const r = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 2, unitPriceP: 200_000 }])); // total 400,000 < 500,000 received
    expect(r.status).toBe(422);
    expect(r.body.errors).toContain("The amount paid is more than the invoice total. Record the extra as a separate payment on account.");
  });

  it("the extra receipt needs PAYMENT_CREATE on top of the edit permission — refused whole (403), nothing written", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { paidAmountP: 100_000 });
    const held = ROLE_PERMISSIONS.MANAGER;
    const at = held.indexOf("PAYMENT_CREATE");
    held.splice(at, 1); // the matrix gives every role that can sell PAYMENT_CREATE; take it away from one to prove the check
    try {
      const r = await put(h, manager, inv.id, editBody(inv, { paidAmountP: 300_000 }));
      expect(r.status).toBe(403);
      expect(r.body.message).toBe("You do not have permission to take payment. Clear the amount paid, or ask someone who can record payments.");
      expect(await customerBalanceSql(h.admin, s.shop.id)).toBe(2_000_000 - 100_000);
      // the same manager can still edit WITHOUT changing the payment
      expect((await put(h, manager, inv.id, editBody(inv))).status).toBe(200);
    } finally {
      held.splice(at, 0, "PAYMENT_CREATE");
    }
  });

  it("the same for taking money on a new invoice", async () => {
    const s = await scenario(h);
    const held = ROLE_PERMISSIONS.SALES;
    const at = held.indexOf("PAYMENT_CREATE");
    held.splice(at, 1);
    try {
      const line = { productId: s.product.id, quantity: 1, unitPriceP: 1_000 };
      const refused = await post(h, sales, invBody(s.shop.id, s.wh.id, [line], { paidAmountP: 500 }));
      expect(refused.status).toBe(403);
      expect((await h.admin`SELECT COUNT(*)::int AS c FROM invoices WHERE customer_id = ${s.shop.id}`)[0]!.c).toBe(0);
      expect((await post(h, sales, invBody(s.shop.id, s.wh.id, [line]))).status).toBe(201);
    } finally {
      held.splice(at, 0, "PAYMENT_CREATE");
    }
  });
});

describe("edit posted — what is refused (each says what to do next)", () => {
  it("a cancelled invoice: the legacy wording", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    expect((await h.request(owner, "POST", `/invoices/${inv.id}/cancel`, { body: { reason: "x" } })).status).toBe(200);
    const r = await put(h, owner, inv.id, editBody(inv));
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual(["A cancelled invoice cannot be edited. Duplicate it instead."]);
  });

  it("a non-cancelled return exists: refused, names the return, and nothing changes", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 4, unitPriceP: 10_000 });
    await h.seed.customerReturn(s.shop.id, inv.id, { totalP: 10_000, number: "CR-77" });
    const r = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 5, unitPriceP: 10_000 }]));
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toContain("A return has been posted against this invoice (CR-77), so it can no longer be edited");
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(96_000);
  });

  it("a CANCELLED return does not block the edit", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 4, unitPriceP: 10_000 });
    await h.seed.customerReturn(s.shop.id, inv.id, { totalP: 10_000, number: "CR-78", status: "CANCELLED" });
    expect((await put(h, owner, inv.id, editBody(inv))).status).toBe(200);
  });

  it("a dispatched invoice (status DISPATCHED, or a dispatch note number) is refused", async () => {
    const s = await scenario(h);
    const a = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    await h.admin`UPDATE invoices SET dispatch_number = 'DSP-2026-000001' WHERE id = ${a.id}`;
    const ra = await put(h, owner, a.id, editBody(a));
    expect(ra.status).toBe(422);
    expect(ra.body.errors[0]).toContain("has been dispatched (dispatch note DSP-2026-000001), so it can no longer be edited");
    const b = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    await h.admin`UPDATE invoices SET status = 'DISPATCHED' WHERE id = ${b.id}`;
    expect((await put(h, owner, b.id, editBody(b))).body.errors[0]).toContain("has been dispatched");
  });

  it("a different shop: the legacy wording pointing to Change shop", async () => {
    const s = await scenario(h);
    const other = await h.seed.customer();
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    const r = await put(h, owner, inv.id, editBody(inv, { customerId: other.id }));
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual(['The shop on a posted invoice cannot be changed while editing it. Use "Change shop" on the invoice, which moves its payments with it.']);
    expect((await get(h, owner, inv.id)).body.customerId).toBe(s.shop.id);
  });

  it("a posted invoice can NEVER go back to a draft", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    const r = await put(h, owner, inv.id, editBody(inv, { mode: "draft" }));
    expect(r.status).toBe(422);
    expect(r.body.errors).toEqual(["A posted invoice cannot be turned back into a draft. Save your changes as a posted invoice, or cancel the invoice."]);
    expect((await get(h, owner, inv.id)).body.status).toBe("CONFIRMED");
  });

  it("stale edit: the revision must be the one the client loaded", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    const first = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 2, unitPriceP: 1_000 }]));
    expect(first.status).toBe(200);
    const again = await put(h, owner, inv.id, editBody(inv, {}, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 3, unitPriceP: 1_000 }])); // still carries revision 1
    expect(again.status).toBe(422);
    expect(again.body.message).toBe("This invoice was changed by someone else since you opened it. Reload it and make your change again.");
    expect((await get(h, owner, inv.id)).body.totalP).toBe(2_000);
    const noRevision: Record<string, unknown> = { ...editBody(first.body) };
    delete noRevision.revision;
    expect((await put(h, owner, inv.id, noRevision)).body.message).toContain("Reload the invoice and try again");
  });

  it("a line id that is not this invoice's is refused", async () => {
    const s = await scenario(h);
    const a = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    const b = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    const r = await put(h, owner, a.id, editBody(a, {}, [{ id: b.lines[0].id, productId: s.product.id, quantity: 1, unitPriceP: 1_000 }]));
    expect(r.status).toBe(422);
    expect(r.body.errors[0]).toBe("Line 1: that line does not belong to this invoice. Reload the invoice and try again.");
  });

  it("an unknown invoice is a 404", async () => {
    const s = await scenario(h);
    const r = await put(h, owner, "00000000-0000-4000-8000-000000000000", { ...invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1 }]), revision: 1 });
    expect(r.status).toBe(404);
    expect(r.body.message).toBe("Invoice not found.");
  });

  it("a repeated PUT with the same idempotency key does not take the money or move the stock twice", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s);
    const key = newKey();
    const body = editBody(inv, { paidAmountP: 300_000, idempotencyKey: key }, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 11, unitPriceP: 200_000 }]);
    const a = await put(h, owner, inv.id, body);
    const b = await put(h, owner, inv.id, body); // same revision AND same key: a replay, not a stale edit
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.revision).toBe(a.body.revision);
    expect(b.body.receipts).toHaveLength(1);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(89_000);
  });
});

describe("edit posted — who may", () => {
  it("SALES holds SALES_CREATE but not TRANSACTION_CORRECT: 403 on a posted invoice, yet it may edit a draft and post it", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    expect((await put(h, sales, inv.id, editBody(inv))).status).toBe(403);
    const d = await post(h, sales, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
    const posted = await put(h, sales, d.body.id, editBody(d.body));
    expect(posted.status).toBe(200);
    expect(posted.body.status).toBe("CONFIRMED");
  });

  it("ACCOUNTANT holds TRANSACTION_CORRECT and PAYMENT_CREATE but not SALES_CREATE: may correct a posted invoice, may not create or post one", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 1_000 });
    const fixed = await put(h, accountant, inv.id, editBody(inv, { paidAmountP: 400 }, [{ id: inv.lines[0].id, productId: s.product.id, quantity: 2, unitPriceP: 1_000 }]));
    expect(fixed.status).toBe(200);
    expect(fixed.body).toMatchObject({ totalP: 2_000, paidP: 400 });
    expect((await post(h, accountant, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }]))).status).toBe(403);
    const draft = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
    expect((await put(h, accountant, draft.body.id, editBody(draft.body))).status).toBe(403); // posting a draft is SALES_CREATE
  });
});

/** A posted invoice the way the importer leaves one: header + line + journal entry, `migrated` (the old app's data migration) and no movement. */
async function migrated(s: Scenario, qty = 4, unitPriceP = 10_000) {
  const total = qty * unitPriceP;
  const inv = await h.seed.invoice(s.shop.id, { totalP: total, number: `INV-MIG-${Date.now().toString(36)}` });
  await h.admin`UPDATE invoices SET migrated = true, stock_applied = true, warehouse_id = ${s.wh.id}, subtotal_p = ${total}, total_qty_milli = ${qty * 1000}, line_count = 1, revision = 3 WHERE id = ${inv.id}`;
  await h.admin`INSERT INTO invoice_items (invoice_id, product_id, warehouse_id, qty_milli, unit_price_p, line_total_p, sort_order) VALUES (${inv.id}, ${s.product.id}, ${s.wh.id}, ${qty * 1000}, ${unitPriceP}, ${total}, 0)`;
  return inv;
}

describe("edit posted — a MIGRATED invoice has no movements, so it never gets stock back", () => {
  it("edit: totals and journal change, NO stock movement is written and the godown is untouched", async () => {
    const s = await scenario(h, { stock: 50 });
    const inv = await migrated(s);
    const before = await get(h, owner, inv.id);
    expect(before.body).toMatchObject({ migrated: true, stockApplied: true });
    const r = await put(h, owner, inv.id, editBody(before.body, {}, [{ id: before.body.lines[0].id, productId: s.product.id, quantity: 9, unitPriceP: 10_000 }]));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ totalP: 90_000, migrated: true, stockApplied: true, revision: 4 });
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(50_000);
    expect(await movementsOf(h, inv.id)).toEqual([]);
    expect((await entriesFor(h.admin, "INVOICE", inv.id))[0]!.lines[0]!.debit).toBe(90_000);
  });

  it("stock is not checked for a migrated invoice (no bags leave the godown)", async () => {
    const s = await scenario(h, { stock: 1 });
    const inv = await migrated(s);
    const before = await get(h, owner, inv.id);
    const r = await put(h, owner, inv.id, editBody(before.body, {}, [{ id: before.body.lines[0].id, productId: s.product.id, quantity: 500, unitPriceP: 10_000 }]));
    expect(r.status).toBe(200);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(1_000);
  });
});

describe("edit posted — an invoice that came in through the importer (created_by null, imported lines) edits like any other", () => {
  it("an imported posted invoice with its SALE_OUT movement: raising the quantity posts only the difference", async () => {
    const s = await scenario(h, { stock: 100 });
    const inv = await h.seed.invoice(s.shop.id, { totalP: 40_000, number: `INV-IMP-${Date.now().toString(36)}` });
    await h.admin`UPDATE invoices SET stock_applied = true, warehouse_id = ${s.wh.id}, subtotal_p = 40000, total_qty_milli = 4000, line_count = 1, revision = 2 WHERE id = ${inv.id}`;
    await h.admin`INSERT INTO invoice_items (invoice_id, product_id, warehouse_id, qty_milli, unit_price_p, line_total_p, sort_order) VALUES (${inv.id}, ${s.product.id}, ${s.wh.id}, 4000, 10000, 40000, 0)`;
    await h.admin`INSERT INTO stock_movements (date, product_id, warehouse_id, kind, bucket, qty_delta_milli, ref, ref_type, source_type, source_id) VALUES ('2026-02-01', ${s.product.id}, ${s.wh.id}, 'SALE_OUT', 'stock', -4000, 'x', 'INVOICE', 'INVOICE', ${inv.id})`;
    await h.admin`UPDATE stock_levels SET qty_milli = qty_milli - 4000 WHERE product_id = ${s.product.id} AND warehouse_id = ${s.wh.id}`;
    const cur = (await get(h, owner, inv.id)).body;
    const r = await put(h, owner, inv.id, editBody(cur, {}, [{ id: cur.lines[0].id, productId: s.product.id, quantity: 6, unitPriceP: 10_000 }]));
    expect(r.status).toBe(200);
    expect(await levelOf(h, s.product.id, s.wh.id)).toBe(94_000);
    expect(await movementSum(h, s.product.id, s.wh.id)).toBe(94_000);
    expect(r.body.totalP).toBe(60_000);
  });
});

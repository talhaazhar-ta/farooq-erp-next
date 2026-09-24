import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { outstandingDocumentSchema, statementSchema, type Statement } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { cancel, invBody, mkPosted, post, scenario, seedProduct, seedStock } from "./helpers/invoices.js";

/**
 * Statement detail (S8, legacy 24-client-changes.js): an invoice row says what the invoice was for and how many bags — ADDITIVELY
 * (`description` keeps the ledger's wording, no amount or balance moves) — and the Receive panel's outstanding invoices carry the
 * same one-line summary. Every string below is worked out by hand from the legacy `Desc.fromLines` / `qtyOf` / `qtyLabel`.
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

const statementOf = async (customerId: string): Promise<Statement> => {
  const res = await h.request(owner, "GET", `/customers/${customerId}/statement`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return statementSchema.parse(res.body);
};

async function withProducts(specs: { nameEn: string; nameUr?: string; weightKg: number }[]) {
  const s = await scenario(h, { stock: 1000, productOpts: specs[0]! });
  const rest: Awaited<ReturnType<typeof seedProduct>>[] = [];
  for (const spec of specs.slice(1)) {
    const p = await seedProduct(h, spec);
    await seedStock(h, p.id, s.wh.id, 1000);
    rest.push(p);
  }
  return { s, products: [s.product, ...rest] };
}

describe("an invoice row's detail and quantity", () => {
  it("one line: 'N × Name pack @ PKR rate' (the legacy one-line summary), its bags, and the ledger's own description untouched", async () => {
    const { s } = await withProducts([{ nameEn: "Zam Zam Atta", nameUr: "زم زم آٹا", weightKg: 20 }]);
    const inv = await mkPosted(h, owner, s, { qty: 10, unitPriceP: 200_000 });
    const st = await statementOf(s.shop.id);
    const row = st.rows.find((r) => r.ref === inv.number)!;
    expect(row).toMatchObject({ kind: "INVOICE", description: "Sales invoice", debitP: 2_000_000, creditP: 0, balanceP: 2_000_000 });
    expect(row.detail).toBe("10 × Zam Zam Atta 20 KG @ PKR 2,000");
    expect(row.qtyInfo).toEqual({ total: 10, mixed: false });
    expect(row.qtyLabel).toBe("10");
    expect(st.closing).toBe(2_000_000);
  });

  it("a fractional quantity and a rate with paisa: '2.5 × … @ PKR 1,000.50'", async () => {
    const { s } = await withProducts([{ nameEn: "Delta Maida", weightKg: 50 }]);
    await mkPosted(h, owner, s, { qty: 2.5, unitPriceP: 100_050 });
    const row = (await statementOf(s.shop.id)).rows.find((r) => r.kind === "INVOICE")!;
    expect(row.detail).toBe("2.5 × Delta Maida 50 KG @ PKR 1,000.50");
    expect(row.qtyLabel).toBe("2.5");
  });

  it("what was typed on the invoice wins (cleaned: line breaks become spaces); the quantity is still shown", async () => {
    const { s, products } = await withProducts([{ nameEn: "Karim Chana", weightKg: 25 }]);
    const r = await post(h, owner, invBody(s.shop.id, s.wh.id, [{ productId: products[0]!.id, quantity: 4, unitPriceP: 50_000 }], { description: "Weekly stock\nfor the shop" }));
    expect(r.status).toBe(201);
    const row = (await statementOf(s.shop.id)).rows.find((x) => x.kind === "INVOICE")!;
    expect(row.detail).toBe("Weekly stock for the shop");
    expect(row.qtyLabel).toBe("4");
  });

  it("several lines: 'N items — X total qty'; the same package is one figure, different packages are labelled '(mixed units)'", async () => {
    const same = await withProducts([{ nameEn: "Sugar A", weightKg: 50 }, { nameEn: "Sugar B", weightKg: 50 }, { nameEn: "Sugar C", weightKg: 50 }]);
    await post(h, owner, invBody(same.s.shop.id, same.s.wh.id, [
      { productId: same.products[0]!.id, quantity: 200, unitPriceP: 10_000 },
      { productId: same.products[1]!.id, quantity: 250, unitPriceP: 10_000 },
      { productId: same.products[2]!.id, quantity: 50.5, unitPriceP: 10_000 },
    ]));
    const a = (await statementOf(same.s.shop.id)).rows.find((r) => r.kind === "INVOICE")!;
    expect(a.detail).toBe("3 items — 500.5 total qty");
    expect(a.qtyInfo).toEqual({ total: 500.5, mixed: false });
    expect(a.qtyLabel).toBe("500.5");

    const mixed = await withProducts([{ nameEn: "Rice 25", weightKg: 25 }, { nameEn: "Flour 50", weightKg: 50 }]);
    await post(h, owner, invBody(mixed.s.shop.id, mixed.s.wh.id, [
      { productId: mixed.products[0]!.id, quantity: 10, unitPriceP: 10_000 },
      { productId: mixed.products[1]!.id, quantity: 5, unitPriceP: 10_000 },
    ]));
    const b = (await statementOf(mixed.s.shop.id)).rows.find((r) => r.kind === "INVOICE")!;
    expect(b.detail).toBe("2 items — 15 total qty");
    expect(b.qtyInfo).toEqual({ total: 15, mixed: true });
    expect(b.qtyLabel).toBe("15 (mixed units)");
  });

  it("an imported invoice without lines falls back to 'Sale invoice <number>' and no quantity", async () => {
    const s = await scenario(h);
    const inv = await h.seed.invoice(s.shop.id, { totalP: 500_000, number: "INV-OLD-9001", date: "2026-02-01" });
    const row = (await statementOf(s.shop.id)).rows.find((r) => r.ref === inv.invoiceNumber)!;
    expect(row).toMatchObject({ description: "Sales invoice", detail: "Sale invoice INV-OLD-9001", qtyInfo: null, qtyLabel: "—" });
  });

  it("payment rows show no detail and no quantity — an em dash — and keep the description the S5 screens draw", async () => {
    const s = await scenario(h);
    await mkPosted(h, owner, s, { qty: 1, unitPriceP: 100_000 });
    const rec = await h.request(owner, "POST", "/payments/receive", { body: { customerId: s.shop.id, amountP: 40_000, method: "Cash" } });
    expect(rec.status).toBe(201);
    const pay = (await statementOf(s.shop.id)).rows.find((r) => r.kind === "PAYMENT")!;
    expect(pay).toMatchObject({ description: "Payment received — Cash", detail: null, qtyInfo: null, qtyLabel: "—", creditP: 40_000, balanceP: 60_000 });
  });

  it("a cancelled invoice is not on the statement (S7) — so it has no row to decorate; the closing balance is unchanged by any of this", async () => {
    const s = await scenario(h);
    const a = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 100_000 });
    const b = await mkPosted(h, owner, s, { qty: 1, unitPriceP: 70_000 });
    await cancel(h, owner, a.id);
    const st = await statementOf(s.shop.id);
    expect(st.rows.filter((r) => r.kind === "INVOICE").map((r) => r.ref)).toEqual([b.number]);
    expect(st.omittedCancelled).toBe(1);
    expect(st.closing).toBe(70_000);
  });
});

describe("an invoice and the receipt taken with it are never shown out of order", () => {
  it("the invoice row comes before its own sale receipt — every time (journal entries in one transaction no longer tie)", async () => {
    for (let k = 0; k < 6; k++) {
      const s = await scenario(h);
      const inv = await mkPosted(h, owner, s, { qty: 2, unitPriceP: 100_000, paidAmountP: 50_000 });
      const rows = (await statementOf(s.shop.id)).rows;
      expect(rows.map((r) => r.kind), `shop ${k}`).toEqual(["INVOICE", "PAYMENT"]);
      expect(rows.map((r) => r.balanceP)).toEqual([200_000, 150_000]);
      expect(rows[0]!.ref).toBe(inv.number);
    }
  });
});

describe("the Receive panel's outstanding invoices", () => {
  it("each carries the one-line summary of what it was for (the same wording as a statement row); purchases and lineless invoices have an empty one", async () => {
    const { s, products } = await withProducts([{ nameEn: "Taj Sella", weightKg: 25 }, { nameEn: "Tea Box", weightKg: 1 }]);
    const one = await mkPosted(h, owner, s, { qty: 20, unitPriceP: 270_000 });
    const two = await post(h, owner, invBody(s.shop.id, s.wh.id, [
      { productId: products[0]!.id, quantity: 3, unitPriceP: 10_000 },
      { productId: products[1]!.id, quantity: 4.5, unitPriceP: 20_000 },
    ], { date: "2026-03-01" }));
    const old = await h.seed.invoice(s.shop.id, { totalP: 90_000, number: "INV-OLD-9002", date: "2026-01-01" });
    const res = await h.request(owner, "GET", `/customers/${s.shop.id}/outstanding-invoices`);
    expect(res.status).toBe(200);
    const docs = (res.body as unknown[]).map((d) => outstandingDocumentSchema.parse(d));
    const byId = new Map(docs.map((d) => [d.id, d]));
    expect(byId.get(one.id)!.lineSummary).toBe("20 × Taj Sella 25 KG @ PKR 2,700");
    expect(byId.get(two.body.id)!.lineSummary).toBe("2 items — 7.5 total qty");
    expect(byId.get(old.id)!.lineSummary).toBe("");
    // nothing else about the rows changed: oldest first (1 Jan, 1 Mar, then today 5 Mar), the same figures
    expect(docs.map((d) => d.number)).toEqual([old.invoiceNumber, two.body.number, one.number]);
    expect(byId.get(one.id)).toMatchObject({ totalP: 5_400_000, paidP: 0, creditP: 0, outstandingP: 5_400_000 });
  });
});

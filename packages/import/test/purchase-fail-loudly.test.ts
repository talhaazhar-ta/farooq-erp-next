import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImportError, runImport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";

/**
 * S11: the importer never guesses about purchase lines, quantities, prices or numbers. Each of these aborts naming the store, the
 * document and the field — and leaves the database exactly as the previous good import left it.
 */
const sql = adminSql();

async function snapshot() {
  const [r] = await sql`
    SELECT (SELECT count(*) FROM purchases)::int AS purchases, (SELECT count(*) FROM purchase_items)::int AS items,
           (SELECT count(*) FROM stock_levels)::int AS levels, (SELECT count(*) FROM stock_movements)::int AS movements,
           (SELECT count(*) FROM journal_entries)::int AS entries, (SELECT count(*) FROM audit_log WHERE action = 'IMPORT')::int AS imports,
           (SELECT coalesce(sum(qty_milli), 0) FROM stock_levels)::text AS qty, (SELECT coalesce(sum(line_total_p), 0) FROM purchase_items)::text AS lines`;
  return { ...r };
}

let before: Awaited<ReturnType<typeof snapshot>>;
beforeAll(async () => {
  await runImport(fixture(), IMPORT_OPTS);
  before = await snapshot();
  expect(before).toMatchObject({ purchases: 4, items: 5, levels: 7, movements: 30 }); // a populated database, so "unchanged" is meaningful
});
afterAll(async () => {
  await sql.end();
});

const line = (b: any, id: string) => b.data.purchaseItems.find((i: any) => i.id === id);
const purchase = (b: any, id: string) => b.data.purchases.find((p: any) => p.id === id);

const cases: [name: string, backup: () => unknown, message: RegExp][] = [
  /* ── classification: nothing is dropped silently ── */
  ["an unclassified field on a purchase line", () => mutate((b) => { line(b, "pi-pur-1-1").mystery = 1; }), /Store 'purchaseItems' has an unclassified field 'mystery' \(on purchaseItems\[id=pi-pur-1-1\]\)/],
  ["an unclassified field on a purchase (the new header)", () => mutate((b) => { purchase(b, "pur-1").loyaltyPoints = 5; }), /Store 'purchases' has an unclassified field 'loyaltyPoints'/],

  /* ── references ── */
  ["a line on a purchase that is not in the backup", () => mutate((b) => { line(b, "pi-pur-1-1").purchaseId = "pur-ghost"; }), /purchaseItems\[id=pi-pur-1-1\]\.purchaseId: dangling reference — no purchase with id pur-ghost/],
  ["a line for a product that does not exist", () => mutate((b) => { line(b, "pi-pur-1-1").productId = "p-ghost"; }), /purchaseItems\[id=pi-pur-1-1\]\.productId: dangling reference — no product with id p-ghost/],
  ["a line into a warehouse that does not exist", () => mutate((b) => { line(b, "pi-pur-1-2").warehouseId = "wh-ghost"; }), /purchaseItems\[id=pi-pur-1-2\]\.warehouseId: dangling reference — no warehouse with id wh-ghost/],
  ["a purchase whose header godown does not exist", () => mutate((b) => { purchase(b, "pur-1").warehouseId = "wh-ghost"; }), /purchases\[id=pur-1\]\.warehouseId: dangling reference — no warehouse with id wh-ghost/],
  ["a line with no godown when its purchase has none either", () => mutate((b) => { delete line(b, "pi-pur-1-1").warehouseId; delete purchase(b, "pur-1").warehouseId; }), /purchaseItems\[id=pi-pur-1-1\]\.warehouseId: the line has no godown and neither has its purchase/],

  /* ── quantities ── */
  ["a line quantity with FOUR decimals (thousandths cannot hold it)", () => mutate((b) => { line(b, "pi-pur-1-1").quantity = 12.0001; line(b, "pi-pur-1-1").orderedQty = 12.0001; }), /purchaseItems\[id=pi-pur-1-1\]\.quantity: quantity 12\.0001 has more than 3 decimals/],
  ["a received quantity with FOUR decimals", () => mutate((b) => { line(b, "pi-pur-1-1").receivedQty = 11.5001; }), /purchaseItems\[id=pi-pur-1-1\]\.receivedQty: quantity 11\.5001 has more than 3 decimals/],
  ["a received quantity below zero", () => mutate((b) => { line(b, "pi-pur-1-1").receivedQty = -1; }), /purchaseItems\[id=pi-pur-1-1\]\.receivedQty: quantity must not be negative, got -1/],
  ["a line quantity of zero", () => mutate((b) => { line(b, "pi-pur-1-1").quantity = 0; }), /purchaseItems\[id=pi-pur-1-1\]\.quantity: quantity must be greater than zero/],
  ["a missing line quantity", () => mutate((b) => { delete line(b, "pi-pur-1-1").quantity; }), /purchaseItems\[id=pi-pur-1-1\]\.quantity: quantity is missing/],
  ["an ordered quantity that differs from the quantity (the legacy always writes the same figure in both)", () => mutate((b) => { line(b, "pi-pur-1-1").orderedQty = 13; }), /purchaseItems\[id=pi-pur-1-1\]\.orderedQty: 13 differs from the quantity 12/],
  ["a header quantity with four decimals", () => mutate((b) => { purchase(b, "pur-1").totalQty = 15.0001; }), /purchases\[id=pur-1\]\.totalQty: quantity 15\.0001 has more than 3 decimals/],

  /* ── money ── */
  ["a line price with a fraction of a paisa", () => mutate((b) => { line(b, "pi-pur-1-1").unitPrice = 60000.5; }), /purchaseItems\[id=pi-pur-1-1\]\.unitPrice: money must be an integer number of paisa, got 60000\.5/],
  ["a line total with a fraction of a paisa", () => mutate((b) => { line(b, "pi-pur-1-1").lineTotal = 720000.25; }), /purchaseItems\[id=pi-pur-1-1\]\.lineTotal: money must be an integer number of paisa, got 720000\.25/],
  ["a cost figure with a fraction of a paisa", () => mutate((b) => { line(b, "pi-pur-1-1").goodsUnitCost = 60000.5; }), /purchaseItems\[id=pi-pur-1-1\]\.goodsUnitCost: money must be an integer number of paisa, got 60000\.5/],
  ["a negative line price", () => mutate((b) => { line(b, "pi-pur-1-1").unitPrice = -1; }), /purchaseItems\[id=pi-pur-1-1\]\.unitPrice: money must not be negative/],
  ["a header freight with a fraction of a paisa", () => mutate((b) => { purchase(b, "pur-1").freightAmount = 40000.5; }), /purchases\[id=pur-1\]\.freightAmount: money must be an integer number of paisa, got 40000\.5/],
  ["a line discount above the line's gross (fix 2: 12 x 60,000 = 720,000)", () => mutate((b) => { line(b, "pi-pur-1-1").discount = 720_001; }), /purchaseItems\[id=pi-pur-1-1\]\.discount: 720001 paisa is more than the line's gross \(60000 paisa x 12\)/],

  /* ── identity ── */
  ["a duplicate line id", () => mutate((b) => { b.data.purchaseItems.push({ ...line(b, "pi-pur-1-1") }); }), /Duplicate legacy id in 'purchaseItems': pi-pur-1-1/],
  ["a duplicate purchase number", () => mutate((b) => { purchase(b, "pur-2").purchaseNumber = "PUR-2026-000001"; }), /purchases\[id=pur-2\]\.purchaseNumber: PUR-2026-000001 is already the number of purchase pur-1/],
  ["a duplicate purchase id", () => mutate((b) => { b.data.purchases.push({ ...purchase(b, "pur-1"), purchaseNumber: "PUR-2026-000099" }); }), /Duplicate legacy id in 'purchases': pur-1/],
  ["a purchase status the legacy never writes", () => mutate((b) => { purchase(b, "pur-1").status = "SHIPPED"; }), /purchases\[id=pur-1\]\.status: unknown value "SHIPPED"/],
];

describe("S11 fail loudly — aborts naming the store, the document and the field, and leaves the database untouched", () => {
  it.each(cases)("%s", async (_name, backup, message) => {
    const attempt = runImport(backup(), IMPORT_OPTS);
    await expect(attempt).rejects.toBeInstanceOf(ImportError);
    await expect(attempt).rejects.toThrow(message);
    expect(await snapshot()).toEqual(before);
  });

  it("the guards are real: near-identical edits that ARE valid still import (a case above fails for its own reason, not for a broken fixture)", async () => {
    const ok = await runImport(
      mutate((b) => {
        line(b, "pi-pur-1-1").discount = 1000; // a discount within the gross
        line(b, "pi-pur-1-1").lineTotal = 719_000;
        line(b, "pi-pur-1-1").receivedQty = 11.5; // 3 decimals are fine
        purchase(b, "pur-2").purchaseNumber = "PUR-2026-000099"; // a number nobody else has
      }),
      IMPORT_OPTS,
    );
    expect(ok.loaded).toMatchObject({ purchases: 4, purchase_items: 5 });
    await runImport(fixture(), IMPORT_OPTS);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImportError, runImport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";

/**
 * S6: the importer never guesses about lines, quantities, prices or stock. Each of these aborts naming the store,
 * the document and the field — and leaves the database exactly as the previous good import left it.
 */
const sql = adminSql();

async function snapshot() {
  const [r] = await sql`
    SELECT (SELECT count(*) FROM invoices)::int AS invoices, (SELECT count(*) FROM invoice_items)::int AS items,
           (SELECT count(*) FROM stock_levels)::int AS levels, (SELECT count(*) FROM stock_movements)::int AS movements,
           (SELECT count(*) FROM products)::int AS products, (SELECT count(*) FROM journal_entries)::int AS entries,
           (SELECT count(*) FROM audit_log WHERE action = 'IMPORT')::int AS imports,
           (SELECT coalesce(sum(qty_milli), 0) FROM stock_levels)::text AS qty`;
  return { ...r };
}

let before: Awaited<ReturnType<typeof snapshot>>;
beforeAll(async () => {
  await runImport(fixture(), IMPORT_OPTS);
  before = await snapshot();
  expect(before).toMatchObject({ invoices: 8, items: 11, levels: 7, movements: 30 }); // a populated database, so "unchanged" is meaningful
});
afterAll(async () => {
  await sql.end();
});

const item = (b: any, id: string) => b.data.invoiceItems.find((i: any) => i.id === id);
const movement = (b: any, id: string) => b.data.stockMovements.find((m: any) => m.id === id);

const cases: [name: string, backup: () => unknown, message: RegExp][] = [
  /* ── classification: nothing is dropped silently ── */
  ["an unclassified field on an invoice line", () => mutate((b) => { item(b, "ii-inv-1-1").mystery = 1; }), /Store 'invoiceItems' has an unclassified field 'mystery' \(on invoiceItems\[id=ii-inv-1-1\]\)/],
  ["an unclassified field on an inventory row", () => mutate((b) => { b.data.inventory[0].reservedQty = 3; }), /Store 'inventory' has an unclassified field 'reservedQty'/],
  ["an unclassified field on a stock movement", () => mutate((b) => { movement(b, "mv-1").batch = "x"; }), /Store 'stockMovements' has an unclassified field 'batch'/],
  ["an unclassified field on an invoice (the new header)", () => mutate((b) => { b.data.invoices[0].loyaltyPoints = 5; }), /Store 'invoices' has an unclassified field 'loyaltyPoints'/],

  /* ── lines ── */
  ["a line on an invoice that is not in the backup", () => mutate((b) => { item(b, "ii-inv-1-1").invoiceId = "inv-ghost"; }), /invoiceItems\[id=ii-inv-1-1\]\.invoiceId: dangling reference — no invoice with id inv-ghost/],
  ["a line for a product that does not exist", () => mutate((b) => { item(b, "ii-inv-1-1").productId = "p-ghost"; }), /invoiceItems\[id=ii-inv-1-1\]\.productId: dangling reference — no product with id p-ghost/],
  ["a line out of a warehouse that does not exist", () => mutate((b) => { item(b, "ii-inv-1-1").warehouseId = "wh-ghost"; }), /invoiceItems\[id=ii-inv-1-1\]\.warehouseId: dangling reference — no warehouse with id wh-ghost/],
  ["a line quantity with FOUR decimals (thousandths cannot hold it)", () => mutate((b) => { item(b, "ii-inv-6-1").quantity = 2.5001; }), /invoiceItems\[id=ii-inv-6-1\]\.quantity: quantity 2\.5001 has more than 3 decimals/],
  ["a line quantity of zero", () => mutate((b) => { item(b, "ii-inv-1-1").quantity = 0; }), /invoiceItems\[id=ii-inv-1-1\]\.quantity: quantity must be greater than zero/],
  ["a negative line quantity", () => mutate((b) => { item(b, "ii-inv-1-1").quantity = -1; }), /invoiceItems\[id=ii-inv-1-1\]\.quantity: quantity must be greater than zero/],
  ["a missing line quantity", () => mutate((b) => { delete item(b, "ii-inv-1-1").quantity; }), /invoiceItems\[id=ii-inv-1-1\]\.quantity: quantity is missing/],
  ["a line price with a fraction of a paisa", () => mutate((b) => { item(b, "ii-inv-1-1").unitPrice = 100000.5; }), /invoiceItems\[id=ii-inv-1-1\]\.unitPrice: money must be an integer number of paisa, got 100000\.5/],
  ["a line price that is text", () => mutate((b) => { item(b, "ii-inv-1-1").unitPrice = "1000"; }), /invoiceItems\[id=ii-inv-1-1\]\.unitPrice: money must be a finite number/],
  ["a negative line discount", () => mutate((b) => { item(b, "ii-inv-2-2").discount = -5; }), /invoiceItems\[id=ii-inv-2-2\]\.discount: money must not be negative/],
  ["a line discount larger than the line's gross", () => mutate((b) => { item(b, "ii-inv-2-2").discount = 160_001; }), /invoiceItems\[id=ii-inv-2-2\]\.discount: 160001 paisa is more than the line's gross/],
  ["a fractional-paisa cost snapshot", () => mutate((b) => { item(b, "ii-inv-1-1").costSnapshot = 80000.25; }), /invoiceItems\[id=ii-inv-1-1\]\.costSnapshot: money must be an integer/],
  ["more returned than sold", () => mutate((b) => { item(b, "ii-inv-8-1").returnedQty = 4.001; }), /invoiceItems\[id=ii-inv-8-1\]\.returnedQty: 4\.001 is more than the quantity sold \(4\)/],
  ["a duplicate line id", () => mutate((b) => { b.data.invoiceItems.push({ ...item(b, "ii-inv-1-1") }); }), /Duplicate legacy id in 'invoiceItems': ii-inv-1-1/],

  /* ── the header ── */
  ["two invoices with the same number", () => mutate((b) => { b.data.invoices[1].invoiceNumber = b.data.invoices[0].invoiceNumber; }), /invoices\[id=inv-2\]\.invoiceNumber: INV-2026-000001 is already the number of invoice inv-1/],
  ["an invoice in a warehouse that does not exist", () => mutate((b) => { b.data.invoices[0].warehouseId = "wh-ghost"; }), /invoices\[id=inv-1\]\.warehouseId: dangling reference — no warehouse with id wh-ghost/],
  ["an invoice with a region that does not exist", () => mutate((b) => { b.data.invoices[0].regionId = "rg-ghost"; }), /invoices\[id=inv-1\]\.regionId: dangling reference — no region with id rg-ghost/],
  ["an unknown invoice type", () => mutate((b) => { b.data.invoices[0].invoiceType = "PROFORMA"; }), /invoices\[id=inv-1\]\.invoiceType: unknown value "PROFORMA"/],
  ["a fractional-paisa freight charge", () => mutate((b) => { b.data.invoices[4].freightAmount = 12000.5; }), /invoices\[id=inv-5\]\.freightAmount: money must be an integer/],
  ["a header quantity with four decimals", () => mutate((b) => { b.data.invoices[5].totalQty = 2.5001; }), /invoices\[id=inv-6\]\.totalQty: quantity 2\.5001 has more than 3 decimals/],
  ["a previous balance that is not a number", () => mutate((b) => { b.data.invoices[4].previousBalance = "-200000"; }), /invoices\[id=inv-5\]\.previousBalance: money must be a finite number/],
  ["a `migrated` flag that is not a boolean", () => mutate((b) => { b.data.invoices[6].migrated = "yes"; }), /invoices\[id=inv-7\]\.migrated: expected a boolean/],

  /* ── inventory ── */
  ["an inventory row for a product that does not exist", () => mutate((b) => { b.data.inventory[0].productId = "p-ghost"; }), /inventory\[id=p-1\|wh-1\]\.productId: dangling reference — no product with id p-ghost/],
  ["an inventory row in a warehouse that does not exist", () => mutate((b) => { b.data.inventory[0].warehouseId = "wh-ghost"; }), /inventory\[id=p-1\|wh-1\]\.warehouseId: dangling reference — no warehouse with id wh-ghost/],
  ["two inventory rows for the same product and warehouse", () => mutate((b) => { b.data.inventory.push({ ...b.data.inventory[0], id: "dup" }); }), /Duplicate 'inventory' row for product p-1 in warehouse wh-1/],
  ["an inventory quantity with four decimals", () => mutate((b) => { b.data.inventory[0].qty = 90.5001; }), /inventory\[id=p-1\|wh-1\]\.qty: quantity 90\.5001 has more than 3 decimals/],
  ["a damaged quantity with four decimals", () => mutate((b) => { b.data.inventory[0].damagedQty = 0.6001; }), /inventory\[id=p-1\|wh-1\]\.damagedQty: quantity 0\.6001 has more than 3 decimals/],
  ["a fractional-paisa average cost", () => mutate((b) => { b.data.inventory[0].avgCostP = 79000.5; }), /inventory\[id=p-1\|wh-1\]\.avgCostP: money must be an integer/],

  /* ── movements ── */
  ["a movement of an unknown kind", () => mutate((b) => { movement(b, "mv-5").kind = "SALE_SIDEWAYS"; }), /stockMovements\[id=mv-5\]\.kind: unknown value "SALE_SIDEWAYS"/],
  ["a movement with an unknown refType", () => mutate((b) => { movement(b, "mv-5").refType = "TELEPORT"; }), /stockMovements\[id=mv-5\]\.refType: unknown value "TELEPORT"/],
  ["a movement in an unknown bucket", () => mutate((b) => { movement(b, "mv-5").bucket = "quarantine"; }), /stockMovements\[id=mv-5\]\.bucket: unknown value "quarantine"/],
  ["a movement of a product that does not exist", () => mutate((b) => { movement(b, "mv-5").productId = "p-ghost"; }), /stockMovements\[id=mv-5\]\.productId: dangling reference — no product with id p-ghost/],
  ["a movement in a warehouse that does not exist", () => mutate((b) => { movement(b, "mv-5").warehouseId = "wh-ghost"; }), /stockMovements\[id=mv-5\]\.warehouseId: dangling reference — no warehouse with id wh-ghost/],
  ["a sale movement that points at an invoice number that does not exist", () => mutate((b) => { movement(b, "mv-5").ref = "INV-2026-999999"; }), /stockMovements\[id=mv-5\]\.ref: dangling reference — no invoice numbered "INV-2026-999999" \(refType INVOICE\)/],
  ["a purchase movement that points at a purchase number that does not exist", () => mutate((b) => { movement(b, "mv-20").ref = "PUR-2026-999999"; }), /stockMovements\[id=mv-20\]\.ref: dangling reference — no purchase numbered "PUR-2026-999999" \(refType PURCHASE\)/],
  ["a purchase-edit movement that points at a purchase number that does not exist", () => mutate((b) => { movement(b, "mv-21").ref = "PUR-2026-999999"; }), /stockMovements\[id=mv-21\]\.ref: dangling reference — no purchase numbered "PUR-2026-999999" \(refType PURCHASE_EDIT\)/],
  ["a cancel movement that points at an invoice number that does not exist", () => mutate((b) => { movement(b, "mv-13").ref = "INV-2026-999999"; }), /stockMovements\[id=mv-13\]\.ref: dangling reference — no invoice numbered "INV-2026-999999" \(refType INVOICE_CANCEL\)/],
  ["a movement quantity with four decimals", () => mutate((b) => { movement(b, "mv-16").qtyDelta = -2.5001; }), /stockMovements\[id=mv-16\]\.qtyDelta: quantity -2\.5001 has more than 3 decimals/],
  ["a movement of nothing", () => mutate((b) => { movement(b, "mv-5").qtyDelta = 0; }), /stockMovements\[id=mv-5\]\.qtyDelta: a movement of zero is not a movement/],
  ["a movement quantity that is text", () => mutate((b) => { movement(b, "mv-5").qtyDelta = "-10"; }), /stockMovements\[id=mv-5\]\.qtyDelta: quantity must be a finite number/],
  ["a movement with a fractional-paisa cost", () => mutate((b) => { movement(b, "mv-1").unitCostP = 80000.5; }), /stockMovements\[id=mv-1\]\.unitCostP: money must be an integer/],
  ["a movement dated in the wrong shape", () => mutate((b) => { movement(b, "mv-5").date = "01/02/2026"; }), /stockMovements\[id=mv-5\]\.date: expected a YYYY-MM-DD date/],
  ["a duplicate movement id", () => mutate((b) => { b.data.stockMovements.push({ ...movement(b, "mv-5") }); }), /Duplicate legacy id in 'stockMovements': mv-5/],

  /* ── products (the catalogue + the Prices panel) ── */
  ["a product price that is not exact paisa (10.005 rupees)", () => mutate((b) => { b.data.products[1].sell = 10.005; }), /products\[id=p-2\]\.sell: rupee amount 10\.005 is not exact paisa: Use at most 2 decimal places/],
  ["a product paisa price that is fractional", () => mutate((b) => { b.data.products[0].sellP = 100000.5; }), /products\[id=p-1\]\.sellP: money must be an integer/],
  ["a negative product price", () => mutate((b) => { b.data.products[0].buyP = -1; }), /products\[id=p-1\]\.buyP: money must not be negative/],
  ["a product tax percentage that is text", () => mutate((b) => { b.data.products[0].taxPct = "five"; }), /products\[id=p-1\]\.taxPct: expected a non-negative number/],
  ["a product weight that is negative", () => mutate((b) => { b.data.products[0].kg = -50; }), /products\[id=p-1\]\.kg: expected a non-negative number/],
];

describe("S6 fail loudly — aborts naming the store, the document and the field, and leaves the database untouched", () => {
  it.each(cases)("%s", async (_name, backup, message) => {
    const attempt = runImport(backup(), IMPORT_OPTS);
    await expect(attempt).rejects.toBeInstanceOf(ImportError);
    await expect(attempt).rejects.toThrow(message);
    expect(await snapshot()).toEqual(before);
  });

  it("the guards are real: the same edits made to a COPY that is valid still import (a case above fails for its own reason, not for a broken fixture)", async () => {
    const ok = await runImport(mutate((b) => { b.data.products[1].sell = 10.5; item(b, "ii-inv-6-1").quantity = 2.5; }), IMPORT_OPTS);
    expect(ok.loaded).toMatchObject({ invoice_items: 11, stock_levels: 7, stock_movements: 30 });
    await runImport(fixture(), IMPORT_OPTS);
  });
});

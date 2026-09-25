import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { TEST_APP_URL } from "@farooq/db/testing";
import { purchaseLines, purchaseMemo, purchasePosts, PURCHASE_SOURCE } from "@farooq/db";
import { runImport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture } from "./helpers.js";

/**
 * S11: what the DATABASE itself refuses (checked with the admin role, so no application code stands between the statement and the
 * constraint), and the shared posting builder against the lines the importer used to write inline.
 */
const sql = adminSql();
let ids: { supplier: string; product: string; warehouse: string; purchase: string };

beforeAll(async () => {
  await runImport(fixture(), IMPORT_OPTS);
  const [s] = await sql`SELECT id FROM suppliers WHERE legacy_id = 'sup-3'`;
  const [p] = await sql`SELECT id FROM products WHERE legacy_id = 'p-1'`;
  const [w] = await sql`SELECT id FROM warehouses WHERE legacy_id = 'wh-1'`;
  const [pu] = await sql`SELECT id FROM purchases WHERE legacy_id = 'pur-1'`;
  ids = { supplier: s!.id, product: p!.id, warehouse: w!.id, purchase: pu!.id };
});
afterAll(async () => {
  await sql`DELETE FROM purchase_items WHERE legacy_id LIKE 'rule-%'`;
  await sql`DELETE FROM purchases WHERE legacy_id LIKE 'rule-%'`;
  await sql.end();
});

const insertLine = (qtyMilli: number, unitPriceP: number, discountP: number, extra: { received?: number; legacyId?: string } = {}) =>
  sql`
    INSERT INTO purchase_items (legacy_id, purchase_id, product_id, warehouse_id, qty_milli, received_qty_milli, unit_price_p, discount_p, line_total_p)
    VALUES (${extra.legacyId ?? "rule-line"}, ${ids.purchase}, ${ids.product}, ${ids.warehouse}, ${qtyMilli}, ${extra.received ?? 0}, ${unitPriceP}, ${discountP}, 0)`;

describe("purchase lines: the constraints", () => {
  it("a discount above the line's gross is refused (fix 2): 3 bags at 1,000 = 3,000 gross; 3,000 is fine, 3,001 is not", async () => {
    await insertLine(3000, 1000, 3000, { legacyId: "rule-ok-discount" });
    await expect(insertLine(3000, 1000, 3001)).rejects.toMatchObject({ constraint_name: "purchase_items_discount_chk" });
    // fractional bags use the same rounding as the line total: 2.5 bags at 1,001 = round(2,502.5) = 2,503 gross
    await insertLine(2500, 1001, 2503, { legacyId: "rule-ok-discount-2" });
    await expect(insertLine(2500, 1001, 2504)).rejects.toMatchObject({ constraint_name: "purchase_items_discount_chk" });
  });

  it("a zero or negative ordered quantity is refused; so is a negative received or returned quantity", async () => {
    // (unit price 0 keeps the discount CHECK, which Postgres evaluates first, satisfied so the quantity CHECK is the one that speaks)
    await expect(insertLine(0, 0, 0)).rejects.toMatchObject({ constraint_name: "purchase_items_qty_chk" });
    await expect(insertLine(-1000, 0, 0)).rejects.toMatchObject({ constraint_name: "purchase_items_qty_chk" });
    await expect(insertLine(1000, 1000, 0, { received: -1 })).rejects.toMatchObject({ constraint_name: "purchase_items_qty_chk" });
    await expect(sql`UPDATE purchase_items SET returned_qty_milli = -1 WHERE legacy_id = 'rule-ok-discount'`).rejects.toMatchObject({ constraint_name: "purchase_items_qty_chk" });
  });

  it("received is NOT capped at ordered (the legacy allowed raising the ordered quantity on a full load); negative money is refused", async () => {
    await insertLine(1000, 1000, 0, { received: 5000, legacyId: "rule-over-received" });
    await expect(sql`
      INSERT INTO purchase_items (purchase_id, product_id, warehouse_id, qty_milli, unit_price_p, tax_p, line_total_p)
      VALUES (${ids.purchase}, ${ids.product}, ${ids.warehouse}, 1000, 1, -1, 1)`).rejects.toMatchObject({ constraint_name: "purchase_items_money_chk" });
  });

  it("a line needs a real purchase, product and godown (foreign keys), and every line id is unique", async () => {
    await expect(sql`
      INSERT INTO purchase_items (purchase_id, product_id, warehouse_id, qty_milli, unit_price_p, line_total_p)
      VALUES (${ids.supplier}, ${ids.product}, ${ids.warehouse}, 1000, 1, 1)`).rejects.toMatchObject({ constraint_name: "purchase_items_purchase_id_purchases_id_fk" });
    await expect(insertLine(1000, 1, 0, { legacyId: "rule-ok-discount" })).rejects.toMatchObject({ constraint_name: "purchase_items_legacy_id_unique" });
  });
});

describe("purchases: the number and the header", () => {
  it("two purchases can never share a number; any number of them may have none", async () => {
    await expect(sql`INSERT INTO purchases (legacy_id, supplier_id, date, total_p, status, purchase_number) VALUES ('rule-dup', ${ids.supplier}, '2026-03-01', 0, 'RECEIVED', 'PUR-2026-000001')`).rejects.toMatchObject({
      constraint_name: "purchases_purchase_number_uq",
    });
    for (const n of [1, 2, 3]) {
      await sql`INSERT INTO purchases (legacy_id, supplier_id, date, total_p, status) VALUES (${`rule-null-${n}`}, ${ids.supplier}, '2026-03-01', 0, 'DRAFT')`;
    }
    const [c] = await sql`SELECT count(*)::int AS n FROM purchases WHERE legacy_id LIKE 'rule-null-%' AND purchase_number IS NULL`;
    expect(c!.n).toBe(3);
  });

  it("negative header money or quantity is refused", async () => {
    await expect(sql`INSERT INTO purchases (legacy_id, supplier_id, date, total_p, status, freight_p) VALUES ('rule-neg', ${ids.supplier}, '2026-03-01', 0, 'DRAFT', -1)`).rejects.toMatchObject({
      constraint_name: "purchases_amounts_chk",
    });
  });
});

describe("the application role", () => {
  it("may read, insert and UPDATE purchase lines (edits update them in place: they are not append-only) but can never TRUNCATE the table", async () => {
    const app = postgres(TEST_APP_URL, { max: 1, onnotice: () => undefined });
    try {
      const [n] = await app`SELECT count(*)::int AS n FROM purchase_items WHERE legacy_id = 'rule-ok-discount'`;
      expect(n!.n).toBe(1);
      await app`UPDATE purchase_items SET notes = 'edited in place' WHERE legacy_id = 'rule-ok-discount'`;
      await expect(app`TRUNCATE purchase_items`).rejects.toMatchObject({ code: "42501" });
      await expect(app`TRUNCATE purchases CASCADE`).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
    expect((await sql`SELECT count(*)::int AS n FROM purchase_items`)[0]!.n).toBeGreaterThanOrEqual(5); // nothing was emptied
  });
});

describe("the shared posting builder (`purchaseLines`) is the importer's old inline one", () => {
  const S = "supplier-1";
  it("a positive total is DR PURCHASES / CR PAYABLES(supplier); a negative total swaps the sides (the same signed effect)", () => {
    expect(purchaseLines(S, 900_000)).toEqual([
      { account: "PURCHASES", debitP: 900_000, creditP: 0 },
      { account: "PAYABLES", partyType: "SUPPLIER", partyId: S, debitP: 0, creditP: 900_000 },
    ]);
    expect(purchaseLines(S, -5000)).toEqual([
      { account: "PAYABLES", partyType: "SUPPLIER", partyId: S, debitP: 5000, creditP: 0 },
      { account: "PURCHASES", debitP: 0, creditP: 5000 },
    ]);
    expect(purchaseLines(S, 0)).toEqual([
      { account: "PURCHASES", debitP: 0, creditP: 0 },
      { account: "PAYABLES", partyType: "SUPPLIER", partyId: S, debitP: 0, creditP: 0 },
    ]);
  });

  it("the memo, the source name and the status rule are the legacy's: everything except CANCELLED posts (a DRAFT and an ORDERED one do)", () => {
    expect(PURCHASE_SOURCE).toBe("PURCHASE");
    expect(purchaseMemo("PUR-2026-000001")).toBe("Purchase PUR-2026-000001");
    expect(purchaseMemo(null)).toBe("Purchase");
    expect(["DRAFT", "ORDERED", "PARTIALLY_RECEIVED", "RECEIVED"].map(purchasePosts)).toEqual([true, true, true, true]);
    expect(purchasePosts("CANCELLED")).toBe(false);
  });

  it("the journal the importer writes through it is exactly the old one: PUR-1's entry is DR PURCHASES 900,000 / CR PAYABLES(Sunrise) with the memo 'Purchase PUR-2026-000001'", async () => {
    const rows = await sql`
      SELECT e.memo, e.source_type, e.date::text AS date, a.code, l.party_type, s.legacy_id AS supplier, l.debit_p::text AS dr, l.credit_p::text AS cr
      FROM purchases p JOIN journal_entries e ON e.source_id = p.id AND e.source_type = 'PURCHASE'
      JOIN journal_lines l ON l.entry_id = e.id JOIN accounts a ON a.id = l.account_id LEFT JOIN suppliers s ON s.id = l.party_id
      WHERE p.legacy_id = 'pur-1' ORDER BY a.code`;
    expect(rows.map((r) => [r.memo, r.source_type, r.date, r.code, r.party_type, r.supplier, r.dr, r.cr])).toEqual([
      ["Purchase PUR-2026-000001", "PURCHASE", "2026-02-20", "PAYABLES", "SUPPLIER", "sup-1", "0", "900000"],
      ["Purchase PUR-2026-000001", "PURCHASE", "2026-02-20", "PURCHASES", null, null, "900000", "0"],
    ]);
  });
});

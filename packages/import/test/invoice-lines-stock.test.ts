import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { TEST_ADMIN_URL, TEST_APP_URL } from "@farooq/db/testing";
import { exitCodeFor, formatReport, prepareImport, reconcile, runImport, type ImportResult, type ReconciliationReport } from "../src/index.js";
import { balanceChainGaps } from "../src/reconcile-stock.js";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";

/**
 * S6: invoice lines, the full invoice header, the product catalogue / prices and the stock ledger, imported from the
 * synthetic fixture and checked against numbers worked out BY HAND (the fixture's own header comment and the tables
 * below), not against the importer's own output. Amounts are paisa; quantities are asserted in thousandths of a bag.
 */
const sql = adminSql();
let result: ImportResult;
let report: ReconciliationReport;

beforeAll(async () => {
  result = await runImport(fixture(), IMPORT_OPTS);
  report = await reconcile(fixture(), TEST_ADMIN_URL);
});
afterAll(async () => {
  await sql.end();
});

/** invoice → [subtotal, item discounts, invoice discount, tax, freight, loading, other, grand total, quantity (thousandths), lines] */
const HAND_COMPUTED: Record<string, number[]> = {
  "INV-2026-000001": [1_000_000, 0, 0, 0, 0, 0, 0, 1_000_000, 10_000, 1], // inv-1: 10 x 100,000
  "INV-2026-000002": [520_000, 20_000, 0, 0, 0, 0, 0, 500_000, 6000, 2], // inv-2: 4 x 90,000 + 2 x 80,000 - 20,000 discount
  "INV-2026-000003": [888_888, 0, 0, 0, 0, 0, 0, 888_888, 2000, 1], // inv-4 (cancelled): 2 x 444,444
  "INV-2026-000004": [400_000, 15_000, 110_000, 5000, 12_000, 5000, 3000, 300_000, 5000, 2], // inv-5: 400,000 - 15,000 - 110,000 + 5,000 + 12,000 + 5,000 + 3,000
  "INV-2026-000005": [750_000, 0, 0, 0, 0, 0, 0, 750_000, 2500, 1], // inv-6: 2.5 x 300,000
  "INV-2026-000006": [400_000, 0, 0, 0, 0, 0, 0, 400_000, 5000, 1], // inv-7 (migrated): 5 x 80,000
  "INV-2026-000007": [600_000, 0, 0, 0, 0, 0, 0, 600_000, 6000, 2], // inv-8: 4 x 100,000 + 2 x 100,000
};

describe("invoice header + lines", () => {
  it("every posted invoice's header holds the hand-computed sub-totals, charges, grand total, quantity and line count", async () => {
    const rows = await sql`
      SELECT invoice_number, subtotal_p::text AS sub, item_discounts_p::text AS idisc, invoice_discount_p::text AS vdisc, tax_p::text AS tax,
             freight_p::text AS fr, loading_p::text AS ld, other_charges_p::text AS ot, total_p::text AS grand,
             total_qty_milli::text AS qty, line_count AS lines
      FROM invoices WHERE invoice_number IS NOT NULL ORDER BY invoice_number`;
    expect(rows.map((r) => r.invoice_number)).toEqual(Object.keys(HAND_COMPUTED));
    for (const r of rows) {
      expect([r.sub, r.idisc, r.vdisc, r.tax, r.fr, r.ld, r.ot, r.grand, r.qty, r.lines].map(Number), r.invoice_number).toEqual(HAND_COMPUTED[r.invoice_number as string]);
    }
  });

  it("the DRAFT (inv-3) has lines, no number, no stock, no journal entry — and 3 x 333,333 = 999,999", async () => {
    const [d] = await sql`
      SELECT i.invoice_number, i.status, i.stock_applied, i.total_p::text AS total, i.line_count,
             (SELECT count(*) FROM invoice_items x WHERE x.invoice_id = i.id)::int AS items,
             (SELECT count(*) FROM journal_entries e WHERE e.source_id = i.id)::int AS entries,
             (SELECT count(*) FROM stock_movements m WHERE m.source_id = i.id)::int AS movements
      FROM invoices i WHERE i.legacy_id = 'inv-3'`;
    expect(d).toMatchObject({ invoice_number: null, status: "DRAFT", stock_applied: false, total: "999999", line_count: 1, items: 1, entries: 0, movements: 0 });
  });

  it("the rich invoice (inv-5) keeps every line field: two godowns, an item discount, a taxed line, snapshots, DISPATCHED, a negative previous balance", async () => {
    const lines = await sql`
      SELECT l.sort_order, p.legacy_id AS product, w.legacy_id AS warehouse, l.qty_milli::text AS qty, l.unit_price_p::text AS price,
             l.discount_p::text AS disc, l.tax_p::text AS tax, l.line_total_p::text AS total, l.cost_snapshot_p::text AS cost, l.unit
      FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id JOIN products p ON p.id = l.product_id JOIN warehouses w ON w.id = l.warehouse_id
      WHERE i.legacy_id = 'inv-5' ORDER BY l.sort_order`;
    expect(lines.map((l) => [l.sort_order, l.product, l.warehouse, l.qty, l.price, l.disc, l.tax, l.total, l.cost])).toEqual([
      [0, "p-1", "wh-2", "3000", "100000", "15000", "0", "285000", "80000"], // 300,000 - 15,000
      [1, "p-2", "wh-1", "2000", "50000", "0", "5000", "105000", "85000"], //   100,000 + 5,000 tax
    ]);
    const [h] = await sql`
      SELECT i.status, i.dispatch_number, i.previous_balance_p::text AS prev, i.salesperson, i.payment_method, i.reference_no, i.notes, i.stock_applied, i.migrated,
             i.warehouse_snapshot, w.legacy_id AS warehouse, r.legacy_id AS region, c.legacy_id AS customer, i.revision, i.invoice_type, i.due_date::text AS due
      FROM invoices i LEFT JOIN warehouses w ON w.id = i.warehouse_id LEFT JOIN regions r ON r.id = i.region_id JOIN customers c ON c.id = i.customer_id
      WHERE i.legacy_id = 'inv-5'`;
    expect(h).toMatchObject({
      status: "DISPATCHED", dispatch_number: "DSP-2026-000001", prev: "-200000", salesperson: "Ali", payment_method: "Cash", reference_no: "REF-5",
      notes: "deliver in the morning", stock_applied: true, migrated: false, warehouse_snapshot: "Second Godown", warehouse: "wh-2", region: "rg-a",
      customer: "cust-2", revision: 1, invoice_type: "SALE", due: "2026-02-10",
    });
  });

  it("a fractional quantity is exact: 2.5 bags = 2,500 thousandths, and 0.6 bag returned = 600", async () => {
    const [q] = await sql`SELECT l.qty_milli::text AS qty FROM invoice_items l JOIN invoices i ON i.id = l.invoice_id WHERE i.legacy_id = 'inv-6'`;
    expect(q!.qty).toBe("2500");
    const [r] = await sql`SELECT l.qty_milli::text AS qty, l.returned_qty_milli::text AS returned FROM invoice_items l WHERE l.legacy_id = 'ii-inv-8-1'`;
    expect([r!.qty, r!.returned]).toEqual(["4000", "600"]);
  });

  it("the edited invoice (inv-2) carries revision 2 and its FINAL lines; the cancelled one (inv-4) is CANCELLED with its cancel fields", async () => {
    const [e] = await sql`SELECT revision, previous_balance_p::text AS prev, count(l.id)::int AS lines FROM invoices i LEFT JOIN invoice_items l ON l.invoice_id = i.id WHERE i.legacy_id = 'inv-2' GROUP BY i.id`;
    expect(e).toMatchObject({ revision: 2, prev: "1000000", lines: 2 });
    const [c] = await sql`SELECT status, stock_applied, cancel_reason, cancelled_at IS NOT NULL AS cancelled FROM invoices WHERE legacy_id = 'inv-4'`;
    expect(c).toMatchObject({ status: "CANCELLED", stock_applied: false, cancel_reason: "typo", cancelled: true });
  });

  it("a cost snapshot of 0 stays 0 (the line had no recorded cost) — it is not turned into 'unknown'", async () => {
    const rows = await sql`SELECT legacy_id, cost_snapshot_p::text AS cost FROM invoice_items WHERE legacy_id IN ('ii-inv-2-2', 'ii-inv-1-1') ORDER BY legacy_id`;
    expect(rows.map((r) => [r.legacy_id, r.cost])).toEqual([["ii-inv-1-1", "80000"], ["ii-inv-2-2", "0"]]);
  });

  it("the migrated invoice (inv-7) is flagged, has its line, is in the ledger — and no stock movement", async () => {
    const [m] = await sql`
      SELECT i.migrated, i.stock_applied, i.salesperson, (SELECT count(*) FROM invoice_items x WHERE x.invoice_id = i.id)::int AS lines,
             (SELECT count(*) FROM stock_movements s WHERE s.source_type = 'INVOICE' AND s.source_id = i.id)::int AS movements,
             (SELECT count(*) FROM journal_entries e WHERE e.source_type = 'INVOICE' AND e.source_id = i.id)::int AS entries
      FROM invoices i WHERE i.legacy_id = 'inv-7'`;
    expect(m).toMatchObject({ migrated: true, stock_applied: true, salesperson: "Migrated", lines: 1, movements: 0, entries: 1 });
    expect(result.migratedInvoices).toEqual(["INV-2026-000006"]);
    expect(report.invoices.migrated).toEqual(["INV-2026-000006"]);
  });

  it("keeps the untouched legacy line document in legacy_doc", async () => {
    const original = fixture().data.invoiceItems!.find((d: any) => d.id === "ii-inv-5-1");
    const [row] = await sql`SELECT legacy_doc FROM invoice_items WHERE legacy_id = 'ii-inv-5-1'`;
    expect(row!.legacy_doc).toEqual(original);
  });
});

describe("product catalogue + the Prices panel (legacy Prices.of)", () => {
  it("p-1 has the panel fields set: every `...P` paisa field, the percentages and the reorder level", async () => {
    const [p] = await sql`
      SELECT name_ur, name_en, brand, brand_en, weight_kg, sku, barcode, buy_p::text AS buy, sell_p::text AS sell, extra_p::text AS extra,
             min_sell_p::text AS min, wholesale_p::text AS wholesale, retail_p::text AS retail, discount_pct, tax_pct, reorder
      FROM products WHERE legacy_id = 'p-1'`;
    expect(p).toEqual({
      name_ur: "Fixture Flour 50kg", name_en: "Fixture Flour 50kg", brand: "Fixture", brand_en: "Fixture", weight_kg: 50, sku: "SKU-p-1", barcode: null,
      buy: "80000", sell: "100000", extra: "2000", min: "95000", wholesale: "98000", retail: "105000", discount_pct: 2.5, tax_pct: 5, reorder: 20,
    });
  });
  it("p-2 has only the legacy rupee fields: sell 900.50 -> 90,050 paisa, min 850 -> 85,000; buy 0 / extra / wholesale / retail were never set (null)", async () => {
    const [p] = await sql`
      SELECT buy_p::text AS buy, sell_p::text AS sell, extra_p::text AS extra, min_sell_p::text AS min, wholesale_p::text AS wholesale, retail_p::text AS retail,
             discount_pct, tax_pct, reorder FROM products WHERE legacy_id = 'p-2'`;
    expect(p).toEqual({ buy: null, sell: "90050", extra: null, min: "85000", wholesale: null, retail: null, discount_pct: null, tax_pct: null, reorder: null });
  });
  it("p-3 (older shape, zeros everywhere) has no price at all — null, not 0", async () => {
    const [p] = await sql`SELECT buy_p, sell_p, min_sell_p, weight_kg FROM products WHERE legacy_id = 'p-3'`;
    expect(p).toEqual({ buy_p: null, sell_p: null, min_sell_p: null, weight_kg: 25 });
  });

  const priced = (doc: Record<string, unknown>) =>
    prepareImport(mutate((b) => { Object.assign(b.data.products[2], doc); })).rows.products.find((r) => r.legacyId === "p-3")!;
  it("mirrors Prices.of precedence: the `...P` field wins even when 0; else the legacy rupee field when truthy; `minSellP` 0 falls through to `min`", () => {
    expect(priced({ buyP: 0, buy: 800 })).toMatchObject({ buyP: 0 }); // buyP is set (0) -> kept; the rupee field is not consulted
    expect(priced({ buyP: 12_345, buy: 1 })).toMatchObject({ buyP: 12_345 });
    expect(priced({ buy: 800 })).toMatchObject({ buyP: 80_000 });
    expect(priced({ buy: 0 })).toMatchObject({ buyP: null });
    expect(priced({ minSellP: 0, min: 950 })).toMatchObject({ minSellP: 95_000 });
    expect(priced({ minSellP: 90_000, min: 950 })).toMatchObject({ minSellP: 90_000 });
    expect(priced({ wholesaleP: 0 })).toMatchObject({ wholesaleP: null });
    expect(priced({ extra: 20, sell: 1000.5 })).toMatchObject({ extraP: 2000, sellP: 100_050 });
  });
  it("rupee TEXT a person typed goes through the strict parser: '1,200.50' -> 120,050", () => {
    expect(priced({ sell: "1,200.50" })).toMatchObject({ sellP: 120_050 });
  });
});

describe("stock levels and movements", () => {
  it("the six legacy inventory rows become 6 stock rows + 1 damaged row with the hand-computed quantities (thousandths) and carried costs", async () => {
    const rows = await sql`
      SELECT p.legacy_id AS p, w.legacy_id AS w, l.bucket, l.qty_milli::text AS qty, l.avg_cost_p::text AS avg, l.last_cost_p::text AS last
      FROM stock_levels l JOIN products p ON p.id = l.product_id JOIN warehouses w ON w.id = l.warehouse_id ORDER BY p.legacy_id, w.legacy_id, l.bucket`;
    expect(rows.map((r) => [r.p, r.w, r.bucket, r.qty, r.avg, r.last])).toEqual([
      ["p-1", "wh-1", "damaged", "600", "0", "0"], //    0.6 bag came back damaged (cr-1)
      ["p-1", "wh-1", "stock", "90500", "64286", "64286"], // 100 - 10 - 2.5 - 4 + 12 - 12 + 12 - 5; average from pur-1's first line (S11)
      ["p-1", "wh-2", "stock", "32000", "80000", "0"], //    30 - 3 + 5; no purchase line behind its average: kept from before
      ["p-2", "wh-1", "stock", "52000", "85000", "85000"], // 60 - 4 + 4 - 4 - 2 + 2 - 2 - 2 (+ 6 - 6 of the cancelled pur-3); kept from before
      ["p-2", "wh-2", "stock", "3000", "45857", "45857"], //  3 - 3 + 3 (pur-1's second line, landed cost included)
      ["p-3", "wh-1", "stock", "38000", "0", "0"], //        40 - 3 + 3 - 2  (the migrated invoice's 5 bags were never a movement)
      ["p-3", "wh-2", "stock", "60000", "1667", "1667"], //  60 of pur-4's 100 ordered bags (the legacy goods unit round(100,000 / 60))
    ]);
  });

  it("stores 32 movements with their kinds, and links each to its document: invoices and purchases by id, other types by name only", async () => {
    const byKind = await sql`SELECT kind, count(*)::int AS n FROM stock_movements GROUP BY kind ORDER BY kind`;
    expect(byKind.map((r) => [r.kind, r.n])).toEqual([
      ["ADJUSTMENT_IN", 4], ["CUSTOMER_RETURN_DAMAGED_IN", 1], ["OPENING_STOCK", 1], ["PURCHASE_IN", 6], ["PURCHASE_REVERSAL_OUT", 3],
      ["RECEIPT_EDIT_OUT", 1] /* S14: RCV-2026-000004 edited */, ["SALE_OUT", 11], ["SALE_REVERSAL_IN", 3], ["TRANSFER_IN", 1], ["TRANSFER_OUT", 1],
    ]);
    const sources = await sql`
      SELECT m.ref_type, m.source_type, count(*)::int AS n, count(m.source_id)::int AS linked,
             count(*) FILTER (WHERE m.source_id IS NOT NULL AND coalesce(i.id, p.id) IS NULL)::int AS dangling
      FROM stock_movements m LEFT JOIN invoices i ON m.source_type = 'INVOICE' AND i.id = m.source_id
                             LEFT JOIN purchases p ON m.source_type = 'PURCHASE' AND p.id = m.source_id
      GROUP BY m.ref_type, m.source_type ORDER BY m.ref_type`;
    expect(sources.map((r) => [r.ref_type, r.source_type, r.n, r.linked, r.dangling])).toEqual([
      ["CUSTOMER_RETURN", "CUSTOMER_RETURN", 1, 0, 0],
      ["INVOICE", "INVOICE", 11, 11, 0],
      ["INVOICE_CANCEL", "INVOICE", 1, 1, 0],
      ["INVOICE_EDIT", "INVOICE", 2, 2, 0],
      ["PURCHASE", "PURCHASE", 6, 6, 0],
      ["PURCHASE_EDIT", "PURCHASE", 3, 3, 0],
      ["STOCK_RECEIPT", "STOCK_RECEIPT", 5, 0, 0],
      ["STOCK_RECEIPT_EDIT", "STOCK_RECEIPT_EDIT", 1, 0, 0], // S14: the edited receipt's reversal, carried by name like the receipt
      ["TRANSFER", "TRANSFER", 2, 0, 0],
    ]);
  });

  it("a movement points at the RIGHT invoice: inv-2's four kinds of movement are all on INV-2026-000002", async () => {
    const rows = await sql`
      SELECT m.ref_type, count(*)::int AS n FROM stock_movements m JOIN invoices i ON i.id = m.source_id
      WHERE i.legacy_id = 'inv-2' GROUP BY m.ref_type ORDER BY m.ref_type`;
    expect(rows.map((r) => [r.ref_type, r.n])).toEqual([["INVOICE", 4], ["INVOICE_EDIT", 2]]);
  });

  it("a legacy unit cost of 0 means 'none recorded' (null); a real one is kept; the user name stays in legacy_doc, created_by is empty", async () => {
    const [z] = await sql`SELECT count(*) FILTER (WHERE unit_cost_p IS NULL)::int AS nulls, count(*) FILTER (WHERE unit_cost_p > 0)::int AS costed, count(created_by)::int AS by FROM stock_movements`;
    expect(z).toEqual({ nulls: 21, costed: 11, by: 0 }); // S14: the edited receipt's reversal (80,000) and its corrected line (90,000) both carry a cost
    const [u] = await sql`SELECT legacy_doc->>'userId' AS u, date::text AS d, created_at FROM stock_movements WHERE legacy_id = 'mv-5'`;
    expect(u!.u).toBe("Fixture");
    expect(u!.d).toBe("2026-02-01");
    expect(new Date(u!.created_at).toISOString()).toBe("2026-02-01T05:00:10.000Z");
  });

  it("a fractional movement is exact: SALE_OUT of 2.5 bags = -2,500 thousandths; the damaged movement is in the damaged bucket", async () => {
    const [a] = await sql`SELECT qty_delta_milli::text AS q FROM stock_movements WHERE kind = 'SALE_OUT' AND ref = 'INV-2026-000005'`;
    expect(a!.q).toBe("-2500");
    const [b] = await sql`SELECT bucket, qty_delta_milli::text AS q FROM stock_movements WHERE kind = 'CUSTOMER_RETURN_DAMAGED_IN'`;
    expect(b).toEqual({ bucket: "damaged", q: "600" });
  });
});

describe("reconciliation of invoice totals and stock (the hand-computed numbers)", () => {
  it("passes with 0 mismatches of any kind, exit code 0", () => {
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("invoice totals: 7 posted invoices with 10 lines / 36.5 bags recomputed, the draft not checked", () => {
    expect(report.invoices).toEqual({
      checked: 7, lines: 10, qtyMilli: 36_500, totalMismatches: [], noLines: [], drafts: 1, migrated: ["INV-2026-000006"], migratedMismatches: [],
    });
  });

  it("stock: 7 rows, 32 movements, 275.5 bags + 0.6 damaged, legacy = level = sum of movements, no broken running-balance chain", () => {
    expect(report.stock).toEqual({ rows: 7, movements: 32, stockQtyMilli: 275_500, damagedQtyMilli: 600, mismatches: [], chainGaps: 0 });
  });

  it("invoice <-> stock: 7 invoices checked (the migrated one skipped), 14 movements, every edit / cancel nets out", () => {
    expect(report.invoiceStock).toEqual({ invoicesChecked: 7, migratedSkipped: 1, movementsChecked: 14, mismatches: [] });
  });

  it("the balances are still the S2 numbers: 0 differences, receivables 2,935,000", () => {
    expect(report.customers.differences).toEqual([]);
    expect(report.suppliers.differences).toEqual([]);
    expect(report.totals.receivables.newNetP).toBe(2_935_000);
  });

  it("the printed report says the real numbers", () => {
    const text = formatReport(report);
    expect(text).toContain("7 checked (totals recomputed from 10 lines, 36.5 bags), 0 total mismatch(es); 1 draft(s) not checked");
    expect(text).toContain("7 product x warehouse x bucket rows, 32 movements, 275.5 bags in stock + 0.6 damaged; 0 mismatch(es)");
    expect(text).toContain("7 invoices vs 14 invoice movements, 0 mismatch(es); 1 migrated invoice(s) skipped");
    expect(text).toContain("INV-2026-000006");
  });
});

describe("what the database itself enforces", () => {
  it("many DRAFTS can exist (their number is NULL); two invoices can never share a number", async () => {
    const [c] = await sql`SELECT id FROM customers WHERE legacy_id = 'cust-4'`;
    try {
      for (let i = 0; i < 3; i++) await sql`INSERT INTO invoices (customer_id, date, total_p, status) VALUES (${c!.id}, '2026-03-01', 0, 'DRAFT')`;
      const [n] = await sql`SELECT count(*)::int AS n FROM invoices WHERE invoice_number IS NULL`;
      expect(n!.n).toBe(4); // inv-3 + the 3 just made
      await expect(sql`INSERT INTO invoices (customer_id, date, total_p, status, invoice_number) VALUES (${c!.id}, '2026-03-01', 0, 'CONFIRMED', 'INV-2026-000001')`)
        .rejects.toMatchObject({ code: "23505", constraint_name: "invoices_invoice_number_uq" });
    } finally {
      await sql`DELETE FROM invoices WHERE invoice_number IS NULL AND legacy_id IS NULL`;
    }
  });

  it("the importer accepts a backup with several numberless drafts (legacy: '' -> NULL) — the legacy one-draft bug does not exist here", async () => {
    const b = mutate((x) => {
      for (const n of ["b", "c"]) {
        x.data.invoices.push({ ...x.data.invoices[2], id: `inv-3${n}` });
        x.data.invoiceItems.push({ ...x.data.invoiceItems.find((i: any) => i.invoiceId === "inv-3"), id: `ii-inv-3${n}-1`, invoiceId: `inv-3${n}` });
      }
    });
    const r = await runImport(b, IMPORT_OPTS);
    expect(r.loaded.invoices).toBe(10);
    const [n] = await sql`SELECT count(*)::int AS n FROM invoices WHERE invoice_number IS NULL AND status = 'DRAFT'`;
    expect(n!.n).toBe(3);
    expect((await reconcile(b, TEST_ADMIN_URL)).ok).toBe(true);
    await runImport(fixture(), IMPORT_OPTS); // leave the fixture in place for the rest of the file
  });

  it("the CHECK constraints refuse a zero-quantity line, a discount above the gross, a zero movement and an unknown bucket", async () => {
    const [i] = await sql`SELECT i.id AS inv, p.id AS prod, w.id AS wh FROM invoices i, products p, warehouses w WHERE i.legacy_id = 'inv-1' AND p.legacy_id = 'p-1' AND w.legacy_id = 'wh-1'`;
    const line = (qty: number, unit: number, disc: number) =>
      sql`INSERT INTO invoice_items (invoice_id, product_id, warehouse_id, qty_milli, unit_price_p, discount_p, line_total_p) VALUES (${i!.inv}, ${i!.prod}, ${i!.wh}, ${qty}, ${unit}, ${disc}, 0)`;
    await expect(line(0, 1000, 0)).rejects.toMatchObject({ constraint_name: "invoice_items_qty_chk" });
    await expect(line(2000, 1000, 2001)).rejects.toMatchObject({ constraint_name: "invoice_items_discount_chk" }); // gross = 2,000
    await expect(line(2000, 1000, 2000)).resolves.toBeDefined(); // a discount equal to the gross is allowed
    await sql`DELETE FROM invoice_items WHERE legacy_id IS NULL`;
    const mv = (delta: number, bucket: string) =>
      sql`INSERT INTO stock_movements (date, product_id, warehouse_id, kind, bucket, qty_delta_milli) VALUES ('2026-03-01', ${i!.prod}, ${i!.wh}, 'ADJUSTMENT_IN', ${bucket}, ${delta})`;
    await expect(mv(0, "stock")).rejects.toMatchObject({ constraint_name: "stock_movements_qty_chk" });
    await expect(mv(1000, "quarantine")).rejects.toMatchObject({ constraint_name: "stock_movements_bucket_chk" });
  });

  it("stock_movements is append-only for the application role: it may read and insert, never update or delete (like audit_log); stock_levels stays writable", async () => {
    const app = postgres(TEST_APP_URL, { max: 1, onnotice: () => undefined });
    try {
      expect((await app`SELECT count(*)::int AS n FROM stock_movements`)[0]!.n).toBe(32);
      await expect(app`UPDATE stock_movements SET note = 'tampered'`).rejects.toMatchObject({ code: "42501" });
      await expect(app`DELETE FROM stock_movements`).rejects.toMatchObject({ code: "42501" });
      const [k] = await sql`SELECT p.id AS prod, w.id AS wh FROM products p, warehouses w WHERE p.legacy_id = 'p-3' AND w.legacy_id = 'wh-1'`;
      await app`INSERT INTO stock_movements (date, product_id, warehouse_id, kind, qty_delta_milli) VALUES ('2026-03-01', ${k!.prod}, ${k!.wh}, 'ADJUSTMENT_IN', 1000)`;
      await sql`DELETE FROM stock_movements WHERE legacy_id IS NULL`; // (the admin role cleans up after the test)
      await app`UPDATE stock_levels SET qty_milli = qty_milli WHERE false`; // the services need to update levels: allowed
      expect((await app`SELECT count(*)::int AS n FROM stock_movements`)[0]!.n).toBe(32);
    } finally {
      await app.end();
    }
  });
});

describe("re-importing the same backup", () => {
  it("is idempotent for lines, levels and movements: identical ids, identical rows, identical sums", async () => {
    const dump = async () => ({
      items: await sql`SELECT id, legacy_id, invoice_id, qty_milli::text, unit_price_p::text, line_total_p::text FROM invoice_items ORDER BY legacy_id`,
      levels: await sql`SELECT product_id, warehouse_id, bucket, qty_milli::text FROM stock_levels ORDER BY product_id, warehouse_id, bucket`,
      moves: await sql`SELECT id, legacy_id, source_type, source_id, qty_delta_milli::text FROM stock_movements ORDER BY legacy_id`,
    });
    const first = await dump();
    await runImport(fixture(), IMPORT_OPTS);
    expect(await dump()).toEqual(first);
    expect((await reconcile(fixture(), TEST_ADMIN_URL)).ok).toBe(true);
  });

  it("DRAFT / RETURNED / DISPATCHED statuses are accepted; a fully RETURNED invoice imports and reconciles like any other", async () => {
    const b = mutate((x) => {
      x.data.invoices.find((d: any) => d.id === "inv-5").status = "RETURNED";
      for (const l of x.data.invoiceItems.filter((i: any) => i.invoiceId === "inv-5")) l.returnedQty = l.quantity;
    });
    await runImport(b, IMPORT_OPTS);
    const [r] = await sql`SELECT i.status, sum(l.returned_qty_milli)::text AS returned FROM invoices i JOIN invoice_items l ON l.invoice_id = i.id WHERE i.legacy_id = 'inv-5' GROUP BY i.status`;
    expect(r).toEqual({ status: "RETURNED", returned: "5000" });
    expect((await reconcile(b, TEST_ADMIN_URL)).ok).toBe(true);
    await runImport(fixture(), IMPORT_OPTS);
  });
});

describe("the legacy running-balance chain (informational)", () => {
  const mv = (createdAt: string, delta: number, after: number, over: Record<string, unknown> = {}) => ({ productId: "p", warehouseId: "w", bucket: "stock", createdAt, qtyDelta: delta, balanceAfter: after, ...over });
  it("a consistent chain has no gaps, whatever order the documents were stored in", () => {
    const chain = [mv("2026-01-01T00:00:01Z", 10, 10), mv("2026-01-01T00:00:02Z", -3, 7), mv("2026-01-01T00:00:03Z", 2.5, 9.5)];
    expect(balanceChainGaps(chain)).toBe(0);
    expect(balanceChainGaps([...chain].reverse())).toBe(0);
  });
  it("a step that does not continue the previous one is a gap (someone changed the quantity outside a movement)", () => {
    expect(balanceChainGaps([mv("2026-01-01T00:00:01Z", 10, 10), mv("2026-01-01T00:00:02Z", -3, 7), mv("2026-01-01T00:00:03Z", 2, 12)])).toBe(1);
  });
  it("two movements in the same millisecond are ordered by the chain, not by luck", () => {
    const same = "2026-01-01T00:00:02Z";
    const chain = [mv("2026-01-01T00:00:01Z", 10, 10), mv(same, -3, 7), mv(same, -2, 5)];
    expect(balanceChainGaps(chain)).toBe(0);
    expect(balanceChainGaps([chain[0]!, chain[2]!, chain[1]!])).toBe(0);
  });
  it("chains are per product x warehouse x bucket: the damaged bucket does not disturb the stock bucket", () => {
    expect(balanceChainGaps([mv("2026-01-01T00:00:01Z", 10, 10), mv("2026-01-01T00:00:02Z", 0.6, 0.6, { bucket: "damaged" }), mv("2026-01-01T00:00:03Z", -1, 9)])).toBe(0);
  });
});

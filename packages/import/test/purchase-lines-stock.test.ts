import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { costBasisOf } from "@farooq/shared";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { costBasisFromDoc, createDb, readProfitCostBasis } from "@farooq/db";
import { exitCodeFor, formatReport, prepareImport, reconcile, runImport, type ImportResult, type ReconciliationReport } from "../src/index.js";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";

/**
 * S11: purchase lines, the full purchase header and the average cost, imported from the synthetic fixture and checked against numbers
 * worked out BY HAND (the fixture's own header comment "Purchases (S11)" and the tables below), not against the importer's own output.
 * Amounts are paisa; quantities are asserted in thousandths of a bag.
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

/** purchase → [subtotal, discount amount, tax, freight, loading, other, grand total, total qty, ordered qty, received qty, lines] (quantities in thousandths) */
const HAND_COMPUTED: Record<string, number[]> = {
  "PUR-2026-000001": [840_000, 0, 0, 40_000, 20_000, 0, 900_000, 15_000, 15_000, 15_000, 2], // 12 x 60,000 + 3 x 40,000 + freight 40,000 + loading 20,000
  "PUR-2026-000002": [500_000, 100_000, 0, 0, 0, 0, 400_000, 10_000, 10_000, 0, 1], // DRAFT: 10 x 50,000 - 60,000 (line) - 40,000 (overall) discount, nothing arrived
  "PUR-2026-000003": [300_000, 0, 0, 0, 0, 0, 300_000, 6000, 6000, 6000, 1], // CANCELLED: 6 x 50,000
  "PUR-2026-000004": [100_000, 0, 0, 0, 0, 0, 100_000, 100_000, 100_000, 60_000, 1], // part delivery: 100 x 1,000, 60 arrived
};

describe("purchase header + lines", () => {
  it("every purchase's header holds the hand-computed sub-total, charges, grand total, ordered / received bags and line count", async () => {
    const rows = await sql`
      SELECT purchase_number, subtotal_p::text AS sub, discount_amount_p::text AS disc, tax_p::text AS tax, freight_p::text AS fr, loading_p::text AS ld,
             other_charges_p::text AS ot, total_p::text AS grand, total_qty_milli::text AS qty, ordered_qty_milli::text AS ord,
             received_qty_milli::text AS rec, line_count AS lines
      FROM purchases ORDER BY purchase_number`;
    expect(rows.map((r) => r.purchase_number)).toEqual(Object.keys(HAND_COMPUTED));
    for (const r of rows) {
      expect([r.sub, r.disc, r.tax, r.fr, r.ld, r.ot, r.grand, r.qty, r.ord, r.rec, r.lines].map(Number), r.purchase_number).toEqual(HAND_COMPUTED[r.purchase_number as string]);
    }
  });

  it("the rest of the header is mapped out of legacy_doc: snapshots, godown, edit revision, flags, the old client's operation id; created_by is empty", async () => {
    const [p1] = await sql`
      SELECT p.supplier_name_snapshot, p.warehouse_snapshot, w.legacy_id AS wh, p.status, p.revision, p.stock_applied, p.migrated, p.client_op_id, p.created_by,
             p.legacy_doc->>'createdBy' AS by, p.updated_at
      FROM purchases p JOIN warehouses w ON w.id = p.warehouse_id WHERE p.legacy_id = 'pur-1'`;
    expect(p1).toMatchObject({ supplier_name_snapshot: "Sunrise Mills Ltd", warehouse_snapshot: "Main Godown", wh: "wh-1", status: "RECEIVED", revision: 2, stock_applied: true, migrated: false, client_op_id: "op-pur-1", created_by: null, by: "Fixture" });
    expect(new Date(p1!.updated_at).toISOString()).toBe("2026-02-21T09:00:00.000Z");
    const flags = await sql`SELECT legacy_id, status, stock_applied FROM purchases ORDER BY legacy_id`;
    expect(flags.map((r) => [r.legacy_id, r.status, r.stock_applied])).toEqual([
      ["pur-1", "RECEIVED", true], ["pur-2", "DRAFT", false], ["pur-3", "CANCELLED", false], ["pur-4", "PARTIALLY_RECEIVED", true],
    ]);
  });

  it("every line keeps its own godown, both quantities, its money and the cost figures the legacy stored (hand-computed in the fixture comment)", async () => {
    const rows = await sql`
      SELECT i.legacy_id, w.legacy_id AS wh, p.legacy_id AS prod, i.qty_milli::text AS qty, i.received_qty_milli::text AS rec, i.unit_price_p::text AS unit,
             i.line_total_p::text AS total, i.goods_unit_cost_p::text AS goods, i.charge_share_p::text AS share, i.landed_unit_cost_p::text AS landed,
             i.operational_share_p::text AS op
      FROM purchase_items i JOIN warehouses w ON w.id = i.warehouse_id JOIN products p ON p.id = i.product_id ORDER BY i.legacy_id`;
    expect(rows.map((r) => [r.legacy_id, r.prod, r.wh, r.qty, r.rec, r.unit, r.total, r.goods, r.share, r.landed, r.op])).toEqual([
      // header godown is wh-1, but the second line of PUR-1 and the part delivery went into wh-2: the godown is per LINE
      ["pi-pur-1-1", "p-1", "wh-1", "12000", "12000", "60000", "720000", "60000", "51429", "64286", "0"],
      ["pi-pur-1-2", "p-2", "wh-2", "3000", "3000", "40000", "120000", "40000", "8571", "45857", "9000"],
      ["pi-pur-2-1", "p-3", "wh-1", "10000", "0", "50000", "440000", "44000", "0", "44000", null],
      ["pi-pur-3-1", "p-2", "wh-1", "6000", "6000", "50000", "300000", "50000", "0", "50000", null],
      ["pi-pur-4-1", "p-3", "wh-2", "100000", "60000", "1000", "100000", "1667", "0", "1667", null],
    ]);
  });

  it("receivedQty ABSENT means the whole line arrived (stored resolved, the raw document untouched); 0 means nothing arrived — both kept apart", async () => {
    const rows = await sql`
      SELECT legacy_id, received_qty_milli::text AS rec, legacy_doc ? 'receivedQty' AS has_raw, legacy_doc->>'receivedQty' AS raw
      FROM purchase_items WHERE legacy_id IN ('pi-pur-1-2', 'pi-pur-2-1', 'pi-pur-1-1') ORDER BY legacy_id`;
    expect(rows.map((r) => [r.legacy_id, r.rec, r.has_raw, r.raw])).toEqual([
      ["pi-pur-1-1", "12000", true, "12"],
      ["pi-pur-1-2", "3000", false, null], // absent in the backup -> all 3 bags
      ["pi-pur-2-1", "0", true, "0"], //        an explicit 0 -> nothing arrived
    ]);
    // and the pure step says the same, straight from the backup (no database)
    const prepared = prepareImport(fixture());
    const byLegacy = new Map(prepared.rows.purchaseItems.map((r) => [r.legacyId, r.receivedQtyMilli]));
    expect(byLegacy.get("pi-pur-1-2")).toBe(3000);
    expect(byLegacy.get("pi-pur-2-1")).toBe(0);
    // ...for a different line as well: drop `receivedQty` from the part delivery and it becomes a full delivery (100 bags)
    const dropped = prepareImport(mutate((b) => { delete b.data.purchaseItems.find((i: any) => i.id === "pi-pur-4-1").receivedQty; }));
    expect(dropped.rows.purchaseItems.find((r) => r.legacyId === "pi-pur-4-1")!.receivedQtyMilli).toBe(100_000);
    // ...and set it to 0 and nothing arrived
    const zero = prepareImport(mutate((b) => { b.data.purchaseItems.find((i: any) => i.id === "pi-pur-4-1").receivedQty = 0; }));
    expect(zero.rows.purchaseItems.find((r) => r.legacyId === "pi-pur-4-1")!.receivedQtyMilli).toBe(0);
  });

  it("an operational share of 0 (a cancelled landed cost) is kept as 0, never confused with 'never computed' (NULL)", async () => {
    const rows = await sql`SELECT legacy_id, operational_share_p FROM purchase_items WHERE operational_share_p IS NOT NULL ORDER BY legacy_id`;
    expect(rows.map((r) => [r.legacy_id, Number(r.operational_share_p)])).toEqual([["pi-pur-1-1", 0], ["pi-pur-1-2", 9000]]);
  });

  it("DRAFT posts, CANCELLED does not, and the four purchases still owe the suppliers what every M1 number was built on", async () => {
    const rows = await sql`
      SELECT p.legacy_id, count(e.id)::int AS entries FROM purchases p
      LEFT JOIN journal_entries e ON e.source_id = p.id AND e.source_type = 'PURCHASE' GROUP BY p.legacy_id ORDER BY p.legacy_id`;
    expect(rows.map((r) => [r.legacy_id, r.entries])).toEqual([["pur-1", 1], ["pur-2", 1], ["pur-3", 0], ["pur-4", 1]]);
    expect(result.journalEntries).toBe(35);
    expect(report.suppliers.differences).toEqual([]);
    expect(report.totals.payables.newNetP).toBe(1_312_000);
  });
});

describe("the three reconciliation checks on the fixture (hand-computed)", () => {
  it("passes with 0 mismatches of any kind, exit code 0", () => {
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(exitCodeFor(report)).toBe(0);
  });

  it("purchase totals: 3 non-cancelled purchases with 4 lines (125 bags ordered, 75 received) recomputed, the cancelled one not checked", () => {
    expect(report.purchases).toEqual({
      checked: 3, lines: 4, orderedQtyMilli: 125_000, receivedQtyMilli: 75_000, totalMismatches: [], noLines: [], cancelled: 1, migrated: [], migratedMismatches: [],
    });
  });

  it("purchase <-> stock: 4 purchases checked against 9 purchase movements — the edit's reverse-and-re-add and the cancelled purchase's +6 -6 all net out", () => {
    // pur-1: p-1 @wh-1 +12 -12 +12 and p-2 @wh-2 +3 -3 +3 (6 movements); pur-3 +6 -6; pur-4 +60; pur-2 nothing arrived
    expect(report.purchaseStock).toEqual({ purchasesChecked: 4, migratedSkipped: [], movementsChecked: 9, mismatches: [] });
  });

  it("average cost: 3 stock rows recomputed from purchase lines and matched (64,286 / 45,857 / 1,667); the 3 rows with no received purchase line are LISTED", () => {
    const a = report.averageCost;
    expect(a.basis).toBe("LANDED");
    expect([a.rows, a.matched, a.mismatches]).toEqual([3, 3, []]);
    expect([...a.keptFromBefore].sort((x, y) => `${x.product}${x.warehouse}`.localeCompare(`${y.product}${y.warehouse}`))).toEqual([
      { product: "p-1", warehouse: "wh-2", avgCostP: 80_000 }, //    no purchase line at all
      { product: "p-2", warehouse: "wh-1", avgCostP: 85_000 }, //    its only purchase line is on the CANCELLED pur-3
      { product: "p-3", warehouse: "wh-1", avgCostP: 0 }, //         its only purchase line received nothing (pur-2)
    ]);
  });

  it("operational share = the landed-cost rows of the backup (a POSTED one counts, a CANCELLED one adds nothing); landed unit = goods + charges + operational", () => {
    const a = report.averageCost;
    expect(a.operationalShare).toEqual({ linesChecked: 5, withShare: 1, orphanRows: [], mismatches: [] });
    // costed lines that received bags: PUR-1's two lines and PUR-4's; PUR-2's received nothing (skipped, not failed)
    expect(a.landedUnit).toEqual({ linesChecked: 3, skippedNothingReceived: 1, mismatches: [] });
  });

  it("informational: the part delivery's stored goods unit (the LEGACY figure, 1,667) differs from the fixed allocation (1,000) — and nothing else does", () => {
    expect(report.averageCost.allocation).toEqual({
      linesChecked: 4,
      differs: [{ purchase: "PUR-2026-000004", line: "pi-pur-4-1", storedGoodsUnitP: 1667, goodsUnitP: 1000, storedChargeShareP: 0, chargeShareP: 0 }],
    });
  });

  it("the printed report says the real numbers", () => {
    const text = formatReport(report);
    expect(text).toContain("3 checked (totals recomputed from 4 lines, 125 bags ordered, 75 received), 0 total mismatch(es); 1 cancelled not checked, 0 purchase(s) without lines");
    expect(text).toContain("4 purchases vs 9 purchase movements, 0 mismatch(es); 0 migrated purchase(s) skipped");
    expect(text).toContain("basis LANDED: 3 stock row(s) recomputed from purchase lines, 3 matched, 0 mismatched; 3 kept from before");
    expect(text).toContain("· kept from before: product p-1 @ warehouse wh-2, average 80,000 paisa");
    expect(text).toContain("landed unit = goods + charges + operational on 3 costed line(s), 0 mismatch(es)");
    expect(text).toContain("1 of 4 line(s) carry a goods unit / charge share that the fixed allocation");
  });
});

describe("the cost basis comes from the imported settings", () => {
  it("missing = LANDED (the legacy default); PURCHASE only when the setting says so — the db helper and the shared one agree on every value", async () => {
    for (const v of [undefined, null, "", "LANDED", "PURCHASE", "purchase", 7]) {
      expect(costBasisFromDoc({ profitCostBasis: v })).toBe(costBasisOf(v));
    }
    expect(costBasisFromDoc(null)).toBe("LANDED");
    const { client, db } = createDb(TEST_ADMIN_URL);
    try {
      expect(await readProfitCostBasis(db)).toBe("LANDED"); // the fixture's business document has no profitCostBasis
    } finally {
      await client.end();
    }
  });

  it("with `profitCostBasis: PURCHASE` the average is recomputed on the goods price alone — the fixture's stored (LANDED) averages then differ, and the report names the figures", async () => {
    const backup = mutate((b) => { b.data.business[0].profitCostBasis = "PURCHASE"; });
    await runImport(backup, IMPORT_OPTS);
    const { client, db } = createDb(TEST_ADMIN_URL);
    try {
      expect(await readProfitCostBasis(db)).toBe("PURCHASE");
    } finally {
      await client.end();
    }
    const r = await reconcile(backup, TEST_ADMIN_URL);
    expect(r.averageCost.basis).toBe("PURCHASE");
    // p-1@wh-1: goods 60,000 (not 64,286); p-2@wh-2: goods 40,000 (not 45,857); p-3@wh-2: goods 1,667 (the legacy figure) = stored
    expect(r.averageCost.mismatches.map((m) => [m.product, m.warehouse, m.recomputedP, m.storedP]).sort()).toEqual([
      ["p-1", "wh-1", 60_000, 64_286],
      ["p-2", "wh-2", 40_000, 45_857],
    ]);
    expect(r.ok).toBe(false);
    await runImport(fixture(), IMPORT_OPTS); // put the fixture back for the next test file
  });
});

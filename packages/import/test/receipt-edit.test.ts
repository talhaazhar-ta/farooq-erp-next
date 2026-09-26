import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImportError, prepareImport, reconcile, runImport } from "../src/index.js";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { MOVEMENT_KINDS, MOVEMENT_REF_TYPES } from "@farooq/db";
import { IMPORT_OPTS, adminSql, fixture, mutate } from "./helpers.js";

/**
 * S14, old repo `b2b0778` — a posted Add-stock receipt can be edited (`StockDocs.editReceive`, 07-transactions.js): every old line comes
 * back OUT of stock as `RECEIPT_EDIT_OUT` (refType `STOCK_RECEIPT_EDIT`, ref = the receipt's RCV number) dated as the ORIGINAL receipt and
 * carrying the OLD line's cost (`unitCostP: o.unitCostP || 0`), then the corrected lines go in as `ADJUSTMENT_IN` / `STOCK_RECEIPT`.
 *
 * The fixture has one (build-fixture.ts, mv-31 / mv-32): RCV-2026-000004, p-1 @ wh-2, 30 bags @ 800.00 edited to 30 @ 900.00.
 *   the bags net 0:  32 stay in the godown; Σ movements = 30 (+30 receipt) + 5 (transfer) − 3 (inv-5) − 30 + 30 = 32
 *   carried cost:    (30 x 80,000 − 30 x 80,000 + 30 x 90,000) / 30 = 90,000 — asserted in apps/api `invoices-cost.test.ts` on this same fixture
 */
const sql = adminSql();
beforeAll(async () => {
  await runImport(fixture(), IMPORT_OPTS);
});
afterAll(async () => {
  await sql.end();
});

describe("the vocabulary", () => {
  it("RECEIPT_EDIT_OUT and STOCK_RECEIPT_EDIT are known names (and they are plain text in the database: no migration, no CHECK on kind / ref_type)", async () => {
    expect(MOVEMENT_KINDS).toContain("RECEIPT_EDIT_OUT");
    expect(MOVEMENT_REF_TYPES).toContain("STOCK_RECEIPT_EDIT");
    const checks = await sql`SELECT conname FROM pg_constraint WHERE conrelid = 'stock_movements'::regclass AND contype = 'c' ORDER BY conname`;
    expect(checks.map((c) => c.conname)).toEqual(["stock_movements_bucket_chk", "stock_movements_qty_chk"]);
  });
});

describe("the fixture's receipt edit is imported", () => {
  it("the reversal keeps its negative quantity, the OLD cost, the original date, the receipt number and a source type named like its ref type", async () => {
    const rows = await sql`
      SELECT m.kind, m.qty_delta_milli::int AS q, m.unit_cost_p::int AS cost, m.date::text AS date, m.ref, m.ref_type, m.source_type, m.source_id, m.bucket
      FROM stock_movements m WHERE m.kind = 'RECEIPT_EDIT_OUT'`;
    expect(rows).toEqual([{ kind: "RECEIPT_EDIT_OUT", q: -30_000, cost: 80_000, date: "2026-01-10", ref: "RCV-2026-000004", ref_type: "STOCK_RECEIPT_EDIT", source_type: "STOCK_RECEIPT_EDIT", source_id: null, bucket: "stock" }]);
  });

  it("the edited receipt's movements: +30 @ 800, −30 @ 800 (the reversal), +30 @ 900 — the level is 32 = Σ movements, and reconciliation finds no stock mismatch", async () => {
    const rows = await sql`
      SELECT m.kind, m.qty_delta_milli::int AS q, m.unit_cost_p::int AS cost FROM stock_movements m
      WHERE m.ref IN ('RCV-2026-000004') ORDER BY m.date, m.created_at, m.id`;
    expect(rows.map((r) => [r.kind, r.q, r.cost])).toEqual([["ADJUSTMENT_IN", 30_000, 80_000], ["RECEIPT_EDIT_OUT", -30_000, 80_000], ["ADJUSTMENT_IN", 30_000, 90_000]]);
    const [lvl] = await sql`
      SELECT l.qty_milli::int AS q, (SELECT SUM(m.qty_delta_milli)::int FROM stock_movements m WHERE m.product_id = l.product_id AND m.warehouse_id = l.warehouse_id AND m.bucket = 'stock') AS s
      FROM stock_levels l JOIN products p ON p.id = l.product_id JOIN warehouses w ON w.id = l.warehouse_id
      WHERE p.legacy_id = 'p-1' AND w.legacy_id = 'wh-2' AND l.bucket = 'stock'`;
    expect(lvl).toEqual({ q: 32_000, s: 32_000 });
    const report = await reconcile(fixture(), TEST_ADMIN_URL);
    expect(report.stock.mismatches).toEqual([]);
    expect(report.stock.movements).toBe(32);
    expect(report.failures).toEqual([]);
  });
});

describe("a RECEIPT_EDIT_OUT that does not look like one aborts the import (fail loudly)", () => {
  const reversal = (b: any) => b.data.stockMovements.find((m: any) => m.kind === "RECEIPT_EDIT_OUT");
  const cases: [string, () => unknown, RegExp][] = [
    ["a reversal that ADDS bags", () => mutate((b) => { reversal(b).qtyDelta = 30; }), /stockMovements\[id=mv-31\]\.qtyDelta: a RECEIPT_EDIT_OUT takes bags back out of stock, so it must be negative \(got 30\)/],
    ["a reversal with no cost field at all", () => mutate((b) => { delete reversal(b).unitCostP; }), /stockMovements\[id=mv-31\]\.unitCostP: a RECEIPT_EDIT_OUT carries the old line's cost \(0 when it had none\) — the field is missing/],
    ["a reversal whose cost is null", () => mutate((b) => { reversal(b).unitCostP = null; }), /stockMovements\[id=mv-31\]\.unitCostP: a RECEIPT_EDIT_OUT carries the old line's cost/],
    ["a reversal with a fractional-paisa cost", () => mutate((b) => { reversal(b).unitCostP = 80_000.5; }), /stockMovements\[id=mv-31\]\.unitCostP: money must be an integer/],
    ["a reversal of nothing", () => mutate((b) => { reversal(b).qtyDelta = 0; }), /stockMovements\[id=mv-31\]\.qtyDelta: a movement of zero is not a movement/],
    ["a reversal with an unknown refType", () => mutate((b) => { reversal(b).refType = "STOCK_RECEIPT_REDO"; }), /stockMovements\[id=mv-31\]\.refType: unknown value "STOCK_RECEIPT_REDO"/],
    ["an unknown neighbour kind still aborts", () => mutate((b) => { reversal(b).kind = "RECEIPT_EDIT_IN"; }), /stockMovements\[id=mv-31\]\.kind: unknown value "RECEIPT_EDIT_IN"/],
  ];
  it.each(cases)("%s", async (_n, backup, message) => {
    const attempt = runImport(backup() as never, IMPORT_OPTS);
    await expect(attempt).rejects.toBeInstanceOf(ImportError);
    await expect(attempt).rejects.toThrow(message);
  });

  it("the guard is real: a reversal whose old line had NO cost (the legacy writes `0`) imports, stored as 'no cost recorded' (NULL)", async () => {
    await runImport(mutate((b) => { reversal(b).unitCostP = 0; }), IMPORT_OPTS);
    const [r] = await sql`SELECT unit_cost_p::text AS c FROM stock_movements WHERE kind = 'RECEIPT_EDIT_OUT'`;
    expect(r!.c).toBeNull();
    await runImport(fixture(), IMPORT_OPTS); // leave the fixture behind
  });
});

describe("the Prices-panel extra cost per bag reaches products.extra_p exactly as `Prices.of` reads it (S14 rule 1)", () => {
  const priced = (doc: Record<string, unknown>) => prepareImport(mutate((b) => { Object.assign(b.data.products[2], doc); })).rows.products.find((r) => r.legacyId === "p-3")!;
  it("`extraP` wins even at 0; else the rupee `extra` when truthy (200 -> 20,000 paisa); else never set", () => {
    expect(priced({ extraP: 20_000, extra: 1 })).toMatchObject({ extraP: 20_000 });
    expect(priced({ extraP: 0, extra: 200 })).toMatchObject({ extraP: 0 });
    expect(priced({ extra: 200 })).toMatchObject({ extraP: 20_000 });
    expect(priced({ extra: "200.50" })).toMatchObject({ extraP: 20_050 });
    expect(priced({ extra: 0 })).toMatchObject({ extraP: null });
  });
});

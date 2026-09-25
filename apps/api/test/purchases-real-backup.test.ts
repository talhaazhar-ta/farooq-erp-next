import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkEnvelope, exitCodeFor, reconcile, runImport, type Backup } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { getPur, purEditBody, putPur } from "./helpers/purchases.js";

/**
 * S12 on REAL data (local only — the backups are business data, gitignored under /data/, never in CI; only counts are printed): import the
 * newest nightly, then save EVERY real, non-cancelled purchase back through `PUT /purchases/:id` with nothing changed — as an office user
 * opening a bill and pressing Save would. An edit that changes nothing must change nothing: the same totals, the same paid figures, the same
 * bags, the same supplier balances, the same journal, the same average cost on every stock row (the legacy weighted average recomputed by
 * the S12 writer equals what the legacy itself stored, including the first real landed cost), and the reconciliation against the untouched
 * backup still has 0 differences.
 */
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data");
const newest = existsSync(dataDir)
  ? readdirSync(dataDir)
      .filter((f) => /^business-.*\.json$/.test(f))
      .sort()
      .slice(-1)[0]
  : undefined;

describe.skipIf(!newest)("the newest real nightly: every purchase saved back unchanged (local only)", () => {
  let h: Harness;
  let owner: Session;
  let backup: Backup;
  beforeAll(async () => {
    backup = checkEnvelope(JSON.parse(readFileSync(path.join(dataDir, newest!), "utf8")));
    await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "purchases-real-backup" });
    h = await createHarness();
    owner = await h.session("OWNER");
  });
  afterAll(async () => {
    await h.close();
  });

  const state = async () => ({
    levels: await h.admin`SELECT product_id, warehouse_id, bucket, qty_milli::text AS qty, avg_cost_p::text AS avg FROM stock_levels ORDER BY product_id, warehouse_id, bucket`,
    balances: await h.admin`SELECT l.party_id, SUM(l.credit_p - l.debit_p)::text AS b FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = 'PAYABLES' GROUP BY l.party_id ORDER BY l.party_id`,
    purchases: await h.admin`SELECT id, total_p::text AS total, subtotal_p::text AS subtotal, discount_amount_p::text AS disc, tax_p::text AS tax, status, received_qty_milli::text AS recv, ordered_qty_milli::text AS ord, line_count FROM purchases ORDER BY id`,
    items: await h.admin`SELECT id, qty_milli::text AS q, received_qty_milli::text AS r, unit_price_p::text AS u, line_total_p::text AS t, operational_share_p::text AS op, goods_unit_cost_p::text AS g, charge_share_p::text AS c, landed_unit_cost_p::text AS l FROM purchase_items ORDER BY id`,
    entries: await h.admin`SELECT e.source_id, e.date::text AS date, SUM(l.debit_p)::text AS d FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.source_type = 'PURCHASE' GROUP BY e.id ORDER BY e.source_id`,
    movements: (await h.admin`SELECT count(*)::int AS n FROM stock_movements`)[0]!.n as number,
    vouchers: (await h.admin`SELECT count(*)::int AS n FROM payments`)[0]!.n as number,
  });

  it("nothing moves: totals, paid, bags, balances, journal and every average cost are as imported; the reconciliation still has 0 differences", async () => {
    const before = await state();
    const ids = (await h.admin`SELECT id FROM purchases WHERE status <> 'CANCELLED' ORDER BY purchase_number NULLS LAST, id`).map((r) => r.id as string);
    expect(ids.length).toBeGreaterThan(0);

    let saved = 0;
    let lines = 0;
    for (const id of ids) {
      const detail = (await getPur(h, owner, id)).body;
      lines += detail.lines.length;
      const r = await putPur(h, owner, id, purEditBody(detail));
      // a purchase the legacy left without lines cannot be re-saved (a purchase needs a line): that is the one thing an unchanged save may refuse
      if (detail.lines.length === 0) {
        expect(r.status, `${detail.number} has no lines`).toBe(422);
        continue;
      }
      expect(r.status, `${detail.number}: ${JSON.stringify(r.body)}`).toBe(200);
      expect(r.body.totalP, detail.number).toBe(detail.totalP);
      expect(r.body.paidP, detail.number).toBe(detail.paidP);
      expect(r.body.receivedQuantity, detail.number).toBe(detail.receivedQuantity);
      saved++;
    }
    console.log(`\n=== ${newest} ===\npurchases saved back unchanged: ${saved} of ${ids.length} (${lines} lines)`);

    const after = await state();
    expect(after.levels).toEqual(before.levels); // bags AND average cost of every stock row
    expect(after.balances).toEqual(before.balances);
    expect(after.purchases).toEqual(before.purchases);
    expect(after.items).toEqual(before.items); // every cost column re-written by the S12 writer equals what the legacy stored
    expect(after.entries).toEqual(before.entries);
    expect(after.movements).toBe(before.movements); // an unchanged save posts no stock movement
    expect(after.vouchers).toBe(before.vouchers); // ... and no voucher

    const report = await reconcile(backup, TEST_ADMIN_URL);
    expect(report.failures).toEqual([]);
    expect(exitCodeFor(report)).toBe(0);
    expect(report.suppliers.differences).toEqual([]);
    expect(report.purchases.totalMismatches).toEqual([]);
    expect(report.purchaseStock.mismatches).toEqual([]);
    expect(report.averageCost.mismatches).toEqual([]);
    expect(report.averageCost.operationalShare.mismatches).toEqual([]);
    expect(report.averageCost.landedUnit.mismatches).toEqual([]);
    console.log(`reconciliation after the saves: 0 differences; average cost (${report.averageCost.basis}): matched ${report.averageCost.matched} of ${report.averageCost.rows}`);
  });
});

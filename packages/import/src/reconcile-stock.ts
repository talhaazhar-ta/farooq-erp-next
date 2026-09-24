import type postgres from "postgres";
import { invoiceTotals } from "@farooq/shared";
import type { Backup } from "./validate.js";
import type { InvoiceMismatch, InvoiceStockMismatch, ReconciliationReport, StockMismatch } from "./reconcile.js";

/**
 * S6's three checks. Like the balance check, each compares two things that never call each other:
 *   1. invoice totals     the shared port of the legacy `Calc`, run over the invoice LINES in the database, against the header
 *                         the invoice carries (total, sub-totals, quantity, line count) and every stored line total;
 *   2. stock              the legacy `inventory` rows (from the raw backup) against `stock_levels` against Σ `stock_movements`;
 *   3. invoice <-> stock  every invoice's stock movements net to minus its line quantities.
 * A mismatch is named (invoice number / legacy ids), never just counted.
 */

const num = (v: unknown): number => Number(v);
const milli = (qty: unknown): number => Math.round(Number(qty) * 1000);

type Client = postgres.Sql;

export interface InvoiceStockChecks {
  invoices: ReconciliationReport["invoices"];
  stock: ReconciliationReport["stock"];
  invoiceStock: ReconciliationReport["invoiceStock"];
}

export async function checkInvoicesAndStock(client: Client, backup: Backup): Promise<InvoiceStockChecks> {
  const invoiceHeaders = await client`
    SELECT id, invoice_number, legacy_id, status, migrated, stock_applied, total_p::text AS total_p, subtotal_p::text AS subtotal_p,
           item_discounts_p::text AS item_discounts_p, invoice_discount_p::text AS invoice_discount_p, tax_p::text AS tax_p,
           freight_p::text AS freight_p, loading_p::text AS loading_p, other_charges_p::text AS other_charges_p,
           total_qty_milli::text AS total_qty_milli, line_count, legacy_doc->>'discountAmount' AS legacy_discount_amount
    FROM invoices ORDER BY invoice_number NULLS LAST, legacy_id`;
  const lineRows = await client`
    SELECT invoice_id, product_id, sort_order, qty_milli::text AS qty_milli, unit_price_p::text AS unit_price_p,
           discount_p::text AS discount_p, tax_p::text AS tax_p, line_total_p::text AS line_total_p
    FROM invoice_items ORDER BY invoice_id, sort_order, id`;
  const linesOf = new Map<string, postgres.Row[]>();
  for (const l of lineRows) {
    const list = linesOf.get(l.invoice_id as string);
    if (list) list.push(l);
    else linesOf.set(l.invoice_id as string, [l]);
  }

  /* ── 1. invoice totals ─────────────────────────────────────────────── */
  const invoices: InvoiceStockChecks["invoices"] = {
    checked: 0, lines: 0, qtyMilli: 0, totalMismatches: [], noLines: [], drafts: 0, migrated: [], migratedMismatches: [],
  };
  const nameOf = (h: postgres.Row): string => (h.invoice_number as string | null) ?? `(draft ${h.legacy_id as string})`;
  for (const h of invoiceHeaders) {
    const lines = linesOf.get(h.id as string) ?? [];
    if (h.migrated) invoices.migrated.push(nameOf(h));
    if (h.status === "DRAFT") {
      invoices.drafts++;
      continue;
    }
    if (lines.length === 0) {
      invoices.noLines.push(nameOf(h));
      continue;
    }
    const t = invoiceTotals({
      lines: lines.map((l) => ({ qtyMilli: num(l.qty_milli), unitPriceP: num(l.unit_price_p), discountP: num(l.discount_p), taxP: num(l.tax_p) })),
      invoiceDiscountP: num(h.invoice_discount_p),
      freightP: num(h.freight_p),
      loadingP: num(h.loading_p),
      otherChargesP: num(h.other_charges_p),
    });
    const problems: string[] = [];
    const cmp = (what: string, recomputed: number, stored: number) => {
      if (recomputed !== stored) problems.push(`${what}: lines give ${recomputed}, header says ${stored}`);
    };
    cmp("grand total", t.grandTotalP, num(h.total_p));
    cmp("subtotal", t.subtotalP, num(h.subtotal_p));
    cmp("item discounts", t.itemDiscountsP, num(h.item_discounts_p));
    cmp("invoice discount", t.invoiceDiscountP, num(h.invoice_discount_p));
    cmp("discount amount", t.discountAmountP, num(h.item_discounts_p) + num(h.invoice_discount_p));
    if (h.legacy_discount_amount !== null && h.legacy_discount_amount !== undefined) cmp("legacy discountAmount", t.discountAmountP, num(h.legacy_discount_amount));
    cmp("tax", t.taxP, num(h.tax_p));
    cmp("quantity (thousandths)", t.totalQtyMilli, num(h.total_qty_milli));
    cmp("line count", t.lineCount, num(h.line_count));
    lines.forEach((l, i) => cmp(`line ${i + 1} total`, t.lines[i]!.lineTotalP, num(l.line_total_p)));
    if (h.migrated) {
      if (problems.length) invoices.migratedMismatches.push({ invoice: nameOf(h), problems });
    } else if (problems.length) {
      invoices.totalMismatches.push({ invoice: nameOf(h), problems } satisfies InvoiceMismatch);
    }
    invoices.checked++;
    invoices.lines += lines.length;
    invoices.qtyMilli += t.totalQtyMilli;
  }

  /* ── 2. stock: legacy inventory = stock_levels = Σ stock_movements ─── */
  const key = (p: string, w: string, b: string) => `${p}\u0000${w}\u0000${b}`;
  const legacyLevels = new Map<string, number>();
  for (const r of backup.data.inventory ?? []) {
    legacyLevels.set(key(r.productId, r.warehouseId, "stock"), milli(r.qty));
    legacyLevels.set(key(r.productId, r.warehouseId, "damaged"), milli(r.damagedQty ?? 0));
  }
  const levelRows = await client`
    SELECT p.legacy_id AS p, w.legacy_id AS w, l.bucket, l.qty_milli::text AS q
    FROM stock_levels l JOIN products p ON p.id = l.product_id JOIN warehouses w ON w.id = l.warehouse_id`;
  const levels = new Map<string, number>(levelRows.map((r) => [key(r.p as string, r.w as string, r.bucket as string), num(r.q)]));
  const moveRows = await client`
    SELECT p.legacy_id AS p, w.legacy_id AS w, m.bucket, SUM(m.qty_delta_milli)::text AS q, count(*)::text AS n
    FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
    GROUP BY p.legacy_id, w.legacy_id, m.bucket`;
  const sums = new Map<string, number>(moveRows.map((r) => [key(r.p as string, r.w as string, r.bucket as string), num(r.q)]));
  const movements = moveRows.reduce((a, r) => a + num(r.n), 0);

  const stock: InvoiceStockChecks["stock"] = { rows: 0, movements, stockQtyMilli: 0, damagedQtyMilli: 0, mismatches: [], chainGaps: 0 };
  const allKeys = new Set([...legacyLevels.keys(), ...levels.keys(), ...sums.keys()]);
  for (const k of [...allKeys].sort()) {
    const [p, w, bucket] = k.split("\u0000") as [string, string, string];
    const legacyMilli = legacyLevels.get(k) ?? 0;
    const levelMilli = levels.get(k) ?? 0;
    const movementsMilli = sums.get(k) ?? 0;
    // A damaged row that is 0 everywhere is simply not there (the importer only writes one when it holds stock).
    if (bucket === "damaged" && legacyMilli === 0 && levelMilli === 0 && movementsMilli === 0) continue;
    stock.rows++;
    if (bucket === "damaged") stock.damagedQtyMilli += levelMilli;
    else stock.stockQtyMilli += levelMilli;
    if (legacyMilli !== levelMilli || levelMilli !== movementsMilli) {
      stock.mismatches.push({ product: p, warehouse: w, bucket, legacyMilli, levelMilli, movementsMilli } satisfies StockMismatch);
    }
  }
  stock.chainGaps = balanceChainGaps(backup.data.stockMovements ?? []);

  /* ── 3. invoice <-> stock ──────────────────────────────────────────── */
  const invoiceStock: InvoiceStockChecks["invoiceStock"] = { invoicesChecked: 0, migratedSkipped: 0, movementsChecked: 0, mismatches: [] };
  const netRows = await client`
    SELECT source_id, product_id, SUM(qty_delta_milli)::text AS net, count(*)::text AS n
    FROM stock_movements WHERE source_type = 'INVOICE' GROUP BY source_id, product_id`;
  const netOf = new Map<string, Map<string, number>>();
  for (const r of netRows) {
    const m = netOf.get(r.source_id as string) ?? new Map<string, number>();
    m.set(r.product_id as string, num(r.net));
    netOf.set(r.source_id as string, m);
    invoiceStock.movementsChecked += num(r.n);
  }
  const productName = new Map<string, string>((await client`SELECT id, legacy_id FROM products`).map((r) => [r.id as string, r.legacy_id as string]));
  for (const h of invoiceHeaders) {
    if (h.migrated) {
      invoiceStock.migratedSkipped++;
      continue;
    }
    invoiceStock.invoicesChecked++;
    // What the lines say went out: their quantity per product when the invoice holds stock, nothing when it does not
    // (a draft, a cancelled invoice, an invoice saved back to draft: every deduction has been reversed).
    const expected = new Map<string, number>();
    if (h.stock_applied) {
      for (const l of linesOf.get(h.id as string) ?? []) expected.set(l.product_id as string, (expected.get(l.product_id as string) ?? 0) - num(l.qty_milli));
    }
    const net = netOf.get(h.id as string) ?? new Map<string, number>();
    for (const product of new Set([...expected.keys(), ...net.keys()])) {
      const e = expected.get(product) ?? 0;
      const n = net.get(product) ?? 0;
      if (e !== n) invoiceStock.mismatches.push({ invoice: nameOf(h), product: productName.get(product) ?? product, expectedMilli: e, netMilli: n } satisfies InvoiceStockMismatch);
    }
  }

  return { invoices, stock, invoiceStock };
}

/**
 * Informational: the legacy stamps `balanceAfter` (the running quantity) on every movement. Following each
 * (product, warehouse, bucket) chain in time order, a step whose start (`balanceAfter - qtyDelta`) is not the previous
 * step's end is a gap. Movements made in the same millisecond have no defined order, so among those the one that
 * continues the chain is taken. Reported, never failed: the stock check above is the proof; a gap only says the old
 * app's running figures were touched by something other than a movement (a manual fix, a data migration).
 */
export function balanceChainGaps(movements: Record<string, any>[]): number {
  const chains = new Map<string, Record<string, any>[]>();
  for (const m of movements) {
    const k = `${m.productId}|${m.warehouseId}|${m.bucket ?? "stock"}`;
    const list = chains.get(k);
    if (list) list.push(m);
    else chains.set(k, [m]);
  }
  let gaps = 0;
  for (const list of chains.values()) {
    const remaining = [...list].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    let running: number | null = null;
    while (remaining.length) {
      const at = remaining[0]!.createdAt;
      const tied = remaining.filter((m) => m.createdAt === at);
      const start = (m: Record<string, any>) => milli(m.balanceAfter) - milli(m.qtyDelta);
      const next = running === null ? tied[0]! : (tied.find((m) => start(m) === running) ?? tied[0]!);
      if (running !== null && start(next) !== running) gaps++;
      running = milli(next.balanceAfter);
      remaining.splice(remaining.indexOf(next), 1);
    }
  }
  return gaps;
}

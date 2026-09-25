import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "@farooq/db";
import {
  milliToQty,
  parseSearchQuery,
  PURCHASE_PAYMENT_STATUSES,
  PURCHASE_SEARCH_PROBLEMS,
  type ListPurchasesQuery,
  type PurchaseHit,
  type PurchaseSort,
  type SearchInterpretation,
} from "@farooq/shared";
import { hasTerm } from "../invoices/invoices.search.js";

/**
 * The purchase list's search, on the server (S13). The legacy Purchases page matched the whole box, lower-cased, as ONE substring of
 * the first line's product text (`pTxt`), the supplier's current name and the supplier's bill number, and filtered by the header godown,
 * the first line's category, the stored payment word and a date preset. This is S4 / S8's engine (`fold_search`, generated `search_*`
 * columns, `parseSearchQuery`) over a wider set of fields, so everything the old list found is still found (the parity test proves it):
 *
 *  - every space-separated word must be found (AND, any order), substring match, Urdu / English folding;
 *  - a word is looked for in: the purchase number (and its compact form), the supplier's bill number (and compact), the delivery
 *    reference; the supplier as PRINTED on the bill and as it is NOW; the amount forms; the date forms; the vehicle (and compact),
 *    driver, header godown, notes and description; and every LINE — as printed (English / Urdu name, brand, package) and the line
 *    product's CURRENT text (the legacy `pTxt`: names, brand, category, SKU, code, bag weight, catalogue folio);
 *  - a date typed into the box becomes a date filter (replacing from / to) and is echoed back, not searched as text;
 *  - the godown filter matches the header godown OR any line's godown; the category filter any line's product (the legacy looked at
 *    the first line only — a two-line purchase is no longer hidden by its first line);
 *  - the payment status is derived from the allocations of POSTED vouchers (a reversed voucher no longer counts) — never stored.
 * The list is built from `purchases` + allocations — never from the journal.
 */

export type PurchaseFilters = Omit<ListPurchasesQuery, "limit" | "offset">;

interface DateBound {
  from: string | null;
  to: string | null;
}

export interface PurchaseSearchReading {
  interpreted: SearchInterpretation;
  ranges: DateBound[] | null;
}

export function readPurchaseFilters(f: PurchaseFilters): PurchaseSearchReading {
  const parsed = parseSearchQuery(f.q ?? "");
  const problems: string[] = [];
  let ranges: DateBound[] | null = null;
  let replaced = false;
  if (parsed.dates.length) {
    ranges = parsed.dates.map((d) => ({ from: d.from, to: d.to }));
    replaced = Boolean(f.from || f.to);
  } else if (f.from || f.to) {
    if (f.from && f.to && f.from > f.to) problems.push(PURCHASE_SEARCH_PROBLEMS.fromAfterTo);
    ranges = [{ from: f.from ?? null, to: f.to ?? null }];
  }
  return {
    interpreted: {
      terms: parsed.terms,
      dates: parsed.dates.map((d) => ({ label: d.label, from: d.from, to: d.to, src: d.src, dayFirst: d.dayFirst })),
      dateFilterReplaced: replaced,
      problems,
    },
    ranges,
  };
}

/** A word matches when a field holds it — or, for a phrase, holds it with the spaces removed (legacy `hasTerm`). */
function has(col: SQL, term: string): SQL {
  const squeezed = term.includes(" ") ? term.replace(/ /g, "") : "";
  return squeezed ? sql`(strpos(${col}, ${term}) > 0 OR strpos(${col}, ${squeezed}) > 0)` : sql`strpos(${col}, ${term}) > 0`;
}

function termCondition(term: string): SQL {
  const own = ["search_numbers", "search_supplier", "search_amount", "search_date", "search_other"].map((c) => has(sql.raw(`COALESCE(b.${c}, '')`), term));
  own.push(has(sql.raw(`COALESCE(b.sup_text, '')`), term));
  own.push(sql`EXISTS (SELECT 1 FROM purchase_items pi LEFT JOIN products pr ON pr.id = pi.product_id
                       WHERE pi.purchase_id = b.id AND (${has(sql.raw(`COALESCE(pi.search_text, '')`), term)} OR ${has(sql.raw(`COALESCE(pr.search_text, '')`), term)}))`);
  return sql`(${sql.join(own, sql` OR `)})`;
}

function structuralConditions(f: PurchaseFilters, reading: PurchaseSearchReading): SQL[] {
  const conds: SQL[] = [];
  if (f.warehouseId) conds.push(sql`(p.warehouse_id = ${f.warehouseId} OR EXISTS (SELECT 1 FROM purchase_items wi WHERE wi.purchase_id = p.id AND wi.warehouse_id = ${f.warehouseId}))`);
  if (f.category) conds.push(sql`EXISTS (SELECT 1 FROM purchase_items ci JOIN products cp ON cp.id = ci.product_id WHERE ci.purchase_id = p.id AND cp.category = ${f.category})`);
  if (reading.ranges) {
    const any = reading.ranges.map((r) => {
      const parts: SQL[] = [];
      if (r.from) parts.push(sql`p.date >= ${r.from}::date`);
      if (r.to) parts.push(sql`p.date <= ${r.to}::date`);
      return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : sql`TRUE`;
    });
    conds.push(sql`(${sql.join(any, sql` OR `)})`);
  }
  return conds;
}

const whereOf = (conds: SQL[]): SQL => (conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``);

/** Business date, then entry time, then the number (byte order), then the id: a total order. */
const NEWEST_FIRST = `date DESC, created_at DESC, purchase_number COLLATE "C" DESC NULLS LAST, id DESC`;
const OLDEST_FIRST = `date ASC, created_at ASC, purchase_number COLLATE "C" ASC NULLS FIRST, id ASC`;

export function purchaseOrderBy(sort: PurchaseSort | undefined): SQL {
  switch (sort) {
    case "oldest":
      return sql.raw(OLDEST_FIRST);
    case "high":
      return sql.raw(`total_p DESC, ${NEWEST_FIRST}`);
    case "low":
      return sql.raw(`total_p ASC, ${NEWEST_FIRST}`);
    case "due":
      // a cancelled purchase owes nothing: last
      return sql.raw(`(CASE WHEN status = 'CANCELLED' THEN -1 ELSE total_p - paid_p END) DESC, ${NEWEST_FIRST}`);
    default:
      return sql.raw(NEWEST_FIRST);
  }
}

/** `paymentStatusOf` in SQL. */
const PAY_STATE = `CASE WHEN total_p <= 0 THEN 'UNPAID' WHEN paid_p >= total_p THEN 'PAID' WHEN paid_p > 0 THEN 'PARTIAL' ELSE 'UNPAID' END`;

export interface PurchaseSearchRow {
  id: string;
  pos: number;
  paidP: number;
}

type Kpis = { count: number; receivedQuantity: number; orderedQuantity: number; valueP: number; owedP: number; suppliers: number; suppliersOwed: number };
type Facets = Record<(typeof PURCHASE_PAYMENT_STATUSES)[number], { count: number; totalP: number }>;

export interface PurchaseSearchOutcome {
  interpreted: SearchInterpretation;
  rows: PurchaseSearchRow[];
  total: number;
  kpis: Kpis;
  payFacets: Facets;
  onFile: number;
}

const emptyFacets = (): Facets => ({ PAID: { count: 0, totalP: 0 }, UNPAID: { count: 0, totalP: 0 }, PARTIAL: { count: 0, totalP: 0 } });
const emptyKpis = (): Kpis => ({ count: 0, receivedQuantity: 0, orderedQuantity: 0, valueP: 0, owedP: 0, suppliers: 0, suppliersOwed: 0 });

type ResultRow = { t: string; a: string | null; b: string | null; c: string | null; d: string | null; e: string | null; f: string | null; g: string | null };

/** The purchases matching `f`, ordered, one page of them, the total, the cards and the payment counts — in one statement (+ one count). */
export async function searchPurchases(db: Executor, f: PurchaseFilters, page?: { limit: number; offset: number }): Promise<PurchaseSearchOutcome> {
  const reading = readPurchaseFilters(f);
  const [counts] = await db.execute<{ on_file: number }>(sql`SELECT count(*)::int AS on_file FROM purchases`);
  const onFile = counts?.on_file ?? 0;
  const empty: PurchaseSearchOutcome = { interpreted: reading.interpreted, rows: [], total: 0, kpis: emptyKpis(), payFacets: emptyFacets(), onFile };
  if (reading.interpreted.problems.length) return empty;

  const terms = reading.interpreted.terms;
  const base = sql`base AS MATERIALIZED (
    SELECT p.id, p.status, p.supplier_id, p.total_p, p.date, p.created_at, p.purchase_number, p.ordered_qty_milli, p.received_qty_milli,
           paid.p AS paid_p, p.search_numbers, p.search_supplier, p.search_amount, p.search_date, p.search_other, s.search_text AS sup_text
    FROM purchases p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(a.amount_p), 0) AS p FROM payment_allocations a JOIN payments pm ON pm.id = a.payment_id WHERE a.purchase_id = p.id AND pm.status = 'POSTED') paid ON TRUE
    ${whereOf(structuralConditions(f, reading))}
  )`;
  const m = sql`, m AS MATERIALIZED (
    SELECT b.id, b.status, b.supplier_id, b.total_p, b.paid_p, b.date, b.created_at, b.purchase_number, b.ordered_qty_milli, b.received_qty_milli,
           ${sql.raw(PAY_STATE.replace(/total_p/g, "b.total_p").replace(/paid_p/g, "b.paid_p"))} AS pay
    FROM base b
    ${whereOf(terms.map((t) => termCondition(t)))}
  )`;

  const ks = f.paymentStatus ? sql`WHERE pay = ${f.paymentStatus}` : sql``;
  const live = f.paymentStatus ? sql`pay = ${f.paymentStatus} AND status <> 'CANCELLED'` : sql`status <> 'CANCELLED'`;
  const paging = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
  const rows = await db.execute<ResultRow>(sql`
    WITH ${base} ${m},
    pg AS (SELECT id, paid_p, row_number() OVER (ORDER BY ${purchaseOrderBy(f.sort)}) AS pos FROM m ${ks} ORDER BY pos ${paging}),
    owed AS (SELECT supplier_id, SUM(total_p - paid_p) AS owed FROM m WHERE ${live} AND supplier_id IS NOT NULL GROUP BY supplier_id)
    SELECT 'p' AS t, id::text AS a, pos::text AS b, paid_p::text AS c, NULL AS d, NULL AS e, NULL AS f, NULL AS g FROM pg
    UNION ALL SELECT 't', NULL, count(*)::text, NULL, NULL, NULL, NULL, NULL FROM m ${ks}
    UNION ALL SELECT 'k', count(*)::text, COALESCE(sum(received_qty_milli), 0)::text, COALESCE(sum(ordered_qty_milli), 0)::text,
                COALESCE(sum(total_p), 0)::text, COALESCE(sum(total_p - paid_p), 0)::text,
                (SELECT count(*) FROM owed)::text, (SELECT count(*) FROM owed WHERE owed > 0)::text
              FROM m WHERE ${live}
    UNION ALL SELECT 'f:' || pay, NULL, count(*)::text, COALESCE(sum(total_p), 0)::text, NULL, NULL, NULL, NULL FROM m GROUP BY pay`);

  const out: PurchaseSearchOutcome = { ...empty, kpis: emptyKpis(), payFacets: emptyFacets() };
  for (const r of rows) {
    if (r.t === "p") out.rows.push({ id: r.a!, pos: Number(r.b), paidP: Number(r.c) });
    else if (r.t === "t") out.total = Number(r.b);
    else if (r.t === "k")
      out.kpis = {
        count: Number(r.a),
        receivedQuantity: milliToQty(Number(r.b)),
        orderedQuantity: milliToQty(Number(r.c)),
        valueP: Number(r.d),
        owedP: Number(r.e),
        suppliers: Number(r.f),
        suppliersOwed: Number(r.g),
      };
    else if (r.t.startsWith("f:")) {
      const k = r.t.slice(2) as keyof Facets;
      if (out.payFacets[k]) out.payFacets[k] = { count: Number(r.b), totalP: Number(r.c) };
    }
  }
  out.rows.sort((a, b) => a.pos - b.pos);
  return out;
}

/**
 * Which product lines a search landed on, so the list can say WHY a purchase is there when its first line (the one the row shows) is
 * not it ("Zam Zam × 100 · +1 more"). Words the header already explains (number, supplier, amount, date, vehicle …) are not "why".
 */
export async function purchaseHitsFor(db: Executor, ids: string[], terms: string[]): Promise<Map<string, PurchaseHit>> {
  const out = new Map<string, PurchaseHit>();
  if (!terms.length || ids.length === 0) return out;
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const heads = await db.execute<{ id: string; own: string }>(sql`
    SELECT p.id::text AS id, concat_ws(chr(1), p.search_numbers, p.search_supplier, p.search_amount, p.search_date, p.search_other, s.search_text) AS own
    FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE p.id IN (${idList})`);
  const lines = await db.execute<{ purchase_id: string; name: string; qty_milli: string; n: string }>(sql`
    SELECT pi.purchase_id::text AS purchase_id, COALESCE(NULLIF(pi.description_en_snapshot, ''), NULLIF(pi.description_snapshot, ''), '') AS name, pi.qty_milli::text AS qty_milli,
           concat_ws(chr(1), pi.search_text, pr.search_text) AS n
    FROM purchase_items pi LEFT JOIN products pr ON pr.id = pi.product_id
    WHERE pi.purchase_id IN (${idList}) ORDER BY pi.purchase_id, pi.sort_order, pi.id`);
  for (const h of heads) {
    const want = terms.filter((t) => !hasTerm([h.own ?? ""], t));
    if (!want.length) continue;
    const hit = lines.filter((l) => l.purchase_id === h.id && l.n !== "" && want.some((t) => hasTerm([l.n], t)));
    if (!hit.length) continue;
    out.set(h.id, { lines: hit.slice(0, 3).map((l) => ({ name: l.name, quantity: milliToQty(Number(l.qty_milli)) })), more: Math.max(0, hit.length - 3) });
  }
  return out;
}

/** The categories products carry (the category picker). */
export async function productCategories(db: Executor): Promise<string[]> {
  const rows = await db.execute<{ c: string }>(sql`SELECT DISTINCT category AS c FROM products WHERE category IS NOT NULL AND btrim(category) <> '' ORDER BY 1`);
  return [...rows].map((r) => r.c);
}

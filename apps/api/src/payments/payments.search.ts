import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "@farooq/db";
import {
  parseSearchQuery,
  type ListPaymentsQuery,
  type PaymentFacets,
  type PaymentKind,
  type PaymentSort,
  type SearchInterpretation,
} from "@farooq/shared";

/**
 * Payment search, on the server (S4). A port of the legacy 38-payment-search.js `build` / `matcher` / `sortList`:
 *
 *  - every space-separated word must be found (AND, any order), substring match, Urdu / English folding;
 *  - "search in" narrows the words to one field: number, party (+ phone, owner, region), reference, invoice / purchase
 *    numbers the voucher was applied to, amount (every typed form), or notes & other; "everything" looks at all of
 *    them plus the date forms;
 *  - a party is matched by the name printed on the voucher (the snapshot — it never changes) AND by its current name;
 *  - a date typed into the box becomes a date filter (replacing from / to) and is echoed back, not searched as text;
 *  - inputs that can never match are said out loud (`problems`) and the list is empty on purpose.
 *
 * The folded text of every field is built in SQL by `fold_search` and its `search_*` helpers (migration 0004) — no
 * extension needed. The reference-implementation parity tests prove the result equals the legacy algorithm's.
 *
 * Cost model (one round trip): the structural filters (method, region, dates, amounts, party) cut the rows first; the
 * folded text of every field is already stored (generated columns), so a text search is `strpos` over those columns —
 * nothing is folded per request except the few words typed. Only the invoice numbers a voucher was applied to are gathered
 * per request, and the party's current text once per party.
 */

export const SEARCH_PROBLEMS = {
  fromAfterTo: "The “From” date is after the “To” date, so no payment can match.",
  minAboveMax: "The minimum amount is above the maximum, so no payment can match.",
} as const;

export type PaymentFilters = Omit<ListPaymentsQuery, "limit" | "offset">;

interface DateBound {
  from: string | null;
  to: string | null;
}

export interface SearchReading {
  interpreted: SearchInterpretation;
  /** The date ranges any of which may match (a typed date, else from / to), or null for "any date". */
  ranges: DateBound[] | null;
}

/** How the box and the filters are read — also what `interpreted` says. */
export function readFilters(f: PaymentFilters): SearchReading {
  const parsed = parseSearchQuery(f.q ?? "");
  const problems: string[] = [];
  let ranges: DateBound[] | null = null;
  let replaced = false;
  if (parsed.dates.length) {
    ranges = parsed.dates.map((d) => ({ from: d.from, to: d.to })); // a typed date replaces the date filter
    replaced = Boolean(f.from || f.to);
  } else if (f.from || f.to) {
    if (f.from && f.to && f.from > f.to) problems.push(SEARCH_PROBLEMS.fromAfterTo);
    ranges = [{ from: f.from ?? null, to: f.to ?? null }];
  }
  if (f.minP !== undefined && f.maxP !== undefined && f.minP > f.maxP) problems.push(SEARCH_PROBLEMS.minAboveMax);
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

/** The legacy `dirOf`: which list a voucher is on, whatever its status. */
const KIND_SQL = sql.raw(`CASE WHEN p.direction = 'IN' THEN 'received' WHEN p.party_type = 'CUSTOMER' THEN 'paidToShops' ELSE 'paidToSuppliers' END`);

/**
 * The folded text of each searchable field, as the legacy `build()` indexed it. The row-local ones are Postgres
 * GENERATED ... STORED columns (migration 0004: maintained by the database itself, never stale, no triggers), so a
 * search folds nothing per voucher; only the invoice / purchase numbers are gathered through the allocations.
 */
const FIELD_SQL: Record<string, string> = {
  f_number: `p.search_number`,
  f_party: `p.search_party`,
  f_reference: `p.search_reference`,
  // the numbers of the invoices / purchases the voucher was applied to, each with its compact form
  f_invoice: `COALESCE((
      SELECT string_agg(COALESCE(i.search_number, u.search_number), chr(1))
      FROM payment_allocations pa
      LEFT JOIN invoices i ON i.id = pa.invoice_id
      LEFT JOIN purchases u ON u.id = pa.purchase_id
      WHERE pa.payment_id = p.id AND COALESCE(i.search_number, u.search_number) <> ''
    ), '')`,
  f_amount: `p.search_amount`,
  f_date: `p.search_date`,
  f_other: `p.search_other`,
};

/** Which folded fields a scope looks at ("cur" is the party's current text). A word matches when ANY of them holds it. */
const SCOPE_FIELDS: Record<string, string[]> = {
  all: ["f_number", "f_party", "f_reference", "f_invoice", "f_amount", "f_date", "f_other", "cur"],
  party: ["f_party", "cur"],
  number: ["f_number"],
  reference: ["f_reference"],
  invoice: ["f_invoice"],
  amount: ["f_amount"],
  notes: ["f_other"],
};

/**
 * A word matches when a field holds it — or, for a phrase, holds it with the spaces removed (legacy `hasTerm`).
 * (The legacy tested the fields joined by a separator no word can contain, which is the same as testing each field.)
 */
function termCondition(fields: string[], term: string): SQL {
  const squeezed = term.includes(" ") ? term.replace(/ /g, "") : "";
  const tests = fields.map((name) => {
    const col = name === "cur" ? sql.raw("cur.f") : sql.raw(`b.${name}`);
    return squeezed ? sql`(strpos(${col}, ${term}) > 0 OR strpos(${col}, ${squeezed}) > 0)` : sql`strpos(${col}, ${term}) > 0`;
  });
  return sql`(${sql.join(tests, sql` OR `)})`;
}

/** Filters on raw columns (`p`, `c`) — applied before anything is folded. Direction and status are NOT here (the facets ignore them). */
function structuralConditions(f: PaymentFilters, reading: SearchReading): SQL[] {
  const conds: SQL[] = [];
  if (f.partyType) conds.push(sql`p.party_type = ${f.partyType}`);
  if (f.partyId) conds.push(sql`p.party_id = ${f.partyId}`);
  if (f.method) conds.push(sql`p.method = ${f.method}`);
  // a region belongs to a shop; a supplier has none, so it cannot pass
  if (f.regionId) conds.push(sql`c.region_id = ${f.regionId}`);
  if (reading.ranges) {
    const any = reading.ranges.map((r) => {
      const parts: SQL[] = [];
      if (r.from) parts.push(sql`p.payment_date >= ${r.from}::date`);
      if (r.to) parts.push(sql`p.payment_date <= ${r.to}::date`);
      return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : sql`TRUE`;
    });
    conds.push(sql`(${sql.join(any, sql` OR `)})`);
  }
  if (f.minP !== undefined) conds.push(sql`p.amount_p >= ${f.minP}`);
  if (f.maxP !== undefined) conds.push(sql`p.amount_p <= ${f.maxP}`);
  return conds;
}

/** The direction / status controls (the tabs), on the result columns. */
function kindStatusConditions(f: PaymentFilters): SQL[] {
  const conds: SQL[] = [];
  const d = f.direction;
  if (d === "IN" || d === "OUT") conds.push(sql`direction = ${d}`);
  else if (d && d !== "all") conds.push(sql`kind = ${d satisfies PaymentKind}`);
  if (f.status) conds.push(sql`status = ${f.status}`);
  return conds;
}

const whereOf = (conds: SQL[]): SQL => (conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``);

/** `newer` of the legacy: business date, then entry time, then receipt number (byte order, not the database collation). */
const NEWEST_FIRST = `payment_date DESC, created_at DESC, receipt_number COLLATE "C" DESC, id DESC`;
const OLDEST_FIRST = `payment_date ASC, created_at ASC, receipt_number COLLATE "C" ASC, id ASC`;

export function orderBy(sort: PaymentSort | undefined): SQL {
  switch (sort) {
    case "oldest":
      return sql.raw(OLDEST_FIRST);
    case "high":
      return sql.raw(`amount_p DESC, ${NEWEST_FIRST}`);
    case "low":
      return sql.raw(`amount_p ASC, ${NEWEST_FIRST}`);
    default:
      return sql.raw(NEWEST_FIRST);
  }
}

export interface SearchOutcome {
  interpreted: SearchInterpretation;
  /** Ids of this page, in order. */
  ids: string[];
  total: number;
  facets: PaymentFacets;
  onFile: number;
}

const emptyFacets = (): PaymentFacets => ({
  received: { count: 0, totalP: 0 },
  paidToShops: { count: 0, totalP: 0 },
  paidToSuppliers: { count: 0, totalP: 0 },
  reversed: { count: 0, totalP: 0 },
});

type ResultRow = {
  t: string;
  a: string | null;
  n: string | null;
  s: string | null;
};

/**
 * The ids matching `f`, ordered, one page of them (`page` omitted = all of them, for the CSV), the total, and the
 * facet counts — in one statement. An input that can never match short-circuits to an empty answer (problem said).
 */
export async function searchPayments(db: Executor, f: PaymentFilters, page?: { limit: number; offset: number }): Promise<SearchOutcome> {
  const reading = readFilters(f);
  const [onFileRow] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM payments`);
  const onFile = onFileRow?.n ?? 0;
  if (reading.interpreted.problems.length) return { interpreted: reading.interpreted, ids: [], total: 0, facets: emptyFacets(), onFile };

  const terms = reading.interpreted.terms;
  const fields = SCOPE_FIELDS[f.scope ?? "all"] ?? SCOPE_FIELDS.all!;
  const needsCur = terms.length > 0 && fields.includes("cur");
  const foldCols = terms.length ? fields.filter((x) => x !== "cur").map((name) => sql.raw(`, ${FIELD_SQL[name]} AS ${name}`)) : [];

  // 1. rows passing the structural filters, with the folded fields the scope needs (folded once, here)
  const base = sql`base AS MATERIALIZED (
    SELECT p.id, p.direction, p.party_type, p.party_id, p.status, p.amount_p, p.payment_date, p.created_at, p.receipt_number, ${KIND_SQL} AS kind
    ${sql.join(foldCols, sql``)}
    FROM payments p
    LEFT JOIN customers c ON p.party_type = 'CUSTOMER' AND c.id = p.party_id
    ${whereOf(structuralConditions(f, reading))}
  )`;
  // 2. the party's CURRENT text, from the parties' own generated columns (a rename is found at once; the printed name is in f_party)
  const cur = needsCur
    ? sql`, cur AS MATERIALIZED (
    SELECT 'CUSTOMER' AS pt, c.id, concat_ws(chr(1), NULLIF(c.search_text, ''), NULLIF(r.search_text, '')) AS f
    FROM customers c LEFT JOIN regions r ON r.id = c.region_id
    WHERE c.id IN (SELECT party_id FROM base WHERE party_type = 'CUSTOMER')
    UNION ALL
    SELECT 'SUPPLIER', s.id, s.search_text
    FROM suppliers s WHERE s.id IN (SELECT party_id FROM base WHERE party_type = 'SUPPLIER')
  )`
    : sql``;
  // 3. the words: every one must be found
  const termConds = terms.map((t) => termCondition(fields, t));
  const m = sql`, m AS MATERIALIZED (
    SELECT b.id, b.direction, b.status, b.kind, b.amount_p, b.payment_date, b.created_at, b.receipt_number
    FROM base b ${needsCur ? sql`LEFT JOIN cur ON cur.pt = b.party_type AND cur.id = b.party_id` : sql``}
    ${whereOf(termConds)}
  )`;

  const ks = whereOf(kindStatusConditions(f));
  const paging = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
  const rows = await db.execute<ResultRow>(sql`
    WITH ${base} ${cur} ${m},
    pg AS (SELECT id, row_number() OVER (ORDER BY ${orderBy(f.sort)}) AS pos FROM m ${ks} ORDER BY pos ${paging})
    SELECT 'p' AS t, id::text AS a, pos::text AS n, NULL::text AS s FROM pg
    UNION ALL SELECT 't', NULL, count(*)::text, NULL FROM m ${ks}
    UNION ALL SELECT g, NULL, count(*)::text, COALESCE(sum(amount_p), 0)::text
              FROM (SELECT CASE WHEN status = 'REVERSED' THEN 'reversed' ELSE kind END AS g, amount_p FROM m) x GROUP BY g`);

  const facets = emptyFacets();
  let total = 0;
  const ids: { id: string; pos: number }[] = [];
  for (const r of rows) {
    if (r.t === "p") ids.push({ id: r.a!, pos: Number(r.n) });
    else if (r.t === "t") total = Number(r.n);
    else facets[r.t as keyof PaymentFacets] = { count: Number(r.n), totalP: Number(r.s) };
  }
  ids.sort((a, b) => a.pos - b.pos);
  return { interpreted: reading.interpreted, ids: ids.map((x) => x.id), total, facets, onFile };
}

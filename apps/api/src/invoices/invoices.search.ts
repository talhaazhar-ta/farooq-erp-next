import { sql, type SQL } from "drizzle-orm";
import type { Executor } from "@farooq/db";
import {
  INVOICE_SEARCH_PROBLEMS,
  INVOICE_STATUSES,
  milliToQty,
  parseSearchQuery,
  type InvoiceHit,
  type InvoiceSearchScope,
  type InvoiceSort,
  type InvoiceStatus,
  type ListInvoicesQuery,
  type SearchInterpretation,
} from "@farooq/shared";

/**
 * Invoice search, on the server (S8): a port of the legacy 33-invoice-search.js `build` / `matcher` / `sortList` / `hitsFor`.
 * The engine is S4's (`fold_search`, generated `search_*` columns, `parseSearchQuery`); this file only says which fields the
 * words are looked for in:
 *
 *  - every space-separated word must be found (AND, any order), substring match, Urdu / English folding;
 *  - "search in" narrows the words to one kind of field: invoice / order / dispatch / reference number, customer & phone,
 *    product, amount, receipt / payment reference, notes & other — "everything" looks at all of them plus the date forms;
 *  - the customer is matched by the name printed on the invoice (its snapshot — it never changes) AND by the shop's
 *    current text (a rename is found at once);
 *  - **a receipt NUMBER is found only with the "Receipt / payment ref." scope, never in Everything** (it has the same shape as
 *    an invoice number, so the tail of one would pull in every invoice whose receipt happens to end the same way); Everything
 *    sees the cheque / transaction REFERENCE of a receipt only. Only POSTED receipts count (a reversed one is not searched);
 *  - a date typed into the box becomes a date filter (replacing from / to) and is echoed back, not searched as text;
 *  - inputs that can never match are said out loud (`problems`) and the list is empty on purpose.
 *
 * The invoice's own folded text is stored (generated columns, migration 0007); what follows other tables is read per request:
 * the shop's current text, the receipts applied, the product lines (`invoice_items.search_text`) and the payment-status word
 * ("Unpaid" / "Partly paid" / "Paid", which the legacy kept on the invoice and this database derives from the receipts).
 * The list is built from `invoices` + allocations — never from the journal, which holds both entries of a cancelled invoice.
 */

export type InvoiceFilters = Omit<ListInvoicesQuery, "limit" | "offset">;

interface DateBound {
  from: string | null;
  to: string | null;
}

export interface InvoiceSearchReading {
  interpreted: SearchInterpretation;
  /** The date ranges any of which may match (a typed date, else from / to), or null for "any date". */
  ranges: DateBound[] | null;
}

/** How the box and the filters are read — also what `interpreted` says. */
export function readInvoiceFilters(f: InvoiceFilters): InvoiceSearchReading {
  const parsed = parseSearchQuery(f.q ?? "");
  const problems: string[] = [];
  let ranges: DateBound[] | null = null;
  let replaced = false;
  if (parsed.dates.length) {
    ranges = parsed.dates.map((d) => ({ from: d.from, to: d.to })); // a typed date replaces the date filter
    replaced = Boolean(f.from || f.to);
  } else if (f.from || f.to) {
    if (f.from && f.to && f.from > f.to) problems.push(INVOICE_SEARCH_PROBLEMS.fromAfterTo);
    ranges = [{ from: f.from ?? null, to: f.to ?? null }];
  }
  if (f.minP !== undefined && f.maxP !== undefined && f.minP > f.maxP) problems.push(INVOICE_SEARCH_PROBLEMS.minAboveMax);
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

/* ── the folded text of each field ───────────────────────────────────────── */

/** The payment-status word the legacy `STATUS_LABEL[paymentStatus]` put in "other" — from the receipts, exactly as `paymentStatusOf`. */
const PAY_STATE_WORD = `CASE WHEN i.total_p <= 0 THEN 'unpaid' WHEN paid.p >= i.total_p THEN 'paid' WHEN paid.p > 0 THEN 'partly paid' ELSE 'unpaid' END`;

/** POSTED receipts applied to the invoice: per receipt its number (+ compact), reference (+ compact) and method, each folded. */
const RECEIPTS_OF = (cols: string): string => `COALESCE((
    SELECT string_agg(${cols}, chr(1))
    FROM payment_allocations pa JOIN payments pm ON pm.id = pa.payment_id
    WHERE pa.invoice_id = i.id AND pm.status = 'POSTED'
  ), '')`;

const FIELD_SQL: Record<string, string> = {
  f_numbers: `i.search_numbers`,
  f_customer: `i.search_customer`,
  f_amount: `i.search_amount`,
  f_date: `i.search_date`,
  f_other: `concat_ws(chr(1), NULLIF(i.search_other, ''), ${PAY_STATE_WORD})`,
  // what "Everything" sees of a receipt: the cheque / transaction reference only
  f_payref: RECEIPTS_OF(`NULLIF(pm.search_reference, '')`),
  // what the "Receipt / payment ref." scope sees: number, reference and method
  f_pay: RECEIPTS_OF(`concat_ws(chr(1), NULLIF(pm.search_number, ''), NULLIF(pm.search_reference, ''), NULLIF(fold_search(pm.method), ''))`),
};

/** Which fields a scope looks at ("cur" is the shop's current text, "product" the lines). A word matches when ANY of them holds it. */
const SCOPE_FIELDS: Record<InvoiceSearchScope, string[]> = {
  all: ["f_numbers", "f_customer", "product", "f_amount", "f_date", "f_payref", "f_other", "cur"],
  customer: ["f_customer", "cur"],
  number: ["f_numbers"],
  product: ["product"],
  amount: ["f_amount"],
  payment: ["f_pay"],
  notes: ["f_other"],
};

/** A word matches when a field holds it — or, for a phrase, holds it with the spaces removed (legacy `hasTerm`). */
function termCondition(fields: string[], term: string): SQL {
  const squeezed = term.includes(" ") ? term.replace(/ /g, "") : "";
  const has = (col: SQL): SQL => (squeezed ? sql`(strpos(${col}, ${term}) > 0 OR strpos(${col}, ${squeezed}) > 0)` : sql`strpos(${col}, ${term}) > 0`);
  const tests = fields.map((name) => {
    if (name === "cur") return has(sql.raw("cur.f"));
    if (name === "product") return sql`EXISTS (SELECT 1 FROM invoice_items ii WHERE ii.invoice_id = b.id AND ${has(sql.raw("ii.search_text"))})`;
    return has(sql.raw(`b.${name}`));
  });
  return sql`(${sql.join(tests, sql` OR `)})`;
}

/** Filters on raw columns of `i` — applied before anything is folded. The status filter is NOT here (the facets ignore it). */
function structuralConditions(f: InvoiceFilters, reading: InvoiceSearchReading): SQL[] {
  const conds: SQL[] = [];
  if (f.regionId) conds.push(sql`i.region_id = ${f.regionId}`);
  if (f.warehouseId) conds.push(sql`i.warehouse_id = ${f.warehouseId}`);
  if (reading.ranges) {
    const any = reading.ranges.map((r) => {
      const parts: SQL[] = [];
      if (r.from) parts.push(sql`i.date >= ${r.from}::date`);
      if (r.to) parts.push(sql`i.date <= ${r.to}::date`);
      return parts.length ? sql`(${sql.join(parts, sql` AND `)})` : sql`TRUE`;
    });
    conds.push(sql`(${sql.join(any, sql` OR `)})`);
  }
  if (f.minP !== undefined) conds.push(sql`i.total_p >= ${f.minP}`);
  if (f.maxP !== undefined) conds.push(sql`i.total_p <= ${f.maxP}`);
  return conds;
}

const whereOf = (conds: SQL[]): SQL => (conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``);

/** `newer` of the legacy: business date, then entry time — and (the legacy left it open) the number, then the id, so the order is total. */
const NEWEST_FIRST = `date DESC, created_at DESC, invoice_number COLLATE "C" DESC NULLS LAST, id DESC`;
const OLDEST_FIRST = `date ASC, created_at ASC, invoice_number COLLATE "C" ASC NULLS FIRST, id ASC`;

export function invoiceOrderBy(sort: InvoiceSort | undefined): SQL {
  switch (sort) {
    case "oldest":
      return sql.raw(OLDEST_FIRST);
    case "high":
      return sql.raw(`total_p DESC, ${NEWEST_FIRST}`);
    case "low":
      return sql.raw(`total_p ASC, ${NEWEST_FIRST}`);
    case "due":
      // legacy `dueOf`: a cancelled invoice or a draft is −1 (last); the rest by what is still owed
      return sql.raw(`(CASE WHEN status IN ('CANCELLED', 'DRAFT') THEN -1 ELSE total_p - paid_p - credit_p END) DESC, ${NEWEST_FIRST}`);
    default:
      return sql.raw(NEWEST_FIRST);
  }
}

export interface InvoiceSearchRow {
  id: string;
  pos: number;
  paidP: number;
  creditP: number;
}

export interface InvoiceSearchOutcome {
  interpreted: SearchInterpretation;
  /** This page, in order (`page` omitted = every match, for the CSV). */
  rows: InvoiceSearchRow[];
  total: number;
  kpis: { count: number; drafts: number; invoicedP: number; receivedP: number; outstandingP: number };
  statusFacets: Record<InvoiceStatus, { count: number; totalP: number }>;
  onFile: number;
}

const emptyFacets = (): InvoiceSearchOutcome["statusFacets"] =>
  Object.fromEntries(INVOICE_STATUSES.map((s) => [s, { count: 0, totalP: 0 }])) as InvoiceSearchOutcome["statusFacets"];

type ResultRow = { t: string; a: string | null; n: string | null; s: string | null; u: string | null };

/**
 * The invoices matching `f`, ordered, one page of them, the total, the four cards and the status counts — in one statement
 * (plus one small count of what is on file). An input that can never match short-circuits to an empty answer (problem said).
 */
export async function searchInvoices(db: Executor, f: InvoiceFilters, page?: { limit: number; offset: number }): Promise<InvoiceSearchOutcome> {
  const reading = readInvoiceFilters(f);
  const [counts] = await db.execute<{ on_file: number; drafts: number }>(sql`SELECT count(*)::int AS on_file, (count(*) FILTER (WHERE status = 'DRAFT'))::int AS drafts FROM invoices`);
  const onFile = counts?.on_file ?? 0;
  const drafts = counts?.drafts ?? 0;
  const empty: InvoiceSearchOutcome = { interpreted: reading.interpreted, rows: [], total: 0, kpis: { count: 0, drafts, invoicedP: 0, receivedP: 0, outstandingP: 0 }, statusFacets: emptyFacets(), onFile };
  if (reading.interpreted.problems.length) return empty;

  const terms = reading.interpreted.terms;
  const fields = SCOPE_FIELDS[f.scope ?? "all"] ?? SCOPE_FIELDS.all;
  const needsCur = terms.length > 0 && fields.includes("cur");
  const foldCols = terms.length ? fields.filter((x) => x !== "cur" && x !== "product").map((name) => sql.raw(`, ${FIELD_SQL[name]} AS ${name}`)) : [];

  // 1. rows passing the structural filters, with what was paid / credited and the folded fields the scope needs (folded once, here)
  const base = sql`base AS MATERIALIZED (
    SELECT i.id, i.status, i.customer_id, i.total_p, i.date, i.created_at, i.invoice_number, paid.p AS paid_p, credit.c AS credit_p
    ${sql.join(foldCols, sql``)}
    FROM invoices i
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(a.amount_p), 0) AS p FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = i.id AND p.status = 'POSTED') paid ON TRUE
    LEFT JOIN LATERAL (SELECT COALESCE(SUM(r.total_p), 0) AS c FROM returns r WHERE r.invoice_id = i.id AND r.kind = 'CUSTOMER' AND r.status <> 'CANCELLED') credit ON TRUE
    ${whereOf(structuralConditions(f, reading))}
  )`;
  // 2. the shop's CURRENT text, from the shop's own generated columns (a rename is found at once; the printed name is in f_customer)
  const cur = needsCur
    ? sql`, cur AS MATERIALIZED (
    SELECT c.id, concat_ws(chr(1), NULLIF(c.search_text, ''), NULLIF(r.search_text, '')) AS f
    FROM customers c LEFT JOIN regions r ON r.id = c.region_id
    WHERE c.id IN (SELECT customer_id FROM base)
  )`
    : sql``;
  // 3. the words: every one must be found
  const m = sql`, m AS MATERIALIZED (
    SELECT b.id, b.status, b.total_p, b.paid_p, b.credit_p, b.date, b.created_at, b.invoice_number
    FROM base b ${needsCur ? sql`LEFT JOIN cur ON cur.id = b.customer_id` : sql``}
    ${whereOf(terms.map((t) => termCondition(fields, t)))}
  )`;

  const ks = f.status ? sql`WHERE status = ${f.status}` : sql``;
  const paging = page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``;
  const live = sql`status NOT IN ('CANCELLED', 'DRAFT')`;
  const rows = await db.execute<ResultRow>(sql`
    WITH ${base} ${cur} ${m},
    pg AS (SELECT id, paid_p, credit_p, row_number() OVER (ORDER BY ${invoiceOrderBy(f.sort)}) AS pos FROM m ${ks} ORDER BY pos ${paging})
    SELECT 'p' AS t, id::text AS a, pos::text AS n, paid_p::text AS s, credit_p::text AS u FROM pg
    UNION ALL SELECT 't', NULL, count(*)::text, NULL, NULL FROM m ${ks}
    UNION ALL SELECT 'k', (count(*) FILTER (WHERE ${live}))::text, COALESCE(sum(total_p) FILTER (WHERE ${live}), 0)::text, COALESCE(sum(paid_p) FILTER (WHERE ${live}), 0)::text,
                COALESCE(sum(total_p - paid_p - credit_p) FILTER (WHERE ${live}), 0)::text FROM m ${ks}
    UNION ALL SELECT 'f:' || status, NULL, count(*)::text, COALESCE(sum(total_p), 0)::text, NULL FROM m GROUP BY status`);

  const out: InvoiceSearchOutcome = { ...empty, kpis: { ...empty.kpis } };
  for (const r of rows) {
    if (r.t === "p") out.rows.push({ id: r.a!, pos: Number(r.n), paidP: Number(r.s), creditP: Number(r.u) });
    else if (r.t === "t") out.total = Number(r.n);
    else if (r.t === "k") out.kpis = { count: Number(r.a), drafts, invoicedP: Number(r.n), receivedP: Number(r.s), outstandingP: Number(r.u) };
    else if (r.t.startsWith("f:")) {
      const status = r.t.slice(2) as InvoiceStatus;
      if (out.statusFacets[status]) out.statusFacets[status] = { count: Number(r.n), totalP: Number(r.s) };
    }
  }
  out.rows.sort((a, b) => a.pos - b.pos);
  return out;
}

/* ── why a row is in the list (legacy `hitsFor`) ─────────────────────────── */

/** The legacy `hasTerm` over already-folded text. */
export function hasTerm(hays: readonly string[], t: string): boolean {
  const t2 = t.includes(" ") ? t.replace(/ /g, "") : "";
  return hays.some((h) => h.includes(t) || (t2 !== "" && h.includes(t2)));
}

/**
 * For a search that landed on a product or on a receipt: which product lines and which receipts matched — so the list can say
 * WHY ("Taj Mahal Sella × 20", "Paid by REC-2026-000031 (4471)"). Words the invoice number or the shop already explain are not
 * counted. Only the "Everything", "Product" and "Receipt / payment ref." scopes have hits; others (and no words) return an empty map.
 */
export async function hitsFor(db: Executor, ids: string[], terms: string[], scope: InvoiceSearchScope): Promise<Map<string, InvoiceHit>> {
  const out = new Map<string, InvoiceHit>();
  const wantProduct = scope === "all" || scope === "product";
  const wantPay = scope === "all" || scope === "payment";
  if (!terms.length || ids.length === 0 || (!wantProduct && !wantPay)) return out;
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

  const heads = await db.execute<{ id: string; numbers: string; customer: string; cur: string }>(sql`
    SELECT i.id::text AS id, COALESCE(i.search_numbers, '') AS numbers, COALESCE(i.search_customer, '') AS customer,
           concat_ws(chr(1), NULLIF(c.search_text, ''), NULLIF(r.search_text, '')) AS cur
    FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id LEFT JOIN regions r ON r.id = c.region_id
    WHERE i.id IN (${idList})`);
  const lines = wantProduct
    ? await db.execute<{ invoice_id: string; name: string; qty_milli: string; n: string }>(sql`
        SELECT invoice_id::text AS invoice_id, COALESCE(NULLIF(description_en_snapshot, ''), NULLIF(description_snapshot, ''), '') AS name, qty_milli::text AS qty_milli, COALESCE(search_text, '') AS n
        FROM invoice_items WHERE invoice_id IN (${idList}) ORDER BY invoice_id, sort_order, id`)
    : [];
  const pays = wantPay
    ? await db.execute<{ invoice_id: string; no: string; ref: string | null; ref_text: string; all_text: string }>(sql`
        SELECT pa.invoice_id::text AS invoice_id, pm.receipt_number AS no, pm.reference AS ref, COALESCE(pm.search_reference, '') AS ref_text,
               concat_ws(chr(1), NULLIF(pm.search_number, ''), NULLIF(pm.search_reference, ''), NULLIF(fold_search(pm.method), '')) AS all_text
        FROM payment_allocations pa JOIN payments pm ON pm.id = pa.payment_id
        WHERE pa.invoice_id IN (${idList}) AND pm.status = 'POSTED'
        ORDER BY pa.invoice_id, pa.created_at, pm.created_at, pm.receipt_number, pa.id`)
    : [];

  for (const h of heads) {
    // words the invoice number or the shop already explain are not "why" (Everything only)
    const want = scope === "all" ? terms.filter((t) => !hasTerm([h.numbers, h.customer, h.cur ?? ""], t)) : terms;
    if (!want.length) continue;
    const hit = wantProduct
      ? lines.filter((l) => l.invoice_id === h.id && l.n !== "" && want.some((t) => hasTerm([l.n], t)))
      : [];
    // "Everything" looks at cheque / transaction references only (the receipt number is for the "Receipt / payment ref." scope)
    const paidHere = wantPay
      ? pays.filter((p) => {
          if (p.invoice_id !== h.id) return false;
          const text = scope === "all" ? p.ref_text : p.all_text;
          return text !== "" && want.some((t) => hasTerm([text], t));
        })
      : [];
    if (!hit.length && !paidHere.length) continue;
    out.set(h.id, {
      lines: hit.slice(0, 3).map((l) => ({ name: l.name, quantity: milliToQty(Number(l.qty_milli)) })),
      more: Math.max(0, hit.length - 3),
      pays: paidHere.slice(0, 3).map((p) => p.no + (p.ref ? ` (${p.ref})` : "")),
      morePays: Math.max(0, paidHere.length - 3),
    });
  }
  return out;
}

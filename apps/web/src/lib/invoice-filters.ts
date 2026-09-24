import {
  INVOICE_SEARCH_SCOPES,
  INVOICE_SEARCH_SCOPE_LABELS,
  INVOICE_SORTS,
  INVOICE_SORT_LABELS,
  INVOICE_STATUSES,
  INVOICE_STATUS_LABELS,
  parseRupees,
  type InvoiceHit,
} from "@farooq/shared";
import { isPeriodKey, periodRange } from "./periods";

/**
 * The Invoices list's whole state. Like the Payments list it lives in the URL (reload and Back keep the screen): every
 * field is a plain string (or the 1-based page) and defaults are simply left out of the address. There are no presets on
 * the server — "This week" is worked out here from the business date and sent as `from` / `to`.
 */

export const SCOPE_OPTIONS = INVOICE_SEARCH_SCOPES.map((k) => [k, INVOICE_SEARCH_SCOPE_LABELS[k]] as const);
export const SORT_OPTIONS = INVOICE_SORTS.map((k) => [k, INVOICE_SORT_LABELS[k]] as const);
export const STATUS_OPTIONS = INVOICE_STATUSES.map((k) => [k, INVOICE_STATUS_LABELS[k]] as const);

export const PAGE_SIZE = 50;

export interface InvoiceFilters {
  q: string;
  scope: string;
  /** One of the eight legacy statuses, or "" for all. */
  status: string;
  region: string;
  warehouse: string;
  period: string;
  from: string;
  to: string;
  /** Rupee text as typed ("1,500"); converted to paisa only when the request is built. */
  min: string;
  max: string;
  sort: string;
  page: number;
}

export const DEFAULT_INVOICE_FILTERS: InvoiceFilters = {
  q: "",
  scope: "all",
  status: "",
  region: "",
  warehouse: "",
  period: "all",
  from: "",
  to: "",
  min: "",
  max: "",
  sort: "newest",
  page: 1,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(str(v)) ? (str(v) as T) : fallback);

/** Anything that can arrive in the address → a valid filter set (a hand-edited URL never breaks the screen). */
export function invoiceFiltersFromSearch(raw: Record<string, unknown>): InvoiceFilters {
  const page = Number.parseInt(str(raw.page), 10);
  return {
    q: str(raw.q).slice(0, 200),
    scope: oneOf(raw.scope, INVOICE_SEARCH_SCOPES, "all"),
    status: oneOf(raw.status, [...INVOICE_STATUSES, ""] as const, ""),
    region: UUID.test(str(raw.region)) ? str(raw.region) : "",
    warehouse: UUID.test(str(raw.warehouse)) ? str(raw.warehouse) : "",
    period: isPeriodKey(str(raw.period)) ? str(raw.period) : "all",
    from: str(raw.from),
    to: str(raw.to),
    min: str(raw.min).slice(0, 30),
    max: str(raw.max).slice(0, 30),
    sort: oneOf(raw.sort, INVOICE_SORTS, "newest"),
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100_000) : 1,
  };
}

/** Filter set → the address parameters: defaults are left out so a clean screen has a clean URL. */
export function invoiceFiltersToSearch(f: InvoiceFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_INVOICE_FILTERS) as (keyof InvoiceFilters)[]) {
    const value = f[key];
    if (value !== DEFAULT_INVOICE_FILTERS[key] && str(value) !== "") out[key] = str(value);
  }
  // dates are meaningless without "custom"
  if (f.period !== "custom") {
    delete out.from;
    delete out.to;
  }
  return out;
}

/** True when anything narrows the list (drives "Clear filters" and the "n of N match" wording). */
export function hasActiveInvoiceFilters(f: InvoiceFilters): boolean {
  return Boolean(f.q.trim() || f.status || f.region || f.warehouse || f.period !== "all" || f.min.trim() || f.max.trim());
}

export interface BuiltInvoiceQuery {
  /** Parameters for `GET /invoices` (`limit` / `offset` included unless paging is off). */
  params: Record<string, string>;
  /** Per-field problems with what was typed; while any exist the request is not sent. */
  errors: { min?: string; max?: string };
}

/**
 * Filters → API query. The raw box goes to the server as `q` (it reads typed dates and words itself — never parsed here).
 * Amounts become integer paisa via `parseRupees` (on the grand total). A period preset becomes `from` / `to` from the
 * business date.
 */
export function buildInvoicesQuery(f: InvoiceFilters, today: string, opts: { paging?: boolean } = {}): BuiltInvoiceQuery {
  const params: Record<string, string> = {};
  const errors: BuiltInvoiceQuery["errors"] = {};

  if (f.q.trim()) params.q = f.q;
  if (f.scope !== "all") params.scope = f.scope;
  if (f.status) params.status = f.status;
  if (f.region) params.regionId = f.region;
  if (f.warehouse) params.warehouseId = f.warehouse;
  if (f.sort !== "newest") params.sort = f.sort;

  if (f.period === "custom") {
    if (f.from) params.from = f.from;
    if (f.to) params.to = f.to;
  } else if (f.period !== "all") {
    const [from, to] = periodRange(f.period, today);
    if (from) params.from = from;
    if (to) params.to = to;
  }

  for (const [field, param] of [
    ["min", "minP"],
    ["max", "maxP"],
  ] as const) {
    if (!f[field].trim()) continue;
    const r = parseRupees(f[field]);
    if (r.ok) params[param] = String(r.paisa);
    else errors[field] = r.message;
  }

  if (opts.paging !== false) {
    params.limit = String(PAGE_SIZE);
    params.offset = String((f.page - 1) * PAGE_SIZE);
  }
  return { params, errors };
}

/** The CSV export: the same filters, every match, no paging. */
export const buildInvoiceExportQuery = (f: InvoiceFilters, today: string): BuiltInvoiceQuery => buildInvoicesQuery(f, today, { paging: false });

/** A bag count as the legacy printed it under the number: "20", "2.5". */
const bags = (n: number): string => String(Number(n.toFixed(3)));

/**
 * "why it matched", drawn under the invoice number as the legacy did:
 * "Taj Mahal Sella × 20 · +1 more · Paid by REC-2026-000031 (4471)".
 */
export function hitsText(h: InvoiceHit | null): string {
  if (!h) return "";
  const parts: string[] = [];
  if (h.lines.length > 0) parts.push(h.lines.map((l) => `${l.name} × ${bags(l.quantity)}`).join(" · "));
  if (h.more > 0) parts.push(`+${h.more} more`);
  if (h.pays.length > 0) parts.push(`Paid by ${h.pays.join(", ")}`);
  if (h.morePays > 0) parts.push(`+${h.morePays} more receipt${h.morePays === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** The colour a status pill gets. */
export function statusTone(status: string): "neutral" | "ok" | "warn" | "danger" {
  switch (status) {
    case "PAID":
      return "ok";
    case "CANCELLED":
      return "danger";
    case "PARTIALLY_PAID":
    case "PARTIALLY_RETURNED":
    case "RETURNED":
      return "warn";
    default:
      return "neutral";
  }
}

export const statusLabel = (status: string): string => (INVOICE_STATUS_LABELS as Record<string, string>)[status] ?? status;

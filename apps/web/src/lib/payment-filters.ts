import { parseRupees } from "@farooq/shared";
import { isPeriodKey, periodRange } from "./periods";

/**
 * The Payments screen's whole state. It lives in the URL (reload and back / forward keep the screen), so every field
 * is a plain string (or the 1-based page) and defaults are simply left out of the address.
 */

export const TABS = ["all", "received", "paidToShops", "paidToSuppliers", "reversed"] as const;
export type PaymentTab = (typeof TABS)[number];

export const SCOPE_OPTIONS = [
  ["all", "Search: everything"],
  ["number", "Search: receipt / voucher no."],
  ["party", "Search: shop or supplier / phone"],
  ["reference", "Search: cheque / reference no."],
  ["invoice", "Search: invoice / purchase no."],
  ["amount", "Search: amount"],
  ["notes", "Search: notes & other"],
] as const;
export const SORT_OPTIONS = [
  ["newest", "Newest first"],
  ["oldest", "Oldest first"],
  ["high", "Highest amount"],
  ["low", "Lowest amount"],
] as const;
/** What the legacy `ERP.ENUM.methods` offered. */
export const PAYMENT_METHODS = ["Cash", "Bank Transfer", "JazzCash", "Easypaisa", "Cheque", "Adjustment"] as const;

export const PAGE_SIZE = 50;

export type PanelName = "receive" | "pay" | "refund";
export const PANELS: readonly PanelName[] = ["receive", "pay", "refund"];

export interface PaymentFilters {
  q: string;
  scope: string;
  tab: PaymentTab;
  method: string;
  region: string;
  period: string;
  from: string;
  to: string;
  /** Rupee text as typed ("1,500"); converted to paisa only when the request is built. */
  min: string;
  max: string;
  sort: string;
  page: number;
  /** Which Receive / Pay panel is open, if any. Not a filter, but it belongs in the address so Back closes it. */
  panel: PanelName | "";
}

export const DEFAULT_FILTERS: PaymentFilters = {
  q: "",
  scope: "all",
  tab: "all",
  method: "",
  region: "",
  period: "all",
  from: "",
  to: "",
  min: "",
  max: "",
  sort: "newest",
  page: 1,
  panel: "",
};

const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(str(v)) ? (str(v) as T) : fallback;

/** Anything that can arrive in the address → a valid filter set (a hand-edited URL never breaks the screen). */
export function filtersFromSearch(raw: Record<string, unknown>): PaymentFilters {
  const page = Number.parseInt(str(raw.page), 10);
  return {
    q: str(raw.q).slice(0, 200),
    scope: oneOf(raw.scope, SCOPE_OPTIONS.map(([k]) => k), "all"),
    tab: oneOf(raw.tab, TABS, "all"),
    method: str(raw.method).slice(0, 40),
    region: str(raw.region),
    period: isPeriodKey(str(raw.period)) ? str(raw.period) : "all",
    from: str(raw.from),
    to: str(raw.to),
    min: str(raw.min).slice(0, 30),
    max: str(raw.max).slice(0, 30),
    sort: oneOf(raw.sort, SORT_OPTIONS.map(([k]) => k), "newest"),
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100_000) : 1,
    panel: oneOf(raw.panel, [...PANELS, ""] as const, ""),
  };
}

/** Filter set → the address parameters: defaults are left out so a clean screen has a clean URL. */
export function filtersToSearch(f: PaymentFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof PaymentFilters)[]) {
    const value = f[key];
    if (value !== DEFAULT_FILTERS[key] && str(value) !== "") out[key] = str(value);
  }
  // dates are meaningless without "custom"
  if (f.period !== "custom") {
    delete out.from;
    delete out.to;
  }
  return out;
}

/** True when anything narrows the list (drives "Clear filters" and the "n of N match" wording). The open panel is not a filter. */
export function hasActiveFilters(f: PaymentFilters): boolean {
  return Boolean(f.q.trim() || f.tab !== "all" || f.method || f.region || f.period !== "all" || f.min.trim() || f.max.trim());
}

export interface BuiltQuery {
  /** Parameters for `GET /payments` (`limit` / `offset` included unless paging is off). */
  params: Record<string, string>;
  /** Per-field problems with what was typed; while any exist the request is not sent. */
  errors: { min?: string; max?: string };
}

/**
 * Filters → API query. The raw box goes to the server as `q` (it reads typed dates and words itself — never parsed
 * here). Amounts become integer paisa via `parseRupees`. A period preset becomes `from` / `to` from the business date.
 * Every tab also says `status`, so a tab's number and the rows under it are the same set.
 */
export function buildPaymentsQuery(f: PaymentFilters, today: string, opts: { paging?: boolean } = {}): BuiltQuery {
  const params: Record<string, string> = {};
  const errors: BuiltQuery["errors"] = {};

  if (f.q.trim()) params.q = f.q;
  if (f.scope !== "all") params.scope = f.scope;
  if (f.method) params.method = f.method;
  if (f.region) params.regionId = f.region;
  if (f.sort !== "newest") params.sort = f.sort;

  if (f.tab === "reversed") params.status = "REVERSED";
  else {
    params.status = "POSTED";
    if (f.tab !== "all") params.direction = f.tab;
  }

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
export const buildExportQuery = (f: PaymentFilters, today: string): BuiltQuery => buildPaymentsQuery(f, today, { paging: false });

export const toQueryString = (params: Record<string, string>): string => {
  const s = new URLSearchParams(params).toString();
  return s ? `?${s}` : "";
};

/** Sentence for a typed date the server read: “12/09/2026” is read as 12 Sep 2026 (day / month / year). */
export function describeReadDate(d: { label: string; from: string; to: string; src: string; dayFirst: boolean }, replaced: boolean): string {
  const span = d.from === d.to ? d.label : `all of ${d.label}`;
  return `“${d.src}” is read as ${span}${d.dayFirst ? " (day / month / year)" : ""}${replaced ? " — this replaces the date filter" : ""}.`;
}

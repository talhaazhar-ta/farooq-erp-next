import {
  PURCHASE_PAY_LABELS,
  PURCHASE_PAYMENT_STATUSES,
  PURCHASE_SORTS,
  PURCHASE_SORT_LABELS,
  PURCHASE_STATUS_LABELS,
  type PurchaseHit,
} from "@farooq/shared";
import { isPeriodKey, periodRange } from "./periods";

/**
 * The Purchases list's whole state. Like the Invoices list it lives in the URL (reload and Back keep the screen): every field is a plain
 * string (or the 1-based page) and defaults are left out of the address. "This week" is worked out here from the business date and sent
 * as `from` / `to`.
 */

export const SORT_OPTIONS = PURCHASE_SORTS.map((k) => [k, PURCHASE_SORT_LABELS[k]] as const);
export const PAY_OPTIONS = PURCHASE_PAYMENT_STATUSES.map((k) => [k, PURCHASE_PAY_LABELS[k]] as const);

export const PAGE_SIZE = 50;

export interface PurchaseFilters {
  q: string;
  /** PAID / PARTIAL / UNPAID, or "" for all. */
  pay: string;
  warehouse: string;
  category: string;
  period: string;
  from: string;
  to: string;
  sort: string;
  page: number;
}

export const DEFAULT_PURCHASE_FILTERS: PurchaseFilters = { q: "", pay: "", warehouse: "", category: "", period: "all", from: "", to: "", sort: "newest", page: 1 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(str(v)) ? (str(v) as T) : fallback);

/** Anything that can arrive in the address → a valid filter set (a hand-edited URL never breaks the screen). */
export function purchaseFiltersFromSearch(raw: Record<string, unknown>): PurchaseFilters {
  const page = Number.parseInt(str(raw.page), 10);
  return {
    q: str(raw.q).slice(0, 200),
    pay: oneOf(raw.pay, [...PURCHASE_PAYMENT_STATUSES, ""] as const, ""),
    warehouse: UUID.test(str(raw.warehouse)) ? str(raw.warehouse) : "",
    category: str(raw.category).slice(0, 100),
    period: isPeriodKey(str(raw.period)) ? str(raw.period) : "all",
    from: str(raw.from),
    to: str(raw.to),
    sort: oneOf(raw.sort, PURCHASE_SORTS, "newest"),
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 100_000) : 1,
  };
}

/** Filter set → the address parameters: defaults are left out so a clean screen has a clean URL. */
export function purchaseFiltersToSearch(f: PurchaseFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(DEFAULT_PURCHASE_FILTERS) as (keyof PurchaseFilters)[]) {
    const value = f[key];
    if (value !== DEFAULT_PURCHASE_FILTERS[key] && str(value) !== "") out[key] = str(value);
  }
  if (f.period !== "custom") {
    delete out.from;
    delete out.to;
  }
  return out;
}

export function hasActivePurchaseFilters(f: PurchaseFilters): boolean {
  return Boolean(f.q.trim() || f.pay || f.warehouse || f.category || f.period !== "all");
}

/** Filters → `GET /purchases` parameters. The raw box goes to the server as `q` (it reads typed dates itself). */
export function buildPurchasesQuery(f: PurchaseFilters, today: string, opts: { paging?: boolean } = {}): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.q.trim()) params.q = f.q;
  if (f.pay) params.paymentStatus = f.pay;
  if (f.warehouse) params.warehouseId = f.warehouse;
  if (f.category) params.category = f.category;
  if (f.sort !== "newest") params.sort = f.sort;
  if (f.period === "custom") {
    if (f.from) params.from = f.from;
    if (f.to) params.to = f.to;
  } else if (f.period !== "all") {
    const [from, to] = periodRange(f.period, today);
    if (from) params.from = from;
    if (to) params.to = to;
  }
  if (opts.paging !== false) {
    params.limit = String(PAGE_SIZE);
    params.offset = String((f.page - 1) * PAGE_SIZE);
  }
  return params;
}

/** A bag count as the legacy wrote it ("20", "2.5", "1,250"). */
export const bagsText = (n: number): string => Number(n.toFixed(3)).toLocaleString("en-US");

/** "why it matched", under the number: "Zam Zam Atta 20KG × 100 · +1 more". */
export function purchaseHitsText(h: PurchaseHit | null): string {
  if (!h) return "";
  const parts = h.lines.map((l) => `${l.name} × ${bagsText(l.quantity)}`);
  if (h.more > 0) parts.push(`+${h.more} more`);
  return parts.join(" · ");
}

export const purchaseStatusLabel = (s: string): string => (PURCHASE_STATUS_LABELS as Record<string, string>)[s] ?? s;
export const payLabel = (s: string): string => (PURCHASE_PAY_LABELS as Record<string, string>)[s] ?? s;

export function purchaseStatusTone(s: string): "neutral" | "ok" | "warn" | "danger" {
  if (s === "CANCELLED") return "danger";
  if (s === "PARTIALLY_RECEIVED" || s === "ORDERED" || s === "DRAFT") return "warn";
  return "neutral";
}
export function payTone(s: string): "neutral" | "ok" | "warn" | "danger" {
  return s === "PAID" ? "ok" : s === "PARTIAL" ? "warn" : "danger";
}

import { formatMoney } from "./money.js";

/**
 * What a transaction says about its lines, in one short string — a literal port of the legacy `ERP.Desc.fromLines`,
 * `qtyOf` and `qtyLabel` (24-client-changes.js). One implementation for the statement rows, the Receive panel's
 * outstanding invoices and the printed invoice, so they can never word the same invoice differently.
 *
 *   one line    "200 × Zam Zam 20KG @ PKR 2,700"       (pack shown when it is not "Bag")
 *   many lines  "3 items — 500 total qty"
 *   none        ""
 */

export interface SummaryLine {
  descriptionEn: string | null;
  description: string | null;
  package: string | null;
  qtyMilli: number;
  unitPriceP: number;
}

export interface QtyInfo {
  /** Σ quantities in bags (≤ 3 decimals). */
  total: number;
  /** True when the lines are in different packages: the total is then a count, not one unit. */
  mixed: boolean;
}

/** The legacy `MAX_DESC`: a typed description is cut at this many characters. */
export const MAX_DESCRIPTION = 500;

/** The legacy `cleanDesc`: line breaks and tabs become spaces, the ends are trimmed (spaces and NBSP), the length capped. */
const NBSP = String.fromCharCode(0xa0);
const TRIM_ENDS = new RegExp(`^[ ${NBSP}]+|[ ${NBSP}]+$`, "g");
export function cleanDescription(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v).replace(/[\r\n\t]+/g, " ").replace(TRIM_ENDS, "");
  return s.length > MAX_DESCRIPTION ? s.slice(0, MAX_DESCRIPTION) : s;
}

/** A quantity in thousandths as `Number.toLocaleString("en-US")` writes it: "1,250", "2.5", "0.6". */
export function formatQtyMilli(qtyMilli: number): string {
  const neg = qtyMilli < 0;
  const abs = Math.abs(Math.round(qtyMilli));
  const whole = Math.floor(abs / 1000);
  const frac = String(abs % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? "." + frac : ""}`;
}

const nameOf = (l: SummaryLine): string => l.descriptionEn || l.description || "item";

/** `Desc.fromLines`. */
export function lineSummary(lines: readonly SummaryLine[]): string {
  if (lines.length === 0) return "";
  if (lines.length === 1) {
    const it = lines[0]!;
    const pack = it.package && it.package !== "Bag" ? ` ${it.package}` : "";
    return `${formatQtyMilli(it.qtyMilli)} × ${nameOf(it)}${pack}${it.unitPriceP ? ` @ ${formatMoney(it.unitPriceP)}` : ""}`;
  }
  const total = lines.reduce((a, l) => a + l.qtyMilli, 0);
  return `${lines.length} items — ${formatQtyMilli(total)} total qty`;
}

/** `qtyOf`: null with no lines. Units are not summed across different packages — the row says "(mixed units)". */
export function qtyInfoOf(lines: readonly Pick<SummaryLine, "package" | "qtyMilli">[]): QtyInfo | null {
  if (lines.length === 0) return null;
  const units = new Set(lines.map((l) => l.package || "Bag"));
  return { total: lines.reduce((a, l) => a + l.qtyMilli, 0) / 1000, mixed: units.size > 1 };
}

/** `Desc.qtyLabel`: "—" without a quantity, "500" or "500 (mixed units)". */
export function qtyLabelOf(info: QtyInfo | null): string {
  if (!info || !info.total) return "—";
  const n = formatQtyMilli(Math.round(info.total * 1000));
  return info.mixed ? `${n} (mixed units)` : n;
}

/** The statement's description of an invoice row (`decorate` + `Desc.resolve` + `Desc.auto("INVOICE")`): what was typed, else the lines, else "Sale invoice <number>". */
export function invoiceRowDetail(typed: string | null | undefined, lines: readonly SummaryLine[], invoiceNumber: string | null): string {
  return cleanDescription(typed) || cleanDescription(lineSummary(lines)) || `Sale invoice ${invoiceNumber ?? ""}`;
}

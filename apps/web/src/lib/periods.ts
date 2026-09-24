/**
 * Date-range presets for the Payments and Statement filters, worked out from the BUSINESS date (Asia/Karachi
 * calendar day, passed in as `YYYY-MM-DD`) — never from `toISOString()` or the browser's local clock zone.
 * Arithmetic is on the calendar only (UTC has no daylight saving, so adding whole days cannot shift a day).
 * Same definitions as the legacy `ERP.Reports.range` + the module-33 `presetRange`.
 */

export const PERIOD_OPTIONS = [
  ["all", "All dates"],
  ["today", "Today"],
  ["yesterday", "Yesterday"],
  ["week", "This week"],
  ["month", "This month"],
  ["lastmonth", "Last month"],
  ["last30", "Last 30 days"],
  ["last90", "Last 3 months"],
  ["year", "This year"],
  ["lastyear", "Last 12 months"],
  ["custom", "Custom range…"],
] as const;
export type PeriodKey = (typeof PERIOD_OPTIONS)[number][0];

export const isPeriodKey = (v: unknown): v is PeriodKey => PERIOD_OPTIONS.some(([k]) => k === v);

const pad2 = (n: number): string => (n < 10 ? "0" : "") + n;
const isoOf = (d: Date): string => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

function parts(iso: string): [number, number, number] {
  const [y, m, d] = iso.split("-").map(Number);
  return [y!, m!, d!];
}

/** `iso` plus `days` calendar days (negative goes back). */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = parts(iso);
  return isoOf(new Date(Date.UTC(y, m - 1, d + days)));
}

/** 0 = Monday … 6 = Sunday. */
function weekdayIndex(iso: string): number {
  const [y, m, d] = parts(iso);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return (dow || 7) - 1;
}

/** The [from, to] a preset stands for on business date `today`; `[null, null]` for "all" / "custom". */
export function periodRange(key: string, today: string): [string | null, string | null] {
  const [y, m] = parts(today);
  switch (key) {
    case "today":
      return [today, today];
    case "yesterday": {
      const d = addDays(today, -1);
      return [d, d];
    }
    case "week":
      return [addDays(today, -weekdayIndex(today)), today]; // Monday .. today (legacy)
    case "month":
      return [`${y}-${pad2(m)}-01`, today];
    case "lastmonth": {
      const first = new Date(Date.UTC(y, m - 2, 1));
      const last = new Date(Date.UTC(y, m - 1, 0));
      return [isoOf(first), isoOf(last)];
    }
    case "last30":
      return [addDays(today, -30), today];
    case "last90":
      return [addDays(today, -90), today];
    case "year":
      return [`${y}-01-01`, today];
    case "lastyear":
      return [addDays(today, -365), today];
    default:
      return [null, null];
  }
}

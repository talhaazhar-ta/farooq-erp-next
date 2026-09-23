/**
 * Business dates (CLAUDE.md rule 6): a "date" is a local calendar day written `YYYY-MM-DD`, never built from
 * `toISOString()` — that is UTC, and Pakistan (UTC+5) would still say "yesterday" until 05:00 local time.
 */

export const BUSINESS_TIME_ZONE = "Asia/Karachi";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day in `YYYY-MM-DD` form (2026-02-30 and 2026-13-01 are not). Years 2000-2100 only. */
export function isValidBusinessDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 2000 || year > 2100) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

const karachiParts = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The business date (in Asia/Karachi) that the instant `now` falls on, as `YYYY-MM-DD`. */
export function businessDateOf(now: Date): string {
  const parts = karachiParts.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Money at the edges (CLAUDE.md rule 5): everything inside the system is integer paisa; rupee text is only ever
 * parsed on the way in and formatted on the way out. Nothing here goes through floating point.
 */

/** Sanity cap on a single amount: 10^13 paisa = 10^11 rupees. Far above any real voucher, far below 2^53. */
export const MAX_AMOUNT_P = 10_000_000_000_000;

export type ParsedRupees = { ok: true; paisa: number } | { ok: false; message: string };

export const MONEY_MESSAGES = {
  empty: "Enter an amount.",
  notANumber: "Enter a valid amount, for example 1,500 or 1500.50.",
  negative: "An amount cannot be negative.",
  decimals: "Use at most 2 decimal places (paisa).",
  tooLarge: "That amount is too large.",
} as const;

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * Rupee text typed by a person → integer paisa. Accepts thousands commas, spaces and a leading `Rs` / `Rs.` /
 * `PKR`. STRICT where the legacy `toPaisa` was lenient: more than two decimal places is an error (the legacy
 * rounded silently), so "1.005" is refused instead of becoming 1.01 or 1.00. The digits are read as text — never
 * multiplied as floats — so 1.005 and 0.1 + 0.2 style traps cannot occur.
 */
export function parseRupees(text: string): ParsedRupees {
  let s = String(text ?? "").replace(ARABIC_DIGITS, (c) => {
    const k = c.charCodeAt(0);
    return String(k >= 0x06f0 ? k - 0x06f0 : k - 0x0660);
  });
  s = s.replace(/[,\s]|pkr|rs\.?/gi, "");
  if (s === "") return { ok: false, message: MONEY_MESSAGES.empty };
  if (s.startsWith("-")) return { ok: false, message: /^-\d*\.?\d*$/.test(s) && /\d/.test(s) ? MONEY_MESSAGES.negative : MONEY_MESSAGES.notANumber };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return { ok: false, message: MONEY_MESSAGES.notANumber };
  const whole = (m[1] ?? "").replace(/^0+(?=\d)/, "");
  const frac = m[2] ?? "";
  if (frac.length > 2) return { ok: false, message: MONEY_MESSAGES.decimals };
  if (whole.length > 14) return { ok: false, message: MONEY_MESSAGES.tooLarge };
  const paisa = Number(whole === "" ? "0" : whole) * 100 + Number(frac.padEnd(2, "0"));
  if (paisa > MAX_AMOUNT_P) return { ok: false, message: MONEY_MESSAGES.tooLarge };
  return { ok: true, paisa };
}

const group = (digits: string): string => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * Paisa → "1,500" or "1,500.50": en-US grouping, `.NN` only when there are paisa (the legacy `Money.fmt`, without
 * the currency word). A negative figure carries a leading "-".
 */
export function formatPaisa(paisa: number): string {
  const neg = paisa < 0;
  const abs = Math.abs(Math.round(paisa));
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${neg ? "-" : ""}${group(String(whole))}${cents ? "." + String(cents).padStart(2, "0") : ""}`;
}

/** Paisa → "1,500.00": always two decimals (the legacy `Money.fmtPlain`, used for tables and files). */
export function formatPaisaPlain(paisa: number): string {
  const neg = paisa < 0;
  const abs = Math.abs(Math.round(paisa));
  return `${neg ? "-" : ""}${group(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, "0")}`;
}

/** Paisa → "PKR 1,500.50" exactly like the legacy `Money.fmt` (a negative gets "− " in front, U+2212). */
export function formatMoney(paisa: number): string {
  return `${paisa < 0 ? "− " : ""}PKR ${formatPaisa(Math.abs(paisa))}`;
}

/** Paisa → plain rupees for a file cell: "1500" or "1500.50" (no grouping, no trailing ".00"). */
export function rupeesText(paisa: number): string {
  const neg = paisa < 0;
  const abs = Math.abs(Math.round(paisa));
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}${abs % 100 ? "." + String(abs % 100).padStart(2, "0") : ""}`;
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen",
  "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
] as const;
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"] as const;

const two = (x: number): string => (x < 20 ? ONES[x]! : TENS[Math.floor(x / 10)]! + (x % 10 ? " " + ONES[x % 10] : ""));
const three = (x: number): string =>
  x > 99 ? `${ONES[Math.floor(x / 100)]} Hundred${x % 100 ? " " + two(x % 100) : ""}` : two(x);
/** Crores can run past 999 for the largest sane amounts (the legacy printed "undefined" there): "Ten Thousand". */
const crores = (x: number): string => (x < 1000 ? three(x) : `${three(Math.floor(x / 1000))} Thousand${x % 1000 ? " " + three(x % 1000) : ""}`);

/**
 * Pakistani numbering (Thousand / Lac / Crore), in the legacy style ("Twelve Thousand Three Hundred Forty Five
 * Rupees Only"). Unlike the legacy, which rounded to whole rupees, the paisa are said too:
 * "… Rupees and Fifty Paisa Only".
 */
export function amountInWords(paisa: number): string {
  const p = Math.round(Number(paisa) || 0);
  if (p < 0) return "Minus " + amountInWords(-p);
  let rupees = Math.floor(p / 100);
  const paise = p % 100;
  const parts: string[] = [];
  const cr = Math.floor(rupees / 10_000_000);
  rupees %= 10_000_000;
  const lac = Math.floor(rupees / 100_000);
  rupees %= 100_000;
  const th = Math.floor(rupees / 1000);
  rupees %= 1000;
  if (cr) parts.push(crores(cr) + " Crore");
  if (lac) parts.push(three(lac) + " Lac");
  if (th) parts.push(three(th) + " Thousand");
  if (rupees) parts.push(three(rupees));
  const rupeeWords = parts.length ? parts.join(" ") : "Zero";
  return paise ? `${rupeeWords} Rupees and ${two(paise)} Paisa Only` : `${rupeeWords} Rupees Only`;
}

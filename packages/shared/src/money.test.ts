import { describe, expect, it } from "vitest";
import { amountInWords, formatMoney, formatPaisa, formatPaisaPlain, MAX_AMOUNT_P, parseRupees, rupeesText } from "./money.js";

const paisa = (text: string): number => {
  const r = parseRupees(text);
  if (!r.ok) throw new Error(`${text}: ${r.message}`);
  return r.paisa;
};
const refusal = (text: string): string | null => {
  const r = parseRupees(text);
  return r.ok ? null : r.message;
};
const NOT_A_NUMBER = "Enter a valid amount, for example 1,500 or 1500.50.";

describe("parseRupees — strict money entry", () => {
  it.each([
    ["0", 0], ["1", 100], ["1500", 150_000], ["1,500", 150_000], ["1,00,000", 10_000_000], ["1500.5", 150_050],
    ["1500.50", 150_050], ["0.05", 5], [".5", 50], ["5.", 500], ["1.10", 110], ["  Rs. 2,500.75 ", 250_075],
    ["PKR 1,000", 100_000], ["rs 10", 1000], ["٥٠٠", 50_000], ["۱.۵", 150], ["007", 700],
  ] as [string, number][])("%s → %i paisa", (text, want) => {
    expect(paisa(text)).toBe(want);
  });
  it("never goes through floating point: 1.005 is refused, and 1.15 / 8.20 (float traps) are exact", () => {
    expect(refusal("1.005")).toBe("Use at most 2 decimal places (paisa).");
    expect(refusal("1.000")).toBe("Use at most 2 decimal places (paisa).");
    expect(paisa("0.30")).toBe(30);
    expect(paisa("1.15")).toBe(115); // 1.15 * 100 = 114.99999999999999 in floats
    expect(paisa("8.20")).toBe(820); // 8.2 * 100 = 819.9999999999999
  });
  it("refuses empty, non-numeric and negative input, each with its own message", () => {
    expect(refusal("")).toBe("Enter an amount.");
    expect(refusal("   ")).toBe("Enter an amount.");
    expect(refusal("abc")).toBe(NOT_A_NUMBER);
    expect(refusal("1e3")).toBe(NOT_A_NUMBER);
    expect(refusal("1.2.3")).toBe(NOT_A_NUMBER);
    expect(refusal(".")).toBe(NOT_A_NUMBER);
    expect(refusal("-5")).toBe("An amount cannot be negative.");
    expect(refusal("-")).toBe(NOT_A_NUMBER);
    expect(refusal("--5")).toBe(NOT_A_NUMBER);
  });
  it("refuses anything above the cap and accepts the cap itself", () => {
    expect(paisa("100,000,000,000")).toBe(MAX_AMOUNT_P);
    expect(refusal("100,000,000,000.01")).toBe("That amount is too large.");
    expect(refusal("1" + "0".repeat(20))).toBe("That amount is too large.");
  });
});

describe("formatPaisa / formatMoney — the legacy Money.fmt", () => {
  it("groups by thousands and shows .NN only when there are paisa", () => {
    expect(formatPaisa(0)).toBe("0");
    expect(formatPaisa(100)).toBe("1");
    expect(formatPaisa(42_500_000)).toBe("425,000");
    expect(formatPaisa(42_500_050)).toBe("425,000.50");
    expect(formatPaisa(5)).toBe("0.05");
    expect(formatPaisa(123_456_789)).toBe("1,234,567.89");
    expect(formatPaisa(-150_000)).toBe("-1,500");
  });
  it("formatPaisaPlain always has two decimals (legacy fmtPlain)", () => {
    expect(formatPaisaPlain(42_500_000)).toBe("425,000.00");
    expect(formatPaisaPlain(5)).toBe("0.05");
    expect(formatPaisaPlain(-150_050)).toBe("-1,500.50");
  });
  it("formatMoney adds the currency word, and a negative is '− PKR …'", () => {
    expect(formatMoney(42_500_000)).toBe("PKR 425,000");
    expect(formatMoney(42_500_050)).toBe("PKR 425,000.50");
    expect(formatMoney(-150_000)).toBe("− PKR 1,500");
  });
  it("rupeesText is the bare figure for a file cell", () => {
    expect(rupeesText(100_000)).toBe("1000");
    expect(rupeesText(100_050)).toBe("1000.50");
    expect(rupeesText(5)).toBe("0.05");
  });
});

describe("amountInWords — Pakistani numbering, paisa said too", () => {
  it.each([
    [0, "Zero Rupees Only"],
    [100, "One Rupees Only"],
    [2_100, "Twenty One Rupees Only"],
    [1_900, "Nineteen Rupees Only"],
    [5_000, "Fifty Rupees Only"],
    [10_000, "One Hundred Rupees Only"],
    [100_000, "One Thousand Rupees Only"],
    [1_234_500, "Twelve Thousand Three Hundred Forty Five Rupees Only"],
    [10_000_000, "One Lac Rupees Only"],
    [123_456_700, "Twelve Lac Thirty Four Thousand Five Hundred Sixty Seven Rupees Only"],
    [1_000_000_000, "One Crore Rupees Only"],
    [1_500_000_000, "One Crore Fifty Lac Rupees Only"],
    [100_000_000_000, "One Hundred Crore Rupees Only"],
  ] as [number, string][])("%i paisa → %s", (p, words) => {
    expect(amountInWords(p)).toBe(words);
  });
  it("says the paisa: 'Rupees and Fifty Paisa Only'", () => {
    expect(amountInWords(100_050)).toBe("One Thousand Rupees and Fifty Paisa Only");
    expect(amountInWords(101)).toBe("One Rupees and One Paisa Only");
    expect(amountInWords(50)).toBe("Zero Rupees and Fifty Paisa Only");
    expect(amountInWords(2_100_021)).toBe("Twenty One Thousand Rupees and Twenty One Paisa Only");
  });
  it("a negative amount is 'Minus …'", () => {
    expect(amountInWords(-100_000)).toBe("Minus One Thousand Rupees Only");
  });
  it("the largest sane amount does not print 'undefined' (the legacy did above 999 crore)", () => {
    expect(amountInWords(MAX_AMOUNT_P)).toBe("Ten Thousand Crore Rupees Only");
    expect(amountInWords(1_900_000_000_000)).toBe("One Thousand Nine Hundred Crore Rupees Only");
  });
});

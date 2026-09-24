import { describe, expect, it } from "vitest";
import { compactFold, foldSearch, hasTerm, joinFolded, SEARCH_SEPARATOR } from "./fold.js";

describe("foldSearch — the legacy normalize (11-search.js)", () => {
  it("lower-cases and reduces punctuation to single spaces", () => {
    expect(foldSearch("  REC-2026-000031 ")).toBe("rec 2026 000031");
    expect(foldSearch("Zam   Zam,  Sella!")).toBe("zam zam sella");
  });
  it("null / undefined / empty fold to the empty string", () => {
    expect(foldSearch(null)).toBe("");
    expect(foldSearch(undefined)).toBe("");
    expect(foldSearch("")).toBe("");
    expect(foldSearch("  ---  ")).toBe("");
  });
  it("folds the Urdu letter variants: ی/ي/ى/ئ, ک/ك, ہ/ه/ة/ھ, the alef forms, ؤ", () => {
    expect(foldSearch("کيا")).toBe(foldSearch("كیا"));
    expect(foldSearch("ہاشم")).toBe(foldSearch("هاشم"));
    expect(foldSearch("ھاشم")).toBe(foldSearch("ہاشم"));
    expect(foldSearch("آٹا")).toBe(foldSearch("اٹا".replace("ا", "آ")));
    expect(foldSearch("أحمد")).toBe(foldSearch("احمد"));
    expect(foldSearch("مؤمن")).toBe(foldSearch("مومن"));
  });
  it("strips diacritics, tatweel and zero-width marks", () => {
    expect(foldSearch("مُحَمَّد")).toBe(foldSearch("محمد"));
    expect(foldSearch("زـم")).toBe("زم");
    expect(foldSearch("زم‌زم")).toBe("زمزم");
  });
  it("folds Arabic-Indic and Persian digits to Latin (legacy S23)", () => {
    expect(foldSearch("۲۰")).toBe("20");
    expect(foldSearch("٠٥/٠٣/٢٠٢٥")).toBe("05 03 2025");
  });
  it("keeps Urdu letters and digits, drops Urdu punctuation", () => {
    expect(foldSearch("دکان، نمبر ۱۲")).toBe("دکان نمبر 12");
    expect(foldSearch("سیب؟")).toBe("سیب");
  });
  it("is idempotent", () => {
    for (const s of ["Zam-Zam ۱۲", "کيا  ھے؟", "İSTANBUL Σίσυφος"]) expect(foldSearch(foldSearch(s))).toBe(foldSearch(s));
  });
  it("lower-cases per character, so a final capital sigma is not context-sensitive", () => {
    expect(foldSearch("ΟΔΟΣ")).toBe("οδοσ");
  });
});

describe("compactFold / joinFolded", () => {
  it("compactFold removes the spaces as well", () => {
    expect(compactFold("REC-2026-000031")).toBe("rec2026000031");
    expect(compactFold("0300 123-4567")).toBe("03001234567");
  });
  it("joinFolded folds each part, drops empties and joins with the separator", () => {
    expect(joinFolded(["Ali Ahmad", null, "", "REC-1", undefined])).toBe(`ali ahmad${SEARCH_SEPARATOR}rec 1`);
    expect(joinFolded([])).toBe("");
  });
});

describe("hasTerm", () => {
  it("a word matches anywhere inside a field", () => {
    expect(hasTerm(["ali ahmad traders"], "ahmad")).toBe(true);
    expect(hasTerm(["ali ahmad traders"], "med")).toBe(false);
  });
  it("a phrase also matches with its spaces removed (zam zam ⇄ zamzam, phone with a dash)", () => {
    expect(hasTerm(["zamzam store"], "zam zam")).toBe(true);
    expect(hasTerm(["03001234567"], "0300 1234567")).toBe(true);
    expect(hasTerm(["zam store"], "zam zam")).toBe(false);
  });
  it("any of several fields is enough", () => {
    expect(hasTerm(["nothing", "the current name"], "current")).toBe(true);
    expect(hasTerm([], "x")).toBe(false);
  });
});

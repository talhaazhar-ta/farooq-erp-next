import { describe, expect, it } from "vitest";
import { hasAtMostThreeDecimals, validateInvoice, type LineForValidation, type ValidationContext } from "../src/invoices/validate.js";
import { pairKey } from "../src/invoices/stock.js";

/**
 * `Validate.invoice` (02-services.js 291-325) — every message is the legacy text VERBATIM, in the legacy order. The
 * expectations are typed from the legacy source, not produced by the code under test. No database: the context is preloaded.
 */

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const W2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHOP = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const products = new Map([
  [P1, { name: "Sella", nameEn: "Sella Rice 50kg", nameUr: "سیلا چاول" }],
  [P2, { name: "Atta", nameEn: null, nameUr: "آٹا" }],
]);

function ctx(over: Partial<ValidationContext> & { stock?: Record<string, number> } = {}): ValidationContext {
  const stock = over.stock ?? { [pairKey({ productId: P1, warehouseId: W1 })]: 100_000, [pairKey({ productId: P2, warehouseId: W1 })]: 100_000 };
  return {
    customerExists: true,
    warehouseNames: new Map([[W1, "Main Godown"], [W2, "Shop Godown"]]),
    products,
    availableMilli: (p, w) => stock[pairKey({ productId: p, warehouseId: w })] ?? 0,
    allowNegativeStock: false,
    isDraft: false,
    skipStock: false,
    ...over,
  };
}

const header = (over: Partial<Parameters<typeof validateInvoice>[0]> = {}) => ({
  customerId: SHOP,
  warehouseId: W1,
  invoiceDiscountP: 0,
  freightP: 0,
  loadingP: 0,
  otherChargesP: 0,
  paidP: 0,
  ...over,
});

const line = (over: Partial<LineForValidation> = {}): LineForValidation => ({
  productId: P1,
  warehouseId: W1,
  quantity: 1,
  unitPriceP: 100_000,
  discountP: 0,
  taxP: 0,
  taxRatePct: 0,
  ...over,
});

const errorsOf = (h: Parameters<typeof validateInvoice>[0], lines: LineForValidation[], c = ctx()) => validateInvoice(h, lines, c).errors;

describe("Validate.invoice — the legacy messages, verbatim", () => {
  it("a valid invoice has no errors", () => {
    expect(errorsOf(header(), [line()])).toEqual([]);
  });

  it("no shop / an unknown shop → 'Choose a shop to invoice.'", () => {
    expect(errorsOf(header({ customerId: "" }), [line()])).toEqual(["Choose a shop to invoice."]);
    expect(errorsOf(header(), [line()], ctx({ customerExists: false }))).toEqual(["Choose a shop to invoice."]);
  });

  it("no / unknown warehouse → 'Choose the warehouse the bags leave from.'", () => {
    expect(errorsOf(header({ warehouseId: "" }), [line({ warehouseId: W1 })])).toEqual(["Choose the warehouse the bags leave from."]);
    expect(errorsOf(header({ warehouseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }), [line()])).toEqual(["Choose the warehouse the bags leave from."]);
  });

  it("no lines → 'Add at least one product line.'", () => {
    expect(errorsOf(header(), [])).toEqual(["Add at least one product line."]);
  });

  it("a product that no longer exists → 'Line n: that product no longer exists.'", () => {
    expect(errorsOf(header(), [line(), line({ productId: "99999999-9999-4999-8999-999999999999" })])).toEqual(["Line 2: that product no longer exists."]);
  });

  it("quantity must be more than zero, and the label is the English name, else the Urdu name (legacy `p.en || p.ur`)", () => {
    expect(errorsOf(header(), [line({ quantity: 0 })])).toEqual(["Line 1 (Sella Rice 50kg): quantity must be more than zero."]);
    expect(errorsOf(header(), [line({ productId: P2, quantity: -2 })])).toEqual(["Line 1 (آٹا): quantity must be more than zero."]);
  });

  it("a negative rate → 'Line n: the rate cannot be negative.'", () => {
    expect(errorsOf(header(), [line({ unitPriceP: -1 })])).toContain("Line 1: the rate cannot be negative.");
  });

  it("a zero rate on a posted invoice → 'enter a rate per bag'; a draft may have one", () => {
    expect(errorsOf(header(), [line({ unitPriceP: 0 })])).toEqual(["Line 1 (Sella Rice 50kg): enter a rate per bag."]);
    expect(errorsOf(header(), [line({ unitPriceP: 0 })], ctx({ isDraft: true }))).toEqual([]);
  });

  it("a discount larger than the line amount is refused; equal to it is fine (2 bags × 1,000 = 2,000)", () => {
    const l = line({ quantity: 2, unitPriceP: 1_000 });
    expect(errorsOf(header(), [{ ...l, discountP: 2_001 }])).toEqual(["Line 1: the discount is larger than the line amount."]);
    expect(errorsOf(header(), [{ ...l, discountP: 2_000 }])).toEqual([]);
  });

  it("stock: 'Only X bags of P are available in W. Requested: Q.'", () => {
    const c = ctx({ stock: { [pairKey({ productId: P1, warehouseId: W1 })]: 5_000 } });
    expect(errorsOf(header(), [line({ quantity: 8 })], c)).toEqual(["Only 5 bags of Sella Rice 50kg are available in Main Godown. Requested: 8."]);
  });

  it("stock: fractional figures print as the legacy printed them (2.5, 3)", () => {
    const c = ctx({ stock: { [pairKey({ productId: P1, warehouseId: W1 })]: 2_500 } });
    expect(errorsOf(header(), [line({ quantity: 3 })], c)).toEqual(["Only 2.5 bags of Sella Rice 50kg are available in Main Godown. Requested: 3."]);
  });

  it("stock is checked in the LINE's godown, not the header's", () => {
    const c = ctx({ stock: { [pairKey({ productId: P1, warehouseId: W1 })]: 100_000, [pairKey({ productId: P1, warehouseId: W2 })]: 1_000 } });
    expect(errorsOf(header(), [line({ quantity: 4, warehouseId: W2 })], c)).toEqual(["Only 1 bags of Sella Rice 50kg are available in Shop Godown. Requested: 4."]);
  });

  it("stock: a draft, the 'allow negative stock' setting and a migrated invoice skip the check", () => {
    const c = { stock: { [pairKey({ productId: P1, warehouseId: W1 })]: 1_000 } };
    expect(errorsOf(header(), [line({ quantity: 5 })], ctx({ ...c, isDraft: true }))).toEqual([]);
    expect(errorsOf(header(), [line({ quantity: 5 })], ctx({ ...c, allowNegativeStock: true }))).toEqual([]);
    expect(errorsOf(header(), [line({ quantity: 5 })], ctx({ ...c, skipStock: true }))).toEqual([]);
  });

  it("STRICTER: two lines of one product in one godown are checked TOGETHER (the legacy checked line by line and let 6 + 6 leave 10)", () => {
    const c = ctx({ stock: { [pairKey({ productId: P1, warehouseId: W1 })]: 10_000 } });
    expect(errorsOf(header(), [line({ quantity: 6 }), line({ quantity: 6 })], c)).toEqual(["Only 10 bags of Sella Rice 50kg are available in Main Godown. Requested: 12."]);
    // ...but the same product in two DIFFERENT godowns is two checks
    const two = ctx({ stock: { [pairKey({ productId: P1, warehouseId: W1 })]: 10_000, [pairKey({ productId: P1, warehouseId: W2 })]: 10_000 } });
    expect(errorsOf(header(), [line({ quantity: 6 }), line({ quantity: 6, warehouseId: W2 })], two)).toEqual([]);
  });

  it("paid: 'The amount paid cannot be negative.' and the overpay message, verbatim", () => {
    expect(errorsOf(header({ paidP: -1 }), [line()])).toEqual(["The amount paid cannot be negative."]);
    expect(errorsOf(header({ paidP: 100_001 }), [line()])).toEqual(["The amount paid is more than the invoice total. Record the extra as a separate payment on account."]);
    expect(errorsOf(header({ paidP: 100_000 }), [line()])).toEqual([]); // exactly the total is fine
  });

  it("the overpay test uses the GRAND total (charges in, discounts out): 1,000 + 200 freight − 100 discount = 1,100", () => {
    const l = line({ unitPriceP: 100_000 });
    const h = header({ freightP: 20_000, invoiceDiscountP: 10_000 });
    expect(errorsOf({ ...h, paidP: 110_000 }, [l])).toEqual([]);
    expect(errorsOf({ ...h, paidP: 110_001 }, [l])).toHaveLength(1);
  });

  it("errors are COLLECTED in the legacy order, not first-fail", () => {
    expect(errorsOf(header({ customerId: "", warehouseId: "", paidP: -5 }), [])).toEqual([
      "Choose a shop to invoice.",
      "Choose the warehouse the bags leave from.",
      "Add at least one product line.",
      "The amount paid cannot be negative.",
    ]);
  });
});

describe("Validate.invoice — where S7 is STRICTER than the legacy", () => {
  it("negative line / invoice discount and negative charges are refused (the legacy passed them through)", () => {
    expect(errorsOf(header(), [line({ discountP: -1 })])).toContain("Line 1: the discount cannot be negative.");
    expect(errorsOf(header({ invoiceDiscountP: -1 }), [line()])).toEqual(["The invoice discount cannot be negative."]);
    expect(errorsOf(header({ freightP: -1 }), [line()])).toEqual(["The freight cannot be negative."]);
    expect(errorsOf(header({ loadingP: -1 }), [line()])).toEqual(["The loading charge cannot be negative."]);
    expect(errorsOf(header({ otherChargesP: -1 }), [line()])).toEqual(["The other charges cannot be negative."]);
    expect(errorsOf(header(), [line({ taxP: -1 })])).toContain("Line 1: the tax cannot be negative.");
  });

  it("a quantity with more than 3 decimals is refused (the legacy rounded it silently); 2.5 and 0.125 pass", () => {
    expect(errorsOf(header(), [line({ quantity: 0.3004 })])).toEqual(["Line 1 (Sella Rice 50kg): the quantity can have at most 3 decimal places."]);
    expect(errorsOf(header(), [line({ quantity: 2.5 })])).toEqual([]);
    expect(errorsOf(header(), [line({ quantity: 0.125 })])).toEqual([]);
    expect(hasAtMostThreeDecimals(0.1 + 0.2)).toBe(true); // 0.30000000000000004 is 0.3 to the thousandth
    expect(hasAtMostThreeDecimals(1.0005)).toBe(false);
  });

  it("absurd quantities and totals are refused rather than overflowing", () => {
    expect(errorsOf(header(), [line({ quantity: 2_000_000 })], ctx({ allowNegativeStock: true }))).toEqual(["Line 1 (Sella Rice 50kg): that quantity is too large."]);
    expect(errorsOf(header(), [line({ unitPriceP: 10_000_000_000_000, quantity: 900_000 })], ctx({ allowNegativeStock: true }))).toContain("Line 1: the line amount is too large.");
  });

  it("a line's own godown must exist", () => {
    expect(errorsOf(header(), [line({ warehouseId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })], ctx({ allowNegativeStock: true }))).toContain("Line 1: choose the warehouse this line leaves from.");
  });
});

describe("the totals come from the shared Calc port", () => {
  it("returns the legacy totals: 10 bags × 2,700 − 500 line discount − 1,000 invoice discount + 5% tax + charges", () => {
    const r = validateInvoice(
      header({ invoiceDiscountP: 100_000, freightP: 30_000, loadingP: 20_000, otherChargesP: 10_000 }),
      [line({ quantity: 10, unitPriceP: 270_000, discountP: 50_000, taxRatePct: 5 })],
      ctx(),
    );
    expect(r.errors).toEqual([]);
    expect(r.totals.grandTotalP).toBe(2_742_500); // 2,700,000 − 50,000 − 100,000 + 132,500 + 60,000
  });
});

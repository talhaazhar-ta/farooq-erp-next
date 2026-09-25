import { describe, expect, it } from "vitest";
import { editRefusals, netStockChange, type EditFacts, type NewLineFacts, type OldLineFacts } from "../src/purchases/rules.js";
import { validatePurchase, type PurchaseLineForValidation } from "../src/purchases/validate.js";

/** The pure halves of the purchase service: `validatePurchase` (legacy `Validate.purchase` + the owner's new rules) and `editRefusals` (legacy `Purchases.editErrors`). */

const WH = "wh-1";
const P = "p-1";
const ctx = { supplierExists: true, warehouseNames: new Map([[WH, "Main"]]), products: new Map([[P, { name: "Rice", nameEn: "Basmati", nameUr: null }]]) };
const header = { supplierId: "s", warehouseId: WH, invoiceDiscountP: 0, freightP: 0, loadingP: 0, otherChargesP: 0, paidP: 0 };
const line = (o: Partial<PurchaseLineForValidation> = {}): PurchaseLineForValidation => ({ productId: P, warehouseId: WH, quantity: 10, receivedQuantity: undefined, unitPriceP: 100_000, discountP: 0, taxP: 0, taxRatePct: 0, ...o });
const errs = (h = header, lines = [line()], c = ctx) => validatePurchase(h, lines, c).errors;

describe("validatePurchase — the legacy messages, verbatim, in the legacy order", () => {
  it("a valid purchase has no errors and the totals of Calc.invoice (10 x 1,000 - 100 discount + 50 freight = 9,950)", () => {
    const r = validatePurchase({ ...header, freightP: 5_000 }, [line({ discountP: 10_000 })], ctx);
    expect(r.errors).toEqual([]);
    expect(r.totals).toMatchObject({ subtotalP: 1_000_000, itemDiscountsP: 10_000, grandTotalP: 995_000 });
  });

  it("Choose a supplier. / Choose the destination warehouse. / Add at least one product line. — in that order", () => {
    expect(validatePurchase({ ...header, supplierId: "" }, [], { ...ctx, supplierExists: false }).errors).toEqual(["Choose a supplier.", "Add at least one product line."]);
    expect(errs({ ...header, warehouseId: "nope" })).toEqual(["Choose the destination warehouse."]);
    expect(errs({ ...header, supplierId: "ghost" }, [line()], { ...ctx, supplierExists: false })).toEqual(["Choose a supplier."]);
  });

  it("Line N: quantity must be more than zero. / Line N: invalid rate.", () => {
    expect(errs(header, [line(), line({ quantity: 0 })])).toEqual(["Line 2: quantity must be more than zero."]);
    expect(errs(header, [line({ quantity: -1 })])).toEqual(["Line 1: quantity must be more than zero."]);
    expect(errs(header, [line({ unitPriceP: -1 })])).toEqual(["Line 1: invalid rate."]);
    expect(errs(header, [line({ unitPriceP: 0 })])).toEqual([]); // a zero rate is allowed
  });

  it("all errors are collected, not first-fail", () => {
    const e = errs({ ...header, supplierId: "" }, [line({ quantity: 0, unitPriceP: -5 })], { ...ctx, supplierExists: false });
    expect(e).toEqual(["Choose a supplier.", "Line 1: quantity must be more than zero.", "Line 1: invalid rate."]);
  });

  it("NEW: a quantity with more than 3 decimals, a negative received, more than 3 received decimals", () => {
    expect(errs(header, [line({ quantity: 1.0005 })])).toEqual(["Line 1 (Basmati): the quantity can have at most 3 decimal places."]);
    expect(errs(header, [line({ quantity: 2.5 }), line({ quantity: 0.125 })])).toEqual([]);
    expect(errs(header, [line({ receivedQuantity: -1 })])).toEqual(["Line 1: the bags received cannot be negative."]);
    expect(errs(header, [line({ receivedQuantity: 1.0005 })])).toEqual(["Line 1 (Basmati): the bags received can have at most 3 decimal places."]);
    expect(errs(header, [line({ receivedQuantity: 0 })])).toEqual([]); // nothing arrived: an order
    expect(errs(header, [line({ receivedQuantity: 25 })])).toEqual([]); // not capped at the ordered bags
  });

  it("NEW (owner decision 3): a line discount above the line amount is refused, exactly the amount is fine", () => {
    expect(errs(header, [line({ discountP: 1_000_001 })])).toEqual(["Line 1: the discount is larger than the line amount."]);
    expect(errs(header, [line({ discountP: 1_000_000 })])).toEqual([]);
    expect(errs(header, [line({ discountP: -1 })])).toEqual(["Line 1: the discount cannot be negative."]);
  });

  it("NEW: negative overall discount / charges are refused", () => {
    expect(errs({ ...header, invoiceDiscountP: -1, freightP: -1, loadingP: -1, otherChargesP: -1 })).toEqual([
      "The discount cannot be negative.",
      "The freight cannot be negative.",
      "The loading charge cannot be negative.",
      "The other charges cannot be negative.",
    ]);
  });

  it("NEW (owner decision 3): the amount paid below 0 or above the total is refused on any purchase; exactly the total is fine", () => {
    expect(errs({ ...header, paidP: -1 })).toEqual(["The amount paid cannot be negative."]);
    expect(errs({ ...header, paidP: 1_000_001 })).toEqual(["The amount paid is more than the purchase total. Record the extra as a separate payment to the supplier."]);
    expect(errs({ ...header, paidP: 1_000_000 })).toEqual([]);
  });

  it("an unknown product and an unknown line godown are named by line", () => {
    expect(errs(header, [line({ productId: "ghost" })])).toEqual(["Line 1: that product no longer exists."]);
    expect(errs(header, [line({ warehouseId: "elsewhere" })])).toEqual(["Line 1: choose the warehouse this line goes to."]);
  });
});

/* ── editRefusals ──────────────────────────────────────────────────────── */

const old = (o: Partial<OldLineFacts> = {}): OldLineFacts => ({ id: "L1", productId: P, warehouseId: WH, descriptionSnapshot: "چاول", descriptionEnSnapshot: "Basmati", receivedQtyMilli: 100_000, returnedQtyMilli: 0, operationalShareP: null, ...o });
const next = (o: Partial<NewLineFacts> = {}): NewLineFacts => ({ id: "L1", productId: P, warehouseId: WH, receivedQtyMilli: 100_000, ...o });
const facts = (o: Partial<EditFacts> = {}): EditFacts => ({
  oldLines: [old()],
  newLines: [next()],
  supplierLockReason: null,
  paidNowP: 0,
  voucherNumbers: [],
  newPaidP: 0,
  allowNegativeStock: false,
  levelMilli: () => 100_000,
  productName: () => "Basmati",
  warehouseName: () => "Main",
  ...o,
});

describe("editRefusals — the legacy Purchases.editErrors, verbatim", () => {
  it("an untouched purchase has nothing to refuse", () => {
    expect(editRefusals(facts())).toEqual([]);
  });

  it("a line with returned bags: cannot be removed, cannot change product / warehouse, cannot show fewer than the returned received", () => {
    const o = [old({ returnedQtyMilli: 10_000 })];
    expect(editRefusals(facts({ oldLines: o, newLines: [] }))).toEqual(["Basmati: 10 bags have been returned to the supplier, so this line cannot be removed. It can be reduced, but not below the bags already returned."]);
    expect(editRefusals(facts({ oldLines: [old({ returnedQtyMilli: 1_000 })], newLines: [] }))).toEqual(["Basmati: 1 bag has been returned to the supplier, so this line cannot be removed. It can be reduced, but not below the bags already returned."]);
    expect(editRefusals(facts({ oldLines: o, newLines: [next({ productId: "p-2" })] }))).toEqual(["Basmati: 10 bags have been returned to the supplier, so its product and warehouse cannot be changed."]);
    expect(editRefusals(facts({ oldLines: o, newLines: [next({ warehouseId: "wh-2" })], levelMilli: () => 500_000 }))).toEqual(["Basmati: 10 bags have been returned to the supplier, so its product and warehouse cannot be changed."]);
    expect(editRefusals(facts({ oldLines: o, newLines: [next({ receivedQtyMilli: 8_000 })], levelMilli: () => 500_000 }))).toEqual(["Basmati: 10 bags were already returned to the supplier, so fewer than 10 cannot be shown as received."]);
    expect(editRefusals(facts({ oldLines: o, newLines: [next({ receivedQtyMilli: 10_000 })], levelMilli: () => 500_000 }))).toEqual([]); // exactly the returned bags is fine
  });

  it("a line with landed costs: cannot be removed (Cancel the landed-cost entry first.) nor re-producted; a 0 share (cancelled entry) is no lock", () => {
    const o = [old({ operationalShareP: 900_000 })];
    expect(editRefusals(facts({ oldLines: o, newLines: [] }))).toEqual(["Basmati: landed costs have been spread over it, so this line cannot be removed. Cancel the landed-cost entry first."]);
    expect(editRefusals(facts({ oldLines: o, newLines: [next({ productId: "p-2" })] }))).toEqual(["Basmati: landed costs have been spread over it, so its product and warehouse cannot be changed."]);
    expect(editRefusals(facts({ oldLines: [old({ operationalShareP: 0 })], newLines: [], levelMilli: () => 500_000 }))).toEqual([]);
    // returns win the wording when both apply (the legacy ternary)
    expect(editRefusals(facts({ oldLines: [old({ returnedQtyMilli: 5_000, operationalShareP: 1 })], newLines: [] }))[0]).toMatch(/5 bags have been returned/);
  });

  it("a description-less line is called 'a line'; the English snapshot wins over the Urdu one", () => {
    expect(editRefusals(facts({ oldLines: [old({ descriptionEnSnapshot: null, descriptionSnapshot: null, operationalShareP: 5 })], newLines: [] }))[0]).toMatch(/^a line: landed costs/);
    expect(editRefusals(facts({ oldLines: [old({ descriptionEnSnapshot: null, operationalShareP: 5 })], newLines: [] }))[0]).toMatch(/^چاول: landed costs/);
  });

  it("a supplier lock reason is passed straight through", () => {
    expect(editRefusals(facts({ supplierLockReason: "locked!" }))).toEqual(["locked!"]);
  });

  it("the amount paid cannot be lowered: says how much and which vouchers", () => {
    expect(editRefusals(facts({ paidNowP: 2_000_000, voucherNumbers: ["PV-2026-000001", "PV-2026-000002"], newPaidP: 500_000 }))).toEqual([
      "Rs 20,000.00 has already been paid against this purchase (PV-2026-000001, PV-2026-000002). The amount paid cannot be lowered here — reverse that payment voucher from Payments instead.",
    ]);
    expect(editRefusals(facts({ paidNowP: 2_000_000, voucherNumbers: ["PV-1"], newPaidP: 2_000_000 }))).toEqual([]);
  });

  it("the stock guard is judged on the NET change per product x godown: cutting 100 to 30 with 20 on the shelf takes 70 fewer than there is", () => {
    const e = editRefusals(facts({ newLines: [next({ receivedQtyMilli: 30_000 })], levelMilli: () => 20_000 }));
    expect(e).toEqual(["Only 20 bags of Basmati are in Main now, but this edit takes 70 fewer bags into stock than before. The rest of that delivery has already been sold or moved, so it cannot be reduced by that much."]);
    // 15 fewer fits in the 20; an unchanged quantity never fails even with 0 on the shelf; more bags never fail
    expect(editRefusals(facts({ newLines: [next({ receivedQtyMilli: 85_000 })], levelMilli: () => 20_000 }))).toEqual([]);
    expect(editRefusals(facts({ levelMilli: () => 0 }))).toEqual([]);
    expect(editRefusals(facts({ newLines: [next({ receivedQtyMilli: 150_000 })], levelMilli: () => 0 }))).toEqual([]);
    // with "allow negative stock" the same cut is allowed
    expect(editRefusals(facts({ newLines: [next({ receivedQtyMilli: 30_000 })], levelMilli: () => 20_000, allowNegativeStock: true }))).toEqual([]);
  });

  it("two lines of one product in one godown are netted together (a bag moved between lines is no change)", () => {
    const o = [old({ id: "L1", receivedQtyMilli: 60_000 }), old({ id: "L2", receivedQtyMilli: 40_000 })];
    const n = [next({ id: "L1", receivedQtyMilli: 100_000 }), next({ id: "L2", receivedQtyMilli: 0 })];
    expect(editRefusals(facts({ oldLines: o, newLines: n, levelMilli: () => 0 }))).toEqual([]);
  });

  it("a delivery moved to another godown is judged in the OLD godown (it must give the bags back) — and only there", () => {
    const e = editRefusals(facts({ newLines: [next({ warehouseId: "wh-2" })], levelMilli: (_p, w) => (w === WH ? 40_000 : 0), warehouseName: (w) => (w === WH ? "Main" : "Second") }));
    expect(e).toEqual(["Only 40 bags of Basmati are in Main now, but this edit takes 100 fewer bags into stock than before. The rest of that delivery has already been sold or moved, so it cannot be reduced by that much."]);
  });
});

describe("netStockChange", () => {
  it("new received minus old received per product x godown, zero changes included, in the fixed lock order", () => {
    const changes = netStockChange(
      [{ productId: "b", warehouseId: "w1", receivedQtyMilli: 5_000 }, { productId: "a", warehouseId: "w1", receivedQtyMilli: 3_000 }],
      [{ productId: "a", warehouseId: "w1", receivedQtyMilli: 3_000 }, { productId: "b", warehouseId: "w2", receivedQtyMilli: 5_000 }],
    );
    expect(changes).toEqual([
      { productId: "a", warehouseId: "w1", milli: 0 },
      { productId: "b", warehouseId: "w1", milli: -5_000 },
      { productId: "b", warehouseId: "w2", milli: 5_000 },
    ]);
  });
});

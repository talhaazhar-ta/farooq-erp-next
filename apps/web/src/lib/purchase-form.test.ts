import { describe, expect, it } from "vitest";
import { invoiceTotals, type PartyLookupItem } from "@farooq/shared";
import { PIDS, purchaseDetail } from "../test/purchase-fixtures";
import {
  bagTotals,
  blankPurchaseForm,
  isPurchaseDirty,
  lastRateText,
  lineLockOf,
  MORE_THAN_ORDERED_HINT,
  newPurchaseLine,
  NOTHING_ARRIVED_HINT,
  PAID_EDIT_HINT,
  PAID_NEW_HINT,
  paidBelowPaid,
  PART_DELIVERY_HINT,
  purchaseDetailToForm,
  purchaseFormReducer,
  purchaseFormToSavePayload,
  purchaseFormTotals,
  purchasePaidRules,
  receivedHint,
  receivedMilliOf,
  receivedState,
  saveLabel,
  type PurchaseForm,
  type PurchaseFormLine,
} from "./purchase-form";

const SUPPLIER: PartyLookupItem = { id: PIDS.supplier, name: "Zam Zam Mills", contact: null, phone: null, region: null, regionId: null, active: true };
const WH1 = PIDS.warehouse;
const WH2 = PIDS.warehouse2;

const line = (patch: Partial<PurchaseFormLine> = {}): PurchaseFormLine => ({ ...newPurchaseLine({ id: PIDS.product, unit: "Bag" }, WH1, "1000"), quantity: "10", ...patch });
const formWith = (lines: PurchaseFormLine[], patch: Partial<PurchaseForm> = {}): PurchaseForm => ({ ...blankPurchaseForm(WH1, "2026-09-26"), supplier: SUPPLIER, lines, ...patch });
const ok = (f: PurchaseForm, ctx: { revision?: number } = {}) => {
  const r = purchaseFormToSavePayload(f, { idempotencyKey: "key-12345678", ...ctx });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.payload;
};

describe("a new purchase form", () => {
  it("starts with no supplier chosen, no lines, cash and today's business date", () => {
    const f = blankPurchaseForm(WH1, "2026-09-26");
    expect(f.supplier).toBeNull();
    expect(f.lines).toEqual([]);
    expect(f).toMatchObject({ warehouseId: WH1, date: "2026-09-26", paymentMethod: "Cash", paidAmount: "" });
  });

  it("a request without a supplier carries an empty id, so the SERVER refuses it in its own words", () => {
    const p = ok(formWith([line()], { supplier: null }));
    expect(p.supplierId).toBe("");
  });
});

describe("Received: blank means the whole line, 0 means the bill only", () => {
  it.each([
    ["", "10", "all"],
    ["  ", "10", "all"],
    ["10", "10", "all"],
    ["6", "10", "part"],
    ["0", "10", "none"],
    ["0.0", "10", "none"],
    ["12", "10", "more"],
    ["abc", "10", "invalid"],
    ["1.2345", "10", "invalid"],
  ] as const)("Received %j of %s ordered is %s", (received, quantity, state) => {
    expect(receivedState({ quantity, received })).toBe(state);
  });

  it("the bags that go into stock: blank = the ordered bags, 0 = none, a figure = that figure", () => {
    expect(receivedMilliOf({ quantity: "10", received: "" })).toBe(10_000);
    expect(receivedMilliOf({ quantity: "10", received: "0" })).toBe(0);
    expect(receivedMilliOf({ quantity: "10", received: "2.5" })).toBe(2_500);
    expect(receivedMilliOf({ quantity: "", received: "" })).toBe(0);
  });

  it("a request sends receivedQuantity ONLY when the box was filled in — never a guess for a blank", () => {
    const p = ok(formWith([line({ received: "" }), line({ received: "6" }), line({ received: "0" }), line({ received: "12.5" })]));
    expect(p.lines[0]).not.toHaveProperty("receivedQuantity");
    expect(p.lines[1]).toMatchObject({ quantity: 10, receivedQuantity: 6 });
    expect(p.lines[2]).toMatchObject({ receivedQuantity: 0 }); // an order: nothing arrived
    expect(p.lines[3]).toMatchObject({ receivedQuantity: 12.5 }); // more than ordered is allowed
  });

  it("at most 3 decimals, on Ordered and on Received; the message names the line and nothing is sent", () => {
    const a = purchaseFormToSavePayload(formWith([line({ quantity: "2.5555" })]), { idempotencyKey: "k-12345678" });
    expect(a).toMatchObject({ ok: false });
    expect(!a.ok && a.errors[0]).toMatch(/^Line 1: Enter the number of bags — at most 3 decimal places/);
    const b = purchaseFormToSavePayload(formWith([line(), line({ received: "1.2345" })]), { idempotencyKey: "k-12345678" });
    expect(!b.ok && b.errors[0]).toMatch(/^Line 2, received bags: Enter the number of bags — at most 3 decimal places/);
    expect(ok(formWith([line({ quantity: "2.505", received: "0.001" })])).lines[0]).toMatchObject({ quantity: 2.505, receivedQuantity: 0.001 });
  });

  it("the hint for 0 says it books the bill and no stock, and warns about counting the delivery twice (the warehouse-app trap)", () => {
    expect(receivedHint("none")).toBe(NOTHING_ARRIVED_HINT);
    expect(NOTHING_ARRIVED_HINT).toMatch(/puts no bags into stock/);
    expect(NOTHING_ARRIVED_HINT).toMatch(/counted twice/);
    expect(receivedHint("part")).toBe(PART_DELIVERY_HINT);
    expect(receivedHint("more")).toBe(MORE_THAN_ORDERED_HINT);
    expect(receivedHint("all")).toBeNull();
    expect(receivedHint("invalid")).toBeNull();
  });

  it("the bag totals count ordered and received apart", () => {
    const f = formWith([line({ quantity: "10", received: "" }), line({ quantity: "20", received: "5" }), line({ quantity: "4", received: "0" })]);
    expect(bagTotals(f)).toEqual({ orderedMilli: 34_000, receivedMilli: 15_000 });
  });

  it("the main button says 'Save & Receive Stock' unless nothing at all arrives (then it is an order, no stock); an edit says 'Save changes'", () => {
    expect(saveLabel(formWith([line()]), false)).toBe("Save & Receive Stock");
    expect(saveLabel(formWith([line({ received: "0" }), line({ received: "0" })]), false)).toBe("Save order (no stock)");
    expect(saveLabel(formWith([line({ received: "0" }), line({ received: "3" })]), false)).toBe("Save & Receive Stock");
    expect(saveLabel(formWith([]), false)).toBe("Save & Receive Stock");
    expect(saveLabel(formWith([line()]), true)).toBe("Save changes");
  });
});

describe("the totals are the shared invoiceTotals over the ORDERED bags", () => {
  it("10 ordered, 6 received: the bill is for 10", () => {
    const f = formWith([line({ quantity: "10", received: "6", rate: "1000", discount: "100" })], { freight: "500", invoiceDiscount: "50", paidAmount: "3000" });
    const t = purchaseFormTotals(f);
    const expected = invoiceTotals({ lines: [{ qtyMilli: 10_000, unitPriceP: 100_000, discountP: 10_000, taxP: 0 }], invoiceDiscountP: 5_000, freightP: 50_000, loadingP: 0, otherChargesP: 0, paidP: 300_000 });
    expect(t).toEqual(expected);
    expect(t.subtotalP).toBe(1_000_000);
    expect(t.grandTotalP).toBe(1_000_000 - 10_000 - 5_000 + 50_000);
    expect(t.balanceP).toBe(t.grandTotalP - 300_000);
  });

  it("what cannot be read yet counts as 0 (the request refuses it by name when saved)", () => {
    expect(purchaseFormTotals(formWith([line({ quantity: "x", rate: "1000" })])).grandTotalP).toBe(0);
    expect(purchaseFormTotals(formWith([line({ rate: "12.345" })])).grandTotalP).toBe(0);
  });

  it("a fixed tax carried from a saved line is added", () => {
    expect(purchaseFormTotals(formWith([line({ quantity: "1", rate: "100", taxP: 1_500 })])).grandTotalP).toBe(10_000 + 1_500);
  });
});

describe("the form reducer", () => {
  it("the header warehouse rewrites every line's warehouse; a line's own warehouse changes only that line", () => {
    const a = line({ key: "a" });
    const b = line({ key: "b" });
    let f = formWith([a, b]);
    f = purchaseFormReducer(f, { type: "line", key: "a", patch: { warehouseId: WH2 } });
    expect(f.lines.map((l) => l.warehouseId)).toEqual([WH2, WH1]);
    f = purchaseFormReducer(f, { type: "headerWarehouse", warehouseId: WH2 });
    expect(f.warehouseId).toBe(WH2);
    expect(f.lines.map((l) => l.warehouseId)).toEqual([WH2, WH2]);
  });

  it("a line the server has tied to its product and godown is not moved, re-warehoused or removed", () => {
    const tied = line({ key: "t", lock: "3 bags have been returned to the supplier, so …" });
    const free = line({ key: "f" });
    let f = formWith([tied, free]);
    f = purchaseFormReducer(f, { type: "headerWarehouse", warehouseId: WH2 });
    expect(f.lines.map((l) => l.warehouseId)).toEqual([WH1, WH2]);
    f = purchaseFormReducer(f, { type: "line", key: "t", patch: { warehouseId: WH2, quantity: "7" } });
    expect(f.lines[0]).toMatchObject({ warehouseId: WH1, quantity: "7" }); // its quantity may change, its godown may not
    f = purchaseFormReducer(f, { type: "remove", key: "t" });
    expect(f.lines).toHaveLength(2);
    f = purchaseFormReducer(f, { type: "remove", key: "f" });
    expect(f.lines.map((l) => l.key)).toEqual(["t"]);
  });

  it("lines move up and down and stop at the ends", () => {
    let f = formWith([line({ key: "a" }), line({ key: "b" }), line({ key: "c" })]);
    f = purchaseFormReducer(f, { type: "move", key: "c", direction: -1 });
    expect(f.lines.map((l) => l.key)).toEqual(["a", "c", "b"]);
    expect(purchaseFormReducer(f, { type: "move", key: "a", direction: -1 })).toBe(f);
  });
});

describe("a saved purchase becomes a form and goes back as the same request", () => {
  it("keeps every id, quantity, rate and charge; a line that arrived whole has Received blank, a part delivery its figure, an order 0", () => {
    const base = purchaseDetail();
    const l = base.lines[0]!;
    const pu = purchaseDetail({
      lines: [
        { ...l, id: PIDS.line, receivedQuantity: 10, receivedQtyMilli: 10_000 },
        { ...l, id: PIDS.line2, productId: PIDS.product2, receivedQuantity: 6, receivedQtyMilli: 6_000 },
        { ...l, id: "99999999-1111-4111-8111-999999999993", receivedQuantity: 0, receivedQtyMilli: 0 },
      ],
      invoiceDiscountP: 20_000,
      loadingP: 12_500,
      notes: "gate 2",
      description: "March flour",
    });
    const f = purchaseDetailToForm(pu);
    expect(f.lines.map((x) => x.received)).toEqual(["", "6", "0"]);
    expect(f.lines.map((x) => x.id)).toEqual([PIDS.line, PIDS.line2, "99999999-1111-4111-8111-999999999993"]);
    expect(f).toMatchObject({ supplierInvoiceNo: "SB-5", vehicleNo: "103", driver: "Aslam", deliveryRef: "", freight: "500", loading: "125", invoiceDiscount: "200", otherCharges: "", notes: "gate 2", description: "March flour", date: "2026-09-20", warehouseId: WH1 });
    expect(f.supplier).toMatchObject({ id: PIDS.supplier, name: "Zam Zam Mills" }); // the supplier's name NOW
  });

  it("the amount paid starts at what has been paid; the request carries the revision, the line id and everything else, unchanged", () => {
    const pu = purchaseDetail();
    const f = purchaseDetailToForm(pu);
    expect(f.paidAmount).toBe("3000");
    const p = ok(f, { revision: pu.revision });
    expect(p).toEqual({
      supplierId: PIDS.supplier,
      warehouseId: WH1,
      date: "2026-09-20",
      supplierInvoiceNo: "SB-5",
      vehicleNo: "103",
      driver: "Aslam",
      lines: [{ id: PIDS.line, productId: PIDS.product, quantity: 10, receivedQuantity: 6, unitPriceP: 100_000, discountP: 0, warehouseId: WH1, unit: "Bag" }],
      invoiceDiscountP: 0,
      freightP: 50_000,
      loadingP: 0,
      otherChargesP: 0,
      paidAmountP: 300_000,
      paymentMethod: "Cash",
      description: "",
      revision: 3,
      idempotencyKey: "key-12345678",
    });
  });

  it("a request for a NEW purchase has no revision and no line ids", () => {
    const p = ok(formWith([line()]));
    expect(p).not.toHaveProperty("revision");
    expect(p.lines[0]).not.toHaveProperty("id");
  });

  it("the description is always sent (an edit KEEPS an omitted one, so clearing the box has to say so)", () => {
    const f = purchaseDetailToForm(purchaseDetail({ description: "old" }));
    expect(ok({ ...f, description: "" }, { revision: 3 }).description).toBe("");
    expect(ok({ ...f, description: "  new  " }, { revision: 3 }).description).toBe("new");
  });

  it("a saved fixed tax is carried on the line", () => {
    const pu = purchaseDetail();
    const f = purchaseDetailToForm({ ...pu, lines: [{ ...pu.lines[0]!, taxP: 2_500 }] });
    expect(f.lines[0]!.taxP).toBe(2_500);
    expect(ok(f, { revision: 3 }).lines[0]).toMatchObject({ taxP: 2_500 });
  });
});

describe("lines the server ties to their product and godown", () => {
  it("bags returned to the supplier: the server's own sentence (rules.ts), singular and plural", () => {
    expect(lineLockOf({ returnedQuantity: 1, operationalShareP: null })).toBe(
      "1 bag has been returned to the supplier, so this line cannot be removed and its product and warehouse cannot be changed. It can be reduced, but not below the bags already returned.",
    );
    expect(lineLockOf({ returnedQuantity: 2.5, operationalShareP: null })).toMatch(/^2\.5 bags have been returned to the supplier, so this line cannot be removed/);
  });

  it("landed costs spread over the line, and no lock otherwise (the share is only readable with PROFIT_VIEW: absent = no lock shown, the server's refusal is the fallback)", () => {
    expect(lineLockOf({ returnedQuantity: 0, operationalShareP: 250_000 })).toMatch(/^Landed costs have been spread over this line, so it cannot be removed.*Cancel the landed-cost entry first\.$/);
    expect(lineLockOf({ returnedQuantity: 0, operationalShareP: 0 })).toBe("");
    expect(lineLockOf({ returnedQuantity: 0, operationalShareP: null })).toBe("");
    expect(lineLockOf({ returnedQuantity: 0 })).toBe("");
  });

  it("detailToForm marks the line and remembers the bags returned", () => {
    const pu = purchaseDetail();
    const f = purchaseDetailToForm({ ...pu, lines: [{ ...pu.lines[0]!, returnedQuantity: 2 }] });
    expect(f.lines[0]!.returnedMilli).toBe(2_000);
    expect(f.lines[0]!.lock).toMatch(/^2 bags have been returned/);
  });
});

describe("the Amount Paid box", () => {
  it("without permission to pay a supplier it is disabled, with the reason", () => {
    const r = purchasePaidRules({ canPayOut: false, editing: false });
    expect(r.disabled).toBe(true);
    expect(r.hint).toMatch(/do not have permission to pay a supplier/);
    expect(purchasePaidRules({ canPayOut: false, editing: true }).disabled).toBe(true);
  });

  it("on an edit it carries the legacy hint verbatim; a new purchase has its own", () => {
    expect(purchasePaidRules({ canPayOut: true, editing: true })).toEqual({ disabled: false, hint: PAID_EDIT_HINT });
    expect(PAID_EDIT_HINT).toBe(
      "What has been paid with this purchase so far. Raising it records another payment voucher for the difference; to lower it, reverse the voucher from Payments.",
    );
    expect(purchasePaidRules({ canPayOut: true, editing: false })).toEqual({ disabled: false, hint: PAID_NEW_HINT });
  });

  it("a figure below what has been paid is recognised (the server refuses it; the screen says so before the click)", () => {
    expect(paidBelowPaid({ paidAmount: "2000" }, 300_000)).toBe(true);
    expect(paidBelowPaid({ paidAmount: "" }, 300_000)).toBe(true);
    expect(paidBelowPaid({ paidAmount: "3000" }, 300_000)).toBe(false);
    expect(paidBelowPaid({ paidAmount: "3500" }, 300_000)).toBe(false);
    expect(paidBelowPaid({ paidAmount: "abc" }, 300_000)).toBe(false); // unreadable text is named by the request, not judged here
    expect(paidBelowPaid({ paidAmount: "" }, 0)).toBe(false);
  });

  it("money is read as rupees with at most two decimals, never through floating point", () => {
    expect(ok(formWith([line()], { paidAmount: "1,234.50", freight: "0.10" }))).toMatchObject({ paidAmountP: 123_450, freightP: 10 });
    const bad = purchaseFormToSavePayload(formWith([line()], { paidAmount: "1.999" }), { idempotencyKey: "k-12345678" });
    expect(!bad.ok && bad.errors[0]).toMatch(/^The amount paid:/);
  });
});

describe("has anything changed?", () => {
  it("dirty means different from the snapshot: a character typed and deleted again is not a change", () => {
    const snap = purchaseDetailToForm(purchaseDetail());
    expect(isPurchaseDirty(snap, snap)).toBe(false);
    const typed = purchaseFormReducer(snap, { type: "field", field: "notes", value: "x" });
    expect(isPurchaseDirty(typed, snap)).toBe(true);
    expect(isPurchaseDirty(purchaseFormReducer(typed, { type: "field", field: "notes", value: "" }), snap)).toBe(false);
  });

  it("choosing another supplier, another Received figure or removing a line each count", () => {
    const snap = formWith([line({ key: "a" }), line({ key: "b" })]);
    expect(isPurchaseDirty(purchaseFormReducer(snap, { type: "supplier", supplier: { ...SUPPLIER, id: PIDS.otherSupplier } }), snap)).toBe(true);
    expect(isPurchaseDirty(purchaseFormReducer(snap, { type: "line", key: "a", patch: { received: "0" } }), snap)).toBe(true);
    expect(isPurchaseDirty(purchaseFormReducer(snap, { type: "remove", key: "b" }), snap)).toBe(true);
  });
});

describe("the last rate bought at", () => {
  it("names the rate, the day and the purchase", () => {
    expect(lastRateText({ unitPriceP: 120_000, date: "2026-09-20", purchaseNumber: "PUR-2026-000007" }, (p) => `PKR ${p / 100}`)).toBe("Last bought at PKR 1200/bag on 20 Sep 2026 (PUR-2026-000007).");
    expect(lastRateText({ unitPriceP: 120_000, date: "2026-09-20", purchaseNumber: null }, (p) => `PKR ${p / 100}`)).toBe("Last bought at PKR 1200/bag on 20 Sep 2026.");
  });
});

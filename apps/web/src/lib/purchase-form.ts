import {
  businessDateOf,
  invoiceTotals,
  milliToQty,
  qtyToMilli,
  rupeesText,
  type InvoiceTotals,
  type PartyLookupItem,
  type PurchaseDetail,
  type PurchaseLine,
  type PurchaseRate,
  type SavePurchaseInput,
} from "@farooq/shared";
import { fmtDate } from "./format";
import { parseAmount, parseQuantity } from "./invoice-form";

/**
 * The purchase builder's form (S15): what a person typed (text, exactly as typed), the reducer that changes it, and the ONE pair
 * of functions that turn a saved purchase into a form and a form into the request the API takes (`detailToForm`,
 * `formToSavePayload`). A new purchase and an edit both go through them.
 *
 * Money is typed as rupees and converted to paisa only when a request is built (`parseRupees`, strict, at most two decimals);
 * a quantity is bags with at most three decimals read as text into thousandths. Totals are the shared `invoiceTotals` over the
 * ORDERED bags — the bill is for what was ordered; only the RECEIVED bags go into stock (S11 / S12).
 */

export interface PurchaseFormLine {
  /** A local React key — never sent. */
  key: string;
  /** The id of an existing line (editing) — kept so the line keeps its identity; absent for a line added here. */
  id?: string;
  productId: string;
  /** Bags ORDERED, as typed. */
  quantity: string;
  /** Bags that ARRIVED, as typed. Blank = the whole line arrived (the legacy blank); "0" = an order, nothing arrived. */
  received: string;
  /** Rupees per bag, as typed. */
  rate: string;
  /** A flat discount in rupees, as typed. */
  discount: string;
  warehouseId: string;
  /** A fixed tax (paisa) carried from a saved line — the screen has no tax entry (the legacy builder had none either). */
  taxP: number;
  unit: string;
  batchNo: string;
  notes: string;
  /** Editing: bags already sent back to the supplier (thousandths). */
  returnedMilli: number;
  /** Editing: why this line cannot be removed or given another product / warehouse — the server's own reason, or "". */
  lock: string;
}

export interface PurchaseForm {
  /** The supplier. `null` until a person chooses one — never pre-selected. */
  supplier: PartyLookupItem | null;
  warehouseId: string;
  date: string;
  supplierInvoiceNo: string;
  vehicleNo: string;
  driver: string;
  deliveryRef: string;
  lines: PurchaseFormLine[];
  invoiceDiscount: string;
  freight: string;
  loading: string;
  otherCharges: string;
  paidAmount: string;
  paymentMethod: string;
  description: string;
  notes: string;
}

/** The text fields a plain `field` action may set. */
export type PurchaseFormField = Exclude<keyof PurchaseForm, "supplier" | "lines">;

let lineCounter = 0;
export const newPurchaseLineKey = (): string => `pline-${++lineCounter}`;

export function blankPurchaseForm(warehouseId: string, today: string = businessDateOf(new Date())): PurchaseForm {
  return {
    supplier: null,
    warehouseId,
    date: today,
    supplierInvoiceNo: "",
    vehicleNo: "",
    driver: "",
    deliveryRef: "",
    lines: [],
    invoiceDiscount: "",
    freight: "",
    loading: "",
    otherCharges: "",
    paidAmount: "",
    paymentMethod: "Cash",
    description: "",
    notes: "",
  };
}

/** A line as it starts when a product is added: nothing typed but the rate hint, in the header's godown. */
export function newPurchaseLine(p: { id: string; unit: string | null }, warehouseId: string, rate = ""): PurchaseFormLine {
  return { key: newPurchaseLineKey(), productId: p.id, quantity: "", received: "", rate, discount: "", warehouseId, taxP: 0, unit: p.unit ?? "", batchNo: "", notes: "", returnedMilli: 0, lock: "" };
}

/* ── the reducer ───────────────────────────────────────────────────────────────────────────────── */

export type PurchaseFormAction =
  | { type: "field"; field: PurchaseFormField; value: string }
  | { type: "supplier"; supplier: PartyLookupItem | null }
  /** The header warehouse rewrites every line's warehouse (legacy) — except a line the server has tied to its godown. */
  | { type: "headerWarehouse"; warehouseId: string }
  | { type: "addLine"; line: PurchaseFormLine }
  | { type: "line"; key: string; patch: Partial<Pick<PurchaseFormLine, "quantity" | "received" | "rate" | "discount" | "warehouseId">> }
  | { type: "move"; key: string; direction: -1 | 1 }
  | { type: "remove"; key: string }
  | { type: "reset"; form: PurchaseForm };

export function purchaseFormReducer(form: PurchaseForm, action: PurchaseFormAction): PurchaseForm {
  switch (action.type) {
    case "field":
      return { ...form, [action.field]: action.value };
    case "supplier":
      return { ...form, supplier: action.supplier };
    case "headerWarehouse":
      return { ...form, warehouseId: action.warehouseId, lines: form.lines.map((l) => (l.lock ? l : { ...l, warehouseId: action.warehouseId })) };
    case "addLine":
      return { ...form, lines: [...form.lines, action.line] };
    case "line":
      return {
        ...form,
        lines: form.lines.map((l) => {
          if (l.key !== action.key) return l;
          const { warehouseId, ...rest } = action.patch;
          return { ...l, ...rest, ...(warehouseId !== undefined && !l.lock ? { warehouseId } : {}) };
        }),
      };
    case "move": {
      const i = form.lines.findIndex((l) => l.key === action.key);
      const j = i + action.direction;
      if (i < 0 || j < 0 || j >= form.lines.length) return form;
      const lines = [...form.lines];
      [lines[i], lines[j]] = [lines[j]!, lines[i]!];
      return { ...form, lines };
    }
    case "remove":
      return { ...form, lines: form.lines.filter((l) => l.key !== action.key || l.lock !== "") };
    case "reset":
      return action.form;
  }
}

/* ── bags: ordered and received ────────────────────────────────────────────────────────────────── */

/** What a line's Received box means: blank = the whole line, 0 = nothing arrived, less = a part delivery, more = more than was ordered. */
export type ReceivedState = "all" | "none" | "part" | "more" | "invalid";

export function receivedState(line: Pick<PurchaseFormLine, "quantity" | "received">): ReceivedState {
  if (line.received.trim() === "") return "all";
  const got = parseQuantity(line.received);
  if (!got.ok) return "invalid";
  const ordered = parseQuantity(line.quantity);
  const orderedMilli = ordered.ok ? ordered.qtyMilli : 0;
  if (got.qtyMilli === 0) return "none";
  if (got.qtyMilli < orderedMilli) return "part";
  if (got.qtyMilli > orderedMilli) return "more";
  return "all";
}

/** The bags that will go into stock from one line, thousandths (blank = the ordered bags; unreadable counts as 0). */
export function receivedMilliOf(line: Pick<PurchaseFormLine, "quantity" | "received">): number {
  const ordered = parseQuantity(line.quantity);
  if (line.received.trim() === "") return ordered.ok ? ordered.qtyMilli : 0;
  const got = parseQuantity(line.received);
  return got.ok ? got.qtyMilli : 0;
}

export const NOTHING_ARRIVED_HINT =
  "Nothing has arrived: this books the bill on the supplier’s account but puts no bags into stock. If the warehouse also records this delivery, do not enter the bags here as well — they would be counted twice.";
export const PART_DELIVERY_HINT = "Part delivery: only these bags go into stock; the rest stays open on the order.";
export const MORE_THAN_ORDERED_HINT = "More bags arrived than were ordered: stock takes all of them, the bill stays for the ordered bags.";
export const RECEIVED_BANNER = "Leave Received blank if the whole line arrived. Enter a smaller figure for a part delivery — only those bags go into stock and the rest stays open.";

export function receivedHint(state: ReceivedState): string | null {
  return state === "none" ? NOTHING_ARRIVED_HINT : state === "part" ? PART_DELIVERY_HINT : state === "more" ? MORE_THAN_ORDERED_HINT : null;
}

export interface BagTotals {
  orderedMilli: number;
  receivedMilli: number;
}

export function bagTotals(form: Pick<PurchaseForm, "lines">): BagTotals {
  let orderedMilli = 0;
  let receivedMilli = 0;
  for (const l of form.lines) {
    const q = parseQuantity(l.quantity);
    orderedMilli += q.ok ? q.qtyMilli : 0;
    receivedMilli += receivedMilliOf(l);
  }
  return { orderedMilli, receivedMilli };
}

/* ── live totals ───────────────────────────────────────────────────────────────────────────────── */

const paisaOr0 = (text: string): number => {
  const r = parseAmount(text);
  return r.ok ? r.paisa : 0;
};

/** The totals as they stand now: what cannot be read yet counts as 0 (the request refuses it by name when saved). Always the shared `invoiceTotals`, over the ORDERED bags. */
export function purchaseFormTotals(form: PurchaseForm): InvoiceTotals {
  return invoiceTotals({
    lines: form.lines.map((l) => {
      const q = parseQuantity(l.quantity);
      return { qtyMilli: q.ok ? q.qtyMilli : 0, unitPriceP: paisaOr0(l.rate), discountP: paisaOr0(l.discount), taxP: l.taxP };
    }),
    invoiceDiscountP: paisaOr0(form.invoiceDiscount),
    freightP: paisaOr0(form.freight),
    loadingP: paisaOr0(form.loading),
    otherChargesP: paisaOr0(form.otherCharges),
    paidP: paisaOr0(form.paidAmount),
  });
}

/** The label of the main button: a bill with nothing received is an order, not "receive stock". */
export function saveLabel(form: Pick<PurchaseForm, "lines">, editing: boolean): string {
  if (editing) return "Save changes";
  const { orderedMilli, receivedMilli } = bagTotals(form);
  return form.lines.length > 0 && orderedMilli > 0 && receivedMilli === 0 ? "Save order (no stock)" : "Save & Receive Stock";
}

/* ── saved purchase ⇄ form ⇄ request ───────────────────────────────────────────────────────────── */

const textOrEmpty = (v: string | null | undefined): string => v ?? "";
const rupeesOrEmpty = (paisa: number): string => (paisa ? rupeesText(paisa) : "");

const bagsWord = (milli: number): string => `${milliToQty(milli)} bag${milli === 1000 ? "" : "s"}`;

/** Why a saved line is tied to its product and godown, in the server's own words (`rules.ts` `editRefusals`), or "". */
export function lineLockOf(l: Pick<PurchaseLine, "returnedQuantity" | "operationalShareP">): string {
  const returned = qtyToMilli(l.returnedQuantity);
  if (returned > 0) {
    return `${bagsWord(returned)} ${returned === 1000 ? "has" : "have"} been returned to the supplier, so this line cannot be removed and its product and warehouse cannot be changed. It can be reduced, but not below the bags already returned.`;
  }
  if ((l.operationalShareP ?? 0) !== 0) {
    return "Landed costs have been spread over this line, so it cannot be removed and its product and warehouse cannot be changed. Cancel the landed-cost entry first.";
  }
  return "";
}

/** The supplier as the picker holds it, from what a purchase printed about it. */
export function supplierOf(pu: Pick<PurchaseDetail, "supplierId" | "supplierName" | "supplierCurrentName">): PartyLookupItem | null {
  if (!pu.supplierId) return null;
  return { id: pu.supplierId, name: pu.supplierCurrentName ?? pu.supplierName ?? "", contact: null, phone: null, region: null, regionId: null, active: true };
}

/** A saved purchase → the form that edits it. Every line id, quantity, rate, discount, tax and charge is kept; Received stays blank for a line that arrived whole. */
export function purchaseDetailToForm(pu: PurchaseDetail, fallbackWarehouseId = ""): PurchaseForm {
  return {
    supplier: supplierOf(pu),
    warehouseId: pu.warehouseId ?? pu.lines[0]?.warehouseId ?? fallbackWarehouseId,
    date: pu.date,
    supplierInvoiceNo: textOrEmpty(pu.supplierInvoiceNo),
    vehicleNo: textOrEmpty(pu.vehicleNo),
    driver: textOrEmpty(pu.driver),
    deliveryRef: textOrEmpty(pu.deliveryRef),
    lines: pu.lines.map((l) => ({
      key: newPurchaseLineKey(),
      id: l.id,
      productId: l.productId,
      quantity: String(l.quantity),
      received: l.receivedQtyMilli === l.qtyMilli ? "" : String(l.receivedQuantity),
      rate: rupeesText(l.unitPriceP),
      discount: rupeesOrEmpty(l.discountP),
      warehouseId: l.warehouseId,
      taxP: l.taxP,
      unit: l.unit,
      batchNo: textOrEmpty(l.batchNo),
      notes: textOrEmpty(l.notes),
      returnedMilli: qtyToMilli(l.returnedQuantity),
      lock: lineLockOf(l),
    })),
    invoiceDiscount: rupeesOrEmpty(pu.invoiceDiscountP),
    freight: rupeesOrEmpty(pu.freightP),
    loading: rupeesOrEmpty(pu.loadingP),
    otherCharges: rupeesOrEmpty(pu.otherChargesP),
    // starts at what has been paid with the purchase; it can be raised, never lowered
    paidAmount: rupeesOrEmpty(pu.paidP),
    paymentMethod: "Cash",
    description: textOrEmpty(pu.description),
    notes: textOrEmpty(pu.notes),
  };
}

export interface PurchaseSaveContext {
  idempotencyKey: string;
  /** Editing: the revision of the purchase as loaded. */
  revision?: number;
}

export type PurchasePayloadResult = { ok: true; payload: SavePurchaseInput } | { ok: false; errors: string[] };

/**
 * The form → the request (the WHOLE form, every time; an edit is a full PUT). Refuses only what cannot be turned into a number
 * at all (naming the line); whether a supplier is chosen, a quantity is enough or a rate is missing is the server's to say — and
 * its words are shown as they come. `receivedQuantity` is sent only when the Received box was filled in (blank = the whole line).
 */
export function purchaseFormToSavePayload(form: PurchaseForm, ctx: PurchaseSaveContext): PurchasePayloadResult {
  const errors: string[] = [];
  const amount = (label: string, text: string, prefix = ""): number => {
    const r = parseAmount(text);
    if (r.ok) return r.paisa;
    errors.push(`${prefix}${label}: ${r.message}`);
    return 0;
  };

  const lines = form.lines.map((l, i) => {
    const n = `Line ${i + 1}`;
    const q = parseQuantity(l.quantity);
    if (!q.ok) errors.push(`${n}: ${q.message}`);
    let receivedQuantity: number | undefined;
    if (l.received.trim() !== "") {
      const r = parseQuantity(l.received);
      if (r.ok) receivedQuantity = r.quantity;
      else errors.push(`${n}, received bags: ${r.message}`);
    }
    const unitPriceP = amount("the rate", l.rate, `${n}, `);
    const discountP = amount("the discount", l.discount, `${n}, `);
    return {
      ...(l.id ? { id: l.id } : {}),
      productId: l.productId,
      quantity: q.ok ? q.quantity : 0,
      ...(receivedQuantity !== undefined ? { receivedQuantity } : {}),
      unitPriceP,
      discountP,
      ...(l.taxP > 0 ? { taxP: l.taxP } : {}),
      warehouseId: l.warehouseId,
      ...(l.unit ? { unit: l.unit } : {}),
      ...(l.batchNo.trim() ? { batchNo: l.batchNo.trim() } : {}),
      ...(l.notes.trim() ? { notes: l.notes.trim() } : {}),
    };
  });

  const invoiceDiscountP = amount("The overall discount", form.invoiceDiscount);
  const freightP = amount("The freight", form.freight);
  const loadingP = amount("The loading charge", form.loading);
  const otherChargesP = amount("The other charges", form.otherCharges);
  const paidAmountP = amount("The amount paid", form.paidAmount);
  if (errors.length) return { ok: false, errors };

  const payload: SavePurchaseInput = {
    // an empty id is not a uuid: the server says "Choose a supplier." in its own words
    supplierId: form.supplier?.id ?? "",
    warehouseId: form.warehouseId,
    date: form.date,
    ...(form.supplierInvoiceNo.trim() ? { supplierInvoiceNo: form.supplierInvoiceNo.trim() } : {}),
    ...(form.vehicleNo.trim() ? { vehicleNo: form.vehicleNo.trim() } : {}),
    ...(form.driver.trim() ? { driver: form.driver.trim() } : {}),
    ...(form.deliveryRef.trim() ? { deliveryRef: form.deliveryRef.trim() } : {}),
    lines,
    invoiceDiscountP,
    freightP,
    loadingP,
    otherChargesP,
    paidAmountP,
    paymentMethod: form.paymentMethod,
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    // sent even when empty: on an edit an omitted description is KEPT, so clearing the box has to say so
    description: form.description.trim(),
    ...(ctx.revision !== undefined ? { revision: ctx.revision } : {}),
    idempotencyKey: ctx.idempotencyKey,
  };
  return { ok: true, payload };
}

/* ── has anything changed since the form was loaded or last saved? ─────────────────────────────── */

/** Everything a person could have changed, in a comparable string (the React keys are not part of it). */
export function purchaseFingerprint(form: PurchaseForm): string {
  return JSON.stringify({ ...form, supplier: form.supplier?.id ?? null, lines: form.lines.map(({ key: _key, ...rest }) => rest) });
}

/** Dirty means "different from the snapshot", not "a key was pressed": typing a character and deleting it again is not a change. */
export const isPurchaseDirty = (form: PurchaseForm, snapshot: PurchaseForm): boolean => purchaseFingerprint(form) !== purchaseFingerprint(snapshot);

/* ── the Amount Paid box ───────────────────────────────────────────────────────────────────────── */

export interface PurchasePaidRules {
  disabled: boolean;
  hint: string;
}

/** Legacy hint on an edit (05-ui-builder.js), verbatim. */
export const PAID_EDIT_HINT =
  "What has been paid with this purchase so far. Raising it records another payment voucher for the difference; to lower it, reverse the voucher from Payments.";
export const PAID_NEW_HINT = "Leave at 0 if nothing is paid now. Money paid with the bill goes to the supplier as a payment voucher.";
export const PAID_NO_PERMISSION_HINT = "You do not have permission to pay a supplier. The purchase can be saved with nothing new paid; someone who records payments pays the supplier.";

/** What the Amount Paid box may do, by role and by whether this is an edit. The server judges the amount; this only says what is possible and why not. */
export function purchasePaidRules(o: { canPayOut: boolean; editing: boolean }): PurchasePaidRules {
  if (!o.canPayOut) return { disabled: true, hint: PAID_NO_PERMISSION_HINT };
  return { disabled: false, hint: o.editing ? PAID_EDIT_HINT : PAID_NEW_HINT };
}

/** Typed amount paid in paisa (0 when blank / unreadable) against what was already paid: a lower figure is refused by the server, shown early. */
export function paidBelowPaid(form: Pick<PurchaseForm, "paidAmount">, alreadyPaidP: number): boolean {
  const r = parseAmount(form.paidAmount);
  return r.ok && r.paisa < alreadyPaidP;
}

/* ── the last rate bought at ───────────────────────────────────────────────────────────────────── */

/** "Last bought at PKR 1,200.00 on 20 Sep 2026 (PUR-2026-000007)" — the legacy `lastRate` offered as a starting point. */
export function lastRateText(rate: Pick<PurchaseRate, "unitPriceP" | "date" | "purchaseNumber">, formatMoney: (paisa: number) => string): string {
  return `Last bought at ${formatMoney(rate.unitPriceP)}/bag on ${fmtDate(rate.date)}${rate.purchaseNumber ? ` (${rate.purchaseNumber})` : ""}.`;
}

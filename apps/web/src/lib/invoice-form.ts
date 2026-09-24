import {
  businessDateOf,
  formatPaisa,
  invoiceTotals,
  milliToQty,
  parseRupees,
  qtyToMilli,
  rupeesText,
  type InvoiceDetail,
  type InvoiceTotals,
  type PartyLookupItem,
  type ProductPickItem,
  type SaveInvoiceInput,
} from "@farooq/shared";

/**
 * The invoice builder's form: what a person typed (text, exactly as typed), the reducer that changes it, and the ONE
 * pair of functions that turn a saved invoice into a form and a form into the request the API takes
 * (`detailToForm`, `formToSavePayload`). Edit, Duplicate-then-edit and the direct Post all go through them.
 *
 * Money is typed as rupees and converted to paisa only when a request is built (`parseRupees` — strict, at most two
 * decimals, Urdu digits accepted); a quantity is bags with at most three decimals, read as text into integer
 * thousandths (never multiplied as a float). Totals are the shared `invoiceTotals`, so the screen and the server cannot
 * add up differently.
 */

export const PAYMENT_METHODS = ["Cash", "Bank Transfer", "JazzCash", "Easypaisa", "Cheque", "Adjustment"] as const;

export interface FormLine {
  /** A local React key — never sent. */
  key: string;
  /** The id of an existing line (editing) — kept so the line keeps its identity; absent for a line added here. */
  id?: string;
  productId: string;
  /** Bags, as typed. */
  quantity: string;
  /** Rupees per bag, as typed. */
  rate: string;
  /** A flat discount in rupees, as typed. */
  discount: string;
  warehouseId: string;
  /** A fixed tax (paisa) carried from a saved line. The screen has no tax entry (the legacy builder had none either). */
  taxP: number;
  unit: string;
  batchNo: string;
  notes: string;
}

export interface InvoiceForm {
  /** The shop. `null` until a person chooses one — never pre-selected. */
  customer: PartyLookupItem | null;
  /** A filter for the shop list only (the region select) — not part of the saved invoice. */
  regionId: string;
  warehouseId: string;
  date: string;
  dueDate: string;
  orderNumber: string;
  lines: FormLine[];
  invoiceDiscount: string;
  freight: string;
  loading: string;
  otherCharges: string;
  paidAmount: string;
  paymentMethod: string;
  referenceNo: string;
  description: string;
  notes: string;
}

/** The text fields a plain `field` action may set. */
export type FormField = Exclude<keyof InvoiceForm, "customer" | "lines">;

let lineCounter = 0;
export const newLineKey = (): string => `line-${++lineCounter}`;

export function blankForm(warehouseId: string, today: string = businessDateOf(new Date())): InvoiceForm {
  return {
    customer: null,
    regionId: "",
    warehouseId,
    date: today,
    dueDate: "",
    orderNumber: "",
    lines: [],
    invoiceDiscount: "",
    freight: "",
    loading: "",
    otherCharges: "",
    paidAmount: "",
    paymentMethod: "Cash",
    referenceNo: "",
    description: "",
    notes: "",
  };
}

/* ── the reducer ───────────────────────────────────────────────────────────────────────────────── */

export type FormAction =
  | { type: "field"; field: FormField; value: string }
  /** Changing the region clears the shop (legacy 06-wiring.js 1005). */
  | { type: "region"; regionId: string }
  | { type: "shop"; customer: PartyLookupItem | null }
  /** The header warehouse rewrites every line's warehouse (legacy 06-wiring.js 1010). */
  | { type: "headerWarehouse"; warehouseId: string }
  | { type: "addLine"; line: FormLine }
  | { type: "line"; key: string; patch: Partial<Pick<FormLine, "quantity" | "rate" | "discount" | "warehouseId">> }
  | { type: "move"; key: string; direction: -1 | 1 }
  | { type: "remove"; key: string }
  | { type: "reset"; form: InvoiceForm };

export function formReducer(form: InvoiceForm, action: FormAction): InvoiceForm {
  switch (action.type) {
    case "field":
      return { ...form, [action.field]: action.value };
    case "region":
      return { ...form, regionId: action.regionId, customer: null };
    case "shop":
      return { ...form, customer: action.customer };
    case "headerWarehouse":
      return { ...form, warehouseId: action.warehouseId, lines: form.lines.map((l) => ({ ...l, warehouseId: action.warehouseId })) };
    case "addLine":
      return { ...form, lines: [...form.lines, action.line] };
    case "line":
      return { ...form, lines: form.lines.map((l) => (l.key === action.key ? { ...l, ...action.patch } : l)) };
    case "move": {
      const i = form.lines.findIndex((l) => l.key === action.key);
      const j = i + action.direction;
      if (i < 0 || j < 0 || j >= form.lines.length) return form;
      const lines = [...form.lines];
      [lines[i], lines[j]] = [lines[j]!, lines[i]!];
      return { ...form, lines };
    }
    case "remove":
      return { ...form, lines: form.lines.filter((l) => l.key !== action.key) };
    case "reset":
      return action.form;
  }
}

/* ── reading what was typed ────────────────────────────────────────────────────────────────────── */

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const westernDigits = (text: string): string =>
  text.replace(ARABIC_DIGITS, (c) => {
    const k = c.charCodeAt(0);
    return String(k >= 0x06f0 ? k - 0x06f0 : k - 0x0660);
  });

export const QUANTITY_MESSAGE = "Enter the number of bags — at most 3 decimal places (2.5 is two and a half bags).";

export type ParsedQuantity = { ok: true; qtyMilli: number; quantity: number } | { ok: false; message: string };

/** Bags typed by a person → exact thousandths. Blank is "not entered yet" (0), text that is not a number is an error. Read as text, never as a float. */
export function parseQuantity(text: string): ParsedQuantity {
  const s = westernDigits(String(text ?? "")).replace(/[,\s]/g, "");
  if (s === "") return { ok: true, qtyMilli: 0, quantity: 0 };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) return { ok: false, message: QUANTITY_MESSAGE };
  const frac = m[2] ?? "";
  if (frac.length > 3) return { ok: false, message: QUANTITY_MESSAGE };
  const whole = (m[1] ?? "").replace(/^0+(?=\d)/, "") || "0";
  if (whole.length > 7) return { ok: false, message: "That quantity is too large." };
  const qtyMilli = Number(whole) * 1000 + Number(frac.padEnd(3, "0"));
  return { ok: true, qtyMilli, quantity: milliToQty(qtyMilli) };
}

export type ParsedAmount = { ok: true; paisa: number } | { ok: false; message: string };

/** Rupees typed → paisa; blank is 0 (a discount, a charge, an amount paid may be left empty). */
export function parseAmount(text: string): ParsedAmount {
  if (String(text ?? "").trim() === "") return { ok: true, paisa: 0 };
  const r = parseRupees(text);
  return r.ok ? { ok: true, paisa: r.paisa } : { ok: false, message: r.message };
}

const paisaOr0 = (text: string): number => {
  const r = parseAmount(text);
  return r.ok ? r.paisa : 0;
};

/* ── live totals ───────────────────────────────────────────────────────────────────────────────── */

/** The totals as they stand now: what cannot be read yet counts as 0 (the request refuses it by name when saved). Always the shared `invoiceTotals`. */
export function formTotals(form: InvoiceForm): InvoiceTotals {
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

/* ── saved invoice ⇄ form ⇄ request ────────────────────────────────────────────────────────────── */

const textOrEmpty = (v: string | null | undefined): string => v ?? "";
const rupeesOrEmpty = (paisa: number): string => (paisa ? rupeesText(paisa) : "");

/** The shop as the picker holds it, from what an invoice printed about it. */
export function customerOf(inv: Pick<InvoiceDetail, "customerId" | "shop">): PartyLookupItem | null {
  if (!inv.customerId) return null;
  return {
    id: inv.customerId,
    name: inv.shop.shopName ?? inv.shop.name ?? "",
    contact: inv.shop.contactPerson,
    phone: inv.shop.mobile,
    region: inv.shop.region,
    regionId: inv.shop.regionId,
    active: true,
  };
}

/** A saved invoice (draft or posted) → the form that edits it. Every line id, quantity, rate, discount, tax and charge is kept. */
export function detailToForm(inv: InvoiceDetail, fallbackWarehouseId = ""): InvoiceForm {
  return {
    customer: customerOf(inv),
    regionId: "",
    warehouseId: inv.warehouseId ?? inv.lines[0]?.warehouseId ?? fallbackWarehouseId,
    date: inv.date,
    dueDate: textOrEmpty(inv.dueDate),
    orderNumber: textOrEmpty(inv.orderNumber),
    lines: inv.lines.map((l) => ({
      key: newLineKey(),
      id: l.id,
      productId: l.productId,
      quantity: String(l.quantity),
      rate: rupeesText(l.unitPriceP),
      discount: rupeesOrEmpty(l.discountP),
      warehouseId: l.warehouseId,
      taxP: l.taxP,
      unit: l.unit,
      batchNo: textOrEmpty(l.batchNo),
      notes: textOrEmpty(l.notes),
    })),
    invoiceDiscount: rupeesOrEmpty(inv.invoiceDiscountP),
    freight: rupeesOrEmpty(inv.freightP),
    loading: rupeesOrEmpty(inv.loadingP),
    otherCharges: rupeesOrEmpty(inv.otherChargesP),
    // a draft holds no payment; a posted invoice starts at what is already received
    paidAmount: inv.status === "DRAFT" ? "" : rupeesOrEmpty(inv.paidP),
    paymentMethod: inv.paymentMethod ?? "Cash",
    referenceNo: textOrEmpty(inv.referenceNo),
    description: textOrEmpty(inv.description),
    notes: textOrEmpty(inv.notes),
  };
}

export interface SaveContext {
  mode: "draft" | "post";
  idempotencyKey: string;
  /** Editing: the revision of the invoice as loaded. */
  revision?: number;
}

export type PayloadResult = { ok: true; payload: SaveInvoiceInput } | { ok: false; errors: string[] };

/**
 * The form → the request. Refuses only what cannot be turned into a number at all (naming the line); whether a quantity
 * is enough, a rate is missing or the shop is chosen is the server's to say — and its words are shown as they come.
 */
export function formToSavePayload(form: InvoiceForm, ctx: SaveContext): PayloadResult {
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
    const unitPriceP = amount("the rate", l.rate, `${n}, `);
    const discountP = amount("the discount", l.discount, `${n}, `);
    return {
      ...(l.id ? { id: l.id } : {}),
      productId: l.productId,
      quantity: q.ok ? q.quantity : 0,
      unitPriceP,
      discountP,
      ...(l.taxP > 0 ? { taxP: l.taxP } : {}),
      warehouseId: l.warehouseId,
      ...(l.unit ? { unit: l.unit } : {}),
      ...(l.batchNo.trim() ? { batchNo: l.batchNo.trim() } : {}),
      ...(l.notes.trim() ? { notes: l.notes.trim() } : {}),
    };
  });

  const invoiceDiscountP = amount("The invoice discount", form.invoiceDiscount);
  const freightP = amount("The freight", form.freight);
  const loadingP = amount("The loading charge", form.loading);
  const otherChargesP = amount("The other charges", form.otherCharges);
  const paidAmountP = amount("The amount paid", form.paidAmount);
  if (errors.length) return { ok: false, errors };

  const payload: SaveInvoiceInput = {
    mode: ctx.mode,
    // an empty id is not a uuid: leaving it out lets the server say "Choose a shop to invoice." in its own words
    customerId: form.customer?.id ?? "",
    warehouseId: form.warehouseId,
    date: form.date,
    ...(form.dueDate ? { dueDate: form.dueDate } : {}),
    lines,
    invoiceDiscountP,
    freightP,
    loadingP,
    otherChargesP,
    paidAmountP,
    paymentMethod: form.paymentMethod,
    ...(form.referenceNo.trim() ? { referenceNo: form.referenceNo.trim() } : {}),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    ...(form.orderNumber.trim() ? { orderNumber: form.orderNumber.trim() } : {}),
    ...(ctx.revision !== undefined ? { revision: ctx.revision } : {}),
    idempotencyKey: ctx.idempotencyKey,
  };
  return { ok: true, payload };
}

/** "Post invoice" on a draft's view page: the draft exactly as saved, posted on credit (paid 0), at the revision it was loaded at. */
export function postPayloadOf(inv: InvoiceDetail, idempotencyKey: string): PayloadResult {
  const form = detailToForm(inv);
  return formToSavePayload({ ...form, paidAmount: "" }, { mode: "post", idempotencyKey, revision: inv.revision });
}

/* ── has anything changed since the form was loaded or last saved? ─────────────────────────────── */

/** Everything a person could have changed, in a comparable string (the React keys are not part of it). */
export function fingerprint(form: InvoiceForm): string {
  return JSON.stringify({ ...form, customer: form.customer?.id ?? null, lines: form.lines.map(({ key: _key, ...rest }) => rest) });
}

/** Dirty means "different from the snapshot", not "a key was pressed": typing a character and deleting it again is not a change. */
export const isDirty = (form: InvoiceForm, snapshot: InvoiceForm): boolean => fingerprint(form) !== fingerprint(snapshot);

/* ── stock: per product × warehouse, totalled across lines (the server's rule) ─────────────────── */

export const pairKey = (productId: string, warehouseId: string): string => `${productId}|${warehouseId}`;

export interface PairStock {
  /** Bags that can go out of this godown now (thousandths). `null` while the product's figures are not known yet. */
  availableMilli: number | null;
  /** What every line of the form takes from this pair (thousandths). */
  requestedMilli: number;
  /** requested − available, when positive. */
  shortMilli: number;
}

/**
 * What each product × warehouse has and what the lines ask of it. Two lines of one product from one godown are
 * ADDED before comparing (as the server checks it). Editing a posted invoice counts its own previously deducted bags back
 * in (`ownBackMilli`: the picker's `available` no longer includes them). Only a warning: the server decides.
 */
export function stockByPair(
  form: Pick<InvoiceForm, "lines">,
  products: ReadonlyMap<string, Pick<ProductPickItem, "available">>,
  ownBackMilli: ReadonlyMap<string, number> = new Map(),
): Map<string, PairStock> {
  const out = new Map<string, PairStock>();
  for (const l of form.lines) {
    const key = pairKey(l.productId, l.warehouseId);
    const q = parseQuantity(l.quantity);
    const milli = q.ok ? q.qtyMilli : 0;
    const known = out.get(key);
    if (known) {
      known.requestedMilli += milli;
      continue;
    }
    const product = products.get(l.productId);
    const level = product?.available.find((a) => a.warehouseId === l.warehouseId);
    out.set(key, { availableMilli: product ? qtyToMilli(level?.quantity ?? 0) + (ownBackMilli.get(key) ?? 0) : null, requestedMilli: milli, shortMilli: 0 });
  }
  for (const s of out.values()) s.shortMilli = s.availableMilli !== null && s.requestedMilli > s.availableMilli ? s.requestedMilli - s.availableMilli : 0;
  return out;
}

/** The bags an edited posted invoice took out of each product × warehouse (what to add back to the picker's figures). Only when its stock really was deducted. */
export function ownBagsBack(inv: Pick<InvoiceDetail, "status" | "stockApplied" | "migrated" | "lines">): Map<string, number> {
  const out = new Map<string, number>();
  if (inv.status === "DRAFT" || inv.status === "CANCELLED" || !inv.stockApplied || inv.migrated) return out;
  for (const l of inv.lines) out.set(pairKey(l.productId, l.warehouseId), (out.get(pairKey(l.productId, l.warehouseId)) ?? 0) + l.qtyMilli);
  return out;
}

export const shortLineCount = (form: Pick<InvoiceForm, "lines">, stock: ReadonlyMap<string, PairStock>): number =>
  form.lines.filter((l) => (stock.get(pairKey(l.productId, l.warehouseId))?.shortMilli ?? 0) > 0).length;

/* ── prices ────────────────────────────────────────────────────────────────────────────────────── */

/** The rate a new line starts with: the owner's set price, else the last rate charged (legacy `lastRate`), else empty. */
export const defaultRateText = (p: Pick<ProductPickItem, "sellP" | "lastRateP">): string => {
  const paisa = p.sellP ?? p.lastRateP;
  return paisa ? rupeesText(paisa) : "";
};

export const LOW_MARGIN_PCT = 5;

export type PriceHint = { kind: "no-cost" | "below-cost" | "below-min" | "low-margin" | "ok"; text: string };

const rupees = (paisa: number): string => `PKR ${formatPaisa(paisa)}`;

/**
 * Below cost / below the minimum price / low margin (legacy 17-profit.js `marginNote`). Only for a role that may see cost —
 * `showCost` is false for everyone else and nothing is returned, so no cost figure can leak into the page.
 */
export function priceHint(
  showCost: boolean,
  product: Pick<ProductPickItem, "costP" | "minSellP"> | undefined,
  line: Pick<FormLine, "quantity" | "rate" | "discount">,
): PriceHint | null {
  if (!showCost || !product) return null;
  const costP = product.costP ?? 0;
  if (costP <= 0) return { kind: "no-cost", text: "No purchase cost recorded yet for this product — profit cannot be shown." };
  const q = parseQuantity(line.quantity);
  const rate = parseAmount(line.rate);
  const disc = parseAmount(line.discount);
  if (!q.ok || !rate.ok || !disc.ok || q.qtyMilli <= 0 || rate.paisa <= 0) return null;
  const qty = q.qtyMilli / 1000;
  const revenue = Math.max(0, Math.round(rate.paisa * qty) - disc.paisa);
  const totalCost = Math.round(costP * qty);
  const profit = revenue - totalCost;
  const unitRevenue = Math.round(revenue / qty);
  const margin = revenue ? (profit / revenue) * 100 : 0;
  if (totalCost > 0 && revenue < totalCost) {
    return { kind: "below-cost", text: `Below cost. Cost ${rupees(costP)}/bag against ${rupees(unitRevenue)} — a loss of ${rupees(Math.abs(profit))} on this line.` };
  }
  if (product.minSellP && unitRevenue < product.minSellP) {
    return { kind: "below-min", text: `Below the minimum price of ${rupees(product.minSellP)}/bag. Cost ${rupees(costP)}/bag · profit ${rupees(profit)} · margin ${margin.toFixed(2)}%.` };
  }
  if (margin < LOW_MARGIN_PCT) {
    return { kind: "low-margin", text: `Low margin. Cost ${rupees(costP)}/bag · profit ${rupees(profit)} · margin ${margin.toFixed(2)}%.` };
  }
  return { kind: "ok", text: `Cost ${rupees(costP)}/bag · profit ${rupees(profit)} · margin ${margin.toFixed(2)}%.` };
}

/* ── what the server refused ───────────────────────────────────────────────────────────────────── */

/** "Line 2 (Zam Zam): …" → 2 (1-based), else null. */
export function lineNumberOf(message: string): number | null {
  const m = /^Line (\d+)\b/.exec(message);
  return m ? Number(m[1]) : null;
}

/** The refusal split into what belongs to a line (marked on that row) and what belongs to the whole invoice. Every line is still listed in the banner. */
export function splitErrors(errors: readonly string[]): { byLine: Map<number, string[]>; general: string[] } {
  const byLine = new Map<number, string[]>();
  const general: string[] = [];
  for (const e of errors) {
    const n = lineNumberOf(e);
    if (n === null) general.push(e);
    else byLine.set(n, [...(byLine.get(n) ?? []), e]);
  }
  return { byLine, general };
}

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatPaisaPlain, milliToQty, type InvoiceTotals, type ProductPickItem, type PurchaseDetail, type PurchaseRate, type WarehouseItem } from "@farooq/shared";
import { balanceWords, fmtMoney } from "../lib/format";
import { parseQuantity, PAYMENT_METHODS } from "../lib/invoice-form";
import { useMediaQuery } from "../lib/media";
import {
  lastRateText,
  receivedHint,
  receivedState,
  type BagTotals,
  type PurchaseForm,
  type PurchaseFormAction,
  type PurchaseFormLine,
  type PurchasePaidRules,
} from "../lib/purchase-form";
import { getBalance, keys } from "../lib/queries";
import { fmtBags } from "./invoice-builder-parts";
import { PartyCombobox } from "./party-combobox";
import { Banner, Button, cn, Field, inputClass } from "./ui";

/* ── the supplier ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Never pre-selected (a wrong supplier is a wrong payable). On a recorded purchase the picker is locked when the server says so
 * (`actions.changeSupplier`: a voucher or a return belongs to this supplier) and the server's own reason is shown. The card shows what
 * is payable to the supplier now (legacy).
 */
export function SupplierSection({
  form,
  dispatch,
  lockReason,
  invalid,
}: {
  form: PurchaseForm;
  dispatch: (a: PurchaseFormAction) => void;
  /** Non-null = the supplier cannot be changed, and why. */
  lockReason: string | null;
  invalid: boolean;
}) {
  const supplier = form.supplier;
  const balance = useQuery({ queryKey: supplier ? keys.balance("supplier", supplier.id) : ["balance", "none"], queryFn: () => getBalance("supplier", supplier!.id), enabled: Boolean(supplier) });
  return (
    <div className="space-y-3">
      <div className="text-sm">
        <span className="mb-1 block font-medium text-(--color-text)">Supplier</span>
        {lockReason !== null ? (
          <p dir="auto" className={cn(inputClass, "text-left opacity-80")} data-testid="supplier-locked">
            {supplier?.name ?? ""}
          </p>
        ) : (
          <PartyCombobox type="supplier" value={supplier} label="Supplier" invalid={invalid} onChange={(s) => dispatch({ type: "supplier", supplier: s })} />
        )}
      </div>
      {lockReason !== null ? (
        <p className="text-xs text-(--color-text-muted)" data-testid="supplier-locked-hint">
          {lockReason}
        </p>
      ) : null}
      {supplier ? (
        <dl className="rounded-lg border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm" data-testid="supplier-card">
          <dt className="text-xs text-(--color-text-muted)">Payable now</dt>
          <dd className="font-semibold" data-testid="supplier-balance">
            {balance.data ? balanceWords("SUPPLIER", balance.data.balanceP) : "…"}
          </dd>
        </dl>
      ) : null}
    </div>
  );
}

/* ── the lines ────────────────────────────────────────────────────────────────────────────────── */

export interface PurchaseLinesEditorProps {
  form: PurchaseForm;
  dispatch: (a: PurchaseFormAction) => void;
  products: ReadonlyMap<string, ProductPickItem>;
  /** The purchase being edited (its saved line names stand in until a product's own figures arrive). */
  purchase: PurchaseDetail | null;
  totals: InvoiceTotals;
  warehouses: WarehouseItem[];
  rates: ReadonlyMap<string, PurchaseRate>;
  errorsByLine: ReadonlyMap<number, string[]>;
  focusKey: string | null;
  onFocused: () => void;
}

interface LineView {
  line: PurchaseFormLine;
  index: number;
  english: string;
  urdu: string | null;
  meta: string;
  pack: string;
  amountP: number;
  received: ReturnType<typeof receivedHint>;
  rate: string | null;
  belowReturned: string | null;
  errors: string[];
}

function buildViews(p: PurchaseLinesEditorProps): LineView[] {
  return p.form.lines.map((line, index) => {
    const product = p.products.get(line.productId);
    const saved = p.purchase?.lines.find((l) => l.productId === line.productId);
    const known = p.rates.get(line.productId);
    const state = receivedState(line);
    const got = line.received.trim() === "" ? null : parseQuantity(line.received);
    return {
      line,
      index,
      english: product?.nameEn ?? product?.name ?? saved?.descriptionEn ?? saved?.description ?? "Loading product…",
      urdu: product?.nameUr && product.nameUr !== (product.nameEn ?? product.name) ? product.nameUr : null,
      meta: [product?.brand ?? saved?.brand, product?.category].filter(Boolean).join(" · "),
      pack: product?.weightKg ? `${product.weightKg} KG` : (saved?.package ?? "Bag"),
      amountP: p.totals.lines[index]?.lineTotalP ?? 0,
      received: receivedHint(state),
      // a line already on the purchase would only be told its own rate: the hint is for lines added here
      rate: known && !line.id ? lastRateText(known, fmtMoney) : null,
      belowReturned: line.returnedMilli > 0 && got !== null && got.ok && got.qtyMilli < line.returnedMilli ? `${fmtBags(milliToQty(line.returnedMilli))} bags were already returned to the supplier, so fewer than that cannot be shown as received.` : null,
      errors: p.errorsByLine.get(index + 1) ?? [],
    };
  });
}

/** Enter moves to the next box (a form should not submit or jump away on Enter). */
function enterMovesOn(e: React.KeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  if (e.key !== "Enter" || !root) return;
  e.preventDefault();
  const fields = Array.from(root.querySelectorAll<HTMLElement>("[data-line-field]"));
  const next = fields[fields.indexOf(e.currentTarget) + 1];
  next?.focus();
  if (next instanceof HTMLInputElement) next.select();
}

type Field4 = "qty" | "recv" | "rate" | "discount";

export function PurchaseLinesEditor(props: PurchaseLinesEditorProps) {
  const { dispatch, warehouses, focusKey, onFocused } = props;
  const wide = useMediaQuery("(min-width: 768px)"); // a table on a wide screen, cards on a phone — only one of them is in the page
  const rootRef = useRef<HTMLDivElement>(null);
  const views = buildViews(props);

  useEffect(() => {
    if (!focusKey) return;
    const el = rootRef.current?.querySelector<HTMLInputElement>(`[data-line-key="${focusKey}"][data-line-field="qty"]`);
    if (el) {
      el.focus();
      el.select();
    }
    onFocused();
  }, [focusKey, onFocused]);

  if (views.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-(--color-border) px-4 py-6 text-center text-sm text-(--color-text-muted)" data-testid="no-lines">
        <b>No items yet.</b> Search above and press <em>Add item</em> — one purchase can hold as many products as the load has.
      </p>
    );
  }

  const warehouseSelect = (v: LineView) => (
    <select
      aria-label={`Warehouse, line ${v.index + 1}`}
      value={v.line.warehouseId}
      disabled={v.line.lock !== ""}
      onChange={(e) => dispatch({ type: "line", key: v.line.key, patch: { warehouseId: e.target.value } })}
      className={cn(inputClass, "w-full py-1.5")}
      data-testid="line-warehouse"
    >
      {warehouses.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
  const numberInput = (v: LineView, field: Field4, label: string, value: string, placeholder: string) => (
    <input
      inputMode="decimal"
      autoComplete="off"
      aria-label={`${label}, line ${v.index + 1}`}
      aria-invalid={v.errors.length > 0 && field === "qty" ? true : undefined}
      placeholder={placeholder}
      value={value}
      data-line-key={v.line.key}
      data-line-field={field}
      data-testid={`line-${field}`}
      onChange={(e) =>
        dispatch({
          type: "line",
          key: v.line.key,
          patch: field === "qty" ? { quantity: e.target.value } : field === "recv" ? { received: e.target.value } : field === "rate" ? { rate: e.target.value } : { discount: e.target.value },
        })
      }
      onKeyDown={(e) => enterMovesOn(e, rootRef.current)}
      className={cn(inputClass, "num py-1.5 text-right", field === "qty" && "font-semibold")}
    />
  );
  const actions = (v: LineView) => (
    <div className="flex gap-1">
      <Button size="sm" aria-label={`Move line ${v.index + 1} up`} disabled={v.index === 0} onClick={() => dispatch({ type: "move", key: v.line.key, direction: -1 })} data-testid="line-up">
        ↑
      </Button>
      <Button size="sm" aria-label={`Move line ${v.index + 1} down`} disabled={v.index === views.length - 1} onClick={() => dispatch({ type: "move", key: v.line.key, direction: 1 })} data-testid="line-down">
        ↓
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Remove line ${v.index + 1}`}
        title={v.line.lock || undefined}
        disabled={v.line.lock !== ""}
        onClick={() => dispatch({ type: "remove", key: v.line.key })}
        data-testid="line-remove"
      >
        ✕
      </Button>
    </div>
  );
  const notes = (v: LineView) => (
    <>
      {v.line.lock ? (
        <p className="mt-1 text-xs text-(--color-text-muted)" data-testid="line-lock">
          {v.line.lock}
        </p>
      ) : null}
      {v.belowReturned ? (
        <p role="alert" className="mt-1 text-xs text-(--color-danger)" data-testid="line-returned-hint">
          {v.belowReturned}
        </p>
      ) : null}
      {v.received ? (
        <p className="mt-1 text-xs text-(--color-text)" data-testid="line-received-hint" data-state={receivedState(v.line)}>
          {v.received}
        </p>
      ) : null}
      {v.rate ? (
        <p className="mt-1 text-xs text-(--color-text-muted)" data-testid="line-last-rate">
          {v.rate}
        </p>
      ) : null}
      {v.errors.map((m) => (
        <p key={m} role="alert" className="mt-1 text-xs text-(--color-danger)" data-testid="line-error">
          {m}
        </p>
      ))}
    </>
  );
  const rowClass = (v: LineView) => (v.errors.length > 0 || v.belowReturned ? "bg-(--color-danger-bg)" : "");
  const product = (v: LineView) => (
    <>
      <span dir="auto" className="block text-left text-sm font-medium">
        {v.urdu ? `${v.urdu} ` : ""}
        <span className={v.urdu ? "font-normal text-(--color-text-muted)" : ""}>{v.english}</span>
      </span>
      {v.meta ? (
        <span dir="auto" className="block text-left text-xs text-(--color-text-muted)">
          {v.meta}
        </span>
      ) : null}
    </>
  );

  return (
    <div ref={rootRef}>
      {wide ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm" data-testid="lines-editor">
            <thead className="text-left text-xs text-(--color-text-muted)">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">Product</th>
                <th className="whitespace-nowrap px-2 py-1.5 font-medium">Package</th>
                <th className="px-2 py-1.5 font-medium">Warehouse</th>
                <th className="w-24 px-2 py-1.5 text-right font-medium">Ordered</th>
                <th className="w-24 px-2 py-1.5 text-right font-medium">Received</th>
                <th className="w-28 px-2 py-1.5 text-right font-medium">Rate</th>
                <th className="w-24 px-2 py-1.5 text-right font-medium">Discount</th>
                <th className="w-32 px-2 py-1.5 text-right font-medium">Amount</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {views.map((v) => (
                <tr key={v.line.key} className={cn("border-t border-(--color-border) align-top", rowClass(v))} data-testid="line-row">
                  <td className="px-2 py-2 text-(--color-text-muted)">{v.index + 1}</td>
                  <td className="min-w-[12rem] px-2 py-2">
                    {product(v)}
                    {notes(v)}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2">{v.pack}</td>
                  <td className="min-w-[11.5rem] px-2 py-2">{warehouseSelect(v)}</td>
                  <td className="px-2 py-2">{numberInput(v, "qty", "Ordered", v.line.quantity, "0")}</td>
                  <td className="px-2 py-2">{numberInput(v, "recv", "Received", v.line.received, "all")}</td>
                  <td className="px-2 py-2">{numberInput(v, "rate", "Rate", v.line.rate, "0")}</td>
                  <td className="px-2 py-2">{numberInput(v, "discount", "Discount", v.line.discount, "0")}</td>
                  <td className="num px-2 py-2 text-right font-semibold" data-testid="line-amount">
                    {formatPaisaPlain(v.amountP)}
                    {v.line.taxP > 0 ? <span className="block text-xs font-normal text-(--color-text-muted)">incl. tax {formatPaisaPlain(v.line.taxP)}</span> : null}
                  </td>
                  <td className="px-2 py-2">{actions(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="space-y-3" data-testid="lines-cards">
          {views.map((v) => (
            <li key={v.line.key} className={cn("rounded-lg border border-(--color-border) p-3", rowClass(v))} data-testid="line-row">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-xs text-(--color-text-muted)">
                    Line {v.index + 1} · {v.pack}
                  </span>
                  {product(v)}
                </div>
                {actions(v)}
              </div>
              <div className="mt-2">{warehouseSelect(v)}</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-xs text-(--color-text-muted)">
                  Ordered
                  {numberInput(v, "qty", "Ordered", v.line.quantity, "0")}
                </label>
                <label className="text-xs text-(--color-text-muted)">
                  Received
                  {numberInput(v, "recv", "Received", v.line.received, "all")}
                </label>
                <label className="text-xs text-(--color-text-muted)">
                  Rate
                  {numberInput(v, "rate", "Rate", v.line.rate, "0")}
                </label>
                <label className="text-xs text-(--color-text-muted)">
                  Discount
                  {numberInput(v, "discount", "Discount", v.line.discount, "0")}
                </label>
              </div>
              <p className="mt-2 text-right text-sm">
                Amount{" "}
                <b className="num" data-testid="line-amount">
                  {formatPaisaPlain(v.amountP)}
                </b>
                {v.line.taxP > 0 ? <span className="ml-1 text-xs text-(--color-text-muted)">incl. tax {formatPaisaPlain(v.line.taxP)}</span> : null}
              </p>
              {notes(v)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The banner above the lines: what a blank Received means (legacy sentence, verbatim). */
export function ReceivedBanner() {
  return (
    <Banner tone="info" data-testid="received-banner">
      <p>
        Leave <b>Received</b> blank if the whole line arrived. Enter a smaller figure for a part delivery — only those bags go into stock and the rest stays open.
      </p>
    </Banner>
  );
}

/* ── charges, payment and notes ───────────────────────────────────────────────────────────────── */

export function PurchaseChargesSection({
  form,
  dispatch,
  paid,
  totals,
  editing,
}: {
  form: PurchaseForm;
  dispatch: (a: PurchaseFormAction) => void;
  paid: PurchasePaidRules;
  totals: InvoiceTotals;
  editing: boolean;
}) {
  const set = (field: "invoiceDiscount" | "freight" | "loading" | "otherCharges" | "paidAmount" | "paymentMethod" | "description" | "notes") => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    dispatch({ type: "field", field, value: e.target.value });
  const money = (field: "invoiceDiscount" | "freight" | "loading" | "otherCharges", label: string) => (
    <Field label={label}>
      <input inputMode="decimal" autoComplete="off" placeholder="0" value={form[field]} onChange={set(field)} className={cn(inputClass, "num text-right")} data-testid={`field-${field}`} />
    </Field>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {money("invoiceDiscount", "Overall discount")}
        {money("freight", "Delivery / freight")}
        {money("loading", "Loading / unloading")}
        {money("otherCharges", "Other charges")}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount Paid" hint={paid.hint}>
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={form.paidAmount}
            disabled={paid.disabled}
            onChange={set("paidAmount")}
            className={cn(inputClass, "num min-h-12 text-right text-lg font-bold")}
            data-testid="field-paidAmount"
          />
        </Field>
        <Field label={editing ? "Payment method (for what is added)" : "Payment method"}>
          <select value={form.paymentMethod} onChange={set("paymentMethod")} disabled={paid.disabled} className={inputClass} data-testid="field-paymentMethod">
            {[...new Set([...PAYMENT_METHODS, form.paymentMethod])].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Description / تفصیل" hint="Appears on the supplier’s statement — English or Urdu. Left blank, the statement writes its own.">
        <input value={form.description} onChange={set("description")} maxLength={1000} dir="auto" placeholder="Appears on the supplier’s statement" className={inputClass} data-testid="field-description" />
      </Field>
      <Field label="Internal note">
        <textarea value={form.notes} onChange={set("notes")} rows={2} maxLength={1000} dir="auto" placeholder="Anything that should appear on the document" className={inputClass} data-testid="field-notes" />
      </Field>
      <p className="text-sm text-(--color-text-muted)" data-testid="balance-after">
        {totals.grandTotalP ? `Grand total ${fmtMoney(totals.grandTotalP)} · still owed on this bill after this payment ${fmtMoney(totals.grandTotalP - totals.paidP)}` : "Add a line to see the totals."}
      </p>
    </div>
  );
}

/* ── the summary ──────────────────────────────────────────────────────────────────────────────── */

export function PurchaseSummaryRows({ totals, bags }: { totals: InvoiceTotals; bags: BagTotals }) {
  const rows: [string, string, boolean][] = [
    ["Subtotal", fmtMoney(totals.subtotalP), true],
    ["Item discounts", `− ${fmtMoney(totals.itemDiscountsP)}`, totals.itemDiscountsP > 0],
    ["Overall discount", `− ${fmtMoney(totals.invoiceDiscountP)}`, totals.invoiceDiscountP > 0],
    ["Tax", fmtMoney(totals.taxP), totals.taxP > 0],
    ["Delivery / freight", fmtMoney(totals.freightP), totals.freightP > 0],
    ["Loading / unloading", fmtMoney(totals.loadingP), totals.loadingP > 0],
    ["Other charges", fmtMoney(totals.otherChargesP), totals.otherChargesP > 0],
  ];
  return (
    <dl className="text-sm" data-testid="summary">
      {rows
        .filter(([, , show]) => show)
        .map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 py-0.5">
            <dt className="text-(--color-text-muted)">{label}</dt>
            <dd className="num">{value}</dd>
          </div>
        ))}
      <div className="flex justify-between gap-4 border-t border-(--color-border) py-1 text-base font-bold">
        <dt>Grand total</dt>
        <dd className="num" data-testid="summary-grand-total">
          {fmtMoney(totals.grandTotalP)}
        </dd>
      </div>
      <div className="flex justify-between gap-4 py-0.5">
        <dt className="text-(--color-text-muted)">Bags ordered</dt>
        <dd className="num" data-testid="summary-ordered">
          {fmtBags(milliToQty(bags.orderedMilli))}
        </dd>
      </div>
      <div className="flex justify-between gap-4 py-0.5">
        <dt className="text-(--color-text-muted)">Bags into stock</dt>
        <dd className="num" data-testid="summary-received">
          {fmtBags(milliToQty(bags.receivedMilli))}
        </dd>
      </div>
      <div className="flex justify-between gap-4 py-0.5">
        <dt className="text-(--color-text-muted)">Amount Paid</dt>
        <dd className="num" data-testid="summary-paid">
          {fmtMoney(totals.paidP)}
        </dd>
      </div>
      <div className="flex justify-between gap-4 py-0.5 font-semibold">
        <dt>Payable on this bill</dt>
        <dd className="num" data-testid="summary-balance">
          {fmtMoney(totals.balanceP)}
        </dd>
      </div>
    </dl>
  );
}

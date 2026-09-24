import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatPaisaPlain, milliToQty, type InvoiceDetail, type InvoiceTotals, type PartyLookupItem, type ProductPickItem, type WarehouseItem } from "@farooq/shared";
import { balanceWords, fmtMoney } from "../lib/format";
import { pairKey, PAYMENT_METHODS, priceHint, type FormAction, type FormLine, type InvoiceForm, type PairStock } from "../lib/invoice-form";
import { useMediaQuery } from "../lib/media";
import { getBalance, getRegions, keys, searchProducts } from "../lib/queries";
import { PartyCombobox } from "./party-combobox";
import { Badge, Banner, Button, cn, Field, inputClass } from "./ui";

/** Bags for a person: 1,250 / 2.5 (never "2.500"). */
export const fmtBags = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 3 });

const availableIn = (p: Pick<ProductPickItem, "available">, warehouseId: string): number => p.available.find((a) => a.warehouseId === warehouseId)?.quantity ?? 0;

/* ── the shop ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Region → Shop, never pre-selected (a wrong shop is a wrong balance). Changing the region clears the shop. A card shows the
 * owner, mobile, region and the shop's balance now. On a posted invoice both are locked: the invoice's payments hang off the
 * shop, so it moves through "Change shop" on the invoice, which takes them along.
 */
export function ShopSection({
  form,
  dispatch,
  locked,
  invalid,
}: {
  form: InvoiceForm;
  dispatch: (a: FormAction) => void;
  locked: boolean;
  invalid: boolean;
}) {
  const regions = useQuery({ queryKey: keys.regions, queryFn: getRegions, staleTime: 5 * 60_000 });
  const shop = form.customer;
  const balance = useQuery({ queryKey: shop ? keys.balance("customer", shop.id) : ["balance", "none"], queryFn: () => getBalance("customer", shop!.id), enabled: Boolean(shop) });
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
        <Field label="Region">
          <select value={form.regionId} disabled={locked} onChange={(e) => dispatch({ type: "region", regionId: e.target.value })} className={inputClass} data-testid="region-select">
            <option value="">All regions</option>
            {(regions.data ?? [])
              .filter((r) => r.active)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.nameEn}
                  {r.nameUr ? ` — ${r.nameUr}` : ""}
                </option>
              ))}
          </select>
        </Field>
        <div className="text-sm">
          <span className="mb-1 block font-medium text-(--color-text)">Shop</span>
          {locked ? (
            <p dir="auto" className={cn(inputClass, "text-left opacity-80")} data-testid="shop-locked">
              {shop?.name ?? ""}
            </p>
          ) : (
            <PartyCombobox type="customer" value={shop} regionId={form.regionId} label="Shop" invalid={invalid} onChange={(c: PartyLookupItem | null) => dispatch({ type: "shop", customer: c })} />
          )}
        </div>
      </div>
      {locked ? (
        <p className="text-xs text-(--color-text-muted)" data-testid="shop-locked-hint">
          The shop on a posted invoice cannot be changed here. To bill a different shop, leave this edit and use <b>Change shop</b> on the invoice — its payments and the shop balances move with it.
        </p>
      ) : null}
      {shop ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm sm:grid-cols-4" data-testid="shop-card">
          <div>
            <dt className="text-xs text-(--color-text-muted)">Owner</dt>
            <dd dir="auto" className="text-left">{shop.contact || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-text-muted)">Mobile</dt>
            <dd>{shop.phone || "Not set"}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-text-muted)">Region</dt>
            <dd dir="auto" className="text-left">{shop.region || "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-(--color-text-muted)">Current balance</dt>
            <dd className="font-semibold" data-testid="shop-balance">
              {balance.data ? balanceWords("CUSTOMER", balance.data.balanceP) : "…"}
            </dd>
          </div>
        </dl>
      ) : null}
    </div>
  );
}

/* ── the product picker ───────────────────────────────────────────────────────────────────────── */

function ProductResult({ p, warehouseId, onPick }: { p: ProductPickItem; warehouseId: string; onPick: (p: ProductPickItem) => void }) {
  const here = availableIn(p, warehouseId);
  return (
    <li>
      <button type="button" onClick={() => onPick(p)} data-testid="product-result" className="block w-full px-3 py-2 text-left hover:bg-(--color-bg)">
        <span dir="auto" className="block text-left text-sm font-medium text-(--color-text)">
          {p.nameUr ? `${p.nameUr} ` : ""}
          <span className="font-normal text-(--color-text-muted)">{p.nameEn ?? p.name}</span>
        </span>
        <span dir="auto" className="block text-left text-xs text-(--color-text-muted)">
          {[p.brand, p.weightKg ? `${p.weightKg} KG` : null, p.category].filter(Boolean).join(" · ")}
        </span>
        <span className={cn("block text-xs font-medium", here > 0 ? "text-(--color-ok)" : "text-(--color-danger)")}>Available: {fmtBags(here)} Bags</span>
      </button>
    </li>
  );
}

/** Search box + "Add item" over `GET /products` (words in name, Urdu name, brand, category, SKU, bag size; in-stock first for the warehouse) and a plain list as a fallback. */
export function ProductPicker({ warehouseId, onAdd }: { warehouseId: string; onAdd: (p: ProductPickItem) => void }) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const [plainOpen, setPlainOpen] = useState(false);
  const [plainChoice, setPlainChoice] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 200);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const results = useQuery({ queryKey: keys.productSearch(debounced, warehouseId, 40), queryFn: ({ signal }) => searchProducts(debounced, warehouseId, 40, signal), enabled: open && warehouseId !== "", staleTime: 10_000, placeholderData: (prev) => prev });
  const plain = useQuery({ queryKey: keys.productSearch("", warehouseId, 100), queryFn: ({ signal }) => searchProducts("", warehouseId, 100, signal), enabled: plainOpen && warehouseId !== "", staleTime: 30_000 });

  function pick(p: ProductPickItem) {
    onAdd(p);
    setText("");
    setDebounced("");
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="space-y-2" data-testid="product-picker">
      <div className="flex gap-2">
        <input
          type="search"
          aria-label="Search products"
          placeholder="Search product, brand, category, SKU or bag size…"
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter") {
              e.preventDefault();
              const first = results.data?.[0];
              if (open && first && text.trim()) pick(first);
            }
          }}
          className={inputClass}
        />
        <Button variant="primary" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="shrink-0 whitespace-nowrap">
          Add item
        </Button>
      </div>
      {open ? (
        <div
          className={cn("max-h-72 overflow-y-auto rounded-md border border-(--color-border) bg-(--color-surface) shadow-sm", results.isFetching && "opacity-60")}
          aria-busy={results.isFetching}
          data-testid="product-results"
        >
          {results.isPending ? (
            <p className="px-3 py-3 text-sm text-(--color-text-muted)">Searching…</p>
          ) : results.isError ? (
            <p className="px-3 py-3 text-sm text-(--color-danger)">Couldn’t load the products. Try again.</p>
          ) : results.data.length === 0 ? (
            <p className="px-3 py-3 text-sm text-(--color-text-muted)" data-testid="no-products">
              Nothing matches “{debounced.trim()}”. Try the Urdu name, the brand, or the bag size.
            </p>
          ) : (
            <ul className="divide-y divide-(--color-border)">
              {results.data.map((p) => (
                <ProductResult key={p.id} p={p} warehouseId={warehouseId} onPick={pick} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <details onToggle={(e) => setPlainOpen((e.currentTarget as HTMLDetailsElement).open)} className="text-sm" data-testid="plain-picker">
        <summary className="cursor-pointer text-xs text-(--color-text-muted)">Choose from a plain list instead</summary>
        <div className="mt-2 flex gap-2">
          <select aria-label="Product (plain list)" value={plainChoice} onChange={(e) => setPlainChoice(e.target.value)} className={inputClass}>
            <option value="">— choose a product —</option>
            {(plain.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.nameEn ?? p.name}
                {p.weightKg ? ` — ${p.weightKg} KG` : ""}
              </option>
            ))}
          </select>
          <Button
            disabled={!plainChoice}
            className="shrink-0 whitespace-nowrap"
            onClick={() => {
              const p = plain.data?.find((x) => x.id === plainChoice);
              if (p) {
                onAdd(p);
                setPlainChoice("");
              }
            }}
          >
            Add this product
          </Button>
        </div>
      </details>
    </div>
  );
}

/* ── the lines ────────────────────────────────────────────────────────────────────────────────── */

const HINT_TONE = { "no-cost": "text-(--color-text-muted)", "below-cost": "text-(--color-danger)", "below-min": "text-(--color-danger)", "low-margin": "text-(--color-text)", ok: "text-(--color-text-muted)" } as const;

interface LineView {
  line: FormLine;
  index: number;
  english: string;
  urdu: string | null;
  meta: string;
  pack: string;
  availableMilli: number | null;
  shortMilli: number;
  amountP: number;
  hint: ReturnType<typeof priceHint>;
  errors: string[];
}

export interface LinesEditorProps {
  form: InvoiceForm;
  dispatch: (a: FormAction) => void;
  products: ReadonlyMap<string, ProductPickItem>;
  /** The invoice being edited (its saved line names stand in until a product's own figures arrive). */
  invoice: InvoiceDetail | null;
  stock: ReadonlyMap<string, PairStock>;
  totals: InvoiceTotals;
  warehouses: WarehouseItem[];
  showCost: boolean;
  errorsByLine: ReadonlyMap<number, string[]>;
  focusKey: string | null;
  onFocused: () => void;
}

function buildViews(p: LinesEditorProps): LineView[] {
  return p.form.lines.map((line, index) => {
    const product = p.products.get(line.productId);
    const saved = p.invoice?.lines.find((l) => l.productId === line.productId);
    const pair = p.stock.get(pairKey(line.productId, line.warehouseId));
    return {
      line,
      index,
      english: product?.nameEn ?? product?.name ?? saved?.descriptionEn ?? saved?.description ?? "Loading product…",
      urdu: product?.nameUr && product.nameUr !== (product.nameEn ?? product.name) ? product.nameUr : null,
      meta: [product?.brand ?? saved?.brand, product?.category ?? saved?.category].filter(Boolean).join(" · "),
      pack: product?.weightKg ? `${product.weightKg} KG` : (saved?.package ?? "Bag"),
      availableMilli: pair?.availableMilli ?? null,
      shortMilli: pair?.shortMilli ?? 0,
      amountP: p.totals.lines[index]?.lineTotalP ?? 0,
      hint: priceHint(p.showCost, product, line),
      errors: p.errorsByLine.get(index + 1) ?? [],
    };
  });
}

/** Enter moves to the next quantity / rate / discount box (the legacy had no Enter handling; a form should not submit or jump away). */
function enterMovesOn(e: React.KeyboardEvent<HTMLElement>, root: HTMLElement | null) {
  if (e.key !== "Enter" || !root) return;
  e.preventDefault();
  const fields = Array.from(root.querySelectorAll<HTMLElement>("[data-line-field]"));
  const next = fields[fields.indexOf(e.currentTarget) + 1];
  next?.focus();
  if (next instanceof HTMLInputElement) next.select();
}

function availabilityText(v: LineView): string {
  if (v.availableMilli === null) return "checking stock…";
  const have = `${fmtBags(milliToQty(v.availableMilli))} available`;
  return v.shortMilli > 0 ? `${have} · short by ${fmtBags(milliToQty(v.shortMilli))}` : have;
}

export function LinesEditor(props: LinesEditorProps) {
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
        <b>No items yet.</b> Search above and press <em>Add item</em> — one invoice can hold as many products as the load needs.
      </p>
    );
  }

  const warehouseSelect = (v: LineView) => (
    <select
      aria-label={`Warehouse, line ${v.index + 1}`}
      value={v.line.warehouseId}
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
  const numberInput = (v: LineView, field: "qty" | "rate" | "discount", label: string, value: string, placeholder: string) => (
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
      onChange={(e) => dispatch({ type: "line", key: v.line.key, patch: field === "qty" ? { quantity: e.target.value } : field === "rate" ? { rate: e.target.value } : { discount: e.target.value } })}
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
      <Button size="sm" variant="ghost" aria-label={`Remove line ${v.index + 1}`} onClick={() => dispatch({ type: "remove", key: v.line.key })} data-testid="line-remove">
        ✕
      </Button>
    </div>
  );
  const notes = (v: LineView) => (
    <>
      {v.hint ? (
        <p className={cn("mt-1 text-xs", HINT_TONE[v.hint.kind])} data-testid="line-hint" data-kind={v.hint.kind}>
          {v.hint.text}
        </p>
      ) : null}
      {v.errors.map((m) => (
        <p key={m} role="alert" className="mt-1 text-xs text-(--color-danger)" data-testid="line-error">
          {m}
        </p>
      ))}
    </>
  );
  const rowClass = (v: LineView) => (v.errors.length > 0 || v.shortMilli > 0 ? "bg-(--color-danger-bg)" : "");
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
  const avail = (v: LineView) => (
    <p className={cn("mt-0.5 text-xs", v.shortMilli > 0 ? "font-medium text-(--color-danger)" : "text-(--color-text-muted)")} data-testid="line-avail" data-short={v.shortMilli > 0 ? "true" : undefined}>
      {availabilityText(v)}
    </p>
  );

  return (
    <div ref={rootRef}>
      {wide ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[52rem] text-sm" data-testid="lines-editor">
            <thead className="text-left text-xs text-(--color-text-muted)">
              <tr>
                <th className="px-2 py-1.5 font-medium">#</th>
                <th className="px-2 py-1.5 font-medium">Product</th>
                <th className="whitespace-nowrap px-2 py-1.5 font-medium">Package</th>
                <th className="px-2 py-1.5 font-medium">Warehouse</th>
                <th className="w-24 px-2 py-1.5 text-right font-medium">Qty</th>
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
                  <td className="min-w-[11.5rem] px-2 py-2">
                    {warehouseSelect(v)}
                    {avail(v)}
                  </td>
                  <td className="px-2 py-2">{numberInput(v, "qty", "Quantity", v.line.quantity, "0")}</td>
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
                  <span className="text-xs text-(--color-text-muted)">Line {v.index + 1} · {v.pack}</span>
                  {product(v)}
                </div>
                {actions(v)}
              </div>
              <div className="mt-2">
                {warehouseSelect(v)}
                {avail(v)}
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2">
                <label className="text-xs text-(--color-text-muted)">
                  Qty
                  {numberInput(v, "qty", "Quantity", v.line.quantity, "0")}
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
                Amount <b className="num" data-testid="line-amount">{formatPaisaPlain(v.amountP)}</b>
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

/* ── charges, payment and notes ───────────────────────────────────────────────────────────────── */

export interface PaidRules {
  disabled: boolean;
  hint: string;
}

/** What the Amount Paid box may do, by role and by what the invoice is. The server judges the amount; this only says what is possible and why not. */
export function paidRules(o: { canTakePayment: boolean; posted: boolean; receivedP: number }): PaidRules {
  if (!o.canTakePayment) {
    return { disabled: true, hint: "You do not have permission to take payment. The invoice can be posted on credit; someone who records payments takes the money." };
  }
  if (o.posted) {
    return {
      disabled: false,
      hint: `Already received: ${fmtMoney(o.receivedP)}. It cannot go below that — reverse the receipt from Payments first. Raising it records another receipt for the difference.`,
    };
  }
  return { disabled: false, hint: "Leave at 0 for a credit sale. Money is taken when the invoice is posted — a draft cannot hold a payment." };
}

export function ChargesSection({ form, dispatch, paid, totals }: { form: InvoiceForm; dispatch: (a: FormAction) => void; paid: PaidRules; totals: InvoiceTotals }) {
  const set = (field: "invoiceDiscount" | "freight" | "loading" | "otherCharges" | "paidAmount" | "paymentMethod" | "referenceNo" | "description" | "notes") => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
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
        <Field label="Payment method">
          <select value={form.paymentMethod} onChange={set("paymentMethod")} className={inputClass} data-testid="field-paymentMethod">
            {[...new Set([...PAYMENT_METHODS, form.paymentMethod])].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Reference number">
        <input value={form.referenceNo} onChange={set("referenceNo")} maxLength={100} placeholder="Cheque / transaction / bilty number" className={cn(inputClass, "font-mono")} />
      </Field>
      <Field label="Description / تفصیل" hint="Appears on the account statement — English or Urdu. Left blank, the statement writes its own.">
        <input value={form.description} onChange={set("description")} maxLength={500} dir="auto" placeholder="Appears on the account statement" className={inputClass} data-testid="field-description" />
      </Field>
      <Field label="Internal note">
        <textarea value={form.notes} onChange={set("notes")} rows={2} maxLength={1000} dir="auto" placeholder="Anything that should appear on the document" className={inputClass} data-testid="field-notes" />
      </Field>
      <p className="text-sm text-(--color-text-muted)" data-testid="balance-after">
        {totals.grandTotalP ? `Grand total ${fmtMoney(totals.grandTotalP)} · balance after this payment ${fmtMoney(totals.grandTotalP - totals.paidP)}` : "Add a line to see the totals."}
      </p>
    </div>
  );
}

/* ── the summary ──────────────────────────────────────────────────────────────────────────────── */

export function SummaryRows({ totals, previousBalanceP }: { totals: InvoiceTotals; previousBalanceP: number | null }) {
  const rows: [string, string, boolean][] = [
    ["Subtotal", fmtMoney(totals.subtotalP), true],
    ["Item discounts", `− ${fmtMoney(totals.itemDiscountsP)}`, totals.itemDiscountsP > 0],
    ["Invoice discount", `− ${fmtMoney(totals.invoiceDiscountP)}`, totals.invoiceDiscountP > 0],
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
        <dd className="num" data-testid="summary-grand-total">{fmtMoney(totals.grandTotalP)}</dd>
      </div>
      <div className="flex justify-between gap-4 py-0.5">
        <dt className="text-(--color-text-muted)">Bags</dt>
        <dd className="num" data-testid="summary-bags">{fmtBags(milliToQty(totals.totalQtyMilli))}</dd>
      </div>
      <div className="flex justify-between gap-4 py-0.5">
        <dt className="text-(--color-text-muted)">Amount Paid</dt>
        <dd className="num" data-testid="summary-paid">{fmtMoney(totals.paidP)}</dd>
      </div>
      <div className="flex justify-between gap-4 py-0.5 font-semibold">
        <dt>Balance on this invoice</dt>
        <dd className="num" data-testid="summary-balance">{fmtMoney(totals.balanceP)}</dd>
      </div>
      {previousBalanceP !== null ? (
        <div className="flex justify-between gap-4 py-0.5">
          <dt className="text-(--color-text-muted)">Shop’s balance before this sale</dt>
          <dd className="num" data-testid="summary-previous">{fmtMoney(previousBalanceP)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export function ShortBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span data-testid="short-count">
      <Badge tone="danger">
        {count} line{count === 1 ? "" : "s"} short of stock
      </Badge>
    </span>
  );
}

export function StockWarning({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <Banner tone="warn" title={`${count} line${count === 1 ? " is" : "s are"} short of stock`} data-testid="stock-warning">
      Saving will be refused if the bags are not there when you post (unless the business allows negative stock). Change the quantity or the warehouse, or save a draft.
    </Banner>
  );
}

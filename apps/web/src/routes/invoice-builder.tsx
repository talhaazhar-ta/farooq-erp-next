import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { INVOICE_MESSAGES, milliToQty, type InvoiceDetail, type ProductPickItem, type WarehouseItem } from "@farooq/shared";
import { RequireInvoicesAccess } from "../components/guard";
import { CancelInvoiceDialog, useAfterInvoiceChange } from "../components/invoice-dialogs";
import {
  ChargesSection,
  fmtBags,
  LinesEditor,
  paidRules,
  ProductPicker,
  ShopSection,
  ShortBadge,
  StockWarning,
  SummaryRows,
} from "../components/invoice-builder-parts";
import { UnsavedChangesDialog, useUnsavedGuard } from "../components/unsaved-guard";
import { Banner, Button, cn, Dialog, ErrorLines, Field, inputClass, Loading, NotAvailable, useToast } from "../components/ui";
import { useAuth } from "../lib/auth";
import { canCreateInvoice, canDiscardDraft, canReceive, canSeeProfit, notAvailableTitle } from "../lib/access";
import { ApiError } from "../lib/api";
import { fmtMoney } from "../lib/format";
import { newIdempotencyKey } from "../lib/ids";
import {
  blankForm,
  defaultRateText,
  detailToForm,
  formReducer,
  formToSavePayload,
  formTotals,
  isDirty,
  newLineKey,
  ownBagsBack,
  shortLineCount,
  splitErrors,
  stockByPair,
  type FormLine,
  type InvoiceForm,
} from "../lib/invoice-form";
import { invoiceTitle } from "../lib/invoice-view";
import { getBalance, getInvoice, getProductsByIds, getWarehouses, keys, saveInvoice } from "../lib/queries";

/* ── the two routes ───────────────────────────────────────────────────────────────────────────── */

export function InvoiceNewPage() {
  return (
    <RequireInvoicesAccess>
      <NewInvoiceScreen />
    </RequireInvoicesAccess>
  );
}

export function InvoiceEditPage() {
  return (
    <RequireInvoicesAccess>
      <EditInvoiceScreen />
    </RequireInvoicesAccess>
  );
}

function BackLink({ to }: { to: { id: string } | null }) {
  return to ? (
    <Link to="/invoices/$id" params={{ id: to.id }} className="text-sm text-(--color-primary) hover:underline">
      ← Back to the invoice
    </Link>
  ) : (
    <Link to="/invoices" className="text-sm text-(--color-primary) hover:underline">
      ← All invoices
    </Link>
  );
}

function NewInvoiceScreen() {
  const { user } = useAuth();
  const warehouses = useQuery({ queryKey: keys.warehouses, queryFn: getWarehouses, staleTime: 5 * 60_000 });
  if (!user) return null;
  if (!canCreateInvoice(user.role)) {
    return (
      <NotAvailable title={notAvailableTitle(user.role)}>
        New invoices are made by the owner, a manager or a salesperson. You can still open, print and correct invoices.
      </NotAvailable>
    );
  }
  if (warehouses.isPending) return <Loading label="Loading…" />;
  if (warehouses.isError) return <ErrorLines error={warehouses.error} onRetry={() => void warehouses.refetch()} />;
  const first = warehouses.data.find((w) => w.active);
  if (!first) {
    return (
      <div className="space-y-3">
        <BackLink to={null} />
        <Banner tone="warn" title="There is no warehouse to sell from">
          Add a warehouse first — every invoice says which godown its bags leave from.
        </Banner>
      </div>
    );
  }
  return <BuilderScreen invoice={null} initial={blankForm(first.id)} warehouses={warehouses.data} />;
}

function EditInvoiceScreen() {
  const { id } = useParams({ from: "/shell/invoices/$id/edit" });
  // Loaded once and NOT refreshed behind the person's back (a refetch with newer data must never replace a form being edited): a fresh copy is only ever fetched by "Reload".
  const q = useQuery({
    queryKey: ["invoice-edit", id],
    queryFn: () => getInvoice(id),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
  const warehouses = useQuery({ queryKey: keys.warehouses, queryFn: getWarehouses, staleTime: 5 * 60_000 });
  const [reloaded, setReloaded] = useState(false); // after "Reload" the person has already agreed to edit: no second question

  if (q.isPending || warehouses.isPending) return <Loading label="Loading invoice…" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <BackLink to={null} />
        {notFound ? <Banner tone="warn" title="Invoice not found">This invoice does not exist (or the address is wrong).</Banner> : <ErrorLines error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  if (warehouses.isError) return <ErrorLines error={warehouses.error} onRetry={() => void warehouses.refetch()} />;

  const inv = q.data;
  if (!inv.actions.edit.allowed) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <BackLink to={{ id: inv.id }} />
        <Banner tone="warn" title={`${invoiceTitle(inv.number)} cannot be edited`} data-testid="edit-refused">
          {inv.actions.edit.reason}
        </Banner>
      </div>
    );
  }
  return <BuilderScreen key={`${inv.id}:${q.dataUpdatedAt}`} invoice={inv} initial={detailToForm(inv, warehouses.data.find((w) => w.active)?.id ?? "")} warehouses={warehouses.data} askFirst={!reloaded} onReload={() => {
    setReloaded(true);
    void q.refetch();
  }} />;
}

/* ── the builder ──────────────────────────────────────────────────────────────────────────────── */

interface Failure {
  lines: string[];
  kind: "refused" | "network" | "forbidden" | "stale";
}

function failureOf(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.isNetwork) return { lines: error.lines, kind: "network" };
    if (error.status === 403) return { lines: error.lines, kind: "forbidden" };
    if (error.lines.includes(INVOICE_MESSAGES.stale)) return { lines: error.lines, kind: "stale" };
    return { lines: error.lines, kind: "refused" };
  }
  return { lines: [error instanceof Error ? error.message : "Something went wrong."], kind: "refused" };
}

function SaveErrors({ failure, onReload }: { failure: Failure; onReload?: (() => void) | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [failure]);
  const title =
    failure.kind === "network"
      ? "Could not reach the server — nothing was saved. Your form is exactly as you left it; try again."
      : failure.kind === "forbidden"
        ? "You are not allowed to save this — the whole save was refused and nothing was changed"
        : "This invoice cannot be saved yet — nothing has been changed";
  return (
    <div ref={ref}>
      <Banner tone="error" title={title} data-testid="save-errors">
        <ul className="list-disc space-y-0.5 pl-5">
          {failure.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {failure.kind === "stale" && onReload ? (
          <Button size="sm" className="mt-2" onClick={onReload} data-testid="reload-invoice">
            Reload the invoice
          </Button>
        ) : null}
      </Banner>
    </div>
  );
}

function Card({ title, aside, children, testId }: { title: string; aside?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface)" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--color-border) px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function BuilderScreen({ invoice, initial, warehouses, onReload, askFirst = true }: { invoice: InvoiceDetail | null; initial: InvoiceForm; warehouses: WarehouseItem[]; onReload?: () => void; askFirst?: boolean }) {
  const { user } = useAuth();
  const role = user!.role;
  const navigate = useNavigate();
  const toast = useToast();
  const after = useAfterInvoiceChange();

  const posted = invoice !== null && invoice.status !== "DRAFT";
  const savedDraft = invoice !== null && invoice.status === "DRAFT";

  const [form, dispatch] = useReducer(formReducer, initial);
  const [snapshot, setSnapshot] = useState(initial);
  const dirty = isDirty(form, snapshot);
  const guard = useUnsavedGuard(dirty);

  const [gate, setGate] = useState(posted && askFirst); // editing a posted invoice asks first
  const [discarding, setDiscarding] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const clearFocus = useCallback(() => setFocusKey(null), []);

  /* what is known about the products on the lines: what the picker returned, plus a fetch for the ones already on the invoice */
  const [known, setKnown] = useState<ReadonlyMap<string, ProductPickItem>>(new Map());
  const missing = useMemo(() => [...new Set(form.lines.map((l) => l.productId))].filter((id) => !known.has(id)).sort(), [form.lines, known]);
  const fetched = useQuery({ queryKey: keys.productsByIds(missing), queryFn: () => getProductsByIds(missing), enabled: missing.length > 0, staleTime: 30_000 });
  useEffect(() => {
    if (!fetched.data) return;
    setKnown((prev) => {
      const next = new Map(prev);
      for (const p of fetched.data) next.set(p.id, p);
      return next;
    });
  }, [fetched.data]);

  const totals = useMemo(() => formTotals(form), [form]);
  const ownBack = useMemo(() => (invoice ? ownBagsBack(invoice) : new Map<string, number>()), [invoice]);
  const stock = useMemo(() => stockByPair(form, known, ownBack), [form, known, ownBack]);
  const shortCount = shortLineCount(form, stock);
  const errors = useMemo(() => splitErrors(failure?.lines ?? []), [failure]);

  const shopId = form.customer?.id ?? null;
  const balance = useQuery({ queryKey: shopId ? keys.balance("customer", shopId) : ["balance", "none"], queryFn: () => getBalance("customer", shopId!), enabled: Boolean(shopId) && !posted });
  const previousBalanceP = posted ? invoice.previousBalanceP : (balance.data?.balanceP ?? null);
  const paid = paidRules({ canTakePayment: canReceive(role), posted, receivedP: invoice?.paidP ?? 0 });
  const showCost = canSeeProfit(role);

  const key = useRef(newIdempotencyKey());
  const busy = useRef(false);

  const save = useMutation({
    mutationFn: async (mode: "draft" | "post") => {
      const built = formToSavePayload(form, { mode, idempotencyKey: key.current, ...(invoice ? { revision: invoice.revision } : {}) });
      if (!built.ok) throw new ApiError(422, built.errors[0] ?? "Check the figures.", built.errors);
      return saveInvoice(built.payload, invoice?.id);
    },
    onMutate: () => setFailure(null),
    onSuccess: async (saved, mode) => {
      guard.allowLeave();
      key.current = newIdempotencyKey(); // the next save is a new save
      setSnapshot(form);
      await after();
      toast(
        posted
          ? `${saved.number ?? "The invoice"} updated — stock and the shop’s balance follow the change.`
          : mode === "draft"
            ? "Draft saved. It has no number yet and has not touched stock or the shop’s balance."
            : `${saved.number ?? "The invoice"} posted. Stock and the shop’s balance are updated.`,
      );
      void navigate({ to: "/invoices/$id", params: { id: saved.id } });
    },
    onError: (e) => setFailure(failureOf(e)),
    onSettled: () => {
      busy.current = false;
    },
  });

  function submit(mode: "draft" | "post") {
    if (busy.current || save.isPending) return; // double click: one request
    busy.current = true;
    save.mutate(mode);
  }

  function addLine(p: ProductPickItem) {
    const line: FormLine = { key: newLineKey(), productId: p.id, quantity: "", rate: defaultRateText(p), discount: "", warehouseId: form.warehouseId, taxP: 0, unit: p.unit ?? "", batchNo: "", notes: "" };
    setKnown((prev) => new Map(prev).set(p.id, p));
    dispatch({ type: "addLine", line });
    setFocusKey(line.key);
  }

  const headerWarehouses = warehouses.filter((w) => w.active || w.id === form.warehouseId);
  const title = posted ? `Edit ${invoiceTitle(invoice.number)}` : savedDraft ? "Edit draft" : "New invoice";
  const saving = save.isPending;

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-4" data-testid="invoice-builder">
      <BackLink to={invoice ? { id: invoice.id } : null} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold" data-testid="builder-title">
          {title}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <ShortBadge count={shortCount} />
          {dirty ? (
            <span className="text-xs text-(--color-text-muted)" data-testid="dirty-note">
              Unsaved changes
            </span>
          ) : null}
        </div>
      </div>

      {failure ? <SaveErrors failure={failure} onReload={onReload} /> : null}
      <StockWarning count={shortCount} />

      <div className="min-w-0 space-y-4">
        <div className="min-w-0 space-y-4">
          <Card title="Invoice">
            <div className="space-y-4">
              <ShopSection form={form} dispatch={dispatch} locked={posted} invalid={Boolean(failure?.lines.includes(INVOICE_MESSAGES.chooseShop))} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Warehouse">
                  <select value={form.warehouseId} onChange={(e) => dispatch({ type: "headerWarehouse", warehouseId: e.target.value })} className={inputClass} data-testid="header-warehouse">
                    {headerWarehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Date">
                  <input type="date" value={form.date} onChange={(e) => dispatch({ type: "field", field: "date", value: e.target.value })} className={inputClass} data-testid="field-date" />
                </Field>
                <Field label="Due date">
                  <input type="date" value={form.dueDate} onChange={(e) => dispatch({ type: "field", field: "dueDate", value: e.target.value })} className={inputClass} />
                </Field>
                <Field label="Order number">
                  <input value={form.orderNumber} onChange={(e) => dispatch({ type: "field", field: "orderNumber", value: e.target.value })} maxLength={60} placeholder="Optional" className={cn(inputClass, "font-mono")} />
                </Field>
              </div>
            </div>
          </Card>

          <Card
            title="Items"
            testId="items-card"
            aside={
              <span className="text-xs text-(--color-text-muted)" data-testid="items-count">
                {totals.lineCount} line{totals.lineCount === 1 ? "" : "s"} · {fmtBags(milliToQty(totals.totalQtyMilli))} bags
              </span>
            }
          >
            <div className="space-y-4">
              <ProductPicker warehouseId={form.warehouseId} onAdd={addLine} />
              <LinesEditor
                form={form}
                dispatch={dispatch}
                products={known}
                invoice={invoice}
                stock={stock}
                totals={totals}
                warehouses={warehouses.filter((w) => w.active || form.lines.some((l) => l.warehouseId === w.id))}
                showCost={showCost}
                errorsByLine={errors.byLine}
                focusKey={focusKey}
                onFocused={clearFocus}
              />
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Card title={paid.disabled ? "Charges" : "Charges & payment"}>
              <ChargesSection form={form} dispatch={dispatch} paid={paid} totals={totals} />
            </Card>
            <aside className="min-w-0 space-y-3 lg:self-start" data-testid="summary-aside">
              <Card title="Summary" testId="summary-card">
                <SummaryRows totals={totals} previousBalanceP={previousBalanceP} />
              </Card>
              <p className="text-xs text-(--color-text-muted)">
                Every line is checked against warehouse stock before anything is written. If one line is short, nothing is posted.
              </p>
            </aside>
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 z-10 -mx-3 border-t border-(--color-border) bg-(--color-surface) px-3 py-2 shadow-[0_-2px_8px_rgba(0,0,0,0.06)] sm:-mx-6 sm:px-6" data-testid="sticky-bar">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
          <p className="text-sm" data-testid="sticky-total">
            <span className="text-(--color-text-muted)">Grand total </span>
            <b className="num text-base">{fmtMoney(totals.grandTotalP)}</b>
            {totals.paidP > 0 ? <span className="text-(--color-text-muted)"> · paid {fmtMoney(totals.paidP)}</span> : null}
          </p>
          <div className="flex flex-wrap gap-2">
            {posted ? (
              <Link to="/invoices/$id" params={{ id: invoice.id }} className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)" data-testid="cancel-editing">
                Cancel editing
              </Link>
            ) : savedDraft ? (
              canDiscardDraft(role) ? (
                <Button onClick={() => setDiscarding(true)} data-testid="discard">
                  Discard draft
                </Button>
              ) : null
            ) : (
              <Link to="/invoices" className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)" data-testid="discard">
                Discard
              </Link>
            )}
            {!posted ? (
              <Button onClick={() => submit("draft")} disabled={saving} data-testid="save-draft">
                {saving && save.variables === "draft" ? "Saving draft…" : "Save draft"}
              </Button>
            ) : null}
            <Button variant="primary" size="md" onClick={() => submit("post")} disabled={saving} data-testid="save-post" className="min-w-32">
              {saving && save.variables === "post" ? "Saving…" : posted ? "Save changes" : "Post invoice"}
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={gate}
        onClose={() => void navigate({ to: "/invoices/$id", params: { id: invoice?.id ?? "" } })}
        title="Edit a confirmed invoice?"
        description="Editing it will adjust stock and the shop’s balance by the difference, and the change is recorded in the audit log."
      >
        <div className="flex justify-end gap-2">
          <Link to="/invoices/$id" params={{ id: invoice?.id ?? "" }} className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)" data-testid="gate-cancel">
            Cancel
          </Link>
          <Button variant="primary" onClick={() => setGate(false)} data-testid="gate-continue">
            Continue editing
          </Button>
        </div>
      </Dialog>

      {discarding && invoice ? <CancelInvoiceDialog invoice={invoice} onClose={() => setDiscarding(false)} onDone={guard.allowLeave} /> : null}
      <UnsavedChangesDialog open={guard.blocked} onStay={guard.stay} onLeave={guard.leave} />
    </div>
  );
}

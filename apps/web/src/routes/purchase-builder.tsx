import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { milliToQty, PURCHASE_MESSAGES, rupeesText, type ProductPickItem, type PurchaseDetail, type PurchaseRate, type WarehouseItem } from "@farooq/shared";
import { RequirePurchasesAccess } from "../components/guard";
import { fmtBags, ProductPicker } from "../components/invoice-builder-parts";
import { PurchaseChargesSection, PurchaseLinesEditor, PurchaseSummaryRows, ReceivedBanner, SupplierSection } from "../components/purchase-builder-parts";
import { UnsavedChangesDialog, useUnsavedGuard } from "../components/unsaved-guard";
import { Banner, Button, Card, cn, Dialog, ErrorLines, Field, inputClass, Loading, NotAvailable, useToast } from "../components/ui";
import { canCreatePurchase, canPayOut, notAvailableTitle } from "../lib/access";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtMoney } from "../lib/format";
import { newIdempotencyKey } from "../lib/ids";
import { splitErrors } from "../lib/invoice-form";
import {
  bagTotals,
  blankPurchaseForm,
  isPurchaseDirty,
  newPurchaseLine,
  paidBelowPaid,
  purchaseDetailToForm,
  purchaseFormReducer,
  purchaseFormToSavePayload,
  purchaseFormTotals,
  purchasePaidRules,
  receivedState,
  saveLabel,
  type PurchaseForm,
} from "../lib/purchase-form";
import { getProductsByIds, getPurchase, getPurchaseRates, getWarehouses, keys, savePurchase } from "../lib/queries";

/* ── the two routes ───────────────────────────────────────────────────────────────────────────── */

export function PurchaseNewPage() {
  return (
    <RequirePurchasesAccess>
      <NewPurchaseScreen />
    </RequirePurchasesAccess>
  );
}

export function PurchaseEditPage() {
  return (
    <RequirePurchasesAccess>
      <EditPurchaseScreen />
    </RequirePurchasesAccess>
  );
}

function BackLink({ to }: { to: { id: string } | null }) {
  return to ? (
    <Link to="/purchases/$id" params={{ id: to.id }} className="text-sm text-(--color-primary) hover:underline">
      ← Back to the purchase
    </Link>
  ) : (
    <Link to="/purchases" className="text-sm text-(--color-primary) hover:underline">
      ← All purchases
    </Link>
  );
}

function NewPurchaseScreen() {
  const { user } = useAuth();
  const warehouses = useQuery({ queryKey: keys.warehouses, queryFn: getWarehouses, staleTime: 5 * 60_000 });
  if (!user) return null;
  if (!canCreatePurchase(user.role)) {
    return (
      <NotAvailable title={notAvailableTitle(user.role)}>
        New purchases are recorded by the owner or a manager. You can still open, print and correct recorded purchases.
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
        <Banner tone="warn" title="There is no warehouse to receive into">
          Add a warehouse first — every purchase says which godown its bags go to.
        </Banner>
      </div>
    );
  }
  return <BuilderScreen purchase={null} initial={blankPurchaseForm(first.id)} warehouses={warehouses.data} />;
}

function EditPurchaseScreen() {
  const { id } = useParams({ from: "/shell/purchases/$id/edit" });
  // Loaded once and NOT refreshed behind the person's back (a refetch with newer data must never replace a form being edited): a fresh copy is only ever fetched by "Reload".
  const q = useQuery({
    queryKey: ["purchase-edit", id],
    queryFn: () => getPurchase(id),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2,
  });
  const warehouses = useQuery({ queryKey: keys.warehouses, queryFn: getWarehouses, staleTime: 5 * 60_000 });
  const [reloaded, setReloaded] = useState(false); // after "Reload" the person has already agreed to edit: no second question

  if (q.isPending || warehouses.isPending) return <Loading label="Loading purchase…" />;
  if (q.isError) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return (
      <div className="space-y-3">
        <BackLink to={null} />
        {notFound ? <Banner tone="warn" title="Purchase not found">This purchase does not exist (or the address is wrong).</Banner> : <ErrorLines error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  if (warehouses.isError) return <ErrorLines error={warehouses.error} onRetry={() => void warehouses.refetch()} />;

  const pu = q.data;
  if (!pu.actions.edit.allowed) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <BackLink to={{ id: pu.id }} />
        <Banner tone="warn" title={`${pu.number ?? "This purchase"} cannot be edited`} data-testid="edit-refused">
          {pu.actions.edit.reason}
        </Banner>
      </div>
    );
  }
  return (
    <BuilderScreen
      key={`${pu.id}:${q.dataUpdatedAt}`}
      purchase={pu}
      initial={purchaseDetailToForm(pu, warehouses.data.find((w) => w.active)?.id ?? "")}
      warehouses={warehouses.data}
      askFirst={!reloaded}
      onReload={() => {
        setReloaded(true);
        void q.refetch();
      }}
    />
  );
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
    if (error.lines.includes(PURCHASE_MESSAGES.stale) || error.lines.includes(PURCHASE_MESSAGES.revisionRequired)) return { lines: error.lines, kind: "stale" };
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
        : "This purchase cannot be saved yet — nothing has been changed";
  return (
    <div ref={ref}>
      <Banner tone="error" title={title} data-testid="save-errors">
        <ul className="list-disc space-y-0.5 pl-5">
          {failure.lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {failure.kind === "stale" && onReload ? (
          <Button size="sm" className="mt-2" onClick={onReload} data-testid="reload-purchase">
            Reload the purchase
          </Button>
        ) : null}
      </Banner>
    </div>
  );
}

function BuilderScreen({ purchase, initial, warehouses, onReload, askFirst = true }: { purchase: PurchaseDetail | null; initial: PurchaseForm; warehouses: WarehouseItem[]; onReload?: () => void; askFirst?: boolean }) {
  const { user } = useAuth();
  const role = user!.role;
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  const editing = purchase !== null;

  const [form, dispatch] = useReducer(purchaseFormReducer, initial);
  const [snapshot, setSnapshot] = useState(initial);
  const dirty = isPurchaseDirty(form, snapshot);
  const guard = useUnsavedGuard(dirty);

  const [gate, setGate] = useState(editing && askFirst); // editing a recorded purchase asks first (legacy)
  const [failure, setFailure] = useState<Failure | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const clearFocus = useCallback(() => setFocusKey(null), []);

  /* what is known about the products on the lines: what the picker returned, plus a fetch for the ones already on the purchase */
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

  /* the last rate each product was bought at (legacy `lastRate`): a starting rate for a new line and a hint under every line */
  const formRef = useRef(form);
  formRef.current = form;
  const rateIds = useMemo(() => [...new Set(form.lines.map((l) => l.productId))].sort().slice(0, 100), [form.lines]);
  const rateQuery = useQuery({ queryKey: keys.purchaseRates(rateIds), queryFn: () => getPurchaseRates(rateIds), enabled: rateIds.length > 0, staleTime: 30_000, placeholderData: (prev) => prev });
  const rates = useMemo(() => new Map<string, PurchaseRate>((rateQuery.data ?? []).map((r) => [r.productId, r])), [rateQuery.data]);
  /** Lines added while their product's last rate was not known yet: filled in when it arrives, only while their rate box is still empty. */
  const awaitingRate = useRef(new Set<string>());
  useEffect(() => {
    if (rateQuery.isPlaceholderData || !rateQuery.data || awaitingRate.current.size === 0) return;
    for (const l of formRef.current.lines) {
      if (!awaitingRate.current.has(l.key)) continue;
      awaitingRate.current.delete(l.key);
      const r = rates.get(l.productId);
      if (r && l.rate === "") dispatch({ type: "line", key: l.key, patch: { rate: rupeesText(r.unitPriceP) } });
    }
  }, [rateQuery.data, rateQuery.isPlaceholderData, rates]);

  const totals = useMemo(() => purchaseFormTotals(form), [form]);
  const bags = useMemo(() => bagTotals(form), [form]);
  const errors = useMemo(() => splitErrors(failure?.lines ?? []), [failure]);
  const paid = purchasePaidRules({ canPayOut: canPayOut(role), editing });
  const alreadyPaidP = purchase?.paidP ?? 0;
  const lowered = editing && paidBelowPaid(form, alreadyPaidP);
  const supplierLock = purchase && !purchase.actions.changeSupplier.allowed ? (purchase.actions.changeSupplier.reason ?? "The supplier cannot be changed.") : null;
  const anyNone = form.lines.some((l) => receivedState(l) === "none");

  const key = useRef(newIdempotencyKey());
  const busy = useRef(false);

  const save = useMutation({
    mutationFn: async () => {
      const built = purchaseFormToSavePayload(form, { idempotencyKey: key.current, ...(purchase ? { revision: purchase.revision } : {}) });
      if (!built.ok) throw new ApiError(422, built.errors[0] ?? "Check the figures.", built.errors);
      return savePurchase(built.payload, purchase?.id);
    },
    onMutate: () => setFailure(null),
    onSuccess: async (saved) => {
      guard.allowLeave();
      key.current = newIdempotencyKey(); // the next save is a new save
      setSnapshot(form);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.purchases }),
        qc.invalidateQueries({ queryKey: keys.payments }),
        qc.invalidateQueries({ queryKey: ["balance"] }),
        qc.invalidateQueries({ queryKey: ["outstanding"] }),
        qc.invalidateQueries({ queryKey: ["statement"] }),
        qc.invalidateQueries({ queryKey: keys.products }),
      ]);
      toast(
        editing
          ? `Purchase ${saved.number ? `${saved.number} ` : ""}updated — stock and the supplier balance follow the change.`
          : `${saved.number ?? "The purchase"} saved — the bags received are in stock and the supplier’s balance is updated.`,
      );
      void navigate({ to: "/purchases/$id", params: { id: saved.id } });
    },
    onError: (e) => setFailure(failureOf(e)),
    onSettled: () => {
      busy.current = false;
    },
  });

  function submit() {
    if (busy.current || save.isPending) return; // double click: one request
    busy.current = true;
    save.mutate();
  }

  function addLine(p: ProductPickItem) {
    const lastRate = rates.get(p.id);
    const line = newPurchaseLine(p, form.warehouseId, lastRate ? rupeesText(lastRate.unitPriceP) : "");
    if (!lastRate) awaitingRate.current.add(line.key);
    setKnown((prev) => new Map(prev).set(p.id, p));
    dispatch({ type: "addLine", line });
    setFocusKey(line.key);
  }

  const headerWarehouses = warehouses.filter((w) => w.active || w.id === form.warehouseId);
  const title = editing ? `Edit ${purchase.number ?? "purchase"}` : "Receive stock from a mill";
  const saving = save.isPending;

  return (
    <div className="mx-auto max-w-6xl space-y-4 pb-4" data-testid="purchase-builder">
      <BackLink to={purchase ? { id: purchase.id } : null} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold" data-testid="builder-title">
          {title}
        </h1>
        {dirty ? (
          <span className="text-xs text-(--color-text-muted)" data-testid="dirty-note">
            Unsaved changes
          </span>
        ) : null}
      </div>

      {failure ? <SaveErrors failure={failure} onReload={onReload} /> : null}

      <div className="min-w-0 space-y-4">
        <Card title="Purchase">
          <div className="space-y-4">
            <SupplierSection form={form} dispatch={dispatch} lockReason={supplierLock} invalid={Boolean(failure?.lines.includes(PURCHASE_MESSAGES.chooseSupplier))} />
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
              <Field label="Supplier invoice / bilty">
                <input value={form.supplierInvoiceNo} onChange={(e) => dispatch({ type: "field", field: "supplierInvoiceNo", value: e.target.value })} maxLength={100} placeholder="Optional" className={cn(inputClass, "font-mono")} data-testid="field-supplierInvoiceNo" />
              </Field>
              <Field label="Vehicle number">
                <input value={form.vehicleNo} onChange={(e) => dispatch({ type: "field", field: "vehicleNo", value: e.target.value })} maxLength={40} placeholder="Optional" className={cn(inputClass, "font-mono")} data-testid="field-vehicleNo" />
              </Field>
              <Field label="Driver">
                <input value={form.driver} onChange={(e) => dispatch({ type: "field", field: "driver", value: e.target.value })} maxLength={100} dir="auto" placeholder="Optional" className={inputClass} data-testid="field-driver" />
              </Field>
              <Field label="Delivery reference">
                <input value={form.deliveryRef} onChange={(e) => dispatch({ type: "field", field: "deliveryRef", value: e.target.value })} maxLength={100} placeholder="Optional" className={cn(inputClass, "font-mono")} data-testid="field-deliveryRef" />
              </Field>
            </div>
          </div>
        </Card>

        <Card
          title="Items"
          testId="items-card"
          aside={
            <span className="text-xs text-(--color-text-muted)" data-testid="items-count">
              {totals.lineCount} line{totals.lineCount === 1 ? "" : "s"} · {fmtBags(milliToQty(bags.orderedMilli))} ordered · {fmtBags(milliToQty(bags.receivedMilli))} into stock
            </span>
          }
        >
          <div className="space-y-4">
            <ReceivedBanner />
            {anyNone ? (
              <Banner tone="warn" title="Some lines have nothing received" data-testid="none-banner">
                Those lines are booked on the supplier’s account but put no bags into stock. Do not also record the delivery in the warehouse.
              </Banner>
            ) : null}
            <ProductPicker warehouseId={form.warehouseId} onAdd={addLine} />
            <PurchaseLinesEditor
              form={form}
              dispatch={dispatch}
              products={known}
              purchase={purchase}
              totals={totals}
              warehouses={warehouses.filter((w) => w.active || form.lines.some((l) => l.warehouseId === w.id))}
              rates={rates}
              errorsByLine={errors.byLine}
              focusKey={focusKey}
              onFocused={clearFocus}
            />
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <Card title={paid.disabled ? "Charges" : "Charges & payment"}>
            <PurchaseChargesSection form={form} dispatch={dispatch} paid={paid} totals={totals} editing={editing} />
            {lowered ? (
              <p role="alert" className="mt-2 text-sm text-(--color-danger)" data-testid="paid-lowered">
                {fmtMoney(alreadyPaidP)} has already been paid against this purchase. The amount paid cannot be lowered here — reverse that payment voucher from Payments instead.
              </p>
            ) : null}
          </Card>
          <aside className="min-w-0 space-y-3 lg:self-start" data-testid="summary-aside">
            <Card title="Summary" testId="summary-card">
              <PurchaseSummaryRows totals={totals} bags={bags} />
            </Card>
            <p className="text-xs text-(--color-text-muted)">The bill is for the ordered bags. Only the bags received go into stock, and the average cost of each product is worked out again when you save.</p>
          </aside>
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
            {purchase ? (
              <Link to="/purchases/$id" params={{ id: purchase.id }} className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)" data-testid="cancel-editing">
                Cancel editing
              </Link>
            ) : (
              <Link to="/purchases" className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)" data-testid="discard">
                Discard
              </Link>
            )}
            <Button variant="primary" size="md" onClick={submit} disabled={saving} data-testid="save-purchase" className="min-w-40">
              {saving ? "Saving…" : saveLabel(form, editing)}
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={gate}
        onClose={() => void navigate({ to: "/purchases/$id", params: { id: purchase?.id ?? "" } })}
        title="Edit a purchase that is already in stock?"
        description="Editing it will adjust stock and the supplier balance by the difference, and the change is recorded in the audit log."
      >
        <div className="flex justify-end gap-2">
          <Link to="/purchases/$id" params={{ id: purchase?.id ?? "" }} className="rounded-md border border-(--color-border) bg-(--color-surface) px-3.5 py-2 text-sm font-medium text-(--color-text)" data-testid="gate-cancel">
            Cancel
          </Link>
          <Button variant="primary" onClick={() => setGate(false)} data-testid="gate-continue">
            Continue editing
          </Button>
        </div>
      </Dialog>

      <UnsavedChangesDialog open={guard.blocked} onStay={guard.stay} onLeave={guard.leave} noun="purchase" />
    </div>
  );
}

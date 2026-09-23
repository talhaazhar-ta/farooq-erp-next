import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { invoices, purchases, type Executor } from "@farooq/db";

/**
 * "Paid / outstanding" — ported from the legacy `Invoices.paidFor / outstanding / refreshPaymentState`.
 *
 *   paid        = Σ allocations of POSTED payments. (The legacy DELETED a reversed payment's allocation rows;
 *                 here they are kept as history, so a REVERSED payment is excluded explicitly.)
 *   invoice     outstanding = grandTotal − paid − Σ credit of non-CANCELLED customer returns linked to the invoice
 *   purchase    outstanding = total − paid
 */

export interface OutstandingRow {
  id: string;
  number: string | null;
  date: string;
  status: string;
  createdAt: Date;
  totalP: number;
  paidP: number;
  creditP: number;
  outstandingP: number;
}

// The correlated subqueries name the outer table explicitly: drizzle omits the qualifier in a single-table select,
// which would make a bare "id" ambiguous against payments/returns inside the subquery.
const PAID_INVOICE = sql<string>`COALESCE((SELECT SUM(a.amount_p) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.invoice_id = "invoices"."id" AND p.status = 'POSTED'), 0)`;
const CREDIT_INVOICE = sql<string>`COALESCE((SELECT SUM(r.total_p) FROM returns r WHERE r.invoice_id = "invoices"."id" AND r.kind = 'CUSTOMER' AND r.status <> 'CANCELLED'), 0)`;
const PAID_PURCHASE = sql<string>`COALESCE((SELECT SUM(a.amount_p) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.purchase_id = "purchases"."id" AND p.status = 'POSTED'), 0)`;

/** Invoices that can never be collected against. */
export const NOT_COLLECTABLE = ["DRAFT", "CANCELLED"] as const;
/** Statuses `refreshPaymentState` leaves alone. */
const STATUS_FROZEN: readonly string[] = ["CANCELLED", "DRAFT", "RETURNED", "PARTIALLY_RETURNED"];

/** The legacy sort for oldest-first allocation, with the ties the legacy left unstable pinned down. */
export function byOldestFirst(a: OutstandingRow, b: OutstandingRow): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const ac = a.createdAt.getTime();
  const bc = b.createdAt.getTime();
  if (ac !== bc) return ac < bc ? -1 : 1;
  const an = a.number ?? "";
  const bn = b.number ?? "";
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `Calc.paymentStatus` + the mapping `refreshPaymentState` applies to the invoice's `status`. */
export function invoiceStatusFor(totalP: number, paidP: number): "CONFIRMED" | "PARTIALLY_PAID" | "PAID" {
  if (totalP <= 0) return "CONFIRMED"; // paymentStatus UNPAID
  if (paidP >= totalP) return "PAID";
  return paidP > 0 ? "PARTIALLY_PAID" : "CONFIRMED";
}

/** Locks the given invoices (`FOR UPDATE`, ordered by id so two transactions can't deadlock) and returns those that exist. */
export async function lockInvoices(
  tx: Executor,
  ids: string[],
): Promise<{ id: string; customerId: string | null; status: string; number: string | null }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: invoices.id, customerId: invoices.customerId, status: invoices.status, number: invoices.invoiceNumber })
    .from(invoices)
    .where(inArray(invoices.id, ids))
    .orderBy(asc(invoices.id))
    .for("update");
}

/** Locks every collectable invoice of one shop (the auto-allocation candidates). */
export async function lockCustomerInvoices(tx: Executor, customerId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), notInArray(invoices.status, [...NOT_COLLECTABLE])))
    .orderBy(asc(invoices.id))
    .for("update");
  return rows.map((r) => r.id);
}

export async function lockPurchases(
  tx: Executor,
  ids: string[],
): Promise<{ id: string; supplierId: string | null; status: string; number: string | null }[]> {
  if (ids.length === 0) return [];
  return tx
    .select({ id: purchases.id, supplierId: purchases.supplierId, status: purchases.status, number: purchases.purchaseNumber })
    .from(purchases)
    .where(inArray(purchases.id, ids))
    .orderBy(asc(purchases.id))
    .for("update");
}

interface RawOutstanding {
  id: string;
  number: string | null;
  date: string;
  status: string;
  createdAt: Date;
  totalP: number;
  paid: string;
  credit: string;
}

const toRow = (r: RawOutstanding): OutstandingRow => {
  const paidP = Number(r.paid);
  const creditP = Number(r.credit);
  return {
    id: r.id,
    number: r.number,
    date: r.date,
    status: r.status,
    createdAt: r.createdAt,
    totalP: r.totalP,
    paidP,
    creditP,
    outstandingP: r.totalP - paidP - creditP,
  };
};

const invoiceColumns = {
  id: invoices.id,
  number: invoices.invoiceNumber,
  date: invoices.date,
  status: invoices.status,
  createdAt: invoices.createdAt,
  totalP: invoices.totalP,
  paid: PAID_INVOICE,
  credit: CREDIT_INVOICE,
};

const purchaseColumns = {
  id: purchases.id,
  number: purchases.purchaseNumber,
  date: purchases.date,
  status: purchases.status,
  createdAt: purchases.createdAt,
  totalP: purchases.totalP,
  paid: PAID_PURCHASE,
};

/** Paid / credit / outstanding for the named invoices (any shop). Read after locking them to see a settled picture. */
export async function invoiceOutstanding(db: Executor, ids: string[]): Promise<OutstandingRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.select(invoiceColumns).from(invoices).where(inArray(invoices.id, ids));
  return rows.map(toRow);
}

/** Every collectable invoice of a shop, oldest first, with its outstanding (rows with nothing outstanding included). */
export async function customerInvoiceOutstanding(db: Executor, customerId: string): Promise<OutstandingRow[]> {
  const rows = await db
    .select(invoiceColumns)
    .from(invoices)
    .where(and(eq(invoices.customerId, customerId), notInArray(invoices.status, [...NOT_COLLECTABLE])));
  return rows.map(toRow).sort(byOldestFirst);
}

export async function purchaseOutstanding(db: Executor, ids: string[]): Promise<OutstandingRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.select(purchaseColumns).from(purchases).where(inArray(purchases.id, ids));
  return rows.map((r) => toRow({ ...r, credit: "0" }));
}

/** Every non-CANCELLED purchase of a supplier, oldest first. */
export async function supplierPurchaseOutstanding(db: Executor, supplierId: string): Promise<OutstandingRow[]> {
  const rows = await db
    .select(purchaseColumns)
    .from(purchases)
    .where(and(eq(purchases.supplierId, supplierId), notInArray(purchases.status, ["CANCELLED"])));
  return rows.map((r) => toRow({ ...r, credit: "0" })).sort(byOldestFirst);
}

/**
 * The legacy `Invoices.refreshPaymentState` for each invoice: recompute `status` from the allocations of POSTED
 * payments (returns credit is deliberately NOT subtracted here, as in the legacy), leaving CANCELLED / DRAFT /
 * RETURNED / PARTIALLY_RETURNED untouched. Call after locking the invoices.
 */
export async function refreshInvoiceStatuses(tx: Executor, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const rows = await invoiceOutstanding(tx, unique);
  for (const r of rows) {
    if (STATUS_FROZEN.includes(r.status)) continue;
    const status = invoiceStatusFor(r.totalP, r.paidP);
    if (status !== r.status) await tx.update(invoices).set({ status }).where(eq(invoices.id, r.id));
  }
}

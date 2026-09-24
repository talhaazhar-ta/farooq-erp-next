import { and, asc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  customers,
  invoiceItems,
  invoices,
  paymentAllocations,
  payments,
  purchases,
  regions,
  suppliers,
  type Executor,
} from "@farooq/db";
import {
  lineSummary,
  roleHasPermission,
  type ListPaymentsQuery,
  type PaymentKind,
  type OutstandingDocument,
  type PartyLookupItem,
  type PartyLookupQuery,
  type PaymentDetail,
  type PaymentListItem,
  type PaymentListResponse,
  type PaymentVoucher,
  type Role,
} from "@farooq/shared";
import {
  customerInvoiceOutstanding,
  supplierPurchaseOutstanding,
  type OutstandingRow,
} from "./outstanding.js";
import { searchPayments } from "./payments.search.js";
import { editAmountRefusal, REVERSE_MESSAGES } from "./rules.js";

/**
 * Read side of payments. Every function takes an `Executor` (the pool or an open transaction), so the write
 * service can build its response from inside the same transaction.
 */

type PaymentRow = typeof payments.$inferSelect;

/** The legacy `dirOf`: which of the three lists a voucher belongs to, whatever its status. */
export const kindOf = (p: { direction: string; partyType: string }): PaymentKind =>
  p.direction === "IN" ? "received" : p.partyType === "CUSTOMER" ? "paidToShops" : "paidToSuppliers";

function toVoucher(p: PaymentRow, partyName: string | null, allocatedP: number): PaymentVoucher {
  return {
    id: p.id,
    receiptNumber: p.receiptNumber,
    direction: p.direction as PaymentVoucher["direction"],
    partyType: p.partyType as PaymentVoucher["partyType"],
    partyId: p.partyId,
    partyName,
    kind: kindOf(p),
    partyNameSnapshot: p.partyNameSnapshot,
    partyOwnerSnapshot: p.partyOwnerSnapshot,
    regionSnapshot: p.regionSnapshot,
    isRefund: p.isRefund,
    amountP: p.amountP,
    method: p.method,
    reference: p.reference,
    note: p.note,
    paymentDate: p.paymentDate,
    status: p.status as PaymentVoucher["status"],
    receivedBy: p.receivedBy,
    createdAt: p.createdAt.toISOString(),
    createdBy: p.createdBy,
    reversedAt: p.reversedAt ? p.reversedAt.toISOString() : null,
    reversedBy: p.reversedBy,
    reverseReason: p.reverseReason,
    allocatedP,
    unallocatedP: p.amountP - allocatedP,
  };
}

const partyNameOf = (r: { cn: string | null; sn: string | null }): string | null => r.cn ?? r.sn ?? null;

/** One voucher with its allocations, plus which actions `role` may take on it and why an action is refused. */
export async function loadPaymentDetail(db: Executor, id: string, role: Role): Promise<PaymentDetail | null> {
  const [row] = await db
    .select({ p: payments, cn: customers.shopName, sn: suppliers.companyName })
    .from(payments)
    .leftJoin(customers, and(eq(payments.partyType, "CUSTOMER"), eq(payments.partyId, customers.id)))
    .leftJoin(suppliers, and(eq(payments.partyType, "SUPPLIER"), eq(payments.partyId, suppliers.id)))
    .where(eq(payments.id, id))
    .limit(1);
  if (!row) return null;

  const allocs = await db
    .select({
      id: paymentAllocations.id,
      invoiceId: paymentAllocations.invoiceId,
      purchaseId: paymentAllocations.purchaseId,
      invoiceNumber: invoices.invoiceNumber,
      purchaseNumber: purchases.purchaseNumber,
      amountP: paymentAllocations.amountP,
    })
    .from(paymentAllocations)
    .leftJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
    .leftJoin(purchases, eq(paymentAllocations.purchaseId, purchases.id))
    .where(eq(paymentAllocations.paymentId, id))
    // Rows of one voucher share a created_at, so list them the way they were allocated: oldest document first.
    .orderBy(
      asc(paymentAllocations.createdAt),
      asc(sql`COALESCE(${invoices.date}, ${purchases.date})`),
      asc(sql`COALESCE(${invoices.invoiceNumber}, ${purchases.purchaseNumber})`),
      asc(paymentAllocations.id),
    );
  const allocatedP = allocs.reduce((a, x) => a + x.amountP, 0);

  const canCorrect = roleHasPermission(role, "TRANSACTION_CORRECT");
  const refusal = await editAmountRefusal(db, row.p);
  const reverseReason = !canCorrect
    ? "You do not have permission to reverse a voucher."
    : row.p.status === "REVERSED"
      ? REVERSE_MESSAGES.alreadyReversed
      : null;
  const editReason = !canCorrect ? "You do not have permission to correct a voucher’s amount." : refusal;

  return {
    ...toVoucher(row.p, partyNameOf(row), allocatedP),
    allocations: allocs.map((a) => ({
      id: a.id,
      invoiceId: a.invoiceId,
      purchaseId: a.purchaseId,
      documentNumber: a.invoiceNumber ?? a.purchaseNumber ?? null,
      amountP: a.amountP,
    })),
    actions: {
      reverse: { allowed: reverseReason === null, reason: reverseReason },
      editAmount: { allowed: editReason === null, reason: editReason },
    },
  };
}

/** Escapes LIKE wildcards so a search for "50%" or "a_b" matches literally. */
const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** A voucher as the list draws it, before it is mapped to the wire shape (the CSV needs a few more columns). */
export interface ListRow {
  p: PaymentRow;
  partyName: string | null;
  regionId: string | null;
  regionEn: string | null;
  regionUr: string | null;
  /** The invoice / purchase numbers it was applied to, oldest document first. */
  refs: string[];
  allocationCount: number;
  allocatedP: number;
}

/** Loads the given vouchers with their allocations, in the order of `ids`. */
export async function loadListRows(db: Executor, ids: string[]): Promise<ListRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ p: payments, cn: customers.shopName, sn: suppliers.companyName, regionId: customers.regionId, regionEn: regions.nameEn, regionUr: regions.nameUr })
    .from(payments)
    .leftJoin(customers, and(eq(payments.partyType, "CUSTOMER"), eq(payments.partyId, customers.id)))
    .leftJoin(regions, eq(customers.regionId, regions.id))
    .leftJoin(suppliers, and(eq(payments.partyType, "SUPPLIER"), eq(payments.partyId, suppliers.id)))
    .where(inArray(payments.id, ids));
  const allocs = await db
    .select({
      paymentId: paymentAllocations.paymentId,
      amountP: paymentAllocations.amountP,
      number: sql<string | null>`COALESCE(${invoices.invoiceNumber}, ${purchases.purchaseNumber})`,
    })
    .from(paymentAllocations)
    .leftJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
    .leftJoin(purchases, eq(paymentAllocations.purchaseId, purchases.id))
    .where(inArray(paymentAllocations.paymentId, ids))
    .orderBy(
      asc(paymentAllocations.createdAt),
      asc(sql`COALESCE(${invoices.date}, ${purchases.date})`),
      asc(sql`COALESCE(${invoices.invoiceNumber}, ${purchases.purchaseNumber})`),
      asc(paymentAllocations.id),
    );
  const byPayment = new Map<string, { refs: string[]; n: number; total: number }>();
  for (const a of allocs) {
    const e = byPayment.get(a.paymentId) ?? { refs: [], n: 0, total: 0 };
    if (a.number) e.refs.push(a.number);
    e.n += 1;
    e.total += a.amountP;
    byPayment.set(a.paymentId, e);
  }
  const byId = new Map(rows.map((r) => [r.p.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    const a = byPayment.get(id);
    return [{ p: r.p, partyName: partyNameOf(r), regionId: r.regionId, regionEn: r.regionEn, regionUr: r.regionUr, refs: a?.refs ?? [], allocationCount: a?.n ?? 0, allocatedP: a?.total ?? 0 }];
  });
}

const toListItem = (r: ListRow): PaymentListItem => ({
  ...toVoucher(r.p, r.partyName, r.allocatedP),
  allocationCount: r.allocationCount,
  appliedTo: r.refs,
  regionId: r.regionId,
  regionName: r.regionEn,
});

/** `GET /payments`: the search of legacy module 38, on the server. See payments.search.ts. */
export async function listPayments(db: Executor, q: ListPaymentsQuery): Promise<PaymentListResponse> {
  const { limit, offset, ...filters } = q;
  const found = await searchPayments(db, filters, { limit, offset });
  const items = (await loadListRows(db, found.ids)).map(toListItem);
  return { items, total: found.total, limit, offset, interpreted: found.interpreted, facets: found.facets, onFile: found.onFile };
}

/* ── picker lookups ─────────────────────────────────────────────────── */

export async function lookupCustomers(db: Executor, q: PartyLookupQuery): Promise<PartyLookupItem[]> {
  const pat = q.q ? likePattern(q.q) : null;
  const rows = await db
    .select({
      id: customers.id,
      name: customers.shopName,
      contact: customers.ownerName,
      phone: customers.phone,
      region: regions.nameEn,
      regionId: customers.regionId,
      active: customers.active,
    })
    .from(customers)
    .leftJoin(regions, eq(customers.regionId, regions.id))
    .where(
      and(
        q.regionId ? eq(customers.regionId, q.regionId) : undefined,
        pat ? or(ilike(customers.shopName, pat), ilike(customers.ownerName, pat), ilike(customers.phone, pat), ilike(customers.legacyCode, pat)) : undefined,
      ),
    )
    .orderBy(asc(customers.shopName), asc(customers.id))
    .limit(q.limit);
  return rows;
}

export async function lookupSuppliers(db: Executor, q: PartyLookupQuery): Promise<PartyLookupItem[]> {
  if (q.regionId) return []; // a region belongs to a shop; a supplier has none, so it cannot pass
  const pat = q.q ? likePattern(q.q) : null;
  const rows = await db
    .select({
      id: suppliers.id,
      name: suppliers.companyName,
      contact: sql<string | null>`${suppliers.legacyDoc}->>'cp'`,
      phone: suppliers.phone,
      active: suppliers.active,
    })
    .from(suppliers)
    .where(pat ? or(ilike(suppliers.companyName, pat), ilike(suppliers.phone, pat)) : undefined)
    .orderBy(asc(suppliers.companyName), asc(suppliers.id))
    .limit(q.limit);
  return rows.map((r) => ({ ...r, contact: r.contact || null, region: null, regionId: null }));
}

/* ── balances (from the journal — the same definition the reconciliation uses) ─── */

/** Customers: Σ(debit − credit) of the shop's lines on RECEIVABLES (positive = the shop owes us). Null = no such shop. */
export async function customerBalance(db: Executor, customerId: string): Promise<number | null> {
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!c) return null;
  return partyBalance(db, "CUSTOMER", customerId, "RECEIVABLES", "debit-credit");
}

/** Suppliers: Σ(credit − debit) of the supplier's lines on PAYABLES (positive = we owe the supplier). Null = no such supplier. */
export async function supplierBalance(db: Executor, supplierId: string): Promise<number | null> {
  const [s] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
  if (!s) return null;
  return partyBalance(db, "SUPPLIER", supplierId, "PAYABLES", "credit-debit");
}

async function partyBalance(db: Executor, partyType: string, partyId: string, account: string, sign: "debit-credit" | "credit-debit"): Promise<number> {
  const expr = sign === "debit-credit" ? sql`l.debit_p - l.credit_p` : sql`l.credit_p - l.debit_p`;
  const rows = await db.execute<{ balance: string }>(
    sql`SELECT COALESCE(SUM(${expr}), 0)::text AS balance
        FROM journal_lines l JOIN accounts a ON a.id = l.account_id
        WHERE l.party_type = ${partyType} AND l.party_id = ${partyId} AND a.code = ${account}`,
  );
  return Number(rows[0]?.balance ?? 0);
}

/* ── outstanding documents ───────────────────────────────────────────── */

const toDocument = (r: OutstandingRow): OutstandingDocument => ({
  id: r.id,
  number: r.number,
  date: r.date,
  status: r.status,
  totalP: r.totalP,
  paidP: r.paidP,
  creditP: r.creditP,
  outstandingP: r.outstandingP,
  lineSummary: "",
});

/** The invoices a receipt can be allocated to: collectable, outstanding > 0, oldest first. Null = no such shop. */
export async function outstandingInvoices(db: Executor, customerId: string): Promise<OutstandingDocument[] | null> {
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!c) return null;
  const rows = (await customerInvoiceOutstanding(db, customerId)).filter((r) => r.outstandingP > 0);
  return withLineSummaries(db, rows.map(toDocument));
}

/** (S8) What each invoice was for, in one line (the same wording as a statement row) — so the Receive panel can say "200 × Zam Zam 20KG @ PKR 2,700" beside a number. */
async function withLineSummaries(db: Executor, docs: OutstandingDocument[]): Promise<OutstandingDocument[]> {
  if (docs.length === 0) return docs;
  const lines = await db
    .select({
      invoiceId: invoiceItems.invoiceId,
      descriptionEn: invoiceItems.descriptionEnSnapshot,
      description: invoiceItems.descriptionSnapshot,
      package: invoiceItems.packageSnapshot,
      qtyMilli: invoiceItems.qtyMilli,
      unitPriceP: invoiceItems.unitPriceP,
    })
    .from(invoiceItems)
    .where(inArray(invoiceItems.invoiceId, docs.map((d) => d.id)))
    .orderBy(asc(invoiceItems.invoiceId), asc(invoiceItems.sortOrder), asc(invoiceItems.id));
  const byInvoice = new Map<string, typeof lines>();
  for (const l of lines) byInvoice.set(l.invoiceId, [...(byInvoice.get(l.invoiceId) ?? []), l]);
  return docs.map((d) => ({ ...d, lineSummary: lineSummary(byInvoice.get(d.id) ?? []) }));
}

/** The purchases a supplier payment can be allocated to: not cancelled, outstanding > 0, oldest first. Null = no such supplier. */
export async function outstandingPurchases(db: Executor, supplierId: string): Promise<OutstandingDocument[] | null> {
  const [s] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
  if (!s) return null;
  return (await supplierPurchaseOutstanding(db, supplierId)).filter((r) => r.outstandingP > 0).map(toDocument);
}

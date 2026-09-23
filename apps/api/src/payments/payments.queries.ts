import { and, asc, count, desc, eq, gte, ilike, inArray, lte, or, sql, type SQL } from "drizzle-orm";
import {
  customers,
  invoices,
  paymentAllocations,
  payments,
  purchases,
  regions,
  suppliers,
  type Executor,
} from "@farooq/db";
import {
  roleHasPermission,
  type ListPaymentsQuery,
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
import { editAmountRefusal, REVERSE_MESSAGES } from "./rules.js";

/**
 * Read side of payments. Every function takes an `Executor` (the pool or an open transaction), so the write
 * service can build its response from inside the same transaction.
 */

type PaymentRow = typeof payments.$inferSelect;

function toVoucher(p: PaymentRow, partyName: string | null, allocatedP: number): PaymentVoucher {
  return {
    id: p.id,
    receiptNumber: p.receiptNumber,
    direction: p.direction as PaymentVoucher["direction"],
    partyType: p.partyType as PaymentVoucher["partyType"],
    partyId: p.partyId,
    partyName,
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

export async function listPayments(db: Executor, q: ListPaymentsQuery): Promise<PaymentListResponse> {
  const conds: SQL[] = [];
  if (q.direction) conds.push(eq(payments.direction, q.direction));
  if (q.partyType) conds.push(eq(payments.partyType, q.partyType));
  if (q.partyId) conds.push(eq(payments.partyId, q.partyId));
  if (q.status) conds.push(eq(payments.status, q.status));
  if (q.from) conds.push(gte(payments.paymentDate, q.from));
  if (q.to) conds.push(lte(payments.paymentDate, q.to));
  if (q.q) {
    const pat = likePattern(q.q);
    conds.push(
      or(
        ilike(payments.receiptNumber, pat),
        ilike(payments.reference, pat),
        ilike(customers.shopName, pat),
        ilike(suppliers.companyName, pat),
      )!,
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const base = () =>
    db
      .select({ p: payments, cn: customers.shopName, sn: suppliers.companyName })
      .from(payments)
      .leftJoin(customers, and(eq(payments.partyType, "CUSTOMER"), eq(payments.partyId, customers.id)))
      .leftJoin(suppliers, and(eq(payments.partyType, "SUPPLIER"), eq(payments.partyId, suppliers.id)));

  const rows = await base()
    .where(where)
    .orderBy(desc(payments.paymentDate), desc(payments.createdAt), desc(payments.id))
    .limit(q.limit)
    .offset(q.offset);

  const [totalRow] = await db
    .select({ n: count() })
    .from(payments)
    .leftJoin(customers, and(eq(payments.partyType, "CUSTOMER"), eq(payments.partyId, customers.id)))
    .leftJoin(suppliers, and(eq(payments.partyType, "SUPPLIER"), eq(payments.partyId, suppliers.id)))
    .where(where);

  const sums = new Map<string, { n: number; total: number }>();
  if (rows.length) {
    const agg = await db
      .select({ paymentId: paymentAllocations.paymentId, n: sql<number>`count(*)::int`, total: sql<string>`COALESCE(SUM(${paymentAllocations.amountP}), 0)` })
      .from(paymentAllocations)
      .where(inArray(paymentAllocations.paymentId, rows.map((r) => r.p.id)))
      .groupBy(paymentAllocations.paymentId);
    for (const a of agg) sums.set(a.paymentId, { n: a.n, total: Number(a.total) });
  }

  const items: PaymentListItem[] = rows.map((r) => {
    const s = sums.get(r.p.id);
    return { ...toVoucher(r.p, partyNameOf(r), s?.total ?? 0), allocationCount: s?.n ?? 0 };
  });
  return { items, total: totalRow?.n ?? 0, limit: q.limit, offset: q.offset };
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
      active: customers.active,
    })
    .from(customers)
    .leftJoin(regions, eq(customers.regionId, regions.id))
    .where(pat ? or(ilike(customers.shopName, pat), ilike(customers.ownerName, pat), ilike(customers.phone, pat), ilike(customers.legacyCode, pat)) : undefined)
    .orderBy(asc(customers.shopName), asc(customers.id))
    .limit(q.limit);
  return rows;
}

export async function lookupSuppliers(db: Executor, q: PartyLookupQuery): Promise<PartyLookupItem[]> {
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
  return rows.map((r) => ({ ...r, contact: r.contact || null, region: null }));
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
});

/** The invoices a receipt can be allocated to: collectable, outstanding > 0, oldest first. Null = no such shop. */
export async function outstandingInvoices(db: Executor, customerId: string): Promise<OutstandingDocument[] | null> {
  const [c] = await db.select({ id: customers.id }).from(customers).where(eq(customers.id, customerId)).limit(1);
  if (!c) return null;
  return (await customerInvoiceOutstanding(db, customerId)).filter((r) => r.outstandingP > 0).map(toDocument);
}

/** The purchases a supplier payment can be allocated to: not cancelled, outstanding > 0, oldest first. Null = no such supplier. */
export async function outstandingPurchases(db: Executor, supplierId: string): Promise<OutstandingDocument[] | null> {
  const [s] = await db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1);
  if (!s) return null;
  return (await supplierPurchaseOutstanding(db, supplierId)).filter((r) => r.outstandingP > 0).map(toDocument);
}

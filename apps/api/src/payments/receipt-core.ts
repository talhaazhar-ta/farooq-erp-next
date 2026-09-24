import { eq } from "drizzle-orm";
import {
  auditLog,
  customers,
  loadAccountIds,
  paymentAllocations,
  paymentLines,
  paymentMemo,
  payments,
  postJournalEntry,
  regions,
  PAYMENT_SOURCE,
  type Tx,
} from "@farooq/db";
import { PAYMENT_MESSAGES, type Role } from "@farooq/shared";
import { BusinessRuleError } from "./errors.js";
import { nextNumber } from "./numbering.js";
import {
  byOldestFirst,
  customerInvoiceOutstanding,
  invoiceOutstanding,
  lockCustomerInvoices,
  lockInvoices,
  NOT_COLLECTABLE,
  refreshInvoiceStatuses,
} from "./outstanding.js";

/**
 * The write half of "money in from a shop", extracted from `PaymentsService` in S7 so that BOTH `PaymentsService.receive`
 * and an invoice saved with money taken at the time of sale run the very same code: one voucher, one journal entry, its
 * allocations, the invoice status refresh and the audit row — all inside the CALLER'S transaction. S3's tests exercise it
 * unchanged; S7's add the invoice-side cases.
 */

/** Who is acting. Permission checks are the guards' job, never the service's; `role` only shapes the response's `actions`. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export const rupees = (paisa: number): string =>
  `Rs ${(paisa / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Empty / whitespace-only optional text is stored as null. */
export const blankToNull = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);

/** What is printed on the voucher about the party, frozen at creation (legacy `partyNameSnapshot` / `partyOwnerSnapshot` / `regionSnapshot`). */
export interface PartySnapshot {
  name: string;
  owner: string | null;
  region: string | null;
}

export const cleanText = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

export interface Allocation {
  documentId: string;
  amountP: number;
}

/** A region as printed on vouchers and invoices: "اردو — English" (the legacy format), or just the English name when there is no Urdu one. */
export const formatRegion = (r: { nameEn: string; nameUr: string | null }): string => (r.nameUr ? `${r.nameUr} — ${r.nameEn}` : r.nameEn);

/** The shop and what its voucher will print about it: name, owner, and its region. */
export async function loadShop(tx: Tx, id: string): Promise<{ id: string; snapshot: PartySnapshot } | null> {
  const [row] = await tx
    .select({ id: customers.id, name: customers.shopName, owner: customers.ownerName, regionEn: regions.nameEn, regionUr: regions.nameUr })
    .from(customers)
    .leftJoin(regions, eq(customers.regionId, regions.id))
    .where(eq(customers.id, id))
    .limit(1);
  if (!row) return null;
  const region = row.regionEn ? formatRegion({ nameEn: row.regionEn, nameUr: row.regionUr }) : null;
  return { id: row.id, snapshot: { name: row.name, owner: cleanText(row.owner), region } };
}

/** Numbers the voucher (inside this transaction), inserts it and posts its journal entry. */
export async function insertVoucher(
  tx: Tx,
  actor: Actor,
  today: string,
  v: {
    direction: "IN" | "OUT";
    partyType: "CUSTOMER" | "SUPPLIER";
    partyId: string;
    snapshot: PartySnapshot;
    amountP: number;
    common: { method?: string | undefined; reference?: string | undefined; note?: string | undefined; date?: string | undefined; idempotencyKey?: string | undefined };
  },
) {
  // The number's year is the CURRENT business year, not the payment date's (the legacy `FDB.nextNumber` default).
  // Kind: REC for money in (the legacy `receiptPrefix` setting defaults to REC; there is no settings module yet), PV for money out.
  const receiptNumber = await nextNumber(tx, v.direction === "IN" ? "REC" : "PV", Number(today.slice(0, 4)));
  const paymentDate = v.common.date ?? today;
  const [payment] = await tx
    .insert(payments)
    .values({
      direction: v.direction,
      partyType: v.partyType,
      partyId: v.partyId,
      isRefund: v.partyType === "CUSTOMER" && v.direction === "OUT",
      amountP: v.amountP,
      method: blankToNull(v.common.method) ?? "Cash",
      reference: blankToNull(v.common.reference),
      note: blankToNull(v.common.note),
      paymentDate,
      status: "POSTED",
      receiptNumber,
      receivedBy: actor.name,
      partyNameSnapshot: v.snapshot.name,
      partyOwnerSnapshot: v.snapshot.owner,
      regionSnapshot: v.snapshot.region,
      createdBy: actor.id,
      idempotencyKey: v.common.idempotencyKey ?? null,
    })
    .returning();
  const accountIds = await loadAccountIds(tx);
  await postJournalEntry(tx, accountIds, {
    date: paymentDate,
    memo: paymentMemo({ direction: v.direction, partyType: v.partyType, receiptNumber }),
    sourceType: PAYMENT_SOURCE,
    sourceId: payment!.id,
    createdBy: actor.id,
    lines: paymentLines({ direction: v.direction, partyType: v.partyType, partyId: v.partyId, amountP: v.amountP }),
  });
  return payment!;
}

/**
 * No `allocations` given: oldest invoice first (the legacy `autoAllocate`) over the shop's collectable invoices
 * with something outstanding, stopping when the money runs out. The candidates are locked first, so two receipts
 * racing for the same shop cannot both fill the same invoice. Ties on date are broken by created_at, then
 * invoice number, then id (the legacy sort was unstable there).
 */
export async function autoAllocate(tx: Tx, customerId: string, amountP: number): Promise<Allocation[]> {
  await lockCustomerInvoices(tx, customerId);
  const rows = (await customerInvoiceOutstanding(tx, customerId)).filter((r) => r.outstandingP > 0).sort(byOldestFirst);
  let left = amountP;
  const out: Allocation[] = [];
  for (const r of rows) {
    if (left <= 0) break;
    const take = Math.min(r.outstandingP, left);
    out.push({ documentId: r.id, amountP: take });
    left -= take;
  }
  return out; // whatever is left stays an unallocated advance (the legacy allows it; it still credits the ledger)
}

/**
 * NEW, stricter than the legacy (which passed chosen allocations straight through and left the caps to the UI):
 * every invoice must exist, belong to THIS shop, not be DRAFT/CANCELLED, appear once, and receive at most its
 * current outstanding; the allocations together may not exceed the amount received.
 */
export async function checkInvoiceAllocations(tx: Tx, customerId: string, amountP: number, requested: { invoiceId: string; amountP: number }[]): Promise<Allocation[]> {
  const errors: string[] = [];
  const ids = requested.map((a) => a.invoiceId);
  if (new Set(ids).size !== ids.length) errors.push("The same invoice appears more than once in the allocations.");

  const locked = await lockInvoices(tx, [...new Set(ids)]);
  const byId = new Map(locked.map((i) => [i.id, i]));
  const outstanding = new Map((await invoiceOutstanding(tx, [...byId.keys()])).map((r) => [r.id, r]));

  const seen = new Set<string>();
  for (const a of requested) {
    const inv = byId.get(a.invoiceId);
    if (!inv) {
      errors.push("An invoice in the allocations does not exist.");
      continue;
    }
    const label = inv.number ?? "(draft)";
    if (inv.customerId !== customerId) errors.push(`Invoice ${label} does not belong to this shop.`);
    else if ((NOT_COLLECTABLE as readonly string[]).includes(inv.status)) errors.push(`Invoice ${label} is ${inv.status === "DRAFT" ? "a draft" : "cancelled"} and cannot be paid.`);
    else if (!seen.has(a.invoiceId)) {
      const due = outstanding.get(a.invoiceId)?.outstandingP ?? 0;
      if (a.amountP > due) errors.push(`Invoice ${label}: ${rupees(a.amountP)} is more than the ${rupees(Math.max(due, 0))} outstanding.`);
    }
    seen.add(a.invoiceId);
  }
  const total = requested.reduce((sum, a) => sum + a.amountP, 0);
  if (total > amountP) errors.push(`The allocations total ${rupees(total)}, more than the ${rupees(amountP)} received.`);
  if (errors.length) throw new BusinessRuleError([...new Set(errors)]);
  return requested.map((a) => ({ documentId: a.invoiceId, amountP: a.amountP }));
}

export interface ReceiptInput {
  customerId: string;
  amountP: number;
  /** Omitted / empty = allocate automatically, oldest invoice first. */
  allocations?: { invoiceId: string; amountP: number }[] | undefined;
  method?: string | undefined;
  reference?: string | undefined;
  note?: string | undefined;
  date?: string | undefined;
  idempotencyKey?: string | undefined;
}

/**
 * Money in from a shop, inside the caller's transaction: checks the shop and the allocations, writes the voucher (number,
 * row, journal entry), its allocation rows, refreshes the statuses of the invoices it pays and writes the audit row.
 * Returns the voucher's id.
 */
export async function writeReceipt(tx: Tx, actor: Actor, today: string, input: ReceiptInput): Promise<string> {
  const shop = await loadShop(tx, input.customerId);
  if (!shop) throw new BusinessRuleError([PAYMENT_MESSAGES.chooseShop]);

  const allocations = input.allocations?.length
    ? await checkInvoiceAllocations(tx, input.customerId, input.amountP, input.allocations)
    : await autoAllocate(tx, input.customerId, input.amountP);

  const payment = await insertVoucher(tx, actor, today, {
    direction: "IN",
    partyType: "CUSTOMER",
    partyId: shop.id,
    snapshot: shop.snapshot,
    amountP: input.amountP,
    common: input,
  });
  if (allocations.length) {
    await tx.insert(paymentAllocations).values(allocations.map((a) => ({ paymentId: payment.id, invoiceId: a.documentId, amountP: a.amountP })));
  }
  await refreshInvoiceStatuses(tx, allocations.map((a) => a.documentId));
  await tx.insert(auditLog).values({
    actorId: actor.id,
    action: "Payment received",
    entity: "Payment",
    entityId: payment.id,
    before: null,
    after: {
      receiptNumber: payment.receiptNumber,
      amountP: input.amountP,
      method: payment.method,
      party: shop.snapshot.name,
      allocations: allocations.map((a) => ({ invoiceId: a.documentId, amountP: a.amountP })),
    },
  });
  return payment.id;
}

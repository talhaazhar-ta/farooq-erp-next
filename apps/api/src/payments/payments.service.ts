import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  customers,
  journalEntries,
  loadAccountIds,
  paymentAllocations,
  paymentLines,
  paymentMemo,
  paymentReversalMemo,
  payments,
  regions,
  postJournalEntry,
  replaceEntryLines,
  reversedLines,
  suppliers,
  PAYMENT_REVERSAL_SOURCE,
  PAYMENT_SOURCE,
  type Db,
  type Tx,
} from "@farooq/db";
import {
  businessDateOf,
  PAYMENT_MESSAGES,
  type EditPaymentAmountInput,
  type PaymentDetail,
  type PayPaymentInput,
  type ReceivePaymentInput,
  type RefundPaymentInput,
  type ReversePaymentInput,
  type Role,
} from "@farooq/shared";
import { DB } from "../db/db.module.js";
import { CLOCK, type Clock } from "./clock.js";
import { BusinessRuleError, NotFoundError } from "./errors.js";
import { nextNumber } from "./numbering.js";
import {
  byOldestFirst,
  customerInvoiceOutstanding,
  invoiceOutstanding,
  lockCustomerInvoices,
  lockInvoices,
  lockPurchases,
  NOT_COLLECTABLE,
  purchaseOutstanding,
  refreshInvoiceStatuses,
} from "./outstanding.js";
import { loadPaymentDetail } from "./payments.queries.js";
import { EDIT_AMOUNT_MESSAGES, editAmountRefusal, REVERSE_MESSAGES } from "./rules.js";

/** Who is acting. Permission checks are the guards' job, never the service's; `role` only shapes the response's `actions`. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
}

export interface WriteResult {
  payment: PaymentDetail;
  /** True when an idempotency key matched an earlier request: nothing new was written. */
  replayed: boolean;
}

const rupees = (paisa: number): string =>
  `Rs ${(paisa / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Empty / whitespace-only optional text is stored as null. */
const blankToNull = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);

/** What is printed on the voucher about the party, frozen at creation (legacy `partyNameSnapshot` / `partyOwnerSnapshot` / `regionSnapshot`). */
interface PartySnapshot {
  name: string;
  owner: string | null;
  region: string | null;
}

const cleanText = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

interface Allocation {
  documentId: string;
  amountP: number;
}

/**
 * receive / pay / refund / reverse / editAmount — ported from the legacy `Payments` engine (02-services.js), with
 * every rule enforced HERE, in ONE database transaction per operation (CLAUDE.md rule 7). Where this is stricter
 * than the legacy, the comment says so; STATUS.md lists them all.
 *
 * Every write also posts (or rewrites) exactly one journal entry, found by (source_type, source_id), and one
 * audit_log row, in the same transaction. Journal shapes come from `@farooq/db`'s shared builder — the same one
 * the importer uses.
 */
@Injectable()
export class PaymentsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /* ── receive: money in from a shop ─────────────────────────────────── */

  async receive(input: ReceivePaymentInput, actor: Actor): Promise<WriteResult> {
    return this.create(input.idempotencyKey, actor, async (tx, today) => {
      const shop = await this.loadShop(tx, input.customerId);
      if (!shop) throw new BusinessRuleError([PAYMENT_MESSAGES.chooseShop]);

      const allocations = input.allocations?.length
        ? await this.checkInvoiceAllocations(tx, input.customerId, input.amountP, input.allocations)
        : await this.autoAllocate(tx, input.customerId, input.amountP);

      const payment = await this.insertVoucher(tx, actor, today, {
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
      await this.audit(tx, actor, "Payment received", payment.id, null, {
        receiptNumber: payment.receiptNumber,
        amountP: input.amountP,
        method: payment.method,
        party: shop.snapshot.name,
        allocations: allocations.map((a) => ({ invoiceId: a.documentId, amountP: a.amountP })),
      });
      return payment.id;
    });
  }

  /* ── pay: money out to a supplier ──────────────────────────────────── */

  async pay(input: PayPaymentInput, actor: Actor): Promise<WriteResult> {
    return this.create(input.idempotencyKey, actor, async (tx, today) => {
      const [sup] = await tx.select({ id: suppliers.id, name: suppliers.companyName, doc: suppliers.legacyDoc }).from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
      if (!sup) throw new BusinessRuleError([PAYMENT_MESSAGES.chooseSupplier]);

      const allocations = input.allocations?.length ? await this.checkPurchaseAllocations(tx, input.supplierId, input.amountP, input.allocations) : [];

      const payment = await this.insertVoucher(tx, actor, today, {
        direction: "OUT",
        partyType: "SUPPLIER",
        partyId: sup.id,
        // the legacy printed the supplier's contact person (`cp`) as the "owner" line and no region
        snapshot: { name: sup.name, owner: cleanText((sup.doc as { cp?: unknown } | null)?.cp), region: null },
        amountP: input.amountP,
        common: input,
      });
      if (allocations.length) {
        await tx.insert(paymentAllocations).values(allocations.map((a) => ({ paymentId: payment.id, purchaseId: a.documentId, amountP: a.amountP })));
      }
      // Deliberately NOT touching purchases.status: a purchase's payment state is M3's (the legacy `_write` never did either).
      await this.audit(tx, actor, "Payment made to supplier", payment.id, null, {
        receiptNumber: payment.receiptNumber,
        amountP: input.amountP,
        method: payment.method,
        party: sup.name,
        allocations: allocations.map((a) => ({ purchaseId: a.documentId, amountP: a.amountP })),
      });
      return payment.id;
    });
  }

  /* ── refund: money out to a shop ───────────────────────────────────── */

  async refund(input: RefundPaymentInput, actor: Actor): Promise<WriteResult> {
    return this.create(input.idempotencyKey, actor, async (tx, today) => {
      const shop = await this.loadShop(tx, input.customerId);
      if (!shop) throw new BusinessRuleError([PAYMENT_MESSAGES.chooseShop]);

      const payment = await this.insertVoucher(tx, actor, today, {
        direction: "OUT",
        partyType: "CUSTOMER",
        partyId: shop.id,
        snapshot: shop.snapshot,
        amountP: input.amountP,
        common: input,
      });
      await this.audit(tx, actor, "Refund paid to shop", payment.id, null, {
        receiptNumber: payment.receiptNumber,
        amountP: input.amountP,
        method: payment.method,
        party: shop.snapshot.name,
      });
      return payment.id;
    });
  }

  /* ── reverse ───────────────────────────────────────────────────────── */

  /**
   * Marks the voucher REVERSED and posts the mirror-image journal entry dated like the ORIGINAL payment, so the
   * pair cancels at every date and statements leave both out (the legacy ledger simply skipped a REVERSED
   * payment). Allocation rows are KEPT (never delete money history — the audit row also snapshots them); every
   * paid / outstanding computation counts POSTED payments only. There is no period locking, as in the legacy.
   *
   * Stricter than the legacy: an already-reversed voucher is refused (the legacy engine reversed it again).
   */
  async reverse(paymentId: string, input: ReversePaymentInput, actor: Actor): Promise<WriteResult> {
    const id = await this.db.transaction(async (tx) => {
      const p = await this.lockPayment(tx, paymentId);
      if (p.status === "REVERSED") throw new BusinessRuleError([REVERSE_MESSAGES.alreadyReversed]);

      const allocs = await tx.select().from(paymentAllocations).where(eq(paymentAllocations.paymentId, p.id));
      const invoiceIds = [...new Set(allocs.map((a) => a.invoiceId).filter((x): x is string => x !== null))];
      await lockInvoices(tx, invoiceIds); // ordered by id: two concurrent reversals can't deadlock

      const now = this.clock.now();
      await tx
        .update(payments)
        .set({ status: "REVERSED", reversedAt: now, reversedBy: actor.id, reverseReason: input.reason })
        .where(eq(payments.id, p.id));

      const accountIds = await loadAccountIds(tx);
      await postJournalEntry(tx, accountIds, {
        date: p.paymentDate,
        memo: paymentReversalMemo(p.receiptNumber),
        sourceType: PAYMENT_REVERSAL_SOURCE,
        sourceId: p.id,
        createdBy: actor.id,
        lines: reversedLines(paymentLines({ direction: p.direction as "IN" | "OUT", partyType: p.partyType as "CUSTOMER" | "SUPPLIER", partyId: p.partyId, amountP: p.amountP })),
      });

      await refreshInvoiceStatuses(tx, invoiceIds);
      await this.audit(
        tx,
        actor,
        "Payment reversed",
        p.id,
        { status: "POSTED", receiptNumber: p.receiptNumber, amountP: p.amountP, allocations: allocs.map((a) => ({ invoiceId: a.invoiceId, purchaseId: a.purchaseId, amountP: a.amountP })) },
        { status: "REVERSED", reason: input.reason },
      );
      return p.id;
    });
    return { payment: await this.detail(id, actor), replayed: false };
  }

  /* ── editAmount ────────────────────────────────────────────────────── */

  /**
   * Corrects a voucher's amount IN PLACE and rewrites that voucher's single journal entry to the new figure, in the
   * same transaction (the legacy "corrects the figure in place"). Trade-off, recorded in STATUS: a compensating
   * delta entry would keep a paper trail in the journal but make statements show two rows per voucher; the audit
   * row (before/after + reason) is the trail instead.
   */
  async editAmount(paymentId: string, input: EditPaymentAmountInput, actor: Actor): Promise<WriteResult> {
    const id = await this.db.transaction(async (tx) => {
      const p = await this.lockPayment(tx, paymentId);
      const refusal = await editAmountRefusal(tx, p);
      if (refusal) throw new BusinessRuleError([refusal]);
      if (!(input.amountP > 0)) throw new BusinessRuleError([EDIT_AMOUNT_MESSAGES.amount]);
      if (input.amountP === p.amountP) throw new BusinessRuleError([EDIT_AMOUNT_MESSAGES.unchanged]);

      await tx.update(payments).set({ amountP: input.amountP }).where(eq(payments.id, p.id));

      const [entry] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.sourceType, PAYMENT_SOURCE), eq(journalEntries.sourceId, p.id)))
        .limit(1);
      if (!entry) throw new Error(`Invariant violated: payment ${p.id} has no journal entry to correct`);
      const accountIds = await loadAccountIds(tx);
      await replaceEntryLines(
        tx,
        accountIds,
        entry.id,
        paymentLines({ direction: p.direction as "IN" | "OUT", partyType: p.partyType as "CUSTOMER" | "SUPPLIER", partyId: p.partyId, amountP: input.amountP }),
      );

      await this.audit(
        tx,
        actor,
        "Payment amount corrected",
        p.id,
        { amountP: p.amountP },
        { amountP: input.amountP, receiptNumber: p.receiptNumber, reason: blankToNull(input.reason) },
      );
      return p.id;
    });
    return { payment: await this.detail(id, actor), replayed: false };
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  /**
   * Skeleton of the three create operations: one transaction; an idempotency key is claimed first (an advisory lock
   * serialises two requests carrying the same key, so the second sees the first's committed voucher and returns it
   * instead of writing another; the unique index on `idempotency_key` is the backstop).
   */
  private async create(key: string | undefined, actor: Actor, build: (tx: Tx, today: string) => Promise<string>): Promise<WriteResult> {
    const outcome = await this.db.transaction(async (tx) => {
      if (key) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`payment-idempotency:${key}`}))`);
        const [existing] = await tx.select({ id: payments.id }).from(payments).where(eq(payments.idempotencyKey, key)).limit(1);
        if (existing) return { id: existing.id, replayed: true };
      }
      return { id: await build(tx, businessDateOf(this.clock.now())), replayed: false };
    });
    return { payment: await this.detail(outcome.id, actor), replayed: outcome.replayed };
  }

  /** The shop and what its voucher will print about it: name, owner, and the region as "اردو — English" (the legacy format). */
  private async loadShop(tx: Tx, id: string): Promise<{ id: string; snapshot: PartySnapshot } | null> {
    const [row] = await tx
      .select({ id: customers.id, name: customers.shopName, owner: customers.ownerName, regionEn: regions.nameEn, regionUr: regions.nameUr })
      .from(customers)
      .leftJoin(regions, eq(customers.regionId, regions.id))
      .where(eq(customers.id, id))
      .limit(1);
    if (!row) return null;
    const region = row.regionEn ? (row.regionUr ? `${row.regionUr} — ${row.regionEn}` : row.regionEn) : null;
    return { id: row.id, snapshot: { name: row.name, owner: cleanText(row.owner), region } };
  }

  private async detail(id: string, actor: Actor): Promise<PaymentDetail> {
    const d = await loadPaymentDetail(this.db, id, actor.role);
    if (!d) throw new Error(`Payment ${id} vanished after commit`);
    return d;
  }

  private async lockPayment(tx: Tx, id: string): Promise<typeof payments.$inferSelect> {
    const [p] = await tx.select().from(payments).where(eq(payments.id, id)).for("update").limit(1);
    if (!p) throw new NotFoundError(PAYMENT_MESSAGES.notFound);
    return p;
  }

  /** Numbers the voucher (inside this transaction), inserts it and posts its journal entry. */
  private async insertVoucher(
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
  private async autoAllocate(tx: Tx, customerId: string, amountP: number): Promise<Allocation[]> {
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
  private async checkInvoiceAllocations(tx: Tx, customerId: string, amountP: number, requested: { invoiceId: string; amountP: number }[]): Promise<Allocation[]> {
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

  /** Same guards for a supplier payment's optional purchase allocations (outstanding = total − allocations of POSTED payments; CANCELLED refused). */
  private async checkPurchaseAllocations(tx: Tx, supplierId: string, amountP: number, requested: { purchaseId: string; amountP: number }[]): Promise<Allocation[]> {
    const errors: string[] = [];
    const ids = requested.map((a) => a.purchaseId);
    if (new Set(ids).size !== ids.length) errors.push("The same purchase appears more than once in the allocations.");

    const locked = await lockPurchases(tx, [...new Set(ids)]);
    const byId = new Map(locked.map((p) => [p.id, p]));
    const outstanding = new Map((await purchaseOutstanding(tx, [...byId.keys()])).map((r) => [r.id, r]));

    const seen = new Set<string>();
    for (const a of requested) {
      const pur = byId.get(a.purchaseId);
      if (!pur) {
        errors.push("A purchase in the allocations does not exist.");
        continue;
      }
      const label = pur.number ?? "(draft)";
      if (pur.supplierId !== supplierId) errors.push(`Purchase ${label} does not belong to this supplier.`);
      else if (pur.status === "CANCELLED") errors.push(`Purchase ${label} is cancelled and cannot be paid.`);
      else if (!seen.has(a.purchaseId)) {
        const due = outstanding.get(a.purchaseId)?.outstandingP ?? 0;
        if (a.amountP > due) errors.push(`Purchase ${label}: ${rupees(a.amountP)} is more than the ${rupees(Math.max(due, 0))} outstanding.`);
      }
      seen.add(a.purchaseId);
    }
    const total = requested.reduce((sum, a) => sum + a.amountP, 0);
    if (total > amountP) errors.push(`The allocations total ${rupees(total)}, more than the ${rupees(amountP)} paid.`);
    if (errors.length) throw new BusinessRuleError([...new Set(errors)]);
    return requested.map((a) => ({ documentId: a.purchaseId, amountP: a.amountP }));
  }

  private async audit(tx: Tx, actor: Actor, action: string, paymentId: string, before: unknown, after: unknown): Promise<void> {
    await tx.insert(auditLog).values({ actorId: actor.id, action, entity: "Payment", entityId: paymentId, before: before ?? null, after: after ?? null });
  }
}

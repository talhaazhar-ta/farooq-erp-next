import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import {
  auditLog,
  journalEntries,
  loadAccountIds,
  paymentAllocations,
  paymentLines,
  paymentReversalMemo,
  payments,
  postJournalEntry,
  replaceEntryLines,
  reversedLines,
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
} from "@farooq/shared";
import { DB } from "../db/db.module.js";
import { CLOCK, type Clock } from "./clock.js";
import { BusinessRuleError, NotFoundError } from "./errors.js";
import { lockInvoices, refreshInvoiceStatuses } from "./outstanding.js";
import { writePayout } from "./payout-core.js";
import { loadPaymentDetail } from "./payments.queries.js";
import { EDIT_AMOUNT_MESSAGES, editAmountRefusal, REVERSE_MESSAGES } from "./rules.js";
import { blankToNull, insertVoucher, loadShop, writeReceipt, type Actor } from "./receipt-core.js";

export type { Actor };

export interface WriteResult {
  payment: PaymentDetail;
  /** True when an idempotency key matched an earlier request: nothing new was written. */
  replayed: boolean;
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
    return this.create(input.idempotencyKey, actor, (tx, today) => writeReceipt(tx, actor, today, input));
  }

  /* ── pay: money out to a supplier ──────────────────────────────────── */

  async pay(input: PayPaymentInput, actor: Actor): Promise<WriteResult> {
    return this.create(input.idempotencyKey, actor, (tx, today) => writePayout(tx, actor, today, input));
  }

  /* ── refund: money out to a shop ───────────────────────────────────── */

  async refund(input: RefundPaymentInput, actor: Actor): Promise<WriteResult> {
    return this.create(input.idempotencyKey, actor, async (tx, today) => {
      const shop = await loadShop(tx, input.customerId);
      if (!shop) throw new BusinessRuleError([PAYMENT_MESSAGES.chooseShop]);

      const payment = await insertVoucher(tx, actor, today, {
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

  private async audit(tx: Tx, actor: Actor, action: string, paymentId: string, before: unknown, after: unknown): Promise<void> {
    await tx.insert(auditLog).values({ actorId: actor.id, action, entity: "Payment", entityId: paymentId, before: before ?? null, after: after ?? null });
  }
}

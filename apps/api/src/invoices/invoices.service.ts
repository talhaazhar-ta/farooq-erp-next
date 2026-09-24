import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  customers,
  invoiceCancelLines,
  invoiceCancelMemo,
  invoiceItems,
  invoiceLines,
  invoiceMemo,
  invoices,
  journalEntries,
  loadAccountIds,
  payments,
  postJournalEntry,
  products,
  regions,
  replaceEntryLines,
  requestKeys,
  setEntryDate,
  warehouses,
  INVOICE_CANCEL_SOURCE,
  INVOICE_SOURCE,
  type Db,
  type Tx,
} from "@farooq/db";
import {
  addDays,
  businessDateOf,
  INVOICE_MESSAGES,
  milliToQty,
  roleHasPermission,
  type CancelInvoiceInput,
  type ChangeInvoiceShopInput,
  type DuplicateInvoiceInput,
  type InvoiceDetail,
  type Permission,
  type SaveInvoiceInput,
} from "@farooq/shared";
import { DB } from "../db/db.module.js";
import { CLOCK, type Clock } from "../payments/clock.js";
import { BusinessRuleError, NotFoundError } from "../payments/errors.js";
import { nextNumber } from "../payments/numbering.js";
import { invoiceStatusFor } from "../payments/outstanding.js";
import { customerBalance } from "../payments/payments.queries.js";
import { blankToNull, cleanText, formatRegion, writeReceipt, type Actor } from "../payments/receipt-core.js";
import { loadFullLedger, windowStatement } from "../statements/ledger.js";
import { loadInvoiceDetail, paidOn } from "./invoices.queries.js";
import { cancelRefusal, changeShopRefusals, editRefusal, receiptsOn, type InvoiceForRules } from "./rules.js";
import { allowNegativeStock, applyMovement, costOf, lockStockLevels, pairKey, type StockPair } from "./stock.js";
import { validateInvoice, type LineForValidation } from "./validate.js";

export interface InvoiceWriteResult {
  invoice: InvoiceDetail;
  /** True when an idempotency key matched an earlier request: nothing new was written. */
  replayed: boolean;
}

type InvoiceRow = typeof invoices.$inferSelect;
type ItemRow = typeof invoiceItems.$inferSelect;
type CustomerRow = typeof customers.$inferSelect;

const rulesOf = (i: InvoiceRow): InvoiceForRules => ({
  id: i.id,
  status: i.status,
  customerId: i.customerId,
  number: i.invoiceNumber,
  shopNameSnapshot: i.shopNameSnapshot,
  dispatchNumber: i.dispatchNumber,
  totalP: i.totalP,
});

const docText = (doc: unknown, key: string): string | null => cleanText((doc as Record<string, unknown> | null)?.[key]);

/** What an invoice prints about the shop (legacy `Invoices.customerFields`): one place, so a new invoice and a moved one can never disagree. */
function customerFields(c: CustomerRow, region: { nameEn: string; nameUr: string | null } | null) {
  return {
    customerCodeSnapshot: cleanText(c.legacyCode) ?? cleanText(c.legacyId),
    customerNameSnapshot: cleanText(c.ownerName) ?? cleanText(c.shopName),
    shopNameSnapshot: cleanText(c.shopName),
    contactPersonSnapshot: cleanText(c.ownerName),
    mobileSnapshot: cleanText(c.phone),
    whatsappSnapshot: docText(c.legacyDoc, "wa"),
    addressSnapshot: docText(c.legacyDoc, "addr"),
    regionId: c.regionId,
    regionSnapshot: region ? formatRegion(region) : null,
    marketSnapshot: docText(c.legacyDoc, "area") ?? docText(c.legacyDoc, "route"),
  };
}

const requirePermission = (actor: Actor, permission: Permission, message: string): void => {
  if (!roleHasPermission(actor.role, permission)) throw new ForbiddenException(message);
};

/**
 * save (draft / post / edit a posted invoice) / cancel / duplicate / change shop — ported from the legacy `Invoices`
 * (02-services.js), every rule enforced HERE in ONE database transaction per operation (CLAUDE.md rule 7). What the
 * legacy did in one IndexedDB transaction — number, invoice, lines, stock, movements, payment, allocation, ledger effect,
 * audit — is one Postgres transaction here. Where this is stricter than the legacy, the comment says so; STATUS lists them.
 *
 * Journal (planner decisions, docs/sessions/S7.md):
 *   post          one INVOICE entry DR RECEIVABLES(shop) / CR SALES, dated the invoice's date
 *   edit posted   that entry's lines and date are rewritten in place (the legacy ledger reads grandTotal / invoiceDate live)
 *   cancel        a reversing INVOICE_CANCEL entry, dated the invoice's own date, so the pair cancels at every date
 * Stock: SALE_OUT per line on post; an edit posts the DIFFERENCE per product × warehouse; a cancel restocks Σ qty per product ×
 * warehouse today. A migrated invoice (the old app's data migration) has no movements, so it never gets any back.
 */
@Injectable()
export class InvoicesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /* ── save: create a draft / post / edit ────────────────────────────── */

  /** `id` null = a new invoice (POST /invoices); otherwise the invoice being edited (PUT /invoices/:id). */
  async save(input: SaveInvoiceInput, actor: Actor, id: string | null): Promise<InvoiceWriteResult> {
    return this.withKey(input.idempotencyKey, actor, (tx, today) => this.saveInTx(tx, actor, today, input, id));
  }

  /* ── cancel ────────────────────────────────────────────────────────── */

  async cancel(id: string, input: CancelInvoiceInput, actor: Actor): Promise<InvoiceWriteResult> {
    const outcome = await this.db.transaction(async (tx) => {
      const today = businessDateOf(this.clock.now());
      const inv = await this.lockInvoice(tx, id);
      const why = await cancelRefusal(tx, rulesOf(inv));
      if (why) throw new BusinessRuleError([why]);

      const posted = inv.status !== "DRAFT";
      const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(asc(invoiceItems.sortOrder));

      if (posted && inv.customerId) await this.lockCustomers(tx, [inv.customerId]);

      // stock comes back: Σ(qty − returned) per product × warehouse, dated TODAY (legacy). Returns cannot exist here (refused above).
      if (inv.stockApplied && !inv.migrated) {
        const back = new Map<string, StockPair & { milli: number }>();
        for (const it of items) {
          const k = pairKey(it);
          const known = back.get(k);
          const milli = it.qtyMilli - it.returnedQtyMilli;
          if (known) known.milli += milli;
          else back.set(k, { productId: it.productId, warehouseId: it.warehouseId, milli });
        }
        await lockStockLevels(tx, [...back.values()]);
        for (const b of [...back.values()].sort((x, y) => (pairKey(x) < pairKey(y) ? -1 : 1))) {
          if (b.milli === 0) continue;
          await applyMovement(tx, {
            date: today,
            productId: b.productId,
            warehouseId: b.warehouseId,
            kind: "SALE_REVERSAL_IN",
            qtyDeltaMilli: b.milli,
            ref: inv.invoiceNumber,
            refType: "INVOICE_CANCEL",
            invoiceId: inv.id,
            note: `Invoice cancelled — ${input.reason}`,
            createdBy: actor.id,
          });
        }
      }

      if (posted && inv.customerId) {
        const accountIds = await loadAccountIds(tx);
        await postJournalEntry(tx, accountIds, {
          date: inv.date,
          memo: invoiceCancelMemo(inv.invoiceNumber),
          sourceType: INVOICE_CANCEL_SOURCE,
          sourceId: inv.id,
          createdBy: actor.id,
          lines: invoiceCancelLines(inv.customerId, inv.totalP),
        });
      }

      const now = this.clock.now();
      await tx
        .update(invoices)
        .set({ status: "CANCELLED", stockApplied: false, cancelledAt: now, cancelReason: input.reason, updatedAt: now, revision: inv.revision + 1 })
        .where(eq(invoices.id, id));
      await this.audit(tx, actor, "Invoice cancelled", inv, { status: inv.status, grandTotal: inv.totalP }, { status: "CANCELLED" }, input.reason);
      return { id, replayed: false };
    });
    return this.result(outcome.id, actor, outcome.replayed);
  }

  /* ── duplicate ─────────────────────────────────────────────────────── */

  /** A fresh DRAFT from an invoice (legacy `duplicate`): today's date, nothing paid, due date / order / dispatch / reference blank, no number. */
  async duplicate(id: string, input: DuplicateInvoiceInput, actor: Actor): Promise<InvoiceWriteResult> {
    return this.withKey(input.idempotencyKey, actor, async (tx, today) => {
      const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).limit(1);
      if (!inv) throw new NotFoundError(INVOICE_MESSAGES.notFound);
      const items = await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(asc(invoiceItems.sortOrder), asc(invoiceItems.id));
      const draft: SaveInvoiceInput = {
        mode: "draft",
        customerId: inv.customerId ?? "",
        warehouseId: inv.warehouseId ?? "",
        date: today,
        lines: items.map((it) => ({
          productId: it.productId,
          quantity: milliToQty(it.qtyMilli),
          unitPriceP: it.unitPriceP,
          discountP: it.discountP,
          taxP: it.taxP, // the legacy `toDraft` dropped a fixed line tax; carrying it forward keeps the copy true to the original
          warehouseId: it.warehouseId,
          unit: it.unit,
          ...(it.batchNo ? { batchNo: it.batchNo } : {}),
          ...(it.notes ? { notes: it.notes } : {}),
        })),
        invoiceDiscountP: inv.invoiceDiscountP,
        freightP: inv.freightP,
        loadingP: inv.loadingP,
        otherChargesP: inv.otherChargesP,
        ...(inv.paymentMethod ? { paymentMethod: inv.paymentMethod } : {}),
        ...(inv.notes ? { notes: inv.notes } : {}),
        ...(inv.description ? { description: inv.description } : {}),
        ...(inv.salesperson ? { salesperson: inv.salesperson } : {}),
      };
      return this.saveInTx(tx, actor, today, draft, null, { duplicatedFrom: inv.invoiceNumber ?? inv.id });
    });
  }

  /* ── change shop ───────────────────────────────────────────────────── */

  /**
   * Moves a posted invoice to another shop — the shop and nothing else (legacy `changeCustomer`): the invoice's snapshots, its
   * journal entry's party line, the wholly-applied receipts (and their snapshots and journal party lines) follow it;
   * `previous_balance_p` is recomputed as the new shop's balance the day before the invoice date; lines, number, date and
   * stock are untouched. Refusals (cancelled, draft, a return exists, a receipt shared with other invoices) are `changeShopRefusals`.
   */
  async changeShop(id: string, input: ChangeInvoiceShopInput, actor: Actor): Promise<InvoiceWriteResult> {
    const outcome = await this.db.transaction(async (tx) => {
      const inv = await this.lockInvoice(tx, id);
      const [to] = await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
      const errs = await changeShopRefusals(tx, rulesOf(inv), { customerId: input.customerId, exists: !!to });
      if (errs.length) throw new BusinessRuleError(errs);
      const target = to!;
      await this.lockCustomers(tx, [inv.customerId, target.id].filter((x): x is string => !!x));

      // the new shop's balance the day before this invoice's date — what it owed before this sale. Read before anything moves.
      const ledger = await loadFullLedger(tx, "CUSTOMER", target.id);
      const previousBalanceP = windowStatement("CUSTOMER", ledger, { from: null, to: addDays(inv.date, -1) }).closing;

      const region = target.regionId ? ((await tx.select({ nameEn: regions.nameEn, nameUr: regions.nameUr }).from(regions).where(eq(regions.id, target.regionId)).limit(1))[0] ?? null) : null;
      const fields = customerFields(target, region);
      const oldShop = inv.shopNameSnapshot;
      const oldId = inv.customerId;

      // the journal: the invoice's own entry, then each receipt that belongs wholly to it
      const movedReceipts = (await receiptsOn(tx, id)).filter((r) => r.status === "POSTED" && r.wholly);
      const sourceOf = [{ type: INVOICE_SOURCE, id }, ...movedReceipts.map((r) => ({ type: "PAYMENT", id: r.paymentId }))];
      for (const s of sourceOf) {
        await tx.execute(sql`
          UPDATE journal_lines SET party_id = ${target.id}
          WHERE party_type = 'CUSTOMER' AND party_id = ${oldId}
            AND entry_id IN (SELECT id FROM journal_entries WHERE source_type = ${s.type} AND source_id = ${s.id})`);
      }
      for (const r of movedReceipts) {
        await tx
          .update(payments)
          .set({ partyId: target.id, partyNameSnapshot: target.shopName, partyOwnerSnapshot: cleanText(target.ownerName), regionSnapshot: fields.regionSnapshot })
          .where(eq(payments.id, r.paymentId));
      }

      await tx
        .update(invoices)
        .set({ ...fields, customerId: target.id, previousBalanceP, updatedAt: this.clock.now(), revision: inv.revision + 1 })
        .where(eq(invoices.id, id));
      await this.audit(
        tx,
        actor,
        "Invoice moved to another shop",
        inv,
        { customerId: oldId, shop: oldShop },
        { customerId: target.id, shop: fields.shopNameSnapshot, receiptsMoved: movedReceipts.map((r) => r.receiptNumber) },
        blankToNull(input.reason) ?? "",
      );
      return { id, replayed: false };
    });
    return this.result(outcome.id, actor, outcome.replayed);
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  /**
   * One transaction; an idempotency key is claimed first (an advisory lock serialises two requests carrying the same key, so the
   * second sees the first's recorded invoice and returns it instead of writing another; the primary key on `request_keys` is the backstop).
   */
  private async withKey(key: string | undefined, actor: Actor, run: (tx: Tx, today: string) => Promise<{ id: string; replayed: boolean }>): Promise<InvoiceWriteResult> {
    const outcome = await this.db.transaction(async (tx) => {
      if (key) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`invoice-idempotency:${key}`}))`);
        const [seen] = await tx.select({ entityId: requestKeys.entityId }).from(requestKeys).where(eq(requestKeys.key, key)).limit(1);
        if (seen) return { id: seen.entityId, replayed: true };
      }
      const done = await run(tx, businessDateOf(this.clock.now()));
      if (key) await tx.insert(requestKeys).values({ key, kind: "INVOICE", entityId: done.id });
      return done;
    });
    return this.result(outcome.id, actor, outcome.replayed);
  }

  private async result(id: string, actor: Actor, replayed: boolean): Promise<InvoiceWriteResult> {
    const invoice = await loadInvoiceDetail(this.db, id, actor.role);
    if (!invoice) throw new Error(`Invoice ${id} vanished after commit`);
    return { invoice, replayed };
  }

  private async lockInvoice(tx: Tx, id: string): Promise<InvoiceRow> {
    const [row] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update").limit(1);
    if (!row) throw new NotFoundError(INVOICE_MESSAGES.notFound);
    return row;
  }

  /** Serialises invoice work per shop (previous balance is read at posting time). NO KEY UPDATE: it must not block other invoices' foreign-key checks. */
  private async lockCustomers(tx: Tx, ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    await tx.select({ id: customers.id }).from(customers).where(inArray(customers.id, unique)).orderBy(asc(customers.id)).for("no key update");
  }

  private async audit(tx: Tx, actor: Actor, action: string, inv: { id: string; invoiceNumber: string | null }, before: unknown, after: unknown, reason: string | null): Promise<void> {
    await tx.insert(auditLog).values({
      actorId: actor.id,
      action,
      entity: "Invoice",
      entityId: inv.id,
      before: before ?? null,
      after: { ref: inv.invoiceNumber ?? "draft", ...(after as object), ...(reason ? { reason } : {}) },
    });
  }

  private async saveInTx(
    tx: Tx,
    actor: Actor,
    today: string,
    input: SaveInvoiceInput,
    id: string | null,
    opts: { duplicatedFrom?: string } = {},
  ): Promise<{ id: string; replayed: boolean }> {
    const asDraft = input.mode === "draft";
    const existing = id ? await this.lockInvoice(tx, id) : null;
    const existingPosted = !!existing && existing.status !== "DRAFT" && existing.status !== "CANCELLED";

    /* ── who may do this, and is it the version they saw? ── */
    if (!existing || existing.status === "DRAFT") requirePermission(actor, "SALES_CREATE", INVOICE_MESSAGES.noPermissionPost);
    else if (existing.status === "CANCELLED") throw new BusinessRuleError([INVOICE_MESSAGES.cancelledEdit]);
    else requirePermission(actor, "TRANSACTION_CORRECT", INVOICE_MESSAGES.noPermissionCorrect);
    if (existing) {
      if (input.revision === undefined) throw new BusinessRuleError([INVOICE_MESSAGES.revisionRequired]);
      if (input.revision !== existing.revision) throw new BusinessRuleError([INVOICE_MESSAGES.stale]);
    }

    const errors: string[] = [];
    if (existingPosted) {
      if (asDraft) throw new BusinessRuleError([INVOICE_MESSAGES.toDraft]);
      const why = await editRefusal(tx, rulesOf(existing));
      if (why) throw new BusinessRuleError([why]);
      if (input.customerId !== existing.customerId) errors.push(INVOICE_MESSAGES.shopLockedOnEdit);
    }

    /* ── what it refers to ── */
    const [customer] = await tx.select().from(customers).where(eq(customers.id, input.customerId)).limit(1);
    const region = customer?.regionId ? ((await tx.select({ nameEn: regions.nameEn, nameUr: regions.nameUr }).from(regions).where(eq(regions.id, customer.regionId)).limit(1))[0] ?? null) : null;
    const whRows = await tx.select({ id: warehouses.id, name: warehouses.name }).from(warehouses);
    const warehouseNames = new Map(whRows.map((w) => [w.id, w.name]));
    const productIds = [...new Set(input.lines.map((l) => l.productId))];
    const productRows = productIds.length ? await tx.select().from(products).where(inArray(products.id, productIds)) : [];
    const productById = new Map(productRows.map((p) => [p.id, p]));
    const oldItems: ItemRow[] = existing ? await tx.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, existing.id)).orderBy(asc(invoiceItems.sortOrder), asc(invoiceItems.id)) : [];
    const oldById = new Map(oldItems.map((i) => [i.id, i]));

    const lines: (LineForValidation & { src: SaveInvoiceInput["lines"][number] })[] = input.lines.map((l) => ({
      src: l,
      productId: l.productId,
      warehouseId: l.warehouseId ?? input.warehouseId,
      quantity: l.quantity,
      unitPriceP: l.unitPriceP,
      discountP: l.discountP ?? 0,
      taxP: l.taxP ?? 0,
      taxRatePct: l.taxRatePct ?? 0,
    }));
    input.lines.forEach((l, i) => {
      if (l.id && !oldById.has(l.id)) errors.push(`Line ${i + 1}: that line does not belong to this invoice. Reload the invoice and try again.`);
    });

    /* ── payment taken with the sale ── */
    const alreadyPaid = existingPosted ? await paidOn(tx, existing.id) : 0;
    const paidP = asDraft ? (input.paidAmountP ?? 0) : (input.paidAmountP ?? alreadyPaid);
    if (asDraft && paidP > 0) errors.push(INVOICE_MESSAGES.paymentOnDraft);
    if (!asDraft && paidP > alreadyPaid) requirePermission(actor, "PAYMENT_CREATE", INVOICE_MESSAGES.noPermissionPayment);
    if (existingPosted && paidP < alreadyPaid) {
      const held = (await receiptsOn(tx, existing.id)).filter((r) => r.status === "POSTED").map((r) => r.receiptNumber);
      errors.push(
        `The amount paid is less than the money already received on this invoice (${held.join(", ")}). Reverse the receipt first, then change the amount paid.`,
      );
    }

    /* ── stock: lock what is touched, in a fixed order, then read what is available ── */
    const stockOn = !asDraft && !existing?.migrated;
    const ownDeducted = existingPosted && existing.stockApplied && !existing.migrated;
    let levels = new Map<string, number>();
    if (!asDraft) await this.lockCustomers(tx, [input.customerId]);
    if (stockOn) {
      const pairs: StockPair[] = lines.filter((l) => warehouseNames.has(l.warehouseId) && productById.has(l.productId)).map((l) => ({ productId: l.productId, warehouseId: l.warehouseId }));
      if (ownDeducted) pairs.push(...oldItems);
      levels = await lockStockLevels(tx, pairs);
    }
    const ownBack = new Map<string, number>();
    if (ownDeducted) for (const it of oldItems) ownBack.set(pairKey(it), (ownBack.get(pairKey(it)) ?? 0) + it.qtyMilli);

    const v = validateInvoice(
      {
        customerId: input.customerId,
        warehouseId: input.warehouseId,
        invoiceDiscountP: input.invoiceDiscountP ?? 0,
        freightP: input.freightP ?? 0,
        loadingP: input.loadingP ?? 0,
        otherChargesP: input.otherChargesP ?? 0,
        paidP,
      },
      lines,
      {
        customerExists: !!customer,
        warehouseNames,
        products: new Map([...productById].map(([k, p]) => [k, { name: p.name, nameEn: p.nameEn, nameUr: p.nameUr }])),
        availableMilli: (productId, warehouseId) => (levels.get(pairKey({ productId, warehouseId })) ?? 0) + (ownBack.get(pairKey({ productId, warehouseId })) ?? 0),
        allowNegativeStock: await allowNegativeStock(tx),
        isDraft: asDraft,
        skipStock: !stockOn,
      },
    );
    const all = [...new Set([...errors, ...v.errors])];
    if (all.length) throw new BusinessRuleError(all);
    const totals = v.totals;
    const cust = customer!;

    /* ── the header ── */
    const postingNow = !asDraft && !existingPosted;
    const number = existing?.invoiceNumber ?? (asDraft ? null : await nextNumber(tx, "INV", Number(today.slice(0, 4))));
    const invoiceDate = input.date ?? today;
    const now = this.clock.now();
    const previousBalanceP = postingNow ? ((await customerBalance(tx, cust.id)) ?? 0) : (existing?.previousBalanceP ?? 0);
    const status = asDraft ? "DRAFT" : invoiceStatusFor(totals.grandTotalP, paidP);
    const header = {
      invoiceNumber: number,
      customerId: cust.id,
      date: invoiceDate,
      dueDate: input.dueDate ?? null,
      totalP: totals.grandTotalP,
      status,
      invoiceType: "SALE",
      warehouseId: input.warehouseId,
      warehouseSnapshot: warehouseNames.get(input.warehouseId) ?? null,
      salesperson: blankToNull(input.salesperson) ?? existing?.salesperson ?? actor.name,
      subtotalP: totals.subtotalP,
      itemDiscountsP: totals.itemDiscountsP,
      invoiceDiscountP: totals.invoiceDiscountP,
      taxP: totals.taxP,
      freightP: totals.freightP,
      loadingP: totals.loadingP,
      otherChargesP: totals.otherChargesP,
      paymentMethod: blankToNull(input.paymentMethod) ?? "Cash",
      referenceNo: blankToNull(input.referenceNo),
      notes: blankToNull(input.notes),
      description: blankToNull(input.description),
      orderNumber: blankToNull(input.orderNumber),
      previousBalanceP,
      totalQtyMilli: totals.totalQtyMilli,
      lineCount: totals.lineCount,
      stockApplied: postingNow ? true : (existing?.stockApplied ?? false),
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: now,
      confirmedAt: existing?.confirmedAt ?? (asDraft ? null : now),
      ...customerFields(cust, region),
    };
    const [saved] = existing
      ? await tx.update(invoices).set(header).where(eq(invoices.id, existing.id)).returning({ id: invoices.id })
      : await tx.insert(invoices).values({ ...header, createdBy: actor.id }).returning({ id: invoices.id });
    const invoiceId = saved!.id;

    /* ── the lines: stable ids for lines that were kept, product snapshots re-taken (legacy `snapshotItem` runs on every save) ── */
    const keep = new Set(input.lines.map((l) => l.id).filter((x): x is string => !!x));
    const dropped = oldItems.filter((o) => !keep.has(o.id)).map((o) => o.id);
    if (dropped.length) await tx.delete(invoiceItems).where(inArray(invoiceItems.id, dropped));
    const costCache = new Map<string, number>();
    for (const [i, l] of lines.entries()) {
      const p = productById.get(l.productId)!;
      const t = totals.lines[i]!;
      const key = pairKey(l);
      if (!costCache.has(key)) costCache.set(key, await costOf(tx, l.productId, l.warehouseId));
      const row = {
        invoiceId,
        sortOrder: i,
        productId: l.productId,
        warehouseId: l.warehouseId,
        descriptionSnapshot: p.nameUr ?? p.nameEn ?? p.name,
        descriptionEnSnapshot: p.nameEn,
        brandSnapshot: p.brandEn ?? p.brand,
        categorySnapshot: p.category,
        packageSnapshot: p.weightKg ? `${p.weightKg} KG` : "Bag",
        skuSnapshot: p.sku ?? docText(p.legacyDoc, "sourceFolio") ?? p.legacyId,
        unit: cleanText(l.src.unit) ?? "Bag",
        qtyMilli: t.qtyMilli,
        unitPriceP: t.unitPriceP,
        discountP: t.discountP,
        taxP: t.taxP,
        lineTotalP: t.lineTotalP,
        costSnapshotP: costCache.get(key)!,
        batchNo: blankToNull(l.src.batchNo),
        notes: blankToNull(l.src.notes),
      };
      if (l.src.id) await tx.update(invoiceItems).set(row).where(eq(invoiceItems.id, l.src.id));
      else await tx.insert(invoiceItems).values(row);
    }

    /* ── stock ── */
    if (postingNow) {
      for (const [i, l] of lines.entries()) {
        await applyMovement(tx, {
          date: invoiceDate,
          productId: l.productId,
          warehouseId: l.warehouseId,
          kind: "SALE_OUT",
          qtyDeltaMilli: -totals.lines[i]!.qtyMilli,
          ref: number,
          refType: "INVOICE",
          invoiceId,
          note: cust.shopName,
          createdBy: actor.id,
        });
      }
    } else if (ownDeducted) {
      // the net correction: one movement per product × warehouse whose quantity changed (the legacy reversed everything and deducted again)
      const diff = new Map<string, StockPair & { milli: number }>();
      const bump = (p: StockPair, milli: number) => {
        const k = pairKey(p);
        const known = diff.get(k);
        if (known) known.milli += milli;
        else diff.set(k, { productId: p.productId, warehouseId: p.warehouseId, milli });
      };
      for (const it of oldItems) bump(it, -it.qtyMilli);
      lines.forEach((l, i) => bump(l, totals.lines[i]!.qtyMilli));
      for (const d of [...diff.values()].sort((a, b) => (pairKey(a) < pairKey(b) ? -1 : 1))) {
        if (d.milli === 0) continue;
        await applyMovement(tx, {
          date: invoiceDate,
          productId: d.productId,
          warehouseId: d.warehouseId,
          kind: d.milli > 0 ? "SALE_OUT" : "SALE_REVERSAL_IN",
          qtyDeltaMilli: -d.milli,
          ref: number,
          refType: "INVOICE_EDIT",
          invoiceId,
          note: "Adjusted on invoice edit",
          createdBy: actor.id,
        });
      }
    }

    /* ── the journal ── */
    if (postingNow) {
      await postJournalEntry(tx, await loadAccountIds(tx), {
        date: invoiceDate,
        memo: invoiceMemo(number),
        sourceType: INVOICE_SOURCE,
        sourceId: invoiceId,
        createdBy: actor.id,
        lines: invoiceLines(cust.id, totals.grandTotalP),
      });
    } else if (existingPosted) {
      const [entry] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.sourceType, INVOICE_SOURCE), eq(journalEntries.sourceId, invoiceId)))
        .limit(1);
      if (!entry) throw new Error(`Invariant violated: posted invoice ${invoiceId} has no journal entry to correct`);
      await replaceEntryLines(tx, await loadAccountIds(tx), entry.id, invoiceLines(cust.id, totals.grandTotalP));
      await setEntryDate(tx, entry.id, invoiceDate);
    }

    /* ── the money received with the sale: the same receive code path as PaymentsService.receive ── */
    if (!asDraft && paidP > alreadyPaid) {
      const delta = paidP - alreadyPaid;
      await writeReceipt(tx, actor, today, {
        customerId: cust.id,
        amountP: delta,
        allocations: [{ invoiceId, amountP: delta }],
        method: header.paymentMethod,
        ...(header.referenceNo ? { reference: header.referenceNo } : {}),
        date: invoiceDate,
        note: `Received with invoice ${number}`,
      });
    }

    await this.audit(
      tx,
      actor,
      existing ? "Invoice edited" : asDraft ? "Draft invoice saved" : "Invoice created",
      { id: invoiceId, invoiceNumber: number },
      existing ? { grandTotal: existing.totalP, lineCount: existing.lineCount, status: existing.status } : null,
      { grandTotal: totals.grandTotalP, lineCount: totals.lineCount, status, ...(opts.duplicatedFrom ? { duplicatedFrom: opts.duplicatedFrom } : {}) },
      null,
    );
    return { id: invoiceId, replayed: false };
  }
}

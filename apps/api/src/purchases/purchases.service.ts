import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  auditLog,
  companyProfile,
  journalEntries,
  loadAccountIds,
  postJournalEntry,
  products,
  purchaseItems,
  purchaseLines,
  purchaseMemo,
  purchases,
  readProfitCostBasis,
  replaceEntryLines,
  requestKeys,
  suppliers,
  warehouses,
  PURCHASE_SOURCE,
  type Db,
  type Tx,
} from "@farooq/db";
import {
  allocateCharges,
  businessDateOf,
  milliToQty,
  PURCHASE_MESSAGES,
  qtyToMilli,
  roleHasPermission,
  type Permission,
  type PurchaseDetail,
  type SavePurchaseInput,
} from "@farooq/shared";
import { DB } from "../db/db.module.js";
import { allowNegativeStock, applyStockMovement, lockStockLevels, pairKey, sortedPairs, type StockPair } from "../invoices/stock.js";
import { CLOCK, type Clock } from "../payments/clock.js";
import { BusinessRuleError, NotFoundError } from "../payments/errors.js";
import { nextNumber } from "../payments/numbering.js";
import { writePayout } from "../payments/payout-core.js";
import { blankToNull, cleanText, type Actor } from "../payments/receipt-core.js";
import { recomputeAverages, type SavedLineUnit } from "./cost.js";
import { canEditPurchases, loadPurchaseDetail, paidOn, supplierLockReason, vouchersOn } from "./purchases.queries.js";
import { editRefusals, netStockChange, type NewLineFacts, type OldLineFacts } from "./rules.js";
import { validatePurchase, type PurchaseLineForValidation } from "./validate.js";

export interface PurchaseWriteResult {
  purchase: PurchaseDetail;
  /** True when an idempotency key matched an earlier request: nothing new was written. */
  replayed: boolean;
}

type PurchaseRow = typeof purchases.$inferSelect;
type ItemRow = typeof purchaseItems.$inferSelect;

const requirePermission = (actor: Actor, permission: Permission, message: string): void => {
  if (!roleHasPermission(actor.role, permission)) throw new ForbiddenException(message);
};

/** The purchase number's prefix: the company setting `purchasePrefix` (legacy `Settings.get().purchasePrefix || 'PUR'`). */
async function purchasePrefix(tx: Tx): Promise<string> {
  const [row] = await tx.select({ doc: companyProfile.doc }).from(companyProfile).orderBy(asc(companyProfile.id)).limit(1);
  const p = (row?.doc as { purchasePrefix?: unknown } | undefined)?.purchasePrefix;
  return typeof p === "string" && /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(p.trim()) ? p.trim() : "PUR";
}

/**
 * save (record a purchase / edit a recorded one) — ported from the legacy `Purchases.save` (02-services.js 1065-1198) plus the cost
 * wrapper over it (`17-profit.js`, `26-landed-cost.js`), every rule enforced HERE in ONE database transaction. What the legacy did in one
 * IndexedDB transaction — number, header, lines, stock, average cost, voucher, allocation, audit — is one Postgres transaction here.
 *
 * Journal: one PURCHASE entry, DR PURCHASES / CR PAYABLES(supplier) for the grand total, dated the purchase date; an edit rewrites that entry
 * (amount, date, supplier) in place. Every non-cancelled purchase posts, even one nothing has arrived for (an order).
 * Stock: PURCHASE_IN per product × godown for the RECEIVED bags on create; an edit posts the NET difference per product × godown
 * (PURCHASE_IN / PURCHASE_REVERSAL_OUT, ref_type PURCHASE_EDIT, dated the date as saved) where the legacy reversed every old line and
 * re-received the new ones — the level and the purchase ↔ stock check come out the same. Received = 0 books the bill and no stock.
 * Average cost: recomputed from the lines after every save (`cost.ts`).
 * Lock order: purchase → supplier(s) → stock levels (product, then godown) → (payments take their own numbers): two saves cannot deadlock.
 */
@Injectable()
export class PurchasesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `id` null = a new purchase (POST /purchases); otherwise the purchase being edited (PUT /purchases/:id). */
  async save(input: SavePurchaseInput, actor: Actor, id: string | null): Promise<PurchaseWriteResult> {
    const outcome = await this.db.transaction(async (tx) => {
      const key = input.idempotencyKey;
      if (key) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`purchase-idempotency:${key}`}))`);
        const [seen] = await tx.select({ entityId: requestKeys.entityId, kind: requestKeys.kind }).from(requestKeys).where(eq(requestKeys.key, key)).limit(1);
        if (seen) {
          if (seen.kind !== "PURCHASE") throw new BusinessRuleError(["That idempotency key was already used for something else. Use a fresh one."]);
          return { id: seen.entityId, replayed: true };
        }
      }
      const done = await this.saveInTx(tx, actor, businessDateOf(this.clock.now()), input, id);
      if (key) await tx.insert(requestKeys).values({ key, kind: "PURCHASE", entityId: done.id });
      return { id: done.id, replayed: false };
    });
    const purchase = await loadPurchaseDetail(this.db, outcome.id, actor.role);
    if (!purchase) throw new Error(`Purchase ${outcome.id} vanished after commit`);
    return { purchase, replayed: outcome.replayed };
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  private async lockPurchase(tx: Tx, id: string): Promise<PurchaseRow> {
    const [row] = await tx.select().from(purchases).where(eq(purchases.id, id)).for("update").limit(1);
    if (!row) throw new NotFoundError(PURCHASE_MESSAGES.notFound);
    return row;
  }

  /** Serialises purchase work per supplier. NO KEY UPDATE: it must not block other documents' foreign-key checks. */
  private async lockSuppliers(tx: Tx, ids: (string | null | undefined)[]): Promise<void> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return;
    await tx.select({ id: suppliers.id }).from(suppliers).where(inArray(suppliers.id, unique)).orderBy(asc(suppliers.id)).for("no key update");
  }

  private async saveInTx(tx: Tx, actor: Actor, today: string, input: SavePurchaseInput, id: string | null): Promise<{ id: string }> {
    const existing = id ? await this.lockPurchase(tx, id) : null;

    /* ── who may do this, and is it the version they saw? ── */
    if (!existing) requirePermission(actor, "PURCHASE_CREATE", PURCHASE_MESSAGES.noPermissionCreate);
    else {
      if (!canEditPurchases(actor.role)) throw new ForbiddenException(PURCHASE_MESSAGES.noPermissionEdit);
      if (existing.status === "CANCELLED") throw new BusinessRuleError([PURCHASE_MESSAGES.cancelledEdit]);
      if (input.revision === undefined) throw new BusinessRuleError([PURCHASE_MESSAGES.revisionRequired]);
      if (input.revision !== existing.revision) throw new BusinessRuleError([PURCHASE_MESSAGES.stale]);
    }

    /* ── what it refers to (suppliers locked first) ── */
    await this.lockSuppliers(tx, [input.supplierId, existing?.supplierId]);
    const [supplier] = await tx.select().from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
    const whRows = await tx.select({ id: warehouses.id, name: warehouses.name }).from(warehouses);
    const warehouseNames = new Map(whRows.map((w) => [w.id, w.name]));
    const productIds = [...new Set(input.lines.map((l) => l.productId))];
    const productRows = productIds.length ? await tx.select().from(products).where(inArray(products.id, productIds)) : [];
    const productById = new Map(productRows.map((p) => [p.id, p]));
    const oldItems: ItemRow[] = existing ? await tx.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, existing.id)).orderBy(asc(purchaseItems.sortOrder), asc(purchaseItems.id)) : [];
    const oldById = new Map(oldItems.map((i) => [i.id, i]));

    const errors: string[] = [];
    const lines: (PurchaseLineForValidation & { src: SavePurchaseInput["lines"][number] })[] = input.lines.map((l) => ({
      src: l,
      productId: l.productId,
      warehouseId: l.warehouseId ?? input.warehouseId,
      quantity: l.quantity,
      receivedQuantity: l.receivedQuantity,
      unitPriceP: l.unitPriceP,
      discountP: l.discountP ?? 0,
      taxP: l.taxP ?? 0,
      taxRatePct: l.taxRatePct ?? 0,
    }));
    const seenIds = new Set<string>();
    input.lines.forEach((l, i) => {
      if (!l.id) return;
      if (!oldById.has(l.id)) errors.push(`Line ${i + 1}: that line does not belong to this purchase. Reload the purchase and try again.`);
      else if (seenIds.has(l.id)) errors.push(`Line ${i + 1}: that line appears twice. Reload the purchase and try again.`);
      seenIds.add(l.id);
    });

    /* ── money paid with the bill: it can only be raised, and paying out needs its own permission ── */
    const alreadyPaid = existing ? await paidOn(tx, existing.id) : 0;
    const paidP = input.paidAmountP ?? alreadyPaid;
    if (paidP > alreadyPaid) requirePermission(actor, "PAYMENT_PAYOUT", PURCHASE_MESSAGES.noPermissionPayment);

    /* ── stock: lock every touched level in a fixed order, then read what is there ── */
    const okPairs = (l: { productId: string; warehouseId: string }) => warehouseNames.has(l.warehouseId) && productById.has(l.productId);
    const pairs: StockPair[] = [...lines.filter(okPairs), ...oldItems];
    const levels = await lockStockLevels(tx, pairs);

    const v = validatePurchase(
      {
        supplierId: input.supplierId,
        warehouseId: input.warehouseId,
        invoiceDiscountP: input.invoiceDiscountP ?? 0,
        freightP: input.freightP ?? 0,
        loadingP: input.loadingP ?? 0,
        otherChargesP: input.otherChargesP ?? 0,
        paidP,
      },
      lines,
      {
        supplierExists: !!supplier,
        warehouseNames,
        products: new Map([...productById].map(([k, p]) => [k, { name: p.name, nameEn: p.nameEn, nameUr: p.nameUr }])),
      },
    );
    errors.push(...v.errors);
    const totals = v.totals;
    const recvMilli = lines.map((l, i) => (l.receivedQuantity === undefined ? totals.lines[i]!.qtyMilli : qtyToMilli(l.receivedQuantity)));

    /* ── an edit's own refusals (legacy `editErrors`), judged only once the form itself is valid, like the legacy ── */
    if (existing && errors.length === 0) {
      const vouchers = (await vouchersOn(tx, existing.id)).filter((x) => x.status !== "REVERSED");
      const oldFacts: OldLineFacts[] = oldItems.map((o) => ({
        id: o.id,
        productId: o.productId,
        warehouseId: o.warehouseId,
        descriptionSnapshot: o.descriptionSnapshot,
        descriptionEnSnapshot: o.descriptionEnSnapshot,
        receivedQtyMilli: o.receivedQtyMilli,
        returnedQtyMilli: o.returnedQtyMilli,
        operationalShareP: o.operationalShareP,
      }));
      const newFacts: NewLineFacts[] = lines.map((l, i) => ({ id: l.src.id, productId: l.productId, warehouseId: l.warehouseId, receivedQtyMilli: recvMilli[i]! }));
      const productName = (pid: string): string => {
        const p = productById.get(pid) ?? oldFacts.find((o) => o.productId === pid);
        if (!p) return "that product";
        return "nameEn" in p ? (p.nameEn || p.nameUr || "that product") : (p.descriptionEnSnapshot || p.descriptionSnapshot || "that product");
      };
      errors.push(
        ...editRefusals({
          oldLines: oldFacts,
          newLines: newFacts,
          supplierLockReason: input.supplierId !== existing.supplierId ? await supplierLockReason(tx, existing, oldItems) : null,
          paidNowP: alreadyPaid,
          voucherNumbers: vouchers.map((x) => x.receiptNumber),
          newPaidP: paidP,
          allowNegativeStock: await allowNegativeStock(tx),
          levelMilli: (productId, warehouseId) => levels.get(pairKey({ productId, warehouseId })) ?? 0,
          productName,
          warehouseName: (wid) => warehouseNames.get(wid) ?? wid,
        }),
      );
    }
    const all = [...new Set(errors)];
    if (all.length) throw new BusinessRuleError(all);
    const sup = supplier!;

    /* ── the cost of every line: the charges spread over the lines (`allocateCharges`, fix 3 for a part delivery) + the operational share carried over ── */
    const chargesP = totals.freightP + totals.loadingP + totals.otherChargesP;
    const alloc = allocateCharges(
      lines.map((_, i) => ({ qtyMilli: totals.lines[i]!.qtyMilli, receivedQtyMilli: recvMilli[i]!, unitPriceP: totals.lines[i]!.unitPriceP, lineTotalP: totals.lines[i]!.lineTotalP })),
      chargesP,
    );
    const basis = await readProfitCostBasis(tx);
    const opShare = lines.map((l) => (l.src.id ? (oldById.get(l.src.id)?.operationalShareP ?? null) : null));
    const landedUnit = lines.map((_, i) => alloc[i]!.landedUnitP + (recvMilli[i]! > 0 && opShare[i] ? Math.round(opShare[i]! / (recvMilli[i]! / 1000)) : 0));

    /* ── the header ── */
    const ordMilli = totals.totalQtyMilli;
    const recMilli = recvMilli.reduce((a, b) => a + b, 0);
    const status = recMilli >= ordMilli ? "RECEIVED" : recMilli > 0 ? "PARTIALLY_RECEIVED" : "ORDERED";
    const number = existing?.purchaseNumber ?? (await nextNumber(tx, await purchasePrefix(tx), Number(today.slice(0, 4))));
    const date = input.date ?? existing?.date ?? today;
    const now = this.clock.now();
    const header = {
      purchaseNumber: number,
      supplierId: sup.id,
      supplierNameSnapshot: sup.companyName,
      supplierInvoiceNo: blankToNull(input.supplierInvoiceNo),
      warehouseId: input.warehouseId,
      warehouseSnapshot: warehouseNames.get(input.warehouseId) ?? null,
      date,
      vehicleNo: blankToNull(input.vehicleNo)?.toUpperCase() ?? null,
      driver: blankToNull(input.driver),
      deliveryRef: blankToNull(input.deliveryRef),
      subtotalP: totals.subtotalP,
      discountAmountP: totals.discountAmountP,
      taxP: totals.taxP,
      freightP: totals.freightP,
      loadingP: totals.loadingP,
      otherChargesP: totals.otherChargesP,
      totalP: totals.grandTotalP,
      status,
      notes: blankToNull(input.notes),
      // an edit keeps the description unless the form says otherwise (legacy: it stays when the form's is blank or unchanged)
      description: input.description !== undefined ? blankToNull(input.description) : (existing?.description ?? null),
      totalQtyMilli: ordMilli,
      orderedQtyMilli: ordMilli,
      receivedQtyMilli: recMilli,
      lineCount: totals.lineCount,
      stockApplied: recMilli > 0,
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: now,
    };
    const [saved] = existing
      ? await tx.update(purchases).set(header).where(eq(purchases.id, existing.id)).returning({ id: purchases.id })
      : await tx.insert(purchases).values({ ...header, createdBy: actor.id }).returning({ id: purchases.id });
    const purchaseId = saved!.id;

    /* ── the lines: stable ids for lines that were kept (returns and landed costs point at them), the rest deleted / new ── */
    const keep = new Set(input.lines.map((l) => l.id).filter((x): x is string => !!x));
    const dropped = oldItems.filter((o) => !keep.has(o.id)).map((o) => o.id);
    if (dropped.length) await tx.delete(purchaseItems).where(inArray(purchaseItems.id, dropped));
    const savedUnits: SavedLineUnit[] = [];
    for (const [i, l] of lines.entries()) {
      const p = productById.get(l.productId)!;
      const t = totals.lines[i]!;
      const old = l.src.id ? oldById.get(l.src.id) : undefined;
      const row = {
        purchaseId,
        sortOrder: i,
        productId: l.productId,
        warehouseId: l.warehouseId,
        descriptionSnapshot: p.nameUr ?? p.nameEn ?? p.name,
        descriptionEnSnapshot: p.nameEn,
        brandSnapshot: p.brandEn ?? p.brand,
        packageSnapshot: p.weightKg ? `${p.weightKg} KG` : "Bag",
        unit: cleanText(l.src.unit) ?? "Bag",
        qtyMilli: t.qtyMilli,
        receivedQtyMilli: recvMilli[i]!,
        returnedQtyMilli: old?.returnedQtyMilli ?? 0,
        unitPriceP: t.unitPriceP,
        discountP: t.discountP,
        taxP: t.taxP,
        lineTotalP: t.lineTotalP,
        goodsUnitCostP: alloc[i]!.goodsUnitP,
        chargeShareP: alloc[i]!.chargeShareP,
        landedUnitCostP: landedUnit[i]!,
        operationalShareP: opShare[i] ?? null,
        batchNo: blankToNull(l.src.batchNo),
        notes: blankToNull(l.src.notes),
      };
      if (old) await tx.update(purchaseItems).set(row).where(eq(purchaseItems.id, old.id));
      else await tx.insert(purchaseItems).values(row);
      savedUnits.push({ productId: l.productId, warehouseId: l.warehouseId, unitP: basis === "LANDED" ? landedUnit[i]! : alloc[i]!.goodsUnitP });
    }

    /* ── stock: the bags that ARRIVED (a create books each pair; an edit posts the net difference) ── */
    const weightedPrice = new Map<string, number>(); // received-weighted unit price per pair (planner decision 1)
    {
      const acc = new Map<string, { qty: number; value: number }>();
      lines.forEach((l, i) => {
        const a = acc.get(pairKey(l)) ?? { qty: 0, value: 0 };
        a.qty += recvMilli[i]!;
        a.value += totals.lines[i]!.unitPriceP * recvMilli[i]!;
        acc.set(pairKey(l), a);
      });
      for (const [k, a] of acc) if (a.qty > 0) weightedPrice.set(k, Math.round(a.value / a.qty));
    }
    const costOf = (pair: StockPair): number | null => {
      const c = weightedPrice.get(pairKey(pair)) ?? 0;
      return c > 0 ? c : null; // the importer stores a legacy 0 as "no cost recorded"
    };
    const changes = netStockChange(existing ? oldItems : [], lines.map((l, i) => ({ productId: l.productId, warehouseId: l.warehouseId, receivedQtyMilli: recvMilli[i]! })));
    for (const d of changes) {
      if (d.milli === 0) continue;
      await applyStockMovement(tx, {
        date,
        productId: d.productId,
        warehouseId: d.warehouseId,
        kind: d.milli > 0 ? "PURCHASE_IN" : "PURCHASE_REVERSAL_OUT",
        qtyDeltaMilli: d.milli,
        unitCostP: d.milli > 0 ? costOf(d) : null,
        ref: number,
        refType: existing ? "PURCHASE_EDIT" : "PURCHASE",
        sourceType: "PURCHASE",
        sourceId: purchaseId,
        note: existing ? "Adjusted on purchase edit" : sup.companyName,
        createdBy: actor.id,
      });
    }

    /* ── average cost: every pair touched now or before this edit ── */
    await recomputeAverages(tx, basis, sortedPairs([...lines, ...oldItems]), savedUnits);

    /* ── the journal ── */
    const accountIds = await loadAccountIds(tx);
    if (!existing) {
      await postJournalEntry(tx, accountIds, {
        date,
        memo: purchaseMemo(number),
        sourceType: PURCHASE_SOURCE,
        sourceId: purchaseId,
        createdBy: actor.id,
        lines: purchaseLines(sup.id, totals.grandTotalP),
      });
    } else {
      const [entry] = await tx
        .select({ id: journalEntries.id })
        .from(journalEntries)
        .where(and(eq(journalEntries.sourceType, PURCHASE_SOURCE), eq(journalEntries.sourceId, purchaseId)))
        .limit(1);
      if (!entry) throw new Error(`Invariant violated: purchase ${purchaseId} has no journal entry to correct`);
      await replaceEntryLines(tx, accountIds, entry.id, purchaseLines(sup.id, totals.grandTotalP));
      await tx.update(journalEntries).set({ date, memo: purchaseMemo(number) }).where(eq(journalEntries.id, entry.id));
    }

    /* ── the money paid with the bill: the same payout code path as PaymentsService.pay; only ever ADDED (saving twice must not pay twice) ── */
    if (paidP > alreadyPaid) {
      const delta = paidP - alreadyPaid;
      await writePayout(tx, actor, today, {
        supplierId: sup.id,
        amountP: delta,
        allocations: [{ purchaseId, amountP: delta }],
        method: blankToNull(input.paymentMethod) ?? "Cash",
        ...(header.supplierInvoiceNo ? { reference: header.supplierInvoiceNo } : {}),
        date,
        note: `Paid with purchase ${number}`,
      });
    }

    await tx.insert(auditLog).values({
      actorId: actor.id,
      action: existing ? "Purchase edited" : "Purchase recorded",
      entity: "Purchase",
      entityId: purchaseId,
      before: existing ? { grandTotal: existing.totalP, lineCount: existing.lineCount, supplier: existing.supplierNameSnapshot, received: milliToQty(existing.receivedQtyMilli), status: existing.status } : null,
      after: { ref: number, grandTotal: totals.grandTotalP, lineCount: totals.lineCount, supplier: sup.companyName, received: milliToQty(recMilli), status },
    });
    return { id: purchaseId };
  }
}

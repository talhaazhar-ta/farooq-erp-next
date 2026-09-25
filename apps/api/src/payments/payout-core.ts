import { eq } from "drizzle-orm";
import { auditLog, paymentAllocations, suppliers, type Tx } from "@farooq/db";
import { PAYMENT_MESSAGES } from "@farooq/shared";
import { BusinessRuleError } from "./errors.js";
import { lockPurchases, purchaseOutstanding } from "./outstanding.js";
import { cleanText, insertVoucher, rupees, type Actor, type Allocation } from "./receipt-core.js";

/**
 * The write half of "money out to a supplier", extracted from `PaymentsService.pay` in S12 (the way S7 extracted `writeReceipt`) so that BOTH
 * `PaymentsService.pay` and a purchase saved with money paid at the time run the very same code: one voucher, one journal entry, its
 * allocations and the audit row — all inside the CALLER'S transaction. S3's tests exercise it unchanged; S12's add the purchase-side cases.
 */

/**
 * Same guards for a supplier payment's optional purchase allocations (outstanding = total − allocations of POSTED payments; CANCELLED
 * refused): every purchase must exist, belong to THIS supplier, not be cancelled, appear once, and receive at most its outstanding.
 */
export async function checkPurchaseAllocations(tx: Tx, supplierId: string, amountP: number, requested: { purchaseId: string; amountP: number }[]): Promise<Allocation[]> {
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

export interface PayoutInput {
  supplierId: string;
  amountP: number;
  allocations?: { purchaseId: string; amountP: number }[] | undefined;
  method?: string | undefined;
  reference?: string | undefined;
  note?: string | undefined;
  date?: string | undefined;
  idempotencyKey?: string | undefined;
}

/**
 * Money out to a supplier, inside the caller's transaction: checks the supplier and the allocations, writes the voucher (number, row,
 * journal entry), its allocation rows and the audit row. Returns the voucher's id. Deliberately does NOT touch `purchases.status`:
 * a purchase's payment state is derived from the allocations (the legacy `_write` never stored it either).
 */
export async function writePayout(tx: Tx, actor: Actor, today: string, input: PayoutInput): Promise<string> {
  const [sup] = await tx.select({ id: suppliers.id, name: suppliers.companyName, doc: suppliers.legacyDoc }).from(suppliers).where(eq(suppliers.id, input.supplierId)).limit(1);
  if (!sup) throw new BusinessRuleError([PAYMENT_MESSAGES.chooseSupplier]);

  const allocations = input.allocations?.length ? await checkPurchaseAllocations(tx, input.supplierId, input.amountP, input.allocations) : [];

  const payment = await insertVoucher(tx, actor, today, {
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
  await tx.insert(auditLog).values({
    actorId: actor.id,
    action: "Payment made to supplier",
    entity: "Payment",
    entityId: payment.id,
    before: null,
    after: {
      receiptNumber: payment.receiptNumber,
      amountP: input.amountP,
      method: payment.method,
      party: sup.name,
      allocations: allocations.map((a) => ({ purchaseId: a.documentId, amountP: a.amountP })),
    },
  });
  return payment.id;
}

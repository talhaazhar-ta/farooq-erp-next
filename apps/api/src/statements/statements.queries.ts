import { and, asc, eq, sql } from "drizzle-orm";
import { companyProfile, customers, invoices, paymentAllocations, payments, purchases, regions, suppliers, type Executor } from "@farooq/db";
import {
  amountInWords,
  COMPANY_DISPLAY_FIELDS,
  RECEIPT_LABELS,
  type CompanyProfile,
  type Receipt,
  type Region,
  type Statement,
  type StatementQuery,
} from "@farooq/shared";
import { deltaOf, loadFullLedger, windowStatement, type PartyType } from "./ledger.js";

/* ── company profile: a whitelist of the settings document, never the whole bag ───────────────────── */

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

/** The display fields a printed page needs, from the legacy settings document; defaults as the legacy `DocModel.business`. */
export function pickCompanyFields(doc: Record<string, unknown> | null): CompanyProfile {
  const d = doc ?? {};
  const out: Record<string, string | null> = {};
  for (const key of COMPANY_DISPLAY_FIELDS) out[key] = text(d[key]);
  return { ...out, logoText: out.logoText ?? "F&C", currencyLabel: out.currencyLabel ?? "PKR" } as CompanyProfile;
}

export async function loadCompany(db: Executor): Promise<CompanyProfile> {
  const [row] = await db.select({ doc: companyProfile.doc }).from(companyProfile).orderBy(asc(companyProfile.id)).limit(1);
  return pickCompanyFields((row?.doc as Record<string, unknown> | undefined) ?? null);
}

export async function listRegions(db: Executor): Promise<Region[]> {
  const rows = await db.select({ id: regions.id, nameEn: regions.nameEn, nameUr: regions.nameUr, active: regions.active }).from(regions).orderBy(asc(regions.nameEn), asc(regions.id));
  return rows;
}

/* ── statements ─────────────────────────────────────────────────────── */

const regionLabel = (en: string | null, ur: string | null): string | null => (en ? (ur ? `${ur} — ${en}` : en) : null);

async function loadParty(db: Executor, type: PartyType, id: string): Promise<Statement["party"] | null> {
  if (type === "CUSTOMER") {
    const [c] = await db
      .select({ name: customers.shopName, owner: customers.ownerName, phone: customers.phone, code: customers.legacyCode, en: regions.nameEn, ur: regions.nameUr })
      .from(customers)
      .leftJoin(regions, eq(customers.regionId, regions.id))
      .where(eq(customers.id, id))
      .limit(1);
    return c ? { type, id, name: c.name, owner: c.owner || null, region: regionLabel(c.en, c.ur), phone: c.phone || null, legacyCode: c.code || null } : null;
  }
  const [s] = await db
    .select({ name: suppliers.companyName, phone: suppliers.phone, doc: suppliers.legacyDoc })
    .from(suppliers)
    .where(eq(suppliers.id, id))
    .limit(1);
  if (!s) return null;
  const doc = (s.doc ?? {}) as { cp?: unknown; legacyCode?: unknown };
  return { type, id, name: s.name, owner: text(doc.cp), region: null, phone: s.phone || null, legacyCode: text(doc.legacyCode) };
}

/** `GET /customers/:id/statement` and `/suppliers/:id/statement`. Null = no such party. */
export async function loadStatement(db: Executor, type: PartyType, id: string, q: StatementQuery): Promise<Statement | null> {
  const party = await loadParty(db, type, id);
  if (!party) return null;
  const ledger = await loadFullLedger(db, type, id);
  return { party, ...windowStatement(type, ledger, { from: q.from ?? null, to: q.to ?? null }) };
}

/* ── receipt / voucher ──────────────────────────────────────────────── */

/** `GET /payments/:id/receipt`. Null = no such payment. See RECEIPT_LABELS for the (legacy, verbatim) wording. */
export async function loadReceipt(db: Executor, paymentId: string): Promise<Receipt | null> {
  const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!p) return null;
  const incoming = p.direction === "IN";
  const partyType = p.partyType as PartyType;
  const reversed = p.status === "REVERSED";

  const allocs = await db
    .select({
      invoiceId: paymentAllocations.invoiceId,
      purchaseId: paymentAllocations.purchaseId,
      amountP: paymentAllocations.amountP,
      invoiceNumber: invoices.invoiceNumber,
      invoiceDate: invoices.date,
      purchaseNumber: purchases.purchaseNumber,
      purchaseDate: purchases.date,
    })
    .from(paymentAllocations)
    .leftJoin(invoices, eq(paymentAllocations.invoiceId, invoices.id))
    .leftJoin(purchases, eq(paymentAllocations.purchaseId, purchases.id))
    .where(eq(paymentAllocations.paymentId, p.id))
    .orderBy(
      asc(paymentAllocations.createdAt),
      asc(sql`COALESCE(${invoices.date}, ${purchases.date})`),
      asc(sql`COALESCE(${invoices.invoiceNumber}, ${purchases.purchaseNumber})`),
      asc(paymentAllocations.id),
    );

  // The customer's CURRENT phone (the legacy receipt read it live); the name / owner / region are the printed snapshots.
  let phone: string | null = null;
  if (partyType === "CUSTOMER") {
    const [c] = await db.select({ phone: customers.phone }).from(customers).where(and(eq(customers.id, p.partyId))).limit(1);
    phone = c?.phone || null;
  }

  // Balances: the party's running balance immediately before / after THIS voucher's row in the statement order.
  let previousBalanceP: number | null = null;
  let remainingBalanceP: number | null = null;
  if (!reversed) {
    const ledger = await loadFullLedger(db, partyType, p.partyId);
    let running = 0;
    for (const e of ledger.entries) {
      const before = running;
      running += deltaOf(partyType, e);
      if (e.sourceType === "PAYMENT" && e.sourceId === p.id) {
        previousBalanceP = before;
        remainingBalanceP = running;
        break;
      }
    }
  }

  const labels = incoming ? RECEIPT_LABELS.receipt : RECEIPT_LABELS.voucher;
  const rows = allocs.map((a) => ({
    documentType: (a.invoiceId ? "INVOICE" : "PURCHASE") as "INVOICE" | "PURCHASE",
    documentId: (a.invoiceId ?? a.purchaseId)!,
    documentNumber: a.invoiceNumber ?? a.purchaseNumber ?? null,
    documentDate: (a.invoiceDate ?? a.purchaseDate) ?? "",
    amountP: a.amountP,
  }));
  return {
    kind: incoming ? "RECEIPT" : "VOUCHER",
    title: labels.title,
    paymentId: p.id,
    number: p.receiptNumber,
    status: reversed ? "Reversed" : "Posted",
    cancelled: reversed,
    date: p.paymentDate,
    company: await loadCompany(db),
    party: { label: labels.party, type: partyType, id: p.partyId, name: p.partyNameSnapshot, owner: p.partyOwnerSnapshot, region: p.regionSnapshot, phone },
    meta: { receiptNumber: p.receiptNumber, method: p.method, reference: p.reference, receivedBy: p.receivedBy },
    allocations: rows,
    totalAppliedP: rows.reduce((a, r) => a + r.amountP, 0),
    amountP: p.amountP,
    amountLabel: labels.amount,
    amountInWords: amountInWords(p.amountP),
    previousBalanceP,
    remainingBalanceP,
    notes: p.note,
    reversal: reversed ? { reason: p.reverseReason, at: p.reversedAt ? p.reversedAt.toISOString() : null } : null,
    labels: { meta: RECEIPT_LABELS.meta, signatures: [...RECEIPT_LABELS.signatures], thanks: RECEIPT_LABELS.thanks, terms: RECEIPT_LABELS.terms },
  };
}

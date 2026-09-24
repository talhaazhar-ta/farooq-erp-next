import { asc, eq, sql } from "drizzle-orm";
import { companyProfile, customers, invoiceItems, invoices, regions, type Executor } from "@farooq/db";
import {
  amountInWords,
  CLASSIC_LABELS,
  formatBusinessDate,
  formatMoney,
  formatPaisaPlain,
  formatQtyMilli,
  INVOICE_PRINT_LABELS,
  INVOICE_STATUS_LABELS,
  paymentStatusOf,
  type InvoicePrint,
  type InvoiceTemplate,
} from "@farooq/shared";
import { customerBalance } from "../payments/payments.queries.js";
import { loadCompany } from "../statements/statements.queries.js";
import { loadFullLedger } from "../statements/ledger.js";
import { receiptsOn } from "./rules.js";
import { paidOn } from "./invoices.queries.js";

/**
 * The printed sales invoice, as ONE model that both layouts render — the legacy `DocModel.invoice` (04-documents.js) plus the
 * `classic` block (08-classic-invoice.js `classicBlock`), built from the database, never from a form. See `invoicePrintSchema`
 * for every field and `INVOICE_PRINT_LABELS` / `CLASSIC_LABELS` for the (verbatim) wording.
 *
 *  - draft: number "DRAFT", `hasNumber` false, `isDraft` — no number is invented; cancelled: `cancelled` for a stamp;
 *  - totals rows: Subtotal, then Item discounts / Invoice discount / Tax / Delivery / Loading / Other charges ONLY when not zero,
 *    then Grand total, Amount Paid and Balance on this invoice (the legacy pushed them in that order);
 *  - classic: the invoice's own number is `SLV-` (the business's `salesDocPrefix`) + the trailing digits to six places; the account
 *    block is the shop's LAST SIX ledger rows up to and including this invoice, from the S4 statement builder (`loadFullLedger`) —
 *    not a second implementation; "Opening" is the frozen `previous_balance_p`, "Balance" = opening + grand total − paid;
 *  - standard: the same ledger box with the shop's CURRENT outstanding balance (live, from the journal) on its last line.
 * The template printed is the one asked for, else the business's `invoiceTemplate` setting, else `classic` (the live setting).
 */

type ItemRow = typeof invoiceItems.$inferSelect;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const dmy = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const p = iso.slice(0, 10).split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso;
};

/** The three settings the invoice reads that the company block does not carry. */
async function loadInvoiceSettings(db: Executor): Promise<{ template: InvoiceTemplate; prefix: string; thanks: string; terms: string; bank: string }> {
  const [row] = await db.select({ doc: companyProfile.doc }).from(companyProfile).orderBy(asc(companyProfile.id)).limit(1);
  const d = (row?.doc ?? {}) as Record<string, unknown>;
  const template = text(d.invoiceTemplate);
  return {
    template: template === "standard" ? "standard" : "classic",
    prefix: text(d.salesDocPrefix) || "SLV",
    thanks: text(d.invoiceFooter) || INVOICE_PRINT_LABELS.thanks,
    terms: text(d.terms),
    bank: text(d.bankDetails),
  };
}

const pluralQty = (it: ItemRow): string => `${formatQtyMilli(it.qtyMilli)} ${it.unit || "Bag"}${it.qtyMilli === 1000 ? "" : "s"}`;

/** `GET /invoices/:id/print`. Null when there is no such invoice. */
export async function loadInvoicePrint(db: Executor, id: string, requested?: InvoiceTemplate): Promise<InvoicePrint | null> {
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
  if (!inv) return null;
  const items = await db.select().from(invoiceItems).where(eq(invoiceItems.invoiceId, id)).orderBy(asc(invoiceItems.sortOrder), asc(invoiceItems.id));
  const settings = await loadInvoiceSettings(db);
  const company = await loadCompany(db);
  const L = INVOICE_PRINT_LABELS;
  const T = L.totals;

  const paidP = await paidOn(db, id);
  const receipts = (await receiptsOn(db, id)).filter((r) => r.status === "POSTED");
  const receiptExtra = receipts.length
    ? await db.execute<{ id: string; method: string | null; reference: string | null }>(sql`SELECT id::text AS id, method, reference FROM payments WHERE id IN (${sql.join(receipts.map((r) => sql`${r.paymentId}::uuid`), sql`, `)})`)
    : [];
  const extra = new Map([...receiptExtra].map((r) => [r.id, r]));

  const isDraft = inv.status === "DRAFT";
  const cancelled = inv.status === "CANCELLED";
  const number = inv.invoiceNumber || L.draftNumber;
  const openingP = inv.previousBalanceP || 0;

  // ── the shop as it is now: code, the region's Urdu name, the live balance ──
  let currentCode: string | null = null;
  let currentRegionUr = "";
  let currentBalanceP: number | null = null;
  if (inv.customerId) {
    const [c] = await db
      .select({ code: customers.legacyCode, ur: regions.nameUr })
      .from(customers)
      .leftJoin(regions, eq(customers.regionId, regions.id))
      .where(eq(customers.id, inv.customerId))
      .limit(1);
    currentCode = c?.code || null;
    currentRegionUr = c?.ur || "";
    currentBalanceP = await customerBalance(db, inv.customerId);
  }

  // ── standard model ──
  const totals: InvoicePrint["totals"] = [];
  const row = (key: string, label: string, amountP: number, text: string, o: Partial<{ labelUr: string; big: boolean; bold: boolean; rule: boolean }> = {}) =>
    totals.push({ key, label, labelUr: o.labelUr ?? null, amountP, text, big: o.big ?? false, bold: o.bold ?? false, rule: o.rule ?? false });
  row("subtotal", T.subtotal, inv.subtotalP, formatMoney(inv.subtotalP));
  if (inv.itemDiscountsP) row("itemDiscounts", T.itemDiscounts, inv.itemDiscountsP, "− " + formatMoney(inv.itemDiscountsP));
  if (inv.invoiceDiscountP) row("invoiceDiscount", T.invoiceDiscount, inv.invoiceDiscountP, "− " + formatMoney(inv.invoiceDiscountP));
  if (inv.taxP) row("tax", T.tax, inv.taxP, formatMoney(inv.taxP));
  if (inv.freightP) row("freight", T.freight, inv.freightP, formatMoney(inv.freightP));
  if (inv.loadingP) row("loading", T.loading, inv.loadingP, formatMoney(inv.loadingP));
  if (inv.otherChargesP) row("other", T.other, inv.otherChargesP, formatMoney(inv.otherChargesP));
  row("grand", T.grand, inv.totalP, formatMoney(inv.totalP), { labelUr: T.grandUr, big: true, rule: true });
  row("paid", T.paid, paidP, formatMoney(paidP), { labelUr: T.paidUr });
  row("balance", T.balance, inv.totalP - paidP, formatMoney(inv.totalP - paidP), { labelUr: T.balanceUr, bold: true });

  const ledger: InvoicePrint["ledger"] = [
    { label: L.ledger.previous, labelUr: L.ledger.previousUr, text: formatMoney(openingP), amountP: openingP },
    { label: L.ledger.thisInvoice, labelUr: "", text: "+ " + formatMoney(inv.totalP), amountP: inv.totalP },
    { label: L.ledger.received, labelUr: "", text: "− " + formatMoney(paidP), amountP: paidP },
    { label: L.ledger.current, labelUr: L.ledger.currentUr, text: formatMoney(currentBalanceP ?? 0), amountP: currentBalanceP ?? 0 },
  ];

  // ── classic block: the shop's last six account rows up to and including this invoice ──
  const entries = inv.customerId ? (await loadFullLedger(db, "CUSTOMER", inv.customerId)).entries : [];
  const upto: typeof entries = [];
  for (const e of entries) {
    upto.push(e);
    if (e.kind === "INVOICE" && e.ref === inv.invoiceNumber) break;
  }
  const shown = upto.slice(-6);
  const serialMatch = /(\d+)$/.exec(inv.invoiceNumber || "");
  const serial = serialMatch ? parseInt(serialMatch[1]!, 10) : 0;
  const drSum = shown.reduce((a, e) => a + e.debitP, 0);
  const crSum = shown.reduce((a, e) => a + e.creditP, 0);
  const boxAmounts = [inv.totalP, openingP, openingP + inv.totalP, paidP, 0, openingP + inv.totalP - paidP];
  const boxBig = [false, false, true, false, false, true];
  const phones = [company.phone && CLASSIC_LABELS.phoneMobileUr + company.phone, company.shopPhone && CLASSIC_LABELS.phoneShopUr + company.shopPhone, company.proprietor].filter((x): x is string => Boolean(x));

  return {
    kind: "INVOICE",
    title: L.title,
    invoiceId: inv.id,
    number,
    hasNumber: Boolean(inv.invoiceNumber),
    status: (INVOICE_STATUS_LABELS as Record<string, string>)[inv.status] ?? inv.status,
    statusKey: inv.status,
    isDraft,
    cancelled,
    date: inv.date,
    template: requested ?? settings.template,
    company,
    party: {
      label: L.billTo,
      labelUr: L.billToUr,
      customerId: inv.customerId,
      shop: inv.shopNameSnapshot,
      owner: inv.customerNameSnapshot,
      code: inv.customerCodeSnapshot,
      contact: inv.mobileSnapshot,
      whatsapp: inv.whatsappSnapshot,
      address: inv.addressSnapshot,
      region: inv.regionSnapshot,
      market: inv.marketSnapshot,
    },
    metaLabel: L.meta,
    meta: [
      { label: L.metaRows.number, value: inv.invoiceNumber || L.notIssued, strong: true },
      { label: L.metaRows.type, value: inv.invoiceType === "SALE" ? L.saleType : inv.invoiceType, strong: false },
      { label: L.metaRows.date, value: formatBusinessDate(inv.date), strong: false },
      { label: L.metaRows.dueDate, value: inv.dueDate ? formatBusinessDate(inv.dueDate) : "—", strong: false },
      { label: L.metaRows.order, value: inv.orderNumber || "—", strong: false },
      { label: L.metaRows.dispatch, value: inv.dispatchNumber || "", strong: false },
      { label: L.metaRows.warehouse, value: inv.warehouseSnapshot || "", strong: false },
      { label: L.metaRows.paymentStatus, value: INVOICE_STATUS_LABELS[paymentStatusOf(inv.totalP, paidP)], strong: false },
      { label: L.metaRows.salesperson, value: inv.salesperson || "", strong: false },
    ],
    strip: [
      { label: L.strip.method, value: inv.paymentMethod || "—" },
      { label: L.strip.reference, value: inv.referenceNo || "—" },
      { label: L.strip.region, value: inv.regionSnapshot || "—" },
      { label: L.strip.items, value: String(items.length) },
    ],
    columns: L.columns.map((c) => ({ ...c })),
    rows: items.map((it, i) => ({
      sr: i + 1,
      description: it.descriptionEnSnapshot || "",
      descriptionUr: it.descriptionSnapshot || "",
      brand: it.brandSnapshot || "—",
      pack: it.packageSnapshot || "Bag",
      qty: pluralQty(it),
      quantity: it.qtyMilli / 1000,
      rateP: it.unitPriceP,
      rate: formatPaisaPlain(it.unitPriceP),
      discountP: it.discountP,
      discount: it.discountP ? formatPaisaPlain(it.discountP) : "—",
      amountP: it.lineTotalP,
      amount: formatPaisaPlain(it.lineTotalP),
      returned: it.returnedQtyMilli / 1000,
      batch: it.batchNo || "",
    })),
    itemsFooter: {
      description: `Total — ${items.length}${items.length === 1 ? " line" : " lines"}`,
      qty: `${formatQtyMilli(inv.totalQtyMilli)} Bags`,
      amountP: inv.subtotalP - inv.itemDiscountsP,
      amount: formatPaisaPlain(inv.subtotalP - inv.itemDiscountsP),
    },
    totals,
    totalP: inv.totalP,
    paidP,
    balanceP: inv.totalP - paidP,
    amountInWords: amountInWords(inv.totalP),
    labels: { words: L.words, ledger: { ...L.ledger }, ribbon: { cancelled: L.ribbonCancelled, draft: L.ribbonDraft } },
    payments: receipts.map((r) => ({
      paymentId: r.paymentId,
      receiptNumber: r.receiptNumber,
      date: r.date,
      method: extra.get(r.paymentId)?.method ?? null,
      reference: extra.get(r.paymentId)?.reference ?? null,
      amountP: r.allocatedToThisP,
      text: formatMoney(r.allocatedToThisP),
    })),
    notes: inv.notes || "",
    ledger,
    previousBalanceP: openingP,
    currentBalanceP,
    signatures: [...L.signatures],
    footer: { thanks: settings.thanks, terms: settings.terms, bank: settings.bank },
    classic: {
      serial,
      invNo: `${settings.prefix}-${String(serial).padStart(6, "0")}`,
      idNo: currentCode || inv.customerCodeSnapshot || "",
      contact: inv.mobileSnapshot || "Nil",
      regionUr: currentRegionUr || (inv.regionSnapshot || "").split(" — ")[0]!,
      remarks: inv.notes || "",
      ledgerRows: shown.map((e) => ({
        date: dmy(e.date),
        drP: e.debitP,
        crP: e.creditP,
        dr: e.debitP ? formatPaisaPlain(e.debitP) : "0",
        cr: e.creditP ? formatPaisaPlain(e.creditP) : "0",
      })),
      ledgerTotals: { drP: drSum, crP: crSum, dr: formatPaisaPlain(drSum), cr: formatPaisaPlain(crSum) },
      box: CLASSIC_LABELS.box.map(([label, labelUr], i) => ({ label, labelUr, amountP: boxAmounts[i]!, text: formatPaisaPlain(boxAmounts[i]!), big: boxBig[i]! })),
      qtyTotal: inv.totalQtyMilli / 1000,
      lineTotalP: inv.totalP,
      lineTotal: formatPaisaPlain(inv.totalP),
      phones,
    },
  };
}

import type { InvoiceDetail } from "@farooq/shared";

export const IDS = {
  invoice: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  shop: "11111111-1111-4111-8111-111111111111",
  other: "22222222-2222-4222-8222-222222222222",
  third: "33333333-3333-4333-8333-333333333333",
  product: "44444444-4444-4444-8444-444444444444",
  product2: "44444444-4444-4444-8444-444444444445",
  warehouse: "55555555-5555-4555-8555-555555555555",
  line: "66666666-6666-4666-8666-666666666666",
  line2: "66666666-6666-4666-8666-666666666667",
  receipt: "77777777-7777-4777-8777-777777777777",
  move: "88888888-8888-4888-8888-888888888888",
};

const allowed = { allowed: true, reason: null };

/** A posted, unpaid invoice of 27,425.00 (2,742,500 paisa): 20 bags + 10 bags. Override anything; `profit` is absent unless given (as for a role without PROFIT_VIEW). */
export function invoiceDetail(patch: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    id: IDS.invoice,
    number: "INV-2026-000001",
    status: "CONFIRMED",
    paymentStatus: "UNPAID",
    invoiceType: "SALE",
    date: "2026-09-01",
    dueDate: null,
    customerId: IDS.shop,
    shop: { code: "C001", name: "Alpha Store", shopName: "Alpha Store", contactPerson: "Noor", mobile: "0300-1", whatsapp: null, address: null, regionId: null, region: "Drosh", market: null },
    warehouseId: IDS.warehouse,
    warehouseName: "Main Godown",
    salesperson: "Ali",
    orderNumber: null,
    dispatchNumber: null,
    subtotalP: 2_742_500,
    itemDiscountsP: 0,
    invoiceDiscountP: 0,
    discountAmountP: 0,
    taxP: 0,
    freightP: 0,
    loadingP: 0,
    otherChargesP: 0,
    totalP: 2_742_500,
    paidP: 0,
    balanceP: 2_742_500,
    outstandingP: 2_742_500,
    paymentMethod: null,
    referenceNo: null,
    notes: null,
    description: null,
    previousBalanceP: 100_000,
    totalQuantity: 30,
    lineCount: 2,
    stockApplied: true,
    migrated: false,
    revision: 2,
    createdBy: null,
    createdAt: "2026-09-01T05:00:00.000Z",
    updatedAt: "2026-09-01T05:00:00.000Z",
    confirmedAt: "2026-09-01T05:00:00.000Z",
    cancelledAt: null,
    cancelReason: null,
    lines: [
      {
        id: IDS.line, sortOrder: 0, productId: IDS.product, warehouseId: IDS.warehouse, description: "زم زم آٹا", descriptionEn: "Zam Zam Atta 20KG", brand: "Zam Zam", category: "Flour",
        package: "20 KG", sku: null, unit: "Bag", quantity: 20, qtyMilli: 20_000, unitPriceP: 135_000, discountP: 0, taxP: 0, lineTotalP: 2_700_000, returnedQuantity: 0,
        costSnapshotP: null, batchNo: null, notes: null,
      },
      {
        id: IDS.line2, sortOrder: 1, productId: IDS.product2, warehouseId: IDS.warehouse, description: "نور نمک", descriptionEn: "Noor Salt 50KG", brand: "Noor", category: "Salt",
        package: "50 KG", sku: null, unit: "Bag", quantity: 10, qtyMilli: 10_000, unitPriceP: 4_250, discountP: 0, taxP: 0, lineTotalP: 42_500, returnedQuantity: 0,
        costSnapshotP: null, batchNo: null, notes: null,
      },
    ],
    receipts: [],
    stockMovements: [
      { id: IDS.move, date: "2026-09-01", kind: "SALE_OUT", refType: "INVOICE", ref: "INV-2026-000001", productId: IDS.product, warehouseId: IDS.warehouse, bucket: "stock", quantity: -20, note: "Alpha Store" },
    ],
    actions: { edit: allowed, cancel: allowed, changeShop: allowed, duplicate: allowed },
    ...patch,
  };
}

/** The `profit` block a role with PROFIT_VIEW receives: line one has a cost, line two does not. */
export const PROFIT = {
  lines: [
    { lineId: IDS.line, revenueP: 2_700_000, costKnown: true, costP: 2_400_000, profitP: 300_000, marginPct: 11.11, markupPct: 12.5 },
    { lineId: IDS.line2, revenueP: 42_500, costKnown: false, costP: null, profitP: null, marginPct: null, markupPct: null },
  ],
  revenueP: 2_742_500,
  invoiceDiscountP: 0,
  costP: 2_400_000,
  profitP: 300_000,
  marginPct: 11.11,
  complete: false,
  unknownCostLines: 1,
};

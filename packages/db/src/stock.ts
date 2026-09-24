/**
 * The vocabulary of the stock ledger (S6): what the legacy `Inventory.apply` writes, so the importer (packages/import)
 * and the invoice / purchase / stock services (apps/api, S7+) name a movement the same way.
 *
 * Quantities are integer thousandths of a bag (`qty_milli`); the legacy rounds every quantity to 3 decimals.
 */

/** `stock` = sellable; `damaged` = the damaged bucket (customer returns, write-offs). */
export const STOCK_BUCKETS = ["stock", "damaged"] as const;
export type StockBucket = (typeof STOCK_BUCKETS)[number];

/** Every movement kind the legacy code writes (`ERP.ENUM.movement`, plus the `ADJUSTMENT` fallback of the old `moveStock`). */
export const MOVEMENT_KINDS = [
  "OPENING_STOCK", "PURCHASE_IN", "SALE_OUT", "CUSTOMER_RETURN_IN", "CUSTOMER_RETURN_DAMAGED_IN", "SUPPLIER_RETURN_OUT",
  "TRANSFER_IN", "TRANSFER_OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "SALE_REVERSAL_IN", "PURCHASE_REVERSAL_OUT",
  "REPLACEMENT_OUT", "SUPPLIER_REPLACEMENT_IN", "STOCK_WRITE_OFF", "DISPATCH_OUT", "MILL_ISSUE_OUT", "MILL_RECEIPT_IN",
  "MILL_ISSUE_REVERSAL_IN", "MILL_RECEIPT_REVERSAL_OUT", "CONVERT_OUT", "CONVERT_IN",
  "ADJUSTMENT", // 06-wiring.js `moveStock`: the fallback kind for a screen that names none
] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/** The `refType` of a movement that points at an invoice (`ref` = the invoice number). */
export const INVOICE_REF_TYPES = ["INVOICE", "INVOICE_EDIT", "INVOICE_CANCEL"] as const;
/** The `refType` of a movement that points at a purchase (`ref` = the purchase number). */
export const PURCHASE_REF_TYPES = ["PURCHASE", "PURCHASE_EDIT"] as const;

/**
 * Every `refType` the legacy writes. Stock documents, returns, milling and write-offs are later milestones' documents:
 * their movements are imported with the type and no linked id. The last group is the old screens' `moveStock`, whose
 * refType is a free-text label ('Sale', 'Transfer out', ...) or empty.
 */
export const MOVEMENT_REF_TYPES = [
  ...INVOICE_REF_TYPES, ...PURCHASE_REF_TYPES,
  "CUSTOMER_RETURN", "SUPPLIER_RETURN", "SUPPLIER_REPLACEMENT", "WRITE_OFF", "MIGRATION",
  "TRANSFER", "STOCK_RECEIPT", "ADJUSTMENT", "CONVERSION", "DISPATCH",
  "MILLING", "MILLING_CANCEL", "MILL_ARRIVAL", "MILL_ARRIVAL_CANCEL",
  "Purchase", "Sale", "Dispatch", "Transfer out", "Transfer in", "",
] as const;
export type MovementRefType = (typeof MOVEMENT_REF_TYPES)[number];

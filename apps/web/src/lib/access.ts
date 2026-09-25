import { roleHasAnyPermission, ROLE_LABELS, type Permission, type Role } from "@farooq/shared";

/** Who may read payments, receipts, statements and balances (the same set the API checks). The warehouse role holds none. */
export const PAYMENT_READ_PERMISSIONS: readonly Permission[] = ["PAYMENT_CREATE", "COLLECTION_VIEW", "FINANCIAL_REPORT_VIEW"];

export const canReadPayments = (role: Role): boolean => roleHasAnyPermission(role, PAYMENT_READ_PERMISSIONS);
export const canReceive = (role: Role): boolean => roleHasAnyPermission(role, ["PAYMENT_CREATE"]);
export const canPayOut = (role: Role): boolean => roleHasAnyPermission(role, ["PAYMENT_PAYOUT"]);
export const canCorrect = (role: Role): boolean => roleHasAnyPermission(role, ["TRANSACTION_CORRECT"]);

/** Who may read the invoice list, an invoice, its print and its CSV (the same set the API checks). The warehouse role holds none. */
export const INVOICE_READ_PERMISSIONS: readonly Permission[] = ["SALES_CREATE", "TRANSACTION_CORRECT", "COLLECTION_VIEW", "FINANCIAL_REPORT_VIEW"];
export const canReadInvoices = (role: Role): boolean => roleHasAnyPermission(role, INVOICE_READ_PERMISSIONS);
/** Owner decision 2026-09-24: anyone who may make a sale may discard a DRAFT; a posted invoice needs the corrector. */
export const canDiscardDraft = (role: Role): boolean => roleHasAnyPermission(role, ["SALES_CREATE", "TRANSACTION_CORRECT"]);
export const canCorrectInvoice = (role: Role): boolean => roleHasAnyPermission(role, ["TRANSACTION_CORRECT"]);
export const canDuplicateInvoice = (role: Role): boolean => roleHasAnyPermission(role, ["SALES_CREATE"]);
/** "New invoice", and posting a draft: whoever may make a sale. */
export const canCreateInvoice = (role: Role): boolean => roleHasAnyPermission(role, ["SALES_CREATE"]);
/**
 * Whether Edit is OFFERED at all for an invoice in this state (the server's `actions.edit` says whether it is allowed now, and why not):
 * a draft is edited by whoever may make a sale, a posted invoice by the corrector.
 */
export const canOfferEdit = (role: Role, draft: boolean): boolean => (draft ? canCreateInvoice(role) : canCorrectInvoice(role));
/**
 * Who may read purchases (list, view, print, CSV) — the same set the API checks. The warehouse role and Sales hold none: the old ERP
 * showed its Purchases page to every role, S13 keeps it closed because purchases carry supplier money (an owner-visible difference).
 */
export const PURCHASE_READ_PERMISSIONS: readonly Permission[] = ["PURCHASE_CREATE", "TRANSACTION_CORRECT", "FINANCIAL_REPORT_VIEW"];
export const canReadPurchases = (role: Role): boolean => roleHasAnyPermission(role, PURCHASE_READ_PERMISSIONS);
export const canSeeProfit = (role: Role): boolean => roleHasAnyPermission(role, ["PROFIT_VIEW"]);

export const notAvailableTitle = (role: Role): string => `Not available for the ${ROLE_LABELS[role]} role`;

export interface NavItem {
  label: string;
  /** null = a module that does not exist yet: shown visibly disabled ("Soon"), never a dead link. */
  to: "/" | "/payments" | "/invoices" | "/purchases" | "/statements" | null;
  /** Permissions of which the role needs at least one. Undefined = every signed-in role. */
  any?: readonly Permission[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Dashboard", to: "/" },
  { label: "Invoices", to: "/invoices", any: INVOICE_READ_PERMISSIONS },
  { label: "Purchases", to: "/purchases", any: PURCHASE_READ_PERMISSIONS },
  { label: "Payments", to: "/payments", any: PAYMENT_READ_PERMISSIONS },
  { label: "Statements", to: "/statements", any: PAYMENT_READ_PERMISSIONS },
  { label: "Customers", to: null },
  { label: "Suppliers", to: null },
  { label: "Reports", to: null },
];

export function visibleNav(role: Role): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.any || roleHasAnyPermission(role, item.any));
}

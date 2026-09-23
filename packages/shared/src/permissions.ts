/**
 * Permission and role names, ported from the old ERP's
 * `erp-upgrade/19-collection-rbac.js` (base roles) plus the later patches
 * `27-landed-ui.js` (LANDED_COST_*, EXPENSE_MANAGE) and `30-payroll.js` /
 * `34-accounts.js` (PAYROLL_MANAGE, owner-only, given to no role).
 *
 * The old app enforced these in the browser only. Here they are enforced
 * server-side by the permission guard — deny by default.
 *
 * `PAYMENT_PAYOUT` is NEW in S3 (no legacy equivalent): it gates money going
 * OUT (supplier payments and refunds to shops). In the legacy app the SALES
 * role's `PAYMENT_CREATE` also let it record cash paid out (old repo open
 * item 7). Owner decision — to allow SALES to pay out again, add
 * "PAYMENT_PAYOUT" to its list below.
 */

export const PERMISSIONS = [
  "MASTER_DATA_VIEW",
  "MASTER_DATA_CREATE",
  "MASTER_DATA_EDIT",
  "MASTER_DATA_ARCHIVE",
  "PRODUCT_EDIT",
  "SUPPLIER_EDIT",
  "CUSTOMER_EDIT",
  "SALES_CREATE",
  "PURCHASE_CREATE",
  "PAYMENT_CREATE",
  "PAYMENT_PAYOUT",
  "COLLECTION_VIEW",
  "COLLECTION_EXPORT",
  "FINANCIAL_REPORT_VIEW",
  "PROFIT_VIEW",
  "TRANSACTION_CORRECT",
  "AUDIT_LOG_VIEW",
  "STOCK_MANAGE",
  "LANDED_COST_MANAGE",
  "LANDED_COST_VIEW",
  "EXPENSE_MANAGE",
  "PAYROLL_MANAGE",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
  "OWNER",
  "MANAGER",
  "ACCOUNTANT",
  "SALES",
  "INVENTORY",
] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Owner",
  MANAGER: "Manager",
  ACCOUNTANT: "Accountant",
  SALES: "Sales",
  INVENTORY: "Warehouse",
};

/**
 * OWNER is not listed — it implicitly has every permission (`all: true` in
 * the legacy RBAC module). Every other role's permission set here is a
 * direct port of the legacy `ROLES` object, patches included.
 */
export const ROLE_PERMISSIONS: Record<Exclude<Role, "OWNER">, Permission[]> = {
  MANAGER: [
    "MASTER_DATA_VIEW",
    "MASTER_DATA_CREATE",
    "MASTER_DATA_EDIT",
    "MASTER_DATA_ARCHIVE",
    "PRODUCT_EDIT",
    "SUPPLIER_EDIT",
    "CUSTOMER_EDIT",
    "SALES_CREATE",
    "PURCHASE_CREATE",
    "PAYMENT_CREATE",
    "PAYMENT_PAYOUT",
    "COLLECTION_VIEW",
    "COLLECTION_EXPORT",
    "FINANCIAL_REPORT_VIEW",
    "PROFIT_VIEW",
    "TRANSACTION_CORRECT",
    "AUDIT_LOG_VIEW",
    "STOCK_MANAGE",
    "LANDED_COST_MANAGE",
    "EXPENSE_MANAGE",
  ],
  ACCOUNTANT: [
    "MASTER_DATA_VIEW",
    "CUSTOMER_EDIT",
    "PAYMENT_CREATE",
    "PAYMENT_PAYOUT",
    "COLLECTION_VIEW",
    "COLLECTION_EXPORT",
    "FINANCIAL_REPORT_VIEW",
    "PROFIT_VIEW",
    "TRANSACTION_CORRECT",
    "AUDIT_LOG_VIEW",
    "LANDED_COST_VIEW",
    "EXPENSE_MANAGE",
  ],
  SALES: ["MASTER_DATA_VIEW", "SALES_CREATE", "PAYMENT_CREATE", "COLLECTION_VIEW", "CUSTOMER_EDIT"],
  INVENTORY: ["MASTER_DATA_VIEW", "STOCK_MANAGE"],
};

export function permissionsForRole(role: Role): Permission[] {
  if (role === "OWNER") return [...PERMISSIONS];
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: Role, permission: Permission): boolean {
  if (role === "OWNER") return true;
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** True when the role holds at least one of the permissions (used by read routes open to several roles). */
export function roleHasAnyPermission(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.some((p) => roleHasPermission(role, p));
}

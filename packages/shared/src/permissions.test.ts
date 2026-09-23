import { describe, expect, it } from "vitest";
import { permissionsForRole, PERMISSIONS, roleHasAnyPermission, roleHasPermission } from "./permissions.js";

describe("permissions", () => {
  it("OWNER has every permission", () => {
    expect(roleHasPermission("OWNER", "PAYROLL_MANAGE")).toBe(true);
    expect(roleHasPermission("OWNER", "EXPENSE_MANAGE")).toBe(true);
  });

  it("INVENTORY (warehouse) cannot see profit or payments — ported from legacy 19-collection-rbac.js", () => {
    expect(roleHasPermission("INVENTORY", "PROFIT_VIEW")).toBe(false);
    expect(roleHasPermission("INVENTORY", "PAYMENT_CREATE")).toBe(false);
    expect(roleHasPermission("INVENTORY", "STOCK_MANAGE")).toBe(true);
  });

  it("no non-owner role has PAYROLL_MANAGE — given to no role in the legacy app", () => {
    for (const role of ["MANAGER", "ACCOUNTANT", "SALES", "INVENTORY"] as const) {
      expect(roleHasPermission(role, "PAYROLL_MANAGE")).toBe(false);
      expect(permissionsForRole(role)).not.toContain("PAYROLL_MANAGE");
    }
  });

  it("every non-owner permission is a known PERMISSIONS entry", () => {
    for (const role of ["MANAGER", "ACCOUNTANT", "SALES", "INVENTORY"] as const) {
      for (const permission of permissionsForRole(role)) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });
});

describe("PAYMENT_PAYOUT (new in S3 — legacy open item 7)", () => {
  it("is held by OWNER, MANAGER and ACCOUNTANT", () => {
    for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as const) {
      expect(roleHasPermission(role, "PAYMENT_PAYOUT")).toBe(true);
    }
  });

  it("is NOT held by SALES or INVENTORY, although SALES keeps PAYMENT_CREATE (receiving money)", () => {
    expect(roleHasPermission("SALES", "PAYMENT_CREATE")).toBe(true);
    for (const role of ["SALES", "INVENTORY"] as const) {
      expect(roleHasPermission(role, "PAYMENT_PAYOUT")).toBe(false);
      expect(permissionsForRole(role)).not.toContain("PAYMENT_PAYOUT");
    }
  });

  it("TRANSACTION_CORRECT (reverse / edit amount) stays with OWNER, MANAGER, ACCOUNTANT only", () => {
    expect(roleHasPermission("SALES", "TRANSACTION_CORRECT")).toBe(false);
    expect(roleHasPermission("INVENTORY", "TRANSACTION_CORRECT")).toBe(false);
    expect(roleHasPermission("ACCOUNTANT", "TRANSACTION_CORRECT")).toBe(true);
  });
});

describe("roleHasAnyPermission", () => {
  const readers = ["PAYMENT_CREATE", "COLLECTION_VIEW", "FINANCIAL_REPORT_VIEW"] as const;
  it("passes when any one permission is held", () => {
    expect(roleHasAnyPermission("SALES", readers)).toBe(true); // PAYMENT_CREATE + COLLECTION_VIEW
    expect(roleHasAnyPermission("ACCOUNTANT", readers)).toBe(true);
  });
  it("fails for the warehouse role, which holds none of them", () => {
    expect(roleHasAnyPermission("INVENTORY", readers)).toBe(false);
  });
});

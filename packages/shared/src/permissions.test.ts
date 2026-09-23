import { describe, expect, it } from "vitest";
import { permissionsForRole, PERMISSIONS, roleHasPermission } from "./permissions.js";

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

import { describe, expect, it } from "vitest";
import { ROLES, type Role } from "@farooq/shared";
import { canCorrect, canPayOut, canReadPayments, canReceive, notAvailableTitle, visibleNav } from "./access";

const labels = (role: Role) => visibleNav(role).map((n) => n.label);

describe("what each role sees and can do (the permission matrix, in the UI)", () => {
  it("OWNER, MANAGER, ACCOUNTANT: everything payments", () => {
    for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as Role[]) {
      expect(canReadPayments(role)).toBe(true);
      expect(canReceive(role)).toBe(true);
      expect(canPayOut(role)).toBe(true);
      expect(canCorrect(role)).toBe(true);
      expect(labels(role)).toEqual(expect.arrayContaining(["Payments", "Statements"]));
    }
  });

  it("SALES can receive but not pay out, reverse or edit", () => {
    expect(canReadPayments("SALES")).toBe(true);
    expect(canReceive("SALES")).toBe(true);
    expect(canPayOut("SALES")).toBe(false);
    expect(canCorrect("SALES")).toBe(false);
    expect(labels("SALES")).toEqual(expect.arrayContaining(["Payments", "Statements"]));
  });

  it("INVENTORY (warehouse) has no Payments or Statements at all", () => {
    expect(canReadPayments("INVENTORY")).toBe(false);
    expect(canReceive("INVENTORY")).toBe(false);
    expect(labels("INVENTORY")).not.toContain("Payments");
    expect(labels("INVENTORY")).not.toContain("Statements");
    expect(labels("INVENTORY")).toContain("Dashboard");
  });

  it("modules that do not exist yet are listed as disabled (no route), for every role", () => {
    for (const role of ROLES) {
      const soon = visibleNav(role).filter((n) => n.to === null).map((n) => n.label);
      expect(soon).toEqual(["Customers", "Suppliers", "Reports"]);
    }
  });

  it("the not-available panel names the role in the legacy wording", () => {
    expect(notAvailableTitle("INVENTORY")).toBe("Not available for the Warehouse role");
    expect(notAvailableTitle("SALES")).toBe("Not available for the Sales role");
  });
});

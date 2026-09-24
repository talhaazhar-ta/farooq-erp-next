import { describe, expect, it } from "vitest";
import { ROLES, type Role } from "@farooq/shared";
import {
  canCorrect,
  canCorrectInvoice,
  canDiscardDraft,
  canDuplicateInvoice,
  canPayOut,
  canReadInvoices,
  canReadPayments,
  canReceive,
  canSeeProfit,
  notAvailableTitle,
  visibleNav,
} from "./access";

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

  it("invoices: OWNER / MANAGER / ACCOUNTANT / SALES read them, the warehouse role does not (nav hidden)", () => {
    for (const role of ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"] as Role[]) {
      expect(canReadInvoices(role)).toBe(true);
      expect(labels(role)).toContain("Invoices");
    }
    expect(canReadInvoices("INVENTORY")).toBe(false);
    expect(labels("INVENTORY")).not.toContain("Invoices");
  });

  it("SALES may discard a draft and duplicate, but not cancel a posted invoice or change its shop; the corrector roles may", () => {
    expect(canDiscardDraft("SALES")).toBe(true);
    expect(canDuplicateInvoice("SALES")).toBe(true);
    expect(canCorrectInvoice("SALES")).toBe(false);
    for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as Role[]) expect(canCorrectInvoice(role)).toBe(true);
    expect(canDiscardDraft("INVENTORY")).toBe(false);
    expect(canDuplicateInvoice("INVENTORY")).toBe(false);
  });

  it("profit is for the roles that hold PROFIT_VIEW only", () => {
    for (const role of ["OWNER", "MANAGER", "ACCOUNTANT"] as Role[]) expect(canSeeProfit(role)).toBe(true);
    expect(canSeeProfit("SALES")).toBe(false);
    expect(canSeeProfit("INVENTORY")).toBe(false);
  });
});

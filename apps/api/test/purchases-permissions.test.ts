import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, ROLE_PERMISSIONS, roleHasPermission, type Role } from "@farooq/shared";
import { createHarness, supplierBalanceSql, type Harness, type Session } from "./helpers/harness.js";
import { levelOf } from "./helpers/invoices.js";
import { getPur, mkPurchase, postPur, purBody, purEditBody, purScenario, putPur, vouchersFor } from "./helpers/purchases.js";

/**
 * The permission matrix of every purchase endpoint (owner decision 2026-09-25): create = PURCHASE_CREATE (OWNER, MANAGER); edit =
 * PURCHASE_CREATE or TRANSACTION_CORRECT (OWNER, MANAGER, ACCOUNTANT — the legacy `canEdit`); a payment made with the purchase also needs
 * PAYMENT_PAYOUT (the whole save is refused); INVENTORY and SALES have none of them. Reads (planner decision 9): any of PURCHASE_CREATE /
 * TRANSACTION_CORRECT / FINANCIAL_REPORT_VIEW. The expected sets are written out here by hand from the decisions — not derived from
 * `roleHasPermission`, which is only cross-checked at the end.
 */
let h: Harness;
const sessions = {} as Record<Role, Session>;
beforeAll(async () => {
  h = await createHarness();
  for (const r of ROLES) sessions[r] = await h.session(r);
});
afterAll(async () => {
  await h.close();
});

const CREATORS: Role[] = ["OWNER", "MANAGER"]; // PURCHASE_CREATE
const EDITORS: Role[] = ["OWNER", "MANAGER", "ACCOUNTANT"]; // PURCHASE_CREATE or TRANSACTION_CORRECT
const READERS: Role[] = ["OWNER", "MANAGER", "ACCOUNTANT"]; // PURCHASE_CREATE / TRANSACTION_CORRECT / FINANCIAL_REPORT_VIEW
const check = (role: Role, allowed: Role[], status: number, okStatuses: number[]) => {
  if (allowed.includes(role)) expect(okStatuses, `${role} should be allowed, got ${status}`).toContain(status);
  else expect(status, `${role} should be refused`).toBe(403);
};

describe("permission matrix", () => {
  it("POST /purchases: PURCHASE_CREATE — OWNER, MANAGER; not ACCOUNTANT, SALES or INVENTORY", async () => {
    for (const role of ROLES) {
      const s = await purScenario(h, 1);
      const r = await postPur(h, sessions[role], purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 1_000 }]));
      check(role, CREATORS, r.status, [201]);
      if (!CREATORS.includes(role)) expect(await levelOf(h, s.ps[0]!.id, s.wh.id), `${role} must not have moved stock`).toBeNull();
    }
  });

  it("PUT /purchases/:id: PURCHASE_CREATE or TRANSACTION_CORRECT — OWNER, MANAGER, ACCOUNTANT; not SALES, not INVENTORY", async () => {
    for (const role of ROLES) {
      const s = await purScenario(h, 1);
      const pu = await mkPurchase(h, sessions.OWNER, s, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 1_000 }]);
      check(role, EDITORS, (await putPur(h, sessions[role], pu.id, purEditBody(pu, { notes: role }))).status, [200]);
    }
  });

  it("GET /purchases/:id and GET /purchases/last-rates: OWNER, MANAGER, ACCOUNTANT; not SALES, not INVENTORY", async () => {
    const s = await purScenario(h, 1);
    const pu = await mkPurchase(h, sessions.OWNER, s, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 1_000 }]);
    for (const role of ROLES) {
      check(role, READERS, (await getPur(h, sessions[role], pu.id)).status, [200]);
      check(role, READERS, (await h.request(sessions[role], "GET", `/purchases/last-rates?productIds=${s.ps[0]!.id}`)).status, [200]);
    }
  });

  it("nobody signed in: 401 on every endpoint; a missing CSRF token: 401", async () => {
    const s = await purScenario(h, 1);
    const pu = await mkPurchase(h, sessions.OWNER, s, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 1_000 }]);
    expect((await postPur(h, null, purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 1 }]))).status).toBe(401);
    expect((await putPur(h, null, pu.id, purEditBody(pu))).status).toBe(401);
    expect((await getPur(h, null, pu.id)).status).toBe(401);
    expect((await h.request(null, "GET", `/purchases/last-rates?productIds=${s.ps[0]!.id}`)).status).toBe(401);
    expect((await h.request(sessions.OWNER, "POST", "/purchases", { body: purBody(s.supplier.id, s.wh.id, [{ productId: s.ps[0]!.id, quantity: 1, unitPriceP: 1 }]), csrf: false })).status).toBe(401);
  });

  it("a refused role changes NOTHING: the purchase, its stock and the supplier's balance are as they were", async () => {
    const s = await purScenario(h, 1);
    const pu = await mkPurchase(h, sessions.OWNER, s, [{ productId: s.ps[0]!.id, quantity: 4, unitPriceP: 100_000 }]);
    const owed = await supplierBalanceSql(h.admin, s.supplier.id);
    for (const role of ["SALES", "INVENTORY"] as Role[]) {
      expect((await putPur(h, sessions[role], pu.id, purEditBody(pu, {}, [{ id: pu.lines[0].id, productId: s.ps[0]!.id, quantity: 9, unitPriceP: 100_000 }]))).status).toBe(403);
    }
    expect(await levelOf(h, s.ps[0]!.id, s.wh.id)).toBe(4_000);
    expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(owed);
    expect((await getPur(h, sessions.OWNER, pu.id)).body.revision).toBe(1);
  });
});

describe("a payment made with the purchase also needs PAYMENT_PAYOUT — 403 and the WHOLE save is refused", () => {
  it("a role that may record purchases but not pay a supplier: creating with money paid is refused with nothing written; without money it works", async () => {
    // No built-in role holds PURCHASE_CREATE or TRANSACTION_CORRECT without PAYMENT_PAYOUT (MANAGER has both, ACCOUNTANT has TRANSACTION_CORRECT + PAYMENT_PAYOUT),
    // so the rule is proved by taking PAYMENT_PAYOUT away from MANAGER for the length of the test (the array is the one the guard and the service read).
    const perms = ROLE_PERMISSIONS.MANAGER;
    const kept = [...perms];
    const s = await purScenario(h, 1);
    const line = { productId: s.ps[0]!.id, quantity: 10, unitPriceP: 100_000 };
    const pu = await mkPurchase(h, sessions.OWNER, s, [line], { paidAmountP: 200_000 });
    try {
      perms.splice(perms.indexOf("PAYMENT_PAYOUT"), 1);
      expect(roleHasPermission("MANAGER", "PAYMENT_PAYOUT")).toBe(false);
      const before = await supplierBalanceSql(h.admin, s.supplier.id);

      const denied = await postPur(h, sessions.MANAGER, purBody(s.supplier.id, s.wh.id, [line], { paidAmountP: 100_000 }));
      expect(denied.status).toBe(403);
      expect(denied.body.message).toBe("You do not have permission to pay a supplier. Clear the amount paid, or ask someone who can record payments.");
      expect(await supplierBalanceSql(h.admin, s.supplier.id)).toBe(before); // the whole save was refused: no bill, no stock, no voucher
      expect(await levelOf(h, s.ps[0]!.id, s.wh.id)).toBe(10_000);

      // an edit that RAISES the money paid is refused the same way ...
      const raise = await putPur(h, sessions.MANAGER, pu.id, purEditBody(pu, { paidAmountP: 300_000 }));
      expect(raise.status).toBe(403);
      expect(await vouchersFor(h, pu.id)).toHaveLength(1);
      // ... but the same edit that does not raise it is fine, and so is a new purchase with no money
      expect((await putPur(h, sessions.MANAGER, pu.id, purEditBody(pu, { notes: "no new money" }))).status).toBe(200);
      expect((await postPur(h, sessions.MANAGER, purBody(s.supplier.id, s.wh.id, [line]))).status).toBe(201);
    } finally {
      ROLE_PERMISSIONS.MANAGER.length = 0;
      ROLE_PERMISSIONS.MANAGER.push(...kept);
    }
    expect(roleHasPermission("MANAGER", "PAYMENT_PAYOUT")).toBe(true);
  });
});

describe("the role sets themselves (cross-check of the hand-written expectations above)", () => {
  it("PURCHASE_CREATE / TRANSACTION_CORRECT / PAYMENT_PAYOUT / FINANCIAL_REPORT_VIEW are held by exactly the roles this file assumes", () => {
    const has = (r: Role, p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(r, p);
    expect(ROLES.filter((r) => has(r, "PURCHASE_CREATE")).sort()).toEqual(["MANAGER", "OWNER"]);
    expect(ROLES.filter((r) => has(r, "TRANSACTION_CORRECT")).sort()).toEqual(["ACCOUNTANT", "MANAGER", "OWNER"]);
    expect(ROLES.filter((r) => has(r, "PAYMENT_PAYOUT")).sort()).toEqual(["ACCOUNTANT", "MANAGER", "OWNER"]);
    expect(ROLES.filter((r) => has(r, "FINANCIAL_REPORT_VIEW")).sort()).toEqual(["ACCOUNTANT", "MANAGER", "OWNER"]);
    expect(ROLES.filter((r) => has(r, "PROFIT_VIEW")).sort()).toEqual(["ACCOUNTANT", "MANAGER", "OWNER"]);
  });
});

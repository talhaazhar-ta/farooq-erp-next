import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, roleHasPermission, type Role } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { cancel, changeShop, duplicate, editBody, get, invBody, mkPosted, post, put, scenario } from "./helpers/invoices.js";

/**
 * The permission matrix of every invoice endpoint (owner decision 2): create / draft / post = SALES_CREATE; edit a POSTED invoice,
 * cancel, change shop = TRANSACTION_CORRECT; money at sale also PAYMENT_CREATE; INVENTORY has none of them. The expected sets are
 * written out here by hand from the decision — not derived from `roleHasPermission`, which is only cross-checked at the end.
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

const CREATORS: Role[] = ["OWNER", "MANAGER", "SALES"]; // SALES_CREATE
const CORRECTORS: Role[] = ["OWNER", "MANAGER", "ACCOUNTANT"]; // TRANSACTION_CORRECT
const READERS: Role[] = ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"]; // any of SALES_CREATE / TRANSACTION_CORRECT / COLLECTION_VIEW / FINANCIAL_REPORT_VIEW
const okOrRefused = (role: Role, allowed: Role[], status: number, okStatuses: number[]) => {
  if (allowed.includes(role)) expect(okStatuses, `${role} should be allowed, got ${status}`).toContain(status);
  else expect(status, `${role} should be refused`).toBe(403);
};

describe("permission matrix", () => {
  it("POST /invoices (draft or post): SALES_CREATE — OWNER, MANAGER, SALES; not ACCOUNTANT, not INVENTORY", async () => {
    for (const role of ROLES) {
      for (const mode of ["draft", "post"]) {
        const s = await scenario(h);
        const r = await post(h, sessions[role], invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode }));
        okOrRefused(role, CREATORS, r.status, [201]);
      }
    }
  });

  it("PUT on a DRAFT: SALES_CREATE (saving it and posting it)", async () => {
    for (const role of ROLES) {
      const s = await scenario(h);
      const d = await post(h, sessions.OWNER, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
      okOrRefused(role, CREATORS, (await put(h, sessions[role], d.body.id, editBody(d.body, { mode: "draft" }))).status, [200]);
      const d2 = await post(h, sessions.OWNER, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
      okOrRefused(role, CREATORS, (await put(h, sessions[role], d2.body.id, editBody(d2.body))).status, [200]);
    }
  });

  it("PUT on a POSTED invoice: TRANSACTION_CORRECT — OWNER, MANAGER, ACCOUNTANT; not SALES, not INVENTORY", async () => {
    for (const role of ROLES) {
      const s = await scenario(h);
      const inv = await mkPosted(h, sessions.OWNER, s, { qty: 1, unitPriceP: 1_000 });
      okOrRefused(role, CORRECTORS, (await put(h, sessions[role], inv.id, editBody(inv))).status, [200]);
    }
  });

  it("POST /invoices/:id/cancel and /change-shop: TRANSACTION_CORRECT", async () => {
    for (const role of ROLES) {
      const s = await scenario(h);
      const other = await h.seed.customer();
      const a = await mkPosted(h, sessions.OWNER, s, { qty: 1, unitPriceP: 1_000 });
      okOrRefused(role, CORRECTORS, (await cancel(h, sessions[role], a.id)).status, [200]);
      const b = await mkPosted(h, sessions.OWNER, s, { qty: 1, unitPriceP: 1_000 });
      okOrRefused(role, CORRECTORS, (await changeShop(h, sessions[role], b.id, other.id)).status, [200]);
    }
  });

  it("POST /invoices/:id/cancel on a DRAFT: SALES_CREATE or TRANSACTION_CORRECT (owner decision 2026-09-24) — everyone but INVENTORY", async () => {
    const DISCARDERS: Role[] = ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"];
    for (const role of ROLES) {
      const s = await scenario(h);
      const d = await post(h, sessions.OWNER, invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }], { mode: "draft" }));
      okOrRefused(role, DISCARDERS, (await cancel(h, sessions[role], d.body.id)).status, [200]);
    }
  });

  it("POST /invoices/:id/duplicate: SALES_CREATE", async () => {
    for (const role of ROLES) {
      const s = await scenario(h);
      const inv = await mkPosted(h, sessions.OWNER, s, { qty: 1, unitPriceP: 1_000 });
      okOrRefused(role, CREATORS, (await duplicate(h, sessions[role], inv.id)).status, [201]);
    }
  });

  it("GET /invoices/:id: OWNER, MANAGER, ACCOUNTANT, SALES read it; INVENTORY does not", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, sessions.OWNER, s, { qty: 1, unitPriceP: 1_000 });
    for (const role of ROLES) okOrRefused(role, READERS, (await get(h, sessions[role], inv.id)).status, [200]);
  });

  it("GET /products and /warehouses: MASTER_DATA_VIEW — every role holds it", async () => {
    for (const role of ROLES) {
      expect((await h.request(sessions[role], "GET", "/products")).status, role).toBe(200);
      expect((await h.request(sessions[role], "GET", "/warehouses")).status, role).toBe(200);
    }
  });

  it("no session → 401 on every endpoint; a missing or wrong CSRF token → 401 on every write", async () => {
    const s = await scenario(h);
    const inv = await mkPosted(h, sessions.OWNER, s, { qty: 1, unitPriceP: 1_000 });
    const id = inv.id;
    const body = invBody(s.shop.id, s.wh.id, [{ productId: s.product.id, quantity: 1, unitPriceP: 1_000 }]);
    expect((await post(h, null, body)).status).toBe(401);
    expect((await put(h, null, id, body)).status).toBe(401);
    expect((await cancel(h, null, id)).status).toBe(401);
    expect((await changeShop(h, null, id, s.shop.id)).status).toBe(401);
    expect((await duplicate(h, null, id)).status).toBe(401);
    expect((await get(h, null, id)).status).toBe(401);
    expect((await h.request(null, "GET", "/products")).status).toBe(401);
    expect((await h.request(null, "GET", "/warehouses")).status).toBe(401);
    for (const csrf of [false, "wrong-token"] as const) {
      expect((await h.request(sessions.OWNER, "POST", "/invoices", { body, csrf })).status).toBe(401);
      expect((await h.request(sessions.OWNER, "PUT", `/invoices/${id}`, { body: editBody(inv), csrf })).status).toBe(401);
      expect((await h.request(sessions.OWNER, "POST", `/invoices/${id}/cancel`, { body: { reason: "x" }, csrf })).status).toBe(401);
      expect((await h.request(sessions.OWNER, "POST", `/invoices/${id}/change-shop`, { body: { customerId: s.shop.id }, csrf })).status).toBe(401);
      expect((await h.request(sessions.OWNER, "POST", `/invoices/${id}/duplicate`, { body: {}, csrf })).status).toBe(401);
    }
    expect((await get(h, sessions.OWNER, id)).body.status).toBe("CONFIRMED"); // none of the refused writes did anything
  });

  it("the hand-written sets above agree with the shared permission model (a change to the matrix must be a decision, not an accident)", () => {
    const has = (r: Role, p: Parameters<typeof roleHasPermission>[1]) => roleHasPermission(r, p);
    expect(ROLES.filter((r) => has(r, "SALES_CREATE")).sort()).toEqual([...CREATORS].sort());
    expect(ROLES.filter((r) => has(r, "TRANSACTION_CORRECT")).sort()).toEqual([...CORRECTORS].sort());
    expect(ROLES.filter((r) => has(r, "PAYMENT_CREATE")).sort()).toEqual(["ACCOUNTANT", "MANAGER", "OWNER", "SALES"]);
    expect(ROLES.filter((r) => has(r, "SALES_CREATE") || has(r, "TRANSACTION_CORRECT") || has(r, "COLLECTION_VIEW") || has(r, "FINANCIAL_REPORT_VIEW")).sort()).toEqual([...READERS].sort());
  });
});

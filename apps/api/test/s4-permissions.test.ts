import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Role } from "@farooq/shared";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";

/**
 * Who may call every endpoint S4 added (worked out from the S4 plan, NOT read back from ROLE_PERMISSIONS):
 *   payments read set  = any of PAYMENT_CREATE | COLLECTION_VIEW | FINANCIAL_REPORT_VIEW  → OWNER, MANAGER, ACCOUNTANT, SALES; INVENTORY 403
 *   reference reads    = MASTER_DATA_VIEW                                                  → every role
 * Unauthenticated is 401 everywhere; a GET needs no CSRF token; a refused call reads nothing.
 */
let h: Harness;
let sessions: Record<Role, Session>;
let shopId: string;
let supplierId: string;
let paymentId: string;

beforeAll(async () => {
  h = await createHarness();
  sessions = Object.fromEntries(await Promise.all(ROLES.map(async (r) => [r, await h.session(r)]))) as Record<Role, Session>;
  const shop = await h.seed.customer();
  const sup = await h.seed.supplier();
  shopId = shop.id;
  supplierId = sup.id;
  paymentId = (await h.request(sessions.OWNER, "POST", "/payments/receive", { body: { customerId: shop.id, amountP: 1_000 } })).body.id;
});
afterAll(async () => {
  await h.close();
});

const READ_ROLES: readonly Role[] = ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"];
const ANY_ROLE: readonly Role[] = ROLES;

const endpoints = (): { name: string; url: string; allowed: readonly Role[] }[] => [
  { name: "GET /payments (v2 search)", url: `/payments?q=abc&scope=party&direction=received&sort=high&minP=1&maxP=99`, allowed: READ_ROLES },
  { name: "GET /payments/export.csv", url: `/payments/export.csv?q=abc`, allowed: READ_ROLES },
  { name: "GET /payments/:id/receipt", url: `/payments/${paymentId}/receipt`, allowed: READ_ROLES },
  { name: "GET /customers/:id/statement", url: `/customers/${shopId}/statement?from=2026-01-01`, allowed: READ_ROLES },
  { name: "GET /suppliers/:id/statement", url: `/suppliers/${supplierId}/statement`, allowed: READ_ROLES },
  { name: "GET /company", url: `/company`, allowed: ANY_ROLE },
  { name: "GET /regions", url: `/regions`, allowed: ANY_ROLE },
  { name: "GET /customers?regionId (lookup)", url: `/customers?regionId=${"00000000-0000-4000-8000-000000000000"}`, allowed: ANY_ROLE },
];

describe("S4 endpoints — every role", () => {
  it.each(ROLES)("%s", async (role) => {
    for (const e of endpoints()) {
      const res = await h.request(sessions[role], "GET", e.url);
      const allowed = e.allowed.includes(role);
      expect(res.status, `${role} ${e.name}`).toBe(allowed ? 200 : 403);
      if (!allowed) {
        // the refusal reveals nothing about the data behind it
        expect(JSON.stringify(res.body), `${role} ${e.name}`).not.toMatch(/receiptNumber|shopName|balance|Fixture|items/);
      }
    }
  });

  it("no session → 401 on every one of them, with no data", async () => {
    for (const e of endpoints()) {
      const res = await h.request(null, "GET", e.url);
      expect(res.status, e.name).toBe(401);
      expect(JSON.stringify(res.body), e.name).not.toMatch(/receiptNumber|items|businessName/);
    }
  });

  it("an expired or made-up session cookie is a 401 too", async () => {
    const ghost: Session = { ...sessions.OWNER, cookie: "00000000-0000-4000-8000-000000000000" };
    for (const e of endpoints()) expect((await h.request(ghost, "GET", e.url)).status, e.name).toBe(401);
  });

  it("SALES is read-only here: it can search, print and read statements, and every write it may not do is still refused", async () => {
    const sales = sessions.SALES;
    expect((await h.request(sales, "GET", `/payments/${paymentId}/receipt`)).status).toBe(200);
    expect((await h.request(sales, "POST", `/payments/${paymentId}/reverse`, { body: { reason: "x" } })).status).toBe(403);
    expect((await h.request(sales, "POST", "/payments/pay", { body: { supplierId, amountP: 100 } })).status).toBe(403);
  });

  it("the warehouse role (INVENTORY) sees the reference data but no money: no search, export, receipt or statement", async () => {
    const inv = sessions.INVENTORY;
    expect((await h.request(inv, "GET", "/company")).status).toBe(200);
    expect((await h.request(inv, "GET", "/regions")).status).toBe(200);
    for (const url of [`/payments`, `/payments/export.csv`, `/payments/${paymentId}/receipt`, `/customers/${shopId}/statement`, `/suppliers/${supplierId}/statement`]) {
      expect((await h.request(inv, "GET", url)).status, url).toBe(403);
    }
  });

  it("a 403 does not depend on the id being real: INVENTORY gets 403, not 404, for a made-up statement id (the guard runs first)", async () => {
    const res = await h.request(sessions.INVENTORY, "GET", "/customers/00000000-0000-4000-8000-000000000000/statement");
    expect(res.status).toBe(403);
  });
});

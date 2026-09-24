import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, roleHasPermission, type Role } from "@farooq/shared";
import { INVOICE_READ_PERMISSIONS } from "../src/invoices/invoices.controller.js";
import { createHarness, type Harness, type Session } from "./helpers/harness.js";
import { mkPosted, scenario } from "./helpers/invoices.js";

/**
 * Who may read what (S8): the list, the CSV and the printed invoice need any of SALES_CREATE / TRANSACTION_CORRECT / COLLECTION_VIEW /
 * FINANCIAL_REPORT_VIEW (the warehouse role holds none); the profit needs PROFIT_VIEW. The expected sets are written out by hand
 * from the roles' permissions — the shared permission model is only cross-checked at the end.
 */
let h: Harness;
const sessions = {} as Record<Role, Session>;
let invoiceId: string;
beforeAll(async () => {
  h = await createHarness();
  for (const r of ROLES) sessions[r] = await h.session(r);
  const s = await scenario(h);
  invoiceId = (await mkPosted(h, sessions.OWNER, s, { qty: 1, unitPriceP: 100_000 })).id;
});
afterAll(async () => {
  await h.close();
});

const READERS: Role[] = ["OWNER", "MANAGER", "ACCOUNTANT", "SALES"];
const PROFIT_VIEWERS: Role[] = ["OWNER", "MANAGER", "ACCOUNTANT"];

describe("reads", () => {
  for (const [name, url] of [
    ["GET /invoices", "/invoices"],
    ["GET /invoices/export.csv", "/invoices/export.csv"],
    ["GET /invoices/:id/print", () => `/invoices/${invoiceId}/print`],
  ] as const) {
    it(`${name}: OWNER, MANAGER, ACCOUNTANT and SALES; the warehouse role is refused (403); no session is 401`, async () => {
      const path = typeof url === "string" ? url : url();
      for (const role of ROLES) {
        const res = await h.request(sessions[role], "GET", path);
        expect(res.status, `${name} as ${role}`).toBe(READERS.includes(role) ? 200 : 403);
      }
      expect((await h.request(null, "GET", path)).status).toBe(401);
    });
  }

  it("GET /invoices/:id/profit: PROFIT_VIEW only — OWNER, MANAGER, ACCOUNTANT (SALES and the warehouse role: 403; no session: 401)", async () => {
    for (const role of ROLES) expect((await h.request(sessions[role], "GET", `/invoices/${invoiceId}/profit`)).status, role).toBe(PROFIT_VIEWERS.includes(role) ? 200 : 403);
    expect((await h.request(null, "GET", `/invoices/${invoiceId}/profit`)).status).toBe(401);
  });

  it("a refused role learns nothing: the 403 body carries no invoice data", async () => {
    const res = await h.request(sessions.INVENTORY, "GET", "/invoices?limit=1");
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).not.toMatch(/INV-|items|total/);
  });

  it("the expected sets agree with the shared permission model (a cross-check, not the source of the expectation)", () => {
    for (const role of ROLES) {
      expect(INVOICE_READ_PERMISSIONS.some((p) => roleHasPermission(role, p)), role).toBe(READERS.includes(role));
      expect(roleHasPermission(role, "PROFIT_VIEW"), role).toBe(PROFIT_VIEWERS.includes(role));
    }
  });
});

describe("requests", () => {
  it("unknown query fields, a bad enum, a bad date, a limit past 200 or a negative offset are refused (422) — never ignored", async () => {
    const owner = sessions.OWNER;
    for (const qs of ["nope=1", "status=NOPE", "scope=everything", "sort=random", "from=31-12-2026", "to=2026-13-01", "limit=201", "limit=0", "offset=-1", "minP=-5", "regionId=abc", "warehouseId=abc"]) {
      const res = await h.request(owner, "GET", `/invoices?${qs}`);
      expect(res.status, qs).toBe(422);
      expect(res.body.errors.length, qs).toBeGreaterThan(0);
    }
  });

  it("a hostile search string is text, not SQL: quotes, percent signs, backslashes, very long input", async () => {
    const owner = sessions.OWNER;
    for (const q of ["'; DROP TABLE invoices; --", "%", "_", "\\", "a".repeat(200), "\u0000".slice(0, 0) + "؀؀؀", '"quoted"']) {
      const res = await h.request(owner, "GET", `/invoices?q=${encodeURIComponent(q)}`);
      expect(res.status, q).toBe(200);
    }
    expect((await h.request(owner, "GET", `/invoices?q=${encodeURIComponent("a".repeat(201))}`)).status).toBe(422);
    expect((await h.request(owner, "GET", "/invoices?limit=1")).status).toBe(200); // the table is still there
  });
});

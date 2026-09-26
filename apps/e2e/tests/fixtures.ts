import { readFileSync } from "node:fs";
import path from "node:path";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import type { InvoiceDetail, InvoiceListResponse, PaymentDetail, PaymentListResponse, PartyLookupItem, ProductPickItem, PurchaseDetail, PurchaseListResponse, Role, Statement, WarehouseItem } from "@farooq/shared";
import { ARTIFACTS_DIR, readState } from "../setup/env";

export { expect };
export { BUYER_PRODUCTS, PURCHASE_PRODUCTS, SCENARIO } from "../setup/dataset";
export { ARTIFACTS_DIR };

/* ── a signed-in browser page per role ───────────────────────────────────────────────────────── */

export interface Opened {
  page: Page;
  context: BrowserContext;
  /** console.error / uncaught exceptions seen so far (a refused request the test provokes on purpose is expected to add "Failed to load resource" here). */
  errors: string[];
}

interface Fixtures {
  /** Opens a page already signed in as `role` (session cookie only: no login attempt is spent). */
  open: (role: Role, opts?: { width?: number; height?: number; theme?: "light" | "dark"; timezoneId?: string }) => Promise<Opened>;
  /** Set to true in a test that provokes a refusal on purpose; otherwise any console error fails the test. */
  allowConsoleErrors: { value: boolean };
}

export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern here
  allowConsoleErrors: async ({}, use) => {
    await use({ value: false });
  },
  open: async ({ browser, allowConsoleErrors }, use, testInfo) => {
    const opened: Opened[] = [];
    await use(async (role, opts = {}) => {
      const context = await browser.newContext({
        storageState: readState().users[role].storageState,
        viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 },
        ...(opts.timezoneId ? { timezoneId: opts.timezoneId } : {}),
      });
      if (opts.theme) await context.addInitScript((t) => { try { localStorage.setItem("theme", t); } catch { /* ignore */ } }, opts.theme);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      const o = { page, context, errors };
      opened.push(o);
      return o;
    });
    for (const o of opened) {
      if (!allowConsoleErrors.value) expect(o.errors, "console errors on a golden path").toEqual([]);
      await o.context.close();
    }
    void testInfo;
  },
});

/* ── the API, called directly (to set up data and to check what a screen claims) ─────────────── */

export interface Api {
  get<T = any>(path: string): Promise<T>;
  post(path: string, body: unknown): Promise<{ status: number; body: any }>;
  /** POST that must succeed. */
  postOk<T = any>(path: string, body: unknown): Promise<T>;
  /** PUT (an invoice edit made "by someone else", behind the screen's back). */
  put(path: string, body: unknown): Promise<{ status: number; body: any }>;
}

export async function apiAs(role: Role): Promise<Api> {
  const s = readState();
  const cookie = JSON.parse(readFileSync(s.users[role].storageState, "utf8")).cookies[0].value as string;
  const headers = { cookie: `fc_sid=${cookie}` };
  const csrf = ((await (await fetch(`${s.apiUrl}/auth/csrf`, { headers })).json()) as { csrfToken: string }).csrfToken;
  const post = async (p: string, body: unknown) => {
    const res = await fetch(`${s.apiUrl}${p}`, { method: "POST", headers: { ...headers, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const put = async (p: string, body: unknown) => {
    const res = await fetch(`${s.apiUrl}${p}`, { method: "PUT", headers: { ...headers, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return {
    put,
    get: async (p) => {
      const res = await fetch(`${s.apiUrl}${p}`, { headers });
      if (!res.ok) throw new Error(`GET ${p} → ${res.status} ${await res.text()}`);
      return res.json() as never;
    },
    post,
    postOk: async (p, body) => {
      const r = await post(p, body);
      if (r.status >= 300) throw new Error(`POST ${p} → ${r.status} ${JSON.stringify(r.body)}`);
      return r.body;
    },
  };
}

export async function findParty(api: Api, type: "customers" | "suppliers", name: string): Promise<PartyLookupItem> {
  const rows = await api.get<PartyLookupItem[]>(`/${type}?q=${encodeURIComponent(name)}&limit=20`);
  const hit = rows.find((r) => r.name === name);
  if (!hit) throw new Error(`No ${type} named "${name}" — is the e2e dataset loaded?`);
  return hit;
}

export const balanceOf = async (api: Api, type: "customers" | "suppliers", id: string): Promise<number> => (await api.get<{ balanceP: number }>(`/${type}/${id}/balance`)).balanceP;
export const statementOf = (api: Api, type: "customers" | "suppliers", id: string, q = ""): Promise<Statement> => api.get(`/${type}/${id}/statement${q}`);
export const paymentsList = (api: Api, q: string): Promise<PaymentListResponse> => api.get(`/payments?${q}`);
export const paymentDetail = (api: Api, id: string): Promise<PaymentDetail> => api.get(`/payments/${id}`);

/** Every payment matching `q` (walks the 200-row pages). */
export async function allPayments(api: Api, q = ""): Promise<PaymentListResponse["items"]> {
  const out: PaymentListResponse["items"] = [];
  for (let offset = 0; ; offset += 200) {
    const r = await paymentsList(api, `${q}${q ? "&" : ""}limit=200&offset=${offset}`);
    out.push(...r.items);
    if (out.length >= r.total || r.items.length === 0) return out;
  }
}

/* ── invoices (S9) ───────────────────────────────────────────────────────────────────────────── */

export const invoicesList = (api: Api, q: string): Promise<InvoiceListResponse> => api.get(`/invoices?${q}`);
export const invoiceDetailOf = (api: Api, id: string): Promise<InvoiceDetail> => api.get(`/invoices/${id}`);

/** Every invoice matching `q` (walks the 200-row pages). */
export async function allInvoices(api: Api, q = ""): Promise<InvoiceListResponse["items"]> {
  const out: InvoiceListResponse["items"] = [];
  for (let offset = 0; ; offset += 200) {
    const r = await invoicesList(api, `${q}${q ? "&" : ""}limit=200&offset=${offset}`);
    out.push(...r.items);
    if (out.length >= r.total || r.items.length === 0) return out;
  }
}

/** The first godown and a product with plenty of bags in it (the synthetic products each start with 100,000 in both godowns). */
export async function stockBasics(api: Api): Promise<{ warehouse: WarehouseItem; product: ProductPickItem; product2: ProductPickItem }> {
  const warehouse = (await api.get<WarehouseItem[]>("/warehouses")).find((w) => w.active)!;
  // the S10 builder products ("Builder …") have few bags on purpose and belong to the builder specs alone; so do S15's "E2E Buyer …" (the purchase-builder specs buy them)
  const products = (await api.get<ProductPickItem[]>(`/products?warehouseId=${warehouse.id}&limit=40`)).filter((p) => !/^(Builder |E2E Buyer )/.test(p.nameEn ?? p.name));
  return { warehouse, product: products[0]!, product2: products[1]! };
}

let keyCounter = 0;
/** POST /invoices through the real API: one 20-bag line at Rs 1,500 = 30,000.00 (+ an optional second product). Returns the saved invoice. */
export async function postInvoice(
  api: Api,
  o: { customerId: string; mode?: "post" | "draft"; paidAmountP?: number; date?: string; qty?: number; unitPriceP?: number; second?: boolean },
): Promise<InvoiceDetail> {
  const { warehouse, product, product2 } = await stockBasics(api);
  const lines = [{ productId: product.id, quantity: o.qty ?? 20, unitPriceP: o.unitPriceP ?? 150_000 }, ...(o.second ? [{ productId: product2.id, quantity: 5, unitPriceP: 90_000 }] : [])];
  return api.postOk<InvoiceDetail>("/invoices", {
    mode: o.mode ?? "post",
    customerId: o.customerId,
    warehouseId: warehouse.id,
    ...(o.date ? { date: o.date } : {}),
    lines,
    ...(o.paidAmountP ? { paidAmountP: o.paidAmountP } : {}),
    idempotencyKey: `e2e-${Date.now()}-${++keyCounter}`,
  });
}

/* ── purchases (S13) ─────────────────────────────────────────────────────────────────────────── */

export const purchasesList = (api: Api, q: string): Promise<PurchaseListResponse> => api.get(`/purchases?${q}`);
export const purchaseDetailOf = (api: Api, id: string): Promise<PurchaseDetail> => api.get(`/purchases/${id}`);

/** A product of the catalogue by its English name (the importer maps legacy ids to UUIDs). */
export async function productByName(api: Api, en: string): Promise<ProductPickItem> {
  const hit = (await api.get<ProductPickItem[]>(`/products?q=${encodeURIComponent(en)}&limit=20`)).find((p) => (p.nameEn ?? p.name) === en);
  if (!hit) throw new Error(`No product named "${en}" — is the e2e dataset loaded?`);
  return hit;
}

export interface PurchaseLineSpec {
  productId: string;
  quantity: number;
  unitPriceP: number;
  receivedQuantity?: number;
  warehouseId?: string;
  discountP?: number;
}

/** POST /purchases through the real API (the supplier and products must be the calling spec's own). Returns the saved purchase. */
export async function postPurchase(
  api: Api,
  o: { supplierId: string; lines: PurchaseLineSpec[]; warehouseId?: string; date?: string; paidAmountP?: number; freightP?: number; loadingP?: number; supplierInvoiceNo?: string; vehicleNo?: string; driver?: string; notes?: string },
): Promise<PurchaseDetail> {
  const warehouseId = o.warehouseId ?? (await api.get<WarehouseItem[]>("/warehouses")).find((w) => w.active)!.id;
  const { lines, ...rest } = o;
  return api.postOk<PurchaseDetail>("/purchases", { ...rest, warehouseId, lines, idempotencyKey: `e2e-pur-${Date.now()}-${++keyCounter}` });
}

/* ── small helpers ───────────────────────────────────────────────────────────────────────────── */

/** "1,234.50" → 123450 */
export const paisaOf = (text: string): number => Math.round(Number(text.replace(/[^\d.-]/g, "")) * 100);

/** The number of a receipt: "REC-2026-000123". */
export const RECEIPT_NO = /^(REC|PV)-\d{4}-\d{6}$/;

export const shot = (name: string): string => path.join(ARTIFACTS_DIR, `${name}.png`);

/** No page-level horizontal scrolling (an inner scroll box, like a wide table's, is fine). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scrollW, clientW } = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
  expect(scrollW, "page-level horizontal scroll").toBeLessThanOrEqual(clientW);
}

/** Splits RFC 4180 CSV text (quoted cells, doubled quotes, CRLF) into rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

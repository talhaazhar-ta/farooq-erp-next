import type { Page } from "@playwright/test";
import type { InvoiceDetail, ProductPickItem, WarehouseItem } from "@farooq/shared";
import { BUILDER_PRODUCTS } from "../setup/dataset";
import { expect, type Api } from "./fixtures";

/** Helpers shared by the invoice-builder specs (S10): driving the screen like a person, and reading the truth back from the API. */

export { BUILDER_PRODUCTS };

/** The two godowns of the dataset in the API's order: the first is the one a new invoice starts with. */
export async function godowns(api: Api): Promise<{ main: WarehouseItem; second: WarehouseItem }> {
  const all = (await api.get<WarehouseItem[]>("/warehouses")).filter((w) => w.active);
  return { main: all[0]!, second: all[1]! };
}

/** One of the builder products as the picker returns it (for a warehouse). */
export async function builderProduct(api: Api, key: keyof typeof BUILDER_PRODUCTS, warehouseId: string): Promise<ProductPickItem> {
  const rows = await api.get<ProductPickItem[]>(`/products?q=${encodeURIComponent(BUILDER_PRODUCTS[key].en)}&warehouseId=${warehouseId}`);
  const hit = rows.find((p) => p.nameEn === BUILDER_PRODUCTS[key].en);
  if (!hit) throw new Error(`Builder product ${key} is not in the dataset`);
  return hit;
}

export const bagsIn = (p: ProductPickItem, warehouseId: string): number => p.available.find((a) => a.warehouseId === warehouseId)?.quantity ?? 0;

/** The bags of a builder product in a godown, read live from the API. */
export async function stockOf(api: Api, key: keyof typeof BUILDER_PRODUCTS, warehouseId: string): Promise<number> {
  return bagsIn(await builderProduct(api, key, warehouseId), warehouseId);
}

/** Chooses a shop in the builder's shop combobox by typing its name. */
export async function chooseShop(page: Page, name: string): Promise<void> {
  const box = page.getByRole("combobox", { name: "Shop" });
  await box.click();
  await box.fill(name);
  await page.getByRole("option", { name: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
  await expect(box).toHaveValue(name);
}

/** Adds a product line by searching for it; the new line's quantity box takes the focus (legacy). Returns the 0-based index of the new line. */
export async function addProduct(page: Page, search: string): Promise<number> {
  const before = await page.getByTestId("line-row").count();
  const box = page.getByRole("searchbox", { name: "Search products" });
  await box.fill(search);
  // the list keeps the previous answer on screen while the new one loads: wait for the answer to THIS search before clicking
  await expect(page.getByTestId("product-results")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByTestId("product-result").first()).toContainText(search);
  await page.getByTestId("product-result").first().click();
  await expect(page.getByTestId("line-row")).toHaveCount(before + 1);
  return before;
}

/** Types into one box of a line (0-based). */
export async function fillLine(page: Page, index: number, field: "qty" | "rate" | "discount", value: string): Promise<void> {
  await page.getByTestId("line-row").nth(index).getByTestId(`line-${field}`).fill(value);
}

export const money = (paisa: number): string => (paisa / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** What the screen's sticky bar and summary say the grand total is, in paisa. */
export async function screenGrandTotal(page: Page): Promise<number> {
  const text = (await page.getByTestId("summary-grand-total").innerText()).replace(/[^\d.]/g, "");
  return Math.round(Number(text) * 100);
}

export function lineOf(inv: InvoiceDetail, productName: string) {
  const l = inv.lines.find((x) => x.descriptionEn === productName || x.description === productName);
  if (!l) throw new Error(`${productName} is not on ${inv.number ?? "the draft"}`);
  return l;
}

let apiKey = 0;
export interface ApiLine {
  productId: string;
  quantity: number;
  unitPriceP: number;
  discountP?: number;
  taxRatePct?: number;
  warehouseId?: string;
}
/** An invoice made straight through the API (test set-up: what the builder is then asked to open, edit or duplicate). */
export async function saveViaApi(
  api: Api,
  o: { customerId: string; warehouseId: string; lines: ApiLine[]; mode?: "draft" | "post"; paidAmountP?: number; extra?: Record<string, unknown> },
): Promise<InvoiceDetail> {
  return api.postOk<InvoiceDetail>("/invoices", {
    mode: o.mode ?? "post",
    customerId: o.customerId,
    warehouseId: o.warehouseId,
    lines: o.lines,
    ...(o.paidAmountP ? { paidAmountP: o.paidAmountP } : {}),
    ...(o.extra ?? {}),
    idempotencyKey: `e2e-builder-${Date.now()}-${++apiKey}`,
  });
}

/** The bags this invoice moved, net (negative = out of stock), from the movements the server lists on it. */
export const netBags = (inv: InvoiceDetail): number => inv.stockMovements.reduce((a, m) => a + m.quantity, 0);

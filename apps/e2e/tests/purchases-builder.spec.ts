import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import type { InvoiceDetail, ProductPickItem, PurchaseDetail, WarehouseItem } from "@farooq/shared";
import { test, expect, apiAs, balanceOf, expectNoHorizontalScroll, findParty, paisaOf, postPurchase, purchaseDetailOf, purchasesList, shot, ARTIFACTS_DIR, BUYER_PRODUCTS, SCENARIO, type Api } from "./fixtures";
import { addProduct, fillLine, godowns, screenGrandTotal } from "./builder-helpers";

/**
 * The purchase builder (S15) driven like a person against the real server. Every figure a test expects is read back from the API (stock,
 * balances, the average cost, the voucher) — the screen is never its own witness — and the money figures are worked out by hand in the
 * comments. Each money-moving test owns a supplier of its own (`SCENARIO.sup…`, appended in S15) and the "E2E Buyer …" products; the
 * average cost is per product × godown, so the edit test buys into the SECOND godown where nothing else is bought.
 *
 *   Sahiwal    new purchase: two lines, a part delivery, charges, money paid           Mardan / Jhelum  the supplier can be changed (nothing paid)
 *   Faisal     Received blank / 0 / part; an order books no stock                        Sialkot          stale revision → Reload; the unsaved-changes guard
 *   Sukkur     the last rate bought at                                                   Kasur            bags already sold: the edit is refused, then fixed
 *   Gujrat     edit: legacy question, supplier locked, net stock, average cost           Dera             a manager builds; a double click saves once
 *   Bahawal    the amount paid cannot be lowered (server's words)                        Swat             phone layout, refusals, dark theme, roles
 */

let api: Api;
let main: WarehouseItem;
let second: WarehouseItem;
test.beforeAll(async () => {
  api = await apiAs("OWNER");
  ({ main, second } = await godowns(api));
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
});

/* ── helpers ─────────────────────────────────────────────────────────────────────────────────── */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function chooseSupplier(page: Page, name: string): Promise<void> {
  const box = page.getByRole("combobox", { name: "Supplier" });
  await box.click();
  await box.fill(name);
  await page.getByRole("option", { name: new RegExp(escapeRe(name)) }).first().click();
  await expect(box).toHaveValue(name);
}

const fillRecv = (page: Page, index: number, value: string) => page.getByTestId("line-row").nth(index).getByTestId("line-recv").fill(value);
const toast = (page: Page, text: string) => page.getByTestId("toast").filter({ hasText: text }).first();

/** The bags of a buyer product in a godown, read live from the API. */
async function bagsOf(key: keyof typeof BUYER_PRODUCTS, warehouseId: string): Promise<number> {
  const rows = await api.get<ProductPickItem[]>(`/products?q=${encodeURIComponent(BUYER_PRODUCTS[key].en)}&warehouseId=${warehouseId}&limit=20`);
  const hit = rows.find((p) => p.nameEn === BUYER_PRODUCTS[key].en);
  if (!hit) throw new Error(`${BUYER_PRODUCTS[key].en} is not in the dataset`);
  return hit.available.find((a) => a.warehouseId === warehouseId)?.quantity ?? 0;
}
async function productOf(key: keyof typeof BUYER_PRODUCTS, warehouseId: string): Promise<ProductPickItem> {
  const rows = await api.get<ProductPickItem[]>(`/products?q=${encodeURIComponent(BUYER_PRODUCTS[key].en)}&warehouseId=${warehouseId}&limit=20`);
  return rows.find((p) => p.nameEn === BUYER_PRODUCTS[key].en)!;
}
const supplierId = async (name: string) => (await findParty(api, "suppliers", name)).id;

/** The full PUT body of a recorded purchase, unchanged (what a screen would send) — a test patches what it changes. */
function editBodyOf(d: PurchaseDetail, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    supplierId: d.supplierId,
    warehouseId: d.warehouseId,
    date: d.date,
    supplierInvoiceNo: d.supplierInvoiceNo ?? undefined,
    vehicleNo: d.vehicleNo ?? undefined,
    driver: d.driver ?? undefined,
    deliveryRef: d.deliveryRef ?? undefined,
    lines: d.lines.map((l) => ({
      id: l.id,
      productId: l.productId,
      quantity: l.quantity,
      ...(l.receivedQtyMilli !== l.qtyMilli ? { receivedQuantity: l.receivedQuantity } : {}),
      unitPriceP: l.unitPriceP,
      discountP: l.discountP,
      warehouseId: l.warehouseId,
    })),
    invoiceDiscountP: d.invoiceDiscountP,
    freightP: d.freightP,
    loadingP: d.loadingP,
    otherChargesP: d.otherChargesP,
    revision: d.revision,
    idempotencyKey: `e2e-edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...patch,
  };
}

/* ── tests ───────────────────────────────────────────────────────────────────────────────────── */

test("new purchase: two lines, a part delivery, charges, money paid → the bill, the stock, the voucher and the supplier's balance agree with the API", async ({ open }) => {
  const { page } = await open("OWNER");
  const sahiwal = await supplierId(SCENARIO.supSahiwal.name);
  const rice0 = await bagsOf("rice", main.id);
  const sugar0 = await bagsOf("sugar", main.id);

  // the button on the list, the empty form: the supplier is NOT pre-selected
  await page.goto("/purchases");
  await page.getByTestId("new-purchase").click();
  await expect(page).toHaveURL(/\/purchases\/new$/);
  await expect(page.getByTestId("builder-title")).toHaveText("Receive stock from a mill");
  await expect(page.getByRole("combobox", { name: "Supplier" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "Supplier" })).toHaveAttribute("placeholder", "— Choose a supplier —");
  await expect(page.getByTestId("no-lines")).toBeVisible();
  await expect(page.getByTestId("received-banner")).toContainText("Leave Received blank if the whole line arrived.");

  await chooseSupplier(page, SCENARIO.supSahiwal.name);
  await expect(page.getByTestId("supplier-balance")).toContainText("Settled");

  // 40 rice ordered, 25 arrived, Rs 1,000 a bag; 10 sugar (Received left blank = all), Rs 3,000 a bag less Rs 500
  const r = await addProduct(page, "E2E Buyer Rice");
  await expect(page.getByTestId("line-qty").nth(r)).toBeFocused();
  await page.keyboard.type("40");
  await fillRecv(page, r, "25");
  await fillLine(page, r, "rate", "1000");
  await expect(page.getByTestId("line-received-hint").nth(0)).toContainText("Part delivery");
  const s = await addProduct(page, "E2E Buyer Sugar");
  await fillLine(page, s, "qty", "10");
  await fillLine(page, s, "rate", "3000");
  await fillLine(page, s, "discount", "500");
  await page.getByTestId("field-freight").fill("200");
  await page.getByTestId("field-loading").fill("100");
  await page.getByTestId("field-invoiceDiscount").fill("50");
  await page.getByTestId("field-paidAmount").fill("5,000");
  await page.getByTestId("field-supplierInvoiceNo").fill("SAH-1");
  await page.getByTestId("field-vehicleNo").fill("LES-777");
  await page.getByTestId("field-driver").fill("Bilal");

  // by hand: 40 × 1,000 + 10 × 3,000 = 70,000 − 500 (line) − 50 (overall) + 200 + 100 (charges) = 69,750.00; paid 5,000 → 64,750.00
  expect(await screenGrandTotal(page)).toBe(6_975_000);
  await expect(page.getByTestId("summary-balance")).toHaveText("PKR 64,750.00");
  await expect(page.getByTestId("summary-ordered")).toHaveText("50");
  await expect(page.getByTestId("summary-received")).toHaveText("35");
  await expect(page.getByTestId("sticky-total")).toContainText("69,750.00");
  await page.screenshot({ path: shot("purchase-builder-new-desktop"), fullPage: true });

  await page.getByTestId("save-purchase").click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/); // (a form that still thought it had unsaved changes would have asked first)
  await expect(toast(page, "saved")).toBeVisible();
  const id = page.url().split("/").pop()!;
  const d = await purchaseDetailOf(api, id);
  expect(d.number).toMatch(/^PUR-\d{4}-\d{6}$/);
  expect(d.supplierId).toBe(sahiwal);
  expect(d.status).toBe("PARTIALLY_RECEIVED");
  expect(d.totalP).toBe(6_975_000);
  expect(d.paidP).toBe(500_000);
  expect(d.balanceP).toBe(6_475_000);
  expect([d.supplierInvoiceNo, d.vehicleNo, d.driver]).toEqual(["SAH-1", "LES-777", "Bilal"]);
  expect(d.lines.map((l) => [l.quantity, l.receivedQuantity])).toEqual([[40, 25], [10, 10]]);
  expect(d.orderedQuantity).toBe(50);
  expect(d.receivedQuantity).toBe(35);
  expect(d.payments).toHaveLength(1);
  expect(d.payments[0]).toMatchObject({ allocatedP: 500_000, status: "POSTED", reference: "SAH-1" });
  // only the bags that ARRIVED went into stock
  expect(await bagsOf("rice", main.id)).toBe(rice0 + 25);
  expect(await bagsOf("sugar", main.id)).toBe(sugar0 + 10);
  // the supplier owes the rest
  expect(await balanceOf(api, "suppliers", sahiwal)).toBe(6_475_000);
  // the page it landed on says the same
  await expect(page.getByTestId("purchase-number")).toHaveText(d.number!);
  expect(paisaOf(await page.getByTestId("grand-total").innerText())).toBe(6_975_000);
  expect(paisaOf(await page.getByTestId("paid-total").innerText())).toBe(500_000);
  await expect(page.getByTestId("purchase-bags")).toHaveText("35 received of 50 ordered");
  await expect(page.getByTestId("cost-block")).toBeVisible();
});

test("Received: blank = all, a smaller figure = a part delivery, 0 = the bill only (hint + button say so); an order books no stock", async ({ open }) => {
  const { page } = await open("OWNER");
  const faisal = await supplierId(SCENARIO.supFaisal.name);
  const salt0 = await bagsOf("salt", main.id);
  const ghee0 = await bagsOf("ghee", main.id);

  await page.goto("/purchases/new");
  await chooseSupplier(page, SCENARIO.supFaisal.name);
  const a = await addProduct(page, "E2E Buyer Salt");
  await fillLine(page, a, "qty", "20");
  await fillLine(page, a, "rate", "500");
  const b = await addProduct(page, "E2E Buyer Ghee");
  await fillLine(page, b, "qty", "10");
  await fillLine(page, b, "rate", "4000");
  await expect(page.getByTestId("line-received-hint")).toHaveCount(0); // blank = the whole line: nothing to say
  await expect(page.getByTestId("save-purchase")).toHaveText("Save & Receive Stock");

  await fillRecv(page, a, "0"); // salt: an order, nothing arrived
  const hint = page.getByTestId("line-row").nth(a).getByTestId("line-received-hint");
  await expect(hint).toContainText("puts no bags into stock");
  await expect(hint).toContainText("counted twice"); // the warehouse-app double-count trap
  await expect(page.getByTestId("none-banner")).toBeVisible();
  await expect(page.getByTestId("summary-received")).toHaveText("10");
  await expect(page.getByTestId("save-purchase")).toHaveText("Save & Receive Stock"); // the ghee still arrives
  await fillRecv(page, b, "0");
  await expect(page.getByTestId("summary-received")).toHaveText("0");
  await expect(page.getByTestId("save-purchase")).toHaveText("Save order (no stock)");
  // 20 × 500 + 10 × 4,000 = 50,000.00, on the bags ORDERED
  expect(await screenGrandTotal(page)).toBe(5_000_000);

  await page.getByTestId("save-purchase").click();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/);
  const d = await purchaseDetailOf(api, page.url().split("/").pop()!);
  expect(d.status).toBe("ORDERED");
  expect(d.receivedQuantity).toBe(0);
  expect(d.stockMovements).toHaveLength(0);
  expect(d.totalP).toBe(5_000_000);
  await expect(page.getByTestId("ordered-banner")).toBeVisible();
  await expect(page.getByTestId("no-stock")).toContainText("Nothing has arrived");
  expect(await bagsOf("salt", main.id)).toBe(salt0);
  expect(await bagsOf("ghee", main.id)).toBe(ghee0);
  // the bill is on the supplier's account all the same
  expect(await balanceOf(api, "suppliers", faisal)).toBe(5_000_000);
});

test("a product bought before starts at the last rate paid, with the day and the purchase named; a typed rate is kept", async ({ open }) => {
  const { page } = await open("OWNER");
  const prior = await postPurchase(api, { supplierId: await supplierId(SCENARIO.supSukkur.name), lines: [{ productId: (await productOf("sugar", main.id)).id, quantity: 5, unitPriceP: 330_000 }] });
  await page.goto("/purchases/new");
  await chooseSupplier(page, SCENARIO.supSukkur.name);
  const i = await addProduct(page, "E2E Buyer Sugar");
  await expect(page.getByTestId("line-rate").nth(i)).toHaveValue("3300");
  await expect(page.getByTestId("line-last-rate").nth(i)).toContainText(`Last bought at PKR 3,300.00/bag`);
  await expect(page.getByTestId("line-last-rate").nth(i)).toContainText(prior.number!);
  // typing over the starting rate is fine
  await fillLine(page, i, "rate", "3400");
  await expect(page.getByTestId("line-rate").nth(i)).toHaveValue("3400");
});

test("edit: the legacy question first, the supplier locked while a voucher belongs to it, net stock, the average cost recomputed, money only ever raised", async ({ open }) => {
  const { page } = await open("OWNER");
  const gujrat = await supplierId(SCENARIO.supGujrat.name);
  const rice = await productOf("rice", second.id);
  const ghee = await productOf("ghee", second.id);
  // 30 rice ordered / 20 arrived at Rs 1,000; 10 ghee at Rs 4,000 (all arrived); freight Rs 100; Rs 2,000 paid — into the SECOND godown (nothing else buys there)
  const p = await postPurchase(api, {
    supplierId: gujrat,
    warehouseId: second.id,
    lines: [
      { productId: rice.id, quantity: 30, receivedQuantity: 20, unitPriceP: 100_000, warehouseId: second.id },
      { productId: ghee.id, quantity: 10, unitPriceP: 400_000, warehouseId: second.id },
    ],
    freightP: 10_000,
    paidAmountP: 200_000,
    supplierInvoiceNo: "GUJ-1",
  });
  expect(p.totalP).toBe(7_010_000); // 30,000 + 40,000 + 100
  const before = await purchaseDetailOf(api, p.id);
  // charges 10,000 spread over the line values 3,000,000 : 4,000,000 → rice 4,286 (÷ 20 received = 214) → landed 100,214; ghee 5,714 (÷ 10 = 571) → 400,571
  expect(before.costs!.stock.find((c) => c.productId === rice.id)!.avgCostP).toBe(100_214);
  expect(before.costs!.stock.find((c) => c.productId === ghee.id)!.avgCostP).toBe(400_571);
  const riceBefore = await bagsOf("rice", second.id);
  const gheeBefore = await bagsOf("ghee", second.id);

  await page.goto(`/purchases/${p.id}`);
  await expect(page.getByTestId("action-edit")).toBeEnabled();
  await page.getByTestId("action-edit").click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${p.id}/edit$`));

  // the legacy question comes first; Cancel goes back to the purchase without opening the form
  const gate = page.getByRole("dialog", { name: "Edit a purchase that is already in stock?" });
  await expect(gate).toContainText("Editing it will adjust stock and the supplier balance by the difference, and the change is recorded in the audit log.");
  await gate.getByTestId("gate-cancel").click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${p.id}$`));
  await page.getByTestId("action-edit").click();
  await page.getByTestId("gate-continue").click();

  await expect(page.getByTestId("builder-title")).toHaveText(`Edit ${p.number}`);
  // the supplier is locked (a voucher belongs to it) with the SERVER's reason
  expect(before.actions.changeSupplier.allowed).toBe(false);
  await expect(page.getByTestId("supplier-locked")).toHaveText(SCENARIO.supGujrat.name);
  await expect(page.getByTestId("supplier-locked-hint")).toHaveText(before.actions.changeSupplier.reason!);
  await expect(page.getByRole("combobox", { name: "Supplier" })).toHaveCount(0);
  // the lines as saved: rice a part delivery, ghee blank = all; the amount paid starts at what has been paid, with the legacy hint
  await expect(page.getByTestId("line-row")).toHaveCount(2);
  await expect(page.getByTestId("line-qty").nth(0)).toHaveValue("30");
  await expect(page.getByTestId("line-recv").nth(0)).toHaveValue("20");
  await expect(page.getByTestId("line-recv").nth(1)).toHaveValue("");
  await expect(page.getByTestId("field-paidAmount")).toHaveValue("2000");
  await expect(page.getByText("What has been paid with this purchase so far. Raising it records another payment voucher for the difference; to lower it, reverse the voucher from Payments.")).toBeVisible();
  await expect(page.getByTestId("save-purchase")).toHaveText("Save changes");
  await page.screenshot({ path: shot("purchase-builder-edit-desktop"), fullPage: true });

  // rice: the whole line arrived after all (Received blank) at Rs 1,100; the ghee line goes; Rs 1,000 more is paid
  await page.getByTestId("line-recv").nth(0).fill("");
  await fillLine(page, 0, "rate", "1100");
  await page.getByRole("button", { name: "Remove line 2" }).click();
  await page.getByTestId("field-paidAmount").fill("3,000");
  // by hand: 30 × 1,100 = 33,000 + freight 100 = 33,100.00; paid 3,000 → 30,100.00
  expect(await screenGrandTotal(page)).toBe(3_310_000);
  await expect(page.getByTestId("summary-balance")).toHaveText("PKR 30,100.00");
  await page.getByTestId("save-purchase").click();

  await expect(page).toHaveURL(new RegExp(`/purchases/${p.id}$`));
  await expect(toast(page, `Purchase ${p.number} updated — stock and the supplier balance follow the change.`)).toBeVisible();
  const d = await purchaseDetailOf(api, p.id);
  expect(d.revision).toBe(before.revision + 1);
  expect(d.lines).toHaveLength(1);
  expect(d.lines[0]!.id).toBe(before.lines[0]!.id); // the kept line keeps its identity
  expect(d).toMatchObject({ totalP: 3_310_000, paidP: 300_000, balanceP: 3_010_000, status: "RECEIVED" });
  expect(d.payments).toHaveLength(2); // only the 1,000 that was ADDED got a new voucher
  expect(d.payments.reduce((a, v) => a + v.allocatedP, 0)).toBe(300_000);
  // net stock: rice 20 → 30 (+10), ghee 10 → 0 (−10)
  expect(await bagsOf("rice", second.id)).toBe(riceBefore + 10);
  expect(await bagsOf("ghee", second.id)).toBe(gheeBefore - 10);
  expect(d.stockMovements.some((m) => m.refType === "PURCHASE_EDIT")).toBe(true);
  // the average cost was recomputed from the saved lines: 110,000 + 10,000 ÷ 30 bags (333) = 110,333
  expect(d.costs!.stock.find((c) => c.productId === rice.id)!.avgCostP).toBe(110_333);
  expect(await balanceOf(api, "suppliers", gujrat)).toBe(3_010_000);
});

test("the amount paid cannot be lowered: the screen says so, the server refuses in its own words naming the voucher, nothing changes", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true; // the server refuses on purpose here
  const { page } = await open("OWNER");
  const p = await postPurchase(api, { supplierId: await supplierId(SCENARIO.supBahawal.name), lines: [{ productId: (await productOf("salt", main.id)).id, quantity: 10, unitPriceP: 50_000 }], paidAmountP: 100_000 });
  expect(p.payments).toHaveLength(1);
  await page.goto(`/purchases/${p.id}/edit`);
  await page.getByTestId("gate-continue").click();
  await expect(page.getByTestId("field-paidAmount")).toHaveValue("1000");
  await page.getByTestId("field-paidAmount").fill("400");
  await expect(page.getByTestId("paid-lowered")).toContainText("PKR 1,000.00 has already been paid against this purchase");
  await page.getByTestId("save-purchase").click();
  const banner = page.getByTestId("save-errors");
  await expect(banner).toContainText("This purchase cannot be saved yet — nothing has been changed");
  await expect(banner).toContainText(p.payments[0]!.receiptNumber);
  await expect(banner).toContainText("The amount paid cannot be lowered here — reverse that payment voucher from Payments instead.");
  await expect(page.getByTestId("field-paidAmount")).toHaveValue("400"); // the form is exactly as typed
  const d = await purchaseDetailOf(api, p.id);
  expect(d.revision).toBe(p.revision);
  expect(d.paidP).toBe(100_000);
  // raising it works: another voucher for the difference only
  await page.getByTestId("field-paidAmount").fill("1,500");
  await expect(page.getByTestId("paid-lowered")).toHaveCount(0);
  await page.getByTestId("save-purchase").click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${p.id}$`));
  const e = await purchaseDetailOf(api, p.id);
  expect(e.paidP).toBe(150_000);
  expect(e.payments).toHaveLength(2);
  expect(await balanceOf(api, "suppliers", p.supplierId!)).toBe(500_000 - 150_000);
});

test("while nothing has been paid the supplier can be changed: both suppliers' balances follow", async ({ open }) => {
  const { page } = await open("OWNER");
  const jhelum = await supplierId(SCENARIO.supJhelum.name);
  const mardan = await supplierId(SCENARIO.supMardan.name);
  const p = await postPurchase(api, { supplierId: jhelum, lines: [{ productId: (await productOf("salt", main.id)).id, quantity: 4, unitPriceP: 60_000 }] });
  expect(p.actions.changeSupplier.allowed).toBe(true);
  expect(await balanceOf(api, "suppliers", jhelum)).toBe(240_000);
  await page.goto(`/purchases/${p.id}`);
  await expect(page.getByTestId("action-change-supplier")).toBeEnabled();
  await page.getByTestId("action-change-supplier").click(); // opens the same form
  await page.getByTestId("gate-continue").click();
  await expect(page.getByTestId("supplier-locked")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Supplier" })).toHaveValue(SCENARIO.supJhelum.name);
  await chooseSupplier(page, SCENARIO.supMardan.name);
  await page.getByTestId("save-purchase").click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${p.id}$`));
  expect((await purchaseDetailOf(api, p.id)).supplierId).toBe(mardan);
  expect(await balanceOf(api, "suppliers", jhelum)).toBe(0);
  expect(await balanceOf(api, "suppliers", mardan)).toBe(240_000);
  await expect(page.getByTestId("purchase-supplier")).toHaveText(SCENARIO.supMardan.name);
});

test("a stale revision: the server's words and Reload; Reload brings the newer purchase into the form without asking the question again", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true;
  const { page } = await open("OWNER");
  const p = await postPurchase(api, { supplierId: await supplierId(SCENARIO.supSialkot.name), lines: [{ productId: (await productOf("ghee", main.id)).id, quantity: 6, unitPriceP: 410_000 }] });
  await page.goto(`/purchases/${p.id}/edit`);
  await page.getByTestId("gate-continue").click();
  await expect(page.getByTestId("line-qty").first()).toHaveValue("6");
  await page.getByTestId("field-notes").fill("changed on the screen");
  // someone else edits it first (7 bags)
  const r = await api.put(`/purchases/${p.id}`, editBodyOf(p, { lines: [{ id: p.lines[0]!.id, productId: p.lines[0]!.productId, quantity: 7, unitPriceP: 410_000, warehouseId: p.lines[0]!.warehouseId }] }));
  expect(r.status).toBe(200);
  await page.getByTestId("save-purchase").click();
  await expect(page.getByTestId("save-errors")).toContainText("This purchase was changed by someone else since you opened it. Reload it and make your change again.");
  await page.getByTestId("reload-purchase").click();
  await expect(page.getByTestId("line-qty").first()).toHaveValue("7");
  await expect(page.getByTestId("save-errors")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("field-notes")).toHaveValue("");
  await page.getByTestId("field-notes").fill("second try");
  await page.getByTestId("save-purchase").click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${p.id}$`));
  expect((await purchaseDetailOf(api, p.id)).notes).toBe("second try");
});

test("leaving with changes asks first; Keep editing stays, Leave loses them; a saved form does not ask", async ({ open }) => {
  const { page } = await open("OWNER");
  await page.goto("/purchases/new");
  await expect(page.getByTestId("dirty-note")).toHaveCount(0);
  await page.getByTestId("field-notes").fill("draft thoughts");
  await expect(page.getByTestId("dirty-note")).toBeVisible();
  await page.getByRole("link", { name: "← All purchases" }).click();
  const ask = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(ask).toContainText("You have changes on this purchase that have not been saved.");
  await ask.getByTestId("stay").click();
  await expect(page).toHaveURL(/\/purchases\/new$/);
  await expect(page.getByTestId("field-notes")).toHaveValue("draft thoughts");
  await page.getByRole("link", { name: "← All purchases" }).click();
  await page.getByRole("dialog", { name: "Leave without saving?" }).getByTestId("leave").click();
  await expect(page).toHaveURL(/\/purchases$/);
});

test("bags already sold: an edit that takes back more than is on the shelf is refused in the server's words, and the form fixes it", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true;
  const { page } = await open("OWNER");
  // the SECOND godown: salt is bought nowhere else there, so the shelf holds exactly this delivery
  const salt = await productOf("salt", second.id);
  const kasur = await supplierId(SCENARIO.supKasur.name);
  const shop = await findParty(api, "customers", SCENARIO.buyerShop.name);
  const stock0 = await bagsOf("salt", second.id);
  const p = await postPurchase(api, { supplierId: kasur, warehouseId: second.id, lines: [{ productId: salt.id, quantity: 10, unitPriceP: 50_000, warehouseId: second.id }] });
  expect(await bagsOf("salt", second.id)).toBe(stock0 + 10);
  // 8 of them are sold
  await api.postOk<InvoiceDetail>("/invoices", {
    mode: "post", customerId: shop.id, warehouseId: second.id, lines: [{ productId: salt.id, quantity: 8, unitPriceP: 60_000, warehouseId: second.id }], idempotencyKey: `e2e-buyer-${Date.now()}`,
  });
  expect(await bagsOf("salt", second.id)).toBe(stock0 + 2);

  await page.goto(`/purchases/${p.id}/edit`);
  await page.getByTestId("gate-continue").click();
  await fillRecv(page, 0, "5"); // only 5 arrived after all: 5 fewer bags in stock than before, but only 2 are on the shelf
  await page.getByTestId("save-purchase").click();
  const banner = page.getByTestId("save-errors");
  await expect(banner).toContainText("The rest of that delivery has already been sold or moved, so it cannot be reduced by that much.");
  expect((await purchaseDetailOf(api, p.id)).revision).toBe(p.revision);
  expect(await bagsOf("salt", second.id)).toBe(stock0 + 2);
  // 8 arrived is fine: 2 fewer bags, exactly what is on the shelf
  await fillRecv(page, 0, "8");
  await page.getByTestId("save-purchase").click();
  await expect(page).toHaveURL(new RegExp(`/purchases/${p.id}$`));
  expect(await bagsOf("salt", second.id)).toBe(stock0);
  expect((await purchaseDetailOf(api, p.id)).receivedQuantity).toBe(8);
});

test("a manager builds one (whole page, a double click saves ONCE)", async ({ open }) => {
  const { page } = await open("MANAGER");
  const dera = await supplierId(SCENARIO.supDera.name);
  await page.goto("/purchases");
  await page.getByTestId("new-purchase").click();
  await chooseSupplier(page, SCENARIO.supDera.name);
  const i = await addProduct(page, "E2E Buyer Rice");
  await fillLine(page, i, "qty", "12");
  await fillLine(page, i, "rate", "1050");
  await page.getByTestId("save-purchase").dblclick();
  await expect(page).toHaveURL(/\/purchases\/[0-9a-f-]{36}$/);
  const mine = (await purchasesList(api, `q=${encodeURIComponent(SCENARIO.supDera.name)}&limit=50`)).items;
  expect(mine).toHaveLength(1);
  const d = await purchaseDetailOf(api, mine[0]!.id);
  expect(d.totalP).toBe(1_260_000); // 12 × 1,050
  expect(await balanceOf(api, "suppliers", dera)).toBe(1_260_000);
});

test("refusals: no supplier, then no line, then an amount paid above the total — every server line shown verbatim, nothing saved", async ({ open, allowConsoleErrors }) => {
  allowConsoleErrors.value = true;
  const { page } = await open("OWNER");
  const before = (await purchasesList(api, "limit=1")).onFile;
  await page.goto("/purchases/new");
  await page.getByTestId("save-purchase").click();
  const banner = page.getByTestId("save-errors");
  await expect(banner).toContainText("Choose a supplier.");
  await expect(page.getByRole("combobox", { name: "Supplier" })).toHaveAttribute("aria-invalid", "true");
  await chooseSupplier(page, SCENARIO.supSwat.name);
  await page.getByTestId("save-purchase").click();
  await expect(page.getByTestId("save-errors")).toContainText("Add at least one product line.");
  const i = await addProduct(page, "E2E Buyer Salt");
  await fillLine(page, i, "qty", "1");
  await fillLine(page, i, "rate", "100");
  await page.getByTestId("field-paidAmount").fill("500");
  await page.getByTestId("save-purchase").click();
  await expect(page.getByTestId("save-errors")).toContainText("The amount paid is more than the purchase total. Record the extra as a separate payment to the supplier.");
  expect((await purchasesList(api, "limit=1")).onFile).toBe(before);
});

test("phone: the lines become cards, the total and Save stay in reach, no sideways scrolling — new and edit", async ({ open }) => {
  const { page } = await open("OWNER", { width: 390, height: 844 });
  const p = await postPurchase(api, { supplierId: await supplierId(SCENARIO.supSwat.name), lines: [{ productId: (await productOf("ghee", main.id)).id, quantity: 3, receivedQuantity: 2, unitPriceP: 400_000 }] });
  await page.goto("/purchases/new");
  await expect(page.getByTestId("purchase-builder")).toBeVisible();
  await chooseSupplier(page, SCENARIO.supSwat.name);
  const i = await addProduct(page, "E2E Buyer Rice");
  await fillLine(page, i, "qty", "5");
  await fillLine(page, i, "rate", "1000");
  await fillRecv(page, i, "0");
  await expect(page.getByTestId("lines-cards")).toBeVisible();
  await expect(page.getByTestId("lines-editor")).toHaveCount(0); // one representation in the page
  await expectNoHorizontalScroll(page);
  const bar = page.getByTestId("sticky-bar");
  await expect(bar).toBeInViewport();
  await expect(bar.getByTestId("save-purchase")).toBeInViewport();
  await expect(page.getByTestId("sticky-total")).toContainText("5,000.00");
  await page.screenshot({ path: shot("purchase-builder-new-phone"), fullPage: true });

  await page.goto(`/purchases/${p.id}/edit`);
  await page.getByTestId("gate-continue").click();
  await expect(page.getByTestId("lines-cards")).toBeVisible();
  await expect(page.getByTestId("line-recv").first()).toHaveValue("2");
  await expectNoHorizontalScroll(page);
  await expect(page.getByTestId("sticky-bar").getByTestId("save-purchase")).toBeInViewport();
  await page.screenshot({ path: shot("purchase-builder-edit-phone"), fullPage: true });
});

test("dark theme: the form is readable (screenshot) and the shell says nothing is wrong", async ({ open }) => {
  const { page } = await open("OWNER", { theme: "dark" });
  await page.goto("/purchases/new");
  await chooseSupplier(page, SCENARIO.supSwat.name);
  const i = await addProduct(page, "E2E Buyer Sugar");
  await fillLine(page, i, "qty", "3");
  await fillLine(page, i, "rate", "3000");
  await fillRecv(page, i, "1");
  await page.screenshot({ path: shot("purchase-builder-new-dark"), fullPage: true });
  await expect(page.getByTestId("line-received-hint")).toBeVisible();
});

test("who may build: the accountant corrects but does not record (and can still pay a supplier); Sales and the warehouse role see 'Not available'", async ({ open }) => {
  const acc = await open("ACCOUNTANT");
  await acc.page.goto("/purchases");
  await expect(acc.page.getByTestId("purchase-row").first()).toBeVisible();
  await expect(acc.page.getByTestId("new-purchase")).toHaveCount(0);
  await acc.page.goto("/purchases/new");
  await expect(acc.page.getByTestId("not-available")).toContainText("Not available for the");
  const list = { items: (await purchasesList(api, "limit=50")).items.filter((i) => i.status !== "CANCELLED") };
  await acc.page.goto(`/purchases/${list.items[0]!.id}/edit`);
  await acc.page.getByTestId("gate-continue").click();
  await expect(acc.page.getByTestId("purchase-builder")).toBeVisible();
  await expect(acc.page.getByTestId("field-paidAmount")).toBeEnabled(); // the accountant holds PAYMENT_PAYOUT
  for (const role of ["SALES", "INVENTORY"] as const) {
    const o = await open(role);
    for (const path of ["/purchases/new", `/purchases/${list.items[0]!.id}/edit`]) {
      await o.page.goto(path);
      await expect(o.page.getByTestId("not-available")).toContainText("Not available for the");
      await expect(o.page.getByTestId("purchase-builder")).toHaveCount(0);
    }
  }
});

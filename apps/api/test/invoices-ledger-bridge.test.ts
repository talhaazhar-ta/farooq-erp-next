import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLegacyLedger, reconcile, runImport, uuidV5, type Backup, type ReconciliationReport } from "@farooq/import";
import { TEST_ADMIN_URL } from "@farooq/db/testing";
import { statementSchema } from "@farooq/shared";
import { createHarness, customerBalanceSql, supplierBalanceSql, trialBalance, type Harness, type Session } from "./helpers/harness.js";
import { cancel, changeShop, duplicate, editBody, invBody, levelOf, movementSum, post, put } from "./helpers/invoices.js";

/**
 * THE INVOICE LEDGER BRIDGE — S3's bridge for M2 (CLAUDE.md rule 8).
 *
 * 1. Import the synthetic fixture (every balance and every stock quantity reconciles to the unit).
 * 2. Run a scripted sequence of invoice operations through the HTTP API: post with and without money, edit up and down,
 *    cancel, change shop (with receipts), duplicate -> post, a multi-godown taxed sale, a draft.
 * 3. Apply THE SAME operations, by hand, to the fixture's legacy-shaped JSON, the way the legacy `Invoices` code wrote them
 *    (a full reverse + re-deduct on edit, a status flip on cancel, `customerId` rewritten on change-shop).
 * 4. Compare, for EVERY shop and supplier, the legacy ledger algorithm (`LegacyLedger`, no database) with the new journal; the
 *    stock levels with Σ movements and with hand-computed bags; then run the real reconciliation on the result.
 *
 * Every expected figure below was derived on paper (paisa / thousandths) from the fixture header, not by running either side.
 *
 *  step  operation (today = 2026-03-05)                                     shop balance after (paisa)
 *   1    post INV-…09 cust-4: 5 bags p-1@wh-1 @1,000 − 200 + 100 freight,  cust-4 15,000 + 490,000 − 100,000 = 405,000
 *        paid 1,000                                                         (previous balance printed: 15,000)
 *   2    post INV-…10 cust-6: 2.5 bags p-2@wh-1 @900 − 50 discount           cust-6 0 + 220,000 = 220,000
 *   3    edit INV-…09 up to 8 bags, paid up to 3,000 (a 2,000 receipt)        cust-4 15,000 + 790,000 − 300,000 = 505,000
 *   4    edit INV-…10 down to 1 bag                                           cust-6 85,000
 *   5    post INV-…11 cust-6: 3 bags p-3 @800                                  cust-6 85,000 + 240,000
 *   6    cancel INV-…11                                                        cust-6 85,000 (pair cancels)
 *   7    change shop INV-…10 cust-6 -> cust-4                                  cust-6 0, cust-4 590,000
 *   8    change shop INV-…09 (both receipts) cust-4 -> cust-6                  cust-4 100,000, cust-6 490,000
 *   9    duplicate INV-…09 -> draft -> post INV-…12                            cust-6 490,000 + 790,000 = 1,280,000
 *  10    post INV-…13 cust-2: 2 bags p-1@wh-2 @1,000 + 1 bag p-2 @900 + 10%  cust-2 100,000 + 299,000 − 299,000 = 100,000
 *        tax, paid in full
 *  11    a draft for cust-5                                                    (nothing moves)
 *  Final receivables: c1 1,900,000  c2 100,000  c3 470,000  c4 100,000  c5 450,000  c6 1,280,000   (Σ 4,300,000 = 2,935,000 + 1,964,000 invoiced − 599,000 received)
 *  Final bags: p-1@wh-1 90.5 − 8 − 8 = 74.5 (0.6 damaged untouched)  p-1@wh-2 32 − 2 = 30  p-2@wh-1 52 − 1 − 1 = 50  p-3@wh-1 38
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "../../../packages/import/fixtures/synthetic-backup.json");

let h: Harness;
let owner: Session;
let backup: Backup;
const id = (store: string, legacyId: string) => uuidV5(`${store}:${legacyId}`);
const cust = (l: string) => id("customers", l);
const P1 = id("products", "p-1");
const P2 = id("products", "p-2");
const P3 = id("products", "p-3");
const WH1 = id("warehouses", "wh-1");
const WH2 = id("warehouses", "wh-2");

const made: Record<string, any> = {}; // step name -> the invoice as the API returned it (latest)

beforeAll(async () => {
  backup = JSON.parse(readFileSync(FIXTURE, "utf8"));
  await runImport(backup, { databaseUrl: TEST_ADMIN_URL, sourceName: "invoice-ledger-bridge" });
  h = await createHarness();
  owner = await h.session("OWNER");
});
afterAll(async () => {
  await h.close();
});

describe("invoice ledger bridge: import the fixture, operate through the API, mirror by hand, compare", () => {
  it("0. before any operation the imported fixture already has the hand-computed balances and bags", async () => {
    const before = { "cust-1": 1_900_000, "cust-2": 100_000, "cust-3": 470_000, "cust-4": 15_000, "cust-5": 450_000, "cust-6": 0 };
    for (const [l, p] of Object.entries(before)) expect(await customerBalanceSql(h.admin, cust(l)), l).toBe(p);
    expect(await levelOf(h, P1, WH1)).toBe(90_500);
    expect(await levelOf(h, P1, WH2)).toBe(32_000);
    expect(await levelOf(h, P2, WH1)).toBe(52_000);
    expect(await levelOf(h, P3, WH1)).toBe(38_000);
  });

  it("1. the scripted operations through the API", async () => {
    const ok = (r: { status: number; body: any }, want = [200, 201]) => {
      expect(want, JSON.stringify(r.body)).toContain(r.status);
      return r.body;
    };
    const line = (productId: string, quantity: number, unitPriceP: number, extra: object = {}) => ({ productId, quantity, unitPriceP, ...extra });

    // 1 & 2
    made.op1 = ok(await post(h, owner, invBody(cust("cust-4"), WH1, [line(P1, 5, 100_000, { discountP: 20_000 })], { freightP: 10_000, paidAmountP: 100_000 })));
    made.op2 = ok(await post(h, owner, invBody(cust("cust-6"), WH1, [line(P2, 2.5, 90_000)], { invoiceDiscountP: 5_000 })));
    expect([made.op1.number, made.op2.number]).toEqual(["INV-2026-000009", "INV-2026-000010"]); // the fixture's live counter (8) continues
    expect(made.op1.previousBalanceP).toBe(15_000);
    expect([made.op1.totalP, made.op2.totalP]).toEqual([490_000, 220_000]);
    // 3 & 4
    made.op1 = ok(await put(h, owner, made.op1.id, editBody(made.op1, { paidAmountP: 300_000 }, [{ id: made.op1.lines[0].id, productId: P1, quantity: 8, unitPriceP: 100_000, discountP: 20_000 }])));
    made.op2 = ok(await put(h, owner, made.op2.id, editBody(made.op2, {}, [{ id: made.op2.lines[0].id, productId: P2, quantity: 1, unitPriceP: 90_000 }])));
    expect([made.op1.totalP, made.op1.paidP, made.op2.totalP]).toEqual([790_000, 300_000, 85_000]);
    // 5 & 6
    made.op5 = ok(await post(h, owner, invBody(cust("cust-6"), WH1, [line(P3, 3, 80_000)])));
    expect(made.op5.number).toBe("INV-2026-000011");
    made.op5 = ok(await cancel(h, owner, made.op5.id, "entered twice"));
    // 7 & 8
    made.op2 = ok(await changeShop(h, owner, made.op2.id, cust("cust-4"), { reason: "wrong shop" }));
    made.op1 = ok(await changeShop(h, owner, made.op1.id, cust("cust-6")));
    expect(made.op1.receipts).toHaveLength(2); // both receipts went with it
    // 9
    const dup = ok(await duplicate(h, owner, made.op1.id));
    expect(dup).toMatchObject({ status: "DRAFT", customerId: cust("cust-6"), totalP: 790_000, paidP: 0 });
    made.op9 = ok(await put(h, owner, dup.id, editBody(dup)));
    expect(made.op9.number).toBe("INV-2026-000012");
    // 10 & 11
    made.op10 = ok(await post(h, owner, invBody(cust("cust-2"), WH1, [line(P1, 2, 100_000, { warehouseId: WH2 }), line(P2, 1, 90_000, { taxRatePct: 10 })], { paidAmountP: 299_000 })));
    expect(made.op10).toMatchObject({ number: "INV-2026-000013", totalP: 299_000, taxP: 9_000, status: "PAID" });
    made.op11 = ok(await post(h, owner, invBody(cust("cust-5"), WH1, [line(P1, 1, 100_000)], { mode: "draft" })));
    expect(made.op11.status).toBe("DRAFT");
  });

  it("2. hand-computed balances and bags straight from the database", async () => {
    const expected = { "cust-1": 1_900_000, "cust-2": 100_000, "cust-3": 470_000, "cust-4": 100_000, "cust-5": 450_000, "cust-6": 1_280_000 };
    for (const [l, p] of Object.entries(expected)) expect(await customerBalanceSql(h.admin, cust(l)), l).toBe(p);
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(2_935_000 + 1_964_000 - 599_000);
    // bags: every level equals the hand-computed figure AND the sum of its movements
    const finals: [string, string, number][] = [[P1, WH1, 74_500], [P1, WH2, 30_000], [P2, WH1, 50_000], [P3, WH1, 38_000]];
    for (const [p, w, q] of finals) {
      expect(await levelOf(h, p, w)).toBe(q);
      expect(await movementSum(h, p, w)).toBe(q);
    }
    const [dmg] = await h.admin`SELECT qty_milli::int AS q FROM stock_levels WHERE product_id = ${P1} AND warehouse_id = ${WH1} AND bucket = 'damaged'`;
    expect(dmg!.q).toBe(600);
  });

  it("3. cust-6's statement: the cancelled invoice is left out (both entries), the moved invoice and its receipts are on it", async () => {
    const s = statementSchema.parse((await h.request(owner, "GET", `/customers/${cust("cust-6")}/statement`)).body);
    expect(s.rows.map((r) => r.ref).sort()).toEqual(["INV-2026-000009", "INV-2026-000012", made.op1.receipts[0].receiptNumber, made.op1.receipts[1].receiptNumber].sort());
    expect(s.closing).toBe(1_280_000);
    expect(s.omittedCancelled).toBe(1);
    const c4 = statementSchema.parse((await h.request(owner, "GET", `/customers/${cust("cust-4")}/statement`)).body);
    expect(c4.rows.map((r) => r.ref)).toContain("INV-2026-000010"); // the moved one
    expect(c4.closing).toBe(100_000);
  });

  describe("4. the same operations applied BY HAND to the legacy-shaped JSON", () => {
    let legacy: Backup;
    beforeAll(() => {
      legacy = JSON.parse(JSON.stringify(backup));
      const d = legacy.data as Record<string, any[]>;
      const T = "2026-03-05T06:00:00.000Z";
      const invTemplate = d.invoices!.find((i) => i.id === "inv-1")!;
      const itemTemplate = d.invoiceItems!.find((i) => i.invoiceId === "inv-1")!;
      const payTemplate = d.payments!.find((p) => p.id === "pay-1")!;
      const running = new Map<string, number>();
      for (const m of d.stockMovements!) running.set(`${m.productId}|${m.warehouseId}|${m.bucket}`, Math.round(m.balanceAfter * 1000));

      /** An invoice document, its header worked out with plain integer arithmetic (never the shared Calc). */
      const invoice = (docId: string, no: string, customerId: string, status: string, lines: { p: string; wh: string; qty: number; unit: number; disc?: number; tax?: number }[], charges: { inv?: number; freight?: number } = {}, extra: object = {}) => {
        const subtotal = lines.reduce((a, l) => a + Math.round(l.unit * l.qty), 0);
        const itemDisc = lines.reduce((a, l) => a + (l.disc ?? 0), 0);
        const tax = lines.reduce((a, l) => a + (l.tax ?? 0), 0);
        const grand = subtotal - itemDisc - (charges.inv ?? 0) + tax + (charges.freight ?? 0);
        d.invoices!.push({
          ...invTemplate, id: docId, invoiceNumber: no, customerId, status, invoiceDate: "2026-03-05", dueDate: "2026-03-05", createdAt: T, updatedAt: T, confirmedAt: status === "DRAFT" ? null : T,
          subtotal, itemDiscounts: itemDisc, invoiceDiscount: charges.inv ?? 0, discountAmount: itemDisc + (charges.inv ?? 0), taxAmount: tax, freightAmount: charges.freight ?? 0,
          loadingAmount: 0, otherCharges: 0, grandTotal: grand, paidAmount: 0, balanceAmount: grand, totalQty: lines.reduce((a, l) => a + l.qty, 0), lineCount: lines.length,
          revision: 1, stockApplied: status !== "DRAFT", cancelledAt: null, cancelReason: "", warehouseId: "wh-1", previousBalance: 0, ...extra,
        });
        setLines(docId, lines);
      };
      const setLines = (docId: string, lines: { p: string; wh: string; qty: number; unit: number; disc?: number; tax?: number }[]) => {
        d.invoiceItems = d.invoiceItems!.filter((i) => i.invoiceId !== docId);
        lines.forEach((l, i) =>
          d.invoiceItems!.push({ ...itemTemplate, id: `ii-${docId}-${i}`, invoiceId: docId, sortOrder: i, productId: l.p, warehouseId: l.wh, quantity: l.qty, unitPrice: l.unit, discount: l.disc ?? 0, tax: l.tax ?? 0, lineTotal: Math.round(l.unit * l.qty) - (l.disc ?? 0) + (l.tax ?? 0), returnedQty: 0 }),
        );
      };
      const inv = (docId: string) => d.invoices!.find((i) => i.id === docId)!;
      const mv = (p: string, wh: string, kind: string, qty: number, refType: string, ref: string) => {
        const key = `${p}|${wh}|stock`;
        const next = (running.get(key) ?? 0) + Math.round(qty * 1000);
        running.set(key, next);
        d.stockMovements!.push({ ...d.stockMovements![0], id: `mv-new-${d.stockMovements!.length}`, createdAt: T, date: "2026-03-05", productId: p, warehouseId: wh, kind, qtyDelta: qty, bucket: "stock", balanceAfter: next / 1000, ref, refType, note: "", unitCostP: 0 });
      };
      const receipt = (docId: string, no: string, customerId: string, amount: number, invoiceDocId: string) => {
        d.payments!.push({ ...payTemplate, id: docId, receiptNumber: no, partyId: customerId, amount, paymentDate: "2026-03-05", createdAt: T, status: "POSTED", method: "Cash", reference: "", note: "", balanceBefore: 0, balanceAfter: 0 });
        d.paymentAllocations!.push({ id: `al-${docId}`, paymentId: docId, invoiceId: invoiceDocId, purchaseId: null, amount, createdAt: T });
      };

      // 1 & 3: INV-09, posted with 5 bags and 1,000 received; edited to 8 bags with 3,000 in all — the legacy reverses the old lines and deducts the new ones
      invoice("n1", "INV-2026-000009", "cust-4", "PARTIALLY_PAID", [{ p: "p-1", wh: "wh-1", qty: 5, unit: 100_000, disc: 20_000 }], { freight: 10_000 });
      mv("p-1", "wh-1", "SALE_OUT", -5, "INVOICE", "INV-2026-000009");
      receipt("r1", "REC-2026-000004", "cust-4", 100_000, "n1");
      setLines("n1", [{ p: "p-1", wh: "wh-1", qty: 8, unit: 100_000, disc: 20_000 }]);
      Object.assign(inv("n1"), { subtotal: 800_000, grandTotal: 790_000, balanceAmount: 490_000, totalQty: 8, revision: 2 });
      mv("p-1", "wh-1", "SALE_REVERSAL_IN", 5, "INVOICE_EDIT", "INV-2026-000009");
      mv("p-1", "wh-1", "SALE_OUT", -8, "INVOICE", "INV-2026-000009");
      receipt("r2", "REC-2026-000005", "cust-4", 200_000, "n1");
      // 2 & 4: INV-10, posted with 2.5 bags, edited down to 1
      invoice("n2", "INV-2026-000010", "cust-6", "CONFIRMED", [{ p: "p-2", wh: "wh-1", qty: 2.5, unit: 90_000 }], { inv: 5_000 });
      mv("p-2", "wh-1", "SALE_OUT", -2.5, "INVOICE", "INV-2026-000010");
      setLines("n2", [{ p: "p-2", wh: "wh-1", qty: 1, unit: 90_000 }]);
      Object.assign(inv("n2"), { subtotal: 90_000, grandTotal: 85_000, balanceAmount: 85_000, totalQty: 1, revision: 2 });
      mv("p-2", "wh-1", "SALE_REVERSAL_IN", 2.5, "INVOICE_EDIT", "INV-2026-000010");
      mv("p-2", "wh-1", "SALE_OUT", -1, "INVOICE", "INV-2026-000010");
      // 5 & 6: INV-11 posted then CANCELLED (Invoices.cancel: status flip, stock back, todayISO)
      invoice("n3", "INV-2026-000011", "cust-6", "CONFIRMED", [{ p: "p-3", wh: "wh-1", qty: 3, unit: 80_000 }]);
      mv("p-3", "wh-1", "SALE_OUT", -3, "INVOICE", "INV-2026-000011");
      Object.assign(inv("n3"), { status: "CANCELLED", stockApplied: false, cancelledAt: T, cancelReason: "entered twice" });
      mv("p-3", "wh-1", "SALE_REVERSAL_IN", 3, "INVOICE_CANCEL", "INV-2026-000011");
      // 7 & 8: Invoices.changeCustomer rewrites customerId; the wholly-applied receipts follow (partyId)
      inv("n2").customerId = "cust-4";
      inv("n1").customerId = "cust-6";
      for (const p of d.payments!.filter((x) => x.id === "r1" || x.id === "r2")) p.partyId = "cust-6";
      // 9: duplicate -> draft -> post (a new invoice, nothing paid)
      invoice("n4", "INV-2026-000012", "cust-6", "CONFIRMED", [{ p: "p-1", wh: "wh-1", qty: 8, unit: 100_000, disc: 20_000 }], { freight: 10_000 });
      mv("p-1", "wh-1", "SALE_OUT", -8, "INVOICE", "INV-2026-000012");
      // 10: two godowns, a 10% tax line (9,000), paid in full
      invoice("n5", "INV-2026-000013", "cust-2", "PAID", [{ p: "p-1", wh: "wh-2", qty: 2, unit: 100_000 }, { p: "p-2", wh: "wh-1", qty: 1, unit: 90_000, tax: 9_000 }]);
      mv("p-1", "wh-2", "SALE_OUT", -2, "INVOICE", "INV-2026-000013");
      mv("p-2", "wh-1", "SALE_OUT", -1, "INVOICE", "INV-2026-000013");
      receipt("r3", "REC-2026-000006", "cust-2", 299_000, "n5");
      // 11: a draft (no number, no stock, not in the ledger)
      invoice("n6", "", "cust-5", "DRAFT", [{ p: "p-1", wh: "wh-1", qty: 1, unit: 100_000 }], {}, { stockApplied: false });
      // the legacy inventory rows after all of it (bags)
      const inventory = (p: string, wh: string) => d.inventory!.find((r) => r.productId === p && r.warehouseId === wh)!;
      inventory("p-1", "wh-1").qty = 74.5;
      inventory("p-1", "wh-2").qty = 30;
      inventory("p-2", "wh-1").qty = 50;
      inventory("p-3", "wh-1").qty = 38;
      // the live counters
      d.sequences!.find((s) => s.id === "INV" || s.kind === "INV" || s.key === "INV" || JSON.stringify(s).includes('"INV"'))!.n = 13;
      const rec = d.sequences!.find((s) => JSON.stringify(s).includes('"REC"'))!;
      rec.n = 6;
      const counts = legacy.counts as Record<string, number>;
      for (const [store, docs] of Object.entries(d)) counts[store] = docs.length;
    });

    it("hand-computed expectations per shop on the legacy algorithm (paper arithmetic — neither implementation involved)", () => {
      const ledger = createLegacyLedger(legacy.data);
      const expected = { "cust-1": 1_900_000, "cust-2": 100_000, "cust-3": 470_000, "cust-4": 100_000, "cust-5": 450_000, "cust-6": 1_280_000 };
      for (const [l, p] of Object.entries(expected)) expect(ledger.customer(l).closing, `legacy ${l}`).toBe(p);
    });

    it("EVERY party: the old algorithm's balance == the new journal's balance", async () => {
      const ledger = createLegacyLedger(legacy.data);
      expect(ledger.customerIds).toHaveLength(6);
      for (const l of ledger.customerIds) expect(await customerBalanceSql(h.admin, cust(l)), `customer ${l}`).toBe(ledger.customer(l).closing);
      for (const l of ledger.supplierIds) expect(await supplierBalanceSql(h.admin, id("suppliers", l)), `supplier ${l}`).toBe(ledger.supplier(l).closing);
    });

    it("the trial balance is still zero, every entry balances, and each posted invoice has exactly one INVOICE entry (a cancelled one also one INVOICE_CANCEL)", async () => {
      const t = await trialBalance(h.admin);
      expect(t.debit).toBe(t.credit);
      expect(await h.admin`SELECT entry_id FROM journal_lines GROUP BY entry_id HAVING SUM(debit_p) <> SUM(credit_p)`).toHaveLength(0);
      for (const [name, inv] of Object.entries(made)) {
        const rows = await h.admin`SELECT source_type FROM journal_entries WHERE source_id = ${inv.id} ORDER BY source_type`;
        const want = name === "op11" ? [] : name === "op5" ? ["INVOICE", "INVOICE_CANCEL"] : ["INVOICE"];
        expect(rows.map((r) => r.source_type), name).toEqual(want);
      }
    });

    it("the REAL reconciliation, run on the post-S7 database against the hand-updated JSON: 0 differences in balances, statements, invoice totals, stock and invoice <-> stock", async () => {
      const report: ReconciliationReport = await reconcile(legacy, TEST_ADMIN_URL);
      expect(report.customers).toEqual({ compared: 6, differences: [] });
      expect(report.suppliers).toEqual({ compared: 5, differences: [] });
      expect(report.statements.mismatches).toEqual([]);
      expect(report.trialBalance.balanced).toBe(true);
      expect(report.invoices.totalMismatches).toEqual([]);
      expect(report.invoices.noLines).toEqual([]);
      expect(report.invoices.checked).toBe(7 + 5); // the fixture's 8 invoices minus its draft, plus the 5 posted / cancelled here (a draft is not checked)
      expect(report.stock.mismatches).toEqual([]);
      expect(report.invoiceStock.mismatches).toEqual([]);
      // The single deliberate difference from the legacy: an EDIT posts the DIFFERENCE (one movement) where the legacy reversed
      // every old line and deducted the new ones (two movements). 43 movement docs in the hand-updated JSON (the fixture's 32 + 11), 41 rows in the database.
      expect(report.counts.filter((c) => c.class === "imported" && !c.match).map((c) => [c.store, c.backup, c.loaded])).toEqual([["stockMovements", 43, 41]]);
      expect(report.failures).toHaveLength(1);
    });
  });
});

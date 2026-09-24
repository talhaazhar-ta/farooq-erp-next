import type { Backup } from "@farooq/import";
// The deterministic synthetic backups the API's S4 (payments) and S8 (invoices with lines) parity tests use (seeded; invented values only).
import { buildSyntheticBackup } from "../../api/test/helpers/synthetic-payments";
import { buildSyntheticInvoices } from "../../api/test/helpers/synthetic-invoices";

/**
 * The e2e dataset =
 *   - S8's seeded synthetic backup: 300 invoices WITH LINES, every status (draft, confirmed, partly paid, paid, cancelled,
 *     dispatched, partly returned), receipts (some reversed), credit notes, two godowns and the stock they moved;
 *   - S4's 300 payments (paging, search, facets, supplier payments, refunds, reversals) — re-numbered so the receipt numbers do
 *     not collide with the invoice receipts, and the ones that paid S4's own (lineless) invoices re-pointed at S8's invoices
 *     of the same shop, within what each still owes;
 *   - a few hand-made shops with known invoices, so the tests can assert exact figures (unchanged since S5).
 * All names and amounts are invented. Money is integer paisa.
 *
 *   Alpha   three unpaid invoices  Rs 10,000 / 20,000 / 30,000   (oldest first: auto-allocation)
 *   Beta    two unpaid invoices    Rs  5,000 /  5,000            (manual allocation)
 *   Gamma   one unpaid invoice     Rs  8,000, an Urdu shop name  (Urdu names on every screen)
 *   Delta / Echo / Foxtrot / Golf / Hotel / India / Juliet   shops with no invoices        (each test that changes money uses its own shop)
 *   Kilo / Lima / Mike / November / Oscar   the same, for the invoice specs (S9)
 */
export const SCENARIO = {
  alpha: { id: "e2e-cust-alpha", name: "E2E Alpha Store", invoices: [1_000_000, 2_000_000, 3_000_000] },
  beta: { id: "e2e-cust-beta", name: "E2E Beta Traders", invoices: [500_000, 500_000] },
  gamma: { id: "e2e-cust-gamma", name: "گاما ٹریڈرز E2E", invoices: [800_000] },
  delta: { id: "e2e-cust-delta", name: "E2E Delta Shop", invoices: [] },
  echo: { id: "e2e-cust-echo", name: "E2E Echo Shop", invoices: [] },
  foxtrot: { id: "e2e-cust-foxtrot", name: "E2E Foxtrot Shop", invoices: [] },
  golf: { id: "e2e-cust-golf", name: "E2E Golf Shop", invoices: [] },
  hotel: { id: "e2e-cust-hotel", name: "E2E Hotel Shop", invoices: [] },
  india: { id: "e2e-cust-india", name: "E2E India Shop", invoices: [] },
  juliet: { id: "e2e-cust-juliet", name: "E2E Juliet Shop", invoices: [] },
  // S9: shops the invoice specs post to / move between (each money-moving invoice test owns one, like S5's)
  kilo: { id: "e2e-cust-kilo", name: "E2E Kilo Shop", invoices: [] },
  lima: { id: "e2e-cust-lima", name: "E2E Lima Shop", invoices: [] },
  mike: { id: "e2e-cust-mike", name: "E2E Mike Shop", invoices: [] },
  november: { id: "e2e-cust-november", name: "E2E November Shop", invoices: [] },
  oscar: { id: "e2e-cust-oscar", name: "E2E Oscar Shop", invoices: [] },
  supplier: { id: "e2e-sup-mills", name: "E2E Supplier Mills", purchases: [5_000_000] },
} as const;

type Doc = Record<string, any>;

/** S8's invoices + S4's payments in one backup (see the header). Every shop's balance is still worked out from the same documents on both sides of the reconciliation. */
function mergedBase(): Backup {
  const backup = buildSyntheticInvoices();
  const data = backup.data as Record<string, Doc[]>;
  const s4 = buildSyntheticBackup({ payments: 300 }).data as Record<string, Doc[]>;
  const pad = (n: number) => String(n).padStart(6, "0");
  const seq = (kind: string) => (data.sequences!.find((x) => x.kind === kind)?.n as number | undefined) ?? 0;

  // receipts: S4's shop receipts continue the REC series after S8's; its payment vouchers (PV) are new to this dataset
  let rec = seq("REC");
  let pv = 0;
  const byOriginal = [...s4.payments!].sort((a, b) => (a.receiptNumber < b.receiptNumber ? -1 : 1));
  const renamed = new Map<string, string>();
  for (const p of byOriginal) renamed.set(p.id, p.direction === "IN" ? `REC-2026-${pad(++rec)}` : `PV-2026-${pad(++pv)}`);
  const payments: Doc[] = s4.payments!.map((p) => ({ ...p, receiptNumber: renamed.get(p.id)! }));
  const paymentById = new Map(payments.map((p) => [p.id, p]));

  // what each S8 invoice still owes after the receipts already on it (only POSTED receipts count)
  const owed = new Map<string, number>();
  const collectable = new Map<string, Doc[]>();
  for (const inv of data.invoices!) {
    if (inv.status === "DRAFT" || inv.status === "CANCELLED") continue;
    owed.set(inv.id, inv.grandTotal);
    (collectable.get(inv.customerId) ?? collectable.set(inv.customerId, []).get(inv.customerId)!).push(inv);
  }
  const posted = new Set(data.payments!.filter((p) => p.status === "POSTED").map((p) => p.id));
  for (const a of data.paymentAllocations!) if (a.invoiceId && posted.has(a.paymentId)) owed.set(a.invoiceId, (owed.get(a.invoiceId) ?? 0) - a.amount);

  const allocations = s4.paymentAllocations!.flatMap((a) => {
    if (!a.invoiceId) return [{ ...a, id: `s4-${a.id}` }]; // supplier payment → purchase: unchanged
    const pay = paymentById.get(a.paymentId)!;
    const invs = collectable.get(pay.partyId) ?? [];
    const inv = invs.find((i) => (owed.get(i.id) ?? 0) > 0);
    if (!inv) return []; // this shop has nothing left to collect: the receipt stays on account
    const take = Math.min(a.amount, owed.get(inv.id)!);
    if (pay.status === "POSTED") owed.set(inv.id, owed.get(inv.id)! - take);
    return [{ ...a, id: `s4-${a.id}`, invoiceId: inv.id, amount: take }];
  });

  const byEntry = (a: Doc, b: Doc) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
  data.payments = [...data.payments!, ...payments].sort(byEntry);
  data.paymentAllocations = [...data.paymentAllocations!, ...allocations].sort(byEntry);
  data.sequences = data.sequences!.filter((x) => x.kind !== "REC").concat([
    { k: "REC:2026", kind: "REC", year: 2026, n: rec, updatedAt: "2026-09-20T09:00:00.000Z" },
    { k: "PV:2026", kind: "PV", year: 2026, n: pv, updatedAt: "2026-09-20T09:00:00.000Z" },
  ]);
  return backup;
}

export function buildE2eBackup(): Backup {
  const backup = mergedBase();
  const data = backup.data as Record<string, Doc[]>;
  const customerTemplate = data.customers![0]!;
  const invoiceTemplate = data.invoices![0]!;
  const purchaseTemplate = data.purchases![0]!;
  const supplierTemplate = data.suppliers![0]!;
  const pad = (n: number) => String(n).padStart(6, "0");
  let invNo = 900_000;

  const shops = [SCENARIO.alpha, SCENARIO.beta, SCENARIO.gamma, SCENARIO.delta, SCENARIO.echo, SCENARIO.foxtrot, SCENARIO.golf, SCENARIO.hotel, SCENARIO.india, SCENARIO.juliet, SCENARIO.kilo, SCENARIO.lima, SCENARIO.mike, SCENARIO.november, SCENARIO.oscar];
  shops.forEach((s, i) => {
    data.customers!.push({
      ...customerTemplate,
      id: s.id,
      legacyCode: `E${pad(i + 1)}`,
      sh: s.name,
      ow: `Owner ${i + 1}`,
      nameUr: "",
      ph: `0300-555${String(i + 1).padStart(4, "0")}`,
      wa: "",
      region: "rg-drosh",
      isCashCounter: false,
      active: true,
    });
    s.invoices.forEach((grandTotal, k) => {
      const day = `2026-08-${String(1 + k * 9).padStart(2, "0")}`;
      data.invoices!.push({
        ...invoiceTemplate,
        id: `e2e-inv-${s.id}-${k + 1}`,
        invoiceNumber: `INV-2026-${pad(++invNo)}`,
        clientOpId: `op-e2e-inv-${s.id}-${k + 1}`,
        orderNumber: "",
        dispatchNumber: "",
        customerId: s.id,
        customerCodeSnapshot: `E${pad(i + 1)}`,
        customerNameSnapshot: `Owner ${i + 1}`,
        shopNameSnapshot: s.name,
        contactPersonSnapshot: `Owner ${i + 1}`,
        mobileSnapshot: `0300-555${String(i + 1).padStart(4, "0")}`,
        whatsappSnapshot: "",
        regionId: "rg-drosh",
        regionSnapshot: "دروش — Drosh",
        salesperson: "",
        invoiceDate: day,
        dueDate: day,
        subtotal: grandTotal,
        discountAmount: 0,
        itemDiscounts: 0,
        invoiceDiscount: 0,
        taxAmount: 0,
        freightAmount: 0,
        loadingAmount: 0,
        otherCharges: 0,
        grandTotal,
        paidAmount: 0,
        balanceAmount: grandTotal,
        paymentStatus: "UNPAID",
        paymentMethod: "",
        referenceNo: "",
        status: "CONFIRMED",
        notes: "",
        description: "",
        totalQty: 0,
        lineCount: 0,
        previousBalance: 0,
        revision: 1,
        createdAt: `${day}T05:00:00.000Z`,
        updatedAt: `${day}T05:00:00.000Z`,
        confirmedAt: `${day}T05:00:00.000Z`,
        cancelledAt: null,
        cancelReason: "",
        stockApplied: false,
      });
    });
  });

  data.suppliers!.push({ ...supplierTemplate, id: SCENARIO.supplier.id, legacyCode: "E-S01", co: SCENARIO.supplier.name, cp: "Mr Mills", ph: "0300-7770001", lo: "Peshawar", active: true });
  SCENARIO.supplier.purchases.forEach((grandTotal, k) => {
    data.purchases!.push({
      ...purchaseTemplate,
      id: `e2e-pur-${k + 1}`,
      purchaseNumber: `PUR-2026-${pad(900_001 + k)}`,
      supplierId: SCENARIO.supplier.id,
      purchaseDate: "2026-08-05",
      grandTotal,
      status: "RECEIVED",
      createdAt: "2026-08-05T06:00:00.000Z",
    });
  });

  const counts: Record<string, number> = {};
  for (const [store, docs] of Object.entries(data)) counts[store] = docs.length;
  (backup as Doc).counts = counts;
  return backup;
}

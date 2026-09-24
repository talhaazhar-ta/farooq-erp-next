import type { Backup } from "@farooq/import";
// The deterministic ~300-payment synthetic backup the API's S4 parity tests use (seeded; invented values only).
import { buildSyntheticBackup } from "../../api/test/helpers/synthetic-payments";

type Doc = Record<string, any>;

/**
 * The e2e dataset = S4's seeded 300-payment synthetic backup (paging, search, facets) PLUS a few hand-made shops with
 * known invoices, so the tests can assert exact figures. All names and amounts are invented. Money is integer paisa.
 *
 *   Alpha   three unpaid invoices  Rs 10,000 / 20,000 / 30,000   (oldest first: auto-allocation)
 *   Beta    two unpaid invoices    Rs  5,000 /  5,000            (manual allocation)
 *   Gamma   one unpaid invoice     Rs  8,000, an Urdu shop name  (Urdu names on every screen)
 *   Delta / Echo / Foxtrot / Golf / Hotel / India / Juliet   shops with no invoices        (each test that changes money uses its own shop)
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
  supplier: { id: "e2e-sup-mills", name: "E2E Supplier Mills", purchases: [5_000_000] },
} as const;

export function buildE2eBackup(): Backup {
  const backup = buildSyntheticBackup({ payments: 300 });
  const data = backup.data as Record<string, Doc[]>;
  const customerTemplate = data.customers![0]!;
  const invoiceTemplate = data.invoices![0]!;
  const purchaseTemplate = data.purchases![0]!;
  const supplierTemplate = data.suppliers![0]!;
  const pad = (n: number) => String(n).padStart(6, "0");
  let invNo = 900_000;

  const shops = [SCENARIO.alpha, SCENARIO.beta, SCENARIO.gamma, SCENARIO.delta, SCENARIO.echo, SCENARIO.foxtrot, SCENARIO.golf, SCENARIO.hotel, SCENARIO.india, SCENARIO.juliet];
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
        customerId: s.id,
        invoiceDate: day,
        grandTotal,
        status: "CONFIRMED",
        createdAt: `${day}T05:00:00.000Z`,
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

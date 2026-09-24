import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Backup } from "@farooq/import";

/**
 * A DETERMINISTIC synthetic legacy backup with ~300 payments — every direction, method and status, allocations to
 * invoices and purchases, Urdu and English names with the letter variants the legacy folding exists for, phone numbers
 * with and without dashes, references with hyphens / spaces / slashes, amounts with paisa, payments that tie on date and
 * entry time, shops RENAMED since their vouchers were made, and reversed vouchers with reasons. All values are invented;
 * it shares the committed fixture's envelope and its untouched stores. Seeded (mulberry32): the same data every run.
 */

type Doc = Record<string, any>;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_PATH = path.join(here, "../../../../packages/import/fixtures/synthetic-backup.json");

const REGIONS: [string, string, string][] = [
  ["rg-drosh", "دروش", "Drosh"],
  ["rg-barawal", "براول", "Barawal"],
  ["rg-dir", "دیر بازار", "Dir Bazar"],
  ["rg-sahib", "صاحب آباد", "Sahib Abad"],
  ["rg-kha", "خا گرام", "Kha Gram"],
  ["rg-upper", "اپر چترال", "Upper Chitral"],
  ["rg-lower", "لوئر چترال", "Lower Chitral"],
  ["rg-sher", "شیرنگل", "Sherangal"],
];

// Urdu words are spelled with the variants that must fold together (ک/ك, ی/ي, ہ/ه/ھ, آ/ا).
const URDU_WORDS = ["دکان", "کریم", "كريم", "ہاشم", "هاشم", "ھاشم", "اعظم", "زم زم", "زمزم", "جنرل اسٹور", "ٹریڈرز", "بسم اللہ", "فاروق", "یاسر", "ياسر", "نور", "آٹا", "اٹا", "منڈی"];
const EN_WORDS = ["Al Noor", "Bismillah", "Zam Zam", "Delta", "Karim", "Hashim", "Farooq", "Ali", "Ahmad", "Traders", "Store", "Kiryana", "General", "Mart", "Sons", "Brothers", "Enterprises"];
const OWNERS = ["Noor", "Haji Ali", "Ahmad", "Karim Khan", "فاروق", "حاجی نور", "Zahid", "Sher Ali", "کریم"];
const METHODS = ["Cash", "Bank Transfer", "Cheque", "JazzCash", "Easypaisa"];
const REFERENCES = ["CHQ-84711", "CHQ 99120", "TRX/7741", "txn 55-102", "JC-30044", "EP 88213", "ref-2026-77", "چیک 4471"];
const NOTES = ["advance eid", "Refund against invoice", "گاڑی کرایہ", "part payment", "settlement", "کچھ رقم واپس", "adjusted 50% discount", "note with, comma"];
const DESCRIPTIONS = ["HBL bank online", "نقد وصول", "cash at godown", "کرایہ"];
const RECEIVERS = ["Farooq", "Ali", "Accountant", "فاروق"];
const REVERSE_REASONS = ["wrong shop", "duplicate entry", "غلط دکان", "cheque bounced"];

export interface SyntheticOptions {
  seed?: number;
  payments?: number;
}

export function buildSyntheticBackup(opts: SyntheticOptions = {}): Backup {
  const rand = mulberry32(opts.seed ?? 20260924);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  const dateOf = (dayOfYear: number) => {
    const d = new Date(Date.UTC(2026, 0, 1 + dayOfYear));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };

  const base: Backup = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  const data = base.data as Record<string, Doc[]>;

  data.regions = REGIONS.map(([id, ur, en]) => ({ id, ur, en, active: true, routes: [] }));

  const shopName = () => {
    const words: string[] = [];
    const n = int(2, 3);
    const urdu = rand() < 0.45;
    for (let i = 0; i < n; i++) words.push(pick(urdu ? URDU_WORDS : EN_WORDS));
    return words.join(" ");
  };
  data.customers = Array.from({ length: 40 }, (_, i) => {
    const no = i + 1;
    const dashed = rand() < 0.5;
    const ph = `03${int(0, 4)}${int(0, 9)}${dashed ? "-" : ""}${pad(int(0, 9999999), 7)}`;
    const sh = shopName();
    return {
      id: `cust-${no}`, legacyCode: `C${pad(no, 3)}`, sh, ow: pick(OWNERS), nameUr: rand() < 0.3 ? pick(URDU_WORDS) : "", ph,
      wa: rand() < 0.3 ? ph.replace("-", "") : "", region: pick(REGIONS)[0], isCashCounter: false, active: true,
    };
  });
  data.suppliers = [
    ["Sunrise Flour Mills", "Mr Tariq", "0300-1112223", "Peshawar"], ["الفلاح ملز", "چوہدری کریم", "03451234567", "لاہور"],
    ["Zam Zam Sugar Mills", "", "0333-4445556", ""], ["Delta Agro", "Umar", "", "Karachi"], ["ہاشم ٹریڈرز", "ہاشم", "0301-7778889", "چترال"],
    ["Karim Rice Depot", "Karim", "0311-0001112", ""], ["Bismillah Oil Mills", "Anwar", "0322-9990001", "Gujranwala"],
  ].map(([co, cp, ph, lo], i) => ({ id: `sup-${i + 1}`, legacyCode: `S${pad(i + 1)}`, co, cp, ph, lo, nameUr: "", wa: "", active: true }));

  // Shops renamed since their vouchers were made: vouchers keep the OLD name (their snapshot), the shop record the new one.
  const renamed = new Map<string, string>();
  for (const i of [2, 7, 11, 19, 26, 33]) {
    const c = data.customers![i]!;
    renamed.set(c.id, c.sh);
    c.sh = `${pick(EN_WORDS)} ${pick(URDU_WORDS)} Renamed${i}`;
  }

  // Invoices and purchases: numbers to search by and to apply payments to.
  data.invoices = Array.from({ length: 90 }, (_, i) => {
    const day = int(0, 250);
    const status = pick(["CONFIRMED", "CONFIRMED", "CONFIRMED", "PARTIALLY_PAID", "PAID", "DISPATCHED", "DRAFT", "CANCELLED"] as const);
    const c = data.customers![int(0, 39)]!;
    return {
      id: `inv-${i + 1}`, invoiceNumber: status === "DRAFT" ? "" : `INV-2026-${pad(i + 1, 6)}`, customerId: c.id, invoiceDate: dateOf(day),
      grandTotal: int(50, 4000) * 1000, status, createdAt: `${dateOf(day)}T0${int(4, 9)}:${pad(int(0, 59))}:${pad(int(0, 59))}.${pad(int(0, 999), 3)}Z`,
    };
  });
  data.purchases = Array.from({ length: 24 }, (_, i) => {
    const day = int(0, 250);
    return {
      id: `pur-${i + 1}`, purchaseNumber: `PUR-2026-${pad(i + 1, 6)}`, supplierId: `sup-${int(1, 7)}`, purchaseDate: dateOf(day),
      grandTotal: int(100, 9000) * 1000, status: pick(["RECEIVED", "ORDERED", "CANCELLED"] as const), createdAt: `${dateOf(day)}T06:00:00.000Z`,
    };
  });

  // ~300 payments.
  const total = opts.payments ?? 300;
  const payments: Doc[] = [];
  const allocations: Doc[] = [];
  const counters = { REC: 0, PV: 0 };
  // a handful of dates crowded with same-time entries, so ties on (date, createdAt) fall to the receipt number
  const crowded = [dateOf(40), dateOf(120), dateOf(200)];
  for (let i = 0; i < total; i++) {
    const kindRoll = rand();
    const direction = kindRoll < 0.62 ? "IN" : "OUT";
    const partyType = direction === "IN" || kindRoll < 0.82 ? "CUSTOMER" : "SUPPLIER";
    const cust = partyType === "CUSTOMER" ? data.customers![int(0, 39)]! : null;
    const sup = partyType === "SUPPLIER" ? data.suppliers![int(0, 6)]! : null;
    const paymentDate = rand() < 0.15 ? pick(crowded) : dateOf(int(0, 260));
    const time = rand() < 0.15 ? "07:00:00.000" : `${pad(int(3, 15))}:${pad(int(0, 59))}:${pad(int(0, 59))}.${pad(int(0, 999), 3)}`;
    const receiptNumber = direction === "IN" ? `REC-2026-${pad(++counters.REC, 6)}` : `PV-2026-${pad(++counters.PV, 6)}`;
    const paisa = rand() < 0.3 ? int(1, 99) : 0;
    const amount = int(1, 900) * 500 + paisa; // whole 5-rupee steps, sometimes with paisa
    const status = rand() < 0.13 ? "REVERSED" : "POSTED";
    const p: Doc = {
      id: `pay-${i + 1}`, receiptNumber, direction, partyId: cust ? cust.id : sup!.id, partyType, isRefund: partyType === "CUSTOMER" && direction === "OUT",
      partyNameSnapshot: cust ? (renamed.get(cust.id) ?? cust.sh) : sup!.co, partyOwnerSnapshot: cust ? cust.ow : sup!.cp,
      regionSnapshot: cust ? (() => { const r = REGIONS.find((x) => x[0] === cust.region)!; return `${r[1]} — ${r[2]}`; })() : "",
      amount, method: pick(METHODS), reference: rand() < 0.55 ? pick(REFERENCES) : "", paymentDate, note: rand() < 0.3 ? pick(NOTES) : "",
      receivedBy: pick(RECEIVERS), status, createdAt: `${paymentDate}T${time}Z`, createdBy: "Fixture", balanceBefore: 0, balanceAfter: 0,
    };
    if (rand() < 0.25) p.description = pick(DESCRIPTIONS);
    if (status === "REVERSED") {
      p.reversedAt = `${paymentDate}T18:00:00.000Z`;
      p.reverseReason = pick(REVERSE_REASONS);
    }
    payments.push(p);

    // allocations: shop receipts to that shop's collectable invoices, some supplier payments to purchases
    if (direction === "IN" && rand() < 0.75) {
      const mine = data.invoices!.filter((v) => v.customerId === cust!.id && v.status !== "DRAFT" && v.status !== "CANCELLED");
      let left = amount;
      for (const inv of mine.slice(0, int(1, 3))) {
        const take = Math.min(left, Math.max(1, Math.floor(inv.grandTotal * (0.2 + rand() * 0.6))));
        if (take <= 0) break;
        left -= take;
        allocations.push({ id: `al-${allocations.length + 1}`, paymentId: p.id, invoiceId: inv.id, purchaseId: null, amount: take, createdAt: p.createdAt });
      }
    } else if (partyType === "SUPPLIER" && rand() < 0.5) {
      const mine = data.purchases!.filter((v) => v.supplierId === sup!.id && v.status !== "CANCELLED");
      if (mine.length) {
        const pur = pick(mine);
        allocations.push({ id: `al-${allocations.length + 1}`, paymentId: p.id, invoiceId: null, purchaseId: pur.id, amount: Math.min(amount, pur.grandTotal), createdAt: p.createdAt });
      }
    }
  }
  data.payments = payments;
  data.paymentAllocations = allocations;

  // stores the importer cross-checks against the parties above: none in this dataset
  for (const s of ["customerReturns", "supplierReturns", "accountAdjustments", "millingJobs", "invoiceItems", "inventory", "stockMovements", "operations"]) data[s] = [];
  data.sequences = [{ k: "REC:2026", kind: "REC", year: 2026, n: counters.REC, updatedAt: "2026-09-20T09:00:00.000Z" }, { k: "PV:2026", kind: "PV", year: 2026, n: counters.PV, updatedAt: "2026-09-20T09:00:00.000Z" }];

  const counts: Record<string, number> = {};
  for (const [store, docs] of Object.entries(data)) counts[store] = docs.length;
  (base as Doc).counts = counts;
  return base;
}

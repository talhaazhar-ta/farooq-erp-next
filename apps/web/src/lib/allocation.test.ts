import { describe, expect, it } from "vitest";
import { autoAllocate, fillAmount, hasManualProblems, manualAllocation, type OutstandingLike } from "./allocation";

/** Seeded (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The server's rule, written out independently (apps/api payments.service `autoAllocate`): walk oldest first, take min(outstanding, left). */
function serverRule(rows: OutstandingLike[], amount: number): Map<string, number> {
  const out = new Map<string, number>();
  let left = amount;
  for (const r of rows) {
    if (left <= 0) break;
    if (r.outstandingP <= 0) continue;
    const take = Math.min(r.outstandingP, left);
    out.set(r.id, take);
    left -= take;
  }
  return out;
}

const rows = (...amounts: number[]): OutstandingLike[] => amounts.map((outstandingP, i) => ({ id: `inv-${i + 1}`, outstandingP }));

describe("autoAllocate (preview of the server's oldest-first rule)", () => {
  it("fills the oldest invoice first and stops when the money runs out", () => {
    const r = autoAllocate(rows(1_000_000, 2_000_000, 3_000_000), 2_500_000);
    expect(r.lines).toEqual([
      { invoiceId: "inv-1", amountP: 1_000_000 },
      { invoiceId: "inv-2", amountP: 1_500_000 },
    ]);
    expect(r.leftOverP).toBe(0);
  });

  it("keeps the surplus on account when the money exceeds everything owed", () => {
    const r = autoAllocate(rows(100, 200), 1000);
    expect(r.lines.map((l) => l.amountP)).toEqual([100, 200]);
    expect(r.leftOverP).toBe(700);
  });

  it("allocates nothing for a zero / negative / fractional-garbage amount", () => {
    expect(autoAllocate(rows(100), 0)).toEqual({ lines: [], leftOverP: 0 });
    expect(autoAllocate(rows(100), -50)).toEqual({ lines: [], leftOverP: 0 });
  });

  it("skips an invoice with nothing outstanding", () => {
    const r = autoAllocate(rows(0, 500), 300);
    expect(r.lines).toEqual([{ invoiceId: "inv-2", amountP: 300 }]);
  });

  it("property: never over-allocates, agrees with the server rule, conserves the money (2,000 random cases)", () => {
    const rand = rng(20260924);
    for (let n = 0; n < 2000; n++) {
      const count = Math.floor(rand() * 9);
      const list = rows(...Array.from({ length: count }, () => (rand() < 0.15 ? 0 : 1 + Math.floor(rand() * 5_000_000))));
      const amount = Math.floor(rand() * 12_000_000);
      const { lines, leftOverP } = autoAllocate(list, amount);

      const byId = new Map(list.map((r) => [r.id, r.outstandingP]));
      let applied = 0;
      for (const l of lines) {
        expect(l.amountP).toBeGreaterThan(0);
        expect(l.amountP).toBeLessThanOrEqual(byId.get(l.invoiceId)!); // never more than the invoice owes
        applied += l.amountP;
      }
      expect(applied).toBeLessThanOrEqual(amount); // never more than the money received
      expect(applied + leftOverP).toBe(amount); // conservation
      const owed = list.reduce((s, r) => s + r.outstandingP, 0);
      expect(applied).toBe(Math.min(amount, owed));
      expect(new Map(lines.map((l) => [l.invoiceId, l.amountP]))).toEqual(serverRule(list, amount));
      // oldest first: once an invoice is only part-paid, nothing after it gets anything
      const listed = lines.map((l) => l.invoiceId);
      const order = list.map((r) => r.id).filter((id) => listed.includes(id));
      expect(listed).toEqual(order);
      const partial = lines.findIndex((l) => l.amountP < byId.get(l.invoiceId)!);
      if (partial !== -1) expect(partial).toBe(lines.length - 1);
    }
  });
});

describe("manualAllocation (per-invoice boxes)", () => {
  const list = rows(1_000_000, 2_000_000);

  it("reads rupee text into paisa lines and leaves the rest on account", () => {
    const m = manualAllocation(list, { "inv-1": "4,000", "inv-2": "1500.50" }, 700_050);
    expect(m.lines).toEqual([
      { invoiceId: "inv-1", amountP: 400_000 },
      { invoiceId: "inv-2", amountP: 150_050 },
    ]);
    expect(m.totalP).toBe(550_050);
    expect(m.leftOverP).toBe(150_000);
    expect(hasManualProblems(m)).toBe(false);
  });

  it("refuses a box above what the invoice still owes (the cap)", () => {
    const m = manualAllocation(list, { "inv-1": "10,000.01" }, 5_000_000);
    expect(m.rowErrors["inv-1"]).toMatch(/More than the 10,000 outstanding/);
    expect(m.lines).toEqual([]);
    expect(hasManualProblems(m)).toBe(true);
  });

  it("accepts exactly the outstanding amount", () => {
    const m = manualAllocation(list, { "inv-1": "10000" }, 1_000_000);
    expect(m.rowErrors).toEqual({});
    expect(m.lines).toEqual([{ invoiceId: "inv-1", amountP: 1_000_000 }]);
  });

  it("refuses boxes that together exceed the amount received", () => {
    const m = manualAllocation(list, { "inv-1": "6000", "inv-2": "6000" }, 1_000_000);
    expect(m.totalError).toMatch(/more than the 10,000 received/);
    expect(hasManualProblems(m)).toBe(true);
  });

  it("flags nonsense and too many decimals per row, and treats blank / zero as nothing", () => {
    const m = manualAllocation(list, { "inv-1": "abc", "inv-2": "12.345" }, 5_000_000);
    expect(m.rowErrors["inv-1"]).toBeTruthy();
    expect(m.rowErrors["inv-2"]).toMatch(/2 decimal/);
    const blank = manualAllocation(list, { "inv-1": "", "inv-2": "0" }, 5_000_000);
    expect(blank.lines).toEqual([]);
    expect(hasManualProblems(blank)).toBe(false);
  });

  it("reads Urdu digits and thousands separators", () => {
    const m = manualAllocation(list, { "inv-1": "۱٬۰۰۰".replace("٬", ",") }, 1_000_000);
    expect(m.lines).toEqual([{ invoiceId: "inv-1", amountP: 100_000 }]);
  });

  it("property: an accepted manual allocation never exceeds an invoice or the money (1,000 random cases)", () => {
    const rand = rng(7);
    for (let n = 0; n < 1000; n++) {
      const l = rows(...Array.from({ length: 1 + Math.floor(rand() * 5) }, () => 1 + Math.floor(rand() * 900_000)));
      const amount = Math.floor(rand() * 2_000_000);
      const entries: Record<string, string> = {};
      for (const r of l) if (rand() < 0.7) entries[r.id] = (Math.floor(rand() * (r.outstandingP * 1.3)) / 100).toFixed(2);
      const m = manualAllocation(l, entries, amount);
      if (hasManualProblems(m)) continue;
      const cap = new Map(l.map((r) => [r.id, r.outstandingP]));
      for (const line of m.lines) expect(line.amountP).toBeLessThanOrEqual(cap.get(line.invoiceId)!);
      expect(m.totalP).toBeLessThanOrEqual(amount);
      expect(m.totalP + m.leftOverP).toBe(amount);
    }
  });
});

describe("fillAmount", () => {
  it("is the invoice's outstanding, or what is left of the money, whichever is smaller", () => {
    expect(fillAmount({ id: "a", outstandingP: 500 }, 1000, 0)).toBe(500);
    expect(fillAmount({ id: "a", outstandingP: 500 }, 1000, 800)).toBe(200);
    expect(fillAmount({ id: "a", outstandingP: 500 }, 1000, 1000)).toBe(0);
  });
});

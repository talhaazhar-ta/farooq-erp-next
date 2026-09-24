import { describe, expect, it } from "vitest";
import { cancelEffect, invoiceTitle, postedReceipts, shopMoveFigures } from "./invoice-view";

const receipt = (allocatedP: number, status: "POSTED" | "REVERSED" = "POSTED") => ({
  paymentId: "11111111-1111-4111-8111-111111111111",
  receiptNumber: "REC-1",
  date: "2026-09-01",
  method: null,
  reference: null,
  allocatedP,
  status,
});

describe("Change shop: the legacy before / after arithmetic (invoice total less what moves with it)", () => {
  it("an unpaid invoice: the old shop goes down by the whole total, the new one up by it", () => {
    const g = shopMoveFigures({ totalP: 1_000_000, receipts: [] }, 3_500_000, 200_000);
    expect(g.netP).toBe(1_000_000);
    expect(g.oldBalanceNowP).toBe(3_500_000);
    expect(g.oldBalanceAfterP).toBe(2_500_000);
    expect(g.newBalanceNowP).toBe(200_000);
    expect(g.newBalanceAfterP).toBe(1_200_000);
  });

  it("a receipt taken with the invoice moves with it: only the unpaid part changes hands", () => {
    const g = shopMoveFigures({ totalP: 1_000_000, receipts: [receipt(400_000)] }, 2_000_000, 0);
    expect(g.netP).toBe(600_000);
    expect(g.oldBalanceAfterP).toBe(1_400_000);
    expect(g.newBalanceAfterP).toBe(600_000);
  });

  it("a REVERSED receipt no longer counts (it does not move)", () => {
    const g = shopMoveFigures({ totalP: 500_000, receipts: [receipt(500_000, "REVERSED")] }, 500_000, 0);
    expect(g.netP).toBe(500_000);
    expect(g.oldBalanceAfterP).toBe(0);
  });

  it("a fully paid invoice moves nothing on either balance", () => {
    const g = shopMoveFigures({ totalP: 700_000, receipts: [receipt(300_000), receipt(400_000)] }, 90_000, -10_000);
    expect(g.netP).toBe(0);
    expect(g.oldBalanceAfterP).toBe(90_000);
    expect(g.newBalanceAfterP).toBe(-10_000);
  });

  it("no shop chosen yet → no 'after' for it", () => {
    const g = shopMoveFigures({ totalP: 100, receipts: [] }, 100, null);
    expect(g.newBalanceNowP).toBeNull();
    expect(g.newBalanceAfterP).toBeNull();
  });

  it("only POSTED receipts are picked out", () => {
    expect(postedReceipts({ receipts: [receipt(1), receipt(2, "REVERSED"), receipt(3)] }).map((r) => r.allocatedP)).toEqual([1, 3]);
  });
});

describe("the words a correction shows before it happens", () => {
  it("cancelling a posted invoice: bags come back, the balance goes down, a reason is kept", () => {
    const text = cancelEffect({ status: "CONFIRMED", number: "INV-2026-000001", totalP: 2_742_500, totalQuantity: 30 }).join(" ");
    expect(text).toMatch(/bags come back into stock/);
    expect(text).toContain("30");
    expect(text).toContain("PKR 27,425");
    expect(text).toMatch(/goes down by/);
    expect(text).toMatch(/marked Cancelled, with your reason/);
  });
  it("discarding a draft: nothing else changes", () => {
    const text = cancelEffect({ status: "DRAFT", number: null, totalP: 100, totalQuantity: 1 }).join(" ");
    expect(text).toMatch(/no number, no stock and no account entry/);
    expect(text).not.toMatch(/come back into stock/);
  });
  it("a draft is titled 'Draft', not a blank", () => {
    expect(invoiceTitle(null)).toBe("Draft");
    expect(invoiceTitle("INV-2026-000005")).toBe("INV-2026-000005");
  });
});

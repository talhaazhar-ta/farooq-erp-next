import { isValidBusinessDate } from "@farooq/shared";
import { isPeriodKey, periodRange } from "./periods";

/** The statement screen's state, kept in the address (`/statements?type=customer&partyId=…&from=…&to=…`). */
export interface StatementFilters {
  type: "customer" | "supplier";
  partyId: string;
  /** Customers only: narrows the shop picker. */
  region: string;
  period: string;
  from: string;
  to: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

export function statementSearchFrom(raw: Record<string, unknown>): StatementFilters {
  const from = str(raw.from);
  const to = str(raw.to);
  const period = isPeriodKey(str(raw.period)) ? str(raw.period) : from || to ? "custom" : "all";
  return {
    type: str(raw.type) === "supplier" ? "supplier" : "customer",
    partyId: UUID.test(str(raw.partyId)) ? str(raw.partyId) : "",
    region: UUID.test(str(raw.region)) ? str(raw.region) : "",
    period,
    from: period === "custom" && isValidBusinessDate(from) ? from : "",
    to: period === "custom" && isValidBusinessDate(to) ? to : "",
  };
}

export function statementSearchOut(f: StatementFilters): Record<string, string> {
  const out: Record<string, string> = { type: f.type };
  if (f.partyId) out.partyId = f.partyId;
  if (f.type === "customer" && f.region) out.region = f.region;
  if (f.period !== "all") out.period = f.period;
  if (f.period === "custom") {
    if (f.from) out.from = f.from;
    if (f.to) out.to = f.to;
  }
  return out;
}

/** The date window the request asks for ("" = open on that side). */
export function statementWindow(f: StatementFilters, today: string): { from: string; to: string } {
  if (f.period === "custom") return { from: f.from, to: f.to };
  if (f.period === "all") return { from: "", to: "" };
  const [from, to] = periodRange(f.period, today);
  return { from: from ?? "", to: to ?? "" };
}

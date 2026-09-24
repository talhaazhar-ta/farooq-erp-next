import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { canReadInvoices, canReadPayments, notAvailableTitle } from "../lib/access";
import { NotAvailable } from "./ui";

/** Renders its children only for a role that may read payments; anyone else gets the "not available" panel (never a blank page or a raw 403). */
export function RequirePaymentsAccess({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!canReadPayments(user.role)) {
    return <NotAvailable title={notAvailableTitle(user.role)}>Payments and statements hold the shops’ and suppliers’ money. Ask the owner, a manager or the accountant.</NotAvailable>;
  }
  return <>{children}</>;
}

/** Same for invoices: the warehouse role holds none of the permissions that read them. */
export function RequireInvoicesAccess({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!user) return null;
  if (!canReadInvoices(user.role)) {
    return <NotAvailable title={notAvailableTitle(user.role)}>Invoices hold the shops’ sales and balances. Ask the owner, a manager, the accountant or a salesperson.</NotAvailable>;
  }
  return <>{children}</>;
}

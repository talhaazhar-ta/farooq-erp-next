import type { ReactNode } from "react";
import { useAuth } from "../lib/auth";
import { canReadPayments, notAvailableTitle } from "../lib/access";
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

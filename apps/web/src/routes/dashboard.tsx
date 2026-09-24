import { Link } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { canReadPayments } from "../lib/access";

export function DashboardPage() {
  const { user } = useAuth();
  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-6">
      <h1 className="text-base font-semibold text-(--color-text)">Welcome{user ? `, ${user.name}` : ""}</h1>
      <p className="mt-2 text-sm text-(--color-text-muted)">
        Payments and account statements are ready. Other modules land in later releases.
      </p>
      {user && canReadPayments(user.role) ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <Link to="/payments" className="rounded-md bg-(--color-primary) px-3.5 py-2 text-sm font-medium text-(--color-primary-fg)">
            Open Payments
          </Link>
          <Link to="/statements" className="rounded-md border border-(--color-border) px-3.5 py-2 text-sm font-medium text-(--color-text)">
            Account statements
          </Link>
        </div>
      ) : null}
    </div>
  );
}

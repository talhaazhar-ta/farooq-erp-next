import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";
import { ROLE_LABELS } from "@farooq/shared";

const NAV_ITEMS = [
  { label: "Dashboard", href: "#" },
  { label: "Collection", href: "#" },
  { label: "Customers", href: "#" },
  { label: "Suppliers", href: "#" },
  { label: "Payments", href: "#" },
  { label: "Reports", href: "#" },
];

type Theme = "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("theme") as Theme) ?? "light";
    } catch {
      return "light";
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {
      // ignore (private browsing etc.)
    }
  }, [theme]);

  return [theme, setThemeState];
}

export function AuthenticatedShell({ children }: { children: ReactNode }) {
  const { user, isLoading, logout } = useAuth();
  const [theme, setTheme] = useTheme();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-(--color-text-muted)">Loading…</div>
    );
  }
  if (!user) return <Navigate to="/sign-in" />;

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r border-(--color-border) bg-(--color-surface) p-4 sm:block">
        <div className="mb-6 text-sm font-semibold text-(--color-text)">Farooq &amp; Co Traders</div>
        <nav className="space-y-1">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="block rounded-md px-3 py-2 text-sm text-(--color-text-muted) hover:bg-(--color-bg) hover:text-(--color-text)"
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>

      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface) px-4 py-3">
          <span className="text-sm text-(--color-text-muted)">Authenticated shell</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              className="rounded-md border border-(--color-border) px-2 py-1 text-xs text-(--color-text)"
            >
              {theme === "light" ? "Dark mode" : "Light mode"}
            </button>
            <div className="flex items-center gap-2 rounded-full border border-(--color-border) py-1 pl-1 pr-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-(--color-primary) text-xs font-semibold text-(--color-primary-fg)">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="text-sm text-(--color-text)">{user.name}</span>
              <span className="text-xs text-(--color-text-muted)">· {ROLE_LABELS[user.role]}</span>
            </div>
            <button
              type="button"
              onClick={() => logout()}
              className="rounded-md border border-(--color-border) px-2 py-1 text-xs text-(--color-text)"
            >
              Sign out
            </button>
          </div>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}

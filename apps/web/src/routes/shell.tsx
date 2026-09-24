import { useEffect, useState } from "react";
import { Link, Navigate, Outlet } from "@tanstack/react-router";
import { ROLE_LABELS } from "@farooq/shared";
import { useAuth } from "../lib/auth";
import { visibleNav, type NavItem } from "../lib/access";
import { cn } from "../components/ui";

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

const linkBase = "block whitespace-nowrap rounded-md px-3 py-2 text-sm";

function NavEntry({ item, mobile }: { item: NavItem; mobile?: boolean }) {
  if (item.to === null) {
    // a module that does not exist yet: visibly disabled, not a dead link
    return (
      <span aria-disabled="true" title="Coming in a later release" className={cn(linkBase, "cursor-not-allowed text-(--color-text-muted) opacity-60")}>
        {item.label}
        <span className="ml-2 rounded-full border border-(--color-border) px-1.5 py-0.5 text-[10px] uppercase tracking-wide">Soon</span>
      </span>
    );
  }
  return (
    <Link
      to={item.to}
      activeOptions={{ exact: item.to === "/" }}
      className={cn(linkBase, "text-(--color-text-muted) hover:bg-(--color-bg) hover:text-(--color-text)", mobile && "border border-transparent")}
      activeProps={{ className: "bg-(--color-bg) font-medium !text-(--color-text)", "aria-current": "page" }}
    >
      {item.label}
    </Link>
  );
}

export function AuthenticatedShell() {
  const { user, isLoading, logout } = useAuth();
  const [theme, setTheme] = useTheme();

  if (isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-(--color-text-muted)">Loading…</div>;
  }
  if (!user) return <Navigate to="/sign-in" />;

  const nav = visibleNav(user.role);

  return (
    <div className="flex min-h-screen">
      <aside className="no-print hidden w-56 shrink-0 border-r border-(--color-border) bg-(--color-surface) p-4 sm:block print:hidden">
        <div className="mb-6 text-sm font-semibold text-(--color-text)">Farooq &amp; Co Traders</div>
        <nav aria-label="Main" className="space-y-1">
          {nav.map((item) => (
            <NavEntry key={item.label} item={item} />
          ))}
        </nav>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col">
        <header className="no-print border-b border-(--color-border) bg-(--color-surface) px-3 py-2.5 sm:px-4 print:hidden">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-semibold text-(--color-text) sm:hidden">Farooq &amp; Co Traders</span>
            <span className="hidden text-sm text-(--color-text-muted) sm:inline">Farooq &amp; Co Traders ERP</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTheme(theme === "light" ? "dark" : "light")}
                className="rounded-md border border-(--color-border) px-2 py-1 text-xs text-(--color-text)"
              >
                {theme === "light" ? "Dark mode" : "Light mode"}
              </button>
              <div className="flex items-center gap-2 rounded-full border border-(--color-border) py-1 pl-1 pr-2 sm:pr-3" title={`${user.name} · ${ROLE_LABELS[user.role]}`}>
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-(--color-primary) text-xs font-semibold text-(--color-primary-fg)">
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="hidden text-sm text-(--color-text) sm:inline" data-testid="user-name">
                  {user.name}
                </span>
                <span className="text-xs text-(--color-text-muted)" data-testid="user-role">
                  <span className="hidden sm:inline">· </span>
                  {ROLE_LABELS[user.role]}
                </span>
              </div>
              <button
                type="button"
                onClick={() => logout()}
                className="rounded-md border border-(--color-border) px-2 py-1 text-xs text-(--color-text)"
              >
                Sign out
              </button>
            </div>
          </div>
          <nav aria-label="Main (compact)" className="-mx-1 mt-2 flex gap-1 overflow-x-auto pb-1 sm:hidden">
            {nav.map((item) => (
              <NavEntry key={item.label} item={item} mobile />
            ))}
          </nav>
        </header>

        <main className="min-w-0 flex-1 p-3 sm:p-6 print:p-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

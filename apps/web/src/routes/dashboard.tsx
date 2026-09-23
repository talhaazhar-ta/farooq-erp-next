export function DashboardPage() {
  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) p-6">
      <h2 className="text-base font-semibold text-(--color-text)">Welcome</h2>
      <p className="mt-2 text-sm text-(--color-text-muted)">
        Signed in. This is the empty authenticated shell — business screens land in later sessions (S2+).
      </p>
    </div>
  );
}

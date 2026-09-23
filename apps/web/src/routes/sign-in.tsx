import { useState, type FormEvent } from "react";
import { Navigate } from "@tanstack/react-router";
import { useAuth } from "../lib/auth";

export function SignInPage() {
  const { user, login, loginError, isLoading } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!isLoading && user) return <Navigate to="/" />;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await login(username, password);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-(--color-bg) px-4">
      <div className="w-full max-w-sm rounded-xl border border-(--color-border) bg-(--color-surface) p-8 shadow-sm">
        <h1 className="text-lg font-semibold text-(--color-text)">Farooq &amp; Co Traders</h1>
        <p className="mt-1 text-sm text-(--color-text-muted)">Sign in to the ERP</p>

        <form method="post" onSubmit={handleSubmit} className="mt-6 space-y-4">
          <div>
            <label htmlFor="username" className="mb-1 block text-sm font-medium text-(--color-text)">
              Username
            </label>
            <input
              id="username"
              name="username"
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-md border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm text-(--color-text) outline-none focus:border-(--color-primary)"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-(--color-text)">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm text-(--color-text) outline-none focus:border-(--color-primary)"
            />
          </div>

          {loginError && <p className="text-sm text-(--color-danger)">{loginError}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-(--color-primary) px-3 py-2 text-sm font-medium text-(--color-primary-fg) disabled:opacity-60"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}

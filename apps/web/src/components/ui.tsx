import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { ApiError } from "../lib/api";

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

/* ── buttons & fields ─────────────────────────────────────────────────── */

type Variant = "primary" | "secondary" | "danger" | "ghost";
const VARIANTS: Record<Variant, string> = {
  primary: "bg-(--color-primary) text-(--color-primary-fg) hover:opacity-90",
  secondary: "border border-(--color-border) bg-(--color-surface) text-(--color-text) hover:bg-(--color-bg)",
  danger: "bg-(--color-danger) text-white hover:opacity-90",
  ghost: "text-(--color-text-muted) hover:bg-(--color-bg) hover:text-(--color-text)",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type={type}
      {...rest}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm",
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export const inputClass =
  "w-full rounded-md border border-(--color-border) bg-(--color-bg) px-3 py-2 text-sm text-(--color-text) placeholder:text-(--color-text-muted) disabled:opacity-60";

/** A label tied to its control by nesting (works with any control, including a custom combobox). The hint / error sit OUTSIDE the label, so they never become part of the control's accessible name. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null | undefined; children: ReactNode; className?: string }) {
  return (
    <div className={cn("text-sm", className)}>
      <label className="block">
        <span className="mb-1 block font-medium text-(--color-text)">{label}</span>
        {children}
      </label>
      {hint && !error ? <span className="mt-1 block text-xs text-(--color-text-muted)">{hint}</span> : null}
      {error ? (
        <span role="alert" className="mt-1 block text-xs text-(--color-danger)">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A small labelled `<select>` for a filter bar. */
export function LabeledSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  return (
    <label className="flex flex-col text-xs text-(--color-text-muted)">
      {label}
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={cn(inputClass, "mt-0.5 w-auto")}>
        {children}
      </select>
    </label>
  );
}

/* ── banners, badges, empty states ────────────────────────────────────── */

type Tone = "info" | "warn" | "error" | "success";
const TONES: Record<Tone, string> = {
  info: "border-(--color-border) bg-(--color-info-bg) text-(--color-text)",
  warn: "border-(--color-warn-border) bg-(--color-warn-bg) text-(--color-text)",
  error: "border-(--color-danger) bg-(--color-danger-bg) text-(--color-text)",
  success: "border-(--color-ok) bg-(--color-ok-bg) text-(--color-text)",
};

export function Banner({ tone = "info", title, children, className, role, ...rest }: { tone?: Tone; title?: string; children?: ReactNode; className?: string; role?: string; "data-testid"?: string }) {
  return (
    <div role={role ?? (tone === "error" ? "alert" : undefined)} {...rest} className={cn("rounded-lg border px-3.5 py-2.5 text-sm", TONES[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={title ? "mt-0.5" : ""}>{children}</div> : null}
    </div>
  );
}

/** A titled panel of a builder screen (invoice and purchase builders). */
export function Card({ title, aside, children, testId }: { title: string; aside?: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <section className="rounded-xl border border-(--color-border) bg-(--color-surface)" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--color-border) px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Badge({ tone = "neutral", children }: { tone?: "neutral" | "ok" | "warn" | "danger"; children: ReactNode }) {
  const tones = {
    neutral: "bg-(--color-bg) text-(--color-text-muted) border-(--color-border)",
    ok: "bg-(--color-ok-bg) text-(--color-ok) border-(--color-ok)",
    warn: "bg-(--color-warn-bg) text-(--color-text) border-(--color-warn-border)",
    danger: "bg-(--color-danger-bg) text-(--color-danger) border-(--color-danger)",
  } as const;
  return <span className={cn("inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p role="status" className="py-8 text-center text-sm text-(--color-text-muted)">
      {label}
    </p>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-(--color-border) px-4 py-10 text-center">
      <p className="text-sm font-semibold text-(--color-text)">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-(--color-text-muted)">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/**
 * The server's refusal, verbatim. A 422 carries `errors[]` (allocation problems come as several lines) — every line is
 * shown, not just the first. A network failure gets a retry button.
 */
export function ErrorLines({ error, onRetry, title }: { error: unknown; onRetry?: (() => void) | undefined; title?: string }) {
  if (!error) return null;
  const api = error instanceof ApiError ? error : null;
  const lines = api ? api.lines : [error instanceof Error ? error.message : "Something went wrong."];
  return (
    <Banner tone="error" title={title} data-testid="error-lines">
      {lines.length === 1 ? (
        <p>{lines[0]}</p>
      ) : (
        <ul className="list-disc space-y-0.5 pl-5">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {onRetry && (api?.isNetwork ?? false) ? (
        <Button size="sm" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Banner>
  );
}

/** Shown instead of a screen the signed-in role cannot use (never a blank page or a raw 403). */
export function NotAvailable({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-(--color-warn-border) bg-(--color-warn-bg) p-6" data-testid="not-available">
      <h2 className="text-base font-semibold text-(--color-text)">{title}</h2>
      <p className="mt-1 text-sm text-(--color-text-muted)">{children ?? "Ask the owner, a manager or the accountant if you need this."}</p>
    </div>
  );
}

/* ── dialog (native <dialog>: focus trap, Esc, inert page — free and accessible) ───────────────── */

export function Dialog({ open, onClose, title, description, children, wide = false }: { open: boolean; onClose: () => void; title: string; description?: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      if (typeof el.showModal === "function") el.showModal();
      else el.setAttribute("open", "");
    }
    if (!open && el.open) {
      if (typeof el.close === "function") el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  if (!open) return null;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={() => onClose()}
      className={cn(
        "m-auto max-h-[92vh] w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-(--color-border) bg-(--color-surface) p-0 text-(--color-text) shadow-xl backdrop:bg-black/50",
        wide ? "max-w-3xl" : "max-w-lg",
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-(--color-border) px-5 py-4">
        <div>
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={descId} className="mt-0.5 text-sm text-(--color-text-muted)">
              {description}
            </p>
          ) : null}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close" className="shrink-0 whitespace-nowrap">
          Close
        </Button>
      </div>
      <div className="px-5 py-4">{children}</div>
    </dialog>
  );
}

/* ── toasts ───────────────────────────────────────────────────────────── */

interface Toast {
  id: number;
  text: string;
  tone: "success" | "error";
}
const ToastContext = createContext<((text: string, tone?: Toast["tone"]) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const push = useCallback((text: string, tone: Toast["tone"] = "success") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 print:hidden">
        {toasts.map((t) => (
          <div
            key={t.id}
            data-testid="toast"
            className={cn(
              "pointer-events-auto max-w-md rounded-lg border px-4 py-2.5 text-sm shadow-lg",
              t.tone === "success" ? "border-(--color-ok) bg-(--color-surface) text-(--color-text)" : "border-(--color-danger) bg-(--color-surface) text-(--color-text)",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: Toast["tone"]) => void {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

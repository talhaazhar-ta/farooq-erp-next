import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PartyLookupItem } from "@farooq/shared";
import { keys, lookupParties, type PartyType } from "../lib/queries";
import { cn, inputClass } from "./ui";

/**
 * Async search combobox over `GET /customers?q=` / `GET /suppliers?q=` (ARIA 1.2 combobox: listbox popup, arrow keys,
 * Enter, Escape). Money screens never pre-select a party: it starts on "— Choose a shop —" and stays there until the
 * person picks one. Names render with `dir="auto"` so Urdu shop names lay out correctly.
 */
export function PartyCombobox({
  type,
  value,
  onChange,
  regionId = "",
  id,
  label,
  invalid = false,
}: {
  type: PartyType;
  value: PartyLookupItem | null;
  onChange: (party: PartyLookupItem | null) => void;
  regionId?: string;
  id?: string;
  label?: string;
  invalid?: boolean;
}) {
  const autoId = useId();
  const inputId = id ?? `${autoId}-input`;
  const listId = `${autoId}-list`;
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 200);
    return () => clearTimeout(t);
  }, [text]);

  const results = useQuery({
    queryKey: keys.parties(type, debounced, regionId),
    queryFn: ({ signal }) => lookupParties(type, debounced, regionId, signal),
    enabled: open,
    staleTime: 15_000,
  });
  const items = results.data ?? [];
  const noun = type === "customer" ? "shop" : "supplier";
  const placeholder = `— Choose a ${noun} —`;

  useEffect(() => setActive(0), [debounced, regionId]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  function pick(item: PartyLookupItem) {
    onChange(item);
    setText("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && open) {
      const item = items[active];
      if (item) {
        e.preventDefault();
        pick(item);
      }
    } else if (e.key === "Escape" && open) {
      e.stopPropagation(); // closes the list, not the dialog around it
      e.preventDefault();
      setOpen(false);
    }
  }

  const shown = open ? text : (value?.name ?? "");

  return (
    <div ref={rootRef} className="relative">
      <input
        id={inputId}
        role="combobox"
        aria-label={label ?? `Choose a ${noun}`}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={invalid || undefined}
        aria-activedescendant={open && items[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        dir="auto"
        placeholder={placeholder}
        value={shown}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (value) onChange(null); // typing again un-chooses: Save must not keep an old party
        }}
        onKeyDown={onKeyDown}
        className={cn(inputClass, invalid && "border-(--color-danger)")}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={`${noun}s`}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-(--color-border) bg-(--color-surface) py-1 shadow-lg"
        >
          {results.isPending ? (
            <li role="presentation" className="px-3 py-2 text-sm text-(--color-text-muted)">
              Searching…
            </li>
          ) : results.isError ? (
            <li role="presentation" className="px-3 py-2 text-sm text-(--color-danger)">
              Couldn’t load the list. Try again.
            </li>
          ) : items.length === 0 ? (
            <li role="presentation" className="px-3 py-2 text-sm text-(--color-text-muted)">
              No {noun} found{debounced.trim() ? ` for “${debounced.trim()}”` : ""}.
            </li>
          ) : (
            items.map((item, i) => (
              <li
                key={item.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn("cursor-pointer px-3 py-2 text-sm", i === active ? "bg-(--color-bg)" : "")}
              >
                <span dir="auto" className="font-medium text-(--color-text)">
                  {item.name}
                </span>
                <span className="ml-2 text-xs text-(--color-text-muted)" dir="auto">
                  {[item.contact, item.region, item.phone].filter(Boolean).join(" · ")}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}

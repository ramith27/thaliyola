import { useEffect, useId, useRef, useState } from "react";
import { api } from "../api";
import { Avatar } from "./kit/display";

interface Person {
  email: string;
  name: string | null;
  pending: boolean;
}

/**
 * An email field that suggests people already on Thaliyola (by name or email) as you type, or as soon as it's
 * focused. Picking one fills in their email; typing a new address still works for someone who hasn't signed in.
 */
export function PersonInput({
  value,
  onChange,
  exclude = [],
  placeholder = "Name or email",
  label = "Person",
  disabled = false,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: {
  value: string;
  onChange: (email: string) => void;
  /** Emails not to suggest (already members). */
  exclude?: string[];
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  /** Set by a surrounding kit Field, or passed directly so a hint or error reaches screen readers. */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [active, setActive] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();

  // Look people up as the text changes (debounced; the latest answer wins).
  useEffect(() => {
    if (!open) return;
    let stale = false;
    const t = setTimeout(() => {
      api<{ people: Person[] }>(`/people?q=${encodeURIComponent(value.trim())}&limit=20`)
        .then((r) => {
          if (stale) return;
          const skip = new Set(exclude.map((e) => e.toLowerCase()));
          setPeople(r.people.filter((p) => !skip.has(p.email.toLowerCase())).slice(0, 8));
          setActive(-1);
        })
        .catch(() => !stale && setPeople([]));
    }, 150);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [value, open, exclude.join(",")]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const pick = (p: Person) => {
    onChange(p.email);
    setOpen(false);
  };
  const exact = people.some((p) => p.email.toLowerCase() === value.trim().toLowerCase());
  const showing = open && people.length > 0 && !(exact && people.length === 1);

  return (
    <div className="person-input" ref={box}>
      <input
        className="input"
        type="text"
        inputMode="email"
        autoComplete="off"
        required
        disabled={disabled}
        value={value}
        placeholder={placeholder}
        id={id}
        aria-label={label}
        aria-describedby={describedBy || undefined}
        aria-invalid={invalid || undefined}
        role="combobox"
        aria-expanded={showing}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, people.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && showing && active >= 0) {
            e.preventDefault();
            pick(people[active]!);
          } else if (e.key === "Escape" && showing) {
            // Close only the suggestions, not a surrounding dialog.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === "Escape" || e.key === "Tab") {
            setOpen(false);
          }
        }}
      />
      {showing && (
        <ul className="person-menu" role="listbox" id={listId} aria-label="People on Thaliyola">
          {people.map((p, i) => (
            <li
              key={p.email}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "active" : ""}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
              onMouseEnter={() => setActive(i)}
            >
              <Avatar name={p.name} email={p.email} size={24} />
              <span className="person-text">
                <strong>{p.name || p.email}</strong>
                {p.name && <span className="small muted">{p.email}</span>}
              </span>
              {p.pending && <span className="person-pending">not signed in yet</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

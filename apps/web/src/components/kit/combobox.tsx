/**
 * Combobox (SPEC §5.2): a select for long lists. The trigger looks like a Select; it opens a panel with a search field
 * and a listbox (grouped options, arrow keys, Enter to pick, Escape to close). Also the list behind the breadcrumb
 * project switcher (ComboboxPanel). Phones get the panel as a bottom sheet.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { I } from "../icons";
import { plural } from "../labels";
import { Popover } from "./overlay";
import { cx } from "./util";

export interface ComboOption {
  value: string;
  label: string;
  /** A heading the option is listed under ("Spaces", "Projects"). Options of one group should be adjacent. */
  group?: string;
  /** A second line (a path, a description). Searched too. */
  hint?: string;
  /** Extra words to match ("order-service"). */
  keywords?: string;
  disabled?: boolean;
}

/** Every word typed must appear in the label, hint or keywords (case-insensitive). Pure, for tests. */
export function filterOptions(options: ComboOption[], text: string): ComboOption[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const hay = `${o.label} ${o.hint ?? ""} ${o.keywords ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface ComboboxPanelProps {
  options: ComboOption[];
  value?: string;
  onPick(value: string): void;
  /** The search field's accessible name ("Search projects"). */
  searchLabel: string;
  placeholder?: string;
  emptyText?: string;
  /** Rendered above the search field (the panel's title). */
  title?: ReactNode;
}

/** The search field and listbox. Focuses the field when it mounts; the chosen option starts active. */
export function ComboboxPanel({ options, value, onPick, searchLabel, placeholder = "Type to filter", emptyText = "Nothing matches.", title }: ComboboxPanelProps) {
  const [text, setText] = useState("");
  const shown = useMemo(() => filterOptions(options, text), [options, text]);
  const enabled = shown.filter((o) => !o.disabled);
  const [active, setActive] = useState<string | null>(() => (value && options.some((o) => o.value === value && !o.disabled) ? value : null));
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const optionId = (v: string) => `${id}-opt-${encodeURIComponent(v)}`;

  // Keep the active option among the visible ones as the text narrows the list.
  const activeShown = active !== null && enabled.some((o) => o.value === active) ? active : (enabled[0]?.value ?? null);
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (activeShown === null) return;
    const el = document.getElementById(optionId(activeShown));
    el?.scrollIntoView?.({ block: "nearest" });
  }, [activeShown]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (delta: number | "first" | "last") => {
    if (!enabled.length) return;
    const at = enabled.findIndex((o) => o.value === activeShown);
    const i = delta === "first" ? 0 : delta === "last" ? enabled.length - 1 : Math.max(0, Math.min(enabled.length - 1, (at < 0 ? -1 : at) + delta));
    setActive(enabled[i]!.value);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(8);
    else if (e.key === "PageUp") move(-8);
    else if (e.key === "Home" && e.ctrlKey) move("first");
    else if (e.key === "End" && e.ctrlKey) move("last");
    else if (e.key === "Enter") {
      if (activeShown !== null) onPick(activeShown);
    } else return;
    e.preventDefault();
  };

  // Group headings, in the order the groups first appear.
  const rows: ReactNode[] = [];
  let lastGroup: string | undefined;
  for (const o of shown) {
    if (o.group && o.group !== lastGroup) {
      rows.push(
        <li key={`g-${o.group}`} role="presentation" className="combobox-group">
          {o.group}
        </li>,
      );
    }
    lastGroup = o.group;
    const selected = o.value === value;
    rows.push(
      <li
        key={o.value || "(none)"}
        id={optionId(o.value)}
        role="option"
        aria-selected={selected}
        aria-disabled={o.disabled || undefined}
        className="combobox-option"
        data-active={o.value === activeShown || undefined}
        onPointerDown={(e) => e.preventDefault()}
        onPointerMove={() => !o.disabled && o.value !== activeShown && setActive(o.value)}
        onClick={() => !o.disabled && onPick(o.value)}
      >
        <span className="combobox-check" aria-hidden="true">
          {selected && <I name="check" size={16} />}
        </span>
        <span className="combobox-option-text">
          <span className="combobox-option-label">{o.label}</span>
          {o.hint && <span className="combobox-option-hint">{o.hint}</span>}
        </span>
      </li>,
    );
  }

  return (
    <div className="combobox-panel">
      {title && <p className="combobox-title">{title}</p>}
      <div className="combobox-search">
        <I name="search" size={16} className="combobox-search-icon" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={searchLabel}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={activeShown !== null ? optionId(activeShown) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={searchLabel} className="combobox-list">
        {rows}
      </ul>
      {!shown.length && <p className="combobox-empty">{emptyText}</p>}
      <span className="sr-only" aria-live="polite">
        {text ? plural(shown.length, "match", "matches") : ""}
      </span>
    </div>
  );
}

export interface ComboboxProps {
  value: string;
  onChange(value: string): void;
  options: ComboOption[];
  /** Trigger text when no option matches the value. */
  placeholder?: string;
  /** The panel's search field name ("Search projects"). */
  searchLabel?: string;
  emptyText?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
}

/**
 * A select for long lists: a trigger showing the choice (labelled by a surrounding Field, which gives it the id),
 * opening a searchable listbox. Picking closes it and returns focus to the trigger.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Choose…",
  searchLabel = "Search",
  emptyText,
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const chosen = options.find((o) => o.value === value);
  return (
    <span className={cx("combobox", className)}>
      <button
        ref={trigger}
        type="button"
        id={id}
        className="combobox-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="combobox-value" data-empty={chosen ? undefined : true}>
          {chosen ? chosen.label : placeholder}
        </span>
        <I name="chevron-down" size={16} className="combobox-chevron" />
      </button>
      <Popover anchorRef={trigger} open={open} onClose={() => setOpen(false)} label={searchLabel} id={panelId} sheetOnMobile className="combobox-popover">
        <ComboboxPanel
          options={options}
          value={value}
          searchLabel={searchLabel}
          emptyText={emptyText}
          onPick={(v) => {
            setOpen(false);
            trigger.current?.focus({ preventScroll: true });
            if (v !== value) onChange(v);
          }}
        />
      </Popover>
    </span>
  );
}

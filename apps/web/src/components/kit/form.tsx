/**
 * Fields and inputs (SPEC §5.2). Visible labels everywhere; only optional fields are marked; hints and errors are
 * linked with aria-describedby. Validate on submit: show messages under fields, focus the first invalid one, and
 * never disable submit for missing input (only while busy).
 */
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import type { ScopeInfo } from "../../api";
import { I, type IconName } from "../icons";
import { plural, SCOPE_KIND } from "../labels";
import { treeOrder } from "../tree";
import { Button, IconButton } from "./button";
import { Combobox, type ComboOption } from "./combobox";
import { Spinner } from "./feedback";
import { useConfirm } from "./overlay";
import { cx } from "./util";

// ---- Field -------------------------------------------------------------------------------------------

export interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  counter?: { value: number; max: number };
  labelHidden?: boolean;
  className?: string;
  children: ReactElement;
}

/** A label, the control, its hint and its error. Injects id, aria-describedby, aria-invalid and aria-required. */
export function Field({ label, hint, error, optional, counter, labelHidden, className, children }: FieldProps) {
  const auto = useId();
  const child = Children.only(children);
  const childProps = (isValidElement(child) ? child.props : {}) as Record<string, unknown>;
  const id = (childProps.id as string | undefined) ?? auto;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const showCounter = counter && counter.value >= counter.max * 0.8;
  const counterId = showCounter ? `${id}-counter` : undefined;
  const control = cloneElement(child as ReactElement<Record<string, unknown>>, {
    id,
    "aria-describedby": cx(childProps["aria-describedby"] as string | undefined, errorId, hintId, counterId) || undefined,
    "aria-invalid": error ? true : (childProps["aria-invalid"] as boolean | undefined),
    "aria-required": optional ? undefined : ((childProps["aria-required"] as boolean | undefined) ?? true),
  });
  return (
    <div className={cx("field", className)} data-invalid={error ? true : undefined}>
      <label htmlFor={id} className={cx("field-label", labelHidden && "sr-only")}>
        {label}
        {optional && <span className="field-optional"> (optional)</span>}
      </label>
      {control}
      {error && (
        <p id={errorId} className="field-error">
          <I name="alert" size={14} />
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      )}
      {showCounter && (
        <p id={counterId} className="field-counter" data-over={counter.value > counter.max || undefined} aria-live="polite">
          {counter.value} / {counter.max}
        </p>
      )}
    </div>
  );
}

// ---- Inputs ------------------------------------------------------------------------------------------

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...props }, ref) {
  return <input ref={ref} type="text" {...props} className={cx("input", className)} />;
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  autoGrow?: boolean;
  minRows?: number;
  maxRows?: number;
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ autoGrow, minRows = 3, maxRows = 20, mono, className, onInput, ...props }, ref) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  const grow = () => {
    const el = inner.current;
    if (!autoGrow || !el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = "auto";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, line * minRows), line * maxRows + 16)}px`;
  };
  useLayoutEffect(grow, [props.value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (typeof ref === "function") ref(el);
        else if (ref) ref.current = el;
      }}
      rows={props.rows ?? minRows}
      {...props}
      className={cx("textarea", mono && "textarea-mono", className)}
      onInput={(e) => {
        onInput?.(e);
        grow();
      }}
    />
  );
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: SelectOption[];
  groups?: { label: string; options: SelectOption[] }[];
}

/** A native select with a drawn chevron. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ options, groups, className, children, ...props }, ref) {
  return (
    <span className={cx("select", className)}>
      <select ref={ref} {...props}>
        {options?.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
        {groups?.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
        {children}
      </select>
      <I name="chevron-down" size={16} className="select-chevron" />
    </span>
  );
});

export interface ProjectPickerProps {
  value: string;
  onChange(slug: string): void;
  scopes: ScopeInfo[];
  filter?: (s: ScopeInfo) => boolean;
  noneLabel?: string;
  /** Added after the option it started on, e.g. "(where it is now)". */
  currentLabel?: string;
  includeSpaces?: boolean;
  /** A searchable Combobox instead of a native select: for pickers that may list many projects. */
  searchable?: boolean;
  id?: string;
  disabled?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
}

/** A project's full path, "Order service v2 › Order API" (parents first). */
export function projectPath(s: ScopeInfo, bySlug: Map<string, ScopeInfo>): string {
  const names = [s.name];
  let p = s.parent ? bySlug.get(s.parent) : undefined;
  for (let guard = 0; p && guard < 10; guard++) {
    names.unshift(p.name);
    p = p.parent ? bySlug.get(p.parent) : undefined;
  }
  return names.join(" › ");
}

/**
 * The options a project picker offers: spaces, then projects in tree order with their full path, grouped. `label`
 * may add to an option's text (e.g. "(where it is now)"). Pure, for tests.
 */
export function projectOptions(
  scopes: ScopeInfo[],
  opts: { filter?: (s: ScopeInfo) => boolean; includeSpaces?: boolean; label?: (s: ScopeInfo, text: string) => string } = {},
): ComboOption[] {
  const { filter, includeSpaces = true, label = (_s, t) => t } = opts;
  const bySlug = new Map(scopes.map((s) => [s.slug, s]));
  const ok = (s: ScopeInfo) => !filter || filter(s);
  const spaces = includeSpaces ? scopes.filter((s) => s.kind !== "project" && ok(s)) : [];
  const projects = treeOrder(scopes.filter((s) => s.kind === "project")).filter(ok);
  return [
    ...spaces.map((s) => ({ value: s.slug, label: label(s, s.kind === "personal" ? SCOPE_KIND.personal! : s.name), group: "Spaces", keywords: s.slug })),
    ...projects.map((s) => ({ value: s.slug, label: label(s, projectPath(s, bySlug)), group: "Projects", keywords: s.slug })),
  ];
}

/**
 * "Order service v2 › Order API": spaces, then projects in tree order with their full path. A native select (type-ahead
 * works), or with `searchable` a Combobox that filters as you type.
 */
export function ProjectPicker({ value, onChange, scopes, filter, noneLabel, currentLabel, includeSpaces = true, searchable, ...rest }: ProjectPickerProps) {
  const initial = useRef(value);
  const label = (s: ScopeInfo, text: string) => (currentLabel && s.slug === initial.current ? `${text} ${currentLabel}` : text);
  const options = projectOptions(scopes, { filter, includeSpaces, label });
  if (searchable) {
    return (
      <Combobox
        {...rest}
        value={value}
        onChange={onChange}
        options={noneLabel !== undefined ? [{ value: "", label: noneLabel }, ...options] : options}
        placeholder={noneLabel ?? "Choose a project"}
        searchLabel={includeSpaces ? "Search projects and spaces" : "Search projects"}
        emptyText="No project matches."
      />
    );
  }
  const group = (g: string) => options.filter((o) => o.group === g).map((o) => ({ value: o.value, label: o.label }));
  const spaces = group("Spaces");
  const projects = group("Projects");
  return (
    <Select
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      options={noneLabel !== undefined ? [{ value: "", label: noneLabel }] : undefined}
      groups={[...(spaces.length ? [{ label: "Spaces", options: spaces }] : []), ...(projects.length ? [{ label: "Projects", options: projects }] : [])]}
    />
  );
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
}

/** A native checkbox with its label (24px target) and an optional description. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox({ label, description, className, ...props }, ref) {
  const descId = useId();
  return (
    <label className={cx("checkbox", className)}>
      <input ref={ref} type="checkbox" aria-describedby={description ? descId : undefined} {...props} />
      <span className="checkbox-text">
        <span className="checkbox-label">{label}</span>
        {description && (
          <span id={descId} className="checkbox-description">
            {description}
          </span>
        )}
      </span>
    </label>
  );
});

export interface SwitchProps {
  checked: boolean;
  onChange(next: boolean): void;
  label: string;
  description?: string;
  status?: "saving" | "saved" | "error";
  disabled?: boolean;
}

/** An on/off setting that applies at once (role="switch"), with an inline Saving / Saved status. */
export function Switch({ checked, onChange, label, description, status, disabled }: SwitchProps) {
  const descId = useId();
  return (
    <div className="switch-field">
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-thumb" />
        </span>
        <span className="switch-label">{label}</span>
      </button>
      <span className="switch-status" aria-live="polite">
        {status === "saving" && <Spinner size={16} />}
        {status === "saved" && (
          <>
            <I name="check" size={14} /> Saved
          </>
        )}
        {status === "error" && (
          <>
            <I name="alert" size={14} /> Not saved
          </>
        )}
      </span>
      {description && (
        <p id={descId} className="switch-description">
          {description}
        </p>
      )}
    </div>
  );
}

export interface ChoiceOption {
  value: string;
  label: string;
  description?: ReactNode;
  icon?: IconName;
  badge?: ReactNode;
  disabledReason?: string;
}
export interface ChoiceCardsProps {
  name: string;
  legend: string;
  legendHidden?: boolean;
  type?: "radio" | "checkbox";
  value: string | string[];
  onChange(v: string | string[]): void;
  options: ChoiceOption[];
  columns?: 1 | 2 | 3;
}

/** Radio or checkbox cards in a fieldset; the checked card uses the accent soft fill. */
export function ChoiceCards({ name, legend, legendHidden, type = "radio", value, onChange, options, columns = 1 }: ChoiceCardsProps) {
  const values = Array.isArray(value) ? value : [value];
  return (
    <fieldset className="choices kit-choices" data-columns={columns}>
      <legend className={cx("field-label", legendHidden && "sr-only")}>{legend}</legend>
      {options.map((o) => {
        const checked = values.includes(o.value);
        return (
          <label key={o.value} className="choice">
            <input
              type={type}
              name={name}
              value={o.value}
              checked={checked}
              disabled={!!o.disabledReason}
              onChange={(e) => {
                if (type === "radio") onChange(o.value);
                else onChange(e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value));
              }}
            />
            {o.icon && <I name={o.icon} size={20} className="choice-icon" />}
            <span className="choice-text">
              <span className="choice-label">
                {o.label}
                {o.badge && <span className="choice-badge">{o.badge}</span>}
              </span>
              {o.description && <span className="choice-description">{o.description}</span>}
              {o.disabledReason && <span className="choice-description choice-reason">{o.disabledReason}</span>}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

// ---- Search ------------------------------------------------------------------------------------------

export interface SearchInputProps {
  value: string;
  onChange(v: string): void;
  label: string;
  placeholder?: string;
  debounceMs?: number;
  resultCount?: number;
  size?: "md" | "lg";
  autoFocus?: boolean;
}

/**
 * Keeps its own text and reports it debounced, so URL updates never steal focus. Clear (×) and Esc empty it; a
 * polite live region reads "12 results" when the count changes.
 */
export function SearchInput({ value, onChange, label, placeholder, debounceMs = 250, resultCount, size = "md", autoFocus }: SearchInputProps) {
  const [text, setText] = useState(value);
  const last = useRef(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const cb = useRef(onChange);
  cb.current = onChange;
  // Follow outside changes (Back/Forward, Clear filters), but never while the person is typing.
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      if (document.activeElement !== inputRef.current) setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text === last.current) return;
    const t = setTimeout(() => {
      last.current = text;
      cb.current(text);
    }, debounceMs);
    return () => clearTimeout(t);
  }, [text, debounceMs]);
  const emitNow = (v: string) => {
    setText(v);
    last.current = v;
    cb.current(v);
  };
  return (
    <div className="search-input" data-size={size}>
      <I name="search" size={size === "lg" ? 18 : 16} className="search-input-icon" />
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault();
            e.stopPropagation();
            emitNow("");
          }
        }}
      />
      {text && (
        <IconButton
          icon="x"
          label="Clear search"
          size="sm"
          className="search-input-clear"
          onClick={() => {
            emitNow("");
            inputRef.current?.focus();
          }}
        />
      )}
      {resultCount !== undefined && (
        <span className="sr-only" aria-live="polite">
          {plural(resultCount, "result")}
        </span>
      )}
    </div>
  );
}

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {}

/** A password field with Show / Hide. Paste is never blocked. */
export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput({ className, ...props }, ref) {
  const [shown, setShown] = useState(false);
  return (
    <span className={cx("password-input", className)}>
      <input ref={ref} {...props} type={shown ? "text" : "password"} className="input" />
      <IconButton icon={shown ? "eye-off" : "eye"} label={shown ? "Hide password" : "Show password"} pressed={shown} size="sm" onClick={() => setShown((s) => !s)} />
    </span>
  );
});

// ---- File drop ---------------------------------------------------------------------------------------

export interface FileDropProps {
  accept: string;
  file: File | null;
  onFile(f: File | null): void;
  busy?: boolean;
  busyText?: string;
  hint?: ReactNode;
  label: string;
}

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** Drop a file or choose one (the input stays in the accessibility tree). The chosen file shows with Remove. */
export function FileDrop({ accept, file, onFile, busy, busyText = "Uploading", hint, label }: FileDropProps) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  return (
    <div
      className="file-drop"
      data-state={over ? "dragover" : file ? "chosen" : undefined}
      aria-busy={busy || undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
    >
      <label htmlFor={id} className="file-drop-label">
        {label}
      </label>
      <input
        ref={input}
        id={id}
        type="file"
        className="sr-only"
        tabIndex={-1}
        accept={accept}
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
      {file ? (
        <div className="file-drop-file">
          <I name="doc" size={16} />
          <span className="file-drop-name">{file.name}</span>
          <span className="file-drop-size">{fileSize(file.size)}</span>
          {busy ? (
            <Spinner label={busyText} />
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onFile(null)}>
              Remove
            </Button>
          )}
        </div>
      ) : (
        <div className="file-drop-empty">
          <I name="upload" size={20} />
          <span>Drop a file here, or</span>
          <Button size="sm" onClick={() => input.current?.click()}>
            Choose file
          </Button>
        </div>
      )}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

// ---- Form layout ---------------------------------------------------------------------------------------

export function FormSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="form-section" aria-labelledby={id}>
      <div className="form-section-head">
        <h2 id={id} className="form-section-title">
          {title}
        </h2>
        {description && <div className="form-section-description">{description}</div>}
      </div>
      <div className="form-section-body">{children}</div>
    </section>
  );
}

export interface FormActionsProps {
  sticky?: boolean;
  status?: ReactNode;
  hint?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}

/** The footer of forms and editors: autosave status, the outcome line, an inline field, then Cancel … primary. */
export function FormActions({ sticky, status, hint, extra, children }: FormActionsProps) {
  return (
    <div className="form-actions" data-sticky={sticky || undefined}>
      {extra && <div className="form-actions-extra">{extra}</div>}
      <div className="form-actions-row">
        <div className="form-actions-info">
          {status && (
            <span className="form-actions-status" aria-live="polite">
              {status}
            </span>
          )}
          {hint && <span className="form-actions-hint">{hint}</span>}
        </div>
        <div className="form-actions-buttons">{children}</div>
      </div>
    </div>
  );
}

export interface SaveBarProps {
  dirtyCount: number;
  onSave(): void;
  onDiscard(): void;
  saving?: boolean;
  error?: ReactNode;
  saveLabel?: string;
}

/** "2 unsaved changes · Discard · Save changes", sticky at the bottom while something is unsaved. */
export function SaveBar({ dirtyCount, onSave, onDiscard, saving, error, saveLabel = "Save changes" }: SaveBarProps) {
  useUnsavedChangesGuard(dirtyCount > 0);
  if (dirtyCount <= 0) return null;
  return (
    <div className="save-bar" role="region" aria-label="Unsaved changes">
      <span className="save-bar-count" aria-live="polite">
        {plural(dirtyCount, "unsaved change")}
      </span>
      {error && <span className="save-bar-error">{error}</span>}
      <div className="save-bar-actions">
        <Button variant="ghost" onClick={onDiscard} disabled={saving}>
          Discard
        </Button>
        <Button variant="primary" loading={saving} loadingText="Saving" onClick={onSave}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * Asks before leaving with unsaved changes: on reload/close (beforeunload) and on same-tab "#/" links. Back and
 * Forward are not blocked (editors autosave drafts).
 */
export function useUnsavedChangesGuard(dirty: boolean, message = "Leave without saving? Your changes will be lost.") {
  const confirm = useConfirm();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirty) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = message;
      return message;
    };
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.closest("dialog")) return;
      const to = a.getAttribute("href")!;
      if (to === window.location.hash) return;
      e.preventDefault();
      e.stopPropagation();
      void confirm({ title: message, confirmLabel: "Leave", cancelLabel: "Stay", tone: "danger" }).then((r) => {
        if (r) {
          dirtyRef.current = false;
          window.location.hash = to.slice(1);
        }
      });
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [dirty, message, confirm]);
}

/** Focuses the first control marked aria-invalid="true" (call after validating on submit). */
export function focusFirstInvalid(form: HTMLElement | null) {
  form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

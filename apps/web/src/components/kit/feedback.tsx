/**
 * Feedback (SPEC §5.8): toasts (polite live region, a separate alert region for errors, Undo), Callout,
 * ErrorState + humanizeError, EmptyState, skeletons, Spinner, AsyncBlock, NewItemsPill and useAsyncAction.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { humanizeError } from "../labels";
import { I, type IconName } from "../icons";
import { Button, IconButton } from "./button";
import { Disclosure } from "./page";
import { cx } from "./util";

export { humanizeError };

// ---- Toasts ----------------------------------------------------------------------------------------------

export interface ToastOptions {
  description?: string;
  action?: { label: string; onClick: () => void };
  undo?: () => Promise<unknown>;
  link?: { label: string; href: string };
  duration?: number;
  id?: string;
}
export interface ErrorToastOptions extends ToastOptions {
  /** A title above the humanized message ("Couldn't approve"). */
  title?: string;
}

type ToastTone = "success" | "info" | "warning" | "error";

interface ToastItem extends ToastOptions {
  id: string;
  tone: ToastTone;
  title: string;
  duration: number;
}

export interface ToastApi {
  success(title: string, o?: ToastOptions): string;
  info(title: string, o?: ToastOptions): string;
  warning(title: string, o?: ToastOptions): string;
  /** An Error, an ApiError or a message. Errors stay until dismissed. */
  error(errOrTitle: unknown, o?: ErrorToastOptions): string;
  dismiss(id: string): void;
}

const ToastContext = createContext<ToastApi | null>(null);

const NOOP: ToastApi = { success: () => "", info: () => "", warning: () => "", error: () => "", dismiss: () => {} };

/** The toast API. Outside a KitProvider (the static viewer) it does nothing. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? NOOP;
}

const TOAST_ICON: Record<ToastTone, IconName> = { success: "check-circle", info: "info", warning: "alert", error: "alert" };
const MAX_TOASTS = 3;
let toastSeq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const region = useRef<HTMLDivElement>(null);

  const announce = useCallback((t: ToastItem) => {
    const text = [t.title, t.description].filter(Boolean).join(" ");
    const set = t.tone === "error" ? setAssertive : setPolite;
    set("");
    setTimeout(() => set(text), 60);
  }, []);

  const dismiss = useCallback((id: string) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, title: string, o: ToastOptions = {}) => {
      const id = o.id ?? `toast-${++toastSeq}`;
      const hasAction = !!(o.action || o.undo || o.link);
      const duration = o.duration ?? (tone === "error" ? 0 : tone === "warning" ? 10_000 : hasAction ? 8_000 : 5_000);
      const item: ToastItem = { ...o, id, tone, title, duration };
      setToasts((list) => {
        let next = [...list.filter((t) => t.id !== id), item];
        while (next.length > MAX_TOASTS) {
          const drop = next.findIndex((t) => t.tone !== "error");
          next = next.filter((_, i) => i !== (drop >= 0 ? drop : 0));
        }
        return next;
      });
      announce(item);
      return id;
    },
    [announce],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (t, o) => push("success", t, o),
      info: (t, o) => push("info", t, o),
      warning: (t, o) => push("warning", t, o),
      error: (e, o = {}) => {
        if (typeof e === "string") return push("error", e, o);
        const h = humanizeError(e);
        return o.title ? push("error", o.title, { ...o, description: o.description ?? h.title }) : push("error", h.title, o);
      },
      dismiss,
    }),
    [push, dismiss],
  );

  // Top layer: re-show the region after each new toast so it sits above an open modal <dialog>.
  useLayoutEffect(() => {
    const el = region.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!el || typeof el.showPopover !== "function") return;
    if (!el.hasAttribute("popover")) el.setAttribute("popover", "manual");
    try {
      if (el.matches(":popover-open")) el.hidePopover?.();
      if (toasts.length) el.showPopover();
    } catch {
      /* not supported: a fixed region is fine */
    }
  }, [toasts]);

  const undo = async (t: ToastItem) => {
    dismiss(t.id);
    try {
      await t.undo?.();
      push("success", "Undone");
    } catch (e) {
      api.error(e, { title: "Couldn't undo" });
    }
  };

  return (
    <ToastContext.Provider value={api}>
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <>
            <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {polite}
            </div>
            <div className="sr-only" role="alert" aria-atomic="true">
              {assertive}
            </div>
            <div ref={region} className="toast-region" data-empty={toasts.length === 0 || undefined}>
              {toasts.map((t) => (
                <ToastView key={t.id} t={t} onDismiss={() => dismiss(t.id)} onUndo={() => undo(t)} />
              ))}
            </div>
          </>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

function ToastView({ t, onDismiss, onUndo }: { t: ToastItem; onDismiss: () => void; onUndo: () => void }) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(t.duration);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    if (!t.duration || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissRef.current(), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [paused, t.duration]);

  return (
    <div
      className={cx("toast", `toast-${t.tone}`)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setPaused(false)}
    >
      <span className="toast-icon" aria-hidden="true">
        <I name={TOAST_ICON[t.tone]} size={18} />
      </span>
      <div className="toast-text">
        <p className="toast-title">{t.title}</p>
        {t.description && <p className="toast-description">{t.description}</p>}
        {(t.action || t.undo || t.link) && (
          <div className="toast-actions">
            {t.undo && (
              <button type="button" className="link-btn" onClick={onUndo}>
                Undo
              </button>
            )}
            {t.action && (
              <button
                type="button"
                className="link-btn"
                onClick={() => {
                  onDismiss();
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
            {t.link && (
              <a href={t.link.href} onClick={onDismiss}>
                {t.link.label}
              </a>
            )}
          </div>
        )}
      </div>
      <IconButton icon="x" label="Dismiss notification" size="sm" className="toast-close" onClick={onDismiss} />
    </div>
  );
}

// ---- Callout -----------------------------------------------------------------------------------------------

export interface CalloutProps {
  tone?: "info" | "success" | "warning" | "danger" | "neutral";
  title?: ReactNode;
  icon?: IconName | false;
  actions?: ReactNode;
  onDismiss?: () => void;
  live?: boolean;
  children?: ReactNode;
  className?: string;
}

const CALLOUT_ICON: Record<NonNullable<CalloutProps["tone"]>, IconName> = { info: "info", success: "check-circle", warning: "alert", danger: "alert", neutral: "info" };

/** Persistent page or item state: stale, draft, trashed, conflict, read-only, setup needed. */
export function Callout({ tone = "info", title, icon, actions, onDismiss, live, children, className }: CalloutProps) {
  return (
    <div className={cx("callout", `callout-${tone}`, className)} role={live ? (tone === "danger" ? "alert" : "status") : undefined}>
      {icon !== false && (
        <span className="callout-icon" aria-hidden="true">
          <I name={icon ?? CALLOUT_ICON[tone]} size={20} />
        </span>
      )}
      <div className="callout-body">
        {title && <p className="callout-title">{title}</p>}
        {children !== undefined && children !== null && <div className="callout-text">{children}</div>}
        {actions && <div className="callout-actions">{actions}</div>}
      </div>
      {onDismiss && <IconButton icon="x" label="Dismiss" size="sm" className="callout-dismiss" onClick={onDismiss} />}
    </div>
  );
}

// ---- Errors ------------------------------------------------------------------------------------------------

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  compact?: boolean;
}

const same = (a: string, b: string) => a.trim().replace(/\.$/, "").toLowerCase() === b.trim().replace(/\.$/, "").toLowerCase();

/** What failed, in plain words, with Try again and the raw text under "Technical details". */
export function ErrorState({ error, onRetry, title, compact }: ErrorStateProps) {
  const h = humanizeError(error);
  const detail = h.detail && !same(h.detail, h.title) ? h.detail : undefined;
  if (compact) {
    return (
      <div className="error-state" data-compact="true" role="alert">
        <I name="alert" size={16} className="error-state-icon" />
        <div className="error-state-main">
          <p className="error-state-message">
            {title && <strong>{title}. </strong>}
            {h.title}
          </p>
          {detail && (
            <details className="error-state-details">
              <summary>Technical details</summary>
              <code>{detail}</code>
            </details>
          )}
        </div>
        {onRetry && (
          <Button size="sm" variant="secondary" icon="refresh" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="error-state" role="alert">
      <span className="error-state-badge" aria-hidden="true">
        <I name="alert" size={24} />
      </span>
      <p className="error-state-title">{title ?? "This didn't load"}</p>
      <p className="error-state-message">{h.title}</p>
      {detail && (
        <Disclosure summary="Technical details">
          <code className="error-state-code">{detail}</code>
        </Disclosure>
      )}
      {onRetry && (
        <Button variant="secondary" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ---- Empty states ----------------------------------------------------------------------------------------

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  variant?: "default" | "compact" | "positive" | "search" | "locked";
}

const EMPTY_ICON: Record<NonNullable<EmptyStateProps["variant"]>, IconName> = { default: "inbox", compact: "inbox", positive: "check-circle", search: "search", locked: "lock" };

/** Every list has one. "locked" names who can help ("Ask a Project admin (Rita, Wes) to add one."). */
export function EmptyState({ icon, title, description, primary, secondary, variant = "default" }: EmptyStateProps) {
  return (
    <div className="empty-state" data-variant={variant}>
      <span className="empty-state-icon" aria-hidden="true">
        <I name={icon ?? EMPTY_ICON[variant]} size={variant === "compact" ? 20 : 24} />
      </span>
      <p className="empty-state-title">{title}</p>
      {description && <div className="empty-state-description">{description}</div>}
      {(primary || secondary) && (
        <div className="empty-state-actions">
          {primary}
          {secondary}
        </div>
      )}
    </div>
  );
}

// ---- Skeletons and spinner -------------------------------------------------------------------------------

export function Skeleton({ width, height, radius }: { width?: number | string; height?: number | string; radius?: "sm" | "md" | "full" }) {
  return (
    <span
      className="skeleton"
      aria-hidden="true"
      data-radius={radius}
      style={{ width: typeof width === "number" ? `${width}px` : width, height: typeof height === "number" ? `${height}px` : height }}
    />
  );
}

const LINE_WIDTHS = ["72%", "94%", "58%", "86%", "66%", "90%"];

export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="skeleton-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={LINE_WIDTHS[i % LINE_WIDTHS.length]} />
      ))}
    </span>
  );
}

export function SkeletonRows({ count = 3, density = "comfortable" }: { count?: number; density?: "comfortable" | "compact" }) {
  return (
    <span className="skeleton-rows" data-density={density} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="skeleton-row">
          <Skeleton width={20} height={20} radius="sm" />
          <span className="skeleton-row-lines">
            <Skeleton width={LINE_WIDTHS[i % LINE_WIDTHS.length]} />
            {density === "comfortable" && <Skeleton width="40%" height={12} />}
          </span>
        </span>
      ))}
    </span>
  );
}

export function SkeletonCard() {
  return (
    <span className="skeleton-card" aria-hidden="true">
      <Skeleton width="45%" height={18} />
      <SkeletonText lines={3} />
    </span>
  );
}

export function SkeletonTiles({ count = 4 }: { count?: number }) {
  return (
    <span className="skeleton-tiles" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className="skeleton-card">
          <Skeleton width="60%" height={14} />
          <Skeleton width="40%" height={28} />
        </span>
      ))}
    </span>
  );
}

/** A small spinner. With `label`, it is announced (role="status"). */
export function Spinner({ size = 16, label }: { size?: 16 | 20; label?: string }) {
  const spin = <span className="spinner" data-size={size} aria-hidden="true" />;
  if (!label) return spin;
  return (
    <span className="spinner-wrap" role="status">
      {spin}
      <span className="sr-only">{label}</span>
    </span>
  );
}

// ---- AsyncBlock ---------------------------------------------------------------------------------------------

export interface AsyncBlockProps<T> {
  result: { data: T | null; error: unknown; loading: boolean; reload: () => void };
  skeleton: ReactNode;
  /** "Loading proposals" (announced while the skeleton shows). */
  label: string;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  errorTitle?: string;
  children: (data: T) => ReactNode;
}

/**
 * Loading → skeleton; a reload keeps the data, dimmed; an error with no data → ErrorState with Try again;
 * an error with data → a compact error above it; nothing in it → `empty`.
 */
export function AsyncBlock<T>({ result, skeleton, label, isEmpty, empty, errorTitle, children }: AsyncBlockProps<T>) {
  const { data, error, loading, reload } = result;
  if (data === null || data === undefined) {
    if (error) return <ErrorState error={error} title={errorTitle} onRetry={reload} />;
    if (!loading) return null;
    return (
      <div className="async-block" aria-busy="true">
        <span className="sr-only" role="status">
          {label}…
        </span>
        {skeleton}
      </div>
    );
  }
  const staleError = error ? <ErrorState compact error={error} title={errorTitle} onRetry={reload} /> : null;
  if (isEmpty?.(data) && empty !== undefined) {
    return (
      <>
        {staleError}
        {empty}
      </>
    );
  }
  return (
    <div className="async-block" aria-busy={loading || undefined} data-refreshing={loading || undefined}>
      {staleError}
      {children(data)}
    </div>
  );
}

// ---- New items --------------------------------------------------------------------------------------------

export interface NewItemsPillProps {
  count: number;
  noun: [string, string];
  onShow(): void;
}

/** "3 new proposals · Show": lists don't reorder under the person while they read. */
export function NewItemsPill({ count, noun, onShow }: NewItemsPillProps) {
  if (count <= 0) return null;
  return (
    <div className="new-items-pill-wrap" role="status">
      <button type="button" className="new-items-pill" onClick={onShow}>
        <I name="arrow" size={14} className="new-items-pill-icon" />
        {count} new {count === 1 ? noun[0] : noun[1]} · Show
      </button>
    </div>
  );
}

// ---- useAsyncAction -----------------------------------------------------------------------------------------

/**
 * Runs an action with a busy state. Success → toast (with Undo when `undo` is given). Failure → an error toast
 * with Try again, unless `error: false` (the caller shows the error inline, e.g. on a row).
 */
export function useAsyncAction<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
  o: { success?: string | ((r: R) => string); error?: string | false; undo?: (r: R) => Promise<unknown>; onDone?: (r: R) => void } = {},
): { run: (...a: A) => Promise<R | undefined>; busy: boolean; error: unknown; reset(): void } {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optsRef = useRef(o);
  optsRef.current = o;
  const runRef = useRef<(...a: A) => Promise<R | undefined>>();

  const run = useCallback(
    async (...a: A) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fnRef.current(...a);
        const { success, undo, onDone } = optsRef.current;
        if (success) toast.success(typeof success === "function" ? success(r) : success, undo ? { undo: () => undo(r) } : undefined);
        onDone?.(r);
        return r;
      } catch (e) {
        setError(e);
        const err = optsRef.current.error;
        if (err !== false) toast.error(e, { title: err || undefined, action: { label: "Try again", onClick: () => void runRef.current?.(...a) } });
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  runRef.current = run;
  const reset = useCallback(() => setError(null), []);
  return { run, busy, error, reset };
}

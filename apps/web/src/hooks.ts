import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { api, ApiError } from "./api";
import { href, navigate, type Route } from "./router";

/** Loads `path` (re-runs when it changes). `null` path skips loading. */
export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (path === null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<T>(path)
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/**
 * Calls `refresh` when knowledge changes on the server (server-sent events).
 * Dev-token sessions can't send their token on an event stream, so they poll
 * every 30 seconds instead. Hidden tabs refresh when shown again.
 */
export function useLiveRefresh(refresh: () => void) {
  useEffect(() => {
    let stale = false;
    const fire = () => {
      if (document.hidden) stale = true;
      else refresh();
    };
    const onVisible = () => {
      if (!document.hidden && stale) {
        stale = false;
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let devToken = false;
    try {
      devToken = !!localStorage.getItem("thaliyola.devToken");
    } catch {
      /* storage unavailable */
    }
    if (devToken || typeof EventSource === "undefined") poll = setInterval(fire, 30_000);
    else {
      source = new EventSource("/api/events", { withCredentials: true });
      source.addEventListener("changed", fire);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [refresh]);
}

// ---- Routing (SPEC §5.16) --------------------------------------------------------------------------

/** Parses a location hash ("#/article/x?section=y") the same way router.ts does. Pure, for tests. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "") || "/";
  const q = raw.indexOf("?");
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const queryPart = q < 0 ? "" : raw.slice(q + 1);
  return { path: pathPart.split("/").filter(Boolean).map(safeDecode), query: new URLSearchParams(queryPart) };
}

function safeDecode(s: string) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** "/article/abc" for a route (segments re-encoded). */
export function routePath(route: Pick<Route, "path">): string {
  return "/" + route.path.map(encodeURIComponent).join("/");
}

const ROUTE_EVENT = "thaliyola:route";

/**
 * The current route. App uses this instead of router.ts's useRoute: it also follows `replaceRoute`
 * (the thaliyola:route event) and scrolls to the top only when the path changes, not on query-only changes.
 */
export function useAppRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    let lastPath = window.location.hash.replace(/^#/, "").split("?")[0] ?? "";
    const onChange = () => {
      const next = parseHash(window.location.hash);
      const path = window.location.hash.replace(/^#/, "").split("?")[0] ?? "";
      setRoute(next);
      if (path !== lastPath) window.scrollTo(0, 0);
      lastPath = path;
    };
    window.addEventListener("hashchange", onChange);
    window.addEventListener(ROUTE_EVENT, onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener(ROUTE_EVENT, onChange);
    };
  }, []);
  return route;
}

/** Changes the URL without a history entry or a scroll (filters, tabs), then tells useAppRoute. Empty values are dropped. */
export function replaceRoute(path: string, query?: Record<string, string | undefined>) {
  window.history.replaceState(window.history.state, "", href(path, query));
  window.dispatchEvent(new Event(ROUTE_EVENT));
}

/** route.query merged over the defaults. Pure, for tests. */
export function readQueryState(query: URLSearchParams, defaults: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...defaults };
  query.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * The next query after a patch: keeps every other key in the URL, applies the patch, and drops empty
 * values and values equal to their default (so default views keep clean URLs). Pure, for tests.
 */
export function patchQueryState(
  query: URLSearchParams,
  patch: Record<string, string | undefined>,
  defaults: Record<string, string> = {},
): Record<string, string> {
  const next: Record<string, string> = {};
  query.forEach((v, k) => {
    next[k] = v;
  });
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === "" || v === defaults[k]) delete next[k];
    else next[k] = v;
  }
  for (const [k, v] of Object.entries(next)) if (v === "" || v === defaults[k]) delete next[k];
  return next;
}

/** "a=1&b=2" for a query object, in key order (stable URLs). Pure, for tests. */
export function serializeQuery(query: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const k of Object.keys(query).sort()) {
    const v = query[k];
    if (v) q.set(k, v);
  }
  return q.toString();
}

/**
 * URL state for filters and tabs. The URL is the single source of truth (no useState copy). Writes drop empty
 * and default values and replace the history entry, or push one with `{ push: true }`. Pages that read every URL
 * value through this (or route.query) may set `keepMountedOnQuery` so typing never remounts them.
 */
export function useQueryState(
  route: Route,
  defaults: Record<string, string> = {},
): [Record<string, string>, (patch: Record<string, string | undefined>, opts?: { push?: boolean }) => void] {
  const defaultsKey = JSON.stringify(defaults);
  const queryKey = route.query.toString();
  const values = useMemo(() => readQueryState(route.query, defaults), [queryKey, defaultsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const routeRef = useRef(route);
  routeRef.current = route;
  const set = useCallback(
    (patch: Record<string, string | undefined>, opts?: { push?: boolean }) => {
      // Read the live URL, so two quick writes in one tick both land.
      const live = parseHash(window.location.hash);
      const base = live.path.join("/") === routeRef.current.path.join("/") ? live : routeRef.current;
      const next = patchQueryState(base.query, patch, JSON.parse(defaultsKey) as Record<string, string>);
      const path = routePath(base);
      if (opts?.push) navigate(path, next);
      else replaceRoute(path, next);
    },
    [defaultsKey],
  );
  return [values, set];
}

// ---- Shortcuts (SPEC §2.10) -----------------------------------------------------------------------

const SHORTCUTS_KEY = "thaliyola.shortcuts";
const SHORTCUTS_EVENT = "thaliyola:shortcuts";

/** The "Single-key shortcuts" switch (WCAG 2.1.4). On by default; stored per browser. */
export function singleKeyShortcutsEnabled(): boolean {
  try {
    return localStorage.getItem(SHORTCUTS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setSingleKeyShortcuts(on: boolean) {
  try {
    if (on) localStorage.removeItem(SHORTCUTS_KEY);
    else localStorage.setItem(SHORTCUTS_KEY, "off");
  } catch {
    /* storage unavailable: applies for this page only */
  }
  singleKeyOverride = on;
  window.dispatchEvent(new Event(SHORTCUTS_EVENT));
}

let singleKeyOverride: boolean | null = null;
const singleKeysOn = () => singleKeyOverride ?? singleKeyShortcutsEnabled();

export interface RegisteredShortcut {
  id: number;
  key: string;
  label: string;
  group: string;
}

let registry: RegisteredShortcut[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Shortcuts registered by mounted pages (with labels), for the shortcut sheet. */
export function useShortcutRegistry(): RegisteredShortcut[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => registry,
    () => registry,
  );
}

const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;
const ACTIVATES = 'button, a[href], summary, input[type="checkbox"], input[type="radio"], [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="radio"], [role="switch"]';

/** "mod+s" → { mod: true, key: "s" }; "A" → Shift+A; "?" → itself. */
function parseCombo(combo: string): { mod: boolean; key: string } {
  const m = /^mod\+(.+)$/i.exec(combo);
  return m ? { mod: true, key: m[1]! } : { mod: false, key: combo };
}

/**
 * Whether a keydown should run a shortcut. Pure (takes the event's facts), for tests:
 * - single keys never fire while typing in a field, nor when single-key shortcuts are off;
 * - Enter and Space are never taken from a focused button, link, summary, checkbox or interactive role;
 * - mod+key combos (⌘ on Mac, Ctrl elsewhere) fire anywhere, including inside fields.
 */
export function shortcutApplies(
  combo: string,
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey?: boolean },
  focus: { typing: boolean; activates: boolean },
  singleKeys: boolean,
): boolean {
  const { mod, key } = parseCombo(combo);
  if (mod) return (e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === key.toLowerCase();
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key !== key) return false;
  if (focus.typing) return false;
  if ((key === "Enter" || key === " ") && focus.activates) return false;
  if (key !== "Escape" && key !== "Enter" && !singleKeys) return false;
  return true;
}

/**
 * Keyboard shortcuts. `keys` maps a key ("j", "A" for Shift+A, "?", "Escape", "mod+s") to its handler.
 * With `target`, keys bind to that element (list-scoped keys) instead of the window. With `labels`, the keys are
 * listed in the shortcut sheet under `group`. The old two-argument call keeps working.
 */
export function useShortcuts(
  keys: Record<string, () => void>,
  enabled = true,
  opts?: { target?: RefObject<HTMLElement | null>; labels?: Record<string, string>; group?: string },
) {
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const target = opts?.target;
  const labelsKey = JSON.stringify(opts?.labels ?? {});
  const group = opts?.group ?? "This page";

  useEffect(() => {
    if (!enabled) return;
    const el: HTMLElement | Window | null = target ? target.current : window;
    if (!el) return;
    const onKey = (ev: Event) => {
      const e = ev as KeyboardEvent;
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      // An open dialog, sheet, menu or popover owns Escape: a page-wide shortcut (e.g. the bulk bar's "Clear")
      // must not swallow it, or the dialog could not be closed from the keyboard.
      if (!target && e.key === "Escape" && t && typeof t.closest === "function" && t.closest("dialog[open], .popover")) return;
      const focus = {
        typing: !!t && (t.isContentEditable || TYPING.test(t.tagName)),
        activates: !!t && typeof t.closest === "function" && !!t.closest(ACTIVATES),
      };
      for (const [combo, fn] of Object.entries(keysRef.current)) {
        if (shortcutApplies(combo, e, focus, singleKeysOn())) {
          e.preventDefault();
          fn();
          return;
        }
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [enabled, target, Object.keys(keys).join("\u0000")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const labels = JSON.parse(labelsKey) as Record<string, string>;
    const entries = Object.entries(labels);
    if (!enabled || !entries.length) return;
    const mine = entries.map(([key, label]) => ({ id: nextId++, key, label, group }));
    registry = [...registry, ...mine];
    emit();
    return () => {
      const ids = new Set(mine.map((m) => m.id));
      registry = registry.filter((r) => !ids.has(r.id));
      emit();
    };
  }, [enabled, labelsKey, group]);
}

/** Re-renders when the single-key switch changes (for the shortcut sheet and KeyHint). */
export function useSingleKeyShortcuts(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(
    (l) => {
      window.addEventListener(SHORTCUTS_EVENT, l);
      return () => window.removeEventListener(SHORTCUTS_EVENT, l);
    },
    singleKeysOn,
    () => true,
  );
  return [on, setSingleKeyShortcuts];
}

// ---- Small utilities --------------------------------------------------------------------------------

/** `value`, settled for `ms` milliseconds. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Whether a media query matches, kept live ("(max-width: 860px)", "(pointer: coarse)"). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (l) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const m = window.matchMedia(query);
      m.addEventListener("change", l);
      return () => m.removeEventListener("change", l);
    },
    () => (typeof window !== "undefined" && !!window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Tells the shell to refetch the sidebar and tab-bar counts (after approve, reject, dismiss, file, status changes). */
export function refreshCounts() {
  window.dispatchEvent(new Event("thaliyola:counts"));
}

// ---- Shell requests (SPEC §2.4–§2.6, §2.11) ------------------------------------------------------------

/** The shell's own panels, which any page may ask for (NotFound's "Search", a Help link, the `c` key). */
export type ShellPanel = "search" | "create" | "shortcuts" | "glossary";
const SHELL_EVENT = "thaliyola:shell";

/** Asks the shell to open one of its panels (the search overlay, Create, the shortcut sheet, the glossary). */
export function openShellPanel(panel: ShellPanel, detail?: { query?: string }) {
  window.dispatchEvent(new CustomEvent(SHELL_EVENT, { detail: { panel, ...detail } }));
}

/** The shell listens with this. */
export function useShellPanelRequests(onRequest: (panel: ShellPanel, detail: { query?: string }) => void) {
  const ref = useRef(onRequest);
  ref.current = onRequest;
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ panel: ShellPanel; query?: string }>).detail;
      if (d?.panel) ref.current(d.panel, { query: d.query });
    };
    window.addEventListener(SHELL_EVENT, on);
    return () => window.removeEventListener(SHELL_EVENT, on);
  }, []);
}

const REMOUNT_EVENT = "thaliyola:remount";

/** Remounts the current page so it loads fresh (Help › Getting started brings Home's checklist back). */
export function remountPage() {
  window.dispatchEvent(new Event(REMOUNT_EVENT));
}

/** A number that changes on every remountPage() call (App adds it to the page key). */
export function useRemountKey(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const on = () => setN((x) => x + 1);
    window.addEventListener(REMOUNT_EVENT, on);
    return () => window.removeEventListener(REMOUNT_EVENT, on);
  }, []);
  return n;
}

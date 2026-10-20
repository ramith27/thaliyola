import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "./api";

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
 * Single-key shortcuts (no modifiers), ignored while typing in a field.
 * `keys` maps a key ("j", "a", "?") to its handler.
 */
export function useShortcuts(keys: Record<string, () => void>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keys, enabled]);
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

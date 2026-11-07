import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

/**
 * Live updates for open pages: whenever knowledge is published (an approval,
 * an owner's edit, a move, a documentation page), connected browsers hear
 * about it over server-sent events and refresh what they show. One process,
 * in memory; a lost event only means a page refreshes on its next visit.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitChanged() {
  bus.emit("changed", { at: Date.now() });
}

export function eventStream(req: Request, res: Response) {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  let pending: NodeJS.Timeout | null = null;
  // Bursts (a docs run publishing pages) collapse into one refresh per second.
  const onChange = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      res.write(`event: changed\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
    }, 1000);
  };
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  bus.on("changed", onChange);
  req.on("close", () => {
    clearInterval(ping);
    if (pending) clearTimeout(pending);
    bus.off("changed", onChange);
  });
}

/**
 * Keyed wake-ups for long-polls (a session waiting for an answer, a listener waiting for a question).
 * Waiters still re-check the database when woken or when their wait ends, so a missed event only
 * delays an answer until the next check. One process; several instances would relay keys over
 * Postgres LISTEN/NOTIFY.
 */
const keyed = new EventEmitter();
keyed.setMaxListeners(0);

export function wake(keys: (string | null | undefined)[]) {
  for (const k of keys) if (k) keyed.emit(k);
}

/** Resolves true when any key fires, false when `ms` passes (or the signal aborts). */
export function waitFor(keys: string[], ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve(false);
    const done = (fired: boolean) => {
      clearTimeout(timer);
      for (const k of keys) keyed.off(k, onFire);
      signal?.removeEventListener("abort", onAbort);
      resolve(fired);
    };
    const onFire = () => done(true);
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    for (const k of keys) keyed.on(k, onFire);
    signal?.addEventListener("abort", onAbort);
  });
}

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import type pg from "pg";
import type { Db } from "../db/pool.js";

/**
 * Live updates for open pages: whenever knowledge is published (an approval,
 * an owner's edit, a move, a documentation page), connected browsers hear
 * about it over server-sent events and refresh what they show.
 *
 * Each process keeps its own subscribers. With several replicas, a relay
 * (startChangeRelay) carries changes between them over Postgres LISTEN/NOTIFY,
 * so a page connected to one pod hears about a write made on another. The
 * message says only that something changed, never what. A lost event only
 * means a page refreshes on its next visit.
 */
export const CHANGES_CHANNEL = "thaliyola_changed";
/** Keyed wake-ups (sessions' long-polls) between replicas: the payload carries only opaque keys (ids). */
export const WAKE_CHANNEL = "thaliyola_wake";

export class ChangeBus {
  /** Tells this process's own notifications apart from other replicas'. */
  readonly instanceId = randomUUID();
  private readonly bus = new EventEmitter();
  private readonly streams = new Set<Response>();
  /** Set by the relay: sends a change to the other replicas. */
  publish: (() => void) | null = null;

  constructor() {
    this.bus.setMaxListeners(0);
  }

  /** A change made here: tells this process's pages now, and the other replicas through the relay. */
  emit() {
    this.deliver();
    this.publish?.();
  }

  /** A change from another replica: tells this process's pages only. */
  deliver() {
    this.bus.emit("changed");
  }

  /** Calls fn on every change; returns the unsubscribe function. */
  subscribe(fn: () => void) {
    this.bus.on("changed", fn);
    return () => void this.bus.off("changed", fn);
  }

  /** Open event streams (pages listening on this process). */
  get openStreams() {
    return this.streams.size;
  }

  stream(req: Request, res: Response) {
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
    const unsubscribe = this.subscribe(onChange);
    this.streams.add(res);
    const done = () => {
      clearInterval(ping);
      if (pending) clearTimeout(pending);
      unsubscribe();
      this.streams.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
  }

  /** Ends every open stream (shutdown): browsers reconnect after a few seconds, to another replica. */
  closeStreams() {
    for (const res of [...this.streams]) res.end();
    this.streams.clear();
  }
}

/** The process's bus. */
export const changes = new ChangeBus();

export function emitChanged() {
  changes.emit();
}

export function eventStream(req: Request, res: Response) {
  changes.stream(req, res);
}

export interface ChangeRelay {
  /** Resolves once the first LISTEN is in place (or failed and a retry is scheduled). */
  ready: Promise<void>;
  /** Whether the relay is listening right now. */
  readonly listening: boolean;
  /** Sends a pending change, stops listening and returns the connection to the pool. */
  stop(): Promise<void>;
}

/**
 * Carries changes between replicas: NOTIFY on CHANGES_CHANNEL when this process emits one (at most one per
 * `publishDelayMs`), and LISTEN on a dedicated pooled connection for the others'. A dropped connection is replaced
 * after `retryMs`; on reconnecting, pages refresh once, since a change may have been missed meanwhile.
 */
export function startChangeRelay(
  db: Db,
  bus: ChangeBus = changes,
  log: (msg: string) => void = (msg) => console.error(`[events] ${msg}`),
  opts: { publishDelayMs?: number; retryMs?: number } = {},
): ChangeRelay {
  const publishDelay = opts.publishDelayMs ?? 100;
  const retryMs = opts.retryMs ?? 5000;
  const payload = JSON.stringify({ from: bus.instanceId });
  let client: pg.PoolClient | null = null;
  let stopped = false;
  let connectedBefore = false;
  let retry: NodeJS.Timeout | null = null;
  let pending: NodeJS.Timeout | null = null;

  const send = () => db.query("SELECT pg_notify($1, $2)", [CHANGES_CHANNEL, payload]).then(
    () => undefined,
    (err: Error) => log(`couldn't tell the other replicas about a change: ${err.message}`),
  );
  bus.publish = () => {
    if (pending || stopped) return;
    pending = setTimeout(() => {
      pending = null;
      void send();
    }, publishDelay);
  };

  relayWake = (keys) =>
    void db.query("SELECT pg_notify($1, $2)", [WAKE_CHANNEL, JSON.stringify({ from: bus.instanceId, keys })]).then(
      () => undefined,
      (err: Error) => log(`couldn't wake waiters on the other replicas: ${err.message}`),
    );

  const onNotification = (msg: pg.Notification) => {
    if (msg.channel === WAKE_CHANNEL) {
      try {
        const m = JSON.parse(msg.payload ?? "{}") as { from?: string; keys?: unknown };
        if (m.from !== bus.instanceId && Array.isArray(m.keys)) wakeLocal(m.keys.filter((k): k is string => typeof k === "string").slice(0, 20));
      } catch {
        // Malformed: waiters re-check the database when their wait ends anyway.
      }
      return;
    }
    if (msg.channel !== CHANGES_CHANNEL) return;
    try {
      if ((JSON.parse(msg.payload ?? "{}") as { from?: string }).from === bus.instanceId) return;
    } catch {
      // Not ours and not well-formed: still only "something changed".
    }
    bus.deliver();
  };

  const drop = (c: pg.PoolClient, err?: Error) => {
    if (client !== c) return;
    client = null;
    c.off("notification", onNotification);
    c.release(err ?? true);
    if (!stopped) {
      log(`lost the change listener${err ? ` (${err.message})` : ""}; reconnecting in ${Math.round(retryMs / 1000)} s`);
      schedule();
    }
  };

  const schedule = () => {
    if (retry || stopped) return;
    retry = setTimeout(() => {
      retry = null;
      void connect();
    }, retryMs);
    retry.unref();
  };

  async function connect() {
    if (stopped) return;
    let c: pg.PoolClient | null = null;
    try {
      c = await db.connect();
      c.on("notification", onNotification);
      const conn = c;
      c.on("error", (err) => drop(conn, err));
      c.on("end", () => drop(conn));
      client = c;
      await c.query(`LISTEN ${CHANGES_CHANNEL}`);
      await c.query(`LISTEN ${WAKE_CHANNEL}`);
      if (stopped) return;
      if (connectedBefore) bus.deliver();
      connectedBefore = true;
    } catch (err) {
      if (c && client === c) drop(c, err as Error);
      else {
        log(`couldn't listen for other replicas' changes: ${(err as Error).message}; retrying in ${Math.round(retryMs / 1000)} s`);
        schedule();
      }
    }
  }

  const ready = connect();
  return {
    ready,
    get listening() {
      return !!client;
    },
    async stop() {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (pending) {
        clearTimeout(pending);
        pending = null;
        await send();
      }
      if (bus.publish) bus.publish = null;
      relayWake = null;
      await ready;
      const c = client;
      client = null;
      if (c) {
        c.off("notification", onNotification);
        // Closed rather than returned to the pool: it carries this relay's listeners.
        c.release(true);
      }
    },
  };
}

/**
 * Keyed wake-ups for long-polls (a session waiting for an answer, a listener waiting for a question).
 * Waiters still re-check the database when woken or when their wait ends, so a missed event only
 * delays an answer until the next check. With several replicas, the change relay carries the keys
 * to the others over Postgres LISTEN/NOTIFY (WAKE_CHANNEL), so a waiter on one pod hears a write on another.
 */
const keyed = new EventEmitter();
keyed.setMaxListeners(0);
/** Set by the change relay: sends keys to the other replicas. */
let relayWake: ((keys: string[]) => void) | null = null;

function wakeLocal(keys: string[]) {
  for (const k of keys) keyed.emit(k);
}

export function wake(keys: (string | null | undefined)[]) {
  const ks = keys.filter((k): k is string => !!k);
  if (!ks.length) return;
  wakeLocal(ks);
  relayWake?.(ks);
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

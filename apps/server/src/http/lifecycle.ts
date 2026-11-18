import type { Server } from "node:http";
import type { NextFunction, Request, Response } from "express";
import type { Db } from "../db/pool.js";

/**
 * Where the process is in its life, for zero-downtime deploys with several replicas. A load balancer or Kubernetes
 * sends traffic only while /readyz says ready: not while the process is starting, not once it is shutting down, and
 * not while it can't reach the database.
 */
export type Phase = "starting" | "ready" | "stopping";

export class Lifecycle {
  phase: Phase = "starting";
  get ready() {
    return this.phase === "ready";
  }
}

/** Resolves to the value, or to "timeout" after ms. */
function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * GET /readyz: 200 when this replica should get traffic, 503 while starting, while shutting down, and when the
 * database doesn't answer within `timeoutMs` (a full pool counts: requests would queue behind it). It says nothing
 * else about the installation.
 */
export function readiness(db: Db, lifecycle: Lifecycle | undefined, timeoutMs = 2000) {
  return async (_req: Request, res: Response) => {
    res.set("Cache-Control", "no-store");
    const phase = lifecycle?.phase ?? "ready";
    if (phase !== "ready") return void res.status(503).json({ ready: false, phase });
    const db_ok = await within(
      db.query("SELECT 1").then(
        () => true,
        () => false,
      ),
      timeoutMs,
    );
    if (db_ok !== true) return void res.status(503).json({ ready: false, phase, database: db_ok === "timeout" ? "timeout" : "unreachable" });
    res.json({ ready: true, phase, database: "ok" });
  };
}

/** While shutting down, answers in-flight keep-alive connections with Connection: close so clients reconnect elsewhere. */
export function drainConnections(lifecycle: Lifecycle | undefined) {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (lifecycle?.phase === "stopping") res.set("Connection", "close");
    next();
  };
}

/**
 * Stops taking new connections and waits up to graceMs for in-flight requests to finish; then closes whatever is
 * left. Resolves "drained" or "timeout".
 */
export function closeServer(server: Server, graceMs: number): Promise<"drained" | "timeout"> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve("drained");
    // Keep-alive connections become idle as their last request finishes: close them as they do.
    const sweep = setInterval(() => server.closeIdleConnections(), 100);
    const timer = setTimeout(() => {
      clearInterval(sweep);
      server.closeAllConnections();
      resolve("timeout");
    }, graceMs);
    timer.unref();
    server.close(() => {
      clearInterval(sweep);
      clearTimeout(timer);
      resolve("drained");
    });
    server.closeIdleConnections();
  });
}

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown> | unknown;
  /** Time to keep back for the steps after this one, so a step that can't be hurried doesn't use up all of it. */
  reserveMs?: number;
}

/**
 * What runs after the server stops taking requests. Notifications the requests queued go out first, so a job run
 * that can't be interrupted (a long advisory refresh) doesn't leave them no time; the jobs then get what's left
 * minus `reserveMs`, which still covers the notifications their runs queued, the change relay and closing the pool.
 */
export function drainSteps(p: {
  jobs: () => Promise<unknown>;
  flush: () => Promise<unknown>;
  relay: () => Promise<unknown>;
  closePool: () => Promise<unknown>;
  reserveMs: number;
}): ShutdownStep[] {
  return [
    { name: "notifications", run: p.flush },
    { name: "background jobs", run: p.jobs, reserveMs: p.reserveMs },
    { name: "notifications from jobs", run: p.flush },
    { name: "change relay", run: p.relay },
    { name: "database pool", run: p.closePool },
  ];
}

/**
 * Graceful shutdown: readiness goes to 503 at once, then each step runs in order, all within timeoutMs. A step that
 * fails or runs out of time is logged and the next one runs, so the pool is always closed last. Resolves true when
 * everything finished in time.
 */
export async function shutdown(
  lifecycle: Lifecycle,
  opts: { server: Server; timeoutMs: number; before?: ShutdownStep[]; after?: ShutdownStep[]; log?: (msg: string) => void },
): Promise<boolean> {
  const log = opts.log ?? ((msg: string) => console.log(`[shutdown] ${msg}`));
  lifecycle.phase = "stopping";
  const deadline = Date.now() + opts.timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  let clean = true;
  const step = async (s: ShutdownStep) => {
    try {
      // Each step gets at least a second, so the pool is still closed after a slow drain.
      const r = await within(Promise.resolve().then(s.run), Math.max(left() - (s.reserveMs ?? 0), 1000));
      if (r === "timeout") {
        clean = false;
        log(`${s.name}: still running when time was up`);
      }
    } catch (err) {
      clean = false;
      log(`${s.name} failed: ${(err as Error).message}`);
    }
  };
  for (const s of opts.before ?? []) await step(s);
  const http = await closeServer(opts.server, Math.max(left(), 1));
  if (http === "timeout") {
    clean = false;
    log("requests still running when time was up were cut off");
  }
  for (const s of opts.after ?? []) await step(s);
  return clean;
}

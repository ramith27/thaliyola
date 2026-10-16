import type { NextFunction, Request, Response } from "express";
import type { Actor } from "../core/context.js";

/**
 * Per-user request budget (fixed one-minute windows, in memory). Stops a
 * runaway agent loop from hammering the server; humans never get near it.
 */
export function rateLimitPerActor(perMinute: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (_req: Request, res: Response, next: NextFunction) => {
    const actor = res.locals.actor as Actor | undefined;
    if (!actor || perMinute <= 0) return next();
    const now = Date.now();
    let w = windows.get(actor.id);
    if (!w || now - w.start >= 60_000) {
      w = { start: now, count: 0 };
      windows.set(actor.id, w);
      if (windows.size > 50_000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k);
    }
    if (++w.count > perMinute) {
      res.set("Retry-After", String(Math.ceil((w.start + 60_000 - now) / 1000)));
      res.status(429).json({ error: "rate limit exceeded; slow down" });
      return;
    }
    next();
  };
}

/** One JSON line per request: method, path (no query string), status, duration, who. */
export function accessLog(write: (line: string) => void = (l) => process.stdout.write(`${l}\n`)) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      if (req.path === "/healthz") return;
      const actor = res.locals.actor as Actor | undefined;
      write(
        JSON.stringify({
          t: new Date().toISOString(),
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Number((Number(process.hrtime.bigint() - start) / 1e6).toFixed(1)),
          user: actor?.id,
        }),
      );
    });
    next();
  };
}

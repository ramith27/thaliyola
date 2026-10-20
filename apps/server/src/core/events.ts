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

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth, type Authenticator } from "../auth/index.js";
import type { Settings } from "../config.js";
import type { Actor } from "../core/context.js";
import type { Db } from "../db/pool.js";
import { buildMcpServer } from "../mcp/server.js";
import { apiRouter } from "./api.js";

const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

export function createApp(db: Db, authenticate: Authenticator, settings: Settings, webDist: string = DEFAULT_WEB_DIST) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", async (_req, res) => {
    await db.query("SELECT 1");
    res.json({ ok: true });
  });

  // Stateless streamable HTTP: a fresh server + transport per request, bound to the caller.
  app.use("/api", requireAuth(db, authenticate), apiRouter(db, settings));

  app.post("/mcp", requireAuth(db, authenticate), async (req, res) => {
    const server = buildMcpServer({
      db,
      settings,
      actor: res.locals.actor as Actor,
      project: req.header("x-cairn-project") || undefined,
      component: req.header("x-cairn-component") || undefined,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // No server-initiated streams or sessions in stateless mode.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  // Web UI: static assets plus SPA fallback. Auth happens on the API calls it makes.
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/|mcp$|healthz$).*/, (_req, res) => {
      res.set("Cache-Control", "no-cache").sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  return app;
}

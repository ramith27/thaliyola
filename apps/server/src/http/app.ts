import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth, type Authenticator } from "../auth/index.js";
import { oauthRouter } from "../auth/oauth.js";
import type { Settings } from "../config.js";
import type { Embedder } from "../core/embeddings.js";
import type { Actor } from "../core/context.js";
import type { Db } from "../db/pool.js";
import { buildMcpServer } from "../mcp/server.js";
import { isAdmin } from "../core/permissions.js";
import { apiErrorHandler, apiRouter } from "./api.js";
import { accessLog, rateLimitPerActor } from "./middleware.js";
import { accountRouter, publicAuthRouter, requirePasswordChanged } from "./auth.js";

const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist");

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

export interface AppOptions {
  db: Db;
  authenticate: Authenticator;
  settings: Settings;
  /** Built web UI; served at / when present. */
  webDist?: string;
  /** Enables semantic search and duplicate detection. */
  embedder?: Embedder;
  /** Called after writes so background indexing can pick up new chunks. */
  onWrite?: () => void;
}

export function createApp({ db, authenticate, settings, webDist = DEFAULT_WEB_DIST, embedder, onWrite }: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  // Honour X-Forwarded-* from a proxy or tunnel on the same machine (secure cookies, client IP for login throttling).
  app.set("trust proxy", "loopback");
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  if (settings.logRequests) app.use(accessLog());
  const rateLimit = rateLimitPerActor(settings.rateLimitPerMinute);
  // Small bodies for everyone; the two routes that carry base64 uploads get a larger limit, but only after auth.
  const UPLOAD_PATHS = new Set(["/mcp", "/api/assets"]);
  const smallJson = express.json({ limit: "1mb" });
  const uploadJson = express.json({ limit: Math.ceil(settings.assetMaxBytes * 1.4) + 1024 * 1024 });
  app.use((req, res, next) => (UPLOAD_PATHS.has(req.path) ? next() : smallJson(req, res, next)));

  app.get("/healthz", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ ok: true, database: "ok", embeddings: embedder ? embedder.model : "off" });
    } catch {
      res.status(503).json({ ok: false, database: "unreachable" });
    }
  });

  // Stateless streamable HTTP: a fresh server + transport per request, bound to the caller.
  app.use("/auth", publicAuthRouter(db, settings));

  // OAuth server for local mode (claude.ai connectors and other OAuth-only MCP clients).
  const oauth = settings.authMode === "local" && settings.publicUrl ? oauthRouter(db, settings, new URL(settings.publicUrl)) : undefined;
  if (oauth) app.use(oauth.router);
  app.use(
    "/api",
    requireAuth(db, authenticate),
    rateLimit,
    (req: Request, res: Response, next: NextFunction) => (req.path === "/assets" ? uploadJson(req, res, next) : next()),
    requirePasswordChanged,
    accountRouter(db, settings, (actor) => isAdmin({ db, actor, settings })),
    apiRouter({ db, settings, embedder, onWrite }),
    apiErrorHandler,
  );

  app.post("/mcp", requireAuth(db, authenticate, oauth?.resourceMetadataUrl), rateLimit, uploadJson, requirePasswordChanged, async (req, res) => {
    const server = buildMcpServer({
      db,
      settings,
      embedder,
      onWrite,
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
    app.get(/^\/(?!api\/|auth\/|oauth\/|\.well-known\/|mcp$|healthz$|authorize$|token$|register$|revoke$).*/, (_req, res) => {
      res.set("Cache-Control", "no-cache").sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    // Body-parser errors are the client's: oversized or malformed JSON.
    const type = (err as { type?: string })?.type;
    if (type === "entity.too.large") return void res.status(413).json({ error: "request body too large" });
    if (type === "entity.parse.failed") return void res.status(400).json({ error: "malformed JSON" });
    console.error(err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

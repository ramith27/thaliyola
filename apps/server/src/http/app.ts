import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireAuth, type Authenticator } from "../auth/index.js";
import { oauthRouter } from "../auth/oauth.js";
import type { Settings } from "../config.js";
import type { Embedder } from "../core/embeddings.js";
import type { Actor } from "../core/context.js";
import type { Db } from "../db/pool.js";
import { emitChanged } from "../core/events.js";
import { useDeliveryPool } from "../core/connections/routes.js";
import { resolveRepo } from "../core/scopes.js";
import { uploadWithToken } from "../core/security.js";
import { NotFoundError, ValidationError } from "../core/context.js";
import { buildMcpServer } from "../mcp/server.js";
import { isClaudeCode, type SkillMcpOpts } from "../mcp/skills.js";
import { deliverableSkills, rankedForInstructions, skillPromptsFor } from "../core/skills/delivery.js";
import { receiveSkillWebhook } from "../core/skills/sources.js";
import { receiveWebhook } from "../core/sources.js";
import { receiveGitWebhook } from "../core/briefings.js";
import { SKILL_LIMITS } from "../core/skills/types.js";
import type { RequestContext } from "../core/context.js";
import { isAdmin } from "../core/permissions.js";
import { buildInfo } from "../core/version.js";
import { apiErrorHandler, apiRouter } from "./api.js";
import { accessLog, rateLimitPerActor } from "./middleware.js";
import { drainConnections, readiness, type Lifecycle } from "./lifecycle.js";
import { actionsRouter, notificationsRouter } from "./notifications.js";
import { accountRouter, publicAuthRouter, requirePasswordChanged } from "./auth.js";

const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/dist");
/** The sync script in the repository, for when the web build doesn't carry it (development, tests). */
const SKILLS_SYNC_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/public/skills-sync.py");

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
  /** Starting / ready / stopping, for /readyz; absent means always ready (tests). */
  lifecycle?: Lifecycle;
  /** Express "trust proxy": which proxies' X-Forwarded-For / -Proto to believe (TRUST_PROXY). Default: loopback only. */
  trustProxy?: boolean | number | string;
}

/** The static site viewer build sits next to the web build (dev: apps/web/dist-viewer; installed: /opt/thaliyola/viewer). */
function viewerDirFor(webDist: string) {
  const installed = path.join(path.dirname(webDist), "viewer");
  return existsSync(installed) ? installed : path.join(path.dirname(webDist), "dist-viewer");
}

/**
 * What the MCP server needs to know about the caller's skills for this request, from the JSON-RPC message(s): the
 * client and the caller's skills on initialize (the instructions lead with them) and on tools/list (list_skills' and
 * get_skill's descriptions), the skill prompts on prompts/list and prompts/get. Other calls pay nothing.
 */
async function skillOptsFor(ctx: RequestContext, body: unknown): Promise<SkillMcpOpts> {
  const messages = (Array.isArray(body) ? body : [body]).filter((m): m is { method?: string; params?: { clientInfo?: { name?: unknown } } } => !!m && typeof m === "object");
  const methods = new Set(messages.map((m) => m.method));
  const opts: SkillMcpOpts = { deliver: false, client: "other" };
  try {
    if (methods.has("initialize")) {
      opts.client = isClaudeCode(messages.find((m) => m.method === "initialize")?.params?.clientInfo?.name) ? "claude_code" : "other";
    }
    // initialize: the instructions lead with the caller's skills; tools/list: list_skills' and get_skill's descriptions.
    if (methods.has("initialize") || methods.has("tools/list")) {
      const { delivery, skills } = await deliverableSkills(ctx);
      opts.deliver = delivery.state === "on";
      const ordered = methods.has("initialize") ? await rankedForInstructions(ctx, skills) : skills;
      opts.catalog = ordered.map((s) => ({ name: s.name, description: s.description }));
    }
    if (methods.has("prompts/list") || methods.has("prompts/get")) opts.prompts = await skillPromptsFor(ctx);
  } catch (err) {
    console.error(`[skills] couldn't load the caller's skills for MCP: ${(err as Error).message}`);
  }
  return opts;
}

export function createApp({ db, authenticate, settings, webDist = DEFAULT_WEB_DIST, embedder, onWrite: onWriteHook, lifecycle, trustProxy = "loopback" }: AppOptions) {
  // Slack and Trello deliveries finish after the request (and its transaction) that raised them: they record on the pool.
  useDeliveryPool(db);
  // Every published change re-indexes (if configured) and tells open pages to refresh.
  const onWrite = () => {
    onWriteHook?.();
    emitChanged();
  };
  const app = express();
  app.disable("x-powered-by");
  // Honour X-Forwarded-* from a proxy or tunnel on the same machine (secure cookies, client IP for login throttling),
  // or from the proxies TRUST_PROXY names (a load balancer in front of several replicas).
  app.set("trust proxy", trustProxy);
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  app.use(drainConnections(lifecycle));
  if (settings.logRequests) app.use(accessLog());
  const rateLimit = rateLimitPerActor(settings.rateLimitPerMinute);
  const publicOrigin = settings.publicUrl ? new URL(settings.publicUrl).origin : undefined;
  // Small bodies for everyone; the routes that carry uploads get a larger limit, but only after auth.
  const UPLOAD_PATHS = new Set(["/mcp", "/api/assets", "/api/import", "/api/dependencies", "/api/skills/import/upload"]);
  // Creating a skill or proposing a version (the web editor) sends its files as JSON.
  const SKILL_EDIT_PATH = /^\/api\/skills(?:\/[^/]+\/versions)?$/;
  const smallJson = express.json({ limit: "1mb" });
  const uploadJson = express.json({ limit: Math.ceil(settings.assetMaxBytes * 1.4) + 1024 * 1024 });
  // A whole skill fits in one call: up to SKILL_LIMITS.skillBytes of files, as base64 (4/3) or escaped JSON text.
  const skillJsonBytes = Math.ceil(SKILL_LIMITS.skillBytes * 1.5) + 2 * 1024 * 1024;
  const skillJson = express.json({ limit: skillJsonBytes });
  // MCP carries uploads (upload_asset) and whole skills (propose_skill), so it takes the larger of the two.
  const mcpJson = express.json({ limit: Math.max(Math.ceil(settings.assetMaxBytes * 1.4) + 1024 * 1024, skillJsonBytes) });
  const importRaw = express.raw({ type: () => true, limit: settings.importMaxBytes });
  const lockfilesRaw = express.raw({ type: () => true, limit: "25mb" });
  const skillsRaw = express.raw({ type: () => true, limit: settings.skills?.importMaxBytes ?? 50 * 1024 * 1024 });
  // A skill source's push webhook reads its raw body (GitHub signs the exact bytes).
  const SKILL_WEBHOOK_PATH = /^\/api\/skill-sources\/[^/]+\/webhook$/;
  const webhookRaw = express.raw({ type: () => true, limit: "5mb" });
  app.use((req, res, next) =>
    UPLOAD_PATHS.has(req.path) || SKILL_EDIT_PATH.test(req.path) || SKILL_WEBHOOK_PATH.test(req.path) || req.path.startsWith("/deps/upload/") ? next() : smallJson(req, res, next),
  );

  app.get("/healthz", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ ok: true, database: "ok", embeddings: embedder ? embedder.model : "off", ...buildInfo() });
    } catch {
      res.status(503).json({ ok: false, database: "unreachable", ...buildInfo() });
    }
  });
  // Kubernetes probes. Liveness: the process answers (never the database, so an outage doesn't restart every pod).
  // Readiness: send this replica traffic (not while starting or shutting down, or without its database).
  app.get("/livez", (_req, res) => void res.set("Cache-Control", "no-store").json({ ok: true }));
  app.get("/readyz", readiness(db, lifecycle));

  // Stateless streamable HTTP: a fresh server + transport per request, bound to the caller.
  // Lockfile upload through a one-time link from scan_dependencies: the link is the credential.
  app.post("/deps/upload/:token", lockfilesRaw, async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return void res.status(400).type("text/plain").send("Send the tar.gz of lockfiles as the request body.\n");
      const r = await uploadWithToken(db, settings, String(req.params.token), req.body);
      res.json(r);
    } catch (err) {
      const status = err instanceof NotFoundError ? 404 : err instanceof ValidationError ? 400 : 500;
      if (status === 500) console.error(err);
      res.status(status).json({ error: status === 500 ? "upload failed" : (err as Error).message });
    }
  });
  // GitLab / GitHub push webhook of a skill source: no sign-in, the source's webhook secret is the credential.
  app.post("/api/skill-sources/:id/webhook", webhookRaw, async (req, res) => {
    try {
      const headers: Record<string, string | undefined> = {};
      for (const name of ["x-gitlab-token", "x-gitlab-event", "x-hub-signature-256", "x-github-event"]) headers[name] = req.header(name) ?? undefined;
      const out = await receiveSkillWebhook(db, settings, String(req.params.id), headers, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      if (out.status === 429) res.set("Retry-After", "60");
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error(`[skills] webhook failed: ${(err as Error).message}`);
      res.status(500).json({ error: "webhook failed" });
    }
  });
  // Pull-request webhooks of a git connection (PR briefings): the connection's webhook secret is the credential.
  app.post("/hooks/git/:id", webhookRaw, async (req, res) => {
    try {
      const headers: Record<string, string | undefined> = {};
      for (const name of ["x-gitlab-token", "x-gitlab-event", "x-hub-signature-256", "x-github-event"]) headers[name] = req.header(name) ?? undefined;
      const out = await receiveGitWebhook(db, settings, String(req.params.id), headers, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      res.status(out.status).json(out.body);
    } catch (err) {
      console.error(`[briefings] webhook failed: ${(err as Error).message}`);
      res.status(500).json({ error: "webhook failed" });
    }
  });
  // Webhook sources (GitHub merged PRs, Sentry resolved issues): the secret in the URL is the credential.
  app.post("/hooks/sources/:id/:token", express.json({ limit: "2mb" }), async (req, res) => {
    try {
      const headers: Record<string, string | undefined> = {};
      for (const name of ["x-github-event", "sentry-hook-resource"]) headers[name] = req.header(name) ?? undefined;
      const out = await receiveWebhook(db, String(req.params.id), String(req.params.token), headers, req.body, settings);
      if (out.status === 404) return void res.status(404).json({ error: "not found" });
      res.status(out.status).json({ result: out.result });
    } catch (err) {
      console.error(`[sources] webhook failed: ${(err as Error).message}`);
      res.status(500).json({ error: "webhook failed" });
    }
  });
  app.use("/auth", publicAuthRouter(db, settings));
  app.use("/actions", actionsRouter(db, settings));

  // OAuth server for local mode (claude.ai connectors and other OAuth-only MCP clients).
  const oauth = settings.authMode === "local" && settings.publicUrl ? oauthRouter(db, settings, new URL(settings.publicUrl)) : undefined;
  if (oauth) app.use(oauth.router);
  app.use(
    "/api",
    requireAuth(db, settings, authenticate, undefined, publicOrigin),
    rateLimit,
    (req: Request, res: Response, next: NextFunction) => (req.path === "/assets" ? uploadJson(req, res, next) : next()),
    (req: Request, res: Response, next: NextFunction) => (req.path === "/import" ? importRaw(req, res, next) : next()),
    (req: Request, res: Response, next: NextFunction) => (req.path === "/dependencies" ? lockfilesRaw(req, res, next) : next()),
    (req: Request, res: Response, next: NextFunction) => (req.path === "/skills/import/upload" ? skillsRaw(req, res, next) : next()),
    (req: Request, res: Response, next: NextFunction) => (SKILL_EDIT_PATH.test(`/api${req.path}`) ? skillJson(req, res, next) : next()),
    requirePasswordChanged,
    accountRouter(db, settings, (actor) => isAdmin({ db, actor, settings })),
    notificationsRouter(db, settings),
    apiRouter({ db, settings, embedder, onWrite, viewerDir: viewerDirFor(webDist) }),
    apiErrorHandler,
  );

  app.post("/mcp", requireAuth(db, settings, authenticate, oauth?.resourceMetadataUrl, publicOrigin), rateLimit, mcpJson, requirePasswordChanged, async (req, res) => {
    // The project comes from X-Thaliyola-Project, or from the repository the session runs in (X-Thaliyola-Repo: git remote URL).
    let project = req.header("x-thaliyola-project") || undefined;
    let component = req.header("x-thaliyola-component") || undefined;
    const repo = req.header("x-thaliyola-repo");
    if (repo && !project) {
      const found = await resolveRepo(db, repo).catch(() => null);
      if (found) {
        project = found.project;
        component ??= found.component;
      }
    }
    const ctx: RequestContext = { db, settings, embedder, onWrite, actor: res.locals.actor as Actor, project, component };
    const server = buildMcpServer(ctx, { skills: await skillOptsFor(ctx, req.body) });
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

  // The Claude Code skills sync script (public, no secrets in it), with this server's address filled in.
  app.get("/skills-sync.py", (req, res) => {
    const origin = settings.publicUrl ?? `${req.protocol}://${req.header("host")}`;
    const file = [path.join(webDist, "skills-sync.py"), SKILLS_SYNC_SOURCE].find((f) => existsSync(f));
    if (!/^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)?$/.test(origin) || !file) return void res.status(404).type("text/plain").send("Not available\n");
    res.set("Cache-Control", "no-cache").type("text/x-python").send(readFileSync(file, "utf8").replaceAll("__THALIYOLA_URL__", origin.replace(/\/+$/, "")));
  });
  app.delete("/mcp", methodNotAllowed);

  // Web UI: static assets plus SPA fallback. Auth happens on the API calls it makes.
  if (existsSync(webDist)) {
    // Install script for agent hosts, with this server's address filled in.
    app.get("/connect.sh", (req, res) => {
      const origin = settings.publicUrl ?? `${req.protocol}://${req.header("host")}`;
      const file = path.join(webDist, "connect.sh");
      if (!/^https?:\/\/[A-Za-z0-9.\-:[\]]+(\/[A-Za-z0-9._~\-/]*)?$/.test(origin) || !existsSync(file)) return void res.status(404).type("text/plain").send("Not available\n");
      res.set("Cache-Control", "no-cache").type("text/x-shellscript").send(readFileSync(file, "utf8").replaceAll("__THALIYOLA_URL__", origin.replace(/\/+$/, "")));
    });
    app.use(express.static(webDist, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/|auth\/|oauth\/|actions\/|\.well-known\/|mcp$|healthz$|readyz$|livez$|authorize$|token$|register$|revoke$|skills-sync\.py$).*/, (_req, res) => {
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

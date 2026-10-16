import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { requireAuth, type Authenticator } from "../auth/index.js";
import type { Settings } from "../config.js";
import type { Actor } from "../core/context.js";
import type { Db } from "../db/pool.js";
import { buildMcpServer } from "../mcp/server.js";
import { apiRouter } from "./api.js";

export function createApp(db: Db, authenticate: Authenticator, settings: Settings) {
  const app = express();
  app.disable("x-powered-by");
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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  });

  return app;
}

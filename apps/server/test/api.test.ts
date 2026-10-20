import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let server: Server;
let base: string;

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  const web = mkdtempSync(path.join(tmpdir(), "thaliyola-web-"));
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Thaliyola</title>");
  server = createApp({ db, authenticate: devAuthenticator("user=alice@example.com,admin=admin@example.com"), settings: TEST_SETTINGS, webDist: web }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

async function call(token: string, method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

describe("REST API", () => {
  it("lists scopes with components and the type vocabularies", async () => {
    const { body } = await call("user", "GET", "/api/scopes");
    expect(body.scopes.map((s: { slug: string }) => s.slug)).toEqual(["team", "library", "merchant-portal", "order-service"]);
    expect(body.scopes[3].components.map((c: { slug: string }) => c.slug)).toEqual(["backend", "frontend"]);
    expect(body.article_types).toContain("screen_spec");
  });

  it("searches with comma-separated filters and rejects bad ones", async () => {
    const ok = await call("user", "GET", "/api/search?q=checkout&scope=all&types=rca,runbook");
    expect(ok.status).toBe(200);
    expect(ok.body.findings[0].id).toBe(ids.rca);
    const bad = await call("user", "GET", "/api/search?q=x&statuses=bogus");
    expect(bad.status).toBe(400);
  });

  it("queues a non-owner's edit but publishes an admin's edit directly", async () => {
    const article = (await call("user", "GET", `/api/articles/${ids.overview}`)).body;
    const proposal = await call("user", "PUT", `/api/articles/${ids.overview}`, {
      version: article.version,
      summary: "Mention the refunds worker",
      body_md: `${article.body_md}\n\n## Workers\nA refunds worker drains the queue.`,
    });
    expect(proposal.body).toMatchObject({ status: "pending_review", published: false });

    const direct = await call("admin", "PUT", `/api/articles/${ids.overview}`, {
      version: article.version,
      summary: "Rename",
      title: "Order service v2: overview",
      body_md: article.body_md,
    });
    expect(direct.body).toMatchObject({ status: "published", published: true, version: article.version + 1 });
    expect((await call("user", "GET", `/api/articles/${ids.overview}`)).body.title).toBe("Order service v2: overview");

    // The queued proposal is now based on an old version.
    const rev = await call("admin", "GET", `/api/revisions/${proposal.body.revision_id}`);
    expect(rev.body.stale).toBe(true);
    expect((await call("admin", "POST", `/api/revisions/${proposal.body.revision_id}/approve`)).status).toBe(409);
  });

  it("creates findings from the UI, with duplicate detection", async () => {
    const created = await call("admin", "POST", "/api/findings", {
      scope: "team",
      type: "query_recipe",
      title: "Daily active merchants query",
      symptoms: "Need the count of merchants with at least one order per day.",
      root_cause: "Use analytics.daily_orders grouped by merchant_id and day.",
    });
    expect(created.body).toMatchObject({ published: true });
    const dup = await call("user", "POST", "/api/findings", {
      scope: "team",
      type: "query_recipe",
      title: "Daily active merchants",
      symptoms: "Need the count of merchants with at least one order per day.",
      root_cause: "Group analytics.daily_orders by merchant_id and day.",
    });
    expect(dup.body.status).toBe("duplicates_found");
  });

  it("verifies entries and acknowledges notices", async () => {
    const v = await call("user", "POST", `/api/verify/${ids.runbook}`, { still_valid: true });
    expect(v.body.status).toBe("verified");
    const notices = await call("user", "GET", "/api/projects/order-service/notices?component=frontend");
    const id = notices.body.notices[0].id;
    expect((await call("user", "POST", `/api/notices/${id}/ack`)).body.state).toBe("acked");
  });

  it("returns everything needed to connect tools", async () => {
    const { body } = await call("user", "GET", "/api/connect-info");
    expect(body.mcp_url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(body.account).toMatchObject({ email: "alice@example.com", admin: false });
    expect(body.projects.map((p: { slug: string }) => p.slug)).toEqual(["merchant-portal", "order-service"]);
    expect(body.projects[1].components).toEqual(["backend", "frontend"]);
    expect(body.catalog.tools).toHaveLength(40);
    expect(body.catalog.prompts.map((p: { name: string }) => p.name)).toContain("start-coding");
    expect(body.catalog.instructions).toMatch(/search_knowledge first/);
    expect(body.has_connected).toBe(false);
  });

  it("serves dashboard insights with zero-filled series", async () => {
    const { body } = await call("user", "GET", "/api/insights");
    expect(body.totals).toMatchObject({ projects: 2 });
    expect(body.totals.articles).toBeGreaterThan(5);
    expect(body.growth).toHaveLength(12);
    expect(body.activity).toHaveLength(30);
    expect(body.statuses.published).toBeGreaterThan(0);
    expect(body.types[0]).toHaveProperty("n");
  });

  it("serves the knowledge graph with edges between visible nodes only", async () => {
    const { body } = await call("user", "GET", "/api/graph");
    const ids = new Set(body.nodes.map((n: { id: string }) => n.id));
    expect(body.nodes.some((n: { kind: string }) => n.kind === "component")).toBe(true);
    expect(body.edges.length).toBeGreaterThan(3);
    expect(body.edges.every((e: { source: string; target: string }) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    expect(body.edges.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["uses", "consumed_by", "part_of"]));
    const scoped = await call("user", "GET", "/api/graph?scope=library");
    expect(scoped.body.nodes.every((n: { scope: string }) => n.scope === "library")).toBe(true);
  });

  it("focuses the graph on one item's neighbourhood", async () => {
    const { body } = await call("user", "GET", `/api/graph?focus=${ids.screen}&depth=1`);
    const labels = body.nodes.map((n: { label: string }) => n.label).sort();
    expect(labels).toEqual(expect.arrayContaining(["Orders list screen", "Data table", "Orders API v1"]));
    expect(labels).not.toContain("Checkout error-rate alert");
    const two = await call("user", "GET", `/api/graph?focus=${ids.screen}&depth=2`);
    // Two hops reach the contract's consumer component and, through it, the project.
    expect(two.body.nodes.some((n: { kind: string }) => n.kind === "component")).toBe(true);
    expect(two.body.nodes.some((n: { kind: string }) => n.kind === "project")).toBe(true);
  });

  it("returns JSON 404 for unknown API routes and audits API calls", async () => {
    const res = await call("user", "GET", "/api/nope");
    expect(res).toEqual({ status: 404, body: { error: "not found" } });
    const { rows } = await db.query("SELECT DISTINCT tool FROM audit_log WHERE tool LIKE 'api:%'");
    expect(rows.map((r) => r.tool)).toEqual(expect.arrayContaining(["api:search", "api:edit_article", "api:get_revision"]));
  });
});

describe("web UI hosting", () => {
  it("serves the SPA with security headers, without auth, for client routes", async () => {
    const res = await fetch(`${base}/review/123`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>Thaliyola</title>");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps /mcp and /api off the SPA fallback", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/api/scopes`)).status).toBe(401);
  });
});

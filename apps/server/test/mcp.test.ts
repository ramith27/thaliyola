import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let server: Server;
let url: URL;

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  server = createApp(db, devAuthenticator("secret-token=alice@example.com,admin-token=admin@example.com"), TEST_SETTINGS).listen(0);
  await new Promise((r) => server.once("listening", r));
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

async function connect(headers: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

function json(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

describe("MCP over streamable HTTP", () => {
  it("rejects requests without a valid token", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists the read tools and carries usage instructions", async () => {
    const client = await connect({ authorization: "Bearer secret-token" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ack_notice", "add_source_link", "browse_kb", "create_article", "get_article", "get_article_template", "get_asset", "get_finding",
      "get_project_context", "link_entries", "list_impact_notices", "list_projects", "list_review_queue",
      "promote_finding", "propose_article_edit", "propose_finding", "search_knowledge", "share_to_library",
      "update_finding", "upload_asset", "verify_entry",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).not.toContain("propose_finding");
    expect(client.getInstructions()).toMatch(/search_knowledge first/);
    await client.close();
  });

  it("uses the X-Cairn-Project/Component headers as defaults and audits calls", async () => {
    const client = await connect({
      authorization: "Bearer secret-token",
      "x-cairn-project": "order-service",
      "x-cairn-component": "frontend",
    });
    const ctx = json(await client.callTool({ name: "get_project_context", arguments: {} }));
    expect(ctx.note).toMatch(/not instructions/);
    expect(ctx.component.slug).toBe("frontend");
    expect(ctx.contracts.consumes[0].id).toBe(ids.contract);

    const search = json(await client.callTool({ name: "search_knowledge", arguments: { query: "stuck orders refund" } }));
    expect(search.articles.map((h: { id: string }) => h.id)).toContain(ids.screen);

    const finding = json(await client.callTool({ name: "get_finding", arguments: { id: ids.rca } }));
    expect(finding.root_cause).toMatch(/rate limit/);

    const { rows } = await db.query(
      `SELECT l.tool, l.target_id, u.email FROM audit_log l JOIN users u ON u.id = l.actor_id ORDER BY l.id`,
    );
    expect(rows.map((r) => r.tool)).toEqual(["get_project_context", "search_knowledge", "get_finding"]);
    expect(rows[2]).toMatchObject({ target_id: ids.rca, email: "alice@example.com" });
    await client.close();
  });

  it("proposes over MCP, approves over REST as an admin, and refuses non-admin approval", async () => {
    const client = await connect({ authorization: "Bearer secret-token", "x-cairn-project": "order-service" });
    const proposed = json(
      await client.callTool({
        name: "propose_finding",
        arguments: {
          type: "known_issue",
          title: "Coupon codes are case-sensitive",
          symptoms: "Customers report valid coupon SAVE10 rejected when typed as save10.",
          root_cause: "Coupon lookup compares codes exactly.",
          components: ["backend"],
        },
      }),
    );
    expect(proposed.status).toBe("pending_review");

    const approve = (token: string) =>
      fetch(new URL(`/api/revisions/${proposed.revision_id}/approve`, url), { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const denied = await approve("secret-token");
    expect(denied.status).toBe(403);
    const ok = await approve("admin-token");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: "approved", item_status: "published" });

    const search = json(await client.callTool({ name: "search_knowledge", arguments: { query: "coupon rejected lowercase" } }));
    expect(search.findings[0].id).toBe(proposed.finding_id);
    await client.close();
  });

  it("returns a version conflict with the current content", async () => {
    const client = await connect({ authorization: "Bearer secret-token" });
    const res = await client.callTool({
      name: "update_finding",
      arguments: { id: ids.rca, version: 99, summary: "x", patch: { fix: "y" } },
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(body.error).toMatch(/Version conflict/);
    expect(body.current.version).toBe(1);
    await client.close();
  });

  it("returns tool errors, not transport errors, for bad input", async () => {
    const client = await connect({ authorization: "Bearer secret-token" });
    const res = await client.callTool({ name: "browse_kb", arguments: { scope: "missing" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/scope 'missing' not found/);
    await client.close();
  });
});

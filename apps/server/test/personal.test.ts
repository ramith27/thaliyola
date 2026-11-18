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
let server: Server;
let base: string;
const TOKENS = "admin=admin@example.com,alice=alice@example.com,bob=bob@example.com,svc=svc-bot@example.com";

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator(TOKENS), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
const clients: Record<string, Client> = {};
afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

async function tool(token: string, name: string, args: Record<string, unknown>, project?: string) {
  const key = `${token}:${project ?? ""}`;
  if (!clients[key]) {
    clients[key] = new Client({ name: "test", version: "0" });
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, ...(project ? { "x-thaliyola-project": project } : {}) };
    await clients[key].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
  }
  const result = await clients[key].callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}
const rest = async (token: string, path: string) => (await fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${token}` } })).json();
const hitIds = (res: { articles: { id: string }[]; findings: { id: string }[] }) => [...res.articles, ...res.findings].map((h) => h.id);

let noteId: string;

describe("personal context", () => {
  it("saves a note that is published at once and comes back in the person's context", async () => {
    expect((await tool("alice", "get_personal_context", {})).notes).toEqual([]);
    const saved = await tool("alice", "save_personal_note", {
      title: "How I like pull requests",
      body_md: "Small pull requests, conventional commit titles, and always run the zebra linter before pushing.",
      tags: ["workflow"],
    });
    expect(saved).toMatchObject({ status: "published", published: true });
    noteId = saved.article_id;
    const context = await tool("alice", "get_personal_context", {});
    expect(context.notes).toEqual([expect.objectContaining({ id: noteId, type: "note", title: "How I like pull requests", tags: ["workflow"] })]);
  });

  it("is found by default search from any project, but not by anyone else, admins included", async () => {
    const fromProject = await tool("alice", "search_knowledge", { query: "zebra linter before pushing" }, "order-service");
    expect(hitIds(fromProject)).toContain(noteId);
    for (const other of ["bob", "admin"]) {
      expect(hitIds(await tool(other, "search_knowledge", { query: "zebra linter before pushing", scope: "all" }))).not.toContain(noteId);
      expect((await tool(other, "get_article", { id: noteId })).error).toMatch(/not found/);
      expect((await rest(other, "/scopes")).scopes.map((s: { slug: string }) => s.slug)).not.toContain(`personal-${await idOf("alice@example.com")}`);
    }
  });

  it("replaces a note's text by id, and only the owner's own notes", async () => {
    const updated = await tool("alice", "save_personal_note", { id: noteId, title: "How I like pull requests", body_md: "Small pull requests. Squash on merge." });
    expect(updated).toMatchObject({ published: true });
    expect((await tool("alice", "get_article", { id: noteId })).body_md).toMatch(/Squash on merge/);
    expect((await tool("bob", "save_personal_note", { id: noteId, title: "x", body_md: "y" })).error).toMatch(/not found/);
  });

  it("takes any article or finding with scope 'me', published without review", async () => {
    const finding = await tool("alice", "propose_finding", {
      scope: "me",
      type: "query_recipe",
      title: "My query for stuck orders",
      symptoms: "need the list of orders stuck in pending",
      root_cause: "n/a",
      fix: "select id from orders where state = 'pending'",
    });
    expect(finding).toMatchObject({ published: true });
    const pending = await db.query("SELECT count(*)::int AS n FROM revisions r JOIN scopes s ON s.id = r.scope_id WHERE s.kind = 'personal' AND r.state = 'pending'");
    expect(pending.rows[0].n).toBe(0);
    expect((await tool("alice", "get_personal_context", {})).findings.map((f: { title: string }) => f.title)).toEqual(["My query for stuck orders"]);
  });

  it("can't be shared or opened up, and its names can't be taken by projects", async () => {
    const slug = `personal-${await idOf("alice@example.com")}`;
    expect((await tool("admin", "set_project_access", { project: slug, email: "bob@example.com", role: "reader" })).error).toBeTruthy();
    expect((await tool("alice", "set_project_access", { project: "me", email: "bob@example.com", role: "reader" })).error).toMatch(/personal space/);
    expect((await tool("alice", "set_project_visibility", { project: "me", visibility: "team" })).error).toMatch(/personal space/);
    expect((await tool("admin", "create_project", { slug: "me", name: "Me" })).error).toMatch(/reserved/);
    expect((await tool("svc", "save_personal_note", { title: "x", body_md: "y" })).error).toMatch(/only people/);
  });
});

const idOf = async (email: string) => (await db.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string;

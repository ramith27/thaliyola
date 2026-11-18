import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { flushDeliveries } from "../src/core/notify.js";
import { upsertUser } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const settings = { ...TEST_SETTINGS, requireApproval: true, defaultProjectVisibility: "members" as const };
const TOKENS = "admin=admin@example.com,alice=alice@example.com,bob=bob@example.com,newbie=newbie@example.com,vip=vip@example.com";

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator(TOKENS), settings }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const email of ["alice@example.com", "bob@example.com"]) await upsertUser(db, { subject: `dev:${email}`, email, kind: "human" });
});
afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

const clients: Record<string, Client> = {};
async function tool(token: string, name: string, args: Record<string, unknown>) {
  if (!clients[token]) {
    clients[token] = new Client({ name: "test", version: "0" });
    await clients[token].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  }
  const result = await clients[token].callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}
const projects = async (token: string) => (await tool(token, "list_projects", {})).projects.map((p: { slug: string }) => p.slug);
const me = async (token: string) => (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).status;

describe("members-only projects and access through MCP", () => {
  it("makes new projects members-only by default, and lets the creator choose", async () => {
    expect(await tool("admin", "create_project", { slug: "secret-app", name: "Secret app" })).toMatchObject({ status: "created", visibility: "members" });
    expect(await tool("admin", "create_project", { slug: "open-app", name: "Open app", visibility: "team" })).toMatchObject({ visibility: "team" });
    expect(await projects("alice")).toEqual(expect.arrayContaining(["open-app"]));
    expect(await projects("alice")).not.toContain("secret-app");
    expect((await tool("alice", "get_project_access", { project: "secret-app" })).error).toMatch(/not found/);
  });

  it("lets owners and admins give people and teams access, and nobody else", async () => {
    expect((await tool("alice", "set_project_access", { project: "secret-app", email: "alice@example.com", role: "owner" })).error).toMatch(/not found/);
    expect(await tool("admin", "set_project_access", { project: "secret-app", email: "Alice@Example.com", role: "owner" })).toMatchObject({ email: "alice@example.com", role: "owner" });
    expect(await projects("alice")).toContain("secret-app");

    await tool("alice", "set_project_access", { project: "secret-app", email: "bob@example.com", role: "reader" });
    expect(await projects("bob")).toContain("secret-app");
    expect((await tool("bob", "set_project_access", { project: "secret-app", email: "bob@example.com", role: "owner" })).error).toMatch(/needs Manage/);
    const access = await tool("alice", "get_project_access", { project: "secret-app" });
    expect(access).toMatchObject({ visibility: "members", my_role: "owner", can_manage: true });
    expect(access.people.map((p: { email: string; role: string }) => `${p.email}:${p.role}`)).toEqual(
      expect.arrayContaining(["alice@example.com:owner", "bob@example.com:reader"]),
    );

    await tool("alice", "set_project_access", { project: "secret-app", email: "bob@example.com", role: "none" });
    expect(await projects("bob")).not.toContain("secret-app");
    expect((await tool("alice", "set_project_access", { project: "secret-app", role: "reader" })).error).toMatch(/either email or team/);
  });

  it("still needs an admin to let in someone new that an owner added; an admin's grant lets them straight in", async () => {
    await tool("alice", "set_project_access", { project: "secret-app", email: "newbie@example.com", role: "writer" });
    expect(await me("newbie")).toBe(403);
    await flushDeliveries();
    const told = await db.query("SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'admin@example.com'");
    expect(told.rows.map((r) => r.title)).toContain("newbie@example.com is waiting for access");

    await tool("admin", "set_project_access", { project: "secret-app", email: "vip@example.com", role: "reader" });
    expect(await me("vip")).toBe(200);
    expect(await projects("vip")).toContain("secret-app");
  });

  it("lets owners open a project to everyone or make it members-only again", async () => {
    expect((await tool("bob", "set_project_visibility", { project: "secret-app", visibility: "team" })).error).toBeTruthy();
    expect(await tool("alice", "set_project_visibility", { project: "secret-app", visibility: "team" })).toMatchObject({ visibility: "team" });
    expect(await projects("bob")).toContain("secret-app");
    await tool("alice", "set_project_visibility", { project: "secret-app", visibility: "members" });
    expect(await projects("bob")).not.toContain("secret-app");
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { approveRevision } from "../src/core/review.js";
import { deleteItem } from "../src/core/trash.js";
import { addComment } from "../src/core/workflow.js";
import { createArticle } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const PEOPLE = ["admin", "alice", "bob", "carol", "dave", "erin", "frank", "gina"];
const TOKENS = PEOPLE.map((p) => `${p}=${p}@example.com`).join(",");

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator(TOKENS), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of PEOPLE) await ctxFor(db, { email: `${p}@example.com` });
});
const clients: Record<string, Client> = {};
afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  if (!clients[token]) {
    clients[token] = new Client({ name: "test", version: "0" });
    await clients[token].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  }
  const result = await clients[token].callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}
const as = (p: string) => ctxFor(db, { email: `${p}@example.com` });
// The admin owns "lab" (so may publish there); asking for review keeps these as drafts for the reviewers.
const draft = async (title: string) => (await createArticle({ ...(await as("admin")), requestReview: true }, { scope: "lab", type: "decision", title, body_md: "## Context\n\nx" })) as { revision_id: string; article_id: string };

describe("roles", () => {
  it("lists built-in project and org roles with what each permission allows", async () => {
    const catalog = await tool("alice", "list_roles");
    const keys = catalog.roles.map((r: { key: string }) => r.key);
    expect(keys).toEqual(expect.arrayContaining(["owner", "moderator", "reviewer", "writer", "qa", "stakeholder", "reader", "user_manager", "project_creator", "security_lead", "auditor"]));
    expect(catalog.roles.find((r: { key: string }) => r.key === "reader")).toMatchObject({ name: "Viewer", permissions: ["read"] });
    expect(catalog.project_permissions.review).toBeTruthy();
    expect(catalog.org_permissions.manage_users).toBeTruthy();
  });

  it("gives people several project roles whose permissions add up", async () => {
    expect(await tool("admin", "create_project", { slug: "lab", name: "Lab", visibility: "members" })).toMatchObject({ status: "created" });
    await tool("admin", "set_project_access", { project: "lab", email: "carol@example.com", roles: ["owner"] });
    expect(await tool("carol", "set_project_access", { project: "lab", email: "alice@example.com", roles: ["qa", "reviewer"] })).toMatchObject({ roles: ["reviewer", "qa"] });
    await tool("carol", "set_project_access", { project: "lab", email: "bob@example.com", roles: ["stakeholder"] });
    await tool("carol", "set_project_access", { project: "lab", email: "gina@example.com", roles: ["moderator"] });

    const access = await tool("alice", "get_project_access", { project: "lab" });
    expect(access.my_roles).toEqual(["reviewer", "qa"]);
    expect(access.my_permissions).toEqual(["comment", "propose", "read", "review", "verify"]);
    expect(access.people.find((p: { email: string }) => p.email === "alice@example.com").roles).toEqual(["reviewer", "qa"]);

    // Reviewer: approves. Stakeholder: reads and comments, nothing else. Moderator: deletes; a reviewer can't.
    const a = await draft("Use queues");
    await addComment(await as("bob"), a.revision_id, "Looks right to me");
    await expect(approveRevision(await as("bob"), a.revision_id)).rejects.toThrow(/include Review/);
    await expect(createArticle(await as("bob"), { scope: "lab", type: "decision", title: "x", body_md: "x" })).rejects.toThrow(/none of your roles here include/);
    await approveRevision(await as("alice"), a.revision_id);
    await expect(deleteItem(await as("alice"), a.article_id)).rejects.toThrow(/include Moderate/);
    expect(await deleteItem(await as("gina"), a.article_id)).toMatchObject({ status: "deleted" });

    // Viewer: can't even comment on a members-only project.
    await tool("carol", "set_project_access", { project: "lab", email: "dave@example.com", role: "reader" });
    const b = await draft("Use cron");
    await expect(addComment(await as("dave"), b.revision_id, "hm")).rejects.toThrow(/include Comment/);
    expect((await tool("alice", "set_project_access", { project: "lab", email: "dave@example.com", roles: ["writer"] })).error).toMatch(/change who has access/);
  });

  it("doesn't let anyone grant permissions they don't hold", async () => {
    await tool("admin", "save_role", { key: "access_manager", kind: "project", name: "Access manager", permissions: ["read", "manage_members"] });
    await tool("carol", "set_project_access", { project: "lab", email: "dave@example.com", roles: ["access_manager"] });
    expect((await tool("dave", "set_project_access", { project: "lab", email: "frank@example.com", roles: ["owner"] })).error).toMatch(/can't give or take away Project admin/);
    expect(await tool("dave", "set_project_access", { project: "lab", email: "frank@example.com", roles: ["reader"] })).toMatchObject({ roles: ["reader"] });
    // …nor take away more than they could give.
    expect((await tool("dave", "set_project_access", { project: "lab", email: "carol@example.com", roles: [] })).error).toMatch(/can't give or take away/);
  });

  it("lets teams hold roles too", async () => {
    await (await import("../src/core/teams.js")).createTeam(await as("admin"), { slug: "qa-team", name: "QA team" });
    await tool("admin", "set_team_membership", { team: "qa-team", email: "erin@example.com", member: true, lead: true });
    await tool("carol", "set_project_access", { project: "lab", team: "qa-team", roles: ["qa"] });
    expect((await tool("erin", "get_project_access", { project: "lab" })).my_roles).toEqual(["qa"]);
    expect((await tool("erin", "list_teams", { team: "qa-team" })).projects).toEqual([expect.objectContaining({ slug: "lab", roles: ["qa"] })]);
  });

  it("splits admin into org roles, with the same no-escalation rule", async () => {
    expect((await tool("erin", "list_people")).error).toMatch(/manage_users/);
    expect(await tool("admin", "set_user_roles", { email: "erin@example.com", roles: ["user_manager"] })).toMatchObject({ roles: ["user_manager"] });
    expect((await tool("erin", "list_people")).people.map((p: { email: string }) => p.email)).toContain("frank@example.com");
    expect((await tool("erin", "set_user_roles", { email: "frank@example.com", roles: ["project_creator"] })).error).toMatch(/can't give or take away Project creator/);

    await tool("admin", "set_user_roles", { email: "frank@example.com", roles: ["project_creator"] });
    expect(await tool("frank", "create_project", { slug: "franks", name: "Frank's" })).toMatchObject({ status: "created" });
    expect(await tool("gina", "create_project", { slug: "ginas", name: "Gina's" })).toMatchObject({ status: "requested" });

    // A user manager manages people, not admins.
    const adminId = (await db.query("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0].id;
    const patch = await fetch(`${base}/api/users/${adminId}`, {
      method: "PATCH",
      headers: { authorization: "Bearer erin", "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(patch.status).toBe(403);
    const me = await (await fetch(`${base}/api/me`, { headers: { authorization: "Bearer erin" } })).json();
    expect(me).toMatchObject({ admin: false, roles: ["user_manager"], permissions: ["manage_users"] });
  });

  it("keeps built-in roles' meaning, and deleting a custom role removes it everywhere", async () => {
    expect((await tool("admin", "save_role", { key: "reader", permissions: ["read", "propose"] })).error).toMatch(/built-in/);
    expect(await tool("admin", "save_role", { key: "reader", name: "Read-only" })).toMatchObject({ name: "Read-only", permissions: ["read"] });
    expect((await tool("carol", "save_role", { key: "x_role", kind: "project", name: "X", permissions: ["read"] })).error).toMatch(/manage_roles/);
    // Read is added for you: every project role includes it.
    expect(await tool("admin", "save_role", { kind: "project", name: "QA lead", permissions: ["verify", "comment"] })).toMatchObject({
      key: "qa_lead",
      permissions: ["read", "comment", "verify"],
    });
    expect((await tool("admin", "save_role", { kind: "project", name: "Bad", permissions: ["manage_users"] })).error).toMatch(/is an organisation permission/);
    expect(await tool("admin", "delete_role", { key: "QA lead" })).toMatchObject({ deleted: true });
    expect(await tool("admin", "delete_role", { key: "access_manager" })).toMatchObject({ deleted: true, grants_removed: 1 });
    expect((await tool("dave", "get_project_access", { project: "lab" })).error).toMatch(/not found/);
  });
});

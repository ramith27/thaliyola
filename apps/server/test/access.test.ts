import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptInvitation, createInvitation } from "../src/auth/invitations.js";
import { devAuthenticator } from "../src/auth/index.js";
import { createLocalUser } from "../src/auth/local.js";
import { adminCreateProject } from "../src/core/admin.js";
import { setProjectParent } from "../src/core/hierarchy.js";
import { createRole, deleteRole, setUserRoles } from "../src/core/roles.js";
import { createTeamProject } from "../src/core/teams.js";
import { createAccount, upsertUser } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const PEOPLE = ["admin", "alice", "bob", "carol", "dave", "erin", "frank", "gina", "gina2", "hank", "ivy", "otto", "sam"];
const TOKENS = [...PEOPLE.map((p) => `${p}=${p}@example.com`), "svc=svc-bot@example.com"].join(",");
const clients: Record<string, Client> = {};

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator(TOKENS), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of PEOPLE) await as(p);
  await ctxFor(db, { email: "svc-bot@example.com", service: true });
  const admin = await as("admin");
  await setUserRoles(admin, await idOf("erin"), ["user_manager"]);
  await setUserRoles(admin, await idOf("hank"), ["team_manager"]);
  await setUserRoles(admin, await idOf("otto"), ["auditor"]);
  await setUserRoles(admin, await idOf("sam"), ["security_lead"]);
});
afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

const as = (p: string) => ctxFor(db, { email: `${p}@example.com` });
const idOf = async (p: string) =>
  (await db.query("SELECT id FROM users WHERE email = $1 ORDER BY kind = 'human' DESC, created_at LIMIT 1", [p.includes("@") ? p : `${p}@example.com`])).rows[0].id as string;
const scopeId = async (slug: string) => (await db.query("SELECT id FROM scopes WHERE slug = $1", [slug])).rows[0].id as string;

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  if (!clients[token]) {
    clients[token] = new Client({ name: "test", version: "0" });
    await clients[token].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  }
  const result = await clients[token].callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

type Grant = { key: string; via: string; team: { slug: string } | null; from: { slug: string } | null };

describe("1. names and aliases", () => {
  it("accepts role names, aliases, any case and plurals, and explains wrong or unknown ones", async () => {
    expect(await tool("admin", "create_project", { slug: "names", name: "Names" })).toMatchObject({ status: "created" });
    expect(await tool("admin", "set_project_access", { project: "names", email: "alice@example.com", roles: ["Contributor"] })).toMatchObject({
      roles: ["writer"],
      role_names: ["Contributor"],
      project_name: "Names",
    });
    expect((await tool("admin", "set_project_access", { project: "names", email: "bob@example.com", roles: ["project admins"] })).roles).toEqual(["owner"]);
    expect((await tool("admin", "set_project_access", { project: "names", email: "carol@example.com", roles: ["VIEWER"] })).roles).toEqual(["reader"]);
    expect((await tool("admin", "set_project_access", { project: "names", email: "dave@example.com", roles: ["contributer"] })).error).toContain("Contributor (writer)");
    expect((await tool("admin", "set_project_access", { project: "names", email: "dave@example.com", roles: ["Auditor"] })).error).toMatch(/set_user_roles/);
    expect((await tool("admin", "set_user_roles", { email: "alice@example.com", roles: ["Reviewer"] })).error).toMatch(/set_project_access/);
    // Nothing was given to dave by the refused calls.
    expect((await tool("admin", "get_project_access", { project: "names" })).people.map((p: { email: string }) => p.email)).not.toContain("dave@example.com");
  });
});

describe("2. add and remove", () => {
  it("changes only the roles named, reports before and after, and refuses mixing replace with add / remove", async () => {
    await tool("admin", "set_project_access", { project: "names", email: "alice@example.com", roles: ["QA"] });
    expect(await tool("admin", "set_project_access", { project: "names", email: "alice@example.com", add: ["Reviewer"] })).toMatchObject({
      roles: ["reviewer", "qa"],
      before: ["qa"],
      added: ["reviewer"],
      removed: [],
    });
    expect(await tool("admin", "set_project_access", { project: "names", email: "alice@example.com", remove: ["qa"] })).toMatchObject({
      roles: ["reviewer"],
      before: ["reviewer", "qa"],
      added: [],
      removed: ["qa"],
    });
    expect((await tool("admin", "set_project_access", { project: "names", email: "alice@example.com", roles: ["qa"], add: ["reviewer"] })).error).toMatch(/not both/);
    expect((await tool("admin", "set_project_access", { project: "names", email: "nobody-here@example.com", remove: ["qa"] })).error).toMatch(/has no roles here/);
    expect((await db.query("SELECT 1 FROM users WHERE email = 'nobody-here@example.com'")).rowCount).toBe(0);
    // REST takes the same change.
    const rest = await call("admin", "PUT", "/api/scopes/names/members", { email: "alice@example.com", add: ["Stakeholder"] });
    expect(rest.body).toMatchObject({ roles: ["reviewer", "stakeholder"], added: ["stakeholder"] });
    expect((await call("admin", "PUT", "/api/scopes/names/members", { email: "alice@example.com", remove: ["Stakeholder"] })).body.roles).toEqual(["reviewer"]);
    // The older single role still works and is echoed.
    expect((await call("admin", "PUT", "/api/scopes/names/members", { email: "alice@example.com", role: "reviewer" })).body).toMatchObject({ role: "reviewer", roles: ["reviewer"] });
  });
});

describe("3. new people", () => {
  it("says when someone hasn't signed in yet", async () => {
    const res = await tool("admin", "set_project_access", { project: "names", email: "newcomer@example.com", roles: ["Viewer"] });
    expect(res).toMatchObject({ account: "not_signed_in", needs_approval: false, roles: ["reader"] });
    expect(res.note).toContain("hasn't signed in yet");
  });
});

describe("4. remaining access", () => {
  it("reports access that remains through a team after direct roles are taken away", async () => {
    expect(await tool("admin", "save_team", { team: "writers-team", name: "Writers" })).toMatchObject({ slug: "writers-team", name: "Writers", created: true });
    await tool("admin", "set_team_membership", { team: "writers-team", email: "carol@example.com", member: true });
    expect(await tool("admin", "set_project_access", { project: "names", team: "writers-team", roles: ["Contributor"] })).toMatchObject({
      team: "writers-team",
      team_name: "Writers",
      roles: ["writer"],
      role_names: ["Contributor"],
      added: ["writer"],
    });
    const res = await tool("admin", "set_project_access", { project: "names", email: "carol@example.com", roles: [] });
    expect(res).toMatchObject({ roles: [], removed: ["reader"] });
    expect(res.still_has_access_via).toEqual([{ team: { slug: "writers-team", name: "Writers" }, from: null, roles: ["writer"], role_names: ["Contributor"] }]);
    expect(res.note).toContain("through the team Writers");
  });
});

describe("5. Administrator", () => {
  it("is the top organisation role, kept when roles are replaced, given and taken only by Administrators", async () => {
    const catalog = await tool("alice", "list_roles");
    const org = catalog.roles.filter((r: { kind: string }) => r.kind === "org");
    expect(org[0]).toMatchObject({ key: "admin", name: "Administrator", admin: true, can_edit: false, can_delete: false });
    expect(org[0].permissions).toEqual(Object.keys(catalog.org_permissions));
    expect(catalog.summary).toContain("Administrator is the organisation role that can do everything");

    const frank = await idOf("frank");
    expect(await tool("admin", "set_user_roles", { email: "frank@example.com", add: ["Administrator"] })).toMatchObject({ roles: ["admin"], added: ["admin"], before: [] });
    expect((await call("frank", "GET", "/api/me")).body).toMatchObject({ admin: true, roles: ["admin"], role_names: ["Administrator"], administrator_source: "account" });
    expect((await db.query("SELECT is_admin FROM users WHERE id = $1", [frank])).rows[0].is_admin).toBe(true);
    expect((await db.query("SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'admin'", [frank])).rowCount).toBe(0);
    const listed = (await call("admin", "GET", "/api/users")).body.users.find((u: { id: string }) => u.id === frank);
    expect(listed.roles[0]).toBe("admin");

    // Replacing organisation roles never removes Administrator (B1).
    expect((await tool("admin", "set_user_roles", { email: "frank@example.com", roles: ["auditor"] })).roles).toEqual(["admin", "auditor"]);
    // User managers neither make Administrators nor touch their accounts.
    expect((await tool("erin", "set_user_roles", { email: "gina@example.com", add: ["Administrator"] })).error).toMatch(/only Administrators/);
    expect((await tool("erin", "set_user_roles", { email: "frank@example.com", roles: [] })).error).toMatch(/only Administrators/);
    expect((await call("erin", "PATCH", `/api/users/${frank}`, { disabled: true })).status).toBe(403);
    // Nobody removes their own; ADMIN_EMAILS Administrators are set on the server.
    expect((await tool("frank", "set_user_roles", { email: "frank@example.com", remove: ["Administrator"] })).error).toMatch(/your own/);
    expect((await tool("frank", "set_user_roles", { email: "admin@example.com", remove: ["Administrator"] })).error).toMatch(/ADMIN_EMAILS/);
    expect(await tool("admin", "set_user_roles", { email: "frank@example.com", remove: ["Administrator"] })).toMatchObject({ roles: ["auditor"], removed: ["admin"] });
    expect((await call("frank", "GET", "/api/me")).body).toMatchObject({ admin: false, roles: ["auditor"] });

    // The older is_admin flag merges with roles; a contradiction is refused.
    expect((await call("admin", "PATCH", `/api/users/${frank}`, { roles: ["auditor"], is_admin: true })).body).toMatchObject({ roles: ["admin", "auditor"], added: ["admin"] });
    expect((await call("admin", "PATCH", `/api/users/${frank}`, { roles: ["admin"], is_admin: false })).status).toBe(400);
    expect((await call("admin", "PATCH", `/api/users/${frank}`, { remove: ["Administrator", "Auditor"] })).body).toMatchObject({ roles: [], removed: ["admin", "auditor"] });

    expect((await tool("admin", "set_user_roles", { email: "svc-bot@example.com", add: ["Administrator"] })).error).toMatch(/only people/);
    await expect(db.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'admin')", [frank])).rejects.toThrow();
    const me = (await call("admin", "GET", "/api/me")).body;
    expect(me).toMatchObject({ admin: true, administrator_source: "ADMIN_EMAILS", can_see_access: true });
    expect(me.roles[0]).toBe("admin");
  });

  it("lets a User manager give and take only organisation roles whose permissions they hold", async () => {
    const gina2 = await idOf("gina2");
    expect((await call("erin", "PATCH", `/api/users/${gina2}`, { add: ["User manager"] })).body).toMatchObject({ roles: ["user_manager"], role_names: ["User manager"] });
    expect((await call("erin", "PATCH", `/api/users/${gina2}`, { add: ["Auditor"] })).status).toBe(403);
    expect((await call("erin", "PATCH", `/api/users/${gina2}`, { remove: ["user_manager"] })).body).toMatchObject({ roles: [], removed: ["user_manager"] });
    expect((await call("dave", "GET", "/api/me")).body).toMatchObject({ administrator_source: null, can_see_access: false, roles: [], role_names: [] });
  });
});

describe("6. account actions (B2)", () => {
  it("keeps account actions on people with organisation permissions you lack for Administrators", async () => {
    const power = (await createLocalUser(db, { email: "power@example.com" })).user.id;
    const plain = (await createLocalUser(db, { email: "plain@example.com" })).user.id;
    expect((await call("admin", "POST", "/api/roles", { kind: "organisation", name: "Power role", permissions: ["purge"] })).body).toMatchObject({
      key: "power_role",
      kind: "org",
      kind_name: "Organisation role",
    });
    await tool("admin", "set_user_roles", { email: "power@example.com", add: ["Power role"] });

    const reset = await call("erin", "POST", `/api/users/${power}/reset-password`);
    expect(reset.status).toBe(403);
    expect(reset.body.error).toMatch(/Delete permanently/);
    expect((await call("erin", "PATCH", `/api/users/${power}`, { disabled: true })).status).toBe(403);
    expect((await call("erin", "POST", `/api/users/${plain}/reset-password`)).body.temporary_password).toBeTruthy();
    expect((await call("admin", "POST", `/api/users/${power}/reset-password`)).status).toBe(200);

    const users = (await call("erin", "GET", "/api/users")).body.users as { id: string; email: string; can_manage_account: boolean }[];
    expect(users.find((u) => u.id === power)!.can_manage_account).toBe(false);
    expect(users.find((u) => u.id === plain)!.can_manage_account).toBe(true);
    expect(users.find((u) => u.email === "admin@example.com")!.can_manage_account).toBe(false);
    expect(users.find((u) => u.email === "erin@example.com")!.can_manage_account).toBe(false);
    expect((await call("erin", "GET", "/api/users?q=power")).body.users.map((u: { email: string }) => u.email)).toEqual(["power@example.com"]);
  });
});

describe("7. role definitions", () => {
  it("limits what a Manage roles holder can define to what they hold, and keeps built-ins and Administrator", async () => {
    expect(await tool("admin", "save_role", { key: "role_keeper", kind: "org", name: "Role keeper", permissions: ["manage_roles", "manage_users"] })).toMatchObject({ key: "role_keeper" });
    await tool("admin", "set_user_roles", { email: "gina@example.com", roles: ["Role keeper"] });

    expect((await tool("gina", "save_role", { key: "role_keeper", permissions: ["manage_roles", "manage_users", "manage_all_projects"] })).error).toMatch(/permissions you don't have/);
    expect((await tool("gina", "save_role", { kind: "org", name: "Purger", permissions: ["purge"] })).error).toMatch(/permissions you don't have/);
    const docs = await tool("gina", "save_role", { kind: "project", name: "Docs editor", permissions: ["read", "comment", "propose"] });
    expect(docs).toMatchObject({ key: "docs_editor", kind: "project", can_delete: true });
    expect(await tool("gina", "save_role", { key: "Docs editor", permissions: ["read", "comment", "propose", "verify"] })).toMatchObject({
      permissions: ["read", "comment", "propose", "verify"],
      before: { permissions: ["read", "comment", "propose"] },
    });

    // Once someone holds it, changing what it allows (or deleting it) is for Manage every project.
    await tool("admin", "set_project_access", { project: "names", email: "dave@example.com", roles: ["Docs editor"] });
    expect((await tool("gina", "save_role", { key: "docs_editor", permissions: ["read"] })).error).toMatch(/Manage every project/);
    expect((await tool("gina", "delete_role", { key: "docs_editor" })).error).toMatch(/Manage every project/);
    const catalog = await tool("gina", "list_roles");
    expect(catalog.roles.find((r: { key: string }) => r.key === "docs_editor")).toMatchObject({ editable_permissions: [], can_delete: false });
    expect(catalog.roles.find((r: { key: string }) => r.key === "role_keeper")).toMatchObject({ can_delete: true, editable_permissions: ["manage_users", "manage_roles"] });
    expect(catalog.roles.find((r: { key: string }) => r.key === "power_role")).toMatchObject({ can_delete: false, editable_permissions: [] });

    // Publish directly can be switched on a built-in project role, nothing else.
    const reviewer = ["read", "comment", "propose", "verify", "review"];
    expect((await tool("admin", "save_role", { key: "reviewer", permissions: [...reviewer, "publish"] })).permissions).toContain("publish");
    expect(await tool("alice", "create_article", { project: "names", type: "decision", title: "Reviewers publish", body_md: "## Context\n\nx" })).toMatchObject({
      status: "published",
    });
    await tool("admin", "save_role", { key: "reviewer", permissions: reviewer });
    expect((await tool("alice", "create_article", { project: "names", type: "decision", title: "Reviewers propose", body_md: "## Context\n\nx" })).status).toBe("pending_review");
    expect((await tool("admin", "save_role", { key: "reviewer", permissions: [...reviewer, "moderate"] })).error).toMatch(/built-in/);

    expect((await tool("admin", "save_role", { name: "Reviewer", kind: "project", permissions: ["read"] })).error).toMatch(/already exists/);
    expect((await tool("admin", "save_role", { key: "admin", name: "Boss" })).error).toMatch(/Administrator/);
    expect((await tool("admin", "save_role", { key: "reviewer", kind: "org" })).error).toMatch(/project role, not an organisation role/);

    expect(await tool("admin", "save_role", { key: "reader", name: "Read-only" })).toMatchObject({ name: "Read-only" });
    expect((await tool("admin", "set_project_access", { project: "names", email: "newcomer@example.com", roles: ["Viewer"] })).roles).toEqual(["reader"]);
    await tool("admin", "save_role", { key: "reader", name: "Viewer" });
  });
});

describe("8. invitations", () => {
  const local = { ...TEST_SETTINGS, authMode: "local" as const };
  const tokenOf = (link: string) => link.slice(link.indexOf("#/invite/") + "#/invite/".length);

  it("carries several project roles", async () => {
    const inv = await createInvitation(db, local, await idOf("admin"), { email: "invitee1@example.com", scope: "names", roles: ["Reviewer", "QA"] });
    const accepted = await acceptInvitation(db, tokenOf(inv.link), { password: "a-long-enough-passphrase-9" });
    const roles = await db.query("SELECT role FROM scope_members WHERE user_id = $1 AND scope_id = $2 ORDER BY role", [accepted!.userId, await scopeId("names")]);
    expect(roles.rows.map((r) => r.role)).toEqual(["qa", "reviewer"]);
  });

  it("strips a deleted role from open invitations, so a new role reusing its key gives nothing (B4)", async () => {
    const admin = await as("admin");
    await createRole(admin, { key: "temp_role", kind: "project", name: "Temp role", permissions: ["read"] });
    const inv = await createInvitation(db, local, admin.actor.id, { email: "invitee2@example.com", scope: "names", roles: ["temp_role"] });
    const listed = (await call("admin", "GET", "/api/invitations")).body.invitations.find((i: { id: string }) => i.id === inv.id);
    expect(listed).toMatchObject({ scope: "names", scope_name: "Names", scope_roles: ["temp_role"], scope_role_names: ["Temp role"] });
    expect(await deleteRole(await as("admin"), "Temp role")).toMatchObject({ deleted: true, invitations_changed: 1 });
    await createRole(await as("admin"), { key: "temp_role", kind: "project", name: "Temp role", permissions: ["read", "manage_members"] });
    const accepted = await acceptInvitation(db, tokenOf(inv.link), { password: "a-long-enough-passphrase-9" });
    expect(accepted).toMatchObject({ email: "invitee2@example.com" });
    expect((await db.query("SELECT role FROM scope_members WHERE user_id = $1", [accepted!.userId])).rows).toEqual([]);
  });

  it("checks project access before inviting into a project", async () => {
    // Inviting into a project gives roles there: Manage access in it, and only roles you could give.
    expect((await call("erin", "POST", "/api/invitations", { email: "x1@example.com", scope: "names", roles: ["Reviewer"] })).body.error).toMatch(/needs Manage access/);
    expect((await call("erin", "POST", "/api/invitations", { email: "x1@example.com", scope: "vault-not-yet", roles: ["Reviewer"] })).status).toBe(404);
    expect((await call("admin", "POST", "/api/invitations", { email: "x1@example.com", scope: "names", roles: ["Auditor"] })).body.error).toMatch(/organisation role/);
  });
});

describe("9. team escalation (B6)", () => {
  it("keeps a team's members and leads for people who hold its project roles, without naming projects they can't see", async () => {
    expect(await tool("admin", "create_project", { slug: "vault", name: "Vault", visibility: "members" })).toMatchObject({ status: "created" });
    await tool("admin", "save_team", { team: "keepers", name: "Keepers" });
    expect(await tool("admin", "save_team", { team: "keepers", description: "Keep the vault" })).toMatchObject({ created: false, description: "Keep the vault" });
    await tool("admin", "set_team_membership", { team: "keepers", email: "ivy@example.com", member: true, lead: true });
    await tool("admin", "set_team_membership", { team: "keepers", email: "bob@example.com", member: true });
    await tool("admin", "set_project_access", { project: "vault", team: "keepers", roles: ["owner"] });
    expect((await tool("admin", "set_project_access", { project: "vault", email: "admin@example.com", roles: [] })).removed).toEqual(["owner"]);

    // A Team manager outside the team can't change who is in it, and isn't told which project.
    for (const args of [
      { email: "hank@example.com", member: true },
      { email: "bob@example.com", member: false },
      { email: "bob@example.com", member: true, lead: true },
    ]) {
      const res = await tool("hank", "set_team_membership", { team: "keepers", ...args });
      expect(res.error).toMatch(/you can't change who is in Keepers/);
      expect(res.error).toContain("a project you can't see");
      expect(res.error).not.toMatch(/vault/i);
    }
    expect((await tool("hank", "delete_team", { team: "keepers" })).error).toMatch(/you can't delete Keepers/);
    const seen = await tool("hank", "list_teams", { team: "keepers" });
    expect(seen).toMatchObject({ can_manage: true, can_change_members: false, leads: 1, projects: [] });
    expect(seen.change_members_note).not.toMatch(/vault/i);
    expect((await call("hank", "GET", "/api/teams/keepers")).body).toMatchObject({ can_change_members: false });

    // Leaving out lead keeps a lead a lead.
    expect(await tool("admin", "set_team_membership", { team: "keepers", email: "ivy@example.com", member: true })).toMatchObject({ before_role: "lead", role: "lead" });
    // The lead adds carol, who then manages the vault's access through the team.
    expect(await tool("ivy", "set_team_membership", { team: "keepers", email: "carol@example.com", member: true })).toMatchObject({ role: "member", before_role: null });
    expect(await tool("carol", "set_project_access", { project: "vault", email: "dave@example.com", roles: ["Viewer"] })).toMatchObject({ roles: ["reader"] });
    expect((await tool("ivy", "set_team_membership", { team: "keepers", email: "carol@example.com", member: false })).member).toBe(false);
    expect((await tool("ivy", "set_team_membership", { team: "keepers", email: "bob@example.com", member: false })).member).toBe(false);
    // The last member holding the vault's Project admin role can't leave it without one; an Administrator can.
    expect((await tool("ivy", "set_team_membership", { team: "keepers", email: "ivy@example.com", member: false })).error).toMatch(/without a Project admin/);
    expect((await tool("admin", "set_team_membership", { team: "keepers", email: "ivy@example.com", member: false })).note).toMatch(/no leads/);
    expect((await tool("admin", "set_team_membership", { team: "keepers", email: "ivy@example.com", member: false })).error).toMatch(/isn't in Keepers/);
  });

  it("warns when a team's last lead steps down", async () => {
    await tool("admin", "save_team", { team: "solo", name: "Solo" });
    await tool("admin", "set_team_membership", { team: "solo", email: "gina@example.com", member: true, lead: true });
    const res = await tool("gina", "set_team_membership", { team: "solo", email: "gina@example.com", member: true, lead: false });
    expect(res).toMatchObject({ role: "member", before_role: "lead" });
    expect(res.note).toContain("no leads");
    // A plain member can't change the team.
    expect((await tool("gina", "set_team_membership", { team: "solo", email: "dave@example.com", member: true })).error).toMatch(/leads, team managers and admins/);
    // REST: an omitted role keeps the current one.
    await tool("admin", "set_team_membership", { team: "solo", email: "gina@example.com", member: true, lead: true });
    expect((await call("admin", "PUT", "/api/teams/solo/members", { email: "gina@example.com", member: true })).body).toMatchObject({ role: "lead", before_role: "lead" });
  });

  it("deletes a team only for people who hold its roles, and keeps a Project admin unless an Administrator deletes it", async () => {
    expect((await tool("dave", "save_team", { team: "nope", name: "Nope" })).error).toMatch(/team managers/);
    await adminCreateProject(await as("admin"), { slug: "fort", name: "Fort" });
    await tool("hank", "save_team", { team: "guards", name: "Guards" });
    await tool("hank", "set_team_membership", { team: "guards", email: "hank@example.com", member: true, lead: true });
    await tool("admin", "set_project_access", { project: "fort", team: "guards", roles: ["Project admin"] });
    expect((await tool("hank", "delete_team", { team: "guards" })).error).toMatch(/without a Project admin/);
    expect(await tool("admin", "delete_team", { team: "guards" })).toMatchObject({ deleted: true, projects_without_admin: [{ slug: "fort", name: "Fort" }] });
  });
});

describe("10–11. teams on scopes and team projects", () => {
  it("doesn't apply the Project-admin rule to the team scope", async () => {
    await tool("admin", "save_team", { team: "staff", name: "Staff" });
    await tool("admin", "set_team_membership", { team: "staff", email: "carol@example.com", member: true, lead: true });
    await tool("admin", "set_project_access", { project: "team", team: "staff", roles: ["owner"] });
    expect(await tool("carol", "set_team_membership", { team: "staff", email: "carol@example.com", member: false })).toMatchObject({ member: false, role: null });
  });

  it("gives a team project several roles, and refuses organisation roles there", async () => {
    const res = await createTeamProject(await as("admin"), "staff", { slug: "staff-proj", name: "Staff project", team_roles: ["Reviewer", "QA"] });
    expect(res.team_roles).toEqual(["reviewer", "qa"]);
    const held = await db.query("SELECT role FROM scope_team_roles WHERE scope_id = $1 ORDER BY role", [await scopeId("staff-proj")]);
    expect(held.rows.map((r) => r.role)).toEqual(["qa", "reviewer"]);
    await expect(createTeamProject(await as("admin"), "staff", { slug: "staff-bad", name: "Bad", team_role: "user_manager" })).rejects.toThrow(/organisation role/);
    const rest = await call("admin", "POST", "/api/teams/staff/projects", { slug: "staff-rest", name: "Staff REST", team_roles: ["Viewer"] });
    expect(rest.body).toMatchObject({ team: "staff", team_roles: ["reader"] });
    expect((await call("admin", "GET", "/api/teams")).body.teams.find((t: { slug: string }) => t.slug === "staff").projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug: "staff-proj", role_names: ["Reviewer", "QA"] })]),
    );
  });
});

describe("12. one person's access", () => {
  it("shows direct, team and inherited roles, to the person and to those who can see access", async () => {
    const admin = await as("admin");
    await adminCreateProject(admin, { slug: "up", name: "Up" });
    await adminCreateProject(await as("admin"), { slug: "down", name: "Down", parent: "up" });
    await tool("admin", "set_project_access", { project: "up", email: "bob@example.com", roles: ["Viewer"] });
    await tool("admin", "save_team", { team: "readers", name: "Readers" });
    await tool("admin", "set_team_membership", { team: "readers", email: "bob@example.com", member: true });
    await tool("admin", "set_project_access", { project: "names", team: "readers", roles: ["Stakeholder"] });

    const mine = await tool("bob", "get_person_access");
    expect(mine.person).toMatchObject({ email: "bob@example.com", kind: "human", status: "active" });
    expect(mine.teams).toEqual(expect.arrayContaining([{ slug: "readers", name: "Readers", team_role: "member" }]));
    const names = mine.projects.find((p: { slug: string }) => p.slug === "names");
    expect(names.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "owner", via: "direct", team: null, from: null }),
        expect.objectContaining({ key: "stakeholder", via: "team", team: { slug: "readers", name: "Readers" } }),
      ]),
    );
    expect(names.permissions).toContain("manage_members");
    const down = mine.projects.find((p: { slug: string }) => p.slug === "down");
    expect(down.roles).toEqual([expect.objectContaining({ key: "reader", name: "Viewer", via: "inherited", from: { slug: "up", name: "Up" } })]);
    expect(down.roles.every((r: Grant) => r.from?.slug === "up")).toBe(true);
    expect(mine.administrator).toEqual({ is: false, source: null });

    expect((await tool("dave", "get_person_access", { person: "bob@example.com" })).error).toMatch(/someone else's access/);
    // A User manager who can't read a members-only project only sees that there is one.
    const daves = await tool("erin", "get_person_access", { person: "dave@example.com" });
    expect(daves.projects.map((p: { slug: string }) => p.slug)).not.toContain("vault");
    expect(daves.other_projects).toBe(1);
    expect((await tool("otto", "get_person_access", { person: "Dave" })).projects.map((p: { slug: string }) => p.slug)).toEqual(expect.arrayContaining(["vault", "names"]));
    const adminView = await tool("otto", "get_person_access", { person: "admin@example.com" });
    expect(adminView).toMatchObject({ administrator: { is: true, source: "ADMIN_EMAILS" }, reads_every_project: true, manages_every_project: true });
    expect(adminView.org_roles[0]).toMatchObject({ key: "admin", name: "Administrator" });

    expect((await call("dave", "GET", "/api/account/access")).status).toBe(200);
    const bob = await idOf("bob");
    expect((await call("dave", "GET", `/api/users/${bob}/access`)).status).toBe(403);
    expect((await call("admin", "GET", `/api/users/${bob}/access`)).body.person.email).toBe("bob@example.com");
  });
});

describe("13. a project's access", () => {
  it("summarises who has access, who else can see a members-only project, and what's open to everyone", async () => {
    const names = await tool("alice", "get_project_access", { project: "names" });
    expect(names).toMatchObject({ project_name: "Names", org_wide: null, can_manage_members: false });
    expect(names.summary).toMatch(/^Everyone signed in can read it\. \d+ people have a role here \(\d+ directly, \d+ through teams\)\.$/);
    expect(names.people.find((p: { email: string }) => p.email === "alice@example.com")).toMatchObject({ role_names: ["Reviewer"], account: "active", kind: "human" });
    expect(names.teams.find((t: { slug: string }) => t.slug === "writers-team")).toMatchObject({
      role_names: ["Contributor"],
      member_list: [{ id: expect.any(String), email: "carol@example.com", name: null, team_role: "member" }],
    });

    expect(await tool("admin", "create_project", { slug: "secret", name: "Secret", visibility: "members" })).toMatchObject({ status: "created" });
    await tool("admin", "set_project_access", { project: "secret", email: "alice@example.com", roles: ["Project admin"] });
    await tool("admin", "set_project_access", { project: "secret", email: "admin@example.com", roles: [] });
    await tool("alice", "set_project_access", { project: "secret", email: "carol@example.com", roles: ["Viewer"] });
    const managed = await tool("alice", "get_project_access", { project: "secret" });
    expect(managed.summary).toMatch(/^Members only/);
    expect(managed.org_wide.people).toEqual(
      expect.arrayContaining([
        { email: "admin@example.com", name: null, why: ["Administrator"] },
        { email: "otto@example.com", name: null, why: ["Auditor"] },
      ]),
    );
    const member = await tool("carol", "get_project_access", { project: "secret" });
    expect(member.org_wide.people).toBeNull();
    expect(member.org_wide.count).toBeGreaterThanOrEqual(2);
    expect((await tool("frank", "set_project_access", { project: "secret", email: "frank@example.com", roles: ["reader"] })).error).toMatch(/not found/);

    await adminCreateProject(await as("admin"), { slug: "opened", name: "Opened" });
    expect((await tool("dave", "get_project_access", { project: "opened" })).open_to_everyone).toEqual({ read: true, comment: true, propose: true, verify: true });
    await tool("admin", "set_project_access", { project: "opened", email: "dave@example.com", roles: ["Contributor"] });
    expect((await tool("dave", "get_project_access", { project: "opened" })).open_to_everyone).toMatchObject({ read: true, propose: false });

    await tool("admin", "set_project_access", { project: "opened", email: "svc-bot@example.com", roles: ["Viewer"] });
    const robot = (await db.query("INSERT INTO users (subject, kind) VALUES ('cf-svc:robot', 'service') RETURNING id")).rows[0].id;
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'reader')", [await scopeId("opened"), robot]);
    const opened = await tool("admin", "get_project_access", { project: "opened" });
    expect(opened.people.find((p: { email: string }) => p.email === "svc-bot@example.com")).toMatchObject({ kind: "service" });
    expect(opened.people.find((p: { email: string }) => p.email === "cf-svc:robot")).toMatchObject({ kind: "service", roles: ["reader"] });
    expect(await tool("admin", "set_project_access", { project: "opened", email: "cf-svc:robot", roles: [] })).toMatchObject({ email: "cf-svc:robot", removed: ["reader"] });
    expect((await tool("admin", "get_project_access", { project: "opened" })).people.map((p: { email: string }) => p.email)).not.toContain("cf-svc:robot");
  });
});

describe("14. moving a project (B3)", () => {
  it("needs Manage access on it, no escalation, and keeps a Project admin", async () => {
    await adminCreateProject(await as("admin"), { slug: "p1", name: "P1" });
    await tool("admin", "set_project_access", { project: "p1", email: "dave@example.com", roles: ["owner"] });
    await adminCreateProject(await as("admin"), { slug: "c1", name: "C1", parent: "p1" });
    await expect(setProjectParent(await as("dave"), "c1", null)).rejects.toThrow(/without a Project admin/);
    expect(await setProjectParent(await as("admin"), "c1", null)).toMatchObject({ changed: true, parent: null });

    await tool("admin", "save_role", { key: "settings_only", kind: "project", name: "Settings only", permissions: ["read", "manage_settings"] });
    await tool("admin", "save_role", { key: "access_settings", kind: "project", name: "Access and settings", permissions: ["read", "manage_members", "manage_settings"] });
    await adminCreateProject(await as("admin"), { slug: "c2", name: "C2" });
    await adminCreateProject(await as("admin"), { slug: "c3", name: "C3" });
    await tool("admin", "set_project_access", { project: "c2", email: "dave@example.com", roles: ["Settings only"] });
    await tool("admin", "set_project_access", { project: "c3", email: "dave@example.com", roles: ["Access and settings"] });
    await expect(setProjectParent(await as("dave"), "c2", "p1")).rejects.toThrow(/Manage access/);
    await expect(setProjectParent(await as("dave"), "c3", "p1")).rejects.toThrow(/can't move C3 there: people would gain or lose Project admin/);
    expect((await call("dave", "PUT", "/api/projects/c3/parent", { parent: "p1" })).status).toBe(403);
    expect((await call("frank", "PUT", "/api/projects/secret/parent", { parent: null })).status).toBe(404);
  });
});

describe("15. effective permissions (B5)", () => {
  it("says what the server will actually allow", async () => {
    expect((await tool("sam", "get_project_access", { project: "opened" })).effective_permissions).toContain("security");
    const admin = await tool("admin", "get_project_access", { project: "opened" });
    expect(admin.my_roles).toEqual([]);
    expect(admin.effective_permissions).toEqual(expect.arrayContaining(["review", "moderate", "manage_members", "manage_settings"]));
    expect(admin.effective_permissions).not.toContain("publish");

    const scopes = (await call("dave", "GET", "/api/scopes")).body.scopes as { slug: string; kind: string; effective_permissions: string[]; can_manage_members: boolean; my_role_names: string[] }[];
    const personal = scopes.find((s) => s.kind === "personal")!;
    expect(personal.effective_permissions).toEqual(expect.arrayContaining(["read", "propose", "review", "publish", "moderate"]));
    expect(personal.effective_permissions).not.toContain("manage_members");
    expect(personal.effective_permissions).not.toContain("manage_settings");
    const names = scopes.find((s) => s.slug === "names")!;
    expect(names.my_role_names).toEqual(["Docs editor"]);
    expect(names.effective_permissions).toEqual((await tool("dave", "get_project_access", { project: "names" })).effective_permissions);
    expect(names.can_manage_members).toBe(false);

    await tool("admin", "set_project_access", { project: "opened", email: "svc-bot@example.com", roles: ["Project admin"] });
    const bot = (await call("svc", "GET", "/api/scopes")).body.scopes.find((s: { slug: string }) => s.slug === "opened");
    for (const p of ["review", "moderate", "publish", "manage_members", "manage_settings"]) expect(bot.effective_permissions).not.toContain(p);
    expect(bot.effective_permissions).toEqual(expect.arrayContaining(["read", "propose", "security"]));
  });
});

describe("16. holders", () => {
  it("shows who holds a role only to people who can see access", async () => {
    const member = (await call("dave", "GET", "/api/roles")).body;
    expect(member.can_manage_roles).toBe(false);
    expect(member.can_see_holders).toBe(false);
    expect(member.roles.every((r: { holders: unknown }) => r.holders === null)).toBe(true);
    expect(member.model.project).toMatch(/^Project roles decide/);
    expect(member.team_roles).toEqual({ member: "Member", lead: "Lead (chooses the team's members)" });
    const writer = (await call("admin", "GET", "/api/roles")).body.roles.find((r: { key: string }) => r.key === "writer");
    expect(writer.holders).toMatchObject({ people: expect.any(Number), teams: expect.any(Number) });
    expect(writer.holders.teams).toBeGreaterThanOrEqual(1);
    expect(writer.allows[0]).toBe("Read: See the project and everything in it");

    expect((await call("dave", "GET", "/api/roles/Contributor/holders")).status).toBe(403);
    const holders = (await call("admin", "GET", "/api/roles/Contributor/holders")).body;
    expect(holders.role).toEqual({ key: "writer", name: "Contributor", kind: "project" });
    expect(holders.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "names", teams: [{ slug: "writers-team", name: "Writers" }] }),
        expect.objectContaining({ slug: "opened", people: [{ id: expect.any(String), email: "dave@example.com", name: null }] }),
      ]),
    );
    const auditors = await tool("erin", "list_roles", { role: "auditors" });
    expect(auditors.role).toMatchObject({ key: "auditor" });
    expect(auditors.holders.people.map((p: { email: string }) => p.email)).toContain("otto@example.com");
    expect((await tool("dave", "list_roles", { role: "Auditor" })).holders).toBeNull();
  });
});

describe("17. role kinds in the database", () => {
  it("refuses an organisation role given in a project", async () => {
    await expect(db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'auditor')", [await scopeId("names"), await idOf("dave")])).rejects.toThrow(
      /only project roles/,
    );
  });
});

describe("18. disabled people and service accounts aren't Project admins", () => {
  it("reports projects disabling someone leaves without a Project admin", async () => {
    await adminCreateProject(await as("admin"), { slug: "duo", name: "Duo" });
    await tool("admin", "set_project_access", { project: "duo", email: "gina2@example.com", roles: ["owner"] });
    await tool("admin", "set_project_access", { project: "duo", email: "svc-bot@example.com", roles: ["owner"] });
    const gina2 = await idOf("gina2");
    const off = await call("admin", "PATCH", `/api/users/${gina2}`, { disabled: true });
    expect(off.body.user.disabled_at).toBeTruthy();
    expect(off.body.projects_without_admin).toEqual([{ slug: "duo", name: "Duo" }]);
    expect((await call("admin", "PATCH", `/api/users/${gina2}`, { disabled: false })).status).toBe(200);
  });
});

describe("19. people over MCP", () => {
  it("approves people waiting and adds people with roles, checking everything before writing", async () => {
    await upsertUser(db, { subject: "dev:waiter@example.com", email: "waiter@example.com", kind: "human" }, { approval: true });
    expect((await tool("erin", "list_people", { query: "waiter" })).waiting_for_approval.map((p: { email: string }) => p.email)).toContain("waiter@example.com");
    expect(await tool("erin", "decide_access_request", { person: "waiter@example.com", decision: "approve" })).toMatchObject({ approved: true });
    expect((await tool("erin", "decide_access_request", { person: "waiter@example.com", decision: "approve" })).error).toMatch(/nobody is waiting/);

    expect(await tool("admin", "add_person", { email: "newbie@example.com", roles: ["Auditor"], project: "names", project_roles: ["QA"] })).toMatchObject({
      status: "added",
      roles: ["auditor"],
      role_names: ["Auditor"],
      project: "names",
      project_roles: ["qa"],
    });
    const newbie = await idOf("newbie");
    expect((await db.query("SELECT role FROM user_roles WHERE user_id = $1", [newbie])).rows).toEqual([{ role: "auditor" }]);
    expect((await db.query("SELECT role FROM scope_members WHERE user_id = $1", [newbie])).rows).toEqual([{ role: "qa" }]);

    expect((await tool("erin", "add_person", { email: "nope@example.com", roles: ["Project creator"] })).error).toMatch(/can't give or take away/);
    expect((await db.query("SELECT 1 FROM users WHERE email = 'nope@example.com'")).rowCount).toBe(0);
    expect((await tool("dave", "add_person", { email: "nope@example.com" })).error).toMatch(/add people/);

    // REST: the same. A User manager gives organisation roles they hold, and project roles only where they manage access.
    expect((await call("erin", "POST", "/api/users", { email: "rest@example.com", roles: ["User manager"] })).body).toMatchObject({
      status: "added",
      roles: ["user_manager"],
      project: null,
      project_roles: [],
    });
    expect((await call("erin", "POST", "/api/users", { email: "rest2@example.com", project: "names" })).status).toBe(403);
    expect((await db.query("SELECT 1 FROM users WHERE email = 'rest2@example.com'")).rowCount).toBe(0);
    expect((await call("admin", "POST", "/api/users", { email: "rest2@example.com", project: "names", role: "Viewer" })).body).toMatchObject({
      status: "added",
      project: "names",
      project_roles: ["reader"],
    });
  });

  it("creates built-in accounts with their roles all at once, or not at all", async () => {
    const local = { ...TEST_SETTINGS, authMode: "local" as const };
    const made = await createAccount(await ctxFor(db, { email: "admin@example.com", settings: local }), {
      email: "local1@example.com",
      roles: ["Auditor"],
      project: "names",
      projectRoles: ["QA", "Reviewer"],
    });
    expect(made).toMatchObject({ roles: ["auditor"], project: "names", project_roles: ["reviewer", "qa"] });
    expect(made.temporary_password).toBeTruthy();
    const id = made.user.id;
    expect((await db.query("SELECT role FROM user_roles WHERE user_id = $1", [id])).rows).toEqual([{ role: "auditor" }]);
    expect((await db.query("SELECT role FROM scope_members WHERE user_id = $1 ORDER BY role", [id])).rows).toEqual([{ role: "qa" }, { role: "reviewer" }]);
    await expect(createAccount(await ctxFor(db, { email: "erin@example.com", settings: local }), { email: "local2@example.com", roles: ["Auditor"] })).rejects.toThrow(/can't give or take away/);
    expect((await db.query("SELECT 1 FROM users WHERE email = 'local2@example.com'")).rowCount).toBe(0);
  });
});

describe("20. people by name, names in results, and other follow-ups", () => {
  it("takes a full name or 'me' when changing access, and never guesses from part of a name", async () => {
    await ctxFor(db, { email: "priya.rao@example.com" });
    await db.query("UPDATE users SET display_name = 'Priya Rao' WHERE email = 'priya.rao@example.com'");
    await adminCreateProject(await as("admin"), { slug: "leadgen", name: "Leadgen" });
    expect(await tool("admin", "set_project_access", { project: "leadgen", email: "priya rao", add: ["Reviewer"] })).toMatchObject({
      email: "priya.rao@example.com",
      roles: ["reviewer"],
      before_names: [],
      added_names: ["Reviewer"],
      removed_names: [],
    });
    expect((await tool("admin", "set_project_access", { project: "leadgen", email: "priya", add: ["QA"] })).error).toMatch(
      /isn't an email or anyone's full name; did you mean Priya Rao <priya\.rao@example\.com>/,
    );
    expect((await tool("admin", "set_project_access", { project: "leadgen", email: "zzqq", add: ["QA"] })).error).toMatch(/use find_people/);
    expect((await tool("admin", "set_project_access", { project: "leadgen", email: "me", add: ["QA"] })).email).toBe("admin@example.com");

    await tool("admin", "save_team", { team: "platform-eng", name: "Platform" });
    expect(await tool("admin", "set_team_membership", { team: "Platform team", email: "Priya Rao", member: true, lead: true })).toMatchObject({
      team: "platform-eng",
      email: "priya.rao@example.com",
      role: "lead",
    });
    expect((await tool("admin", "set_team_membership", { team: "no-such-team", email: "Priya Rao", member: true })).error).toMatch(/list_teams/);

    // Organisation roles: Manage people is checked before anyone is looked up, and part of a name is never enough.
    expect((await tool("dave", "set_user_roles", { email: "priya", add: ["Auditor"] })).error).toMatch(/Manage people/);
    expect((await tool("admin", "set_user_roles", { email: "priya", add: ["Auditor"] })).error).toMatch(/did you mean Priya Rao/);
    expect(await tool("admin", "set_user_roles", { email: "Priya Rao", add: ["Auditor"] })).toMatchObject({
      added: ["auditor"],
      added_names: ["Auditor"],
      before_names: [],
      role_names: ["Auditor"],
    });
    expect(await tool("admin", "set_project_access", { project: "leadgen", team: "platform-eng", add: ["Contributor"] })).toMatchObject({
      added_names: ["Contributor"],
      before_names: [],
    });
  });

  it("doesn't let people who can't see others' access find out who has an account", async () => {
    const known = await tool("dave", "get_person_access", { person: "priya.rao@example.com" });
    const unknown = await tool("dave", "get_person_access", { person: "nobody-at-all@example.com" });
    expect(known.error).toMatch(/needs Manage people/);
    expect(unknown.error).toBe(known.error);
    expect((await tool("dave", "get_person_access", { person: "dave@example.com" })).person.email).toBe("dave@example.com");
  });

  it("makes one change in several projects, each on its own", async () => {
    await adminCreateProject(await as("admin"), { slug: "leadgen-api", name: "Leadgen API" });
    const res = await tool("admin", "set_project_access", { projects: ["leadgen", "leadgen-api", "no-such-project"], team: "platform-eng", add: ["Reviewer"] });
    expect(res.changed).toBe(2);
    expect(res.results[1]).toMatchObject({ project: "leadgen-api", ok: true, added: ["reviewer"], added_names: ["Reviewer"] });
    expect(res.results[2]).toMatchObject({ project: "no-such-project", ok: false, error: expect.stringMatching(/list_projects shows/) });
    expect((await tool("admin", "set_project_access", { project: "leadgen", projects: ["leadgen-api"], team: "platform-eng", add: ["QA"] })).error).toMatch(/not both/);
    const listed = (await tool("admin", "list_projects")).projects.find((p: { slug: string }) => p.slug === "leadgen");
    expect(listed.project_admins).toEqual(listed.owners);
  });

  it("adds Read to project roles, and refuses names that would take over a built-in role's plural", async () => {
    const admin = await as("admin");
    expect(await createRole(admin, { kind: "project", name: "Checker", permissions: ["verify"] })).toMatchObject({ permissions: ["read", "verify"] });
    await expect(createRole(admin, { key: "viewers_custom", kind: "project", name: "Viewers", permissions: ["manage_members"] })).rejects.toThrow(/already used by Viewer/);
    await expect(createRole(admin, { key: "viewers", kind: "project", name: "Read team", permissions: ["read"] })).rejects.toThrow(/already used by Viewer/);
    await expect(createRole(admin, { key: "pa_custom", kind: "project", name: "Project admins", permissions: ["read"] })).rejects.toThrow(/already used by Project admin/);
    await deleteRole(admin, "Checker");
  });

  it("gives an invitation's roles from scope_roles only, keeping scope_role in step when a role is deleted", async () => {
    const local = { ...TEST_SETTINGS, authMode: "local" as const };
    const tokenOf = (link: string) => link.slice(link.indexOf("#/invite/") + "#/invite/".length);
    const admin = await as("admin");
    await createRole(admin, { key: "temp_two", kind: "project", name: "Temp two", permissions: ["read"] });
    const inv = await createInvitation(db, local, admin.actor.id, { email: "invitee3@example.com", scope: "names", roles: ["temp_two", "QA"] });
    await deleteRole(await as("admin"), "temp_two");
    expect((await db.query("SELECT scope_role, scope_roles FROM invitations WHERE id = $1", [inv.id])).rows[0]).toEqual({ scope_role: "qa", scope_roles: ["qa"] });
    // An older row whose roles were all taken away gives nothing, whatever scope_role says.
    const old = await createInvitation(db, local, admin.actor.id, { email: "invitee4@example.com", scope: "names", roles: ["QA"] });
    await db.query("UPDATE invitations SET scope_roles = '{}' WHERE id = $1", [old.id]);
    const accepted = await acceptInvitation(db, tokenOf(old.link), { password: "a-long-enough-passphrase-9" });
    expect((await db.query("SELECT role FROM scope_members WHERE user_id = $1", [accepted!.userId])).rows).toEqual([]);
  });

  it("refuses taking a project out of a parent you don't manage as a permission problem (403)", async () => {
    await adminCreateProject(await as("admin"), { slug: "top9", name: "Top9" });
    await adminCreateProject(await as("admin"), { slug: "kid9", name: "Kid9", parent: "top9" });
    await tool("admin", "set_project_access", { project: "kid9", email: "dave@example.com", roles: ["owner"] });
    const res = await call("dave", "PUT", "/api/projects/kid9/parent", { parent: null });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Manage settings in Top9 .* take a project out/);
  });

  it("lets a Team manager start a project for a team without Create projects (D10d)", async () => {
    const res = await call("hank", "POST", "/api/teams/platform-eng/projects", { slug: "plat-proj", name: "Platform project" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ team: "platform-eng", team_roles: ["writer"] });
  });
});

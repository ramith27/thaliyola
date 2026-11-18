import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { createApiToken } from "../src/auth/local.js";
import { createProject } from "../src/core/admin.js";
import { flushDeliveries } from "../src/core/notify.js";
import { setUserRoles } from "../src/core/roles.js";
import { createTeam, setTeamMember } from "../src/core/teams.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

/** The MCP tools for jobs that used to be web-only: team projects, account status and project requests. */

let db: Db;
let server: Server;
let base: string;
const PEOPLE = ["admin", "erin", "hank", "lena", "mo", "otto", "pat", "sam", "wait"];
const clients: Record<string, Client> = {};

const as = (p: string) => ctxFor(db, { email: `${p}@example.com` });
const idOf = async (p: string) => (await db.query("SELECT id FROM users WHERE email = $1", [`${p}@example.com`])).rows[0].id as string;

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator(PEOPLE.map((p) => `${p}=${p}@example.com`).join(",")), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of PEOPLE) await as(p);
  const admin = await as("admin");
  await setUserRoles(admin, await idOf("erin"), ["user_manager"]);
  await setUserRoles(admin, await idOf("hank"), ["team_manager"]);
  await setUserRoles(admin, await idOf("otto"), ["auditor"]);
  await setUserRoles(admin, await idOf("pat"), ["project_creator"]);
  await setUserRoles(admin, await idOf("sam"), ["security_lead"]);
  await createTeam(admin, { slug: "growth", name: "Growth" });
  await setTeamMember(admin, "growth", "lena@example.com", true, "lead");
  await setTeamMember(admin, "growth", "mo@example.com", true, "member");
});
afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await flushDeliveries();
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

const teamRoles = async (project: string) =>
  (await db.query("SELECT t.slug, r.role FROM scope_team_roles r JOIN teams t ON t.id = r.team_id JOIN scopes s ON s.id = r.scope_id WHERE s.slug = $1 ORDER BY 1, 2", [project])).rows;
const owners = async (project: string) =>
  (await db.query("SELECT u.email FROM scope_members m JOIN users u ON u.id = m.user_id JOIN scopes s ON s.id = m.scope_id WHERE s.slug = $1 AND m.role = 'owner' ORDER BY 1", [project])).rows.map(
    (r: { email: string }) => r.email,
  );

describe("create_project for a team", () => {
  it("lets a team lead start a project for the team, which gets its roles there, as on the team's page", async () => {
    const res = await tool("lena", "create_project", { slug: "growth-app", name: "Growth app", team: "growth", repos: [{ slug: "web", kind: "frontend" }] });
    expect(res).toMatchObject({ status: "created", project: "growth-app", project_name: "Growth app", team: "growth", team_name: "Growth", team_roles: ["writer"], team_role_names: ["Contributor"], repositories: 1 });
    expect(res.note).toMatch(/Growth's members hold Contributor there/);
    expect(await teamRoles("growth-app")).toEqual([{ slug: "growth", role: "writer" }]);
    expect(await owners("growth-app")).toEqual(["lena@example.com"]);
    // Lena has no Create projects: without team it's only a request.
    expect(await tool("lena", "create_project", { slug: "lena-solo", name: "Solo" })).toMatchObject({ status: "requested" });
  });

  it("takes the team's name and the roles to give it; Team managers may do it for any team", async () => {
    const res = await tool("hank", "create_project", { slug: "growth-data", name: "Growth data", team: "Growth team", team_roles: ["Reviewer", "QA"] });
    expect(res.team).toBe("growth");
    expect([...res.team_role_names].sort()).toEqual(["QA", "Reviewer"]);
    expect((await teamRoles("growth-data")).map((r: { role: string }) => r.role).sort()).toEqual([...res.team_roles].sort());
    expect(await owners("growth-data")).toEqual(["hank@example.com"]);
  });

  it("refuses members who don't lead the team, and says what to do instead", async () => {
    const r = await tool("mo", "create_project", { slug: "mo-team", name: "Mo", team: "growth" });
    expect(r.error).toMatch(/leads, team managers and admins/);
    expect(r.error).toMatch(/Leave team out/);
    // A Project creator who isn't a lead can't hand a team roles this way either.
    expect((await tool("pat", "create_project", { slug: "pat-team", name: "Pat", team: "growth" })).error).toMatch(/leads, team managers/);
    expect((await db.query("SELECT 1 FROM scopes WHERE slug IN ('mo-team', 'pat-team')")).rowCount).toBe(0);
  });

  it("refuses unknown teams, taken slugs and team_roles without a team", async () => {
    expect((await tool("lena", "create_project", { slug: "x-1", name: "X", team: "nope" })).error).toMatch(/no team 'nope'/);
    expect((await tool("lena", "create_project", { slug: "growth-app", name: "Again", team: "growth" })).error).toMatch(/already taken/);
    expect((await tool("pat", "create_project", { slug: "x-2", name: "X", team_roles: ["Reviewer"] })).error).toMatch(/team_roles needs team/);
    expect((await tool("lena", "create_project", { slug: "x-3", name: "X", team: "growth", team_roles: [] })).error).toMatch(/at least one role/);
  });
});

describe("parents a caller can't see", () => {
  it("answers exactly as for a missing project, so a members-only project's name and slug don't leak", async () => {
    const admin = await as("admin");
    await createProject(admin, { slug: "secret-x", name: "Project Nightingale Acquisition", visibility: "members" });
    await createProject(admin, { slug: "open-x", name: "Open X", visibility: "team" });
    const hidden = (await tool("lena", "create_project", { slug: "growth-sub", name: "Sub", team: "growth", parent: "secret-x" })).error as string;
    const missing = (await tool("lena", "create_project", { slug: "growth-sub", name: "Sub", team: "growth", parent: "no-such-x" })).error as string;
    expect(hidden).not.toMatch(/Nightingale/);
    expect(hidden.replace("secret-x", "SLUG")).toBe(missing.replace("no-such-x", "SLUG"));
    expect(hidden).toMatch(/not found/);
    expect((await tool("lena", "get_project_context", { project: "secret-x" })).error).toMatch(/not found/);
    // A project lena can read but doesn't manage is named, as before.
    expect((await tool("lena", "create_project", { slug: "growth-sub", name: "Sub", team: "growth", parent: "open-x" })).error).toMatch(/you don't manage Open X/);
    // A Project creator gets the same answer, and so does moving a project with set_project_parent.
    const pat = (await tool("pat", "create_project", { slug: "pat-sub", name: "Sub", parent: "secret-x" })).error as string;
    expect(pat).not.toMatch(/Nightingale/);
    expect(pat).toMatch(/scope 'secret-x' not found/);
    expect(await tool("lena", "create_project", { slug: "growth-top", name: "Top", team: "growth" })).toMatchObject({ status: "created" });
    const moved = (await tool("lena", "set_project_parent", { project: "growth-top", parent: "secret-x" })).error as string;
    expect(moved).not.toMatch(/Nightingale/);
    expect(moved.replace("secret-x", "SLUG")).toBe((await tool("lena", "set_project_parent", { project: "growth-top", parent: "no-such-x" })).error.replace("no-such-x", "SLUG"));
    expect((await db.query("SELECT 1 FROM scopes WHERE slug IN ('growth-sub', 'pat-sub')")).rowCount).toBe(0);
    // Someone who manages the hidden project can still put projects under it.
    expect(await tool("admin", "create_project", { slug: "secret-sub", name: "Secret sub", parent: "secret-x" })).toMatchObject({ status: "created" });
  });
});

describe("set_account_status", () => {
  it("needs Manage people, before anyone is looked up", async () => {
    expect((await tool("otto", "set_account_status", { person: "mo@example.com", status: "disabled" })).error).toMatch(/Manage people/);
    expect((await tool("otto", "set_account_status", { person: "ghost@example.com", status: "disabled" })).error).toMatch(/Manage people/);
    expect((await tool("lena", "set_account_status", { person: "mo@example.com", status: "disabled" })).error).toMatch(/Manage people/);
  });

  it("disables an account (signing it out everywhere) and enables it again", async () => {
    const mo = await idOf("mo");
    await createApiToken(db, mo, "laptop");
    await db.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('h-mo', $1, now() + interval '1 day')", [mo]);
    const off = await tool("erin", "set_account_status", { person: "mo@example.com", status: "disabled" });
    expect(off).toMatchObject({ person: "mo@example.com", kind: "human", before: "enabled", status: "disabled", changed: true });
    expect(off.summary).toMatch(/can't sign in/);
    const row = (await db.query("SELECT disabled_at FROM users WHERE id = $1", [mo])).rows[0];
    expect(row.disabled_at).not.toBeNull();
    expect((await db.query("SELECT 1 FROM sessions WHERE user_id = $1", [mo])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL", [mo])).rowCount).toBe(0);
    // A disabled account can't use the tools.
    expect(await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer mo", "content-type": "application/json" }, body: "{}" }).then((r) => r.status)).toBeGreaterThanOrEqual(401);
    // Again: nothing changes.
    expect(await tool("erin", "set_account_status", { person: "mo@example.com", status: "disabled" })).toMatchObject({ before: "disabled", changed: false });
    // By the id list_people shows.
    expect(await tool("erin", "set_account_status", { person: mo, status: "enabled" })).toMatchObject({ before: "disabled", status: "enabled", changed: true });
    expect((await db.query("SELECT disabled_at FROM users WHERE id = $1", [mo])).rows[0].disabled_at).toBeNull();
    const audits = (await db.query("SELECT tool FROM audit_log WHERE target_id = $1 ORDER BY at", [mo])).rows.map((r: { tool: string }) => r.tool);
    expect(audits.filter((t: string) => t === "update_user")).toHaveLength(2);
  });

  it("applies the Users page's rules: not yourself, Administrators only by Administrators, no escalation", async () => {
    expect((await tool("erin", "set_account_status", { person: "me", status: "disabled" })).error).toMatch(/disable yourself/);
    expect((await tool("erin", "set_account_status", { person: "admin@example.com", status: "disabled" })).error).toMatch(/only Administrators/);
    // Sam holds Security lead, whose permissions Erin doesn't have.
    expect((await tool("erin", "set_account_status", { person: "sam@example.com", status: "disabled" })).error).toMatch(/you can't disable sam@example.com: they hold Security lead/);
    expect((await db.query("SELECT disabled_at FROM users WHERE email IN ('sam@example.com', 'admin@example.com', 'erin@example.com') AND disabled_at IS NOT NULL")).rowCount).toBe(0);
    // An Administrator can.
    expect(await tool("admin", "set_account_status", { person: "sam@example.com", status: "disabled" })).toMatchObject({ changed: true, status: "disabled" });
    expect(await tool("admin", "set_account_status", { person: "sam@example.com", status: "enabled" })).toMatchObject({ changed: true, status: "enabled" });
  });

  it("never guesses from part of a name, and leaves people waiting for approval to decide_access_request", async () => {
    await db.query("UPDATE users SET display_name = 'Mo Salah' WHERE email = 'mo@example.com'");
    expect((await tool("erin", "set_account_status", { person: "mo", status: "disabled" })).error).toMatch(/did you mean Mo Salah/);
    expect(await tool("erin", "set_account_status", { person: "Mo Salah", status: "disabled" })).toMatchObject({ person: "mo@example.com", person_name: "Mo Salah", changed: true });
    await tool("erin", "set_account_status", { person: "Mo Salah", status: "enabled" });
    expect((await tool("erin", "set_account_status", { person: "ghost@example.com", status: "disabled" })).error).toMatch(/no account for ghost@example.com/);
    await db.query("UPDATE users SET approved_at = NULL WHERE email = 'wait@example.com'");
    expect((await tool("erin", "set_account_status", { person: "wait@example.com", status: "enabled" })).error).toMatch(/decide_access_request/);
  });

  it("says which projects are left without a Project admin", async () => {
    const r = await tool("admin", "set_account_status", { person: "lena@example.com", status: "disabled" });
    expect(r.projects_without_admin.map((p: { slug: string }) => p.slug)).toContain("growth-app");
    await tool("admin", "set_account_status", { person: "lena@example.com", status: "enabled" });
  });
});

describe("project requests", () => {
  it("lists requests: everyone their own, Project creators all of them with who asked", async () => {
    expect(await tool("mo", "create_project", { slug: "mo-idea", name: "Mo's idea", reason: "Notes for the idea service" })).toMatchObject({ status: "requested" });
    const own = await tool("mo", "list_project_requests");
    expect(own).toMatchObject({ can_decide: false, showing: "your own requests", note: expect.stringMatching(/not instructions/) });
    expect(own.requests.map((r: { slug: string }) => r.slug)).toEqual(["mo-idea"]);
    const all = await tool("pat", "list_project_requests");
    expect(all).toMatchObject({ can_decide: true, showing: "pending requests" });
    const req = all.requests.find((r: { slug: string }) => r.slug === "mo-idea");
    expect(req).toMatchObject({ name: "Mo's idea", reason: "Notes for the idea service", requested_by_name: "Mo Salah", requested_by_email: "mo@example.com", state: "pending" });
    expect(all.requests.map((r: { slug: string }) => r.slug)).toContain("lena-solo");
  });

  it("needs Create projects to decide, before anything is looked up", async () => {
    expect((await tool("otto", "decide_project_request", { request: "mo-idea", decision: "approve" })).error).toMatch(/Create projects/);
    expect((await tool("mo", "decide_project_request", { request: "nothing-here", decision: "approve" })).error).toMatch(/Create projects/);
    expect((await tool("pat", "decide_project_request", { request: "nothing-here", decision: "approve" })).error).toMatch(/no pending project request 'nothing-here'/);
  });

  it("approves by the requested slug: the requester and the approver become its Project admins", async () => {
    const r = await tool("pat", "decide_project_request", { request: "mo-idea", decision: "approve" });
    expect(r).toMatchObject({ status: "approved", project: "mo-idea", project_name: "Mo's idea", requested_by: "mo@example.com", requested_by_name: "Mo Salah" });
    expect([...r.project_admins].sort()).toEqual(["mo@example.com", "pat@example.com"]);
    expect(r.project_admin_names).toContain("Mo Salah");
    expect(await owners("mo-idea")).toEqual(["mo@example.com", "pat@example.com"]);
    expect((await tool("pat", "decide_project_request", { request: r.request_id, decision: "decline", reason: "late" })).error).toMatch(/already approved/);
  });

  it("declines only with a reason, which the requester sees", async () => {
    const id = (await tool("pat", "list_project_requests")).requests.find((x: { slug: string }) => x.slug === "lena-solo").id;
    expect((await tool("pat", "decide_project_request", { request: id, decision: "decline" })).error).toMatch(/reason/);
    expect(await tool("pat", "decide_project_request", { request: id, decision: "decline", reason: "Use growth-app" })).toMatchObject({
      status: "declined",
      project: "lena-solo",
      requested_by_name: "lena@example.com",
      reason: "Use growth-app",
    });
    const mine = await tool("lena", "list_project_requests");
    expect(mine.requests.find((x: { slug: string }) => x.slug === "lena-solo")).toMatchObject({ state: "declined", decision_note: "Use growth-app" });
    expect((await db.query("SELECT 1 FROM scopes WHERE slug = 'lena-solo'")).rowCount).toBe(0);
  });

  it("approves under another slug and name", async () => {
    await tool("mo", "create_project", { slug: "mo-two", name: "Two" });
    const r = await tool("admin", "decide_project_request", { request: "mo-two", decision: "approve", slug: "mo-second", name: "Second" });
    expect(r).toMatchObject({ project: "mo-second", project_name: "Second" });
    expect((await db.query("SELECT name FROM scopes WHERE slug = 'mo-second'")).rows[0].name).toBe("Second");
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenAuthenticator, chain, devAuthenticator } from "../src/auth/index.js";
import { agentCallSql, audit, inAuditRequest, scrubDetails } from "../src/core/audit.js";
import { actionKey, AUDIT_ACTIONS, canSeeAuditLog, describeAction, isReadAction, READ_ACTIONS, suffixDetails } from "../src/core/audit-log.js";
import { savePersonalNote } from "../src/core/personal.js";
import { createRole, setUserRoles } from "../src/core/roles.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
const PEOPLE = ["admin", "member", "otto", "rhea", "uma"];
const clients: Client[] = [];

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  const tokens = [...PEOPLE.map((p) => `${p}=${p}@example.com`), "svc=svc-bot@example.com"].join(",");
  server = createApp({ db, authenticate: chain(apiTokenAuthenticator(db), devAuthenticator(tokens)), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of PEOPLE) await ctxFor(db, { email: `${p}@example.com` });
  await ctxFor(db, { email: "svc-bot@example.com", service: true });
  const admin = await ctxFor(db, { email: "admin@example.com" });
  // otto: Auditor (Read every project + See usage). rhea: only Read every project. uma: only See usage.
  await setUserRoles(admin, await idOf("otto"), ["auditor"]);
  await createRole(admin, { kind: "org", name: "Reads everything", permissions: ["read_all_projects"] });
  await createRole(admin, { kind: "org", name: "Usage watcher", permissions: ["view_metrics"] });
  await setUserRoles(admin, await idOf("rhea"), ["Reads everything"]);
  await setUserRoles(admin, await idOf("uma"), ["Usage watcher"]);
});
afterAll(async () => {
  for (const c of clients) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

const idOf = async (p: string) => (await db.query("SELECT id FROM users WHERE email = $1", [`${p}@example.com`])).rows[0].id as string;

async function call(auth: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, "content-type": "application/json", origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // CSV
  }
  return { status: res.status, body: parsed as any, headers: res.headers };
}

async function tool(auth: string, name: string, args: Record<string, unknown> = {}) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${auth}` } } }));
  clients.push(client);
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}

const allAudit = async () => JSON.stringify((await db.query("SELECT tool, details, target_label FROM audit_log")).rows);
/** Every column of every audit row, as text. */
const everyColumn = async () => (await db.query<{ row: string }>("SELECT a::text AS row FROM audit_log a")).rows.map((r) => r.row).join("\n");
type Entry = { action: string; target: Record<string, unknown> | null; details: Record<string, unknown> | null; via: string | null };
/** The newest change with this action, as the page shows it. */
async function newest(action: string, query = ""): Promise<Entry> {
  const page = await call("admin", "GET", `/audit?action=${action}${query}`);
  expect(page.status, JSON.stringify(page.body)).toBe(200);
  const e = page.body.entries.find((x: Entry) => x.action === action);
  expect(e, action).toBeTruthy();
  return e;
}

describe("who may see the audit log", () => {
  it("lets Administrators and Auditors in, and nobody with only one of the two permissions", async () => {
    expect((await call("admin", "GET", "/audit")).status).toBe(200);
    expect((await call("otto", "GET", "/audit")).status).toBe(200);
    for (const who of ["member", "rhea", "uma", "svc"]) {
      const res = await call(who, "GET", "/audit");
      expect(res.status, who).toBe(403);
      expect(res.body.error).toMatch(/Read every project and See usage/);
      expect((await call(who, "GET", "/audit.csv")).status, who).toBe(403);
    }
  });

  it("applies the same rule to the MCP tool, before looking anyone up", async () => {
    expect((await tool("member", "list_audit_log", { person: "nobody@example.com" })).error).toMatch(/Read every project and See usage/);
    const page = await tool("otto", "list_audit_log", { limit: 5 });
    expect(Array.isArray(page.entries)).toBe(true);
  });

  it("states the rule once", async () => {
    const svc = await ctxFor(db, { email: "svc-bot@example.com", service: true });
    expect(canSeeAuditLog(svc)).toBe(false);
    expect(canSeeAuditLog(await ctxFor(db, { email: "admin@example.com" }))).toBe(true);
  });
});

describe("what the audit log records and shows", () => {
  it("records a role change with its details, once, with the person's name and a readable label", async () => {
    const member = await idOf("member");
    expect((await call("admin", "PATCH", `/users/${member}`, { add: ["Project creator"] })).status).toBe(200);
    const page = await call("otto", "GET", `/audit?target=${member}`);
    expect(page.status).toBe(200);
    const change = page.body.entries.find((e: { action: string }) => e.action === "update_user");
    expect(change).toMatchObject({
      label: "Changed an account",
      group: "people",
      actor: { name: expect.any(String), email: "admin@example.com", kind: "human" },
      target: { id: member, kind: "person", label: "member@example.com", ref: member },
      details: { added: ["project_creator"], removed: [] },
    });
    expect(page.body.target).toMatchObject({ id: member, kind: "person" });
  });

  it("hides the web call that wrapped a recorded change, and says how it came in", async () => {
    const created = await call("admin", "POST", "/service-accounts", { name: "ci-docs", display_name: "CI docs" });
    expect(created.status).toBe(200);
    const page = await call("admin", "GET", `/audit?target=${created.body.id}`);
    const actions = page.body.entries.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === "create_service_account")).toHaveLength(1);
    expect(page.body.entries[0]).toMatchObject({ action: "create_service_account", via: "api", target: { kind: "service_account", label: "CI docs" }, details: { identifier: "service:ci-docs" } });
    // Both rows are still stored (usage numbers count them).
    const stored = await db.query(
      "SELECT tool, via FROM audit_log WHERE request_id = (SELECT request_id FROM audit_log WHERE target_id = $1 AND tool = 'create_service_account') ORDER BY id",
      [created.body.id],
    );
    expect(stored.rows).toEqual([
      { tool: "create_service_account", via: null },
      { tool: "api:create_service_account", via: "api" },
    ]);
  });

  it("names the targets of older rows when they're read", async () => {
    const admin = await idOf("admin");
    await db.query("INSERT INTO audit_log (actor_id, tool, target_id) VALUES ($1, 'approve_revision', $2), ($1, 'api:admin_update_scope', $3)", [admin, ids.runbook, ids.project]);
    const page = await call("admin", "GET", `/audit?person=${admin}&limit=5`);
    const [scope, item] = page.body.entries;
    expect(item).toMatchObject({ action: "approve_revision", label: "Approved a proposal", target: { kind: "article", id: ids.runbook, label: expect.any(String) } });
    expect(item.target.label.length).toBeGreaterThan(0);
    expect(scope).toMatchObject({ action: "admin_update_scope", label: "Changed a project", target: { kind: "project", ref: "order-service", label: "Order service v2" } });
    expect(page.body.person).toMatchObject({ id: admin, email: "admin@example.com" });
    // By email too; an unknown email matches nothing.
    const byEmail = await call("admin", "GET", `/audit?person=admin@example.com&limit=5`);
    expect(byEmail.body.entries.map((e: { id: string }) => e.id)).toEqual(page.body.entries.map((e: { id: string }) => e.id));
    expect((await call("admin", "GET", `/audit?person=nobody@example.com`)).body.entries).toEqual([]);
  });

  it("never shows the title of something in another person's personal space", async () => {
    const member = await ctxFor(db, { email: "member@example.com" });
    await savePersonalNote(member, { title: "My salary negotiation notes", body_md: "private" });
    const note = (await db.query("SELECT id FROM articles WHERE title = 'My salary negotiation notes'")).rows[0].id;
    await db.query("INSERT INTO audit_log (actor_id, tool, target_id) VALUES ($1, 'get_article', $2)", [member.actor.id, note]);
    const page = await call("admin", "GET", `/audit?person=${member.actor.id}&reads=true`);
    expect(JSON.stringify(page.body)).not.toContain("salary");
    const row = page.body.entries.find((e: { action: string }) => e.action === "get_article");
    expect(row.target).toMatchObject({ id: null, ref: null, label: "A private note", private: true });
  });

  it("leaves page views and searches out unless asked, and filters by action (with its aliases), person and dates", async () => {
    const otto = await idOf("otto");
    await call("otto", "GET", "/me");
    await call("otto", "GET", "/scopes");
    const changes = await call("admin", "GET", `/audit?person=${otto}`);
    expect(changes.body.entries.every((e: { action: string }) => !isReadAction(e.action))).toBe(true);
    const reads = await call("admin", "GET", `/audit?person=${otto}&reads=true`);
    expect(reads.body.entries.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(["me", "audit"]));

    // approve and approve_revision share a label: filtering by either finds both.
    const admin = await idOf("admin");
    await db.query("INSERT INTO audit_log (actor_id, tool, target_id) VALUES ($1, 'api:approve', NULL)", [admin]);
    const approvals = await call("admin", "GET", "/audit?action=approve_revision");
    expect(new Set(approvals.body.entries.map((e: { action: string }) => e.action))).toEqual(new Set(["approve", "approve_revision"]));

    // Dates: an old row only shows in a range that includes it.
    await db.query("INSERT INTO audit_log (actor_id, tool, at) VALUES ($1, 'create_team', '2020-03-04T10:00:00Z')", [admin]);
    const inRange = await call("admin", "GET", "/audit?from=2020-03-04&to=2020-03-04");
    expect(inRange.body.entries.map((e: { action: string }) => e.action)).toEqual(["create_team"]);
    expect((await call("admin", "GET", "/audit?from=2020-03-05&to=2020-03-06")).body.entries).toEqual([]);
    expect((await call("admin", "GET", "/audit?from=not-a-date")).status).toBe(400);
    expect((await call("admin", "GET", "/audit?person=not-a-uuid")).status).toBe(400);
    expect((await call("admin", "GET", "/audit?action=drop%20table")).status).toBe(400);
  });

  it("pages with a cursor, without repeats or gaps", async () => {
    const first = await call("admin", "GET", "/audit?limit=3");
    expect(first.body.entries).toHaveLength(3);
    expect(first.body.next_cursor).toBe(first.body.entries[2].id);
    expect(first.body.actions.length).toBeGreaterThan(10);
    const second = await call("admin", "GET", `/audit?limit=3&cursor=${first.body.next_cursor}`);
    expect(second.body.actions).toBeUndefined();
    const all = await call("admin", "GET", "/audit?limit=6");
    expect([...first.body.entries, ...second.body.entries].map((e: { id: string }) => e.id)).toEqual(all.body.entries.map((e: { id: string }) => e.id));
    expect((await call("admin", "GET", "/audit?cursor=abc")).status).toBe(400);
  });

  it("downloads the filtered log as CSV that spreadsheets won't run as formulas, and records the download", async () => {
    const admin = await idOf("admin");
    await audit(db, admin, "create_role", null, { targetKind: "role", targetLabel: '=HYPERLINK("http://evil")', details: { key: "x" } });
    const res = await call("otto", "GET", "/audit.csv?action=create_role");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="thaliyola-audit-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = (res.body as string).trim().split("\r\n");
    expect(lines[0]).toBe("Time (UTC),Person,Email,Action,Action key,Target type,Target,Target id,Via,Details");
    expect(lines.length).toBeGreaterThan(1);
    expect(res.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(res.body).not.toMatch(/,=HYPERLINK/);
    const recorded = await call("admin", "GET", "/audit?action=export_audit");
    expect(recorded.body.entries[0]).toMatchObject({ action: "export_audit", actor: { email: "otto@example.com" }, details: { filters: { action: "create_role" } } });
  });
});

describe("secrets stay out of the audit log", () => {
  it("scrubs secret-looking keys and values", () => {
    expect(
      scrubDetails({
        token: "abc",
        password: "hunter2",
        token_hash: "x",
        slack_webhook_url: "https://hooks.slack.com/services/T/B/X",
        token_name: "Laptop",
        note: "thaliyola_pat_abcdef",
        link: "https://user:pw@example.com/x",
        nested: { client_secret: "s", ok: 1 },
        when: new Date("2026-11-13T10:00:00Z"),
      }),
    ).toEqual({ token_name: "Laptop", note: "[hidden]", link: "[hidden]", nested: { ok: 1 }, when: "2026-11-13T10:00:00.000Z" });
  });

  it("records settings changes with values, but a secret setting only as changed", async () => {
    const res = await call("admin", "PATCH", "/system/settings", { slack_webhook_url: "https://hooks.slack.com/services/T000/B000/SECRETSECRET", digest_hour: 9 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const page = await call("admin", "GET", "/audit?action=update_system_settings");
    const changes = page.body.entries[0].details.changes;
    expect(changes).toEqual(
      expect.arrayContaining([
        { setting: "slack_webhook_url", label: expect.any(String), change: "changed" },
        expect.objectContaining({ setting: "digest_hour", to: 9 }),
      ]),
    );
    expect(await allAudit()).not.toContain("SECRETSECRET");
  });

  it("never records temporary passwords, new tokens or invitation links", async () => {
    const token = await call("admin", "POST", "/account/tokens", { name: "Laptop", expires_in_days: 30 });
    expect(token.body.token).toMatch(/^thaliyola_pat_/);
    const sa = await call("admin", "POST", "/service-accounts", { name: "nightly" });
    const saToken = await call("admin", "POST", `/service-accounts/${sa.body.id}/tokens`, { name: "Nightly job" });
    const everything = await allAudit();
    expect(everything).not.toContain(token.body.token);
    expect(everything).not.toContain(saToken.body.token);
    expect(everything).not.toContain("thaliyola_pat_");
    const page = await call("admin", "GET", `/audit?target=${token.body.id}`);
    expect(page.body.entries[0]).toMatchObject({ action: "create_api_token", target: { kind: "token", label: "Laptop" }, details: { token_name: "Laptop" } });
  });
});

describe("action labels", () => {
  it("normalises tools to action keys and labels unknown ones readably", () => {
    expect(actionKey("api:create_role")).toBe("create_role");
    expect(actionKey("system_settings:digest_hour,mail_from")).toBe("system_settings");
    expect(describeAction("system_settings:digest_hour")).toMatchObject({ label: "Changed system settings", group: "settings" });
    expect(describeAction("api:some_new_thing")).toEqual({ key: "some_new_thing", label: "Some new thing", group: "other" });
    expect(describeAction("search_knowledge").group).toBe("reads");
    expect(isReadAction("rotate_api_token")).toBe(false);
    for (const [key, def] of Object.entries(AUDIT_ACTIONS)) expect(def.label, key).toMatch(/^[A-Z]/);
  });
});

describe("role and access changes are recorded with their details", () => {
  it("project roles: who got which roles on which project", async () => {
    const res = await call("admin", "PUT", "/scopes/order-service/members", { email: "uma@example.com", roles: ["Contributor"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const e = await newest("set_member_roles");
    expect(e).toMatchObject({ via: "api", target: { id: ids.project, kind: "project", label: "Order service v2" }, details: { person: "uma@example.com", person_id: await idOf("uma"), before: [], removed: [] } });
    expect(e.details!.added).toEqual(e.details!.after);
    expect((e.details!.added as string[]).length).toBe(1);
  });

  it("team project roles: which team got which roles on which project", async () => {
    expect((await call("admin", "POST", "/teams", { slug: "auditors", name: "Auditors" })).status).toBe(200);
    const res = await call("admin", "PUT", "/scopes/order-service/teams", { team: "auditors", roles: ["Viewer"] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const e = await newest("set_team_role");
    expect(e).toMatchObject({ target: { id: ids.project, kind: "project" }, details: { team: "auditors", before: [], removed: [] } });
    expect((e.details!.added as string[]).length).toBe(1);
  });

  it("team membership: the team is the target; who was added, made a lead or removed", async () => {
    const created = await newest("create_team");
    expect(created).toMatchObject({ target: { kind: "team", label: "Auditors", ref: "auditors" }, details: { team: "auditors" } });
    const teamId = created.target!.id as string;
    const otto = await idOf("otto");
    expect((await call("admin", "PUT", "/teams/auditors/members", { email: "otto@example.com", member: true })).status).toBe(200);
    expect((await call("admin", "PUT", "/teams/auditors/members", { email: "otto@example.com", member: true, role: "lead" })).status).toBe(200);
    expect((await call("admin", "PUT", "/teams/auditors/members", { email: "otto@example.com", member: false })).status).toBe(200);
    // Repeating a change that changes nothing records nothing.
    expect((await call("admin", "PUT", "/teams/auditors/members", { email: "rhea@example.com", member: true })).status).toBe(200);
    expect((await call("admin", "PUT", "/teams/auditors/members", { email: "rhea@example.com", member: true })).status).toBe(200);
    expect((await call("admin", "PATCH", "/teams/auditors", { name: "Audit team" })).status).toBe(200);

    const page = await call("admin", "GET", `/audit?target=${teamId}`);
    const rows = page.body.entries.map((e: Entry) => ({ action: e.action, details: e.details }));
    expect(rows).toEqual([
      { action: "update_team", details: { team: "auditors", name_before: "Auditors", name_after: "Audit team" } },
      { action: "set_team_member", details: expect.objectContaining({ person: "rhea@example.com", member: "added", role: "member", before_role: null }) },
      { action: "set_team_member", details: { team: "auditors", person: "otto@example.com", person_id: otto, member: "removed", role: null, before_role: "lead" } },
      { action: "set_team_member", details: expect.objectContaining({ person: "otto@example.com", member: "role changed", role: "lead", before_role: "member" }) },
      { action: "set_team_member", details: expect.objectContaining({ person: "otto@example.com", member: "added", role: "member", before_role: null }) },
      { action: "create_team", details: { team: "auditors" } },
    ]);
    expect(page.body.entries[0].target).toMatchObject({ id: teamId, kind: "team", label: "Audit team", ref: "auditors" });
    expect(page.body.target).toMatchObject({ id: teamId, kind: "team", label: "Audit team" });

    // The MCP tool records the same change.
    await tool("admin", "set_team_membership", { team: "auditors", email: "uma@example.com", member: true });
    const viaMcp = await newest("set_team_member");
    expect(viaMcp).toMatchObject({ via: "mcp", target: { id: teamId, kind: "team" }, details: { person: "uma@example.com", member: "added" } });

    // A deleted team keeps its name in the log.
    expect((await call("admin", "DELETE", "/teams/auditors")).status).toBe(200);
    const deleted = await newest("delete_team");
    expect(deleted).toMatchObject({ target: { id: teamId, kind: "team", label: "Audit team" }, details: { team: "auditors", projects_left_without_admin: [] } });
  });

  it("roles: created, changed and deleted, with their permissions", async () => {
    const created = await call("admin", "POST", "/roles", { kind: "org", name: "Log readers", permissions: ["view_metrics"] });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(await newest("create_role")).toMatchObject({ target: { kind: "role", label: "Log readers" }, details: { kind: "org", permissions: ["view_metrics"] } });
    expect((await call("admin", "PATCH", "/roles/Log readers", { name: "Log watchers", permissions: ["view_metrics", "read_all_projects"] })).status).toBe(200);
    expect(await newest("update_role")).toMatchObject({
      target: { kind: "role", label: "Log watchers" },
      details: { name_before: "Log readers", name_after: "Log watchers", added: ["read_all_projects"], removed: [] },
    });
    expect((await call("admin", "DELETE", "/roles/Log watchers")).status).toBe(200);
    expect(await newest("delete_role")).toMatchObject({ target: { kind: "role", label: "Log watchers" }, details: { kind: "org", grants_removed: expect.any(Number) } });
  });

  it("project visibility: which projects, and to what", async () => {
    const res = await call("admin", "POST", "/projects/visibility", { projects: ["order-service"], visibility: "members" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await newest("set_projects_visibility")).toMatchObject({ details: { visibility: "members", projects: ["order-service"], refused: [] } });
    await call("admin", "POST", "/projects/visibility", { projects: ["order-service"], visibility: "team" });
  });
});

describe("account and service-account changes are recorded with their details", () => {
  const waiting = async (email: string) =>
    (await db.query("INSERT INTO users (subject, email, kind, approved_at) VALUES ($1, $2, 'human', NULL) RETURNING id", [`cf:${email}`, email])).rows[0].id as string;

  it("approving and declining someone's access", async () => {
    const yes = await waiting("waiting-yes@example.com");
    const no = await waiting("waiting-no@example.com");
    expect((await call("admin", "POST", `/access-requests/${yes}/approve`)).status).toBe(200);
    expect((await call("admin", "POST", `/access-requests/${no}/decline`)).status).toBe(200);
    expect(await newest("approve_access")).toMatchObject({ via: "api", target: { id: yes, kind: "person", label: "waiting-yes@example.com" }, details: { status: "approved" } });
    expect(await newest("decline_access")).toMatchObject({ via: "api", target: { id: no, kind: "person", label: "waiting-no@example.com" }, details: { status: "declined" } });
  });

  it("disabling and enabling a person", async () => {
    const uma = await idOf("uma");
    expect((await call("admin", "PATCH", `/users/${uma}`, { disabled: true })).status).toBe(200);
    expect((await call("admin", "PATCH", `/users/${uma}`, { disabled: false })).status).toBe(200);
    const page = await call("admin", "GET", `/audit?target=${uma}&action=update_user`);
    expect(page.body.entries.slice(0, 2).map((e: Entry) => e.details)).toEqual([{ account: "enabled" }, { account: "disabled" }]);
    expect(page.body.entries[0].target).toMatchObject({ id: uma, kind: "person", label: "uma@example.com" });
  });

  it("disabling and enabling a service account, and revoking its token", async () => {
    const sa = await call("admin", "POST", "/service-accounts", { name: "audit-bot", display_name: "Audit bot" });
    const tok = await call("admin", "POST", `/service-accounts/${sa.body.id}/tokens`, { name: "Deploys" });
    expect(tok.status).toBe(200);
    expect((await call("admin", "DELETE", `/service-accounts/${sa.body.id}/tokens/${tok.body.id}`)).status).toBe(200);
    expect((await call("admin", "PATCH", `/service-accounts/${sa.body.id}`, { disabled: true })).status).toBe(200);
    expect((await call("admin", "PATCH", `/service-accounts/${sa.body.id}`, { disabled: false })).status).toBe(200);
    const page = await call("admin", "GET", `/audit?target=${sa.body.id}`);
    const rows = page.body.entries.map((e: Entry) => [e.action, e.details]);
    expect(rows).toEqual([
      ["enable_service_account", { disabled: false, was_disabled: true }],
      ["disable_service_account", { disabled: true, was_disabled: false }],
      ["revoke_service_token", { token_id: tok.body.id, token_name: "Deploys" }],
      ["create_service_token", expect.objectContaining({ token_id: tok.body.id, token_name: "Deploys" })],
      ["create_service_account", { identifier: "service:audit-bot" }],
    ]);
    expect(page.body.entries.every((e: Entry) => (e.target as { kind: string }).kind === "service_account")).toBe(true);
  });

  it("purging an entry keeps neither its title nor its text anywhere in the log", async () => {
    const title = (await db.query("SELECT title FROM findings WHERE id = $1", [ids.rca])).rows[0].title as string;
    const res = await call("admin", "POST", `/purge/${ids.rca}`, { reason: "Contained a customer's card number", confirm_title: title });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const e = await newest("purge");
    expect(e).toMatchObject({ target: { id: ids.rca, kind: "finding", label: "Deleted finding" }, details: { kind: "finding", reason: "Contained a customer's card number" } });
    expect(await everyColumn()).not.toContain(title);
    expect(JSON.stringify((await call("admin", "GET", "/audit?reads=true&limit=200")).body)).not.toContain(title);
  });
});

describe("project requests", () => {
  it("records the request as the target of the decline, so filtering by the request shows both", async () => {
    const req = await call("rhea", "POST", "/project-requests", { slug: "audit-sandbox", name: "Audit sandbox", reason: "testing" });
    expect(req.body.status, JSON.stringify(req.body)).toBe("requested");
    expect((await call("admin", "POST", `/project-requests/${req.body.request_id}/decline`, { note: "Use an existing project" })).status).toBe(200);
    const page = await call("admin", "GET", `/audit?target=${req.body.request_id}`);
    expect(page.body.entries.map((e: Entry) => e.action)).toEqual(["decline_project_request", "request_project"]);
    expect(page.body.entries[0]).toMatchObject({ via: "api", target: { id: req.body.request_id, kind: "project_request", label: "Audit sandbox" }, details: { slug: "audit-sandbox" } });
    // The note goes to the requester, not into the log.
    expect(JSON.stringify(page.body)).not.toContain("Use an existing project");
  });

  it("gives a change recorded without a target the target of the call that wrapped it", async () => {
    const admin = await idOf("admin");
    const project = ids.project;
    await inAuditRequest("api", async () => {
      await audit(db, admin, "some_inner_change", null);
      await audit(db, admin, "api:some_inner_change", project, { wrapper: true });
    });
    const page = await call("admin", "GET", `/audit?target=${project}&action=some_inner_change`);
    expect(page.body.entries).toHaveLength(1);
    expect(page.body.entries[0]).toMatchObject({ action: "some_inner_change", via: "api", target: { id: project, kind: "project" } });
  });
});

describe("older rows keep what their tool name said", () => {
  it("shows the app of an OAuth connection and the settings of a settings change as details", async () => {
    const admin = await idOf("admin");
    await db.query("INSERT INTO audit_log (actor_id, tool) VALUES ($1, 'oauth_authorize:Claude Desktop'), ($1, 'system_settings:session_ttl_hours,digest_hour')", [admin]);
    expect(await newest("oauth_authorize")).toMatchObject({ details: { app: "Claude Desktop" } });
    expect(await newest("system_settings")).toMatchObject({ details: { settings: ["session_ttl_hours", "digest_hour"] } });
    expect(suffixDetails("create_role", "create_role")).toBeNull();
    expect(suffixDetails("something", "api:something:else")).toEqual({ detail: "else" });
  });
});

describe("secrets of new accounts and invitations stay out of the audit log", () => {
  let local: Server;
  let localBase: string;
  beforeAll(async () => {
    const tokens = "admin=admin@example.com";
    local = createApp({ db, authenticate: chain(apiTokenAuthenticator(db), devAuthenticator(tokens)), settings: { ...TEST_SETTINGS, authMode: "local" } }).listen(0);
    await new Promise((r) => local.once("listening", r));
    localBase = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => local.close(r));
  });
  const post = async (path: string, body?: unknown) => {
    const res = await fetch(`${localBase}/api${path}`, {
      method: "POST",
      headers: { authorization: "Bearer admin", "content-type": "application/json", origin: localBase },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("never records a temporary password (new account or reset) or an invitation link", async () => {
    const created = await post("/users", { email: "new-local@example.com", name: "New Local" });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const first = created.body.temporary_password as string;
    expect(first.length).toBeGreaterThan(8);
    const reset = await post(`/users/${created.body.user.id}/reset-password`);
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const second = reset.body.temporary_password as string;
    const invited = await post("/invitations", { email: "invitee@example.com", scope: "order-service", roles: ["Viewer"] });
    expect(invited.status, JSON.stringify(invited.body)).toBe(200);
    const inviteToken = (invited.body.link as string).split("/invite/")[1]!;
    expect(inviteToken.length).toBeGreaterThan(20);

    const everything = await everyColumn();
    for (const secret of [first, second, inviteToken, invited.body.link]) expect(everything).not.toContain(secret);

    expect(await newest("create_user")).toMatchObject({ target: { id: created.body.user.id, kind: "person", label: "New Local" } });
    expect(await newest("reset_password")).toMatchObject({ target: { id: created.body.user.id, kind: "person" }, details: { signed_out_everywhere: true } });
    expect(await newest("invite_user")).toMatchObject({
      target: { kind: "person", label: "invitee@example.com" },
      details: { invitation_id: invited.body.id, email: "invitee@example.com", project: "order-service", roles: ["Viewer"] },
    });
  });
});

describe("stored action and read flag", () => {
  it("computes the same action and read flag in the database as on the page", async () => {
    const keys = [...Object.keys(AUDIT_ACTIONS), ...READ_ACTIONS, "get_article", "list_projects", "search_knowledge", "browse_kb", "detect_x", "some_new_thing", "getaway"];
    const { rows } = await db.query<{ k: string; read: boolean }>("SELECT k, audit_action_is_read(k) AS read FROM unnest($1::text[]) AS k", [keys]);
    for (const r of rows) expect(r.read, r.k).toBe(isReadAction(r.k));
    await db.query("INSERT INTO audit_log (actor_id, tool) VALUES (NULL, 'api:get_article'), (NULL, 'api:get_asset'), (NULL, 'system_settings:x,y')");
    const stored = await db.query("SELECT tool, action, is_read FROM audit_log ORDER BY id DESC LIMIT 3");
    expect(stored.rows).toEqual([
      { tool: "system_settings:x,y", action: "system_settings", is_read: false },
      { tool: "api:get_asset", action: "get_asset", is_read: false },
      { tool: "api:get_article", action: "get_article", is_read: true },
    ]);
  });

  it("filters by action and leaves out reads with the stored columns' indexes", async () => {
    const plan = async (sql: string, params: unknown[]) => {
      const c = await db.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL enable_seqscan = off");
        return JSON.stringify((await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    };
    expect(await plan("SELECT id FROM audit_log a WHERE a.action = ANY ($1::text[]) ORDER BY id DESC LIMIT 50", [["approve", "approve_revision"]])).toContain("audit_log_action");
    expect(await plan("SELECT id FROM audit_log a WHERE NOT a.is_read ORDER BY id DESC LIMIT 50", [])).toContain("audit_log_changes");
  });
});

describe("usage numbers", () => {
  it("count MCP calls as agent calls, and not the changes web calls record or Thaliyola's own jobs", async () => {
    const admin = await idOf("admin");
    await db.query("DELETE FROM audit_log");
    // Since 035: an MCP call (its wrapper row and the change it recorded), a web call (likewise), a personal-token
    // rotation (account page, no request), a job's notice (no actor).
    await inAuditRequest("mcp", async () => {
      await audit(db, admin, "set_member_roles", ids.project);
      await audit(db, admin, "set_project_access", ids.project, { wrapper: true });
    });
    await inAuditRequest("api", async () => {
      await audit(db, admin, "approve_access", admin);
      await audit(db, admin, "api:approve_access", admin, { wrapper: true });
    });
    await audit(db, admin, "rotate_api_token", null);
    await audit(db, null, "notify_token_expiry", null);
    // Before 035 (no request id): an MCP call and a web call.
    await db.query("INSERT INTO audit_log (actor_id, tool) VALUES ($1, 'search_knowledge'), ($1, 'api:get_article'), ($1, 'login')", [admin]);
    const { rows } = await db.query(`SELECT l.tool FROM audit_log l WHERE ${agentCallSql("l")} ORDER BY l.id`);
    expect(rows.map((r) => r.tool)).toEqual(["set_project_access", "search_knowledge"]);
    const page = await call("admin", "GET", "/insights");
    const today = page.body.activity.at(-1);
    expect(today).toMatchObject({ agents: 2 });
  });
});

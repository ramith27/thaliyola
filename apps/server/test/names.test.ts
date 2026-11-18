import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator, nameFromClaims } from "../src/auth/index.js";
import { acceptInvitation, createInvitation } from "../src/auth/invitations.js";
import { changeMemberRoles, listManagedProjects, listMembers } from "../src/core/admin.js";
import { flushDeliveries } from "../src/core/notify.js";
import { onboarding } from "../src/core/onboarding.js";
import { listReviewQueue } from "../src/core/review.js";
import { setUserRoles } from "../src/core/roles.js";
import { getSystemSettings } from "../src/core/system.js";
import { createArticle, proposeFinding } from "../src/core/writes.js";
import { setAssignee } from "../src/core/workflow.js";
import { addPerson, approveUser, cleanName, listAccessRequests, setMyName, updatePerson, upsertUser } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const TOKENS = "admin=admin@example.com,rita=rita@example.com,uma=uma@example.com,wes=wes@example.com,svc=svc-bot@example.com";
const clients: Record<string, Client> = {};

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator(TOKENS), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of ["admin", "rita", "uma", "wes"]) await as(p);
  await ctxFor(db, { email: "svc-bot@example.com", service: true });
  await setUserRoles(await as("admin"), await idOf("uma"), ["user_manager"]);
  await setUserRoles(await as("admin"), await idOf("wes"), ["security_lead"]);
});
afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

const as = (p: string, extra = {}) => ctxFor(db, { email: p.includes("@") ? p : `${p}@example.com`, ...extra });
const idOf = async (p: string) => (await db.query("SELECT id FROM users WHERE email = $1", [p.includes("@") ? p : `${p}@example.com`])).rows[0].id as string;
const nameIn = async (p: string) => (await db.query("SELECT display_name FROM users WHERE email = $1", [p.includes("@") ? p : `${p}@example.com`])).rows[0].display_name as string | null;

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  if (!clients[token]) {
    clients[token] = new Client({ name: "test", version: "0" });
    await clients[token].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  }
  const result = await clients[token].callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}

describe("display names: what a name may be", () => {
  it("collapses spaces, treats empty as no name, and refuses @, hidden characters and very long names", () => {
    expect(cleanName("  Rita   Shah ")).toBe("Rita Shah");
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(null)).toBeNull();
    // Joiners some scripts need are fine.
    expect(cleanName("ര‍മിത്")).toBe("ര‍മിത്");
    expect(() => cleanName("rita@example.com")).toThrow(/can't contain @/);
    expect(() => cleanName("Rita‮hahS")).toThrow(/control or invisible/);
    expect(() => cleanName("Rita\u0000")).toThrow(/control or invisible/);
    expect(() => cleanName("x".repeat(101))).toThrow(/at most 100/);
  });
});

describe("your own name", () => {
  it("is set, shown on /me and connect-info, and cleared with PATCH /api/account", async () => {
    const set = await call("rita", "PATCH", "/api/account", { display_name: "  Rita   Shah " });
    expect(set).toMatchObject({ status: 200, body: { email: "rita@example.com", name: "Rita Shah" } });
    expect((await call("rita", "GET", "/api/me")).body).toMatchObject({ email: "rita@example.com", name: "Rita Shah" });
    expect((await call("rita", "GET", "/api/connect-info")).body.account).toMatchObject({ email: "rita@example.com", name: "Rita Shah" });
    expect((await db.query("SELECT 1 FROM audit_log WHERE tool = 'api:update_account' AND actor_id = $1", [await idOf("rita")])).rowCount).toBe(1);

    expect((await call("rita", "PATCH", "/api/account", { display_name: "" })).body.name).toBeNull();
    expect((await call("rita", "GET", "/api/me")).body.name).toBeNull();
    await call("rita", "PATCH", "/api/account", { display_name: "Rita Shah" });
  });

  it("refuses bad names, a name someone else has, and service accounts", async () => {
    expect(await call("wes", "PATCH", "/api/account", { display_name: "wes@example.com" })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/@/) } });
    expect(await call("wes", "PATCH", "/api/account", { display_name: "rita shah" })).toMatchObject({
      status: 400,
      body: { error: expect.stringMatching(/someone else is already called/) },
    });
    expect((await call("wes", "PATCH", "/api/account", {})).status).toBe(400);
    expect(await nameIn("wes")).toBeNull();
    // A name only someone themselves had is theirs to keep.
    expect((await setMyName(await as("rita"), "Rita Shah")).name).toBe("Rita Shah");
    await expect(setMyName(await as("svc-bot@example.com", { service: true }), "Admin")).rejects.toThrow(/only people/);
    expect((await call("svc", "PATCH", "/api/account", { display_name: "Admin" })).status).toBe(403);
  });

  it("can be set from Claude with set_my_name, and only your own", async () => {
    expect(await tool("wes", "set_my_name", { name: "Wes Ng" })).toMatchObject({ id: await idOf("wes"), email: "wes@example.com", name: "Wes Ng" });
    expect(await nameIn("wes")).toBe("Wes Ng");
    expect((await tool("wes", "set_my_name", { name: "Rita Shah" })).error).toMatch(/already called/);
    expect((await tool("svc", "set_my_name", { name: "Wes" })).error).toMatch(/only people/);
    // One change recorded with what it was and became (the MCP call around it is the wrapper row the Audit log hides).
    const changes = (await db.query("SELECT details, target_kind FROM audit_log WHERE tool = 'set_my_name' AND actor_id = $1 AND via IS NULL", [await idOf("wes")])).rows;
    expect(changes).toEqual([{ target_kind: "person", details: { name_before: null, name_after: "Wes Ng" } }]);
  });
});

describe("someone else's name (Manage people)", () => {
  it("is set and cleared on Admin › People by people with Manage people", async () => {
    const id = await idOf("uma");
    const res = await call("admin", "PATCH", `/api/users/${id}`, { name: "Uma Iyer" });
    expect(res).toMatchObject({ status: 200, body: { user: { display_name: "Uma Iyer" } } });
    expect((await call("admin", "GET", "/api/users")).body.users.find((u: { id: string }) => u.id === id)).toMatchObject({ display_name: "Uma Iyer" });
    // A User manager renames a member; null clears it.
    const member = await ctxFor(db, { email: "member@example.com" });
    expect((await call("uma", "PATCH", `/api/users/${member.actor.id}`, { name: "Max Member" })).body.user.display_name).toBe("Max Member");
    expect((await call("uma", "PATCH", `/api/users/${member.actor.id}`, { name: null })).body.user.display_name).toBeNull();
    // Leaving name out keeps it.
    await call("uma", "PATCH", `/api/users/${member.actor.id}`, { name: "Max Member" });
    await call("uma", "PATCH", `/api/users/${member.actor.id}`, { disabled: false });
    expect(await nameIn("member@example.com")).toBe("Max Member");
  });

  it("is refused without Manage people, for Administrators unless you are one, and above your own rights", async () => {
    expect((await call("rita", "PATCH", `/api/users/${await idOf("uma")}`, { name: "Not Uma" })).status).toBe(403);
    expect(await call("uma", "PATCH", `/api/users/${await idOf("admin")}`, { name: "Boss" })).toMatchObject({
      status: 403,
      body: { error: expect.stringMatching(/only Administrators change an Administrator's account/) },
    });
    // Wes is a Security lead: a User manager doesn't hold that, so can't rename him.
    expect(await call("uma", "PATCH", `/api/users/${await idOf("wes")}`, { name: "Someone Else" })).toMatchObject({
      status: 403,
      body: { error: expect.stringMatching(/can't rename wes@example.com/) },
    });
    expect(await nameIn("wes")).toBe("Wes Ng");
    // Names other people hold are refused here too.
    await expect(updatePerson(await as("admin"), await idOf("member@example.com"), { name: "Wes Ng" })).rejects.toThrow(/already called/);
    expect(await nameIn("admin")).toBeNull();
  });

  it("names people added ahead of their first sign-in", async () => {
    await expect(addPerson(await as("admin"), { email: "new.person@example.com", name: "new@person" })).rejects.toThrow(/@/);
    await addPerson(await as("admin"), { email: "new.person@example.com", name: " Nia  Person " });
    expect(await nameIn("new.person@example.com")).toBe("Nia Person");
  });
});

describe("names on invitations (built-in sign-in)", () => {
  it("keeps the invitee's own name when it's free, refuses one someone has, and falls back to the invitation's", async () => {
    const tokenOf = (link: string) => link.slice(link.indexOf("#/invite/") + "#/invite/".length);
    const admin = await as("admin");
    const local = { ...TEST_SETTINGS, authMode: "local" as const };
    await expect(createInvitation(db, local, admin.actor.id, { email: "x@example.com", name: "x@y" })).rejects.toThrow(/@/);
    const a = await createInvitation(db, local, admin.actor.id, { email: "inv.a@example.com", name: "Invited A" });
    await expect(acceptInvitation(db, tokenOf(a.link), { password: "a-long-enough-passphrase-9", name: "Rita Shah" })).rejects.toThrow(/already called/);
    await acceptInvitation(db, tokenOf(a.link), { password: "a-long-enough-passphrase-9", name: "  " });
    expect(await nameIn("inv.a@example.com")).toBe("Invited A");
    const b = await createInvitation(db, local, admin.actor.id, { email: "inv.b@example.com" });
    await acceptInvitation(db, tokenOf(b.link), { password: "a-long-enough-passphrase-9", name: "Bea  Invitee" });
    expect(await nameIn("inv.b@example.com")).toBe("Bea Invitee");
  });
});

describe("names from Cloudflare Access", () => {
  it("reads name, given_name plus family_name, or common_name, top-level or under custom", () => {
    expect(nameFromClaims({ email: "a@b.c", name: "Ada Lovelace", given_name: "X" })).toBe("Ada Lovelace");
    expect(nameFromClaims({ email: "a@b.c", given_name: "Ada", family_name: "Lovelace" })).toBe("Ada Lovelace");
    expect(nameFromClaims({ email: "a@b.c", given_name: "Ada" })).toBe("Ada");
    expect(nameFromClaims({ email: "a@b.c", common_name: "Ada L" })).toBe("Ada L");
    expect(nameFromClaims({ email: "a@b.c", custom: { name: "Ada Custom" } })).toBe("Ada Custom");
    // Unusable names are dropped, never refused.
    expect(nameFromClaims({ email: "a@b.c", name: "a@b.c" })).toBeNull();
    expect(nameFromClaims({ email: "a@b.c", name: 42 })).toBeNull();
    expect(nameFromClaims({ email: "a@b.c" })).toBeNull();
  });

  it("names a new account on first sign-in and an unnamed one later, but never replaces a name someone set", async () => {
    const id = { subject: "cf:ada@example.com", email: "ada@example.com", kind: "human" as const };
    expect((await upsertUser(db, { ...id, name: "Ada Lovelace" })).name).toBe("Ada Lovelace");
    // Someone (or Ada) changes it: the sign-in's name doesn't come back.
    await db.query("UPDATE users SET display_name = 'Countess Ada' WHERE subject = $1", [id.subject]);
    expect((await upsertUser(db, { ...id, name: "Ada Lovelace" })).name).toBe("Countess Ada");
    // Cleared: the next sign-in fills it in again.
    await db.query("UPDATE users SET display_name = NULL WHERE subject = $1", [id.subject]);
    expect((await upsertUser(db, { ...id, name: "Ada Lovelace" })).name).toBe("Ada Lovelace");
    // A sign-in without a name leaves it alone.
    expect((await upsertUser(db, id)).name).toBe("Ada Lovelace");
  });

  it("names a placeholder that the first sign-in claims, unless it was named when added", async () => {
    const admin = await as("admin");
    await addPerson(admin, { email: "bo@example.com" });
    await addPerson(admin, { email: "cy@example.com", name: "Cy Chosen" });
    expect((await upsertUser(db, { subject: "cf:bo@example.com", email: "bo@example.com", kind: "human", name: "Bo Claim" })).name).toBe("Bo Claim");
    expect((await upsertUser(db, { subject: "cf:cy@example.com", email: "cy@example.com", kind: "human", name: "Cy Claim" })).name).toBe("Cy Chosen");
    // Service identities never take a name this way.
    expect((await upsertUser(db, { subject: "cf-svc:abc", email: null, kind: "service", name: "Root" })).name).toBeNull();
  });
});

describe("names wherever people are listed", () => {
  it("in the review queue (authors, reviewers, assignees) and in notifications", async () => {
    const admin = await as("admin");
    await changeMemberRoles(admin, "order-service", "rita@example.com", { set: ["owner"] });
    const author = await as("author@example.com", { project: "order-service" });
    await changeMemberRoles(admin, "order-service", "author@example.com", { set: ["writer"] });
    await setMyName(author, "Arun Author");
    const res = await proposeFinding(await as("author@example.com", { project: "order-service" }), {
      type: "rca",
      title: "Names in the queue",
      symptoms: "Emails everywhere",
      root_cause: "No names",
      force_new: true,
    });
    await setAssignee(await as("admin"), (res as { revision_id: string }).revision_id, await idOf("rita"));
    await flushDeliveries();
    const row = (await listReviewQueue(admin, { scope: "order-service" })).find((r) => r.id === (res as { revision_id: string }).revision_id);
    expect(row).toMatchObject({
      summary: "New root cause analysis: Names in the queue",
      author: "author@example.com",
      author_name: "Arun Author",
      assignee: "Rita Shah",
      assignee_email: "rita@example.com",
      assignee_name: "Rita Shah",
    });
    const ritaNotes = async () =>
      (await db.query("SELECT n.title, n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'rita@example.com' ORDER BY n.created_at, n.title")).rows;
    expect(await ritaNotes()).toEqual(
      expect.arrayContaining([
        { title: "Review: New root cause analysis: Names in the queue", body: "Arun Author (author@example.com) proposed a change in Order service v2." },
        { title: "Assigned to you: New root cause analysis: Names in the queue", body: "admin@example.com asked you to review this." },
      ]),
    );
    await setMyName(admin, "Ada Admin");
    await setAssignee(await as("admin"), (res as { revision_id: string }).revision_id, null);
    await setAssignee(await as("admin"), (res as { revision_id: string }).revision_id, await idOf("rita"));
    await flushDeliveries();
    expect((await ritaNotes()).map((n) => n.body)).toContain("Ada Admin asked you to review this.");
    await setMyName(await as("admin"), null);
  });

  it("in member lists, project owners, access requests and change results", async () => {
    const admin = await as("admin");
    const members = await listMembers(admin, "order-service");
    expect(members.members.find((m) => m.email === "rita@example.com")).toMatchObject({ name: "Rita Shah" });
    const project = (await listManagedProjects(admin)).projects.find((p: { slug: string }) => p.slug === "order-service");
    expect(project.owner_list).toEqual(expect.arrayContaining([{ email: "rita@example.com", name: "Rita Shah" }]));
    expect((await changeMemberRoles(admin, "order-service", "rita@example.com", { add: ["writer"] })).name).toBe("Rita Shah");
    await upsertUser(db, { subject: "cf:waiting@example.com", email: "waiting@example.com", kind: "human", name: "Wait Ing" }, { approval: true });
    expect((await listAccessRequests(admin)).find((r) => r.email === "waiting@example.com")).toMatchObject({ name: "Wait Ing" });
    // The person approved hears it from a name, not an email.
    await setMyName(admin, "Ada Admin");
    await approveUser(await as("admin"), await idOf("waiting@example.com"));
    await flushDeliveries();
    const body = (await db.query("SELECT n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'waiting@example.com'")).rows[0].body;
    expect(body).toBe("Ada Admin approved your access.");
    await setMyName(await as("admin"), null);
  });

  it("in team member, access and person-access lists", async () => {
    const access = await call("admin", "GET", "/api/scopes/order-service/access");
    expect(access.body.people.find((p: { email: string }) => p.email === "rita@example.com")).toMatchObject({ name: "Rita Shah" });
    const person = await call("admin", "GET", `/api/users/${await idOf("rita")}/access`);
    expect(person.body.person).toMatchObject({ email: "rita@example.com", name: "Rita Shah" });
    const holders = await call("admin", "GET", "/api/roles/security_lead/holders");
    expect(holders.body.people).toEqual([expect.objectContaining({ email: "wes@example.com", name: "Wes Ng" })]);
  });
});

describe("proposal summaries", () => {
  it("name the type the way people do", async () => {
    const ctx = await as("author@example.com", { project: "order-service" });
    const article = await createArticle(ctx, { type: "api_contract", title: "Orders API", body_md: "## Interface\n\nGET /orders" });
    const finding = await proposeFinding(ctx, { type: "known_issue", title: "Coupon spaces", symptoms: "x", root_cause: "y", force_new: true });
    const queue = await listReviewQueue(await as("admin"), { scope: "order-service" });
    expect(queue.find((r) => r.id === (article as { revision_id: string }).revision_id)?.summary).toBe("New API contract: Orders API");
    expect(queue.find((r) => r.id === (finding as { revision_id: string }).revision_id)?.summary).toBe("New known issue: Coupon spaces");
  });
});

describe("plain words in help text", () => {
  it("keeps environment variables out of the onboarding steps and system help, in a technical detail instead", async () => {
    const steps = (await onboarding(await as("admin"))).steps;
    const email = steps.find((s) => s.key === "email")!;
    expect(email.detail).not.toMatch(/[A-Z]+_[A-Z]+/);
    expect(email.technical).toMatch(/MAIL_TRANSPORT=smtp and SMTP_URL/);
    expect(steps.find((s) => s.key === "connect")!.technical).toBeNull();
    const settings = (await getSystemSettings(await as("admin"))).settings;
    for (const s of settings) expect(s.help).not.toMatch(/\b[A-Z]+_[A-Z_]+\b/);
    expect(settings.find((s) => s.key === "require_approval")).toMatchObject({ technical: expect.stringMatching(/ADMIN_EMAILS/), env: "REQUIRE_APPROVAL" });
  });
});

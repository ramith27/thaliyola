import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { approveRevision } from "../src/core/review.js";
import { createRole } from "../src/core/roles.js";
import { updateSystemSettings } from "../src/core/system.js";
import { listAccessRequests, upsertUser } from "../src/core/users.js";
import { proposeMove } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const PEOPLE = ["admin", "olga", "will", "pia", "cara", "dev1", "dev2"];
const clients: Record<string, Client> = {};
const as = (p: string) => ctxFor(db, { email: `${p}@example.com` });

async function tool(who: string, name: string, args: Record<string, unknown> = {}) {
  if (!clients[who]) {
    clients[who] = new Client({ name: "test", version: "0" });
    await clients[who].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${who}` } } }));
  }
  const result = await clients[who].callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}
const note = (title: string, extra: Record<string, unknown> = {}) => ({ project: "kiln", type: "decision", title, body_md: "## Context\n\nWhy we chose it.", ...extra });

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator(PEOPLE.map((p) => `${p}=${p}@example.com`).join(",")), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of PEOPLE) await as(p);
  const admin = await as("admin");
  await adminCreateProject(admin, { slug: "kiln", name: "Kiln", visibility: "members" });
  await adminSetMember(admin, "kiln", "olga@example.com", "owner");
  await adminSetMember(admin, "kiln", "will@example.com", "writer");
});
afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

describe("publishing without review", () => {
  it("publishes a project admin's writes from Claude at once, and still sends a contributor's for review", async () => {
    const own = await tool("olga", "create_article", note("Use one queue per tenant"));
    expect(own).toMatchObject({ status: "published", published: true, state: "approved" });
    expect((await tool("will", "get_article", { id: own.article_id })).status).toBe("published");

    const theirs = await tool("will", "create_article", note("Retry failed jobs twice"));
    expect(theirs.status).toBe("pending_review");

    // Edits and findings too; asking for review keeps it a draft.
    const article = await tool("olga", "get_article", { id: own.article_id });
    expect(await tool("olga", "propose_article_edit", { id: own.article_id, version: article.version, summary: "Add the limit", section: "Context", text: "At most 50 tenants per queue." })).toMatchObject({ published: true });
    const finding = await tool("olga", "propose_finding", { project: "kiln", type: "rca", title: "Kiln jobs stall at midnight", symptoms: "jobs stop at 00:00 UTC", root_cause: "the lease expires during log rotation" });
    expect(finding).toMatchObject({ status: "published" });
    expect(await tool("olga", "create_article", note("Shard queues by region", { request_review: true }))).toMatchObject({ status: "pending_review" });
  });

  it("follows the permission, not the role name, and never skips review for moves", async () => {
    const admin = await as("admin");
    // A custom role that publishes without being able to review anyone else's work.
    await createRole(admin, { key: "trusted_writer", kind: "project", name: "Trusted writer", permissions: ["read", "comment", "propose", "publish"] });
    await adminSetMember(admin, "kiln", "pia@example.com", "trusted_writer");
    const pia = await tool("pia", "create_article", note("Logs go to the shared bucket"));
    expect(pia).toMatchObject({ published: true });
    const queued = await tool("will", "create_article", note("Alert on queue depth"));
    await expect(approveRevision(await as("pia"), queued.revision_id)).rejects.toThrow(/include Review/);

    const move = await proposeMove(await as("olga"), { id: pia.article_id, to: "kiln", folder: "Ops" });
    expect(move.status).toBe("pending_review");
  });

  it("can be switched off for everyone in system settings", async () => {
    const admin = await as("admin");
    await updateSystemSettings(admin, { direct_publish: false });
    try {
      expect((await tool("olga", "create_article", note("Pin the worker image"))).status).toBe("pending_review");
    } finally {
      await updateSystemSettings(admin, { direct_publish: null });
    }
    expect(TEST_SETTINGS.directPublish).toBe(true);
  });
});

describe("approval to join", () => {
  it("lets everyone waiting in when approval is switched off", async () => {
    const admin = await as("admin");
    await updateSystemSettings(admin, { require_approval: true });
    try {
      const waiting = await upsertUser(db, { subject: "dev:newbie@example.com", email: "newbie@example.com", kind: "human" }, { approval: true });
      expect(waiting.approved).toBe(false);
      expect((await listAccessRequests(admin)).map((p: { email: string }) => p.email)).toContain("newbie@example.com");

      const saved = await updateSystemSettings(admin, { require_approval: false });
      expect(saved.let_in).toBe(1);
      expect((await upsertUser(db, { subject: "dev:newbie@example.com", email: "newbie@example.com", kind: "human" }, { approval: false })).approved).toBe(true);
      // Someone new now gets in on first sign-in.
      expect((await upsertUser(db, { subject: "dev:later@example.com", email: "later@example.com", kind: "human" }, { approval: TEST_SETTINGS.requireApproval })).approved).toBe(true);
    } finally {
      await updateSystemSettings(admin, { require_approval: null });
    }
  });
});

describe("managing a project's members over MCP", () => {
  it("lets whoever created a project find people and give them roles without the web page", async () => {
    await tool("admin", "set_user_roles", { email: "cara@example.com", roles: ["project_creator"] });
    expect(await tool("cara", "create_project", { slug: "atlas", name: "Atlas", visibility: "members" })).toMatchObject({ status: "created" });

    const found = await tool("cara", "find_people", { query: "dev" });
    expect(found.people.map((p: { email: string }) => p.email)).toEqual(expect.arrayContaining(["dev1@example.com", "dev2@example.com"]));

    const added = await tool("cara", "set_project_access", { project: "atlas", emails: ["dev1@example.com", "dev2@example.com", "not-an-email"], roles: ["writer"] });
    expect(added).toMatchObject({ changed: 2 });
    expect(added.results.find((r: { email: string }) => r.email === "not-an-email").ok).toBe(false);
    expect(await tool("cara", "set_project_access", { project: "atlas", email: "will@example.com", roles: ["reviewer", "qa"] })).toMatchObject({ roles: ["reviewer", "qa"] });

    const access = await tool("cara", "get_project_access", { project: "atlas" });
    expect(access.my_roles).toEqual(["owner"]);
    expect(access.people.map((p: { email: string }) => p.email)).toEqual(expect.arrayContaining(["dev1@example.com", "dev2@example.com", "will@example.com"]));
    expect((await tool("dev1", "list_projects")).projects?.map?.((p: { slug: string }) => p.slug) ?? JSON.stringify(await tool("dev1", "list_projects"))).toContain("atlas");

    // Someone without a say in the project can't.
    expect((await tool("dev1", "set_project_access", { project: "atlas", email: "pia@example.com", roles: ["reader"] })).error).toBeTruthy();
  });
});

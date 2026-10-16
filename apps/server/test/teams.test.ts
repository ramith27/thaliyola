import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { adminAddComponent, adminCreateProject, adminSetMember, adminUpdateScope, removeComponent, updateComponent } from "../src/core/admin.js";
import { getArticle } from "../src/core/items.js";
import { moveItems } from "../src/core/move.js";
import { readableScopes } from "../src/core/permissions.js";
import { resolveRepo } from "../src/core/scopes.js";
import { createTeam, listAccess, setTeamMember, setTeamRole } from "../src/core/teams.js";
import { createArticle, proposeFinding } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator("dev=dev@example.com"), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

const admin = () => ctxFor(db, { email: "admin@example.com" });
const person = (email: string) => ctxFor(db, { email });

describe("teams", () => {
  it("gives every member of a team its role on each project it's added to", async () => {
    const a = await admin();
    await adminCreateProject(a, { slug: "billing", name: "Billing" });
    await adminCreateProject(a, { slug: "payouts", name: "Payouts" });
    await adminUpdateScope(a, "billing", { visibility: "members" });
    await adminUpdateScope(a, "payouts", { visibility: "members" });
    await createTeam(a, { slug: "payments", name: "Payments team" });
    await setTeamMember(a, "payments", "pat@example.com", true);
    await setTeamRole(a, "billing", "payments", "writer");
    await setTeamRole(a, "payouts", "payments", "reader");

    const pat = await person("pat@example.com");
    const ids = await readableScopes(pat);
    const slugs = (await db.query("SELECT slug FROM scopes WHERE id = ANY($1)", [ids])).rows.map((r) => r.slug);
    expect(slugs).toEqual(expect.arrayContaining(["billing", "payouts"]));
    // Writer through the team on billing, reader on payouts.
    await expect(createArticle(pat, { scope: "billing", type: "design_doc", title: "Invoice numbering", body_md: "## Context\n\nSequential." })).resolves.toBeTruthy();
    await expect(createArticle(await person("pat@example.com"), { scope: "payouts", type: "design_doc", title: "Nope", body_md: "x" })).rejects.toThrow(/not a writer/);
    // An outsider sees neither.
    const outsider = await readableScopes(await person("outsider@example.com"));
    expect((await db.query("SELECT slug FROM scopes WHERE id = ANY($1)", [outsider])).rows.map((r) => r.slug)).not.toContain("billing");

    const access = await listAccess(a, "billing");
    expect(access.teams).toEqual([expect.objectContaining({ slug: "payments", role: "writer", members: ["pat@example.com"] })]);

    // Leaving the team removes the access.
    await setTeamMember(a, "payments", "pat@example.com", false);
    const after = await readableScopes(await person("pat@example.com"));
    expect((await db.query("SELECT slug FROM scopes WHERE id = ANY($1)", [after])).rows.map((r) => r.slug)).not.toContain("billing");
  });

  it("only admins manage teams", async () => {
    await expect(createTeam(await person("pat@example.com"), { slug: "x", name: "X" })).rejects.toThrow(/admin only/);
  });
});

describe("project owners manage their project", () => {
  it("lets owners (not just admins) set members, teams, settings and repositories", async () => {
    const a = await admin();
    await adminCreateProject(a, { slug: "search", name: "Search" });
    await adminSetMember(a, "search", "olive@example.com", "owner");
    const olive = await person("olive@example.com");
    await adminSetMember(olive, "search", "will@example.com", "writer");
    await setTeamRole(olive, "search", "payments", "reader");
    await adminUpdateScope(olive, "search", { description: "Product search" });
    await adminAddComponent(olive, "search", { slug: "indexer", kind: "backend", repo_url: "https://github.com/acme/search-indexer" });
    await adminAddComponent(olive, "search", { slug: "query-api", kind: "backend", repo_url: "git@github.com:acme/search-api.git" });
    const access = await listAccess(olive, "search");
    expect(access.can_manage).toBe(true);
    expect(access.people.map((p: { email: string; role: string }) => [p.email, p.role])).toEqual([
      ["olive@example.com", "owner"],
      ["will@example.com", "writer"],
    ]);
    // A writer can't manage, and can't touch other projects either.
    await expect(adminSetMember(await person("will@example.com"), "search", "x@example.com", "owner")).rejects.toThrow(/owners and admins/);
    await expect(adminUpdateScope(olive, "team", { name: "Org" })).rejects.toThrow(/only admins/);
    // An owner can't leave the project ownerless.
    await expect(adminSetMember(olive, "search", "olive@example.com", "writer")).rejects.toThrow(/at least one owner/);
    expect((await listAccess(a, "search")).people[0]).toMatchObject({ email: "olive@example.com", role: "owner" });
  });

  it("keeps one project per repository, finds projects from any form of the remote URL, and edits or removes repos", async () => {
    const a = await admin();
    await expect(adminAddComponent(a, "billing", { slug: "dup", kind: "backend", repo_url: "https://github.com/ACME/search-api" })).rejects.toThrow(/already search\/query-api/);
    expect(await resolveRepo(db, "https://github.com/acme/search-api.git")).toEqual({ project: "search", component: "query-api" });
    expect(await resolveRepo(db, "ssh://git@github.com/acme/search-indexer/")).toEqual({ project: "search", component: "indexer" });
    expect(await resolveRepo(db, "https://github.com/acme/unknown")).toBeNull();
    await updateComponent(a, "search", "indexer", { repo_url: "https://github.com/acme/indexer-v2", description: "Kafka consumer" });
    expect(await resolveRepo(db, "github.com/acme/indexer-v2")).toEqual({ project: "search", component: "indexer" });
    await removeComponent(a, "search", "indexer");
    expect(await resolveRepo(db, "github.com/acme/indexer-v2")).toBeNull();
  });

  it("picks the project from the X-Cairn-Repo header over MCP", async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer dev", "x-cairn-repo": "git@github.com:acme/search-api.git" } } }));
    const res = await client.callTool({ name: "get_project_context", arguments: {} });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(body.project.slug).toBe("search");
    const byArg = await client.callTool({ name: "get_project_context", arguments: { repo: "https://github.com/acme/nothing" } });
    expect(byArg.isError).toBe(true);
    await client.close();
  });
});

describe("moving items into a project", () => {
  it("moves a team folder into a project, dropping the prefix and turning chosen sub-folders into repositories", async () => {
    const a = await admin();
    const mk = (title: string, path: string) => createArticle(a, { scope: "team", type: "system", title, path, body_md: `## Purpose\n\n${title}.` });
    const one = await mk("Billing overview", "Projects/Billing");
    const two = await mk("Invoice service", "Projects/Billing/invoice-api");
    const three = await mk("Invoice domains", "Projects/Billing/invoice-api/Domains");
    await mk("Billing data", "Projects/Billing/Data");
    await mk("Unrelated", "Systems");
    const f = await proposeFinding(a, { scope: "team", type: "known_issue", title: "Invoices off by one", symptoms: "Numbers skip", root_cause: "Sequence cache", force_new: true });
    if (f.status !== "pending_review") throw new Error("expected proposal");

    const dry = await moveItems(a, { from: "team", to: "billing", folder: "Projects/Billing", dry_run: true });
    expect(dry.articles.map((x) => x.to_path).sort()).toEqual(["", "Data", "invoice-api", "invoice-api/Domains"]);
    expect(dry.subfolders).toEqual(["Data", "invoice-api"]);

    const done = await moveItems(a, { from: "team", to: "billing", folder: "Projects/Billing", repo_folders: ["invoice-api"], ids: [f.finding_id] });
    expect(done.moved).toBe(5);
    expect(done.new_components).toEqual(["invoice-api"]);
    const moved = await getArticle(a, three.article_id);
    expect(moved.scope.slug).toBe("billing");
    expect(moved.path).toBe("Domains");
    expect(moved.components).toEqual(["invoice-api"]);
    expect((await getArticle(a, one.article_id)).path).toBe("");
    expect((await getArticle(a, two.article_id)).path).toBe("");
    // Search chunks and the open proposal moved too.
    expect((await db.query("SELECT DISTINCT s.slug FROM chunks c JOIN scopes s ON s.id = c.scope_id WHERE c.parent_id = $1", [three.article_id])).rows).toEqual([{ slug: "billing" }]);
    expect((await db.query("SELECT s.slug FROM revisions r JOIN scopes s ON s.id = r.scope_id WHERE r.id = $1", [f.revision_id])).rows[0].slug).toBe("billing");
    // Only people who can approve in both scopes may move.
    await expect(moveItems(await person("will@example.com"), { from: "billing", to: "team", folder: "Domains" })).rejects.toThrow(/owners and admins/);
  });
});

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextArticleTags } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { startApp, type TestApp } from "./skills-helpers.js";

/**
 * Changing an article's tags after it was created (1.1.0): propose_article_edit and the article edit API take tags
 * (replace all) or add_tags / remove_tags, with or without new text, through the same review as text edits. Approving
 * applies them, the version snapshot keeps them, and search and get_article show them.
 */

let db: Db;
let app: TestApp;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];

async function call(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }> {
  const c = new Client({ name: "claude-ai", version: "1.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  try {
    const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text?: string }[] };
    const text = r.content.map((x) => x.text ?? "").join("\n");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* an error */
    }
    return { isError: !!r.isError, text, json };
  } finally {
    await c.close();
  }
}
const article = async (id: string) => (await db.query<{ tags: string[]; version: number; body_md: string }>("SELECT tags, version, body_md FROM articles WHERE id = $1", [id])).rows[0]!;
const setTags = (id: string, tags: string[]) => db.query("UPDATE articles SET tags = $2 WHERE id = $1", [id, tags]);

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  app = await startApp(db, TEST_SETTINGS, { rita: "rita@example.com" });
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("normalising tag changes", () => {
  it("replaces, adds and removes, folding case, spaces and duplicates", () => {
    expect(nextArticleTags(["a", "b"], { tags: ["Partners Named", "partners named", " Webflow_Audit ", "#ops"] })).toEqual({ tags: ["partners-named", "webflow-audit", "ops"], added: ["partners-named", "webflow-audit", "ops"], removed: ["a", "b"] });
    expect(nextArticleTags(["partners-not-named", "webflow"], { add_tags: ["Partners  Named", "webflow"], remove_tags: ["Partners Not Named"] })).toEqual({ tags: ["webflow", "partners-named"], added: ["partners-named"], removed: ["partners-not-named"] });
    expect(nextArticleTags(["a"], {})).toBeNull();
    expect(() => nextArticleTags(["a"], { tags: ["b"], add_tags: ["c"] })).toThrow(/not both/);
  });
});

describe("propose_article_edit with tags", () => {
  it("proposes a tag-only change for review, shows what it adds and removes, and applies it on approval", async () => {
    await setTags(ids.runbook, ["partners-not-named", "checkout"]);
    const before = await article(ids.runbook);
    const r = await call("alice", "propose_article_edit", { id: ids.runbook, version: before.version, summary: "Fix a stale tag", add_tags: ["Partners Named"], remove_tags: ["partners-not-named"] });
    expect(r.json, r.text).toMatchObject({ status: "pending_review" });
    // Nothing changes until it's approved.
    expect((await article(ids.runbook)).tags).toEqual(["partners-not-named", "checkout"]);
    const rev = await app.call("admin", "GET", `/api/revisions/${r.json.revision_id}`);
    expect(rev.body.proposed).toMatchObject({ tags: ["checkout", "partners-named"], tags_added: ["partners-named"], tags_removed: ["partners-not-named"], body_md: before.body_md });
    expect(rev.body.payload.text).toBeUndefined();

    // Someone without Review can't approve it; a reviewer can.
    expect((await app.call("rita", "POST", `/api/revisions/${r.json.revision_id}/approve`, {})).status).toBe(403);
    expect((await app.call("admin", "POST", `/api/revisions/${r.json.revision_id}/approve`, {})).status).toBe(200);
    const after = await article(ids.runbook);
    expect(after.tags).toEqual(["checkout", "partners-named"]);
    expect(after.body_md).toBe(before.body_md);
    expect(after.version).toBe(before.version + 1);

    // get_article and tag search see the new tags; the old one finds nothing.
    expect((await call("alice", "get_article", { id: ids.runbook })).json.tags).toEqual(["checkout", "partners-named"]);
    const found = await call("alice", "search_knowledge", { query: "checkout error rate", scope: "all", tags: ["partners-named"] });
    expect(found.json.articles.map((a: { id: string }) => a.id)).toContain(ids.runbook);
    const stale = await call("alice", "search_knowledge", { query: "checkout error rate", scope: "all", tags: ["partners-not-named"] });
    expect(stale.json.articles.map((a: { id: string }) => a.id)).not.toContain(ids.runbook);
  });

  it("replaces all tags together with new text", async () => {
    const before = await article(ids.runbook);
    const r = await call("alice", "propose_article_edit", { id: ids.runbook, version: before.version, summary: "Rewrite the fix", section: "Fix", text: "Roll back the deploy first.", tags: ["Runbook", "checkout", "CHECKOUT"] });
    expect(r.json, r.text).toMatchObject({ status: "pending_review" });
    expect((await app.call("admin", "POST", `/api/revisions/${r.json.revision_id}/approve`, {})).status).toBe(200);
    const after = await article(ids.runbook);
    expect(after.tags).toEqual(["runbook", "checkout"]);
    expect(after.body_md).toMatch(/## Fix\nRoll back the deploy first\./);
  });

  it("refuses both ways at once, an edit that changes nothing, and a section without text", async () => {
    const v = (await article(ids.runbook)).version;
    expect((await call("alice", "propose_article_edit", { id: ids.runbook, version: v, summary: "x", tags: ["a"], add_tags: ["b"] })).text).toMatch(/not both/);
    expect((await call("alice", "propose_article_edit", { id: ids.runbook, version: v, summary: "x", add_tags: ["Runbook"] })).text).toMatch(/already has exactly these tags/);
    expect((await call("alice", "propose_article_edit", { id: ids.runbook, version: v, summary: "x" })).text).toMatch(/pass text, a title, or tags/);
    expect((await call("alice", "propose_article_edit", { id: ids.runbook, version: v, summary: "x", section: "Fix", add_tags: ["z"] })).text).toMatch(/section needs its new text/);
    // A stale version conflicts like any edit.
    expect((await call("alice", "propose_article_edit", { id: ids.runbook, version: v - 1, summary: "x", add_tags: ["z"] })).text).toMatch(/Version conflict/);
  });

  it("publishes at once for someone who may publish directly", async () => {
    // carol is a Project admin (Publish without review) of the project the runbook now lives in.
    await db.query("UPDATE articles SET scope_id = $2 WHERE id = $1", [ids.runbook, ids.project]);
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [ids.project, app.ids.carol]);
    const before = await article(ids.runbook);
    const r = await call("carol", "propose_article_edit", { id: ids.runbook, version: before.version, summary: "Tag it", add_tags: ["incident-response"] });
    expect(r.json, r.text).toMatchObject({ status: "published" });
    expect((await article(ids.runbook)).tags).toEqual(["runbook", "checkout", "incident-response"]);
  });

  it("keeps tags in version history, with what each version added and removed", async () => {
    const h = await app.call("alice", "GET", `/api/items/${ids.runbook}/versions`);
    expect(h.status).toBe(200);
    const [latest, previous] = h.body.versions;
    expect(latest).toMatchObject({ tags: ["runbook", "checkout", "incident-response"], tags_added: ["incident-response"], tags_removed: [] });
    expect(previous).toMatchObject({ tags: ["runbook", "checkout"], tags_added: ["runbook"], tags_removed: ["partners-named"] });
    const v = await app.call("alice", "GET", `/api/items/${ids.runbook}/versions/${latest.version}`);
    expect(v.body.content.tags).toEqual(["runbook", "checkout", "incident-response"]);
  });

  it("keeps the permission rules: no proposing where you can't propose", async () => {
    const vault = (await db.query<{ id: string }>("INSERT INTO scopes (kind, slug, name, visibility) VALUES ('project', 'tag-vault', 'Tag vault', 'members') RETURNING id")).rows[0]!.id;
    await db.query("UPDATE articles SET scope_id = $2 WHERE id = $1", [ids.tokens, vault]);
    const v = (await article(ids.tokens)).version;
    const r = await call("rita", "propose_article_edit", { id: ids.tokens, version: v, summary: "x", add_tags: ["mine"] });
    expect(r.isError).toBe(true);
    expect((await article(ids.tokens)).tags).not.toContain("mine");
  });
});

describe("the article edit API (web)", () => {
  it("takes tags, with or without a body", async () => {
    const before = await article(ids.runbook);
    const r = await app.call("admin", "PUT", `/api/articles/${ids.runbook}`, { version: before.version, summary: "Tags from the editor", remove_tags: ["incident-response"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.published).toBe(true);
    expect((await article(ids.runbook)).tags).toEqual(["runbook", "checkout"]);
    // alice is a Contributor there: she proposes, a reviewer approves.
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'writer') ON CONFLICT DO NOTHING", [ids.project, app.ids.alice]);
    const r2 = await app.call("alice", "PUT", `/api/articles/${ids.runbook}`, { version: before.version + 1, summary: "Both", body_md: before.body_md, tags: ["Ops Runbook"] });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(r2.body.published).toBe(false);
    const rev = await app.call("admin", "GET", `/api/revisions/${r2.body.revision_id}`);
    expect(rev.body.proposed).toMatchObject({ tags: ["ops-runbook"], tags_added: ["ops-runbook"], tags_removed: ["runbook", "checkout"] });
  });
});

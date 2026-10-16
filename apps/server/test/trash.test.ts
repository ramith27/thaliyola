import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { browseKb, getArticle } from "../src/core/items.js";
import { searchKnowledge } from "../src/core/search.js";
import { approveRevision } from "../src/core/review.js";
import { listProjects } from "../src/core/scopes.js";
import { deleteItem, deleteProject, emptyItem, emptyProject, listTrash, restoreItem, restoreProject } from "../src/core/trash.js";
import { createArticle, proposeArticleEdit } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];

beforeAll(async () => {
  ({ db, ids } = await freshDb());
});
afterAll(() => db.end());

const admin = () => ctxFor(db, { email: "admin@example.com" });

describe("trash", () => {
  it("deletes an article to the trash: hidden everywhere, open proposals closed, restorable by owners", async () => {
    const a = await admin();
    const page = await getArticle(a, ids.runbook);
    const edit = await proposeArticleEdit(await ctxFor(db, { email: "writer@example.com" }), { id: ids.runbook, version: page.version, section: "Fix", text: "x", summary: "pending edit" });
    await expect(deleteItem(await ctxFor(db, { email: "writer@example.com" }), ids.runbook)).rejects.toThrow(/owners and admins/);
    await deleteItem(a, ids.runbook);
    expect((await db.query("SELECT state FROM revisions WHERE id = $1", [edit.revision_id])).rows[0].state).toBe("rejected");
    // Gone for readers, from search and from browsing; still visible to someone who can restore it.
    await expect(getArticle(await ctxFor(db, { email: "reader@example.com" }), ids.runbook)).rejects.toThrow(/not found/);
    expect((await getArticle(a, ids.runbook)).status).toBe("deleted");
    const hits = await searchKnowledge(a, { query: "checkout error rate alert" });
    expect(hits.articles.map((h) => h.id)).not.toContain(ids.runbook);
    expect(JSON.stringify(await browseKb(a, "team"))).not.toContain(ids.runbook);
    await expect(proposeArticleEdit(a, { id: ids.runbook, version: page.version, section: "Fix", text: "y", summary: "edit" })).rejects.toThrow(/in the trash/);
    expect((await listTrash(a)).items.map((i: { id: string }) => i.id)).toContain(ids.runbook);

    const restored = await restoreItem(a, ids.runbook);
    expect(restored.status).toBe("published");
    expect((await listTrash(a)).items.map((i: { id: string }) => i.id)).not.toContain(ids.runbook);
  });

  it("deletes a project with everything in it, and restores it the same way", async () => {
    const a = await admin();
    await adminCreateProject(a, { slug: "doomed", name: "Doomed project" });
    await adminSetMember(a, "doomed", "owner@example.com", "owner");
    const art = await createArticle(a, { scope: "doomed", type: "design_doc", title: "Doomed design", body_md: "## Context\n\nGoing away." });
    await approveRevision(a, art.revision_id);
    const owner = await ctxFor(db, { email: "owner@example.com" });
    await expect(deleteProject(owner, "doomed", "wrong")).rejects.toThrow(/type the project's name/);
    await expect(deleteProject(owner, "team", "Team")).rejects.toThrow(/only projects/);
    const res = await deleteProject(owner, "doomed", "Doomed project");
    expect(res.articles).toBe(1);
    expect((await listProjects(await admin())).map((p) => p.slug)).not.toContain("doomed");
    await expect(createArticle(a, { scope: "doomed", type: "design_doc", title: "x", body_md: "x" })).rejects.toThrow(/in the trash/);
    await expect(restoreItem(a, art.article_id)).rejects.toThrow(/restore the project instead/);
    expect((await listTrash(await ctxFor(db, { email: "owner@example.com" }))).projects.map((p: { slug: string }) => p.slug)).toEqual(["doomed"]);

    await restoreProject(owner, "doomed");
    expect((await getArticle(await admin(), art.article_id)).status).toBe("published");
  });

  it("lets only admins empty the trash for good", async () => {
    const a = await admin();
    await deleteItem(a, ids.cvr);
    await expect(emptyItem(await ctxFor(db, { email: "owner@example.com" }), ids.cvr)).rejects.toThrow(/only admins/);
    await emptyItem(a, ids.cvr);
    expect((await db.query("SELECT count(*)::int AS n FROM articles WHERE id = $1", [ids.cvr])).rows[0].n).toBe(0);

    await deleteProject(a, "doomed", "doomed");
    await expect(emptyProject(a, "doomed", "nope")).rejects.toThrow(/type the project's name/);
    await emptyProject(a, "doomed", "Doomed project");
    expect((await db.query("SELECT count(*)::int AS n FROM scopes WHERE slug = 'doomed'")).rows[0].n).toBe(0);
    expect((await db.query("SELECT reason FROM purges WHERE target_kind = 'project'")).rows[0].reason).toMatch(/doomed deleted permanently/);
  });
});

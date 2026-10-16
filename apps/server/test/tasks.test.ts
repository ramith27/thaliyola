import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAddComponent, adminCreateProject } from "../src/core/admin.js";
import { getArticle } from "../src/core/items.js";
import { getProjectContext } from "../src/core/projects.js";
import { approveRevision, getRevision } from "../src/core/review.js";
import { completeTask, getTasks, taskSummary } from "../src/core/tasks.js";
import { createArticle, proposeFinding, proposeMove } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await admin();
  await adminCreateProject(a, { slug: "keyvault", name: "Keyvault" });
  await adminAddComponent(a, "keyvault", { slug: "chrome-extension", kind: "frontend", repo_url: "https://github.com/acme/keyvault-chrome" });
  await adminAddComponent(a, "keyvault", { slug: "android", kind: "mobile" });
  // Filed in the team space but clearly about the project.
  const misfiled = await createArticle(a, { scope: "team", type: "system", title: "Keyvault autofill service", path: "Projects/Keyvault", body_md: "## Purpose\n\nAutofill on Android." });
  await approveRevision(a, misfiled.revision_id);
  const f = await proposeFinding(a, { scope: "team", type: "rca", title: "Keyvault for Chrome: panel stuck", symptoms: "Panel stays open", root_cause: "Session record deleted early", force_new: true });
  if (f.status === "pending_review") await approveRevision(a, f.revision_id);
  // A project page with no repository, and an outline with an empty section.
  const loose = await createArticle(a, { scope: "keyvault", type: "runbook", title: "Release a new app version", body_md: "## Trigger\n\nNew build.\n\n## Diagnosis steps\n\n_To write: Numbered checks._\n" });
  await approveRevision(a, loose.revision_id);
});
afterAll(() => db.end());

const admin = () => ctxFor(db, { email: "admin@example.com" });

describe("curation tasks for client agents", () => {
  it("finds misfiled entries, pages without a repository, empty outlines and projects without an overview", async () => {
    const res = await getTasks(await admin(), { limit: 20 });
    const kinds = new Set(res.tasks.map((t) => t.kind));
    for (const k of ["file_into_project", "tag_repository", "fill_outline", "write_overview"]) expect(kinds.has(k as never), k).toBe(true);
    const misfiled = res.tasks.filter((t) => t.kind === "file_into_project").map((t) => t.targets[0]!.title);
    expect(misfiled).toEqual(expect.arrayContaining(["Keyvault autofill service", "Keyvault for Chrome: panel stuck"]));
    const outline = res.tasks.find((t) => t.kind === "fill_outline" && t.targets[0]!.title === "Release a new app version")!;
    expect(outline.context.empty_sections).toEqual(expect.arrayContaining(["Diagnosis steps"]));
    expect(outline.instructions).toMatch(/propose_article_edit/);
  });

  it("reserves handed-out tasks for an hour and hides completed ones", async () => {
    const first = await getTasks(await admin(), { kind: "file_into_project", limit: 1 });
    const task = first.tasks[0]!;
    // Another agent doesn't get the same task while it's reserved.
    const other = await getTasks(await ctxFor(db, { email: "other@example.com" }), { kind: "file_into_project", limit: 20 });
    expect(other.tasks.map((t) => t.id)).not.toContain(task.id);
    await completeTask(await admin(), { task_id: task.id, outcome: "skipped", note: "not sure which project" });
    const again = await getTasks(await admin(), { kind: "file_into_project", limit: 20 });
    expect(again.tasks.map((t) => t.id)).not.toContain(task.id);
    await expect(completeTask(await admin(), { task_id: task.id, outcome: "done" })).rejects.toThrow(/already completed/);
    const summary = await taskSummary(await admin());
    expect(summary.recent[0]).toMatchObject({ key: task.id, outcome: "skipped" });
  });

  it("lets an agent propose moving an entry into a project repository, and a reviewer approve it", async () => {
    const agent = await ctxFor(db, { email: "agent@example.com", service: true });
    const finding = (await db.query("SELECT id FROM findings WHERE title = 'Keyvault for Chrome: panel stuck'")).rows[0].id;
    const proposal = await proposeMove(agent, { id: finding, to: "keyvault", repo: "chrome-extension", summary: "Chrome extension bug" });
    expect(proposal.status).toBe("pending_review");
    await expect(proposeMove(agent, { id: finding, to: "keyvault" })).rejects.toThrow(/already waiting/);
    await expect(proposeMove(agent, { id: finding, to: "keyvault", repo: "nope" })).rejects.toThrow(/no repository 'nope'/);
    const rev = await getRevision(await admin(), proposal.revision_id);
    expect(rev.op).toBe("move");
    expect(rev.payload).toMatchObject({ to: "keyvault", repo: "chrome-extension" });
    // Service identities never approve; an admin does.
    await expect(approveRevision(agent, proposal.revision_id)).rejects.toThrow();
    await approveRevision(await admin(), proposal.revision_id);
    const moved = await db.query("SELECT s.slug, (SELECT array_agg(c.slug) FROM components c WHERE c.id = ANY(f.component_ids)) AS repos FROM findings f JOIN scopes s ON s.id = f.scope_id WHERE f.id = $1", [finding]);
    expect(moved.rows[0]).toEqual({ slug: "keyvault", repos: ["chrome-extension"] });

    // Re-filing inside the project keeps the folder.
    const page = (await db.query("SELECT id FROM articles WHERE title = 'Release a new app version'")).rows[0].id;
    const tag = await proposeMove(agent, { id: page, to: "keyvault", repo: "android" });
    await approveRevision(await admin(), tag.revision_id);
    const a = await getArticle(await admin(), page);
    expect([a.scope.slug, a.components]).toEqual(["keyvault", ["android"]]);
  });

  it("tells agents working in a project that there's curation work there", async () => {
    const ctx = (await getProjectContext(await admin(), "keyvault")) as { curation?: { open_tasks: number; hint: string } };
    expect(ctx.curation?.open_tasks).toBeGreaterThan(0);
    expect(ctx.curation?.hint).toMatch(/get_tasks/);
  });
});

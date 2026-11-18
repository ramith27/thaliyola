import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember, listManagedProjects } from "../src/core/admin.js";
import { setProjectParent } from "../src/core/hierarchy.js";
import { getProjectContext } from "../src/core/projects.js";
import { approveRevision } from "../src/core/review.js";
import { listProjects } from "../src/core/scopes.js";
import { searchKnowledge } from "../src/core/search.js";
import { listAccess } from "../src/core/teams.js";
import { deleteProject } from "../src/core/trash.js";
import { createArticle } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
const as = (who: string) => ctxFor(db, { email: `${who}@example.com` });
const slugs = async (who: string) => (await listProjects(await as(who))).map((p) => p.slug);
const publish = async (scope: string, title: string, body: string) => {
  const a = await as("admin");
  const res = (await createArticle(a, { scope, type: "decision", title, body_md: `## Context\n\n${body}` })) as { revision_id: string; article_id: string; published?: boolean };
  if (!res.published) await approveRevision(a, res.revision_id);
  return res.article_id;
};

beforeAll(async () => {
  ({ db } = await freshDb());
  const admin = await as("admin");
  await adminCreateProject(admin, { slug: "platform", name: "Platform", visibility: "members" });
  await adminSetMember(admin, "platform", "carol@example.com", "owner");
  await adminSetMember(admin, "platform", "bob@example.com", "reader");
});
afterAll(() => db.end());

describe("sub-projects", () => {
  it("lets a project's admins add sub-projects, whose access flows down from the parent", async () => {
    const carol = await as("carol");
    // Carol isn't a project creator, but she manages Platform.
    await expect(adminCreateProject(carol, { slug: "loose", name: "Loose" })).rejects.toThrow(/project creators/);
    expect(await adminCreateProject(carol, { slug: "platform-api", name: "Platform API", parent: "platform", visibility: "members" })).toMatchObject({ parent: "platform" });
    await adminCreateProject(carol, { slug: "platform-workers", name: "Platform workers", parent: "platform-api", visibility: "members" });

    expect(await slugs("bob")).toEqual(expect.arrayContaining(["platform", "platform-api", "platform-workers"]));
    expect(await slugs("dave")).not.toContain("platform-api");
    const access = await listAccess(await as("bob"), "platform-workers");
    expect(access.my_roles).toEqual(["reader"]);
    expect(access.inherited).toEqual(expect.arrayContaining([expect.objectContaining({ email: "bob@example.com", roles: ["reader"], sources: [{ slug: "platform", name: "Platform", team: null }] })]));
    // A sub-project can add people of its own, who don't see the parent.
    await adminSetMember(carol, "platform-api", "dave@example.com", "writer");
    expect(await slugs("dave")).toEqual(expect.arrayContaining(["platform-api", "platform-workers"]));
    expect(await slugs("dave")).not.toContain("platform");

    const listed = (await listManagedProjects(await as("admin"))).projects.find((p: { slug: string }) => p.slug === "platform-workers");
    expect(listed.parent).toBe("platform-api");
  });

  it("shows where a project sits, and searches the projects above and below it", async () => {
    const parentDoc = await publish("platform", "Use one shared message bus", "every service talks over the zanzibar bus");
    const childDoc = await publish("platform-workers", "Workers retry with jitter", "workers back off with quokka jitter");
    const bob = await as("bob");
    const ctx = await getProjectContext(bob, "platform-api");
    expect(ctx.hierarchy).toEqual({ path: [{ slug: "platform", name: "Platform", readable: true }], sub_projects: [{ slug: "platform-workers", name: "Platform workers", sub_projects: 0 }] });

    const fromChild = await searchKnowledge(bob, { query: "zanzibar bus", project: "platform-workers" });
    expect(fromChild.articles.map((h) => h.id)).toContain(parentDoc);
    const fromParent = await searchKnowledge(bob, { query: "quokka jitter", project: "platform" });
    expect(fromParent.articles.map((h) => h.id)).toContain(childDoc);
    const scoped = await searchKnowledge(bob, { query: "quokka jitter", scope: "platform" });
    expect(scoped.articles.map((h) => h.id)).toContain(childDoc);
  });

  it("refuses cycles and orphaning, and moving needs both sides' admins", async () => {
    const carol = await as("carol");
    await expect(setProjectParent(carol, "platform", "platform-workers")).rejects.toThrow(/its own sub-project/);
    await expect(setProjectParent(carol, "platform", "platform")).rejects.toThrow(/own parent/);
    await expect(deleteProject(carol, "platform", "Platform")).rejects.toThrow(/sub-projects first: Platform API/);

    // Dave writes in platform-api but doesn't manage it or Platform.
    await expect(setProjectParent(await as("dave"), "platform-api", null)).rejects.toThrow(/needs Manage/);
    expect(await setProjectParent(carol, "platform-workers", "platform")).toMatchObject({ parent: "platform", changed: true });
    // Taken out of Platform, the workers project loses Platform's members.
    await setProjectParent(carol, "platform-workers", null);
    expect(await slugs("bob")).not.toContain("platform-workers");
    // Carol still manages it: she created it, so she owns it.
    expect((await listAccess(carol, "platform-workers")).can_manage).toBe(true);
  });
});

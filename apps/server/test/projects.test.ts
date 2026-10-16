import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { browseKb, getArticle } from "../src/core/items.js";
import { getProjectContext } from "../src/core/projects.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];

beforeAll(async () => {
  ({ db, ids } = await freshDb());
});
afterAll(async () => {
  await db.end();
});

describe("getProjectContext", () => {
  it("gives a frontend session its contracts, notices, shared design and records", async () => {
    const ctx = await ctxFor(db, { project: "order-service", component: "frontend" });
    const res = await getProjectContext(ctx);
    expect(res.project.slug).toBe("order-service");
    expect(res.component?.slug).toBe("frontend");
    expect(res.components.map((c) => c.slug)).toEqual(["backend", "frontend"]);
    expect(res.overview?.id).toBe(ids.overview);
    expect(res.contracts).toEqual({ provides: [], consumes: [expect.objectContaining({ id: ids.contract })] });
    expect(res.open_impact_notices).toHaveLength(1);
    expect(res.open_impact_notices[0].summary).toMatch(/status filter/);
    expect(res.uses.map((u: { id: string }) => u.id).sort()).toEqual([ids.dataTable, ids.tokens, ids.webhookPattern].sort());
    expect(res.recent_records.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([ids.contract, ids.screen, ids.decision]));
    // The export known issue is tagged to the backend only.
    expect(res.open_known_issues).toEqual([]);
  });

  it("shows the backend its provided contract and its known issue, not frontend notices", async () => {
    const ctx = await ctxFor(db);
    const res = await getProjectContext(ctx, "order-service", "backend");
    expect(res.contracts).toEqual({ provides: [expect.objectContaining({ id: ids.contract })], consumes: [] });
    expect(res.open_known_issues.map((k: { id: string }) => k.id)).toEqual([ids.knownIssue]);
    expect(res.open_impact_notices).toEqual([]);
  });

  it("requires a project and rejects non-project scopes", async () => {
    const ctx = await ctxFor(db);
    await expect(getProjectContext(ctx)).rejects.toThrow(/no project/);
    await expect(getProjectContext(ctx, "library")).rejects.toThrow(/not a project/);
  });
});

describe("getArticle / browseKb", () => {
  it("returns one section and both directions of relations", async () => {
    const ctx = await ctxFor(db);
    const a = await getArticle(ctx, ids.dataTable, "accessibility");
    expect(a.body_md).toMatch(/^## Accessibility\n\nSortable headers/);
    expect(a.sections).toEqual(["Purpose", "States", "Accessibility", "Do and don't"]);
    expect(a.related).toEqual([expect.objectContaining({ relation: "uses", direction: "in", id: ids.screen, scope: "order-service" })]);
    expect(a.source_links[0]?.system).toBe("figma");
  });

  it("lists the available sections when one is missing", async () => {
    const ctx = await ctxFor(db);
    await expect(getArticle(ctx, ids.dataTable, "nope")).rejects.toThrow(/available: Purpose/);
  });

  it("builds a folder tree", async () => {
    const ctx = await ctxFor(db);
    const res = await browseKb(ctx, "team");
    expect(Object.keys(res.tree.folders)).toEqual(["Data and metrics", "Runbooks"]);
    expect(res.tree.folders["Data and metrics"]!.folders["Metrics"]!.articles[0]!.id).toBe(ids.cvr);
    const sub = await browseKb(ctx, "team", "Data and metrics");
    expect(Object.keys(sub.tree.folders)).toEqual(["Metrics"]);
  });
});

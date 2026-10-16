import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relate } from "../src/core/bootstrap.js";
import { searchKnowledge } from "../src/core/search.js";
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

describe("searchKnowledge", () => {
  it("finds the team runbook and RCA for a symptom, articles first", async () => {
    const ctx = await ctxFor(db, { project: "order-service" });
    const res = await searchKnowledge(ctx, { query: "checkout errors spiked at noon, payments failing" });
    expect(res.findings.map((h) => h.id)).toContain(ids.rca);
    expect(res.articles.map((h) => h.id)).toContain(ids.runbook);
    const rca = res.findings.find((h) => h.id === ids.rca)!;
    expect(rca.scope).toEqual({ slug: "team", kind: "team" });
    expect(rca.snippet).toMatch(/\*\*/);
  });

  it("doesn't let the current-project boost lift a weak match over a much stronger one", async () => {
    // Regression: with rank-only fusion the project's export issue (matches "fail") beat the team RCA
    // that matches every term, because a 1.3x boost outweighs a one-position rank gap.
    const ctx = await ctxFor(db, { project: "order-service" });
    const res = await searchKnowledge(ctx, { query: "payments failing with 429 during a sale" });
    expect(res.findings[0]?.id).toBe(ids.rca);
  });

  it("points at the matching article section", async () => {
    const ctx = await ctxFor(db);
    const res = await searchKnowledge(ctx, { query: "aria-sort accessibility" });
    const hit = res.articles.find((h) => h.id === ids.dataTable)!;
    expect(hit.section).toBe("Accessibility");
    expect(hit.scope.slug).toBe("library");
  });

  it("keeps other projects out of the default scope but finds them with scope=all", async () => {
    const ctx = await ctxFor(db, { project: "order-service" });
    const dflt = await searchKnowledge(ctx, { query: "merchant onboarding wizard" });
    expect(dflt.articles.map((h) => h.id)).not.toContain(ids.otherDoc);
    const all = await searchKnowledge(ctx, { query: "merchant onboarding wizard", scope: "all" });
    expect(all.articles.map((h) => h.id)).toContain(ids.otherDoc);
  });

  it("includes another project's item once the current project declares it uses it", async () => {
    await relate(db, { kind: "scope", id: ids.project }, "uses", { kind: "article", id: ids.otherDoc });
    const ctx = await ctxFor(db, { project: "order-service" });
    const res = await searchKnowledge(ctx, { query: "merchant onboarding wizard" });
    const hit = res.articles.find((h) => h.id === ids.otherDoc)!;
    expect(hit.via_uses_link).toBe(true);
    expect(hit.scope.slug).toBe("merchant-portal");
    await db.query("DELETE FROM relations WHERE from_id = $1 AND to_id = $2", [ids.project, ids.otherDoc]);
  });

  it("hides drafts unless asked for", async () => {
    const ctx = await ctxFor(db, { project: "order-service" });
    const dflt = await searchKnowledge(ctx, { query: "refund returns 500" });
    expect(dflt.findings.map((h) => h.id)).not.toContain(ids.draft);
    const drafts = await searchKnowledge(ctx, { query: "refund returns 500", statuses: ["draft"] });
    expect(drafts.findings.map((h) => h.id)).toEqual([ids.draft]);
  });

  it("filters by entity alias and by type", async () => {
    const ctx = await ctxFor(db);
    const res = await searchKnowledge(ctx, { query: "orders sessions", entity: "cvr" });
    expect(res.articles.map((h) => h.id)).toEqual([ids.cvr]);
    const typed = await searchKnowledge(ctx, { query: "checkout", types: ["rca"] });
    expect(typed.articles).toEqual([]);
    expect(typed.findings.map((h) => h.id)).toEqual([ids.rca]);
  });

  it("marks possibly-stale items with a warning", async () => {
    await db.query("UPDATE findings SET status = 'possibly_stale' WHERE id = $1", [ids.rca]);
    const ctx = await ctxFor(db);
    const res = await searchKnowledge(ctx, { query: "payment provider rate limit" });
    expect(res.findings.find((h) => h.id === ids.rca)!.warning).toMatch(/verified/);
    await db.query("UPDATE findings SET status = 'published' WHERE id = $1", [ids.rca]);
  });

  it("rejects an unknown scope and an empty query", async () => {
    const ctx = await ctxFor(db);
    await expect(searchKnowledge(ctx, { query: "x", scope: "nope" })).rejects.toThrow(/not found/);
    await expect(searchKnowledge(ctx, { query: "  " })).rejects.toThrow(/empty/);
  });
});

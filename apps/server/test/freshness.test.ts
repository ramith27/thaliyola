import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { markStale, needsAttention } from "../src/core/freshness.js";
import { searchKnowledge } from "../src/core/search.js";
import { verifyEntry } from "../src/core/writes.js";
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

describe("freshness", () => {
  it("flags entries not verified within the window, separately for findings and articles", async () => {
    await db.query("UPDATE findings SET last_verified_at = now() - interval '100 days' WHERE id = $1", [ids.rca]);
    await db.query("UPDATE articles SET last_verified_at = now() - interval '100 days' WHERE id IN ($1, $2)", [ids.runbook, ids.cvr]);
    expect(await markStale(db, { findingDays: 90, articleDays: 180 })).toEqual({ findings: 1, articles: 0 });
    expect(await markStale(db, { findingDays: 90, articleDays: 90 })).toEqual({ findings: 0, articles: 2 });
    const ctx = await ctxFor(db);
    const hits = await searchKnowledge(ctx, { query: "payment provider rate limit" });
    expect(hits.findings[0]).toMatchObject({ id: ids.rca, status: "possibly_stale" });
    expect(hits.findings[0]!.warning).toBeTruthy();
  });

  it("lists what needs attention, including overdue reviews, until verified", async () => {
    await db.query("UPDATE articles SET review_due = current_date - 1 WHERE id = $1", [ids.dataTable]);
    const ctx = await ctxFor(db);
    const before = (await needsAttention(ctx)).entries.map((e: { id: string; reason: string }) => `${e.id}:${e.reason}`);
    expect(before).toEqual(
      expect.arrayContaining([`${ids.rca}:not verified recently`, `${ids.runbook}:not verified recently`, `${ids.dataTable}:review overdue`]),
    );
    await verifyEntry(ctx, { id: ids.rca, still_valid: true });
    const after = (await needsAttention(ctx)).entries.map((e: { id: string }) => e.id);
    expect(after).not.toContain(ids.rca);
    const libraryOnly = (await needsAttention(ctx, { scope: "library" })).entries.map((e: { id: string }) => e.id);
    expect(libraryOnly).toEqual([ids.dataTable]);
  });
});

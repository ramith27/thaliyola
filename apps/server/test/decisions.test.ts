import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { insertArticle } from "../src/core/bootstrap.js";
import { decisionConflicts, notifyReviewsDue, resolveConflict, setRevisitDate, similarDecisions } from "../src/core/decisions.js";
import { HashingEmbedder, indexPendingChunks } from "../src/core/embeddings.js";
import { listSuggestions } from "../src/core/suggestions.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
const embedder = new HashingEmbedder();
const as = async (email: string) => ({ ...(await ctxFor(db, { email })), embedder, settings: { ...TEST_SETTINGS, duplicateSimilarity: 0.8 } });
let scope: string;
let queueA: string;
let queueB: string;
const body = (choice: string) => `## Context\nWe need a job queue.\n\n## Options considered\nSQS, Postgres.\n\n## Choice\n${choice}\n\n## Consequences\nOps cost.`;

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "shop", name: "Shop" });
  await adminSetMember(a, "shop", "owner@example.com", "owner");
  await adminSetMember(a, "shop", "writer@example.com", "writer");
  scope = (await db.query("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0].id;
  const owner = (await as("owner@example.com")).actor.id;
  queueA = await insertArticle(db, { scopeId: scope, type: "decision", title: "Use Postgres for the job queue", body: body("Use Postgres SKIP LOCKED for the background job queue."), ownerId: owner });
  queueB = await insertArticle(db, { scopeId: scope, type: "decision", title: "Use SQS for background jobs", body: body("Use Postgres SKIP LOCKED for the background job queue, polled by workers.") });
  await insertArticle(db, { scopeId: scope, type: "decision", title: "Use Inter as the UI font", body: body("Inter for all interface text, Georgia for long reading.") });
  while ((await indexPendingChunks(db, embedder)) > 0);
});
afterAll(() => db.end());

describe("revisit dates", () => {
  it("gives new decisions one six months out, and other articles none", async () => {
    const due = (await db.query("SELECT review_due - current_date AS days FROM articles WHERE id = $1", [queueA])).rows[0].days;
    expect(due).toBe(180);
    const sys = await insertArticle(db, { scopeId: scope, type: "system", title: "Checkout", body: "## Purpose\nx" });
    expect((await db.query("SELECT review_due FROM articles WHERE id = $1", [sys])).rows[0].review_due).toBeNull();
  });

  it("lets the owner or a reviewer move it, nobody else", async () => {
    await expect(setRevisitDate(await as("writer@example.com"), { id: queueA, months: 3 })).rejects.toThrow(/owner/);
    const r = await setRevisitDate(await as("owner@example.com"), { id: queueA, date: "2027-01-31" });
    expect(r.review_due).toBe("2027-01-31");
    await expect(setRevisitDate(await as("owner@example.com"), { id: queueA, date: "next week" })).rejects.toThrow(/YYYY-MM-DD/);
  });

  it("tells the owner once when the date passes", async () => {
    await db.query("UPDATE articles SET review_due = current_date - 1 WHERE id = $1", [queueA]);
    expect(await notifyReviewsDue(db, TEST_SETTINGS)).toBeGreaterThanOrEqual(1);
    const n = (await db.query("SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'owner@example.com' AND n.target_id = $1", [queueA])).rows;
    expect(n.map((x) => x.title)).toEqual(["Time to revisit the decision: Use Postgres for the job queue"]);
    expect(await notifyReviewsDue(db, TEST_SETTINGS)).toBe(0);
    // A new date that passes again is announced again.
    await setRevisitDate(await as("owner@example.com"), { id: queueA, date: "2020-01-01" });
    expect(await notifyReviewsDue(db, TEST_SETTINGS)).toBe(1);
  });
});

describe("possible conflicts", () => {
  it("pairs decisions whose choices read alike, and finds them before a new one is recorded", async () => {
    const pairs = await decisionConflicts(await as("owner@example.com"), null);
    expect(pairs.map((p) => [p.a.title, p.b.title].sort())).toEqual([["Use Postgres for the job queue", "Use SQS for background jobs"]]);
    const s = await listSuggestions(await as("owner@example.com"), { scope: "all" });
    expect(s.conflicts).toHaveLength(1);
    const similar = await similarDecisions(await as("writer@example.com"), scope, "Use Postgres SKIP LOCKED for the background job queue.");
    expect(similar.map((d) => d.title)).toContain("Use Postgres for the job queue");
  });

  it("lets a reviewer mark one superseded or say they don't conflict; then it's gone", async () => {
    await expect(resolveConflict(await as("writer@example.com"), { a: queueA, b: queueB, outcome: "not_a_conflict" })).rejects.toThrow(/review/);
    await resolveConflict(await as("owner@example.com"), { a: queueA, b: queueB, outcome: "supersedes" });
    expect((await db.query("SELECT status FROM articles WHERE id = $1", [queueB])).rows[0].status).toBe("superseded");
    expect(await decisionConflicts(await as("owner@example.com"), null)).toEqual([]);
  });
});

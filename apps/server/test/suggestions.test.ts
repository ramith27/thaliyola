import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertFinding, relate } from "../src/core/bootstrap.js";
import { HashingEmbedder, indexPendingChunks } from "../src/core/embeddings.js";
import { listSuggestions } from "../src/core/suggestions.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];

beforeAll(async () => {
  ({ db, ids } = await freshDb());
});
afterAll(async () => {
  await db.end();
});

describe("suggestions", () => {
  it("suggests promoting a recurring root cause into the article it relates to", async () => {
    const ctx = await ctxFor(db);
    expect((await listSuggestions(ctx)).promote).toEqual([]);
    const again = await insertFinding(db, {
      scopeId: ids.team, type: "incident", title: "Black Friday checkout 429s",
      symptoms: "Payments failed with 429 during the Black Friday sale.", rootCause: "Retry storm hit the payment provider rate limit.", fix: "Backoff.",
    });
    await relate(db, { kind: "finding", id: again }, "same_root_cause", { kind: "finding", id: ids.rca });
    const s = await listSuggestions(ctx);
    const top = s.promote.find((p) => p.finding.id === ids.rca)!;
    expect(top).toMatchObject({ recurrences: 1, suggested_article: { id: ids.runbook, type: "runbook" } });
    expect(top.hint).toContain("Checkout error-rate alert");
    // The linked incident is part of the same cluster, not a second suggestion.
    expect(s.promote.map((p) => p.finding.id)).not.toContain(again);
  });

  it("counts repeated verification as recurrence", async () => {
    const ctx = await ctxFor(db);
    // verify_entry calls are counted from the audit log (written by the MCP/REST layer).
    await db.query("INSERT INTO audit_log (actor_id, tool, target_id) SELECT $1, 'verify_entry', $2 FROM generate_series(1, 3)", [ctx.actor.id, ids.knownIssue]);
    const s = await listSuggestions(ctx);
    expect(s.promote.find((p) => p.finding.id === ids.knownIssue)?.verifications).toBe(3);
  });

  it("finds unlinked near-duplicate findings with embeddings, and drops them once linked", async () => {
    const embedder = new HashingEmbedder();
    const ctx = await ctxFor(db, { embedder, settings: { ...TEST_SETTINGS, duplicateSimilarity: 0.7 } });
    const copy = await insertFinding(db, {
      scopeId: ids.project, type: "rca", title: "Order export times out for big ranges",
      symptoms: "CSV export from the orders list spins and fails with a 504 for large date ranges.", rootCause: "Export runs synchronously in the request.", fix: "Narrow the date range.",
    });
    while ((await indexPendingChunks(db, embedder)) > 0);
    const before = await listSuggestions(ctx);
    expect(before.duplicates).toEqual([expect.objectContaining({ a: expect.anything(), b: expect.anything() })]);
    const pair = before.duplicates[0] as { a: { id: string }; b: { id: string } };
    expect([pair.a.id, pair.b.id].sort()).toEqual([copy, ids.knownIssue].sort());
    await relate(db, { kind: "finding", id: copy }, "same_root_cause", { kind: "finding", id: ids.knownIssue });
    expect((await listSuggestions(ctx)).duplicates).toEqual([]);
    expect((await listSuggestions(await ctxFor(db))).note).toMatch(/semantic search/);
  });
});

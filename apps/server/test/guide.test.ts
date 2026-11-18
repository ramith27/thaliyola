import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guideProgress } from "../src/core/guide.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  ({ db } = await freshDb());
});
afterAll(() => db.end());

describe("guide progress", () => {
  it("starts with nothing used and a tip for each feature", async () => {
    const p = await guideProgress(await ctxFor(db, { email: "new@example.com" }));
    expect(p.done).toBe(0);
    expect(p.total).toBe(10);
    expect(p.features.sessions).toMatchObject({ done: false, tip: expect.stringMatching(/Install the Claude Code plugin/) });
  });

  it("counts what the person and their agents did, and spots an old plugin", async () => {
    const ctx = await ctxFor(db, { email: "busy@example.com" });
    await db.query("INSERT INTO audit_log (actor_id, tool, via) VALUES ($1, 'search_knowledge', 'mcp'), ($1, 'get_design_system', 'api')", [ctx.actor.id]);
    await db.query("INSERT INTO agent_sessions (user_id, handle, client) VALUES ($1, 'busy/app', 'claude-code')", [ctx.actor.id]);
    let p = await guideProgress(ctx);
    expect(p.features).toMatchObject({ connect: { done: true }, knowledge: { done: true }, design: { done: true }, security: { done: false } });
    expect(p.features.sessions).toMatchObject({ done: true, tip: expect.stringMatching(/Update the Claude Code plugin/) });
    await db.query("INSERT INTO audit_log (actor_id, tool, via) VALUES ($1, 'api:check_path', 'api')", [ctx.actor.id]);
    p = await guideProgress(ctx);
    expect(p.features.sessions).toEqual({ done: true });
    expect(p.done).toBe(4);
    // Someone else's activity doesn't count.
    expect((await guideProgress(await ctxFor(db, { email: "other@example.com" }))).done).toBe(0);
  });
});

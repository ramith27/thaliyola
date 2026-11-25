import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertArticle } from "../src/core/bootstrap.js";
import { flushDeliveries } from "../src/core/notify.js";
import { searchKnowledge } from "../src/core/search.js";
import { listSuggestions } from "../src/core/suggestions.js";
import { rateSource, recordRead, usefulnessOf } from "../src/core/usefulness.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
let team: string;
let a: string;
let b: string;
let old: string;

beforeAll(async () => {
  ({ db } = await freshDb());
  team = (await db.query("SELECT id FROM scopes WHERE slug = 'team'")).rows[0].id;
  const owner = (await ctxFor(db, { email: "owner@example.com" })).actor.id;
  // Two runbooks equally good for "rollback the payments deploy".
  a = await insertArticle(db, { scopeId: team, type: "runbook", title: "Payments rollback A", body: "## Steps\nRollback the payments deploy with the deploy tool.", ownerId: owner });
  b = await insertArticle(db, { scopeId: team, type: "runbook", title: "Payments rollback B", body: "## Steps\nRollback the payments deploy with the deploy tool.", ownerId: owner });
  old = await insertArticle(db, { scopeId: team, type: "runbook", title: "Fax machine setup", body: "## Steps\nPlug it in." });
  await db.query("UPDATE articles SET created_at = now() - interval '400 days' WHERE id = $1", [old]);
});
afterAll(() => db.end());

const order = async () => (await searchKnowledge(await ctxFor(db, { email: "reader@example.com" }), { query: "rollback the payments deploy" })).articles.map((h) => h.id);

describe("usefulness", () => {
  it("counts reads, and ranks a used, helpful item above an equal one", async () => {
    for (let i = 0; i < 5; i++) recordRead(db, "article", b);
    recordRead(db, "article", b, "quoted");
    await flushDeliveries();
    await rateSource(await ctxFor(db, { email: "reader@example.com" }), { id: b, verdict: "helpful" });
    const u = await usefulnessOf(await ctxFor(db, { email: "reader@example.com" }), b);
    expect(u).toMatchObject({ reads: 5, quoted: 1, helpful: 1, mine: "helpful" });
    const ids = await order();
    expect(ids.indexOf(b)).toBeLessThan(ids.indexOf(a));
  });

  it("needs a note for outdated, tells the owner, and two people's reports make it possibly stale", async () => {
    const r1 = await ctxFor(db, { email: "r1@example.com" });
    await expect(rateSource(r1, { id: b, verdict: "outdated" })).rejects.toThrow(/note/);
    await rateSource(r1, { id: b, verdict: "outdated", note: "The deploy tool was replaced by Argo." });
    await flushDeliveries();
    const n = (await db.query("SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'owner@example.com' AND n.target_id = $1", [b])).rows;
    expect(n.map((x) => x.title)).toEqual(["Reported outdated: Payments rollback B"]);
    expect((await db.query("SELECT status FROM articles WHERE id = $1", [b])).rows[0].status).toBe("published");
    const second = await rateSource(await ctxFor(db, { email: "r2@example.com" }), { id: b, verdict: "wrong", note: "Argo, not the deploy tool." });
    expect(second.marked_possibly_stale).toBe(true);
    expect((await db.query("SELECT status FROM articles WHERE id = $1", [b])).rows[0].status).toBe("possibly_stale");
    // Reported items rank below the one nobody complained about.
    const ids = await order();
    expect(ids.indexOf(a)).toBeLessThan(ids.indexOf(b));
    expect((await usefulnessOf(r1, b)).reports.map((x: { verdict: string }) => x.verdict).sort()).toEqual(["outdated", "wrong"]);
  });

  it("lists what nobody has read in six months as a suggestion", async () => {
    const s = await listSuggestions(await ctxFor(db, { email: "admin@example.com" }), { scope: "all" });
    expect(s.unused.map((x: { id: string }) => x.id)).toEqual([old]);
    recordRead(db, "article", old);
    await flushDeliveries();
    expect((await listSuggestions(await ctxFor(db, { email: "admin@example.com" }), { scope: "all" })).unused).toEqual([]);
  });
});

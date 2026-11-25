import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject } from "../src/core/admin.js";
import { insertArticle, relate } from "../src/core/bootstrap.js";
import { searchKnowledge } from "../src/core/search.js";
import { setValidDates } from "../src/core/validity.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
let team: string;
let oldRule: string;
let newRule: string;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const find = async (q: string, asOf?: string) =>
  (await searchKnowledge(await ctxFor(db, { email: "reader@example.com" }), { query: q, asOf })).articles.filter((h) => h.id === oldRule || h.id === newRule);

beforeAll(async () => {
  ({ db } = await freshDb());
  team = (await db.query("SELECT id FROM scopes WHERE slug = 'team'")).rows[0].id;
  oldRule = await insertArticle(db, { scopeId: team, type: "decision", title: "Session timeout is 30 minutes", body: "## Choice\nSessions time out after 30 minutes idle." });
  await db.query("UPDATE articles SET created_at = now() - interval '200 days' WHERE id = $1", [oldRule]);
  newRule = await insertArticle(db, { scopeId: team, type: "decision", title: "Session timeout is 15 minutes", body: "## Choice\nSessions time out after 15 minutes idle." });
});
afterAll(() => db.end());

describe("facts with dates", () => {
  it("closes the old item's dates when another supersedes it, and starts the new one's", async () => {
    await relate(db, { kind: "article", id: newRule }, "supersedes", { kind: "article", id: oldRule });
    await db.query("UPDATE articles SET status = 'superseded' WHERE id = $1", [oldRule]);
    const rows = (await db.query("SELECT id, valid_from::text, valid_until::text FROM articles WHERE id = ANY($1)", [[oldRule, newRule]])).rows;
    expect(rows.find((r) => r.id === oldRule)).toMatchObject({ valid_from: null, valid_until: day(0) });
    expect(rows.find((r) => r.id === newRule)).toMatchObject({ valid_from: day(0), valid_until: null });
  });

  it("answers what's true now, and what was true on a date", async () => {
    expect((await find("session timeout")).map((h) => h.id)).toEqual([newRule]);
    const then = await find("session timeout", day(-30));
    expect(then.map((h) => h.id)).toEqual([oldRule]);
    expect(then[0]).toMatchObject({ status: "superseded", valid: { from: null, until: day(0) }, warning: expect.stringMatching(/true then, not now/) });
    await expect(find("session timeout", "2026-02-30")).rejects.toThrow(/isn't a date/);
  });

  it("lets verifiers set dates: expired items leave search, future ones say when they start", async () => {
    const admin = await ctxFor(db, { email: "admin@example.com" });
    // Members-only: someone outside the project can't (it doesn't even exist for them).
    await adminCreateProject(admin, { slug: "vault", name: "Vault", visibility: "members" });
    const vault = (await db.query("SELECT id FROM scopes WHERE slug = 'vault'")).rows[0].id;
    const secret = await insertArticle(db, { scopeId: vault, type: "system", title: "Vault rotation", body: "## Purpose\nx" });
    await expect(setValidDates(await ctxFor(db, { email: "reader@example.com" }), { id: secret, valid_until: day(10) })).rejects.toThrow(/not found/);
    await expect(setValidDates(admin, { id: newRule, valid_from: day(5), valid_until: day(1) })).rejects.toThrow(/after valid_from/);
    await setValidDates(admin, { id: newRule, valid_from: day(5) });
    expect((await find("session timeout"))[0]).toMatchObject({ id: newRule, warning: expect.stringMatching(new RegExp(`Takes effect on ${day(5)}`)) });
    await setValidDates(admin, { id: newRule, valid_from: day(-10), valid_until: day(-1) });
    expect(await find("session timeout")).toEqual([]);
    expect((await find("session timeout", day(-2))).map((h) => h.id)).toContain(newRule);
  });
});

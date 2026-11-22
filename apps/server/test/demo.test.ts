import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_PEOPLE, demoAccount, lastReset, nextReset, resetDemo } from "../src/core/demo.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
const settings = { ...TEST_SETTINGS, authMode: "local" as const, demo: { resetHours: 12 } };

beforeAll(async () => {
  ({ db } = await freshDb());
});
afterAll(() => db.end());

describe("the public demo", () => {
  it("wipes everything and seeds the showcase, and records when", async () => {
    await db.query("INSERT INTO articles (scope_id, type, title, body_md, status) SELECT id, 'system', 'Visitor scribble', 'x', 'published' FROM scopes WHERE slug = 'team'");
    expect(await resetDemo(db, settings, () => {})).toBe(true);
    expect((await db.query("SELECT count(*)::int AS n FROM articles WHERE title = 'Visitor scribble'")).rows[0].n).toBe(0);
    const counts = (await db.query(
      `SELECT (SELECT count(*) FROM design_systems)::int AS design, (SELECT count(*) FROM incidents)::int AS incidents, (SELECT count(*) FROM agent_sessions)::int AS sessions,
              (SELECT count(*) FROM vulnerabilities)::int AS vulns, (SELECT count(*) FROM pr_briefings)::int AS prs, (SELECT count(*) FROM users WHERE email LIKE '%@demo.thaliyola.app')::int AS people`,
    )).rows[0];
    expect(counts).toEqual({ design: 2, incidents: 1, sessions: 3, vulns: 4, prs: 1, people: 4 });
    const last = await lastReset(db);
    expect(last).not.toBeNull();
    expect(nextReset(settings, last).getTime() - last!.getTime()).toBe(12 * 3_600_000);
  });

  it("signs in only the demo people, who are approved and need no password change", async () => {
    for (const p of DEMO_PEOPLE) {
      const id = await demoAccount(db, p.key);
      expect(id).toBeTruthy();
      const u = (await db.query("SELECT approved_at IS NOT NULL AS ok, must_change_password, is_admin FROM users WHERE id = $1", [id])).rows[0];
      expect(u).toEqual({ ok: true, must_change_password: false, is_admin: p.admin });
    }
    expect(await demoAccount(db, "admin")).toBeNull();
  });
});

describe("outbound requests in the demo", () => {
  it("only reach the model download host", async () => {
    const { lockOutbound } = await import("../src/core/demo.js");
    const real = globalThis.fetch;
    try {
      lockOutbound();
      await expect(fetch("https://hooks.slack.com/services/x")).rejects.toThrow(/off in the demo/);
      await expect(fetch("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/off in the demo/);
    } finally {
      globalThis.fetch = real;
    }
  });
});

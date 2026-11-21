import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { insertArticle, insertFinding } from "../src/core/bootstrap.js";
import { briefLines, getProjectBrief } from "../src/core/brief.js";
import { declareIncident } from "../src/core/incidents.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
const as = (email: string) => ctxFor(db, { email });

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "shop", name: "Shop", visibility: "members" });
  await adminSetMember(a, "shop", "alice@example.com", "writer");
  const s = (await db.query("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0].id;
  await insertArticle(db, { scopeId: s, type: "decision", title: "Use Postgres for jobs", body: "## Choice\nPostgres" });
  const old = await insertArticle(db, { scopeId: s, type: "decision", title: "Cache in Redis", body: "## Choice\nRedis" });
  await db.query("UPDATE articles SET created_at = now() - interval '60 days', review_due = current_date + 5 WHERE id = $1", [old]);
  await insertFinding(db, { scopeId: s, type: "known_issue", title: "Export times out", symptoms: "x", rootCause: "y", fix: "z" });
  await db.query("INSERT INTO vulnerabilities (scope_id, source, title, severity, status) VALUES ($1, 'reported', 'XSS in search', 'critical', 'open')", [s]);
  await declareIncident(await as("alice@example.com"), { project: "shop", title: "Checkout down", severity: "sev1" });
  const src = (await db.query("INSERT INTO sources (kind, name, scope_id, next_run_at) VALUES ('github_prs', 'PRs', $1, 'infinity') RETURNING id", [s])).rows[0].id;
  await db.query("INSERT INTO inbox_items (source_id, scope_id, external_id, title, url, published_at) VALUES ($1, $2, 'pr:1', 'Merged: Fix checkout retries (acme/shop#1)', 'https://x/1', now())", [src, s]);
});
afterAll(() => db.end());

describe("project brief", () => {
  it("gathers the week's incidents, merged PRs, decisions made and due, new knowledge and vulnerabilities", async () => {
    const b = await getProjectBrief(await as("alice@example.com"), "shop");
    expect(b.incidents.map((i) => [i.title, i.severity])).toEqual([["Checkout down", "sev1"]]);
    expect(b.prs_merged.map((p) => p.title)).toEqual(["Merged: Fix checkout retries (acme/shop#1)"]);
    expect(b.decisions.map((d) => d.title)).toEqual(["Use Postgres for jobs"]);
    expect(b.decisions_due.map((d) => d.title)).toEqual(["Cache in Redis"]);
    expect(b.new_knowledge.map((k) => k.title)).toEqual(["Export times out"]);
    expect(b.vulnerabilities).toEqual({ opened: 1, fixed: 0, open_critical: 1 });
    const lines = briefLines(b, (p) => `https://kb/#${p}`);
    expect(lines[0]).toBe("Incidents: SEV1 Checkout down (open)");
    expect(lines).toContain("1 pull request merged: Fix checkout retries (acme/shop#1)");
    expect(lines.at(-1)).toBe("Full brief: https://kb/#/project/shop/brief");
  });

  it("is only for people who can read the project", async () => {
    await expect(getProjectBrief(await as("outsider@example.com"), "shop")).rejects.toThrow(/not found/);
  });
});

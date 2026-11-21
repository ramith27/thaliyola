import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { insertArticle } from "../src/core/bootstrap.js";
import { findExperts, knowsAbout, rebuildExpertise } from "../src/core/expertise.js";
import { askSession, registerSession } from "../src/core/sessions.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
const as = (email: string) => ctxFor(db, { email });
const id = async (email: string) => (await as(email)).actor.id;

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "pay", name: "Payments", components: [{ slug: "api", kind: "backend", repo_url: "https://github.com/acme/pay-api" }] });
  await adminCreateProject(a, { slug: "vault", name: "Vault", visibility: "members" });
  for (const e of ["alice@example.com", "bob@example.com", "carol@example.com", "dave@example.com"]) await adminSetMember(a, "pay", e, "writer");
  await adminSetMember(a, "vault", "alice@example.com", "writer");
  const pay = (await db.query("SELECT id FROM scopes WHERE slug = 'pay'")).rows[0].id;
  const vault = (await db.query("SELECT id FROM scopes WHERE slug = 'vault'")).rows[0].id;
  const api = (await db.query("SELECT id FROM components WHERE scope_id = $1", [pay])).rows[0].id;
  const [alice, bob, dave] = [await id("alice@example.com"), await id("bob@example.com"), await id("dave@example.com")];

  // Alice wrote two refunds articles (one a year ago), tagged and linked to the "refunds" service; Bob approved one.
  const recent = await insertArticle(db, { scopeId: pay, type: "system", title: "Refunds", body: "## Purpose\nx", tags: ["refunds"], componentIds: [api] });
  const old = await insertArticle(db, { scopeId: pay, type: "runbook", title: "Refund stuck", body: "## Trigger\nx", tags: ["refunds"] });
  await db.query("INSERT INTO item_versions (target_kind, target_id, version, title, content, author_id, approver_id, created_at) VALUES ('article', $1, 1, 'Refunds', '{}', $2, $3, now()), ('article', $4, 1, 'Refund stuck', '{}', $2, NULL, now() - interval '365 days')", [recent, alice, bob, old]);
  const ent = (await db.query("INSERT INTO entities (kind, name) VALUES ('service', 'refunds-service') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO entity_links (entity_id, target_kind, target_id) VALUES ($1, 'article', $2)", [ent, recent]);
  // Dave wrote about Vault (members-only), and opted out of being listed.
  const v = await insertArticle(db, { scopeId: vault, type: "system", title: "Vault keys", body: "## Purpose\nx", tags: ["refunds"] });
  await db.query("INSERT INTO item_versions (target_kind, target_id, version, title, content, author_id, created_at) VALUES ('article', $1, 1, 'Vault keys', '{}', $2, now())", [v, alice]);
  const hidden = await insertArticle(db, { scopeId: pay, type: "system", title: "Ledger", body: "## Purpose\nx", tags: ["refunds"] });
  await db.query("INSERT INTO item_versions (target_kind, target_id, version, title, content, author_id, created_at) VALUES ('article', $1, 1, 'Ledger', '{}', $2, now())", [hidden, dave]);
  await db.query("UPDATE users SET prefs = prefs || '{\"hide_expertise\": true}' WHERE id = $1", [dave]);
  // Carol answered a question about the API.
  const carol = await id("carol@example.com");
  await db.query(
    "INSERT INTO session_questions (from_user_id, to_scope_id, to_component, question, status, answer, answered_by_user_id, answered_at, expires_at) VALUES ($1, $2, 'api', 'Why 409?', 'answered', 'Idempotency', $3, now(), now() + interval '1 hour')",
    [alice, pay, carol],
  );
  expect(await rebuildExpertise(db)).toBeGreaterThan(0);
});
afterAll(() => db.end());

describe("who knows what", () => {
  it("ranks people for a project from what they wrote, approved and answered, recent work first", async () => {
    const r = await findExperts(await as("bob@example.com"), { project: "pay" });
    expect(r.experts.map((e) => e.name)).toEqual(["alice@example.com", "carol@example.com"]);
    expect(r.experts[0]!.score).toBeGreaterThan(r.experts[1]!.score);
  });

  it("finds them by repository, entity, tag or words, never the caller", async () => {
    const byRepo = await findExperts(await as("bob@example.com"), { project: "pay", component: "api" });
    expect(byRepo.experts.map((e) => e.name).sort()).toEqual(["alice@example.com", "carol@example.com"]);
    expect((await findExperts(await as("carol@example.com"), { topic: "refunds-service" })).experts.map((e) => e.name)).toEqual(["alice@example.com", "bob@example.com"]);
    expect((await findExperts(await as("carol@example.com"), { topic: "refunds" })).experts[0]!.name).toBe("alice@example.com");
    expect((await findExperts(await as("alice@example.com"), { topic: "refunds" })).experts.map((e) => e.name)).not.toContain("alice@example.com");
  });

  it("leaves out people who opted out, and evidence from projects the caller can't read", async () => {
    const all = (await findExperts(await as("bob@example.com"), { topic: "refunds" })).experts.map((e) => e.name);
    expect(all).not.toContain("dave@example.com");
    const forBob = await knowsAbout(await as("bob@example.com"), await id("alice@example.com"));
    const forAlice = await knowsAbout(await as("alice@example.com"), await id("alice@example.com"));
    expect(JSON.stringify(forBob)).not.toMatch(/Vault/);
    const sum = (rows: { score: number }[]) => rows.reduce((n, r) => n + r.score, 0);
    expect(sum(forAlice)).toBeGreaterThan(sum(forBob));
  });
});

describe("asking an expert", () => {
  it("asks the experts' online sessions, or the top expert in person when none is online", async () => {
    const bob = await as("bob@example.com");
    const inPerson = (await askSession(bob, { to: "expert:refunds-service", question: "Who approves partial refunds?", wait_seconds: 0 })) as { to: string };
    expect(inPerson.to).toBe("alice@example.com");
    await registerSession(await as("alice@example.com"), { repo: "https://github.com/acme/pay-api", client: "claude-code", client_session_id: "a1" });
    const viaSession = (await askSession(bob, { to: "expert:refunds-service", question: "And full refunds?", wait_seconds: 0 })) as { asked: string[]; experts: { name: string }[] };
    expect(viaSession.asked).toEqual(["alice/pay-api"]);
    expect(viaSession.experts[0]!.name).toBe("alice@example.com");
    await expect(askSession(bob, { to: "expert:quantum flux", question: "x", wait_seconds: 0 })).rejects.toThrow(/anyone who knows/);
  });
});

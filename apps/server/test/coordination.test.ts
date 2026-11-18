import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAddComponent, adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { checkPath, claimWork, cleanPath, listClaims, releaseWork, touchPath } from "../src/core/coordination.js";
import { answerQuestion, askSession, getAnswer, handoffSession, listSessions, registerSession, waitForQuestions } from "../src/core/sessions.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
const as = (email: string) => ctxFor(db, { email });
const REPO = "git@github.com:acme/shop-api.git";

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "shop", name: "Shop" });
  await adminAddComponent(a, "shop", { slug: "api", kind: "backend", repo_url: REPO });
  for (const e of ["alice@example.com", "bob@example.com", "dave@example.com"]) await adminSetMember(a, "shop", e, "writer");
  await db.query("UPDATE scopes SET visibility = 'members' WHERE slug = 'shop'");
  // Two clones of one remote, written differently, and one session elsewhere.
  await registerSession(await as("alice@example.com"), { repo: REPO, client: "claude-code", client_session_id: "a1" });
  await registerSession(await as("bob@example.com"), { repo: "https://github.com/Acme/shop-api", client: "claude-code", client_session_id: "b1" });
  await registerSession(await as("dave@example.com"), { repo: REPO, name: "dave-two", client: "claude-code", client_session_id: "d1" });
});
afterAll(() => db.end());

describe("paths", () => {
  it("cleans paths and refuses ones outside the repository", () => {
    expect(cleanPath("./src//orders/")).toBe("src/orders");
    expect(cleanPath("src\\a.ts")).toBe("src/a.ts");
    expect(() => cleanPath("../etc/passwd")).toThrow(/leaves/);
    expect(() => cleanPath("src/../../x")).toThrow(/leaves/);
    expect(() => cleanPath(" ")).toThrow();
  });
});

describe("work claims", () => {
  it("warns another session about a file (or folder) someone is working on, in any clone of the repository", async () => {
    const alice = await as("alice@example.com");
    const bob = await as("bob@example.com");
    const r = await claimWork(alice, { session: "alice/shop-api", paths: ["src/refunds/"], note: "partial refunds" });
    expect(r.others_here).toEqual([]);
    // A file under the claimed folder, from Bob's differently written clone.
    const c = await checkPath(bob, { client: "claude-code", client_session_id: "b1", path: "src/refunds/handler.ts" });
    expect(c.conflicts).toHaveLength(1);
    expect(c.conflicts[0]).toMatchObject({ session: "alice/shop-api", claimed: "src/refunds", auto: false, note: "partial refunds" });
    expect(c.conflicts[0]!.text).toMatch(/alice\/shop-api .* claimed src\/refunds \(partial refunds\)/);
    // Unrelated files and the claimant itself see nothing.
    expect((await checkPath(bob, { client: "claude-code", client_session_id: "b1", path: "src/refundsX.ts" })).conflicts).toEqual([]);
    expect((await checkPath(alice, { client: "claude-code", client_session_id: "a1", path: "src/refunds/handler.ts" })).conflicts).toEqual([]);
    // Claiming something overlapping says who's there.
    const overlap = await claimWork(bob, { session: "bob/shop-api", paths: ["src"] });
    expect(overlap.others_here.map((o) => o.session)).toEqual(["alice/shop-api"]);
    expect(overlap.how).toMatch(/Coordinate/);
    await releaseWork(bob, { session: "bob/shop-api" });
  });

  it("claims edited files automatically, without shortening or downgrading a deliberate claim", async () => {
    const alice = await as("alice@example.com");
    const dave = await as("dave@example.com");
    await touchPath(dave, { client: "claude-code", client_session_id: "d1", path: "README.md" });
    const c = await checkPath(alice, { client: "claude-code", client_session_id: "a1", path: "README.md" });
    expect(c.conflicts[0]).toMatchObject({ session: "dave/dave-two", auto: true });
    expect(c.conflicts[0]!.text).toMatch(/edited README.md just now/);
    // Alice touches her own deliberately claimed folder: it stays deliberate, with its note and longer expiry.
    await touchPath(alice, { client: "claude-code", client_session_id: "a1", path: "src/refunds" });
    const row = (await db.query("SELECT auto, note, expires_at > now() + interval '60 minutes' AS long FROM work_claims w JOIN agent_sessions s ON s.id = w.session_id WHERE s.handle = 'alice/shop-api' AND path = 'src/refunds'")).rows[0];
    expect(row).toMatchObject({ auto: false, note: "partial refunds", long: true });
  });

  it("lists claims people can see, and shows them on list_sessions; outsiders see nothing", async () => {
    const bob = await as("bob@example.com");
    const claims = await listClaims(bob, { project: "shop" });
    expect(claims.claims.map((c: { path: string }) => c.path).sort()).toEqual(["README.md", "src/refunds"]);
    const sessions = await listSessions(bob);
    expect(sessions.sessions.find((s: { handle: string }) => s.handle === "alice/shop-api")!.working_on).toEqual(["src/refunds"]);
    await expect(listClaims(await as("carol@example.com"), { project: "shop" })).rejects.toThrow(/not found/);
    expect((await listClaims(await as("carol@example.com"))).claims).toEqual([]);
  });

  it("releases claims, and expired ones stop warning", async () => {
    const alice = await as("alice@example.com");
    const bob = await as("bob@example.com");
    expect((await releaseWork(alice, { session: "alice/shop-api", paths: ["src/refunds"] })).released).toBe(1);
    expect((await checkPath(bob, { client: "claude-code", client_session_id: "b1", path: "src/refunds/a.ts" })).conflicts).toEqual([]);
    await db.query("UPDATE work_claims SET expires_at = now() - interval '1 second'");
    expect((await checkPath(alice, { client: "claude-code", client_session_id: "a1", path: "README.md" })).conflicts).toEqual([]);
  });
});

describe("handoffs", () => {
  it("passes work on; accepting it moves the sender's claims to the session that took it", async () => {
    const alice = await as("alice@example.com");
    const bob = await as("bob@example.com");
    await claimWork(alice, { session: "alice/shop-api", paths: ["src/payouts", "src/payouts.test.ts"] });
    const h = await handoffSession(alice, { session: "alice/shop-api", to: "bob/shop-api", summary: "Payout retries half done", next_steps: "1. Add backoff", files: ["src/payouts/retry.ts"] });
    expect(h).toMatchObject({ status: "waiting" });
    const got = await waitForQuestions(bob, { session: "bob/shop-api", wait_seconds: 0 });
    expect(got.questions[0]).toMatchObject({ kind: "handoff" });
    expect(got.questions[0].question).toMatch(/^Handoff: Payout retries half done[\s\S]*Next steps:\n1\. Add backoff[\s\S]*- src\/payouts\/retry\.ts/);
    expect(got.how).toMatch(/handoff/);
    const accepted = await answerQuestion(bob, { session: "bob/shop-api", id: (h as { id: string }).id, answer: "Taking it: backoff next." });
    expect(accepted.status).toBe("accepted");
    const owners = (await db.query("SELECT s.handle, w.path FROM work_claims w JOIN agent_sessions s ON s.id = w.session_id WHERE w.released_at IS NULL AND w.expires_at > now() ORDER BY w.path")).rows;
    expect(owners).toEqual([
      { handle: "bob/shop-api", path: "src/payouts" },
      { handle: "bob/shop-api", path: "src/payouts.test.ts" },
    ]);
    const back = await getAnswer(alice, { session: "alice/shop-api", id: (h as { id: string }).id });
    expect(back.answer).toMatchObject({ kind: "handoff", status: "answered", answer: "Taking it: backoff next." });
  });
});

describe("asking everyone", () => {
  it("asks every online session in the project, collects each answer, and counts as one question", async () => {
    const alice = await as("alice@example.com");
    const bob = await as("bob@example.com");
    const dave = await as("dave@example.com");
    const asked = askSession(alice, { session: "alice/shop-api", to: "shop", question: "Who changed the tax rounding?", everyone: true, wait_seconds: 10 });
    const bobGot = await waitForQuestions(bob, { session: "bob/shop-api", wait_seconds: 5 });
    await answerQuestion(bob, { session: "bob/shop-api", id: bobGot.questions[0].id, answer: "Not me." });
    const first = (await asked) as { id: string; asked: string[]; answers: { answer: string }[]; status: string };
    expect(first.asked.sort()).toEqual(["bob/shop-api", "dave/dave-two"]);
    expect(first.status).toBe("answered");
    expect(first.answers.map((a) => a.answer)).toEqual(["Not me."]);
    // Dave answers later; get_answer with the group id collects it.
    const daveGot = await waitForQuestions(dave, { session: "dave/dave-two", wait_seconds: 0 });
    await answerQuestion(dave, { session: "dave/dave-two", id: daveGot.questions[0].id, answer: "I did, in #412." });
    const all = (await getAnswer(alice, { session: "alice/shop-api", id: first.id })) as { answers: { answer: string }[]; still_waiting: number };
    expect(all.answers.map((a) => a.answer).sort()).toEqual(["I did, in #412.", "Not me."]);
    expect(all.still_waiting).toBe(0);
    const n = (await db.query("SELECT count(DISTINCT coalesce(group_id, id))::int AS n FROM session_questions WHERE group_id = $1", [first.id])).rows[0].n;
    expect(n).toBe(1);
  });

  it("falls back to an ordinary project question when nobody is online, and refuses a single session", async () => {
    const alice = await as("alice@example.com");
    await db.query("UPDATE agent_sessions SET last_seen_at = now() - interval '1 hour' WHERE handle <> 'alice/shop-api'");
    const r = (await askSession(alice, { session: "alice/shop-api", to: "shop", question: "Anyone?", everyone: true, wait_seconds: 0 })) as { status: string; to: string };
    expect(r).toMatchObject({ status: "waiting", to: "shop" });
    await expect(askSession(alice, { session: "alice/shop-api", to: "bob/shop-api", question: "x", everyone: true, wait_seconds: 0 })).rejects.toThrow(/not one session/);
  });
});

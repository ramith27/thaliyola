import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAddComponent, adminCreateProject, adminSetMember } from "../src/core/admin.js";
import {
  answerQuestion,
  askSession,
  cancelQuestion,
  declineQuestion,
  getAnswer,
  hookCheck,
  listQuestions,
  listSessions,
  registerSession,
  waitForQuestions,
} from "../src/core/sessions.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
const as = (email: string) => ctxFor(db, { email });

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "billing", name: "Billing" });
  await adminAddComponent(a, "billing", { slug: "api", kind: "backend", repo_url: "git@github.com:acme/billing-api.git" });
  await adminAddComponent(a, "billing", { slug: "web", kind: "frontend", repo_url: "https://github.com/acme/billing-web" });
  for (const e of ["alice@example.com", "bob@example.com", "dave@example.com"]) await adminSetMember(a, "billing", e, "writer");
  await db.query("UPDATE scopes SET visibility = 'members' WHERE slug = 'billing'");
});
afterAll(() => db.end());

describe("registering", () => {
  it("names a session after its person, project and repository, and keeps the handle on re-registering", async () => {
    const r = await registerSession(await as("alice@example.com"), { repo: "https://github.com/acme/billing-api.git", description: "Working on refunds", client: "claude-code", client_session_id: "cc-alice-1" });
    expect(r).toMatchObject({ session: "alice/billing-api", project: "billing", repository: "api", listening: false });
    const again = await registerSession(await as("alice@example.com"), { client: "claude-code", client_session_id: "cc-alice-1", listening: true });
    expect(again).toMatchObject({ session: "alice/billing-api", listening: true });
    expect((await registerSession(await as("bob@example.com"), { name: "web", repo: "git@github.com:acme/billing-web.git" })).session).toBe("bob/web");
    expect((await registerSession(await as("dave@example.com"), { project: "billing", component: "web" })).session).toBe("dave/billing-web");
    // Bob's second session, private; updating it by handle keeps it private.
    expect((await registerSession(await as("bob@example.com"), { name: "scratch", visibility: "private" })).session).toBe("bob/scratch");
    expect(await registerSession(await as("bob@example.com"), { session: "bob/scratch", listening: true })).toMatchObject({ visibility: "private", listening: true });
    await expect(registerSession(await as("bob@example.com"), { session: "alice/billing-api" })).rejects.toThrow(/not found/);
  });

  it("lists the sessions you can ask: your own, and teammates' in projects you can read", async () => {
    const forAlice = await listSessions(await as("alice@example.com"));
    expect(forAlice.sessions.map((s: { handle: string }) => s.handle).sort()).toEqual(["alice/billing-api", "bob/web", "dave/billing-web"]);
    const forCarol = await listSessions(await as("carol@example.com"));
    expect(forCarol.sessions).toEqual([]);
  });
});

describe("asking and answering", () => {
  it("returns the answer inside the asker's wait when a listener answers", async () => {
    const alice = await as("alice@example.com");
    const bob = await as("bob@example.com");
    const started = Date.now();
    const listener = (async () => {
      const got = await waitForQuestions(bob, { session: "bob/web", wait_seconds: 10 });
      expect(got.questions).toHaveLength(1);
      const q = got.questions[0] as { id: string; from_session: string; addressed_to: string; question: string };
      expect(q).toMatchObject({ from_session: "alice/billing-api", addressed_to: "you", question: "Which endpoint does the refund button call?" });
      await answerQuestion(bob, { session: "bob/web", id: q.id, answer: "POST /refunds from src/api/refunds.ts#L12, with the order id and amount in cents." });
    })();
    // The listener is already waiting when the question arrives.
    await new Promise((r) => setTimeout(r, 100));
    const r = await askSession(alice, { session: "alice/billing-api", to: "bob/web", question: "Which endpoint does the refund button call?", wait_seconds: 10 });
    await listener;
    expect(r).toMatchObject({ status: "answered", answered_by_session: "bob/web", answer: expect.stringContaining("POST /refunds") });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("gives a ticket when the answer isn't ready, and hands the answer over later", async () => {
    const alice = await as("alice@example.com");
    const dave = await as("dave@example.com");
    const t = await askSession(alice, { session: "alice/billing-api", to: "dave/billing-web", question: "Is the currency formatter shared?", wait_seconds: 0 });
    expect(t).toMatchObject({ status: "waiting", to: "dave/billing-web", to_online: true });
    const { questions } = await waitForQuestions(dave, { session: "dave/billing-web", wait_seconds: 0 });
    await answerQuestion(dave, { session: "dave/billing-web", id: (questions[0] as { id: string }).id, answer: "Yes, src/lib/money.ts" });
    const got = await getAnswer(alice, { session: "alice/billing-api", id: (t as { id: string }).id });
    expect(got.answer).toMatchObject({ status: "answered", answer: "Yes, src/lib/money.ts" });
    // Delivered once: it doesn't come back as a new answer.
    expect((await getAnswer(alice, { session: "alice/billing-api" })).other_answers).toEqual([]);
  });

  it("delivers answers to earlier questions the asker hasn't seen (the hook path)", async () => {
    const alice = await as("alice@example.com");
    const t = await askSession(alice, { session: "alice/billing-api", to: "bob@example.com", question: "Who owns the invoices job?", wait_seconds: 0 });
    const got = await hookCheck(await as("bob@example.com"), { session: "bob/web", claim: true });
    expect(got.questions.map((q: { id: string }) => q.id)).toContain((t as { id: string }).id);
    await answerQuestion(await as("bob@example.com"), { session: "bob/web", id: (t as { id: string }).id, answer: "The platform team" });
    const inbox = await hookCheck(alice, { client: "claude-code", client_session_id: "cc-alice-1", answers: true });
    expect(inbox.answers.map((a) => a.answer)).toEqual(["The platform team"]);
    expect((await hookCheck(alice, { client: "claude-code", client_session_id: "cc-alice-1", answers: true })).answers).toEqual([]);
  });

  it("hands a project-addressed question to one session only", async () => {
    const alice = await as("alice@example.com");
    await askSession(alice, { session: "alice/billing-api", to: "billing/web", question: "Where are feature flags read?", wait_seconds: 0 });
    const first = await waitForQuestions(await as("bob@example.com"), { session: "bob/web", wait_seconds: 0 });
    const second = await waitForQuestions(await as("dave@example.com"), { session: "dave/billing-web", wait_seconds: 0 });
    expect(first.questions.length + second.questions.length).toBe(1);
    // The private session never sees project questions.
    expect((await waitForQuestions(await as("bob@example.com"), { session: "bob/scratch", wait_seconds: 0 })).questions).toEqual([]);
    const taken = (first.questions[0] ?? second.questions[0]) as { id: string };
    const by = first.questions.length ? "bob" : "dave";
    const other = by === "bob" ? { who: "dave@example.com", s: "dave/billing-web" } : { who: "bob@example.com", s: "bob/web" };
    await expect(answerQuestion(await as(other.who), { session: other.s, id: taken.id, answer: "x" })).rejects.toThrow(/another session/);
    await declineQuestion(await as(`${by}@example.com`), { session: by === "bob" ? "bob/web" : "dave/billing-web", id: taken.id, reason: "Ask the platform channel" });
    const r = await getAnswer(alice, { id: taken.id });
    expect(r.answer).toMatchObject({ status: "declined", answer: "Ask the platform channel" });
  });

  it("keeps outsiders and private sessions out, limits the rate, and redacts", async () => {
    const carol = await as("carol@example.com");
    await expect(askSession(carol, { to: "bob/web", question: "hi", wait_seconds: 0 })).rejects.toThrow(/not found/);
    await expect(askSession(carol, { to: "billing", question: "hi", wait_seconds: 0 })).rejects.toThrow(/not found/);
    await expect(askSession(await as("alice@example.com"), { to: "bob/scratch", question: "hi", wait_seconds: 0 })).rejects.toThrow(/not found/);
    // Bob's own sessions can reach his private one.
    const own = await askSession(await as("bob@example.com"), { session: "bob/web", to: "bob/scratch", question: "Did the migration finish? token sk_live_abcdefghijklmnop1234", wait_seconds: 0 });
    expect(own).toMatchObject({ status: "waiting" });
    const q = (await db.query("SELECT question FROM session_questions WHERE id = $1", [(own as { id: string }).id])).rows[0];
    expect(q.question).not.toContain("sk_live_abcdefghijklmnop1234");
    await cancelQuestion(await as("bob@example.com"), (own as { id: string }).id);

    const dave = await as("dave@example.com");
    await db.query(
      `INSERT INTO session_questions (from_session_id, from_user_id, to_user_id, question, expires_at)
       SELECT s.id, s.user_id, s.user_id, 'q', now() + interval '1 hour' FROM agent_sessions s, generate_series(1, 30) WHERE s.handle = 'dave/billing-web'`,
    );
    await expect(askSession(dave, { session: "dave/billing-web", to: "bob/web", question: "one more", wait_seconds: 0 })).rejects.toThrow(/30 questions/);
  });

  it("expires unanswered questions and tells the asker", async () => {
    const alice = await as("alice@example.com");
    const t = (await askSession(alice, { session: "alice/billing-api", to: "dave/billing-web", question: "Still there?", wait_seconds: 0, expires_minutes: 1 })) as { id: string };
    await db.query("UPDATE session_questions SET expires_at = now() - interval '1 second' WHERE id = $1", [t.id]);
    expect((await getAnswer(alice, { id: t.id })).answer).toMatchObject({ status: "expired" });
  });

  it("lets a person answer on the web, and saves an answer as a finding", async () => {
    const alice = await as("alice@example.com");
    const t = (await askSession(alice, { session: "alice/billing-api", to: "bob/web", question: "Why do refunds over 10k fail?", wait_seconds: 0 })) as { id: string };
    await expect(answerQuestion(await as("carol@example.com"), { id: t.id, answer: "no idea" })).rejects.toThrow();
    const r = await answerQuestion(await as("bob@example.com"), { id: t.id, answer: "The payment provider caps single refunds at 10,000; split them.", save_as: "known_issue", save_to: "billing" });
    expect(r).toMatchObject({ status: "answered", saved: { status: "pending_review" } });
    const list = await listQuestions(await as("bob@example.com"), { status: "closed" });
    expect(list.questions.find((q: { id: string }) => q.id === t.id)).toMatchObject({ answered_by: "bob@example.com", for_me: true, saved_item_id: expect.any(String) });
  });
});

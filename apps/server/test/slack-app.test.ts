import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { insertArticle } from "../src/core/bootstrap.js";
import { answerQuestion, declineQuestion, registerSession, waitForQuestions } from "../src/core/sessions.js";
import { receiveSlackCommand, verifySlack } from "../src/core/slack-app.js";
import type { Settings } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
const SECRET = "slack-signing-secret";
const calls: { url: string; body: any }[] = [];
const users: Record<string, string> = { U_ALICE: "alice@example.com", U_BOB: "bob@example.com", U_STRANGER: "stranger@example.com" };
const fakeFetch = (async (url: string, init?: { body?: string }) => {
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push({ url: String(url), body });
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (String(url).endsWith("/users.info")) return json(users[body.user] ? { ok: true, user: { profile: { email: users[body.user] } } } : { ok: false, error: "user_not_found" });
  if (String(url).endsWith("/chat.postMessage")) return json(body.channel === "C_NOBOT" ? { ok: false, error: "not_in_channel" } : { ok: true, ts: "1700000000.000100", channel: body.channel });
  return json({ ok: true });
}) as unknown as typeof fetch;
const settings: Settings = { ...TEST_SETTINGS, publicUrl: "https://kb.example.com", slackApp: { signingSecret: SECRET, botToken: "xoxb-1", apiUrl: "https://slack.test/api", fetch: fakeFetch } };
const as = async (email: string) => ({ ...(await ctxFor(db, { email })), settings });

function command(text: string, extra: Record<string, string> = {}, opts: { secret?: string; ts?: number } = {}) {
  const raw = Buffer.from(new URLSearchParams({ command: "/thaliyola", text, user_id: "U_ALICE", channel_id: "C_TEAM", response_url: "https://slack.test/respond/1", ...extra }).toString());
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", opts.secret ?? SECRET).update(`v0:${ts}:${raw.toString()}`).digest("hex")}`;
  return receiveSlackCommand(db, settings, { "x-slack-request-timestamp": ts, "x-slack-signature": sig }, raw);
}

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "shop", name: "Shop", components: [{ slug: "api", kind: "backend", repo_url: "https://github.com/acme/shop-api" }] });
  await adminSetMember(a, "shop", "alice@example.com", "writer");
  await adminSetMember(a, "shop", "bob@example.com", "writer");
  await as("alice@example.com");
  await as("bob@example.com");
  const scope = (await db.query("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0].id;
  await insertArticle(db, { scopeId: scope, type: "runbook", title: "Refund stuck in pending", body: "## Trigger\nA refund stays pending for more than an hour.\n\n## Fix\nRe-run the settlement job." });
});
afterAll(() => db.end());

describe("verifying Slack", () => {
  it("accepts Slack's signature and refuses wrong or old ones", async () => {
    const raw = Buffer.from("text=hi");
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:text=hi`).digest("hex")}`;
    expect(verifySlack(SECRET, { "x-slack-request-timestamp": ts, "x-slack-signature": sig }, raw)).toBe(true);
    expect(verifySlack(SECRET, { "x-slack-request-timestamp": ts, "x-slack-signature": "v0=00" }, raw)).toBe(false);
    expect(verifySlack(SECRET, { "x-slack-request-timestamp": String(Number(ts) - 600), "x-slack-signature": sig }, raw)).toBe(false);
    expect((await command("help", {}, { secret: "wrong" })).status).toBe(401);
  });

  it("answers help without doing anything", async () => {
    const r = await command("");
    expect(r.body).toMatchObject({ response_type: "ephemeral", text: expect.stringMatching(/\/thaliyola search/) });
    expect(r.work).toBeUndefined();
  });
});

describe("commands", () => {
  it("searches as the person whose Slack email matches, and caches who they are", async () => {
    calls.length = 0;
    const r = await command("search refund pending");
    await r.work;
    const reply = calls.find((c) => c.url === "https://slack.test/respond/1")!;
    expect(reply.body.text).toMatch(/Refund stuck in pending/);
    expect(reply.body.text).toMatch(/https:\/\/kb\.example\.com\/#\/article\//);
    expect((await db.query("SELECT slack_user_id FROM users WHERE email = 'alice@example.com'")).rows[0].slack_user_id).toBe("U_ALICE");
  });

  it("refuses people without a Thaliyola account", async () => {
    calls.length = 0;
    await (await command("search anything", { user_id: "U_STRANGER" })).work;
    expect(calls.find((c) => c.url.includes("/respond/"))!.body.text).toMatch(/no Thaliyola account/);
  });

  it("asks a session and posts the answer in the thread under the question", async () => {
    await registerSession(await as("bob@example.com"), { repo: "https://github.com/acme/shop-api", client: "claude-code", client_session_id: "b1" });
    calls.length = 0;
    await (await command("ask bob/shop-api Why do refunds stay pending?")).work;
    const posted = calls.find((c) => c.url.endsWith("/chat.postMessage"))!;
    expect(posted.body).toMatchObject({ channel: "C_TEAM", text: expect.stringMatching(/<@U_ALICE> asked bob\/shop-api: Why do refunds stay pending\?/) });
    const bob = await as("bob@example.com");
    const got = await waitForQuestions(bob, { session: "bob/shop-api", wait_seconds: 0 });
    calls.length = 0;
    await answerQuestion(bob, { session: "bob/shop-api", id: got.questions[0].id, answer: "The settlement job only runs hourly." });
    expect(calls.find((c) => c.url.endsWith("/chat.postMessage"))!.body).toMatchObject({ channel: "C_TEAM", thread_ts: "1700000000.000100", text: expect.stringMatching(/bob\/shop-api\* answered:\nThe settlement job only runs hourly/) });
  });

  it("falls back to the command's response URL when the app isn't in the channel, declines included", async () => {
    calls.length = 0;
    await (await command("ask bob/shop-api Anything else?", { channel_id: "C_NOBOT" })).work;
    expect(calls.some((c) => c.url.includes("/respond/") && /I'll post the answer here/.test(c.body.text))).toBe(true);
    const bob = await as("bob@example.com");
    const got = await waitForQuestions(bob, { session: "bob/shop-api", wait_seconds: 0 });
    calls.length = 0;
    await declineQuestion(bob, { session: "bob/shop-api", id: got.questions[0].id, reason: "Ask the payments team" });
    expect(calls.find((c) => c.url.includes("/respond/"))!.body).toMatchObject({ response_type: "in_channel", text: expect.stringMatching(/couldn't answer: Ask the payments team/) });
  });

  it("declares an incident in a named project, as the person", async () => {
    calls.length = 0;
    await (await command("incident Checkout returns 502 in shop sev2")).work;
    const msg = calls.find((c) => c.url.includes("/respond/"))!.body;
    expect(msg).toMatchObject({ response_type: "in_channel", text: expect.stringMatching(/SEV2 incident declared in shop by <@U_ALICE>/) });
    const row = (await db.query("SELECT title, severity, declared_via FROM incidents")).rows[0];
    expect(row).toEqual({ title: "Checkout returns 502", severity: "sev2", declared_via: "slack" });
    calls.length = 0;
    await (await command("incident Something")).work;
    expect(calls.find((c) => c.url.includes("/respond/"))!.body.text).toMatch(/Which project\?/);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { addIncidentNote, declareIncident, getIncident, listIncidents, updateIncident } from "../src/core/incidents.js";
import { answerQuestion, askSession, hookCheck, registerSession, waitForQuestions } from "../src/core/sessions.js";
import { createSource, receiveWebhook } from "../src/core/sources.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
const settings = { ...TEST_SETTINGS, publicUrl: "https://kb.example.com", sources: { allowPrivate: false, ...TEST_SETTINGS.sources, enabled: true } };
const as = async (email: string) => ({ ...(await ctxFor(db, { email })), settings });
const hook = (url: string) => /\/hooks\/sources\/([0-9a-f-]{36})\/([\w-]+)$/.exec(url)!.slice(1) as [string, string];
let incidentId: string;

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "shop", name: "Shop", visibility: "members", components: [{ slug: "api", kind: "backend", repo_url: "https://github.com/acme/shop-api" }] });
  await adminSetMember(a, "shop", "alice@example.com", "writer");
  await adminSetMember(a, "shop", "bob@example.com", "writer");
  await adminSetMember(a, "shop", "rita@example.com", "reader");
});
afterAll(() => db.end());

describe("declaring", () => {
  it("lets contributors declare one, tells the project's people, and starts the timeline", async () => {
    await expect(declareIncident(await as("rita@example.com"), { project: "shop", title: "Checkout down" })).rejects.toThrow(/Propose/);
    await expect(declareIncident(await as("outsider@example.com"), { project: "shop", title: "x" })).rejects.toThrow(/not found/);
    const r = await declareIncident(await as("alice@example.com"), { project: "shop", title: "Checkout returns 502", severity: "sev2", summary: "Since 10:05, all card payments" });
    incidentId = r.id;
    expect(r).toMatchObject({ project: "shop", severity: "sev2", status: "open" });
    const told = (await db.query("SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'incident' ORDER BY 1")).rows.map((x) => x.email);
    expect(told).toEqual(expect.arrayContaining(["bob@example.com", "rita@example.com"]));
    const i = await getIncident(await as("rita@example.com"), incidentId);
    expect(i).toMatchObject({ title: "Checkout returns 502", commander: "alice@example.com" });
    expect(i.events[0]).toMatchObject({ kind: "declared" });
  });

  it("says when the project already has one open", async () => {
    const r = await declareIncident(await as("bob@example.com"), { project: "shop", title: "Payments slow" });
    expect(r.other_open?.map((x) => x.title)).toEqual(["Checkout returns 502"]);
    await updateIncident(await as("bob@example.com"), { id: r.id, status: "resolved" });
  });
});

describe("the timeline fills itself", () => {
  it("adds notes, sessions' questions and answers, and merged pull requests", async () => {
    await addIncidentNote(await as("bob@example.com"), { id: incidentId, text: "Rolled back deploy 4812, no change" });
    const alice = await as("alice@example.com");
    const bob = await as("bob@example.com");
    await registerSession(alice, { repo: "https://github.com/acme/shop-api", client: "claude-code", client_session_id: "a1" });
    await registerSession(bob, { repo: "https://github.com/acme/shop-api", name: "b", client: "claude-code", client_session_id: "b1" });
    const q = (await askSession(alice, { session: "alice/shop-api", to: "bob/b", question: "Did the payment client config change today?", wait_seconds: 0 })) as { id: string };
    await waitForQuestions(bob, { session: "bob/b", wait_seconds: 0 });
    await answerQuestion(bob, { session: "bob/b", id: q.id, answer: "Yes, the timeout went from 30s to 3s in #88." });
    const src = (await createSource(await as("admin@example.com"), { kind: "github_prs", name: "PRs", scope: "shop", config: {} })) as { webhook: { url: string } };
    const [sid, token] = hook(src.webhook.url);
    const merged = { action: "closed", repository: { full_name: "acme/shop-api" }, pull_request: { number: 91, title: "Restore payment timeout", merged: true, merged_at: "2026-11-21T10:40:00Z", html_url: "https://github.com/acme/shop-api/pull/91", base: { ref: "main" } } };
    await receiveWebhook(db, sid, token, { "x-github-event": "pull_request" }, merged, settings);
    const kinds = (await getIncident(alice, incidentId)).events.map((e: { kind: string; text: string }) => `${e.kind}: ${e.text}`);
    expect(kinds).toEqual(
      expect.arrayContaining([
        "note: Rolled back deploy 4812, no change",
        "question: Asked bob/b: Did the payment client config change today?",
        "answer: bob/b answered: Did the payment client config change today?",
        "pr: Merged: Restore payment timeout (acme/shop-api#91)",
      ]),
    );
    // Only the question's first line: never the answer's text.
    expect(kinds.join("\n")).not.toMatch(/30s to 3s/);
  });

  it("tells the project's sessions through the plugin hook", async () => {
    const r = await hookCheck(await as("alice@example.com"), { client: "claude-code", client_session_id: "a1" });
    expect(r.incidents?.map((i) => i.title)).toEqual(["Checkout returns 502"]);
  });
});

describe("Sentry", () => {
  it("opens an incident from an alert, joins later alerts for the same issue, and logs the issue resolving", async () => {
    const src = (await createSource(await as("admin@example.com"), { kind: "sentry_issues", name: "Sentry", scope: "shop", config: { incidents: "on" } })) as { webhook: { url: string } };
    const [sid, token] = hook(src.webhook.url);
    const alert = (eventId: string) => ({ action: "triggered", data: { event: { event_id: eventId, issue_id: "777", title: "DatabaseError: too many connections", web_url: "https://sentry.io/i/777" }, triggered_rule: "DB errors spike" } });
    await updateIncident(await as("alice@example.com"), { id: incidentId, status: "resolved" });
    const first = await receiveWebhook(db, sid, token, { "sentry-hook-resource": "event_alert" }, alert("e1"), settings);
    expect(first).toMatchObject({ status: 200, result: "declared" });
    const again = await receiveWebhook(db, sid, token, { "sentry-hook-resource": "event_alert" }, alert("e2"), settings);
    expect(again).toMatchObject({ result: "added" });
    const open = await listIncidents(await as("alice@example.com"), { project: "shop", status: "open" });
    expect(open.incidents.map((i: { title: string; declared_via: string }) => [i.title, i.declared_via])).toEqual([["DatabaseError: too many connections", "sentry"]]);
    const resolved = { action: "resolved", data: { issue: { id: "777", shortId: "SHOP-1", title: "DatabaseError: too many connections", project: { slug: "shop-api" }, web_url: "https://sentry.io/i/777" } } };
    await receiveWebhook(db, sid, token, { "sentry-hook-resource": "issue" }, resolved, settings);
    const id = open.incidents[0].id as string;
    const events = (await getIncident(await as("alice@example.com"), id)).events.map((e: { kind: string }) => e.kind);
    expect(events.filter((k: string) => k === "sentry")).toHaveLength(3);
  });

  it("ignores alerts when the source doesn't open incidents", async () => {
    const src = (await createSource(await as("admin@example.com"), { kind: "sentry_issues", name: "Sentry quiet", scope: "shop", config: {} })) as { webhook: { url: string } };
    const [sid, token] = hook(src.webhook.url);
    const r = await receiveWebhook(db, sid, token, { "sentry-hook-resource": "metric_alert" }, { action: "critical", data: { metric_alert: { id: "5" }, description_title: "p95 latency" } }, settings);
    expect(r).toMatchObject({ status: 202, result: "ignored" });
  });
});

describe("resolving", () => {
  it("drafts a root-cause finding from the timeline, once, for review", async () => {
    const i = (await listIncidents(await as("alice@example.com"), { project: "shop" })).incidents.find((x: { title: string }) => x.title === "Checkout returns 502")!;
    const full = await getIncident(await as("alice@example.com"), i.id);
    expect(full.status).toBe("resolved");
    expect(full.rca_finding_id).toBeTruthy();
    const f = (await db.query("SELECT title, type, symptoms, status FROM findings WHERE id = $1", [full.rca_finding_id])).rows[0];
    expect(f).toMatchObject({ title: "Incident: Checkout returns 502", type: "rca" });
    expect(f.symptoms).toMatch(/SEV2 incident[\s\S]*Timeline:[\s\S]*Rolled back deploy 4812/);
  });
});

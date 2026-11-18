import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject } from "../src/core/admin.js";
import { createSource, listInbox, receiveWebhook, rotateWebhook, runDueSources, updateSource } from "../src/core/sources.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
const settings: typeof TEST_SETTINGS = { ...TEST_SETTINGS, publicUrl: "https://kb.example.com", sources: { allowPrivate: false, ...TEST_SETTINGS.sources, enabled: true } };
const admin = async () => ({ ...(await ctxFor(db, { email: "admin@example.com" })), settings });
const split = (url: string) => {
  const m = /\/hooks\/sources\/([0-9a-f-]{36})\/([\w-]+)$/.exec(url)!;
  return { id: m[1]!, token: m[2]! };
};
const pr = (over: Record<string, unknown> = {}) => ({
  action: "closed",
  repository: { full_name: "acme/shop-api" },
  pull_request: {
    number: 412,
    title: "Fix double charge on retry",
    body: "Root cause: the retry reused a stale idempotency key.\n\nFix: derive it from the order id.",
    html_url: "https://github.com/acme/shop-api/pull/412",
    merged: true,
    merged_at: "2026-11-18T10:00:00Z",
    merged_by: { login: "alice" },
    user: { login: "bob" },
    base: { ref: "main" },
    labels: [{ name: "bug" }],
    changed_files: 3,
    additions: 20,
    deletions: 4,
    ...over,
  },
});

beforeAll(async () => {
  ({ db } = await freshDb());
  await adminCreateProject(await admin(), { slug: "shop", name: "Shop" });
});
afterAll(() => db.end());

describe("GitHub merged pull requests", () => {
  let hook: { id: string; token: string };

  it("gives a push source a secret webhook URL once, and keeps only its hash", async () => {
    const s = (await createSource(await admin(), { kind: "github_prs", name: "Shop PRs", scope: "shop", config: { branch: "main" } })) as { id: string; webhook: { url: string; how: string } };
    expect(s.webhook.url).toMatch(/^https:\/\/kb\.example\.com\/hooks\/sources\/[0-9a-f-]{36}\/[\w-]{32}$/);
    expect(s.webhook.how).toMatch(/Pull requests/);
    hook = split(s.webhook.url);
    const state = (await db.query("SELECT state, next_run_at = 'infinity' AS never FROM sources WHERE id = $1", [s.id])).rows[0];
    expect(JSON.stringify(state.state)).not.toContain(hook.token);
    expect(state.never).toBe(true);
  });

  it("puts a merged pull request in the inbox, and ignores pings, unmerged ones and other branches", async () => {
    expect(await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "ping" }, { zen: "hi" })).toMatchObject({ status: 202, result: "ignored" });
    expect(await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "pull_request" }, pr({ merged: false }))).toMatchObject({ status: 202 });
    expect(await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "pull_request" }, pr({ base: { ref: "develop" } }))).toMatchObject({ status: 202 });
    expect(await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "pull_request" }, pr())).toMatchObject({ status: 200, result: "added" });
    // The same delivery again changes nothing.
    expect(await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "pull_request" }, pr())).toMatchObject({ status: 200, result: "unchanged" });
    const inbox = await listInbox(await admin(), { scope: "shop" });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ title: "Merged: Fix double charge on retry (acme/shop-api#412)", url: "https://github.com/acme/shop-api/pull/412", author: "bob" });
    const body = (await db.query("SELECT body FROM inbox_items")).rows[0].body;
    expect(body).toMatch(/Repository: acme\/shop-api\nMerged into main by alice/);
    expect(body).toMatch(/Root cause: the retry reused a stale idempotency key/);
  });

  it("refuses a wrong secret or unknown source the same way, and a paused source takes nothing", async () => {
    expect((await receiveWebhook(db, hook.id, "wrong", { "x-github-event": "pull_request" }, pr())).status).toBe(404);
    expect((await receiveWebhook(db, "00000000-0000-0000-0000-000000000000", hook.token, {}, pr())).status).toBe(404);
    expect((await receiveWebhook(db, "not-a-uuid", hook.token, {}, pr())).status).toBe(404);
    await updateSource(await admin(), hook.id, { enabled: false });
    expect(await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "pull_request" }, pr({ number: 413 }))).toMatchObject({ status: 202, result: "source is paused" });
    await updateSource(await admin(), hook.id, { enabled: true });
  });

  it("keeps the secret when the filters change; replacing the URL stops the old one", async () => {
    await updateSource(await admin(), hook.id, { config: { branch: "main", repos: "acme/shop-api, acme/other" } });
    expect((await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "pull_request" }, pr({ number: 414 }))).status).toBe(200);
    expect((await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "pull_request" }, { ...pr({ number: 415 }), repository: { full_name: "acme/elsewhere" } })).status).toBe(202);
    const fresh = split((await rotateWebhook(await admin(), hook.id)).webhook.url);
    expect((await receiveWebhook(db, hook.id, hook.token, { "x-github-event": "pull_request" }, pr({ number: 416 }))).status).toBe(404);
    expect((await receiveWebhook(db, fresh.id, fresh.token, { "x-github-event": "pull_request" }, pr({ number: 416 }))).status).toBe(200);
  });

  it("is never fetched on a schedule", async () => {
    await db.query("UPDATE sources SET next_run_at = now() - interval '1 minute'");
    expect(await runDueSources(db, settings, () => {})).toBe(0);
  });
});

describe("Sentry resolved issues", () => {
  it("puts a resolved issue in the inbox with where, how often and what resolved it", async () => {
    const s = (await createSource(await admin(), { kind: "sentry_issues", name: "Sentry", scope: "shop", config: { projects: "shop-api" } })) as { webhook: { url: string } };
    const h = split(s.webhook.url);
    const event = (action: string, project = "shop-api") => ({
      action,
      actor: { name: "Alice" },
      data: {
        issue: {
          id: "9001",
          shortId: "SHOP-API-3F",
          title: "TypeError: Cannot read properties of undefined (reading 'total')",
          culprit: "src/checkout/summary.ts in renderTotal",
          web_url: "https://sentry.io/organizations/acme/issues/9001/",
          project: { slug: project },
          metadata: { type: "TypeError", value: "Cannot read properties of undefined" },
          count: "1520",
          userCount: 87,
          firstSeen: "2026-11-01T00:00:00Z",
          lastSeen: "2026-11-17T00:00:00Z",
          statusDetails: { inRelease: "shop-api@2.4.1" },
        },
      },
    });
    expect((await receiveWebhook(db, h.id, h.token, { "sentry-hook-resource": "issue" }, event("created"))).status).toBe(202);
    expect((await receiveWebhook(db, h.id, h.token, { "sentry-hook-resource": "issue" }, event("resolved", "other"))).status).toBe(202);
    expect(await receiveWebhook(db, h.id, h.token, { "sentry-hook-resource": "issue" }, event("resolved"))).toMatchObject({ status: 200, result: "added" });
    const item = (await db.query("SELECT title, url, body FROM inbox_items WHERE external_id = 'sentry:9001'")).rows[0];
    expect(item.title).toBe("Resolved: SHOP-API-3F TypeError: Cannot read properties of undefined (reading 'total')");
    expect(item.body).toMatch(/Where: src\/checkout\/summary\.ts in renderTotal[\s\S]*1520 events, 87 users[\s\S]*Resolved in release shop-api@2\.4\.1[\s\S]*Resolved by Alice/);
  });
});

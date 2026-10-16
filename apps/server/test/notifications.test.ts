import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { adminSetMember } from "../src/core/admin.js";
import { editArticle } from "../src/core/direct.js";
import { markStale } from "../src/core/freshness.js";
import { getArticle } from "../src/core/items.js";
import { flushDeliveries, outbox, slackOutbox } from "../src/core/notify.js";
import { approveRevision, rejectRevision } from "../src/core/review.js";
import { proposeArticleEdit, proposeFinding } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let server: Server;
let base: string;
let settings: typeof TEST_SETTINGS;

const notes = async (email: string) =>
  (await db.query("SELECT n.kind, n.title, n.link FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = $1 ORDER BY n.created_at", [email])).rows;

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator("w=watcher@example.com,m=member@example.com"), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  settings = { ...TEST_SETTINGS, mailTransport: "json", publicUrl: base, slackWebhookUrl: "test" };
  // Restart with notification delivery configured and the real public URL.
  await new Promise((r) => server.close(r));
  server = createApp({ db, authenticate: devAuthenticator("w=watcher@example.com,m=member@example.com"), settings }).listen(Number(new URL(base).port));
  await new Promise((r) => server.once("listening", r));
  await ctxFor(db, { email: "admin@example.com" });
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});
beforeEach(async () => {
  await flushDeliveries();
  outbox.length = 0;
  slackOutbox.length = 0;
});

const ctx = (email: string, extra = {}) => ctxFor(db, { email, settings, ...extra });

describe("notifications", () => {
  it("tells reviewers about a proposal, by email with a one-click approve link, and posts to Slack", async () => {
    const res = await proposeFinding(await ctx("author@example.com", { project: "order-service" }), {
      type: "rca",
      title: "Refund webhook processed twice",
      symptoms: "Duplicate refunds",
      root_cause: "Missing idempotency",
      force_new: true,
    });
    await flushDeliveries();
    const admin = await notes("admin@example.com");
    expect(admin).toEqual([expect.objectContaining({ kind: "review", title: "Review: New rca: Refund webhook processed twice" })]);
    expect(await notes("author@example.com")).toEqual([]);
    const mail = outbox.find((m) => m.to === "admin@example.com")!;
    expect(mail.subject).toBe("Review: New rca: Refund webhook processed twice");
    expect(mail.html).toMatch(new RegExp(`${base}/actions/[\\w-]+`));
    expect(slackOutbox).toEqual([expect.objectContaining({ text: expect.stringContaining("Refund webhook processed twice") })]);
    expect(res.status).toBe("pending_review");
  });

  it("approves from the email link only after confirming, and only once", async () => {
    const res = await proposeFinding(await ctx("author2@example.com", { project: "order-service" }), {
      type: "known_issue",
      title: "Export button greyed out",
      symptoms: "Cannot export",
      root_cause: "Feature flag",
      force_new: true,
    });
    await flushDeliveries();
    const link = /href="([^"]+\/actions\/[\w-]+)"/.exec(outbox.find((m) => m.to === "admin@example.com")!.html)![1]!;
    const confirm = await fetch(link);
    expect(await confirm.text()).toContain("Approve this change?");
    expect((await db.query("SELECT state FROM revisions WHERE id = $1", [res.status === "pending_review" ? res.revision_id : ""])).rows[0].state).toBe("pending");
    const approve = await fetch(link, { method: "POST", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect(await approve.text()).toContain("Approved");
    expect((await db.query("SELECT state FROM revisions WHERE id = $1", [res.status === "pending_review" ? res.revision_id : ""])).rows[0].state).toBe("approved");
    const again = await fetch(link, { method: "POST", headers: { origin: base, "content-type": "application/x-www-form-urlencoded" }, body: "" });
    expect(await again.text()).toContain("expired or was already used");
    const evil = await fetch(link.replace(/actions\/.*/, "actions/forged-token"));
    expect(await evil.text()).toContain("expired");
  });

  it("tells the author about decisions, and watchers about approved changes", async () => {
    // The watcher watches the runbook.
    expect((await fetch(`${base}/api/watches/${ids.runbook}`, { method: "PUT", headers: { authorization: "Bearer w" } }).then((r) => r.json())).watching).toBe(true);
    const author = await ctx("editor@example.com");
    const runbook = await getArticle(author, ids.runbook);
    const edit = await proposeArticleEdit(author, { id: ids.runbook, version: runbook.version, section: "Fix", text: "Back off with jitter.", summary: "Runbook: add jitter" });
    await approveRevision(await ctx("admin@example.com"), edit.revision_id);
    await flushDeliveries();
    expect(await notes("editor@example.com")).toEqual([expect.objectContaining({ kind: "decided", title: "Approved: Runbook: add jitter" })]);
    expect(await notes("watcher@example.com")).toEqual([expect.objectContaining({ kind: "watch", title: "Changed: Runbook: add jitter" })]);

    const bad = await proposeArticleEdit(author, { id: ids.runbook, version: runbook.version + 1, section: "Fix", text: "Restart everything.", summary: "Runbook: restart" });
    await rejectRevision(await ctx("admin@example.com"), bad.revision_id, "Not a fix");
    await flushDeliveries();
    expect((await notes("editor@example.com")).at(-1)).toMatchObject({ kind: "decided", title: "Rejected: Runbook: restart" });
  });

  it("tells project members when a contract they consume changes", async () => {
    await adminSetMember(await ctx("admin@example.com"), "order-service", "member@example.com", "writer");
    const owner = await ctx("admin@example.com");
    const contract = await getArticle(owner, ids.contract);
    await editArticle(owner, { id: ids.contract, version: contract.version, section: "Errors", text: "409 and 422.", summary: "Orders API: 422 added" });
    await flushDeliveries();
    expect(await notes("member@example.com")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "change", title: "Upstream change for order-service: Orders API: 422 added" })]));
    // A direct edit by an owner never pinged reviewers about a "pending" proposal.
    expect((await notes("admin@example.com")).filter((n) => n.title.includes("Orders API: 422 added") && n.kind === "review")).toEqual([]);
  });

  it("tells owners when something they own goes stale", async () => {
    const owner = await ctx("owner@example.com");
    await db.query("UPDATE articles SET owner_id = $1, last_verified_at = now() - interval '200 days' WHERE id = $2", [owner.actor.id, ids.cvr]);
    await markStale(db, { findingDays: 90, articleDays: 90 }, settings);
    await flushDeliveries();
    expect(await notes("owner@example.com")).toEqual([expect.objectContaining({ kind: "stale", title: "Needs re-verifying: Conversion rate" })]);
  });

  it("respects email preferences and lists and clears notifications over HTTP", async () => {
    const h = { authorization: "Bearer m", "content-type": "application/json" };
    await fetch(`${base}/api/account/prefs`, { method: "PUT", headers: h, body: JSON.stringify({ email: { change: false } }) });
    const owner = await ctx("admin@example.com");
    const contract = await getArticle(owner, ids.contract);
    await editArticle(owner, { id: ids.contract, version: contract.version, section: "Errors", text: "409, 422 and 429.", summary: "Orders API: 429 added" });
    await flushDeliveries();
    expect(outbox.filter((m) => m.to === "member@example.com")).toEqual([]);
    const list = await fetch(`${base}/api/notifications`, { headers: h }).then((r) => r.json());
    expect(list.unread).toBeGreaterThanOrEqual(2);
    await fetch(`${base}/api/notifications/read`, { method: "POST", headers: h, body: "{}" });
    expect((await fetch(`${base}/api/notifications`, { headers: h }).then((r) => r.json())).unread).toBe(0);
  });
});

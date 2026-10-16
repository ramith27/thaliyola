import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { editArticle } from "../src/core/direct.js";
import { getArticle, getFinding } from "../src/core/items.js";
import { flushDeliveries } from "../src/core/notify.js";
import { approveRevision } from "../src/core/review.js";
import { addComment, bulkApprove, listVersions, restoreVersion, setAssignee } from "../src/core/workflow.js";
import { createArticle, proposeArticleEdit, proposeFinding } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let server: Server;
let base: string;

const notes = async (email: string, kind: string) =>
  (await db.query("SELECT n.title, n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = $1 AND n.kind = $2 ORDER BY n.created_at", [email, kind])).rows;

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator("adm=admin@example.com,au=author@example.com"), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});
beforeEach(() => flushDeliveries());

const admin = () => ctxFor(db, { email: "admin@example.com" });
const author = () => ctxFor(db, { email: "author@example.com", project: "order-service" });
const call = (token: string, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("review workflow", () => {
  it("lets a reviewer correct a new finding before approving it, redacting the edit", async () => {
    const res = await proposeFinding(await author(), { type: "rca", title: "Cart totals drift", symptoms: "Totals off by a cent", root_cause: "Float maths", force_new: true });
    if (res.status !== "pending_review") throw new Error("expected a proposal");
    const out = await call("adm", `/revisions/${res.revision_id}/approve`, { edits: { patch: { fix: "Use integer cents. Ask ops at ops@example.com." } } });
    expect(out.status).toBe(200);
    const f = await getFinding(await admin(), res.finding_id);
    expect(f.status).toBe("published");
    expect(f.fix).toContain("Use integer cents");
    expect(f.fix).not.toContain("ops@example.com");
    const rev = (await db.query("SELECT payload FROM revisions WHERE id = $1", [res.revision_id])).rows[0];
    expect(rev.payload.reviewer_edited).toBe(true);
  });

  it("lets a reviewer rewrite the text of an article edit before approving", async () => {
    const a = await getArticle(await admin(), ids.runbook);
    const edit = await proposeArticleEdit(await author(), { id: ids.runbook, version: a.version, section: "Fix", text: "Restart it.", summary: "Runbook fix" });
    await approveRevision(await admin(), edit.revision_id, { body_md: "Roll back the last deploy, then page the owner." });
    const after = await getArticle(await admin(), ids.runbook);
    expect(after.body_md).toContain("Roll back the last deploy");
    expect(after.body_md).not.toContain("Restart it.");
  });

  it("keeps a comment thread on a proposal and tells the other people in it", async () => {
    const res = await proposeFinding(await author(), { type: "known_issue", title: "Coupon field ignores spaces", symptoms: "Codes with spaces fail", root_cause: "No trim", force_new: true });
    if (res.status !== "pending_review") throw new Error("expected a proposal");
    await addComment(await admin(), res.revision_id, "Which browsers?");
    await flushDeliveries();
    expect(await notes("author@example.com", "comment")).toEqual([expect.objectContaining({ title: "Comment on: New known issue: Coupon field ignores spaces" })]);
    const reply = await call("au", `/revisions/${res.revision_id}/comments`, { body: "All of them." });
    expect(reply.status).toBe(200);
    await flushDeliveries();
    expect((await notes("admin@example.com", "comment")).map((n) => n.body)).toEqual([expect.stringContaining("All of them.")]);
    const thread = await call("adm", `/revisions/${res.revision_id}/comments`);
    expect(thread.body.comments.map((c: { body: string }) => c.body)).toEqual(["Which browsers?", "All of them."]);
    expect((await call("au", `/revisions/${res.revision_id}/comments`, { body: "   " })).status).toBe(400);
  });

  it("assigns a proposal to a reviewer, filters the queue by assignee, and refuses non-reviewers", async () => {
    const res = await proposeFinding(await author(), { type: "data_gotcha", title: "Order dates are UTC", symptoms: "Daily totals shift", root_cause: "Timezone", force_new: true });
    if (res.status !== "pending_review") throw new Error("expected a proposal");
    const reviewers = await call("adm", `/revisions/${res.revision_id}/reviewers`);
    const me = reviewers.body.reviewers.find((r: { email: string }) => r.email === "admin@example.com");
    expect(me).toBeTruthy();
    const authorId = (await author()).actor.id;
    await expect(setAssignee(await admin(), res.revision_id, authorId)).rejects.toThrow(/can't approve/);
    await expect(setAssignee(await author(), res.revision_id, me.id)).rejects.toThrow();
    expect((await call("adm", `/revisions/${res.revision_id}/assignee`, { user_id: me.id }, "PUT")).status).toBe(200);
    const mine = await call("adm", "/revisions?assigned=true");
    expect(mine.body.revisions.map((r: { id: string }) => r.id)).toEqual([res.revision_id]);
    expect(mine.body.revisions[0].assignee).toBe("admin@example.com");
  });

  it("approves several proposals at once and reports each result", async () => {
    const one = await proposeFinding(await author(), { type: "rca", title: "Bulk one", symptoms: "a", root_cause: "b", force_new: true });
    const two = await proposeFinding(await author(), { type: "rca", title: "Bulk two", symptoms: "a", root_cause: "b", force_new: true });
    if (one.status !== "pending_review" || two.status !== "pending_review") throw new Error("expected proposals");
    const out = await bulkApprove(await admin(), [one.revision_id, two.revision_id, one.revision_id]);
    expect(out.approved).toBe(2);
    expect(out.results[2]).toMatchObject({ ok: false, error: expect.stringContaining("already approved") });
  });

  it("keeps every published version and restores an old one as a new version", async () => {
    const owner = await admin();
    const created = await createArticle(owner, { scope: "team", type: "runbook", title: "Payment retries", body_md: "## Fix\nRetry three times." });
    await approveRevision(owner, created.revision_id);
    const v1 = await getArticle(owner, created.article_id);
    await editArticle(owner, { id: created.article_id, version: v1.version, summary: "Five retries", section: "Fix", text: "Retry five times." });
    const history = await listVersions(owner, created.article_id);
    expect(history.versions.map((v: { version: number; summary: string }) => [v.version, v.summary])).toEqual([
      [v1.version + 1, "Five retries"],
      [v1.version, "New runbook: Payment retries"],
    ]);
    const old = await call("adm", `/items/${created.article_id}/versions/${v1.version}`);
    expect(old.body.content.body_md).toContain("Retry three times.");

    // An author without approval rights gets a proposal; the owner restores directly.
    const proposal = await restoreVersion(await author(), created.article_id, v1.version);
    expect(proposal.published).toBe(false);
    const restored = await call("adm", `/items/${created.article_id}/restore`, { version: v1.version });
    expect(restored.body.published).toBe(true);
    const now = await getArticle(owner, created.article_id);
    expect(now.version).toBe(v1.version + 2);
    expect(now.body_md).toContain("Retry three times.");
    expect((await listVersions(owner, created.article_id)).versions[0].summary).toBe("Restore version 1 of Payment retries");
  });
});

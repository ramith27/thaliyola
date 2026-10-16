import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminSetMember } from "../src/core/admin.js";
import { ConflictError, ForbiddenError } from "../src/core/context.js";
import { getArticle, getFinding } from "../src/core/items.js";
import { ackNotice, listImpactNotices } from "../src/core/notices.js";
import { approveRevision, getRevision, listReviewQueue, rejectRevision } from "../src/core/review.js";
import { searchKnowledge } from "../src/core/search.js";
import { upsertUser } from "../src/core/users.js";
import {
  createArticle,
  linkEntries,
  promoteFinding,
  proposeArticleEdit,
  proposeFinding,
  updateFinding,
  verifyEntry,
} from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];

beforeAll(async () => {
  ({ db, ids } = await freshDb());
});
afterAll(async () => {
  await db.end();
});

const agent = () => ctxFor(db, { project: "order-service" });
const admin = () => ctxFor(db, { email: "admin@example.com" });

const newFinding = {
  type: "rca",
  title: "Refund webhook processed twice",
  symptoms: "Customers refunded twice; duplicate refund rows with the same provider event id.",
  root_cause: "Webhook handler was not idempotent and the provider retried on a slow response.",
  fix: "Store the provider event id with a unique constraint.",
};

describe("propose → review → publish", () => {
  it("stores a draft that only becomes searchable after approval", async () => {
    const ctx = await agent();
    const res = await proposeFinding(ctx, { ...newFinding, components: ["backend"], tags: ["Refunds", " refunds ", "#Webhooks"], source_links: [{ system: "pr", url: "https://github.com/example/orders-api/pull/7" }] });
    if (res.status !== "pending_review") throw new Error("expected pending_review");
    expect(res.scope).toBe("order-service");

    const draft = await getFinding(ctx, res.finding_id);
    expect(draft).toMatchObject({ status: "draft", tags: ["refunds", "webhooks"], components: ["backend"] });
    expect(draft.source_links).toHaveLength(1);
    expect((await searchKnowledge(ctx, { query: "refunded twice duplicate refund" })).findings.map((h) => h.id)).not.toContain(res.finding_id);

    const queue = await listReviewQueue(ctx, { scope: "order-service" });
    expect(queue.map((r) => r.id)).toContain(res.revision_id);

    const approved = await approveRevision(await admin(), res.revision_id);
    expect(approved).toMatchObject({ state: "approved", item_status: "published" });
    expect((await searchKnowledge(ctx, { query: "refunded twice duplicate refund" })).findings[0]?.id).toBe(res.finding_id);
    await expect(approveRevision(await admin(), res.revision_id)).rejects.toThrow(/already approved/);
  });

  it("returns near-duplicates instead of storing, unless force_new", async () => {
    const ctx = await agent();
    const before = (await db.query("SELECT count(*)::int AS n FROM findings")).rows[0].n;
    const dup = await proposeFinding(ctx, {
      ...newFinding,
      title: "Double refund from webhook retry",
      symptoms: "Customers refunded twice, duplicate refund rows with same provider event id.",
    });
    expect(dup.status).toBe("duplicates_found");
    if (dup.status !== "duplicates_found") return;
    expect(dup.duplicates[0]!.title).toBe("Refund webhook processed twice");
    expect((await db.query("SELECT count(*)::int AS n FROM findings")).rows[0].n).toBe(before);

    const forced = await proposeFinding(ctx, { ...newFinding, title: "Double refund (separate case)", force_new: true, related_ids: [dup.duplicates[0]!.id] });
    expect(forced.status).toBe("pending_review");
    if (forced.status !== "pending_review") return;
    expect((await getFinding(ctx, forced.finding_id)).related).toEqual([expect.objectContaining({ relation: "related", id: dup.duplicates[0]!.id })]);
  });

  it("redacts secrets and personal data, and refuses fields that were only secrets", async () => {
    const ctx = await agent();
    const res = await proposeFinding(ctx, {
      type: "data_gotcha",
      title: "Exports include test orders",
      symptoms: "Reported by jane@example.com; the export used password=hunter2 on the replica.",
      root_cause: "Test orders are not filtered in the export query.",
      force_new: true,
    });
    if (res.status !== "pending_review") throw new Error("expected pending_review");
    expect(res.redactions).toEqual([
      { kind: "secret", count: 1 },
      { kind: "email", count: 1 },
    ]);
    expect((await getFinding(ctx, res.finding_id)).symptoms).toBe(
      "Reported by [REDACTED:email]; the export used password=[REDACTED:secret] on the replica.",
    );
    await expect(
      proposeFinding(ctx, { type: "rca", title: "x", symptoms: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", root_cause: "y", force_new: true }),
    ).rejects.toThrow(/symptoms must not be empty/);
  });

  it("rejects with a reason and marks the draft rejected", async () => {
    const ctx = await agent();
    const res = await proposeFinding(ctx, { type: "rca", title: "Guess about refund failures", symptoms: "Refunds slow on Mondays", root_cause: "Probably the moon", force_new: true });
    if (res.status !== "pending_review") throw new Error("expected pending_review");
    await expect(rejectRevision(await admin(), res.revision_id, " ")).rejects.toThrow(/reason is required/);
    await rejectRevision(await admin(), res.revision_id, "Not confirmed");
    expect((await getFinding(ctx, res.finding_id)).status).toBe("rejected");
    await expect(updateFinding(ctx, { id: res.finding_id, version: 1, summary: "x", patch: { title: "y" } })).rejects.toThrow(/rejected/);
  });
});

describe("optimistic concurrency", () => {
  it("refuses stale versions with the current content, and stale approvals", async () => {
    const ctx = await agent();
    await expect(updateFinding(ctx, { id: ids.knownIssue, version: 7, summary: "x", patch: { fix: "y" } })).rejects.toSatisfy(
      (e: unknown) => e instanceof ConflictError && (e.current as { version: number }).version === 1,
    );

    const a = await updateFinding(ctx, { id: ids.knownIssue, version: 1, summary: "Async export shipped", patch: { fix: "Use the async export (Export → Email me)." } });
    const b = await updateFinding(ctx, { id: ids.knownIssue, version: 1, summary: "Raise timeout", patch: { fix: "Raise the gateway timeout." } });
    expect((await getRevision(ctx, b.revision_id)).stale).toBe(false);

    await approveRevision(await admin(), a.revision_id);
    const f = await getFinding(ctx, ids.knownIssue);
    expect(f).toMatchObject({ version: 2, fix: "Use the async export (Export → Email me)." });
    expect((await searchKnowledge(ctx, { query: "async export email" })).findings[0]?.id).toBe(ids.knownIssue);

    expect((await getRevision(ctx, b.revision_id)).stale).toBe(true);
    await expect(approveRevision(await admin(), b.revision_id)).rejects.toThrow(/changed since this was proposed/);
  });
});

describe("article edits and impact notices", () => {
  it("notifies consuming components when a contract section changes", async () => {
    const ctx = await ctxFor(db, { project: "order-service", component: "backend" });
    const contract = await getArticle(ctx, ids.contract);
    const res = await proposeArticleEdit(ctx, {
      id: ids.contract,
      version: contract.version,
      section: "Errors",
      text: "409 when the order is already refunded.\n422 when the refund exceeds the order total.",
      summary: "POST /orders/{id}/refund can now return 422",
    });
    const preview = await getRevision(ctx, res.revision_id);
    expect((preview.proposed as { body_md: string }).body_md).toContain("422 when the refund exceeds");

    const approved = await approveRevision(await admin(), res.revision_id);
    expect(approved).toMatchObject({ version: contract.version + 1, impact_notices: 1 });

    const frontend = await listImpactNotices(await ctxFor(db), { project: "order-service", component: "frontend" });
    const notice = frontend.notices.find((n) => n.summary.includes("422"))!;
    expect(notice).toMatchObject({ summary: "POST /orders/{id}/refund can now return 422", component: "frontend", source_title: "Orders API v1", source_version: contract.version + 1 });
    const backend = await listImpactNotices(await ctxFor(db), { project: "order-service", component: "backend" });
    expect(backend.notices).toEqual([]);

    await ackNotice(await ctxFor(db), notice.id);
    const after = await listImpactNotices(await ctxFor(db), { project: "order-service", component: "frontend" });
    expect(after.notices.map((n) => n.id)).not.toContain(notice.id);
  });

  it("notifies projects that use a shared library item", async () => {
    const ctx = await ctxFor(db);
    const table = await getArticle(ctx, ids.dataTable);
    const res = await proposeArticleEdit(ctx, { id: ids.dataTable, version: table.version, section: "States", text: "Loading, empty, error, and partial results.", summary: "Data table: new partial-results state" });
    expect((await approveRevision(await admin(), res.revision_id)).impact_notices).toBe(1);
    const notices = await listImpactNotices(ctx, { project: "order-service" });
    expect(notices.notices.find((n) => n.source_id === ids.dataTable)).toMatchObject({ source_scope: "library", component: null });
  });

  it("promotes a finding into an article's Known issues", async () => {
    const ctx = await ctxFor(db);
    const runbook = await getArticle(ctx, ids.runbook);
    const res = await promoteFinding(ctx, { finding_id: ids.rca, article_id: ids.runbook, version: runbook.version });
    await approveRevision(await admin(), res.revision_id);
    const after = await getArticle(ctx, ids.runbook, "Known issues");
    expect(after.body_md).toMatch(/Checkout errors spike: payment provider rate limit\*\*: Retry storm/);
    expect(after.related).toEqual(expect.arrayContaining([expect.objectContaining({ relation: "promoted_into", direction: "in", id: ids.rca })]));
  });

  it("creates articles as drafts and reports missing template sections", async () => {
    const ctx = await agent();
    const res = await createArticle(ctx, { type: "screen_spec", title: "Refund dialog", body_md: "## Purpose\nConfirm a refund.\n", path: " Screens / Dialogs ", components: ["frontend"], uses_ids: [ids.dataTable] });
    expect(res.missing_template_sections).toEqual(["User flow", "States", "API calls"]);
    const a = await getArticle(ctx, res.article_id);
    expect(a).toMatchObject({ status: "draft", path: "Screens/Dialogs", components: ["frontend"] });
    await expect(createArticle(ctx, { scope: "library", type: "project_overview", title: "x", body_md: "" })).rejects.toThrow(/belongs in a project/);
  });
});

describe("verify and supersede", () => {
  it("refreshes a stale entry directly, and supersedes one only after review", async () => {
    const ctx = await ctxFor(db);
    await db.query("UPDATE articles SET status = 'possibly_stale' WHERE id = $1", [ids.cvr]);
    const v = await verifyEntry(ctx, { id: ids.cvr, still_valid: true });
    expect(v).toMatchObject({ status: "verified", item_status: "published" });

    await expect(verifyEntry(ctx, { id: ids.decision, still_valid: false })).rejects.toThrow(/note/);
    const res = await verifyEntry(ctx, { id: ids.decision, still_valid: false, note: "Keys now expire after 7 days" });
    if (res.status !== "pending_review") throw new Error("expected pending_review");
    await approveRevision(await admin(), res.revision_id);
    expect((await getArticle(ctx, ids.decision)).status).toBe("superseded");
    expect((await searchKnowledge(ctx, { query: "idempotency key order creation", scope: "all" })).articles.map((h) => h.id)).not.toContain(ids.decision);
  });
});

describe("links", () => {
  it("validates relation shapes", async () => {
    const ctx = await ctxFor(db);
    const ok = await linkEntries(ctx, { from: "scope:merchant-portal", relation: "uses", to: ids.dataTable });
    expect(ok.relation).toBe("uses");
    await expect(linkEntries(ctx, { from: ids.contract, relation: "provided_by", to: ids.screen })).rejects.toThrow(/article → component/);
    await expect(linkEntries(ctx, { from: "scope:library", relation: "uses", to: ids.contract })).rejects.toThrow(/only projects/);
    await expect(linkEntries(ctx, { from: ids.rca, relation: "related", to: ids.rca })).rejects.toThrow(/itself/);
    const comp = await linkEntries(ctx, { from: ids.contract, relation: "consumed_by", to: "component:order-service/backend" });
    expect(comp.to.kind).toBe("component");
  });
});

describe("permissions", () => {
  beforeEach(async () => {
    await db.query("DELETE FROM scope_members");
  });

  it("only owners and admins approve; services never do", async () => {
    const ctx = await agent();
    const res = await proposeFinding(ctx, { type: "known_issue", title: "Search ignores accents", symptoms: "Searching cafe does not find café", root_cause: "No unaccent", force_new: true });
    if (res.status !== "pending_review") throw new Error("expected pending_review");
    await expect(approveRevision(await ctxFor(db, { email: "random@example.com" }), res.revision_id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(approveRevision(await ctxFor(db, { email: "svc-bot@example.com", service: true }), res.revision_id)).rejects.toThrow(/service identities/);

    await adminSetMember(await admin(), "order-service", "owner@example.com", "owner");
    expect(await approveRevision(await ctxFor(db, { email: "owner@example.com" }), res.revision_id)).toMatchObject({ state: "approved" });
  });

  it("restricts proposals once a scope lists writers", async () => {
    await adminSetMember(await admin(), "team", "writer@example.com", "writer");
    const outsider = await ctxFor(db, { email: "outsider@example.com" });
    await expect(proposeFinding(outsider, { scope: "team", type: "rca", title: "t", symptoms: "s", root_cause: "r", force_new: true })).rejects.toThrow(/not a writer/);
    const writer = await ctxFor(db, { email: "writer@example.com" });
    expect((await proposeFinding(writer, { scope: "team", type: "rca", title: "t", symptoms: "s", root_cause: "r", force_new: true })).status).toBe("pending_review");
  });

  it("lets a person granted a role before signing in claim it on first login", async () => {
    await adminSetMember(await admin(), "library", "New.Person@example.com", "owner");
    const user = await upsertUser(db, { subject: "cf:new.person@example.com", email: "new.person@example.com", kind: "human" });
    const { rows } = await db.query("SELECT role FROM scope_members WHERE user_id = $1", [user.id]);
    expect(rows).toEqual([{ role: "owner" }]);
    expect(user.subject).toBe("cf:new.person@example.com");
  });
});

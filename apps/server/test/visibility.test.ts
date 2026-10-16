import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { adminSetMember, adminUpdateScope } from "../src/core/admin.js";
import { uploadAsset, getAsset } from "../src/core/assets.js";
import { needsAttention } from "../src/core/freshness.js";
import { browseKb, getArticle, getFinding } from "../src/core/items.js";
import { ackNotice } from "../src/core/notices.js";
import { getProjectContext } from "../src/core/projects.js";
import { approveRevision, getRevision, listReviewQueue } from "../src/core/review.js";
import { listProjects } from "../src/core/scopes.js";
import { searchKnowledge } from "../src/core/search.js";
import { linkEntries, proposeFinding, shareToLibrary, updateFinding } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let assetId: string;
let pendingRevision: string;
let server: Server;
let base: string;

const admin = () => ctxFor(db, { email: "admin@example.com" });
const outsider = () => ctxFor(db, { email: "outsider@example.com" });
const reader = () => ctxFor(db, { email: "reader@example.com" });
const writer = () => ctxFor(db, { email: "writer@example.com" });

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  // Prepare state while the project is still team-visible.
  assetId = (await uploadAsset(await writer(), { target_id: ids.screen, filename: "s.png", mime: "image/png", data: PNG })).asset_id;
  pendingRevision = (await updateFinding(await writer(), { id: ids.knownIssue, version: 1, summary: "secret change", patch: { fix: "secret fix" } })).revision_id;

  await adminUpdateScope(await admin(), "order-service", { visibility: "members" });
  await adminSetMember(await admin(), "order-service", "reader@example.com", "reader");
  await adminSetMember(await admin(), "order-service", "writer@example.com", "writer");

  server = createApp({ db, authenticate: devAuthenticator("out=outsider@example.com,adm=admin@example.com"), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

describe("members-only projects", () => {
  it("are invisible to non-members everywhere they could look", async () => {
    const ctx = await outsider();
    const everything = await searchKnowledge(ctx, { query: "orders refund export screen contract", scope: "all", limit: 25 });
    const hitScopes = [...everything.articles, ...everything.findings].map((h) => h.scope.slug);
    expect(hitScopes).not.toContain("order-service");
    expect(hitScopes.length).toBeGreaterThan(0);

    await expect(getArticle(ctx, ids.contract)).rejects.toThrow(/not found/);
    await expect(getFinding(ctx, ids.knownIssue)).rejects.toThrow(/not found/);
    await expect(browseKb(ctx, "order-service")).rejects.toThrow(/scope 'order-service' not found/);
    await expect(getProjectContext(ctx, "order-service")).rejects.toThrow(/not found/);
    await expect(searchKnowledge(ctx, { query: "orders", scope: "order-service" })).rejects.toThrow(/not found/);
    expect((await listProjects(ctx)).map((p) => p.slug)).toEqual(["merchant-portal"]);
    await expect(getAsset(ctx, assetId)).rejects.toThrow(/not found/);
    expect((await listReviewQueue(ctx)).map((r) => r.id)).not.toContain(pendingRevision);
    await expect(getRevision(ctx, pendingRevision)).rejects.toThrow(/not found/);
    expect((await needsAttention(ctx, { scope: "all" })).entries.every((e: { scope: string }) => e.scope !== "order-service")).toBe(true);

    // Library items don't reveal who uses them from a hidden project.
    const table = await getArticle(ctx, ids.dataTable);
    expect(table.related.map((r) => r.scope)).not.toContain("order-service");

    const notice = (await db.query("SELECT id FROM impact_notices LIMIT 1")).rows[0].id;
    await expect(ackNotice(ctx, notice)).rejects.toThrow(/not found/);
  });

  it("can't be written to or linked to by non-members", async () => {
    const ctx = await outsider();
    await expect(proposeFinding(ctx, { scope: "order-service", type: "rca", title: "x", symptoms: "y", root_cause: "z", force_new: true })).rejects.toThrow(/not found/);
    await expect(linkEntries(ctx, { from: "scope:merchant-portal", relation: "uses", to: ids.contract })).rejects.toThrow(/not found/);
    await expect(updateFinding(ctx, { id: ids.knownIssue, version: 1, summary: "x", patch: { fix: "y" } })).rejects.toThrow(/not found/);
  });

  it("are readable by members; only writers and owners may propose", async () => {
    const r = await reader();
    expect((await getArticle(r, ids.contract)).title).toBe("Orders API v1");
    expect((await searchKnowledge(r, { query: "export times out", scope: "all" })).findings.map((h) => h.id)).toContain(ids.knownIssue);
    await expect(proposeFinding(r, { scope: "order-service", type: "rca", title: "x", symptoms: "y", root_cause: "z", force_new: true })).rejects.toThrow(/not a writer/);
    const w = await writer();
    expect((await proposeFinding(w, { scope: "order-service", type: "rca", title: "Writer finding", symptoms: "Seen by writer", root_cause: "Known", force_new: true })).status).toBe("pending_review");
  });

  it("stay fully visible to admins", async () => {
    const ctx = await admin();
    expect((await listProjects(ctx)).map((p) => p.slug)).toEqual(["merchant-portal", "order-service"]);
    expect((await getRevision(ctx, pendingRevision)).summary).toBe("secret change");
  });

  it("let library owners review what the project shares to the library", async () => {
    await adminSetMember(await admin(), "library", "librarian@example.com", "owner");
    const share = await shareToLibrary(await writer(), { id: ids.decision, summary: "Reusable" });
    const librarian = await ctxFor(db, { email: "librarian@example.com" });
    await expect(getArticle(librarian, ids.decision)).rejects.toThrow(/not found/);
    expect((await listReviewQueue(librarian)).map((r) => r.id)).toContain(share.revision_id);
    expect((await getRevision(librarian, share.revision_id)).current).toMatchObject({ title: "Use idempotency keys for order creation" });
    const approved = await approveRevision(librarian, share.revision_id);
    expect((await getArticle(librarian, approved.library_copy_id as string)).scope.slug).toBe("library");
  });

  it("are left out of dashboard numbers and the graph", async () => {
    const graph = await fetch(`${base}/api/graph`, { headers: { authorization: "Bearer out" } }).then((r) => r.json());
    expect(graph.nodes.some((n: { scope: string }) => n.scope === "order-service")).toBe(false);
    const stats = await fetch(`${base}/api/insights`, { headers: { authorization: "Bearer out" } }).then((r) => r.json());
    expect(stats.totals.projects).toBe(1);
  });

  it("are hidden over HTTP too, and only admins change visibility", async () => {
    const scopes = await (await fetch(`${base}/api/scopes`, { headers: { authorization: "Bearer out" } })).json();
    expect(scopes.scopes.map((s: { slug: string }) => s.slug)).not.toContain("order-service");
    const res = await fetch(`${base}/api/articles/${ids.contract}`, { headers: { authorization: "Bearer out" } });
    expect(res.status).toBe(404);
    const patch = await fetch(`${base}/api/scopes/merchant-portal`, {
      method: "PATCH",
      headers: { authorization: "Bearer out", "content-type": "application/json" },
      body: JSON.stringify({ visibility: "members" }),
    });
    expect(patch.status).toBe(403);
    const libraryPatch = await fetch(`${base}/api/scopes/library`, {
      method: "PATCH",
      headers: { authorization: "Bearer adm", "content-type": "application/json" },
      body: JSON.stringify({ visibility: "members" }),
    });
    expect(libraryPatch.status).toBe(400);
  });
});

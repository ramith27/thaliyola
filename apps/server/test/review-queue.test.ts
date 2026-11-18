import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSetMember } from "../src/core/admin.js";
import { getArticle } from "../src/core/items.js";
import { approveRevision, listReviewQueue, reviewFacets } from "../src/core/review.js";
import { bulkReject } from "../src/core/workflow.js";
import { createArticle, proposeArticleEdit, proposeFinding, proposeMove, verifyEntry } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
const ids2 = {} as Record<"newArticle" | "newFinding" | "edit" | "otherEdit" | "retire" | "move", string>;

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  const admin = await ctxFor(db, { email: "admin@example.com" });
  await adminSetMember(admin, "order-service", "rita@example.com", "reviewer");
  await adminSetMember(admin, "order-service", "wes@example.com", "writer");
  await adminSetMember(admin, "order-service", "bot@example.com", "writer");
  const writer = await ctxFor(db, { email: "wes@example.com" });
  const bot = await ctxFor(db, { email: "bot@example.com", service: true });

  ids2.newArticle = (await createArticle(writer, { scope: "order-service", type: "runbook", title: "Refund queue backlog", body_md: "## Trigger\n\nx" })).revision_id;
  ids2.newFinding = ((await proposeFinding(bot, { scope: "order-service", type: "rca", title: "Webhook retries pile up", symptoms: "webhooks late", root_cause: "no backoff" })) as { revision_id: string }).revision_id;
  const page = await getArticle(admin, ids.runbook);
  ids2.edit = (await proposeArticleEdit(writer, { id: ids.runbook, version: page.version, section: "Fix", text: "Roll back.", summary: "Clarify the fix" })).revision_id;
  ids2.otherEdit = (await proposeArticleEdit(bot, { id: ids.runbook, version: page.version, section: "Verify", text: "Watch it.", summary: "Better verify step" })).revision_id;
  ids2.retire = ((await verifyEntry(writer, { id: ids.cvr, still_valid: false, note: "We count sessions differently now" })) as { revision_id: string }).revision_id;
  ids2.move = (await proposeMove(writer, { id: ids.rca, to: "order-service", summary: "Checkout is this project's" })).revision_id;
});
afterAll(() => db.end());

const titles = (rows: { summary: string }[]) => rows.map((r) => r.summary).sort();

describe("review queue filters", () => {
  it("filters by category, project, type, author and words", async () => {
    const admin = await ctxFor(db, { email: "admin@example.com" });
    expect(titles(await listReviewQueue(admin, { category: "edit" }))).toEqual(["Better verify step", "Clarify the fix"]);
    expect((await listReviewQueue(admin, { category: "retire" })).map((r) => r.id)).toEqual([ids2.retire]);
    expect((await listReviewQueue(admin, { category: "move" })).map((r) => r.id)).toEqual([ids2.move]);
    expect((await listReviewQueue(admin, { category: "new", scope: "order-service" })).map((r) => r.id).sort()).toEqual([ids2.newArticle, ids2.newFinding].sort());
    expect((await listReviewQueue(admin, { type: "rca", category: "new" })).map((r) => r.id)).toEqual([ids2.newFinding]);
    expect((await listReviewQueue(admin, { author: "agents" })).every((r) => r.author_kind === "service")).toBe(true);
    expect((await listReviewQueue(admin, { q: "REFUND" })).map((r) => r.id)).toEqual([ids2.newArticle]);
    expect(await listReviewQueue(admin, { q: "100%_" })).toEqual([]);
  });

  it("shows what the caller may review, and hides what they wrote", async () => {
    const rita = await ctxFor(db, { email: "rita@example.com" });
    const mine = await listReviewQueue(rita, { assigned: "to_review" });
    // Rita reviews in order-service only: both new entries; not team edits or the move (reviewed in team).
    expect(mine.map((r) => r.id).sort()).toEqual([ids2.newArticle, ids2.newFinding].sort());
    expect(mine.every((r) => r.can_review)).toBe(true);
    const wes = await ctxFor(db, { email: "wes@example.com" });
    expect(await listReviewQueue(wes, { assigned: "to_review" })).toEqual([]);
    expect((await listReviewQueue(wes, { author: "me" })).length).toBe(4);
  });

  it("counts each facet without its own filter", async () => {
    const admin = await ctxFor(db, { email: "admin@example.com" });
    const f = await reviewFacets(admin, { category: "new" });
    expect(f.categories).toEqual({ new: 2, edit: 2, retire: 1, move: 1 });
    expect(f.projects).toEqual([expect.objectContaining({ slug: "order-service", count: 2 })]);
    expect(f.types).toEqual({ runbook: 1, rca: 1 });
    expect(f.authors).toEqual({ people: 1, agents: 1 });
    expect(f.states.pending).toBe(2);
    expect(f.to_review).toBe(2); // within the other filters (new entries), like every facet
  });

  it("flags proposals the item has moved past, and rejects in bulk with one reason", async () => {
    const admin = await ctxFor(db, { email: "admin@example.com" });
    await approveRevision(admin, ids2.edit);
    const [other] = await listReviewQueue(admin, { q: "Better verify" });
    expect(other).toMatchObject({ outdated: true, can_review: true });

    await expect(bulkReject(admin, [ids2.otherEdit], " ")).rejects.toThrow(/reason/);
    const out = await bulkReject(admin, [ids2.otherEdit, ids2.retire], "Not now");
    expect(out.rejected).toBe(2);
    expect((await listReviewQueue(admin, { state: "rejected" })).map((r) => r.reason)).toEqual(["Not now", "Not now"]);
  });
});

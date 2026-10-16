import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { audit } from "../src/core/audit.js";
import { linkEntries, proposeFinding, verifyEntry } from "../src/core/writes.js";
import { digestSlot, sendDigests } from "../src/core/digest.js";
import { getArticle } from "../src/core/items.js";
import { dismissGap, knowledgeGaps, successMetrics } from "../src/core/metrics.js";
import { flushDeliveries, outbox } from "../src/core/notify.js";
import { purgeItem } from "../src/core/purge.js";
import { approveRevision } from "../src/core/review.js";
import { searchKnowledge } from "../src/core/search.js";
import { addComment } from "../src/core/workflow.js";
import { proposeArticleEdit } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
const settings = { ...TEST_SETTINGS, mailTransport: "json" as const };

beforeAll(async () => {
  ({ db, ids } = await freshDb());
});
afterAll(() => db.end());
beforeEach(async () => {
  await flushDeliveries();
  outbox.length = 0;
});

const admin = () => ctxFor(db, { email: "admin@example.com", settings });

describe("search log and knowledge gaps", () => {
  it("logs searches, keeps the text only for misses (redacted), and groups gaps for admins", async () => {
    const me = await ctxFor(db, { email: "searcher@example.com", settings });
    await searchKnowledge(me, { query: "conversion rate", source: "web" });
    await searchKnowledge(me, { query: "gift card expiry rules", source: "mcp" });
    await searchKnowledge(await ctxFor(db, { email: "other@example.com", settings }), { query: "Gift card expiry rules", source: "web" });
    await searchKnowledge(me, { query: "zebra ghp_abcdefghijklmnopqrstuvwxyz0123456789 xylophone", source: "web" });
    await searchKnowledge(me, { query: "conv", source: "web", prefix: true }); // typing: not logged
    await searchKnowledge(me, { query: "unlogged" }); // no source: not logged
    await flushDeliveries();
    const log = (await db.query("SELECT source, results, keyword_hits, query FROM search_log ORDER BY id")).rows;
    expect(log).toHaveLength(4);
    expect(log[0]).toMatchObject({ source: "web", query: null });
    expect(log[0].keyword_hits).toBeGreaterThan(0);
    expect(log[3].query).toMatch(/^zebra .+ xylophone$/);
    expect(log[3].query).not.toContain("ghp_");

    const gaps = await knowledgeGaps(await admin());
    expect(gaps.gaps[0]).toMatchObject({ query: "gift card expiry rules", searches: 2, people: 2, from_agents: 1 });
    await expect(knowledgeGaps(me)).rejects.toThrow(/admins only/);
    await dismissGap(await admin(), "gift card expiry rules");
    expect((await knowledgeGaps(await admin())).gaps.map((g: { query: string }) => g.query)).not.toContain("gift card expiry rules");
  });
});

describe("success metrics", () => {
  it("reports reuse, search hit rate, review time, repeats and hygiene", async () => {
    const me = await admin();
    await verifyEntry(me, { id: ids.rca, still_valid: true });
    await audit(db, me.actor.id, "verify_entry", ids.rca); // the MCP layer records each tool call
    const f = await proposeFinding(await ctxFor(db, { email: "author@example.com", project: "order-service", settings }), {
      type: "rca",
      title: "Payments 429 again",
      symptoms: "429s during flash sale",
      root_cause: "Retry storm",
      force_new: true,
    });
    if (f.status !== "pending_review") throw new Error("expected proposal");
    await approveRevision(me, f.revision_id);
    await linkEntries(me, { from: f.finding_id, to: ids.rca, relation: "same_root_cause" });

    const m = await successMetrics(me, { days: 30 });
    expect(m.reuse.verifications).toBeGreaterThanOrEqual(1);
    expect(m.search.total).toBe(4);
    expect(m.search.hit_rate).toBeGreaterThan(0);
    expect(m.weekly).toHaveLength(12);
    expect(m.review.decided).toBeGreaterThanOrEqual(1);
    expect(m.repeats[0]).toMatchObject({ occurrences: 1 });
    expect(m.hygiene.total).toBeGreaterThan(0);
    expect(m.gaps_visible).toBe(true);
  });
});

describe("weekly digest", () => {
  it("computes the weekly slot", () => {
    const wed = new Date(2026, 9, 14, 12, 0); // Wednesday
    const slot = digestSlot(wed, 1, 8);
    expect([slot.getDay(), slot.getHours(), slot.getDate()]).toEqual([1, 8, 12]);
    const monEarly = new Date(2026, 9, 12, 7, 0); // Monday before 08:00 → previous Monday
    expect(digestSlot(monEarly, 1, 8).getDate()).toBe(5);
  });

  it("emails each person once per week with what concerns them, and respects opting out", async () => {
    const editor = await ctxFor(db, { email: "editor@example.com", settings });
    const a = await getArticle(editor, ids.runbook);
    const edit = await proposeArticleEdit(editor, { id: ids.runbook, version: a.version, section: "Fix", text: "Roll back.", summary: "Runbook: roll back first" });
    await addComment(await admin(), edit.revision_id, "Looks right");
    await db.query("UPDATE users SET prefs = prefs || '{\"digest\": false}' WHERE email = 'searcher@example.com'");
    const r = await sendDigests(db, settings);
    await flushDeliveries();
    expect(r.sent).toBeGreaterThan(0);
    const mail = outbox.find((m) => m.to === "admin@example.com" && m.subject.startsWith("Thaliyola weekly"))!;
    expect(mail.subject).toMatch(/^Thaliyola weekly: \d+ to review/);
    expect(mail.text).toContain("Runbook: roll back first");
    expect(outbox.find((m) => m.to === "searcher@example.com" && m.subject.startsWith("Thaliyola weekly"))).toBeUndefined();
    // Second run in the same week sends nothing.
    outbox.length = 0;
    expect((await sendDigests(db, settings)).sent).toBe(0);
  });
});

describe("purge", () => {
  it("lets admins hard-delete an item with a reason, removing its content everywhere", async () => {
    const me = await admin();
    await expect(purgeItem(await ctxFor(db, { email: "nobody@example.com", settings }), ids.rca, { reason: "secret leaked", confirm_title: "x" })).rejects.toThrow(/only admins/);
    const title = (await db.query("SELECT title FROM findings WHERE id = $1", [ids.rca])).rows[0].title;
    await expect(purgeItem(me, ids.rca, { reason: "secret leaked", confirm_title: "wrong" })).rejects.toThrow(/exact title/);
    await expect(purgeItem(me, ids.rca, { reason: "x", confirm_title: title })).rejects.toThrow(/reason/);
    const res = await purgeItem(me, ids.rca, { reason: "Contained a customer's card number", confirm_title: title });
    expect(res.purged).toBe(true);
    for (const [table, col] of [["findings", "id"], ["chunks", "parent_id"], ["revisions", "target_id"], ["relations", "from_id"], ["entity_links", "target_id"], ["source_links", "target_id"]]) {
      expect((await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`, [ids.rca])).rows[0].n, table).toBe(0);
    }
    const log = (await db.query("SELECT reason, removed FROM purges WHERE target_id = $1", [ids.rca])).rows[0];
    expect(log.reason).toBe("Contained a customer's card number");
    expect(log.removed.proposals).toBeGreaterThanOrEqual(0);
  });
});

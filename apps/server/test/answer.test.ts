import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { gatherAnswer, keyTerms } from "../src/core/answer.js";
import { ask } from "../src/core/discover.js";
import { insertArticle, insertFinding } from "../src/core/bootstrap.js";
import { HashingEmbedder, indexPendingChunks } from "../src/core/embeddings.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
const embedder = new HashingEmbedder();
const as = async (email: string) => ({ ...(await ctxFor(db, { email })), embedder, settings: { ...TEST_SETTINGS, duplicateSimilarity: 0.8 } });
const decision = (choice: string) => `## Context\nRetries for refunds.\n\n## Choice\n${choice}\n\n## Consequences\nMore load on the provider.`;
let refundsDoc: string;
let issue: string;

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "billing", name: "Billing", visibility: "members" });
  await adminSetMember(a, "billing", "writer@example.com", "writer");
  const billing = (await db.query("SELECT id FROM scopes WHERE slug = 'billing'")).rows[0].id;
  const library = (await db.query("SELECT id FROM scopes WHERE slug = 'library'")).rows[0].id;
  refundsDoc = await insertArticle(db, {
    scopeId: billing,
    type: "system",
    title: "Refund service",
    body: "## Purpose\nThe refund service issues card refunds through the payment provider and retries failed refund calls three times with backoff.",
  });
  await insertArticle(db, { scopeId: billing, type: "decision", title: "Refund retries use exponential backoff", body: decision("Retry failed refund calls three times with exponential backoff, then alert.") });
  await insertArticle(db, { scopeId: billing, type: "decision", title: "Refund retries are queued", body: decision("Retry failed refund calls three times with exponential backoff, then alert the on-call.") });
  await insertArticle(db, { scopeId: billing, type: "ux_pattern", title: "Refund confirmation dialog", body: "## Rule\nRefund confirmation dialogs show the amount and the card, and need a second click." });
  await insertArticle(db, { scopeId: library, type: "ux_pattern", title: "Confirmation dialogs", body: "## Rule\nRefund confirmation dialogs show the amount and the card, and need a second click." });
  issue = await insertFinding(db, {
    scopeId: billing,
    type: "known_issue",
    title: "Refund retries double-charge on provider timeout",
    symptoms: "The refund service retries failed refund calls three times with backoff, and a timed-out call that succeeded is refunded twice.",
    rootCause: "No idempotency key.",
    fix: "Send an idempotency key.",
  });
  // The doc was checked before the issue was found; one of its facts no longer matches the code.
  await db.query("UPDATE articles SET last_verified_at = now() - interval '10 days', updated_at = now() - interval '10 days' WHERE id = $1", [refundsDoc]);
  await db.query("INSERT INTO claims (article_id, section, text, evidence, status) VALUES ($1, 'Purpose', 'retries three times', '[]', 'stale')", [refundsDoc]);
  await db.query("INSERT INTO incidents (scope_id, title, severity, status, summary) VALUES ($1, 'Refunds failing for card payments', 'sev2', 'open', 'Refund calls time out')", [billing]);
  while ((await indexPendingChunks(db, embedder)) > 0);
});
afterAll(() => db.end());

describe("answer_sources", () => {
  it("numbers the sources, gives their sections and freshness, and finds where they disagree", async () => {
    const r = await gatherAnswer(await as("writer@example.com"), { question: "How do refund retries work?", project: "billing" });
    expect(r.sources.length).toBeGreaterThanOrEqual(4);
    expect(r.sources.map((s) => s.n)).toEqual(r.sources.map((_, i) => i + 1));
    const doc = r.sources.find((s) => s.id === refundsDoc)!;
    expect(doc.text).toMatch(/issues card refunds/);
    expect(doc.text.startsWith("Refund service")).toBe(false);
    expect(doc.freshness).toBe("facts_drifted");
    expect(doc.link).toBe(`#/article/${refundsDoc}`);
    const kinds = r.disagreements.map((d) => d.kind);
    expect(kinds).toContain("decisions_disagree");
    const newer = r.disagreements.find((d) => d.kind === "newer_finding")!;
    expect(newer.sources.map((n) => r.sources[n - 1]!.id).sort()).toEqual([refundsDoc, issue].sort());
    expect(r.incidents.map((i) => i.title)).toEqual(["Refunds failing for card payments"]);
    expect(r.how_to_answer).toMatch(/cite them as \[n\]/);
    expect(r.how_to_answer).toMatch(/disagree/);
  });

  it("says the project's own item applies over the Library's", async () => {
    const r = await gatherAnswer(await as("writer@example.com"), { question: "refund confirmation dialog rule", project: "billing" });
    const o = r.disagreements.find((d) => d.kind === "overlap")!;
    expect(o.note).toMatch(/inside billing/);
  });

  it("shows nothing from projects the asker can't read, and says when nothing is known", async () => {
    const r = await gatherAnswer(await as("outsider@example.com"), { question: "How do refund retries work?" });
    expect(r.sources.every((s) => s.project !== "billing")).toBe(true);
    expect(r.incidents).toEqual([]);
    const none = await gatherAnswer(await as("writer@example.com"), { question: "zebra quantum lighthouse" });
    expect(none.confidence).toBe("none");
    expect(none.how_to_answer).toMatch(/thin/);
  });

  it("warns on the search page's best answer too", async () => {
    const r = await ask(await as("writer@example.com"), "How do refund retries work?", { project: "billing" });
    expect(r.cautions?.incidents.map((i) => i.title)).toEqual(["Refunds failing for card payments"]);
    expect(r.cautions?.disagreements.length).toBeGreaterThanOrEqual(1);
  });

  it("picks the words worth matching", () => {
    expect(keyTerms("How do we handle refunds for /orders?")).toEqual(["handle", "refunds", "/orders"]);
  });
});

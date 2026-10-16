import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HashingEmbedder, indexPendingChunks, LocalEmbedder, type Embedder } from "../src/core/embeddings.js";
import { searchKnowledge } from "../src/core/search.js";
import { findDuplicateFindings } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];

async function indexAll(embedder: Embedder) {
  while ((await indexPendingChunks(db, embedder)) > 0);
}

beforeAll(async () => {
  ({ db, ids } = await freshDb());
});
afterAll(async () => {
  await db.end();
});

describe("hybrid search (hashing embedder)", () => {
  const embedder = new HashingEmbedder([["refund", "refunded", "chargeback", "reimbursement"]]);
  const settings = { ...TEST_SETTINGS, searchMinSimilarity: 0.15 };

  it("embeds every chunk, and re-embeds when the model changes", async () => {
    await indexAll(embedder);
    const { rows } = await db.query("SELECT count(*) FILTER (WHERE embedding IS NULL)::int AS missing, count(DISTINCT embedding_model)::int AS models FROM chunks");
    expect(rows[0]).toEqual({ missing: 0, models: 1 });

    class OtherModel extends HashingEmbedder {
      override readonly model = "hashing-v2";
    }
    expect(await indexPendingChunks(db, new OtherModel(), 1000)).toBeGreaterThan(0);
    await indexAll(embedder);
    expect((await db.query("SELECT DISTINCT embedding_model FROM chunks")).rows).toEqual([{ embedding_model: "hashing-v1" }]);
  });

  it("finds items with no keyword in common through embeddings", async () => {
    const ctx = await ctxFor(db, { project: "order-service", embedder, settings });
    const res = await searchKnowledge(ctx, { query: "chargeback" });
    const hit = res.articles.find((h) => h.id === ids.contract);
    expect(hit?.match).toBe("semantic");
    // The keyword-only engine finds nothing for this query.
    const keywordOnly = await searchKnowledge(await ctxFor(db, { project: "order-service" }), { query: "chargeback" });
    expect([...keywordOnly.articles, ...keywordOnly.findings]).toEqual([]);
  });

  it("marks hits found both ways and keeps scope and status filters", async () => {
    const ctx = await ctxFor(db, { project: "order-service", embedder, settings });
    const res = await searchKnowledge(ctx, { query: "payment provider rate limit during a sale" });
    expect(res.findings[0]).toMatchObject({ id: ids.rca, match: "keyword+semantic" });
    const all = [...res.articles, ...res.findings].map((h) => h.id);
    expect(all).not.toContain(ids.otherDoc);
    expect(all).not.toContain(ids.draft);
  });

  it("returns nothing for unrelated queries instead of nearest-neighbour noise", async () => {
    const ctx = await ctxFor(db, { embedder, settings: { ...TEST_SETTINGS, searchMinSimilarity: 0.6 } });
    const res = await searchKnowledge(ctx, { query: "quantum chromodynamics lattice" });
    expect([...res.articles, ...res.findings]).toEqual([]);
  });

  it("detects near-duplicates by embedding similarity", async () => {
    const ctx = await ctxFor(db, { embedder, settings: { ...TEST_SETTINGS, duplicateThreshold: 1.01, duplicateSimilarity: 0.7 } });
    const scopes = (await db.query("SELECT id FROM scopes")).rows.map((r) => r.id);
    const dups = await findDuplicateFindings(ctx, "Sale checkout errors: the payment provider rate limit was exceeded by a retry storm (HTTP 429)", scopes);
    expect(dups[0]).toMatchObject({ id: ids.rca });
    expect(dups[0]!.similarity).toBeGreaterThan(0.7);
  });
});

// Real model: CAIRN_REAL_EMBEDDINGS=1 pnpm test semantic  (downloads ~35 MB on first run)
describe.runIf(process.env.CAIRN_REAL_EMBEDDINGS === "1")("hybrid search (bge-small)", () => {
  const embedder = new LocalEmbedder(undefined, process.env.EMBEDDING_CACHE_DIR);

  beforeAll(async () => {
    await db.query("UPDATE chunks SET embedding = NULL, embedding_model = NULL");
    await indexAll(embedder);
  }, 120_000);

  it.each([
    ["customers can't pay, the card processor is throttling us", "rca"],
    ["how do we work out what share of visits turn into purchases", "cvr"],
    ["giving money back to a customer", "contract"],
  ] as const)("finds the right item for a paraphrase: %s", async (query, key) => {
    const ctx = await ctxFor(db, { project: "order-service", embedder, settings: TEST_SETTINGS });
    const res = await searchKnowledge(ctx, { query, limit: 3 });
    const top = [...res.articles, ...res.findings].sort((a, b) => b.score - a.score).map((h) => `${h.id} ${h.title} ${h.match}`);
    console.log(query, "\n  ", top.join("\n   "));
    expect(top.some((t) => t.startsWith(ids[key]))).toBe(true);
  });

  it("flags a reworded duplicate but not a different problem", async () => {
    const ctx = await ctxFor(db, { embedder, settings: { ...TEST_SETTINGS, duplicateThreshold: 1.01 } });
    const scopes = (await db.query("SELECT id FROM scopes")).rows.map((r) => r.id);
    const same = await findDuplicateFindings(
      ctx,
      "Checkout failing in a flash sale\nPayments returned 429 Too Many Requests at midday during the promotion.\nOur retries hammered the payment provider and hit its rate limit.",
      scopes,
    );
    const different = await findDuplicateFindings(
      ctx,
      "Checkout page slow on mobile\nThe checkout page takes 8 seconds to render on phones.\nA large hero image is loaded before the form.",
      scopes,
    );
    console.log("same:", same, "\ndifferent:", different);
    expect(same.map((d) => d.id)).toContain(ids.rca);
    expect(different.map((d) => d.id)).not.toContain(ids.rca);
  });
});

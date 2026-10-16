/**
 * Scale check (not part of the normal test run):
 *   PERF_DATABASE_URL=postgres://thaliyola:thaliyola@localhost:5432/thaliyola_perf npx tsx test/perf.bench.ts [articles] [findings]
 * Generates synthetic knowledge, embeds it with the hashing embedder, then times search and duplicate checks.
 */
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { createScope, ensureBaseScopes, insertArticle, insertFinding } from "../src/core/bootstrap.js";
import { HashingEmbedder, indexPendingChunks } from "../src/core/embeddings.js";
import { searchKnowledge } from "../src/core/search.js";
import { findDuplicateFindings } from "../src/core/writes.js";
import { upsertUser } from "../src/core/users.js";
import { TEST_SETTINGS } from "./helpers.js";

const url = process.env.PERF_DATABASE_URL!;
const nArticles = Number(process.argv[2] ?? 4000);
const nFindings = Number(process.argv[3] ?? 10000);
const db = createPool(url);
const words = "payment checkout order refund invoice customer merchant export import queue worker cache redis postgres kafka timeout retry latency error spike drop alert dashboard metric revenue conversion session login token webhook api contract screen table component deploy rollback config feature flag schema migration index lock deadlock memory cpu disk network dns certificate".split(" ");
// Realistic vocabulary: a few hundred common domain words plus a long tail of rarer terms (Zipf-like).
const syll = ["ka", "lo", "mi", "ne", "ru", "ta", "vo", "zi", "pe", "da", "fo", "gu", "ri", "sa", "te", "xo"];
const tail = Array.from({ length: 20000 }, (_, i) => syll[i % 16]! + syll[(i >> 4) % 16]! + syll[(i >> 8) % 16]! + syll[(i >> 12) % 16]!);
let rng = 42;
const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (n: number, _seed: number) =>
  Array.from({ length: n }, () => (rand() < 0.35 ? words[Math.floor(rand() * words.length)] : tail[Math.floor(Math.pow(rand(), 2.5) * tail.length)])).join(" ");

const t = async <T>(label: string, fn: () => Promise<T>) => {
  const s = performance.now();
  const r = await fn();
  console.log(`${label.padEnd(48)} ${(performance.now() - s).toFixed(1)} ms`);
  return r;
};

await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await migrate(db);
await ensureBaseScopes(db);
const scopes = [(await db.query("SELECT id FROM scopes WHERE slug = 'team'")).rows[0].id];
for (let p = 0; p < 20; p++) scopes.push(await createScope(db, "project", `project-${p}`, `Project ${p}`));

await t(`insert ${nArticles} articles`, async () => {
  for (let i = 0; i < nArticles; i++) {
    const body = Array.from({ length: 5 }, (_, k) => `## Section ${k}\n${pick(40, i * 5 + k)}`).join("\n\n");
    await insertArticle(db, { scopeId: scopes[i % scopes.length]!, type: "system", title: `System ${i} ${pick(3, i)}`, body });
  }
});
await t(`insert ${nFindings} findings`, async () => {
  for (let i = 0; i < nFindings; i++) {
    await insertFinding(db, { scopeId: scopes[i % scopes.length]!, type: "rca", title: `Incident ${i} ${pick(4, i + 7)}`, symptoms: pick(25, i + 3), rootCause: pick(20, i + 11), fix: pick(10, i + 13) });
  }
});
const embedder = new HashingEmbedder();
await t("embed all chunks (hashing embedder)", async () => {
  while ((await indexPendingChunks(db, embedder, 500)) > 0);
});
await db.query("ANALYZE");
const chunks = (await db.query("SELECT count(*)::int AS n FROM chunks")).rows[0].n;
console.log(`chunks: ${chunks}`);

const actor = await upsertUser(db, { subject: "dev:perf@example.com", email: "perf@example.com", kind: "human" });
const ctx = { db, actor, settings: TEST_SETTINGS, project: "project-3" };
const queries = ["checkout timeout retry spike", "refund webhook duplicate", "redis memory latency alert", "conversion metric dashboard drop"];
for (const q of queries) await t(`keyword search: ${q}`, () => searchKnowledge(ctx, { query: q }));
for (const q of queries) await t(`hybrid search: ${q}`, () => searchKnowledge({ ...ctx, embedder }, { query: q }));
await t("hybrid search, scope=all", () => searchKnowledge({ ...ctx, embedder }, { query: queries[0]!, scope: "all" }));
await t("duplicate check (terms + vectors)", () => findDuplicateFindings({ ...ctx, embedder }, pick(40, 5), scopes));
await db.end();

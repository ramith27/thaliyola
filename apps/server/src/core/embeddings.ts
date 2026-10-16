import { createHash } from "node:crypto";
import os from "node:os";
import type { Db } from "../db/pool.js";

/**
 * Embeddings for semantic search and duplicate detection. The server holds no
 * LLM: this is a small sentence-embedding model run in-process on CPU.
 */
export interface Embedder {
  readonly model: string;
  readonly dims: number;
  embedQuery(text: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_DIMS = 384;

/** bge-small-en-v1.5 via transformers.js (ONNX, int8). Downloads the model on first use. */
export class LocalEmbedder implements Embedder {
  readonly dims = EMBEDDING_DIMS;
  private extractor: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;

  constructor(
    readonly model = "Xenova/bge-small-en-v1.5",
    private readonly cacheDir?: string,
  ) {}

  private load() {
    this.extractor ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (this.cacheDir) env.cacheDir = this.cacheDir;
      const threads = Math.max(1, Math.min(4, os.availableParallelism() - 1));
      // An explicit thread count also stops onnxruntime from pinning threads (fails in containers).
      const pipe = await pipeline("feature-extraction", this.model, {
        dtype: "q8",
        session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
      });
      return pipe as unknown as (texts: string[], opts: object) => Promise<{ tolist(): number[][] }>;
    })();
    this.extractor.catch(() => (this.extractor = null));
    return this.extractor;
  }

  async embedDocuments(texts: string[]) {
    if (!texts.length) return [];
    const extract = await this.load();
    return (await extract(texts, { pooling: "cls", normalize: true })).tolist();
  }

  async embedQuery(text: string) {
    // bge models retrieve better with this instruction on short queries.
    const [v] = await this.embedDocuments([`Represent this sentence for searching relevant passages: ${text}`]);
    return v!;
  }
}

/**
 * Deterministic bag-of-words embedder for tests and offline development:
 * texts sharing words are similar. Optional synonym groups map words onto
 * one dimension so tests can exercise "semantic" matches without a model.
 */
export class HashingEmbedder implements Embedder {
  readonly model: string = "hashing-v1";
  readonly dims = EMBEDDING_DIMS;
  private readonly canonical = new Map<string, string>();

  constructor(synonyms: string[][] = []) {
    for (const group of synonyms) for (const w of group) this.canonical.set(w, group[0]!);
  }

  private vector(text: string) {
    const v = new Array<number>(this.dims).fill(0);
    for (const raw of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (raw.length < 3) continue;
      const word = this.canonical.get(raw) ?? this.canonical.get(raw.replace(/s$/, "")) ?? raw.replace(/s$/, "");
      const h = createHash("sha1").update(word).digest();
      v[h.readUInt16BE(0) % this.dims]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  }

  async embedDocuments(texts: string[]) {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string) {
    return this.vector(text);
  }
}

export function toPgVector(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")}]`;
}

/**
 * Embeds chunks that have no embedding (or one from a different model).
 * Safe to run from several server instances at once (SKIP LOCKED).
 * Returns how many chunks were embedded.
 */
export async function indexPendingChunks(db: Db, embedder: Embedder, batchSize = 32): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; heading: string; text: string }>(
      `SELECT id, heading, text FROM chunks
        WHERE embedding IS NULL OR embedding_model IS DISTINCT FROM $1
        ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [embedder.model, batchSize],
    );
    if (rows.length) {
      const vectors = await embedder.embedDocuments(rows.map((r) => `${r.heading}\n${r.text}`.slice(0, 4000)));
      for (const [i, r] of rows.entries()) {
        await client.query("UPDATE chunks SET embedding = $2::vector, embedding_model = $3 WHERE id = $1", [r.id, toPgVector(vectors[i]!), embedder.model]);
      }
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Background loop: drains pending chunks, then polls. `poke()` wakes it after a write. */
export function startIndexer(db: Db, embedder: Embedder, log: (msg: string) => void = () => {}) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      let total = 0;
      for (let n = await indexPendingChunks(db, embedder); n > 0; n = await indexPendingChunks(db, embedder)) total += n;
      if (total) log(`embedded ${total} chunk(s) with ${embedder.model}`);
    } catch (err) {
      log(`embedding failed: ${(err as Error).message}`);
    } finally {
      running = false;
      if (!stopped) timer = setTimeout(tick, 5000);
    }
  }
  void tick();
  return {
    poke() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(tick, 200);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

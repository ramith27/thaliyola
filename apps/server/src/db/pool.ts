import pg from "pg";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

/** Candidates the HNSW index returns per query; semantic search oversamples this many before scope filters. */
export const VECTOR_CANDIDATES = 400;

export function createPool(connectionString: string): Db {
  // The index search list must be at least as long as the candidate list (set at connection start-up).
  const pool = new pg.Pool({ connectionString, max: 10, options: `-c hnsw.ef_search=${VECTOR_CANDIDATES}` });
  // A dropped connection (network blip, database restart or failover) must not crash the process. Idle clients
  // report it on the pool, checked-out ones (job locks) on the client; the pool discards the broken client and
  // the next query opens a new one.
  pool.on("error", (err) => console.error(`[db] idle connection lost: ${err.message}`));
  pool.on("connect", (client) => client.on("error", (err) => console.error(`[db] connection lost: ${err.message}`)));
  return pool;
}

/** Work waiting for a transaction (opened by withTx) to commit: run after COMMIT, dropped on ROLLBACK. */
const commitHooks = new WeakMap<pg.PoolClient, ((pool: Db) => void)[]>();

/**
 * For a client inside withTx: queues `fn` to run after COMMIT (with the pool; the client is released by then), never
 * if the transaction rolls back, and returns true. Returns false otherwise (the pool, or any other client): the
 * caller does the work itself.
 */
export function whenCommitted(db: Queryable, fn: (pool: Db) => void): boolean {
  const hooks = db instanceof pg.Pool ? undefined : commitHooks.get(db);
  if (!hooks) return false;
  hooks.push(fn);
  return true;
}

export async function withTx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  const hooks: ((pool: Db) => void)[] = [];
  commitHooks.set(client, hooks);
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    commitHooks.delete(client);
    for (const hook of hooks) {
      try {
        hook(db);
      } catch (err) {
        console.error(`[db] after-commit work failed: ${(err as Error).message}`);
      }
    }
    return result;
  } catch (err) {
    commitHooks.delete(client);
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

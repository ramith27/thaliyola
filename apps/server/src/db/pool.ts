import pg from "pg";

export type Db = pg.Pool;
export type Queryable = pg.Pool | pg.PoolClient;

/** Candidates the HNSW index returns per query; semantic search oversamples this many before scope filters. */
export const VECTOR_CANDIDATES = 400;

export function createPool(connectionString: string): Db {
  // The index search list must be at least as long as the candidate list (set at connection start-up).
  return new pg.Pool({ connectionString, max: 10, options: `-c hnsw.ef_search=${VECTOR_CANDIDATES}` });
}

export async function withTx<T>(db: Db, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

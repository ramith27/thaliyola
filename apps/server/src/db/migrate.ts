import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, withTx, type Db } from "./pool.js";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

/** Held while migrating, so replicas starting together (a rolling deploy) apply each migration once. */
const MIGRATION_LOCK = 7_402_210;

/**
 * Applies pending SQL migrations in filename order, each in its own transaction. Several processes may call it at
 * once: an advisory lock lets one migrate while the others wait, and they then find nothing left to apply.
 */
export async function migrate(db: Db, log: (msg: string) => void = () => {}): Promise<void> {
  // Thaliyola needs a UTF-8 database (normalize() and redaction fail otherwise); say so plainly instead of failing later.
  const enc = (await db.query<{ server_encoding: string }>("SHOW server_encoding")).rows[0]?.server_encoding;
  if (enc && enc !== "UTF8") console.warn(`[migrate] WARNING: the database uses ${enc}; Thaliyola needs UTF8. Convert it: see docs/install.md#the-database-must-be-utf-8`);
  const lock = await db.connect();
  try {
    await lock.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    try {
      await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const applied = new Set((await db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        await withTx(db, async (c) => {
          await c.query(sql);
          await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        });
        log(`applied ${file}`);
      }
    } finally {
      await lock.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    }
  } finally {
    lock.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const db = createPool(process.env.DATABASE_URL ?? "postgres://thaliyola:thaliyola@localhost:5432/thaliyola");
  migrate(db, console.log)
    .then(() => db.end())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/pool.js";
import type { Settings } from "../src/config.js";
import type { RequestContext } from "../src/core/context.js";
import { upsertUser } from "../src/core/users.js";
import { seedDemo } from "../src/scripts/demo-data.js";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://cairn:cairn@localhost:5432/cairn_test";

/** Fresh schema + demo data. */
export async function freshDb() {
  const db = createPool(TEST_DATABASE_URL);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const ids = await seedDemo(db);
  return { db, ids };
}

export const TEST_SETTINGS: Settings = {
  adminEmails: ["admin@example.com"],
  duplicateThreshold: 0.6,
  authMode: "dev",
  sessionTtlHours: 24,
  cookieSecure: "false",
  assetDir: mkdtempSync(path.join(tmpdir(), "cairn-assets-")),
  assetMaxBytes: 1024 * 1024,
  searchMinSimilarity: 0.6,
  duplicateSimilarity: 0.8,
};

/** Context for a human user (tester@example.com unless another email is given). */
export async function ctxFor(db: Db, extra: Partial<RequestContext> & { email?: string; service?: boolean } = {}): Promise<RequestContext> {
  const { email = "tester@example.com", service = false, ...rest } = extra;
  const actor = await upsertUser(db, { subject: `dev:${email}`, email, kind: service ? "service" : "human" });
  return { db, actor, settings: TEST_SETTINGS, ...rest };
}

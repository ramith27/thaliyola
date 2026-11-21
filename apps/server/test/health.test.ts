import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertHealth, systemHealth } from "../src/core/health.js";
import { recordJob, runJob } from "../src/core/jobs.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
const settings = { ...TEST_SETTINGS, adminEmails: ["admin@example.com"] };
const as = async (email: string) => ({ ...(await ctxFor(db, { email })), settings });

beforeAll(async () => {
  ({ db } = await freshDb());
  await db.query("UPDATE users SET approved_at = now() WHERE approved_at IS NULL");
});
afterAll(() => db.end());

describe("health", () => {
  it("is for Administrators: database, jobs, backups, activity", async () => {
    await expect(systemHealth(await as("someone@example.com"))).rejects.toThrow(/Administrators/);
    await runJob(db, "maintenance", 999_001, () => {}, async () => ({ stale: 0 }));
    await runJob(db, "sources", 999_002, () => {}, async () => {
      throw new Error("feed unreachable");
    });
    const h = await systemHealth(await as("admin@example.com"));
    expect(h.database).toMatchObject({ encoding: "UTF8", migration: expect.stringMatching(/^\d{3}_/) });
    expect(h.jobs.find((j) => j.name === "maintenance")).toMatchObject({ status: "ok", failures: 0, details: { stale: 0 } });
    expect(h.jobs.find((j) => j.name === "sources")).toMatchObject({ status: "failed", failures: 1, last_error: "feed unreachable" });
    expect(h.backups.note).toMatch(/No backup has reported/);
    expect(h.problems).toEqual([]);
  });

  it("flags stale backups, failed restore checks and jobs failing again and again, and tells admins once a day", async () => {
    await recordJob(db, "backup", { ok: true });
    await db.query("UPDATE job_runs SET last_success = now() - interval '2 days' WHERE name = 'backup'");
    await recordJob(db, "restore_check", { ok: false, error: "row counts differ" });
    for (let i = 0; i < 3; i++) await recordJob(db, "digests", { ok: false, error: "SMTP refused" });
    const h = await systemHealth(await as("admin@example.com"));
    expect(h.backups.stale).toBe(true);
    expect(h.problems).toEqual([
      "No successful backup in the last 36 hours.",
      "The last restore check failed: row counts differ.",
      "digests has failed 3 times in a row: SMTP refused",
    ]);
    await as("admin@example.com");
    await db.query("UPDATE users SET approved_at = now() WHERE approved_at IS NULL");
    expect(await alertHealth(db, settings)).toBe(3);
    const n = (await db.query("SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'admin@example.com' AND n.kind = 'system' ORDER BY 1")).rows.map((r) => r.title);
    expect(n).toEqual(["A Thaliyola job keeps failing: digests", "Thaliyola hasn't been backed up", "The backup restore check failed"]);
    expect(await alertHealth(db, settings)).toBe(0);
  });
});

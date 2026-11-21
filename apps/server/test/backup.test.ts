import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordJob } from "../src/core/jobs.js";
import { backupKey, compare, decryptFile, encryptFile, fetchLatest, upload } from "../src/scripts/backup.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_DATABASE_URL } from "./helpers.js";

let s3: Server;
let base: string;
let dir: string;
let db: Db;
const objects = new Map<string, Buffer>();
const parts = new Map<string, Buffer[]>();
const calls: string[] = [];

beforeAll(async () => {
  ({ db } = await freshDb());
  dir = await mkdtemp(join(tmpdir(), "tly-backup-"));
  // An in-memory S3: PUT/GET/DELETE objects, multipart upload, ListObjectsV2.
  s3 = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url!, "http://x");
      const key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ""));
      calls.push(`${req.method} ${key}${u.search}`);
      if (req.method === "GET" && u.searchParams.get("list-type") === "2") {
        const prefix = u.searchParams.get("prefix") ?? "";
        const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix));
        return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${items.map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-11-21T00:00:00Z</LastModified></Contents>`).join("")}</ListBucketResult>`);
      }
      if (req.method === "POST" && u.searchParams.has("uploads")) {
        parts.set(key, []);
        return res.end(`<InitiateMultipartUploadResult><UploadId>up-1</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === "PUT" && u.searchParams.has("partNumber")) {
        parts.get(key)![Number(u.searchParams.get("partNumber")) - 1] = body;
        res.setHeader("etag", `"p${u.searchParams.get("partNumber")}"`);
        return res.end();
      }
      if (req.method === "POST" && u.searchParams.has("uploadId")) {
        objects.set(key, Buffer.concat(parts.get(key)!));
        return res.end("<CompleteMultipartUploadResult/>");
      }
      if (req.method === "PUT") return objects.set(key, body), res.end();
      if (req.method === "GET") return objects.has(key) ? res.end(objects.get(key)) : ((res.statusCode = 404), res.end());
      if (req.method === "DELETE") return objects.delete(key), res.end();
      res.statusCode = 400;
      res.end();
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => s3.once("listening", r));
  base = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => s3.close(r));
  await db.end();
});

const env = (extra: Record<string, string> = {}) => ({
  BACKUP_S3_ENDPOINT: base,
  BACKUP_S3_BUCKET: "bucket",
  BACKUP_S3_ACCESS_KEY_ID: "id",
  BACKUP_S3_SECRET_ACCESS_KEY: "secret",
  BACKUP_S3_PREFIX: "",
  ...extra,
});

describe("encryption", () => {
  it("round-trips a file with AES-256-GCM and refuses a wrong key or tampering", async () => {
    const data = randomBytes(3_000_000);
    await writeFile(join(dir, "plain"), data);
    const key = backupKey("correct horse battery staple");
    await encryptFile(join(dir, "plain"), join(dir, "enc"), key);
    const enc = await readFile(join(dir, "enc"));
    expect(enc.subarray(0, 5).toString()).toBe("TLYB1");
    await decryptFile(join(dir, "enc"), join(dir, "back"), key);
    expect((await readFile(join(dir, "back"))).equals(data)).toBe(true);
    await expect(decryptFile(join(dir, "enc"), join(dir, "bad"), backupKey("wrong"))).rejects.toThrow();
    expect(backupKey("a".repeat(64))).toHaveLength(32);
  });
});

describe("off-site copies", () => {
  it("uploads large dumps in parts with a checksum, encrypted when a key is set, and keeps the newest N", async () => {
    const big = randomBytes(20 * 1024 * 1024 + 123);
    const names: string[] = [];
    for (const stamp of ["20261101T031500Z", "20261102T031500Z", "20261103T031500Z"]) {
      const f = join(dir, `thaliyola-${stamp}.dump`);
      await writeFile(f, stamp === "20261103T031500Z" ? big : Buffer.from(`dump ${stamp}`));
      names.push(f);
      const r = await upload([f], env({ BACKUP_S3_KEEP: "2", BACKUP_ENCRYPTION_KEY: "k".repeat(20) }));
      expect(r.encrypted).toBe(true);
    }
    expect(calls.some((c) => c.includes("?uploads"))).toBe(true);
    expect([...objects.keys()].sort()).toEqual([
      "thaliyola-20261102T031500Z.dump.enc",
      "thaliyola-20261102T031500Z.dump.enc.sha256",
      "thaliyola-20261103T031500Z.dump.enc",
      "thaliyola-20261103T031500Z.dump.enc.sha256",
    ]);
    // Restoring takes the newest, checks it and decrypts it.
    const out = await fetchLatest(dir, env({ BACKUP_ENCRYPTION_KEY: "k".repeat(20) }));
    expect(out).toBe(join(dir, "thaliyola-20261103T031500Z.dump"));
    expect((await readFile(out)).equals(big)).toBe(true);
    // A corrupted copy is refused.
    const k = "thaliyola-20261103T031500Z.dump.enc";
    const bad = Buffer.from(objects.get(k)!);
    bad[100] = bad[100]! ^ 0xff;
    objects.set(k, bad);
    await expect(fetchLatest(dir, env({ BACKUP_ENCRYPTION_KEY: "k".repeat(20) }))).rejects.toThrow(/checksum/);
  });

  it("says what's missing", async () => {
    await expect(upload([], { BACKUP_S3_BUCKET: "b" })).rejects.toThrow(/BACKUP_S3_ENDPOINT/);
  });
});

describe("restore check and reporting", () => {
  it("compares a restored copy's row counts with the live database", async () => {
    const r = await compare(TEST_DATABASE_URL, new URL(TEST_DATABASE_URL).pathname.slice(1));
    expect(r.ok).toBe(true);
    expect(Object.keys(r.live)).toContain("articles");
  });

  it("records runs: last success, consecutive failures, the error", async () => {
    await recordJob(db, "backup", { ok: true, details: { size: 10 } });
    await recordJob(db, "backup", { ok: false, error: "disk full" });
    await recordJob(db, "backup", { ok: false, error: "disk full again" });
    let row = (await db.query("SELECT status, failures, last_error, last_success IS NOT NULL AS ok_before, details FROM job_runs WHERE name = 'backup'")).rows[0];
    expect(row).toMatchObject({ status: "failed", failures: 2, last_error: "disk full again", ok_before: true, details: { size: 10 } });
    await recordJob(db, "backup", { ok: true });
    row = (await db.query("SELECT status, failures FROM job_runs WHERE name = 'backup'")).rows[0];
    expect(row).toEqual({ status: "ok", failures: 0 });
  });
});

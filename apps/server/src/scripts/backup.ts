/**
 * Off-site backups and restore checks, for deploy/native/backup.sh and restore-check.sh.
 *
 *   node dist/scripts/backup.js upload <file>...          copy backup files to BACKUP_S3_* (encrypted with BACKUP_ENCRYPTION_KEY when set),
 *                                                         with a .sha256 beside each, keeping the newest BACKUP_S3_KEEP (30) backups there
 *   node dist/scripts/backup.js fetch-latest <dir>        download the newest database dump (checked, decrypted) and print its path
 *   node dist/scripts/backup.js decrypt <in> <out>        decrypt one file made by upload
 *   node dist/scripts/backup.js compare <database>        compare row counts of a restored copy with the live database
 *   node dist/scripts/backup.js report <job> ok|failed [message]   record a run for Admin › System › Health
 *
 * Reads DATABASE_URL like the server. Nothing here needs the AWS SDK.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { recordJob } from "../core/jobs.js";
import { S3Client } from "../core/s3-sign.js";

const MAGIC = Buffer.from("TLYB1");

export function backupKey(secret: string): Buffer {
  const s = secret.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, "hex");
  const b = Buffer.from(s, "base64");
  if (b.length === 32 && /^[A-Za-z0-9+/=_-]{43,44}$/.test(s)) return b;
  return scryptSync(s, "thaliyola-backup", 32);
}

/** AES-256-GCM, streamed: TLYB1 | 12-byte IV | ciphertext | 16-byte tag. */
export async function encryptFile(input: string, output: string, key: Buffer) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const out = createWriteStream(output, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(createReadStream(input), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => out.end(cipher.getAuthTag(), (err?: Error | null) => (err ? reject(err) : resolve())));
}

export async function decryptFile(input: string, output: string, key: Buffer) {
  const size = (await stat(input)).size;
  const fh = await open(input, "r");
  const head = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  await fh.read(head, 0, head.length, 0);
  await fh.read(tag, 0, 16, size - 16);
  await fh.close();
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${input} isn't a Thaliyola encrypted backup`);
  const decipher = createDecipheriv("aes-256-gcm", key, head.subarray(MAGIC.length));
  decipher.setAuthTag(tag);
  await pipeline(createReadStream(input, { start: head.length, end: size - 17 }), decipher, createWriteStream(output, { mode: 0o600 }));
}

const sha256File = async (path: string) => {
  const h = createHash("sha256");
  await pipeline(createReadStream(path), h);
  return h.digest("hex");
};

export function s3FromEnv(env: NodeJS.ProcessEnv = process.env, f?: typeof fetch): S3Client | null {
  if (!env.BACKUP_S3_BUCKET) return null;
  const need = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"].filter((k) => !env[k]);
  if (need.length) throw new Error(`set ${need.join(", ")} (BACKUP_S3_BUCKET is set)`);
  return new S3Client({
    endpoint: env.BACKUP_S3_ENDPOINT!,
    region: env.BACKUP_S3_REGION || "auto",
    bucket: env.BACKUP_S3_BUCKET,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID!,
    secretAccessKey: env.BACKUP_S3_SECRET_ACCESS_KEY!,
    prefix: env.BACKUP_S3_PREFIX ?? "thaliyola-backups",
    pathStyle: env.BACKUP_S3_PATH_STYLE !== "false",
    fetch: f,
  });
}

/** Backup sets in the bucket ("thaliyola-<stamp>"), newest first. */
function sets(keys: { key: string }[]) {
  const stamps = [...new Set(keys.map((k) => /^thaliyola-(\d{8}T\d{6}Z)/.exec(k.key)?.[1]).filter(Boolean) as string[])];
  return stamps.sort().reverse();
}

export async function upload(files: string[], env: NodeJS.ProcessEnv = process.env, f?: typeof fetch) {
  const s3 = s3FromEnv(env, f);
  if (!s3) throw new Error("BACKUP_S3_BUCKET isn't set");
  const key = env.BACKUP_ENCRYPTION_KEY ? backupKey(env.BACKUP_ENCRYPTION_KEY) : null;
  let bytes = 0;
  const uploaded: string[] = [];
  for (const file of files) {
    let path = file;
    let name = basename(file);
    if (key) {
      path = `${file}.enc`;
      name = `${name}.enc`;
      await encryptFile(file, path, key);
    }
    try {
      const sum = await sha256File(path);
      await s3.uploadFile(name, path);
      await s3.putObject(`${name}.sha256`, Buffer.from(`${sum}  ${name}\n`));
      bytes += (await stat(path)).size;
      uploaded.push(name);
    } finally {
      if (key) await unlink(path).catch(() => undefined);
    }
  }
  // Remote retention: the newest BACKUP_S3_KEEP sets.
  const keep = Math.max(Number(env.BACKUP_S3_KEEP ?? 30) || 30, 1);
  const all = await s3.list("thaliyola-");
  const old = sets(all).slice(keep);
  for (const o of all.filter((k) => old.some((stamp) => k.key.startsWith(`thaliyola-${stamp}`)))) await s3.deleteObject(o.key);
  return { uploaded, bytes, removed: old.length, location: `s3://${env.BACKUP_S3_BUCKET}/${s3.fullKey("")}`, encrypted: !!key };
}

export async function fetchLatest(dir: string, env: NodeJS.ProcessEnv = process.env, f?: typeof fetch) {
  const s3 = s3FromEnv(env, f);
  if (!s3) throw new Error("BACKUP_S3_BUCKET isn't set");
  const all = await s3.list("thaliyola-");
  const newest = sets(all)[0];
  const dump = newest && all.find((k) => k.key === `thaliyola-${newest}.dump` || k.key === `thaliyola-${newest}.dump.enc`);
  if (!dump) throw new Error("no database dump in the bucket");
  const data = await s3.getObject(dump.key);
  const sum = (await s3.getObject(`${dump.key}.sha256`).catch(() => Buffer.from(""))).toString().split(/\s+/)[0];
  if (sum && createHash("sha256").update(data).digest("hex") !== sum) throw new Error(`${dump.key} doesn't match its checksum`);
  const out = join(dir, dump.key);
  await writeFile(out, data, { mode: 0o600 });
  if (!dump.key.endsWith(".enc")) return out;
  if (!env.BACKUP_ENCRYPTION_KEY) throw new Error("the backup is encrypted: set BACKUP_ENCRYPTION_KEY");
  const plain = out.replace(/\.enc$/, "");
  await decryptFile(out, plain, backupKey(env.BACKUP_ENCRYPTION_KEY));
  await unlink(out);
  return plain;
}

/** Row counts of the key tables, live vs a restored copy: the copy must have them all, not far behind the live data. */
export async function compare(liveUrl: string, checkDb: string) {
  const checkUrl = new URL(liveUrl);
  checkUrl.pathname = `/${checkDb}`;
  const tables = ["users", "scopes", "articles", "findings", "revisions", "item_versions", "schema_migrations"];
  const count = async (url: string) => {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = Number((await c.query(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
      return out;
    } finally {
      await c.end();
    }
  };
  const [live, check] = await Promise.all([count(liveUrl), count(checkUrl.href)]);
  const problems = tables.filter((t) => (live[t]! > 0 && check[t] === 0) || check[t]! > live[t]! * 1.05 + 10 || check[t]! < live[t]! * 0.8 - 10);
  return { ok: problems.length === 0, live, check, problems };
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const db = () => new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  if (cmd === "upload") {
    const pool = db();
    try {
      const r = await upload(args);
      await recordJob(pool, "backup_offsite", { ok: true, details: r });
      console.log(`uploaded ${r.uploaded.join(", ")} (${Math.round(r.bytes / 1e6)} MB) to ${r.location}${r.encrypted ? ", encrypted" : ""}; removed ${r.removed} old backup(s)`);
    } catch (err) {
      await recordJob(pool, "backup_offsite", { ok: false, error: (err as Error).message }).catch(() => undefined);
      throw err;
    } finally {
      await pool.end();
    }
  } else if (cmd === "fetch-latest") {
    console.log(await fetchLatest(args[0] ?? "."));
  } else if (cmd === "decrypt") {
    if (!process.env.BACKUP_ENCRYPTION_KEY) throw new Error("set BACKUP_ENCRYPTION_KEY");
    await decryptFile(args[0]!, args[1]!, backupKey(process.env.BACKUP_ENCRYPTION_KEY));
  } else if (cmd === "compare") {
    const r = await compare(process.env.DATABASE_URL!, args[0]!);
    console.log(JSON.stringify(r));
    process.exitCode = r.ok ? 0 : 1;
  } else if (cmd === "report") {
    const pool = db();
    try {
      const [name, status, ...msg] = args;
      const details = process.env.JOB_DETAILS ? (JSON.parse(process.env.JOB_DETAILS) as Record<string, unknown>) : undefined;
      await recordJob(pool, name!, { ok: status === "ok", error: status === "ok" ? null : msg.join(" ") || "failed", details: details ?? (msg.length && status === "ok" ? { message: msg.join(" ") } : undefined) });
    } finally {
      await pool.end();
    }
  } else {
    console.error("commands: upload | fetch-latest | decrypt | compare | report");
    process.exitCode = 2;
  }
}

if (process.argv[1] && basename(process.argv[1]).startsWith("backup.")) {
  main().catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}

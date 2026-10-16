import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { audit } from "./audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { canApprove } from "./permissions.js";
import { redact } from "./redaction.js";
import { findItem } from "./writes.js";

/**
 * Screenshots, exported frames, design-token files and specs attached to an
 * article or finding. Blobs are content-addressed (sha256) in a store; the
 * `assets` table holds metadata. Images can't be redacted, so uploads are
 * audited and can be removed by the uploader or a scope owner.
 */

export interface AssetStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

/** Local-disk store; an S3-compatible store can implement the same interface. */
export class LocalAssetStore implements AssetStore {
  constructor(private readonly dir: string) {}

  private file(key: string) {
    if (!/^[a-f0-9]{2}\/[a-f0-9]{64}$/.test(key)) throw new ValidationError("bad asset key");
    return path.join(this.dir, key);
  }

  async put(key: string, data: Buffer) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  async get(key: string) {
    return readFile(this.file(key));
  }
}

const stores = new Map<string, AssetStore>();
function storeFor(ctx: RequestContext): AssetStore {
  let store = stores.get(ctx.settings.assetDir);
  if (!store) stores.set(ctx.settings.assetDir, (store = new LocalAssetStore(ctx.settings.assetDir)));
  return store;
}

/** Allowed types, each with a check that the bytes really are that type. */
const MIME_TYPES: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => b.subarray(0, 4).toString("latin1") === "GIF8",
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
  "application/pdf": (b) => b.subarray(0, 5).toString("latin1") === "%PDF-",
  "application/json": (b) => {
    try {
      JSON.parse(b.toString("utf8"));
      return true;
    } catch {
      return false;
    }
  },
  "text/plain": (b) => !b.includes(0),
  "text/markdown": (b) => !b.includes(0),
};
export const ASSET_MIME_TYPES = Object.keys(MIME_TYPES) as [string, ...string[]];
const TEXT_TYPES = new Set(["application/json", "text/plain", "text/markdown"]);

export interface AssetMeta {
  id: string;
  filename: string;
  mime: string;
  size_bytes: number;
  alt_text: string;
  created_at: string;
  uploaded_by: string | null;
}

export async function uploadAsset(
  ctx: RequestContext,
  input: { target_id: string; filename: string; mime: string; data: Buffer; alt_text?: string },
) {
  const item = await findItem(ctx.db, input.target_id);
  if (item.status === "rejected") throw new ValidationError(`${item.kind} is rejected`);
  const check = MIME_TYPES[input.mime];
  if (!check) throw new ValidationError(`unsupported type ${input.mime}; allowed: ${ASSET_MIME_TYPES.join(", ")}`);
  if (!input.data.length) throw new ValidationError("file is empty");
  if (input.data.length > ctx.settings.assetMaxBytes) throw new ValidationError(`file is larger than ${ctx.settings.assetMaxBytes} bytes`);
  if (!check(input.data)) throw new ValidationError(`file content is not ${input.mime}`);

  // Text files (token JSON, specs) are redacted like any other write.
  let data = input.data;
  let redactions: { kind: string; count: number }[] = [];
  if (TEXT_TYPES.has(input.mime)) {
    const r = redact(data.toString("utf8"));
    data = Buffer.from(r.text, "utf8");
    redactions = r.redactions;
  }
  const filename = path.basename(input.filename).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";
  const alt = redact((input.alt_text ?? "").trim()).text.slice(0, 500);

  const sha256 = createHash("sha256").update(data).digest("hex");
  const key = `${sha256.slice(0, 2)}/${sha256}`;
  await storeFor(ctx).put(key, data);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO assets (scope_id, target_kind, target_id, mime, sha256, size_bytes, storage_key, alt_text, filename, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [item.scope_id, item.kind, item.id, input.mime, sha256, data.length, key, alt, filename, ctx.actor.id],
  );
  await audit(ctx.db, ctx.actor.id, "upload_asset", item.id);
  return { asset_id: rows[0]!.id, filename, mime: input.mime, size_bytes: data.length, redactions };
}

export async function listAssets(ctx: RequestContext, targetId: string): Promise<AssetMeta[]> {
  const { rows } = await ctx.db.query<AssetMeta>(
    `SELECT a.id, a.filename, a.mime, a.size_bytes::int AS size_bytes, a.alt_text, a.created_at, coalesce(u.email, u.subject) AS uploaded_by
       FROM assets a LEFT JOIN users u ON u.id = a.created_by
      WHERE a.target_id = $1 AND a.deleted_at IS NULL ORDER BY a.created_at`,
    [targetId],
  );
  return rows;
}

export async function getAsset(ctx: RequestContext, id: string): Promise<{ meta: AssetMeta & { target_id: string; target_kind: string }; data: Buffer }> {
  const { rows } = await ctx.db.query(
    `SELECT a.id, a.filename, a.mime, a.size_bytes::int AS size_bytes, a.alt_text, a.created_at, a.storage_key, a.target_id, a.target_kind,
            coalesce(u.email, u.subject) AS uploaded_by
       FROM assets a LEFT JOIN users u ON u.id = a.created_by WHERE a.id = $1 AND a.deleted_at IS NULL`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`asset ${id}`);
  const { storage_key, ...meta } = row;
  return { meta, data: await storeFor(ctx).get(storage_key) };
}

export async function deleteAsset(ctx: RequestContext, id: string) {
  const { rows } = await ctx.db.query("SELECT scope_id, created_by, target_id FROM assets WHERE id = $1 AND deleted_at IS NULL", [id]);
  const row = rows[0];
  if (!row) throw new NotFoundError(`asset ${id}`);
  if (row.created_by !== ctx.actor.id && !(await canApprove(ctx, row.scope_id))) {
    throw new ForbiddenError("only the uploader or a scope owner can remove an asset");
  }
  await ctx.db.query("UPDATE assets SET deleted_at = now() WHERE id = $1", [id]);
  await audit(ctx.db, ctx.actor.id, "delete_asset", row.target_id);
  return { asset_id: id, deleted: true };
}

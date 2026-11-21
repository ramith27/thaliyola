import { createHash, createHmac } from "node:crypto";
import { open } from "node:fs/promises";

/**
 * AWS Signature V4 for S3-compatible stores (AWS, Cloudflare R2, MinIO, Backblaze B2, Garage…) on node:crypto, and a
 * small client with what backups need beyond whole-object PUT and GET: multipart upload of large files read from disk
 * part by part, listing a prefix, and deleting. The asset store (s3.ts) signs with the same function.
 */

export interface S3Target {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  /** Path-style URLs (endpoint/bucket/key). Most self-hosted servers need this. */
  pathStyle?: boolean;
  fetch?: typeof fetch;
}

const sha256hex = (data: string | Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
/** RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone). */
export const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Headers that sign a request: the canonical query string is the URL's parameters, sorted and encoded. */
export function signS3(cfg: Pick<S3Target, "region" | "accessKeyId" | "secretAccessKey">, method: string, url: URL, payloadHash: string, now = new Date()): Record<string, string> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const signed = Object.keys(headers).sort();
  const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join("");
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [encodeSegment(k), encodeSegment(v)] as const)
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [method, url.pathname, query, canonicalHeaders, signed.join(";"), payloadHash].join("\n");
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), cfg.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const { host: _host, ...rest } = headers;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}` };
}

/** A part size every S3 accepts (5 MiB minimum, 10,000 parts maximum): 16 MiB, larger for very large files. */
const partSize = (size: number) => Math.max(16 * 1024 * 1024, Math.ceil(size / 9_000));

export class S3Client {
  private readonly endpoint: URL;
  private readonly f: typeof fetch;
  constructor(private readonly cfg: S3Target) {
    this.endpoint = new URL(cfg.endpoint);
    this.f = cfg.fetch ?? fetch;
  }

  /** The object's URL; with no key, the bucket's (for listing). */
  url(key?: string, query: Record<string, string> = {}): URL {
    const u = new URL(this.endpoint.href);
    const base = u.pathname.replace(/\/+$/, "");
    const encoded = key === undefined ? "" : `/${this.fullKey(key).split("/").map(encodeSegment).join("/")}`;
    if (this.cfg.pathStyle ?? true) u.pathname = `${base}/${encodeSegment(this.cfg.bucket)}${encoded}`;
    else {
      u.hostname = `${this.cfg.bucket}.${u.hostname}`;
      u.pathname = `${base}${encoded}` || "/";
    }
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  fullKey(key: string) {
    return `${this.cfg.prefix ? `${this.cfg.prefix.replace(/\/+$/, "")}/` : ""}${key}`;
  }

  private async send(method: string, url: URL, body?: Buffer | Uint8Array, extra: Record<string, string> = {}) {
    const hash = sha256hex(body ?? "");
    const res = await this.f(url, { method, headers: { ...signS3(this.cfg, method, url, hash), ...(body ? { "content-length": String(body.length) } : {}), ...extra }, body: body ? new Uint8Array(body) : undefined });
    if (!res.ok) throw new Error(`S3 ${method} ${url.pathname} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async putObject(key: string, data: Buffer) {
    await this.send("PUT", this.url(key), data);
  }

  async getObject(key: string): Promise<Buffer> {
    return Buffer.from(await (await this.send("GET", this.url(key))).arrayBuffer());
  }

  async deleteObject(key: string) {
    const url = this.url(key);
    const res = await this.f(url, { method: "DELETE", headers: signS3(this.cfg, "DELETE", url, sha256hex("")) });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
  }

  /** Keys (relative to the prefix) under a sub-prefix, with size and time, all pages. */
  async list(sub = ""): Promise<{ key: string; size: number; modified: string }[]> {
    const out: { key: string; size: number; modified: string }[] = [];
    let token: string | undefined;
    const prefix = this.fullKey(sub);
    const strip = this.cfg.prefix ? `${this.cfg.prefix.replace(/\/+$/, "")}/` : "";
    do {
      const xml = await (await this.send("GET", this.url(undefined, { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) }))).text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1]!)?.[1] ?? "";
        out.push({ key: unxml(k).slice(strip.length), size: Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? 0), modified: /<LastModified>([^<]+)</.exec(m[1]!)?.[1] ?? "" });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(/<NextContinuationToken>([^<]+)</.exec(xml)?.[1] ?? "") || undefined : undefined;
    } while (token);
    return out;
  }

  /** Uploads a file from disk: one PUT when small, else multipart (read part by part, never all in memory). */
  async uploadFile(key: string, path: string) {
    const fh = await open(path, "r");
    try {
      const size = (await fh.stat()).size;
      const part = partSize(size);
      if (size <= part) {
        const buf = Buffer.alloc(size);
        await fh.read(buf, 0, size, 0);
        return this.putObject(key, buf);
      }
      const init = await (await this.send("POST", this.url(key, { uploads: "" }))).text();
      const uploadId = unxml(/<UploadId>([^<]+)<\/UploadId>/.exec(init)?.[1] ?? "");
      if (!uploadId) throw new Error("S3 didn't start the multipart upload");
      const etags: string[] = [];
      try {
        for (let n = 1, offset = 0; offset < size; n++, offset += part) {
          const len = Math.min(part, size - offset);
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, offset);
          const res = await this.send("PUT", this.url(key, { partNumber: String(n), uploadId }), buf);
          etags.push(res.headers.get("etag") ?? "");
        }
        const done = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
        await this.send("POST", this.url(key, { uploadId }), Buffer.from(done), { "content-type": "application/xml" });
      } catch (err) {
        const abort = this.url(key, { uploadId });
        await this.f(abort, { method: "DELETE", headers: signS3(this.cfg, "DELETE", abort, sha256hex("")) }).catch(() => undefined);
        throw err;
      }
    } finally {
      await fh.close();
    }
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

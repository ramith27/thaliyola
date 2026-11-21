import { createHash } from "node:crypto";
import { encodeSegment, signS3 } from "./s3-sign.js";
import { NotFoundError } from "./context.js";
import type { AssetStore } from "./assets.js";

/**
 * S3-compatible object store (AWS S3, Cloudflare R2, MinIO, Garage, …) with
 * AWS Signature V4 implemented on node:crypto, to avoid pulling in the AWS SDK.
 * Only what assets need: PUT and GET of whole objects.
 */
export interface S3Config {
  endpoint: string; // e.g. https://s3.eu-west-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
  /** Path-style URLs (endpoint/bucket/key). Most self-hosted servers need this. */
  pathStyle?: boolean;
}

const sha256hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export class S3AssetStore implements AssetStore {
  private readonly endpoint: URL;

  constructor(private readonly cfg: S3Config) {
    this.endpoint = new URL(cfg.endpoint);
  }

  private objectUrl(key: string): URL {
    const objectKey = `${this.cfg.prefix ? `${this.cfg.prefix.replace(/\/+$/, "")}/` : ""}${key}`;
    const encodedKey = objectKey.split("/").map(encodeSegment).join("/");
    const url = new URL(this.endpoint.href);
    const basePath = url.pathname.replace(/\/+$/, "");
    if (this.cfg.pathStyle ?? true) {
      url.pathname = `${basePath}/${encodeSegment(this.cfg.bucket)}/${encodedKey}`;
    } else {
      url.hostname = `${this.cfg.bucket}.${url.hostname}`;
      url.pathname = `${basePath}/${encodedKey}`;
    }
    return url;
  }

  /** Signs a request (SigV4, payload hash in x-amz-content-sha256); shared with backups (s3-sign.ts). */
  signedHeaders(method: string, url: URL, body: Buffer | null, now = new Date()): Record<string, string> {
    return signS3(this.cfg, method, url, sha256hex(body ?? ""), now);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const url = this.objectUrl(key);
    const res = await fetch(url, {
      method: "PUT",
      headers: { ...this.signedHeaders("PUT", url, data), "content-length": String(data.length) },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  async get(key: string): Promise<Buffer> {
    const url = this.objectUrl(key);
    const res = await fetch(url, { headers: this.signedHeaders("GET", url, null) });
    if (res.status === 404) throw new NotFoundError(`stored file ${key}`);
    if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const url = this.objectUrl(key);
    const res = await fetch(url, { method: "DELETE", headers: this.signedHeaders("DELETE", url, null) });
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

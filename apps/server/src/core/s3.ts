import { createHash, createHmac } from "node:crypto";
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
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
// RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone).
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

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

  /** Signs a request (SigV4, payload hash in x-amz-content-sha256). */
  signedHeaders(method: string, url: URL, body: Buffer | null, now = new Date()): Record<string, string> {
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256hex(body ?? "");
    const host = url.host;
    const headers: Record<string, string> = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const signed = Object.keys(headers).sort();
    const canonicalHeaders = signed.map((h) => `${h}:${headers[h]}\n`).join("");
    const canonicalRequest = [method, url.pathname, "", canonicalHeaders, signed.join(";"), payloadHash].join("\n");
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
    const kDate = hmac(`AWS4${this.cfg.secretAccessKey}`, date);
    const kSigning = hmac(hmac(hmac(kDate, this.cfg.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
    const { host: _host, ...rest } = headers;
    return {
      ...rest,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signed.join(";")}, Signature=${signature}`,
    };
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
}

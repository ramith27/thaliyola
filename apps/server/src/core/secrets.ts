import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ValidationError } from "./context.js";

/**
 * Secrets at rest: AES-256-GCM with the server's CONNECTIONS_KEY (32 random bytes, base64; a Kubernetes Secret in
 * production). A sealed value is "v1$iv$tag$ciphertext" (base64url), self-describing like auth/passwords.ts so the
 * format can change later. Each value is bound to what it belongs to (associated data, e.g. "connection:<id>"), so a
 * sealed value copied onto another row doesn't open. Opening tries CONNECTIONS_KEY, then CONNECTIONS_KEY_OLD, so the
 * key can be rotated: set the new key, keep the old one as CONNECTIONS_KEY_OLD until everything is re-sealed.
 *
 * Secrets are opened only inside the job or tool that uses them and are never sent to the UI or to agents.
 */

export interface SecretKeys {
  key?: Buffer;
  oldKey?: Buffer;
}

/** The key is missing or doesn't open a stored secret (a 400 for API callers: someone has to act on it). */
export class SecretsUnavailableError extends ValidationError {}

const VERSION = "v1";
const IV_BYTES = 12;

/** Decodes a key from base64 (or base64url); it must be exactly 32 bytes. */
export function parseKey(value: string, name = "CONNECTIONS_KEY"): Buffer {
  const s = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) throw new Error(`${name} must be base64 (e.g. openssl rand -base64 32)`);
  const key = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded (e.g. openssl rand -base64 32); it decodes to ${key.length}`);
  return key;
}

export function canSeal(keys: SecretKeys | undefined): boolean {
  return !!keys?.key;
}

export function seal(plain: string, keys: SecretKeys | undefined, aad: string): string {
  if (!keys?.key) throw new SecretsUnavailableError("secrets can't be stored: CONNECTIONS_KEY isn't set on this server");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join("$");
}

function tryOpen(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad: string): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Opens a sealed value. `rotated` is true when only CONNECTIONS_KEY_OLD opened it (re-seal it with the current key).
 * Tampered values, values sealed for something else, and unknown keys all fail the same way.
 */
export function open(blob: string, keys: SecretKeys | undefined, aad: string): { plain: string; rotated: boolean } {
  if (!keys?.key && !keys?.oldKey) throw new SecretsUnavailableError("stored secrets can't be read: CONNECTIONS_KEY isn't set on this server");
  const [version, iv, tag, ct] = blob.split("$");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new SecretsUnavailableError("the stored secret isn't in a format this server reads");
  const parts = [Buffer.from(iv, "base64url"), Buffer.from(tag, "base64url"), Buffer.from(ct, "base64url")] as const;
  if (parts[0].length !== IV_BYTES || parts[1].length !== 16) throw new SecretsUnavailableError("the stored secret is damaged");
  if (keys.key) {
    const plain = tryOpen(keys.key, ...parts, aad);
    if (plain !== null) return { plain, rotated: false };
  }
  if (keys.oldKey) {
    const plain = tryOpen(keys.oldKey, ...parts, aad);
    if (plain !== null) return { plain, rotated: true };
  }
  throw new SecretsUnavailableError("the stored secret can't be opened with CONNECTIONS_KEY (or CONNECTIONS_KEY_OLD): was the key changed? Enter the secret again");
}

export function sealJson(value: Record<string, string>, keys: SecretKeys | undefined, aad: string): string {
  return seal(JSON.stringify(value), keys, aad);
}

export function openJson(blob: string, keys: SecretKeys | undefined, aad: string): { value: Record<string, string>; rotated: boolean } {
  const { plain, rotated } = open(blob, keys, aad);
  const value = JSON.parse(plain) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecretsUnavailableError("the stored secret is damaged");
  return { value: value as Record<string, string>, rotated };
}

/**
 * What the UI may show of a stored token or key: the last 4 characters of a long one (12 or more), so people can tell
 * which one is stored; nothing for short or multi-line ones. Callers use it only for random tokens and keys, never for
 * passwords or passphrases, whose tail would give too much away (SecretSpec.showTail).
 */
export function hintOf(secret: string): string {
  const s = secret.trim();
  return s.length >= 12 && !s.includes("\n") ? s.slice(-4) : "";
}

/**
 * The ways a secret can appear in text: as it is, JSON-escaped, and URL-encoded the ways a URL carries it
 * (encodeURIComponent, encodeURI, and the form encoding URLSearchParams uses, with + or %20 for spaces), each also
 * with lower-case hex escapes, as servers that echo a URL back often rewrite them.
 */
export function secretForms(s: string): string[] {
  const form = new URLSearchParams({ k: s }).toString().slice(2);
  const tryEncode = (f: (x: string) => string) => {
    try {
      return f(s);
    } catch {
      return s; // A lone surrogate: URL encoding throws; the value is scrubbed as it is.
    }
  };
  const encoded = [tryEncode(encodeURIComponent), tryEncode(encodeURI), form, form.replace(/\+/g, "%20")];
  const lower = encoded.map((e) => e.replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase()));
  // Longest first, so a longer form isn't half-replaced by a shorter one inside it.
  return [...new Set([s, JSON.stringify(s).slice(1, -1), ...encoded, ...lower])].sort((a, b) => b.length - a.length);
}

/** Replaces any secret value (and its JSON- or URL-encoded forms) found in a message, e.g. a driver error. */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const form of secretForms(s)) out = out.split(form).join("[secret]");
  }
  return out;
}

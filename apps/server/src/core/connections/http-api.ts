import { ValidationError } from "../context.js";
import { call, failWith } from "./remote.js";
import type { ConnTarget, DriverEnv, TestResult } from "./types.js";

/**
 * Custom and external HTTP APIs. Authentication is added here from the sealed secret (a bearer token, a custom
 * header, basic auth or a query parameter), so agents never see it.
 */

export const AUTH_TYPES = ["none", "bearer", "header", "basic", "query"] as const;

/** The request with the connection's authentication added. */
export function withAuth(c: ConnTarget, url: URL, headers: Record<string, string> = {}): { url: URL; headers: Record<string, string> } {
  const value = c.secret.auth_value ?? "";
  const out = { ...headers };
  const u = new URL(url);
  switch (c.config.auth_type) {
    case "bearer":
      out.authorization = `Bearer ${value}`;
      break;
    case "header":
      out[c.config.auth_name!.toLowerCase()] = value;
      break;
    case "basic":
      out.authorization = `Basic ${Buffer.from(`${c.config.username ?? ""}:${value}`).toString("base64")}`;
      break;
    case "query":
      u.searchParams.set(c.config.auth_name!, value);
      break;
  }
  return { url: u, headers: out };
}

export async function testHttpApi(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const target = c.config.spec_url || c.config.base_url!;
  // Credentials only go to the API's own origin, not to a spec hosted elsewhere.
  const sameOrigin = new URL(target).origin === new URL(c.config.base_url!).origin;
  const accept = { accept: "application/json, */*;q=0.5" };
  const { url, headers } = sameOrigin ? withAuth(c, new URL(target), accept) : { url: new URL(target), headers: accept };
  const res = await call(url.toString(), "http", env, { headers });
  const where = new URL(target).host;
  if (res.status === 401 || res.status === 403 || res.status >= 500) failWith(res, where);
  if (c.config.spec_url && res.status >= 300) failWith(res, `The spec URL (${where})`);
  if (res.status >= 400) return { detail: `Reached ${where} (HTTP ${res.status} at the base URL, which is normal for many APIs).` };
  return { detail: `Reached ${where} (HTTP ${res.status}).` };
}

// ---- call_api: one request through the connection ----------------------------------------------------------------

/** Methods call_api may always use; others only when the connection lists them (allow_write_methods). */
export const READ_METHODS = ["GET", "HEAD"];
export const ALL_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/** Request bodies are at most this big. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Headers a caller may set (others are the connection's business: auth, cookies, routing). */
const CALLER_HEADER = /^(accept|accept-language|content-type|if-none-match|if-match|if-modified-since|if-unmodified-since|prefer|idempotency-key|x-[a-z0-9][a-z0-9-]{0,60})$/i;
const NEVER_HEADER = /^(x-forwarded-.*|x-real-ip|x-original-.*|x-rewrite-url|x-http-method(-override)?|x-method-override|x-amz-.*|x-api-key|x-auth-token|x-access-token|x-csrf-token)$/i;

export type QueryValue = string | number | boolean;

export interface ApiCall {
  method: string;
  path: string;
  query?: Record<string, QueryValue | QueryValue[]>;
  headers?: Record<string, string>;
  body?: unknown;
}

/** Which methods a connection lets call_api use. */
export function allowedMethods(c: Pick<ConnTarget, "options">): string[] {
  return [...READ_METHODS, ...(c.options.allow_write_methods ?? [])];
}

/**
 * A path as the API's server will see it: each segment percent-decoded. Refused (a ValidationError) when the path
 * uses %25 (double encoding: a proxy and the server could each decode once, so "%252e%252e" ends up as "..") or a
 * semicolon (path parameters: Tomcat, Spring and Jetty read "..;" as ".."), or when a decoded segment is a dot segment
 * (NFKC-normalised), holds a slash, backslash, semicolon or control character, or is malformed.
 */
export function decodedPath(path: string): string {
  if (/%25/i.test(path)) throw new ValidationError("path can't contain %25 (an encoded %): double encoding isn't allowed");
  if (path.includes(";")) throw new ValidationError("path can't contain ; (path parameters aren't allowed)");
  return path
    .split("/")
    .map((raw) => {
      let seg: string;
      try {
        seg = decodeURIComponent(raw);
      } catch {
        throw new ValidationError("path has a malformed %-escape");
      }
      if (/[\/\\;\u0000-\u001f\u007f]/.test(seg)) throw new ValidationError("path can't contain encoded slashes, backslashes, semicolons or control characters");
      const bare = seg.normalize("NFKC").trim();
      if (bare === "." || bare === "..") throw new ValidationError("path can't contain . or .. segments, in any encoding");
      return seg;
    })
    .join("/");
}

/** Whether a path (relative to the base URL) is under one of the allowed prefixes, at a segment boundary. */
export function pathAllowed(c: Pick<ConnTarget, "options">, path: string): boolean {
  const prefixes = c.options.path_prefixes ?? [];
  if (!prefixes.length) return true;
  return prefixes.some((p) => {
    const base = p.replace(/\/+$/, "");
    return !base || path === base || path.startsWith(`${base}/`);
  });
}

/**
 * The request's URL and headers, checked: the path stays under the base URL and the allowed prefixes (no dot
 * segments in any encoding or with ;parameters, no encoded slashes or dots, double encoding, semicolons, backslashes
 * or a query in the path), the method is allowed, the query and headers
 * can't stand in for the connection's own credentials. Throws a ValidationError saying what's wrong.
 */
export function prepareCall(c: ConnTarget, req: ApiCall): { url: URL; method: string; headers: Record<string, string>; body?: string; logText: string } {
  const method = String(req.method ?? "GET").toUpperCase();
  if (!ALL_METHODS.includes(method)) throw new ValidationError(`method is one of ${ALL_METHODS.join(", ")}`);
  if (!allowedMethods(c).includes(method))
    throw new ValidationError(`${method} isn't allowed on this connection: only ${allowedMethods(c).join(", ")}. A Project admin can allow it in project settings → Connections`);
  const path = String(req.path ?? "");
  if (!path.startsWith("/") || path.length > 2000) throw new ValidationError("path starts with / and is relative to the connection's base URL, e.g. /orders/123");
  if (/[\s\u0000-\u001f\u007f\\#?]/.test(path)) throw new ValidationError("path can't contain spaces, backslashes, # or ?: pass query parameters in query");
  if (/%(2e|2f|5c|00)/i.test(path) || path.includes("//") || path.split("/").some((s) => s === "." || s === "..")) throw new ValidationError("path can't contain . or .. segments, // or encoded slashes and dots");
  const decoded = decodedPath(path);
  // Both as sent and as the server decodes it: a server that doesn't decode sees the first, one that does the second.
  if (!pathAllowed(c, path) || !pathAllowed(c, decoded)) throw new ValidationError(`${path} isn't under the paths this connection allows (${(c.options.path_prefixes ?? []).join(", ")})`);

  const base = new URL(c.config.base_url!);
  const basePath = base.pathname.replace(/\/+$/, "");
  const url = new URL(`${base.origin}${basePath}${path}`);
  if (url.origin !== base.origin || !(url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) throw new ValidationError("path leaves the connection's base URL");
  for (const [k, v] of base.searchParams) url.searchParams.append(k, v);

  const authParam = c.config.auth_type === "query" ? c.config.auth_name : undefined;
  const entries = Object.entries(req.query ?? {});
  if (entries.length > 50) throw new ValidationError("at most 50 query parameters");
  for (const [k, raw] of entries) {
    if (!k || k.length > 200) throw new ValidationError("query parameter names are 1 to 200 characters");
    // Also spelled in other case or with spaces around it: some servers read API_KEY or "api_key " as api_key.
    if (authParam && k.trim().toLowerCase() === authParam.trim().toLowerCase()) throw new ValidationError(`${k} carries the connection's key, which Thaliyola adds itself`);
    for (const v of Array.isArray(raw) ? raw : [raw]) {
      if (!["string", "number", "boolean"].includes(typeof v)) throw new ValidationError(`query parameter ${k} must be text, a number or true/false`);
      const s = String(v);
      if (s.length > 2000) throw new ValidationError(`query parameter ${k} is too long`);
      url.searchParams.append(k, s);
    }
  }

  const headers: Record<string, string> = { accept: "application/json, */*;q=0.5" };
  const authHeader = c.config.auth_type === "header" ? c.config.auth_name?.toLowerCase() : undefined;
  for (const [rawName, v] of Object.entries(req.headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!CALLER_HEADER.test(name) || NEVER_HEADER.test(name) || name === authHeader) throw new ValidationError(`header ${rawName} can't be set: Thaliyola adds the connection's credentials itself, and only content headers (accept, content-type, if-*, prefer, x-…) may be passed`);
    if (typeof v !== "string" || v.length > 1000 || /[\r\n\u0000]/.test(v)) throw new ValidationError(`header ${rawName} must be one line of text`);
    headers[name] = v;
  }

  let body: string | undefined;
  if (req.body !== undefined && req.body !== null) {
    if (READ_METHODS.includes(method)) throw new ValidationError(`${method} requests don't take a body`);
    body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new ValidationError(`the body is larger than ${MAX_BODY_BYTES / 1024} KB`);
    headers["content-type"] ??= typeof req.body === "string" ? "text/plain; charset=utf-8" : "application/json";
  }
  const { url: authed, headers: withCreds } = withAuth(c, url, headers);
  // What the log keeps: the method, the path and the query as the caller sent it (the connection's key isn't in it).
  return { url: authed, method, headers: withCreds, body, logText: `${method} ${url.pathname.slice(basePath.length) || "/"}${url.search}` };
}

import { ValidationError } from "../context.js";
import { pinnedFetch, type NetMode, type PinnedRequest, type PinnedResponse } from "./network.js";
import type { DriverEnv } from "./types.js";

/** Helpers for the HTTP-based drivers (APIs, git hosts, Slack, Trello, ClickHouse, Snowflake, BigQuery). */

export class RemoteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** How long the service asked us to wait (Retry-After), when it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/**
 * A database behind an HTTP API (ClickHouse, Snowflake, BigQuery) refused a statement. `dbCode` is its own error code;
 * the message can quote values from the data, so it's hidden when the query reads personal data.
 */
export class DatabaseError extends RemoteError {
  constructor(
    message: string,
    status: number,
    readonly dbCode: string,
  ) {
    super(message, status);
  }
}

/** Retry-After, in milliseconds: seconds or an HTTP date. Undefined when absent or unreadable. */
export function retryAfterMs(res: Pick<PinnedResponse, "headers">, now = Date.now()): number | undefined {
  const raw = res.headers["retry-after"];
  const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** A short reason from an error response: the service's own message field, else its first line, never much of it. */
export function reasonOf(res: PinnedResponse): string {
  let reason = "";
  try {
    const body = JSON.parse(res.text) as Record<string, unknown>;
    const pick = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" ? pick((v as Record<string, unknown>).message) : "");
    reason = pick(body.message) || pick(body.error_description) || pick(body.error) || pick(body.errors);
  } catch {
    reason = res.text.split("\n").find((l) => l.trim()) ?? "";
  }
  reason = reason.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return reason.length > 200 ? `${reason.slice(0, 200)}…` : reason;
}

export function failWith(res: PinnedResponse, what: string): never {
  const reason = reasonOf(res);
  const hint = res.status === 401 || res.status === 403 ? " Check the credentials and their permissions." : "";
  throw new RemoteError(`${what} answered HTTP ${res.status}${reason ? `: ${reason}` : ""}.${hint}`, res.status, res.status === 429 || res.status === 503 ? retryAfterMs(res) : undefined);
}

export async function call(url: string, mode: NetMode, env: DriverEnv, req: PinnedRequest = {}): Promise<PinnedResponse> {
  return pinnedFetch(url, mode, env.net, { timeoutMs: env.timeoutMs, ...req });
}

/** A JSON request that must succeed (2xx). */
export async function callJson<T>(url: string, mode: NetMode, env: DriverEnv, what: string, req: PinnedRequest = {}): Promise<T> {
  const res = await call(url, mode, env, { ...req, headers: { accept: "application/json", ...req.headers } });
  if (res.status < 200 || res.status >= 300) failWith(res, what);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new ValidationError(`${what} didn't answer with JSON (HTTP ${res.status})`);
  }
}

/** An API base URL: the configured one, a test override, or the default. No trailing slash. */
export function base(env: DriverEnv, name: string, fallback: string, configured?: string): string {
  return (configured || env.endpoints?.[name] || fallback).replace(/\/+$/, "");
}

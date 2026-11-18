import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/pool.js";

/** What an audit row's target is, for its label and link on the Audit log page. */
export type AuditTargetKind =
  | "article"
  | "finding"
  | "project"
  | "person"
  | "service_account"
  | "token"
  | "proposal"
  | "role"
  | "team"
  | "settings"
  | "vulnerability"
  | "source"
  | "app"
  | "project_request"
  | "connection"
  | "notification_route"
  | "repository"
  | "release"
  | "feature"
  | "skill"
  | "skill_source"
  | "skill_collection";

export interface AuditExtra {
  /** What changed, in plain values (role keys, names, before/after). Never secrets: see SECRET_KEY. */
  details?: Record<string, unknown> | null;
  targetKind?: AuditTargetKind;
  /** The target's name when the event happened (a deleted target keeps it). */
  targetLabel?: string | null;
  /** Set by the REST handler and the MCP tool runner for the row they write around every call. */
  wrapper?: boolean;
}

/**
 * One web (REST) or MCP call: every audit row written while serving it shares the request id, so the Audit log page
 * shows the change the core function recorded (with its details) instead of also listing the call that wrapped it.
 */
const requestScope = new AsyncLocalStorage<{ id: string; via: "api" | "mcp" }>();

export function inAuditRequest<T>(via: "api" | "mcp", fn: () => Promise<T>): Promise<T> {
  return requestScope.run({ id: randomUUID(), via }, fn);
}

/** The channel of the web or MCP call being served (background work it started included); undefined outside one. */
export function requestVia(): "api" | "mcp" | undefined {
  return requestScope.getStore()?.via;
}

/** Keys whose values never go into the audit log, whatever a caller passes. */
const SECRET_KEY = /^(token|password|secret|api_key|authorization|cookie|credentials?|smtp_url|webhook_url|slack_webhook_url)$|_(secret|hash|password)$/i;
/** Values that look like credentials (API tokens, bearer headers, URLs with a password or a Slack webhook). */
const SECRET_VALUE = /thaliyola_pat_|^bearer\s|:\/\/[^/\s:@]+:[^/\s@]+@|hooks\.slack\.com\//i;

/** Drops secret-looking keys and values; keeps the shape small (strings capped, depth limited). */
export function scrubDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[hidden]" : value.slice(0, 500);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubDetails(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      if (v === undefined) continue;
      out[k] = scrubDetails(v, depth + 1);
    }
    return out;
  }
  return null;
}

/**
 * Records who did what to what. `actorId` is null for Thaliyola's own jobs (e.g. token expiry notices). Details are
 * scrubbed of anything that looks like a secret before they're stored.
 */
export async function audit(db: Queryable, actorId: string | null, tool: string, targetId?: string | null, extra: AuditExtra = {}): Promise<void> {
  const req = requestScope.getStore();
  const details = extra.details ? scrubDetails(extra.details) : null;
  await db.query(
    `INSERT INTO audit_log (actor_id, tool, target_id, details, target_kind, target_label, request_id, via)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      actorId,
      tool.slice(0, 200),
      targetId ?? null,
      details && Object.keys(details as object).length ? JSON.stringify(details) : null,
      extra.targetKind ?? null,
      extra.targetLabel?.slice(0, 300) ?? null,
      req?.id ?? null,
      extra.wrapper && req ? req.via : null,
    ],
  );
}

/**
 * Tools recorded outside any web or MCP call (sign-in, account pages, OAuth, Thaliyola's jobs) or by the review flow:
 * never an agent's call. Only matters for rows without a request id; see agentCallSql().
 */
const NOT_AGENT_CALLS = [
  "login",
  "accept_invitation",
  "change_password",
  "approve_revision",
  "reject_revision",
  "create_api_token",
  "revoke_api_token",
  "rotate_api_token",
  "revoke_oauth_connection",
  "oauth_authorize",
  "invite_user",
  "notify_token_expiry",
];

/**
 * SQL: is this audit_log row an agent's MCP call? Since migration 035 every MCP call writes one row with
 * via = 'mcp' (the changes it records share its request id, and web calls are via = 'api'). Older rows have no
 * request id: there, any row that isn't a web call (api:*) or one of NOT_AGENT_CALLS counts, as it always did.
 */
export function agentCallSql(alias: string): string {
  const l = alias;
  return `(${l}.via = 'mcp' OR (${l}.request_id IS NULL AND ${l}.actor_id IS NOT NULL AND ${l}.tool NOT LIKE 'api:%'
    AND split_part(${l}.tool, ':', 1) <> ALL (ARRAY[${NOT_AGENT_CALLS.map((t) => `'${t}'`).join(", ")}])))`;
}

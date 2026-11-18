import { createApiToken, rotateApiToken, TOKEN_LIST_COLUMNS, type RotationGrace } from "../auth/local.js";
import type { Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { can } from "./permissions.js";

/**
 * Service accounts: identities for other systems (AutoCode, CI jobs, scheduled agents) that call Thaliyola with a
 * token instead of a person signing in. They are created and given tokens by people who manage people (Administrators
 * and User managers), get project roles like a person does (Members and access, with the identifier `service:<name>`),
 * never hold organisation roles, and never publish or approve: their writes always wait for review.
 */

export const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Accounts Thaliyola itself acts as (exports, connection syncs): never listed, managed or given tokens here. */
export const SYSTEM_ACCOUNTS: readonly string[] = ["thaliyola-export", "thaliyola-sync"];
const SYSTEM_SUBJECTS = SYSTEM_ACCOUNTS.map((n) => `service:${n}`);

function assertMayManage(ctx: RequestContext) {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("only people manage service accounts");
  if (!can(ctx, "manage_users")) throw new ForbiddenError("managing service accounts needs Manage people (Administrators and User managers have it)");
}

/** Creates (or, from the command line, reuses) the account `service:<name>`. Returns its id. */
export async function ensureServiceAccount(db: Queryable, name: string, opts: { displayName?: string; createdBy?: string; mustBeNew?: boolean } = {}) {
  if (!SERVICE_NAME.test(name)) throw new ValidationError("service names are 2–41 lowercase letters, digits and hyphens, e.g. autocode or ci-docs");
  const subject = `service:${name}`;
  if (opts.mustBeNew) {
    const taken = await db.query("SELECT 1 FROM users WHERE subject = $1", [subject]);
    if (taken.rows[0]) throw new ValidationError(`a service account called ${name} already exists; create a new token for it instead`);
  }
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (subject, display_name, kind, approved_at, approved_by) VALUES ($1, $2, 'service', now(), $3)
     ON CONFLICT (subject) DO UPDATE SET display_name = coalesce(EXCLUDED.display_name, users.display_name) RETURNING id`,
    [subject, opts.displayName?.trim() || name, opts.createdBy ?? null],
  );
  return rows[0]!.id;
}

interface ServiceRow {
  id: string;
  name: string;
  identifier: string;
  display_name: string | null;
  disabled: boolean;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
}

export async function listServiceAccounts(ctx: RequestContext) {
  assertMayManage(ctx);
  const { rows } = await ctx.db.query<ServiceRow>(
    `SELECT u.id, substr(u.subject, 9) AS name, u.subject AS identifier, u.display_name, u.disabled_at IS NOT NULL AS disabled, u.created_at,
            coalesce(c.display_name, c.email) AS created_by,
            (SELECT max(last_used_at) FROM api_tokens t WHERE t.user_id = u.id) AS last_used_at
       FROM users u LEFT JOIN users c ON c.id = u.approved_by
      WHERE u.kind = 'service' AND u.subject LIKE 'service:%' AND u.subject <> ALL ($1::text[])
      ORDER BY u.disabled_at IS NOT NULL, lower(u.subject)`,
    [SYSTEM_SUBJECTS],
  );
  const ids = rows.map((r) => r.id);
  const tokens = ids.length
    ? (
        await ctx.db.query<{
          user_id: string;
          id: string;
          name: string;
          prefix: string;
          created_at: string;
          last_used_at: string | null;
          expires_at: string | null;
          revoked_at: string | null;
          rotated_at: string | null;
          replaced_by: string | null;
          unused: boolean;
        }>(
          `SELECT user_id, ${TOKEN_LIST_COLUMNS} FROM api_tokens
            WHERE user_id = ANY($1::uuid[]) ORDER BY revoked_at NULLS FIRST, created_at DESC`,
          [ids],
        )
      ).rows
    : [];
  const projects = ids.length
    ? (
        await ctx.db.query<{ user_id: string; slug: string; name: string; roles: string[]; role_names: string[] }>(
          `SELECT m.user_id, s.slug, s.name, array_agg(m.role ORDER BY r.position) AS roles, array_agg(r.name ORDER BY r.position) AS role_names
             FROM scope_members m JOIN scopes s ON s.id = m.scope_id JOIN roles r ON r.key = m.role
            WHERE m.user_id = ANY($1::uuid[]) AND s.deleted_at IS NULL
            GROUP BY m.user_id, s.slug, s.name ORDER BY lower(s.name)`,
          [ids],
        )
      ).rows
    : [];
  return {
    service_accounts: rows.map((r) => ({
      ...r,
      tokens: tokens.filter((t) => t.user_id === r.id).map(({ user_id: _u, ...t }) => t),
      projects: projects.filter((p) => p.user_id === r.id).map(({ user_id: _u, ...p }) => p),
    })),
  };
}

export async function createServiceAccount(ctx: RequestContext, input: { name: string; display_name?: string }) {
  assertMayManage(ctx);
  const name = input.name.trim().toLowerCase();
  if (SYSTEM_ACCOUNTS.includes(name)) throw new ValidationError(`${name} is reserved for Thaliyola itself; choose another name`);
  const id = await ensureServiceAccount(ctx.db, name, { displayName: input.display_name, createdBy: ctx.actor.id, mustBeNew: true });
  await audit(ctx.db, ctx.actor.id, "create_service_account", id, {
    targetKind: "service_account",
    targetLabel: input.display_name?.trim() || name,
    details: { identifier: `service:${name}` },
  });
  return { id, name, identifier: `service:${name}` };
}

async function serviceAccount(ctx: RequestContext, id: string) {
  const { rows } = await ctx.db.query<{ id: string; subject: string; label: string; disabled: boolean }>(
    "SELECT id, subject, coalesce(nullif(display_name, ''), substr(subject, 9)) AS label, disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1 AND kind = 'service' AND subject LIKE 'service:%'",
    [id],
  );
  if (!rows[0] || SYSTEM_SUBJECTS.includes(rows[0].subject)) throw new NotFoundError(`service account ${id}`);
  return rows[0];
}

/** A new token for the service account. The token is returned once; only its hash is stored. */
export async function createServiceToken(ctx: RequestContext, id: string, input: { name: string; expires_in_days?: number }) {
  assertMayManage(ctx);
  const account = await serviceAccount(ctx, id);
  if (account.disabled) throw new ValidationError("the service account is disabled; enable it first");
  const created = await createApiToken(ctx.db, account.id, input.name, input.expires_in_days);
  await audit(ctx.db, ctx.actor.id, "create_service_token", account.id, {
    targetKind: "service_account",
    targetLabel: account.label,
    details: { token_id: created.id, token_name: created.name, expires_at: created.expires_at },
  });
  return { ...created, identifier: account.subject };
}

export async function revokeServiceToken(ctx: RequestContext, id: string, tokenId: string) {
  assertMayManage(ctx);
  const account = await serviceAccount(ctx, id);
  const { rows } = await ctx.db.query<{ name: string }>(
    "UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING name",
    [tokenId, account.id],
  );
  if (!rows[0]) throw new NotFoundError(`token ${tokenId}`);
  await audit(ctx.db, ctx.actor.id, "revoke_service_token", account.id, {
    targetKind: "service_account",
    targetLabel: account.label,
    details: { token_id: tokenId, token_name: rows[0].name },
  });
  return { id: tokenId, revoked: true };
}

/** Disabling stops every token of the account at once (enabling brings back the ones not revoked or expired). */
export async function setServiceAccountDisabled(ctx: RequestContext, id: string, disabled: boolean) {
  assertMayManage(ctx);
  const account = await serviceAccount(ctx, id);
  await ctx.db.query("UPDATE users SET disabled_at = CASE WHEN $2 THEN coalesce(disabled_at, now()) END WHERE id = $1", [account.id, disabled]);
  await audit(ctx.db, ctx.actor.id, disabled ? "disable_service_account" : "enable_service_account", account.id, {
    targetKind: "service_account",
    targetLabel: account.label,
    details: { disabled, was_disabled: account.disabled },
  });
  return { id: account.id, disabled };
}

/**
 * Rotates a service-account token: a new token with the same name and lifetime, shown once; the old one keeps
 * working for the grace period (none, 1 day or 7 days) so the other system can switch, then expires.
 */
export async function rotateServiceToken(ctx: RequestContext, id: string, tokenId: string, grace: RotationGrace) {
  assertMayManage(ctx);
  const account = await serviceAccount(ctx, id);
  if (account.disabled) throw new ValidationError("the service account is disabled; enable it first");
  const rotated = await rotateApiToken(ctx.db, account.id, tokenId, grace);
  await audit(ctx.db, ctx.actor.id, "rotate_service_token", account.id, {
    targetKind: "service_account",
    targetLabel: account.label,
    details: {
      token_name: rotated.name,
      old_token_id: rotated.replaced.id,
      new_token_id: rotated.id,
      grace,
      old_works_until: rotated.replaced.works_until,
      expires_at: rotated.expires_at,
    },
  });
  return { ...rotated, identifier: account.subject };
}

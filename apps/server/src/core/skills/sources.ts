import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Settings } from "../../config.js";
import type { Db, Queryable } from "../../db/pool.js";
import { audit } from "../audit.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Actor, type RequestContext } from "../context.js";
import { gitHeaders, repoPathOf, checkRef } from "../connections/git.js";
import { pinnedFetch, type PinnedResponse } from "../connections/network.js";
import { openSecrets, type ConnectionRow } from "../connections/sync.js";
import { can, canManage, canReadScope, isAdmin } from "../permissions.js";
import { canSeal, hintOf, openJson, sealJson, SecretsUnavailableError } from "../secrets.js";
import { parseRepoUrl } from "../repo-detect.js";
import { actorById } from "../users.js";
import { ownerRights } from "./access.js";
import { writeTar, type TarItem } from "./archive.js";
import { filtersKey, runImport, type SourceRow } from "./importer.js";
import { checkSkillApiUrl, gitError, networkError, skillsEnv } from "./net.js";
import { peopleWith, tellSkill } from "./notify.js";
import { purgeOldUsage } from "./usage.js";
import { cleanGlobs } from "./types.js";

/**
 * Skill sources: a GitLab or GitHub repository read through its API (with a git connection's token, or a token sealed
 * on the source with CONNECTIONS_KEY), or a remembered upload. "Sync now" and the schedule download the repository's
 * archive at one commit and run the importer; the same commit with the same filters is skipped. Every run re-checks
 * that whoever it acts for may still use the source and its token.
 */

const aad = (id: string) => `skill_source:${id}`;
const SOURCE_COLUMNS = `id, name, kind, provider, connection_id, api_url, repository, ref, path, exclude, no_deliver, owner_scope_id, secret, secret_hint,
  publish_directly, publish_directly_by, interval_minutes, enabled, owner_id, next_run_at, last_run_at, last_ok_at, last_commit, last_filters, last_error,
  failures, created_by, created_at, updated_at`;

/** Background runs, so tests and shutdown can wait for them. */
const running = new Set<Promise<unknown>>();
export async function flushSkillImports() {
  while (running.size) await Promise.allSettled([...running]);
}

async function sourceRow(db: Queryable, id: string): Promise<SourceRow | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  return (await db.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM skill_sources WHERE id = $1`, [id])).rows[0];
}

async function assertSourceRight(ctx: RequestContext, id: string): Promise<SourceRow> {
  const s = await sourceRow(ctx.db, id);
  if (!s) throw new NotFoundError("skill source");
  const rights = await ownerRights(ctx, s.owner_scope_id);
  if (!rights.see) throw new NotFoundError("skill source");
  if (!can(ctx, "manage_skills") && !(s.owner_scope_id && rights.manage)) throw new ForbiddenError("skill sources need Manage skills (Skills managers and Administrators)");
  return s;
}

async function view(ctx: RequestContext, s: SourceRow) {
  const conn = s.connection_id
    ? (await ctx.db.query<{ id: string; name: string; enabled: boolean; scope_id: string; scope_slug: string; scope_kind: string; scope_name: string }>(
        "SELECT c.id, c.name, c.enabled, c.scope_id, sc.slug AS scope_slug, sc.kind AS scope_kind, sc.name AS scope_name FROM connections c JOIN scopes sc ON sc.id = c.scope_id WHERE c.id = $1",
        [s.connection_id],
      )).rows[0]
    : undefined;
  // A project connection is named only to people who can read that project.
  const connReadable = conn ? conn.scope_kind === "team" || (await canReadScope(ctx, conn.scope_id)) : false;
  const owner = s.owner_scope_id ? (await ctx.db.query<{ slug: string; name: string }>("SELECT slug, name FROM scopes WHERE id = $1", [s.owner_scope_id])).rows[0] : undefined;
  const runAs = s.owner_id ? (await ctx.db.query<{ name: string | null }>("SELECT coalesce(nullif(display_name, ''), email) AS name FROM users WHERE id = $1", [s.owner_id])).rows[0] : undefined;
  const last = (
    await ctx.db.query<{ id: string; status: string; started_at: string; finished_at: string | null; commit: string | null; error: string | null; dry_run: boolean; counts: unknown }>(
      "SELECT id, status, started_at, finished_at, commit, error, dry_run, report->'counts' AS counts FROM skill_imports WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1",
      [s.id],
    )
  ).rows[0];
  const skills = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM skills WHERE source_id = $1 AND status = 'active'", [s.id])).rows[0]!.n;
  const hook = (
    await ctx.db.query<{ set: boolean; hint: string | null; at: string | null; due: string | null }>(
      "SELECT webhook_secret IS NOT NULL AS set, webhook_secret_hint AS hint, webhook_at AS at, webhook_due_at AS due FROM skill_sources WHERE id = $1",
      [s.id],
    )
  ).rows[0];
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    provider: s.provider,
    repository: s.repository,
    ref: s.ref,
    path: s.path,
    exclude: s.exclude,
    no_deliver: s.no_deliver,
    api_url: s.api_url,
    owner_project: owner ?? null,
    connection: conn
      ? connReadable
        ? { id: conn.id, name: conn.name, enabled: conn.enabled, space: conn.scope_kind === "team" ? "team" : conn.scope_slug, space_name: conn.scope_name }
        : { id: conn.id, name: "A members-only project's git connection", enabled: conn.enabled, space: null, space_name: "A members-only project" }
      : null,
    token: s.secret ? { set: true, hint: s.secret_hint ? `…${s.secret_hint}` : null } : { set: false, hint: null },
    publish_directly: s.publish_directly,
    interval_minutes: s.interval_minutes,
    enabled: s.enabled,
    run_as: runAs?.name ?? null,
    next_run_at: s.next_run_at,
    last_run_at: s.last_run_at,
    last_ok_at: s.last_ok_at,
    last_commit: s.last_commit,
    last_error: s.last_error,
    failures: s.failures,
    skills,
    last_import: last ?? null,
    webhook:
      s.kind === "git"
        ? {
            path: webhookPath(s.id),
            url: ctx.settings.publicUrl ? `${ctx.settings.publicUrl}${webhookPath(s.id)}` : null,
            secret: hook?.set ? { set: true, hint: hook.hint ? `…${hook.hint}` : null } : { set: false, hint: null },
            last_at: hook?.at ?? null,
            queued_at: hook?.due ?? null,
          }
        : null,
    created_at: s.created_at,
  };
}

export async function listSkillSources(ctx: RequestContext) {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("skill sources need Manage skills");
  const { rows } = await ctx.db.query<SourceRow>(`SELECT ${SOURCE_COLUMNS} FROM skill_sources ORDER BY lower(name)`);
  const out = [];
  for (const s of rows) {
    const r = await ownerRights(ctx, s.owner_scope_id);
    if (!r.see || (!can(ctx, "manage_skills") && !(s.owner_scope_id && r.manage) && !r.usage)) continue;
    out.push(await view(ctx, s));
  }
  // Git connections a source may borrow: the Team space's (Administrators set them up) and projects the caller manages.
  const conns = (
    await ctx.db.query<{ id: string; name: string; scope_id: string; scope_kind: string; scope_slug: string; scope_name: string; provider: string | null; enabled: boolean }>(
      `SELECT c.id, c.name, c.scope_id, s.kind AS scope_kind, s.slug AS scope_slug, s.name AS scope_name, c.config->>'provider' AS provider, c.enabled
         FROM connections c JOIN scopes s ON s.id = c.scope_id WHERE c.kind = 'git' ORDER BY s.kind DESC, c.name`,
    )
  ).rows;
  const usable = [];
  for (const c of conns) {
    if (c.scope_kind === "team" ? can(ctx, "manage_skills") : await canManage(ctx, { id: c.scope_id, kind: c.scope_kind })) {
      usable.push({ id: c.id, name: c.name, provider: c.provider, enabled: c.enabled, space: c.scope_kind === "team" ? "team" : c.scope_slug, space_name: c.scope_name });
    }
  }
  return {
    sources: out,
    git_connections: usable,
    can: { create: can(ctx, "manage_skills"), publish_directly: isAdmin(ctx), store_tokens: canSeal(ctx.settings.connections?.keys) },
    git_hosts: ctx.settings.skills?.gitHosts ?? [],
    suggested_no_deliver: ["evals/**", "tasks/**"],
  };
}

export interface SourceInput {
  name?: string;
  kind?: "git" | "upload";
  provider?: "gitlab" | "github";
  repository?: string;
  ref?: string | null;
  path?: string;
  exclude?: string[];
  no_deliver?: string[];
  project?: string | null;
  connection?: string | null;
  api_url?: string | null;
  token?: string | null;
  interval_minutes?: number | null;
  publish_directly?: boolean;
  enabled?: boolean;
  owner?: "me";
}

/** A git connection the caller may use for skill imports: the Team space's (Manage skills), or a project's they manage. */
async function usableConnection(ctx: RequestContext, ref: string): Promise<ConnectionRow & { scope_kind: string; scope_visibility: string }> {
  const { rows } = await ctx.db.query<ConnectionRow & { scope_kind: string; scope_visibility: string }>(
    `SELECT c.*, s.kind AS scope_kind, s.visibility AS scope_visibility FROM connections c JOIN scopes s ON s.id = c.scope_id WHERE c.kind = 'git' AND (c.id::text = $1 OR lower(c.name) = lower($1)) ORDER BY (s.kind = 'team') DESC LIMIT 1`,
    [ref],
  );
  const c = rows[0];
  if (!c || !(await canReadScope(ctx, c.scope_id))) throw new NotFoundError(`git connection '${ref}'`);
  if (c.scope_kind !== "team" && !(await canManage(ctx, { id: c.scope_id, kind: c.scope_kind }))) {
    throw new ForbiddenError(`the git connection ${c.name} belongs to a project whose settings you don't manage; use the Team space's git connection or one of your projects'`);
  }
  return c;
}

/**
 * Which repositories a connection's token may read for skills: a project's connection only the repositories registered
 * in that project (or the projects under it), like read_repo_file; the Team space's connection anything, except (for
 * people who aren't Administrators) a repository registered in a project they can't read. A members-only project's
 * connection only serves that project's own sources, so its name never shows in the organisation's source list.
 */
async function checkConnectionUse(ctx: RequestContext, c: { name: string; scope_id: string; scope_kind: string; scope_visibility?: string }, repository: string, ownerScopeId: string | null) {
  const want = repository.toLowerCase();
  const { rows } = await ctx.db.query<{ scope_id: string; repo_url: string }>("SELECT scope_id, repo_url FROM components WHERE coalesce(repo_url, '') <> ''");
  const registered = rows.filter((r) => parseRepoUrl(r.repo_url)?.path.toLowerCase() === want);
  if (c.scope_kind !== "team") {
    const subtree = new Set((await ctx.db.query<{ scope_id: string }>("SELECT scope_id FROM scope_subtree WHERE root_id = $1", [c.scope_id])).rows.map((r) => r.scope_id));
    subtree.add(c.scope_id);
    if (!registered.some((r) => subtree.has(r.scope_id))) {
      throw new ValidationError(`the git connection ${c.name} belongs to a project, so it reads only that project's registered repositories (project settings → Repositories); add ${repository} there, or use the Team space's git connection`);
    }
    const visibility = c.scope_visibility ?? (await ctx.db.query<{ visibility: string }>("SELECT visibility FROM scopes WHERE id = $1", [c.scope_id])).rows[0]?.visibility;
    if (visibility === "members") {
      const inside = ownerScopeId ? (await ctx.db.query("SELECT 1 FROM scope_subtree WHERE root_id = $1 AND scope_id = $2", [c.scope_id, ownerScopeId])).rowCount || ownerScopeId === c.scope_id : false;
      if (!inside) throw new ValidationError(`the git connection ${c.name} belongs to a members-only project: only that project's own skill sources can use it`);
    }
    return;
  }
  if (isAdmin(ctx)) return;
  for (const r of registered) {
    if (!(await canReadScope(ctx, r.scope_id))) throw new ValidationError(`the Team space's git connection can't read ${repository} for you; an Administrator can set up this source`);
  }
}

const intervalOf = (v: number | null | undefined) => {
  if (v === null || v === undefined || v === 0) return null;
  if (!Number.isInteger(v) || v < 60 || v > 10080) throw new ValidationError("interval_minutes is between 60 (hourly) and 10080 (weekly), or null for no schedule");
  return v;
};

export async function createSkillSource(ctx: RequestContext, input: SourceInput) {
  if (!can(ctx, "manage_skills")) throw new ForbiddenError("adding skill sources needs Manage skills (Skills managers and Administrators)");
  const kind = input.kind ?? "git";
  const name = input.name?.trim();
  if (!name || name.length > 80) throw new ValidationError("a source needs a name (at most 80 characters)");
  let ownerScopeId: string | null = null;
  if (input.project) {
    const { rows } = await ctx.db.query<{ id: string; kind: string }>("SELECT id, kind FROM scopes WHERE slug = $1", [input.project]);
    if (!rows[0] || !(await canReadScope(ctx, rows[0].id))) throw new NotFoundError(`project '${input.project}'`);
    if (rows[0].kind !== "project") throw new ValidationError(`'${input.project}' isn't a project`);
    ownerScopeId = rows[0].id;
  }
  if (input.publish_directly && !isAdmin(ctx)) throw new ForbiddenError("only Administrators let a source publish changed versions without review");
  let provider: "gitlab" | "github" | null = null;
  let repository: string | null = null;
  let apiUrl: string | null = null;
  let connectionId: string | null = null;
  if (kind === "git") {
    provider = input.provider ?? null;
    if (provider !== "gitlab" && provider !== "github") throw new ValidationError("provider is gitlab or github");
    if (!input.repository?.trim()) throw new ValidationError("repository is the GitLab project path (group/project) or GitHub owner/repo");
    repository = repoPathOf({ config: { provider } }, input.repository.trim());
    if (input.connection) {
      const c = await usableConnection(ctx, input.connection);
      if ((c.config.provider ?? "github") !== provider) throw new ValidationError(`${c.name} is a ${c.config.provider === "gitlab" ? "GitLab" : "GitHub"} connection`);
      connectionId = c.id;
      if (input.token) throw new ValidationError("use a git connection or a token, not both");
      await checkConnectionUse(ctx, c, repository, ownerScopeId);
    } else {
      apiUrl = checkSkillApiUrl(input.api_url, provider, ctx.settings);
      if (input.token && !canSeal(ctx.settings.connections?.keys)) throw new ValidationError("storing a token needs CONNECTIONS_KEY on the server (an Administrator sets it); or use a git connection");
    }
    checkRef(input.ref ?? undefined);
  }
  const exists = await ctx.db.query("SELECT 1 FROM skill_sources WHERE lower(name) = lower($1)", [name]);
  if (exists.rowCount) throw new ValidationError(`a skill source named ${name} already exists`);
  const interval = intervalOf(input.interval_minutes);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO skill_sources (name, kind, provider, connection_id, api_url, repository, ref, path, exclude, no_deliver, owner_scope_id, publish_directly,
                                publish_directly_by, interval_minutes, enabled, owner_id, next_run_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CASE WHEN $14::int IS NULL THEN NULL ELSE now() + make_interval(mins => $14::int) END, $16) RETURNING id`,
    [
      name,
      kind,
      provider,
      connectionId,
      apiUrl,
      repository,
      input.ref?.trim() || null,
      (input.path ?? "").trim().replace(/^\/+|\/+$/g, ""),
      cleanGlobs(input.exclude),
      cleanGlobs(input.no_deliver),
      ownerScopeId,
      !!input.publish_directly,
      input.publish_directly ? ctx.actor.id : null,
      interval,
      input.enabled ?? true,
      ctx.actor.id,
    ],
  );
  const id = rows[0]!.id;
  if (input.token && kind === "git" && !connectionId) {
    await ctx.db.query("UPDATE skill_sources SET secret = $2, secret_hint = $3 WHERE id = $1", [id, sealJson({ token: input.token.trim() }, ctx.settings.connections?.keys, aad(id)), hintOf(input.token.trim()).replace(/^…/, "")]);
  }
  const s = (await sourceRow(ctx.db, id))!;
  await audit(ctx.db, ctx.actor.id, "create_skill_source", id, { targetKind: "skill_source", targetLabel: name, details: auditDetails(s, input.token ? "changed" : undefined) });
  return view(ctx, s);
}

function auditDetails(s: SourceRow, token?: "changed" | "cleared") {
  return {
    name: s.name,
    provider: s.provider,
    repository: s.repository,
    ref: s.ref,
    path: s.path,
    exclude: s.exclude,
    no_deliver: s.no_deliver,
    publish_directly: s.publish_directly,
    interval_minutes: s.interval_minutes,
    enabled: s.enabled,
    ...(token ? { token_change: token } : {}),
  };
}

export async function updateSkillSource(ctx: RequestContext, id: string, patch: SourceInput) {
  const s = await assertSourceRight(ctx, id);
  if (!can(ctx, "manage_skills")) throw new ForbiddenError("changing skill sources needs Manage skills");
  if (patch.publish_directly !== undefined && patch.publish_directly !== s.publish_directly && !isAdmin(ctx)) throw new ForbiddenError("only Administrators change whether a source publishes without review");
  const sets: string[] = [];
  const params: unknown[] = [s.id];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n || n.length > 80) throw new ValidationError("a source needs a name (at most 80 characters)");
    if (n.toLowerCase() !== s.name.toLowerCase() && (await ctx.db.query("SELECT 1 FROM skill_sources WHERE lower(name) = lower($1)", [n])).rowCount) throw new ValidationError(`a skill source named ${n} already exists`);
    set("name", n);
  }
  // Publishing without review is what an Administrator approved for this repository, ref, path, host, token and owner:
  // anyone else changing one of those switches it off again (audited), so a repointed source goes back to review.
  const moved: string[] = [];
  let repository = s.repository;
  if (patch.repository !== undefined && s.kind === "git") {
    repository = repoPathOf({ config: { provider: s.provider! } }, patch.repository);
    if (repository !== s.repository) moved.push("repository");
    set("repository", repository);
  }
  if (patch.ref !== undefined) {
    const ref = checkRef(patch.ref ?? undefined) ?? null;
    if (ref !== (s.ref ?? null)) moved.push("ref");
    set("ref", ref);
  }
  if (patch.path !== undefined) {
    const path = patch.path.trim().replace(/^\/+|\/+$/g, "");
    if (path !== s.path) moved.push("path");
    set("path", path);
  }
  if (patch.exclude !== undefined) set("exclude", cleanGlobs(patch.exclude));
  if (patch.no_deliver !== undefined) {
    const next = cleanGlobs(patch.no_deliver);
    // Delivering files that were held back counts too.
    if (s.no_deliver.some((g) => !next.includes(g))) moved.push("no_deliver");
    set("no_deliver", next);
  }
  if (patch.enabled !== undefined) set("enabled", patch.enabled);
  if (patch.interval_minutes !== undefined) {
    const iv = intervalOf(patch.interval_minutes);
    set("interval_minutes", iv);
    sets.push(`next_run_at = ${iv === null ? "NULL" : `now() + make_interval(mins => ${iv})`}`);
  }
  if (patch.owner === "me" && s.owner_id !== ctx.actor.id) {
    moved.push("owner");
    set("owner_id", ctx.actor.id);
  }
  let token: "changed" | "cleared" | undefined;
  let connection: { name: string; scope_id: string; scope_kind: string; scope_visibility: string } | null | undefined;
  if (patch.connection !== undefined && s.kind === "git") {
    if (patch.connection) {
      const c = await usableConnection(ctx, patch.connection);
      if (c.id !== s.connection_id) moved.push("connection");
      connection = c;
      set("connection_id", c.id);
      sets.push("secret = NULL", "secret_hint = NULL");
    } else {
      if (s.connection_id) moved.push("connection");
      connection = null;
      set("connection_id", null);
    }
  }
  if (patch.api_url !== undefined && s.kind === "git") {
    const api = checkSkillApiUrl(patch.api_url, s.provider!, ctx.settings);
    if ((api ?? null) !== (s.api_url ?? null)) moved.push("api_url");
    set("api_url", api);
  }
  if (patch.token !== undefined && s.kind === "git") {
    if (patch.token) {
      if (!canSeal(ctx.settings.connections?.keys)) throw new ValidationError("storing a token needs CONNECTIONS_KEY on the server (an Administrator sets it)");
      set("secret", sealJson({ token: patch.token.trim() }, ctx.settings.connections?.keys, aad(s.id)));
      set("secret_hint", hintOf(patch.token.trim()).replace(/^…/, ""));
      sets.push("connection_id = NULL");
      connection = null;
      token = "changed";
    } else {
      sets.push("secret = NULL", "secret_hint = NULL");
      token = "cleared";
    }
    moved.push("token");
  }
  // A connection's token reads only what it may (checked again on every run).
  const connectionAfter =
    connection !== undefined
      ? connection
      : s.connection_id && patch.repository !== undefined
        ? (await ctx.db.query<{ name: string; scope_id: string; scope_kind: string; scope_visibility: string }>(
            "SELECT c.name, c.scope_id, sc.kind AS scope_kind, sc.visibility AS scope_visibility FROM connections c JOIN scopes sc ON sc.id = c.scope_id WHERE c.id = $1",
            [s.connection_id],
          )).rows[0] ?? null
        : null;
  if (s.kind === "git" && repository && connectionAfter) await checkConnectionUse(ctx, connectionAfter, repository, s.owner_scope_id);
  let directReset = false;
  if (patch.publish_directly !== undefined) {
    set("publish_directly", patch.publish_directly);
    set("publish_directly_by", patch.publish_directly ? ctx.actor.id : null);
  } else if (s.publish_directly && moved.length && !isAdmin(ctx)) {
    set("publish_directly", false);
    set("publish_directly_by", null);
    directReset = true;
  }
  if (!sets.length) return view(ctx, s);
  await ctx.db.query(`UPDATE skill_sources SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  const after = (await sourceRow(ctx.db, s.id))!;
  await audit(ctx.db, ctx.actor.id, "update_skill_source", s.id, {
    targetKind: "skill_source",
    targetLabel: after.name,
    details: { ...auditDetails(after, token), ...(moved.length ? { changed: moved } : {}), ...(directReset ? { publish_directly_reset: true } : {}) },
  });
  const out = await view(ctx, after);
  return directReset ? { ...out, note: "Publishing without review was switched off because where the skills come from changed; an Administrator can switch it on again." } : out;
}

export async function deleteSkillSource(ctx: RequestContext, id: string) {
  const s = await assertSourceRight(ctx, id);
  if (!can(ctx, "manage_skills")) throw new ForbiddenError("removing skill sources needs Manage skills");
  const running = await ctx.db.query("SELECT 1 FROM skill_imports WHERE source_id = $1 AND status = 'running'", [s.id]);
  if (running.rowCount) throw new ConflictError("an import from this source is running; try again when it has finished", null);
  await ctx.db.query("DELETE FROM skill_sources WHERE id = $1", [s.id]);
  await audit(ctx.db, ctx.actor.id, "delete_skill_source", s.id, { targetKind: "skill_source", targetLabel: s.name, details: auditDetails(s) });
  return { id: s.id, deleted: true, note: "Its skills stay, no longer linked to a source." };
}

// ---- runs --------------------------------------------------------------------------------------------------------

/**
 * Whether the run's actor may still use the source and its token. Checked on every run, scheduled ones included:
 * losing Manage skills, the owner project, or Manage settings in a project whose connection it borrows stops it.
 */
export async function assertSourceUsable(ctx: RequestContext, s: SourceRow): Promise<void> {
  if (ctx.actor.kind !== "human" || ctx.actor.disabled) throw new ForbiddenError("the source's owner can't manage skills any more; a Skills manager can take it over");
  if (!can(ctx, "manage_skills")) throw new ForbiddenError("the source's owner can't manage skills any more; a Skills manager can take it over");
  if (s.owner_scope_id && !(await canReadScope(ctx, s.owner_scope_id))) throw new ForbiddenError("the source's project is no longer readable to whoever runs it; a Skills manager there can take it over");
  if (s.kind !== "git") return;
  if (s.connection_id) {
    const { rows } = await ctx.db.query<{ name: string; enabled: boolean; scope_id: string; scope_kind: string; kind: string }>(
      "SELECT c.name, c.enabled, c.scope_id, sc.kind AS scope_kind, c.kind FROM connections c JOIN scopes sc ON sc.id = c.scope_id WHERE c.id = $1",
      [s.connection_id],
    );
    const c = rows[0];
    if (!c) throw new ValidationError("the source's git connection was removed; choose another or a token");
    if (!ctx.settings.connections?.enabled) throw new ValidationError("Connections are switched off (CONNECTIONS=off), so the git connection can't be used");
    if (!c.enabled) throw new ValidationError(`the git connection ${c.name} is switched off`);
    if (c.scope_kind !== "team" && !(await canManage(ctx, { id: c.scope_id, kind: c.scope_kind }))) throw new ForbiddenError(`the git connection ${c.name} is no longer yours to use`);
    await checkConnectionUse(ctx, c, repoPathOf({ config: { provider: s.provider! } }, s.repository ?? ""), s.owner_scope_id);
  } else if (s.api_url) {
    checkSkillApiUrl(s.api_url, s.provider!, ctx.settings);
  }
}

interface GitAccess {
  provider: "gitlab" | "github";
  api: string;
  headers: Record<string, string>;
  token: string | null;
  host: string;
}

async function gitAccess(ctx: RequestContext, s: SourceRow): Promise<GitAccess> {
  const provider = s.provider!;
  let api: string;
  let token: string | null = null;
  if (s.connection_id) {
    const row = (await ctx.db.query<ConnectionRow>("SELECT * FROM connections WHERE id = $1", [s.connection_id])).rows[0]!;
    const secret = await openSecrets(ctx.db, ctx.settings, row);
    token = secret.token ?? null;
    api = (row.config.api_url || ctx.settings.connections?.endpoints?.[provider] || (provider === "gitlab" ? "https://gitlab.com/api/v4" : "https://api.github.com")).replace(/\/+$/, "");
  } else {
    api = checkSkillApiUrl(s.api_url, provider, ctx.settings);
    if (s.secret) {
      try {
        token = openJson(s.secret, ctx.settings.connections?.keys, aad(s.id)).value.token ?? null;
      } catch (err) {
        if (err instanceof SecretsUnavailableError) throw new ValidationError("the source's token can't be opened: CONNECTIONS_KEY isn't set or changed");
        throw err;
      }
    }
  }
  const headers = token ? gitHeaders({ config: { provider }, secret: { token } } as never) : { accept: provider === "gitlab" ? "application/json" : "application/vnd.github+json" };
  return { provider, api, headers, token, host: new URL(api).hostname };
}

async function get(ctx: RequestContext, g: GitAccess, url: string, binary = false): Promise<PinnedResponse> {
  try {
    return await pinnedFetch(url, "http", skillsEnv(ctx.settings).net, {
      headers: g.headers,
      timeoutMs: binary ? 120_000 : 30_000,
      binary,
      maxBytes: binary ? (ctx.settings.skills?.importMaxBytes ?? 50 * 1024 * 1024) : 10 * 1024 * 1024,
    });
  } catch (err) {
    throw new ValidationError(networkError(err, g.host));
  }
}

async function getJson<T>(ctx: RequestContext, g: GitAccess, url: string): Promise<T> {
  const res = await get(ctx, g, url);
  if (res.status < 200 || res.status >= 300) throw new ValidationError(gitError(res, g.provider, g.token ? [g.token] : []));
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new ValidationError(`${g.provider === "gitlab" ? "GitLab" : "GitHub"} didn't answer with JSON`);
  }
}

const enc = encodeURIComponent;
const ghRepo = (repo: string) => repo.split("/").map(enc).join("/");

/** The commit a ref names (the default branch when there's none). */
async function resolveCommit(ctx: RequestContext, g: GitAccess, repo: string, ref: string | null): Promise<{ sha: string; ref: string }> {
  const base = g.provider === "gitlab" ? `${g.api}/projects/${enc(repo)}` : `${g.api}/repos/${ghRepo(repo)}`;
  let r = ref;
  if (!r) r = (await getJson<{ default_branch?: string }>(ctx, g, base)).default_branch ?? "HEAD";
  if (g.provider === "gitlab") {
    const c = await getJson<{ id?: string }>(ctx, g, `${base}/repository/commits/${enc(r)}`);
    if (!c.id || !/^[0-9a-f]{40}$/.test(c.id)) throw new ValidationError(`GitLab didn't name a commit for ${r}`);
    return { sha: c.id, ref: r };
  }
  const c = await getJson<{ sha?: string }>(ctx, g, `${base}/commits/${enc(r)}`);
  if (!c.sha || !/^[0-9a-f]{40}$/.test(c.sha)) throw new ValidationError(`GitHub didn't name a commit for ${r}`);
  return { sha: c.sha, ref: r };
}

/** The repository at one commit as a tar.gz: the archive endpoint, or the tree and raw files when that's refused. */
export async function fetchGitArchive(ctx: RequestContext, g: GitAccess, repo: string, sha: string): Promise<{ data: Uint8Array; via: "archive" | "tree" }> {
  const base = g.provider === "gitlab" ? `${g.api}/projects/${enc(repo)}` : `${g.api}/repos/${ghRepo(repo)}`;
  const url = g.provider === "gitlab" ? `${base}/repository/archive.tar.gz?sha=${sha}` : `${base}/tarball/${sha}`;
  const res = await get(ctx, g, url, true);
  if (res.status >= 200 && res.status < 300 && res.body) return { data: res.body, via: "archive" };
  if (![403, 406, 429].includes(res.status) && res.status < 500) throw new ValidationError(gitError(res, g.provider, g.token ? [g.token] : []));
  // Fallback: list the tree, fetch each blob, and pack them the same way.
  const items: TarItem[] = [];
  let total = 0;
  const max = ctx.settings.skills?.importMaxBytes ?? 50 * 1024 * 1024;
  const add = (path: string, data: Uint8Array) => {
    total += data.length;
    if (total > max) throw new ValidationError(`the repository is larger than ${Math.round(max / 1024 / 1024)} MB`);
    items.push({ path: `tree/${path}`, data });
  };
  if (g.provider === "gitlab") {
    const entries: { path: string; type: string; mode: string }[] = [];
    let page = `${base}/repository/tree?ref=${sha}&recursive=true&per_page=100&pagination=keyset`;
    for (let n = 0; n < 200 && page; n++) {
      const r = await get(ctx, g, page);
      if (r.status !== 200) throw new ValidationError(gitError(r, g.provider, g.token ? [g.token] : []));
      entries.push(...(JSON.parse(r.text) as typeof entries));
      if (entries.length > 10_000) throw new ValidationError("the repository has more than 10000 entries");
      const link = String(r.headers.link ?? "");
      const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
      page = next && new URL(next).origin === new URL(base).origin ? next : "";
    }
    for (const e of entries) {
      if (e.type !== "blob") continue;
      if (e.mode === "120000") {
        items.push({ path: `tree/${e.path}`, type: "2", linkname: "?" });
        continue;
      }
      const r = await get(ctx, g, `${base}/repository/files/${enc(e.path)}/raw?ref=${sha}`, true);
      if (r.status !== 200 || !r.body) throw new ValidationError(gitError(r, g.provider, g.token ? [g.token] : []));
      add(e.path, r.body);
    }
  } else {
    const t = await getJson<{ truncated?: boolean; tree: { path: string; type: string; mode: string; sha: string }[] }>(ctx, g, `${base}/git/trees/${sha}?recursive=1`);
    if (t.truncated) throw new ValidationError("GitHub returned a truncated tree; the repository is too large to read file by file");
    for (const e of t.tree) {
      if (e.type !== "blob") continue;
      if (e.mode === "120000") {
        items.push({ path: `tree/${e.path}`, type: "2", linkname: "?" });
        continue;
      }
      const b = await getJson<{ content?: string; encoding?: string }>(ctx, g, `${base}/git/blobs/${e.sha}`);
      add(e.path, Buffer.from(b.content ?? "", b.encoding === "base64" ? "base64" : "utf8"));
    }
  }
  const { gzipSync } = await import("node:zlib");
  return { data: gzipSync(writeTar(items)), via: "tree" };
}

/** Starts a run of a source in the background (409 while one is running); returns its import id. */
export async function syncSkillSource(ctx: RequestContext, id: string, opts: { force?: boolean; dry_run?: boolean } = {}) {
  const s = await assertSourceRight(ctx, id);
  if (s.kind !== "git") throw new ValidationError("an upload source is synced by uploading again");
  await assertSourceUsable(ctx, s);
  let importId: string;
  try {
    importId = (
      await ctx.db.query<{ id: string }>(
        "INSERT INTO skill_imports (source_id, kind, dry_run, forced, ref, owner_scope_id, started_by) VALUES ($1, 'git', $2, $3, $4, $5, $6) RETURNING id",
        [s.id, !!opts.dry_run, !!opts.force, s.ref, s.owner_scope_id, ctx.actor.id],
      )
    ).rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new ConflictError("an import from this source is already running", null);
    throw err;
  }
  const p = runSource(ctx, s, { importId, force: !!opts.force, dryRun: !!opts.dry_run, scheduled: false }).catch((err) => console.error(`[skills] source run failed: ${(err as Error).message}`));
  running.add(p);
  void p.finally(() => running.delete(p));
  return { import_id: importId, status: "running" as const };
}

/** One run: resolve the commit, skip it when nothing changed, download, import. Records the outcome on the source. */
export async function runSource(ctx: RequestContext, s: SourceRow, o: { importId: string; force: boolean; dryRun: boolean; scheduled: boolean }) {
  const fail = async (message: string) => {
    await ctx.db.query("UPDATE skill_imports SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1 AND status = 'running'", [o.importId, message.slice(0, 500)]);
    if (!o.dryRun) await sourceFailed(ctx.db, ctx.settings, s, message);
    return { import_id: o.importId, status: "failed" as const, error: message };
  };
  try {
    await assertSourceUsable(ctx, s);
    const g = await gitAccess(ctx, s);
    const repo = repoPathOf({ config: { provider: s.provider! } }, s.repository!);
    const { sha, ref } = await resolveCommit(ctx, g, repo, s.ref);
    await ctx.db.query("UPDATE skill_imports SET commit = $2, ref = $3 WHERE id = $1", [o.importId, sha, ref]);
    const filters = filtersKey(s);
    if (!o.force && !o.dryRun && s.last_commit === sha && s.last_filters === filters) {
      const report = { source: s.name, commit: sha, ref, unchanged_all: true, message: `nothing changed since ${sha.slice(0, 7)}`, importer_version: (await import("./types.js")).IMPORTER_VERSION };
      await ctx.db.query("UPDATE skill_imports SET status = 'done', finished_at = now(), report = $2 WHERE id = $1", [o.importId, JSON.stringify(report)]);
      await ctx.db.query("UPDATE skill_sources SET last_run_at = now(), last_ok_at = now(), last_error = NULL, failures = 0, next_run_at = CASE WHEN interval_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => interval_minutes) END WHERE id = $1", [s.id]);
      return { import_id: o.importId, status: "done" as const, report };
    }
    const { data } = await fetchGitArchive(ctx, g, repo, sha);
    const out = await runImport(ctx, { kind: "git", data, source: s, commit: sha, ref, dryRun: o.dryRun, force: o.force, scheduled: o.scheduled, importId: o.importId, repoName: repo.split("/").pop() ?? null });
    await ctx.db.query("UPDATE skill_sources SET last_run_at = now(), next_run_at = CASE WHEN interval_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => interval_minutes) END WHERE id = $1", [s.id]);
    if (out.status === "failed" && !o.dryRun) await sourceFailed(ctx.db, ctx.settings, s, out.error ?? "failed");
    return out;
  } catch (err) {
    const known = err instanceof ValidationError || err instanceof ForbiddenError || err instanceof NotFoundError;
    if (!known) console.error(`[skills] source ${s.name} failed: ${(err as Error).stack ?? err}`);
    return fail(known ? (err as Error).message : "the run failed unexpectedly");
  }
}

async function sourceFailed(db: Queryable, settings: Settings, s: SourceRow, message: string) {
  const { rows } = await db.query<{ failures: number }>(
    "UPDATE skill_sources SET last_run_at = now(), last_error = $2, failures = failures + 1, next_run_at = CASE WHEN interval_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => interval_minutes) END WHERE id = $1 RETURNING failures",
    [s.id, message.slice(0, 500)],
  );
  const n = rows[0]?.failures ?? 1;
  if (n === 1 || n % 10 === 0) {
    const to = [...new Set([...(s.owner_id ? [s.owner_id] : []), ...(await peopleWith(db, settings, "manage_skills", s.owner_scope_id))])];
    await tellSkill(db, settings, to, { title: `Skill source ${s.name}: the import failed${n > 1 ? ` (${n} times in a row)` : ""}`, body: message.slice(0, 500), link: "#/skills/import", targetId: s.id });
  }
}

/** Re-seals source tokens with the current CONNECTIONS_KEY (run at start-up, whether or not CONNECTIONS is on). */
export async function resealSkillSources(db: Queryable, settings: Settings, log: (msg: string) => void) {
  const keys = settings.connections?.keys;
  if (!keys?.key) return { resealed: 0, unreadable: 0 };
  const { rows } = await db.query<{ id: string; secret: string }>("SELECT id, secret FROM skill_sources WHERE secret IS NOT NULL");
  let resealed = 0;
  let unreadable = 0;
  for (const r of rows) {
    try {
      const { value, rotated } = openJson(r.secret, keys, aad(r.id));
      if (!rotated) continue;
      const u = await db.query("UPDATE skill_sources SET secret = $2 WHERE id = $1 AND secret = $3", [r.id, sealJson(value, keys, aad(r.id)), r.secret]);
      resealed += u.rowCount ?? 0;
    } catch (err) {
      if (err instanceof SecretsUnavailableError) unreadable++;
      else throw err;
    }
  }
  const hooks = await db.query<{ id: string; webhook_secret: string }>("SELECT id, webhook_secret FROM skill_sources WHERE webhook_secret IS NOT NULL");
  for (const r of hooks.rows) {
    try {
      const { value, rotated } = openJson(r.webhook_secret, keys, hookAad(r.id));
      if (!rotated) continue;
      const u = await db.query("UPDATE skill_sources SET webhook_secret = $2 WHERE id = $1 AND webhook_secret = $3", [r.id, sealJson(value, keys, hookAad(r.id)), r.webhook_secret]);
      resealed += u.rowCount ?? 0;
    } catch (err) {
      if (err instanceof SecretsUnavailableError) unreadable++;
      else throw err;
    }
  }
  if (resealed || unreadable) log(`skill sources: re-sealed ${resealed} token(s)${unreadable ? `; ${unreadable} can't be opened with the current keys` : ""}`);
  return { resealed, unreadable };
}

/** Due scheduled sources (3 per tick), each as its owner, with fresh permissions. */
export async function runDueSources(db: Db, settings: Settings, log: (msg: string) => void) {
  const { rows } = await db.query<SourceRow>(
    `SELECT ${SOURCE_COLUMNS} FROM skill_sources
      WHERE enabled AND kind = 'git' AND ((interval_minutes IS NOT NULL AND next_run_at <= now()) OR webhook_due_at <= now())
        AND NOT EXISTS (SELECT 1 FROM skill_imports i WHERE i.source_id = skill_sources.id AND i.status = 'running')
      ORDER BY least(next_run_at, webhook_due_at) LIMIT 3`,
  );
  for (const s of rows) {
    // A push the webhook queued (a sync was running or had just run) is covered by this run.
    await db.query("UPDATE skill_sources SET webhook_due_at = NULL WHERE id = $1", [s.id]);
    const owner: Actor | undefined = s.owner_id ? await actorById(db, s.owner_id) : undefined;
    const importId = (
      await db.query<{ id: string }>("INSERT INTO skill_imports (source_id, kind, scheduled, ref, owner_scope_id, started_by) VALUES ($1, 'git', true, $2, $3, $4) RETURNING id", [
        s.id,
        s.ref,
        s.owner_scope_id,
        s.owner_id,
      ])
    ).rows[0]!.id;
    if (!owner) {
      await db.query("UPDATE skill_imports SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1", [importId, "the source's owner can't manage skills any more; a Skills manager can take it over"]);
      await sourceFailed(db, settings, s, "the source's owner can't manage skills any more; a Skills manager can take it over");
      continue;
    }
    const ctx: RequestContext = { db, settings, actor: owner };
    const out = await runSource(ctx, s, { importId, force: false, dryRun: false, scheduled: true });
    if (out.status === "failed") log(`source ${s.name} failed: ${out.error}`);
  }
  return rows.length;
}

/**
 * Every five minutes, one instance at a time: due sources, stale running imports (over 15 minutes) marked failed,
 * old usage purged, unreferenced blobs older than a day deleted. Re-seals tokens once at start-up.
 */
export function startSkillJobs(db: Db, settings: Settings, log: (msg: string) => void, opts: { firstDelayMs?: number; intervalMs?: number } = {}) {
  const LOCK = 7_402_230;
  let resealed = false;
  async function tick() {
    const client = await db.connect().catch((err: Error) => void log(`skills failed: ${err.message}`));
    if (!client) return;
    try {
      const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [LOCK]);
      if (!rows[0]?.locked) return;
      try {
        if (!resealed) {
          await resealSkillSources(db, settings, log);
          resealed = true;
        }
        await db.query("UPDATE skill_imports SET status = 'failed', finished_at = now(), error = 'the run stopped (it took over 15 minutes, or the server restarted)' WHERE status = 'running' AND started_at < now() - interval '15 minutes'");
        await runDueSources(db, settings, log);
        await purgeOldUsage(db, settings.skills?.usageDays ?? 365);
        await db.query(
          "DELETE FROM skill_blobs b WHERE b.created_at < now() - interval '24 hours' AND NOT EXISTS (SELECT 1 FROM skill_files f WHERE f.sha256 = b.sha256)",
        );
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK]);
      }
    } catch (err) {
      log(`skills failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  let current: Promise<void> | null = null;
  const start = () => {
    if (current) return;
    current = tick().finally(() => (current = null));
  };
  const first = setTimeout(start, opts.firstDelayMs ?? 45_000);
  const timer = setInterval(start, opts.intervalMs ?? 5 * 60_000);
  first.unref();
  timer.unref();
  return {
    /** Runs one tick now (tests). */
    tick: () => {
      start();
      return current!;
    },
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await current;
      await flushSkillImports();
    },
  };
}

export async function getSkillImport(ctx: RequestContext, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError("import");
  const row = (
    await ctx.db.query<{ id: string; source_id: string | null; owner_scope_id: string | null; started_by: string | null }>("SELECT id, source_id, owner_scope_id, started_by FROM skill_imports WHERE id = $1", [id])
  ).rows[0];
  if (!row) throw new NotFoundError("import");
  const rights = await ownerRights(ctx, row.owner_scope_id);
  if (!rights.see) throw new NotFoundError("import");
  const { rows } = await ctx.db.query(
    `SELECT i.id, i.kind, i.status, i.dry_run, i.scheduled, i.forced, i.ref, i.commit, i.filename, i.layout, i.report, i.error, i.started_at, i.finished_at,
            CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name) END AS source,
            coalesce(nullif(u.display_name, ''), u.email) AS started_by
       FROM skill_imports i LEFT JOIN skill_sources s ON s.id = i.source_id LEFT JOIN users u ON u.id = i.started_by WHERE i.id = $1`,
    [id],
  );
  return rows[0];
}

export async function listSkillImports(ctx: RequestContext, sourceId?: string) {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("skill imports are for people who manage skills");
  const { rows } = await ctx.db.query<{ id: string; owner_scope_id: string | null }>(
    `SELECT i.id, i.owner_scope_id, i.kind, i.status, i.dry_run, i.scheduled, i.commit, i.filename, i.layout, i.error, i.started_at, i.finished_at, i.report->'counts' AS counts,
            CASE WHEN s.id IS NULL THEN NULL ELSE json_build_object('id', s.id, 'name', s.name) END AS source,
            coalesce(nullif(u.display_name, ''), u.email) AS started_by
       FROM skill_imports i LEFT JOIN skill_sources s ON s.id = i.source_id LEFT JOIN users u ON u.id = i.started_by
      WHERE ($1::uuid IS NULL OR i.source_id = $1) ORDER BY i.started_at DESC LIMIT 100`,
    [sourceId ?? null],
  );
  const out = [];
  for (const r of rows) {
    const rights = await ownerRights(ctx, r.owner_scope_id);
    if (rights.see) out.push({ ...r, owner_scope_id: undefined });
  }
  return { imports: out };
}

// ---- push webhook ----------------------------------------------------------------------------------------------

/**
 * A git source's push webhook: POST /api/skill-sources/:id/webhook, with no sign-in. GitLab sends the source's
 * webhook secret in X-Gitlab-Token; GitHub signs the body with it (X-Hub-Signature-256). A push to the ref the source
 * follows (its default branch when it names none) of the repository it reads starts a sync as the source's owner,
 * exactly like a scheduled run: same permission checks, same review (versions wait for a second person unless an
 * Administrator let the source publish directly). At most one sync per source a minute; a push that comes while one
 * runs, or within the minute, is queued for the skill jobs (within five minutes). Requests are limited per source.
 */

const hookAad = (id: string) => `skill_source_webhook:${id}`;
export const webhookPath = (id: string) => `/api/skill-sources/${id}/webhook`;

/** Requests per source per minute before 429, and seconds between syncs a webhook starts (tests change them). */
export const WEBHOOK_LIMITS = { requestsPerMinute: 30, syncEverySeconds: 60 };
const hits = new Map<string, number[]>();
/** Refused attempts audited at most once a minute per source, so a flood doesn't fill the audit log. */
const refusalAudited = new Map<string, number>();

function overLimit(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
  return recent.length > WEBHOOK_LIMITS.requestsPerMinute;
}

/** Tests: forget the counts. */
export function resetWebhookLimits() {
  hits.clear();
  refusalAudited.clear();
}

/** Makes (or replaces) a source's webhook secret; returns it once. Needs Manage skills and CONNECTIONS_KEY. */
export async function setWebhookSecret(ctx: RequestContext, id: string) {
  const s = await assertSourceRight(ctx, id);
  if (!can(ctx, "manage_skills")) throw new ForbiddenError("a source's webhook needs Manage skills");
  if (s.kind !== "git") throw new ValidationError("only a git source has a push webhook");
  if (!canSeal(ctx.settings.connections?.keys)) throw new ValidationError("storing a webhook secret needs CONNECTIONS_KEY on the server (an Administrator sets it)");
  const secret = randomBytes(24).toString("base64url");
  const replaced = (await ctx.db.query<{ had: boolean }>("SELECT webhook_secret IS NOT NULL AS had FROM skill_sources WHERE id = $1", [s.id])).rows[0]?.had ?? false;
  await ctx.db.query("UPDATE skill_sources SET webhook_secret = $2, webhook_secret_hint = $3, updated_at = now() WHERE id = $1", [s.id, sealJson({ secret }, ctx.settings.connections?.keys, hookAad(s.id)), secret.slice(-4)]);
  await audit(ctx.db, ctx.actor.id, "set_skill_source_webhook", s.id, { targetKind: "skill_source", targetLabel: s.name, details: { name: s.name, change: replaced ? "replaced" : "created" } });
  return {
    secret,
    path: webhookPath(s.id),
    url: ctx.settings.publicUrl ? `${ctx.settings.publicUrl}${webhookPath(s.id)}` : null,
    note: "Copy the secret now: it isn't shown again. In GitLab: Settings › Webhooks, this URL, the secret as Secret token, Push events (the source's branch). In GitHub: content type application/json, the secret as Secret, just the push event.",
  };
}

export async function clearWebhookSecret(ctx: RequestContext, id: string) {
  const s = await assertSourceRight(ctx, id);
  if (!can(ctx, "manage_skills")) throw new ForbiddenError("a source's webhook needs Manage skills");
  await ctx.db.query("UPDATE skill_sources SET webhook_secret = NULL, webhook_secret_hint = NULL, webhook_due_at = NULL, updated_at = now() WHERE id = $1", [s.id]);
  await audit(ctx.db, ctx.actor.id, "remove_skill_source_webhook", s.id, { targetKind: "skill_source", targetLabel: s.name, details: { name: s.name } });
  return { id: s.id, webhook: null };
}

export interface WebhookAnswer {
  status: number;
  body: Record<string, unknown>;
}

function sameText(a: string, b: string): boolean {
  // Hash both so the comparison takes the same time whatever the lengths.
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** One webhook delivery: headers (lower-case names) and the raw body. Never throws for a client's mistake. */
export async function receiveSkillWebhook(db: Db, settings: Settings, id: string, headers: Record<string, string | undefined>, raw: Buffer): Promise<WebhookAnswer> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 404, body: { error: "not found" } };
  if (overLimit(id)) return { status: 429, body: { error: "too many webhook calls for this source; try again in a minute" } };
  const row = (await db.query<SourceRow & { webhook_secret: string | null }>(`SELECT ${SOURCE_COLUMNS}, webhook_secret FROM skill_sources WHERE id = $1`, [id])).rows[0];
  // An unknown source and one without a webhook look the same.
  if (!row || row.kind !== "git" || !row.webhook_secret) return { status: 404, body: { error: "not found" } };
  let secret: string;
  try {
    secret = openJson(row.webhook_secret, settings.connections?.keys, hookAad(row.id)).value.secret ?? "";
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return { status: 503, body: { error: "the webhook secret can't be opened on this server (CONNECTIONS_KEY)" } };
    throw err;
  }
  const gitlab = headers["x-gitlab-token"];
  const signature = headers["x-hub-signature-256"];
  const ok =
    !!secret &&
    ((gitlab !== undefined && sameText(gitlab, secret)) ||
      (signature !== undefined && sameText(signature, `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`)));
  if (!ok) {
    const last = refusalAudited.get(row.id) ?? 0;
    if (Date.now() - last > 60_000) {
      refusalAudited.set(row.id, Date.now());
      await audit(db, null, "refuse_skill_source_webhook", row.id, { targetKind: "skill_source", targetLabel: row.name, details: { name: row.name, reason: gitlab === undefined && signature === undefined ? "no secret sent" : "wrong secret" } });
    }
    return { status: 401, body: { error: "wrong or missing webhook secret" } };
  }
  const event = (headers["x-gitlab-event"] ?? headers["x-github-event"] ?? "").toLowerCase();
  if (event === "ping") return { status: 200, body: { ok: true, message: "pong" } };
  if (event && event !== "push hook" && event !== "push" && event !== "system hook") return { status: 202, body: { ignored: `${event} events don't sync skills; send push events` } };
  let payload: { ref?: unknown; after?: unknown; project?: { path_with_namespace?: unknown; default_branch?: unknown }; repository?: { full_name?: unknown; default_branch?: unknown } };
  try {
    payload = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return { status: 400, body: { error: "the body isn't JSON (GitHub: choose content type application/json)" } };
  }
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  const repo = String(payload.project?.path_with_namespace ?? payload.repository?.full_name ?? "");
  if (repo && row.repository && repo.toLowerCase() !== row.repository.toLowerCase()) {
    return { status: 202, body: { ignored: `a push to ${repo}; this source reads ${row.repository}` } };
  }
  const follows = row.ref ?? String(payload.project?.default_branch ?? payload.repository?.default_branch ?? "");
  if (!ref || !follows || (ref !== `refs/heads/${follows}` && ref !== `refs/tags/${follows}` && ref !== follows)) {
    return { status: 202, body: { ignored: `a push to ${ref || "no ref"}; this source follows ${follows || "its default branch"}` } };
  }
  if (!row.enabled) return { status: 202, body: { ignored: "the source is switched off" } };
  const owner = row.owner_id ? await actorById(db, row.owner_id) : undefined;
  if (!owner) return { status: 409, body: { error: "the source has no owner who can run it; a Skills manager can take it over" } };
  const commit = typeof payload.after === "string" && /^[0-9a-f]{7,64}$/i.test(payload.after) ? payload.after : null;
  const queue = async (why: string): Promise<WebhookAnswer> => {
    await db.query("UPDATE skill_sources SET webhook_due_at = coalesce(least(webhook_due_at, now() + interval '1 minute'), now() + interval '1 minute') WHERE id = $1", [row.id]);
    return { status: 202, body: { queued: true, message: `${why}: the push is queued and synced within a few minutes` } };
  };
  // One sync a minute per source, across replicas (the update is the lock).
  const won = await db.query(
    "UPDATE skill_sources SET webhook_at = now(), webhook_due_at = NULL WHERE id = $1 AND (webhook_at IS NULL OR webhook_at < now() - make_interval(secs => $2)) RETURNING id",
    [row.id, WEBHOOK_LIMITS.syncEverySeconds],
  );
  if (!won.rowCount) return queue("a webhook started a sync less than a minute ago");
  let importId: string;
  try {
    importId = (
      await db.query<{ id: string }>("INSERT INTO skill_imports (source_id, kind, scheduled, ref, owner_scope_id, started_by) VALUES ($1, 'git', true, $2, $3, $4) RETURNING id", [
        row.id,
        row.ref,
        row.owner_scope_id,
        row.owner_id,
      ])
    ).rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return queue("a sync of this source is running");
    throw err;
  }
  await audit(db, null, "skill_source_webhook", row.id, {
    targetKind: "skill_source",
    targetLabel: row.name,
    details: { name: row.name, ref, commit, import_id: importId, provider: gitlab !== undefined ? "gitlab" : "github", run_as: owner.email },
  });
  const ctx: RequestContext = { db, settings, actor: owner };
  const { webhook_secret: _hidden, ...source } = row;
  const p = runSource(ctx, source, { importId, force: false, dryRun: false, scheduled: true }).catch((err) => console.error(`[skills] webhook run failed: ${(err as Error).message}`));
  running.add(p);
  void p.finally(() => running.delete(p));
  return { status: 202, body: { import_id: importId, status: "running" } };
}

import type { Queryable } from "../db/pool.js";
import { repoKey } from "./bootstrap.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { emitChanged } from "./events.js";
import { readableScopes } from "./permissions.js";
import { redact } from "./redaction.js";
import { rulesForEdit } from "./rules.js";
import { findOwnSession, ownSession, type SessionRow } from "./sessions.js";

/**
 * Sessions coordinating their work: a **claim** says "this session is working on these files", so another
 * session (yours or a teammate's) about to edit them is told who is there first. The Claude Code plugin
 * claims a file automatically when its session edits it (for 30 minutes after the last edit) and checks
 * before every edit; agents can also claim and release on purpose. Claims only warn: nothing is locked.
 */

const AUTO_MINUTES = 30;
const DEFAULT_MINUTES = 120;
const MAX_MINUTES = 8 * 60;
const MAX_PATHS = 50;

/** A repository-relative path in one form: forward slashes, no "./", no leading or trailing slash. */
export function cleanPath(p: string): string {
  const out = p
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "");
  if (!out || out === ".") throw new ValidationError("give a file or folder path relative to the repository root");
  if (out.length > 500) throw new ValidationError("that path is too long");
  if (/(^|\/)\.\.(\/|$)/.test(out)) throw new ValidationError(`${p} leaves the repository`);
  return out;
}

/** The repository a session works in, as a comparable key (every clone of one remote matches). */
function sessionRepo(s: SessionRow): string {
  const key = repoKey(s.repo_url);
  if (!key) throw new ValidationError("this session has no git remote, so its files can't be claimed (register_session with repo)");
  return key;
}

/** Sessions the caller may see, as in list_sessions: their own, and project-visible ones in projects they can read. */
const VISIBLE = `(s.user_id = $1 OR (s.visibility = 'project' AND s.scope_id IS NOT NULL AND ($2::uuid[] IS NULL OR s.scope_id = ANY($2))))`;
const ACTIVE = `c.released_at IS NULL AND c.expires_at > now() AND s.ended_at IS NULL`;
const OVERLAPS = (p: string) => `(c.path = ${p} OR starts_with(${p}, c.path || '/') OR starts_with(c.path, ${p} || '/'))`;

/** Other sessions' active claims overlapping these paths in this repository. */
async function conflicts(ctx: RequestContext, s: SessionRow, repo: string, paths: string[]) {
  if (!paths.length) return [];
  const { rows } = await ctx.db.query<{ path: string; claimed: string; session: string; owner: string; note: string; auto: boolean; updated_at: string; mine: boolean }>(
    `SELECT DISTINCT ON (p.path, c.id) p.path, c.path AS claimed, s.handle AS session, coalesce(u.display_name, u.email, u.subject) AS owner, c.note, c.auto, c.updated_at, s.user_id = $1 AS mine
       FROM unnest($5::text[]) AS p(path)
       JOIN work_claims c ON c.repo_key = $3 AND ${OVERLAPS("p.path")}
       JOIN agent_sessions s ON s.id = c.session_id JOIN users u ON u.id = s.user_id
      WHERE ${ACTIVE} AND c.session_id <> $4 AND ${VISIBLE}
      ORDER BY p.path, c.id, c.updated_at DESC`,
    [ctx.actor.id, await readableScopes(ctx), repo, s.id, paths],
  );
  return rows;
}

const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  return m < 1 ? "just now" : m === 1 ? "1 minute ago" : m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)} h ago`;
};

function describe(c: Awaited<ReturnType<typeof conflicts>>[number]) {
  const what = c.auto ? `edited ${c.claimed} ${ago(c.updated_at)}` : `claimed ${c.claimed}${c.note ? ` (${c.note})` : ""}`;
  return `${c.session} (${c.mine ? "your other session" : c.owner}) ${what}`;
}

async function upsertClaims(db: Queryable, s: SessionRow, repo: string, paths: string[], note: string, minutes: number, auto: boolean) {
  await db.query(
    `INSERT INTO work_claims (session_id, repo_key, path, note, auto, expires_at)
     SELECT $1, $2, p, $3, $4, now() + make_interval(mins => $5) FROM unnest($6::text[]) AS p
     ON CONFLICT (session_id, repo_key, path) DO UPDATE
        SET note = CASE WHEN EXCLUDED.auto AND NOT work_claims.auto AND work_claims.released_at IS NULL THEN work_claims.note ELSE EXCLUDED.note END,
            -- An automatic touch never shortens or downgrades a deliberate claim.
            auto = CASE WHEN work_claims.released_at IS NULL THEN work_claims.auto AND EXCLUDED.auto ELSE EXCLUDED.auto END,
            expires_at = CASE WHEN work_claims.released_at IS NULL THEN greatest(work_claims.expires_at, EXCLUDED.expires_at) ELSE EXCLUDED.expires_at END,
            released_at = NULL, updated_at = now()`,
    [s.id, repo, note, auto, minutes, paths],
  );
}

/** Claim files or folders this session is working on; says who else is already there. */
export async function claimWork(ctx: RequestContext, input: { session: string; paths: string[]; note?: string; minutes?: number }) {
  const s = await ownSession(ctx, input.session);
  const repo = sessionRepo(s);
  const paths = [...new Set(input.paths.map(cleanPath))];
  if (!paths.length) throw new ValidationError("paths: at least one file or folder");
  if (paths.length > MAX_PATHS) throw new ValidationError(`claim at most ${MAX_PATHS} paths at once (claim a folder instead)`);
  const note = redact((input.note ?? "").trim().slice(0, 300)).text;
  const minutes = Math.min(Math.max(Math.round(input.minutes ?? DEFAULT_MINUTES), 5), MAX_MINUTES);
  const others = await conflicts(ctx, s, repo, paths);
  await upsertClaims(ctx.db, s, repo, paths, note, minutes, false);
  emitChanged();
  return {
    session: s.handle,
    claimed: paths,
    expires_in_minutes: minutes,
    others_here: others.map((c) => ({ path: c.path, session: c.session, owner: c.mine ? "you" : c.owner, claimed: c.claimed, note: c.note, since: c.updated_at })),
    how: others.length
      ? `Others are working on some of these: ${others.map(describe).join("; ")}. Coordinate before changing them (ask_session), or pick other work. Claims only warn; nothing is locked.`
      : "Claimed. Other sessions about to edit these files will be told you're on them. release_work when you're done (claims also expire).",
  };
}

/** Release this session's claims (all of them, or the given paths). */
export async function releaseWork(ctx: RequestContext, input: { session: string; paths?: string[] }) {
  const s = await ownSession(ctx, input.session);
  const paths = input.paths?.length ? input.paths.map(cleanPath) : null;
  const { rowCount } = await ctx.db.query(
    "UPDATE work_claims SET released_at = now(), updated_at = now() WHERE session_id = $1 AND released_at IS NULL AND ($2::text[] IS NULL OR path = ANY($2))",
    [s.id, paths],
  );
  emitChanged();
  return { session: s.handle, released: rowCount ?? 0 };
}

/** Active claims the caller can see (in one project, or one repository), newest first. */
export async function listClaims(ctx: RequestContext, opts: { project?: string; repo?: string } = {}) {
  const readable = await readableScopes(ctx);
  let scopeId: string | null = null;
  if (opts.project) {
    const r = (await ctx.db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1", [opts.project])).rows[0];
    if (!r || (readable !== null && !readable.includes(r.id))) throw new NotFoundError(`project ${opts.project}`);
    scopeId = r.id;
  }
  const { rows } = await ctx.db.query(
    `SELECT c.path, c.note, c.auto, c.updated_at, c.expires_at, s.handle AS session, sc.slug AS project, s.component AS repository,
            coalesce(u.display_name, u.email, u.subject) AS owner, s.user_id = $1 AS mine
       FROM work_claims c JOIN agent_sessions s ON s.id = c.session_id JOIN users u ON u.id = s.user_id LEFT JOIN scopes sc ON sc.id = s.scope_id
      WHERE ${ACTIVE} AND ${VISIBLE} AND ($3::uuid IS NULL OR s.scope_id = $3) AND ($4::text IS NULL OR c.repo_key = $4)
      ORDER BY c.updated_at DESC LIMIT 300`,
    [ctx.actor.id, readable, scopeId, opts.repo ? repoKey(opts.repo) : null],
  );
  return { claims: rows, note: "Claims only warn; nothing is locked. Automatic ones come from files a session edited in the last 30 minutes." };
}

// ---- For the Claude Code hooks --------------------------------------------------------------------------

type HookRef = { session?: string; client?: string; client_session_id?: string };

/** Before an edit: who else is working on this file. Empty when nobody (or the session has no remote). */
export async function checkPath(ctx: RequestContext, input: HookRef & { path: string }) {
  const s = await findOwnSession(ctx, input);
  const repo = repoKey(s.repo_url);
  const path = cleanPath(input.path);
  // The project's rules for agents (read first, never edit, heads-up), whether or not the repository is known.
  const rules = await rulesForEdit(ctx.db, s, path);
  if (!repo) return { path, conflicts: [], rules };
  const found = await conflicts(ctx, s, repo, [path]);
  return { path, conflicts: found.map((c) => ({ session: c.session, owner: c.mine ? "you" : c.owner, claimed: c.claimed, note: c.note, auto: c.auto, since: c.updated_at, text: describe(c) })), rules };
}

/** After an edit: claim the file automatically for 30 minutes. */
export async function touchPath(ctx: RequestContext, input: HookRef & { path: string }) {
  const s = await findOwnSession(ctx, input);
  const repo = repoKey(s.repo_url);
  if (!repo) return { claimed: false };
  await upsertClaims(ctx.db, s, repo, [cleanPath(input.path)], "", AUTO_MINUTES, true);
  return { claimed: true };
}

/** Active claims per session, for list_sessions and the Sessions page. */
export async function claimsBySession(db: Queryable, sessionIds: string[]) {
  if (!sessionIds.length) return new Map<string, string[]>();
  const { rows } = await db.query<{ session_id: string; paths: string[] }>(
    `SELECT c.session_id, (array_agg(c.path ORDER BY c.updated_at DESC))[1:10] AS paths FROM work_claims c JOIN agent_sessions s ON s.id = c.session_id
      WHERE c.session_id = ANY($1) AND ${ACTIVE} GROUP BY c.session_id`,
    [sessionIds],
  );
  return new Map(rows.map((r) => [r.session_id, r.paths]));
}

/** A handoff was accepted: the sender's claims move to the session that took it (or are released for a person). */
export async function transferClaims(db: Queryable, fromSessionId: string, toSessionId: string | null) {
  if (toSessionId)
    await db.query(
      `UPDATE work_claims c SET session_id = $2, updated_at = now() WHERE c.session_id = $1 AND c.released_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM work_claims d WHERE d.session_id = $2 AND d.repo_key = c.repo_key AND d.path = c.path)`,
      [fromSessionId, toSessionId],
    );
  await db.query("UPDATE work_claims SET released_at = now(), updated_at = now() WHERE session_id = $1 AND released_at IS NULL", [fromSessionId]);
}

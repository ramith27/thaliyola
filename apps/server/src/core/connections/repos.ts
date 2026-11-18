import type { Db, Queryable } from "../../db/pool.js";
import { addComponentTechnologies } from "../advisories.js";
import { emitChanged } from "../events.js";
import { languagesToTech, parseRepoUrl } from "../repo-detect.js";
import { repoInfo, servesHost } from "./git.js";
import type { ConnTarget, DriverEnv } from "./types.js";

/**
 * Git connections and the project's repositories: a project's own GitHub or GitLab token reads its repositories'
 * facts on a schedule (default branch, last commit, languages, open pull requests, kept on the repository), is used by
 * stack detection in preference to the server's token, and lets read_repo_file read files. A token is only ever
 * sent to the host it was set up for. A connection tied to one repository serves that one; a connection without one
 * serves every repository of the project on its host that doesn't have its own.
 */

interface GitConnRow {
  id: string;
  scope_id: string;
  component_id: string | null;
  config: Record<string, string>;
  secret: string | null;
  options: Record<string, unknown>;
  name: string;
}

/**
 * The git connection to use for a repository of a project: one tied to that repository first, then one for the whole
 * project, among enabled connections whose host is the repository's. Null when there's none (or the URL isn't one).
 */
export async function gitConnectionFor(db: Queryable, scopeId: string, component: { id: string; repo_url: string | null }): Promise<GitConnRow | null> {
  const host = component.repo_url ? parseRepoUrl(component.repo_url)?.host : null;
  if (!host) return null;
  const { rows } = await db.query<GitConnRow>(
    `SELECT id, scope_id, component_id, config, secret, options, name FROM connections
      WHERE scope_id = $1 AND kind = 'git' AND enabled AND (component_id = $2 OR component_id IS NULL)
      ORDER BY component_id IS NULL, created_at`,
    [scopeId, component.id],
  );
  return rows.find((r) => servesHost({ config: r.config }, host)) ?? null;
}

export interface RepoSyncSummary {
  repositories: number;
  synced: number;
  failed: { repository: string; error: string }[];
  host: string;
}

/** Reads the facts of every repository the connection serves, and keeps them on the repository. */
export async function syncRepos(db: Db, conn: { id: string; scope_id: string; component_id: string | null }, target: ConnTarget, env: DriverEnv, describe: (err: unknown) => string): Promise<RepoSyncSummary> {
  const { rows } = await db.query<{ id: string; slug: string; repo_url: string }>(
    `SELECT c.id, c.slug, c.repo_url FROM components c
      WHERE c.scope_id = $1 AND c.repo_url IS NOT NULL AND ($2::uuid IS NULL OR c.id = $2)
        -- Repositories with a connection of their own are that one's to sync.
        AND ($2::uuid IS NOT NULL OR NOT EXISTS (SELECT 1 FROM connections g WHERE g.kind = 'git' AND g.enabled AND g.component_id = c.id AND g.id <> $3))
      ORDER BY c.slug LIMIT 50`,
    [conn.scope_id, conn.component_id, conn.id],
  );
  const mine = rows.map((r) => ({ ...r, parsed: parseRepoUrl(r.repo_url) })).filter((r) => r.parsed && servesHost(target, r.parsed.host));
  const out: RepoSyncSummary = { repositories: mine.length, synced: 0, failed: [], host: target.config.api_url ? new URL(target.config.api_url).hostname : target.config.provider === "gitlab" ? "gitlab.com" : "github.com" };
  for (const r of mine) {
    try {
      const info = await repoInfo(target, env, r.parsed!.path);
      await db.query("UPDATE components SET repo_info = $2, repo_synced_at = now() WHERE id = $1", [r.id, { ...info, connection: conn.id, error: null }]);
      const tech = languagesToTech(info.languages);
      if (tech.length) await addComponentTechnologies(db, conn.scope_id, r.slug, tech);
      out.synced++;
    } catch (err) {
      const error = describe(err);
      // Keep what was read before; say why this time failed.
      await db.query("UPDATE components SET repo_info = coalesce(repo_info, '{}'::jsonb) || jsonb_build_object('error', $2::text, 'connection', $3::text) WHERE id = $1", [r.id, error, conn.id]);
      out.failed.push({ repository: r.slug, error });
    }
  }
  if (mine.length) emitChanged();
  return out;
}

/** "Synced 3 repositories on github.com." */
export function repoSyncDetail(s: RepoSyncSummary): string {
  if (!s.repositories) return `No repositories of this project are on ${s.host} yet: add their URLs under Repositories.`;
  const ok = `Synced ${s.synced} of ${s.repositories} ${s.repositories === 1 ? "repository" : "repositories"} on ${s.host}.`;
  return s.failed.length ? `${ok} Couldn't read ${s.failed.map((f) => `${f.repository} (${f.error})`).join(", ")}.`.slice(0, 500) : ok;
}

/** A repository's facts for people and agents (no connection id). */
export function repoFacts(info: Record<string, unknown> | null, syncedAt: string | null) {
  if (!info) return null;
  const { connection: _c, ...rest } = info as Record<string, unknown> & { connection?: unknown };
  return { ...rest, synced_at: syncedAt };
}

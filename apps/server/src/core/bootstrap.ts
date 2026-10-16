import type { Queryable } from "../db/pool.js";
import { reindexArticle, reindexFinding } from "./chunking.js";

/** Direct inserts for bootstrapping and tests. Normal writes go through review (M1). */

export async function createScope(db: Queryable, kind: "team" | "project" | "library", slug: string, name: string, description = "") {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO scopes (kind, slug, name, description) VALUES ($1, $2, $3, $4) RETURNING id",
    [kind, slug, name, description],
  );
  return rows[0]!.id;
}

/**
 * A repository URL in a comparable form: host/path, lower case, without the scheme,
 * user, ".git" or trailing slash ("git@github.com:Org/App.git" → "github.com/org/app").
 */
export function repoKey(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  return url
    .trim()
    .replace(/^([a-z+]+:\/\/)?([^@/]+@)?/i, "")
    .replace(/^([^/:]+):(?!\d+\/)/, "$1/")
    .replace(/(\.git)?\/*$/i, "")
    .toLowerCase();
}

export async function createComponent(db: Queryable, scopeId: string, slug: string, kind: string, repoUrl?: string, description = "") {
  const { rows } = await db.query<{ id: string }>(
    "INSERT INTO components (scope_id, slug, kind, repo_url, repo_key, description) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [scopeId, slug, kind, repoUrl ?? null, repoKey(repoUrl), description],
  );
  return rows[0]!.id;
}

export async function insertArticle(
  db: Queryable,
  a: {
    scopeId: string;
    type: string;
    title: string;
    body: string;
    path?: string;
    status?: string;
    tags?: string[];
    componentIds?: string[];
    ownerId?: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO articles (scope_id, type, title, path, body_md, status, tags, component_ids, owner_id, created_by, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, CASE WHEN $6 = 'published' THEN now() END) RETURNING id`,
    [a.scopeId, a.type, a.title, a.path ?? "", a.body, a.status ?? "published", a.tags ?? [], a.componentIds ?? [], a.ownerId ?? null],
  );
  const id = rows[0]!.id;
  await reindexArticle(db, { id, scope_id: a.scopeId, title: a.title, body_md: a.body });
  return id;
}

export async function insertFinding(
  db: Queryable,
  f: {
    scopeId: string;
    type: string;
    title: string;
    symptoms: string;
    rootCause: string;
    fix: string;
    status?: string;
    tags?: string[];
    componentIds?: string[];
    authorId?: string;
  },
) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO findings (scope_id, type, title, symptoms, root_cause, fix, status, tags, component_ids, author_id, last_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $7 = 'published' THEN now() END) RETURNING id`,
    [f.scopeId, f.type, f.title, f.symptoms, f.rootCause, f.fix, f.status ?? "published", f.tags ?? [], f.componentIds ?? [], f.authorId ?? null],
  );
  const id = rows[0]!.id;
  await reindexFinding(db, { id, scope_id: f.scopeId, title: f.title, symptoms: f.symptoms, root_cause: f.rootCause, fix: f.fix });
  return id;
}

export async function relate(
  db: Queryable,
  from: { kind: string; id: string },
  kind: string,
  to: { kind: string; id: string },
) {
  await db.query(
    "INSERT INTO relations (from_kind, from_id, kind, to_kind, to_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    [from.kind, from.id, kind, to.kind, to.id],
  );
}

export async function tagEntity(db: Queryable, kind: string, name: string, target: { kind: string; id: string }, aliases: string[] = []) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO entities (kind, name, aliases) VALUES ($1, $2, $3)
     ON CONFLICT (kind, name) DO UPDATE SET aliases = EXCLUDED.aliases RETURNING id`,
    [kind, name, aliases],
  );
  await db.query("INSERT INTO entity_links (entity_id, target_kind, target_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
    rows[0]!.id,
    target.kind,
    target.id,
  ]);
}

export async function addSourceLink(db: Queryable, target: { kind: string; id: string }, system: string, url: string, label = "") {
  await db.query("INSERT INTO source_links (target_kind, target_id, system, url, label) VALUES ($1, $2, $3, $4, $5)", [
    target.kind,
    target.id,
    system,
    url,
    label,
  ]);
}

/** Creates the Team and Library scopes if missing. Safe to run repeatedly. */
export async function ensureBaseScopes(db: Queryable) {
  await db.query(
    `INSERT INTO scopes (kind, slug, name, description) VALUES
       ('team', 'team', 'Team', 'Org-wide systems, metrics, runbooks and decisions'),
       ('library', 'library', 'Library', 'Reusable designs, patterns, UI components and contracts shared across projects')
     ON CONFLICT DO NOTHING`,
  );
}

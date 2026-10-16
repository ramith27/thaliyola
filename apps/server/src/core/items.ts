import type { Queryable } from "../db/pool.js";
import { splitSections } from "./chunking.js";
import { NotFoundError, type RequestContext } from "./context.js";
import { getScopeBySlug } from "./scopes.js";

export interface RelatedItem {
  relation: string;
  direction: "out" | "in";
  kind: string;
  id: string;
  label: string;
  type: string | null;
  status: string | null;
  scope: string | null;
}

/** Typed links in both directions, with a readable label for each end. */
export async function relatedItems(db: Queryable, id: string): Promise<RelatedItem[]> {
  const { rows } = await db.query<RelatedItem>(
    `WITH r AS (
       SELECT kind AS relation, 'out' AS direction, to_kind AS other_kind, to_id AS other_id FROM relations WHERE from_id = $1
       UNION ALL
       SELECT kind, 'in', from_kind, from_id FROM relations WHERE to_id = $1
     )
     SELECT r.relation, r.direction, r.other_kind AS kind, r.other_id AS id,
            coalesce(a.title, f.title, s.name, ps.name || ' / ' || c.slug) AS label,
            coalesce(a.type, f.type, s.kind, c.kind) AS type,
            coalesce(a.status, f.status) AS status,
            coalesce(sa.slug, sf.slug, s.slug, ps.slug) AS scope
       FROM r
       LEFT JOIN articles a   ON r.other_kind = 'article'   AND a.id = r.other_id
       LEFT JOIN scopes sa    ON sa.id = a.scope_id
       LEFT JOIN findings f   ON r.other_kind = 'finding'   AND f.id = r.other_id
       LEFT JOIN scopes sf    ON sf.id = f.scope_id
       LEFT JOIN scopes s     ON r.other_kind = 'scope'     AND s.id = r.other_id
       LEFT JOIN components c ON r.other_kind = 'component' AND c.id = r.other_id
       LEFT JOIN scopes ps    ON ps.id = c.scope_id
      ORDER BY r.relation, label`,
    [id],
  );
  return rows;
}

async function sourceLinks(db: Queryable, id: string) {
  const { rows } = await db.query<{ system: string; url: string; label: string }>(
    "SELECT system, url, label FROM source_links WHERE target_id = $1 ORDER BY system, url",
    [id],
  );
  return rows;
}

async function entitiesFor(db: Queryable, id: string) {
  const { rows } = await db.query<{ kind: string; name: string }>(
    `SELECT e.kind, e.name FROM entity_links el JOIN entities e ON e.id = el.entity_id
      WHERE el.target_id = $1 ORDER BY e.kind, e.name`,
    [id],
  );
  return rows;
}

async function componentSlugs(db: Queryable, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<{ slug: string }>("SELECT slug FROM components WHERE id = ANY($1::uuid[]) ORDER BY slug", [ids]);
  return rows.map((r) => r.slug);
}

export async function getArticle(ctx: RequestContext, id: string, section?: string) {
  const { rows } = await ctx.db.query(
    `SELECT a.*, s.slug AS scope_slug, s.kind AS scope_kind, coalesce(u.email, u.subject) AS owner
       FROM articles a JOIN scopes s ON s.id = a.scope_id LEFT JOIN users u ON u.id = a.owner_id
      WHERE a.id = $1`,
    [id],
  );
  const a = rows[0];
  if (!a) throw new NotFoundError(`article ${id}`);

  const sections = splitSections(a.body_md);
  let body: string = a.body_md;
  if (section) {
    const match = sections.find((s) => s.heading.toLowerCase() === section.toLowerCase());
    if (!match) throw new NotFoundError(`section '${section}' (available: ${sections.map((s) => s.heading).filter(Boolean).join(", ")})`);
    body = `## ${match.heading}\n\n${match.text}`;
  }

  return {
    id: a.id,
    title: a.title,
    type: a.type,
    status: a.status,
    scope: { slug: a.scope_slug, kind: a.scope_kind },
    path: a.path,
    owner: a.owner,
    tags: a.tags,
    components: await componentSlugs(ctx.db, a.component_ids),
    version: a.version,
    review_due: a.review_due,
    last_verified_at: a.last_verified_at,
    updated_at: a.updated_at,
    sections: sections.map((s) => s.heading).filter(Boolean),
    body_md: body,
    related: await relatedItems(ctx.db, id),
    source_links: await sourceLinks(ctx.db, id),
    entities: await entitiesFor(ctx.db, id),
  };
}

export async function getFinding(ctx: RequestContext, id: string) {
  const { rows } = await ctx.db.query(
    `SELECT f.*, s.slug AS scope_slug, s.kind AS scope_kind, coalesce(u.email, u.subject) AS author
       FROM findings f JOIN scopes s ON s.id = f.scope_id LEFT JOIN users u ON u.id = f.author_id
      WHERE f.id = $1`,
    [id],
  );
  const f = rows[0];
  if (!f) throw new NotFoundError(`finding ${id}`);
  const history = await ctx.db.query(
    `SELECT r.op, r.state, r.reason, r.created_at, r.decided_at, coalesce(u.email, u.subject) AS author
       FROM revisions r JOIN users u ON u.id = r.author_id
      WHERE r.target_kind = 'finding' AND r.target_id = $1 ORDER BY r.created_at`,
    [id],
  );
  return {
    id: f.id,
    title: f.title,
    type: f.type,
    status: f.status,
    scope: { slug: f.scope_slug, kind: f.scope_kind },
    symptoms: f.symptoms,
    root_cause: f.root_cause,
    fix: f.fix,
    tags: f.tags,
    components: await componentSlugs(ctx.db, f.component_ids),
    author: f.author,
    version: f.version,
    last_verified_at: f.last_verified_at,
    created_at: f.created_at,
    updated_at: f.updated_at,
    related: await relatedItems(ctx.db, id),
    source_links: await sourceLinks(ctx.db, id),
    entities: await entitiesFor(ctx.db, id),
    history: history.rows,
  };
}

/** Articles in one scope as a folder tree (by `path`), optionally under a path prefix. */
export async function browseKb(ctx: RequestContext, scopeSlug: string, pathPrefix?: string) {
  const scope = await getScopeBySlug(ctx.db, scopeSlug);
  const prefix = (pathPrefix ?? "").replace(/^\/+|\/+$/g, "");
  const { rows } = await ctx.db.query<{ id: string; title: string; type: string; status: string; path: string }>(
    `SELECT id, title, type, status, path FROM articles
      WHERE scope_id = $1 AND status NOT IN ('rejected')
        AND ($2 = '' OR path = $2 OR path LIKE $2 || '/%')
      ORDER BY path, title`,
    [scope.id, prefix],
  );

  interface Folder {
    folders: Record<string, Folder>;
    articles: { id: string; title: string; type: string; status: string }[];
  }
  const root: Folder = { folders: {}, articles: [] };
  for (const r of rows) {
    const rel = prefix ? r.path.slice(prefix.length).replace(/^\//, "") : r.path;
    let node = root;
    for (const part of rel.split("/").filter(Boolean)) node = node.folders[part] ??= { folders: {}, articles: [] };
    node.articles.push({ id: r.id, title: r.title, type: r.type, status: r.status });
  }
  return { scope: { slug: scope.slug, kind: scope.kind, name: scope.name }, path: prefix, tree: root };
}

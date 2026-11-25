import type { Queryable } from "../db/pool.js";
import { splitSections } from "./chunking.js";
import { NotFoundError, type RequestContext } from "./context.js";
import { assertCanRead, canApprove, canModerate, readableScopes } from "./permissions.js";
import { getReadableScope } from "./scopes.js";
import { ticketsByLink } from "./connections/tickets.js";

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
export async function relatedItems(db: Queryable, id: string, readable: string[] | null = null): Promise<RelatedItem[]> {
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
      -- Links into scopes the caller can't read are left out.
      WHERE $2::uuid[] IS NULL OR coalesce(sa.id, sf.id, s.id, ps.id) = ANY($2)
      ORDER BY r.relation, label`,
    [id, readable],
  );
  return rows;
}

/** Evidence and design links; a Jira or Linear issue's carries its cached title and status (`ticket`). */
async function sourceLinks(db: Queryable, id: string) {
  const { rows } = await db.query<{ system: string; url: string; label: string }>(
    "SELECT system, url, label FROM source_links WHERE target_id = $1 ORDER BY system, url",
    [id],
  );
  const tickets = rows.some((r) => r.system === "jira" || r.system === "linear") ? await ticketsByLink(db, id) : null;
  return rows.map((r) => {
    const t = tickets?.get(r.url);
    return t ? { ...r, ticket: { key: t.key, title: t.title, status: t.status, category: t.category, checked_at: t.checked_at } } : r;
  });
}

async function entitiesFor(db: Queryable, id: string) {
  const { rows } = await db.query<{ kind: string; name: string }>(
    `SELECT e.kind, e.name FROM entity_links el JOIN entities e ON e.id = el.entity_id
      WHERE el.target_id = $1 ORDER BY e.kind, e.name`,
    [id],
  );
  return rows;
}

async function assetsFor(db: Queryable, id: string) {
  const { rows } = await db.query<{ id: string; filename: string; mime: string; size_bytes: number; alt_text: string }>(
    `SELECT id, filename, mime, size_bytes::int AS size_bytes, alt_text FROM assets
      WHERE target_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    [id],
  );
  return rows;
}

async function componentSlugs(db: Queryable, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const { rows } = await db.query<{ slug: string }>("SELECT slug FROM components WHERE id = ANY($1::uuid[]) ORDER BY slug", [ids]);
  return rows.map((r) => r.slug);
}

export async function getArticle(ctx: RequestContext, id: string, section?: string, opts: { skipReadCheck?: boolean } = {}) {
  const { rows } = await ctx.db.query(
    `SELECT a.*, s.slug AS scope_slug, s.kind AS scope_kind, coalesce(u.email, u.subject) AS owner, u.display_name AS owner_name
       FROM articles a JOIN scopes s ON s.id = a.scope_id LEFT JOIN users u ON u.id = a.owner_id
      WHERE a.id = $1`,
    [id],
  );
  const a = rows[0];
  if (!a) throw new NotFoundError(`article ${id}`);
  if (!opts.skipReadCheck) await assertCanRead(ctx, a.scope_id, `article ${id}`);
  // In the trash: only people who could restore it still see it.
  if (a.status === "deleted" && !(await canModerate(ctx, a.scope_id))) throw new NotFoundError(`article ${id}`);

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
    owner_name: a.owner_name ?? null,
    tags: a.tags,
    components: await componentSlugs(ctx.db, a.component_ids),
    version: a.version,
    review_due: a.review_due,
    valid_from: dateOnly(a.valid_from),
    valid_until: dateOnly(a.valid_until),
    last_verified_at: a.last_verified_at,
    updated_at: a.updated_at,
    sections: sections.map((s) => s.heading).filter(Boolean),
    body_md: body,
    related: await relatedItems(ctx.db, id, await readableScopes(ctx)),
    source_links: await sourceLinks(ctx.db, id),
    entities: await entitiesFor(ctx.db, id),
    assets: await assetsFor(ctx.db, id),
    ...(a.type === "table" ? { synced_table: await syncedTable(ctx, id) } : {}),
  };
}

/** The synced table a table article describes (a database connection's sync wrote it), for the Data view link. */
async function syncedTable(ctx: RequestContext, articleId: string) {
  const { rows } = await ctx.db.query<{ id: string; key: string; connection: string; project: string }>(
    `SELECT o.id, o.key, c.name AS connection, s.slug AS project FROM connection_objects o JOIN connections c ON c.id = o.connection_id JOIN scopes s ON s.id = c.scope_id
      WHERE o.article_id = $1 AND o.kind IN ('table', 'view') AND ($2::uuid[] IS NULL OR s.id = ANY($2::uuid[])) ORDER BY o.removed_at NULLS FIRST LIMIT 1`,
    [articleId, await readableScopes(ctx)],
  );
  return rows[0] ?? null;
}

export async function getFinding(ctx: RequestContext, id: string, opts: { skipReadCheck?: boolean } = {}) {
  const { rows } = await ctx.db.query(
    `SELECT f.*, s.slug AS scope_slug, s.kind AS scope_kind, coalesce(u.email, u.subject) AS author, u.display_name AS author_name
       FROM findings f JOIN scopes s ON s.id = f.scope_id LEFT JOIN users u ON u.id = f.author_id
      WHERE f.id = $1`,
    [id],
  );
  const f = rows[0];
  if (!f) throw new NotFoundError(`finding ${id}`);
  if (!opts.skipReadCheck) await assertCanRead(ctx, f.scope_id, `finding ${id}`);
  if (f.status === "deleted" && !(await canModerate(ctx, f.scope_id))) throw new NotFoundError(`finding ${id}`);
  const history = await ctx.db.query(
    `SELECT r.op, r.state, r.reason, r.created_at, r.decided_at, coalesce(u.email, u.subject) AS author, u.display_name AS author_name
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
    author_name: f.author_name ?? null,
    version: f.version,
    valid_from: dateOnly(f.valid_from),
    valid_until: dateOnly(f.valid_until),
    last_verified_at: f.last_verified_at,
    created_at: f.created_at,
    updated_at: f.updated_at,
    related: await relatedItems(ctx.db, id, await readableScopes(ctx)),
    source_links: await sourceLinks(ctx.db, id),
    entities: await entitiesFor(ctx.db, id),
    assets: await assetsFor(ctx.db, id),
    history: history.rows,
  };
}

/** Articles in one scope as a folder tree (by `path`), optionally under a path prefix. */
export async function browseKb(ctx: RequestContext, scopeSlug: string, pathPrefix?: string) {
  const scope = await getReadableScope(ctx, scopeSlug);
  const prefix = (pathPrefix ?? "").replace(/^\/+|\/+$/g, "");
  const { rows } = await ctx.db.query<{ id: string; title: string; type: string; status: string; path: string }>(
    `SELECT id, title, type, status, path FROM articles
      WHERE scope_id = $1 AND status NOT IN ('rejected', 'deleted')
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

/** A date column as YYYY-MM-DD (pg returns a Date at local midnight). */
function dateOnly(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

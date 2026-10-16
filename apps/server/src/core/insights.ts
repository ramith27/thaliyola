import type { RequestContext } from "./context.js";
import { readableScopes } from "./permissions.js";

/**
 * Numbers for the dashboard, limited to the scopes the viewer can read.
 * Time series are zero-filled so charts get one point per period.
 */
export async function insights(ctx: RequestContext) {
  const readable = await readableScopes(ctx);
  const db = ctx.db;

  const totals = (
    await db.query(
      `SELECT
         (SELECT count(*) FROM articles WHERE status IN ('published','possibly_stale') AND ($1::uuid[] IS NULL OR scope_id = ANY($1)))::int AS articles,
         (SELECT count(*) FROM findings WHERE status IN ('published','possibly_stale') AND ($1::uuid[] IS NULL OR scope_id = ANY($1)))::int AS findings,
         (SELECT count(*) FROM scopes WHERE kind = 'project' AND status = 'active' AND ($1::uuid[] IS NULL OR id = ANY($1)))::int AS projects,
         (SELECT count(*) FROM revisions WHERE state = 'pending' AND ($1::uuid[] IS NULL OR scope_id = ANY($1)))::int AS pending,
         (SELECT count(*) FROM (
            SELECT id FROM articles WHERE (status = 'possibly_stale' OR (status = 'published' AND review_due < current_date)) AND ($1::uuid[] IS NULL OR scope_id = ANY($1))
            UNION ALL SELECT id FROM findings WHERE status = 'possibly_stale' AND ($1::uuid[] IS NULL OR scope_id = ANY($1))) x)::int AS attention`,
      [readable],
    )
  ).rows[0];

  // New knowledge per week (last 12 weeks), by kind.
  const growth = await db.query(
    `WITH weeks AS (SELECT generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') AS week)
     SELECT to_char(w.week, 'YYYY-MM-DD') AS week,
            (SELECT count(*) FROM articles a WHERE date_trunc('week', a.created_at) = w.week AND a.status NOT IN ('rejected', 'deleted') AND ($1::uuid[] IS NULL OR a.scope_id = ANY($1)))::int AS articles,
            (SELECT count(*) FROM findings f WHERE date_trunc('week', f.created_at) = w.week AND f.status NOT IN ('rejected', 'deleted') AND ($1::uuid[] IS NULL OR f.scope_id = ANY($1)))::int AS findings
       FROM weeks w ORDER BY w.week`,
    [readable],
  );

  // Calls per day (last 30 days): agents over MCP vs people in the web UI.
  const activity = await db.query(
    `WITH days AS (SELECT generate_series(current_date - 29, current_date, interval '1 day')::date AS day)
     SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            count(l.id) FILTER (WHERE l.tool NOT LIKE 'api:%' AND l.tool NOT IN ('login', 'approve_revision', 'reject_revision', 'change_password'))::int AS agents,
            count(l.id) FILTER (WHERE l.tool LIKE 'api:%')::int AS web
       FROM days d LEFT JOIN audit_log l ON l.at::date = d.day
      GROUP BY d.day ORDER BY d.day`,
  );

  const statuses = await db.query(
    `SELECT status, count(*)::int AS n FROM (
       SELECT status, scope_id FROM articles UNION ALL SELECT status, scope_id FROM findings) x
      WHERE status IN ('published', 'possibly_stale', 'draft') AND ($1::uuid[] IS NULL OR scope_id = ANY($1))
      GROUP BY status`,
    [readable],
  );

  const types = await db.query(
    `SELECT type, count(*)::int AS n FROM (
       SELECT type, scope_id, status FROM articles UNION ALL SELECT type, scope_id, status FROM findings) x
      WHERE status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR scope_id = ANY($1))
      GROUP BY type ORDER BY n DESC, type`,
    [readable],
  );

  const contributors = await db.query(
    `SELECT coalesce(u.display_name, u.email, u.subject) AS name, count(*)::int AS approved
       FROM revisions r JOIN users u ON u.id = r.author_id
      WHERE r.state = 'approved' AND r.decided_at > now() - interval '90 days' AND ($1::uuid[] IS NULL OR r.scope_id = ANY($1))
      GROUP BY 1 ORDER BY approved DESC, name LIMIT 6`,
    [readable],
  );

  const review = (
    await db.query(
      `SELECT count(*) FILTER (WHERE state = 'approved')::int AS approved,
              count(*) FILTER (WHERE state = 'rejected')::int AS rejected,
              round(extract(epoch FROM percentile_cont(0.5) WITHIN GROUP (ORDER BY decided_at - created_at)) / 3600, 1)::float AS median_hours
         FROM revisions WHERE decided_at > now() - interval '30 days' AND ($1::uuid[] IS NULL OR scope_id = ANY($1))`,
      [readable],
    )
  ).rows[0];

  const recent = await db.query(
    `SELECT r.id, r.op, r.summary, r.decided_at, r.target_kind, r.target_id, s.slug AS scope, coalesce(u.display_name, u.email, u.subject) AS author
       FROM revisions r JOIN users u ON u.id = r.author_id JOIN scopes s ON s.id = r.scope_id
      WHERE r.state = 'approved' AND ($1::uuid[] IS NULL OR r.scope_id = ANY($1))
      ORDER BY r.decided_at DESC LIMIT 8`,
    [readable],
  );

  return {
    totals,
    growth: growth.rows,
    activity: activity.rows,
    statuses: Object.fromEntries(statuses.rows.map((r) => [r.status, r.n])),
    types: types.rows,
    contributors: contributors.rows,
    review,
    recent: recent.rows,
  };
}

/**
 * The knowledge graph: items, projects and components as nodes; typed links as edges.
 * Only what the viewer can read, and both ends of every edge must be visible.
 */
export async function knowledgeGraph(ctx: RequestContext, opts: { scope?: string; limit?: number; focus?: string; depth?: number } = {}) {
  const readable = await readableScopes(ctx);
  // Focus mode: only what is within `depth` links of one item (both directions), plus the projects of any components.
  let focusIds: string[] | null = null;
  if (opts.focus) {
    const { rows } = await ctx.db.query<{ id: string }>(
      `WITH RECURSIVE walk(id, d) AS (
         SELECT $1::uuid, 0
         UNION
         SELECT CASE WHEN r.from_id = w.id THEN r.to_id ELSE r.from_id END, w.d + 1
           FROM relations r JOIN walk w ON r.from_id = w.id OR r.to_id = w.id
          WHERE w.d < $2
       )
       SELECT id FROM walk
       UNION SELECT c.scope_id FROM components c WHERE c.id IN (SELECT id FROM walk)
       UNION SELECT c.id FROM components c WHERE c.scope_id = $1::uuid`,
      [opts.focus, Math.min(Math.max(opts.depth ?? 2, 1), 3)],
    );
    focusIds = rows.map((r) => r.id);
  }
  const limit = Math.min(opts.limit ?? 300, 600);
  const scopeId = opts.scope ? (await ctx.db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1", [opts.scope])).rows[0]?.id ?? null : null;

  const nodes = await ctx.db.query(
    `SELECT * FROM (
       SELECT a.id, 'article' AS kind, a.title AS label, a.type, a.status, s.slug AS scope, s.kind AS scope_kind, a.updated_at
         FROM articles a JOIN scopes s ON s.id = a.scope_id
        WHERE a.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR a.scope_id = ANY($1)) AND ($2::uuid IS NULL OR a.scope_id = $2)
       UNION ALL
       SELECT f.id, 'finding', f.title, f.type, f.status, s.slug, s.kind, f.updated_at
         FROM findings f JOIN scopes s ON s.id = f.scope_id
        WHERE f.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR f.scope_id = ANY($1)) AND ($2::uuid IS NULL OR f.scope_id = $2)
       UNION ALL
       SELECT s.id, 'project', s.name, 'project', 'published', s.slug, s.kind, s.created_at
         FROM scopes s WHERE s.kind = 'project' AND s.status = 'active' AND ($1::uuid[] IS NULL OR s.id = ANY($1)) AND ($2::uuid IS NULL OR s.id = $2)
       UNION ALL
       SELECT c.id, 'component', s.name || ' · ' || c.slug, c.kind, 'published', s.slug, s.kind, c.created_at
         FROM components c JOIN scopes s ON s.id = c.scope_id
        WHERE ($1::uuid[] IS NULL OR c.scope_id = ANY($1)) AND ($2::uuid IS NULL OR c.scope_id = $2)
     ) n WHERE ($4::uuid[] IS NULL OR n.id = ANY($4)) ORDER BY updated_at DESC LIMIT $3`,
    [readable, scopeId, limit, focusIds],
  );
  const ids = nodes.rows.map((n) => n.id);
  const edges = await ctx.db.query(
    `SELECT from_id AS source, to_id AS target, kind FROM relations WHERE from_id = ANY($1::uuid[]) AND to_id = ANY($1::uuid[])
     UNION ALL
     -- Components belong to their project.
     SELECT c.scope_id, c.id, 'part_of' FROM components c WHERE c.id = ANY($1::uuid[]) AND c.scope_id = ANY($1::uuid[])
     UNION ALL
     -- Project items hang off the repository they're about, or off the project itself.
     SELECT x.id, coalesce(c.id, x.scope_id), 'belongs_to'
       FROM (SELECT id, scope_id, component_ids FROM articles UNION ALL SELECT id, scope_id, component_ids FROM findings) x
       LEFT JOIN components c ON c.id = ANY(x.component_ids) AND c.id = ANY($1::uuid[])
      WHERE x.id = ANY($1::uuid[]) AND (c.id IS NOT NULL OR x.scope_id = ANY($1::uuid[]))`,
    [ids],
  );
  return { nodes: nodes.rows, edges: edges.rows, truncated: nodes.rows.length === limit, focus: opts.focus ?? null };
}

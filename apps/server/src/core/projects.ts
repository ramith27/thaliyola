import type { RequestContext } from "./context.js";
import { ValidationError } from "./context.js";
import { readableScopes } from "./permissions.js";
import { getComponent, listComponents, resolveProject } from "./scopes.js";

const OVERVIEW_MAX_CHARS = 6000;
const VISIBLE = ["published", "possibly_stale"];

/**
 * Cold-start context for an agent working in a project: the overview, recent
 * design and decision records, what the project `uses` from other scopes,
 * open known issues, and unacknowledged upstream changes.
 * With a component, also the contracts it provides and consumes.
 */
export async function getProjectContext(ctx: RequestContext, projectSlug?: string, componentSlug?: string) {
  const project = await resolveProject(ctx, projectSlug);
  if (!project) throw new ValidationError("no project given: pass `project` or set the X-Cairn-Project header");
  const db = ctx.db;
  const component = componentSlug ?? (projectSlug === undefined || projectSlug === ctx.project ? ctx.component : undefined);
  const comp = component ? await getComponent(db, project.id, component) : undefined;

  const overview = (
    await db.query(
      `SELECT id, title, status, version, updated_at, body_md FROM articles
        WHERE scope_id = $1 AND type = 'project_overview' AND status = ANY($2)
        ORDER BY (status = 'published') DESC, updated_at DESC LIMIT 1`,
      [project.id, VISIBLE],
    )
  ).rows[0];

  const records = await db.query(
    `SELECT id, title, type, status, updated_at FROM articles
      WHERE scope_id = $1 AND status = ANY($2)
        AND type IN ('decision', 'design_doc', 'tech_spec', 'api_contract', 'screen_spec')
      ORDER BY updated_at DESC LIMIT 15`,
    [project.id, VISIBLE],
  );

  const uses = await db.query(
    `SELECT DISTINCT ON (r.to_id) r.to_kind AS kind, r.to_id AS id,
            coalesce(a.title, f.title) AS title, coalesce(a.type, f.type) AS type,
            coalesce(a.status, f.status) AS status, s.slug AS scope, s.kind AS scope_kind
       FROM relations r
       LEFT JOIN articles a ON r.to_kind = 'article' AND a.id = r.to_id
       LEFT JOIN findings f ON r.to_kind = 'finding' AND f.id = r.to_id
       JOIN scopes s ON s.id = coalesce(a.scope_id, f.scope_id)
      WHERE r.kind = 'uses'
        AND s.id <> $1
        AND ($2::uuid[] IS NULL OR s.id = ANY($2))
        AND (r.from_id = $1
             OR r.from_id IN (SELECT id FROM articles WHERE scope_id = $1)
             OR r.from_id IN (SELECT id FROM findings WHERE scope_id = $1))`,
    [project.id, await readableScopes(ctx)],
  );

  const knownIssues = await db.query(
    `SELECT id, title, status, last_verified_at, updated_at FROM findings
      WHERE scope_id = $1 AND type = 'known_issue' AND status = ANY($2)
        AND ($3::uuid IS NULL OR component_ids = '{}' OR $3 = ANY(component_ids))
      ORDER BY updated_at DESC LIMIT 15`,
    [project.id, VISIBLE, comp?.id ?? null],
  );

  const notices = await db.query(
    `SELECT n.id, n.summary, n.source_version, n.created_at, n.source_id,
            coalesce(a.title, f.title) AS source_title, c.slug AS component
       FROM impact_notices n
       LEFT JOIN articles a ON n.source_kind = 'article' AND a.id = n.source_id
       LEFT JOIN findings f ON n.source_kind = 'finding' AND f.id = n.source_id
       LEFT JOIN components c ON c.id = n.component_id
      WHERE n.state = 'open'
        AND (n.scope_id = $1 OR n.component_id IN (SELECT id FROM components WHERE scope_id = $1))
        AND ($2::uuid IS NULL OR n.component_id IS NULL OR n.component_id = $2)
      ORDER BY n.created_at`,
    [project.id, comp?.id ?? null],
  );

  let contracts: unknown;
  if (comp) {
    const { rows } = await db.query(
      `SELECT r.kind AS role, a.id, a.title, a.status, a.version, a.updated_at
         FROM relations r JOIN articles a ON a.id = r.from_id
        WHERE r.to_id = $1 AND r.kind IN ('provided_by', 'consumed_by') AND a.status = ANY($2)
        ORDER BY r.kind, a.title`,
      [comp.id, VISIBLE],
    );
    contracts = {
      provides: rows.filter((r) => r.role === "provided_by").map(({ role, ...rest }) => rest),
      consumes: rows.filter((r) => r.role === "consumed_by").map(({ role, ...rest }) => rest),
    };
  }

  return {
    project: { slug: project.slug, name: project.name, description: project.description, status: project.status },
    component: comp ? { slug: comp.slug, kind: comp.kind, repo_url: comp.repo_url } : null,
    components: (await listComponents(db, project.id)).map((c) => ({ slug: c.slug, kind: c.kind, repo_url: c.repo_url })),
    open_impact_notices: notices.rows,
    overview: overview
      ? {
          id: overview.id,
          title: overview.title,
          status: overview.status,
          updated_at: overview.updated_at,
          body_md:
            overview.body_md.length > OVERVIEW_MAX_CHARS
              ? overview.body_md.slice(0, OVERVIEW_MAX_CHARS) + "\n\n…(truncated; use get_article for the rest)"
              : overview.body_md,
        }
      : null,
    ...(contracts ? { contracts } : {}),
    recent_records: records.rows,
    uses: uses.rows,
    open_known_issues: knownIssues.rows,
  };
}

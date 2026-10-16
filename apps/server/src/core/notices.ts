import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { assertCanRead } from "./permissions.js";
import { getComponent, resolveProject } from "./scopes.js";

/** Open upstream changes for a project, or for one of its components (plus project-wide ones). */
export async function listImpactNotices(ctx: RequestContext, opts: { project?: string; component?: string; include_acked?: boolean }) {
  const project = await resolveProject(ctx, opts.project);
  if (!project) throw new ValidationError("no project given: pass `project` or set the X-Cairn-Project header");
  const componentSlug = opts.component ?? (opts.project === undefined || opts.project === ctx.project ? ctx.component : undefined);
  const component = componentSlug ? await getComponent(ctx.db, project.id, componentSlug) : undefined;
  const { rows } = await ctx.db.query(
    `SELECT n.id, n.state, n.summary, n.source_kind, n.source_id, n.source_version, n.created_at, n.acked_at,
            coalesce(a.title, f.title) AS source_title, s.slug AS source_scope, c.slug AS component,
            coalesce(u.email, u.subject) AS acked_by
       FROM impact_notices n
       LEFT JOIN articles a ON n.source_kind = 'article' AND a.id = n.source_id
       LEFT JOIN findings f ON n.source_kind = 'finding' AND f.id = n.source_id
       LEFT JOIN scopes s ON s.id = coalesce(a.scope_id, f.scope_id)
       LEFT JOIN components c ON c.id = n.component_id
       LEFT JOIN users u ON u.id = n.acked_by
      WHERE (n.scope_id = $1 OR n.component_id IN (SELECT id FROM components WHERE scope_id = $1))
        AND ($2::uuid IS NULL OR n.component_id IS NULL OR n.component_id = $2)
        AND ($3 OR n.state = 'open')
      ORDER BY n.created_at`,
    [project.id, component?.id ?? null, !!opts.include_acked],
  );
  return { project: project.slug, component: component?.slug ?? null, notices: rows };
}

export async function ackNotice(ctx: RequestContext, id: string) {
  const owner = await ctx.db.query<{ scope_id: string }>(
    "SELECT coalesce(n.scope_id, c.scope_id) AS scope_id FROM impact_notices n LEFT JOIN components c ON c.id = n.component_id WHERE n.id = $1",
    [id],
  );
  if (!owner.rows[0]) throw new NotFoundError(`impact notice ${id}`);
  await assertCanRead(ctx, owner.rows[0].scope_id, `impact notice ${id}`);
  const { rows } = await ctx.db.query(
    `UPDATE impact_notices SET state = 'acked', acked_by = $2, acked_at = now()
      WHERE id = $1 RETURNING id, state, acked_at`,
    [id, ctx.actor.id],
  );
  if (!rows[0]) throw new NotFoundError(`impact notice ${id}`);
  return rows[0];
}

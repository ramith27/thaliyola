import type { Queryable } from "../db/pool.js";
import { ValidationError } from "./context.js";

/**
 * Every project keeps at least one Project admin: an enabled person (not a service account, not a disabled account)
 * who holds Manage access there, directly, through a team or from a project above. Changes are checked by comparing
 * before with after, so a change is refused (or reported) only when it removes the last one itself.
 */

const MAX_DEPTH = 6;

export interface ProjectsWithoutAdmin {
  projects_without_admin: { slug: string; name: string }[];
  other_projects_without_admin: number;
}

/** "A, B and C". */
export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The given projects and every project below them (kind 'project', not deleted), and which of them have an active
 * Project admin: an enabled person (users.kind 'human', disabled_at null) holding manage_members there.
 * People added ahead of their first sign-in count.
 */
export async function projectsWithAdmin(
  db: Queryable,
  scopeIds: string[],
): Promise<{ all: { id: string; slug: string; name: string }[]; withAdmin: Set<string> }> {
  const ids = [...new Set(scopeIds)];
  if (!ids.length) return { all: [], withAdmin: new Set() };
  const { rows } = await db.query<{ id: string; slug: string; name: string; has_admin: boolean }>(
    `WITH RECURSIVE down (id, depth) AS (
       SELECT id, 0 FROM scopes WHERE id = ANY($1::uuid[])
       UNION ALL SELECT s.id, d.depth + 1 FROM down d JOIN scopes s ON s.parent_id = d.id WHERE d.depth < $2)
     SELECT s.id, s.slug, s.name,
            EXISTS (SELECT 1 FROM scope_permissions p JOIN users u ON u.id = p.user_id
                     WHERE p.scope_id = s.id AND p.permission = 'manage_members' AND u.kind = 'human' AND u.disabled_at IS NULL) AS has_admin
       FROM scopes s
      WHERE s.id IN (SELECT id FROM down) AND s.kind = 'project' AND s.status <> 'deleted'
      ORDER BY s.name`,
    [ids, MAX_DEPTH],
  );
  return { all: rows.map(({ id, slug, name }) => ({ id, slug, name })), withAdmin: new Set(rows.filter((r) => r.has_admin).map((r) => r.id)) };
}

/**
 * Runs `change` inside `tx`. A project (among scopeIds and those below) that had an active Project admin before and has
 * none after is "lost". With opts.refuse, any lost project throws ValidationError (the transaction rolls back);
 * otherwise they are reported. Names of projects not in opts.readable (null = all readable) are never shown, only counted.
 */
export async function keepingProjectAdmins<T>(
  tx: Queryable,
  scopeIds: string[],
  change: () => Promise<T>,
  opts: { refuse: boolean; readable: string[] | null },
): Promise<{ result: T } & ProjectsWithoutAdmin> {
  const before = await projectsWithAdmin(tx, scopeIds);
  const result = await change();
  if (!before.withAdmin.size) return { result, projects_without_admin: [], other_projects_without_admin: 0 };
  const after = await projectsWithAdmin(tx, scopeIds);
  const stillThere = new Set(after.all.map((p) => p.id));
  const lost = before.all.filter((p) => before.withAdmin.has(p.id) && stillThere.has(p.id) && !after.withAdmin.has(p.id));
  const shown = lost.filter((p) => opts.readable === null || opts.readable.includes(p.id));
  const hidden = lost.length - shown.length;
  if (opts.refuse && lost.length) {
    const list = joinAnd([...shown.map((p) => p.name), ...(hidden ? [`${hidden} project${hidden === 1 ? "" : "s"} you can't see`] : [])]);
    throw new ValidationError(
      `every project needs at least one Project admin, and this would leave ${list} without a Project admin; make someone else Project admin there first`,
    );
  }
  return { result, projects_without_admin: shown.map(({ slug, name }) => ({ slug, name })), other_projects_without_admin: hidden };
}

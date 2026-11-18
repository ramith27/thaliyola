import type { Settings } from "../../config.js";
import type { Queryable } from "../../db/pool.js";
import { notify } from "../notify.js";
import { idsWithPermission, projectMembersWith } from "../roles.js";

/**
 * Who hears about skills (notification kind "skill", never posted to Slack or Trello routes): reviewers about new
 * versions and audience changes, authors about decisions, managers about problem reports and failed imports. An owned
 * skill's notices go only to people who can read its project.
 */

/** People holding `permission` (an org permission) who can read the owner project, plus its Project admins. */
export async function peopleWith(db: Queryable, settings: Settings, permission: "manage_skills" | "review_skills", ownerScopeId: string | null): Promise<string[]> {
  const holders = await idsWithPermission(db, settings, permission);
  if (!ownerScopeId) return holders;
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.id = ANY ($1::uuid[]) AND (
        EXISTS (SELECT 1 FROM scopes s WHERE s.id = $2 AND s.visibility = 'team')
     OR EXISTS (SELECT 1 FROM scope_roles r WHERE r.scope_id = $2 AND r.user_id = u.id)
     OR u.is_admin OR lower(u.email) = ANY ($3::text[])
     OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.key = ur.role WHERE ur.user_id = u.id AND ro.permissions && ARRAY['read_all_projects', 'manage_all_projects']))`,
    [holders, ownerScopeId, settings.adminEmails],
  );
  const admins = await projectMembersWith(db, ownerScopeId, "manage_settings");
  return [...new Set([...rows.map((r) => r.id), ...admins])];
}

export async function tellSkill(db: Queryable, settings: Settings, to: string[], n: { title: string; body?: string; link: string; targetId?: string | null }, exclude?: string | null) {
  await notify(db, settings, to, { kind: "skill", route: false, ...n }, { exclude: exclude ?? undefined });
}

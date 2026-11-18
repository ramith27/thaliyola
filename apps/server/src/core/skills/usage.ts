import type { Queryable } from "../../db/pool.js";
import { ForbiddenError, type RequestContext } from "../context.js";
import { assertSkillRight, isAuditor, ownerRights, visibleOwnerSql } from "./access.js";
import { can } from "../permissions.js";

/**
 * Who loaded which skill, which version, how and when (get_skill, files, prompts, downloads, the Claude Code sync).
 * Usage names people, so it follows the audit log's bar: people who manage the skill, and Auditors.
 */

const days = (n?: number) => Math.max(1, Math.min(365, Math.floor(n ?? 30)));

export async function skillUsage(ctx: RequestContext, id: string, d?: number) {
  const { skill } = await assertSkillRight(ctx, id, "usage");
  const n = days(d);
  const people = (
    await ctx.db.query(
      `SELECT u.id, coalesce(nullif(u.display_name, ''), u.email) AS name, u.email, count(*)::int AS uses,
              jsonb_build_object('mcp', count(*) FILTER (WHERE su.channel = 'mcp'), 'file', count(*) FILTER (WHERE su.channel = 'file'),
                                 'prompt', count(*) FILTER (WHERE su.channel = 'prompt'), 'download', count(*) FILTER (WHERE su.channel = 'download'),
                                 'sync', count(*) FILTER (WHERE su.channel = 'sync')) AS by_channel,
              min(su.at) AS first_at, max(su.at) AS last_at, (array_agg(su.version ORDER BY su.at DESC))[1] AS last_version
         FROM skill_usage su JOIN users u ON u.id = su.user_id
        WHERE su.skill_id = $1 AND su.at > now() - make_interval(days => $2)
        GROUP BY u.id ORDER BY max(su.at) DESC LIMIT 500`,
      [skill.id, n],
    )
  ).rows;
  const byChannel = (await ctx.db.query<{ channel: string; n: number }>("SELECT channel, count(*)::int AS n FROM skill_usage WHERE skill_id = $1 AND at > now() - make_interval(days => $2) GROUP BY channel", [skill.id, n])).rows;
  const daily = (
    await ctx.db.query<{ day: string; n: number }>(
      "SELECT to_char(date_trunc('day', at), 'YYYY-MM-DD') AS day, count(*)::int AS n FROM skill_usage WHERE skill_id = $1 AND at > now() - make_interval(days => $2) GROUP BY 1 ORDER BY 1",
      [skill.id, n],
    )
  ).rows;
  const current = skill.current_version_id ? (await ctx.db.query<{ version: number }>("SELECT version FROM skill_versions WHERE id = $1", [skill.current_version_id])).rows[0]?.version ?? null : null;
  return {
    skill: { id: skill.id, name: skill.name, version: current },
    days: n,
    total: byChannel.reduce((a, b) => a + b.n, 0),
    by_channel: Object.fromEntries(byChannel.map((c) => [c.channel, c.n])),
    daily,
    people: people.map((p) => ({ ...p, behind: current !== null && typeof p.last_version === "number" && p.last_version < current })),
  };
}

/** Overview: uses per skill, skills nobody loaded lately, and each person's last sync check. */
export async function usageOverview(ctx: RequestContext, d?: number) {
  if (ctx.actor.kind !== "human" || !(can(ctx, "manage_skills") || isAuditor(ctx) || (await ownerRights(ctx, null)).usage)) {
    // Project admins see their projects' own skills through each skill's usage tab.
    throw new ForbiddenError("skill usage names people: it needs Manage skills, or Read every project and See usage (Auditors)");
  }
  const n = days(d);
  const params: unknown[] = [n];
  const where = await visibleOwnerSql(ctx, "sk", params);
  const skills = (
    await ctx.db.query(
      `SELECT sk.id, sk.name, sk.status, v.version,
              (SELECT count(*)::int FROM skill_usage u WHERE u.skill_id = sk.id AND u.at > now() - make_interval(days => $1)) AS uses,
              (SELECT count(DISTINCT u.user_id)::int FROM skill_usage u WHERE u.skill_id = sk.id AND u.at > now() - make_interval(days => $1)) AS people,
              (SELECT max(u.at) FROM skill_usage u WHERE u.skill_id = sk.id) AS last_used_at,
              (SELECT count(DISTINCT u.user_id)::int FROM skill_usage u WHERE u.skill_id = sk.id AND u.channel IN ('download', 'sync')
                  AND u.version < v.version AND NOT EXISTS (SELECT 1 FROM skill_usage u2 WHERE u2.skill_id = sk.id AND u2.user_id = u.user_id AND u2.channel = u.channel AND u2.version >= v.version)) AS behind
         FROM skills sk LEFT JOIN skill_versions v ON v.id = sk.current_version_id
        WHERE ${where} ORDER BY sk.name`,
      params,
    )
  ).rows as { id: string; name: string; uses: number; last_used_at: string | null }[];
  const syncs = (
    await ctx.db.query(
      `SELECT u.id, coalesce(nullif(u.display_name, ''), u.email) AS name, s.at, s.script FROM skill_sync_seen s JOIN users u ON u.id = s.user_id ORDER BY s.at DESC LIMIT 500`,
    )
  ).rows;
  return { days: n, skills, unused: skills.filter((s) => !s.last_used_at || Date.now() - new Date(s.last_used_at).getTime() > 30 * 86_400_000).map((s) => s.name), sync_checks: syncs };
}

export async function purgeOldUsage(db: Queryable, keepDays: number) {
  const r = await db.query("DELETE FROM skill_usage WHERE at < now() - make_interval(days => $1)", [keepDays]);
  return r.rowCount ?? 0;
}

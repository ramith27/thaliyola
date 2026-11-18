import { withTx } from "../../db/pool.js";
import { audit } from "../audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { canReadScope } from "../permissions.js";
import { ownerRights, skillByName } from "./access.js";
import { slugify } from "./layout.js";
import { peopleWith, tellSkill } from "./notify.js";
import { insertVersion, prepareSkill, type PreparedSkill } from "./prepare.js";
import { NAME_RE, type SkillFile } from "./types.js";

/**
 * Converting a project's skill articles into skills owned by that project: runbooks tagged `claude-skill` (folder
 * "Skills" preferred) become pending skills, with linked articles of the same project as references/. This retires the
 * "loader" pattern that keeps private skills as members-only articles. Articles are not changed.
 */

const enc = new TextEncoder();

/** The first paragraph of the `## Trigger` section, tags stripped, at most 1024 characters. */
export function triggerOf(body: string): string | null {
  const m = /^##\s+Trigger\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(body);
  if (!m) return null;
  const para = m[1]!.trim().split(/\n\s*\n/)[0]?.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  return para ? para.slice(0, 1024) : null;
}

export async function convertArticlesToSkills(ctx: RequestContext, projectSlug: string, opts: { dry_run?: boolean } = {}) {
  const scope = (await ctx.db.query<{ id: string; kind: string; slug: string; name: string }>("SELECT id, kind, slug, name FROM scopes WHERE slug = $1", [projectSlug])).rows[0];
  if (!scope || !(await canReadScope(ctx, scope.id))) throw new NotFoundError(`project '${projectSlug}'`);
  if (scope.kind !== "project") throw new ValidationError(`'${projectSlug}' isn't a project`);
  const rights = await ownerRights(ctx, scope.id);
  if (!rights.manage) throw new ForbiddenError("converting a project's articles to skills needs Manage settings there, or Manage skills");
  const articles = (
    await ctx.db.query<{ id: string; title: string; path: string; body_md: string }>(
      "SELECT id, title, path, body_md FROM articles WHERE scope_id = $1 AND type = 'runbook' AND 'claude-skill' = ANY (tags) AND status IN ('published', 'possibly_stale') ORDER BY title",
      [scope.id],
    )
  ).rows;
  const report = { project: scope.slug, dry_run: !!opts.dry_run, added: [] as { name: string; version: number; article_id: string }[], changed: [] as { name: string; version: number }[], unchanged: [] as { name: string }[], rejected: [] as { article_id: string; title: string; reasons: string[] }[], warnings: [] as { article_id: string; message: string }[] };
  const ready: { name: string; prepared: PreparedSkill; articleId: string; existing: Awaited<ReturnType<typeof skillByName>> }[] = [];
  for (const a of articles) {
    if (!/^Skills(\/|$)/i.test(a.path)) report.warnings.push({ article_id: a.id, message: `${a.title} isn't in the Skills folder (${a.path || "the top level"})` });
    const name = a.title.trim();
    const reasons: string[] = [];
    if (!NAME_RE.test(name) || name.length > 64) reasons.push(`the title '${name.slice(0, 80)}' isn't a skill name (lowercase letters/digits with single hyphens)`);
    const description = triggerOf(a.body_md);
    if (!description) reasons.push("no '## Trigger' section to take the description from");
    if (reasons.length) {
      report.rejected.push({ article_id: a.id, title: a.title, reasons });
      continue;
    }
    const linked = (
      await ctx.db.query<{ id: string; title: string; body_md: string; scope_id: string }>(
        `SELECT ar.id, ar.title, ar.body_md, ar.scope_id FROM relations r JOIN articles ar ON ar.id = r.to_id
          WHERE r.from_kind = 'article' AND r.from_id = $1 AND r.to_kind = 'article' AND ar.status IN ('published', 'possibly_stale') ORDER BY ar.title`,
        [a.id],
      )
    ).rows;
    const files: SkillFile[] = [{ path: "SKILL.md", data: enc.encode(`---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${a.body_md.trim()}\n`) }];
    const used = new Set<string>();
    for (const l of linked) {
      if (l.scope_id !== scope.id) {
        report.warnings.push({ article_id: a.id, message: `${a.title} links to an article in another project; left as text` });
        continue;
      }
      let slug = slugify(l.title);
      while (used.has(slug)) slug = `${slug}-x`;
      used.add(slug);
      files.push({ path: `references/${slug}.md`, data: enc.encode(`# ${l.title}\n\n${l.body_md.trim()}\n`) });
    }
    const existing = await skillByName(ctx.db, name);
    if (existing && (existing.owner_scope_id !== scope.id || existing.source_id)) {
      report.rejected.push({ article_id: a.id, title: a.title, reasons: [existing.owner_scope_id === scope.id ? `${name} comes from a source` : "that name isn't available"] });
      continue;
    }
    const prepared = prepareSkill(name, files);
    if (prepared.errors.length) {
      report.rejected.push({ article_id: a.id, title: a.title, reasons: prepared.errors.slice(0, 20) });
      continue;
    }
    ready.push({ name, prepared, articleId: a.id, existing });
  }
  if (opts.dry_run) {
    for (const r of ready) (r.existing ? report.changed : report.added).push({ name: r.name, version: 1, article_id: r.articleId } as never);
    return report;
  }
  const collectionSlug = `${scope.slug}-skills`.slice(0, 64).replace(/-+$/, "");
  const created: { id: string; name: string; version: number }[] = [];
  await withTx(ctx.db, async (tx) => {
    const importId = (
      await tx.query<{ id: string }>("INSERT INTO skill_imports (kind, layout, owner_scope_id, started_by, status, finished_at) VALUES ('articles', 'articles', $1, $2, 'done', now()) RETURNING id", [scope.id, ctx.actor.id])
    ).rows[0]!.id;
    let col = (await tx.query<{ id: string; owner_scope_id: string | null }>("SELECT id, owner_scope_id FROM skill_collections WHERE slug = $1", [collectionSlug])).rows[0];
    if (col && col.owner_scope_id !== scope.id) throw new ValidationError(`the collection ${collectionSlug} belongs to something else`);
    if (!col) {
      col = (await tx.query<{ id: string; owner_scope_id: string | null }>("INSERT INTO skill_collections (slug, name, description, owner_scope_id, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, owner_scope_id", [
        collectionSlug,
        `${scope.name} skills`,
        `Skills of ${scope.name}, converted from its articles.`,
        scope.id,
        ctx.actor.id,
      ])).rows[0]!;
      await tx.query("INSERT INTO skill_assignments (collection_id, audience, scope_id, created_by) VALUES ($1, 'project', $2, $3) ON CONFLICT DO NOTHING", [col.id, scope.id, ctx.actor.id]);
    }
    for (const r of ready) {
      let skillId = r.existing?.id;
      if (r.existing) {
        const cur = (await tx.query<{ content_hash: string }>("SELECT content_hash FROM skill_versions WHERE skill_id = $1 AND (id = $2 OR state = 'pending')", [r.existing.id, r.existing.current_version_id])).rows;
        if (cur.some((c) => c.content_hash === r.prepared.contentHash)) {
          report.unchanged.push({ name: r.name });
          continue;
        }
      } else {
        skillId = (await tx.query<{ id: string }>("INSERT INTO skills (name, collection_id, owner_scope_id, created_by) VALUES ($1, $2, $3, $4) RETURNING id", [r.name, col.id, scope.id, ctx.actor.id])).rows[0]!.id;
      }
      const v = await insertVersion(tx, { skillId: skillId!, state: "pending", baseVersionId: r.existing?.current_version_id ?? null, prepared: r.prepared, summary: `Converted from the article ${r.name}`, authorId: ctx.actor.id, importId }, "an article conversion");
      created.push({ id: skillId!, name: r.name, version: v.version });
      (r.existing ? report.changed : report.added).push({ name: r.name, version: v.version, article_id: r.articleId } as never);
    }
    await tx.query("UPDATE skill_imports SET report = $2 WHERE id = $1", [importId, JSON.stringify(report)]);
    await audit(tx, ctx.actor.id, "convert_articles_to_skills", scope.id, { targetKind: "project", targetLabel: scope.name, details: { project: scope.slug, articles: articles.length, skills: created.length, rejected: report.rejected.length } });
  });
  if (created.length) {
    const reviewers = await peopleWith(ctx.db, ctx.settings, "review_skills", scope.id);
    await tellSkill(ctx.db, ctx.settings, reviewers, { title: `${created.length} skill${created.length === 1 ? "" : "s"} converted from ${scope.name}'s articles wait for review`, link: "#/review/skills" }, ctx.actor.id);
  }
  return report;
}

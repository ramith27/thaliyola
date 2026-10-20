import { splitSections } from "./chunking.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { isAdmin, readableScopes } from "./permissions.js";
import { getReadableScope } from "./scopes.js";
import { listSuggestions } from "./suggestions.js";
import { ARTICLE_TEMPLATES } from "./templates.js";

/**
 * Curation work for connected agents. Thaliyola has no model of its own: it finds
 * what needs judgment (an item filed in the wrong place, a page without its
 * repository, look-alike findings, empty outlines, stale entries, searches
 * that found nothing) and hands it to the client's model with instructions
 * and the tools to act. Everything the agent changes is a reviewed proposal
 * (or a link). Tasks are computed on the fly; agent_tasks records who is on
 * one and how it ended, so agents don't repeat each other.
 */

export const TASK_KINDS = [
  "file_into_project",
  "tag_repository",
  "merge_duplicates",
  "promote_recurring",
  "fill_outline",
  "verify_stale",
  "write_overview",
  "link_related",
  "answer_gap",
  "stale_claims",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export interface Task {
  id: string;
  kind: TaskKind;
  title: string;
  project: string | null;
  targets: { kind: string; id: string; title: string; scope: string }[];
  context: Record<string, unknown>;
  instructions: string;
}

const DO_NOT = "Don't change anything you aren't sure about: complete_task with outcome 'skipped' and a short note instead.";

const INSTRUCTIONS: Record<TaskKind, string> = {
  stale_claims:
    "Facts on this documentation page point at code that has changed. With the repository checked out, look at each stale claim (docs_inspect_claims) against the current code: " +
    "resolve_claims to confirm those that still hold (with updated evidence) and retire those that don't, then fix the page text with propose_article_edit; or, for many changes, run the update-docs prompt. " +
    DO_NOT,
  file_into_project:
    "This entry sits in the shared team space but looks like it belongs to a project. Read it (get_article / get_finding) and the candidate projects (get_project_context). " +
    "If it's about one project, call move_entry with that project, the right repository (repo) when it's about one codebase, and for articles a folder that fits the project's tree. " +
    "If it's genuinely org-wide, complete_task with outcome 'not_applicable'. " +
    DO_NOT,
  tag_repository:
    "This project entry isn't tied to any of the project's repositories. Read it and the repository list in context. If it's about one repository, call move_entry with the same project and repo " +
    "(keep the folder). If it spans the whole project, complete_task 'not_applicable'. " +
    DO_NOT,
  merge_duplicates:
    "These two findings look alike. Read both. Same problem → link_entries(relation 'same_root_cause'), and if one is clearly worse, update_finding the better one with anything missing and " +
    "verify_entry(still_valid false, note 'duplicate of <id>') on the other. Different problems → complete_task 'not_applicable'. " +
    DO_NOT,
  promote_recurring:
    "This finding keeps recurring. Fold its symptoms, cause and fix into the article people read first: promote_finding into the suggested article (or propose_article_edit on a better one, " +
    "or create_article type runbook if none fits). " +
    DO_NOT,
  fill_outline:
    "This article has sections that are still empty or placeholder text ('_To write: …_'). Fill them only with facts you can check: read the repository's code, config and docs, and other Thaliyola entries. " +
    "Send one propose_article_edit per section (section + text). Leave sections you can't verify as they are and say so in the task note. " +
    DO_NOT,
  verify_stale:
    "Nobody has confirmed this entry recently. Check it against the system with the smallest check that settles it (code, config, dashboards, data). " +
    "Still true → verify_entry(still_valid true). Partly wrong → propose a correction (update_finding / propose_article_edit). No longer true → verify_entry(still_valid false, note why). " +
    DO_NOT,
  write_overview:
    "This project has no overview. From its repositories (README, code, config) and its Thaliyola entries, write one: get_article_template('project_overview'), then create_article in the project. " +
    "Facts only; mark anything uncertain. " +
    DO_NOT,
  link_related:
    "This entry has no links to anything. search_knowledge for what it's about and link_entries the clearly related items (related, depends_on, same_root_cause, uses). Two or three good links beat many weak ones. " +
    "Nothing related → complete_task 'not_applicable'. " +
    DO_NOT,
  answer_gap:
    "People searched for this and found nothing. If you can answer it from code, config or docs you can read, write the article (create_article with the right type and project) so the next search finds it. " +
    "If it's noise or you can't verify an answer, complete_task 'skipped' with a note. " +
    DO_NOT,
};

const PRIORITY: Record<TaskKind, number> = {
  stale_claims: 4,
  file_into_project: 1,
  tag_repository: 2,
  merge_duplicates: 3,
  verify_stale: 4,
  promote_recurring: 5,
  fill_outline: 6,
  write_overview: 7,
  answer_gap: 8,
  link_related: 9,
};

const PLACEHOLDER = /_To write: |^\s*$/;

/** Candidate tasks of every kind (or one kind), limited to what the caller can read. */
async function candidates(ctx: RequestContext, opts: { kind?: TaskKind; kinds?: TaskKind[]; project?: string }): Promise<Task[]> {
  const readable = await readableScopes(ctx);
  const projectId = opts.project ? (await getReadableScope(ctx, opts.project)).id : null;
  const want = (k: TaskKind) => (!opts.kind || opts.kind === k) && (!opts.kinds || opts.kinds.includes(k));
  const db = ctx.db;
  const tasks: Task[] = [];

  if (want("file_into_project")) {
    // Team items whose title, folder or tags name a project (or one of its repositories), or that sit under a "Projects/" folder.
    const { rows } = await db.query<{ kind: string; id: string; title: string; path: string; projects: { slug: string; name: string; repos: string[] }[] }>(
      `WITH projects AS (
         SELECT s.id, s.slug, s.name, coalesce(array_agg(c.slug) FILTER (WHERE c.slug IS NOT NULL), '{}') AS repos
           FROM scopes s LEFT JOIN components c ON c.scope_id = s.id
          WHERE s.kind = 'project' AND s.status = 'active' AND ($1::uuid[] IS NULL OR s.id = ANY($1)) AND ($2::uuid IS NULL OR s.id = $2)
          GROUP BY s.id),
       items AS (
         SELECT 'article' AS kind, a.id, a.title, a.path, a.tags FROM articles a JOIN scopes t ON t.id = a.scope_id
          WHERE t.kind = 'team' AND a.status IN ('published', 'possibly_stale')
         UNION ALL
         SELECT 'finding', f.id, f.title, '', f.tags FROM findings f JOIN scopes t ON t.id = f.scope_id
          WHERE t.kind = 'team' AND f.status IN ('published', 'possibly_stale'))
       SELECT i.kind, i.id, i.title, i.path,
              json_agg(json_build_object('slug', p.slug, 'name', p.name, 'repos', p.repos)) AS projects
         FROM items i JOIN projects p ON
              lower(i.title || ' ' || coalesce(i.path, '') || ' ' || array_to_string(i.tags, ' ')) LIKE '%' || lower(p.name) || '%'
           OR lower(i.title || ' ' || coalesce(i.path, '') || ' ' || array_to_string(i.tags, ' ')) LIKE '%' || p.slug || '%'
           OR EXISTS (SELECT 1 FROM unnest(p.repos) r WHERE length(r) > 4 AND lower(i.title || ' ' || coalesce(i.path, '')) LIKE '%' || r || '%')
           OR lower(coalesce(i.path, '')) LIKE 'projects/%'
        GROUP BY i.kind, i.id, i.title, i.path
        LIMIT 40`,
      [readable, projectId],
    );
    for (const r of rows) {
      tasks.push({
        id: `file_into_project:${r.id}`,
        kind: "file_into_project",
        title: `File “${r.title}” into its project`,
        project: r.projects.length === 1 ? r.projects[0]!.slug : null,
        targets: [{ kind: r.kind, id: r.id, title: r.title, scope: "team" }],
        context: { current_folder: r.path || null, candidate_projects: r.projects.slice(0, 5) },
        instructions: INSTRUCTIONS.file_into_project,
      });
    }
  }

  if (want("tag_repository")) {
    const { rows } = await db.query<{ kind: string; id: string; title: string; path: string; scope: string; repos: { slug: string; kind: string; description: string }[] }>(
      `SELECT x.kind, x.id, x.title, x.path, s.slug AS scope,
              (SELECT json_agg(json_build_object('slug', c.slug, 'kind', c.kind, 'description', c.description) ORDER BY c.slug) FROM components c WHERE c.scope_id = s.id) AS repos
         FROM (SELECT 'article' AS kind, id, title, path, scope_id, component_ids, status FROM articles
               UNION ALL SELECT 'finding', id, title, '', scope_id, component_ids, status FROM findings) x
         JOIN scopes s ON s.id = x.scope_id
        WHERE s.kind = 'project' AND x.status IN ('published', 'possibly_stale') AND cardinality(x.component_ids) = 0
          AND (SELECT count(*) FROM components c WHERE c.scope_id = s.id) >= 2
          AND ($1::uuid[] IS NULL OR s.id = ANY($1)) AND ($2::uuid IS NULL OR s.id = $2)
          AND NOT (x.kind = 'article' AND EXISTS (SELECT 1 FROM articles o WHERE o.id = x.id AND o.type = 'project_overview'))
        ORDER BY s.slug, x.path, x.title LIMIT 40`,
      [readable, projectId],
    );
    for (const r of rows) {
      tasks.push({
        id: `tag_repository:${r.id}`,
        kind: "tag_repository",
        title: `Which repository is “${r.title}” about?`,
        project: r.scope,
        targets: [{ kind: r.kind, id: r.id, title: r.title, scope: r.scope }],
        context: { folder: r.path || null, repositories: r.repos },
        instructions: INSTRUCTIONS.tag_repository,
      });
    }
  }

  if (want("merge_duplicates") || want("promote_recurring")) {
    const s = await listSuggestions(ctx, { project: opts.project, limit: 20 });
    if (want("merge_duplicates")) {
      for (const d of s.duplicates as { similarity: number; a: { id: string; title: string; scope: string }; b: { id: string; title: string; scope: string } }[]) {
        const [x, y] = [d.a, d.b].sort((p, q) => p.id.localeCompare(q.id));
        tasks.push({
          id: `merge_duplicates:${x!.id}:${y!.id}`,
          kind: "merge_duplicates",
          title: `Same problem? “${x!.title}” and “${y!.title}”`,
          project: null,
          targets: [
            { kind: "finding", ...x! },
            { kind: "finding", ...y! },
          ],
          context: { similarity: d.similarity },
          instructions: INSTRUCTIONS.merge_duplicates,
        });
      }
    }
    if (want("promote_recurring")) {
      for (const p of s.promote) {
        tasks.push({
          id: `promote_recurring:${p.finding.id}`,
          kind: "promote_recurring",
          title: `Fold “${p.finding.title}” into an article`,
          project: null,
          targets: [{ kind: "finding", ...p.finding }],
          context: { recurrences: p.recurrences, verifications: p.verifications, suggested_article: p.suggested_article, hint: p.hint },
          instructions: INSTRUCTIONS.promote_recurring,
        });
      }
    }
  }

  if (want("fill_outline")) {
    const { rows } = await db.query<{ id: string; title: string; type: string; body_md: string; scope: string }>(
      `SELECT a.id, a.title, a.type, a.body_md, s.slug AS scope FROM articles a JOIN scopes s ON s.id = a.scope_id
        WHERE a.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR a.scope_id = ANY($1)) AND ($2::uuid IS NULL OR a.scope_id = $2)
        ORDER BY a.updated_at DESC LIMIT 400`,
      [readable, projectId],
    );
    for (const a of rows) {
      const sections = splitSections(a.body_md);
      const template = new Set((ARTICLE_TEMPLATES[a.type] ?? []).map((h) => h.toLowerCase()));
      const empty = sections.filter((x) => x.heading && PLACEHOLDER.test(x.text) && (template.has(x.heading.toLowerCase()) || x.text.includes("_To write: "))).map((x) => x.heading);
      if (!empty.length) continue;
      tasks.push({
        id: `fill_outline:${a.id}`,
        kind: "fill_outline",
        title: `Fill in ${empty.length} empty section${empty.length > 1 ? "s" : ""} of “${a.title}”`,
        project: a.scope,
        targets: [{ kind: "article", id: a.id, title: a.title, scope: a.scope }],
        context: { empty_sections: empty },
        instructions: INSTRUCTIONS.fill_outline,
      });
    }
  }

  if (want("verify_stale")) {
    const { rows } = await db.query<{ kind: string; id: string; title: string; scope: string; last_verified_at: string | null }>(
      `SELECT * FROM (
         SELECT 'article' AS kind, a.id, a.title, s.slug AS scope, a.last_verified_at, a.scope_id FROM articles a JOIN scopes s ON s.id = a.scope_id
          WHERE a.status = 'possibly_stale' OR (a.status = 'published' AND a.review_due < current_date)
         UNION ALL
         SELECT 'finding', f.id, f.title, s.slug, f.last_verified_at, f.scope_id FROM findings f JOIN scopes s ON s.id = f.scope_id WHERE f.status = 'possibly_stale') x
        WHERE ($1::uuid[] IS NULL OR x.scope_id = ANY($1)) AND ($2::uuid IS NULL OR x.scope_id = $2)
        ORDER BY x.last_verified_at NULLS FIRST LIMIT 30`,
      [readable, projectId],
    );
    for (const r of rows) {
      tasks.push({
        id: `verify_stale:${r.id}`,
        kind: "verify_stale",
        title: `Is “${r.title}” still true?`,
        project: r.scope,
        targets: [{ kind: r.kind, id: r.id, title: r.title, scope: r.scope }],
        context: { last_verified_at: r.last_verified_at },
        instructions: INSTRUCTIONS.verify_stale,
      });
    }
  }

  if (want("write_overview")) {
    const { rows } = await db.query<{ slug: string; name: string; repos: { slug: string; repo_url: string | null }[] }>(
      `SELECT s.slug, s.name,
              coalesce((SELECT json_agg(json_build_object('slug', c.slug, 'repo_url', c.repo_url)) FROM components c WHERE c.scope_id = s.id), '[]') AS repos
         FROM scopes s
        WHERE s.kind = 'project' AND s.status = 'active' AND ($1::uuid[] IS NULL OR s.id = ANY($1)) AND ($2::uuid IS NULL OR s.id = $2)
          AND NOT EXISTS (SELECT 1 FROM articles a WHERE a.scope_id = s.id AND a.type = 'project_overview' AND a.status IN ('published', 'possibly_stale', 'draft'))`,
      [readable, projectId],
    );
    for (const p of rows) {
      tasks.push({
        id: `write_overview:${p.slug}`,
        kind: "write_overview",
        title: `Write an overview of ${p.name}`,
        project: p.slug,
        targets: [],
        context: { project: p.slug, repositories: p.repos },
        instructions: INSTRUCTIONS.write_overview,
      });
    }
  }

  if (want("link_related")) {
    const { rows } = await db.query<{ kind: string; id: string; title: string; scope: string }>(
      `SELECT x.kind, x.id, x.title, s.slug AS scope FROM (
         SELECT 'article' AS kind, id, title, scope_id, status, created_at FROM articles
         UNION ALL SELECT 'finding', id, title, scope_id, status, created_at FROM findings) x
         JOIN scopes s ON s.id = x.scope_id
        WHERE x.status IN ('published', 'possibly_stale') AND x.created_at < now() - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM relations r WHERE r.from_id = x.id OR r.to_id = x.id)
          AND ($1::uuid[] IS NULL OR x.scope_id = ANY($1)) AND ($2::uuid IS NULL OR x.scope_id = $2)
        ORDER BY x.created_at DESC LIMIT 30`,
      [readable, projectId],
    );
    for (const r of rows) {
      tasks.push({
        id: `link_related:${r.id}`,
        kind: "link_related",
        title: `Link “${r.title}” to related knowledge`,
        project: null,
        targets: [{ kind: r.kind, id: r.id, title: r.title, scope: r.scope }],
        context: {},
        instructions: INSTRUCTIONS.link_related,
      });
    }
  }

  if (want("stale_claims")) {
    const { rows } = await db.query<{ id: string; title: string; scope: string; component: string; stale: number }>(
      `SELECT a.id, a.title, s.slug AS scope, d.component, count(c.id)::int AS stale
         FROM claims c JOIN articles a ON a.id = c.article_id JOIN scopes s ON s.id = a.scope_id LEFT JOIN doc_pages d ON d.article_id = a.id
        WHERE c.status = 'stale' AND a.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR a.scope_id = ANY($1)) AND ($2::uuid IS NULL OR a.scope_id = $2)
        GROUP BY a.id, s.slug, d.component ORDER BY stale DESC LIMIT 30`,
      [readable, projectId],
    );
    for (const r of rows) {
      tasks.push({
        id: `stale_claims:${r.id}`,
        kind: "stale_claims",
        title: `${r.stale} fact${r.stale > 1 ? "s" : ""} on “${r.title}” may be out of date`,
        project: r.scope,
        targets: [{ kind: "article", id: r.id, title: r.title, scope: r.scope }],
        context: { repository: r.component || null, stale_claims: r.stale },
        instructions: INSTRUCTIONS.stale_claims,
      });
    }
  }

  // Search gaps show what people looked for, so only admins' agents get them.
  if (want("answer_gap") && isAdmin(ctx) && !projectId) {
    const { rows } = await db.query<{ query: string; n: number }>(
      `SELECT lower(query) AS query, count(*)::int AS n FROM search_log
        WHERE query IS NOT NULL AND at > now() - interval '30 days' GROUP BY 1 HAVING count(*) >= 1 ORDER BY n DESC LIMIT 15`,
    );
    for (const g of rows) {
      tasks.push({
        id: `answer_gap:${g.query.slice(0, 200)}`,
        kind: "answer_gap",
        title: `Nothing found for “${g.query}”`,
        project: null,
        targets: [],
        context: { query: g.query, searches: g.n },
        instructions: INSTRUCTIONS.answer_gap,
      });
    }
  }
  return tasks;
}

/** Tasks nobody finished recently and nobody else is on right now. */
async function openTasks(ctx: RequestContext, opts: { kind?: TaskKind; kinds?: TaskKind[]; project?: string }) {
  const all = await candidates(ctx, opts);
  if (!all.length) return [];
  const { rows } = await ctx.db.query<{ key: string }>(
    `SELECT key FROM agent_tasks WHERE key = ANY($1)
       AND ((completed_at IS NOT NULL AND completed_at > now() - CASE outcome WHEN 'skipped' THEN interval '30 days' ELSE interval '90 days' END)
            OR (completed_at IS NULL AND claimed_until > now() AND claimed_by <> $2))`,
    [all.map((t) => t.id), ctx.actor.id],
  );
  const hidden = new Set(rows.map((r) => r.key));
  return all.filter((t) => !hidden.has(t.id)).sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind]);
}

/** Hands out up to `limit` tasks and claims them for this caller for an hour. */
export async function getTasks(ctx: RequestContext, opts: { kind?: TaskKind; project?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  const open = await openTasks(ctx, opts);
  const picked = open.slice(0, limit);
  for (const t of picked) {
    await ctx.db.query(
      `INSERT INTO agent_tasks (key, kind, claimed_by, claimed_until) VALUES ($1, $2, $3, now() + interval '1 hour')
       ON CONFLICT (key) DO UPDATE SET claimed_by = EXCLUDED.claimed_by, claimed_until = EXCLUDED.claimed_until, completed_at = NULL, completed_by = NULL, outcome = NULL, note = NULL, revision_id = NULL`,
      [t.id, t.kind, ctx.actor.id],
    );
  }
  return {
    tasks: picked,
    remaining: open.length - picked.length,
    how: "Work through the tasks one at a time. Everything you change is a proposal a person reviews. After each one call complete_task with the outcome and, if you proposed something, its revision_id.",
  };
}

export async function completeTask(ctx: RequestContext, input: { task_id: string; outcome: "done" | "skipped" | "not_applicable"; note?: string; revision_id?: string }) {
  const kind = input.task_id.split(":")[0] as TaskKind;
  if (!TASK_KINDS.includes(kind)) throw new ValidationError(`unknown task ${input.task_id}`);
  const { rows } = await ctx.db.query<{ claimed_by: string | null; claimed_until: string | null; completed_at: string | null }>(
    "SELECT claimed_by, claimed_until, completed_at FROM agent_tasks WHERE key = $1",
    [input.task_id],
  );
  const row = rows[0];
  if (!row) throw new NotFoundError(`task ${input.task_id} (call get_tasks first)`);
  if (row.completed_at) throw new ValidationError("that task is already completed");
  await ctx.db.query(
    `UPDATE agent_tasks SET completed_at = now(), completed_by = $2, outcome = $3, note = $4, revision_id = $5, claimed_until = NULL WHERE key = $1`,
    [input.task_id, ctx.actor.id, input.outcome, input.note?.slice(0, 1000) ?? null, input.revision_id ?? null],
  );
  return { task_id: input.task_id, outcome: input.outcome };
}

/** Counts of open tasks by kind (for the web UI and project hints). */
export async function taskSummary(ctx: RequestContext, opts: { project?: string } = {}) {
  const open = await openTasks(ctx, opts);
  const byKind: Partial<Record<TaskKind, number>> = {};
  for (const t of open) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
  const recent = await ctx.db.query(
    `SELECT t.key, t.kind, t.outcome, t.note, t.completed_at, t.revision_id, coalesce(u.display_name, u.email, u.subject) AS by
       FROM agent_tasks t LEFT JOIN users u ON u.id = t.completed_by
      WHERE t.completed_at IS NOT NULL ORDER BY t.completed_at DESC LIMIT 15`,
  );
  const week = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM agent_tasks WHERE completed_at > now() - interval '7 days' AND outcome = 'done'")).rows[0]!.n;
  return { open: open.length, by_kind: byKind, done_this_week: week, recent: recent.rows, sample: open.slice(0, 8).map((t) => ({ id: t.id, kind: t.kind, title: t.title, project: t.project })) };
}

/** A short note for get_project_context when there's curation work in the project (cheap kinds only). */
export async function projectHint(ctx: RequestContext, project: string) {
  const open = await openTasks(ctx, { project, kinds: ["file_into_project", "tag_repository", "fill_outline", "verify_stale", "write_overview", "stale_claims"] });
  if (!open.length) return null;
  const byKind: Partial<Record<TaskKind, number>> = {};
  for (const t of open) byKind[t.kind] = (byKind[t.kind] ?? 0) + 1;
  return {
    open_tasks: open.length,
    by_kind: byKind,
    hint: `${open.length} curation task${open.length > 1 ? "s" : ""} in this project (get_tasks with project). If you have spare moments in this session, or when the user asks, pick one up; never let it derail the user's request.`,
  };
}

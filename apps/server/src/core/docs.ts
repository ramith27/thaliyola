import { withTx } from "../db/pool.js";
import { audit } from "./audit.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { editArticle, newArticle } from "./direct.js";
import { assertCanPropose, canApprove } from "./permissions.js";
import { getReadableScope, resolveRepo } from "./scopes.js";
import { ARTICLE_TEMPLATES } from "./templates.js";
import { findItem, type CreateArticleInput } from "./writes.js";

/**
 * Repository documentation, written by a connected coding agent and kept in
 * step with the code. Thaliyola has no model: the agent reads the repository
 * and writes the pages; Thaliyola owns the plan and page queue (resumable),
 * checks each page (diagrams, grounded claims, ignore rules), files it as an
 * article in the project (published for owners, a proposal otherwise), and on
 * the next run tells the agent exactly which facts the changed files affect.
 *
 * Lifecycle: docs_begin → docs_submit_plan → docs_next_page → docs_submit_page
 * (repeat) → docs_finish. An update with no relevant changes is a no-op.
 */

const KEY = /^[a-z0-9][a-z0-9-]{0,80}$/;
const MAX_PAGES = 60;
const MAX_CLAIMS = 200;
const CLAIM_LOCK_MINUTES = 30;
const ARTICLE_TYPES = Object.keys(ARTICLE_TEMPLATES);

export interface Evidence {
  path: string;
  start?: number;
  end?: number;
  sha?: string;
}
export interface ClaimInput {
  section?: string;
  text: string;
  evidence: (Evidence | string)[];
}

// ---- Ignore rules (gitignore-style) ---------------------------------------------

function globToRegex(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += glob[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return re;
}

/** A matcher for gitignore-style rules: globs, directories ("dir/"), anchors ("/x") and negation ("!x"). */
export function ignoreMatcher(text: string): (path: string) => boolean {
  const rules = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      let p = negate ? line.slice(1) : line;
      const dir = p.endsWith("/");
      if (dir) p = p.slice(0, -1);
      const anchored = p.startsWith("/") || p.includes("/");
      p = p.replace(/^\//, "");
      const body = globToRegex(p);
      const re = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${dir ? "/" : "(?:/.*)?$"}`);
      return { negate, re, dir };
    });
  return (path: string) => {
    const p = path.replace(/^\.?\//, "");
    let ignored = false;
    for (const r of rules) if (r.re.test(r.dir ? `${p}/` : p) || (r.dir && r.re.test(p))) ignored = !r.negate;
    return ignored;
  };
}

// ---- Mermaid checks --------------------------------------------------------------------

const DIAGRAMS = [
  "graph", "flowchart", "sequenceDiagram", "classDiagram", "stateDiagram", "stateDiagram-v2", "erDiagram", "journey", "gantt", "pie", "gitGraph",
  "mindmap", "timeline", "quadrantChart", "requirementDiagram", "C4Context", "C4Container", "C4Component", "C4Dynamic", "sankey-beta", "xychart-beta",
  "block-beta", "architecture-beta", "packet-beta", "kanban",
];

/** Catches the mistakes that stop a Mermaid diagram rendering; the agent repairs and resubmits. */
export function checkMermaid(markdown: string): string[] {
  const errors: string[] = [];
  const blocks = [...markdown.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)];
  blocks.forEach((m, i) => {
    const code = m[1]!.replace(/%%.*$/gm, "");
    const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
    const n = `diagram ${i + 1}`;
    if (!lines.length) return void errors.push(`${n} is empty`);
    const kind = lines[0]!.split(/\s+/)[0]!;
    if (!DIAGRAMS.includes(kind)) errors.push(`${n} starts with "${kind}", which isn't a Mermaid diagram type (use e.g. flowchart TD, sequenceDiagram, erDiagram, stateDiagram-v2)`);
    const open: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
    lines.forEach((line, j) => {
      const stack: string[] = [];
      let quoted = false;
      for (const ch of line) {
        if (ch === '"') quoted = !quoted;
        if (quoted) continue;
        if (open[ch]) stack.push(open[ch]!);
        else if (")]}".includes(ch) && stack.pop() !== ch) return void errors.push(`${n}, line ${j + 1}: unbalanced "${ch}" in "${line.slice(0, 60)}"`);
      }
      if (quoted) errors.push(`${n}, line ${j + 1}: unclosed quote in "${line.slice(0, 60)}"`);
      else if (stack.length) errors.push(`${n}, line ${j + 1}: unclosed bracket in "${line.slice(0, 60)}"`);
      if ((kind === "flowchart" || kind === "graph") && j > 0 && /\b(end)\b/.test(line) && /-->|---/.test(line) && /\bend\b(?![\w"])/.test(line.split(/-->|---/).at(-1)!)) {
        errors.push(`${n}, line ${j + 1}: a node can't be called "end" in a flowchart (use End or "end")`);
      }
    });
  });
  return [...new Set(errors)].slice(0, 20);
}

// ---- Evidence --------------------------------------------------------------------------

/** "repo://src/a.ts#L40-L82", "src/a.ts#L40" or {path, start, end}. */
export function parseEvidence(e: Evidence | string): Evidence {
  if (typeof e !== "string") return e;
  const m = /^(?:repo:\/\/)?([^#]+?)(?:#L(\d+)(?:-L?(\d+))?)?$/.exec(e.trim());
  if (!m) throw new ValidationError(`evidence "${e}" should look like repo://path/to/file.ts#L40-L82`);
  return { path: m[1]!, start: m[2] ? Number(m[2]) : undefined, end: m[3] ? Number(m[3]) : m[2] ? Number(m[2]) : undefined };
}

function cleanEvidence(raw: Evidence | string, sha: string, ignored: (p: string) => boolean): Evidence {
  const e = parseEvidence(raw);
  const path = e.path.trim().replace(/^\.?\//, "");
  if (!path || path.includes("..") || path.startsWith("/")) throw new ValidationError(`evidence path "${e.path}" must be relative to the repository root`);
  if (ignored(path)) throw new ValidationError(`evidence "${path}" is excluded by the project's ignore rules; don't read or cite it`);
  if (e.start !== undefined && (!Number.isInteger(e.start) || e.start < 1)) throw new ValidationError(`evidence ${path}: line numbers start at 1`);
  if (e.end !== undefined && e.start !== undefined && e.end < e.start) throw new ValidationError(`evidence ${path}: end line before start line`);
  return { path, ...(e.start ? { start: e.start } : {}), ...(e.end ? { end: e.end } : {}), sha: e.sha ?? sha };
}

// ---- Runs ------------------------------------------------------------------------------

async function resolveTarget(ctx: RequestContext, input: { project?: string; repo?: string; component?: string }) {
  let project = input.project;
  let component = input.component;
  if (input.repo && (!project || !component)) {
    const found = await resolveRepo(ctx.db, input.repo);
    if (!found) throw new NotFoundError(`no project has the repository ${input.repo}; add it under the project's settings → Repositories (or create_project)`);
    project ??= found.project;
    component ??= found.component;
  }
  project ??= ctx.project;
  component ??= ctx.component;
  if (!project) throw new ValidationError("pass project (or repo, the git remote URL)");
  const scope = await getReadableScope(ctx, project);
  if (scope.kind !== "project") throw new ValidationError("documentation runs are for projects");
  const comp = component
    ? (await ctx.db.query<{ id: string; slug: string; repo_url: string | null; docs_sha: string | null }>(
        "SELECT id, slug, repo_url, docs_sha FROM components WHERE scope_id = $1 AND slug = $2",
        [scope.id, component],
      )).rows[0]
    : undefined;
  if (component && !comp) throw new NotFoundError(`${project} has no repository '${component}'`);
  return { scope, comp };
}

async function loadRun(ctx: RequestContext, runId: string) {
  const { rows } = await ctx.db.query<{
    id: string; scope_id: string; component_id: string | null; component: string | null; mode: string; head_sha: string; status: string; started_by: string;
  }>(
    `SELECT r.id, r.scope_id, r.component_id, c.slug AS component, r.mode, r.head_sha, r.status, r.started_by
       FROM doc_runs r LEFT JOIN components c ON c.id = r.component_id WHERE r.id = $1`,
    [runId],
  );
  const run = rows[0];
  if (!run) throw new NotFoundError(`docs run ${runId}`);
  if (run.started_by !== ctx.actor.id && !(await canApprove(ctx, run.scope_id))) throw new ValidationError("this run belongs to someone else; start your own with docs_begin");
  return run;
}

async function settingsFor(ctx: RequestContext, scopeId: string) {
  const { rows } = await ctx.db.query<{ doc_instructions: string; doc_ignore: string }>("SELECT doc_instructions, doc_ignore FROM scopes WHERE id = $1", [scopeId]);
  return rows[0]!;
}

async function existingPages(ctx: RequestContext, scopeId: string, component: string) {
  const { rows } = await ctx.db.query(
    `SELECT d.key, a.title, a.path AS folder, a.type, d.article_id, d.sources, d.last_sha,
            (SELECT count(*) FROM claims c WHERE c.article_id = d.article_id AND c.status = 'stale')::int AS stale_claims
       FROM doc_pages d JOIN articles a ON a.id = d.article_id
      WHERE d.scope_id = $1 AND d.component = $2 AND a.status NOT IN ('deleted', 'rejected', 'superseded') ORDER BY a.path, a.title`,
    [scopeId, component],
  );
  return rows;
}

export async function docsBegin(
  ctx: RequestContext,
  input: { project?: string; repo?: string; component?: string; head_sha: string; base_sha?: string; mode?: "init" | "update"; changed_files?: string[]; deleted_files?: string[] },
) {
  const { scope, comp } = await resolveTarget(ctx, input);
  await assertCanPropose(ctx, scope.id);
  if (!/^[0-9a-f]{7,64}$/i.test(input.head_sha)) throw new ValidationError("head_sha must be the current commit (git rev-parse HEAD)");
  const component = comp?.slug ?? "";
  const settings = await settingsFor(ctx, scope.id);
  const pages = await existingPages(ctx, scope.id, component);
  const mode = input.mode ?? (pages.length ? "update" : "init");

  // An unfinished run for the same repository resumes instead of starting over.
  const open = await ctx.db.query<{ id: string; status: string; head_sha: string }>(
    "SELECT id, status, head_sha FROM doc_runs WHERE scope_id = $1 AND component_id IS NOT DISTINCT FROM $2 AND status IN ('planning', 'writing') ORDER BY started_at DESC LIMIT 1",
    [scope.id, comp?.id ?? null],
  );
  if (open.rows[0]) {
    const left = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM doc_run_pages WHERE run_id = $1 AND status IN ('pending', 'claimed')", [open.rows[0].id]);
    return {
      run_id: open.rows[0].id,
      resumed: true,
      status: open.rows[0].status,
      head_sha: open.rows[0].head_sha,
      pages_left: left.rows[0]!.n,
      next: open.rows[0].status === "planning" ? "docs_submit_plan" : "docs_next_page",
      instructions: settings.doc_instructions || null,
      ignore: settings.doc_ignore || null,
    };
  }

  const base = input.base_sha ?? comp?.docs_sha ?? null;
  const changed = [...new Set([...(input.changed_files ?? []), ...(input.deleted_files ?? [])].map((p) => p.replace(/^\.?\//, "")))];
  let affected: { key: string; reasons: string[] }[] = [];
  let unmapped: string[] = [];
  if (mode === "update") {
    if (!changed.length && base && base !== input.head_sha && !input.changed_files) {
      throw new ValidationError(`pass changed_files (git diff --name-only ${base.slice(0, 12)}..${input.head_sha.slice(0, 12)}) so only affected pages are redone`);
    }
    // Facts whose evidence changed are stale until an agent confirms, rewrites or retires them.
    if (changed.length) {
      await ctx.db.query(
        `UPDATE claims c SET status = 'stale', stale_reason = $3
          WHERE c.status = 'ok' AND c.article_id IN (SELECT article_id FROM doc_pages WHERE scope_id = $1 AND component = $2)
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.evidence) e WHERE e->>'path' = ANY($4::text[]))`,
        [scope.id, component, `source changed${base ? ` since ${base.slice(0, 12)}` : ""} (now ${input.head_sha.slice(0, 12)})`, changed],
      );
    }
    const fresh = await existingPages(ctx, scope.id, component);
    affected = fresh
      .map((p: { key: string; sources: string[]; stale_claims: number }) => {
        const reasons: string[] = [];
        const touched = p.sources.filter((s: string) => changed.some((c) => c === s || c.startsWith(`${s.replace(/\/$/, "")}/`)));
        if (touched.length) reasons.push(`sources changed: ${touched.slice(0, 5).join(", ")}`);
        if (p.stale_claims) reasons.push(`${p.stale_claims} stale claim${p.stale_claims > 1 ? "s" : ""}`);
        return { key: p.key, reasons };
      })
      .filter((p) => p.reasons.length);
    const relevant = changed.filter((c) => !isIgnoredFor(settings.doc_ignore, c));
    unmapped = relevant.filter((c) => !fresh.some((p: { sources: string[] }) => p.sources.some((s: string) => c === s || c.startsWith(`${s.replace(/\/$/, "")}/`))));
    if (!affected.length && (base === input.head_sha || relevant.length === 0)) {
      // Nothing relevant changed: record the check and stop, no model work needed.
      const { rows } = await ctx.db.query<{ id: string }>(
        `INSERT INTO doc_runs (scope_id, component_id, mode, base_sha, head_sha, changed_files, status, started_by, finished_at, summary)
         VALUES ($1, $2, 'update', $3, $4, $5, 'noop', $6, now(), 'No relevant changes') RETURNING id`,
        [scope.id, comp?.id ?? null, base, input.head_sha, changed, ctx.actor.id],
      );
      if (comp) await ctx.db.query("UPDATE components SET docs_sha = $2, docs_updated_at = now() WHERE id = $1", [comp.id, input.head_sha]);
      return { run_id: rows[0]!.id, noop: true, message: "The documentation is up to date with this commit; nothing to write." };
    }
  }
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO doc_runs (scope_id, component_id, mode, base_sha, head_sha, changed_files, started_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [scope.id, comp?.id ?? null, mode, base, input.head_sha, changed, ctx.actor.id],
  );
  await audit(ctx.db, ctx.actor.id, "docs_begin", rows[0]!.id);
  return {
    run_id: rows[0]!.id,
    mode,
    project: scope.slug,
    repository: component || null,
    head_sha: input.head_sha,
    base_sha: base,
    instructions: settings.doc_instructions || null,
    ignore: settings.doc_ignore || null,
    existing_pages: pages.map((p: { key: string; title: string; folder: string; type: string; article_id: string; stale_claims: number }) => ({
      key: p.key, title: p.title, folder: p.folder, type: p.type, article_id: p.article_id, stale_claims: p.stale_claims,
    })),
    ...(mode === "update" ? { affected_pages: affected, unmapped_changes: unmapped.slice(0, 200) } : {}),
    next:
      mode === "init"
        ? "Research the repository (code and tests), then docs_submit_plan with the pages: an overview first, then architecture, key flows, data model, APIs/contracts, runbooks. Respect ignore."
        : "docs_submit_plan with the affected pages to rewrite, plus new pages if unmapped_changes add something worth documenting. Nothing worth writing? docs_finish with a summary.",
  };
}

function isIgnoredFor(ignoreText: string, path: string) {
  return ignoreText ? ignoreMatcher(ignoreText)(path) : false;
}

export async function docsSubmitPlan(
  ctx: RequestContext,
  input: { run_id: string; pages: { key: string; title: string; folder?: string; type: string; purpose?: string; sources?: string[] }[] },
) {
  const run = await loadRun(ctx, input.run_id);
  if (run.status !== "planning") throw new ValidationError(`this run is ${run.status}; the plan is already set (docs_next_page)`);
  if (!input.pages.length) throw new ValidationError("a plan needs at least one page");
  if (input.pages.length > MAX_PAGES) throw new ValidationError(`at most ${MAX_PAGES} pages per run; split the work into another run`);
  const ignored = ignoreMatcher((await settingsFor(ctx, run.scope_id)).doc_ignore);
  const seen = new Set<string>();
  for (const p of input.pages) {
    if (!KEY.test(p.key)) throw new ValidationError(`page key "${p.key}" must be lowercase letters, digits and hyphens`);
    if (seen.has(p.key)) throw new ValidationError(`page key "${p.key}" appears twice`);
    seen.add(p.key);
    if (!ARTICLE_TYPES.includes(p.type)) throw new ValidationError(`page "${p.key}": type must be one of ${ARTICLE_TYPES.join(", ")}`);
    if (!p.title.trim()) throw new ValidationError(`page "${p.key}" needs a title`);
    for (const s of p.sources ?? []) if (ignored(s)) throw new ValidationError(`page "${p.key}": source ${s} is excluded by the ignore rules`);
  }
  await withTx(ctx.db, async (db) => {
    for (const [i, p] of input.pages.entries()) {
      await db.query(
        "INSERT INTO doc_run_pages (run_id, position, key, title, folder, type, purpose, sources) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        [run.id, i, p.key, p.title.trim().slice(0, 200), (p.folder ?? "").trim().replace(/^\/+|\/+$/g, ""), p.type, (p.purpose ?? "").slice(0, 1000), p.sources ?? []],
      );
    }
    await db.query("UPDATE doc_runs SET status = 'writing' WHERE id = $1", [run.id]);
  });
  return { run_id: run.id, pages: input.pages.length, next: "docs_next_page" };
}

export async function docsNextPage(ctx: RequestContext, input: { run_id: string }) {
  const run = await loadRun(ctx, input.run_id);
  if (run.status !== "writing") throw new ValidationError(run.status === "planning" ? "submit the plan first (docs_submit_plan)" : `this run is ${run.status}`);
  const { rows } = await ctx.db.query<{ key: string; title: string; folder: string; type: string; purpose: string; sources: string[]; position: number }>(
    `UPDATE doc_run_pages SET status = 'claimed', claimed_at = now()
      WHERE run_id = $1 AND key = (
        SELECT key FROM doc_run_pages WHERE run_id = $1
           AND (status = 'pending' OR (status = 'claimed' AND claimed_at < now() - make_interval(mins => $2)))
         ORDER BY position LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING key, title, folder, type, purpose, sources, position`,
    [run.id, CLAIM_LOCK_MINUTES],
  );
  const page = rows[0];
  const counts = (
    await ctx.db.query<{ total: number; done: number }>(
      "SELECT count(*)::int AS total, count(*) FILTER (WHERE status IN ('submitted', 'skipped'))::int AS done FROM doc_run_pages WHERE run_id = $1",
      [run.id],
    )
  ).rows[0]!;
  if (!page) return { done: true, progress: `${counts.done}/${counts.total}`, next: "docs_finish" };
  const existing = (
    await ctx.db.query<{ article_id: string }>("SELECT article_id FROM doc_pages WHERE scope_id = $1 AND component = $2 AND key = $3", [run.scope_id, run.component ?? "", page.key])
  ).rows[0];
  let current = null;
  let claims: unknown[] = [];
  if (existing) {
    const a = (await ctx.db.query("SELECT id, title, body_md, version, status FROM articles WHERE id = $1", [existing.article_id])).rows[0];
    if (a && a.status !== "deleted") {
      current = { article_id: a.id, title: a.title, version: a.version, body_md: a.body_md };
      claims = (await ctx.db.query("SELECT id, section, text, evidence, status, stale_reason FROM claims WHERE article_id = $1 AND status <> 'retired' ORDER BY section, created_at", [a.id])).rows;
    }
  }
  return {
    run_id: run.id,
    progress: `${counts.done + 1}/${counts.total}`,
    page: { ...page, template_sections: ARTICLE_TEMPLATES[page.type] ?? [] },
    current,
    claims,
    how:
      "Read the sources, then docs_submit_page with the whole page in Markdown and its claims: each factual statement with evidence (repo://path#Lstart-Lend at this commit). " +
      "Use Mermaid diagrams (```mermaid) where they help, only for what the code shows. On an update, keep what is still true, rewrite what changed, and drop stale claims that no longer hold.",
  };
}

export async function docsSubmitPage(
  ctx: RequestContext,
  input: { run_id: string; key: string; title?: string; body_md: string; summary?: string; claims: ClaimInput[] },
) {
  const run = await loadRun(ctx, input.run_id);
  if (run.status !== "writing") throw new ValidationError(`this run is ${run.status}`);
  const page = (
    await ctx.db.query<{ key: string; title: string; folder: string; type: string; status: string; sources: string[] }>(
      "SELECT key, title, folder, type, status, sources FROM doc_run_pages WHERE run_id = $1 AND key = $2",
      [run.id, input.key],
    )
  ).rows[0];
  if (!page) throw new NotFoundError(`page "${input.key}" isn't in this run's plan`);
  if (page.status === "submitted") throw new ValidationError(`page "${input.key}" is already submitted`);
  const body = input.body_md.trim();
  if (body.length < 40) throw new ValidationError("the page is nearly empty");
  const diagramErrors = checkMermaid(body);
  if (diagramErrors.length) throw new ValidationError(`fix the diagrams and resubmit: ${diagramErrors.join("; ")}`);
  if (!input.claims?.length) throw new ValidationError("ground the page: submit its factual statements as claims with evidence (repo://path#L40-L82)");
  if (input.claims.length > MAX_CLAIMS) throw new ValidationError(`at most ${MAX_CLAIMS} claims per page`);
  const ignored = ignoreMatcher((await settingsFor(ctx, run.scope_id)).doc_ignore);
  const claims = input.claims.map((c, i) => {
    if (!c.text?.trim()) throw new ValidationError(`claim ${i + 1} has no text`);
    if (!c.evidence?.length) throw new ValidationError(`claim ${i + 1} ("${c.text.slice(0, 50)}") has no evidence`);
    return { section: (c.section ?? "").trim().slice(0, 200), text: c.text.trim().slice(0, 1000), evidence: c.evidence.slice(0, 10).map((e) => cleanEvidence(e, run.head_sha, ignored)) };
  });

  const component = run.component ?? "";
  const title = (input.title ?? page.title).trim();
  const summary = input.summary?.trim() || `${run.mode === "init" ? "Document" : "Update"} ${title} (${run.head_sha.slice(0, 12)})`;
  const mapped = (
    await ctx.db.query<{ article_id: string }>("SELECT article_id FROM doc_pages WHERE scope_id = $1 AND component = $2 AND key = $3", [run.scope_id, component, page.key])
  ).rows[0];
  const project = (await ctx.db.query<{ slug: string }>("SELECT slug FROM scopes WHERE id = $1", [run.scope_id])).rows[0]!.slug;
  let articleId: string;
  let published = false;
  let revisionId: string | undefined;
  const existing = mapped ? await findItem(ctx.db, mapped.article_id).catch(() => null) : null;
  if (existing && existing.status !== "deleted" && existing.status !== "rejected") {
    const current = (await ctx.db.query<{ body_md: string; title: string }>("SELECT body_md, title FROM articles WHERE id = $1", [existing.id])).rows[0]!;
    articleId = existing.id;
    if (current.body_md.trim() !== body || current.title !== title) {
      const res = await editArticle(ctx, { id: existing.id, version: existing.version, summary, text: body, title: title !== current.title ? title : undefined });
      published = !!res.published;
      revisionId = res.revision_id;
    } else published = true;
  } else {
    const res = await newArticle(ctx, {
      project,
      type: page.type as CreateArticleInput["type"],
      title,
      path: page.folder,
      body_md: body,
      components: component ? [component] : [],
    });
    articleId = res.article_id;
    published = !!res.published;
    revisionId = res.revision_id;
  }

  const sources = [...new Set([...page.sources, ...claims.flatMap((c) => c.evidence.map((e) => e.path))])].slice(0, 500);
  await withTx(ctx.db, async (db) => {
    await db.query("UPDATE claims SET status = 'retired' WHERE article_id = $1 AND status <> 'retired'", [articleId]);
    for (const c of claims) {
      await db.query("INSERT INTO claims (article_id, section, text, evidence) VALUES ($1, $2, $3, $4)", [articleId, c.section, c.text, JSON.stringify(c.evidence)]);
    }
    await db.query(
      `INSERT INTO doc_pages (scope_id, component, key, article_id, sources, last_sha, generated_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (scope_id, component, key) DO UPDATE SET article_id = EXCLUDED.article_id, sources = EXCLUDED.sources, last_sha = EXCLUDED.last_sha,
         generated_by = EXCLUDED.generated_by, updated_at = now()`,
      [run.scope_id, component, page.key, articleId, sources, run.head_sha, ctx.actor.id],
    );
    await db.query("UPDATE doc_run_pages SET status = 'submitted', article_id = $3, revision_id = $4 WHERE run_id = $1 AND key = $2", [run.id, page.key, articleId, revisionId ?? null]);
  });
  const left = (await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM doc_run_pages WHERE run_id = $1 AND status IN ('pending', 'claimed')", [run.id])).rows[0]!.n;
  return { article_id: articleId, published, revision_id: revisionId ?? null, claims: claims.length, pages_left: left, next: left ? "docs_next_page" : "docs_finish" };
}

export async function docsSkipPage(ctx: RequestContext, input: { run_id: string; key: string; reason: string }) {
  const run = await loadRun(ctx, input.run_id);
  const { rowCount } = await ctx.db.query(
    "UPDATE doc_run_pages SET status = 'skipped', note = $3 WHERE run_id = $1 AND key = $2 AND status IN ('pending', 'claimed')",
    [run.id, input.key, input.reason.slice(0, 500)],
  );
  if (!rowCount) throw new NotFoundError(`open page "${input.key}" in this run`);
  return { skipped: input.key };
}

export async function docsFinish(ctx: RequestContext, input: { run_id: string; summary?: string }) {
  const run = await loadRun(ctx, input.run_id);
  if (run.status !== "writing" && run.status !== "planning") throw new ValidationError(`this run is already ${run.status}`);
  const counts = (
    await ctx.db.query<{ submitted: number; skipped: number; open: number }>(
      `SELECT count(*) FILTER (WHERE status = 'submitted')::int AS submitted, count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
              count(*) FILTER (WHERE status IN ('pending', 'claimed'))::int AS open FROM doc_run_pages WHERE run_id = $1`,
      [run.id],
    )
  ).rows[0]!;
  if (counts.open) throw new ValidationError(`${counts.open} page(s) are still open: write them (docs_next_page) or docs_skip_page with a reason`);
  const summary = input.summary?.trim() || `${counts.submitted} page(s) written${counts.skipped ? `, ${counts.skipped} skipped` : ""}`;
  await ctx.db.query("UPDATE doc_runs SET status = 'done', finished_at = now(), summary = $2 WHERE id = $1", [run.id, summary.slice(0, 1000)]);
  if (run.component_id) await ctx.db.query("UPDATE components SET docs_sha = $2, docs_updated_at = now() WHERE id = $1", [run.component_id, run.head_sha]);
  await audit(ctx.db, ctx.actor.id, "docs_finish", run.id);
  const project = (await ctx.db.query<{ slug: string }>("SELECT slug FROM scopes WHERE id = $1", [run.scope_id])).rows[0]!.slug;
  return {
    run_id: run.id,
    status: "done",
    summary,
    agents_md: await agentsMdBlock(ctx, project, run.component ?? undefined),
    next: "Put agents_md into the repository's AGENTS.md (and CLAUDE.md if it exists), replacing any existing block between the THALIYOLA markers.",
  };
}

/** The managed block for a repository's AGENTS.md / CLAUDE.md: where its knowledge lives and how to use it. */
export async function agentsMdBlock(ctx: RequestContext, project: string, component?: string) {
  const scope = await getReadableScope(ctx, project);
  const pages = await existingPages(ctx, scope.id, component ?? "");
  const lines = [
    "<!-- THALIYOLA:START (managed by Thaliyola; edits inside this block are replaced) -->",
    "## Team knowledge (Thaliyola)",
    "",
    `This repository is part of **${scope.name}** (\`${scope.slug}\`)${component ? `, repository \`${component}\`` : ""} in Thaliyola, the team knowledge base (MCP server \`thaliyola\`).`,
    "",
    `- Before changing code, call \`get_project_context\` (project \`${scope.slug}\`${component ? `, component \`${component}\`` : ""}) and read open impact notices first.`,
    "- Before investigating a bug or alert, `search_knowledge` with the symptom as it first appeared.",
    "- After confirming a root cause or making a decision, capture it (`propose_finding`, `create_article`); people review it.",
    "- When code changes, keep the docs current: run the `update-docs` prompt (or `docs_begin` with mode `update` and the changed files).",
    ...(pages.length ? ["", "Documentation pages for this repository:", ...pages.slice(0, 25).map((p: { title: string; folder: string }) => `- ${p.title}${p.folder ? ` (${p.folder})` : ""}`)] : []),
    "<!-- THALIYOLA:END -->",
  ];
  return lines.join("\n");
}

export async function docsStatus(ctx: RequestContext, project: string) {
  const scope = await getReadableScope(ctx, project);
  const repos = await ctx.db.query(
    `SELECT c.slug, c.kind, c.repo_url, c.docs_sha, c.docs_updated_at,
            (SELECT count(*) FROM doc_pages d WHERE d.scope_id = c.scope_id AND d.component = c.slug)::int AS pages,
            (SELECT count(*) FROM claims cl JOIN doc_pages d ON d.article_id = cl.article_id WHERE d.scope_id = c.scope_id AND d.component = c.slug AND cl.status = 'ok')::int AS claims,
            (SELECT count(*) FROM claims cl JOIN doc_pages d ON d.article_id = cl.article_id WHERE d.scope_id = c.scope_id AND d.component = c.slug AND cl.status = 'stale')::int AS stale_claims
       FROM components c WHERE c.scope_id = $1 ORDER BY c.slug`,
    [scope.id],
  );
  const runs = await ctx.db.query(
    `SELECT r.id, c.slug AS repository, r.mode, r.status, r.head_sha, r.started_at, r.finished_at, r.summary, coalesce(u.display_name, u.email, u.subject) AS by,
            (SELECT count(*) FROM doc_run_pages p WHERE p.run_id = r.id)::int AS pages,
            (SELECT count(*) FROM doc_run_pages p WHERE p.run_id = r.id AND p.status = 'submitted')::int AS written
       FROM doc_runs r LEFT JOIN components c ON c.id = r.component_id JOIN users u ON u.id = r.started_by
      WHERE r.scope_id = $1 ORDER BY r.started_at DESC LIMIT 20`,
    [scope.id],
  );
  const settings = await settingsFor(ctx, scope.id);
  return { project: scope.slug, repositories: repos.rows, runs: runs.rows, instructions: settings.doc_instructions, ignore: settings.doc_ignore };
}

// ---- Claims on a page ------------------------------------------------------------------

/** Claims on an article with links to the evidence in the repository host (GitHub, GitLab, Bitbucket). */
export async function claimsFor(ctx: RequestContext, articleId: string) {
  const item = await findItem(ctx.db, articleId);
  await getReadableScopeById(ctx, item.scope_id);
  const repo = (
    await ctx.db.query<{ repo_url: string | null }>(
      "SELECT c.repo_url FROM doc_pages d JOIN components c ON c.scope_id = d.scope_id AND c.slug = d.component WHERE d.article_id = $1 LIMIT 1",
      [articleId],
    )
  ).rows[0]?.repo_url;
  const { rows } = await ctx.db.query<{ id: string; section: string; text: string; evidence: Evidence[]; status: string; stale_reason: string | null; verified_at: string }>(
    "SELECT id, section, text, evidence, status, stale_reason, verified_at FROM claims WHERE article_id = $1 AND status <> 'retired' ORDER BY section, created_at",
    [articleId],
  );
  return {
    article_id: articleId,
    claims: rows.map((c) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, url: evidenceUrl(repo, e) })) })),
    stale: rows.filter((c) => c.status === "stale").length,
  };
}

async function getReadableScopeById(ctx: RequestContext, scopeId: string) {
  const slug = (await ctx.db.query<{ slug: string }>("SELECT slug FROM scopes WHERE id = $1", [scopeId])).rows[0]?.slug;
  if (!slug) throw new NotFoundError("scope");
  return getReadableScope(ctx, slug);
}

/** A browsable link to the cited lines at the cited commit. */
export function evidenceUrl(repoUrl: string | null | undefined, e: Evidence): string | null {
  if (!repoUrl) return null;
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/*$/i.exec(repoUrl.trim());
  if (!m) return null;
  const [host, repoPath] = [m[1]!.toLowerCase(), m[2]!];
  const ref = e.sha ?? "HEAD";
  const lines = e.start ? (e.end && e.end !== e.start ? [e.start, e.end] : [e.start]) : [];
  if (host.includes("bitbucket")) return `https://${host}/${repoPath}/src/${ref}/${e.path}${lines.length ? `#lines-${lines.join(":")}` : ""}`;
  const blob = host.includes("gitlab") || !host.includes("github") ? "-/blob" : "blob";
  return `https://${host}/${repoPath}/${blob}/${ref}/${e.path}${lines.length ? `#L${lines.join("-L")}` : ""}`;
}

/** Confirms claims that still hold (optionally with new evidence) and retires those that don't. */
export async function resolveClaims(
  ctx: RequestContext,
  input: { article_id: string; confirm?: { id: string; evidence?: (Evidence | string)[]; sha?: string }[]; retire?: { id: string; reason?: string }[] },
) {
  const item = await findItem(ctx.db, input.article_id);
  await assertCanPropose(ctx, item.scope_id);
  const ignored = ignoreMatcher((await settingsFor(ctx, item.scope_id)).doc_ignore);
  let confirmed = 0;
  let retired = 0;
  for (const c of input.confirm ?? []) {
    const evidence = c.evidence?.length ? JSON.stringify(c.evidence.map((e) => cleanEvidence(e, c.sha ?? "HEAD", ignored))) : null;
    const { rowCount } = await ctx.db.query(
      "UPDATE claims SET status = 'ok', stale_reason = NULL, verified_at = now(), evidence = coalesce($3::jsonb, evidence) WHERE id = $1 AND article_id = $2 AND status <> 'retired'",
      [c.id, input.article_id, evidence],
    );
    confirmed += rowCount ?? 0;
  }
  for (const r of input.retire ?? []) {
    const { rowCount } = await ctx.db.query("UPDATE claims SET status = 'retired', stale_reason = $3 WHERE id = $1 AND article_id = $2", [r.id, input.article_id, r.reason ?? null]);
    retired += rowCount ?? 0;
  }
  await audit(ctx.db, ctx.actor.id, "resolve_claims", input.article_id);
  return { article_id: input.article_id, confirmed, retired };
}

export async function updateDocSettings(ctx: RequestContext, project: string, patch: { instructions?: string; ignore?: string }) {
  const scope = await getReadableScope(ctx, project);
  const { assertCanManage } = await import("./permissions.js");
  await assertCanManage(ctx, scope);
  if (patch.ignore !== undefined) ignoreMatcher(patch.ignore); // validates
  const { rows } = await ctx.db.query(
    "UPDATE scopes SET doc_instructions = coalesce($2, doc_instructions), doc_ignore = coalesce($3, doc_ignore) WHERE id = $1 RETURNING doc_instructions AS instructions, doc_ignore AS ignore",
    [scope.id, patch.instructions?.slice(0, 20000) ?? null, patch.ignore?.slice(0, 20000) ?? null],
  );
  return rows[0];
}

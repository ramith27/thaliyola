import { randomBytes } from "node:crypto";
import type { Settings } from "../config.js";
import type { Db, Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { repoKey } from "./bootstrap.js";
import { manageable } from "./connections/manage.js";
import { prChanges, setCommitStatus, upsertPrComment } from "./connections/git.js";
import { applyDocsCheck, checkDocs, docsStatus, needsLook, type DocsCheck } from "./doc-check.js";
import { driverEnv, openSecrets, targetOf, type ConnectionRow } from "./connections/sync.js";
import { rateLimiter, verifyGitWebhook } from "./connections/webhooks.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { emitChanged } from "./events.js";
import { assertCanApprove, assertCanManage } from "./permissions.js";
import { redact } from "./redaction.js";
import { parseRepoUrl } from "./repo-detect.js";
import { answerPrQuestion, questionOf } from "./pr-questions.js";
import type { Embedder } from "./embeddings.js";
import { getReadableScope } from "./scopes.js";
import { canSeal, openJson, sealJson, SecretsUnavailableError } from "./secrets.js";

/**
 * PR briefings: what Thaliyola already knows about the files a pull (merge) request changes, as one comment on it,
 * kept up to date as commits arrive. Only file paths are matched (docs' cited lines, contracts, known issues,
 * vulnerabilities, design drift, other sessions' claims); nothing reads the code and no model is involved.
 * The comment lists titles and links only: anyone who can see the pull request reads it.
 */

const MARKER = "<!-- thaliyola-briefing -->";
const STYLE_FILE = /\.(css|scss|sass|less|pcss)$|(^|\/)(tailwind\.config\.[cm]?[jt]s|theme\.[jt]sx?|tokens?\.(json|css|ts))$/i;

export interface Briefing {
  docs: { article_id: string; title: string; claims: number; paths: string[] }[];
  contracts: { article_id: string; title: string; consumers: { project: string; repository: string | null }[]; hidden_consumers: number }[];
  known_issues: { finding_id: string; title: string; type: string; matched: string | null }[];
  vulnerabilities: { id: string; title: string; severity: string; location: string | null }[];
  lockfiles: string[];
  design: { checked_at: string; differences: number; hardcoded_here: { file: string; value: string; suggestion: string }[] } | null;
  working_here: { session: string; owner: string; paths: string[] }[];
}

export const briefingSize = (b: Briefing) =>
  b.docs.length + b.contracts.length + b.known_issues.length + b.vulnerabilities.length + b.lockfiles.length + (b.design && (b.design.hardcoded_here.length || b.design.differences) ? 1 : 0) + b.working_here.length;

const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|requirements[^/]*\.txt|go\.(mod|sum)|Cargo\.lock|Gemfile\.lock|composer\.lock|packages\.lock\.json|gradle\.lockfile)$/;

/** What's known about these paths in one repository of a project. Read as the project sees itself. */
export async function buildBriefing(db: Queryable, scopeId: string, component: { id: string; slug: string; repo_url: string | null }, paths: string[]): Promise<Briefing> {
  const files = [...new Set(paths.map((p) => p.replace(/^\/+/, "")).filter(Boolean))].slice(0, 500);
  const bases = [...new Set(files.map((f) => f.split("/").pop()!).filter((b) => b.length >= 5))].slice(0, 100);

  // 1. Docs: pages with facts citing the changed lines' files, or whose sources cover them.
  const docs = (
    await db.query<{ article_id: string; title: string; claims: number; paths: string[] }>(
      `WITH hit AS (
         SELECT c.article_id, count(*)::int AS claims, array_agg(DISTINCT e->>'path') AS paths
           FROM claims c CROSS JOIN LATERAL jsonb_array_elements(c.evidence) e
          WHERE c.status <> 'retired' AND e->>'path' = ANY($3::text[])
            AND c.article_id IN (SELECT article_id FROM doc_pages WHERE scope_id = $1 AND component = $2)
          GROUP BY c.article_id
         UNION ALL
         SELECT p.article_id, 0, array_agg(DISTINCT s)
           FROM doc_pages p CROSS JOIN LATERAL unnest(p.sources) s
          WHERE p.scope_id = $1 AND p.component = $2 AND p.article_id IS NOT NULL
            AND EXISTS (SELECT 1 FROM unnest($3::text[]) f WHERE f = s OR starts_with(f, rtrim(s, '/') || '/'))
          GROUP BY p.article_id)
       SELECT h.article_id, a.title, max(h.claims)::int AS claims, (array_agg(DISTINCT x))[1:5] AS paths
         FROM hit h CROSS JOIN LATERAL unnest(h.paths) x JOIN articles a ON a.id = h.article_id
        WHERE a.status IN ('published', 'possibly_stale')
        GROUP BY h.article_id, a.title ORDER BY max(h.claims) DESC, a.title LIMIT 10`,
      [scopeId, component.slug, files],
    )
  ).rows;

  // 2. Contracts this repository provides, and who consumes them (projects others can't see are only counted).
  const contracts = (
    await db.query<{ article_id: string; title: string; consumers: { project: string; repository: string | null; visible: boolean }[] }>(
      `SELECT a.id AS article_id, a.title,
              coalesce((SELECT jsonb_agg(jsonb_build_object('project', s.slug, 'repository', c.slug, 'visible', s.visibility = 'team' OR s.id = $1))
                          FROM relations r JOIN components c ON c.id = r.to_id JOIN scopes s ON s.id = c.scope_id
                         WHERE r.from_kind = 'article' AND r.from_id = a.id AND r.kind = 'consumed_by' AND r.to_kind = 'component' AND s.status = 'active'), '[]') AS consumers
         FROM relations p JOIN articles a ON a.id = p.from_id
        WHERE p.kind = 'provided_by' AND p.to_kind = 'component' AND p.to_id = $2 AND p.from_kind = 'article' AND a.status IN ('published', 'possibly_stale')
        ORDER BY a.title LIMIT 10`,
      [scopeId, component.id],
    )
  ).rows.map((r) => ({
    article_id: r.article_id,
    title: r.title,
    consumers: r.consumers.filter((c) => c.visible).map(({ project, repository }) => ({ project, repository })),
    hidden_consumers: r.consumers.filter((c) => !c.visible).length,
  }));

  // 3. Known issues in this repository, the ones naming a changed file first.
  const known = (
    await db.query<{ finding_id: string; title: string; type: string; matched: string | null }>(
      `SELECT finding_id, title, type, matched FROM (
         SELECT f.id AS finding_id, f.title, f.type, f.updated_at,
                (SELECT b FROM unnest($3::text[]) b WHERE (f.title || ' ' || f.symptoms || ' ' || f.root_cause || ' ' || coalesce(f.fix, '')) ILIKE '%' || b || '%' LIMIT 1) AS matched
           FROM findings f
          WHERE f.scope_id = $1 AND $2 = ANY(f.component_ids) AND f.type IN ('known_issue', 'rca', 'incident') AND f.status IN ('published', 'possibly_stale')) k
        ORDER BY matched IS NULL, updated_at DESC LIMIT 8`,
      [scopeId, component.id, bases],
    )
  ).rows.filter((r, i) => r.matched || i < 3);

  // 4. Open vulnerabilities located in the changed files, and lockfiles the change touches.
  const vulnerabilities = (
    await db.query<{ id: string; title: string; severity: string; location: string | null }>(
      `SELECT v.id, v.title, v.severity, v.location FROM vulnerabilities v
        WHERE v.scope_id = $1 AND v.component = $2 AND v.status IN ('open', 'acknowledged') AND v.location IS NOT NULL
          AND EXISTS (SELECT 1 FROM unnest($3::text[]) f WHERE split_part(v.location, '#', 1) = f)
        ORDER BY array_position(ARRAY['critical','high','medium','low','unknown'], v.severity) LIMIT 10`,
      [scopeId, component.slug, files],
    )
  ).rows;
  const lockfiles = files.filter((f) => LOCKFILE.test(f));

  // 5. Design: style or theme files changed, and the last drift check (hard-coded colours in these files).
  let design: Briefing["design"] = null;
  if (files.some((f) => STYLE_FILE.test(f) || /\.(tsx|jsx|vue|svelte)$/.test(f))) {
    const d = (
      await db.query<{ checked_at: Date; differences: number; hardcoded: { file: string; value: string; suggestion: string }[] }>(
        "SELECT checked_at, differences, coalesce(report->'hardcoded', '[]') AS hardcoded FROM design_drift_reports WHERE scope_id = $1 ORDER BY checked_at DESC LIMIT 1",
        [scopeId],
      )
    ).rows[0];
    if (d) {
      const here = d.hardcoded.filter((h) => files.includes(h.file)).slice(0, 10);
      if (here.length || files.some((f) => STYLE_FILE.test(f)))
        design = { checked_at: new Date(d.checked_at).toISOString(), differences: d.differences, hardcoded_here: here.map(({ file, value, suggestion }) => ({ file, value, suggestion })) };
    }
  }

  // 6. Other sessions working on these files right now (project-visible sessions only).
  const key = repoKey(component.repo_url);
  const working_here = key
    ? (
        await db.query<{ session: string; owner: string; paths: string[] }>(
          `SELECT s.handle AS session, coalesce(u.display_name, u.email, u.subject) AS owner, (array_agg(DISTINCT c.path))[1:5] AS paths
             FROM work_claims c JOIN agent_sessions s ON s.id = c.session_id JOIN users u ON u.id = s.user_id
            WHERE c.repo_key = $1 AND c.released_at IS NULL AND c.expires_at > now() AND s.ended_at IS NULL AND s.visibility = 'project'
              AND EXISTS (SELECT 1 FROM unnest($2::text[]) f WHERE f = c.path OR starts_with(f, c.path || '/'))
            GROUP BY s.handle, owner ORDER BY s.handle LIMIT 5`,
          [key, files],
        )
      ).rows
    : [];

  return { docs, contracts, known_issues: known, vulnerabilities, lockfiles, design, working_here };
}

/** The comment: titles and links into Thaliyola, never article or finding text. */
export function renderBriefing(b: Briefing, base: string, project: string, docs: DocsCheck | null = null): string {
  const link = (path: string) => (base ? `${base}/#${path}` : `#${path}`);
  const out: string[] = [MARKER, "### What Thaliyola knows about these changes", ""];
  if (docs && needsLook(docs)) {
    out.push("**Docs check: facts that cite lines this changes** (update the doc, or acknowledge it on the project's Pull requests page)");
    const WHAT = { changed: "lines changed", removed: "file deleted", unknown: "diff too large to check", moved: "moved" } as const;
    for (const f of docs.facts.filter((x) => x.outcome !== "moved").slice(0, 15))
      out.push(`- [${f.article}](${link(`/article/${f.article_id}`)}): \`${f.path}:${f.start}${f.end !== f.start ? `-${f.end}` : ""}\` (${WHAT[f.outcome]})`);
    if (docs.moved) out.push(`- ${docs.moved} more fact${docs.moved === 1 ? "" : "s"} cite lines that only move; ${docs.moved === 1 ? "it follows" : "they follow"} the code when this merges.`);
    out.push("");
  }
  if (b.docs.length) {
    out.push("**Docs that describe this code** (they may need updating; `update-docs` refreshes them)");
    for (const d of b.docs) out.push(`- [${d.title}](${link(`/article/${d.article_id}`)})${d.claims ? `: ${d.claims} fact${d.claims === 1 ? "" : "s"} cite` : ": covers"} ${d.paths.map((p) => `\`${p}\``).join(", ")}`);
    out.push("");
  }
  if (b.contracts.length) {
    out.push("**Contracts this repository provides** (check consumers before changing them)");
    for (const c of b.contracts) {
      const who = c.consumers.map((x) => `${x.project}${x.repository ? `/${x.repository}` : ""}`);
      if (c.hidden_consumers) who.push(`${c.hidden_consumers} more`);
      out.push(`- [${c.title}](${link(`/article/${c.article_id}`)})${who.length ? `, used by ${who.join(", ")}` : ""}`);
    }
    out.push("");
  }
  if (b.known_issues.length) {
    out.push("**Known issues here**");
    for (const k of b.known_issues) out.push(`- [${k.title}](${link(`/finding/${k.finding_id}`)})${k.matched ? ` (mentions \`${k.matched}\`)` : ""}`);
    out.push("");
  }
  if (b.vulnerabilities.length || b.lockfiles.length) {
    out.push("**Security**");
    for (const v of b.vulnerabilities) out.push(`- ${v.severity}: [${v.title}](${link(`/security/${v.id}`)}) in \`${v.location}\``);
    if (b.lockfiles.length) out.push(`- Dependencies change (${b.lockfiles.map((l) => `\`${l}\``).join(", ")}): the next scan re-checks them.`);
    out.push("");
  }
  if (b.design && (b.design.hardcoded_here.length || b.design.differences)) {
    out.push("**Design**");
    if (b.design.hardcoded_here.length) for (const h of b.design.hardcoded_here) out.push(`- \`${h.file}\` hard-codes \`${h.value}\`: ${h.suggestion}`);
    else out.push(`- Style files change; the last design check (${b.design.checked_at.slice(0, 10)}) found ${b.design.differences} difference(s) from the design system.`);
    out.push(`- [Design system](${link(`/scope/${project}/design`)})`);
    out.push("");
  }
  if (b.working_here.length) {
    out.push("**Also being worked on**");
    for (const w of b.working_here) out.push(`- \`${w.session}\` (${w.owner}): ${w.paths.map((p) => `\`${p}\``).join(", ")}`);
    out.push("");
  }
  if (briefingSize(b) === 0 && !(docs && needsLook(docs))) out.push("Nothing recorded about these files yet.", "");
  out.push(`<sub>From [Thaliyola](${link(`/project/${project}`)}). Updated on every push.</sub>`);
  return redact(out.join("\n")).text;
}

// ---- Webhook -------------------------------------------------------------------------------------------------

const hookAad = (id: string) => `connection_webhook:${id}`;
export const gitWebhookPath = (id: string) => `/hooks/git/${id}`;
const limiter = rateLimiter(() => 60);

/** A git connection's webhook secret, made (or replaced) and shown once. Project admins. */
export async function setGitWebhook(ctx: RequestContext, connectionId: string) {
  const row = await manageable(ctx, connectionId);
  if (row.kind !== "git") throw new ValidationError("only a git connection has a pull-request webhook");
  if (!canSeal(ctx.settings.connections?.keys)) throw new ValidationError("storing a webhook secret needs CONNECTIONS_KEY on the server (an Administrator sets it)");
  const secret = randomBytes(24).toString("base64url");
  await ctx.db.query("UPDATE connections SET webhook_secret = $2, webhook_secret_hint = $3 WHERE id = $1", [row.id, sealJson({ secret }, ctx.settings.connections?.keys, hookAad(row.id)), secret.slice(-4)]);
  await audit(ctx.db, ctx.actor.id, "set_git_webhook", row.id, { targetKind: "connection", targetLabel: row.name });
  const base = ctx.settings.publicUrl?.replace(/\/+$/, "") ?? "";
  return {
    secret,
    url: `${base}${gitWebhookPath(row.id)}`,
    how:
      row.config.provider === "gitlab"
        ? "GitLab: project → Settings → Webhooks → Add new webhook. URL: this URL; Secret token: the secret; Triggers: Merge request events (and Comments, for questions asked with @thaliyola)."
        : "GitHub: repository (or organisation) → Settings → Webhooks → Add webhook. Payload URL: this URL; Content type: application/json; Secret: the secret; events: Pull requests (and Issue comments and Pull request review comments, for questions asked with @thaliyola).",
  };
}

/** Turn PR briefings on for a project: off, relevant (only when there's something to say) or always. Project admins. */
export async function setBriefingMode(ctx: RequestContext, project: string, mode: "off" | "relevant" | "always") {
  const scope = await getReadableScope(ctx, project);
  await assertCanManage(ctx, scope);
  await ctx.db.query("UPDATE scopes SET pr_briefings = $2 WHERE id = $1", [scope.id, mode]);
  await audit(ctx.db, ctx.actor.id, "set_pr_briefings", scope.id, { targetKind: "project", targetLabel: scope.slug, details: { mode } });
  return { project: scope.slug, pr_briefings: mode };
}

interface PullRequest {
  provider: "github" | "gitlab";
  repository: string;
  repo_url: string;
  number: number;
  title: string;
  url: string | null;
  author: string | null;
  head_sha: string | null;
  draft: boolean;
  /** Closed by merging: the docs check applies what it found. */
  merged: boolean;
}

const GITHUB_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const GITLAB_ACTIONS = new Set(["open", "update", "reopen"]);

function pullRequestOf(event: string, p: Record<string, any>): PullRequest | null {
  if (event === "pull_request") {
    const merged = p.action === "closed" && !!p.pull_request?.merged;
    if ((!GITHUB_ACTIONS.has(p.action) && !merged) || !p.pull_request || !p.repository?.full_name) return null;
    const pr = p.pull_request;
    return {
      provider: "github",
      repository: String(p.repository.full_name),
      repo_url: String(p.repository.html_url ?? `https://github.com/${p.repository.full_name}`),
      number: Number(pr.number),
      title: String(pr.title ?? "").slice(0, 300),
      url: pr.html_url ? String(pr.html_url) : null,
      author: pr.user?.login ? String(pr.user.login) : null,
      head_sha: pr.head?.sha ? String(pr.head.sha) : null,
      draft: !!pr.draft,
      merged,
    };
  }
  if (event === "merge request hook") {
    const a = p.object_attributes;
    const merged = a?.action === "merge";
    if (!a || (!GITLAB_ACTIONS.has(a.action) && !merged) || !p.project?.path_with_namespace) return null;
    return {
      provider: "gitlab",
      repository: String(p.project.path_with_namespace),
      repo_url: String(p.project.web_url ?? ""),
      number: Number(a.iid),
      title: String(a.title ?? "").slice(0, 300),
      url: a.url ? String(a.url) : null,
      author: p.user?.username ? String(p.user.username) : null,
      head_sha: a.last_commit?.id ? String(a.last_commit.id) : null,
      draft: !!(a.draft ?? a.work_in_progress),
      merged,
    };
  }
  return null;
}

export interface WebhookAnswer {
  status: number;
  body: Record<string, unknown>;
  /** The briefing being built and posted, after the answer (tests await it). */
  work?: Promise<unknown>;
}

/** A pull-request webhook for a git connection. Answers fast; the briefing is built and posted afterwards. */
export async function receiveGitWebhook(
  db: Db,
  settings: Settings,
  id: string,
  headers: Record<string, string | undefined>,
  raw: Buffer,
  log: (m: string) => void = console.error,
  embedder?: Embedder,
): Promise<WebhookAnswer> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 404, body: { error: "not found" } };
  if (limiter.over(id)) return { status: 429, body: { error: "too many webhook calls for this connection; try again in a minute" } };
  const row = (await db.query<ConnectionRow & { webhook_secret: string | null; scope_slug: string; pr_briefings: string; pr_questions: string; pr_docs_check: string }>(
    "SELECT c.*, s.slug AS scope_slug, s.pr_briefings, s.pr_questions, s.pr_docs_check FROM connections c JOIN scopes s ON s.id = c.scope_id WHERE c.id = $1 AND s.status = 'active'",
    [id],
  )).rows[0];
  if (!row || row.kind !== "git" || !row.webhook_secret) return { status: 404, body: { error: "not found" } };
  let secret: string;
  try {
    secret = openJson(row.webhook_secret, settings.connections?.keys, hookAad(row.id)).value.secret ?? "";
  } catch (err) {
    if (err instanceof SecretsUnavailableError) return { status: 503, body: { error: "the webhook secret can't be opened on this server (CONNECTIONS_KEY)" } };
    throw err;
  }
  if (!verifyGitWebhook(secret, headers, raw)) return { status: 401, body: { error: "wrong or missing webhook secret" } };
  const event = (headers["x-github-event"] ?? headers["x-gitlab-event"] ?? "").toLowerCase();
  if (event === "ping") return { status: 200, body: { ok: true, message: "pong" } };
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return { status: 400, body: { error: "the body isn't JSON (GitHub: choose content type application/json)" } };
  }
  // A comment asking @thaliyola something.
  const question = questionOf(event, payload);
  if (question) {
    if (row.pr_questions !== "on") return { status: 202, body: { ignored: `questions in pull requests are off for ${row.scope_slug} (project → Pull requests)` } };
    if (!row.enabled) return { status: 202, body: { ignored: "the connection is switched off" } };
    const qKey = repoKey(question.repo_url);
    const qComponent = (
      await db.query<{ slug: string }>("SELECT slug FROM components WHERE scope_id = $1 AND repo_key = $2 AND ($3::uuid IS NULL OR id = $3) LIMIT 1", [row.scope_id, qKey, row.component_id])
    ).rows[0];
    if (!qComponent || !qKey) return { status: 202, body: { ignored: `${question.repository} isn't one of ${row.scope_slug}'s repositories` } };
    const work = answerPrQuestion(db, settings, embedder, row, qComponent, qKey, question).catch((err: Error) => log(`[pr-questions] ${question.repository}#${question.number}: ${err.message}`));
    return { status: 202, body: { queued: true }, work };
  }
  const pr = pullRequestOf(event, payload);
  if (!pr) return { status: 202, body: { ignored: "only opened or updated pull (merge) requests are briefed, and comments that ask @thaliyola" } };
  if (row.pr_briefings === "off" && row.pr_docs_check === "off") return { status: 202, body: { ignored: `PR briefings are off for ${row.scope_slug} (project → Pull requests)` } };
  if (pr.merged && row.pr_docs_check === "off") return { status: 202, body: { ignored: "merged; the docs check is off, so there's nothing to apply" } };
  if (!row.enabled) return { status: 202, body: { ignored: "the connection is switched off" } };
  const key = repoKey(pr.repo_url);
  const component = (
    await db.query<{ id: string; slug: string; repo_url: string | null }>(
      "SELECT id, slug, repo_url FROM components WHERE scope_id = $1 AND repo_key = $2 AND ($3::uuid IS NULL OR id = $3) LIMIT 1",
      [row.scope_id, key, row.component_id],
    )
  ).rows[0];
  if (!component || !key) return { status: 202, body: { ignored: `${pr.repository} isn't one of ${row.scope_slug}'s repositories` } };
  const modes = { briefings: row.pr_briefings as "off" | "relevant" | "always", docs: row.pr_docs_check as "off" | "warn" | "block" };
  const work = (pr.merged ? applyMerged(db, settings, row, component, key, pr) : briefPullRequest(db, settings, row, row.scope_slug, modes, component, key, pr)).catch((err: Error) => log(`[briefings] ${pr.repository}#${pr.number}: ${err.message}`));
  return { status: 202, body: { queued: true }, work };
}

/**
 * Reads the changes, builds the briefing and the docs check, keeps them, posts (or updates) the comment when briefings
 * are on, and sets the thaliyola/docs commit status when the docs check is.
 */
async function briefPullRequest(
  db: Db,
  settings: Settings,
  conn: ConnectionRow,
  project: string,
  modes: { briefings: "off" | "relevant" | "always"; docs: "off" | "warn" | "block" },
  component: { id: string; slug: string; repo_url: string | null },
  key: string,
  pr: PullRequest,
) {
  const target = targetOf(conn, await openSecrets(db, settings, conn));
  const env = driverEnv(settings);
  const repo = parseRepoUrl(component.repo_url ?? pr.repo_url)?.path ?? pr.repository;
  const base = settings.publicUrl?.replace(/\/+$/, "") ?? "";
  const record = async (fields: { files?: string[]; briefing?: Briefing; items?: number; comment_id?: string | null; status: string; error?: string | null; docs?: DocsCheck | null; docs_state?: string | null }) => {
    await db.query(
      `INSERT INTO pr_briefings (scope_id, component, repo_key, provider, number, title, url, author, head_sha, files, briefing, items, comment_id, status, error, docs_check, docs_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::text[], '{}'), coalesce($11::jsonb, '{}'), coalesce($12::int, 0), $13::text, $14, $15, $16::jsonb, $17::text)
       ON CONFLICT (repo_key, number) DO UPDATE SET scope_id = EXCLUDED.scope_id, component = EXCLUDED.component, title = EXCLUDED.title, url = EXCLUDED.url,
         author = EXCLUDED.author, head_sha = EXCLUDED.head_sha, files = coalesce($10::text[], pr_briefings.files), briefing = coalesce($11::jsonb, pr_briefings.briefing),
         items = coalesce($12::int, pr_briefings.items), comment_id = coalesce($13::text, pr_briefings.comment_id), status = EXCLUDED.status, error = EXCLUDED.error,
         docs_check = coalesce($16::jsonb, pr_briefings.docs_check), docs_state = coalesce($17::text, pr_briefings.docs_state),
         -- An acknowledgement covers the commit it was given for; a new push needs a new look.
         docs_ack_by = CASE WHEN pr_briefings.docs_ack_sha IS DISTINCT FROM EXCLUDED.head_sha THEN NULL ELSE pr_briefings.docs_ack_by END,
         updated_at = now()`,
      [conn.scope_id, component.slug, key, pr.provider, pr.number, pr.title, pr.url, pr.author, pr.head_sha, fields.files ?? null, fields.briefing ? JSON.stringify(fields.briefing) : null, fields.items ?? null, fields.comment_id ?? null, fields.status, fields.error ?? null, fields.docs ? JSON.stringify(fields.docs) : null, fields.docs_state ?? null],
    );
    emitChanged();
  };
  let changes;
  try {
    changes = await prChanges(target, env, repo, pr.number);
  } catch (err) {
    return record({ status: "failed", error: `couldn't list the changed files: ${(err as Error).message}`.slice(0, 500) });
  }
  const files = [...new Set(changes.map((c) => c.path).filter(Boolean))];
  const briefing = await buildBriefing(db, conn.scope_id, component, files);
  const items = briefingSize(briefing);
  const docs = modes.docs !== "off" ? await checkDocs(db, conn.scope_id, component.slug, changes) : null;
  // The status first: it's what a reviewer sees next to the merge button.
  let docsState: string | null = null;
  let statusError: string | null = null;
  if (docs && modes.docs !== "off" && pr.head_sha) {
    const s = docsStatus(docs, modes.docs, null);
    docsState = s.state;
    try {
      await setCommitStatus(target, env, repo, pr.head_sha, { ...s, context: "thaliyola/docs", target_url: base ? `${base}/#/scope/${project}/pulls` : undefined });
    } catch (err) {
      statusError = `couldn't set the docs check status: ${(err as Error).message}${/\b403\b|forbidden/i.test((err as Error).message) ? " (the token needs commit statuses: write)" : ""}`.slice(0, 500);
    }
  }
  const worth = items > 0 || (docs !== null && needsLook(docs) > 0);
  if (modes.briefings === "off" || (!worth && modes.briefings !== "always")) return record({ files, briefing, items, status: "skipped", error: statusError, docs, docs_state: docsState });
  const previous = (await db.query<{ comment_id: string | null }>("SELECT comment_id FROM pr_briefings WHERE repo_key = $1 AND number = $2", [key, pr.number])).rows[0]?.comment_id ?? null;
  try {
    const commentId = await upsertPrComment(target, env, repo, pr.number, renderBriefing(briefing, base, project, docs), previous);
    return record({ files, briefing, items, comment_id: commentId, status: "posted", error: statusError, docs, docs_state: docsState });
  } catch (err) {
    const msg = (err as Error).message;
    const hint = /\b403\b|forbidden|not accessible/i.test(msg) ? " (the token needs permission to write pull-request comments: GitHub Pull requests: write, GitLab api)" : "";
    return record({ files, briefing, items, status: "failed", error: `${msg}${hint}`.slice(0, 500), docs, docs_state: docsState });
  }
}

/** A pull request merged: facts whose lines only moved follow them; facts whose lines changed are marked stale. */
async function applyMerged(db: Db, settings: Settings, conn: ConnectionRow, component: { id: string; slug: string; repo_url: string | null }, key: string, pr: PullRequest) {
  const done = (await db.query<{ docs_applied_at: Date | null }>("SELECT docs_applied_at FROM pr_briefings WHERE repo_key = $1 AND number = $2", [key, pr.number])).rows[0];
  if (done?.docs_applied_at) return { skipped: "already applied" };
  const target = targetOf(conn, await openSecrets(db, settings, conn));
  const repo = parseRepoUrl(component.repo_url ?? pr.repo_url)?.path ?? pr.repository;
  const changes = await prChanges(target, driverEnv(settings), repo, pr.number);
  const docs = await checkDocs(db, conn.scope_id, component.slug, changes);
  const label = `${pr.provider === "gitlab" ? "!" : "#"}${pr.number}`;
  const applied = await applyDocsCheck(db, docs, `${component.slug}${label}`);
  await db.query(
    `INSERT INTO pr_briefings (scope_id, component, repo_key, provider, number, title, url, author, head_sha, status, docs_check, merged_at, docs_applied_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'skipped', $10, now(), now())
     ON CONFLICT (repo_key, number) DO UPDATE SET docs_check = EXCLUDED.docs_check, merged_at = now(), docs_applied_at = now(), updated_at = now()`,
    [conn.scope_id, component.slug, key, pr.provider, pr.number, pr.title, pr.url, pr.author, pr.head_sha, JSON.stringify(docs)],
  );
  if (applied.stale || applied.moved) await audit(db, null, "docs_check_applied", conn.scope_id, { targetKind: "project", details: { pull_request: label, ...applied } }).catch(() => undefined);
  emitChanged();
  return applied;
}

/** Turn the docs check on pull requests off, to warn, or to block until acknowledged. Project admins. */
export async function setDocsCheckMode(ctx: RequestContext, project: string, mode: "off" | "warn" | "block") {
  const scope = await getReadableScope(ctx, project);
  await assertCanManage(ctx, scope);
  await ctx.db.query("UPDATE scopes SET pr_docs_check = $2 WHERE id = $1", [scope.id, mode]);
  await audit(ctx.db, ctx.actor.id, "set_pr_docs_check", scope.id, { targetKind: "project", targetLabel: scope.slug, details: { mode } });
  return { project: scope.slug, pr_docs_check: mode };
}

/**
 * A reviewer looked at the facts a pull request affects (the docs are fine, or updated): the docs check passes for
 * its current commit. A new push needs a new look.
 */
export async function acknowledgeDocsCheck(ctx: RequestContext, project: string, id: string, settings: Settings = ctx.settings) {
  const scope = await getReadableScope(ctx, project);
  await assertCanApprove(ctx, scope.id);
  const row = (
    await ctx.db.query<{ id: string; repo_key: string; component: string; number: number; head_sha: string | null; docs_check: DocsCheck | null; provider: string }>(
      "SELECT id, repo_key, component, number, head_sha, docs_check, provider FROM pr_briefings WHERE id = $1 AND scope_id = $2",
      [id, scope.id],
    )
  ).rows[0];
  if (!row) throw new NotFoundError("that pull request");
  if (!row.docs_check || !row.head_sha) throw new ValidationError("this pull request has no docs check to acknowledge");
  const who = ctx.actor.email ?? "a reviewer";
  await ctx.db.query("UPDATE pr_briefings SET docs_ack_by = $2, docs_ack_sha = head_sha, docs_state = 'success', updated_at = now() WHERE id = $1", [row.id, ctx.actor.id]);
  const conn = (
    await ctx.db.query<ConnectionRow>(
      "SELECT c.* FROM connections c JOIN components k ON k.scope_id = c.scope_id AND k.slug = $2 WHERE c.scope_id = $1 AND c.kind = 'git' AND c.enabled AND (c.component_id IS NULL OR c.component_id = k.id) ORDER BY c.component_id NULLS LAST LIMIT 1",
      [scope.id, row.component],
    )
  ).rows[0];
  if (conn) {
    const comp = (await ctx.db.query<{ repo_url: string | null }>("SELECT repo_url FROM components WHERE scope_id = $1 AND slug = $2", [scope.id, row.component])).rows[0];
    const repo = parseRepoUrl(comp?.repo_url ?? "")?.path;
    const mode = (await ctx.db.query<{ pr_docs_check: "off" | "warn" | "block" }>("SELECT pr_docs_check FROM scopes WHERE id = $1", [scope.id])).rows[0]!.pr_docs_check;
    if (repo && mode !== "off") {
      const s = docsStatus(row.docs_check, mode, who);
      const base = settings.publicUrl?.replace(/\/+$/, "") ?? "";
      await setCommitStatus(targetOf(conn, await openSecrets(ctx.db, settings, conn)), driverEnv(settings), repo, row.head_sha, {
        ...s,
        context: "thaliyola/docs",
        target_url: base ? `${base}/#/scope/${scope.slug}/pulls` : undefined,
      });
    }
  }
  await audit(ctx.db, ctx.actor.id, "acknowledge_docs_check", scope.id, { targetKind: "project", targetLabel: scope.slug, details: { pull_request: row.number } });
  emitChanged();
  return { id: row.id, acknowledged_by: who, commit: row.head_sha };
}

// ---- Reading briefings --------------------------------------------------------------------------------------------

/** The briefing for local changes, before a pull request exists (agents). */
export async function briefChanges(ctx: RequestContext, input: { project: string; component?: string; paths: string[] }) {
  const scope = await getReadableScope(ctx, input.project);
  const component = (
    await ctx.db.query<{ id: string; slug: string; repo_url: string | null }>(
      "SELECT id, slug, repo_url FROM components WHERE scope_id = $1 AND ($2::text IS NULL OR slug = $2) ORDER BY slug LIMIT 1",
      [scope.id, input.component ?? null],
    )
  ).rows[0];
  if (!component) throw new NotFoundError(input.component ? `repository ${input.component} in ${scope.slug}` : `a repository in ${scope.slug}`);
  if (!input.paths.length) throw new ValidationError("paths: the files you changed (git diff --name-only)");
  const briefing = await buildBriefing(ctx.db, scope.id, component, input.paths);
  return { project: scope.slug, repository: component.slug, items: briefingSize(briefing), briefing, note: "Check each listed doc, contract and known issue against your change before opening the pull request." };
}

/** A project's recent briefings, or one (by number). */
export async function listBriefings(ctx: RequestContext, project: string, opts: { number?: number; limit?: number } = {}) {
  const scope = await getReadableScope(ctx, project);
  const { rows } = await ctx.db.query(
    `SELECT b.id, b.component AS repository, b.provider, b.number, b.title, b.url, b.author, b.head_sha, b.files, b.briefing, b.items, b.status, b.error, b.created_at, b.updated_at,
            b.docs_check, b.docs_state, b.merged_at, b.docs_applied_at, CASE WHEN b.docs_ack_sha = b.head_sha THEN coalesce(u.display_name, u.email) END AS docs_ack_by
       FROM pr_briefings b LEFT JOIN users u ON u.id = b.docs_ack_by WHERE b.scope_id = $1 AND ($2::int IS NULL OR b.number = $2) ORDER BY b.updated_at DESC LIMIT $3`,
    [scope.id, opts.number ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)],
  );
  const s = (await ctx.db.query<{ pr_briefings: string; pr_questions: string; pr_docs_check: string }>("SELECT pr_briefings, pr_questions, pr_docs_check FROM scopes WHERE id = $1", [scope.id])).rows[0];
  return { project: scope.slug, mode: s?.pr_briefings ?? "off", questions: s?.pr_questions ?? "off", docs_check: s?.pr_docs_check ?? "off", briefings: rows };
}

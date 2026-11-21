import { randomBytes } from "node:crypto";
import type { Settings } from "../config.js";
import type { Db, Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { repoKey } from "./bootstrap.js";
import { manageable } from "./connections/manage.js";
import { prFiles, upsertPrComment } from "./connections/git.js";
import { driverEnv, openSecrets, targetOf, type ConnectionRow } from "./connections/sync.js";
import { rateLimiter, verifyGitWebhook } from "./connections/webhooks.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { emitChanged } from "./events.js";
import { assertCanManage } from "./permissions.js";
import { redact } from "./redaction.js";
import { parseRepoUrl } from "./repo-detect.js";
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
export function renderBriefing(b: Briefing, base: string, project: string): string {
  const link = (path: string) => (base ? `${base}/#${path}` : `#${path}`);
  const out: string[] = [MARKER, "### What Thaliyola knows about these changes", ""];
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
  if (briefingSize(b) === 0) out.push("Nothing recorded about these files yet.", "");
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
        ? "GitLab: project → Settings → Webhooks → Add new webhook. URL: this URL; Secret token: the secret; Trigger: Merge request events."
        : "GitHub: repository (or organisation) → Settings → Webhooks → Add webhook. Payload URL: this URL; Content type: application/json; Secret: the secret; events: Pull requests.",
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
}

const GITHUB_ACTIONS = new Set(["opened", "synchronize", "reopened", "ready_for_review"]);
const GITLAB_ACTIONS = new Set(["open", "update", "reopen"]);

function pullRequestOf(event: string, p: Record<string, any>): PullRequest | null {
  if (event === "pull_request") {
    if (!GITHUB_ACTIONS.has(p.action) || !p.pull_request || !p.repository?.full_name) return null;
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
    };
  }
  if (event === "merge request hook") {
    const a = p.object_attributes;
    if (!a || !GITLAB_ACTIONS.has(a.action) || !p.project?.path_with_namespace) return null;
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
export async function receiveGitWebhook(db: Db, settings: Settings, id: string, headers: Record<string, string | undefined>, raw: Buffer, log: (m: string) => void = console.error): Promise<WebhookAnswer> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return { status: 404, body: { error: "not found" } };
  if (limiter.over(id)) return { status: 429, body: { error: "too many webhook calls for this connection; try again in a minute" } };
  const row = (await db.query<ConnectionRow & { webhook_secret: string | null; scope_slug: string; pr_briefings: string }>(
    "SELECT c.*, s.slug AS scope_slug, s.pr_briefings FROM connections c JOIN scopes s ON s.id = c.scope_id WHERE c.id = $1 AND s.status = 'active'",
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
  const pr = pullRequestOf(event, payload);
  if (!pr) return { status: 202, body: { ignored: "only opened or updated pull (merge) requests are briefed" } };
  if (row.pr_briefings === "off") return { status: 202, body: { ignored: `PR briefings are off for ${row.scope_slug} (project settings → Repositories)` } };
  if (!row.enabled) return { status: 202, body: { ignored: "the connection is switched off" } };
  const key = repoKey(pr.repo_url);
  const component = (
    await db.query<{ id: string; slug: string; repo_url: string | null }>(
      "SELECT id, slug, repo_url FROM components WHERE scope_id = $1 AND repo_key = $2 AND ($3::uuid IS NULL OR id = $3) LIMIT 1",
      [row.scope_id, key, row.component_id],
    )
  ).rows[0];
  if (!component || !key) return { status: 202, body: { ignored: `${pr.repository} isn't one of ${row.scope_slug}'s repositories` } };
  const work = briefPullRequest(db, settings, row, row.scope_slug, row.pr_briefings as "relevant" | "always", component, key, pr).catch((err: Error) => log(`[briefings] ${pr.repository}#${pr.number}: ${err.message}`));
  return { status: 202, body: { queued: true }, work };
}

/** Reads the changed files, builds the briefing, keeps it and posts (or updates) the comment. */
async function briefPullRequest(db: Db, settings: Settings, conn: ConnectionRow, project: string, mode: "relevant" | "always", component: { id: string; slug: string; repo_url: string | null }, key: string, pr: PullRequest) {
  const target = targetOf(conn, await openSecrets(db, settings, conn));
  const env = driverEnv(settings);
  const repo = parseRepoUrl(component.repo_url ?? pr.repo_url)?.path ?? pr.repository;
  const record = async (fields: { files?: string[]; briefing?: Briefing; items?: number; comment_id?: string | null; status: string; error?: string | null }) => {
    await db.query(
      `INSERT INTO pr_briefings (scope_id, component, repo_key, provider, number, title, url, author, head_sha, files, briefing, items, comment_id, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::text[], '{}'), coalesce($11::jsonb, '{}'), coalesce($12::int, 0), $13::text, $14, $15)
       ON CONFLICT (repo_key, number) DO UPDATE SET scope_id = EXCLUDED.scope_id, component = EXCLUDED.component, title = EXCLUDED.title, url = EXCLUDED.url,
         author = EXCLUDED.author, head_sha = EXCLUDED.head_sha, files = coalesce($10::text[], pr_briefings.files), briefing = coalesce($11::jsonb, pr_briefings.briefing),
         items = coalesce($12::int, pr_briefings.items), comment_id = coalesce($13::text, pr_briefings.comment_id), status = EXCLUDED.status, error = EXCLUDED.error, updated_at = now()`,
      [conn.scope_id, component.slug, key, pr.provider, pr.number, pr.title, pr.url, pr.author, pr.head_sha, fields.files ?? null, fields.briefing ? JSON.stringify(fields.briefing) : null, fields.items ?? null, fields.comment_id ?? null, fields.status, fields.error ?? null],
    );
    emitChanged();
  };
  let files: string[];
  try {
    files = await prFiles(target, env, repo, pr.number);
  } catch (err) {
    return record({ status: "failed", error: `couldn't list the changed files: ${(err as Error).message}`.slice(0, 500) });
  }
  const briefing = await buildBriefing(db, conn.scope_id, component, files);
  const items = briefingSize(briefing);
  if (!items && mode !== "always") return record({ files, briefing, items, status: "skipped" });
  const previous = (await db.query<{ comment_id: string | null }>("SELECT comment_id FROM pr_briefings WHERE repo_key = $1 AND number = $2", [key, pr.number])).rows[0]?.comment_id ?? null;
  try {
    const commentId = await upsertPrComment(target, env, repo, pr.number, renderBriefing(briefing, settings.publicUrl?.replace(/\/+$/, "") ?? "", project), previous);
    return record({ files, briefing, items, comment_id: commentId, status: "posted" });
  } catch (err) {
    const msg = (err as Error).message;
    const hint = /\b403\b|forbidden|not accessible/i.test(msg) ? " (the token needs permission to write pull-request comments: GitHub Pull requests: write, GitLab api)" : "";
    return record({ files, briefing, items, status: "failed", error: `${msg}${hint}`.slice(0, 500) });
  }
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
    `SELECT id, component AS repository, provider, number, title, url, author, head_sha, files, briefing, items, status, error, created_at, updated_at
       FROM pr_briefings WHERE scope_id = $1 AND ($2::int IS NULL OR number = $2) ORDER BY updated_at DESC LIMIT $3`,
    [scope.id, opts.number ?? null, Math.min(Math.max(opts.limit ?? 50, 1), 200)],
  );
  const mode = (await ctx.db.query<{ pr_briefings: string }>("SELECT pr_briefings FROM scopes WHERE id = $1", [scope.id])).rows[0]?.pr_briefings ?? "off";
  return { project: scope.slug, mode, briefings: rows };
}

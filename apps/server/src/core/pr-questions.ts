import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import { gatherAnswer, type AnswerBrief } from "./answer.js";
import { audit } from "./audit.js";
import { replyOnPr } from "./connections/git.js";
import { driverEnv, openSecrets, targetOf, type ConnectionRow } from "./connections/sync.js";
import type { RequestContext } from "./context.js";
import { emitChanged } from "./events.js";
import { assertCanManage, restrictReading } from "./permissions.js";
import { redact } from "./redaction.js";
import { getReadableScope } from "./scopes.js";
import { askSession } from "./sessions.js";
import { systemActor } from "./users.js";
import type { Embedder } from "./embeddings.js";

/**
 * Questions asked in pull (merge) requests. A comment that mentions @thaliyola gets, in the same thread, what the
 * repository's project (with Team and Library) knows about it: short excerpts with links, how fresh they are, where
 * sources disagree and open incidents. The question is also relayed to the project's Claude sessions; a session's
 * answer (or why it can't) is posted in the thread too. Opt-in per project, because the reply quotes knowledge
 * where everyone who can see the pull request reads it; other projects are never read.
 */

const MARKER = "<!-- thaliyola-answer -->";
const MENTION = /(^|[\s(])@thaliyola\b[:,]?/i;
const EXCERPT = 280;
/** Questions per pull request per hour, and per project per hour. */
const perPr = hourly(5);
const perProject = hourly(30);

function hourly(max: number) {
  const hits = new Map<string, number[]>();
  return {
    over(key: string) {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < 3_600_000);
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 3_600_000)) hits.delete(k);
      return recent.length > max;
    },
    reset: () => hits.clear(),
  };
}

/** Tests: forget the hourly counts. */
export function resetPrQuestionLimits() {
  perPr.reset();
  perProject.reset();
}

export interface PrQuestion {
  provider: "github" | "gitlab";
  repository: string;
  repo_url: string;
  number: number;
  pr_title: string;
  comment_id: string;
  author: string | null;
  question: string;
  path: string | null;
  line: number | null;
  /** Reply in this thread: a GitHub review comment, or a GitLab discussion. */
  review_comment_id: string | null;
  discussion_id: string | null;
}

/** A pull-request comment that asks Thaliyola something, or null. Comments Thaliyola wrote are never questions. */
export function questionOf(event: string, p: Record<string, any>): PrQuestion | null {
  const ask = (body: unknown) => {
    const text = String(body ?? "");
    if (text.includes("<!-- thaliyola-") || !MENTION.test(text)) return null;
    const q = text.replace(MENTION, " ").replace(/\s+/g, " ").trim();
    return q.length >= 3 ? q.slice(0, 1000) : null;
  };
  const bot = (u: any) => u?.type === "Bot" || /\[bot\]$/.test(String(u?.login ?? ""));
  if (event === "issue_comment" && p.action === "created" && p.issue?.pull_request && p.comment && !bot(p.comment.user)) {
    const q = ask(p.comment.body);
    if (!q) return null;
    return {
      provider: "github",
      repository: String(p.repository?.full_name ?? ""),
      repo_url: String(p.repository?.html_url ?? `https://github.com/${p.repository?.full_name}`),
      number: Number(p.issue.number),
      pr_title: String(p.issue.title ?? "").slice(0, 300),
      comment_id: String(p.comment.id),
      author: p.comment.user?.login ? String(p.comment.user.login) : null,
      question: q,
      path: null,
      line: null,
      review_comment_id: null,
      discussion_id: null,
    };
  }
  if (event === "pull_request_review_comment" && p.action === "created" && p.pull_request && p.comment && !bot(p.comment.user)) {
    const q = ask(p.comment.body);
    if (!q) return null;
    return {
      provider: "github",
      repository: String(p.repository?.full_name ?? ""),
      repo_url: String(p.repository?.html_url ?? `https://github.com/${p.repository?.full_name}`),
      number: Number(p.pull_request.number),
      pr_title: String(p.pull_request.title ?? "").slice(0, 300),
      comment_id: String(p.comment.id),
      author: p.comment.user?.login ? String(p.comment.user.login) : null,
      question: q,
      path: p.comment.path ? String(p.comment.path) : null,
      line: Number.isInteger(p.comment.line) ? p.comment.line : null,
      // Replies go to the thread's first comment.
      review_comment_id: String(p.comment.in_reply_to_id ?? p.comment.id),
      discussion_id: null,
    };
  }
  if (event === "note hook" && p.object_attributes?.noteable_type === "MergeRequest" && p.merge_request && !bot(p.user)) {
    const a = p.object_attributes;
    if (a.system) return null;
    const q = ask(a.note);
    if (!q) return null;
    return {
      provider: "gitlab",
      repository: String(p.project?.path_with_namespace ?? ""),
      repo_url: String(p.project?.web_url ?? ""),
      number: Number(p.merge_request.iid),
      pr_title: String(p.merge_request.title ?? "").slice(0, 300),
      comment_id: String(a.id),
      author: p.user?.username ? String(p.user.username) : null,
      question: q,
      path: a.position?.new_path ? String(a.position.new_path) : null,
      line: Number.isInteger(a.position?.new_line) ? a.position.new_line : null,
      review_comment_id: null,
      discussion_id: a.discussion_id ? String(a.discussion_id) : null,
    };
  }
  return null;
}

/** Turn questions in pull requests on or off for a project. Project admins. */
export async function setPrQuestions(ctx: RequestContext, project: string, on: boolean) {
  const scope = await getReadableScope(ctx, project);
  await assertCanManage(ctx, scope);
  await ctx.db.query("UPDATE scopes SET pr_questions = $2 WHERE id = $1", [scope.id, on ? "on" : "off"]);
  await audit(ctx.db, ctx.actor.id, "set_pr_questions", scope.id, { targetKind: "project", targetLabel: scope.slug, details: { on } });
  return { project: scope.slug, pr_questions: on ? "on" : "off" };
}

/** Recent questions asked in a project's pull requests. */
export async function listPrQuestions(ctx: RequestContext, project: string, limit = 30) {
  const scope = await getReadableScope(ctx, project);
  const { rows } = await ctx.db.query(
    `SELECT id, component AS repository, provider, number, author, question, path, line, confidence, sources, status, error, created_at, updated_at
       FROM pr_questions WHERE scope_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [scope.id, Math.min(Math.max(limit, 1), 100)],
  );
  return rows;
}

/**
 * Answers a question from the thread: what's known (posted now), then the question relayed to the project's
 * sessions. Called by the git webhook after it verified the connection's secret.
 */
export async function answerPrQuestion(
  db: Db,
  settings: Settings,
  embedder: Embedder | undefined,
  conn: ConnectionRow & { scope_slug: string },
  component: { slug: string },
  key: string,
  q: PrQuestion,
) {
  const already = (await db.query("SELECT 1 FROM pr_questions WHERE repo_key = $1 AND comment_id = $2", [key, q.comment_id])).rowCount;
  if (already) return { skipped: "already answered" };
  const over = perPr.over(`${key}#${q.number}`) || perProject.over(conn.scope_id);
  const scopes = (await db.query<{ id: string }>("SELECT id FROM scopes WHERE id = $1 OR kind IN ('team', 'library')", [conn.scope_id])).rows.map((r) => r.id);
  const ctx: RequestContext = { db, settings, embedder, actor: await systemActor(db), project: conn.scope_slug };
  restrictReading(ctx, scopes);
  const target = targetOf(conn, await openSecrets(db, settings, conn));
  const env = driverEnv(settings);
  const base = settings.publicUrl?.replace(/\/+$/, "") ?? "";
  const thread = { review_comment_id: q.review_comment_id, discussion_id: q.discussion_id };
  const record = async (f: { status: string; brief?: AnswerBrief | null; reply?: string | null; sq?: string | null; error?: string | null }) => {
    await db.query(
      `INSERT INTO pr_questions (scope_id, component, repo_key, provider, number, comment_id, author, question, path, line, confidence, sources, reply_comment_id, session_question_id, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) ON CONFLICT (repo_key, comment_id) DO NOTHING`,
      [conn.scope_id, component.slug, key, q.provider, q.number, q.comment_id, q.author, redact(q.question).text, q.path, q.line, f.brief?.confidence ?? null, f.brief?.sources.length ?? 0, f.reply ?? null, f.sq ?? null, f.status, f.error ?? null],
    );
    emitChanged();
  };
  if (over) {
    await replyOnPr(target, env, q.repository, q.number, `${MARKER}\nThat's a lot of questions for Thaliyola in a short time; try again in an hour.`, thread).catch(() => undefined);
    return record({ status: "failed", error: "rate limited" });
  }
  const where = q.path ? ` (about \`${q.path}${q.line ? `:${q.line}` : ""}\`)` : "";
  const brief = await gatherAnswer(ctx, { question: `${q.question}${q.path ? ` ${q.path.split("/").pop()}` : ""}`, project: conn.scope_slug, limit: 4 });
  // Relay to the project's sessions: one that picks it up answers with the code at hand.
  let relayed: { id: string; note: string } | null = null;
  try {
    const r = (await askSession(ctx, {
      to: conn.scope_slug,
      question: q.question,
      context: `Asked in ${q.provider === "gitlab" ? "merge request !" : "pull request #"}${q.number} (${q.pr_title})${where} by ${q.author ?? "someone"}. Your answer is posted in that thread, where everyone who can see it reads it.`,
      wait_seconds: 0,
      expires_minutes: 240,
    })) as { id?: string };
    if (r.id) {
      const reply = { connection_id: conn.id, repository: q.repository, number: q.number, provider: q.provider, ...thread };
      await db.query("UPDATE session_questions SET reply_pr = $2 WHERE id = $1 OR group_id = $1", [r.id, JSON.stringify(reply)]);
      relayed = { id: r.id, note: `I've asked ${conn.scope_slug}'s Claude sessions too; if one picks it up in the next 4 hours, its answer will be posted here.` };
    }
  } catch (err) {
    relayed = null;
    void err;
  }
  const body = renderAnswer(brief, base, q, relayed?.note ?? null);
  try {
    const reply = await replyOnPr(target, env, q.repository, q.number, body, thread);
    return record({ status: relayed ? "relayed" : "replied", brief, reply, sq: relayed?.id ?? null });
  } catch (err) {
    const msg = (err as Error).message;
    const hint = /\b403\b|forbidden|not accessible/i.test(msg) ? " (the token needs permission to write pull-request comments)" : "";
    return record({ status: "failed", brief, sq: relayed?.id ?? null, error: `${msg}${hint}`.slice(0, 500) });
  }
}

const FRESHNESS: Record<string, string> = {
  possibly_stale: "⚠️ possibly stale",
  facts_drifted: "⚠️ some facts no longer match the code",
  old: "⚠️ not checked in 6 months",
};

/** The reply: excerpts with links, never whole documents. */
export function renderAnswer(b: AnswerBrief, base: string, q: Pick<PrQuestion, "question" | "path" | "line">, relayed: string | null) {
  const link = (l: string) => (base ? `${base}/${l}` : l);
  const lines = [MARKER, `**What Thaliyola knows**${q.path ? ` about \`${q.path}${q.line ? `:${q.line}` : ""}\`` : ""}:`, ""];
  if (!b.sources.length) lines.push("Nothing in the project's knowledge matches this yet.", "");
  for (const s of b.sources.slice(0, 4)) {
    const excerpt = redact(s.text.replace(/\s+/g, " ")).text;
    const short = excerpt.length > EXCERPT ? `${excerpt.slice(0, EXCERPT).replace(/\s+\S*$/, "")} …` : excerpt;
    const flag = FRESHNESS[s.freshness] ? ` _(${FRESHNESS[s.freshness]})_` : "";
    lines.push(`${s.n}. **[${s.title}${s.section ? ` › ${s.section}` : ""}](${link(s.link)})** · ${s.type.replace(/_/g, " ")} · ${s.project}${flag}`, `   > ${short}`);
  }
  if (b.disagreements.length) lines.push("", ...b.disagreements.map((d) => `⚖️ ${d.note.replace(/ \(resolve_decision_conflict\)/, "")}`));
  const open = b.incidents.filter((i) => i.status !== "resolved");
  if (open.length) lines.push("", ...open.map((i) => `🚨 Open incident: [${i.title}](${link(i.link)}) (${i.severity}, ${i.status})`));
  if (b.confidence !== "good" && b.experts.length) lines.push("", `People who know this area: ${b.experts.map((e) => e.name ?? "someone").join(", ")}.`);
  if (relayed) lines.push("", relayed);
  lines.push("", `<sub>Ask again with \`@thaliyola <question>\`. Only ${b.sources.length ? "this project's, Team and Library" : "this project's"} knowledge is quoted here.</sub>`);
  return lines.join("\n");
}

/** Posts a session's answer (or why it couldn't) in the thread the question came from. */
export async function replyInPullRequest(db: Db, settings: Settings, reply: { connection_id: string; repository: string; number: number; review_comment_id?: string | null; discussion_id?: string | null }, questionId: string, text: string, status: "answered" | "declined") {
  const conn = (await db.query<ConnectionRow>("SELECT * FROM connections WHERE id = $1 AND enabled", [reply.connection_id])).rows[0];
  if (!conn) return;
  try {
    const target = targetOf(conn, await openSecrets(db, settings, conn));
    await replyOnPr(target, driverEnv(settings), reply.repository, reply.number, `${MARKER}\n${redact(text).text}`, reply);
    await db.query("UPDATE pr_questions SET status = $2, updated_at = now() WHERE session_question_id = $1", [questionId, status]);
  } catch (err) {
    await db.query("UPDATE pr_questions SET error = $2, updated_at = now() WHERE session_question_id = $1", [questionId, `couldn't post the answer: ${(err as Error).message}`.slice(0, 500)]);
  }
  emitChanged();
}

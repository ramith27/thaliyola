import type { RequestContext } from "./context.js";
import { ValidationError } from "./context.js";
import { findExperts } from "./expertise.js";
import { readableScopes } from "./permissions.js";
import { searchKnowledge, type SearchHit } from "./search.js";

/**
 * Evidence for answering a question, without a model on the server: the best sections of what the team knows, each
 * numbered for citing, with how fresh it is, where sources disagree (decisions on the same question, a project item
 * and a Library one covering the same thing, a known issue newer than the doc), open incidents and pull requests on
 * the topic, and who to ask when nothing is known. The client (Claude, the PR thread relay, Slack) writes the answer.
 */

export interface AnswerSource {
  n: number;
  kind: "article" | "finding";
  id: string;
  title: string;
  type: string;
  project: string;
  section: string | null;
  text: string;
  link: string;
  updated_at: string;
  last_verified_at: string | null;
  freshness: "fresh" | "old" | "possibly_stale" | "facts_drifted";
  note?: string;
}

export interface Disagreement {
  kind: "decisions_disagree" | "overlap" | "newer_finding";
  sources: [number, number];
  note: string;
}

export interface AnswerBrief {
  question: string;
  confidence: "good" | "partial" | "none";
  sources: AnswerSource[];
  disagreements: Disagreement[];
  incidents: { id: string; title: string; severity: string; status: string; project: string; link: string }[];
  pull_requests: { title: string; url: string | null; number: number; project: string; status: string }[];
  experts: { name: string | null; email: string | null; score: number }[];
  how_to_answer: string;
}

const SECTION_CHARS = 1500;
/** Not verified or changed for this long: "old". */
const OLD_DAYS = 180;

export async function gatherAnswer(ctx: RequestContext, input: { question: string; project?: string; limit?: number; source?: "web" | "mcp" }): Promise<AnswerBrief> {
  const question = input.question.trim().replace(/\s+/g, " ");
  if (question.length < 3) throw new ValidationError("question: what you want to know");
  const limit = Math.min(Math.max(input.limit ?? 6, 1), 12);
  const found = await searchKnowledge(ctx, { query: question.slice(0, 500), project: input.project, limit: limit + 2, source: input.source });
  // Source of truth first, then findings, best match first within each; then keep the strongest overall.
  const hits = [...found.articles, ...found.findings].sort((a, b) => b.score - a.score).slice(0, limit);
  const sources = await withSections(ctx, hits);
  const disagreements = await disagreementsAmong(ctx, sources);
  for (const d of disagreements) {
    if (d.kind === "decisions_disagree") for (const n of d.sources) sources[n - 1]!.note ??= "Another decision covers the same question; see disagreements.";
  }
  const terms = keyTerms(question);
  const [incidents, pullRequests] = await Promise.all([incidentsAbout(ctx, terms, input.project), pullRequestsAbout(ctx, terms, input.project)]);
  const best = hits[0]?.score ?? 0;
  const confidence: AnswerBrief["confidence"] = !sources.length ? "none" : sources.length >= 2 && best >= 0.5 ? "good" : "partial";
  const experts = confidence === "good" ? [] : await expertsFor(ctx, terms, input.project);
  return {
    question,
    confidence,
    sources,
    disagreements,
    incidents,
    pull_requests: pullRequests,
    experts,
    how_to_answer: howTo(confidence, disagreements.length > 0, sources.some((s) => s.freshness !== "fresh")),
  };
}

function howTo(confidence: AnswerBrief["confidence"], disagree: boolean, stale: boolean) {
  const parts = ["Answer from these sources only and cite them as [n]; say plainly what they don't cover."];
  if (disagree) parts.push("Where sources disagree, say so and prefer the newer, project-specific, published one; don't merge contradictory claims.");
  if (stale) parts.push("Flag anything resting on a source that isn't fresh, and check it against the code if you can.");
  if (confidence !== "good") parts.push("The team's knowledge is thin here: check the code, ask the experts listed (ask_session to expert:<topic> or a person), and save what you learn (create_finding) so the next person finds it.");
  return parts.join(" ");
}

/** The full best section of each hit (not just the snippet), with freshness. */
async function withSections(ctx: RequestContext, hits: SearchHit[]): Promise<AnswerSource[]> {
  if (!hits.length) return [];
  const { rows } = await ctx.db.query<{ parent_id: string; text: string; heading: string | null; stale_claims: number }>(
    `SELECT h.id AS parent_id, c.text, c.heading,
            (SELECT count(*)::int FROM claims cl WHERE cl.article_id = h.id AND cl.status = 'stale') AS stale_claims
       FROM unnest($1::uuid[], $2::text[]) AS h(id, section)
       LEFT JOIN LATERAL (
         SELECT text, heading FROM chunks c
          WHERE c.parent_id = h.id AND (h.section IS NULL OR c.heading = h.section)
          ORDER BY c.ord LIMIT 1) c ON true`,
    [hits.map((h) => h.id), hits.map((h) => h.section)],
  );
  const byId = new Map(rows.map((r) => [r.parent_id, r]));
  const oldBefore = Date.now() - OLD_DAYS * 86_400_000;
  return hits.map((h, i) => {
    const r = byId.get(h.id);
    let text = (r?.text ?? h.snippet).trim();
    // Chunks start with the item title (and section heading); the citation carries those.
    for (const prefix of [h.title, h.section ?? ""]) if (prefix && text.startsWith(prefix)) text = text.slice(prefix.length).trimStart();
    if (text.length > SECTION_CHARS) text = `${text.slice(0, SECTION_CHARS).replace(/\s+\S*$/, "")} …`;
    const checked = new Date(h.last_verified_at ?? h.updated_at).getTime();
    const freshness: AnswerSource["freshness"] =
      h.status === "possibly_stale" ? "possibly_stale" : (r?.stale_claims ?? 0) > 0 ? "facts_drifted" : checked < oldBefore ? "old" : "fresh";
    const note =
      freshness === "facts_drifted"
        ? `${r!.stale_claims} fact${r!.stale_claims === 1 ? "" : "s"} in this doc no longer match${r!.stale_claims === 1 ? "es" : ""} the code it cites.`
        : freshness === "old"
          ? `Not verified or changed in over ${OLD_DAYS} days.`
          : freshness === "possibly_stale"
            ? "Marked possibly stale."
            : undefined;
    return {
      n: i + 1,
      kind: h.kind,
      id: h.id,
      title: h.title,
      type: h.type,
      project: h.scope.slug,
      section: h.section,
      text,
      link: `#/${h.kind}/${h.id}`,
      updated_at: h.updated_at,
      last_verified_at: h.last_verified_at,
      freshness,
      ...(note ? { note } : {}),
    };
  });
}

const ISSUE_TYPES = new Set(["known_issue", "rca", "incident"]);
const SPECIFIC = (scopeKind: string) => (scopeKind === "project" ? 2 : scopeKind === "team" ? 1 : 0);

/** Pairs of sources that cover the same thing and may not agree, from their sections' embeddings. */
async function disagreementsAmong(ctx: RequestContext, sources: AnswerSource[]): Promise<Disagreement[]> {
  if (!ctx.embedder || sources.length < 2) return [];
  const ids = sources.map((s) => s.id);
  // Same kind of item on the same question reads alike; a known issue and the doc it affects are worded differently.
  const close = Math.max(ctx.settings.duplicateSimilarity - 0.1, 0.5);
  const loose = Math.max(ctx.settings.duplicateSimilarity - 0.2, 0.45);
  const { rows } = await ctx.db.query<{ a: string; b: string; sim: number; related: boolean; dismissed: boolean; a_scope_kind: string; b_scope_kind: string }>(
    `WITH best AS (
       SELECT DISTINCT ON (c.parent_id) c.parent_id, c.embedding, c.scope_id
         FROM chunks c
        WHERE c.parent_id = ANY($1::uuid[]) AND c.embedding IS NOT NULL AND c.embedding_model = $2
        ORDER BY c.parent_id, (c.heading = 'Choice') DESC, c.ord)
     SELECT x.parent_id AS a, y.parent_id AS b, (1 - (x.embedding <=> y.embedding))::float AS sim,
            EXISTS (SELECT 1 FROM relations r WHERE r.kind IN ('supersedes', 'related', 'same_root_cause', 'promoted_into')
                     AND ((r.from_id = x.parent_id AND r.to_id = y.parent_id) OR (r.from_id = y.parent_id AND r.to_id = x.parent_id))) AS related,
            EXISTS (SELECT 1 FROM decision_conflict_dismissals d WHERE d.a = least(x.parent_id, y.parent_id) AND d.b = greatest(x.parent_id, y.parent_id)) AS dismissed,
            sx.kind AS a_scope_kind, sy.kind AS b_scope_kind
       FROM best x JOIN best y ON x.parent_id < y.parent_id
       JOIN scopes sx ON sx.id = x.scope_id JOIN scopes sy ON sy.id = y.scope_id
      WHERE 1 - (x.embedding <=> y.embedding) >= $3`,
    [ids, ctx.embedder.model, loose],
  );
  const at = new Map(sources.map((s) => [s.id, s]));
  const out: Disagreement[] = [];
  for (const r of rows) {
    if (r.related || r.dismissed) continue;
    let a = at.get(r.a)!;
    let b = at.get(r.b)!;
    let aKind = r.a_scope_kind;
    let bKind = r.b_scope_kind;
    if (a.n > b.n) [a, b, aKind, bKind] = [b, a, bKind, aKind];
    const pair: [number, number] = [a.n, b.n];
    if (a.type === "decision" && b.type === "decision" && r.sim >= close) {
      out.push({ kind: "decisions_disagree", sources: pair, note: `[${a.n}] and [${b.n}] are decisions on what looks like the same question. If one replaced the other, a reviewer can mark it superseded (resolve_decision_conflict).` });
    } else if (a.kind !== b.kind && (ISSUE_TYPES.has(a.type) || ISSUE_TYPES.has(b.type))) {
      const [doc, issue] = a.kind === "article" ? [a, b] : [b, a];
      if (new Date(issue.updated_at).getTime() > new Date(doc.last_verified_at ?? doc.updated_at).getTime())
        out.push({ kind: "newer_finding", sources: pair, note: `[${issue.n}] (${issue.type.replace("_", " ")}) is newer than [${doc.n}] was last checked; the doc may not reflect it.` });
    } else if (a.type === b.type && r.sim >= close && a.project !== b.project && SPECIFIC(aKind) !== SPECIFIC(bKind)) {
      const [specific, general] = SPECIFIC(aKind) > SPECIFIC(bKind) ? [a, b] : [b, a];
      out.push({ kind: "overlap", sources: pair, note: `[${specific.n}] (${specific.project}) and [${general.n}] (${general.project}) cover the same thing; inside ${specific.project}, [${specific.n}] applies.` });
    }
  }
  return out;
}

const STOP = new Set(
  "a an and are as at be by can do does for from how i in is it of on or our should the this to was we what when where which who why will with you your".split(" "),
);

/** The words worth matching on titles (incidents, pull requests, expert topics). */
export function keyTerms(question: string) {
  return [...new Set(question.toLowerCase().match(/[\p{L}\p{N}_/.-]{3,}/gu) ?? [])].filter((w) => !STOP.has(w)).slice(0, 8);
}

async function scopeFilter(ctx: RequestContext, project?: string) {
  const readable = await readableScopes(ctx);
  const projectId = project ? ((await ctx.db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1", [project])).rows[0]?.id ?? null) : null;
  return { readable, projectId };
}

async function incidentsAbout(ctx: RequestContext, terms: string[], project?: string) {
  if (!terms.length) return [];
  const { readable, projectId } = await scopeFilter(ctx, project);
  const { rows } = await ctx.db.query<{ id: string; title: string; severity: string; status: string; project: string }>(
    `SELECT i.id, i.title, i.severity, i.status, s.slug AS project
       FROM incidents i JOIN scopes s ON s.id = i.scope_id
      WHERE ($1::uuid[] IS NULL OR i.scope_id = ANY($1)) AND ($2::uuid IS NULL OR i.scope_id = $2)
        AND (i.status <> 'resolved' OR i.started_at > now() - interval '90 days')
        -- An open incident shows on one shared word (people need to know); a past one needs two.
        AND (SELECT count(*) FROM unnest($3::text[]) t WHERE i.title ILIKE '%' || t || '%' OR coalesce(i.summary, '') ILIKE '%' || t || '%')
            >= CASE WHEN i.status = 'resolved' THEN least(2, cardinality($3::text[])) ELSE 1 END
      ORDER BY (i.status <> 'resolved') DESC, i.started_at DESC LIMIT 3`,
    [readable, projectId, terms],
  );
  return rows.map((r) => ({ ...r, link: `#/incidents/${r.id}` }));
}

async function pullRequestsAbout(ctx: RequestContext, terms: string[], project?: string) {
  if (!terms.length) return [];
  const { readable, projectId } = await scopeFilter(ctx, project);
  const { rows } = await ctx.db.query<{ title: string; url: string | null; number: number; project: string; status: string }>(
    `SELECT p.title, p.url, p.number, s.slug AS project, p.status
       FROM pr_briefings p JOIN scopes s ON s.id = p.scope_id
      WHERE ($1::uuid[] IS NULL OR p.scope_id = ANY($1)) AND ($2::uuid IS NULL OR p.scope_id = $2)
        AND p.updated_at > now() - interval '60 days'
        AND (SELECT count(*) FROM unnest($3::text[]) t WHERE p.title ILIKE '%' || t || '%') >= least(2, cardinality($3::text[]))
      ORDER BY p.updated_at DESC LIMIT 3`,
    [readable, projectId, terms],
  );
  return rows;
}

async function expertsFor(ctx: RequestContext, terms: string[], project?: string) {
  const seen = new Map<string, { name: string | null; email: string | null; score: number }>();
  const add = (r: { experts: { name?: string | null; email?: string | null; score: number }[] }) => {
    for (const e of r.experts) {
      const key = e.email ?? e.name ?? "";
      if (key && !seen.has(key)) seen.set(key, { name: e.name ?? null, email: e.email ?? null, score: e.score });
    }
  };
  for (const t of terms.slice(0, 4)) add(await findExperts(ctx, { topic: t, limit: 3 }).catch(() => ({ experts: [] })));
  if (project && seen.size < 3) add(await findExperts(ctx, { project, limit: 3 }).catch(() => ({ experts: [] })));
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}

/**
 * Warnings for the search page's best answer (discover.ts ask): how fresh it is, the other sources that disagree with
 * it, and open incidents on the topic. The same checks Claude gets from answer_sources.
 */
export async function cautionsFor(ctx: RequestContext, hits: SearchHit[], question: string, project?: string) {
  const sources = await withSections(ctx, hits.slice(0, 6));
  if (!sources.length) return null;
  const best = sources[0]!;
  const disagreements = (await disagreementsAmong(ctx, sources))
    .filter((d) => d.sources.includes(1))
    .map((d) => {
      const other = sources[(d.sources[0] === 1 ? d.sources[1] : d.sources[0]) - 1]!;
      const why =
        d.kind === "decisions_disagree"
          ? "Another decision covers the same question"
          : d.kind === "newer_finding"
            ? other.kind === "finding"
              ? `A ${other.type.replace(/_/g, " ")} newer than this was last checked`
              : "This is newer than the doc was last checked"
            : other.project === best.project
              ? "Covered elsewhere too"
              : `Also covered in ${other.project}`;
      return { kind: d.kind, why, other: { kind: other.kind, id: other.id, title: other.title, project: other.project } };
    });
  const incidents = (await incidentsAbout(ctx, keyTerms(question), project)).filter((i) => i.status !== "resolved");
  return { freshness: best.freshness, note: best.note ?? null, disagreements, incidents };
}

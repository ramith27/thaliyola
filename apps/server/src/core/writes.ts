import { VECTOR_CANDIDATES, withTx, type Queryable } from "../db/pool.js";
import { audit, requestVia } from "./audit.js";
import { addSourceLink, insertArticle, insertFinding, relate } from "./bootstrap.js";
import { ConflictError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { getArticle, getFinding } from "./items.js";
import { assertCanPropose, assertCanRead, assertCanVerify, canApprove, canPublishOwn } from "./permissions.js";
import { onlyRedacted, redactFields, type Redaction } from "./redaction.js";
import { approveRevision } from "./review.js";
import { toPgVector } from "./embeddings.js";
import { onProposal, track } from "./notify.js";
import { getComponent, getReadableScope, getScopeBySlug, resolveProject, type Scope } from "./scopes.js";
import { linkEntities, normalizeTags, type EntityRef } from "./tags.js";
import { attachTrackerLink } from "./connections/tickets.js";
import { isTracker } from "./connections/trackers.js";
import { missingSections, newItemSummary, stripHints } from "./templates.js";

/**
 * Proposals. Every write by a person or agent becomes a pending revision that
 * a scope owner approves (see review.ts). New items are stored as drafts so
 * they are visible (with statuses: ["draft"]) while under review.
 */

const LIMITS = { title: 200, field: 20_000, body: 100_000, summary: 300 };

export interface SourceLinkInput {
  system: string;
  url: string;
  label?: string;
}

export interface ItemRow {
  kind: "article" | "finding";
  id: string;
  scope_id: string;
  version: number;
  status: string;
  title: string;
  type: string;
}

export async function findItem(db: Queryable, id: string, lock = false): Promise<ItemRow> {
  const forUpdate = lock ? "FOR UPDATE" : "";
  const a = await db.query<ItemRow>(
    `SELECT 'article' AS kind, id, scope_id, version, status, title, type FROM articles WHERE id = $1 ${forUpdate}`,
    [id],
  );
  if (a.rows[0]) return a.rows[0];
  const f = await db.query<ItemRow>(
    `SELECT 'finding' AS kind, id, scope_id, version, status, title, type FROM findings WHERE id = $1 ${forUpdate}`,
    [id],
  );
  if (f.rows[0]) return f.rows[0];
  throw new NotFoundError(`article or finding ${id}`);
}

/** An item the caller may read; unreadable items look missing. */
export async function findItemFor(ctx: RequestContext, id: string): Promise<ItemRow> {
  const item = await findItem(ctx.db, id);
  await assertCanRead(ctx, item.scope_id, `article or finding ${id}`);
  return item;
}

/** Where a new item goes: an explicit scope slug, else the current project. */
async function targetScope(ctx: RequestContext, scope?: string, project?: string): Promise<Scope> {
  if (scope) return getReadableScope(ctx, scope);
  const p = await resolveProject(ctx, project);
  if (!p) throw new ValidationError("pass `scope` ('team', 'library' or a project slug) or set the X-Thaliyola-Project header");
  return p;
}

async function componentIds(db: Queryable, scope: Scope, slugs: string[] | undefined): Promise<string[]> {
  if (!slugs?.length) return [];
  if (scope.kind !== "project") throw new ValidationError("components can only be set on project items");
  const ids: string[] = [];
  for (const slug of slugs) ids.push((await getComponent(db, scope.id, slug)).id);
  return ids;
}

function checkLength(name: string, value: string | undefined, max: number) {
  if (value !== undefined && value.length > max) throw new ValidationError(`${name} is longer than ${max} characters`);
}

function requireText(name: string, value: string | undefined) {
  if (value === undefined || onlyRedacted(value)) throw new ValidationError(`${name} must not be empty (after redaction)`);
}

function assertEditable(item: ItemRow) {
  if (item.status === "deleted") throw new ValidationError(`${item.kind} is in the trash; restore it first`);
  if (item.status === "rejected" || item.status === "superseded") {
    throw new ValidationError(`${item.kind} is ${item.status}; propose a new one instead`);
  }
}

async function insertRevision(
  db: Queryable,
  r: {
    targetKind: string;
    targetId: string;
    scopeId: string;
    op: string;
    baseVersion: number | null;
    payload: unknown;
    authorId: string;
    summary: string;
    redactions: Redaction[];
  },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO revisions (target_kind, target_id, scope_id, op, base_version, payload, author_id, summary, redactions, created_via)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    // Written through Claude: the same person approving it there soon after needs the user's say-so (core/approvals.ts).
    [r.targetKind, r.targetId, r.scopeId, r.op, r.baseVersion, JSON.stringify(r.payload), r.authorId, r.summary, JSON.stringify(r.redactions), requestVia() === "mcp" ? "mcp" : null],
  );
  return rows[0]!.id;
}

async function addLinks(db: Queryable, target: { kind: string; id: string }, links: SourceLinkInput[] | undefined, actorId?: string) {
  for (const l of links ?? []) {
    const { fields } = redactFields({ url: l.url, label: l.label ?? "" });
    // A Jira or Linear issue's link: once per item, and its status is cached and shown with it (core/connections/tickets.ts).
    if (isTracker(l.system)) await attachTrackerLink(db, target, { system: l.system, url: fields.url, label: fields.label }, actorId);
    else await addSourceLink(db, target, l.system, fields.url, fields.label);
  }
}

/** Proposal kinds an author with "publish" publishes themselves; moves and library shares always get a review. */
const SELF_PUBLISHED = new Set(["create", "update", "promote", "verify"]);

/**
 * Tells reviewers about a committed proposal (asynchronously; never fails the write).
 * Some writes don't wait: in a personal space there is nobody to review, so its owner's writes publish on the spot;
 * and someone holding "publish" in the project (Project admins) publishes their own (see canPublishOwn).
 */
async function announce<T extends { revision_id?: string; status?: string }>(ctx: RequestContext, result: T): Promise<T> {
  if (!result.revision_id) return result;
  const { rows } = await ctx.db.query<{ kind: string; scope_id: string; op: string }>(
    "SELECT s.kind, r.scope_id, r.op FROM revisions r JOIN scopes s ON s.id = r.scope_id WHERE r.id = $1",
    [result.revision_id],
  );
  const r = rows[0];
  if (r?.kind === "personal" && (await canApprove(ctx, r.scope_id))) {
    const approved = await approveRevision(ctx, result.revision_id, undefined, { settle: true });
    return { ...result, ...approved, status: "published", published: true };
  }
  if (r && SELF_PUBLISHED.has(r.op) && (await canPublishOwn(ctx, r.scope_id))) {
    const approved = await approveRevision(ctx, result.revision_id, undefined, { ownWrite: true });
    return { ...result, ...approved, status: "published", published: true, message: "Published: you may publish in this project without review." };
  }
  if (!ctx.quietProposals) {
    track(onProposal(ctx.db, ctx.settings, result.revision_id).catch((err) => console.error(`[notify] ${(err as Error).message}`)));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Duplicate check

export interface Duplicate {
  id: string;
  title: string;
  status: string;
  scope: string;
  /** Share of the proposal's terms found in the existing finding. */
  overlap: number;
  /** Embedding similarity, when semantic search is enabled. */
  similarity: number | null;
}

/**
 * Findings that are probably the same problem: they contain most of the
 * proposal's terms, or (with embeddings) say nearly the same thing in other
 * words. Deterministic; the client's Claude decides whether to merge.
 */
export async function findDuplicateFindings(ctx: RequestContext, text: string, scopeIds: string[]): Promise<Duplicate[]> {
  const byTerms = await ctx.db.query<Omit<Duplicate, "similarity">>(
    `WITH p AS (
       SELECT array_agg(DISTINCT l) AS lex FROM unnest(tsvector_to_array(to_tsvector('english', $1))) l
     ),
     q AS (
       SELECT to_tsquery('simple', coalesce(string_agg(t, ' | '), '')) AS any_term
         FROM (SELECT regexp_replace(l, '[^[:alnum:]_]', '', 'g') AS t FROM unnest((SELECT lex FROM p)) l) x
        WHERE t <> ''
     ),
     -- Cheap ranking first; exact term overlap only for the best candidates.
     candidates AS (
       SELECT c.parent_id, c.tsv FROM chunks c CROSS JOIN q
        WHERE c.parent_kind = 'finding' AND c.scope_id = ANY($2::uuid[]) AND c.tsv @@ q.any_term
        ORDER BY ts_rank(c.tsv, q.any_term, 1) DESC LIMIT 50
     )
     SELECT f.id, f.title, f.status, s.slug AS scope,
            round(((SELECT count(*) FROM unnest(p.lex) x WHERE x = ANY(tsvector_to_array(c.tsv)))::numeric
                   / greatest(cardinality(p.lex), 1)), 2)::float AS overlap
       FROM candidates c
       CROSS JOIN p
       JOIN findings f ON f.id = c.parent_id
       JOIN scopes s ON s.id = f.scope_id
      WHERE f.status IN ('draft', 'published', 'possibly_stale')
      ORDER BY overlap DESC
      LIMIT 5`,
    [text, scopeIds],
  );
  const found = new Map<string, Duplicate>();
  for (const r of byTerms.rows) if (r.overlap >= ctx.settings.duplicateThreshold) found.set(r.id, { ...r, similarity: null });

  if (ctx.embedder) {
    let vector: number[] | null = null;
    try {
      vector = (await ctx.embedder.embedDocuments([text]))[0] ?? null;
    } catch {
      vector = null;
    }
    if (vector) {
      const bySimilarity = await ctx.db.query<{ id: string; title: string; status: string; scope: string; similarity: number }>(
        `SELECT f.id, f.title, f.status, s.slug AS scope, round((1 - nn.dist)::numeric, 3)::float AS similarity
           FROM (SELECT c.id, c.parent_id, c.parent_kind, c.scope_id, c.embedding_model, c.embedding <=> $1::vector AS dist
                   FROM chunks c WHERE c.embedding IS NOT NULL
                  ORDER BY c.embedding <=> $1::vector LIMIT ${VECTOR_CANDIDATES}) nn
           JOIN findings f ON f.id = nn.parent_id
           JOIN scopes s ON s.id = f.scope_id
          WHERE nn.parent_kind = 'finding' AND nn.scope_id = ANY($2::uuid[]) AND nn.embedding_model = $3
            AND f.status IN ('draft', 'published', 'possibly_stale')
          ORDER BY nn.dist LIMIT 5`,
        [toPgVector(vector), scopeIds, ctx.embedder.model],
      );
      for (const r of bySimilarity.rows) {
        if (r.similarity < ctx.settings.duplicateSimilarity) continue;
        const overlap = byTerms.rows.find((t) => t.id === r.id)?.overlap ?? 0;
        found.set(r.id, { ...r, overlap, similarity: r.similarity });
      }
      for (const d of found.values()) d.similarity ??= bySimilarity.rows.find((r) => r.id === d.id)?.similarity ?? null;
    }
  }
  return [...found.values()].sort((a, b) => (b.similarity ?? b.overlap) - (a.similarity ?? a.overlap));
}

/** Team + Library + the item's own scope: where a duplicate would be found by default search. */
async function duplicateScopeIds(db: Queryable, scopeId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM scopes WHERE kind IN ('team', 'library') OR id = $1", [scopeId]);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Findings

export interface ProposeFindingInput {
  scope?: string;
  project?: string;
  type: string;
  title: string;
  symptoms: string;
  root_cause: string;
  fix?: string;
  tags?: string[];
  components?: string[];
  entities?: EntityRef[];
  source_links?: SourceLinkInput[];
  related_ids?: string[];
  force_new?: boolean;
}

export async function proposeFinding(ctx: RequestContext, input: ProposeFindingInput) {
  const scope = await targetScope(ctx, input.scope, input.project);
  await assertCanPropose(ctx, scope.id);
  const { fields, redactions } = redactFields({
    title: input.title.trim(),
    symptoms: input.symptoms.trim(),
    root_cause: input.root_cause.trim(),
    fix: (input.fix ?? "").trim(),
  });
  requireText("title", fields.title);
  requireText("symptoms", fields.symptoms);
  requireText("root_cause", fields.root_cause);
  checkLength("title", fields.title, LIMITS.title);
  for (const f of ["symptoms", "root_cause", "fix"] as const) checkLength(f, fields[f], LIMITS.field);
  const components = await componentIds(ctx.db, scope, input.components);
  for (const id of input.related_ids ?? []) await findItemFor(ctx, id);

  if (!input.force_new) {
    const duplicates = await findDuplicateFindings(
      ctx,
      `${fields.title}\n${fields.symptoms}\n${fields.root_cause}`,
      await duplicateScopeIds(ctx.db, scope.id),
    );
    if (duplicates.length) {
      return {
        status: "duplicates_found" as const,
        duplicates,
        message:
          "Nothing was stored. If one of these is the same problem, update it with update_finding (or verify_entry). " +
          "If they are unrelated, call propose_finding again with force_new: true and pass their ids in related_ids.",
      };
    }
  }

  return announce(ctx, await withTx(ctx.db, async (db) => {
    const id = await insertFinding(db, {
      scopeId: scope.id,
      type: input.type,
      title: fields.title,
      symptoms: fields.symptoms,
      rootCause: fields.root_cause,
      fix: fields.fix,
      status: "draft",
      tags: normalizeTags(input.tags),
      componentIds: components,
      authorId: ctx.actor.id,
    });
    await linkEntities(db, { kind: "finding", id }, input.entities);
    await addLinks(db, { kind: "finding", id }, input.source_links, ctx.actor.id);
    for (const rel of input.related_ids ?? []) {
      const other = await findItem(db, rel);
      await relate(db, { kind: "finding", id }, "related", { kind: other.kind, id: other.id });
    }
    const revisionId = await insertRevision(db, {
      targetKind: "finding",
      targetId: id,
      scopeId: scope.id,
      op: "create",
      baseVersion: 1,
      payload: {},
      authorId: ctx.actor.id,
      summary: newItemSummary(input.type, fields.title).slice(0, LIMITS.summary),
      redactions,
    });
    ctx.onWrite?.();
    return {
      status: "pending_review" as const,
      finding_id: id,
      revision_id: revisionId,
      scope: scope.slug,
      redactions,
      message: "Stored as a draft and queued for review. It becomes searchable by default once approved.",
    };
  }));
}

export interface UpdateFindingInput {
  id: string;
  version: number;
  summary: string;
  patch: { title?: string; symptoms?: string; root_cause?: string; fix?: string; tags?: string[] };
}

export async function updateFinding(ctx: RequestContext, input: UpdateFindingInput) {
  const item = await findItemFor(ctx, input.id);
  if (item.kind !== "finding") throw new ValidationError(`${input.id} is an article; use propose_article_edit`);
  await assertCanPropose(ctx, item.scope_id);
  assertEditable(item);
  if (item.version !== input.version) {
    throw new ConflictError(`finding is at version ${item.version}, not ${input.version}`, await getFinding(ctx, input.id));
  }
  const { tags, ...text } = input.patch;
  const { fields, redactions } = redactFields(Object.fromEntries(Object.entries(text).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v!.trim()])));
  for (const [k, v] of Object.entries(fields)) {
    if (k !== "fix") requireText(k, v as string);
    checkLength(k, v as string, k === "title" ? LIMITS.title : LIMITS.field);
  }
  const patch = { ...fields, ...(tags ? { tags: normalizeTags(tags) } : {}) };
  if (!Object.keys(patch).length) throw new ValidationError("patch is empty");
  const summary = redactFields({ s: input.summary.trim() }).fields.s;
  requireText("summary", summary);

  const revisionId = await insertRevision(ctx.db, {
    targetKind: "finding",
    targetId: item.id,
    scopeId: item.scope_id,
    op: "update",
    baseVersion: item.version,
    payload: { patch },
    authorId: ctx.actor.id,
    summary: summary.slice(0, LIMITS.summary),
    redactions,
  });
  return announce(ctx, { status: "pending_review" as const, revision_id: revisionId, base_version: item.version, redactions });
}

// ---------------------------------------------------------------------------
// Articles

export interface CreateArticleInput {
  scope?: string;
  project?: string;
  type: string;
  title: string;
  body_md: string;
  path?: string;
  tags?: string[];
  components?: string[];
  entities?: EntityRef[];
  source_links?: SourceLinkInput[];
  uses_ids?: string[];
}

export async function createArticle(ctx: RequestContext, input: CreateArticleInput) {
  const scope = await targetScope(ctx, input.scope, input.project);
  await assertCanPropose(ctx, scope.id);
  if (input.type === "project_overview" && scope.kind !== "project") throw new ValidationError("project_overview belongs in a project scope");
  const { fields, redactions } = redactFields({ title: input.title.trim(), body_md: stripHints(input.body_md), path: (input.path ?? "").trim() });
  requireText("title", fields.title);
  checkLength("title", fields.title, LIMITS.title);
  checkLength("body_md", fields.body_md, LIMITS.body);
  const path = fields.path.split("/").map((p) => p.trim()).filter(Boolean).join("/");
  const components = await componentIds(ctx.db, scope, input.components);
  for (const id of input.uses_ids ?? []) await findItemFor(ctx, id);

  return announce(ctx, await withTx(ctx.db, async (db) => {
    const id = await insertArticle(db, {
      scopeId: scope.id,
      type: input.type,
      title: fields.title,
      body: fields.body_md,
      path,
      status: "draft",
      tags: normalizeTags(input.tags),
      componentIds: components,
      ownerId: ctx.actor.kind === "human" ? ctx.actor.id : undefined,
    });
    await linkEntities(db, { kind: "article", id }, input.entities);
    await addLinks(db, { kind: "article", id }, input.source_links, ctx.actor.id);
    for (const target of input.uses_ids ?? []) {
      const other = await findItem(db, target);
      await relate(db, { kind: "article", id }, "uses", { kind: other.kind, id: other.id });
    }
    const revisionId = await insertRevision(db, {
      targetKind: "article",
      targetId: id,
      scopeId: scope.id,
      op: "create",
      baseVersion: 1,
      payload: {},
      authorId: ctx.actor.id,
      summary: newItemSummary(input.type, fields.title).slice(0, LIMITS.summary),
      redactions,
    });
    const missing = missingSections(input.type, fields.body_md);
    ctx.onWrite?.();
    return {
      status: "pending_review" as const,
      article_id: id,
      revision_id: revisionId,
      scope: scope.slug,
      redactions,
      ...(missing.length ? { missing_template_sections: missing } : {}),
    };
  }));
}

export interface ArticleEditInput {
  id: string;
  version: number;
  summary: string;
  /** Section heading to replace (or add); omit to replace the whole body. */
  section?: string;
  /** New text; omit for an edit that only changes tags (or the title). */
  text?: string;
  /** New title (whole-article edits from the UI). */
  title?: string;
  /** Replace all of the article's tags. Not with add_tags / remove_tags. */
  tags?: string[];
  /** Tags to add and to remove, keeping the others. */
  add_tags?: string[];
  remove_tags?: string[];
}

/**
 * The tags an article edit leaves: `tags` replaces them all, `add_tags` / `remove_tags` change some; each is
 * normalised like a new article's (lower case, hyphens for spaces, no duplicates). Null when the edit leaves tags alone.
 */
export function nextArticleTags(current: string[], input: Pick<ArticleEditInput, "tags" | "add_tags" | "remove_tags">): { tags: string[]; added: string[]; removed: string[] } | null {
  const replace = input.tags !== undefined;
  const change = input.add_tags !== undefined || input.remove_tags !== undefined;
  if (replace && change) throw new ValidationError("pass tags (replace them all) or add_tags / remove_tags (change some), not both");
  if (!replace && !change) return null;
  let next: string[];
  if (replace) next = normalizeTags(input.tags);
  else {
    const remove = new Set(normalizeTags(input.remove_tags));
    next = normalizeTags([...current, ...(input.add_tags ?? [])]).filter((t) => !remove.has(t));
  }
  const before = new Set(current);
  const after = new Set(next);
  return { tags: next, added: next.filter((t) => !before.has(t)), removed: current.filter((t) => !after.has(t)) };
}

export async function proposeArticleEdit(ctx: RequestContext, input: ArticleEditInput) {
  const item = await findItemFor(ctx, input.id);
  if (item.kind !== "article") throw new ValidationError(`${input.id} is a finding; use update_finding`);
  await assertCanPropose(ctx, item.scope_id);
  assertEditable(item);
  if (item.version !== input.version) {
    throw new ConflictError(`article is at version ${item.version}, not ${input.version}`, await getArticle(ctx, input.id));
  }
  const hasText = input.text !== undefined;
  const { fields, redactions } = redactFields({
    text: hasText ? stripHints(input.text!) : "",
    summary: input.summary.trim(),
    section: (input.section ?? "").trim(),
    title: (input.title ?? "").trim(),
  });
  requireText("summary", fields.summary);
  checkLength("text", fields.text, LIMITS.body);
  checkLength("title", fields.title, LIMITS.title);
  // Tags change through the same review as text: the proposal carries the tags it leaves and what it adds and removes.
  const current = (await ctx.db.query<{ tags: string[] }>("SELECT tags FROM articles WHERE id = $1", [item.id])).rows[0]?.tags ?? [];
  const tags = nextArticleTags(current, input);
  if (tags && !tags.added.length && !tags.removed.length && !hasText && !fields.title) throw new ValidationError("the article already has exactly these tags: nothing to change");
  if (!hasText && !tags && !fields.title) throw new ValidationError("pass text, a title, or tags (tags, or add_tags / remove_tags) to change");
  if (!hasText && fields.section) throw new ValidationError("a section needs its new text");
  const revisionId = await insertRevision(ctx.db, {
    targetKind: "article",
    targetId: item.id,
    scopeId: item.scope_id,
    op: "update",
    baseVersion: item.version,
    payload: {
      section: fields.section || null,
      ...(hasText ? { text: fields.text } : {}),
      mode: "replace",
      ...(fields.title ? { title: fields.title } : {}),
      ...(tags ? { tags: tags.tags, tags_added: tags.added, tags_removed: tags.removed } : {}),
    },
    authorId: ctx.actor.id,
    summary: fields.summary.slice(0, LIMITS.summary),
    redactions,
  });
  return announce(ctx, { status: "pending_review" as const, revision_id: revisionId, base_version: item.version, redactions });
}

export async function promoteFinding(ctx: RequestContext, input: { finding_id: string; article_id: string; version: number; section?: string }) {
  const finding = await findItemFor(ctx, input.finding_id);
  const article = await findItemFor(ctx, input.article_id);
  if (finding.kind !== "finding" || article.kind !== "article") throw new ValidationError("promote a finding into an article");
  if (finding.status !== "published" && finding.status !== "possibly_stale") throw new ValidationError("only published findings can be promoted");
  await assertCanPropose(ctx, article.scope_id);
  assertEditable(article);
  if (article.version !== input.version) {
    throw new ConflictError(`article is at version ${article.version}, not ${input.version}`, await getArticle(ctx, input.article_id));
  }
  const f = (await ctx.db.query("SELECT title, root_cause, fix FROM findings WHERE id = $1", [finding.id])).rows[0];
  const section = input.section?.trim() || "Known issues";
  const text = `- **${f.title}**: ${f.root_cause}${f.fix ? ` Fix: ${f.fix}` : ""} (finding ${finding.id})`;
  const revisionId = await insertRevision(ctx.db, {
    targetKind: "article",
    targetId: article.id,
    scopeId: article.scope_id,
    op: "promote",
    baseVersion: article.version,
    payload: { section, text, mode: "append", finding_id: finding.id },
    authorId: ctx.actor.id,
    summary: `Promote finding "${f.title}" into ${section}`.slice(0, LIMITS.summary),
    redactions: [],
  });
  return announce(ctx, { status: "pending_review" as const, revision_id: revisionId, section, text });
}

/** Evidence and design links (Figma frame, PR, Sentry issue) are metadata and apply directly. */
export async function addSourceLinkTo(ctx: RequestContext, id: string, link: SourceLinkInput) {
  const item = await findItemFor(ctx, id);
  await assertCanPropose(ctx, item.scope_id);
  if (!/^https?:\/\//.test(link.url)) throw new ValidationError("links must be http(s)");
  await addLinks(ctx.db, { kind: item.kind, id: item.id }, [link], ctx.actor.id);
  return { target_id: item.id, system: link.system, url: redactFields({ u: link.url }).fields.u };
}

// ---------------------------------------------------------------------------
// Sharing

/**
 * Proposes publishing a project or team item to the Library. Library owners
 * review it; on approval the item is copied into the Library and the source
 * project starts `uses`-linking the shared copy (see review.ts).
 */
export async function shareToLibrary(ctx: RequestContext, input: { id: string; summary: string; path?: string }) {
  const item = await findItemFor(ctx, input.id);
  const library = await getScopeBySlug(ctx.db, "library");
  if (item.scope_id === library.id) throw new ValidationError("this item is already in the library");
  // Drafts can be proposed too; the share can only be approved once the item itself is approved.
  if (!["draft", "published", "possibly_stale"].includes(item.status)) throw new ValidationError(`a ${item.status} item can't be shared`);
  await assertCanPropose(ctx, item.scope_id);
  const existing = await ctx.db.query(
    "SELECT to_id FROM relations WHERE from_id = $1 AND kind = 'published_as'",
    [item.id],
  );
  if (existing.rowCount) throw new ValidationError(`already published to the library as ${existing.rows[0].to_id}`);
  const pending = await ctx.db.query("SELECT id FROM revisions WHERE target_id = $1 AND op = 'share' AND state = 'pending'", [item.id]);
  if (pending.rowCount) throw new ValidationError(`a share proposal is already pending (${pending.rows[0].id})`);
  const { fields } = redactFields({ summary: input.summary.trim(), path: (input.path ?? "").trim() });
  requireText("summary", fields.summary);
  const revisionId = await insertRevision(ctx.db, {
    targetKind: item.kind,
    targetId: item.id,
    scopeId: library.id,
    op: "share",
    baseVersion: item.version,
    payload: { path: fields.path.split("/").map((p) => p.trim()).filter(Boolean).join("/") || null },
    authorId: ctx.actor.id,
    summary: fields.summary.slice(0, LIMITS.summary),
    redactions: [],
  });
  return announce(ctx, {
    status: "pending_review" as const,
    revision_id: revisionId,
    message: "Queued for library owners. On approval a library copy is created and this project is linked to it.",
  });
}

// ---------------------------------------------------------------------------
// Verification and links

/** Days until an article's next review after someone confirms an overdue one is still accurate. */
export const REVIEW_INTERVAL_DAYS = 180;

/** Whether confirming an article also counts as its scheduled review: a person, in the app, with Review in the scope. */
async function canMoveReviewDate(ctx: RequestContext, scopeId: string): Promise<boolean> {
  return !ctx.viaAgent && (await canApprove(ctx, scopeId));
}

export async function verifyEntry(ctx: RequestContext, input: { id: string; still_valid: boolean; note?: string }) {
  const item = await findItemFor(ctx, input.id);
  await assertCanVerify(ctx, item.scope_id);
  if (item.status !== "published" && item.status !== "possibly_stale") {
    throw new ValidationError(`only published items can be verified (this one is ${item.status})`);
  }
  if (input.still_valid) {
    // A lightweight signal, applied directly: it refreshes freshness. Only a person who may review in the project,
    // confirming in the app, also moves an overdue review date on: agents (MCP), service accounts and contributors
    // confirming what they read must not silently clear the scheduled review.
    const movesReview = item.kind === "article" && (await canMoveReviewDate(ctx, item.scope_id));
    const { rows } =
      item.kind === "article"
        ? await ctx.db.query(
            `UPDATE articles SET last_verified_at = now(), status = 'published',
                    review_due = CASE WHEN $3::boolean AND review_due < current_date THEN current_date + $2::int ELSE review_due END
              WHERE id = $1 RETURNING last_verified_at, status, review_due`,
            [item.id, REVIEW_INTERVAL_DAYS, movesReview],
          )
        : await ctx.db.query(`UPDATE findings SET last_verified_at = now(), status = 'published' WHERE id = $1 RETURNING last_verified_at, status`, [item.id]);
    return {
      status: "verified" as const,
      last_verified_at: rows[0].last_verified_at,
      item_status: rows[0].status,
      ...(item.kind === "article" ? { review_due: rows[0].review_due } : {}),
    };
  }
  const note = redactFields({ note: (input.note ?? "").trim() }).fields.note;
  requireText("note (why it is no longer valid)", note);
  const revisionId = await insertRevision(ctx.db, {
    targetKind: item.kind,
    targetId: item.id,
    scopeId: item.scope_id,
    op: "verify",
    baseVersion: item.version,
    payload: { still_valid: false, note },
    authorId: ctx.actor.id,
    summary: `No longer valid: ${note}`.slice(0, LIMITS.summary),
    redactions: [],
  });
  return announce(ctx, { status: "pending_review" as const, revision_id: revisionId, message: "Queued: on approval the item is marked superseded." });
}

type Ref = { kind: "article" | "finding" | "scope" | "component"; id: string; scopeId: string };

/** "<uuid>" (article or finding), "scope:<slug>", or "component:<project>/<component>". */
async function resolveRef(ctx: RequestContext, ref: string): Promise<Ref> {
  const db = ctx.db;
  if (ref.startsWith("scope:")) {
    const s = await getReadableScope(ctx, ref.slice(6));
    return { kind: "scope", id: s.id, scopeId: s.id };
  }
  if (ref.startsWith("component:")) {
    const [project, component] = ref.slice(10).split("/");
    if (!project || !component) throw new ValidationError("component refs look like component:<project>/<component>");
    const s = await getReadableScope(ctx, project);
    const c = await getComponent(db, s.id, component);
    return { kind: "component", id: c.id, scopeId: s.id };
  }
  const item = await findItemFor(ctx, ref);
  return { kind: item.kind, id: item.id, scopeId: item.scope_id };
}

const LINK_RULES: Record<string, { from: Ref["kind"][]; to: Ref["kind"][] }> = {
  same_root_cause: { from: ["finding"], to: ["finding"] },
  related: { from: ["article", "finding"], to: ["article", "finding"] },
  supersedes: { from: ["article", "finding"], to: ["article", "finding"] },
  uses: { from: ["scope", "article", "finding"], to: ["article", "finding"] },
  depends_on: { from: ["article"], to: ["article"] },
  provided_by: { from: ["article"], to: ["component"] },
  consumed_by: { from: ["article"], to: ["component"] },
  // Lineage: a repository reads or writes a table (its table article, from a database connection's sync or written by
  // hand). Schema changes to the table then reach the repository's project as impact notices.
  reads: { from: ["component"], to: ["article"] },
  writes: { from: ["component"], to: ["article"] },
};

export const LINK_KINDS = Object.keys(LINK_RULES) as [string, ...string[]];
export const LINEAGE_KINDS = ["reads", "writes"] as const;

/** reads/writes point at a table article. */
async function assertTableArticle(ctx: RequestContext, to: Ref, relation: string) {
  const a = (await ctx.db.query<{ type: string; title: string }>("SELECT type, title FROM articles WHERE id = $1", [to.id])).rows[0];
  if (a?.type !== "table") throw new ValidationError(`'${relation}' links a repository to a table article (type table), and "${a?.title ?? to.id}" is ${a ? `a ${a.type} article` : "not an article"}`);
}

/** A lineage link added or removed, on the Audit log as the repository's event with the table it names. */
async function auditLineage(ctx: RequestContext, tool: "link_entries" | "unlink_entries", from: Ref, to: Ref, relation: string) {
  const repo = (await ctx.db.query<{ project: string; component: string }>("SELECT s.slug AS project, c.slug AS component FROM components c JOIN scopes s ON s.id = c.scope_id WHERE c.id = $1", [from.id])).rows[0];
  const table = (await ctx.db.query<{ title: string }>("SELECT title FROM articles WHERE id = $1", [to.id])).rows[0];
  await audit(ctx.db, ctx.actor.id, tool, from.id, {
    targetKind: "repository",
    targetLabel: repo ? `${repo.project}/${repo.component}` : null,
    details: { relation, table: table?.title ?? null, table_id: to.id, ...(repo ? { project: repo.project, repository: repo.component } : {}) },
  });
}

/** Typed links are low-risk metadata, so they apply directly (and are audited). */
export async function linkEntries(ctx: RequestContext, input: { from: string; to: string; relation: string }) {
  const rule = LINK_RULES[input.relation];
  if (!rule) throw new ValidationError(`unknown relation '${input.relation}'`);
  const from = await resolveRef(ctx, input.from);
  const to = await resolveRef(ctx, input.to);
  if (from.id === to.id) throw new ValidationError("cannot link an item to itself");
  if (!rule.from.includes(from.kind) || !rule.to.includes(to.kind)) {
    throw new ValidationError(`'${input.relation}' links ${rule.from.join("/")} → ${rule.to.join("/")}, not ${from.kind} → ${to.kind}`);
  }
  if (from.kind === "scope") {
    const s = (await ctx.db.query<{ kind: string }>("SELECT kind FROM scopes WHERE id = $1", [from.id])).rows[0]!;
    if (s.kind !== "project") throw new ValidationError("only projects can declare that they use an item");
  }
  if ((LINEAGE_KINDS as readonly string[]).includes(input.relation)) await assertTableArticle(ctx, to, input.relation);
  await assertCanPropose(ctx, from.scopeId);
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO relations (from_kind, from_id, kind, to_kind, to_id, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (from_id, to_id, kind) DO UPDATE SET kind = EXCLUDED.kind
     RETURNING id`,
    [from.kind, from.id, input.relation, to.kind, to.id, ctx.actor.id],
  );
  if ((LINEAGE_KINDS as readonly string[]).includes(input.relation)) await auditLineage(ctx, "link_entries", from, to, input.relation);
  return { relation_id: rows[0]!.id, from: { kind: from.kind, id: from.id }, relation: input.relation, to: { kind: to.kind, id: to.id } };
}

/**
 * Removes a lineage link (a repository reads or writes a table): the same people who may add it, Propose in the
 * repository's project. Other kinds of links aren't removed this way.
 */
export async function unlinkEntries(ctx: RequestContext, input: { from: string; to: string; relation: string }) {
  if (!(LINEAGE_KINDS as readonly string[]).includes(input.relation)) throw new ValidationError(`only ${LINEAGE_KINDS.join(" and ")} links can be removed`);
  const from = await resolveRef(ctx, input.from);
  const to = await resolveRef(ctx, input.to);
  await assertCanPropose(ctx, from.scopeId);
  const { rowCount } = await ctx.db.query("DELETE FROM relations WHERE from_id = $1 AND to_id = $2 AND kind = $3", [from.id, to.id, input.relation]);
  if (!rowCount) throw new NotFoundError(`a ${input.relation} link from ${input.from} to ${input.to}`);
  await auditLineage(ctx, "unlink_entries", from, to, input.relation);
  return { removed: true, from: { kind: from.kind, id: from.id }, relation: input.relation, to: { kind: to.kind, id: to.id } };
}

/**
 * Proposes moving an article or finding into another scope (usually a
 * project), a folder there, and/or onto one of its repositories. Reviewed
 * like any proposal; approving it needs approval rights in both scopes.
 */
export async function proposeMove(ctx: RequestContext, input: { id: string; to: string; folder?: string; repo?: string; summary?: string }) {
  const item = await findItemFor(ctx, input.id);
  assertEditable(item);
  await assertCanPropose(ctx, item.scope_id);
  const to = await getReadableScope(ctx, input.to);
  if (input.repo) {
    if (to.kind !== "project") throw new ValidationError("only projects have repositories");
    const c = await ctx.db.query("SELECT 1 FROM components WHERE scope_id = $1 AND slug = $2", [to.id, input.repo]);
    if (!c.rowCount) throw new ValidationError(`${to.slug} has no repository '${input.repo}'; its repositories are listed by get_project_context`);
  }
  if (item.kind === "finding" && input.folder) throw new ValidationError("findings have no folders; pass repo to group a finding with a repository");
  if (to.id === item.scope_id && input.folder === undefined && input.repo === undefined) throw new ValidationError(`it's already in ${to.slug}; pass a folder or repo to re-file it`);
  const pending = await ctx.db.query("SELECT id FROM revisions WHERE target_id = $1 AND op = 'move' AND state = 'pending'", [item.id]);
  if (pending.rowCount) throw new ValidationError(`a move of this ${item.kind} is already waiting for review (${pending.rows[0].id})`);
  const where = [to.name ?? to.slug, input.folder, input.repo && `repository ${input.repo}`].filter(Boolean).join(" / ");
  const summary = redactFields({ s: input.summary?.trim() || `Move "${item.title}" to ${where}` }).fields.s;
  const revisionId = await insertRevision(ctx.db, {
    targetKind: item.kind,
    targetId: item.id,
    scopeId: item.scope_id,
    op: "move",
    baseVersion: item.version,
    payload: { to: to.slug, to_name: to.name, folder: input.folder?.trim() ?? null, repo: input.repo ?? null },
    authorId: ctx.actor.id,
    summary: summary.slice(0, LIMITS.summary),
    redactions: [],
  });
  return announce(ctx, { status: "pending_review" as const, revision_id: revisionId, move: { to: to.slug, folder: input.folder ?? null, repo: input.repo ?? null } });
}

import { withTx, type Db, type Queryable } from "../db/pool.js";
import { assertClaudeMayDecide, viaDetails } from "./approvals.js";
import { audit } from "./audit.js";
import { draftFeatures, parseChangelog, readChangelog, sectionFor, type FeatureArea, type FeatureKind } from "./changelog.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { slack, track } from "./notify.js";
import { SEED_PLACEHOLDERS, SEED_RELEASES } from "./release-seed.js";
import { assertCan, can } from "./roles.js";
import { buildInfo, compareVersions, isVersion } from "./version.js";

/**
 * Release notes and the feature catalog. A release is one Thaliyola version (draft or published) with the features it
 * brought; every feature says where to find it and how to use it. Everyone signed in reads published releases (the
 * What's new page, `whats_new` and `list_features` over MCP). Administrators and people with Manage releases write
 * them, in the app only. Publishing tells everyone once, in the app.
 */

export type { FeatureArea, FeatureKind } from "./changelog.js";
export type Audience = "everyone" | "admins" | "project_admins";

/** Areas in catalog order, with the names people see. */
export const FEATURE_AREAS: Record<FeatureArea, string> = {
  knowledge: "Knowledge",
  review: "Review",
  security: "Security",
  inbox: "Inbox",
  projects: "Projects",
  people: "People and access",
  connections: "Connections",
  skills: "Skills",
  admin: "Admin",
  mcp: "Claude/MCP",
  platform: "Platform",
};
export const AREA_KEYS = Object.keys(FEATURE_AREAS) as [FeatureArea, ...FeatureArea[]];

export const FEATURE_KINDS: Record<FeatureKind, string> = { new: "New", improved: "Improved", fixed: "Fixed" };
export const KIND_KEYS = Object.keys(FEATURE_KINDS) as [FeatureKind, ...FeatureKind[]];

export const AUDIENCES: Record<Audience, string> = { everyone: "Everyone", admins: "Administrators", project_admins: "Project admins" };
export const AUDIENCE_KEYS = Object.keys(AUDIENCES) as [Audience, ...Audience[]];

const LIMITS = { title: 200, releaseTitle: 200, summary: 8000, text: 20000, route: 300, url: 500, tags: 12, tag: 40 } as const;

export interface ReleaseCounts {
  new: number;
  improved: number;
  fixed: number;
  total: number;
}

export interface Release {
  id: string;
  version: string;
  title: string;
  summary: string;
  released_on: string | null;
  status: "draft" | "published";
  source: "manual" | "changelog" | "seed";
  published_at: string | null;
  created_at: string;
  updated_at: string;
  counts: ReleaseCounts;
  features?: Feature[];
}

export interface Feature {
  id: string;
  release_id: string;
  /** The release it was added in. */
  version: string;
  release_status: "draft" | "published";
  released_on: string | null;
  title: string;
  area: FeatureArea;
  area_name: string;
  kind: FeatureKind;
  kind_name: string;
  description: string;
  how_to: string;
  app_route: string | null;
  docs_url: string | null;
  audience: Audience;
  audience_name: string;
  tags: string[];
  position: number;
  screenshots: { id: string; alt_text: string; filename: string }[];
  updated_at: string;
}

export interface FeatureInput {
  title: string;
  area: FeatureArea;
  kind?: FeatureKind;
  description?: string;
  how_to?: string;
  app_route?: string | null;
  docs_url?: string | null;
  audience?: Audience;
  tags?: string[];
}

// ---- Who may do what ------------------------------------------------------------------------------------------

/** Administrators and holders of Manage releases. */
export function canManageReleases(ctx: RequestContext): boolean {
  return can(ctx, "manage_releases");
}

/**
 * Publishing or unpublishing a written release: a decision Claude may make for someone with Manage releases while
 * "Approvals from Claude" is on (publish_release, unpublish_release). Writing releases and features stays in the app.
 */
async function assertPublish(ctx: RequestContext) {
  await assertClaudeMayDecide(ctx, "publishing release notes");
  assertCan(ctx, "manage_releases", "only Administrators and people with Manage releases publish release notes");
}

function assertManage(ctx: RequestContext) {
  // Release notes are written by people in the app; Claude reads them (whats_new, list_features).
  if (ctx.viaAgent) throw new ForbiddenError("releases and features are written on the What's new page in the app, not through Claude");
  assertCan(ctx, "manage_releases", "only Administrators and people with Manage releases write release notes");
}

// ---- Cleaning input ----------------------------------------------------------------------------------------------

function text(value: string | undefined | null, max: number, what: string): string {
  const v = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (v.length > max) throw new ValidationError(`${what} is at most ${max} characters`);
  return v;
}

function cleanVersion(v: string): string {
  const s = String(v ?? "").trim().replace(/^v/i, "");
  if (!isVersion(s)) throw new ValidationError(`'${v}' is not a version: use major.minor.patch, e.g. 1.2.0`);
  return s;
}

/**
 * "#/admin/audit"; "/admin/audit" and "admin/audit" become that too. Anything else is refused, not rewritten: an
 * address with a scheme ("https://…", "javascript:…") belongs in the docs link.
 */
export function cleanRoute(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const refuse = () => new ValidationError("the in-app link is a route like #/admin/audit");
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || !/^#?\/?[a-z]/i.test(s)) throw refuse();
  const route = `#/${s.replace(/^#?\/?/, "")}`;
  if (route.length > LIMITS.route || /\s/.test(route)) throw refuse();
  return route;
}

/** An http(s) address, with its scheme in lower case ("HTTPS://…" → "https://…"). */
function cleanUrl(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = /^(https?):\/\/(\S+)$/i.exec(s);
  if (s.length > LIMITS.url || !m) throw new ValidationError("the docs link must be an http(s) address");
  return `${m[1]!.toLowerCase()}://${m[2]!}`;
}

function cleanTags(tags: string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const tag = String(t).trim().toLowerCase().replace(/\s+/g, "-");
    if (!tag) continue;
    if (tag.length > LIMITS.tag) throw new ValidationError(`a tag is at most ${LIMITS.tag} characters`);
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > LIMITS.tags) throw new ValidationError(`a feature has at most ${LIMITS.tags} tags`);
  return out;
}

function cleanDate(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new ValidationError("the release date is YYYY-MM-DD");
  return s;
}

function cleanFeature(input: FeatureInput) {
  const title = text(input.title, LIMITS.title, "a feature's title");
  if (!title) throw new ValidationError("give the feature a title");
  if (!(input.area in FEATURE_AREAS)) throw new ValidationError(`area is one of ${AREA_KEYS.join(", ")}`);
  const kind = input.kind ?? "new";
  if (!(kind in FEATURE_KINDS)) throw new ValidationError(`kind is one of ${KIND_KEYS.join(", ")}`);
  const audience = input.audience ?? "everyone";
  if (!(audience in AUDIENCES)) throw new ValidationError(`audience is one of ${AUDIENCE_KEYS.join(", ")}`);
  return {
    title,
    area: input.area,
    kind,
    description: text(input.description, LIMITS.text, "the description"),
    how_to: text(input.how_to, LIMITS.text, "“How to use it”"),
    app_route: cleanRoute(input.app_route),
    docs_url: cleanUrl(input.docs_url),
    audience,
    tags: cleanTags(input.tags),
  };
}

// ---- Reading ---------------------------------------------------------------------------------------------------

const BY_VERSION_DESC = "string_to_array(r.version, '.')::int[] DESC";

const RELEASE_COLUMNS = `r.id, r.version, r.title, r.summary, to_char(r.released_on, 'YYYY-MM-DD') AS released_on, r.status, r.source,
  r.published_at, r.created_at, r.updated_at,
  json_build_object(
    'new', count(f.id) FILTER (WHERE f.kind = 'new'), 'improved', count(f.id) FILTER (WHERE f.kind = 'improved'),
    'fixed', count(f.id) FILTER (WHERE f.kind = 'fixed'), 'total', count(f.id)) AS counts`;

const FEATURE_COLUMNS = `f.id, f.release_id, r.version, r.status AS release_status, to_char(r.released_on, 'YYYY-MM-DD') AS released_on,
  f.title, f.area, f.kind, f.description, f.how_to, f.app_route, f.docs_url, f.audience, f.tags, f.position, f.updated_at,
  coalesce((SELECT json_agg(json_build_object('id', a.id, 'alt_text', a.alt_text, 'filename', a.filename) ORDER BY a.created_at)
              FROM assets a WHERE a.target_id = f.id AND a.target_kind = 'feature' AND a.deleted_at IS NULL), '[]'::json) AS screenshots`;

type FeatureRow = Omit<Feature, "area_name" | "kind_name" | "audience_name">;

const named = (f: FeatureRow): Feature => ({ ...f, area_name: FEATURE_AREAS[f.area], kind_name: FEATURE_KINDS[f.kind], audience_name: AUDIENCES[f.audience] });

/** Catalog order: by area, then newest release first, then the release's own order. */
const areaOrder = (a: FeatureArea) => AREA_KEYS.indexOf(a);

async function featuresOf(db: Queryable, releaseIds: string[]): Promise<Feature[]> {
  if (!releaseIds.length) return [];
  const { rows } = await db.query<FeatureRow>(
    `SELECT ${FEATURE_COLUMNS} FROM features f JOIN releases r ON r.id = f.release_id WHERE f.release_id = ANY($1::uuid[]) ORDER BY f.position, f.created_at`,
    [releaseIds],
  );
  return rows.map(named);
}

async function releaseRows(db: Queryable, where: string, params: unknown[], limit?: number): Promise<Release[]> {
  const { rows } = await db.query<Release>(
    `SELECT ${RELEASE_COLUMNS} FROM releases r LEFT JOIN features f ON f.release_id = r.id
      ${where ? `WHERE ${where}` : ""} GROUP BY r.id ORDER BY ${BY_VERSION_DESC}${limit ? ` LIMIT ${limit}` : ""}`,
    params,
  );
  return rows;
}

async function withFeatures(db: Queryable, releases: Release[]): Promise<Release[]> {
  const features = await featuresOf(
    db,
    releases.map((r) => r.id),
  );
  return releases.map((r) => ({ ...r, features: features.filter((f) => f.release_id === r.id) }));
}

/** Every release the caller may read (managers also see drafts), newest version first, with counts. */
export async function listReleases(ctx: RequestContext, opts: { features?: boolean } = {}): Promise<{ releases: Release[]; can_manage: boolean; current: ReturnType<typeof buildInfo> }> {
  const manage = canManageReleases(ctx);
  const releases = await releaseRows(ctx.db, manage ? "" : "r.status = 'published'", []);
  return { releases: opts.features ? await withFeatures(ctx.db, releases) : releases, can_manage: manage, current: buildInfo() };
}

/** One release with its features. A draft is "not found" for people who can't manage releases. */
export async function getRelease(ctx: RequestContext, version: string): Promise<Release> {
  const v = cleanVersion(version);
  const manage = canManageReleases(ctx);
  const [release] = await releaseRows(ctx.db, `r.version = $1${manage ? "" : " AND r.status = 'published'"}`, [v]);
  if (!release) throw new NotFoundError(`release ${v}`);
  return (await withFeatures(ctx.db, [release]))[0]!;
}

/** The newest published release with its features, or null before the first one. */
export async function latestRelease(db: Queryable): Promise<Release | null> {
  const [release] = await releaseRows(db, "r.status = 'published'", [], 1);
  return release ? (await withFeatures(db, [release]))[0]! : null;
}

/**
 * What changed: every published release newer than `since` (oldest first, so they read in order), or the newest one
 * alone without `since`. With the running version and how many features each brought.
 */
export async function whatsNew(ctx: RequestContext, since?: string): Promise<{ current_version: string; since: string | null; releases: Release[]; note?: string }> {
  const current = buildInfo().version;
  if (since === undefined || since === null || String(since).trim() === "") {
    const latest = await latestRelease(ctx.db);
    return { current_version: current, since: null, releases: latest ? [latest] : [], ...(latest ? {} : { note: "No release notes have been published yet." }) };
  }
  const v = cleanVersion(since);
  const releases = (await releaseRows(ctx.db, "r.status = 'published' AND string_to_array(r.version, '.')::int[] > string_to_array($1, '.')::int[]", [v])).reverse();
  return {
    current_version: current,
    since: v,
    releases: await withFeatures(ctx.db, releases),
    ...(releases.length ? {} : { note: `Nothing has been published after ${v}.` }),
  };
}

/**
 * The feature catalog: every feature of every published release (managers may add drafts), by area. `query` matches
 * all its words in the title, description, how-to and tags.
 */
export async function listFeatures(
  ctx: RequestContext,
  opts: { area?: FeatureArea; kind?: FeatureKind; query?: string; drafts?: boolean; limit?: number } = {},
): Promise<{ features: Feature[]; areas: { key: FeatureArea; name: string; count: number }[]; total: number }> {
  if (opts.area && !(opts.area in FEATURE_AREAS)) throw new ValidationError(`area is one of ${AREA_KEYS.join(", ")}`);
  if (opts.kind && !(opts.kind in FEATURE_KINDS)) throw new ValidationError(`kind is one of ${KIND_KEYS.join(", ")}`);
  const drafts = !!opts.drafts && canManageReleases(ctx);
  const where: string[] = [drafts ? "true" : "r.status = 'published'"];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (opts.kind) where.push(`f.kind = ${p(opts.kind)}`);
  const words = String(opts.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[%_\\]/g, "\\$&"))
    .filter(Boolean)
    .slice(0, 8);
  for (const w of words) {
    const like = p(`%${w}%`);
    where.push(`(f.title ILIKE ${like} OR f.description ILIKE ${like} OR f.how_to ILIKE ${like} OR array_to_string(f.tags, ' ') ILIKE ${like} OR f.area ILIKE ${like})`);
  }
  const { rows } = await ctx.db.query<FeatureRow>(`SELECT ${FEATURE_COLUMNS} FROM features f JOIN releases r ON r.id = f.release_id WHERE ${where.join(" AND ")}`, params);
  const all = rows.map(named).sort((a, b) => areaOrder(a.area) - areaOrder(b.area) || compareVersions(b.version, a.version) || a.position - b.position);
  const areas = AREA_KEYS.map((key) => ({ key, name: FEATURE_AREAS[key], count: all.filter((f) => f.area === key).length })).filter((a) => a.count > 0);
  const shown = opts.area ? all.filter((f) => f.area === opts.area) : all;
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 500));
  return { features: shown.slice(0, limit), areas, total: shown.length };
}

// ---- "What's new" per person ---------------------------------------------------------------------------------------

export interface WhatsNewStatus {
  latest: { version: string; title: string; features: number } | null;
  last_seen: string | null;
  /** A published release newer than the last one this person saw: the dot in the Help menu. */
  unseen: boolean;
}

export async function whatsNewStatus(db: Queryable, userId: string): Promise<WhatsNewStatus> {
  const { rows } = await db.query<{ version: string | null; title: string | null; features: number | null; last_seen: string | null }>(
    `SELECT r.version, r.title, (SELECT count(*)::int FROM features f WHERE f.release_id = r.id) AS features, u.last_seen_release AS last_seen
       FROM users u
       LEFT JOIN LATERAL (SELECT * FROM releases r WHERE r.status = 'published' ORDER BY ${BY_VERSION_DESC} LIMIT 1) r ON true
      WHERE u.id = $1`,
    [userId],
  );
  const row = rows[0];
  const lastSeen = row?.last_seen ?? null;
  if (!row?.version) return { latest: null, last_seen: lastSeen, unseen: false };
  return { latest: { version: row.version, title: row.title ?? "", features: row.features ?? 0 }, last_seen: lastSeen, unseen: !lastSeen || compareVersions(row.version, lastSeen) > 0 };
}

/** Marks the newest published release (or `version`, if newer than what they saw) as seen. Never moves back. */
export async function markReleasesSeen(ctx: RequestContext, version?: string): Promise<WhatsNewStatus> {
  let v: string | null = null;
  if (version) {
    v = cleanVersion(version);
    const ok = await ctx.db.query("SELECT 1 FROM releases WHERE version = $1 AND status = 'published'", [v]);
    if (!ok.rowCount) throw new NotFoundError(`release ${v}`);
  } else {
    v = (await whatsNewStatus(ctx.db, ctx.actor.id)).latest?.version ?? null;
  }
  if (v) {
    await ctx.db.query(
      `UPDATE users SET last_seen_release = $2
        WHERE id = $1 AND (last_seen_release IS NULL OR last_seen_release !~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'
                           OR string_to_array(last_seen_release, '.')::int[] < string_to_array($2, '.')::int[])`,
      [ctx.actor.id, v],
    );
  }
  return whatsNewStatus(ctx.db, ctx.actor.id);
}

// ---- Writing releases ------------------------------------------------------------------------------------------------

async function releaseId(db: Queryable, version: string): Promise<{ id: string; version: string; status: string; title: string }> {
  const row = (await db.query<{ id: string; version: string; status: string; title: string }>("SELECT id, version, status, title FROM releases WHERE version = $1", [cleanVersion(version)])).rows[0];
  if (!row) throw new NotFoundError(`release ${cleanVersion(version)}`);
  return row;
}

const releaseLabel = (version: string) => `Thaliyola ${version}`;

function uniqueVersion(err: unknown, version: string): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === "23505") throw new ValidationError(`there is already a release ${version}`);
  throw err;
}

export async function createRelease(ctx: RequestContext, input: { version: string; title?: string; summary?: string; released_on?: string | null }): Promise<Release> {
  assertManage(ctx);
  const version = cleanVersion(input.version);
  const title = text(input.title, LIMITS.releaseTitle, "the release title");
  const summary = text(input.summary, LIMITS.summary, "the summary");
  const releasedOn = cleanDate(input.released_on);
  const id = await ctx.db
    .query<{ id: string }>("INSERT INTO releases (version, title, summary, released_on, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id", [
      version,
      title,
      summary,
      releasedOn,
      ctx.actor.id,
    ])
    .then((r) => r.rows[0]!.id)
    .catch((err) => uniqueVersion(err, version));
  await audit(ctx.db, ctx.actor.id, "create_release", id, { targetKind: "release", targetLabel: releaseLabel(version), details: { version, title, released_on: releasedOn } });
  ctx.onWrite?.();
  return getRelease(ctx, version);
}

/** Changes a release's version, title, summary or date (drafts and published ones alike). */
export async function updateRelease(
  ctx: RequestContext,
  version: string,
  patch: { version?: string; title?: string; summary?: string; released_on?: string | null },
): Promise<Release> {
  assertManage(ctx);
  const before = (
    await ctx.db.query<{ id: string; version: string; title: string; summary: string; released_on: string | null }>(
      "SELECT id, version, title, summary, to_char(released_on, 'YYYY-MM-DD') AS released_on FROM releases WHERE version = $1",
      [cleanVersion(version)],
    )
  ).rows[0];
  if (!before) throw new NotFoundError(`release ${cleanVersion(version)}`);
  const next = {
    version: patch.version === undefined ? before.version : cleanVersion(patch.version),
    title: patch.title === undefined ? before.title : text(patch.title, LIMITS.releaseTitle, "the release title"),
    summary: patch.summary === undefined ? before.summary : text(patch.summary, LIMITS.summary, "the summary"),
    released_on: patch.released_on === undefined ? before.released_on : cleanDate(patch.released_on),
  };
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of ["version", "title", "released_on"] as const) if (before[k] !== next[k]) changed[k] = { from: before[k], to: next[k] };
  if (before.summary !== next.summary) changed.summary = { from: `${before.summary.length} characters`, to: `${next.summary.length} characters` };
  if (!Object.keys(changed).length) return getRelease(ctx, before.version);
  await ctx.db
    .query("UPDATE releases SET version = $2, title = $3, summary = $4, released_on = $5, updated_at = now() WHERE id = $1", [
      before.id,
      next.version,
      next.title,
      next.summary,
      next.released_on,
    ])
    .catch((err) => uniqueVersion(err, next.version));
  await audit(ctx.db, ctx.actor.id, "update_release", before.id, { targetKind: "release", targetLabel: releaseLabel(next.version), details: { version: next.version, changed } });
  ctx.onWrite?.();
  return getRelease(ctx, next.version);
}

/** "12 new features", "5 new features, 3 improvements and 2 fixes". */
export function countsText(c: Pick<ReleaseCounts, "new" | "improved" | "fixed">): string {
  const parts = [
    c.new ? `${c.new} new feature${c.new === 1 ? "" : "s"}` : "",
    c.improved ? `${c.improved} improvement${c.improved === 1 ? "" : "s"}` : "",
    c.fixed ? `${c.fixed} fix${c.fixed === 1 ? "" : "es"}` : "",
  ].filter(Boolean);
  if (!parts.length) return "release notes";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * Publishes a release: everyone reads it, and the first time it's published everyone signed in (but the publisher)
 * gets one notification in the app, "Thaliyola 1.0.0: 12 new features", and the Help menu's What's new dot.
 */
export async function publishRelease(ctx: RequestContext, version: string): Promise<Release & { notified: number }> {
  await assertPublish(ctx);
  const r = await releaseId(ctx.db, version);
  const notified = await withTx(ctx.db, async (tx) => {
    const row = (
      await tx.query<{ status: string; notified_at: Date | null; title: string; summary: string }>(
        "SELECT status, notified_at, title, summary FROM releases WHERE id = $1 FOR UPDATE",
        [r.id],
      )
    ).rows[0]!;
    const counts = (
      await tx.query<ReleaseCounts>(
        `SELECT count(*) FILTER (WHERE kind = 'new')::int AS new, count(*) FILTER (WHERE kind = 'improved')::int AS improved,
                count(*) FILTER (WHERE kind = 'fixed')::int AS fixed, count(*)::int AS total FROM features WHERE release_id = $1`,
        [r.id],
      )
    ).rows[0]!;
    if (!counts.total) throw new ValidationError("add at least one feature before publishing the release");
    if (row.status === "published") return null;
    await tx.query(
      `UPDATE releases SET status = 'published', published_at = coalesce(published_at, now()), published_by = coalesce(published_by, $2),
              released_on = coalesce(released_on, current_date), notified_at = coalesce(notified_at, now()), updated_at = now() WHERE id = $1`,
      [r.id, ctx.actor.id],
    );
    let n = 0;
    if (!row.notified_at) {
      const title = `${releaseLabel(r.version)}: ${countsText(counts)}`;
      const body = row.title || row.summary.split("\n")[0]!.slice(0, 300) || "See what's new and how to use it.";
      // Everyone signed in, in one statement (an organisation can be large); in the app only, no email.
      const res = await tx.query(
        `INSERT INTO notifications (user_id, kind, title, body, link, target_id)
         SELECT u.id, 'release', $2, $3, $4, $5 FROM users u
          WHERE u.kind = 'human' AND u.disabled_at IS NULL AND u.approved_at IS NOT NULL AND u.id <> $1`,
        [ctx.actor.id, title.slice(0, 300), body.slice(0, 2000), `#/whats-new?tab=releases&release=${r.version}`, r.id],
      );
      n = res.rowCount ?? 0;
      slack(ctx.settings, `:tada: *${title}*${row.title ? `: ${row.title}` : ""}`, `#/whats-new?tab=releases&release=${r.version}`);
    }
    return { n, counts };
  });
  if (notified) {
    await audit(ctx.db, ctx.actor.id, "publish_release", r.id, {
      targetKind: "release",
      targetLabel: releaseLabel(r.version),
      details: { version: r.version, features: notified.counts.total, notified: notified.n, ...viaDetails(ctx) },
    });
    ctx.onWrite?.();
  }
  return { ...(await getRelease(ctx, r.version)), notified: notified?.n ?? 0 };
}

/** Back to a draft: hidden from everyone but release managers. Publishing it again notifies nobody. */
export async function unpublishRelease(ctx: RequestContext, version: string): Promise<Release> {
  await assertPublish(ctx);
  const r = await releaseId(ctx.db, version);
  if (r.status === "published") {
    await ctx.db.query("UPDATE releases SET status = 'draft', updated_at = now() WHERE id = $1", [r.id]);
    await audit(ctx.db, ctx.actor.id, "unpublish_release", r.id, { targetKind: "release", targetLabel: releaseLabel(r.version), details: { version: r.version, ...viaDetails(ctx) } });
    ctx.onWrite?.();
  }
  return getRelease(ctx, r.version);
}

/** Deletes a draft release and its features. Published releases are unpublished first. */
export async function deleteRelease(ctx: RequestContext, version: string): Promise<{ deleted: true; version: string; features: number }> {
  assertManage(ctx);
  const r = await releaseId(ctx.db, version);
  if (r.status === "published") throw new ValidationError("unpublish the release before deleting it");
  const features = await withTx(ctx.db, async (tx) => {
    const ids = (await tx.query<{ id: string }>("SELECT id FROM features WHERE release_id = $1", [r.id])).rows.map((x) => x.id);
    if (ids.length) await tx.query("UPDATE assets SET deleted_at = now() WHERE target_kind = 'feature' AND target_id = ANY($1::uuid[]) AND deleted_at IS NULL", [ids]);
    await tx.query("DELETE FROM releases WHERE id = $1", [r.id]);
    return ids.length;
  });
  await audit(ctx.db, ctx.actor.id, "delete_release", r.id, { targetKind: "release", targetLabel: releaseLabel(r.version), details: { version: r.version, title: r.title, features } });
  ctx.onWrite?.();
  return { deleted: true, version: r.version, features };
}

// ---- Writing features ---------------------------------------------------------------------------------------------

async function getFeature(db: Queryable, id: string): Promise<Feature> {
  const row = (await db.query<FeatureRow>(`SELECT ${FEATURE_COLUMNS} FROM features f JOIN releases r ON r.id = f.release_id WHERE f.id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError("feature");
  return named(row);
}

/** A feature as the caller may see it: drafts' features only for release managers. */
export async function readFeature(ctx: RequestContext, id: string): Promise<Feature> {
  const f = await getFeature(ctx.db, id);
  if (f.release_status !== "published" && !canManageReleases(ctx)) throw new NotFoundError("feature");
  return f;
}

export async function addFeature(ctx: RequestContext, version: string, input: FeatureInput): Promise<Feature> {
  assertManage(ctx);
  const r = await releaseId(ctx.db, version);
  const f = cleanFeature(input);
  const id = await withTx(ctx.db, async (tx) => {
    await tx.query("SELECT 1 FROM releases WHERE id = $1 FOR UPDATE", [r.id]);
    const position = (await tx.query<{ n: number }>("SELECT coalesce(max(position) + 1, 0)::int AS n FROM features WHERE release_id = $1", [r.id])).rows[0]!.n;
    return (
      await tx.query<{ id: string }>(
        `INSERT INTO features (release_id, title, area, kind, description, how_to, app_route, docs_url, audience, tags, position, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [r.id, f.title, f.area, f.kind, f.description, f.how_to, f.app_route, f.docs_url, f.audience, f.tags, position, ctx.actor.id],
      )
    ).rows[0]!.id;
  });
  await audit(ctx.db, ctx.actor.id, "create_feature", id, { targetKind: "feature", targetLabel: f.title, details: { release: r.version, title: f.title, area: f.area, kind: f.kind } });
  await ctx.db.query("UPDATE releases SET updated_at = now() WHERE id = $1", [r.id]);
  ctx.onWrite?.();
  return getFeature(ctx.db, id);
}

/** Changes a feature; `release` moves it to another release (to the end of that one's list). */
export async function updateFeature(ctx: RequestContext, id: string, patch: Partial<FeatureInput> & { release?: string }): Promise<Feature> {
  assertManage(ctx);
  const before = await getFeature(ctx.db, id);
  const f = cleanFeature({
    title: patch.title ?? before.title,
    area: patch.area ?? before.area,
    kind: patch.kind ?? before.kind,
    description: patch.description ?? before.description,
    how_to: patch.how_to ?? before.how_to,
    app_route: patch.app_route === undefined ? before.app_route : patch.app_route,
    docs_url: patch.docs_url === undefined ? before.docs_url : patch.docs_url,
    audience: patch.audience ?? before.audience,
    tags: patch.tags ?? before.tags,
  });
  const target = patch.release !== undefined && cleanVersion(patch.release) !== before.version ? await releaseId(ctx.db, patch.release) : null;
  const changed: Record<string, unknown> = {};
  for (const k of ["title", "area", "kind", "app_route", "docs_url", "audience"] as const) if (before[k] !== f[k]) changed[k] = { from: before[k], to: f[k] };
  if (before.description !== f.description) changed.description = "edited";
  if (before.how_to !== f.how_to) changed.how_to = "edited";
  if (before.tags.join(",") !== f.tags.join(",")) changed.tags = { from: before.tags, to: f.tags };
  if (target) changed.release = { from: before.version, to: target.version };
  if (!Object.keys(changed).length) return before;
  await withTx(ctx.db, async (tx) => {
    const position = target
      ? (await tx.query<{ n: number }>("SELECT coalesce(max(position) + 1, 0)::int AS n FROM features WHERE release_id = $1", [target.id])).rows[0]!.n
      : before.position;
    await tx.query(
      `UPDATE features SET release_id = $2, title = $3, area = $4, kind = $5, description = $6, how_to = $7, app_route = $8, docs_url = $9,
              audience = $10, tags = $11, position = $12, updated_at = now() WHERE id = $1`,
      [id, target?.id ?? before.release_id, f.title, f.area, f.kind, f.description, f.how_to, f.app_route, f.docs_url, f.audience, f.tags, position],
    );
  });
  await audit(ctx.db, ctx.actor.id, "update_feature", id, { targetKind: "feature", targetLabel: f.title, details: { release: target?.version ?? before.version, changed } });
  ctx.onWrite?.();
  return getFeature(ctx.db, id);
}

export async function deleteFeature(ctx: RequestContext, id: string): Promise<{ deleted: true; id: string }> {
  assertManage(ctx);
  const f = await getFeature(ctx.db, id);
  await withTx(ctx.db, async (tx) => {
    await tx.query("UPDATE assets SET deleted_at = now() WHERE target_kind = 'feature' AND target_id = $1 AND deleted_at IS NULL", [id]);
    await tx.query("DELETE FROM features WHERE id = $1", [id]);
  });
  await audit(ctx.db, ctx.actor.id, "delete_feature", id, { targetKind: "feature", targetLabel: f.title, details: { release: f.version, title: f.title } });
  ctx.onWrite?.();
  return { deleted: true, id };
}

/** Puts a release's features in this order. `ids` must be exactly its features. */
export async function reorderFeatures(ctx: RequestContext, version: string, ids: string[]): Promise<Release> {
  assertManage(ctx);
  const r = await releaseId(ctx.db, version);
  await withTx(ctx.db, async (tx) => {
    const mine = (await tx.query<{ id: string }>("SELECT id FROM features WHERE release_id = $1 FOR UPDATE", [r.id])).rows.map((x) => x.id);
    if (ids.length !== mine.length || new Set(ids).size !== ids.length || ids.some((id) => !mine.includes(id))) {
      throw new ValidationError(`pass every feature of ${r.version} once, in the new order`);
    }
    await tx.query("UPDATE features f SET position = o.i - 1, updated_at = now() FROM unnest($1::uuid[]) WITH ORDINALITY AS o(id, i) WHERE f.id = o.id", [ids]);
  });
  await audit(ctx.db, ctx.actor.id, "reorder_features", r.id, { targetKind: "release", targetLabel: releaseLabel(r.version), details: { version: r.version, features: ids.length } });
  ctx.onWrite?.();
  return getRelease(ctx, r.version);
}

/** For asset uploads and removal: a feature exists and the caller may change it. */
export async function assertCanEditFeature(ctx: RequestContext, id: string): Promise<{ id: string; title: string }> {
  assertManage(ctx);
  const f = await getFeature(ctx.db, id);
  return { id: f.id, title: f.title };
}

// ---- The starting catalog and drafts from CHANGELOG.md -------------------------------------------------------------

const LOCK = "thaliyola:releases";

async function insertRelease(
  tx: Queryable,
  r: { version: string; title: string; summary: string; released_on: string | null; status: "draft" | "published"; source: "changelog" | "seed" },
  features: (FeatureInput & { kind: FeatureKind })[],
): Promise<string | null> {
  const id = (
    await tx.query<{ id: string }>(
      `INSERT INTO releases (version, title, summary, released_on, status, source, published_at, notified_at)
       VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $5 = 'published' THEN now() END, CASE WHEN $5 = 'published' THEN now() END)
       ON CONFLICT (version) DO NOTHING RETURNING id`,
      [r.version, r.title.slice(0, LIMITS.releaseTitle), r.summary.slice(0, LIMITS.summary), r.released_on, r.status, r.source],
    )
  ).rows[0]?.id;
  if (!id) return null;
  await insertFeatures(tx, id, features, 0);
  return id;
}

/** Writes features into a release from `position` on, in order. */
async function insertFeatures(tx: Queryable, releaseId: string, features: (FeatureInput & { kind: FeatureKind })[], position: number) {
  for (const input of features) {
    const f = cleanFeature({ ...input, title: input.title.slice(0, LIMITS.title), description: input.description?.slice(0, LIMITS.text) });
    await tx.query(
      `INSERT INTO features (release_id, title, area, kind, description, how_to, app_route, docs_url, audience, tags, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [releaseId, f.title, f.area, f.kind, f.description, f.how_to, f.app_route, f.docs_url, f.audience, f.tags, position++],
    );
  }
}

/**
 * A database seeded before a placeholder was written (the 1.0.0 draft's Skills, until Skills merged) gets the real
 * features in its place, at the placeholder's position, and loses the summary's "fill this in" note. It acts only
 * while the placeholder is there, and skips features the release already has by title, so it runs on every start
 * and never duplicates; an admin who already deleted or rewrote the placeholder is left alone.
 */
export async function fillSeedPlaceholders(db: Queryable): Promise<number> {
  let added = 0;
  for (const p of SEED_PLACEHOLDERS) {
    const seed = SEED_RELEASES.find((r) => r.version === p.version);
    if (!seed) continue;
    const placeholder = (
      await db.query<{ id: string; release_id: string; position: number }>(
        `SELECT f.id, f.release_id, f.position FROM features f JOIN releases r ON r.id = f.release_id
          WHERE r.version = $1 AND f.title = $2 AND f.area = $3 AND 'placeholder' = ANY (f.tags)
          ORDER BY f.position LIMIT 1 FOR UPDATE OF f`,
        [p.version, p.title, p.area],
      )
    ).rows[0];
    if (!placeholder) continue;
    const have = new Set((await db.query<{ title: string }>("SELECT title FROM features WHERE release_id = $1", [placeholder.release_id])).rows.map((r) => r.title));
    const features = seed.features.filter((f) => p.replacedBy.includes(f.title) && !have.has(f.title));
    // Make room after the placeholder for all but one of them (the first takes the placeholder's own position).
    if (features.length > 1) {
      await db.query("UPDATE features SET position = position + $3 WHERE release_id = $1 AND position > $2", [placeholder.release_id, placeholder.position, features.length - 1]);
    }
    await db.query("DELETE FROM features WHERE id = $1", [placeholder.id]);
    await insertFeatures(db, placeholder.release_id, features, placeholder.position);
    await db.query("UPDATE releases SET summary = replace(summary, $2, ''), updated_at = now() WHERE id = $1", [placeholder.release_id, p.summaryNote]);
    await audit(db, null, "update_release", placeholder.release_id, {
      targetKind: "release",
      targetLabel: releaseLabel(p.version),
      details: { version: p.version, replaced_placeholder: p.title, features: features.map((f) => f.title) },
    });
    added += features.length;
  }
  return added;
}

/**
 * A draft for `version` from its CHANGELOG.md section (or "Unreleased"), one feature per bullet, the first time this
 * version runs. It's made once: a version that has a release, or had a draft made for it before (one an admin has
 * since deleted or renamed), is left alone, so it can run on every start.
 */
export async function autoDraftRelease(db: Queryable, version: string, changelog: string | null): Promise<{ created: boolean; version: string; features: number; from: string | null }> {
  const none = { created: false, version, features: 0, from: null };
  if (!isVersion(version)) return none;
  const known = await db.query("SELECT 1 FROM releases WHERE version = $1 UNION ALL SELECT 1 FROM release_autodrafts WHERE version = $1", [version]);
  if (known.rowCount) return none;
  const section = changelog ? sectionFor(parseChangelog(changelog), version) : null;
  const features = section ? draftFeatures(section) : [];
  const id = await insertRelease(
    db,
    { version, title: releaseLabel(version), summary: section?.summary ?? "", released_on: section?.date ?? null, status: "draft", source: "changelog" },
    features,
  );
  if (!id) return none;
  await db.query("INSERT INTO release_autodrafts (version) VALUES ($1) ON CONFLICT DO NOTHING", [version]);
  await audit(db, null, "draft_release", id, { targetKind: "release", targetLabel: releaseLabel(version), details: { version, features: features.length, from: section?.heading ?? null } });
  return { created: true, version, features: features.length, from: section?.heading ?? null };
}

/**
 * The releases that existed before release notes did (0.9.0, and 1.0.0 as a draft), written once into empty tables.
 * Everyone already here has seen the published ones (they use those features), so What's new only lights up for
 * what comes next.
 */
export async function seedReleases(db: Queryable, runningVersion: string): Promise<number> {
  const n = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM releases")).rows[0]!.n;
  if (n > 0) return 0;
  let created = 0;
  let newestPublished: string | null = null;
  for (const r of SEED_RELEASES) {
    // A release the running version is already past is history: published (without a notification). One with
    // placeholders stays a draft until someone fills them in.
    const status = r.status === "draft" && !r.placeholders && compareVersions(runningVersion, r.version) > 0 ? "published" : r.status;
    if (await insertRelease(db, { ...r, status }, r.features)) created++;
    await db.query("INSERT INTO release_autodrafts (version) VALUES ($1) ON CONFLICT DO NOTHING", [r.version]);
    if (status === "published" && (!newestPublished || compareVersions(r.version, newestPublished) > 0)) newestPublished = r.version;
  }
  if (created && newestPublished) {
    await db.query("UPDATE users SET last_seen_release = $1 WHERE last_seen_release IS NULL AND kind = 'human'", [newestPublished]);
  }
  return created;
}

/**
 * On start (every replica; one at a time): fill the empty catalog (or swap the placeholders an earlier one left for
 * their features), then draft the running version from CHANGELOG.md if it has no release yet.
 */
export async function ensureReleaseCatalog(
  db: Db,
  opts: { version?: string; changelog?: string | null } = {},
): Promise<{ seeded: number; filled: number; draft: Awaited<ReturnType<typeof autoDraftRelease>> }> {
  const version = opts.version ?? buildInfo().version;
  const changelog = opts.changelog === undefined ? readChangelog() : opts.changelog;
  return withTx(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [LOCK]);
    const seeded = await seedReleases(tx, version);
    const filled = await fillSeedPlaceholders(tx);
    const draft = await autoDraftRelease(tx, version, changelog);
    return { seeded, filled, draft };
  });
}

/** Keeps a background promise visible to shutdown (flushDeliveries). */
export function startReleaseCatalog(db: Db, log: (msg: string) => void) {
  return track(
    ensureReleaseCatalog(db)
      .then((r) => {
        if (r.seeded) log(`release notes: added the starting catalog (${r.seeded} releases)`);
        if (r.filled) log(`release notes: filled in the starting catalog's placeholders (${r.filled} features)`);
        if (r.draft.created) log(`release notes: drafted ${r.draft.version} from CHANGELOG.md (${r.draft.from ?? "no section"}, ${r.draft.features} features)`);
      })
      .catch((err) => log(`release notes: ${(err as Error).message}`)),
  );
}

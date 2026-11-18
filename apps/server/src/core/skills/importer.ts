import { withTx, type Queryable } from "../../db/pool.js";
import { audit } from "../audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { can, canReadScope } from "../permissions.js";
import { redact } from "../redaction.js";
import { ownerRights, skillByName, type SkillRow } from "./access.js";
import { ArchiveError, readArchive, type TreeEntry, type VirtualTree } from "./archive.js";
import { audienceGain } from "./assignments.js";
import { notifySuperseded } from "./catalog.js";
import { detectLayout, skillNameOf, type Layout, type PluginInfo, type SkillDirRef } from "./layout.js";
import { peopleWith, tellSkill } from "./notify.js";
import { baseInfo, insertVersion, prepareSkill, type PreparedSkill } from "./prepare.js";
import { applyStamp, guidanceOnly, planStamp, SyncError } from "./stamp.js";
import { cleanGlobs, contentHash, IMPORTER_VERSION, matchesGlob, sha256, SKILL_LIMITS, textOf, type SkillFile } from "./types.js";

/**
 * Imports skills from an archive (a repository's tarball through the GitLab or GitHub API, or an upload): read it in
 * memory, stamp the shared core/ guidance exactly like the repo's ci/sync_core.py, find the skills (marketplace,
 * plugin, plain, folder or single layout), validate and scan each one, and compare with what Thaliyola has:
 * - new skills arrive as pending version 1 (always reviewed);
 * - changed skills get a new version, pending unless the source may publish directly (never for new skills, high-risk
 *   flags, held or detached skills);
 * - content a reviewer rejected before isn't proposed again (unless forced);
 * - skills gone from the source are retired (their assignments stay), behind a guard against wiping a source;
 * - moving to another plugin keeps the skill and its own assignments; a move that gives it to more people waits for
 *   review.
 * All writes of one run happen in one transaction. A dry run does everything but write.
 */

export interface SourceRow {
  id: string;
  name: string;
  kind: "git" | "upload";
  provider: "gitlab" | "github" | null;
  connection_id: string | null;
  api_url: string | null;
  repository: string | null;
  ref: string | null;
  path: string;
  exclude: string[];
  no_deliver: string[];
  owner_scope_id: string | null;
  secret: string | null;
  secret_hint: string | null;
  publish_directly: boolean;
  publish_directly_by: string | null;
  interval_minutes: number | null;
  enabled: boolean;
  owner_id: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_ok_at: string | null;
  last_commit: string | null;
  last_filters: string | null;
  last_error: string | null;
  failures: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportInput {
  kind: "git" | "upload";
  data: Uint8Array;
  filename?: string | null;
  source?: SourceRow | null;
  commit?: string | null;
  ref?: string | null;
  dryRun?: boolean;
  force?: boolean;
  scheduled?: boolean;
  /** Collection for skills that have none of their own (uploads). */
  collection?: string | null;
  /** Owner project (slug) of an upload without a source. */
  project?: string | null;
  exclude?: string[];
  noDeliver?: string[];
  path?: string;
  /** git sources: the repository's last path segment (names a single root skill). */
  repoName?: string | null;
  /** A row created by the caller (background git runs); otherwise one is created here. */
  importId?: string | null;
}

export interface ImportReport {
  source: string | null;
  commit: string | null;
  ref: string | null;
  layout: Layout | null;
  importer_version: number;
  dry_run: boolean;
  forced: boolean;
  unchanged_all?: boolean;
  message?: string;
  collections: {
    slug: string;
    name: string;
    created: boolean;
    skills: number;
    connectors: { name: string; url: string }[];
    renamed_from?: string;
    removed?: boolean;
    /** Listed in the source but nothing of it was imported (excluded, or every skill rejected). */
    not_imported?: boolean;
    /** Its name, description or connectors changed upstream: the published ones stay until a reviewer approves. */
    pending_change?: boolean;
  }[];
  added: { name: string; collection: string; version: number; state: string; upstream_version: string | null; flags: number; high_risk_flags: number }[];
  changed: { name: string; from: number | null; to: number; state: string; files_changed: number; guidance_only: boolean; high_risk_flags: number; superseded?: number }[];
  unchanged: { name: string; version: number | null }[];
  /** A pending version withdrawn because the source went back to the published content. */
  withdrawn: { name: string; version: number; reason: string }[];
  /** Only which files are kept from Claude changed, and fewer are delivered now: applied to the published version. */
  delivery_narrowed: { name: string; version: number; withheld: string[] }[];
  rejected_before: { name: string; version: number; reason: string | null }[];
  held: { name: string; at: number; upstream_changed: boolean }[];
  detached: { name: string; upstream_changed: boolean }[];
  adoptable: { name: string; skill_id: string; path: string }[];
  moved: { name: string; from: string | null; to: string; pending: boolean; declined?: boolean; gains: { people: number; audiences: string[] } }[];
  rejected: { path: string; name: string; reasons: string[] }[];
  removed: { name: string }[];
  reactivated: { name: string }[];
  not_covered: { name: string; skill_id: string; path: string | null }[];
  excluded: { path: string; suggested: boolean }[];
  suggested_excludes: string[];
  ignored: string[];
  stamped: { name: string; files: string[] }[];
  warnings: { path: string; message: string }[];
  counts: Record<string, number>;
}

function emptyReport(input: ImportInput): ImportReport {
  return {
    source: input.source?.name ?? null,
    commit: input.commit ?? null,
    ref: input.ref ?? null,
    layout: null,
    importer_version: IMPORTER_VERSION,
    dry_run: !!input.dryRun,
    forced: !!input.force,
    collections: [],
    added: [],
    changed: [],
    unchanged: [],
    withdrawn: [],
    delivery_narrowed: [],
    rejected_before: [],
    held: [],
    detached: [],
    adoptable: [],
    moved: [],
    rejected: [],
    removed: [],
    reactivated: [],
    not_covered: [],
    excluded: [],
    suggested_excludes: [],
    ignored: [],
    stamped: [],
    warnings: [],
    counts: {},
  };
}

/** What a source's filters were for a run (a change re-runs even at the same commit). */
export function filtersKey(s: { path: string; exclude: string[]; no_deliver: string[] }): string {
  return JSON.stringify([IMPORTER_VERSION, s.path || "", [...s.exclude].sort(), [...s.no_deliver].sort()]);
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "upload");

/** Thaliyola's own skill, or a loader that pulls skills out of Thaliyola articles: suggested for exclusion. */
/** At most this many archives inside an upload are opened (one level; archives inside those are not). */
const MAX_NESTED_ARCHIVES = 5;
const NESTED_ARCHIVE = /\.(skill|zip|tgz|tar\.gz)$/i;

/**
 * Archives directly in the upload (at most one folder down), opened in place: "x.skill" becomes the folder "x/" with
 * its contents, so a packaged skill zipped again reads as an ordinary skill folder. Null when there's none to open.
 */
function openNestedArchives(entries: Map<string, TreeEntry>, report: ImportReport): Map<string, TreeEntry> | null {
  const archives = [...entries]
    .filter(([p, e]) => e.type === "file" && NESTED_ARCHIVE.test(p) && p.split("/").length <= 2 && e.data.length > 2)
    .filter(([, e]) => (e.data[0] === 0x50 && e.data[1] === 0x4b) || (e.data[0] === 0x1f && e.data[1] === 0x8b));
  if (!archives.length) return null;
  if (archives.length > MAX_NESTED_ARCHIVES) throw new ValidationError(`the upload holds ${archives.length} archives; upload at most ${MAX_NESTED_ARCHIVES} at a time, or their folders`);
  const merged = new Map(entries);
  let budget = SKILL_LIMITS.uncompressedBytes;
  for (const [p, e] of archives) {
    merged.delete(p);
    let inner: VirtualTree;
    try {
      inner = readArchive(e.data, { gitignore: true, limits: { maxUncompressed: budget, maxEntries: SKILL_LIMITS.archiveEntries } });
    } catch (err) {
      throw new ValidationError(`${p}: ${(err as Error).message}`);
    }
    const folderOf = p.includes("/") ? `${p.slice(0, p.lastIndexOf("/"))}/` : "";
    const base = `${folderOf}${skillNameOf(inner.topName ?? p)}`;
    for (const [ip, ie] of inner.entries) {
      const at = `${base}/${ip}`;
      if (merged.has(at)) throw new ValidationError(`${p}: ${at} is in the upload twice`);
      if (ie.type === "file") budget -= ie.data.length;
      merged.set(at, ie);
    }
    if (budget < 0) throw new ValidationError(`the archives inside the upload unpack to more than ${Math.round(SKILL_LIMITS.uncompressedBytes / 1024 / 1024)} MB`);
    report.warnings.push({ path: p, message: `an archive inside the upload; opened as the folder ${base}/` });
  }
  return merged;
}

function looksLikeThaliyolaOwn(name: string, files: Map<string, TreeEntry>, dir: string): boolean {
  if (name === "thaliyola") return true;
  const md = files.get(dir ? `${dir}/SKILL.md` : "SKILL.md");
  const text = md?.type === "file" ? (textOf(md.data) ?? "") : "";
  return /\b(browse_kb|get_article)\b/.test(text);
}

interface Candidate {
  ref: SkillDirRef;
  plugin: PluginInfo | undefined;
  prepared: PreparedSkill;
  existing: SkillRow | undefined;
}

export async function runImport(ctx: RequestContext, input: ImportInput): Promise<{ import_id: string; status: "done" | "failed"; report: ImportReport; error?: string }> {
  const source = input.source ?? null;
  // Who may import: Manage skills, or (an upload owned by a project) Manage settings there.
  let ownerScopeId: string | null = source?.owner_scope_id ?? null;
  if (!source && input.project) {
    const { rows } = await ctx.db.query<{ id: string; kind: string }>("SELECT id, kind FROM scopes WHERE slug = $1", [input.project]);
    if (!rows[0] || !(await canReadScope(ctx, rows[0].id))) throw new NotFoundError(`project '${input.project}'`);
    if (rows[0].kind !== "project") throw new ValidationError(`'${input.project}' isn't a project`);
    ownerScopeId = rows[0].id;
  }
  const rights = await ownerRights(ctx, ownerScopeId);
  if (!rights.manage || (!ownerScopeId && !can(ctx, "manage_skills"))) throw new ForbiddenError("importing skills needs Manage skills (Skills managers and Administrators)");
  const exclude = cleanGlobs(input.exclude ?? source?.exclude);
  const noDeliver = cleanGlobs(input.noDeliver ?? source?.no_deliver);
  const pathFilter = (input.path ?? source?.path ?? "").trim().replace(/^\/+|\/+$/g, "");

  let importId = input.importId ?? null;
  if (!importId) {
    importId = (
      await ctx.db.query<{ id: string }>(
        `INSERT INTO skill_imports (source_id, kind, dry_run, scheduled, forced, ref, commit, filename, owner_scope_id, started_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [source?.id ?? null, input.kind, !!input.dryRun, !!input.scheduled, !!input.force, input.ref ?? null, input.commit ?? null, input.filename?.slice(0, 200) ?? null, ownerScopeId, ctx.actor.id],
      )
    ).rows[0]!.id;
  }
  const report = emptyReport(input);
  try {
    await pipeline(ctx, input, { importId, ownerScopeId, exclude, noDeliver, pathFilter, report });
    report.counts = countsOf(report);
    await ctx.db.query("UPDATE skill_imports SET status = 'done', finished_at = now(), report = $2, layout = $3, commit = coalesce($4, commit) WHERE id = $1", [
      importId,
      JSON.stringify(report),
      report.layout,
      report.commit,
    ]);
    const details = { source: source?.name ?? null, filename: input.filename ?? null, commit: report.commit, layout: report.layout, ...report.counts, dry_run: !!input.dryRun, forced: !!input.force };
    await audit(ctx.db, input.scheduled ? null : ctx.actor.id, source?.kind === "git" ? "sync_skill_source" : "import_skills", source?.id ?? null, {
      targetKind: source ? "skill_source" : undefined,
      targetLabel: source?.name ?? input.filename ?? null,
      details,
    });
    return { import_id: importId, status: "done", report };
  } catch (err) {
    const message = err instanceof ValidationError || err instanceof SyncError || err instanceof ForbiddenError || err instanceof NotFoundError ? err.message : "the import failed unexpectedly";
    if (!(err instanceof ValidationError || err instanceof SyncError || err instanceof ForbiddenError || err instanceof NotFoundError)) console.error(`[skills] import failed: ${(err as Error).stack ?? err}`);
    report.counts = countsOf(report);
    const safe = redact(message).text.slice(0, 500);
    await ctx.db.query("UPDATE skill_imports SET status = 'failed', finished_at = now(), error = $2, report = $3 WHERE id = $1", [importId, safe, JSON.stringify(report)]);
    return { import_id: importId, status: "failed", report, error: safe };
  }
}

function countsOf(r: ImportReport): Record<string, number> {
  return {
    added: r.added.length,
    changed: r.changed.length,
    unchanged: r.unchanged.length,
    withdrawn: r.withdrawn.length,
    delivery_narrowed: r.delivery_narrowed.length,
    rejected: r.rejected.length,
    rejected_before: r.rejected_before.length,
    held: r.held.length,
    detached: r.detached.length,
    adoptable: r.adoptable.length,
    moved: r.moved.length,
    removed: r.removed.length,
    not_covered: r.not_covered.length,
    excluded: r.excluded.length,
  };
}

async function pipeline(
  ctx: RequestContext,
  input: ImportInput,
  o: { importId: string; ownerScopeId: string | null; exclude: string[]; noDeliver: string[]; pathFilter: string; report: ImportReport },
) {
  const { report, ownerScopeId } = o;
  const source = input.source ?? null;
  // 1. The archive, in memory.
  let tree: VirtualTree;
  try {
    tree = readArchive(input.data, { gitignore: input.kind === "upload", limits: { maxUncompressed: SKILL_LIMITS.uncompressedBytes, maxEntries: SKILL_LIMITS.archiveEntries } });
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ValidationError(`the archive can't be read: ${(err as Error).message}`);
  }
  report.commit ??= tree.commit;
  report.ignored = tree.ignored;
  report.warnings.push(...tree.warnings);

  // 2. Shared guidance from core/, exactly as ci/sync_core.py (only when the tree has core/).
  let entries = tree.entries;
  let skillErrors = new Map<string, string>();
  let stampedBy = new Map<string, string[]>();
  let managedPaths = new Set<string>();
  const hasCore = [...entries.keys()].some((p) => p.startsWith("core/")) || entries.get("core")?.type === "symlink";
  if (hasCore) {
    try {
      const plan = planStamp(entries);
      entries = applyStamp(entries, plan.changes);
      skillErrors = plan.skillErrors;
      stampedBy = plan.stamped;
      managedPaths = plan.managed;
    } catch (err) {
      if (err instanceof SyncError) throw new ValidationError(`core: ${err.message}`);
      throw err;
    }
  }

  // 3. Where the skills are.
  const layoutOpts = { repoName: input.repoName ?? null, topName: tree.topName, filename: input.filename ?? null, collection: input.collection ?? source?.name ?? null };
  let layout = detectLayout(entries, layoutOpts);
  // An upload holding archives instead of folders (a Claude-packaged "advertiser-analysis.skill" zipped again, or a zip
  // of several skill zips): open them, one level deep, and look again.
  if (!layout.layout && input.kind === "upload") {
    const opened = openNestedArchives(entries, report);
    if (opened) {
      entries = opened;
      layout = detectLayout(entries, { ...layoutOpts, topName: null });
    }
  }
  report.layout = layout.layout;
  report.warnings.push(...layout.warnings);
  report.rejected.push(...layout.rejected);
  if (!layout.layout) {
    if (layout.rejected.length) throw new ValidationError(`no skills found: ${layout.rejected.map((r) => `${r.path}: ${r.reasons.join("; ")}`).join(" · ")}`);
    const seen = [...entries.keys()].sort().slice(0, 8);
    throw new ValidationError(
      "no skills found. A skill is a folder with a SKILL.md file (a single skill, a zip of skill folders, " +
        "a Claude-packaged .skill file, skills/<name>/SKILL.md folders, or a plugin marketplace)." +
        (seen.length ? ` The upload contains: ${seen.join(", ")}${entries.size > seen.length ? `, … (${entries.size} files)` : ""}` : " The upload is empty."),
    );
  }
  const plugins = new Map(layout.plugins.map((p) => [p.slug, p]));

  // 4. Path filter and excludes choose what's imported (core/ and the marketplace are always read from the root).
  const covered = (dir: string) => (!o.pathFilter || dir === o.pathFilter || dir.startsWith(`${o.pathFilter}/`)) && !o.exclude.some((g) => matchesGlob(dir, g));
  const chosen: SkillDirRef[] = [];
  for (const s of layout.skills) {
    const suggested = looksLikeThaliyolaOwn(s.name, entries, s.dir);
    if (suggested) {
      const plugin = plugins.get(s.collection);
      const glob = layout.layout === "marketplace" && plugin?.dir ? `${plugin.dir}/**` : s.dir || s.name;
      if (!report.suggested_excludes.includes(glob)) report.suggested_excludes.push(glob);
    }
    if (o.pathFilter && !(s.dir === o.pathFilter || s.dir.startsWith(`${o.pathFilter}/`))) continue;
    if (o.exclude.some((g) => matchesGlob(s.dir, g))) {
      report.excluded.push({ path: s.dir, suggested });
      continue;
    }
    chosen.push(s);
  }
  if (chosen.length > SKILL_LIMITS.skillsPerImport) throw new ValidationError(`the import has ${chosen.length} skills; at most ${SKILL_LIMITS.skillsPerImport} per import`);

  // 5. Each skill: its files, the stamping verdict, validation and scanning.
  const candidates: Candidate[] = [];
  const byName = new Map<string, number>();
  for (const s of chosen) byName.set(s.name, (byName.get(s.name) ?? 0) + 1);
  for (const s of chosen) {
    const reasons: string[] = [];
    if ((byName.get(s.name) ?? 0) > 1) reasons.push(`two skills named '${s.name}' in this import`);
    const err = skillErrors.get(s.dir);
    if (err) reasons.push(err);
    const prefix = s.dir ? `${s.dir}/` : "";
    const files: SkillFile[] = [];
    for (const [p, e] of entries) {
      if (prefix && !p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      if (!prefix && (rel.startsWith(".claude-plugin/") || rel === ".gitignore")) continue;
      if (e.type !== "file") {
        reasons.push(`${p}: symlinks are not allowed`);
        continue;
      }
      files.push({ path: rel, data: e.data, managed: managedPaths.has(p), deliver: !o.noDeliver.some((g) => matchesGlob(rel, g)) });
    }
    const existing = await skillByName(ctx.db, s.name);
    const base = existing?.current_version_id ? await baseInfo(ctx.db, existing.current_version_id) : null;
    const prepared = prepareSkill(s.name, files, base);
    reasons.push(...prepared.errors);
    if (reasons.length) {
      report.rejected.push({ path: s.dir || ".", name: s.name, reasons: [...new Set(reasons)].slice(0, 20) });
      continue;
    }
    for (const w of prepared.warnings) report.warnings.push({ path: s.dir ? `${s.dir}/SKILL.md` : "SKILL.md", message: w.replace(/^SKILL\.md: /, "") });
    const st = stampedBy.get(s.dir);
    if (st?.length) report.stamped.push({ name: s.name, files: st });
    candidates.push({ ref: s, plugin: plugins.get(s.collection), prepared, existing });
  }
  if (!layout.skills.length) throw new ValidationError("the source returned no skills; nothing was changed (check the ref, path filter and excludes)");

  // 6. Collections: from plugin metadata; a slug that belongs to another source (or project) rejects that plugin's skills.
  const usedSlugs = new Set(candidates.map((c) => c.ref.collection));
  const collectionIds = new Map<string, string>();
  const blockedSlugs = new Map<string, string>();
  const colRows = await ctx.db.query<CollectionMeta>(
    "SELECT id, slug, source_id, owner_scope_id, name, description, connectors, pending_meta, declined_meta_hash FROM skill_collections WHERE slug = ANY ($1::text[])",
    [[...usedSlugs, ...layout.renames.keys(), ...[...layout.renames.values()].filter((v): v is string => !!v)]],
  );
  const colBySlug = new Map(colRows.rows.map((r) => [r.slug, r]));
  // marketplace renames apply only to this source's own collections, owned like this import (never a hand-made or
  // uploaded collection, or another owner's): anything else is reported and skipped.
  const renames = new Map<string, string | null>();
  for (const [old, to] of layout.renames) {
    const c = colBySlug.get(old);
    if (!c) continue;
    if (!source || c.source_id !== source.id || (c.owner_scope_id ?? null) !== ownerScopeId) {
      report.warnings.push({ path: ".claude-plugin/marketplace.json", message: `renames: '${old}' ${to === null ? "wasn't removed" : `wasn't renamed to '${to}'`}: that collection doesn't come from this source` });
      continue;
    }
    if (to !== null && colBySlug.has(to)) {
      report.warnings.push({ path: ".claude-plugin/marketplace.json", message: `renames: '${old}' wasn't renamed: a collection named '${to}' already exists` });
      continue;
    }
    renames.set(old, to);
  }
  // A renamed collection is where the new slug's skills go (it's this source's and this owner's, checked above).
  for (const [old, to] of renames) if (to !== null && usedSlugs.has(to)) collectionIds.set(to, colBySlug.get(old)!.id);
  for (const slug of usedSlugs) {
    const c = colBySlug.get(slug);
    if (!c || collectionIds.has(slug)) continue;
    if ((c.owner_scope_id ?? null) !== ownerScopeId) blockedSlugs.set(slug, `the collection '${slug}' belongs to ${c.owner_scope_id ? "a project" : "the organisation"}, not to this import's owner`);
    else if (c.source_id && c.source_id !== source?.id) blockedSlugs.set(slug, `the collection '${slug}' belongs to another source`);
    else collectionIds.set(slug, c.id);
  }
  const keep: Candidate[] = [];
  for (const c of candidates) {
    const why = blockedSlugs.get(c.ref.collection);
    if (why) report.rejected.push({ path: c.ref.dir || ".", name: c.ref.name, reasons: [why] });
    else keep.push(c);
  }

  // 7. Compare with what Thaliyola has.
  type Plan =
    | { kind: "add"; c: Candidate }
    | { kind: "change"; c: Candidate; state: "pending" | "published"; guidanceHash: string | null; filesChanged: number; from: number | null }
    | { kind: "same"; c: Candidate; withdraw?: { id: string; version: number } }
    | { kind: "deliver"; c: Candidate; versionIds: string[]; version: number; withheld: string[] };
  const plans: Plan[] = [];
  const moves: { c: Candidate; to: string; pending: boolean }[] = [];
  const reactivate: SkillRow[] = [];
  const seenIds = new Set<string>();
  const ownerMayPublish = source?.publish_directly && source.owner_id ? await holdsReview(ctx.db, ctx.settings, source.owner_id) : false;
  for (const c of keep) {
    const e = c.existing;
    if (!e) {
      plans.push({ kind: "add", c });
      continue;
    }
    const r = await ownerRights(ctx, e.owner_scope_id);
    if (!r.see) {
      report.rejected.push({ path: c.ref.dir || ".", name: c.ref.name, reasons: ["that name isn't available"] });
      continue;
    }
    if ((e.owner_scope_id ?? null) !== ownerScopeId) {
      report.rejected.push({ path: c.ref.dir || ".", name: c.ref.name, reasons: [`a skill named ${e.name} already exists ${e.owner_scope_id ? "in a project" : "for the whole organisation"}`] });
      continue;
    }
    if (e.source_id && e.source_id !== source?.id) {
      const other = (await ctx.db.query<{ name: string }>("SELECT name FROM skill_sources WHERE id = $1", [e.source_id])).rows[0]?.name ?? "another source";
      report.rejected.push({ path: c.ref.dir || ".", name: c.ref.name, reasons: [`a skill named ${e.name} already exists (from ${other})`] });
      continue;
    }
    if (!e.source_id && source?.kind === "git") {
      if (r.manage) report.adoptable.push({ name: e.name, skill_id: e.id, path: c.ref.dir });
      else report.rejected.push({ path: c.ref.dir || ".", name: c.ref.name, reasons: [`a skill named ${e.name} already exists`] });
      continue;
    }
    if (!r.manage) {
      report.rejected.push({ path: c.ref.dir || ".", name: c.ref.name, reasons: [`you can't change ${e.name}`] });
      continue;
    }
    seenIds.add(e.id);
    const hashes = (
      await ctx.db.query<{ id: string; version: number; state: string; content_hash: string; reason: string | null; from_source: boolean }>(
        `SELECT v.id, v.version, v.state, v.content_hash, v.reason, (i.source_id IS NOT NULL AND i.source_id = $3) AS from_source
           FROM skill_versions v LEFT JOIN skill_imports i ON i.id = v.import_id
          WHERE v.skill_id = $1 AND (v.id = $2 OR v.state IN ('pending', 'rejected')) ORDER BY v.version DESC`,
        [e.id, e.current_version_id, source?.id ?? null],
      )
    ).rows;
    const current = hashes.find((h) => h.id === e.current_version_id);
    const pending = hashes.find((h) => h.state === "pending");
    const same = current?.content_hash === c.prepared.contentHash || pending?.content_hash === c.prepared.contentHash;
    // Back to the published content upstream: a pending version this source proposed earlier is withdrawn.
    const withdraw = current?.content_hash === c.prepared.contentHash && pending && pending.content_hash !== c.prepared.contentHash && pending.from_source ? { id: pending.id, version: pending.version } : undefined;
    // Back in the source after an import retired it (a skill retired by hand stays retired).
    if (e.status === "retired" && e.source_id && e.status_reason?.startsWith("removed from ")) reactivate.push(e);
    if (e.source_detached) {
      report.detached.push({ name: e.name, upstream_changed: current?.content_hash !== c.prepared.contentHash });
      continue;
    }
    if (e.held_at_version !== null) {
      report.held.push({ name: e.name, at: e.held_at_version, upstream_changed: current?.content_hash !== c.prepared.contentHash });
      continue;
    }
    // A move to another plugin: the skill keeps its identity and its own assignments.
    const targetSlug = c.ref.collection;
    const currentSlug = e.collection_id ? (await ctx.db.query<{ slug: string }>("SELECT slug FROM skill_collections WHERE id = $1", [e.collection_id])).rows[0]?.slug ?? null : null;
    if (targetSlug !== currentSlug) {
      const targetId = collectionIds.get(targetSlug) ?? colBySlug.get(targetSlug)?.id;
      const gains = targetId ? await audienceGain(ctx, e, targetId) : { people: 0, audiences: [] };
      if (gains.people > 0 && e.declined_collection_id && e.declined_collection_id === targetId) {
        report.moved.push({ name: e.name, from: currentSlug, to: targetSlug, pending: false, declined: true, gains });
      } else if (gains.people > 0) {
        moves.push({ c, to: targetSlug, pending: true });
        report.moved.push({ name: e.name, from: currentSlug, to: targetSlug, pending: true, gains });
      } else {
        moves.push({ c, to: targetSlug, pending: false });
        report.moved.push({ name: e.name, from: currentSlug, to: targetSlug, pending: false, gains });
      }
    }
    if (same) {
      plans.push({ kind: "same", c, withdraw });
      report.unchanged.push({ name: e.name, version: current ? (hashes.find((h) => h.id === e.current_version_id)?.version ?? null) : null });
      continue;
    }
    const rejectedBefore = hashes.find((h) => h.state === "rejected" && h.content_hash === c.prepared.contentHash);
    if (rejectedBefore && !input.force) {
      report.rejected_before.push({ name: e.name, version: rejectedBefore.version, reason: rejectedBefore.reason });
      continue;
    }
    const base = e.current_version_id ? await baseInfo(ctx.db, e.current_version_id) : null;
    // Only delivery changed, and only narrower (a no_deliver glob added): applied to the published version (and the
    // pending one) in place, without review, since nothing new reaches anyone.
    if (base && current && sameFiles(base.shas, c.prepared)) {
      const withheld = c.prepared.files.filter((f) => !f.deliver && base.deliver.get(f.path) !== false).map((f) => f.path);
      const widened = c.prepared.files.some((f) => f.deliver && base.deliver.get(f.path) === false);
      if (withheld.length && !widened) {
        plans.push({ kind: "deliver", c, versionIds: [current.id, ...(pending ? [pending.id] : [])], version: current.version, withheld });
        continue;
      }
    }
    const guidanceHash = base ? guidanceOnly(base.files, c.prepared.files.map((f) => ({ path: f.path, sha256: f.sha256, managed: f.managed, text: f.path === "SKILL.md" ? textOf(f.data) : undefined }))) : null;
    const highRisk = c.prepared.flags.some((f) => f.high_risk);
    const direct = !!(ownerMayPublish && e.current_version_id && !highRisk);
    const filesChanged = base ? countChanged(base.shas, c.prepared) : c.prepared.files.length;
    plans.push({ kind: "change", c, state: direct ? "published" : "pending", guidanceHash, filesChanged, from: current?.version ?? null });
  }

  // 8. Gone from the source: retired (assignments stay); outside a narrowed filter: listed, not retired.
  const removed: SkillRow[] = [];
  const renamedAway = new Set([...renames].filter(([, to]) => to === null).map(([old]) => old));
  if (source) {
    const { rows } = await ctx.db.query<SkillRow & { collection_slug: string | null }>(
      `SELECT sk.*, c.slug AS collection_slug FROM skills sk LEFT JOIN skill_collections c ON c.id = sk.collection_id WHERE sk.source_id = $1 AND sk.status = 'active' AND NOT sk.source_detached`,
      [source.id],
    );
    const present = new Set(layout.skills.map((s) => s.name));
    for (const s of rows) {
      if (seenIds.has(s.id)) continue;
      const gone = !present.has(s.name) || (s.collection_slug !== null && renamedAway.has(s.collection_slug));
      const inside = s.source_path === null || covered(s.source_path);
      if (gone && inside) removed.push(s);
      else if (!inside) report.not_covered.push({ name: s.name, skill_id: s.id, path: s.source_path });
    }
    const active = rows.length;
    if (!input.force && active > 0 && removed.length > active / 2) {
      throw new ValidationError(`the source would remove ${removed.length} of ${active} skills; nothing was changed (check the ref, path filter and excludes, or run again with force)`);
    }
    report.removed = removed.map((s) => ({ name: s.name }));
  }
  if (!chosen.length && !report.excluded.length) throw new ValidationError("the source returned no skills; nothing was changed (check the ref, path filter and excludes)");

  // Collections for the report.
  for (const slug of [...new Set([...usedSlugs, ...layout.plugins.map((p) => p.slug)])].sort()) {
    const p = plugins.get(slug);
    const imported = usedSlugs.has(slug) && !blockedSlugs.has(slug);
    const live = colBySlug.get(slug);
    report.collections.push({
      slug,
      name: p?.name ?? slug,
      created: imported && !live && !collectionIds.has(slug),
      skills: keep.filter((c) => c.ref.collection === slug).length,
      connectors: (p?.connectors ?? []).map((x) => ({ name: x.name, url: x.url })),
      ...(imported ? {} : { not_imported: true }),
    });
  }
  for (const [old, to] of renames) {
    const c = colBySlug.get(old)!;
    if (to === null) report.collections.push({ slug: old, name: c.name, created: false, skills: 0, connectors: [], removed: true });
    else {
      const entry = report.collections.find((x) => x.slug === to);
      if (entry) {
        entry.renamed_from = old;
        entry.created = false;
      }
    }
  }
  // Name, description and connectors of existing collections: a change waits for review (the live ones stay).
  const metaChanges: { id: string; slug: string; name: string; from: CollectionMetaValue; to: CollectionMetaValue; hash: string }[] = [];
  for (const slug of usedSlugs) {
    if (blockedSlugs.has(slug)) continue;
    const id = collectionIds.get(slug);
    if (!id) continue;
    const live = colRows.rows.find((r) => r.id === id)!;
    const p = plugins.get(slug);
    const next: CollectionMetaValue = { name: p?.name ?? slug, description: p?.description ?? "", connectors: p?.connectors ?? [] };
    const now: CollectionMetaValue = { name: live.name, description: live.description, connectors: live.connectors ?? [] };
    const hash = metaHash(next);
    const entry = report.collections.find((x) => x.slug === slug);
    if (hash === metaHash(now)) continue;
    if (live.pending_meta && metaHash(live.pending_meta) === hash) {
      if (entry) entry.pending_change = true;
      continue;
    }
    if (live.declined_meta_hash === hash) continue;
    metaChanges.push({ id, slug, name: now.name, from: now, to: next, hash });
    if (entry) entry.pending_change = true;
  }

  // 9. Writes, all in one transaction.
  const authorId = input.scheduled && source?.owner_id ? source.owner_id : ctx.actor.id;
  const pendingCreated: { id: string; name: string; version: number }[] = [];
  const superseded: { skill: { id: string; name: string }; old: { version: number; author_id: string | null }; by: number }[] = [];
  const tx = async (db: Queryable) => {
    // Collections: renames keep their assignments; then create or update from plugin metadata.
    for (const [old, to] of renames) {
      const c = colBySlug.get(old)!;
      if (to === null) await db.query("UPDATE skill_collections SET removed_at = coalesce(removed_at, now()), updated_at = now() WHERE id = $1", [c.id]);
      else await db.query("UPDATE skill_collections SET slug = $2, updated_at = now() WHERE id = $1", [c.id, to]);
      await audit(db, input.scheduled ? null : ctx.actor.id, to === null ? "remove_skill_collection" : "rename_skill_collection", c.id, {
        targetKind: "skill_collection",
        targetLabel: c.name,
        details: { from: old, to, source: source?.name ?? null, via_import: o.importId },
      });
    }
    for (const slug of usedSlugs) {
      if (blockedSlugs.has(slug)) continue;
      const p = plugins.get(slug);
      const id = collectionIds.get(slug);
      if (id) {
        // The live name, description and connectors stay; a change is proposed below for review.
        await db.query("UPDATE skill_collections SET upstream_version = $2, source_id = coalesce(source_id, $3), removed_at = NULL, updated_at = now() WHERE id = $1", [id, p?.upstreamVersion ?? null, source?.id ?? null]);
      } else {
        const ins = await db.query<{ id: string }>(
          `INSERT INTO skill_collections (slug, name, description, source_id, owner_scope_id, connectors, upstream_version, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [slug, p?.name ?? slug, p?.description ?? "", source?.id ?? null, ownerScopeId, JSON.stringify(p?.connectors ?? []), p?.upstreamVersion ?? null, ctx.actor.id],
        );
        collectionIds.set(slug, ins.rows[0]!.id);
      }
    }
    for (const m of metaChanges) {
      await db.query("UPDATE skill_collections SET pending_meta = $2, pending_meta_by = $3, pending_meta_import_id = $4, pending_meta_at = now(), updated_at = now() WHERE id = $1", [
        m.id,
        JSON.stringify(m.to),
        authorId,
        o.importId,
      ]);
      await audit(db, input.scheduled ? null : ctx.actor.id, "propose_skill_collection_change", m.id, {
        targetKind: "skill_collection",
        targetLabel: m.name,
        details: { collection: m.slug, ...metaDiff(m.from, m.to), source: source?.name ?? null, via_import: o.importId },
      });
    }
    // Collections whose upstream went back to the published values: drop the stale proposal.
    for (const slug of usedSlugs) {
      const id = collectionIds.get(slug);
      const live = id ? colRows.rows.find((r) => r.id === id) : undefined;
      if (!live?.pending_meta || metaChanges.some((m) => m.id === live.id)) continue;
      const p = plugins.get(slug);
      const next = metaHash({ name: p?.name ?? slug, description: p?.description ?? "", connectors: p?.connectors ?? [] });
      if (next !== metaHash(live.pending_meta)) await db.query("UPDATE skill_collections SET pending_meta = NULL, pending_meta_by = NULL, pending_meta_import_id = NULL, pending_meta_at = NULL WHERE id = $1", [live.id]);
    }
    for (const plan of plans) {
      const c = plan.c;
      if (plan.kind === "deliver") {
        const e = c.existing!;
        await db.query("UPDATE skill_files SET deliver = false WHERE version_id = ANY ($1::uuid[]) AND path = ANY ($2::text[])", [plan.versionIds, plan.withheld]);
        for (const vid of plan.versionIds) {
          const files = (await db.query<{ path: string; sha256: string; deliver: boolean }>("SELECT path, sha256, deliver FROM skill_files WHERE version_id = $1", [vid])).rows;
          await db.query("UPDATE skill_versions SET content_hash = $2 WHERE id = $1", [vid, contentHash(files)]);
        }
        if (source && e.source_path !== c.ref.dir) await db.query("UPDATE skills SET source_path = $2 WHERE id = $1", [e.id, c.ref.dir]);
        await audit(db, input.scheduled ? null : ctx.actor.id, "narrow_skill_delivery", e.id, { targetKind: "skill", targetLabel: e.name, details: { name: e.name, version: plan.version, withheld: plan.withheld, via_import: o.importId } });
        report.delivery_narrowed.push({ name: e.name, version: plan.version, withheld: plan.withheld });
        continue;
      }
      if (plan.kind === "same" && plan.withdraw) {
        const e = c.existing!;
        const reason = `withdrawn: the source went back to the published content at ${short(report.commit)}`;
        const w = await db.query<{ author_id: string | null }>("UPDATE skill_versions SET state = 'superseded', decided_at = now(), reason = $2 WHERE id = $1 AND state = 'pending' RETURNING author_id", [plan.withdraw.id, reason]);
        if (w.rowCount) {
          report.withdrawn.push({ name: e.name, version: plan.withdraw.version, reason });
          await audit(db, input.scheduled ? null : ctx.actor.id, "withdraw_skill_version", e.id, { targetKind: "skill", targetLabel: e.name, details: { name: e.name, version: plan.withdraw.version, reason, via_import: o.importId } });
        }
      }
      if (plan.kind === "add") {
        const ins = await db.query<{ id: string }>("INSERT INTO skills (name, collection_id, owner_scope_id, source_id, source_path, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id", [
          c.ref.name,
          collectionIds.get(c.ref.collection) ?? null,
          ownerScopeId,
          source?.id ?? null,
          source ? c.ref.dir : null,
          ctx.actor.id,
        ]);
        const v = await insertVersion(db, { skillId: ins.rows[0]!.id, state: "pending", baseVersionId: null, prepared: c.prepared, summary: `Imported from ${source?.name ?? input.filename ?? "an upload"} at ${short(report.commit)}`, authorId, sourceCommit: report.commit, sourceRef: report.ref, importId: o.importId }, `${source?.name ?? "an upload"} at ${short(report.commit)}`);
        pendingCreated.push({ id: ins.rows[0]!.id, name: c.ref.name, version: v.version });
        report.added.push({ name: c.ref.name, collection: c.ref.collection, version: v.version, state: "pending", upstream_version: c.prepared.upstreamVersion, flags: c.prepared.flags.length, high_risk_flags: c.prepared.flags.filter((f) => f.high_risk).length });
      } else if (plan.kind === "change") {
        const e = c.existing!;
        if (source && e.source_path !== c.ref.dir) await db.query("UPDATE skills SET source_path = $2 WHERE id = $1", [e.id, c.ref.dir]);
        const v = await insertVersion(
          db,
          {
            skillId: e.id,
            state: plan.state,
            baseVersionId: e.current_version_id,
            prepared: c.prepared,
            summary: `${plan.guidanceHash ? "Shared guidance update" : "Updated"} from ${source?.name ?? input.filename ?? "an upload"} at ${short(report.commit)}`,
            authorId,
            sourceCommit: report.commit,
            sourceRef: report.ref,
            importId: o.importId,
            guidanceHash: plan.guidanceHash,
            direct: plan.state === "published",
          },
          `${source?.name ?? "an upload"} at ${short(report.commit)}`,
        );
        if (v.superseded) superseded.push({ skill: { id: e.id, name: e.name }, old: v.superseded, by: v.version });
        if (plan.state === "pending") pendingCreated.push({ id: e.id, name: e.name, version: v.version });
        else await audit(db, null, "publish_skill_version", e.id, { targetKind: "skill", targetLabel: e.name, details: { name: e.name, version: v.version, from_version: plan.from, direct: true, via_import: o.importId } });
        report.changed.push({
          name: e.name,
          from: plan.from,
          to: v.version,
          state: plan.state,
          files_changed: plan.filesChanged,
          guidance_only: !!plan.guidanceHash,
          high_risk_flags: c.prepared.flags.filter((f) => f.high_risk).length,
          ...(v.superseded ? { superseded: v.superseded.version } : {}),
        });
      } else if (source && c.existing && c.existing.source_path !== c.ref.dir) {
        await db.query("UPDATE skills SET source_path = $2 WHERE id = $1", [c.existing.id, c.ref.dir]);
      }
    }
    for (const m of moves) {
      const e = m.c.existing!;
      const to = collectionIds.get(m.to);
      if (!to) continue;
      if (m.pending) await db.query("UPDATE skills SET pending_collection_id = $2, pending_collection_import_id = $3, pending_collection_by = $4, updated_at = now() WHERE id = $1", [e.id, to, o.importId, authorId]);
      else await db.query("UPDATE skills SET collection_id = $2, pending_collection_id = NULL, pending_collection_by = NULL, updated_at = now() WHERE id = $1", [e.id, to]);
    }
    for (const e of reactivate) {
      await db.query("UPDATE skills SET status = 'active', status_reason = NULL, updated_at = now() WHERE id = $1 AND status = 'retired'", [e.id]);
      report.reactivated.push({ name: e.name });
    }
    for (const s of removed) {
      await db.query("UPDATE skills SET status = 'retired', status_reason = $2, updated_at = now() WHERE id = $1", [s.id, `removed from ${source!.name} at ${short(report.commit)}`]);
    }
    if (source && !input.dryRun) {
      await db.query("UPDATE skill_sources SET last_commit = coalesce($2, last_commit), last_filters = $3, last_ok_at = now(), last_error = NULL, failures = 0, updated_at = now() WHERE id = $1", [
        source.id,
        report.commit,
        filtersKey({ path: o.pathFilter, exclude: o.exclude, no_deliver: o.noDeliver }),
      ]);
    }
  };
  if (input.dryRun) {
    // Everything is computed; the report shows what would happen (versions as "next").
    for (const plan of plans) {
      if (plan.kind === "add") report.added.push({ name: plan.c.ref.name, collection: plan.c.ref.collection, version: 1, state: "pending", upstream_version: plan.c.prepared.upstreamVersion, flags: plan.c.prepared.flags.length, high_risk_flags: plan.c.prepared.flags.filter((f) => f.high_risk).length });
      else if (plan.kind === "change")
        report.changed.push({ name: plan.c.existing!.name, from: plan.from, to: (plan.from ?? 0) + 1, state: plan.state, files_changed: plan.filesChanged, guidance_only: !!plan.guidanceHash, high_risk_flags: plan.c.prepared.flags.filter((f) => f.high_risk).length });
      else if (plan.kind === "deliver") report.delivery_narrowed.push({ name: plan.c.existing!.name, version: plan.version, withheld: plan.withheld });
      else if (plan.withdraw) report.withdrawn.push({ name: plan.c.existing!.name, version: plan.withdraw.version, reason: "withdrawn: the source went back to the published content" });
    }
    report.reactivated = reactivate.map((e) => ({ name: e.name }));
  } else {
    await withTx(ctx.db, (client) => tx(client));
  }
  report.message = input.dryRun ? "Preview only: nothing was changed." : undefined;

  if (!input.dryRun) {
    for (const s of superseded) await notifySuperseded(ctx, s.skill, s.old, s.by);
    if (pendingCreated.length) {
      const reviewers = await peopleWith(ctx.db, ctx.settings, "review_skills", ownerScopeId);
      const guidance = report.changed.filter((c) => c.guidance_only && c.state === "pending").length;
      await tellSkill(
        ctx.db,
        ctx.settings,
        reviewers,
        {
          title: pendingCreated.length === 1 ? `Skill ${pendingCreated[0]!.name}: version ${pendingCreated[0]!.version} waits for review` : `${pendingCreated.length} skill versions from ${source?.name ?? "an upload"} wait for review${guidance ? `; ${guidance} are the same shared guidance change` : ""}`,
          link: pendingCreated.length === 1 ? `#/skills/${pendingCreated[0]!.id}` : "#/review/skills",
          targetId: pendingCreated.length === 1 ? pendingCreated[0]!.id : null,
        },
        authorId,
      );
    }
    if (metaChanges.length) {
      const reviewers = await peopleWith(ctx.db, ctx.settings, "review_skills", ownerScopeId);
      await tellSkill(
        ctx.db,
        ctx.settings,
        reviewers,
        { title: `${metaChanges.length === 1 ? `Skill collection ${metaChanges[0]!.slug}: its` : `${metaChanges.length} skill collections: their`} name, description or connectors changed upstream; the change waits for review`, link: "#/review/skills" },
        authorId,
      );
    }
    const waiting = report.moved.filter((m) => m.pending);
    if (waiting.length) {
      const reviewers = await peopleWith(ctx.db, ctx.settings, "review_skills", ownerScopeId);
      await tellSkill(ctx.db, ctx.settings, reviewers, { title: `${waiting.length} skill move${waiting.length === 1 ? "" : "s"} would give skills to more people; they wait for review`, link: "#/review/skills" }, authorId);
    }
  }
}

interface CollectionMetaValue {
  name: string;
  description: string;
  connectors: { name: string; type?: string; url: string }[];
}

interface CollectionMeta {
  id: string;
  slug: string;
  source_id: string | null;
  owner_scope_id: string | null;
  name: string;
  description: string;
  connectors: { name: string; type: string; url: string }[];
  pending_meta: CollectionMetaValue | null;
  declined_meta_hash: string | null;
}

/** A stable hash of a collection's reviewable metadata. */
export function metaHash(m: CollectionMetaValue): string {
  const connectors = [...(m.connectors ?? [])].map((c) => [c.name, c.type ?? "", c.url]).sort((a, b) => (a.join("\0") < b.join("\0") ? -1 : 1));
  return sha256(JSON.stringify([m.name, m.description, connectors]));
}

/** What changed in a collection's metadata, with the connector URLs before and after (for the audit log). */
export function metaDiff(from: CollectionMetaValue, to: CollectionMetaValue) {
  const urls = (m: CollectionMetaValue) => (m.connectors ?? []).map((c) => `${c.name}: ${c.url}`).sort();
  return {
    ...(from.name !== to.name ? { name_from: from.name, name_to: to.name } : {}),
    ...(from.description !== to.description ? { description_changed: true } : {}),
    connectors_from: urls(from),
    connectors_to: urls(to),
  };
}

/** Same files and bytes as the published version (delivery flags aside). */
function sameFiles(base: Map<string, string>, p: PreparedSkill): boolean {
  if (base.size !== p.files.length) return false;
  return p.files.every((f) => base.get(f.path) === f.sha256);
}

function countChanged(base: Map<string, string>, p: PreparedSkill): number {
  let n = 0;
  const next = new Map(p.files.map((f) => [f.path, f.sha256]));
  for (const [path, sha] of next) if (base.get(path) !== sha) n++;
  for (const path of base.keys()) if (!next.has(path)) n++;
  return n;
}

/** Whether a person (a source's owner) still holds Review skills. */
async function holdsReview(db: Queryable, settings: RequestContext["settings"], userId: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `SELECT (u.kind = 'human' AND u.disabled_at IS NULL AND (u.is_admin OR lower(u.email) = ANY ($2::text[])
             OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.key = ur.role WHERE ur.user_id = u.id AND 'review_skills' = ANY (r.permissions)))) AS ok
       FROM users u WHERE u.id = $1`,
    [userId, settings.adminEmails],
  );
  return !!rows[0]?.ok;
}

export type { TreeEntry };

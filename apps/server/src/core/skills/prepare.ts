import type { Queryable } from "../../db/pool.js";
import { requestVia } from "../audit.js";
import { checkEntryPath, checkPathSet } from "./archive.js";
import { frontmatterJson, parseFrontmatter, validateSkillFrontmatter, type Meta } from "./frontmatter.js";
import { hostsOf, scanSkillFiles } from "./scan.js";
import { contentHash, sha256, SKILL_LIMITS, textOf, type SkillFile, type SkillFlag } from "./types.js";

/**
 * The one validation pipeline every new skill version goes through, whether it comes from an import, an upload or
 * the editor: safe paths, limits, frontmatter (validate.py's rules), secrets and hidden text (rejections), and the
 * flags a reviewer must see. Then storage: content-addressed blobs and the version's file rows.
 */

export interface PreparedFile {
  path: string;
  data: Uint8Array;
  sha256: string;
  size: number;
  kind: "text" | "binary";
  is_script: boolean;
  managed: boolean;
  deliver: boolean;
}

export interface BaseInfo {
  /** path → sha256 of the published version. */
  shas: Map<string, string>;
  /** path → whether the published version delivers it. */
  deliver: Map<string, boolean>;
  hosts: Set<string>;
  allowedTools: string | null;
  /** For guidance-only comparisons. */
  files: { path: string; sha256: string; managed: boolean; text?: string | null }[];
}

export interface PreparedSkill {
  errors: string[];
  warnings: string[];
  meta: Record<string, unknown> | null;
  description: string;
  upstreamVersion: string | null;
  allowedTools: string | null;
  flags: SkillFlag[];
  hasScripts: boolean;
  files: PreparedFile[];
  contentHash: string;
  totalBytes: number;
  skillMd: string | null;
}

const fmt = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export function prepareSkill(dirName: string, input: SkillFile[], base?: BaseInfo | null): PreparedSkill {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files: PreparedFile[] = [];
  let total = 0;
  for (const f of input) {
    try {
      checkEntryPath(f.path);
    } catch (err) {
      errors.push((err as Error).message);
      continue;
    }
    const text = textOf(f.data);
    total += f.data.length;
    if (f.data.length > SKILL_LIMITS.fileBytes) errors.push(`${f.path} is ${fmt(f.data.length)}; a skill file can be at most ${fmt(SKILL_LIMITS.fileBytes)}`);
    files.push({
      path: f.path,
      data: f.data,
      sha256: sha256(f.data),
      size: f.data.length,
      kind: text === null ? "binary" : "text",
      is_script: false,
      // Only the importer's own stamping marks a file managed (never the file's contents).
      managed: f.managed ?? false,
      deliver: f.deliver ?? true,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // The checks archives get: no case or Unicode-normalisation twins, no path that is both a file and a folder.
  try {
    checkPathSet(files.map((f) => f.path));
  } catch (err) {
    errors.push((err as Error).message.replace("the archive has", "the skill has"));
  }
  if (files.length > SKILL_LIMITS.files) errors.push(`the skill has ${files.length} files; at most ${SKILL_LIMITS.files}`);
  if (total > SKILL_LIMITS.skillBytes) errors.push(`the skill is ${fmt(total)}; at most ${fmt(SKILL_LIMITS.skillBytes)}`);
  const md = files.find((f) => f.path === "SKILL.md");
  let meta: Meta | null = null;
  let description = "";
  let upstreamVersion: string | null = null;
  let allowedTools: string | null = null;
  let skillMd: string | null = null;
  if (!md) errors.push("no SKILL.md");
  else {
    if (md.size > SKILL_LIMITS.skillMdBytes) errors.push(`SKILL.md is ${fmt(md.size)}; at most ${fmt(SKILL_LIMITS.skillMdBytes)}`);
    skillMd = textOf(md.data);
    if (skillMd === null) errors.push("SKILL.md: not valid UTF-8");
    else {
      const [m, err] = parseFrontmatter(skillMd);
      if (err) errors.push(`SKILL.md: ${err}`);
      else {
        const check = validateSkillFrontmatter(m!, dirName);
        errors.push(...check.errors);
        warnings.push(...check.warnings);
        meta = frontmatterJson(m!);
        description = check.description?.trim() ?? "";
        upstreamVersion = check.upstreamVersion;
        allowedTools = check.allowedTools;
      }
    }
  }
  if (!md?.deliver && md) errors.push("SKILL.md can't be excluded from delivery");
  const scan = scanSkillFiles(files, base, allowedTools);
  errors.push(...scan.rejects);
  for (const f of files) f.is_script = scan.scripts.has(f.path);
  const flags = [...scan.flags];
  if (description.length > 500) flags.push({ kind: "large_description", path: "SKILL.md", message: `the description is ${description.length} characters; long descriptions crowd out other skills`, high_risk: false });
  return {
    errors,
    warnings,
    meta,
    description,
    upstreamVersion,
    allowedTools,
    flags: flags.sort((a, b) => Number(b.high_risk) - Number(a.high_risk)),
    hasScripts: scan.hasScripts,
    files,
    contentHash: contentHash(files),
    totalBytes: total,
    skillMd,
  };
}

/** A published version's files and facts, for flags that depend on what changed. */
export async function baseInfo(db: Queryable, versionId: string | null): Promise<BaseInfo | null> {
  if (!versionId) return null;
  const { rows } = await db.query<{ path: string; sha256: string; managed: boolean; deliver: boolean; data: Buffer; allowed_tools: string | null }>(
    `SELECT f.path, f.sha256, f.managed, f.deliver, b.data, v.allowed_tools FROM skill_files f JOIN skill_blobs b ON b.sha256 = f.sha256 JOIN skill_versions v ON v.id = f.version_id WHERE f.version_id = $1`,
    [versionId],
  );
  if (!rows.length) return null;
  return {
    shas: new Map(rows.map((r) => [r.path, r.sha256])),
    deliver: new Map(rows.map((r) => [r.path, r.deliver])),
    hosts: hostsOf(rows.map((r) => ({ path: r.path, data: r.data }))),
    allowedTools: rows[0]!.allowed_tools,
    files: rows.map((r) => ({ path: r.path, sha256: r.sha256, managed: r.managed, text: r.path === "SKILL.md" ? textOf(r.data) : undefined })),
  };
}

/** Stores blobs; reuse refreshes created_at so the janitor (unreferenced and older than 24 h) can't race an import. */
export async function storeBlobs(tx: Queryable, files: PreparedFile[]) {
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.sha256)) continue;
    seen.add(f.sha256);
    await tx.query("INSERT INTO skill_blobs (sha256, size, data) VALUES ($1, $2, $3) ON CONFLICT (sha256) DO UPDATE SET created_at = now()", [f.sha256, f.size, Buffer.from(f.data)]);
  }
}

export interface NewVersion {
  skillId: string;
  state: "pending" | "published";
  baseVersionId: string | null;
  prepared: PreparedSkill;
  summary: string;
  authorId: string | null;
  sourceCommit?: string | null;
  sourceRef?: string | null;
  importId?: string | null;
  restoredFrom?: number | null;
  guidanceHash?: string | null;
  direct?: boolean;
}

/** Inserts version N+1 (and its files); an older pending version is superseded first. Returns id and number. */
export async function insertVersion(tx: Queryable, v: NewVersion, supersededBy: string): Promise<{ id: string; version: number; superseded: { id: string; version: number; author_id: string | null } | null }> {
  const old = (
    await tx.query<{ id: string; version: number; author_id: string | null }>("SELECT id, version, author_id FROM skill_versions WHERE skill_id = $1 AND state = 'pending'", [v.skillId])
  ).rows[0];
  const next = ((await tx.query<{ n: number }>("SELECT coalesce(max(version), 0)::int AS n FROM skill_versions WHERE skill_id = $1", [v.skillId])).rows[0]!.n ?? 0) + 1;
  if (old) await tx.query("UPDATE skill_versions SET state = 'superseded', decided_at = now(), reason = $2 WHERE id = $1", [old.id, `superseded by v${next} from ${supersededBy}`]);
  await storeBlobs(tx, v.prepared.files);
  const p = v.prepared;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO skill_versions (skill_id, version, state, base_version_id, description, frontmatter, upstream_version, content_hash, guidance_hash,
                                 file_count, total_bytes, has_scripts, allowed_tools, flags, summary, source_commit, source_ref, import_id,
                                 restored_from, author_id, direct, decided_at, created_via)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, CASE WHEN $3 = 'published' THEN now() END, $22)
     RETURNING id`,
    [
      v.skillId,
      next,
      v.state,
      v.baseVersionId,
      p.description,
      JSON.stringify(p.meta ?? {}),
      p.upstreamVersion,
      p.contentHash,
      v.guidanceHash ?? null,
      p.files.length,
      p.totalBytes,
      p.hasScripts,
      p.allowedTools,
      JSON.stringify(p.flags),
      v.summary.slice(0, 2000),
      v.sourceCommit ?? null,
      v.sourceRef ?? null,
      v.importId ?? null,
      v.restoredFrom ?? null,
      v.authorId,
      !!v.direct,
      // Proposed through Claude (propose_skill, or a sync it started): shown in review, like a proposal's.
      requestVia() === "mcp" ? "mcp" : null,
    ],
  );
  const id = rows[0]!.id;
  for (const f of p.files) {
    await tx.query("INSERT INTO skill_files (version_id, path, sha256, size, kind, is_script, managed, deliver) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [
      id,
      f.path,
      f.sha256,
      f.size,
      f.kind,
      f.is_script,
      f.managed,
      f.deliver,
    ]);
  }
  if (v.state === "published") await tx.query("UPDATE skills SET current_version_id = $2, updated_at = now() WHERE id = $1", [v.skillId, id]);
  return { id, version: next, superseded: old ?? null };
}

/** Files of a version, with their bytes. */
export async function versionFiles(db: Queryable, versionId: string, opts: { deliverOnly?: boolean } = {}) {
  const { rows } = await db.query<{ path: string; sha256: string; size: number; kind: "text" | "binary"; is_script: boolean; managed: boolean; deliver: boolean; data: Buffer }>(
    `SELECT f.path, f.sha256, f.size, f.kind, f.is_script, f.managed, f.deliver, b.data
       FROM skill_files f JOIN skill_blobs b ON b.sha256 = f.sha256
      WHERE f.version_id = $1 ${opts.deliverOnly ? "AND f.deliver" : ""} ORDER BY f.path COLLATE "C"`,
    [versionId],
  );
  return rows;
}

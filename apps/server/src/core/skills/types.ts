import { createHash } from "node:crypto";

/**
 * Skills for Claude: shared types, limits and small helpers. A skill is a folder (SKILL.md plus references, scripts and
 * assets) that Claude follows, so its content is treated as untrusted data everywhere: it's reviewed by a second
 * person before it's published, scanned for secrets and hidden text, never executed here, and only delivered to the
 * people its assignments name.
 */

export const SKILL_LIMITS = {
  /** Files in one skill (SKILL.md included). */
  files: 300,
  fileBytes: 2 * 1024 * 1024,
  skillBytes: 10 * 1024 * 1024,
  skillMdBytes: 200 * 1024,
  /** Whole archive, unpacked. */
  uncompressedBytes: 200 * 1024 * 1024,
  archiveEntries: 10_000,
  skillsPerImport: 500,
  pathChars: 300,
  depth: 12,
} as const;

/** get_skill / get_skill_file return raw text in parts of at most this many characters (≈ 10 000 tokens). */
export const SKILL_PART_CHARS = 40_000;

/** Bumped whenever stamping or validation rules change, so a re-import re-evaluates even at the same commit. */
export const IMPORTER_VERSION = 2;

/** Skill and collection names: the Agent Skills spec's lowercase-hyphen form. */
export const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type DeliveryState = "on" | "off" | "admins_only" | "opted_out";

export const DELIVERY_MESSAGES: Record<Exclude<DeliveryState, "on">, string> = {
  off: "Skills are switched off by an Administrator.",
  opted_out: "You switched off sending your skills to Claude (Account › Skills for Claude).",
  admins_only: "Skills are being piloted by Administrators and aren't available to you yet.",
};

export interface SkillFlag {
  kind: string;
  path: string;
  line?: number;
  message: string;
  high_risk: boolean;
}

/** A file of a skill as the importer or an editor hands it over. */
export interface SkillFile {
  path: string;
  data: Uint8Array;
  /** A core/ copy stamped by the importer. */
  managed?: boolean;
  /** False: imported for reviewers only (the source's no_deliver globs). */
  deliver?: boolean;
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * sha256 over the sorted "path\0sha256\n" lines of a file set (a file kept from Claude adds "\0nodeliver"): equal sets
 * with the same delivery, equal hashes. Migration 052 recomputes stored hashes the same way.
 */
export function contentHash(files: { path: string; sha256: string; deliver?: boolean }[]): string {
  const lines = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => `${f.path}\0${f.sha256}${f.deliver === false ? "\0nodeliver" : ""}\n`);
  return sha256(lines.join(""));
}

// ignoreBOM: a leading byte-order mark stays in the text, as with Python's "utf-8" codec (validate.py then refuses it).
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Strict UTF-8 text, or null for anything that isn't (or holds NUL bytes). */
export function textOf(data: Uint8Array): string | null {
  if (data.includes(0)) return null;
  try {
    return utf8.decode(data);
  } catch {
    return null;
  }
}

/** Code points, like Python's len(). */
export function pyLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Python's str.isspace() set, for str.strip() / rstrip() semantics (JS trim differs: \x1c-\x1f, \x85, ﻿). */
const PY_SPACE = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_RSTRIP = new RegExp(`[${PY_SPACE}]+$`);
const PY_LSTRIP = new RegExp(`^[${PY_SPACE}]+`);
export const pyRstrip = (s: string) => s.replace(PY_RSTRIP, "");
export const pyStrip = (s: string) => s.replace(PY_LSTRIP, "").replace(PY_RSTRIP, "");

/** fnmatch-style glob for posix paths: `**` crosses folders, `*` and `?` don't. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // "a/**/b" also matches "a/b"; "x/**" matches everything under x (and x itself).
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether a path matches a glob, or lies inside a folder the glob names ("plugins/x" and "plugins/x/**" both cover plugins/x/a). */
export function matchesGlob(path: string, glob: string): boolean {
  const g = glob.trim().replace(/^\/+|\/+$/g, "");
  if (!g) return false;
  const re = globToRegExp(g);
  if (re.test(path)) return true;
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) if (re.test(parts.slice(0, i).join("/"))) return true;
  return false;
}

/** Globs as people type them: trimmed, no leading or trailing slashes, no empty ones, no dot segments. */
export function cleanGlobs(globs: string[] | undefined | null): string[] {
  const out: string[] = [];
  for (const raw of globs ?? []) {
    const g = String(raw).trim().replace(/^\/+|\/+$/g, "");
    if (!g || g.length > 200 || /[\\\u0000-\u001f]/.test(g) || g.split("/").some((s) => s === "..")) continue;
    if (!out.includes(g)) out.push(g);
  }
  return out.slice(0, 50);
}

/** The Claude Code folder for a synced skill: thaliyola-<name>, shortened with a hash when longer than 64 characters. */
export function syncDirOf(name: string): string {
  const dir = `thaliyola-${name}`;
  if (dir.length <= 64) return dir;
  return `thaliyola-${name.slice(0, 45).replace(/-+$/, "")}-${sha256(name).slice(0, 6)}`;
}

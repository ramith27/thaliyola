import type { TreeEntry } from "./archive.js";
import { pyRstrip, sha256 } from "./types.js";

/**
 * A faithful port of the claude-skills repo's ci/sync_core.py, run on the in-memory tree of an import: the shared
 * guidance in core/files is copied into the skills that qualify, and core/pointers becomes a marker block right after
 * each one's frontmatter. Names follow the Python ones (splitFrontmatter ↔ split_frontmatter, …) so the two can be
 * read side by side; a parity test runs both on the real repository.
 *
 * One deliberate deviation: sync_core aborts the whole tree on a skill-level problem (a collision, malformed markers, a
 * symlink, non-UTF-8 SKILL.md); here that skill alone is rejected, with sync_core's message, so one bad skill doesn't
 * block the rest. Core-level problems (a missing header, an unpaired file, a marker in a pointer, a symlink in core/)
 * still fail the run, exactly as in Python.
 */

export const MENTIONS = ["tableau", "clickhouse", "redshift"] as const;
// Python's \b with re.IGNORECASE on str is Unicode-aware (letters, digits and underscore are word characters), and
// its case-insensitive "i" also matches İ and ı; "tableau_server" and "éTableau" don't count, "Tableau," does.
const MENTION_RE = /(?<![\p{L}\p{N}_])(tableau|cl[iİı]ckhouse|redsh[iİı]ft)(?![\p{L}\p{N}_])/iu;
export const MARKER_RE = /<!-- (\/?)core:([a-z0-9]+(?:-[a-z0-9]+)*)(?: [^\n]*?)? -->/g;
const JUNK_NAMES = new Set(["__pycache__", ".DS_Store"]);
const JUNK_SUFFIXES = new Set([".pyc"]);
export const MANAGED_PREFIX = "<!-- managed by ci/sync_core.py";

export class SyncError extends Error {}

export interface Change {
  path: string;
  kind: "write" | "delete";
  data: Uint8Array | null;
}

export const managedHeader = (name: string) => `<!-- managed by ci/sync_core.py; edit core/files/${name} in the claude-skills repo -->`;
export const beginMarker = (stem: string) => `<!-- core:${stem} managed by ci/sync_core.py; edit core/pointers/${stem}.md -->`;
export const endMarker = (stem: string) => `<!-- /core:${stem} -->`;

const enc = new TextEncoder();
// ignoreBOM: a leading byte-order mark stays in the text (Python's "utf-8" codec keeps it as U+FEFF too).
const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Python's PurePath.suffix / .stem. */
export function pySuffix(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i) : "";
}
export function pyStem(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(0, i) : name;
}

const isJunk = (name: string) => JUNK_NAMES.has(name) || JUNK_SUFFIXES.has(pySuffix(name));

function startsWithBytes(data: Uint8Array, prefix: string): boolean {
  const p = enc.encode(prefix);
  if (data.length < p.length) return false;
  for (let i = 0; i < p.length; i++) if (data[i] !== p[i]) return false;
  return true;
}

/** A read-only view of the tree with the directory questions sync_core asks (is_dir, iterdir, is_symlink). */
export class TreeView {
  private readonly dirs = new Set<string>();
  constructor(readonly entries: Map<string, TreeEntry>) {
    for (const p of entries.keys()) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) this.dirs.add(parts.slice(0, i).join("/"));
    }
  }
  isDir(p: string) {
    return this.dirs.has(p);
  }
  isFile(p: string) {
    return this.entries.get(p)?.type === "file";
  }
  isSymlink(p: string) {
    return this.entries.get(p)?.type === "symlink";
  }
  exists(p: string) {
    return this.entries.has(p) || this.dirs.has(p);
  }
  read(p: string): Uint8Array {
    const e = this.entries.get(p);
    if (!e || e.type !== "file") throw new SyncError(`${p}: is not a regular file`);
    return e.data;
  }
  /** Names directly inside a folder, sorted like Python's sorted(iterdir()). */
  children(dir: string): string[] {
    const prefix = dir ? `${dir}/` : "";
    const out = new Set<string>();
    for (const p of this.entries.keys()) if (p.startsWith(prefix)) out.add(p.slice(prefix.length).split("/")[0]!);
    return [...out].sort();
  }
}

const join = (...parts: string[]) => parts.filter(Boolean).join("/");

function noSymlink(t: TreeView, p: string) {
  if (t.isSymlink(p)) throw new SyncError(`${p}: symlinks are not allowed`);
}

function readText(t: TreeView, p: string): string {
  try {
    return dec.decode(t.read(p));
  } catch (err) {
    if (err instanceof SyncError) throw err;
    throw new SyncError(`${p}: not valid UTF-8 (${(err as Error).message})`);
  }
}

// ---- inputs --------------------------------------------------------------------------------------------------

export function coreFiles(t: TreeView, core: string): Map<string, Uint8Array> {
  noSymlink(t, core);
  const d = join(core, "files");
  noSymlink(t, d);
  const out = new Map<string, Uint8Array>();
  if (!t.isDir(d)) return out;
  for (const name of t.children(d)) {
    const p = join(d, name);
    noSymlink(t, p);
    if (!t.isFile(p) || isJunk(name)) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) throw new SyncError(`${p}: core files must be lowercase-hyphen names ending in .md`);
    const data = t.read(p);
    if (!startsWithBytes(data, managedHeader(name))) throw new SyncError(`${p}: first line must be '${managedHeader(name)}'`);
    out.set(name, data);
  }
  return out;
}

export function pointers(t: TreeView, core: string): Map<string, string> {
  noSymlink(t, core);
  const d = join(core, "pointers");
  noSymlink(t, d);
  const out = new Map<string, string>();
  if (!t.isDir(d)) return out;
  for (const name of t.children(d)) {
    if (!name.endsWith(".md")) continue;
    const p = join(d, name);
    noSymlink(t, p);
    const body = readText(t, p).replace(/^\n+|\n+$/g, "");
    if (new RegExp(MARKER_RE.source).test(body)) throw new SyncError(`${p}: a pointer must not contain a core:* marker`);
    out.set(name, body);
  }
  return out;
}

export interface Core {
  files: Map<string, Uint8Array>;
  pointers: Map<string, string>;
}

/** (files, pointers), validated as a pair. A missing core/ means no core. */
export function loadCore(t: TreeView, core = "core"): Core {
  if (!t.isDir(core) && !t.isSymlink(core)) return { files: new Map(), pointers: new Map() };
  noSymlink(t, core);
  const files = coreFiles(t, core);
  const ptrs = pointers(t, core);
  const names = [...new Set([...files.keys(), ...ptrs.keys()])].filter((n) => files.has(n) !== ptrs.has(n)).sort();
  for (const name of names) throw new SyncError(`${core}/files/${name} and ${core}/pointers/${name} must both exist`);
  return { files, pointers: ptrs };
}

export function pluginDirs(t: TreeView, root: string): string[] {
  noSymlink(t, root);
  if (!t.isDir(root)) return [];
  const out: string[] = [];
  for (const name of t.children(root)) {
    const p = join(root, name);
    noSymlink(t, p);
    if (t.isDir(p) && !isJunk(name)) {
      noSymlink(t, join(p, "skills"));
      out.push(p);
    }
  }
  return out;
}

/** Skill folders of a plugin; a symlinked skill folder or SKILL.md is reported per skill (`bad`). */
export function skillDirs(t: TreeView, plugin: string, bad: Map<string, string>): string[] {
  const sdir = join(plugin, "skills");
  if (!t.isDir(sdir)) return [];
  const out: string[] = [];
  for (const name of t.children(sdir)) {
    const d = join(sdir, name);
    if (t.isSymlink(d)) {
      bad.set(d, `${d}: symlinks are not allowed`);
      continue;
    }
    const md = join(d, "SKILL.md");
    if (t.isDir(d) && !isJunk(name) && (t.isFile(md) || t.isSymlink(md))) {
      if (t.isSymlink(md)) {
        bad.set(d, `${md}: symlinks are not allowed`);
        continue;
      }
      out.push(d);
    }
  }
  return out;
}

/** Stems of files directly in the skill folder that carry a managed header (remnants included). */
export function managedStems(t: TreeView, skillDir: string): Set<string> {
  const out = new Set<string>();
  for (const name of t.children(skillDir)) {
    const p = join(skillDir, name);
    noSymlink(t, p);
    if (t.isFile(p) && pySuffix(name) === ".md" && name !== "SKILL.md") {
      if (startsWithBytes(t.read(p), managedHeader(name))) out.add(pyStem(name));
    }
  }
  return out;
}

// ---- frontmatter + marker blocks ---------------------------------------------------------------------------------

/** [frontmatter including both fences and the newline after the closing one, rest], or null. */
export function splitFrontmatter(text: string): [string, string] | null {
  const lines = text.split("\n");
  if (!lines.length || pyRstrip(lines[0]!) !== "---") return null;
  for (let i = 1; i < lines.length; i++) {
    if (pyRstrip(lines[i]!) === "---") return [lines.slice(0, i + 1).join("\n") + "\n", lines.slice(i + 1).join("\n")];
  }
  return null;
}

function markers(text: string) {
  return [...text.matchAll(new RegExp(MARKER_RE.source, "g"))];
}

/** [start, end] of the one block named `stem`, null if absent; errors on duplicates or unbalanced markers. */
export function findBlock(text: string, stem: string, where: string): [number, number] | null {
  const all = markers(text);
  const begins = all.filter((m) => m[2] === stem && !m[1]);
  const ends = all.filter((m) => m[2] === stem && m[1]);
  if (!begins.length && !ends.length) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0]!.index! < begins[0]!.index! + begins[0]![0].length) {
    throw new SyncError(`${where}: marker block core:${stem} is duplicated or unbalanced; fix it by hand`);
  }
  return [begins[0]!.index!, ends[0]!.index! + ends[0]![0].length];
}

export function blockStems(text: string): Set<string> {
  return new Set(markers(text).map((m) => m[2]!));
}

export function upsertBlock(text: string, stem: string, body: string, where: string): string {
  const block = `${beginMarker(stem)}\n${body}\n${endMarker(stem)}`;
  const span = findBlock(text, stem, where);
  if (span) return text.slice(0, span[0]) + block + text.slice(span[1]);
  const fm = splitFrontmatter(text);
  if (fm === null) throw new SyncError(`${where}: no frontmatter; cannot place the core:${stem} pointer`);
  const [head, rest] = fm;
  // One bare "\n" on each side of the block; removeBlock() strips exactly those, so the original bytes (LF or CRLF,
  // any spacing) come back unchanged after a stamp-and-remove.
  const sep = rest.startsWith("\n") || rest.startsWith("\r\n") ? "\n" : "\n\n";
  return head + "\n" + block + sep + rest;
}

export function removeBlock(text: string, stem: string, where: string): string {
  const span = findBlock(text, stem, where);
  if (span === null) return text;
  let left = text.slice(0, span[0]);
  let right = text.slice(span[1]);
  if (left.endsWith("\n")) left = left.slice(0, -1);
  if (right.startsWith("\n")) right = right.slice(1);
  return left + right;
}

/** The text with every core:* block removed. */
export function withoutBlocks(text: string, where: string): string {
  let bare = text;
  for (const stem of [...blockStems(text)].sort()) bare = removeBlock(bare, stem, where);
  return bare;
}

/** True when the skill text, with every core:* block removed, names one of MENTIONS as a whole word. */
export function mentionsDataSource(text: string, where: string): boolean {
  return MENTION_RE.test(withoutBlocks(text, where));
}

/** True when the skill's plugin has a .mcp.json at its root (skills/<skill> → plugin root). */
export function pluginShipsConnectors(t: TreeView, skillDir: string): boolean {
  const plugin = skillDir.split("/").slice(0, -2).join("/");
  const mcp = join(plugin, ".mcp.json");
  noSymlink(t, mcp);
  return t.isFile(mcp);
}

type Rule = (t: TreeView, skillDir: string, text: string, where: string) => boolean;
const dataSourceRule: Rule = (_t, _d, text, where) => mentionsDataSource(text, where);
const connectorRule: Rule = (t, d, text, where) => mentionsDataSource(text, where) || pluginShipsConnectors(t, d);

/** Core file name → which skills receive it; files not listed use the data-source rule. */
export const QUALIFIERS: Record<string, Rule> = {
  "datasources.md": dataSourceRule,
  "connectors.md": connectorRule,
  "table-knowledge.md": dataSourceRule,
};

export function qualifies(name: string, t: TreeView, skillDir: string, text: string, where: string): boolean {
  return (QUALIFIERS[name] ?? dataSourceRule)(t, skillDir, text, where);
}

// ---- plan / apply -----------------------------------------------------------------------------------------------

export interface StampPlan {
  changes: Change[];
  /** Skill folder → sync_core's message, for skills that can't be stamped (rejected; the rest go ahead). */
  skillErrors: Map<string, string>;
  /** Skill folder → core files it now carries. */
  stamped: Map<string, string[]>;
  /** Copies this plan put in place (or found identical to core/files): the only files an import marks as managed. */
  managed: Set<string>;
}

/**
 * Every write or delete that brings plugins/ in line with core/ (read-only). Throws SyncError for core-level problems;
 * a skill-level problem rejects that skill (its changes are left out).
 */
export function planStamp(entries: Map<string, TreeEntry>, opts: { core?: string | null; pluginsRoot?: string } = {}): StampPlan {
  const t = new TreeView(entries);
  const pluginsRoot = opts.pluginsRoot ?? "plugins";
  const coreDir = opts.core === undefined ? "core" : opts.core;
  noSymlink(t, pluginsRoot);
  if (coreDir) noSymlink(t, coreDir);
  const { files, pointers: ptrs } = coreDir ? loadCore(t, coreDir) : { files: new Map<string, Uint8Array>(), pointers: new Map<string, string>() };
  const changes: Change[] = [];
  const skillErrors = new Map<string, string>();
  const stamped = new Map<string, string[]>();
  const managed = new Set<string>();
  for (const plugin of pluginDirs(t, pluginsRoot)) {
    for (const d of skillDirs(t, plugin, skillErrors)) {
      const mine: Change[] = [];
      const got: string[] = [];
      const copies: string[] = [];
      try {
        const md = join(d, "SKILL.md");
        const where = md;
        const text = readText(t, md);
        let next = text;
        const stems = [...new Set([...[...files.keys()].map(pyStem), ...blockStems(text), ...managedStems(t, d)])].sort();
        for (const stem of stems) {
          const name = `${stem}.md`;
          const copy = join(d, name);
          noSymlink(t, copy);
          if (files.has(name) && qualifies(name, t, d, text, where)) {
            next = upsertBlock(next, stem, ptrs.get(name)!, where);
            got.push(name);
            copies.push(copy);
            if (t.exists(copy)) {
              if (!t.isFile(copy)) throw new SyncError(`${copy}: exists and is not a managed copy (missing the managed header); rename it or the core file`);
              const current = t.read(copy);
              if (!startsWithBytes(current, managedHeader(name))) {
                throw new SyncError(`${copy}: exists and is not a managed copy (missing the managed header); rename it or the core file`);
              }
              if (sha256(current) !== sha256(files.get(name)!)) mine.push({ path: copy, kind: "write", data: files.get(name)! });
            } else mine.push({ path: copy, kind: "write", data: files.get(name)! });
          } else {
            next = removeBlock(next, stem, where);
            if (t.isFile(copy) && startsWithBytes(t.read(copy), managedHeader(name))) mine.push({ path: copy, kind: "delete", data: null });
          }
        }
        if (next !== text) mine.push({ path: md, kind: "write", data: enc.encode(next) });
      } catch (err) {
        if (!(err instanceof SyncError)) throw err;
        skillErrors.set(d, err.message);
        continue;
      }
      changes.push(...mine);
      if (got.length) stamped.set(d, got);
      for (const c of copies) managed.add(c);
    }
  }
  return { changes, skillErrors, stamped, managed };
}

/** Deletes first, then writes (a new Map; the input is left alone). */
export function applyStamp(entries: Map<string, TreeEntry>, changes: Change[]): Map<string, TreeEntry> {
  const out = new Map(entries);
  for (const c of changes) if (c.kind === "delete") out.delete(c.path);
  for (const c of changes) if (c.kind === "write") out.set(c.path, { type: "file", data: c.data ?? new Uint8Array(0) });
  return out;
}

// ---- guidance-only versions ----------------------------------------------------------------------------------

export interface HashedFile {
  path: string;
  sha256: string;
  managed: boolean;
  /** SKILL.md text, for comparing it without its core blocks. */
  text?: string | null;
}

function blocksOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const stem of blockStems(text)) {
    try {
      const span = findBlock(text, stem, "SKILL.md");
      if (span) out.set(stem, text.slice(span[0], span[1]));
    } catch {
      // malformed: compared as text below
    }
  }
  return out;
}

/**
 * When two versions differ only in shared guidance (managed copies and the contents of core:* blocks, with SKILL.md
 * and every other file otherwise byte-identical), the hash of that change: the same for every skill that got the same
 * core change, so Review can approve them together. Null otherwise.
 */
export function guidanceOnly(base: HashedFile[], next: HashedFile[]): string | null {
  const b = new Map(base.map((f) => [f.path, f]));
  const n = new Map(next.map((f) => [f.path, f]));
  const parts: string[] = [];
  let changed = false;
  for (const path of [...new Set([...b.keys(), ...n.keys()])].sort()) {
    const x = b.get(path);
    const y = n.get(path);
    if (x && y && x.sha256 === y.sha256) continue;
    if (path === "SKILL.md") {
      const tx = x?.text;
      const ty = y?.text;
      if (typeof tx !== "string" || typeof ty !== "string") return null;
      try {
        if (withoutBlocks(tx, path) !== withoutBlocks(ty, path)) return null;
      } catch {
        return null;
      }
      const bx = blocksOf(tx);
      const by = blocksOf(ty);
      for (const stem of [...new Set([...bx.keys(), ...by.keys()])].sort()) {
        if (bx.get(stem) !== by.get(stem)) parts.push(`block:${stem}\0${by.has(stem) ? sha256(by.get(stem)!) : "-"}`);
      }
      changed = true;
      continue;
    }
    if ((x && !x.managed) || (y && !y.managed)) return null;
    parts.push(`file:${path}\0${y ? y.sha256 : "-"}`);
    changed = true;
  }
  return changed ? sha256(parts.join("\n")) : null;
}

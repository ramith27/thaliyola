import { gunzipSync } from "node:zlib";
import { Inflate } from "fflate";
import { ValidationError } from "../context.js";
import { SKILL_LIMITS } from "./types.js";

/**
 * Reads a .zip or .tar.gz into memory: never touches the filesystem, never runs anything. Every entry's path is
 * checked first and one bad path rejects the whole archive (zip slip): absolute paths, `..` or `.` segments,
 * backslashes, control characters, drive letters, empty segments, overlong or too deep paths, duplicates and paths
 * that differ only by case or Unicode normalisation (synced folders land on case-insensitive file systems).
 * Symlinks, hard links, devices and FIFOs are kept as markers, so the importer can reject the skill that holds one.
 */

export type EntryType = "file" | "symlink" | "special";

export interface TreeEntry {
  data: Uint8Array;
  type: EntryType;
}

export interface VirtualTree {
  /** posix path (relative, no top folder) → entry. Directories aren't listed. */
  entries: Map<string, TreeEntry>;
  /** The top folder that was stripped (GitHub owner-repo-sha/, a zipped folder), if any. */
  topName: string | null;
  /** The commit a `git archive` recorded in its global pax header, if any. */
  commit: string | null;
  /** Paths dropped by the upload's root .gitignore. */
  ignored: string[];
  warnings: { path: string; message: string }[];
}

export interface ArchiveLimits {
  maxEntries?: number;
  maxUncompressed?: number;
}

export class ArchiveError extends ValidationError {}

const CONTROL = /[\u0000-\u001f\u007f]/;

/** The rules every entry path follows; `dir`: a directory entry (its trailing slash is allowed). */
export function checkEntryPath(raw: string, dir = false): string {
  let p = raw;
  if (dir) p = p.replace(/\/+$/, "");
  const show = JSON.stringify(raw.slice(0, 120));
  if (!p) throw new ArchiveError(`the archive has an entry with an empty name`);
  if (CONTROL.test(p)) throw new ArchiveError(`unsafe path in the archive: ${show} (control characters)`);
  if (p.includes("\\")) throw new ArchiveError(`unsafe path in the archive: ${show} (backslash)`);
  if (p.startsWith("/")) throw new ArchiveError(`unsafe path in the archive: ${show} (absolute path)`);
  if (/^[A-Za-z]:/.test(p)) throw new ArchiveError(`unsafe path in the archive: ${show} (drive letter)`);
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === "..")) throw new ArchiveError(`unsafe path in the archive: ${show} (empty, . or .. segment)`);
  if (p.length > SKILL_LIMITS.pathChars) throw new ArchiveError(`path too long in the archive (over ${SKILL_LIMITS.pathChars} characters): ${show}`);
  if (parts.length > SKILL_LIMITS.depth) throw new ArchiveError(`path too deep in the archive (over ${SKILL_LIMITS.depth} levels): ${show}`);
  return p;
}

/**
 * The same rules for a set of paths that didn't come from an archive (an editor's files): no duplicates, no case or
 * normalisation twins, no path that is both a file and a folder. Throws ArchiveError.
 */
export function checkPathSet(paths: string[]): void {
  const folded = new Map<string, string>();
  for (const p of paths) {
    const key = p.normalize("NFC").toLowerCase();
    const seen = folded.get(key);
    if (seen !== undefined) throw new ArchiveError(seen === p ? `the archive has ${JSON.stringify(p)} twice` : `the archive has both ${JSON.stringify(seen)} and ${JSON.stringify(p)}, which are the same file on a case-insensitive disk`);
    folded.set(key, p);
  }
  const dirs = new Set<string>();
  for (const key of folded.keys()) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const [key, p] of folded) if (dirs.has(key)) throw new ArchiveError(`the archive has ${JSON.stringify(p)} as both a file and a folder`);
}

/** Collects entries, refusing duplicates and case or normalisation twins. */
class Collector {
  readonly entries = new Map<string, TreeEntry>();
  private readonly folded = new Map<string, string>();
  private total = 0;
  private count = 0;
  constructor(private readonly limits: Required<ArchiveLimits>) {}

  counted() {
    if (++this.count > this.limits.maxEntries) throw new ArchiveError(`the archive has more than ${this.limits.maxEntries} entries`);
  }

  budget(n: number) {
    this.total += n;
    if (this.total > this.limits.maxUncompressed) throw new ArchiveError(`the archive unpacks to more than ${Math.round(this.limits.maxUncompressed / 1024 / 1024)} MB`);
  }

  remaining() {
    return this.limits.maxUncompressed - this.total;
  }

  add(path: string, entry: TreeEntry) {
    const key = path.normalize("NFC").toLowerCase();
    const seen = this.folded.get(key);
    if (seen !== undefined) {
      throw new ArchiveError(seen === path ? `the archive has ${JSON.stringify(path)} twice` : `the archive has both ${JSON.stringify(seen)} and ${JSON.stringify(path)}, which are the same file on a case-insensitive disk`);
    }
    this.folded.set(key, path);
    this.entries.set(path, entry);
  }
}

const fullLimits = (l: ArchiveLimits = {}): Required<ArchiveLimits> => ({
  maxEntries: l.maxEntries ?? SKILL_LIMITS.archiveEntries,
  maxUncompressed: l.maxUncompressed ?? SKILL_LIMITS.uncompressedBytes,
});

const utf8 = new TextDecoder("utf-8", { fatal: true });
function decodeName(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new ArchiveError("the archive has a file name that isn't UTF-8");
  }
}

// ---- zip --------------------------------------------------------------------------------------------------------

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** Our own central-directory reader: never trusts declared sizes, refuses what we can't read safely. */
export function readZip(buf: Uint8Array, limits?: ArchiveLimits): { entries: Map<string, TreeEntry>; commit: string | null } {
  const c = new Collector(fullLimits(limits));
  // End of central directory: the last signature within the final 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ArchiveError("not a zip file (no end of central directory)");
  if (eocd >= 20 && u32(buf, eocd - 20) === 0x07064b50) throw new ArchiveError("ZIP64 archives aren't supported; repack as a plain zip");
  const disk = u16(buf, eocd + 4);
  const cdDisk = u16(buf, eocd + 6);
  const total = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (disk !== 0 || cdDisk !== 0 || u16(buf, eocd + 8) !== total) throw new ArchiveError("multi-disk zip archives aren't supported; repack as a plain zip");
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ArchiveError("ZIP64 archives aren't supported; repack as a plain zip");
  if (cdOffset + cdSize > eocd) throw new ArchiveError("the zip file is damaged (central directory out of range)");
  // `git archive --format=zip` (GitLab's "Download zip") stores the commit as the archive comment.
  const zipComment = Buffer.from(buf.subarray(eocd + 22, Math.min(buf.length, eocd + 22 + u16(buf, eocd + 20)))).toString("latin1");
  const commit = /^[0-9a-f]{40}$/.test(zipComment) ? zipComment : null;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) throw new ArchiveError("the zip file is damaged (bad central directory entry)");
    c.counted();
    const madeBy = u16(buf, p + 4) >> 8;
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const csize = u32(buf, p + 20);
    const usize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const ext = u32(buf, p + 38);
    const local = u32(buf, p + 42);
    const nameBytes = buf.subarray(p + 46, p + 46 + nameLen);
    const name = decodeName(nameBytes);
    p += 46 + nameLen + extraLen + commentLen;
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff) throw new ArchiveError("ZIP64 archives aren't supported; repack as a plain zip");
    const isDir = name.endsWith("/");
    const path = checkEntryPath(name, isDir);
    if (flags & 1) throw new ArchiveError(`${JSON.stringify(path)} is encrypted; repack as a plain zip`);
    const mode = (ext >>> 16) & 0o170000;
    const unix = madeBy === 3 || madeBy === 19;
    if (isDir || (unix && mode === 0o040000)) continue;
    // The local header must name the same file (a mismatch is how some zip-slip archives hide their real path).
    if (local + 30 > buf.length || u32(buf, local) !== 0x04034b50) throw new ArchiveError("the zip file is damaged (bad local header)");
    const lNameLen = u16(buf, local + 26);
    const lExtraLen = u16(buf, local + 28);
    const lName = buf.subarray(local + 30, local + 30 + lNameLen);
    if (lName.length !== nameBytes.length || !lName.every((b, i) => b === nameBytes[i])) throw new ArchiveError(`the zip's local and central names differ for ${JSON.stringify(path)}`);
    const start = local + 30 + lNameLen + lExtraLen;
    if (start + csize > buf.length) throw new ArchiveError("the zip file is truncated");
    const raw = buf.subarray(start, start + csize);
    if (unix && mode === 0o120000) {
      c.add(path, { type: "symlink", data: new Uint8Array(0) });
      continue;
    }
    if (unix && mode !== 0 && mode !== 0o100000) {
      c.add(path, { type: "special", data: new Uint8Array(0) });
      continue;
    }
    let data: Uint8Array;
    if (method === 0) {
      c.budget(raw.length);
      data = raw.slice();
    } else if (method === 8) data = inflateBounded(raw, c);
    else throw new ArchiveError(`${JSON.stringify(path)} uses compression method ${method}; repack as a plain zip (stored or deflate)`);
    if (data.length !== usize) throw new ArchiveError(`the zip file is damaged (${JSON.stringify(path)} has the wrong size)`);
    c.add(path, { type: "file", data });
  }
  return { entries: c.entries, commit };
}

/** Inflates with a running budget: a zip bomb stops at the limit, whatever sizes it declares. */
function inflateBounded(raw: Uint8Array, c: Collector): Uint8Array {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  const inf = new Inflate((chunk, final) => {
    size += chunk.length;
    c.budget(chunk.length);
    if (size > SKILL_LIMITS.uncompressedBytes) throw new ArchiveError("an entry unpacks to more than the limit");
    chunks.push(chunk);
    if (final) done = true;
  });
  try {
    const step = 64 * 1024;
    for (let i = 0; i < raw.length; i += step) inf.push(raw.subarray(i, Math.min(raw.length, i + step)), i + step >= raw.length);
    if (!raw.length) inf.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError("the zip file is damaged (bad deflate data)");
  }
  if (!done && raw.length) throw new ArchiveError("the zip file is damaged (deflate data ended early)");
  const out = new Uint8Array(size);
  let o = 0;
  for (const ch of chunks) {
    out.set(ch, o);
    o += ch.length;
  }
  return out;
}

// ---- tar.gz -----------------------------------------------------------------------------------------------------

const ascii = (b: Uint8Array, from: number, to: number) => {
  let end = from;
  while (end < to && b[end] !== 0) end++;
  return b.subarray(from, end);
};
const str = (b: Uint8Array, from: number, to: number) => Buffer.from(ascii(b, from, to)).toString("latin1");

function tarNumber(b: Uint8Array, from: number, len: number): number {
  if (b[from]! & 0x80) {
    // base-256: big-endian, first byte's top bit set (positive numbers only).
    if (b[from]! & 0x40) throw new ArchiveError("the tar file is damaged (negative size)");
    let n = b[from]! & 0x3f;
    for (let i = 1; i < len; i++) n = n * 256 + b[from + i]!;
    return n;
  }
  const s = str(b, from, from + len).trim();
  if (!s) return 0;
  if (!/^[0-7]+$/.test(s)) throw new ArchiveError("the tar file is damaged (bad number)");
  return parseInt(s, 8);
}

function checksumOk(h: Uint8Array): boolean {
  const stored = tarNumber(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  return sum === stored;
}

/** pax extended header records: "len key=value\n". */
function paxRecords(data: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (i < data.length) {
    let sp = i;
    while (sp < data.length && data[sp] !== 0x20) sp++;
    const len = parseInt(Buffer.from(data.subarray(i, sp)).toString("latin1"), 10);
    if (!Number.isFinite(len) || len <= 0 || i + len > data.length) throw new ArchiveError("the tar file is damaged (bad pax header)");
    const rec = data.subarray(sp + 1, i + len - 1);
    const eq = rec.indexOf(0x3d);
    if (eq > 0) out.set(Buffer.from(rec.subarray(0, eq)).toString("utf8"), decodeName(rec.subarray(eq + 1)));
    i += len;
  }
  return out;
}

/** gunzip (bounded) and a small ustar / pax / GNU reader. */
export function readTarGz(buf: Uint8Array, limits?: ArchiveLimits): { entries: Map<string, TreeEntry>; commit: string | null } {
  const l = fullLimits(limits);
  let tar: Uint8Array;
  try {
    tar = gunzipSync(buf, { maxOutputLength: l.maxUncompressed });
  } catch (err) {
    if (err instanceof RangeError || /larger than|maxOutputLength|buffer/i.test((err as Error).message)) throw new ArchiveError(`the archive unpacks to more than ${Math.round(l.maxUncompressed / 1024 / 1024)} MB`);
    throw new ArchiveError("not a gzip file, or it's damaged");
  }
  return readTar(tar, l);
}

export function readTar(tar: Uint8Array, limits?: ArchiveLimits): { entries: Map<string, TreeEntry>; commit: string | null } {
  const c = new Collector(fullLimits(limits));
  let commit: string | null = null;
  let off = 0;
  let pax: Map<string, string> | null = null;
  let longName: string | null = null;
  let longLink: string | null = null;
  let ended = false;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((x) => x === 0)) {
      ended = true;
      break;
    }
    if (!checksumOk(h)) throw new ArchiveError("the tar file is damaged (bad header checksum)");
    const type = String.fromCharCode(h[156]!);
    let size = tarNumber(h, 124, 12);
    if (pax?.has("size")) {
      const s = Number(pax.get("size"));
      if (!Number.isSafeInteger(s) || s < 0) throw new ArchiveError("the tar file is damaged (bad pax size)");
      size = s;
    }
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new ArchiveError("the tar file is truncated");
    const data = tar.subarray(dataStart, dataEnd);
    off = dataStart + Math.ceil(size / 512) * 512;

    if (type === "x") {
      if (pax) throw new ArchiveError("the tar file is damaged (two pax headers in a row)");
      pax = paxRecords(data);
      continue;
    }
    if (type === "g") {
      // git archive writes the commit here ("comment=<sha>").
      const g = paxRecords(data).get("comment")?.trim();
      if (g && /^[0-9a-f]{40}$/.test(g)) commit = g;
      continue;
    }
    if (type === "L" || type === "K") {
      const v = decodeName(ascii(data, 0, data.length));
      if (type === "L") longName = v;
      else longLink = v;
      continue;
    }
    c.counted();
    // The entry path: pax path / GNU long name, else POSIX prefix + name, else name. GNU headers ("ustar  \0") use
    // bytes 345+ for other fields, so they never have a prefix.
    const posix = Buffer.from(h.subarray(257, 263)).toString("latin1") === "ustar\0";
    const nameField = decodeName(ascii(h, 0, 100));
    const prefix = posix ? decodeName(ascii(h, 345, 500)) : "";
    const name = pax?.get("path") ?? longName ?? (prefix ? `${prefix}/${nameField}` : nameField);
    // The link target follows the same order (pax linkpath, GNU K, linkname); links are markers, never followed.
    void (pax?.get("linkpath") ?? longLink ?? decodeName(ascii(h, 157, 257)));
    pax = null;
    longName = null;
    longLink = null;
    if (type === "5") {
      checkEntryPath(name, true);
      continue;
    }
    const path = checkEntryPath(name);
    if (type === "0" || type === "\0" || type === "7") {
      c.budget(size);
      c.add(path, { type: "file", data: data.slice() });
    } else if (type === "1" || type === "2") c.add(path, { type: "symlink", data: new Uint8Array(0) });
    else if (type === "3" || type === "4" || type === "6") c.add(path, { type: "special", data: new Uint8Array(0) });
    else throw new ArchiveError(`the tar file has an entry of a type we don't read (${JSON.stringify(type)}) at ${JSON.stringify(path)}`);
  }
  if (!ended) throw new ArchiveError("the tar file is truncated (no end-of-archive marker)");
  return { entries: c.entries, commit };
}

// ---- after reading: junk, top folder, .gitignore ---------------------------------------------------------------

const JUNK_NAMES = new Set(["__pycache__", ".DS_Store", ".git"]);

function isJunk(path: string): boolean {
  const parts = path.split("/");
  if (parts.some((s) => JUNK_NAMES.has(s) || s === "__MACOSX")) return true;
  return path.endsWith(".pyc");
}

/** Reads either kind by its first bytes; then drops junk, strips one common top folder and (uploads) applies .gitignore. */
export function readArchive(buf: Uint8Array, opts: { gitignore?: boolean; limits?: ArchiveLimits } = {}): VirtualTree {
  let raw: { entries: Map<string, TreeEntry>; commit: string | null };
  if (buf[0] === 0x50 && buf[1] === 0x4b) raw = readZip(buf, opts.limits);
  else if (buf[0] === 0x1f && buf[1] === 0x8b) raw = readTarGz(buf, opts.limits);
  else throw new ArchiveError("upload a .zip, .tar.gz or .tgz file");
  const warnings: VirtualTree["warnings"] = [];
  let entries = new Map<string, TreeEntry>();
  for (const [p, e] of raw.entries) if (!isJunk(p)) entries.set(p, e);
  const folders = () => {
    const out = new Set<string>();
    for (const p of entries.keys()) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
    }
    return out;
  };
  // macOS Finder's AppleDouble files: "._name" next to "name". A lone one stays (and is mentioned).
  const before = folders();
  for (const p of [...entries.keys()]) {
    const slash = p.lastIndexOf("/");
    const base = p.slice(slash + 1);
    if (!base.startsWith("._") || base.length <= 2) continue;
    const sibling = `${p.slice(0, slash + 1)}${base.slice(2)}`;
    if (entries.has(sibling) || before.has(sibling)) entries.delete(p);
    else warnings.push({ path: p, message: "looks like a macOS AppleDouble file without its original" });
  }
  // A file can't also be a folder ("a" and "a/b"), in any case.
  const dirs = new Set([...folders()].map((d) => d.normalize("NFC").toLowerCase()));
  for (const p of entries.keys()) if (dirs.has(p.normalize("NFC").toLowerCase())) throw new ArchiveError(`the archive has ${JSON.stringify(p)} as both a file and a folder`);
  // One common top folder (GitHub owner-repo-sha/, GitLab project-sha-sha/, a zipped folder) is stripped.
  let topName: string | null = null;
  const firsts = new Set([...entries.keys()].map((p) => (p.includes("/") ? p.split("/")[0]! : "")));
  if (entries.size && firsts.size === 1 && !firsts.has("")) {
    topName = [...firsts][0]!;
    const stripped = new Map<string, TreeEntry>();
    for (const [p, e] of entries) stripped.set(p.slice(topName.length + 1), e);
    entries = stripped;
  }
  const ignored: string[] = [];
  if (opts.gitignore) {
    const gi = entries.get(".gitignore");
    const text = gi?.type === "file" ? Buffer.from(gi.data).toString("utf8") : "";
    const rules = parseGitignore(text);
    if (rules.length) {
      for (const p of [...entries.keys()]) {
        if (isIgnored(rules, p)) {
          entries.delete(p);
          ignored.push(p);
        }
      }
    }
  }
  return { entries, topName, commit: raw.commit, ignored: ignored.sort(), warnings };
}

// ---- .gitignore (simple globs: name, dir/, *.ext, /anchored, ! negation) -----------------------------------------

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  anchored: boolean;
}

function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    line = line.replace(/\/+$/, "");
    const anchored = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\/+/, "");
    if (!line) continue;
    let re = "";
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === "*") {
        if (line[i + 1] === "*") {
          i++;
          if (line[i + 1] === "/") {
            i++;
            re += "(?:.*/)?";
          } else re += ".*";
        } else re += "[^/]*";
      } else if (ch === "?") re += "[^/]";
      else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    rules.push({ re: new RegExp(`^${re}$`), negate, dirOnly, anchored });
  }
  return rules;
}

function isIgnored(rules: IgnoreRule[], path: string): boolean {
  const parts = path.split("/");
  let ignored = false;
  for (const r of rules) {
    // Candidates: the file itself (not for dir-only rules) and every folder above it.
    let hit = false;
    for (let i = 1; i <= parts.length && !hit; i++) {
      const isDir = i < parts.length;
      if (r.dirOnly && !isDir) continue;
      const sub = parts.slice(0, i).join("/");
      hit = r.anchored ? r.re.test(sub) : r.re.test(parts[i - 1]!);
    }
    if (hit) ignored = !r.negate;
  }
  return ignored;
}

// ---- writing (repository fallbacks and tests) --------------------------------------------------------------------

export interface TarItem {
  path: string;
  data?: Uint8Array;
  /** "0" file (default), "2" symlink, "5" directory. */
  type?: "0" | "2" | "5";
  linkname?: string;
}

function header(name: string, size: number, type: string, linkname = ""): Uint8Array {
  const h = new Uint8Array(512);
  const put = (s: string, at: number, len: number) => h.set(Buffer.from(s, "utf8").subarray(0, len), at);
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0");
  put(name, 0, 100);
  put(oct(0o644, 8), 100, 7);
  put(oct(0, 8), 108, 7);
  put(oct(0, 8), 116, 7);
  put(oct(size, 12), 124, 11);
  put(oct(0, 12), 136, 11);
  h[156] = type.charCodeAt(0);
  put(linkname, 157, 100);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  h.fill(32, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);

/** A ustar archive (pax headers for long names), for the tree-and-files fallback and for tests. */
export function writeTar(items: TarItem[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const it of items) {
    const data = it.data ?? new Uint8Array(0);
    const type = it.type ?? "0";
    if (Buffer.byteLength(it.path) > 99 || Buffer.byteLength(it.linkname ?? "") > 99) {
      const recs = [`path=${it.path}`, ...(it.linkname ? [`linkpath=${it.linkname}`] : [])].map((kv) => {
        let len = Buffer.byteLength(kv) + 3;
        while (Buffer.byteLength(`${len} ${kv}\n`) !== len) len = Buffer.byteLength(`${len} ${kv}\n`);
        return `${len} ${kv}\n`;
      });
      const body = Buffer.from(recs.join(""), "utf8");
      parts.push(header("PaxHeader", body.length, "x"), body, pad(body.length));
    }
    parts.push(header(it.path.slice(0, 99), type === "0" ? data.length : 0, type, it.linkname?.slice(0, 99)));
    if (type === "0") parts.push(data, pad(data.length));
  }
  parts.push(new Uint8Array(1024));
  return Buffer.concat(parts);
}

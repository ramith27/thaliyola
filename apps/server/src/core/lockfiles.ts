import path from "node:path";
import { gunzipSync } from "node:zlib";
import { ValidationError } from "./context.js";

/**
 * Lockfiles to packages. Agents and CI upload a repository's lockfiles (a tar.gz
 * made with git ls-files | tar); Thaliyola reads exact versions from them so it
 * can match OSV advisories. Ecosystem names are OSV's.
 */

export interface Package {
  ecosystem: string;
  name: string;
  version: string;
  manifest: string;
}

export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "requirements.txt",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.mod",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "packages.lock.json",
  "gradle.lockfile",
];

/** git ls-files patterns for the upload command. */
export const LOCKFILE_GLOBS = LOCKFILES.map((f) => `'*${f}'`).concat("'*requirements*.txt'");

const MAX_UNPACKED = 64 * 1024 * 1024;
const MAX_FILES = 500;

export function isLockfile(file: string) {
  const base = path.posix.basename(file);
  return LOCKFILES.includes(base) || /^requirements.*\.txt$/.test(base);
}

/** Files in a (gzipped) tar archive: ustar, GNU long names and pax paths. Only lockfiles are kept. */
export function readTar(data: Uint8Array): { path: string; text: string }[] {
  let buf: Buffer;
  try {
    buf = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data, { maxOutputLength: MAX_UNPACKED }) : Buffer.from(data);
  } catch {
    throw new ValidationError("the upload isn't a readable tar.gz (or it unpacks to more than 64 MB)");
  }
  const out: { path: string; text: string }[] = [];
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a: number, n: number) => header.subarray(a, a + n).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(str(124, 12).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new ValidationError("the upload isn't a valid tar archive");
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x") {
      const m = /\d+ path=([^\n]+)\n/.exec(body.toString("utf8"));
      if (m) longName = m[1]!;
      continue;
    }
    if (type !== "0" && type !== "\0" && type !== "7") continue;
    name = name.replace(/^\.\//, "");
    if (!isLockfile(name) || name.split("/").includes("node_modules")) continue;
    out.push({ path: name, text: body.toString("utf8") });
    if (out.length > MAX_FILES) throw new ValidationError(`more than ${MAX_FILES} lockfiles in one upload`);
  }
  return out;
}

const json = (text: string, file: string) => {
  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError(`${file} isn't valid JSON`);
  }
};

/** npm package name from a path like node_modules/a/node_modules/@s/b. */
function npmName(key: string) {
  const i = key.lastIndexOf("node_modules/");
  return i < 0 ? key : key.slice(i + "node_modules/".length);
}

function npmLock(text: string, file: string): Omit<Package, "manifest">[] {
  const lock = json(text, file);
  const out: Omit<Package, "manifest">[] = [];
  if (lock.packages) {
    for (const [key, p] of Object.entries<{ version?: string; link?: boolean; name?: string }>(lock.packages)) {
      if (!key || p.link || !p.version || !key.includes("node_modules/")) continue;
      out.push({ ecosystem: "npm", name: p.name ?? npmName(key), version: p.version });
    }
  } else if (lock.dependencies) {
    const walk = (deps: Record<string, { version?: string; dependencies?: object }>) => {
      for (const [name, d] of Object.entries(deps)) {
        if (d.version && /^\d/.test(d.version)) out.push({ ecosystem: "npm", name, version: d.version });
        if (d.dependencies) walk(d.dependencies as Record<string, { version?: string }>);
      }
    };
    walk(lock.dependencies);
  }
  return out;
}

function pnpmLock(text: string): Omit<Package, "manifest">[] {
  const out: Omit<Package, "manifest">[] = [];
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) section = line.replace(/:.*$/, "");
    if (section !== "packages" && section !== "snapshots") continue;
    // v5/v6: "  /name/1.2.3:" or "  /@s/name@1.2.3(peer):"; v9: "  name@1.2.3:" or "  '@s/name@1.2.3':"
    const m = /^ {2}'?\/?((?:@[^/@\s]+\/)?[^/@\s:'()]+)[@/](\d[^:'()\s_]*)/.exec(line);
    if (m) out.push({ ecosystem: "npm", name: m[1]!, version: m[2]! });
  }
  return out;
}

function yarnLock(text: string): Omit<Package, "manifest">[] {
  const out: Omit<Package, "manifest">[] = [];
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S.*:$/.test(line) && !line.startsWith("#") && !line.startsWith("__metadata")) {
      const spec = line.slice(0, -1).split(",")[0]!.trim().replace(/^"|"$/g, "");
      const at = spec.indexOf("@", 1);
      current = at > 0 ? spec.slice(0, at) : null;
      continue;
    }
    const v = /^ {2}version:? "?([^"\s]+)"?/.exec(line);
    if (v && current) {
      out.push({ ecosystem: "npm", name: current, version: v[1]! });
      current = null;
    }
  }
  return out;
}

function requirements(text: string): Omit<Package, "manifest">[] {
  const out: Omit<Package, "manifest">[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*===?\s*([^\s;\\]+)/.exec(line);
    if (m) out.push({ ecosystem: "PyPI", name: m[1]!.toLowerCase(), version: m[2]! });
  }
  return out;
}

/** [[package]] tables with name and version (poetry.lock, uv.lock, Cargo.lock). */
function tomlPackages(text: string, ecosystem: string): Omit<Package, "manifest">[] {
  const out: Omit<Package, "manifest">[] = [];
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const name = /^name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const version = /^version\s*=\s*"([^"]+)"/m.exec(block)?.[1];
    const local = /^source\s*=\s*\{\s*(editable|virtual|path)\s*=/m.test(block);
    if (name && version && !local) out.push({ ecosystem, name: ecosystem === "PyPI" ? name.toLowerCase() : name, version });
  }
  return out;
}

function pipfileLock(text: string, file: string): Omit<Package, "manifest">[] {
  const lock = json(text, file);
  const out: Omit<Package, "manifest">[] = [];
  for (const group of ["default", "develop"])
    for (const [name, p] of Object.entries<{ version?: string }>(lock[group] ?? {}))
      if (p.version?.startsWith("==")) out.push({ ecosystem: "PyPI", name: name.toLowerCase(), version: p.version.slice(2) });
  return out;
}

function goMod(text: string): Omit<Package, "manifest">[] {
  const out: Omit<Package, "manifest">[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (/^require\s*\($/.test(line)) inBlock = true;
    else if (inBlock && line === ")") inBlock = false;
    const m = (inBlock ? /^(\S+)\s+(v\S+)/ : /^require\s+(\S+)\s+(v\S+)/).exec(line);
    if (m) out.push({ ecosystem: "Go", name: m[1]!, version: m[2]! });
  }
  return out;
}

function gemfileLock(text: string): Omit<Package, "manifest">[] {
  const out: Omit<Package, "manifest">[] = [];
  let inSpecs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^ {2}specs:$/.test(line)) inSpecs = true;
    else if (/^\S/.test(line)) inSpecs = false;
    const m = inSpecs && /^ {4}([^\s(]+) \(([^)-]+)(?:-[^)]+)?\)$/.exec(line);
    if (m) out.push({ ecosystem: "RubyGems", name: m[1]!, version: m[2]! });
  }
  return out;
}

function composerLock(text: string, file: string): Omit<Package, "manifest">[] {
  const lock = json(text, file);
  return [...(lock.packages ?? []), ...(lock["packages-dev"] ?? [])]
    .filter((p: { name?: string; version?: string }) => p.name && p.version && !p.version.startsWith("dev-"))
    .map((p: { name: string; version: string }) => ({ ecosystem: "Packagist", name: p.name, version: p.version.replace(/^v/, "") }));
}

function nugetLock(text: string, file: string): Omit<Package, "manifest">[] {
  const lock = json(text, file);
  const out: Omit<Package, "manifest">[] = [];
  for (const deps of Object.values<Record<string, { resolved?: string; type?: string }>>(lock.dependencies ?? {}))
    for (const [name, d] of Object.entries(deps)) if (d.resolved && d.type !== "Project") out.push({ ecosystem: "NuGet", name, version: d.resolved });
  return out;
}

function gradleLock(text: string): Omit<Package, "manifest">[] {
  const out: Omit<Package, "manifest">[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^#:\s]+):([^:\s]+):([^=\s]+)=/.exec(line);
    if (m) out.push({ ecosystem: "Maven", name: `${m[1]}:${m[2]}`, version: m[3]! });
  }
  return out;
}

export function parseLockfile(file: string, text: string): Package[] {
  const base = path.posix.basename(file);
  const pkgs =
    base === "package-lock.json" || base === "npm-shrinkwrap.json"
      ? npmLock(text, file)
      : base === "pnpm-lock.yaml"
        ? pnpmLock(text)
        : base === "yarn.lock"
          ? yarnLock(text)
          : base === "poetry.lock" || base === "uv.lock"
            ? tomlPackages(text, "PyPI")
            : base === "Cargo.lock"
              ? tomlPackages(text, "crates.io")
              : base === "Pipfile.lock"
                ? pipfileLock(text, file)
                : base === "go.mod"
                  ? goMod(text)
                  : base === "Gemfile.lock"
                    ? gemfileLock(text)
                    : base === "composer.lock"
                      ? composerLock(text, file)
                      : base === "packages.lock.json"
                        ? nugetLock(text, file)
                        : base === "gradle.lockfile"
                          ? gradleLock(text)
                          : /^requirements.*\.txt$/.test(base)
                            ? requirements(text)
                            : [];
  return pkgs.map((p) => ({ ...p, manifest: file }));
}

/** All packages in an upload, one entry per ecosystem/name/version (first manifest wins). */
export function packagesFrom(files: { path: string; text: string }[]): Package[] {
  const seen = new Map<string, Package>();
  for (const f of files) for (const p of parseLockfile(f.path, f.text)) {
    const key = `${p.ecosystem}\0${p.name}\0${p.version}`;
    if (!seen.has(key) && p.name.length <= 300 && p.version.length <= 100) seen.set(key, p);
  }
  return [...seen.values()];
}

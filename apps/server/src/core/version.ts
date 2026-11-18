import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Thaliyola's product version: one semver for the whole product, kept in step in the root package.json and in
 * apps/server and apps/web (`pnpm version:bump`). The server reads its own package.json, which is the one a Docker
 * image or a native install ships.
 *
 * The commit is, in order: BUILD_SHA or CI_COMMIT_SHA in the server's environment; the commit written to
 * dist/build-info.json when the server was built and runs from dist/ (scripts/build-info.mjs reads the same variables,
 * then `git rev-parse HEAD`); for a server run from source, `git rev-parse HEAD` once at start; otherwise null.
 */

export interface BuildInfo {
  /** Semver, e.g. "1.0.0". */
  version: string;
  /** The full commit hash, or null when nobody passed one and git wasn't there at build time. */
  commit: string | null;
  /** When dist/ was built (ISO 8601), or null for a server run from source. */
  built_at: string | null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** apps/server (from src/core or dist/core), or /app in the Docker image. */
const SERVER_ROOT = path.resolve(HERE, "../..");

const SEMVER = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const COMMIT = /^[0-9a-f]{7,40}$/i;

/** "1.2.3" → [1, 2, 3]; anything else → null. Versions are plain major.minor.patch (no pre-release tags). */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = SEMVER.exec(String(v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function isVersion(v: string | null | undefined): boolean {
  return parseVersion(v) !== null;
}

/** Negative when a < b, 0 when equal, positive when a > b. Unparseable versions sort first. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** A commit hash from the environment or a file, lower case; anything that isn't one is ignored. */
export function cleanCommit(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  return COMMIT.test(s) ? s.toLowerCase() : null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function gitHead(cwd: string): string | null {
  try {
    return cleanCommit(execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }));
  } catch {
    return null;
  }
}

/** Whether this server runs its build (dist/, the Docker image, a native install) rather than its source (tsx). */
const RUNNING_FROM: "dist" | "source" = HERE.split(path.sep).includes("dist") ? "dist" : "source";

/**
 * Reads the build once per process (tests pass `env`, `root` and `from` to check each source). A server run from
 * source never reads dist/build-info.json: a build left behind in a checkout would report an old commit.
 */
export function readBuildInfo(env: NodeJS.ProcessEnv = process.env, root = SERVER_ROOT, from: "dist" | "source" = RUNNING_FROM): BuildInfo {
  const pkg = readJson(path.join(root, "package.json"));
  const version = typeof pkg?.version === "string" && isVersion(pkg.version) ? pkg.version : "0.0.0";
  const built = from === "dist" ? readJson(path.join(root, "dist", "build-info.json")) : null;
  const fromEnv = cleanCommit(env.BUILD_SHA) ?? cleanCommit(env.CI_COMMIT_SHA);
  const fromBuild = cleanCommit(built?.commit);
  // Run from source (tsx): there is no build, so the checkout's own commit stands in for it.
  const fromSource = !fromEnv && from === "source" && existsSync(path.join(root, "src")) ? gitHead(root) : null;
  const builtAt = typeof built?.built_at === "string" && !Number.isNaN(Date.parse(built.built_at)) ? new Date(built.built_at).toISOString() : null;
  return { version, commit: fromEnv ?? fromBuild ?? fromSource, built_at: builtAt };
}

let cached: BuildInfo | null = null;

/** This server's version, commit and build time. */
export function buildInfo(): BuildInfo {
  cached ??= readBuildInfo();
  return { ...cached };
}

/** "1.0.0 (abc1234)" or "1.0.0". */
export function versionLabel(info: BuildInfo = buildInfo()): string {
  return info.commit ? `${info.version} (${info.commit.slice(0, 7)})` : info.version;
}

import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import { addComponentTechnologies } from "./advisories.js";
import type { Package } from "./lockfiles.js";

/**
 * Learn each repository's stack without anyone running a scan: its languages from GitHub or GitLab
 * (public repositories need no token; GITHUB_TOKEN / GITLAB_TOKEN for private ones) and, on GitHub,
 * its dependency graph (exact versions only), which then goes through the same OSV matching as an upload.
 */

const LANG_TECH: Record<string, string> = {
  PHP: "php",
  Hack: "php",
  Blade: "laravel",
  Python: "python",
  Go: "go",
  Ruby: "ruby",
  Rust: "rust",
  Java: "java",
  "C#": "dotnet",
  "F#": "dotnet",
  Dockerfile: "docker",
  Elixir: "elixir",
  Swift: "swift",
  Kotlin: "kotlin",
  Dart: "dart",
  HCL: "terraform",
};

const PURL_ECOSYSTEM: Record<string, string> = { npm: "npm", composer: "Packagist", pypi: "PyPI", golang: "Go", maven: "Maven", gem: "RubyGems", cargo: "crates.io", nuget: "NuGet" };

export function parseRepoUrl(url: string): { host: string; path: string } | null {
  const u = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(u);
  if (ssh) return { host: ssh[1]!.toLowerCase(), path: ssh[2]! };
  try {
    const p = new URL(u);
    if (!/^https?:$/.test(p.protocol)) return null;
    return { host: p.hostname.toLowerCase(), path: p.pathname.replace(/^\/+/, "") };
  } catch {
    return null;
  }
}

/** Languages that make up at least 5% of the code (any Dockerfile or Terraform), as technologies. */
export function languagesToTech(langs: Record<string, number>): string[] {
  const total = Object.values(langs).reduce((s, n) => s + n, 0) || 1;
  // Dockerfiles and Terraform are always small but say a lot about where the code runs.
  const always = new Set(["Dockerfile", "HCL"]);
  return [...new Set(Object.entries(langs).filter(([l, n]) => always.has(l) || n / total >= 0.05).map(([l]) => LANG_TECH[l]).filter((t): t is string => !!t))];
}

/** Packages with exact versions from a GitHub SPDX SBOM (manifest ranges like ^1.2 are skipped). */
export function sbomPackages(sbom: { sbom?: { packages?: { externalRefs?: { referenceType?: string; referenceLocator?: string }[] }[] } }): Package[] {
  const out = new Map<string, Package>();
  for (const p of sbom.sbom?.packages ?? []) {
    const purl = p.externalRefs?.find((r) => r.referenceType === "purl")?.referenceLocator;
    const m = purl && /^pkg:([a-z]+)\/(.+)@([^?#]+)/.exec(purl);
    if (!m) continue;
    const ecosystem = PURL_ECOSYSTEM[m[1]!];
    const name = decodeURIComponent(m[2]!).replace(/^([^/]+)\/([^/]+)$/, m[1] === "maven" ? "$1:$2" : "$1/$2");
    const version = decodeURIComponent(m[3]!);
    if (!ecosystem || !/^v?\d+(\.\d+)*([-.+][\w.]+)?$/.test(version)) continue;
    out.set(`${ecosystem}\0${name}\0${version}`, { ecosystem, name, version, manifest: "GitHub dependency graph" });
  }
  return [...out.values()];
}

interface Detected {
  technologies: string[];
  packages: Package[];
  host: string;
  error?: string;
}

async function detectOne(settings: Settings, repoUrl: string): Promise<Detected | null> {
  const repo = parseRepoUrl(repoUrl);
  if (!repo) return null;
  const s = settings.security;
  const f = s?.fetch ?? fetch;
  const get = async (url: string, headers: Record<string, string>) => {
    const res = await f(url, { headers: { "User-Agent": "Thaliyola/1.0 (stack detection)", Accept: "application/json", ...headers }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 404 || res.status === 403 || res.status === 401) return null;
    if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}`);
    return res.json();
  };
  if (repo.host === "github.com") {
    const api = (s?.githubUrl ?? "https://api.github.com").replace(/\/+$/, "");
    const headers: Record<string, string> = { "X-GitHub-Api-Version": "2022-11-28", ...(s?.githubToken ? { Authorization: `Bearer ${s.githubToken}` } : {}) };
    const langs = (await get(`${api}/repos/${repo.path}/languages`, headers)) as Record<string, number> | null;
    if (!langs) return { technologies: [], packages: [], host: repo.host, error: s?.githubToken ? "not found or no access" : "private or not found (set GITHUB_TOKEN)" };
    const sbom = await get(`${api}/repos/${repo.path}/dependency-graph/sbom`, headers).catch(() => null);
    return { technologies: languagesToTech(langs), packages: sbom ? sbomPackages(sbom as never) : [], host: repo.host };
  }
  // Anything else is tried as GitLab (gitlab.com or self-hosted).
  const headers: Record<string, string> = s?.gitlabToken ? { "PRIVATE-TOKEN": s.gitlabToken } : {};
  let langs: Record<string, number> | null;
  try {
    langs = (await get(`https://${repo.host}/api/v4/projects/${encodeURIComponent(repo.path)}/languages`, headers)) as Record<string, number> | null;
  } catch (err) {
    // A token can't help when the host doesn't answer (private network, firewall, VPN-only).
    const unreachable = (err as Error).name === "TimeoutError" || (err as Error).name === "TypeError" || /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/.test((err as Error).message);
    return { technologies: [], packages: [], host: repo.host, error: unreachable ? `couldn't reach ${repo.host} from the server` : (err as Error).message.slice(0, 200) };
  }
  if (!langs) return { technologies: [], packages: [], host: repo.host, error: s?.gitlabToken ? "not found or no access" : "private or not found (set GITLAB_TOKEN)" };
  return { technologies: languagesToTech(langs), packages: [], host: repo.host };
}

/**
 * Detect every repository's stack (daily, and on demand for one project). Dependency-graph packages replace a
 * repository's dependencies only when nobody uploaded lockfiles for it in the last week (uploads are exact).
 */
export async function detectRepos(
  db: Db,
  settings: Settings,
  ingest: (scopeId: string, component: string, packages: Package[]) => Promise<unknown>,
  opts: { scopeId?: string; limit?: number } = {},
) {
  const { rows } = await db.query<{ scope_id: string; slug: string; repo_url: string; uploaded_recently: boolean }>(
    `SELECT c.scope_id, c.slug, c.repo_url,
            EXISTS (SELECT 1 FROM security_reviews r WHERE r.scope_id = c.scope_id AND r.component = c.slug AND r.kind = 'dependencies'
                     AND r.created_at > now() - interval '7 days' AND NOT ('GitHub dependency graph' = ANY(r.tools))) AS uploaded_recently
       FROM components c JOIN scopes s ON s.id = c.scope_id
      WHERE c.repo_url IS NOT NULL AND s.status = 'active' AND ($1::uuid IS NULL OR c.scope_id = $1)
      ORDER BY c.scope_id, c.slug LIMIT $2`,
    [opts.scopeId ?? null, opts.limit ?? 50],
  );
  const results: { repository: string; host: string; technologies: string[]; packages: number; error?: string }[] = [];
  for (const r of rows) {
    try {
      const d = await detectOne(settings, r.repo_url);
      if (!d) continue;
      if (d.technologies.length) await addComponentTechnologies(db, r.scope_id, r.slug, d.technologies);
      if (d.packages.length && !r.uploaded_recently) await ingest(r.scope_id, r.slug, d.packages);
      await db.query("UPDATE components SET detected_at = now(), detect_error = $3 WHERE scope_id = $1 AND slug = $2", [r.scope_id, r.slug, d.error ?? null]);
      results.push({ repository: r.slug, host: d.host, technologies: d.technologies, packages: d.packages.length, ...(d.error ? { error: d.error } : {}) });
    } catch (err) {
      await db.query("UPDATE components SET detected_at = now(), detect_error = $3 WHERE scope_id = $1 AND slug = $2", [r.scope_id, r.slug, (err as Error).message.slice(0, 200)]);
      results.push({ repository: r.slug, host: parseRepoUrl(r.repo_url)?.host ?? "", technologies: [], packages: 0, error: (err as Error).message });
    }
  }
  return results;
}

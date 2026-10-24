import type { Queryable } from "../db/pool.js";

/**
 * OSV.dev (open source vulnerabilities, no key needed) and CISA's Known
 * Exploited Vulnerabilities catalog. Advisories are cached by id and refetched
 * only when OSV reports a newer modified time.
 */

export type Severity = "critical" | "high" | "medium" | "low" | "unknown";
export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "unknown"];

export interface SecurityEnv {
  osvUrl: string;
  kevUrl: string;
  fetch?: typeof fetch;
}

const TIMEOUT_MS = 30_000;

// ---- CVSS ---------------------------------------------------------------------------------------

const roundUp = (x: number) => {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
};

/** CVSS v3.0/3.1 base score from a vector string, or null if it isn't one. */
export function cvss3Score(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) return null;
  const m = Object.fromEntries(vector.split("/").slice(1).map((p) => p.split(":") as [string, string]));
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV as string];
  const AC = { L: 0.77, H: 0.44 }[m.AC as string];
  const UI = { N: 0.85, R: 0.62 }[m.UI as string];
  const changed = m.S === "C";
  const PR = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR as string];
  const cia = (k: string) => ({ H: 0.56, L: 0.22, N: 0 })[m[k] as string];
  const [C, I, A] = [cia("C"), cia("I"), cia("A")];
  if ([AV, AC, UI, PR, C, I, A].some((v) => v === undefined) || !["U", "C"].includes(m.S as string)) return null;
  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploitability = 8.22 * AV! * AC! * PR! * UI!;
  if (impact <= 0) return 0;
  return roundUp(Math.min((changed ? 1.08 : 1) * (impact + exploitability), 10));
}

export function severityFromScore(score: number): Severity {
  return score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : score > 0 ? "low" : "unknown";
}

export function severityFromLabel(label: unknown): Severity {
  const s = String(label ?? "").toLowerCase();
  return s === "critical" ? "critical" : s === "high" ? "high" : s === "moderate" || s === "medium" ? "medium" : s === "low" ? "low" : "unknown";
}

// ---- Advisories -------------------------------------------------------------------------------------

export interface OsvAdvisory {
  id: string;
  modified?: string;
  withdrawn?: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  affected?: {
    package?: { ecosystem: string; name: string };
    ranges?: { type: string; events: Record<string, string>[] }[];
    versions?: string[];
    database_specific?: { severity?: string };
    ecosystem_specific?: { severity?: string };
  }[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
  references?: { type: string; url: string }[];
}

/** Severity, score and vector for an advisory: CVSS v3 first, then the database's own label. */
export function advisorySeverity(a: OsvAdvisory): { severity: Severity; score: number | null; vector: string | null } {
  for (const s of a.severity ?? []) {
    const score = cvss3Score(s.score);
    if (score !== null) return { severity: severityFromScore(score), score, vector: s.score };
  }
  const label = a.database_specific?.severity ?? a.affected?.find((x) => x.database_specific?.severity || x.ecosystem_specific?.severity)?.database_specific?.severity;
  const v4 = a.severity?.find((s) => s.type === "CVSS_V4")?.score ?? null;
  return { severity: severityFromLabel(label), score: null, vector: v4 };
}

const norm = (ecosystem: string, name: string) => (ecosystem === "PyPI" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name);

/** Compares dotted versions numerically (1.10 > 1.9; "v" prefixes and pre-release tags handled loosely). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, "").split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    // A pre-release tag sorts before the release (1.0.0-rc1 < 1.0.0).
    if (typeof x === "number") return 1;
    if (typeof y === "number") return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Fixed versions that are upgrades from the installed one, lowest first (all of them if none compare as newer). */
export function upgradesFrom(installed: string, fixed: string[]): string[] {
  const newer = fixed.filter((f) => compareVersions(f, installed) > 0).sort(compareVersions);
  return newer.length ? newer : fixed;
}

/** Versions that fix this advisory for one package. */
export function fixedVersions(a: OsvAdvisory, ecosystem: string, name: string): string[] {
  const out = new Set<string>();
  for (const aff of a.affected ?? []) {
    if (!aff.package || aff.package.ecosystem.split(":")[0] !== ecosystem || norm(ecosystem, aff.package.name) !== norm(ecosystem, name)) continue;
    for (const r of aff.ranges ?? []) for (const e of r.events) if (e.fixed && r.type !== "GIT") out.add(e.fixed);
  }
  return [...out];
}

async function osvFetch(env: SecurityEnv, path: string, init?: RequestInit) {
  const res = await (env.fetch ?? fetch)(`${env.osvUrl.replace(/\/+$/, "")}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "User-Agent": "Thaliyola/1.0 (vulnerability matching)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OSV answered ${res.status}`);
  return res.json();
}

/** Advisory ids (with modified times) for each package, in input order. */
export async function osvQueryBatch(env: SecurityEnv, packages: { ecosystem: string; name: string; version: string }[]) {
  const results: { id: string; modified?: string }[][] = [];
  for (let i = 0; i < packages.length; i += 1000) {
    const chunk = packages.slice(i, i + 1000);
    const queries = chunk.map((p) => ({ package: { ecosystem: p.ecosystem, name: p.name }, version: p.version }));
    const data = (await osvFetch(env, "/v1/querybatch", { method: "POST", body: JSON.stringify({ queries }) })) as {
      results: { vulns?: { id: string; modified?: string }[]; next_page_token?: string }[];
    };
    for (let j = 0; j < chunk.length; j++) {
      const r = data.results[j] ?? {};
      const vulns = [...(r.vulns ?? [])];
      // Very common packages can have more advisories than one page holds.
      let token = r.next_page_token;
      for (let page = 0; token && page < 5; page++) {
        const more = (await osvFetch(env, "/v1/query", { method: "POST", body: JSON.stringify({ ...queries[j], page_token: token }) })) as { vulns?: { id: string; modified?: string }[]; next_page_token?: string };
        vulns.push(...(more.vulns ?? []));
        token = more.next_page_token;
      }
      results.push(vulns);
    }
  }
  return results;
}

/** Full advisories by id, from the cache when it's current. */
export async function osvAdvisories(db: Queryable, env: SecurityEnv, wanted: { id: string; modified?: string }[]): Promise<Map<string, OsvAdvisory>> {
  const ids = [...new Set(wanted.map((w) => w.id))];
  const out = new Map<string, OsvAdvisory>();
  if (!ids.length) return out;
  const cached = await db.query<{ id: string; modified: string | null; data: OsvAdvisory }>("SELECT id, modified, data FROM osv_advisories WHERE id = ANY($1)", [ids]);
  const byId = new Map(cached.rows.map((r) => [r.id, r]));
  const modified = new Map(wanted.map((w) => [w.id, w.modified]));
  const stale = ids.filter((id) => {
    const c = byId.get(id);
    return !c || (modified.get(id) && c.modified !== modified.get(id));
  });
  for (const r of cached.rows) if (!stale.includes(r.id)) out.set(r.id, r.data);
  // A few at a time: OSV is generous but not unlimited.
  for (let i = 0; i < stale.length; i += 8) {
    const got = await Promise.all(stale.slice(i, i + 8).map((id) => osvFetch(env, `/v1/vulns/${encodeURIComponent(id)}`) as Promise<OsvAdvisory>));
    for (const a of got) {
      out.set(a.id, a);
      await db.query(
        "INSERT INTO osv_advisories (id, modified, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET modified = EXCLUDED.modified, data = EXCLUDED.data, fetched_at = now()",
        [a.id, a.modified ?? null, a],
      );
    }
  }
  return out;
}

/** CVE ids an advisory is known by. */
export function cveIds(id: string, aliases: string[] = []) {
  return [id, ...aliases].filter((x) => /^CVE-\d{4}-\d+$/.test(x));
}

// ---- CISA KEV ---------------------------------------------------------------------------------------------

export async function fetchKev(env: SecurityEnv) {
  const res = await (env.fetch ?? fetch)(env.kevUrl, { headers: { "User-Agent": "Thaliyola/1.0 (vulnerability matching)" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`the KEV catalog answered ${res.status}`);
  const data = (await res.json()) as {
    vulnerabilities: { cveID: string; vendorProject?: string; product?: string; vulnerabilityName?: string; dateAdded?: string; dueDate?: string; knownRansomwareCampaignUse?: string }[];
  };
  if (!Array.isArray(data.vulnerabilities)) throw new Error("the KEV catalog isn't in the expected format");
  return data.vulnerabilities.map((v) => ({
    cve: v.cveID,
    name: v.vulnerabilityName ?? "",
    vendor: v.vendorProject ?? "",
    product: v.product ?? "",
    date_added: v.dateAdded ?? null,
    due_date: v.dueDate ?? null,
    ransomware: v.knownRansomwareCampaignUse === "Known",
  }));
}

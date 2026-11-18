import { randomUUID } from "node:crypto";
import type { Settings } from "../config.js";
import type { Queryable } from "../db/pool.js";
import { ValidationError, type RequestContext } from "./context.js";
import { canSeeVulns, WHO_SEES_DETAILS } from "./security.js";
import { ForbiddenError } from "./context.js";
import { getComponent, getReadableScope } from "./scopes.js";

/**
 * Software bill of materials for a project (or one repository): every dependency Thaliyola knows from the
 * lockfiles that were scanned, as CycloneDX 1.5 JSON, with the open vulnerabilities and, on request, each
 * version's licence from deps.dev (cached). The licence check flags copyleft and unknown licences.
 */

/** OSV ecosystem → package URL type. */
const PURL: Record<string, string> = { npm: "npm", PyPI: "pypi", Go: "golang", Maven: "maven", NuGet: "nuget", RubyGems: "gem", Packagist: "composer", "crates.io": "cargo", Pub: "pub", Hex: "hex" };
/** OSV ecosystem → deps.dev system (the ones deps.dev has). */
const DEPS_DEV: Record<string, string> = { npm: "npm", PyPI: "pypi", Go: "go", Maven: "maven", NuGet: "nuget", RubyGems: "rubygems", "crates.io": "cargo" };

export function purl(ecosystem: string, name: string, version: string): string {
  const type = PURL[ecosystem] ?? ecosystem.toLowerCase();
  if (type === "maven" && name.includes(":")) {
    const [group, artifact] = name.split(":");
    return `pkg:maven/${encodeURIComponent(group!)}/${encodeURIComponent(artifact!)}@${encodeURIComponent(version)}`;
  }
  // npm scopes and Go module paths keep their slashes; each segment is encoded.
  const path = name.split("/").map((p) => encodeURIComponent(p.replace(/^@/, "%40")).replace(/%2540/g, "%40")).join("/");
  return `pkg:${type}/${path}@${encodeURIComponent(version)}`;
}

/** Copyleft licences: their terms reach code that links or ships with them; worth a look before a release. */
const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|EUPL|CDDL|SSPL|OSL|CPAL|CC-BY-SA)/i;
const STRONG = /^(A?GPL|SSPL|EUPL|OSL|CPAL)/i;

export function licenceRisk(licenses: string[] | null): "none" | "weak_copyleft" | "strong_copyleft" | "unknown" {
  if (!licenses?.length) return "unknown";
  // An SPDX expression with OR lets the user pick: the least restrictive option counts.
  const options = licenses.flatMap((l) => l.split(/\s+OR\s+/i)).map((l) => l.replace(/[()]/g, "").trim());
  if (options.some((o) => !COPYLEFT.test(o))) return "none";
  return options.every((o) => STRONG.test(o)) ? "strong_copyleft" : "weak_copyleft";
}

/** Looks up and caches licences for versions not cached yet (at most `limit`, a few at a time). */
async function fillLicences(db: Queryable, settings: Settings, pkgs: { ecosystem: string; name: string; version: string }[], limit = 400) {
  const fetchFn = settings.security?.fetch ?? fetch;
  const base = process.env.DEPS_DEV_URL ?? "https://api.deps.dev";
  const missing = (
    await db.query<{ ecosystem: string; name: string; version: string }>(
      `SELECT p.ecosystem, p.name, p.version FROM unnest($1::text[], $2::text[], $3::text[]) AS p(ecosystem, name, version)
        WHERE NOT EXISTS (SELECT 1 FROM package_licenses l WHERE l.ecosystem = p.ecosystem AND l.name = p.name AND l.version = p.version)`,
      [pkgs.map((p) => p.ecosystem), pkgs.map((p) => p.name), pkgs.map((p) => p.version)],
    )
  ).rows
    .filter((p) => DEPS_DEV[p.ecosystem])
    .slice(0, limit);
  let i = 0;
  const worker = async () => {
    while (i < missing.length) {
      const p = missing[i++]!;
      try {
        const url = `${base}/v3/systems/${DEPS_DEV[p.ecosystem]}/packages/${encodeURIComponent(p.name)}/versions/${encodeURIComponent(p.version)}`;
        const res = await fetchFn(url, { signal: AbortSignal.timeout(6000), headers: { Accept: "application/json", "User-Agent": "thaliyola" } });
        if (res.status === 404) {
          await db.query("INSERT INTO package_licenses (ecosystem, name, version, licenses) VALUES ($1, $2, $3, '{}') ON CONFLICT DO NOTHING", [p.ecosystem, p.name, p.version]);
          continue;
        }
        if (!res.ok) continue;
        const body = (await res.json()) as { licenses?: string[] };
        await db.query("INSERT INTO package_licenses (ecosystem, name, version, licenses) VALUES ($1, $2, $3, $4) ON CONFLICT (ecosystem, name, version) DO UPDATE SET licenses = EXCLUDED.licenses, fetched_at = now()", [
          p.ecosystem,
          p.name,
          p.version,
          (body.licenses ?? []).filter((l) => typeof l === "string").slice(0, 10),
        ]);
      } catch {
        // deps.dev unreachable or slow: the licence stays unknown this time.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, missing.length) }, worker));
  return missing.length;
}

interface Dep {
  component: string;
  ecosystem: string;
  name: string;
  version: string;
  manifest: string;
  licenses: string[] | null;
}

async function dependenciesOf(ctx: RequestContext, slug: string, component: string | undefined, licences: boolean) {
  const scope = await getReadableScope(ctx, slug);
  if (!(await canSeeVulns(ctx, scope.id))) throw new ForbiddenError(`the dependency list and SBOM are for ${WHO_SEES_DETAILS}`);
  if (component) await getComponent(ctx.db, scope.id, component);
  const q = () =>
    ctx.db.query<Dep>(
      `SELECT d.component, d.ecosystem, d.name, d.version, d.manifest, l.licenses
         FROM dependencies d LEFT JOIN package_licenses l ON l.ecosystem = d.ecosystem AND l.name = d.name AND l.version = d.version
        WHERE d.scope_id = $1 AND ($2::text IS NULL OR d.component = $2) ORDER BY d.component, d.ecosystem, lower(d.name), d.version LIMIT 20000`,
      [scope.id, component ?? null],
    );
  let deps = (await q()).rows;
  let looked = 0;
  if (licences && ctx.settings.security?.enabled !== false) {
    looked = await fillLicences(ctx.db, ctx.settings, deps.filter((d) => d.licenses === null));
    if (looked) deps = (await q()).rows;
  }
  return { scope, deps, looked };
}

/** CycloneDX 1.5 JSON for a project or one repository, with open vulnerabilities and (optionally) licences. */
export async function exportSbom(ctx: RequestContext, slug: string, opts: { component?: string; licenses?: boolean } = {}) {
  const { scope, deps } = await dependenciesOf(ctx, slug, opts.component, opts.licenses ?? false);
  if (!deps.length) throw new ValidationError(`no dependencies recorded for ${scope.slug}${opts.component ? `/${opts.component}` : ""} yet: run a dependency scan (security-check, or the CI step)`);
  const vulns = (
    await ctx.db.query<{ id: string; advisory_id: string | null; aliases: string[]; title: string; severity: string; cvss_score: string | null; cvss_vector: string | null; ecosystem: string; package: string; version: string; component: string; fixed_versions: string[]; kev: boolean }>(
      `SELECT id, advisory_id, aliases, title, severity, cvss_score, cvss_vector, ecosystem, package, version, component, fixed_versions, kev FROM vulnerabilities
        WHERE scope_id = $1 AND source = 'osv' AND status IN ('open', 'acknowledged') AND ($2::text IS NULL OR component = $2)`,
      [scope.id, opts.component ?? null],
    )
  ).rows;
  const ref = (d: { component: string; ecosystem: string; name: string; version: string }) => `${d.component || "-"}:${purl(d.ecosystem, d.name, d.version)}`;
  const seen = new Set<string>();
  const components = deps
    .filter((d) => (seen.has(ref(d)) ? false : (seen.add(ref(d)), true)))
    .map((d) => ({
      type: "library",
      "bom-ref": ref(d),
      name: d.name,
      version: d.version,
      purl: purl(d.ecosystem, d.name, d.version),
      ...(d.licenses?.length ? { licenses: d.licenses.map((l) => (/\s(AND|OR|WITH)\s/.test(l) ? { expression: l } : { license: { id: l } })) } : {}),
      properties: [
        ...(d.component ? [{ name: "thaliyola:repository", value: d.component }] : []),
        ...(d.manifest ? [{ name: "thaliyola:lockfile", value: d.manifest }] : []),
      ],
    }));
  const severity = (s: string) => (["critical", "high", "medium", "low"].includes(s) ? s : "unknown");
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: { components: [{ type: "application", name: "Thaliyola" }] },
      component: { type: "application", "bom-ref": `project:${scope.slug}${opts.component ? `/${opts.component}` : ""}`, name: opts.component ? `${scope.slug}/${opts.component}` : scope.slug },
    },
    components,
    vulnerabilities: vulns.map((v) => ({
      "bom-ref": `vuln:${v.id}`,
      id: v.advisory_id ?? v.aliases[0] ?? v.id,
      source: { name: "OSV", url: v.advisory_id ? `https://osv.dev/vulnerability/${v.advisory_id}` : "https://osv.dev" },
      references: v.aliases.map((a) => ({ id: a, source: { name: a.startsWith("CVE-") ? "NVD" : "OSV" } })),
      ratings: [{ severity: severity(v.severity), ...(v.cvss_score ? { score: Number(v.cvss_score), method: "CVSSv31", vector: v.cvss_vector ?? undefined } : {}) }],
      description: v.title,
      ...(v.fixed_versions.length ? { recommendation: `Upgrade to ${v.fixed_versions[0]}` } : {}),
      ...(v.kev ? { properties: [{ name: "cisa:kev", value: "true" }] } : {}),
      affects: [{ ref: ref({ component: v.component, ecosystem: v.ecosystem, name: v.package, version: v.version }) }],
    })),
  };
}

/** The licence check: dependencies whose licence is copyleft or unknown, and the counts by licence. */
export async function licenceReport(ctx: RequestContext, slug: string, opts: { component?: string } = {}) {
  const { scope, deps, looked } = await dependenciesOf(ctx, slug, opts.component, true);
  const counts = new Map<string, number>();
  const flagged: { repository: string; package: string; version: string; ecosystem: string; licenses: string[]; risk: string }[] = [];
  for (const d of deps) {
    const risk = licenceRisk(d.licenses);
    for (const l of d.licenses?.length ? d.licenses : ["unknown"]) counts.set(l, (counts.get(l) ?? 0) + 1);
    if (risk !== "none") flagged.push({ repository: d.component, package: d.name, version: d.version, ecosystem: d.ecosystem, licenses: d.licenses ?? [], risk });
  }
  const order = { strong_copyleft: 0, weak_copyleft: 1, unknown: 2 } as Record<string, number>;
  flagged.sort((a, b) => order[a.risk]! - order[b.risk]! || a.package.localeCompare(b.package));
  return {
    project: scope.slug,
    dependencies: deps.length,
    looked_up_now: looked,
    by_licence: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([license, n]) => ({ license, packages: n })),
    flagged: flagged.slice(0, 500),
    counts: {
      strong_copyleft: flagged.filter((f) => f.risk === "strong_copyleft").length,
      weak_copyleft: flagged.filter((f) => f.risk === "weak_copyleft").length,
      unknown: flagged.filter((f) => f.risk === "unknown").length,
    },
    note: "Licences come from deps.dev for npm, PyPI, Go, Maven, NuGet, RubyGems and crates.io packages; others show as unknown. Strong copyleft (GPL, AGPL, SSPL…) can oblige you to publish your own code when you distribute it; weak copyleft (LGPL, MPL, EPL…) covers changes to the package itself. Not legal advice.",
  };
}

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAddComponent, adminCreateProject, adminSetMember } from "../src/core/admin.js";
import {
  fromNvd,
  latestAdvisories,
  normaliseTechnologies,
  projectAdvisories,
  publishAdvisory,
  refreshAdvisories,
  setAdvisoryResponse,
  setProjectTechnologies,
  stackOf,
} from "../src/core/advisories.js";
import { getProjectContext } from "../src/core/projects.js";
import { recordSecurityReview } from "../src/core/security.js";
import type { Settings } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;

// Modelled on NVD's records for the two PHP CVEs (same issuer and hour; one is critical only by CVSS 4.0).
const nvd = (id: string, desc: string, v31: [number, string], v40?: [number, string], cpe = "cpe:2.3:a:php:php:*:*:*:*:*:*:*:*") => ({
  cve: {
    id,
    sourceIdentifier: "security@php.net",
    published: "2026-10-21T14:17:09.357",
    lastModified: "2026-10-23T16:26:54.713",
    vulnStatus: "Analyzed",
    descriptions: [{ lang: "en", value: desc }],
    metrics: {
      cvssMetricV31: [{ source: "nvd@nist.gov", type: "Primary", cvssData: { baseScore: v31[0], baseSeverity: v31[1], vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" } }],
      ...(v40 ? { cvssMetricV40: [{ source: "security@php.net", type: "Secondary", cvssData: { baseScore: v40[0], baseSeverity: v40[1] } }] } : {}),
      ssvcV203: [{ source: "x", ssvcData: {} }],
    },
    configurations: [{ nodes: [{ cpeMatch: [{ vulnerable: true, criteria: cpe }, { vulnerable: true, criteria: "cpe:2.3:o:siemens:ruggedcom_ape1808_firmware:-:*:*:*:*:*:*:*" }] }] }],
    references: [{ url: "https://github.com/php/php-src/security/advisories/GHSA-w8hw-w9fx-j79w" }],
  },
});
const PHP_618 = nvd("CVE-2026-109618", "PHP uses longjmp() for out-of-memory errors. Request memory may be left uninitialized, allowing remote code execution.", [9.8, "CRITICAL"], [9.2, "CRITICAL"]);
const PHP_619 = nvd("CVE-2026-109619", "PHP has various global state that temporarily points into request memory. Subsequent requests may read freed memory.", [8.1, "HIGH"], [9.2, "CRITICAL"]);
const WORDPRESS = nvd("CVE-2026-55555", "A WordPress plugin allows SQL injection.", [9.8, "CRITICAL"], undefined, "cpe:2.3:a:someone:some_plugin:*:*:*:*:*:wordpress:*:*");
const HIGH_ONLY = nvd("CVE-2026-60000", "A high-severity bug in Go.", [7.5, "HIGH"], undefined, "cpe:2.3:a:golang:go:*:*:*:*:*:*:*:*");
const GHSA = [
  {
    ghsa_id: "GHSA-next-0001",
    cve_id: "CVE-2026-77777",
    summary: "Next.js middleware authorization bypass",
    description: "Crafted headers skip middleware.",
    severity: "critical",
    cvss_severities: { cvss_v3: { score: 9.1, vector_string: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N" } },
    published_at: new Date().toISOString(),
    html_url: "https://github.com/advisories/GHSA-next-0001",
    vulnerabilities: [{ package: { ecosystem: "npm", name: "next" }, first_patched_version: "15.2.3" }],
  },
  // GitHub also knows one of the PHP CVEs: it merges with NVD's entry.
  { ghsa_id: "GHSA-php-0618", cve_id: "CVE-2026-109618", summary: "PHP OOM longjmp leaves request memory uninitialized", severity: "critical", published_at: "2026-10-21T15:00:00Z", html_url: "https://github.com/advisories/GHSA-php-0618", vulnerabilities: [] },
];

let nvdCalls: string[] = [];
const fakeFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://nvd.test")) {
    nvdCalls.push(url);
    const q = new URL(url).searchParams;
    const items = q.get("cvssV3Severity") === "CRITICAL" ? [PHP_618, WORDPRESS] : [PHP_619, HIGH_ONLY];
    return Response.json({ totalResults: items.length, resultsPerPage: 2000, vulnerabilities: items });
  }
  if (url.startsWith("https://gh.test/advisories")) return Response.json(GHSA);
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const SETTINGS: Settings = {
  ...TEST_SETTINGS,
  security: { enabled: true, osvUrl: "https://osv.test", kevUrl: "https://kev.test", feed: true, nvdUrl: "https://nvd.test/cves", githubUrl: "https://gh.test", fetch: fakeFetch },
};
const ctx = async (email: string) => ({ ...(await ctxFor(db, { email })), settings: SETTINGS });
const log: string[] = [];

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await ctx("admin@example.com");
  for (const [slug, name] of [["shop", "Shop"], ["blog", "Blog"], ["web", "Web app"]] as const) {
    await adminCreateProject(a, { slug, name });
    await adminSetMember(a, slug, "owner@example.com", "owner");
  }
  await adminSetMember(a, "shop", "dev@example.com", "writer");
  await adminSetMember(a, "shop", "viewer@example.com", "reader");
  await adminAddComponent(a, "shop", { slug: "api", kind: "backend", repo_url: "git@github.com:acme/shop-api.git" });
  const shop = (await db.query("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0].id;
  const web = (await db.query("SELECT id FROM scopes WHERE slug = 'web'")).rows[0].id;
  // Shop's lockfiles have Composer packages (so it runs PHP); the web app depends on next.
  await db.query("INSERT INTO dependencies (scope_id, component, ecosystem, name, version) VALUES ($1, 'api', 'Packagist', 'laravel/framework', '11.0.0'), ($2, '', 'npm', 'next', '15.1.0')", [shop, web]);
});
afterAll(() => db.end());

describe("technologies", () => {
  it("normalises names, versions and synonyms", () => {
    expect(normaliseTechnologies(["PHP 8.3", "Node.js", "postgres", "k8s", "nginx/1.25", "Docker", "php"])).toEqual(["docker", "kubernetes", "nginx/1.25", "nodejs", "php", "postgresql"]);
  });

  it("reads NVD records: worst of CVSS 3.1 and 4.0, products from CPEs", () => {
    const a = fromNvd(PHP_619.cve as never);
    expect(a).toMatchObject({ key: "CVE-2026-109619", severity: "critical", cvss_score: 8.1, technologies: ["php"], source_org: "security@php.net", published_at: "2026-10-21T14:17:09.357Z" });
    expect(a.products).toEqual(["php:php", "siemens:ruggedcom_ape1808_firmware"]);
    // The issuer's own product is the subject, even when a vendor that bundles it lists more versions.
    const bundled = fromNvd({ ...PHP_619.cve, configurations: [{ nodes: [{ cpeMatch: [
      { vulnerable: true, criteria: "cpe:2.3:o:paloaltonetworks:pan-os:10.1" }, { vulnerable: true, criteria: "cpe:2.3:o:paloaltonetworks:pan-os:10.2" },
      { vulnerable: true, criteria: "cpe:2.3:o:paloaltonetworks:pan-os:11.0" }, { vulnerable: true, criteria: "cpe:2.3:a:php:php:8.2" } ] }] }] } as never);
    expect(bundled.title.startsWith("PHP: ")).toBe(true);
    expect(a.title).toBe("PHP: PHP has various global state that temporarily points into request memory.");
  });
});

describe("the latest critical vulnerabilities", () => {
  it("pulls NVD and GitHub, merges sources about the same CVE, and tells affected projects once", async () => {
    await setProjectTechnologies(await ctx("owner@example.com"), "blog", ["PHP 8.3", "MySQL"]);
    const r = await refreshAdvisories(db, SETTINGS, (m) => log.push(m));
    expect(r.created).toBe(4); // 618 (NVD + GitHub merged), 619, the WordPress plugin, next
    // High by CVSS 3.1 but critical by 4.0 is kept; high by every rating isn't.
    expect(nvdCalls.some((u) => u.includes("cvssV3Severity=HIGH"))).toBe(true);
    expect((await db.query("SELECT 1 FROM advisories WHERE key = 'CVE-2026-60000'")).rowCount).toBe(0);
    const merged = (await db.query("SELECT sources, title, ghsa_ids FROM advisories WHERE key = 'CVE-2026-109618'")).rows[0];
    expect(merged.sources.sort()).toEqual(["ghsa", "nvd"]);
    expect(merged.title).toBe("PHP OOM longjmp leaves request memory uninitialized");
    // The PHP CVEs are older than the notification window on a first run; next is new.
    const notes = (await db.query("SELECT u.email, n.title, n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.kind = 'security' ORDER BY n.title")).rows;
    expect(notes.map((n: { title: string }) => n.title), JSON.stringify(notes)).toContain("Web app: CVE-2026-77777 may affect this project (depends on next)");
    expect(notes.some((n: { title: string }) => n.title.startsWith("Shop"))).toBe(false);
    // The next run looks back 3 days: now Shop (Composer packages → PHP) and Blog (set to PHP) hear about the PHP CVEs.
    expect((await refreshAdvisories(db, SETTINGS, () => {})).created).toBe(0);
    const told = (await db.query("SELECT DISTINCT s.slug FROM advisory_notices n JOIN scopes s ON s.id = n.scope_id ORDER BY 1")).rows.map((r: { slug: string }) => r.slug);
    expect(told).toEqual(["blog", "shop", "web"]);
  });

  it("groups a release of several CVEs for one product and shows which projects it may affect, and why", async () => {
    const feed = await latestAdvisories(await ctx("dev@example.com"), { days: 30 });
    const php = feed.advisories.find((a) => a.cve_ids.includes("CVE-2026-109619"))!;
    expect(php).toMatchObject({ title: "PHP: 2 critical vulnerabilities", cve_ids: ["CVE-2026-109618", "CVE-2026-109619"], severity: "critical", cvss_score: 9.8, technologies: [{ id: "php", label: "PHP" }] });
    expect(php.affects.map((a) => [a.project, a.because, a.can_respond]).sort()).toEqual([
      ["blog", ["uses PHP"], false],
      ["shop", ["uses PHP"], true],
    ]);
    const wp = feed.advisories.find((a) => a.cve_ids.includes("CVE-2026-55555"))!;
    expect(wp.affects).toEqual([]);
    const mine = await latestAdvisories(await ctx("dev@example.com"), { affecting: true });
    expect(mine.advisories.map((a) => a.title).sort()).toEqual(["Next.js middleware authorization bypass", "PHP: 2 critical vulnerabilities"]);
    expect((await latestAdvisories(await ctx("dev@example.com"), { technology: "php" })).advisories).toHaveLength(1);
  });

  it("lets admins publish a named alert that covers those CVEs, without telling projects twice", async () => {
    await expect(publishAdvisory(await ctx("owner@example.com"), { title: "x", summary: "y", technologies: ["php"] })).rejects.toThrow(/only admins/);
    await expect(publishAdvisory(await ctx("admin@example.com"), { title: "x", summary: "y" })).rejects.toThrow(/technologies/);
    const before = (await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'security'")).rows[0].n;
    const alert = await publishAdvisory(await ctx("admin@example.com"), {
      name: "PHP2Shell",
      title: "Unauthenticated remote code execution and memory disclosure in core PHP",
      summary: "Affects all supported PHP versions. Upgrade to the fixed releases.",
      cve_ids: ["cve-2026-109618", "CVE-2026-109619"],
      technologies: ["PHP"],
      url: "https://www.php.net/",
    });
    // Shop and Blog were already told about these CVEs (the second refresh above), so the alert doesn't repeat it.
    expect(alert.notified_projects).toBe(0);
    const after = (await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'security'")).rows[0].n;
    expect(after).toBe(before);
    const feed = await latestAdvisories(await ctx("dev@example.com"), {});
    const items = feed.advisories.filter((a) => a.cve_ids.includes("CVE-2026-109618"));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "PHP2Shell", manual: true, cve_ids: ["CVE-2026-109618", "CVE-2026-109619"], severity: "critical", cvss_score: 9.8 });
    expect(items[0]!.sources.sort()).toEqual(["ghsa", "manual", "nvd"]);
    // Publishing again doesn't notify again.
    await refreshAdvisories(db, { ...SETTINGS }, () => {});
    expect((await db.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'security'")).rows[0].n).toBe(after);
  });

  it("records each project's response and drops settled ones from the project context", async () => {
    const feed = await latestAdvisories(await ctx("dev@example.com"), { project: "shop" });
    const php = feed.advisories.find((a) => a.name === "PHP2Shell")!;
    await expect(setAdvisoryResponse(await ctx("viewer@example.com"), { advisory_id: php.id, project: "shop", status: "patched" })).rejects.toThrow(/writers/);
    await expect(setAdvisoryResponse(await ctx("dev@example.com"), { advisory_id: php.id, project: "shop", status: "not_affected" })).rejects.toThrow(/why/);
    const context = (await getProjectContext(await ctx("viewer@example.com"), "shop")) as { security_advisories?: { items: { name: string; because: string[] }[] } };
    expect(context.security_advisories!.items[0]).toMatchObject({ name: "PHP2Shell", because: ["uses PHP"] });
    await setAdvisoryResponse(await ctx("dev@example.com"), { advisory_id: php.id, project: "shop", status: "patched", note: "Upgraded the base image to the fixed PHP release" });
    const again = await latestAdvisories(await ctx("dev@example.com"), { project: "shop" });
    expect(again.advisories.find((a) => a.name === "PHP2Shell")!.affects[0]!.response).toMatchObject({ status: "patched", note: "Upgraded the base image to the fixed PHP release" });
    expect((await projectAdvisories(await ctx("dev@example.com"), "shop")).map((a) => a.name)).not.toContain("PHP2Shell");
  });

  it("learns a repository's stack from security reviews", async () => {
    const dev = await ctx("dev@example.com");
    await recordSecurityReview(dev, { project: "shop", component: "api", summary: "Reviewed the Dockerfile and config.", technologies: ["nginx 1.25", "Postgres", "Docker"] });
    const shop = (await db.query("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0].id;
    const stack = await stackOf(dev, shop);
    expect(stack.effective).toEqual(["docker", "nginx", "php", "postgresql"]);
    expect(stack.labels.postgresql).toBe("PostgreSQL");
    await expect(setProjectTechnologies(await ctx("viewer@example.com"), "shop", ["go"])).rejects.toThrow(/writers/);
  });

  it("notifies a new alert's projects when they haven't heard of it", async () => {
    const r = await publishAdvisory(await ctx("admin@example.com"), { name: "RedisRun", title: "Remote code execution in Redis", summary: "Patch now.", cve_ids: ["CVE-2026-99001"], technologies: ["redis"] });
    expect(r.notified_projects).toBe(0); // nobody runs Redis yet
    await setProjectTechnologies(await ctx("owner@example.com"), "web", ["Redis"]);
    const r2 = await publishAdvisory(await ctx("admin@example.com"), { name: "RedisRun 2", title: "Second Redis issue", summary: "Patch.", cve_ids: ["CVE-2026-99002"], technologies: ["redis"] });
    expect(r2.notified_projects).toBe(1);
  });
});

describe("major issues and automatic stack detection", () => {
  it("shows critical issues in widely used technologies by default, even when no project is tagged", async () => {
    const feed = await latestAdvisories(await ctx("viewer@example.com"), { view: "major" });
    const titles = feed.advisories.map((a) => a.title);
    expect(titles.some((t) => t.includes("PHP") || t.includes("Unauthenticated remote code execution"))).toBe(true);
    // An obscure plugin isn't major; it's still in "all".
    expect(titles.some((t) => t.includes("WordPress plugin"))).toBe(false);
    expect(feed.counts.all).toBeGreaterThan(feed.counts.major);
    expect((await latestAdvisories(await ctx("viewer@example.com"), { view: "all" })).advisories.some((a) => a.title.includes("WordPress plugin"))).toBe(true);
  });

  it("reads languages from GitHub and GitLab and dependencies from GitHub's dependency graph", async () => {
    const { parseRepoUrl, languagesToTech, sbomPackages, detectRepos } = await import("../src/core/repo-detect.js");
    expect(parseRepoUrl("git@git.example.co:team/platform/api.git")).toEqual({ host: "git.example.co", path: "team/platform/api" });
    expect(parseRepoUrl("https://github.com/acme/shop/")).toEqual({ host: "github.com", path: "acme/shop" });
    expect(languagesToTech({ PHP: 900, Blade: 300, JavaScript: 10, Dockerfile: 60 }).sort()).toEqual(["docker", "laravel", "php"]);
    expect(
      sbomPackages({
        sbom: {
          packages: [
            { externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:npm/%40laravel/multiplex@0.4.1" }] },
            { externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:npm/vite@%5E8.0.0" }] },
            { externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:composer/laravel/framework@11.2.0" }] },
            { externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1" }] },
          ],
        },
      }).map((p) => `${p.ecosystem}:${p.name}@${p.version}`),
    ).toEqual(["npm:@laravel/multiplex@0.4.1", "Packagist:laravel/framework@11.2.0", "Maven:org.apache.logging.log4j:log4j-core@2.14.1"]);

    const a = await ctx("admin@example.com");
    await adminCreateProject(a, { slug: "portal", name: "Portal" });
    await adminAddComponent(a, "portal", { slug: "site", kind: "backend", repo_url: "https://github.com/acme/portal-site" });
    await adminAddComponent(a, "portal", { slug: "worker", kind: "backend", repo_url: "git@git.example.co:team/portal/worker.git" });
    await adminAddComponent(a, "portal", { slug: "secret", kind: "backend", repo_url: "https://github.com/acme/private-thing" });
    await adminAddComponent(a, "portal", { slug: "internal", kind: "backend", repo_url: "git@vpn-only.example:team/internal.git" });
    const calls: string[] = [];
    const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(`${url} ${JSON.stringify(init?.headers ?? {})}`);
      if (url === "https://gh.test/repos/acme/portal-site/languages") return Response.json({ PHP: 800, Dockerfile: 100 });
      if (url === "https://gh.test/repos/acme/portal-site/dependency-graph/sbom")
        return Response.json({ sbom: { packages: [{ externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:composer/guzzlehttp/guzzle@7.4.0" }] }] } });
      if (url === "https://git.example.co/api/v4/projects/team%2Fportal%2Fworker/languages") return Response.json({ Python: 95.5, Shell: 4.5 });
      if (url.startsWith("https://vpn-only.example/")) throw new TypeError("fetch failed");
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const settings: Settings = { ...SETTINGS, security: { ...SETTINGS.security!, fetch: fetchStub, gitlabToken: "glpat-x" } };
    const portal = (await db.query("SELECT id FROM scopes WHERE slug = 'portal'")).rows[0].id;
    const ingested: { component: string; n: number }[] = [];
    const found = await detectRepos(db, settings, async (_s, component, packages) => void ingested.push({ component, n: packages.length }), { scopeId: portal });
    expect(found).toEqual([
      { repository: "internal", host: "vpn-only.example", technologies: [], packages: 0, error: "couldn't reach vpn-only.example from the server" },
      { repository: "secret", host: "github.com", technologies: [], packages: 0, error: "private or not found (set GITHUB_TOKEN)" },
      { repository: "site", host: "github.com", technologies: ["php", "docker"], packages: 1 },
      { repository: "worker", host: "git.example.co", technologies: ["python"], packages: 0 },
    ]);
    expect(ingested).toEqual([{ component: "site", n: 1 }]);
    expect(calls.find((c) => c.includes("git.example.co"))).toContain("glpat-x");
    const stack = await stackOf(a, portal);
    expect(stack.effective).toEqual(["docker", "php", "python"]);
    expect(stack.repositories.find((r) => r.slug === "secret")!.detect_error).toMatch(/GITHUB_TOKEN/);
    // Now PHP issues reach Portal without anyone tagging it.
    const feed = await latestAdvisories(a, { project: "portal" });
    expect(feed.advisories.some((x) => x.cve_ids.includes("CVE-2026-109618"))).toBe(true);
  });
});

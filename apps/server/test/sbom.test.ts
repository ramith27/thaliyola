import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAddComponent, adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { exportSbom, licenceReport, licenceRisk, purl } from "../src/core/sbom.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
const calls: string[] = [];
const LICENCES: Record<string, string[] | 404> = {
  "lodash@4.17.15": ["MIT"],
  "left-pad@1.0.0": ["GPL-3.0-only"],
  "mixed@1.0.0": ["GPL-2.0-only OR MIT"],
  "@acme/ui@2.0.0": ["LGPL-3.0-only"],
  "ghost@0.0.1": 404,
};
const fakeFetch = (async (url: string) => {
  calls.push(url);
  const m = /packages\/([^/]+)\/versions\/([^/]+)$/.exec(url)!;
  const key = `${decodeURIComponent(m[1]!)}@${decodeURIComponent(m[2]!)}`;
  const l = LICENCES[key];
  if (l === 404 || !l) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify({ licenses: l }), { status: 200 });
}) as unknown as typeof fetch;
const settings = { ...TEST_SETTINGS, security: { ...(TEST_SETTINGS.security ?? { osvUrl: "", kevUrl: "" }), enabled: true, fetch: fakeFetch } };
const as = async (email: string) => ({ ...(await ctxFor(db, { email })), settings });

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "shop", name: "Shop" });
  await adminAddComponent(a, "shop", { slug: "api", kind: "backend", repo_url: "https://github.com/acme/shop-api" });
  await adminSetMember(a, "shop", "writer@example.com", "writer");
  await adminSetMember(a, "shop", "viewer@example.com", "reader");
  const scope = (await db.query("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0].id;
  for (const [name, version] of [["lodash", "4.17.15"], ["left-pad", "1.0.0"], ["mixed", "1.0.0"], ["@acme/ui", "2.0.0"], ["ghost", "0.0.1"]])
    await db.query("INSERT INTO dependencies (scope_id, component, ecosystem, name, version, manifest) VALUES ($1, 'api', 'npm', $2, $3, 'package-lock.json')", [scope, name, version]);
  await db.query(
    `INSERT INTO vulnerabilities (scope_id, component, source, advisory_id, aliases, title, ecosystem, package, version, fixed_versions, severity, cvss_score, kev)
     VALUES ($1, 'api', 'osv', 'GHSA-xxxx', '{CVE-2021-23337}', 'Command injection in lodash', 'npm', 'lodash', '4.17.15', '{4.17.21}', 'high', 7.2, true)`,
    [scope],
  );
});
afterAll(() => db.end());

describe("package URLs and licence risk", () => {
  it("builds purls per ecosystem", () => {
    expect(purl("npm", "@types/node", "20.1.0")).toBe("pkg:npm/%40types/node@20.1.0");
    expect(purl("PyPI", "requests", "2.31.0")).toBe("pkg:pypi/requests@2.31.0");
    expect(purl("Maven", "org.apache.logging.log4j:log4j-core", "2.14.1")).toBe("pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1");
    expect(purl("Go", "github.com/gin-gonic/gin", "v1.9.0")).toBe("pkg:golang/github.com/gin-gonic/gin@v1.9.0");
    expect(purl("crates.io", "serde", "1.0.0")).toBe("pkg:cargo/serde@1.0.0");
  });

  it("classifies licences, letting OR pick the least restrictive", () => {
    expect(licenceRisk(["MIT"])).toBe("none");
    expect(licenceRisk(["GPL-3.0-only"])).toBe("strong_copyleft");
    expect(licenceRisk(["AGPL-3.0-or-later"])).toBe("strong_copyleft");
    expect(licenceRisk(["LGPL-2.1-only"])).toBe("weak_copyleft");
    expect(licenceRisk(["GPL-2.0-only OR MIT"])).toBe("none");
    expect(licenceRisk([])).toBe("unknown");
    expect(licenceRisk(null)).toBe("unknown");
  });
});

describe("SBOM", () => {
  it("exports CycloneDX 1.5 with purls, the repository, open vulnerabilities and licences", async () => {
    const bom = await exportSbom(await as("writer@example.com"), "shop", { licenses: true });
    expect(bom).toMatchObject({ bomFormat: "CycloneDX", specVersion: "1.5", metadata: { component: { name: "shop" } } });
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    const lodash = bom.components.find((c) => c.name === "lodash")!;
    expect(lodash).toMatchObject({ purl: "pkg:npm/lodash@4.17.15", "bom-ref": "api:pkg:npm/lodash@4.17.15", licenses: [{ license: { id: "MIT" } }] });
    expect(lodash.properties).toContainEqual({ name: "thaliyola:repository", value: "api" });
    expect(bom.components.find((c) => c.name === "mixed")!.licenses).toEqual([{ expression: "GPL-2.0-only OR MIT" }]);
    expect(bom.components.find((c) => c.name === "ghost")!.licenses).toBeUndefined();
    expect(bom.vulnerabilities).toHaveLength(1);
    expect(bom.vulnerabilities[0]).toMatchObject({
      id: "GHSA-xxxx",
      ratings: [{ severity: "high", score: 7.2, method: "CVSSv31" }],
      recommendation: "Upgrade to 4.17.21",
      affects: [{ ref: "api:pkg:npm/lodash@4.17.15" }],
      properties: [{ name: "cisa:kev", value: "true" }],
    });
  });

  it("caches licences (deps.dev is asked once per version, unknown ones included)", async () => {
    const before = calls.length;
    await exportSbom(await as("writer@example.com"), "shop", { licenses: true });
    expect(calls.length).toBe(before);
    expect((await db.query("SELECT count(*)::int AS n FROM package_licenses")).rows[0].n).toBe(5);
  });

  it("is only for those who see vulnerability details, and says when nothing was scanned", async () => {
    await expect(exportSbom(await as("viewer@example.com"), "shop")).rejects.toThrow(/Contributors/);
    const a = await as("admin@example.com");
    await adminCreateProject(a, { slug: "empty", name: "Empty" });
    await expect(exportSbom(a, "empty")).rejects.toThrow(/no dependencies recorded/);
  });
});

describe("licence check", () => {
  it("flags strong and weak copyleft and unknown licences, most serious first", async () => {
    const r = await licenceReport(await as("writer@example.com"), "shop");
    expect(r.counts).toEqual({ strong_copyleft: 1, weak_copyleft: 1, unknown: 1 });
    expect(r.flagged.map((f) => [f.package, f.risk])).toEqual([
      ["left-pad", "strong_copyleft"],
      ["@acme/ui", "weak_copyleft"],
      ["ghost", "unknown"],
    ]);
    expect(r.by_licence[0]).toBeDefined();
  });
});

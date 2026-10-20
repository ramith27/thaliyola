import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAddComponent, adminCreateProject } from "../src/core/admin.js";
import {
  checkMermaid, claimsFor, docsBegin, docsFinish, docsNextPage, docsStatus, docsSubmitPage, docsSubmitPlan, evidenceUrl, ignoreMatcher, parseEvidence, resolveClaims, updateDocSettings,
} from "../src/core/docs.js";
import { getArticle } from "../src/core/items.js";
import { getTasks } from "../src/core/tasks.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await admin();
  await adminCreateProject(a, { slug: "ledger", name: "Ledger" });
  await adminAddComponent(a, "ledger", { slug: "api", kind: "backend", repo_url: "git@github.com:acme/ledger-api.git" });
  await updateDocSettings(a, "ledger", { instructions: "Write for new backend engineers.", ignore: "secrets/\n*.pem\nvendor/**\n!vendor/README.md" });
});
afterAll(() => db.end());
const admin = () => ctxFor(db, { email: "admin@example.com" });
const SHA1 = "1111111111111111111111111111111111111111";
const SHA2 = "2222222222222222222222222222222222222222";

describe("helpers", () => {
  it("matches gitignore-style rules", () => {
    const ig = ignoreMatcher("secrets/\n*.pem\nvendor/**\n!vendor/README.md\n/build");
    expect(ig("secrets/prod.env")).toBe(true);
    expect(ig("src/secrets/x")).toBe(true);
    expect(ig("certs/server.pem")).toBe(true);
    expect(ig("vendor/lib/a.js")).toBe(true);
    expect(ig("vendor/README.md")).toBe(false);
    expect(ig("build/out.js")).toBe(true);
    expect(ig("src/build/out.js")).toBe(false);
    expect(ig("src/index.ts")).toBe(false);
  });
  it("checks Mermaid diagrams", () => {
    expect(checkMermaid("```mermaid\nflowchart TD\n  A[Start] --> B{Ok?}\n```")).toEqual([]);
    expect(checkMermaid("```mermaid\nflowhcart TD\n  A --> B\n```")[0]).toMatch(/isn't a Mermaid diagram type/);
    expect(checkMermaid("```mermaid\nsequenceDiagram\n  A->>B: hi (there\n```")[0]).toMatch(/unclosed bracket/);
  });
  it("parses evidence and links it to the repository host", () => {
    expect(parseEvidence("repo://src/a.ts#L40-L82")).toEqual({ path: "src/a.ts", start: 40, end: 82 });
    expect(evidenceUrl("git@github.com:acme/ledger-api.git", { path: "src/a.ts", start: 40, end: 82, sha: SHA1 })).toBe(`https://github.com/acme/ledger-api/blob/${SHA1}/src/a.ts#L40-L82`);
    expect(evidenceUrl("https://gitlab.com/acme/x", { path: "a.ts", start: 3, sha: SHA1 })).toBe(`https://gitlab.com/acme/x/-/blob/${SHA1}/a.ts#L3`);
  });
});

describe("documentation runs", () => {
  let overviewId = "";
  it("plans, writes grounded pages one at a time, and finishes with an AGENTS.md block", async () => {
    const a = await admin();
    const begin = await docsBegin(a, { repo: "https://github.com/acme/ledger-api", head_sha: SHA1 });
    expect(begin).toMatchObject({ mode: "init", project: "ledger", repository: "api", instructions: "Write for new backend engineers." });
    const runId = (begin as { run_id: string }).run_id;
    await expect(docsSubmitPlan(a, { run_id: runId, pages: [{ key: "Bad Key", title: "x", type: "system" }] })).rejects.toThrow(/lowercase/);
    await expect(docsSubmitPlan(a, { run_id: runId, pages: [{ key: "keys", title: "Keys", type: "system", sources: ["secrets/keys.txt"] }] })).rejects.toThrow(/ignore rules/);
    await docsSubmitPlan(a, {
      run_id: runId,
      pages: [
        { key: "overview", title: "Ledger API overview", type: "system", sources: ["src/server.ts"] },
        { key: "posting-flow", title: "Posting a transaction", type: "tech_spec", folder: "Flows", sources: ["src/posting"] },
      ],
    });
    // Resuming returns the same run.
    expect(await docsBegin(a, { repo: "https://github.com/acme/ledger-api", head_sha: SHA1 })).toMatchObject({ run_id: runId, resumed: true });

    const p1 = await docsNextPage(a, { run_id: runId });
    expect((p1 as { page: { key: string } }).page.key).toBe("overview");
    const body = "## Purpose\n\nThe ledger API records double-entry transactions.\n\n## Architecture\n\n```mermaid\nflowchart LR\n  Client --> API[Ledger API] --> DB[(Postgres)]\n```\n";
    await expect(docsSubmitPage(a, { run_id: runId, key: "overview", body_md: body.replace("flowchart LR", "flowchrt LR"), claims: [{ text: "x", evidence: ["src/server.ts#L1"] }] })).rejects.toThrow(/fix the diagrams/);
    await expect(docsSubmitPage(a, { run_id: runId, key: "overview", body_md: body, claims: [] })).rejects.toThrow(/ground the page/);
    await expect(docsSubmitPage(a, { run_id: runId, key: "overview", body_md: body, claims: [{ text: "Uses a cert", evidence: ["certs/a.pem"] }] })).rejects.toThrow(/ignore rules/);
    const s1 = await docsSubmitPage(a, {
      run_id: runId,
      key: "overview",
      body_md: body,
      claims: [
        { section: "Purpose", text: "Records double-entry transactions", evidence: ["repo://src/ledger.ts#L10-L40"] },
        { section: "Architecture", text: "Stores data in Postgres", evidence: [{ path: "src/db.ts", start: 1, end: 12 }] },
      ],
    });
    expect(s1).toMatchObject({ published: true, claims: 2, pages_left: 1 });
    overviewId = s1.article_id;
    await docsNextPage(a, { run_id: runId });
    await docsSubmitPage(a, { run_id: runId, key: "posting-flow", body_md: "## Interface\n\nPOST /transactions posts a balanced transaction.\n", claims: [{ text: "POST /transactions posts", evidence: ["src/posting/routes.ts#L5-L30"] }] });
    expect(await docsNextPage(a, { run_id: runId })).toMatchObject({ done: true });
    const fin = await docsFinish(a, { run_id: runId });
    expect(fin.agents_md).toMatch(/<!-- THALIYOLA:START[\s\S]*Ledger API overview[\s\S]*<!-- THALIYOLA:END -->/);
    const article = await getArticle(a, overviewId);
    expect([article.title, article.components]).toEqual(["Ledger API overview", ["api"]]);
    const flow = (await db.query("SELECT path FROM articles WHERE title = 'Posting a transaction'")).rows[0];
    expect(flow.path).toBe("Flows");
    const claims = await claimsFor(a, overviewId);
    expect(claims.claims.find((x) => x.text.includes("double-entry"))!.evidence[0]!.url).toBe(`https://github.com/acme/ledger-api/blob/${SHA1}/src/ledger.ts#L10-L40`);
  });

  it("is a no-op when nothing relevant changed, and otherwise flags exactly the affected facts and pages", async () => {
    const a = await admin();
    expect(await docsBegin(a, { project: "ledger", component: "api", head_sha: SHA1, mode: "update" })).toMatchObject({ noop: true });
    expect(await docsBegin(a, { project: "ledger", component: "api", head_sha: SHA2, mode: "update", changed_files: ["secrets/new.env", "vendor/x.js"] })).toMatchObject({ noop: true });
    await expect(docsBegin(a, { project: "ledger", component: "api", head_sha: SHA2, base_sha: SHA1, mode: "update" })).rejects.toThrow(/changed_files/);

    const up = (await docsBegin(a, { project: "ledger", component: "api", head_sha: SHA2, mode: "update", changed_files: ["src/db.ts", "src/new-feature.ts"] })) as {
      run_id: string; affected_pages: { key: string; reasons: string[] }[]; unmapped_changes: string[];
    };
    expect(up.affected_pages.map((p) => p.key)).toEqual(["overview"]);
    expect(up.affected_pages[0]!.reasons.join(" ")).toMatch(/1 stale claim/);
    expect(up.unmapped_changes).toEqual(["src/new-feature.ts"]);
    const c = await claimsFor(a, overviewId);
    expect(c.claims.find((x) => x.text.includes("Postgres"))!.status).toBe("stale");
    expect(c.claims.find((x) => x.text.includes("double-entry"))!.status).toBe("ok");

    // The stale fact is a curation task too.
    expect((await getTasks(await admin(), { kind: "stale_claims" })).tasks.map((t) => t.targets[0]!.id)).toContain(overviewId);
    // An agent confirms it after checking the code.
    const stale = c.claims.find((x) => x.status === "stale")!;
    await resolveClaims(a, { article_id: overviewId, confirm: [{ id: stale.id, evidence: ["src/db.ts#L1-L14"], sha: SHA2 }] });
    expect((await claimsFor(a, overviewId)).stale).toBe(0);
    await docsFinish(a, { run_id: up.run_id });
    const status = await docsStatus(a, "ledger");
    expect(status.repositories[0]).toMatchObject({ slug: "api", docs_sha: SHA2, pages: 2 });
    expect(status.runs.map((r: { status: string }) => r.status)).toEqual(expect.arrayContaining(["done", "noop"]));
  });

  it("files a non-owner's pages as proposals", async () => {
    const writer = await ctxFor(db, { email: "writer@example.com" });
    const b = (await docsBegin(writer, { project: "ledger", component: "api", head_sha: SHA2, mode: "init" })) as { run_id: string };
    await docsSubmitPlan(writer, { run_id: b.run_id, pages: [{ key: "runbook", title: "Ledger runbook", type: "runbook" }] });
    await docsNextPage(writer, { run_id: b.run_id });
    const res = await docsSubmitPage(writer, { run_id: b.run_id, key: "runbook", body_md: "## Trigger\n\nLedger alerts fire when postings fail.\n", claims: [{ text: "alerts", evidence: ["ops/alerts.yml#L1"] }] });
    expect(res.published).toBe(false);
    expect(res.revision_id).toBeTruthy();
  });
});

describe("static site export", () => {
  it("packs the viewer, wiki.json with pages, grounded facts and the graph", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { unzipSync, strFromU8 } = await import("fflate");
    const { exportSite } = await import("../src/core/exporter.js");
    const viewer = mkdtempSync(join(tmpdir(), "viewer-"));
    writeFileSync(join(viewer, "viewer.html"), "<html>viewer</html>");
    mkdirSync(join(viewer, "assets"));
    writeFileSync(join(viewer, "assets", "viewer.js"), "console.log(1)");
    writeFileSync(join(viewer, "connect.sh"), "#!/bin/sh");
    const out = await exportSite(await admin(), { scope: "ledger", viewerDir: viewer });
    const files = unzipSync(out.zip);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["index.html", "assets/viewer.js", "wiki.json"]));
    expect(Object.keys(files)).not.toContain("connect.sh");
    const wiki = JSON.parse(strFromU8(files["wiki.json"]!));
    expect(wiki.title).toBe("Ledger");
    const page = wiki.pages.find((p: { title: string }) => p.title === "Ledger API overview");
    expect(page.claims[0].evidence[0].url).toMatch(/^https:\/\/github\.com\/acme\/ledger-api\/blob\//);
    expect(wiki.graph.nodes.length).toBeGreaterThan(0);
    await expect(exportSite(await admin(), { scope: "ledger", viewerDir: join(viewer, "nope") })).rejects.toThrow(/isn't built/);
  });
});

describe("repository URLs", () => {
  it("drops credentials that CI checkouts put in http(s) remotes", async () => {
    const { cleanRepoUrl, repoKey } = await import("../src/core/bootstrap.js");
    expect(cleanRepoUrl("https://gitlab-ci-token:glcbt-abc@gitlab.com/acme/api.git")).toBe("https://gitlab.com/acme/api.git");
    expect(cleanRepoUrl("git@github.com:acme/api.git")).toBe("git@github.com:acme/api.git");
    expect(repoKey("https://x-access-token:ghs_1@github.com/Acme/API.git")).toBe(repoKey("git@github.com:acme/api.git"));
  });
});

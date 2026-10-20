import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { zipSync } from "fflate";
import { getAsset } from "./assets.js";
import { ValidationError, type RequestContext } from "./context.js";
import { evidenceUrl, type Evidence } from "./docs.js";
import { knowledgeGraph } from "./insights.js";
import { readableScopes } from "./permissions.js";

/**
 * Exports what the caller can read as a zip of Markdown files with YAML front
 * matter, one folder per scope (articles keep their folders; findings go in
 * `findings/`), plus attachments in `assets/` with image links rewritten to
 * them. Published and possibly-stale items only.
 */

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .slice(0, 80) || "untitled";

const yaml = (fields: Record<string, unknown>) =>
  `---\n${Object.entries(fields)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n\n`;

/** `all` (the admin CLI only) exports every scope, members-only projects included. */
export async function exportMarkdown(ctx: RequestContext, opts: { scope?: string; all?: boolean } = {}) {
  const readable = opts.all ? null : await readableScopes(ctx);
  const scopeFilter = opts.scope ? (await ctx.db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1", [opts.scope])).rows[0]?.id ?? "00000000-0000-0000-0000-000000000000" : null;
  const articles = await ctx.db.query(
    `SELECT a.id, a.title, a.type, a.status, a.path, a.body_md, a.tags, a.version, a.updated_at, a.last_verified_at, s.slug AS scope,
            coalesce(u.email, u.subject) AS owner,
            d.component AS repository, d.last_sha AS commit, coalesce(g.email, g.subject) AS generated_by,
            (SELECT coalesce(json_agg(DISTINCT e->>'path' || coalesce('#L' || (e->>'start') || coalesce('-L' || (e->>'end'), ''), '')), '[]')
               FROM claims c, jsonb_array_elements(c.evidence) e WHERE c.article_id = a.id AND c.status <> 'retired') AS sources
       FROM articles a JOIN scopes s ON s.id = a.scope_id LEFT JOIN users u ON u.id = a.owner_id
       LEFT JOIN doc_pages d ON d.article_id = a.id LEFT JOIN users g ON g.id = d.generated_by
      WHERE a.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR a.scope_id = ANY($1)) AND ($2::uuid IS NULL OR a.scope_id = $2)
      ORDER BY s.slug, a.path, a.title`,
    [readable, scopeFilter],
  );
  const findings = await ctx.db.query(
    `SELECT f.id, f.title, f.type, f.status, f.symptoms, f.root_cause, f.fix, f.tags, f.version, f.updated_at, f.last_verified_at, s.slug AS scope
       FROM findings f JOIN scopes s ON s.id = f.scope_id
      WHERE f.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR f.scope_id = ANY($1)) AND ($2::uuid IS NULL OR f.scope_id = $2)
      ORDER BY s.slug, f.title`,
    [readable, scopeFilter],
  );

  const files: Record<string, Uint8Array> = {};
  const enc = new TextEncoder();
  const used = new Set<string>();
  const unique = (p: string) => {
    let candidate = p;
    for (let i = 2; used.has(candidate); i++) candidate = p.replace(/\.md$/, `-${i}.md`);
    used.add(candidate);
    return candidate;
  };
  const assetPaths = new Map<string, string>();
  async function assetFile(id: string): Promise<string | null> {
    if (assetPaths.has(id)) return assetPaths.get(id)!;
    try {
      const { meta, data } = await getAsset(ctx, id, { skipReadCheck: opts.all });
      const p = `assets/${id.slice(0, 8)}-${meta.filename.replace(/[^\w.-]+/g, "_")}`;
      files[p] = new Uint8Array(data);
      assetPaths.set(id, p);
      return p;
    } catch {
      return null;
    }
  }
  async function withAssets(md: string, file: string) {
    let out = md;
    for (const m of md.matchAll(/\(asset:([0-9a-f-]{36})\)/g)) {
      const p = await assetFile(m[1]!);
      if (p) out = out.split(`(asset:${m[1]})`).join(`(${path.posix.relative(path.posix.dirname(file), p)})`);
    }
    return out;
  }

  // Open Knowledge Format: front matter with provenance on every page, plus index.md and log.md.
  const exported = new Date().toISOString();
  const entries: { scope: string; folder: string; title: string; file: string; kind: string }[] = [];
  for (const a of articles.rows) {
    const file = unique(path.posix.join(a.scope, ...(a.path ? String(a.path).split("/").map(slug) : []), `${slug(a.title)}.md`));
    const meta = yaml({
      okf: "0.2", title: a.title, id: a.id, kind: "article", type: a.type, status: a.status, scope: a.scope, path: a.path || null, tags: a.tags, owner: a.owner,
      version: a.version, updated: a.updated_at,
      provenance: {
        generated: !!a.generated_by, ...(a.generated_by ? { generated_by: a.generated_by, repository: a.repository || null, commit: a.commit } : {}),
        sources: a.sources, verified: a.last_verified_at,
      },
    });
    files[file] = enc.encode(`${meta}# ${a.title}\n\n${await withAssets(a.body_md, file)}\n`);
    entries.push({ scope: a.scope, folder: a.path || "", title: a.title, file, kind: "article" });
  }
  for (const f of findings.rows) {
    const file = unique(path.posix.join(f.scope, "findings", `${slug(f.title)}.md`));
    const meta = yaml({
      okf: "0.2", title: f.title, id: f.id, kind: "finding", type: f.type, status: f.status, scope: f.scope, tags: f.tags, version: f.version, updated: f.updated_at,
      provenance: { generated: false, verified: f.last_verified_at },
    });
    const body = `## Symptoms\n\n${f.symptoms}\n\n## Root cause\n\n${f.root_cause}\n${f.fix ? `\n## Fix\n\n${f.fix}\n` : ""}`;
    files[file] = enc.encode(`${meta}# ${f.title}\n\n${await withAssets(body, file)}`);
    entries.push({ scope: f.scope, folder: "Findings", title: f.title, file, kind: "finding" });
  }

  const index: string[] = [yaml({ okf: "0.2", title: "Index", exported }).trimEnd(), "", "# Index", ""];
  for (const scope of [...new Set(entries.map((e) => e.scope))]) {
    index.push(`## ${scope}`, "");
    for (const folder of [...new Set(entries.filter((e) => e.scope === scope).map((e) => e.folder))].sort()) {
      if (folder) index.push(`### ${folder}`, "");
      for (const e of entries.filter((x) => x.scope === scope && x.folder === folder)) index.push(`- [${e.title}](${e.file})`);
      index.push("");
    }
  }
  files["index.md"] = enc.encode(index.join("\n"));

  // log.md: what was published, newest first.
  const log = await ctx.db.query<{ decided_at: string; summary: string; scope: string; author: string; op: string }>(
    `SELECT r.decided_at, r.summary, s.slug AS scope, coalesce(u.display_name, u.email, u.subject) AS author, r.op
       FROM revisions r JOIN scopes s ON s.id = r.scope_id JOIN users u ON u.id = r.author_id
      WHERE r.state = 'approved' AND ($1::uuid[] IS NULL OR r.scope_id = ANY($1)) AND ($2::uuid IS NULL OR r.scope_id = $2)
      ORDER BY r.decided_at DESC LIMIT 2000`,
    [readable, scopeFilter],
  );
  files["log.md"] = enc.encode(
    [yaml({ okf: "0.2", title: "Log", exported }).trimEnd(), "", "# Log", "", ...log.rows.map((r) => `- ${String(new Date(r.decided_at).toISOString()).slice(0, 10)} · ${r.scope} · ${r.summary} (${r.op}, by ${r.author})`), ""].join("\n"),
  );
  files["README.md"] = enc.encode(`# Thaliyola export\n\nExported ${exported} in Open Knowledge Format 0.2. Start at [index.md](index.md); [log.md](log.md) lists what was published, newest first.\n`);
  return { zip: zipSync(files, { level: 6 }), articles: articles.rows.length, findings: findings.rows.length, assets: assetPaths.size };
}

/**
 * A static site of what the caller can read (optionally one scope): the
 * self-contained viewer (index, search, graph, reader with grounded facts)
 * plus wiki.json and the files pages show. Host it anywhere static: GitHub
 * Pages, MkDocs, an internal file server.
 */
export async function exportSite(ctx: RequestContext, opts: { scope?: string; viewerDir: string }) {
  if (!existsSync(path.join(opts.viewerDir, "viewer.html"))) throw new ValidationError("the static site viewer isn't built on this server (pnpm --filter @thaliyola/web build)");
  const readable = await readableScopes(ctx);
  const scopeRow = opts.scope ? (await ctx.db.query<{ id: string; name: string }>("SELECT id, name FROM scopes WHERE slug = $1 AND status <> 'deleted'", [opts.scope])).rows[0] : undefined;
  if (opts.scope && (!scopeRow || (readable && !readable.includes(scopeRow.id)))) throw new ValidationError(`scope '${opts.scope}' not found`);
  const scopeId = scopeRow?.id ?? null;
  const articles = await ctx.db.query(
    `SELECT a.id, 'article' AS kind, a.title, a.type, s.slug AS scope, a.path AS folder, a.body_md, a.updated_at AS updated,
            (SELECT c.repo_url FROM doc_pages d JOIN components c ON c.scope_id = d.scope_id AND c.slug = d.component WHERE d.article_id = a.id LIMIT 1) AS repo_url
       FROM articles a JOIN scopes s ON s.id = a.scope_id
      WHERE a.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR a.scope_id = ANY($1)) AND ($2::uuid IS NULL OR a.scope_id = $2)
      ORDER BY s.slug, a.path, a.title`,
    [readable, scopeId],
  );
  const findings = await ctx.db.query(
    `SELECT f.id, 'finding' AS kind, f.title, f.type, s.slug AS scope, 'Findings' AS folder, f.updated_at AS updated,
            '## Symptoms' || E'\n\n' || f.symptoms || E'\n\n## Root cause\n\n' || f.root_cause || coalesce(E'\n\n## Fix\n\n' || f.fix, '') AS body_md
       FROM findings f JOIN scopes s ON s.id = f.scope_id
      WHERE f.status IN ('published', 'possibly_stale') AND ($1::uuid[] IS NULL OR f.scope_id = ANY($1)) AND ($2::uuid IS NULL OR f.scope_id = $2)`,
    [readable, scopeId],
  );
  const files: Record<string, Uint8Array> = {};
  const assets: Record<string, string> = {};
  const pages = [];
  for (const p of [...articles.rows, ...findings.rows]) {
    for (const m of String(p.body_md).matchAll(/\(asset:([0-9a-f-]{36})\)/g)) {
      const id = m[1]!;
      if (assets[id]) continue;
      try {
        const { meta, data } = await getAsset(ctx, id);
        const file = `files/${id.slice(0, 8)}-${meta.filename.replace(/[^\w.-]+/g, "_")}`;
        files[file] = new Uint8Array(data);
        assets[id] = file;
      } catch {
        /* unreadable or missing: the page shows a placeholder */
      }
    }
    const claims = p.kind === "article"
      ? (await ctx.db.query<{ section: string; text: string; status: string; evidence: Evidence[] }>(
          "SELECT section, text, status, evidence FROM claims WHERE article_id = $1 AND status <> 'retired' ORDER BY section, created_at",
          [p.id],
        )).rows.map((c) => ({ ...c, evidence: c.evidence.map((e) => ({ ...e, url: evidenceUrl(p.repo_url, e) })) }))
      : [];
    pages.push({ id: p.id, kind: p.kind, title: p.title, type: p.type, scope: p.scope, folder: p.folder ?? "", body_md: p.body_md, updated: p.updated, claims });
  }
  const graph = await knowledgeGraph(ctx, { scope: opts.scope, limit: 600 });
  const title = scopeRow?.name ?? "Team knowledge";
  const wiki = { title, exported: new Date().toISOString(), pages, graph: { nodes: graph.nodes, edges: graph.edges }, assets };
  files["wiki.json"] = new TextEncoder().encode(JSON.stringify(wiki));
  // The viewer itself (its entry becomes index.html).
  const walk = (dir: string, rel = "") => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r);
      // Only the viewer itself: the page, its bundle and the icon (the web app's other public files stay out).
      else if (r === "viewer.html" || r === "favicon.svg" || r.startsWith("assets/")) files[r === "viewer.html" ? "index.html" : r] = new Uint8Array(readFileSync(full));
    }
  };
  walk(opts.viewerDir);
  return { zip: zipSync(files, { level: 6 }), pages: pages.length, title };
}

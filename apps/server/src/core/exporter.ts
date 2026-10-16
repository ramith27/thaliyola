import path from "node:path";
import { zipSync } from "fflate";
import { getAsset } from "./assets.js";
import type { RequestContext } from "./context.js";
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
            coalesce(u.email, u.subject) AS owner
       FROM articles a JOIN scopes s ON s.id = a.scope_id LEFT JOIN users u ON u.id = a.owner_id
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

  const index: string[] = ["# Thaliyola export", "", `Exported ${new Date().toISOString()}.`, ""];
  for (const a of articles.rows) {
    const file = unique(path.posix.join(a.scope, ...(a.path ? String(a.path).split("/").map(slug) : []), `${slug(a.title)}.md`));
    const meta = yaml({ title: a.title, id: a.id, type: a.type, status: a.status, scope: a.scope, path: a.path || null, tags: a.tags, owner: a.owner, version: a.version, updated_at: a.updated_at, last_verified_at: a.last_verified_at });
    files[file] = enc.encode(`${meta}# ${a.title}\n\n${await withAssets(a.body_md, file)}\n`);
    index.push(`- [${a.title}](${file})`);
  }
  for (const f of findings.rows) {
    const file = unique(path.posix.join(f.scope, "findings", `${slug(f.title)}.md`));
    const meta = yaml({ title: f.title, id: f.id, type: f.type, status: f.status, scope: f.scope, tags: f.tags, version: f.version, updated_at: f.updated_at, last_verified_at: f.last_verified_at });
    const body = `## Symptoms\n\n${f.symptoms}\n\n## Root cause\n\n${f.root_cause}\n${f.fix ? `\n## Fix\n\n${f.fix}\n` : ""}`;
    files[file] = enc.encode(`${meta}# ${f.title}\n\n${await withAssets(body, file)}`);
    index.push(`- [${f.title}](${file})`);
  }
  files["README.md"] = enc.encode(index.join("\n") + "\n");
  return { zip: zipSync(files, { level: 6 }), articles: articles.rows.length, findings: findings.rows.length, assets: assetPaths.size };
}

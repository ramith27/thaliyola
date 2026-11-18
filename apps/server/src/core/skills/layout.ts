import type { TreeEntry } from "./archive.js";
import { parseConnectors, parseJsonStrict, type Connector } from "./mcp-json.js";
import { NAME_RE, textOf } from "./types.js";

/**
 * Where the skills are in an imported tree, checked in this order:
 * 1. marketplace: .claude-plugin/marketplace.json lists plugins (./plugins/<p>, or "./" for the repository root), each
 *    with skills/<skill>/SKILL.md (or the entry's own "skills": ["./path", …] list) and optionally
 *    .claude-plugin/plugin.json and .mcp.json (its connectors). Each plugin becomes a collection. A marketplace that
 *    yields no skills falls through to the other layouts.
 * 2. plugin: .claude-plugin/plugin.json and skills/<skill>/SKILL.md at the root: one collection.
 * 3. plain: any …/skills/<name>/SKILL.md (up to 6 levels deep; .claude/skills/<name> too), a collection per parent.
 * 4. folder: <name>/SKILL.md folders at the root (a zip of several skill folders).
 * 5. single: SKILL.md at the root, named after the repository (git) or the upload's folder or file name.
 * 6. nested: any other <…>/<name>/SKILL.md up to 6 folders deep (a folder zipped inside another folder), outside
 *    hidden folders and node_modules. Read as the folder layout.
 *
 * A Claude-packaged skill is named "<name>.skill"; that suffix is dropped from folder and file names.
 * A tree whose only skill file is spelled differently (skill.md, Skill.md) is reported, not imported: Claude only
 * reads SKILL.md.
 */

export type Layout = "marketplace" | "plugin" | "plain" | "folder" | "single";

export interface PluginInfo {
  slug: string;
  name: string;
  description: string;
  upstreamVersion: string | null;
  connectors: Connector[];
  /** The plugin folder in the tree ("" for the plugin layout). */
  dir: string;
}

export interface SkillDirRef {
  /** Folder in the tree ("" for a single skill at the root). */
  dir: string;
  /** The folder's name: what the skill's frontmatter name must equal. */
  name: string;
  /** Collection slug. */
  collection: string;
}

export interface LayoutResult {
  layout: Layout | null;
  plugins: PluginInfo[];
  skills: SkillDirRef[];
  /** marketplace renames: old slug → new slug (or null: removed). */
  renames: Map<string, string | null>;
  rejected: { path: string; name: string; reasons: string[] }[];
  warnings: { path: string; message: string }[];
}

export interface LayoutOptions {
  /** git sources: the repository's last path segment (a single root skill takes this name). */
  repoName?: string | null;
  /** uploads: the stripped top folder, else the file name without its extension. */
  topName?: string | null;
  filename?: string | null;
  /** Collection for skills that have none of their own (plain at the root, folder, single). */
  collection?: string | null;
}

const isFile = (entries: Map<string, TreeEntry>, p: string) => entries.get(p)?.type === "file";

function readJson(entries: Map<string, TreeEntry>, p: string, warnings: LayoutResult["warnings"]): Record<string, unknown> | null {
  const e = entries.get(p);
  if (!e) return null;
  if (e.type !== "file") {
    warnings.push({ path: p, message: "must be a regular file" });
    return null;
  }
  const text = textOf(e.data);
  try {
    if (text === null) throw new Error("not UTF-8");
    const v = parseJsonStrict(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("must be a JSON object");
    return v as Record<string, unknown>;
  } catch (err) {
    warnings.push({ path: p, message: `invalid JSON (${(err as Error).message})` });
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** A collection slug from any folder or file name ("My Skills!" → "my-skills"). */
export function slugify(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/\.(zip|tgz|tar\.gz|tar)$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return s || "uploaded";
}

function connectorsOf(entries: Map<string, TreeEntry>, dir: string, warnings: LayoutResult["warnings"]): Connector[] {
  const p = dir ? `${dir}/.mcp.json` : ".mcp.json";
  const e = entries.get(p);
  if (!e) return [];
  if (e.type !== "file") {
    warnings.push({ path: p, message: "must be a regular file (found a symlink); no connectors kept" });
    return [];
  }
  const text = textOf(e.data);
  if (text === null) {
    warnings.push({ path: p, message: "not valid UTF-8; no connectors kept" });
    return [];
  }
  const r = parseConnectors(text, p);
  for (const m of r.errors) warnings.push({ path: p, message: `${m.replace(`${p}: `, "").replace(`${p} `, "")}; no connectors kept` });
  return r.connectors;
}

/** Skill folders directly under `<base>/skills/`. */
function skillsUnder(entries: Map<string, TreeEntry>, base: string): string[] {
  const prefix = base ? `${base}/skills/` : "skills/";
  const out = new Set<string>();
  for (const p of entries.keys()) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length).split("/");
    if (rest.length === 2 && rest[1] === "SKILL.md") out.add(`${prefix}${rest[0]}`);
  }
  return [...out].sort();
}

const lastSegment = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** A skill's name from its folder or file name: "advertiser-analysis.skill" (Claude's package name) → "advertiser-analysis". */
export function skillNameOf(raw: string): string {
  return raw
    .replace(/^.*[\\/]/, "")
    .replace(/\.(zip|tgz|tar\.gz|tar)$/i, "")
    .replace(/\.skill$/i, "");
}

/** Folders that never hold importable skills when searching deep (case 6). */
const skipDeep = (parts: string[]) => parts.some((s) => s === "node_modules" || (s.startsWith(".") && s !== ".claude"));

export function detectLayout(entries: Map<string, TreeEntry>, opts: LayoutOptions = {}): LayoutResult {
  const warnings: LayoutResult["warnings"] = [];
  const rejected: LayoutResult["rejected"] = [];
  const renames = new Map<string, string | null>();
  const fallback = opts.collection ? slugify(opts.collection) : "uploaded";

  // 1. marketplace
  const mp = readJson(entries, ".claude-plugin/marketplace.json", warnings);
  if (mp) {
    const plugins: PluginInfo[] = [];
    const skills: SkillDirRef[] = [];
    const listed = new Set<string>();
    const list = Array.isArray(mp.plugins) ? (mp.plugins as unknown[]) : [];
    if (!Array.isArray(mp.plugins)) warnings.push({ path: ".claude-plugin/marketplace.json", message: "'plugins' must be an array" });
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const e = raw as Record<string, unknown>;
      const slug = str(e.name);
      if (!slug || !NAME_RE.test(slug) || slug.length > 64) {
        rejected.push({ path: ".claude-plugin/marketplace.json", name: String(e.name ?? ""), reasons: ["a plugin name must be lowercase letters/digits with single hyphens"] });
        continue;
      }
      if (typeof e.source !== "string") {
        rejected.push({ path: `.claude-plugin/marketplace.json#${slug}`, name: slug, reasons: ["external plugin sources aren't imported (only ./ paths inside this repository)"] });
        continue;
      }
      const src = e.source.trim();
      // "./" (or ".") is the repository root: the usual single-plugin layout.
      const dir = src === "." || src === "./" ? "" : src.replace(/^\.\//, "").replace(/\/+$/, "");
      if (!(src === "." || src.startsWith("./")) || (dir && dir.split("/").some((s) => s === "" || s === "." || s === "..")) || /[\\\u0000-\u001f]/.test(dir)) {
        rejected.push({ path: `.claude-plugin/marketplace.json#${slug}`, name: slug, reasons: [`plugin source ${JSON.stringify(src)} must be a ./ path inside the repository`] });
        continue;
      }
      if (listed.has(slug)) {
        warnings.push({ path: ".claude-plugin/marketplace.json", message: `duplicate plugin name '${slug}'` });
        continue;
      }
      listed.add(slug);
      const pj = readJson(entries, dir ? `${dir}/.claude-plugin/plugin.json` : ".claude-plugin/plugin.json", warnings) ?? {};
      plugins.push({
        slug,
        name: (str(e.displayName) ?? str(pj.displayName) ?? slug).slice(0, 200),
        description: (str(e.description) ?? str(pj.description) ?? "").slice(0, 2000),
        upstreamVersion: str(pj.version) ?? str(e.version),
        connectors: connectorsOf(entries, dir, warnings),
        dir,
      });
      if (Array.isArray(e.skills)) {
        // The entry names its skill folders ("./skills/xlsx"), relative to the plugin's source.
        for (const rawPath of e.skills as unknown[]) {
          const sp = typeof rawPath === "string" ? rawPath.trim() : "";
          const rel = sp.replace(/^\.\//, "").replace(/\/+$/, "");
          const d = dir ? (rel ? `${dir}/${rel}` : dir) : rel;
          if (!sp.startsWith("./") || !rel || rel.split("/").some((s) => s === "" || s === "." || s === "..") || /[\\\u0000-\u001f]/.test(rel)) {
            rejected.push({ path: `.claude-plugin/marketplace.json#${slug}`, name: String(rawPath ?? ""), reasons: [`skill path ${JSON.stringify(rawPath)} must be a ./ path inside the plugin`] });
            continue;
          }
          if (!isFile(entries, `${d}/SKILL.md`)) {
            warnings.push({ path: d, message: `listed by plugin ${slug} but has no SKILL.md; not imported` });
            continue;
          }
          skills.push({ dir: d, name: lastSegment(d), collection: slug });
        }
      } else for (const d of skillsUnder(entries, dir)) skills.push({ dir: d, name: lastSegment(d), collection: slug });
    }
    // validate.py's bijection: folders under plugins/ without an entry are not imported.
    const onDisk = new Set([...entries.keys()].filter((p) => p.startsWith("plugins/") && p.split("/").length > 2).map((p) => p.split("/")[1]!));
    const listedDirs = new Set(plugins.map((p) => p.dir));
    for (const name of [...onDisk].sort()) if (!listedDirs.has(`plugins/${name}`)) warnings.push({ path: `plugins/${name}`, message: "has no entry in marketplace.json; not imported" });
    if (mp.renames && typeof mp.renames === "object" && !Array.isArray(mp.renames)) {
      for (const [old, to] of Object.entries(mp.renames as Record<string, unknown>)) {
        if (!NAME_RE.test(old)) continue;
        if (to === null) renames.set(old, null);
        else if (typeof to === "string" && listed.has(to)) renames.set(old, to);
      }
    }
    if (skills.length) return { layout: "marketplace", plugins, skills, renames, rejected, warnings };
    // Nothing importable from the marketplace: read the tree as a plugin or plain layout instead, keeping what was wrong.
    warnings.push({ path: ".claude-plugin/marketplace.json", message: "lists no skills that can be imported; looked for skills/<name>/SKILL.md folders instead" });
    for (const r of rejected.splice(0)) warnings.push({ path: r.path, message: r.reasons.join("; ") });
    renames.clear();
  }

  // 2. plugin
  const pj = readJson(entries, ".claude-plugin/plugin.json", warnings);
  if (pj && skillsUnder(entries, "").length) {
    const slug = str(pj.name) && NAME_RE.test(str(pj.name)!) ? str(pj.name)! : fallback;
    const plugin: PluginInfo = {
      slug,
      name: (str(pj.displayName) ?? slug).slice(0, 200),
      description: (str(pj.description) ?? "").slice(0, 2000),
      upstreamVersion: str(pj.version),
      connectors: connectorsOf(entries, "", warnings),
      dir: "",
    };
    return { layout: "plugin", plugins: [plugin], skills: skillsUnder(entries, "").map((d) => ({ dir: d, name: lastSegment(d), collection: slug })), renames, rejected, warnings };
  }

  // 3. plain: …/skills/<name>/SKILL.md
  const plain: SkillDirRef[] = [];
  const plugins = new Map<string, PluginInfo>();
  for (const p of [...entries.keys()].sort()) {
    const parts = p.split("/");
    if (parts.length < 3 || parts.length > 7 || parts[parts.length - 1] !== "SKILL.md" || parts[parts.length - 3] !== "skills" || !isFile(entries, p)) continue;
    const dir = parts.slice(0, -1).join("/");
    let parent = parts.slice(0, -3);
    if (parent[parent.length - 1] === ".claude") parent = parent.slice(0, -1);
    const slug = parent.length ? slugify(parent[parent.length - 1]!) : fallback;
    if (!plugins.has(slug)) plugins.set(slug, { slug, name: parent.length ? parent[parent.length - 1]! : slug, description: "", upstreamVersion: null, connectors: parent.length ? connectorsOf(entries, parent.join("/"), warnings) : [], dir: parent.join("/") });
    plain.push({ dir, name: parts[parts.length - 2]!, collection: slug });
  }
  if (plain.length) return { layout: "plain", plugins: [...plugins.values()], skills: plain, renames, rejected, warnings };

  // 4. folder: <name>/SKILL.md at the root
  const folders = [...entries.keys()].filter((p) => /^[^/]+\/SKILL\.md$/.test(p) && isFile(entries, p)).map((p) => p.split("/")[0]!).sort();
  const own: PluginInfo = { slug: fallback, name: opts.collection?.trim() || fallback, description: "", upstreamVersion: null, connectors: [], dir: "" };
  if (folders.length && !entries.has("SKILL.md")) {
    return { layout: "folder", plugins: [own], skills: folders.map((d) => ({ dir: d, name: skillNameOf(d), collection: fallback })), renames, rejected, warnings };
  }

  // 5. single: SKILL.md at the root
  if (entries.has("SKILL.md")) {
    const fromFile = opts.filename ? skillNameOf(opts.filename) : null;
    const name = opts.repoName ?? (opts.topName ? skillNameOf(opts.topName) : null) ?? fromFile ?? "skill";
    return { layout: "single", plugins: [own], skills: [{ dir: "", name, collection: fallback }], renames, rejected, warnings };
  }

  // 6. nested: <…>/<name>/SKILL.md deeper down (a folder zipped inside another folder)
  const deep = [...entries.keys()]
    .filter((p) => {
      const parts = p.split("/");
      return parts.length >= 3 && parts.length <= 7 && parts[parts.length - 1] === "SKILL.md" && isFile(entries, p) && !skipDeep(parts.slice(0, -1));
    })
    .map((p) => p.slice(0, p.lastIndexOf("/")))
    .sort();
  if (deep.length) {
    for (const d of deep) warnings.push({ path: d, message: "found inside another folder; imported as its own skill" });
    return { layout: "folder", plugins: [own], skills: deep.map((d) => ({ dir: d, name: skillNameOf(lastSegment(d)), collection: fallback })), renames, rejected, warnings };
  }

  // A skill file with the wrong capitals is the commonest near miss: say so instead of "no skills".
  for (const p of [...entries.keys()].sort()) {
    if (lastSegment(p) !== "SKILL.md" && lastSegment(p).toLowerCase() === "skill.md" && isFile(entries, p)) {
      const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
      rejected.push({ path: p, name: skillNameOf(dir ? lastSegment(dir) : (opts.topName ?? opts.filename ?? "skill")), reasons: [`rename ${lastSegment(p)} to SKILL.md (in capitals): Claude only reads SKILL.md`] });
    }
  }
  return { layout: null, plugins: [], skills: [], renames, rejected, warnings };
}

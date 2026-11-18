import { isMap, isPair, isScalar, parseDocument, visit } from "yaml";
import { NAME_RE, pyLen, pyStrip } from "./types.js";

/**
 * SKILL.md frontmatter, checked like the claude-skills repo's ci/validate.py (validate_skill): the same keys, limits,
 * and messages. YAML is parsed as YAML 1.1 (PyYAML's SafeLoader) with duplicate keys refused.
 */

export const SKILL_KEYS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);
const MAX_NAME = 64;
const MAX_TEXT = 1024;
const DESC_WARN = 500;
export const PLUGIN_DESC_WARN = 6000;
const MAX_COMPAT = 500;
export const XML_TAG_RE = /<\s*\/?\s*[A-Za-z][^<>]*>/;

export type Meta = Record<string, unknown>;

/** Tags PyYAML's SafeLoader constructs; anything else (!!python/str, !custom) is an error there. */
const SAFE_TAGS = new Set(["str", "int", "float", "bool", "null", "map", "seq", "binary", "timestamp", "omap", "pairs", "set"].map((t) => `tag:yaml.org,2002:${t}`));
/** Stands in for a metadata mapping whose keys aren't all strings (validateSkillFrontmatter refuses it). */
const NON_STRING_KEYS: unknown = Object.freeze(["non-string keys"]);

/**
 * What PyYAML's SafeLoader (with validate.py's duplicate-key check) refuses but the yaml library would accept:
 * merge keys, tags it doesn't construct, and a tab used as a separator after ':' or '-'. Null when fine.
 */
function pyYamlRefuses(block: string, doc: ReturnType<typeof parseDocument>): string | null {
  for (const line of block.split("\n")) {
    const head = line.split(/['"#]/, 1)[0]!;
    if (/:\t|^\s*-\t/.test(head)) return "found character '\\t' that cannot start any token";
  }
  let refused: string | null = null;
  visit(doc, (_key, node) => {
    if (refused) return visit.BREAK;
    if (isPair(node) && isScalar(node.key) && node.key.value === "<<" && node.key.type === "PLAIN") {
      refused = "merge keys ('<<') aren't supported";
      return visit.BREAK;
    }
    const tag = (node as { tag?: string }).tag;
    if (tag && !SAFE_TAGS.has(tag)) {
      refused = `could not determine a constructor for the tag '${tag}'`;
      return visit.BREAK;
    }
    return undefined;
  });
  return refused;
}

/** [mapping, null] or [null, error]. Fence: line 1 is '---' and the next line that is exactly '---' closes it. */
export function parseFrontmatter(text: string): [Meta, null] | [null, string] {
  const lines = text.split("\n");
  if (!lines.length || lines[0]!.replace(/\r$/, "") !== "---") return [null, "must start with a '---' frontmatter fence on line 1"];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.replace(/\r$/, "") === "---") {
      const block = lines.slice(1, i).join("\n");
      let meta: unknown;
      try {
        const doc = parseDocument(block, { version: "1.1", uniqueKeys: true, prettyErrors: false, merge: false });
        const problem = doc.errors[0]?.message ?? doc.warnings[0]?.message ?? pyYamlRefuses(block, doc);
        if (problem) return [null, `frontmatter is not valid YAML: ${String(problem).split("\n")[0]}`];
        meta = doc.toJS();
        // Python keeps 1:, yes: and null: keys as int, bool and None (validate.py wants string keys under metadata).
        const md = doc.get("metadata", true);
        if (isMap(md) && meta && typeof meta === "object" && !md.items.every((p) => isScalar(p.key) && typeof p.key.value === "string")) {
          (meta as Meta).metadata = NON_STRING_KEYS;
        }
      } catch (err) {
        return [null, `frontmatter is not valid YAML: ${String((err as Error).message).split("\n")[0]}`];
      }
      if (!meta || typeof meta !== "object" || Array.isArray(meta) || meta instanceof Map) return [null, "frontmatter must be a YAML mapping"];
      return [meta as Meta, null];
    }
  }
  return [null, "frontmatter fence is never closed with '---'"];
}

function strField(meta: Meta, key: string, where: string, errors: string[], opts: { required?: boolean; max?: number } = {}): string | null {
  const val = meta[key];
  if (val === undefined || val === null) {
    if (opts.required) errors.push(`${where}: '${key}' is required`);
    return null;
  }
  if (typeof val !== "string" || !pyStrip(val)) {
    errors.push(`${where}: '${key}' must be a non-empty string`);
    return null;
  }
  if (opts.max && pyLen(val) > opts.max) errors.push(`${where}: '${key}' is ${pyLen(val)} chars, limit ${opts.max}`);
  return val;
}

export interface FrontmatterCheck {
  errors: string[];
  warnings: string[];
  name: string | null;
  description: string | null;
  allowedTools: string | null;
  upstreamVersion: string | null;
}

/** validate_skill's frontmatter rules for one SKILL.md; `where` prefixes the messages (e.g. "plugins/x/skills/y/SKILL.md"). */
export function validateSkillFrontmatter(meta: Meta, dirName: string, where = "SKILL.md"): FrontmatterCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const k of Object.keys(meta).filter((k) => !SKILL_KEYS.has(k)).sort()) {
    errors.push(`${where}: unknown frontmatter key '${k}'. The Agent Skills spec allows only ${JSON.stringify([...SKILL_KEYS].sort())}; put custom fields under 'metadata:'.`);
  }
  const name = strField(meta, "name", where, errors, { required: true, max: MAX_NAME });
  if (name !== null) {
    if (!NAME_RE.test(name)) errors.push(`${where}: name '${name}' must be lowercase letters/digits with single hyphens`);
    if (name !== dirName) errors.push(`${where}: name '${name}' must equal the directory name '${dirName}'`);
  }
  const description = strField(meta, "description", where, errors, { required: true, max: MAX_TEXT });
  if (description !== null) {
    if (XML_TAG_RE.test(description)) errors.push(`${where}: description must not contain XML/HTML tags`);
    const n = pyLen(pyStrip(description));
    if (n < 60) warnings.push(`${where}: description is short (${n} chars) — it is the only thing Claude sees when deciding to load the skill; include concrete trigger phrases`);
    if (n > DESC_WARN) warnings.push(`${where}: description is ${n} chars (aim for <= ${DESC_WARN}); keep the use case and key nouns here and move the rest into the SKILL.md body`);
  }
  strField(meta, "license", where, errors);
  strField(meta, "compatibility", where, errors, { max: MAX_COMPAT });
  const allowedTools = strField(meta, "allowed-tools", where, errors);
  const md = meta.metadata;
  let upstreamVersion: string | null = null;
  if (md !== undefined && md !== null) {
    if (typeof md !== "object" || Object.getPrototypeOf(md) !== Object.prototype || !Object.entries(md).every(([, v]) => typeof v === "string")) {
      errors.push(`${where}: 'metadata' must be a mapping of string keys to string values`);
    } else {
      const v = (md as Record<string, string>).version;
      if (typeof v === "string" && v.trim()) upstreamVersion = v.trim().slice(0, 40);
    }
  }
  return { errors, warnings, name, description, allowedTools, upstreamVersion };
}

/** The frontmatter as plain JSON (dates as strings), for storing with a version. */
export function frontmatterJson(meta: Meta): Record<string, unknown> {
  return JSON.parse(JSON.stringify(meta, (_k, v) => (v instanceof Date ? v.toISOString() : v))) as Record<string, unknown>;
}

#!/usr/bin/env node
// Thaliyola design drift check for CI: reads the design tokens this repository's CSS defines (custom properties,
// light and dark) and the colours hard-coded in its source, and sends them to Thaliyola, which compares them with
// the project's recorded design system and keeps the report (Design page, get_project_context).
//
//   THALIYOLA_URL=https://thaliyola.example.com THALIYOLA_TOKEN=… node design-drift.mjs [--project <slug>] [--dir src] [--fail-on-drift]
//
// The project comes from --project, or from the git remote (the repository must be added to a project).
// No dependencies; reads files only. Exit codes: 0 ok, 1 drift found with --fail-on-drift, 2 error.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const URL_BASE = (process.env.THALIYOLA_URL || opt("url") || "").replace(/\/+$/, "");
const TOKEN = process.env.THALIYOLA_TOKEN || "";
const DIRS = (opt("dir") || "").split(",").filter(Boolean);
const FAIL = args.includes("--fail-on-drift");
if (!URL_BASE || !TOKEN) {
  console.error("Set THALIYOLA_URL and THALIYOLA_TOKEN.");
  process.exit(2);
}

const git = (...a) => {
  try {
    return execFileSync("git", a, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};
const root = git("rev-parse", "--show-toplevel") || process.cwd();
const sha = git("rev-parse", "HEAD");
const remote = git("remote", "get-url", "origin");

const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|\.next|\.nuxt|\.svelte-kit|storybook-static)(\/|$)|\.min\.|\.(test|spec|stories)\./;
const STYLE = new Set([".css", ".scss", ".sass", ".less", ".pcss"]);
const CODE = new Set([".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte", ".astro", ".html"]);
const files = [];
function walk(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const p = join(dir, n);
    const rel = relative(root, p).split("\\").join("/");
    if (SKIP.test(rel)) continue;
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p);
    else if ((STYLE.has(extname(n)) || CODE.has(extname(n))) && st.size < 1_000_000) files.push(p);
    if (files.length > 20_000) return;
  }
}
for (const d of DIRS.length ? DIRS : ["."]) walk(join(root, d));

const COLOR = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(.+\))$/i;
const SIZE = /^(-?\d*\.?\d+(px|rem|em|%|vw|vh|pt|ch)|0|clamp\(.+\)|calc\(.+\))$/i;
const tokens = { colors: new Map(), spacing: new Map(), radii: new Map(), shadows: new Map(), breakpoints: new Map(), fonts: new Map() };
const defined = new Set(); // file:line of token definitions, not counted as hard-coded
const hard = new Map(); // value|file -> {value, file, line, count}

/** Custom properties with the selector (or at-rule) they sit in, so dark-mode values are told apart. */
function readCss(text, file) {
  const stack = [];
  let buf = "";
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") line++;
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const skipped = text.slice(i, end < 0 ? text.length : end + 2);
      line += (skipped.match(/\n/g) || []).length;
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (ch === "{") {
      stack.push(buf.trim());
      buf = "";
    } else if (ch === "}") {
      stack.pop();
      buf = "";
    } else if (ch === ";") {
      const decl = buf.trim();
      const m = /^(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(decl);
      if (m) {
        const dark = stack.some((s) => /dark/i.test(s));
        record(m[1], m[2].trim().replace(/\s*!important$/, ""), dark);
        defined.add(`${file}:${startLine}`);
      }
      buf = "";
    } else {
      if (!buf.trim() && ch.trim()) startLine = line;
      buf += ch;
    }
  }
}
function record(name, value, dark) {
  const n = name.replace(/^--/, "").toLowerCase();
  let kind = null;
  if (COLOR.test(value)) kind = "colors";
  else if (/font|family/.test(n) && !SIZE.test(value)) kind = "fonts";
  else if (/shadow/.test(n)) kind = "shadows";
  else if (/radius|rounded/.test(n) && SIZE.test(value)) kind = "radii";
  else if (/(breakpoint|screen|bp-)/.test(n) && SIZE.test(value)) kind = "breakpoints";
  else if (/(space|spacing|gap|gutter)/.test(n) && SIZE.test(value)) kind = "spacing";
  if (!kind) return;
  if (kind === "fonts") {
    const role = /mono|code/.test(n) ? "mono" : /head|display|title/.test(n) ? "heading" : "body";
    if (!tokens.fonts.has(role)) tokens.fonts.set(role, { role, family: value.slice(0, 200) });
    return;
  }
  const cur = tokens[kind].get(n) || { name: n };
  if (dark) cur.dark = value;
  else cur.value = value;
  tokens[kind].set(n, cur);
}

const HEX = /(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const FUNC = /\b(?:rgba?|hsla?)\(\s*\d[^)]{2,40}\)/g;
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const rel = relative(root, f).split("\\").join("/");
  if (STYLE.has(extname(f))) readCss(text, rel);
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    if (defined.has(`${rel}:${i + 1}`) || /^\s*(\/\/|\*|\/\*)/.test(l) || /--[\w-]+\s*:/.test(l)) return;
    for (const m of [...l.matchAll(HEX), ...l.matchAll(FUNC)]) {
      const v = m[0].toLowerCase().replace(/\s+/g, "");
      const k = `${v}|${rel}`;
      const cur = hard.get(k);
      if (cur) cur.count++;
      else hard.set(k, { value: v, file: rel, line: i + 1, count: 1 });
    }
  });
}

const list = (m) => [...m.values()].filter((t) => t.value).slice(0, 500);
const body = {
  tokens: {
    colors: list(tokens.colors),
    spacing: list(tokens.spacing),
    radii: list(tokens.radii),
    shadows: list(tokens.shadows),
    breakpoints: list(tokens.breakpoints),
    fonts: [...tokens.fonts.values()],
  },
  hardcoded: [...hard.values()].sort((a, b) => b.count - a.count).slice(0, 1000),
  source: `${remote || root}${sha ? `@${sha.slice(0, 12)}` : ""}`,
  head_sha: sha || undefined,
};
// Kinds the CSS doesn't define aren't sent, so they aren't reported as missing.
for (const k of Object.keys(body.tokens)) if (!body.tokens[k].length) delete body.tokens[k];

let project = opt("project");
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": "thaliyola-design-drift" };
try {
  if (!project) {
    if (!remote) throw new Error("no git remote: pass --project <slug>");
    const r = await fetch(`${URL_BASE}/api/repos/resolve?url=${encodeURIComponent(remote)}`, { headers });
    const j = r.ok ? await r.json() : null;
    project = j?.match?.project;
    if (!project) throw new Error(`${remote} isn't added to a Thaliyola project: pass --project <slug>`);
  }
  const res = await fetch(`${URL_BASE}/api/scopes/${encodeURIComponent(project)}/design/drift`, { method: "POST", headers, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  const c = j.counts;
  console.log(
    j.in_sync
      ? `Design: ${project} matches its design system.`
      : `Design drift in ${project}: ${c.changed} changed, ${c.missing_in_code} recorded but not in the code, ${c.new_in_code} in the code but not recorded, ${c.hardcoded} hard-coded colours (${c.off_palette} off the palette).`,
  );
  for (const x of j.changed.slice(0, 20)) console.log(`  changed ${x.kind} ${x.name}${x.mode ? " (dark)" : ""}: recorded ${x.stored}, code ${x.code}`);
  for (const h of j.hardcoded.slice(0, 20)) console.log(`  ${h.file}:${h.line ?? "?"} ${h.value} → ${h.suggestion}`);
  process.exit(FAIL && !j.in_sync ? 1 : 0);
} catch (err) {
  console.error(`Design drift check failed: ${err.message}`);
  process.exit(2);
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CHANGELOG.md, read for release drafts. A section is a `## ` heading: "## 1.0.0 (2026-11-20)", "## [1.0.0]" or
 * "## Unreleased" (a pre-release heading such as "## 1.0.0-rc.1" is not 1.0.0's section). Its paragraphs before the
 * first bullet are the release's summary; each top-level bullet ("- ") with the lines indented under it is one feature.
 * Keep a Changelog subsections ("### Added", "### Changed", "### Fixed", …) set the kind of the bullets under them and
 * are left out of the summary.
 */

export type FeatureArea = "knowledge" | "review" | "security" | "inbox" | "projects" | "people" | "connections" | "skills" | "admin" | "mcp" | "platform";
export type FeatureKind = "new" | "improved" | "fixed";

export interface ChangelogSection {
  heading: string;
  /** The version in the heading, or null for "Unreleased". */
  version: string | null;
  /** The date in the heading ("(2026-11-20)"), if any. */
  date: string | null;
  summary: string;
  bullets: string[];
  /** For each bullet, the kind its Keep a Changelog subsection gives it ("### Fixed" → fixed), else null. */
  kinds: (FeatureKind | null)[];
}

export interface DraftFeature {
  title: string;
  description: string;
  area: FeatureArea;
  kind: FeatureKind;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Where CHANGELOG.md is: CHANGELOG_PATH, else next to the server's package.json (the Docker image and native installs
 * put it there), else the repository root (running from a checkout).
 */
export function changelogPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [env.CHANGELOG_PATH, path.resolve(HERE, "../../CHANGELOG.md"), path.resolve(HERE, "../../../../CHANGELOG.md")].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function readChangelog(file = changelogPath()): string | null {
  if (!file) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// A release version, not a pre-release or build ("1.0.0-rc.1", "1.0.0+exp"): nothing but "]", a space, a dash, a "("
// or the end may follow it.
const VERSION_HEADING = /^\[?v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?![-+.\w])\]?(?:\s*[-–—(]\s*(\d{4}-\d{2}-\d{2})\)?)?/i;

/** Keep a Changelog's subsections, as feature kinds. */
const SUBSECTION_KIND: Record<string, FeatureKind> = {
  added: "new",
  new: "new",
  changed: "improved",
  improved: "improved",
  deprecated: "improved",
  removed: "improved",
  fixed: "fixed",
  security: "fixed",
};

type Building = Omit<ChangelogSection, "bullets" | "kinds"> & { prose: string[]; items: { text: string; kind: FeatureKind | null }[] };

export function parseChangelog(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: Building | null = null;
  let bullet: string[] | null = null;
  let kind: FeatureKind | null = null;
  const flush = () => {
    if (current && bullet) current.items.push({ text: bullet.join("\n").trim(), kind });
    bullet = null;
  };
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      if (current) sections.push(finish(current));
      const heading = h[1]!;
      const m = VERSION_HEADING.exec(heading);
      current = { heading, version: m ? m[1]! : null, date: m?.[2] ?? null, summary: "", prose: [], items: [] };
      kind = null;
      continue;
    }
    if (!current) continue;
    if (/^#\s/.test(line)) continue;
    const sub = /^#{3,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (sub) {
      // "### Fixed": the bullets under it are fixes. Other subheadings keep no kind; none goes into the summary.
      flush();
      kind = SUBSECTION_KIND[sub[1]!.replace(/[^a-z]/gi, "").toLowerCase()] ?? null;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flush();
      bullet = [line.replace(/^[-*]\s+/, "")];
    } else if (bullet && /^\s+\S/.test(line)) {
      // Continuation: indented lines (sub-bullets, wrapped text).
      bullet.push(line.replace(/^ {2,4}/, ""));
    } else if (bullet && line.trim() === "") {
      // A blank line ends the bullet, unless the next text is indented under it (a second paragraph).
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      if (next !== undefined && /^\s+\S/.test(next)) bullet.push("");
      else flush();
    } else if (!current.items.length && !bullet) {
      current.prose.push(line);
    } else {
      flush();
    }
  }
  flush();
  if (current) sections.push(finish(current));
  return sections;
}

function finish(s: Building): ChangelogSection {
  const { prose, items, ...rest } = s;
  const kept = items.filter((b) => b.text);
  return { ...rest, summary: prose.join("\n").trim(), bullets: kept.map((b) => b.text), kinds: kept.map((b) => b.kind) };
}

/** The section for a version: its own ("## 1.0.0 …"), else "## Unreleased". Null when neither is there. */
export function sectionFor(sections: ChangelogSection[], version: string): ChangelogSection | null {
  return sections.find((s) => s.version === version) ?? sections.find((s) => /^\[?unreleased\]?$/i.test(s.heading.trim())) ?? null;
}

/**
 * Areas with the words that point a bullet at each. A bullet's lead (its bold start, or what comes before its first
 * colon, or its first sentence) is matched first, in this order (first match wins); only when the lead names no area
 * does the area the bullet mentions first count, with Claude/MCP last, since most bullets mention a tool somewhere.
 */
const AREA_WORDS: [FeatureArea, RegExp][] = [
  ["skills", /\bskills?\b/i],
  ["connections", /\bconnections?\b|\bjira\b|\blinear\b|\btrello\b(?!.*recipe)/i],
  ["mcp", /\bmcp\b|\bclaude\b/i],
  ["security", /\bsecurity\b|\bvulnerabilit|\badvisor|\bcve\b|\bosv\b|\bkev\b/i],
  ["inbox", /\binbox\b|\bsources?\b|\bfeeds?\b|\bslack thread|\bnotion\b/i],
  ["review", /\breview\b|\bproposals?\b|\bapprov/i],
  ["people", /\bdisplay names?\b|\broles?\b|\bpeople\b|\baccess\b|\btokens?\b|\bservice accounts?\b|\binvitation|\bsign[- ]in\b/i],
  ["admin", /\badmin\b|\baudit\b|\bsystem settings\b|\bpresets?\b/i],
  ["projects", /\bprojects?\b|\bteams?\b|\brepositor/i],
  ["platform", /\breplicas?\b|\bdeploy|\bshutdown\b|\bmigrations?\b|\bdocker\b|\bkubernetes\b|\bhealthz\b|\bversions?\b/i],
  ["knowledge", /\barticles?\b|\bfindings?\b|\bsearch\b|\bgraph\b|\beditor\b|\bexport\b|\bimport\b/i],
];

/** A bullet's lead: its bold start ("**Audit log.** …"), else what comes before its first colon, else its first sentence. */
export function bulletLead(bullet: string): string {
  const first = bullet.split("\n")[0]!.trim();
  const bold = /^\*\*(.+?)\*\*/.exec(first);
  if (bold) return bold[1]!;
  const colon = /^([^:]{2,90}):\s/.exec(first);
  if (colon) return colon[1]!;
  return /^(.+?[.!?])(\s|$)/.exec(first)?.[1] ?? first;
}

export function guessArea(text: string): FeatureArea {
  const lead = bulletLead(text);
  const inLead = AREA_WORDS.find(([, re]) => re.test(lead))?.[0];
  if (inLead) return inLead;
  // Otherwise the area the bullet mentions first; Claude/MCP only when it names nothing else.
  let best: { area: FeatureArea; at: number } | null = null;
  for (const [area, re] of AREA_WORDS) {
    if (area === "mcp") continue;
    const at = text.search(re);
    if (at >= 0 && (!best || at < best.at)) best = { area, at };
  }
  return best?.area ?? (AREA_WORDS.find(([a]) => a === "mcp")![1].test(text) ? "mcp" : "knowledge");
}

export function guessKind(text: string): FeatureKind {
  const t = text.trim();
  if (/^(fix(ed|es)?\b|\*\*fix)/i.test(t) || /^[^:]{0,40}\bfix(ed)?:/i.test(t)) return "fixed";
  // "Before, the refusal named the project": the bullet describes what used to go wrong.
  if (/(^|[.:;]\s+)(before|previously|until now),\s/i.test(t) || /\bused to\b/i.test(t)) return "fixed";
  if (/^(better|faster|improv|clearer|now\b|more\b)/i.test(t) || /\bnow\b.{0,30}\b(also|too)\b/i.test(t)) return "improved";
  return "new";
}

/** Bullets about how Thaliyola is built, not what people use: "Tests: …", "Kit: …", "CI: …". */
export function isInternalBullet(bullet: string): boolean {
  return /^(\*\*)?(tests?|kit|ci|chore|refactor|build|deps|dependencies)(\*\*)?\s*[:.]/i.test(bullet.trim());
}

const strip = (s: string) =>
  s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** A short title for a bullet: its bold lead ("**Audit log.** …"), else what comes before the first colon, else its first words. */
export function bulletTitle(bullet: string): string {
  const first = bullet.split("\n")[0]!;
  const bold = /^\*\*(.+?)\*\*/.exec(first);
  const colon = /^([^:]{2,90}):\s+(.*)$/.exec(first);
  // "Fix: the queue lost its filters" names the change after the colon; "Audit log: export as JSON" before it.
  const generic = colon && /^(fix(es|ed)?|tests?|kit|docs?|ci|chore|mcp|ui|web|api)$/i.test(colon[1]!.trim());
  let t = bold ? bold[1]! : colon ? (generic ? colon[2]!.split(/[;.](\s|$)/)[0]! : colon[1]!) : first;
  t = strip(t).replace(/[.:;,\s]+$/, "");
  if (t.length > 90) t = `${t.slice(0, 87).replace(/\s+\S*$/, "")}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** One draft feature per user-facing bullet; a Keep a Changelog subsection ("### Fixed") decides its kind. */
export function draftFeatures(section: ChangelogSection): DraftFeature[] {
  return section.bullets.flatMap((b, i) =>
    isInternalBullet(b) ? [] : [{ title: bulletTitle(b), description: b, area: guessArea(b), kind: section.kinds[i] ?? guessKind(b) }],
  );
}

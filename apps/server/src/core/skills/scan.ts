import { findSecrets } from "../redaction.js";
import { MARKER_RE } from "./stamp.js";
import { sha256, textOf, type SkillFlag } from "./types.js";

/**
 * What a skill's files hold that a reviewer must see, or that keeps it out altogether. Skill content is stored
 * byte-exact (scripts and stamping parity), so nothing is redacted in place: secrets reject the skill, and everything
 * a reviewer should look at becomes a flag with file:line. High-risk flags need an explicit "I checked the flagged
 * lines" to approve, and stop a publish-directly source from skipping review.
 */

/** ci/validate.py's SECRET_PATTERNS, verbatim, run on the raw bytes (latin1 view, no word boundaries). */
export const VALIDATE_SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/, "Anthropic API key"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/xox[bpa]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{20,}/, "GitHub fine-grained token"],
  [/glpat-[A-Za-z0-9_-]{10,}/, "GitLab token"],
  [/postgres(?:ql)?:\/\/[^:\s/]+:[^@\s]+@/, "database URL with password"],
];
export const SECRET_FILENAMES = /^(\.env(\..+)?|.*\.pem|.*\.p12|id_rsa.*|.*\.key)$/;

/** Redaction kinds that reject a skill outright (token-shaped). */
const REJECT_KINDS = new Set(["private_key", "aws_key", "github_token", "gitlab_token", "slack_token", "api_key", "jwt"]);
const KIND_LABEL: Record<string, string> = {
  private_key: "a private key",
  aws_key: "an AWS access key",
  github_token: "a GitHub token",
  gitlab_token: "a GitLab token",
  slack_token: "a Slack token",
  api_key: "an API key",
  jwt: "a signed token (JWT)",
  credentials: "a URL with a user name and password",
};
/** A URL password that is obviously a placeholder (user:pass@, user:<password>@, ${PASSWORD}…). */
const PLACEHOLDER = /^(?:pass|password|passwd|pwd|secret|changeme|x{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|\{\{[^}]*\}\}|\.\.\.|…)$/i;

const SCRIPT_EXT = new Set([".py", ".sh", ".bash", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd", ".php"]);
const TOOL_ID_RE = /\bmcp__[A-Za-z0-9][A-Za-z0-9_.-]*__[A-Za-z0-9][A-Za-z0-9_-]*/;
const TOOL_ID_SUFFIXES = [".md", ".py", ".html", ".js", ".json", ".txt", ".yaml", ".yml"];
const PIP_INSTALL_RE = /\bpip3?\s+install\b/;

/**
 * Thaliyola's tools that change access, settings or content for others: a skill that names one gets a high-risk flag
 * (a skill is instructions Claude follows; it must never be how access changes). A test keeps this list in step with
 * the MCP registry (every name here is a registered tool without readOnlyHint).
 */
export const ADMIN_TOOLS = [
  "set_user_roles",
  "set_project_access",
  "set_team_membership",
  "add_person",
  "decide_access_request",
  "set_account_status",
  "save_role",
  "delete_role",
  "save_team",
  "delete_team",
  "set_project_visibility",
  "set_project_parent",
  "share_to_library",
  "move_entry",
  "publish_advisory",
  "decide_project_request",
  "assign_skill",
  "unassign_skill",
];
const ADMIN_RE = new RegExp(`\\b(${ADMIN_TOOLS.join("|")})\\b|/api/admin\\b`);

const ext = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i).toLowerCase() : "";
};
const lineOf = (text: string, index: number) => {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};
const cp = (c: number) => `U+${c.toString(16).toUpperCase().padStart(4, "0")}`;

export interface ScanFile {
  path: string;
  data: Uint8Array;
  managed?: boolean;
}

export interface ScanResult {
  rejects: string[];
  flags: SkillFlag[];
  hasScripts: boolean;
  scripts: Set<string>;
  binaries: Set<string>;
}

export function isScriptPath(path: string, data: Uint8Array): boolean {
  if (path.split("/").slice(0, -1).includes("scripts")) return true;
  if (SCRIPT_EXT.has(ext(path))) return true;
  return data[0] === 0x23 && data[1] === 0x21; // "#!"
}

function hostsIn(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(/\bhttps?:\/\/([A-Za-z0-9.-]+)(?::\d+)?/g)) {
    const host = m[1]!.toLowerCase().replace(/\.$/, "");
    if (!out.has(host)) out.set(host, lineOf(text, m.index ?? 0));
  }
  return out;
}

/** Invisible characters a reviewer can't see in rendered (or even plain) text. */
function hiddenChars(path: string, text: string, flags: SkillFlag[], rejects: string[]) {
  const seen = new Set<string>();
  const chars = [...text];
  let offset = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    const c = ch.codePointAt(0)!;
    const at = offset;
    offset += ch.length;
    if (c < 0x80) continue;
    if (c >= 0xe0000 && c <= 0xe007f) {
      rejects.push(`${path}:${lineOf(text, at)}: contains Unicode tag characters (${cp(c)}), which hide text from readers`);
      return;
    }
    let what: string | null = null;
    const prev = chars[i - 1]?.codePointAt(0) ?? 0;
    const next = chars[i + 1]?.codePointAt(0) ?? 0;
    const pictographic = (x: number) => /\p{Extended_Pictographic}/u.test(String.fromCodePoint(x));
    if (c === 0xfeff && at === 0) continue; // a leading BOM
    if (c === 0x200d && (pictographic(prev) || pictographic(next))) continue; // emoji sequences
    if ((c >= 0x200b && c <= 0x200f) || (c >= 0x2060 && c <= 0x2064) || c === 0xfeff) what = "a zero-width character";
    else if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) what = "a bidirectional control";
    else if (c >= 0xfe00 && c <= 0xfe0f) continue; // variation selectors (emoji presentation)
    else if ([0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x3164, 0xffa0].includes(c) || (c >= 0x180b && c <= 0x180f) || (c >= 0x1bca0 && c <= 0x1bca3) || (c >= 0x1d173 && c <= 0x1d17a))
      what = "an invisible character";
    else if ((c >= 0xe000 && c <= 0xf8ff) || c >= 0xf0000) what = "a private-use character";
    if (!what) continue;
    const line = lineOf(text, at);
    const key = `${line}:${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push({ kind: "hidden_text", path, line, message: `${what} (${cp(c)})`, high_risk: true });
  }
}

/** HTML comments in Markdown outside code fences and spans (core:* markers and managed headers are normal). */
function htmlComments(path: string, text: string, flags: SkillFlag[]) {
  const lines = text.split("\n");
  let fence: string | null = null;
  let inComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const bare = line.replace(/`[^`]*`/g, "").replace(new RegExp(MARKER_RE.source, "g"), "").replace(/<!-- managed by ci\/sync_core\.py[^>]*-->/g, "");
    if (inComment) {
      if (bare.includes("-->")) inComment = false;
      continue;
    }
    const at = bare.indexOf("<!--");
    if (at >= 0) {
      flags.push({ kind: "hidden_text", path, line: i + 1, message: "an HTML comment (hidden when the Markdown is rendered)", high_risk: true });
      if (!bare.slice(at).includes("-->")) inComment = true;
    }
  }
}

/**
 * Scans a skill's files. `base` is the published version's files (path → sha256, plus its hosts), so flags that only
 * matter when something changed (scripts, new hosts) are high-risk only then.
 */
export function scanSkillFiles(files: ScanFile[], base?: { shas: Map<string, string>; hosts: Set<string>; allowedTools: string | null } | null, allowedTools?: string | null): ScanResult {
  const rejects: string[] = [];
  const flags: SkillFlag[] = [];
  const scripts = new Set<string>();
  const binaries = new Set<string>();
  const hosts = new Map<string, { path: string; line: number }>();
  for (const f of files) {
    const base_ = f.path.slice(f.path.lastIndexOf("/") + 1);
    if (SECRET_FILENAMES.test(base_)) rejects.push(`${f.path}: credential-looking filename; never ship secrets in a skill`);
    const latin1 = Buffer.from(f.data).toString("latin1");
    for (const [re, label] of VALIDATE_SECRET_PATTERNS) {
      const m = re.exec(latin1);
      if (m) {
        rejects.push(`${f.path}:${lineOf(latin1, m.index)}: contains what looks like a ${label}`);
        break;
      }
    }
    const script = isScriptPath(f.path, f.data);
    if (script) {
      scripts.add(f.path);
      const changed = !base || base.shas.get(f.path) !== sha256(f.data);
      flags.push({ kind: "scripts", path: f.path, message: changed ? (base?.shas.has(f.path) ? "a script that changed" : "a new script") : "a script", high_risk: changed });
    }
    const text = textOf(f.data);
    if (text === null) {
      binaries.add(f.path);
      flags.push({ kind: "binary", path: f.path, message: "a binary file", high_risk: false });
      continue;
    }
    // Redaction rules: token-shaped secrets reject; fuzzy ones and personal data are flagged for the reviewer.
    const seenLines = new Set<string>();
    for (const hit of findSecrets(text)) {
      const key = `${hit.kind}:${hit.line}`;
      if (seenLines.has(key)) continue;
      seenLines.add(key);
      if (REJECT_KINDS.has(hit.kind)) rejects.push(`${f.path}:${hit.line}: contains what looks like ${KIND_LABEL[hit.kind]}`);
      else if (hit.kind === "credentials") {
        const pw = /:\/\/[^\s:/@]+:([^\s@/]+)@/.exec(hit.match)?.[1] ?? "";
        if (PLACEHOLDER.test(pw)) flags.push({ kind: "possible_secret", path: f.path, line: hit.line, message: "a URL with a placeholder password", high_risk: false });
        else rejects.push(`${f.path}:${hit.line}: contains ${KIND_LABEL.credentials}`);
      } else if (hit.kind === "secret" || hit.kind === "bearer_token") flags.push({ kind: "possible_secret", path: f.path, line: hit.line, message: "something that may be a secret value", high_risk: false });
      else if (hit.kind === "email" || hit.kind === "phone") flags.push({ kind: "personal_data", path: f.path, line: hit.line, message: hit.kind === "email" ? "an email address" : "a phone number", high_risk: false });
    }
    hiddenChars(f.path, text, flags, rejects);
    const e = ext(f.path);
    // Every file, stamped copies included: "managed" only ever means the importer itself wrote it from core/files.
    if (e === ".md") htmlComments(f.path, text, flags);
    if (e === ".html" || e === ".htm") flags.push({ kind: "html", path: f.path, message: "an HTML file", high_risk: false });
    if (e === ".py" && PIP_INSTALL_RE.test(text)) flags.push({ kind: "pip_install", path: f.path, line: lineOf(text, text.search(PIP_INSTALL_RE)), message: "'pip install' fails in the claude.ai code-execution sandbox", high_risk: false });
    if (!f.managed && TOOL_ID_SUFFIXES.includes(e)) {
      const m = TOOL_ID_RE.exec(text);
      if (m) flags.push({ kind: "tool_id", path: f.path, line: lineOf(text, m.index), message: `hardcoded MCP tool id '${m[0]}' (tool ids differ between claude.ai, Claude Code and Desktop)`, high_risk: false });
    }
    const a = ADMIN_RE.exec(text);
    if (a) flags.push({ kind: "admin_tools", path: f.path, line: lineOf(text, a.index), message: `names Thaliyola's '${a[0]}', which changes access, settings or content for others`, high_risk: true });
    for (const [host, line] of hostsIn(text)) if (!hosts.has(host)) hosts.set(host, { path: f.path, line });
  }
  for (const [host, at] of [...hosts].sort(([a], [b]) => a.localeCompare(b))) {
    const isNew = !!base && !base.hosts.has(host);
    flags.push({ kind: "external_url", path: at.path, line: at.line, message: isNew ? `links to ${host} (new in this version)` : `links to ${host}`, high_risk: isNew });
  }
  if (allowedTools) {
    const changed = !base || base.allowedTools !== allowedTools;
    flags.push({ kind: "allowed_tools", path: "SKILL.md", message: `pre-approves tools in Claude Code: ${allowedTools.slice(0, 300)}`, high_risk: changed });
  }
  return { rejects, flags, hasScripts: scripts.size > 0, scripts, binaries };
}

/** Hosts linked from a set of files (for the next version's "new host" check). */
export function hostsOf(files: ScanFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    const text = textOf(f.data);
    if (text) for (const h of hostsIn(text).keys()) out.add(h);
  }
  return out;
}

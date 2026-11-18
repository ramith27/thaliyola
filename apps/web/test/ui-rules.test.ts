import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SPEC §7.3 ui-rules: one describe block per package, each scanning only that package's files (ownership: §4.1).
 * During the parallel phase other areas' blocks may fail; run yours with `vitest run test/ui-rules.test.ts -t <id>`.
 */

const SRC = new URL("../src/", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, SRC), "utf8");
const exists = (rel: string) => existsSync(new URL(rel, SRC));
const kitFiles = () => (exists("components/kit/") ? readdirSync(new URL("components/kit/", SRC)).filter((f) => /\.tsx?$/.test(f)).map((f) => `components/kit/${f}`) : []);

interface Pkg {
  id: string;
  code: () => string[];
  css: string[];
}

const PACKAGES: Pkg[] = [
  {
    id: "foundation",
    code: () => [
      "App.tsx", "main.tsx", "viewer/main.tsx", "theme.ts", "hooks.ts",
      ...["Layout.tsx", "find.tsx", "notifications.tsx", "ui.tsx", "icons.tsx", "charts.tsx", "more.tsx", "people.tsx", "tree.ts", "mermaid.tsx",
        "labels.ts", "nav.ts", "permissions.ts", "boot.tsx", "handoff.ts", "saved-views.tsx"].map((f) => `components/${f}`),
      ...kitFiles(),
    ],
    css: ["index", "tokens", "base", "layout", "components", "utilities", "viewer"].map((f) => `styles/${f}.css`),
  },
  { id: "home", code: () => ["pages/dashboard.tsx", "components/checklist.tsx"], css: ["styles/pages/home.css"] },
  { id: "browse", code: () => ["pages/browse.tsx", "pages/entity.tsx", "pages/graph.tsx"], css: ["styles/pages/browse.css", "styles/pages/graph.css"] },
  {
    id: "items",
    code: () => ["pages/items.tsx", "pages/history.tsx", ...["editor", "claims", "assets", "actions", "move", "guide", "tickets"].map((f) => `components/${f}.tsx`)],
    css: ["styles/pages/items.css"],
  },
  { id: "review", code: () => ["pages/review.tsx"], css: ["styles/pages/review.css"] },
  { id: "security", code: () => ["pages/security.tsx"], css: ["styles/pages/security.css"] },
  { id: "inbox", code: () => ["pages/sources.tsx", "pages/paste.tsx"], css: ["styles/pages/inbox.css"] },
  { id: "projects", code: () => ["pages/settings.tsx", "pages/projects.tsx", "pages/setup.tsx"], css: ["styles/pages/projects.css"] },
  { id: "connections", code: () => ["pages/connections.tsx", "pages/data.tsx", "pages/notification-routes.tsx"], css: ["styles/pages/connections.css"] },
  {
    id: "people",
    code: () => ["pages/account.tsx", "pages/teams.tsx", "pages/system.tsx", "pages/invite.tsx", "pages/audit.tsx", "components/roles.tsx", "components/tokens.tsx"],
    css: ["styles/pages/people.css"],
  },
  { id: "tools", code: () => ["pages/metrics.tsx", "pages/connect.tsx", "pages/trash.tsx", "components/hosts.tsx"], css: ["styles/pages/tools.css"] },
  { id: "skills", code: () => ["pages/skills.tsx", "pages/skill-detail.tsx", "components/skill-utils.ts"], css: ["styles/pages/skills.css"] },
];

/** The only places a full reload is allowed: Cloudflare "Sign in again" (App) and Sign out (Layout). */
const RELOAD_ALLOWED = new Set(["App.tsx", "components/Layout.tsx"]);
/** The only CSS file with raw colours. */
const COLOUR_ALLOWED = new Set(["styles/tokens.css"]);
/** The only CSS file with !important. */
const IMPORTANT_ALLOWED = new Set(["styles/utilities.css"]);

/** Code without comments, so prose like "instead of window.confirm" doesn't count. */
const keepLines = (m: string) => m.replace(/[^\n]/g, "");
const stripCode = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, keepLines).replace(/^[ \t]*\/\/.*$/gm, "").replace(/[ \t]\/\/ .*$/gm, "");
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, keepLines);

/** Line numbers of every match, for readable failures. */
function hits(text: string, re: RegExp): number[] {
  const out: number[] = [];
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (let m = g.exec(text); m; m = g.exec(text)) {
    out.push(text.slice(0, m.index).split("\n").length);
    if (m[0] === "") g.lastIndex++;
  }
  return out;
}

function codeProblems(file: string): string[] {
  const src = stripCode(read(file));
  const problems: string[] = [];
  for (const line of hits(src, /\bwindow\.(confirm|alert|prompt)\s*\(/)) problems.push(`${file}:${line} window.confirm/alert/prompt`);
  // Bare confirm(/alert(/prompt( calls, unless the file defines that name itself (e.g. `const confirm = useConfirm()`).
  for (const name of ["confirm", "alert", "prompt"]) {
    const defined = new RegExp(`(?:const|let|var|function)\\s+${name}\\b|[{,]\\s*${name}\\s*[,}]`).test(src);
    if (defined) continue;
    for (const line of hits(src, new RegExp(`(?<![\\w.$])${name}\\s*\\(`))) problems.push(`${file}:${line} bare ${name}(`);
  }
  if (!RELOAD_ALLOWED.has(file)) for (const line of hits(src, /location\.reload\s*\(/)) problems.push(`${file}:${line} location.reload`);
  if (file.endsWith(".tsx")) for (const line of hits(src, /Loading…|Loading\.\.\./)) problems.push(`${file}:${line} literal "Loading…"`);
  return problems;
}

function cssProblems(file: string): string[] {
  const src = stripCss(read(file));
  const problems: string[] = [];
  if (!COLOUR_ALLOWED.has(file)) {
    for (const line of hits(src, /#[0-9a-fA-F]{3,8}\b(?![\w-]*\s*\{)/)) problems.push(`${file}:${line} hex colour`);
    for (const line of hits(src, /\b(?:rgba?|hsla?)\(/)) problems.push(`${file}:${line} rgb()/hsl() colour`);
  }
  for (const line of hits(src, /font-size\s*:(?!\s*(?:var\(--fs-[\w-]+\)|inherit)\s*(?:;|\}|$))/m)) problems.push(`${file}:${line} font-size not var(--fs-*)`);
  for (const line of hits(src, /z-index\s*:(?!\s*var\(--z-[\w-]+\)\s*(?:;|\}|$))/m)) problems.push(`${file}:${line} z-index not var(--z-*)`);
  if (!IMPORTANT_ALLOWED.has(file)) for (const line of hits(src, /!important/)) problems.push(`${file}:${line} !important`);
  return problems;
}

for (const pkg of PACKAGES) {
  describe(pkg.id, () => {
    it("uses no window dialogs, reloads or Loading… text", () => {
      const files = pkg.code().filter(exists);
      expect(files.length).toBeGreaterThan(0);
      expect(files.flatMap(codeProblems)).toEqual([]);
    });

    it("uses tokens only in its CSS", () => {
      const files = pkg.css.filter(exists);
      expect(files.length).toBeGreaterThan(0);
      expect(files.flatMap(cssProblems)).toEqual([]);
    });
  });
}

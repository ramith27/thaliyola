import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** SPEC §3.1 and §3.4: legacy token names stay, the two dark blocks match, and the verified pairs keep their contrast. */
const css = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first `{ … }` after `selector` (one level deep; token blocks have no nesting). */
function block(selector: string, from = 0): string {
  const at = css.indexOf(selector, from);
  if (at < 0) throw new Error(`missing block ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function decls(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(";")) {
    const m = /^\s*(--[\w-]+|color-scheme)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m) out.set(m[1]!, m[2]!.replace(/\s+/g, " "));
  }
  return out;
}

const light = decls(block(":root {"));
const mediaAt = css.indexOf("@media (prefers-color-scheme: dark)");
const darkMedia = decls(block(':root:not([data-theme="light"])', mediaAt));
const darkAttr = decls(block(':root[data-theme="dark"]'));
const dark = new Map([...light, ...darkMedia]);

const LEGACY = [
  "--bg", "--surface", "--surface-2", "--surface-3", "--text", "--text-2", "--muted", "--border", "--border-strong",
  "--accent", "--accent-hover", "--accent-soft", "--accent-text", "--ring", "--warn", "--warn-soft", "--danger", "--danger-soft",
  "--ok", "--ok-soft", "--mark", "--code", "--shadow-sm", "--shadow", "--shadow-lg", "--radius", "--radius-sm", "--font", "--mono",
  "--sidebar-w", "--series-1", "--series-2", "--series-3", "--status-good", "--status-warning", "--sev-critical", "--sev-high",
  "--sev-medium", "--sev-low", "--neutral-mark", "--grid", "--axis", "--tick", "--spark",
];

function resolve(theme: Map<string, string>, name: string, depth = 0): string {
  const v = theme.get(name);
  if (v === undefined) throw new Error(`token ${name} is not defined`);
  const ref = /^var\((--[\w-]+)\)$/.exec(v);
  if (ref && depth < 10) return resolve(theme, ref[1]!, depth + 1);
  return v;
}

function rgb(value: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(value);
  if (!m) throw new Error(`not a solid hex colour: ${value}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: [number, number, number]) {
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: string, b: string) {
  const [l1, l2] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

const SURFACES = ["--bg", "--bg-sidebar", "--surface", "--surface-raised", "--surface-2", "--surface-3"];
const WHITE = "#ffffff";

/** [foreground, backgrounds, minimum]. Literal hex values are allowed for white initials. */
const PAIRS: [string, string[], number][] = [
  ["--text", [...SURFACES, "--surface-pressed"], 4.5],
  ["--text-2", [...SURFACES, "--surface-pressed"], 4.5],
  ["--muted", [...SURFACES, "--surface-pressed", "--accent-soft"], 4.5],
  ["--accent-text", [...SURFACES, "--accent-soft", "--accent-soft-hover"], 4.5],
  ["--on-accent", ["--accent", "--accent-hover"], 4.5],
  ["--focus", SURFACES, 3],
  ["--border-control", ["--surface", "--surface-2"], 3],
  ["--ok", ["--ok-soft"], 4.5],
  ["--warn", ["--warn-soft"], 4.5],
  ["--danger", ["--danger-soft"], 4.5],
  ["--on-danger", ["--danger-solid", "--danger-solid-hover"], 4.5],
  ["--sev-high", ["--surface"], 3],
  ["--sev-medium", ["--surface"], 3],
  ["--sev-low", ["--surface"], 3],
  ["--sev-critical", ["--surface"], 3],
  ["--graph-edge", ["--surface", "--surface-2"], 3],
  ["--tooltip-text", ["--tooltip-bg"], 4.5],
  ["--text-disabled", ["--surface", "--surface-2"], 3],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): [string, string[], number] => [WHITE, [`--avatar-${n}`], 4.5]),
  [WHITE, ["--avatar-service"], 4.5],
];

describe("tokens.css", () => {
  it("defines every legacy token name", () => {
    for (const name of LEGACY) expect(light.has(name), name).toBe(true);
  });

  it("writes the two dark blocks with identical declarations", () => {
    expect(darkMedia.size).toBeGreaterThan(20);
    expect([...darkAttr.entries()]).toEqual([...darkMedia.entries()]);
    expect(darkMedia.get("color-scheme")).toBe("dark");
  });

  it("keeps the explicit light switch", () => {
    expect(css).toMatch(/:root\[data-theme="light"\]\s*\{\s*color-scheme:\s*light;?\s*\}/);
  });

  for (const [themeName, theme] of [["light", light], ["dark", dark]] as const) {
    it(`meets every §3.4 contrast pair in ${themeName}`, () => {
      const failures: string[] = [];
      for (const [fg, bgs, min] of PAIRS) {
        const f = fg.startsWith("--") ? resolve(theme, fg) : fg;
        for (const bg of bgs) {
          const ratio = contrast(f, resolve(theme, bg));
          if (ratio < min) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

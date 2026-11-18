import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readArchive, readTarGz, type TreeEntry } from "../src/core/skills/archive.js";
import { detectLayout } from "../src/core/skills/layout.js";
import { prepareSkill } from "../src/core/skills/prepare.js";
import {
  applyStamp,
  beginMarker,
  endMarker,
  findBlock,
  guidanceOnly,
  loadCore,
  managedHeader,
  mentionsDataSource,
  planStamp,
  removeBlock,
  splitFrontmatter,
  SyncError,
  TreeView,
  upsertBlock,
} from "../src/core/skills/stamp.js";
import { contentHash, sha256 } from "../src/core/skills/types.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");
const enc = new TextEncoder();
const dec = new TextDecoder();

/** A folder on disk as an in-memory tree (what the importer works on). */
export function treeOf(dir: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.set(r, { type: "file", data: new Uint8Array(readFileSync(p)) });
    }
  };
  walk(dir, "");
  return out;
}

const files = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [k, { type: "file" as const, data: enc.encode(v) }]));

describe("sync_core port: blocks and frontmatter", () => {
  it("splits frontmatter with Python's rstrip semantics", () => {
    expect(splitFrontmatter("---\nname: x\n---\nbody")).toEqual(["---\nname: x\n---\n", "body"]);
    expect(splitFrontmatter("---\r\nname: x\r\n---\r\nbody")).toEqual(["---\r\nname: x\r\n---\r\n", "body"]);
    // \x1c is whitespace to Python's str.rstrip(), not to JS trimEnd(); ﻿ the other way round.
    expect(splitFrontmatter("---\x1c\nname: x\n---\nb")).not.toBeNull();
    expect(splitFrontmatter("---﻿\nname: x\n---\nb")).toBeNull();
    expect(splitFrontmatter("no frontmatter")).toBeNull();
  });

  it("round-trips upsert and remove like sync_core (byte for byte after a blank line, CRLF included)", () => {
    // Outputs checked against ci/sync_core.py's upsert_block / remove_block.
    const cases: [string, string][] = [
      ["---\nname: a\n---\n\nBody\n", "---\nname: a\n---\n\nBody\n"],
      ["---\nname: a\n---\nBody\n", "---\nname: a\n---\n\nBody\n"],
      ["---\r\nname: a\r\n---\r\n\r\nBody\r\n", "---\r\nname: a\r\n---\r\n\r\nBody\r\n"],
      ["---\nname: a\n---\n", "---\nname: a\n---\n\n"],
    ];
    for (const [text, back] of cases) {
      const stamped = upsertBlock(text, "datasources", "Read it.", "w");
      expect(stamped).toContain(beginMarker("datasources"));
      expect(removeBlock(stamped, "datasources", "w")).toBe(back);
    }
  });

  it("uses one newline before an existing blank line, two otherwise", () => {
    expect(upsertBlock("---\na: 1\n---\n\nX", "s", "P", "w")).toBe(`---\na: 1\n---\n\n${beginMarker("s")}\nP\n${endMarker("s")}\n\nX`);
    expect(upsertBlock("---\na: 1\n---\nX", "s", "P", "w")).toBe(`---\na: 1\n---\n\n${beginMarker("s")}\nP\n${endMarker("s")}\n\nX`);
  });

  it("replaces an existing block in place and refuses duplicated or unbalanced markers", () => {
    const once = upsertBlock("---\na: 1\n---\n\nX", "s", "old", "w");
    expect(upsertBlock(once, "s", "new", "w")).toBe(once.replace("old", "new"));
    expect(() => findBlock(`${beginMarker("s")}\n${beginMarker("s")}\n${endMarker("s")}`, "s", "w")).toThrow(SyncError);
    expect(() => findBlock(`${endMarker("s")}\n${beginMarker("s")}`, "s", "w")).toThrow(/duplicated or unbalanced/);
    expect(() => upsertBlock("no frontmatter", "s", "p", "w")).toThrow(/no frontmatter/);
  });

  it("finds data-source mentions as whole words, ignoring core blocks", () => {
    expect(mentionsDataSource("Use Tableau, then stop.", "w")).toBe(true);
    expect(mentionsDataSource("CLICKHOUSE first", "w")).toBe(true);
    expect(mentionsDataSource("the tableau_server host", "w")).toBe(false);
    expect(mentionsDataSource("éTableau and xTableau", "w")).toBe(false);
    expect(mentionsDataSource("Tableau2", "w")).toBe(false);
    expect(mentionsDataSource(`${beginMarker("x")}\nTableau\n${endMarker("x")}\nnothing`, "w")).toBe(false);
  });

  it("refuses a core file without its header, an unpaired file and a marker in a pointer", () => {
    const base = new Map([
      ["core/files/a.md", `${managedHeader("a.md")}\nA`],
      ["core/pointers/a.md", "Read a.md"],
    ]);
    expect(loadCore(new TreeView(files(base))).files.size).toBe(1);
    expect(() => loadCore(new TreeView(files(new Map([...base, ["core/files/b.md", "no header"]]))))).toThrow(/first line must be/);
    expect(() => loadCore(new TreeView(files(new Map([...base, ["core/files/b.md", `${managedHeader("b.md")}\n`]]))))).toThrow(/must both exist/);
    expect(() => loadCore(new TreeView(files(new Map([...base, ["core/pointers/a.md", `x ${beginMarker("q")}`]]))))).toThrow(/must not contain a core/);
    expect(() => loadCore(new TreeView(files(new Map([...base, ["core/files/Bad.md", "x"]]))))).toThrow(/lowercase-hyphen/);
  });

  it("uses the data-source rule for core files it doesn't know", () => {
    const tree = files(
      new Map([
        ["core/files/extra.md", `${managedHeader("extra.md")}\nExtra`],
        ["core/pointers/extra.md", "See extra.md"],
        ["plugins/p/.mcp.json", '{"mcpServers": {}}'],
        ["plugins/p/skills/a/SKILL.md", "---\nname: a\n---\nNo mention"],
        ["plugins/p/skills/b/SKILL.md", "---\nname: b\n---\nUses Redshift"],
      ]),
    );
    const plan = planStamp(tree);
    expect(plan.changes.map((c) => c.path).sort()).toEqual(["plugins/p/skills/b/SKILL.md", "plugins/p/skills/b/extra.md"]);
  });
});

describe("stamping the fixture marketplace", () => {
  const source = treeOf(path.join(FIXTURES, "marketplace"));
  const golden = treeOf(path.join(FIXTURES, "marketplace.stamped"));

  it("matches ci/sync_core.py's output byte for byte, and rejects only the two skills it refuses", () => {
    const plan = planStamp(source);
    expect([...plan.skillErrors.keys()].sort()).toEqual(["plugins/beta/skills/bad-markers", "plugins/beta/skills/collision"]);
    expect(plan.skillErrors.get("plugins/beta/skills/collision")).toMatch(/exists and is not a managed copy/);
    expect(plan.skillErrors.get("plugins/beta/skills/bad-markers")).toMatch(/duplicated or unbalanced/);
    const out = applyStamp(source, plan.changes);
    for (const bad of ["collision", "bad-markers"]) for (const k of [...out.keys()]) if (k.startsWith(`plugins/beta/skills/${bad}/`)) out.delete(k);
    expect([...out.keys()].sort()).toEqual([...golden.keys()].sort());
    for (const [p, e] of golden) expect(sha256(out.get(p)!.data), p).toBe(sha256(e.data));
  });

  it("stamps by the qualifier rules", () => {
    const plan = planStamp(source);
    expect(plan.stamped.get("plugins/alpha/skills/uses-tableau")).toEqual(["connectors.md", "datasources.md", "table-knowledge.md"]);
    expect(plan.stamped.get("plugins/alpha/skills/plain-alpha")).toEqual(["connectors.md"]);
    expect(plan.stamped.get("plugins/beta/skills/crlf-redshift")).toEqual(["connectors.md", "datasources.md", "table-knowledge.md"]);
    for (const quiet of ["no-mention", "own-datasources", "word-boundary", "already-stamped", "long-paths"]) expect(plan.stamped.has(`plugins/beta/skills/${quiet}`), quiet).toBe(false);
    // An earlier stamp that no longer qualifies is removed: its block and its managed copy.
    expect(plan.changes).toContainEqual({ path: "plugins/beta/skills/already-stamped/datasources.md", kind: "delete", data: null });
    // A skill's own datasources.md is left alone when the skill doesn't qualify.
    expect(plan.changes.some((c) => c.path.startsWith("plugins/beta/skills/own-datasources/"))).toBe(false);
  });

  it("tells a guidance-only change from a content change, with the same hash across skills", () => {
    const hashed = (m: Map<string, TreeEntry>, dir: string) =>
      [...m].filter(([p]) => p.startsWith(`${dir}/`)).map(([p, e]) => {
        const rel = p.slice(dir.length + 1);
        return { path: rel, sha256: sha256(e.data), managed: rel !== "SKILL.md" && dec.decode(e.data).startsWith("<!-- managed by"), text: rel === "SKILL.md" ? dec.decode(e.data) : undefined };
      });
    const before = applyStamp(source, planStamp(source).changes);
    const changedCore = new Map(source);
    changedCore.set("core/files/connectors.md", { type: "file", data: enc.encode(`${managedHeader("connectors.md")}\nNew guidance.\n`) });
    changedCore.set("core/pointers/connectors.md", { type: "file", data: enc.encode("A new pointer.") });
    const after = applyStamp(changedCore, planStamp(changedCore).changes);
    const a = guidanceOnly(hashed(before, "plugins/alpha/skills/plain-alpha"), hashed(after, "plugins/alpha/skills/plain-alpha"));
    const b = guidanceOnly(hashed(before, "plugins/gamma/skills/dev-files"), hashed(after, "plugins/gamma/skills/dev-files"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    // A change outside the blocks is not guidance-only.
    const edited = new Map(after);
    const md = "plugins/alpha/skills/plain-alpha/SKILL.md";
    edited.set(md, { type: "file", data: enc.encode(dec.decode(after.get(md)!.data).replace("No data source", "Still no data source")) });
    expect(guidanceOnly(hashed(before, "plugins/alpha/skills/plain-alpha"), hashed(edited, "plugins/alpha/skills/plain-alpha"))).toBeNull();
    expect(guidanceOnly(hashed(before, "plugins/alpha/skills/plain-alpha"), hashed(before, "plugins/alpha/skills/plain-alpha"))).toBeNull();
  });

  it("reads the committed git archive (ustar prefix entries) the same as the folder", () => {
    const buf = readFileSync(path.join(FIXTURES, "git-archive.tar.gz"));
    const raw = readTarGz(buf);
    expect(raw.commit).toMatch(/^[0-9a-f]{40}$/);
    expect([...raw.entries.keys()].some((p) => p.endsWith("another-long-folder/notes.md"))).toBe(true);
    const tree = readArchive(buf);
    expect(tree.topName).toBe("fixture-abc1234");
    expect([...tree.entries.keys()].sort()).toEqual([...source.keys()].sort());
  });
});

// ---- the real claude-skills repository ---------------------------------------------------------------------------
const PARITY = process.env.SKILLS_PARITY_REPO;
const tools = (() => {
  if (!PARITY || !existsSync(path.join(PARITY, "ci", "sync_core.py"))) return "SKILLS_PARITY_REPO isn't set to a claude-skills clone";
  if (spawnSync("git", ["--version"]).status !== 0) return "git isn't available";
  if (spawnSync("python3", ["-c", "import yaml"]).status !== 0) return "python3 with pyyaml isn't available";
  return null;
})();

describe.skipIf(!!tools)(`parity with the real repository${tools ? ` (skipped: ${tools})` : ""}`, () => {
  it("imports a copy of the repository like ci/sync_core.py stamps it, every skill folder byte for byte", async () => {
    // A copy of the clone, so nothing touches the original.
    const work = mkdtempSync(path.join(tmpdir(), "skills-parity-"));
    try {
      const copy = path.join(work, "repo");
      cpSync(PARITY!, copy, { recursive: true });
      const sha = execFileSync("git", ["-C", copy, "rev-parse", "HEAD"]).toString().trim();
      const tar = execFileSync("git", ["-C", copy, "archive", "--format=tar", `--prefix=claude-skills-${sha.slice(0, 7)}/`, "HEAD"], { maxBuffer: 256 * 1024 * 1024 });
      // Python reads the same tar (its own tarfile, not our reader) and runs the repo's sync_core.py on it.
      const out = path.join(work, "py");
      execFileSync("python3", ["-I", "-c", "import sys,tarfile,io; t=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read())); t.extractall(sys.argv[1], **({'filter': 'tar'} if hasattr(tarfile, 'tar_filter') else {}))", out], { input: tar });
      const pyRoot = path.join(out, `claude-skills-${sha.slice(0, 7)}`);
      execFileSync("python3", ["-I", path.join(pyRoot, "ci", "sync_core.py"), "--root", pyRoot], { stdio: "ignore" });
      const expected = treeOf(pyRoot);

      // Ours: the gzipped tar through readTarGz (ustar prefix entries included) → stamping → layout → validation.
      const gz = gzipSync(tar);
      const prefixed = countPrefixEntries(tar);
      expect(prefixed).toBeGreaterThan(0);
      const tree = readArchive(gz);
      expect(tree.commit).toBe(sha);
      const plan = planStamp(tree.entries);
      expect(plan.skillErrors.size).toBe(0);
      const stamped = applyStamp(tree.entries, plan.changes);
      const layout = detectLayout(stamped, { repoName: "claude-skills" });
      expect(layout.layout).toBe("marketplace");
      expect(layout.skills.length).toBe(40);
      expect(layout.plugins.length).toBe(10);
      expect(layout.plugins.filter((p) => p.connectors.length).length).toBe(8);
      // Every file of every skill folder, byte for byte.
      let compared = 0;
      for (const s of layout.skills) {
        const mine = [...stamped].filter(([p]) => p.startsWith(`${s.dir}/`));
        const theirs = [...expected].filter(([p]) => p.startsWith(`${s.dir}/`));
        expect(mine.map(([p]) => p).sort(), s.dir).toEqual(theirs.map(([p]) => p).sort());
        for (const [p, e] of mine) expect(sha256(e.data), p).toBe(sha256(expected.get(p)!.data));
        compared += mine.length;
      }
      expect(compared).toBeGreaterThan(300);
      expect([...plan.stamped.keys()].length).toBe(35);
      // Every skill validates; the reviewer flags are there, and no tool-id flag comes from a stamped copy.
      let rejected = 0;
      const flagged = new Map<string, string[]>();
      for (const s of layout.skills) {
        const skillFiles = [...stamped].filter(([p]) => p.startsWith(`${s.dir}/`)).map(([p, e]) => ({ path: p.slice(s.dir.length + 1), data: e.data }));
        const prep = prepareSkill(s.name, skillFiles);
        if (prep.errors.length) rejected++;
        expect(prep.errors, s.dir).toEqual([]);
        flagged.set(s.name, prep.flags.map((f) => `${f.kind}:${f.path}`));
        expect(prep.flags.filter((f) => f.kind === "tool_id" && prep.files.find((x) => x.path === f.path)?.managed)).toEqual([]);
        expect(contentHash(prep.files)).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(rejected).toBe(0);
      expect([...flagged.values()].flat().some((f) => f.endsWith("scripts/offer_digest.py") && f.startsWith("possible_secret"))).toBe(true);
      expect([...flagged.values()].flat().some((f) => f.startsWith("personal_data:") && f.endsWith("evals.json"))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);
});

/** Entries of an uncompressed tar whose path uses the POSIX ustar prefix field. */
function countPrefixEntries(tar: Buffer): number {
  let n = 0;
  for (let off = 0; off + 512 <= tar.length; ) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(h.subarray(124, 136).toString("latin1").replace(/\0.*$/, "").trim() || "0", 8);
    if (h.subarray(257, 263).toString("latin1") === "ustar\0" && h[345] !== 0) n++;
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return n;
}

import { deflateSync, gzipSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ArchiveError, readArchive, readTar, readTarGz, readZip, writeTar } from "../src/core/skills/archive.js";
import { detectLayout } from "../src/core/skills/layout.js";
import { parseConnectors } from "../src/core/skills/mcp-json.js";

/** A raw ustar header with full control over every field (for malicious archives). */
function rawHeader(o: { name: string; prefix?: string; type?: string; size?: number; magic?: "posix" | "gnu"; checksum?: "bad"; sizeField?: Uint8Array }): Buffer {
  const h = Buffer.alloc(512);
  h.write(o.name, 0, 100, "utf8");
  h.write("0000644\0", 100, "latin1");
  h.write("0000000\0", 108, "latin1");
  h.write("0000000\0", 116, "latin1");
  if (o.sizeField) Buffer.from(o.sizeField).copy(h, 124);
  else h.write(`${(o.size ?? 0).toString(8).padStart(11, "0")}\0`, 124, "latin1");
  h.write("00000000000\0", 136, "latin1");
  h.write(o.type ?? "0", 156, "latin1");
  if (o.magic === "gnu") h.write("ustar  \0", 257, "latin1");
  else h.write("ustar\0" + "00", 257, "latin1");
  if (o.prefix) h.write(o.prefix, 345, 155, "utf8");
  h.fill(32, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${(o.checksum === "bad" ? sum + 1 : sum).toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return h;
}
const block = (data: Buffer) => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
const END = Buffer.alloc(1024);
const tar = (...parts: Buffer[]) => Buffer.concat([...parts, END]);
const file = (name: string, text: string, extra: Partial<Parameters<typeof rawHeader>[0]> = {}) => Buffer.concat([rawHeader({ name, size: Buffer.byteLength(text), ...extra }), block(Buffer.from(text))]);
const pax = (records: Record<string, string>, type = "x") => {
  const body = Buffer.from(
    Object.entries(records)
      .map(([k, v]) => {
        const kv = `${k}=${v}\n`;
        let len = kv.length + 3;
        while (`${len} ${kv}`.length !== len) len = `${len} ${kv}`.length;
        return `${len} ${kv}`;
      })
      .join(""),
  );
  return Buffer.concat([rawHeader({ name: "PaxHeader", type, size: body.length }), block(body)]);
};

describe("tar reading", () => {
  it("joins the POSIX prefix and name, lets pax path win, and ignores bytes 345+ in GNU headers", () => {
    const t = tar(
      file("notes.md", "deep", { prefix: "repo/a-long-folder/another" }),
      pax({ path: "repo/from-pax.md" }),
      file("ignored-name.md", "pax", { prefix: "repo/not-used" }),
      file("repo/gnu.md", "gnu", { magic: "gnu", prefix: "garbage-that-is-not-a-prefix" }),
      pax({ comment: "a".repeat(40) }, "g"),
    );
    const r = readTar(t);
    expect([...r.entries.keys()].sort()).toEqual(["repo/a-long-folder/another/notes.md", "repo/from-pax.md", "repo/gnu.md"]);
    expect(Buffer.from(r.entries.get("repo/from-pax.md")!.data).toString()).toBe("pax");
    expect(r.commit).toBe("a".repeat(40));
  });

  it("reads GNU long names (L) and keeps links and devices as markers", () => {
    const long = `repo/${"n".repeat(150)}.md`;
    const L = Buffer.concat([rawHeader({ name: "././@LongLink", type: "L", size: long.length + 1, magic: "gnu" }), block(Buffer.from(`${long}\0`))]);
    const t = tar(L, file("short", "long one", { magic: "gnu" }), rawHeader({ name: "repo/sym", type: "2" }), rawHeader({ name: "repo/hard", type: "1" }), rawHeader({ name: "repo/dev", type: "3" }), rawHeader({ name: "repo/fifo", type: "6" }));
    const r = readTar(t);
    expect(Buffer.from(r.entries.get(long)!.data).toString()).toBe("long one");
    expect(r.entries.get("repo/sym")!.type).toBe("symlink");
    expect(r.entries.get("repo/hard")!.type).toBe("symlink");
    expect(r.entries.get("repo/dev")!.type).toBe("special");
    expect(r.entries.get("repo/fifo")!.type).toBe("special");
  });

  it("reads base-256 sizes", () => {
    const size = Buffer.alloc(12);
    size[0] = 0x80;
    size[11] = 5;
    const t = tar(Buffer.concat([rawHeader({ name: "a/b.md", sizeField: size }), block(Buffer.from("hello"))]));
    expect(Buffer.from(readTar(t).entries.get("a/b.md")!.data).toString()).toBe("hello");
  });

  it.each([
    ["../x", "absolute or dot segments"],
    ["/etc/passwd", "absolute"],
    ["a/../../x", "dot segment"],
    ["C:/x", "drive letter"],
    ["a\\b", "backslash"],
    ["a//b", "empty segment"],
    ["a/./b", "dot segment"],
  ])("rejects the whole archive for %s", (name) => {
    expect(() => readTar(tar(file("ok.md", "fine"), file(name, "bad")))).toThrow(ArchiveError);
  });

  it("rejects traversal through the ustar prefix and through pax path", () => {
    expect(() => readTar(tar(file("x.md", "bad", { prefix: "../.." })))).toThrow(/unsafe path/);
    expect(() => readTar(tar(pax({ path: "../escape.md" }), file("fine.md", "bad")))).toThrow(/unsafe path/);
    expect(() => readTar(tar(pax({ path: "a/\u0000b" }), file("fine.md", "bad")))).toThrow(/unsafe path/);
  });

  it("rejects overlong and too deep paths, NUL, duplicates and case or NFC twins", () => {
    expect(() => readTar(tar(file(`${"a/".repeat(13)}x`, "deep")))).toThrow(/too deep/);
    expect(() => writeAndRead(`r/${"x".repeat(310)}`)).toThrow(/too long/);
    expect(() => readTar(tar(file("r/a.md", "1"), file("r/a.md", "2")))).toThrow(/twice/);
    expect(() => readTar(tar(file("r/A.md", "1"), file("r/a.md", "2")))).toThrow(/case-insensitive/);
    expect(() => readTar(tar(file("r/caf\u00e9.md", "1"), file("r/cafe\u0301.md", "2")))).toThrow(/case-insensitive/);
    // A prefix+name path colliding with a plain one.
    expect(() => readTar(tar(file("b.md", "1", { prefix: "r/a" }), file("r/a/b.md", "2")))).toThrow(/twice/);
  });

  it("rejects bad checksums, truncation, unknown types and a missing end marker", () => {
    expect(() => readTar(tar(file("a.md", "x", { checksum: "bad" })))).toThrow(/checksum/);
    expect(() => readTar(rawHeader({ name: "a.md", size: 2000 }))).toThrow(/truncated/);
    expect(() => readTar(tar(rawHeader({ name: "a.md", type: "S" })))).toThrow(/type we don't read/);
    expect(() => readTar(file("a.md", "x"))).toThrow(/no end-of-archive/);
  });

  it("stops a gzip bomb at the unpacked limit", () => {
    const big = gzipSync(Buffer.alloc(5 * 1024 * 1024));
    expect(() => readTarGz(big, { maxUncompressed: 1024 * 1024 })).toThrow(/unpacks to more than/);
  });
});

function writeAndRead(name: string) {
  return readTar(tar(pax({ path: name }), file("x", "y")));
}

describe("zip reading", () => {
  const ok = (entries: Record<string, Uint8Array | [Uint8Array, object]>) => Buffer.from(zipSync(entries as never));

  it("reads stored and deflated entries", () => {
    const z = ok({ "a/SKILL.md": strToU8("hello"), "a/big.txt": [strToU8("x".repeat(5000)), { level: 9 }] });
    const r = readZip(z);
    expect(Buffer.from(r.entries.get("a/SKILL.md")!.data).toString()).toBe("hello");
    expect(r.entries.get("a/big.txt")!.data.length).toBe(5000);
  });

  it("keeps a symlink entry as a marker", () => {
    const z = ok({ "a/link": [strToU8("../../etc/passwd"), { os: 3, attrs: (0o120777 << 16) >>> 0 }], "a/SKILL.md": strToU8("x") });
    expect(readZip(z).entries.get("a/link")!.type).toBe("symlink");
  });

  it("rejects zip slip, encryption, odd methods, ZIP64 and mismatched local names", () => {
    expect(() => readZip(ok({ "../evil.md": strToU8("x") }))).toThrow(/unsafe path/);
    expect(() => readZip(ok({ "/abs.md": strToU8("x") }))).toThrow(/unsafe path/);
    const z = ok({ "a/SKILL.md": strToU8("hello") });
    const cd = z.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    const enc = Buffer.from(z);
    enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
    expect(() => readZip(enc)).toThrow(/encrypted/);
    const method = Buffer.from(z);
    method.writeUInt16LE(12, cd + 10);
    expect(() => readZip(method)).toThrow(/compression method 12/);
    const z64 = Buffer.from(z);
    z64.writeUInt32LE(0xffffffff, cd + 20);
    expect(() => readZip(z64)).toThrow(/ZIP64/);
    const local = Buffer.from(z);
    local[30] = "b".charCodeAt(0); // the local header's name: "a/SKILL.md" → "b/SKILL.md"
    expect(() => readZip(local)).toThrow(/local and central names differ/);
  });

  it("stops a zip bomb at the budget whatever it declares, and refuses too many entries", () => {
    const bomb = ok({ "a/bomb.txt": [new Uint8Array(3 * 1024 * 1024), { level: 9 }] });
    expect(() => readZip(bomb, { maxUncompressed: 1024 * 1024 })).toThrow(/unpacks to more than/);
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30; i++) many[`a/f${i}.md`] = strToU8("x");
    expect(() => readZip(ok(many), { maxEntries: 20 })).toThrow(/more than 20 entries/);
  });
});

describe("after reading", () => {
  it("drops Finder junk and strips the top folder: a Finder zip of one skill is a single skill", () => {
    const z = Buffer.from(
      zipSync({
        "my-skill/SKILL.md": strToU8("---\nname: my-skill\ndescription: d\n---\n"),
        "my-skill/._SKILL.md": strToU8("appledouble"),
        "my-skill/.DS_Store": strToU8("x"),
        "__MACOSX/my-skill/._SKILL.md": strToU8("x"),
        "my-skill/__pycache__/x.pyc": strToU8("x"),
        "my-skill/._lonely": strToU8("x"),
      }),
    );
    const tree = readArchive(z);
    expect(tree.topName).toBe("my-skill");
    expect([...tree.entries.keys()].sort()).toEqual(["._lonely", "SKILL.md"]);
    expect(tree.warnings[0]!.message).toMatch(/AppleDouble/);
    const layout = detectLayout(tree.entries, { topName: tree.topName });
    expect(layout.layout).toBe("single");
    expect(layout.skills[0]!.name).toBe("my-skill");
  });

  it("honours an upload's root .gitignore", () => {
    const z = Buffer.from(
      zipSync({
        "repo/.gitignore": strToU8("out/\n.env\n*.log\n!keep.log\n/tmp\n"),
        "repo/skills/a/SKILL.md": strToU8("x"),
        "repo/out/x.html": strToU8("x"),
        "repo/skills/a/out/y.html": strToU8("x"),
        "repo/.env": strToU8("SECRET=1"),
        "repo/debug.log": strToU8("x"),
        "repo/keep.log": strToU8("x"),
        "repo/tmp/t.md": strToU8("x"),
        "repo/skills/a/tmp/kept.md": strToU8("x"),
      }),
    );
    const tree = readArchive(z, { gitignore: true });
    expect(tree.ignored).toEqual([".env", "debug.log", "out/x.html", "skills/a/out/y.html", "tmp/t.md"]);
    expect([...tree.entries.keys()].sort()).toEqual([".gitignore", "keep.log", "skills/a/SKILL.md", "skills/a/tmp/kept.md"]);
  });

  it("refuses a path that is both a file and a folder", () => {
    expect(() => readArchive(Buffer.from(zipSync({ "r/a": strToU8("x"), "r/a/b": strToU8("y") })))).toThrow(/both a file and a folder/);
  });

  it("finds folder and plain layouts", () => {
    const folder = readArchive(Buffer.from(zipSync({ "R/a/SKILL.md": strToU8("x"), "R/b/SKILL.md": strToU8("y") })));
    expect(detectLayout(folder.entries, { collection: "Team Picks" })).toMatchObject({ layout: "folder", skills: [{ name: "a", collection: "team-picks" }, { name: "b", collection: "team-picks" }] });
    const plain = readArchive(Buffer.from(zipSync({ "repo/foo/skills/x/SKILL.md": strToU8("x"), "repo/.claude/skills/y/SKILL.md": strToU8("y"), "repo/skills/z/SKILL.md": strToU8("z") })));
    const l = detectLayout(plain.entries, { collection: "mine" });
    expect(l.layout).toBe("plain");
    expect(l.skills.map((s) => [s.name, s.collection])).toEqual([
      ["y", "mine"],
      ["x", "foo"],
      ["z", "mine"],
    ]);
    const plugin = readArchive(Buffer.from(zipSync({ "p/.claude-plugin/plugin.json": strToU8('{"name": "solo", "displayName": "Solo"}'), "p/skills/one/SKILL.md": strToU8("x") })));
    expect(detectLayout(plugin.entries)).toMatchObject({ layout: "plugin", plugins: [{ slug: "solo", name: "Solo" }], skills: [{ name: "one", collection: "solo" }] });
    // A git source names a root skill after the repository, never the archive's owner-repo-sha folder.
    const single = readArchive(Buffer.from(zipSync({ "owner-repo-abc123/SKILL.md": strToU8("x") })));
    expect(detectLayout(single.entries, { repoName: "repo", topName: single.topName }).skills[0]!.name).toBe("repo");
  });

  it("reads the tar the writer makes (fallback archives)", () => {
    const t = gzipSync(writeTar([{ path: "x/skills/a/SKILL.md", data: strToU8("hi") }, { path: `x/skills/a/${"r".repeat(130)}.md`, data: strToU8("long") }]));
    expect([...readArchive(t).entries.keys()].sort()).toEqual(["skills/a/SKILL.md", `skills/a/${"r".repeat(130)}.md`]);
    void deflateSync;
  });
});

describe(".mcp.json", () => {
  it("keeps valid remote connectors and refuses headers, stdio, queries and credentials", () => {
    expect(parseConnectors('{"mcpServers": {"tableau": {"type": "http", "url": "https://t.example.com/mcp"}}}')).toEqual({ connectors: [{ name: "tableau", type: "http", url: "https://t.example.com/mcp" }], errors: [] });
    for (const bad of [
      '{"mcpServers": {"a": {"type": "http", "url": "https://a.example.com", "headers": {}}}}',
      '{"mcpServers": {"a": {"type": "stdio", "command": "x"}}}',
      '{"mcpServers": {"a": {"type": "http", "url": "https://a.example.com/?token=1"}}}',
      '{"mcpServers": {"a": {"type": "http", "url": "https://u:p@a.example.com/"}}}',
      '{"mcpServers": {"a": {"type": "http", "url": "http://a.example.com/"}}}',
      '{"mcpServers": {"a": {"type": "http", "url": "https://a.example.com"}, "a": {"type": "http", "url": "https://b.example.com"}}}',
      '{"mcpServers": {}, "other": 1}',
    ]) {
      const r = parseConnectors(bad);
      expect(r.connectors, bad).toEqual([]);
      expect(r.errors.length, bad).toBeGreaterThan(0);
    }
  });
});

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { startApp, type TestApp } from "./skills-helpers.js";

/**
 * The Claude Code sync script (apps/web/public/skills-sync.py) against the test app and against a hostile stub
 * server: it installs only into thaliyola-* folders it marks, removes what's no longer assigned (everything when
 * skills are switched off or the account is disabled), validates every name and path before touching the disk, and
 * never breaks a session hook. Needs python3 (skipped otherwise).
 */

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/public/skills-sync.py");
const usable = spawnSync("python3", ["--version"]).status === 0;

let db: Db;
let app: TestApp;
let stub: Server;
let stubBase: string;
let stubReply: (url: string) => { status: number; headers?: Record<string, string>; body?: unknown };
const ids: Record<string, string> = {};

const md = (name: string) => `---\nname: ${name}\ndescription: Use when testing the Claude Code sync of ${name}; it lists the steps.\n---\n\n# ${name}\n`;

function exec(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
const home = () => mkdtempSync(path.join(tmpdir(), "thaliyola-sync-"));
const sync = (h: string, token: string, extra: string[] = [], url = app.base, env: Record<string, string> = {}) => exec(["--url", url, ...extra], { HOME: h, THALIYOLA_TOKEN: token, ...env });
const skillsDir = (h: string) => path.join(h, ".claude", "skills");
const listing = (h: string) => (existsSync(skillsDir(h)) ? readdirSync(skillsDir(h)).sort() : []);

/** Every file under a folder, relative to it. */
function walk(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const n of readdirSync(path.join(root, rel))) {
    const r = rel ? `${rel}/${n}` : n;
    const st = lstatSync(path.join(root, r));
    if (st.isDirectory()) out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

beforeAll(async () => {
  if (!usable) return;
  ({ db } = await freshDb());
  app = await startApp(db, { ...TEST_SETTINGS });
  for (const name of ["sync-one", "sync-two"]) {
    const c = await app.call("manager", "POST", "/api/skills", { skill_md: md(name), files: [{ path: "references/r.md", text: `ref of ${name}\n` }], summary: "New" });
    expect(c.status).toBe(200);
    expect((await app.call("reviewer", "POST", `/api/skills/${c.body.id}/versions/1/approve`, {})).status).toBe(200);
    ids[name] = c.body.id;
  }
  const team = (await db.query<{ id: string }>("INSERT INTO teams (slug, name) VALUES ('sync-team', 'Sync team') RETURNING id")).rows[0]!.id;
  await db.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2), ($1, $3)", [team, app.ids.alice, app.ids.bob]);
  for (const name of ["sync-one", "sync-two"]) expect((await app.call("manager", "POST", `/api/skills/${ids[name]}/assignments`, { audience: "team", team: "sync-team" })).status).toBe(200);
  stub = createServer((req, res) => {
    const r = stubReply(req.url!);
    res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
    res.end(r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body));
  }).listen(0, "127.0.0.1");
  await new Promise((r) => stub.once("listening", r));
  stubBase = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});
afterAll(async () => {
  if (!usable) return;
  await db.query("DELETE FROM system_settings WHERE key = 'skills_delivery'");
  stub.close();
  await app.close();
  await db.end();
});

describe.skipIf(!usable)("skills-sync.py", () => {
  it("installs the caller's skills with markers, then answers from the ETag, and writes nowhere else", async () => {
    const h = home();
    const r = await sync(h, "alice");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("Thaliyola skills: added sync-one, added sync-two");
    expect(listing(h)).toEqual(["thaliyola-sync-one", "thaliyola-sync-two"]);
    const dir = path.join(skillsDir(h), "thaliyola-sync-one");
    expect(readFileSync(path.join(dir, "SKILL.md"), "utf8")).toMatch(/^---\nname: thaliyola-sync-one\n/);
    expect(readFileSync(path.join(dir, "references", "r.md"), "utf8")).toBe("ref of sync-one\n");
    expect(JSON.parse(readFileSync(path.join(dir, ".thaliyola-skill.json"), "utf8"))).toMatchObject({ name: "sync-one", version: 1, server: app.base });
    expect(lstatSync(path.join(dir, "SKILL.md")).mode & 0o777).toBe(0o644);
    expect(walk(h).every((f) => f.startsWith(".claude/skills/thaliyola-sync-") || f.startsWith(".config/thaliyola/"))).toBe(true);
    const state = JSON.parse(readFileSync(path.join(h, ".config", "thaliyola", "skills-sync-state.json"), "utf8"));
    expect(state.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await db.query("SELECT script FROM skill_sync_seen WHERE user_id = $1", [app.ids.alice])).rows[0].script).toBe("skills-sync/1");
    expect((await db.query("SELECT count(*)::int AS n FROM skill_usage WHERE user_id = $1 AND channel = 'sync'", [app.ids.alice])).rows[0].n).toBe(2);
    // Again: the conditional request comes back 304, nothing printed, nothing downloaded.
    const again = await sync(h, "alice");
    expect(again.stdout).toBe("");
    expect((await db.query("SELECT count(*)::int AS n FROM skill_usage WHERE user_id = $1 AND channel = 'sync'", [app.ids.alice])).rows[0].n).toBe(2);
    // --max-age skips the network entirely.
    expect((await sync(h, "nobody-at-all", ["--quiet", "--max-age", "300"])).stdout).toBe("");
    // A synced folder someone moved away comes back on the next run (the ETag no longer stands for the disk).
    renameSync(path.join(skillsDir(h), "thaliyola-sync-two"), path.join(h, "moved-away"));
    const repaired = await sync(h, "alice", ["--quiet"]);
    expect(repaired.stdout.trim()).toBe("Thaliyola skills: added sync-two");
    expect(listing(h)).toEqual(["thaliyola-sync-one", "thaliyola-sync-two"]);
    expect((await sync(h, "alice")).stdout).toBe("");
  });

  it("updates changed skills, removes revoked ones, and leaves other folders alone", async () => {
    const h = home();
    await sync(h, "bob");
    mkdirSync(path.join(skillsDir(h), "thaliyola-mine"));
    writeFileSync(path.join(skillsDir(h), "thaliyola-mine", "SKILL.md"), "mine\n");
    mkdirSync(path.join(h, "elsewhere"));
    symlinkSync(path.join(h, "elsewhere"), path.join(skillsDir(h), "thaliyola-linked"));
    mkdirSync(path.join(skillsDir(h), "my-own"));
    mkdirSync(path.join(skillsDir(h), ".thaliyola-staging-999")); // left by a run that died
    const v2 = await app.call("manager", "POST", `/api/skills/${ids["sync-one"]}/versions`, { skill_md: `${md("sync-one")}\nVersion two.\n`, summary: "v2" });
    await app.call("reviewer", "POST", `/api/skills/${ids["sync-one"]}/versions/${v2.body.version}/approve`, {});
    const own = (await db.query<{ id: string }>("SELECT id FROM skill_assignments WHERE skill_id = $1", [ids["sync-two"]])).rows[0]!.id;
    await app.call("manager", "DELETE", `/api/skill-assignments/${own}`);
    const r = await sync(h, "bob", ["--quiet"]);
    expect(r.stdout.trim()).toBe("Thaliyola skills: removed sync-two, updated sync-one");
    expect(readFileSync(path.join(skillsDir(h), "thaliyola-sync-one", "SKILL.md"), "utf8")).toContain("Version two.");
    expect(listing(h)).toEqual(["my-own", "thaliyola-linked", "thaliyola-mine", "thaliyola-sync-one"]);
    expect(lstatSync(path.join(skillsDir(h), "thaliyola-linked")).isSymbolicLink()).toBe(true);
    await app.call("manager", "POST", `/api/skills/${ids["sync-two"]}/assignments`, { audience: "team", team: "sync-team" });
  });

  it("follows CLAUDE_CONFIG_DIR", async () => {
    const h = home();
    const conf = path.join(h, "claude-conf");
    expect((await sync(h, "alice", [], app.base, { CLAUDE_CONFIG_DIR: conf })).status).toBe(0);
    expect(readdirSync(path.join(conf, "skills")).sort()).toEqual(["thaliyola-sync-one", "thaliyola-sync-two"]);
    expect(existsSync(path.join(h, ".claude"))).toBe(false);
  });

  it("removes every managed folder when skills are switched off, and when the account is disabled", async () => {
    const h = home();
    await sync(h, "alice");
    mkdirSync(path.join(skillsDir(h), "thaliyola-mine"));
    await db.query("INSERT INTO system_settings (key, value) VALUES ('skills_delivery', '\"off\"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
    const r = await sync(h, "alice", ["--quiet"]);
    expect(r.stdout.trim()).toBe("Thaliyola skills: removed sync-one, removed sync-two");
    expect(listing(h)).toEqual(["thaliyola-mine"]);
    await db.query("DELETE FROM system_settings WHERE key = 'skills_delivery'");
    const h2 = home();
    await sync(h2, "carol");
    await sync(h2, "bob");
    expect(listing(h2).length).toBeGreaterThan(0);
    await db.query("UPDATE users SET disabled_at = now() WHERE id = $1", [app.ids.bob]);
    try {
      const d = await sync(h2, "bob", ["--quiet"]);
      expect(d.status).toBe(0);
      expect(listing(h2)).toEqual([]);
    } finally {
      await db.query("UPDATE users SET disabled_at = NULL WHERE id = $1", [app.ids.bob]);
    }
  });

  it("in --quiet mode never fails a hook, and says a rejected token once a day", async () => {
    const h = home();
    const r = await sync(h, "not-a-token", ["--quiet"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`Thaliyola skills not updated: token rejected: create a new one at ${app.base}/#/connect`);
    expect(r.stdout).not.toContain("not-a-token");
    expect(JSON.parse(readFileSync(path.join(h, ".config", "thaliyola", "skills-sync-state.json"), "utf8")).last_error).toMatch(/token rejected/);
    expect((await sync(h, "not-a-token", ["--quiet"])).stdout).toBe("");
    // Without --quiet it says so every time and exits 1.
    expect((await sync(h, "not-a-token")).status).toBe(1);
    // A token file readable by others is refused.
    const h2 = home();
    mkdirSync(path.join(h2, ".config", "thaliyola"), { recursive: true });
    writeFileSync(path.join(h2, ".config", "thaliyola", "token"), "alice\n", { mode: 0o644 });
    const loose = await exec(["--url", app.base], { HOME: h2 });
    expect(loose.stderr).toMatch(/readable by you only/);
  });

  it("refuses a plain-http server that isn't this machine", async () => {
    const r = await sync(home(), "alice", [], "http://thaliyola.example.com");
    expect(r.stderr).toMatch(/must use https/);
  });

  describe("against a hostile or misconfigured server", () => {
    const manifest = (skills: unknown[]) => ({ status: 200, body: { delivery: "on", remove_all: false, skills } });

    it("refuses a manifest naming a folder outside its own before touching the disk", async () => {
      for (const bad of [{ name: "x", dir: "../x" }, { name: "x", dir: "thaliyola-y" }, { name: "../x", dir: "thaliyola-x" }]) {
        const h = home();
        stubReply = () => manifest([{ ...bad, version: 1, hash: "0".repeat(64) }]);
        const r = await sync(h, "t", [], stubBase);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/nothing changed/);
        expect(existsSync(path.join(h, ".claude"))).toBe(false);
        expect(existsSync(path.join(h, "x"))).toBe(false);
      }
    });

    it("refuses a bundle with a traversal path or a broken hash, and writes nothing", async () => {
      const file = (p: string, text: string) => ({ path: p, sha256: createHash("sha256").update(text).digest("hex"), size: text.length, b64: Buffer.from(text).toString("base64") });
      const hashOf = (files: { path: string; sha256: string }[]) => createHash("sha256").update([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\0${f.sha256}\n`).join("")).digest("hex");
      for (const files of [[file("SKILL.md", "x"), file("../../escape.md", "pwned")], [file("SKILL.md", "x"), { ...file("a.md", "a"), sha256: "f".repeat(64) }]]) {
        const h = home();
        const hash = hashOf(files);
        stubReply = (url) => (url.startsWith("/api/skills/sync/") ? { status: 200, body: { name: "evil", dir: "thaliyola-evil", version: 1, hash, files } } : manifest([{ name: "evil", dir: "thaliyola-evil", version: 1, hash }]));
        const r = await sync(h, "t", [], stubBase);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/nothing changed/);
        expect(listing(h)).toEqual([]);
        expect(existsSync(path.join(h, "escape.md"))).toBe(false);
        expect(existsSync(path.join(h, ".claude", "escape.md"))).toBe(false);
      }
    });

    it("installs the other skills when one can't be written (case twins on a case-insensitive disk)", async () => {
      const probe = home();
      writeFileSync(path.join(probe, "case-probe"), "x");
      const caseInsensitive = existsSync(path.join(probe, "CASE-PROBE"));
      const file = (p: string, text: string) => ({ path: p, sha256: createHash("sha256").update(text).digest("hex"), size: text.length, b64: Buffer.from(text).toString("base64") });
      const hashOf = (files: { path: string; sha256: string }[]) => createHash("sha256").update([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\0${f.sha256}\n`).join("")).digest("hex");
      const bundles: Record<string, ReturnType<typeof file>[]> = {
        "a-twins": [file("SKILL.md", md("a-twins")), file("references/A.md", "upper"), file("references/a.md", "lower")],
        "b-good": [file("SKILL.md", md("b-good"))],
      };
      const entries = Object.entries(bundles).map(([name, files]) => ({ name, dir: `thaliyola-${name}`, version: 1, hash: hashOf(files) }));
      stubReply = (url) => {
        const m = /^\/api\/skills\/sync\/(.+)$/.exec(url);
        if (m) {
          const e = entries.find((x) => x.name === decodeURIComponent(m[1]!))!;
          return { status: 200, body: { ...e, files: bundles[e.name] } };
        }
        return manifest(entries);
      };
      const h = home();
      const r = await sync(h, "t", [], stubBase);
      if (caseInsensitive) {
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/couldn't install a-twins/);
        expect(listing(h)).toEqual(["thaliyola-b-good"]);
        // --quiet (the SessionStart hook) never fails, and the good skill is still there.
        expect((await sync(h, "t", ["--quiet"], stubBase)).status).toBe(0);
      } else {
        expect(r.status, r.stderr).toBe(0);
        expect(listing(h)).toEqual(["thaliyola-a-twins", "thaliyola-b-good"]);
      }
    });

    it("recognises Cloudflare Access in the way", async () => {
      stubReply = () => ({ status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
      const r = await sync(home(), "t", [], stubBase);
      expect(r.stderr).toMatch(/blocked by Cloudflare Access: ask your Administrator to let \/api\/skills\/sync through/);
      stubReply = () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>login</html>" });
      expect((await sync(home(), "t", [], stubBase)).stderr).toMatch(/blocked by Cloudflare Access/);
    });
  });
});

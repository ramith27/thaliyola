import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { startApp, type TestApp } from "./skills-helpers.js";

/**
 * connect.sh's Claude Code skills sync install (--skills / --remove-skills): the token file, the downloaded
 * skills-sync.py, the first run and the SessionStart hook merged into ~/.claude/settings.json, against a running
 * test app with a temporary HOME. Needs sh, curl and python3 (skipped otherwise).
 */

const CONNECT_SH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/public/connect.sh");
const have = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const usable = have("python3") && have("curl");

let db: Db;
let app: TestApp;

beforeAll(async () => {
  if (!usable) return;
  ({ db } = await freshDb());
  app = await startApp(db, { ...TEST_SETTINGS });
  const created = await app.call("manager", "POST", "/api/skills", {
    skill_md: "---\nname: demo-skill\ndescription: A demo skill for the sync install test.\n---\n\n# Demo\n\nRead references/a.md first.\n",
    files: [{ path: "references/a.md", text: "Some reference.\n" }],
    summary: "First version",
  });
  expect(created.status).toBe(200);
  expect((await app.call("reviewer", "POST", `/api/skills/${created.body.id}/versions/1/approve`, {})).status).toBe(200);
  expect((await app.call("manager", "POST", `/api/skills/${created.body.id}/assignments`, { audience: "everyone" })).status).toBe(200);
});
afterAll(async () => {
  if (!usable) return;
  await app.close();
  await db.end();
});

/** Runs a command without blocking the event loop (the test app answers its requests in this process). */
function exec(cmd: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
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

function run(home: string, args: string[], token: string | null = "alice", url = app.base) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };
  if (token) env.THALIYOLA_TOKEN = token;
  return exec("sh", [CONNECT_SH, ...args, "--url", url], env);
}
const settingsOf = (home: string) => readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
const hookCount = (home: string) => (settingsOf(home).match(/thaliyola\/skills-sync\.py/g) ?? []).length;

describe.skipIf(!usable)("connect.sh --skills", () => {
  it("parses as POSIX sh", () => {
    expect(spawnSync("sh", ["-n", CONNECT_SH]).status).toBe(0);
  });

  it("saves the token, installs the script, syncs and merges the hook once, leaving other files alone", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "thaliyola-connect-"));
    const skills = path.join(home, ".claude", "skills");
    mkdirSync(path.join(skills, "my-own"), { recursive: true });
    mkdirSync(path.join(skills, "thaliyola-mine"));
    writeFileSync(path.join(skills, "thaliyola-mine", "SKILL.md"), "mine\n");
    symlinkSync(path.join(home, "elsewhere"), path.join(skills, "thaliyola-x"));
    writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark", hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }] } }));

    const r = await run(home, ["--skills", "--yes"]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/added demo-skill/);

    const conf = path.join(home, ".config", "thaliyola");
    expect(statSync(path.join(conf, "token")).mode & 0o777).toBe(0o600);
    expect(readFileSync(path.join(conf, "token"), "utf8").trim()).toBe("alice");
    expect(readFileSync(path.join(conf, "skills-sync.py"), "utf8")).toContain(app.base);
    expect(r.stdout + r.stderr).not.toContain("alice");

    const installed = path.join(skills, "thaliyola-demo-skill");
    expect(readFileSync(path.join(installed, "SKILL.md"), "utf8")).toMatch(/^---\nname: thaliyola-demo-skill\n/);
    expect(readFileSync(path.join(installed, "references", "a.md"), "utf8")).toBe("Some reference.\n");
    expect(JSON.parse(readFileSync(path.join(installed, ".thaliyola-skill.json"), "utf8"))).toMatchObject({ name: "demo-skill", version: 1 });

    const settings = JSON.parse(settingsOf(home));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[1].hooks[0]).toMatchObject({ type: "command", command: 'python3 -I "$HOME/.config/thaliyola/skills-sync.py" --quiet --max-age 300 --budget 20', timeout: 30 });
    expect(existsSync(path.join(home, ".claude", "settings.json.thaliyola-backup"))).toBe(true);

    // Again: no second hook.
    expect((await run(home, ["--skills", "--yes"])).status).toBe(0);
    expect(hookCount(home)).toBe(1);

    // Other people's folders were never touched.
    expect(readFileSync(path.join(skills, "thaliyola-mine", "SKILL.md"), "utf8")).toBe("mine\n");
    expect(lstatSync(path.join(skills, "thaliyola-x")).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(skills, "my-own"))).toBe(true);

    // Opting out reaches the next run of the hook command: the managed folder goes, the others stay.
    {
      expect((await app.call("alice", "PUT", "/api/account/skills", { send_to_claude: false })).status).toBe(200);
      const hook = await exec("python3", ["-I", path.join(conf, "skills-sync.py"), "--quiet"], { PATH: process.env.PATH ?? "", HOME: home });
      expect(hook.status).toBe(0);
      expect(existsSync(installed)).toBe(false);
      expect(readdirSync(skills).sort()).toEqual(["my-own", "thaliyola-mine", "thaliyola-x"]);
      await app.call("alice", "PUT", "/api/account/skills", { send_to_claude: true });

      // --remove-skills: no token needed; removes the hook, the token and the script.
      const removed = await run(home, ["--remove-skills"], null);
      expect(removed.status, removed.stdout + removed.stderr).toBe(0);
      expect(hookCount(home)).toBe(0);
      expect(JSON.parse(settingsOf(home)).hooks.SessionStart).toHaveLength(1);
      expect(existsSync(path.join(conf, "token"))).toBe(false);
      expect(existsSync(path.join(conf, "skills-sync.py"))).toBe(false);
    }
  });

  it("leaves a settings.json that isn't plain JSON unchanged", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "thaliyola-connect-"));
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const original = '{ // my comment\n  "theme": "dark"\n}\n';
    writeFileSync(path.join(home, ".claude", "settings.json"), original);
    const r = await run(home, ["--skills", "--yes"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/isn't plain JSON; left it unchanged/);
    expect(settingsOf(home)).toBe(original);
    expect(existsSync(path.join(home, ".claude", "skills", "thaliyola-demo-skill", "SKILL.md"))).toBe(true);
  });

  it("refuses a download that isn't the sync script", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "thaliyola-connect-"));
    const r = await run(home, ["--skills", "--yes"], "alice", `${app.base}/nothing-here`);
    expect(r.status).not.toBe(0);
    expect(existsSync(path.join(home, ".config", "thaliyola", "skills-sync.py"))).toBe(false);
  });
});

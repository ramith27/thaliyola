import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, type RequestContext } from "../src/core/context.js";
import { createApiToken } from "../src/auth/local.js";
import {
  approveGuidanceGroup,
  approveImportVersions,
  approveSkillVersion,
  decideAudienceChange,
  decideCollectionChange,
  rejectSkillVersion,
  releaseHold,
  rollbackSkill,
} from "../src/core/skills/review.js";
import { actorById } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { startApp, type TestApp } from "./skills-helpers.js";

/**
 * Pushing skills from Claude: propose_skill (with files, and every check the web editor applies), propose_skill_edit,
 * assign_skill / unassign_skill with dry runs and members-only names, who may do each, the audit rows, and that an
 * agent can never approve a skill version.
 */

let db: Db;
let app: TestApp;
const settings = { ...TEST_SETTINGS, publicUrl: "https://kb.example.com" };
let vault: string;
const id = (who: string) => (app.ids as Record<string, string>)[who]!;

const md = (name: string, body = `# ${name}\n\nDo the thing, then check it.\n`, description = `Use when someone asks for ${name}; it lists the steps, the checks and what to report back.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

async function mcp(token: string) {
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
async function call(token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: any }> {
  const c = await mcp(token);
  try {
    const r = (await c.callTool({ name, arguments: args })) as ToolResult;
    const text = r.content.map((x) => x.text ?? "").join("\n");
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* an error message */
    }
    return { isError: !!r.isError, text, json };
  } finally {
    await c.close();
  }
}
const skillCount = async () => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM skills")).rows[0]!.n;
const auditRows = (tool: string) =>
  db.query<{ tool: string; target_id: string | null; target_kind: string | null; target_label: string | null; details: any; via: string | null; request_id: string | null; is_read: boolean }>(
    "SELECT tool, target_id, target_kind, target_label, details, via, request_id, is_read FROM audit_log WHERE tool = $1 ORDER BY id DESC",
    [tool],
  );

beforeAll(async () => {
  ({ db } = await freshDb());
  app = await startApp(db, settings, { rita: "rita@example.com" });
  vault = (await db.query<{ id: string }>("INSERT INTO scopes (kind, slug, name, visibility) VALUES ('project', 'vault', 'Vault', 'members') RETURNING id")).rows[0]!.id;
  // carol is the vault's Project admin (no organisation permissions); alice is a member; rita has nothing.
  await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'reader')", [vault, id("carol"), id("alice")]);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("propose_skill", () => {
  let skillId: string;

  it("pushes a skill folder (SKILL.md, references, scripts, a binary asset) as version 1 waiting for review", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
    const r = await call("manager", "propose_skill", {
      skill_md: md("weekly-report", "# Weekly report\n\nRead references/sources.md, then run scripts/collect.sh.\n"),
      files: [
        { path: "references/sources.md", content: "# Sources\n\nThe dashboards to read.\n" },
        { path: "./scripts/collect.sh", content: "#!/bin/sh\necho collecting\n" },
        { path: "assets/logo.png", content_base64: png },
      ],
      collection: "reporting",
      summary: "First version, pushed from Claude Code",
    });
    expect(r.isError, r.text).toBe(false);
    skillId = r.json.id;
    expect(r.json).toMatchObject({
      name: "weekly-report",
      version: 1,
      state: "waiting for review",
      collection: "reporting",
      owner_project: null,
      files: ["SKILL.md", "assets/logo.png", "references/sources.md", "scripts/collect.sh"],
      web_url: `https://kb.example.com/#/skills/${skillId}`,
    });
    expect(r.json.review.who_reviews).toMatch(/someone other than you with Review skills \(Skills managers and Administrators\)/);
    expect(r.json.review.reviewers).toContain("reviewer@example.com");
    expect(r.json.review.reviewers).not.toContain("manager@example.com");
    expect(r.json.review.how).toMatch(/web app/);
    expect(r.json.flags.some((f: { kind: string }) => f.kind)).toBe(true);
    const files = (await db.query("SELECT f.path, f.kind, f.is_script FROM skill_files f JOIN skill_versions v ON v.id = f.version_id WHERE v.skill_id = $1 ORDER BY f.path COLLATE \"C\"", [skillId])).rows;
    expect(files).toEqual([
      { path: "SKILL.md", kind: "text", is_script: false },
      { path: "assets/logo.png", kind: "binary", is_script: false },
      { path: "references/sources.md", kind: "text", is_script: false },
      { path: "scripts/collect.sh", kind: "text", is_script: true },
    ]);
    const v = (await db.query("SELECT state, summary, author_id FROM skill_versions WHERE skill_id = $1", [skillId])).rows[0];
    expect(v).toEqual({ state: "pending", summary: "First version, pushed from Claude Code", author_id: id("manager") });
    // The reviewer is told; the skill isn't anyone's yet.
    expect((await db.query("SELECT 1 FROM notifications WHERE kind = 'skill' AND target_id = $1 AND user_id = $2", [skillId, id("reviewer")])).rowCount).toBe(1);
  });

  it("is audited like the web's create, under the MCP call that made it", async () => {
    const [row] = (await auditRows("create_skill")).rows;
    expect(row).toMatchObject({ target_id: skillId, target_kind: "skill", target_label: "weekly-report", details: { name: "weekly-report", collection: "reporting", version: 1, state: "pending", files: 4, has_scripts: true } });
    const wrapper = (await db.query("SELECT tool, via, target_id FROM audit_log WHERE request_id = $1 AND tool <> 'create_skill'", [row!.request_id])).rows;
    expect(wrapper).toEqual([{ tool: "propose_skill", via: "mcp", target_id: skillId }]);
    const page = await app.call("admin", "GET", "/api/audit?action=create_skill");
    expect(page.body.entries[0]).toMatchObject({ action: "create_skill", via: "mcp", target: { id: skillId, kind: "skill", label: "weekly-report" } });
  });

  it("refuses unsafe paths, oversized files, secrets and bad front matter, saying why, and saves nothing", async () => {
    const before = await skillCount();
    const bad = async (args: Record<string, unknown>, expected: RegExp) => {
      const r = await call("manager", "propose_skill", args);
      expect(r.isError, r.text).toBe(true);
      expect(r.text).toMatch(expected);
    };
    await bad({ skill_md: md("bad-paths"), files: [{ path: "../outside.md", content: "x" }] }, /The skill wasn't saved[\s\S]*unsafe path: "\.\.\/outside\.md" \(empty, \. or \.\. segment\)/);
    await bad({ skill_md: md("bad-paths"), files: [{ path: "/etc/passwd", content: "x" }] }, /unsafe path: "\/etc\/passwd" \(absolute path\)/);
    await bad({ skill_md: md("bad-paths"), files: [{ path: "references\\win.md", content: "x" }] }, /\(backslash\)/);
    await bad({ skill_md: md("too-big"), files: [{ path: "references/big.md", content: "a".repeat(2 * 1024 * 1024 + 1) }] }, /references\/big\.md is 2\.0 MB; a skill file can be at most 2\.0 MB/);
    await bad({ skill_md: md("leaky"), files: [{ path: "references/setup.md", content: `token: ghp_${"a1B2c3D4e5".repeat(4)}\n` }] }, /references\/setup\.md[\s\S]*GitHub token/);
    const leak = await call("manager", "propose_skill", { skill_md: md("leaky"), files: [{ path: "references/setup.md", content: `token: ghp_${"a1B2c3D4e5".repeat(4)}\n` }] });
    expect(leak.text.match(/GitHub token/g)).toHaveLength(1);
    await bad({ skill_md: md("leaky-md", `# Leaky\n\nexport ANTHROPIC_API_KEY=sk-ant-api03-${"x".repeat(40)}\n`) }, /Anthropic API key|API key/);
    await bad({ skill_md: "# No front matter\n\nJust text.\n" }, /SKILL\.md must start with front matter/);
    await bad({ skill_md: "---\nname: No Caps\ndescription: Use when testing names; it lists the steps and the checks to run.\n---\n\nx\n" }, /name must be lowercase letters\/digits with single hyphens/);
    await bad({ skill_md: "---\nname: no-description\n---\n\nx\n" }, /'description' is required/);
    await bad({ skill_md: "---\nname: odd-keys\ndescription: Use when testing keys; it lists the steps and the checks to run.\nfavourite: blue\n---\n\nx\n" }, /unknown frontmatter key 'favourite'/);
    await bad({ skill_md: md("weekly-report") }, /a skill named weekly-report already exists/);
    await bad({ skill_md: md("dup-md"), files: [{ path: "SKILL.md", content: "x" }] }, /send SKILL\.md as skill_md/);
    await bad({ skill_md: md("both"), files: [{ path: "a.md", content: "x", content_base64: "eA==" }] }, /pass content \(text\) or content_base64 \(binary\), one of the two/);
    await bad({ skill_md: md("bad-b64"), files: [{ path: "a.bin", content_base64: "not base64!" }] }, /isn't valid base64/);
    expect(await skillCount()).toBe(before);
    expect((await auditRows("propose_skill")).rows).toHaveLength(1);
  });

  it("is for people who may create skills: rita without Manage skills is refused", async () => {
    // Her personal space (which she manages) doesn't count: it can't own skills.
    const personal = (await db.query<{ id: string }>("INSERT INTO scopes (kind, slug, name, visibility, owner_id) VALUES ('personal', 'personal-rita', 'Rita', 'members', $1) RETURNING id", [id("rita")])).rows[0]!.id;
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner')", [personal, id("rita")]);
    expect((await db.query("SELECT 1 FROM scope_permissions WHERE user_id = $1 AND permission = 'manage_settings'", [id("rita")])).rowCount).toBeGreaterThan(0);
    const r = await call("rita", "propose_skill", { skill_md: md("rita-skill") });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/creating skills needs Manage skills \(Skills managers and Administrators\), or Manage settings in a project/);
    const owned = await call("rita", "propose_skill", { skill_md: md("rita-skill"), project: "vault" });
    expect(owned.text).toBe("project 'vault' not found");
    // A member who can read the project but doesn't manage it can't either.
    expect((await call("alice", "propose_skill", { skill_md: md("alice-skill"), project: "vault" })).text).toMatch(/creating a project's own skill needs Manage settings there, or Manage skills/);
    expect((await db.query("SELECT 1 FROM skills WHERE name LIKE 'rita-%' OR name LIKE 'alice-%'")).rowCount).toBe(0);
  });

  it("lets a project's Project admin create that project's own skill (and only that)", async () => {
    const org = await call("carol", "propose_skill", { skill_md: md("vault-steps") });
    expect(org.text).toMatch(/organisation-wide skills need Manage skills .*pass project/);
    // request_review: as the vault's Project admin her own skill would otherwise publish at once (test/skills-direct-publish.test.ts).
    const r = await call("carol", "propose_skill", { skill_md: md("vault-steps"), project: "vault", summary: "From Claude", request_review: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ name: "vault-steps", owner_project: { slug: "vault", name: "Vault" } });
    expect(r.json.review.who_reviews).toMatch(/who can read Vault, or a Project admin of Vault/);
    expect((await db.query("SELECT owner_scope_id FROM skills WHERE id = $1", [r.json.id])).rows[0].owner_scope_id).toBe(vault);
    // The web says the same: carol may create (her project's) skills, not organisation-wide ones.
    expect((await app.call("carol", "GET", "/api/skills")).body.can).toEqual({ create: true, create_org: false, import: false, publish_directly_projects: ["vault"] });
    expect((await app.call("manager", "GET", "/api/skills")).body.can).toEqual({ create: true, create_org: true, import: true, publish_directly_projects: [] });
  });
});

describe("pushing whole folders", () => {
  it("takes a skill near the 10 MB limit in one call (binary files, as base64), not a transport error", async () => {
    // 5 binary files of 1.95 MB: 9.75 MB of skill, about 13 MB of JSON.
    const blob = (i: number) => Buffer.alloc(Math.floor(1.95 * 1024 * 1024), i + 1).toString("base64");
    const r = await call("manager", "propose_skill", { skill_md: md("big-assets"), files: Array.from({ length: 5 }, (_, i) => ({ path: `assets/blob-${i}.bin`, content_base64: blob(i) })) });
    expect(r.isError, r.text.slice(0, 300)).toBe(false);
    expect(r.json.files).toHaveLength(6);
    // Over the limit, the answer is the skill's own rejection, still not a 413.
    const over = await call("manager", "propose_skill", { skill_md: md("too-many-assets"), files: Array.from({ length: 6 }, (_, i) => ({ path: `assets/blob-${i}.bin`, content_base64: blob(i) })) });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/The skill wasn't saved[\s\S]*the skill is .* at most 10\.0 MB/);
  }, 60_000);

  it("keeps files at the folder's root and in any folder", async () => {
    const r = await call("manager", "propose_skill", {
      skill_md: md("root-files", "# Root files\n\nSee forms.md and docs/guide.md.\n"),
      files: [
        { path: "forms.md", content: "# Forms\n" },
        { path: "LICENSE.txt", content: "MIT\n" },
        { path: "docs/guide.md", content: "# Guide\n" },
      ],
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.json.files).toEqual(["LICENSE.txt", "SKILL.md", "docs/guide.md", "forms.md"]);
  });

  it("treats a pushed-back Claude Code copy (thaliyola-<name>) as an edit of <name>", async () => {
    const orig = await call("manager", "propose_skill", { skill_md: md("synced-one"), files: [{ path: "references/a.md", content: "a\n" }] });
    expect((await app.call("reviewer", "POST", `/api/skills/${orig.json.id}/versions/1/approve`, {})).status).toBe(200);
    const marker = { path: ".thaliyola-skill.json", content: JSON.stringify({ name: "synced-one", version: 1 }) };
    // propose_skill refuses it with the hint, whether or not the marker came along.
    const dup = await call("manager", "propose_skill", { skill_md: md("thaliyola-synced-one"), files: [marker] });
    expect(dup.isError).toBe(true);
    expect(dup.text).toMatch(/installed copy of the team skill 'synced-one'[\s\S]*propose_skill_edit with skill 'synced-one'/);
    expect((await call("manager", "propose_skill", { skill_md: md("brand-new-copy"), files: [marker] })).text).toMatch(/installed copy made by the Claude Code sync/);
    expect((await db.query("SELECT 1 FROM skills WHERE name IN ('thaliyola-synced-one', 'brand-new-copy')")).rowCount).toBe(0);
    // propose_skill_edit takes it: the name is set back, the marker left out.
    const edit = await call("manager", "propose_skill_edit", {
      skill: "synced-one",
      skill_md: md("thaliyola-synced-one", "# synced-one\n\nEdited in ~/.claude/skills.\n"),
      files: [marker, { path: "references/a.md", content: "a, edited\n" }],
      summary: "Edits made in the installed copy",
    });
    expect(edit.isError, edit.text).toBe(false);
    expect(edit.json).toMatchObject({ version: 2, files: ["SKILL.md", "references/a.md"], note: expect.stringMatching(/set back to synced-one/) });
    const skillMd = (
      await db.query<{ data: Buffer }>("SELECT b.data FROM skill_files f JOIN skill_blobs b ON b.sha256 = f.sha256 JOIN skill_versions v ON v.id = f.version_id WHERE v.skill_id = $1 AND v.version = 2 AND f.path = 'SKILL.md'", [orig.json.id])
    ).rows[0]!.data.toString("utf8");
    expect(skillMd).toMatch(/^---\nname: synced-one\n/);
  });
});

describe("propose_skill_edit", () => {
  let skillId: string;
  beforeAll(async () => {
    const r = await call("manager", "propose_skill", { skill_md: md("edit-me"), files: [{ path: "references/old.md", content: "old\n" }, { path: "references/keep.md", content: "keep\n" }] });
    skillId = r.json.id;
    expect((await app.call("reviewer", "POST", `/api/skills/${skillId}/versions/1/approve`, { checked_flags: true })).status).toBe(200);
  });

  it("proposes version 2 by name: a new SKILL.md, a new file and a removal; other files stay", async () => {
    const r = await call("manager", "propose_skill_edit", {
      skill: "edit-me",
      skill_md: md("edit-me", "# edit-me\n\nNow with a checklist in references/checklist.md.\n"),
      files: [{ path: "references/checklist.md", content: "- one\n- two\n" }],
      remove_files: ["references/old.md"],
      summary: "Adds a checklist, drops the old notes",
    });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ name: "edit-me", version: 2, state: "waiting for review", replaced_waiting_version: null, files: ["SKILL.md", "references/checklist.md", "references/keep.md"] });
    expect(r.json.web_url).toBe(`https://kb.example.com/#/skills/${skillId}?tab=versions&v=2`);
    const [row] = (await auditRows("propose_skill_version")).rows;
    expect(row).toMatchObject({ target_id: skillId, target_kind: "skill", target_label: "edit-me", details: { name: "edit-me", version: 2, base_version: 1, files_changed: 3 } });
    expect((await db.query("SELECT tool, via FROM audit_log WHERE request_id = $1 AND tool = 'propose_skill_edit'", [row!.request_id])).rows).toEqual([{ tool: "propose_skill_edit", via: "mcp" }]);
  });

  it("works by id, replaces a waiting version, and refuses empty or impossible edits", async () => {
    const r = await call("manager", "propose_skill_edit", { skill: skillId, files: [{ path: "references/keep.md", content: "kept, changed\n" }], summary: "Touch keep.md" });
    expect(r.json).toMatchObject({ version: 3, replaced_waiting_version: 2 });
    expect((await call("manager", "propose_skill_edit", { skill: "edit-me", summary: "Nothing" })).text).toMatch(/nothing to change/);
    expect((await call("manager", "propose_skill_edit", { skill: "edit-me", remove_files: ["references/missing.md"], summary: "x" })).text).toMatch(/references\/missing\.md isn't a file of edit-me/);
    expect((await call("manager", "propose_skill_edit", { skill: "edit-me", files: [{ path: "../x.md", content: "x" }], summary: "x" })).text).toMatch(/unsafe path/);
    expect((await call("manager", "propose_skill_edit", { skill: "no-such-skill", summary: "x", skill_md: md("no-such-skill") })).text).toMatch(/no skill 'no-such-skill' that you manage/);
  });

  it("won't silently drop someone else's waiting version, and says whose it is", async () => {
    // The admin's version 4 waits; the manager's edit would be built on the published v1 and replace it.
    const theirs = await app.call("admin", "POST", `/api/skills/${skillId}/versions`, { files: [{ path: "references/admin.md", text: "admin notes\n" }], summary: "Admin's notes" });
    expect(theirs.status, JSON.stringify(theirs.body)).toBe(200);
    const refused = await call("manager", "propose_skill_edit", { skill: "edit-me", files: [{ path: "references/keep.md", content: "mine\n" }], summary: "Mine" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/version 4 of edit-me, proposed by admin@example\.com \("Admin's notes"\), is waiting for review[\s\S]*replace_waiting: true/);
    const replaced = await call("manager", "propose_skill_edit", { skill: "edit-me", files: [{ path: "references/keep.md", content: "mine\n" }], summary: "Mine", replace_waiting: true });
    expect(replaced.json).toMatchObject({ version: 5, replaced_waiting_version: 4, replaced: { version: 4, author: "admin@example.com", summary: "Admin's notes" } });
    expect(replaced.json.files).not.toContain("references/admin.md");
  });

  it("is refused to people who can't manage the skill (and hides owned skills from non-readers)", async () => {
    expect((await call("rita", "propose_skill_edit", { skill: "edit-me", skill_md: md("edit-me", "# hijack\n"), summary: "x" })).text).toMatch(/no skill 'edit-me' that you manage/);
    // An Auditor sees it but doesn't manage it.
    expect((await call("auditor", "propose_skill_edit", { skill: "edit-me", skill_md: md("edit-me", "# audit\n"), summary: "x" })).text).toMatch(/changing this skill needs Manage skills/);
    // The vault's own skill doesn't exist for a Skills manager who can't read the vault.
    expect((await call("manager", "propose_skill_edit", { skill: "vault-steps", skill_md: md("vault-steps", "# x\n"), summary: "x" })).text).toMatch(/no skill 'vault-steps' that you manage/);
  });
});

describe("with Approvals from Claude switched off, approval stays with people in the web app (as in 1.0.1)", () => {
  // Approvals from Claude is on by default (test/mcp-approvals.test.ts); here an Administrator switched it off.
  const setOff = (off: boolean) =>
    off
      ? db.query("INSERT INTO system_settings (key, value) VALUES ('mcp_approvals', 'false') ON CONFLICT (key) DO UPDATE SET value = 'false'")
      : db.query("DELETE FROM system_settings WHERE key = 'mcp_approvals'");
  beforeAll(() => setOff(true));
  afterAll(() => setOff(false));

  it("offers only the review tools, which refuse, and the core review functions refuse an agent", async () => {
    const c = await mcp("reviewer");
    const names = (await c.listTools()).tools.map((t) => t.name);
    await c.close();
    expect(names.filter((n) => /approve|publish_skill|reject_skill|rollback|review_skill/.test(n)).sort()).toEqual(["approve_skill_import", "review_skill_version"]);
    const r = await call("manager", "propose_skill", { skill_md: md("agent-proof") });
    const viaTool = await call("reviewer", "review_skill_version", { skill: "agent-proof", version: 1, decision: "approve", checked_flags: true });
    expect(viaTool.isError).toBe(true);
    expect(viaTool.text).toMatch(/a person's decision in the Thaliyola web app[\s\S]*switched off Approvals from Claude/);
    const reviewer = (await actorById(db, id("reviewer")))!;
    const skill = r.json.id as string;
    // Every review decision, as an agent (MCP) and as a REST call with an API token: refused before anything else.
    const decisions: [string, (c: RequestContext) => Promise<unknown>][] = [
      ["approveSkillVersion", (c) => approveSkillVersion(c, skill, 1, { checked_flags: true })],
      ["rejectSkillVersion", (c) => rejectSkillVersion(c, skill, 1, "no")],
      ["approveGuidanceGroup", (c) => approveGuidanceGroup(c, "a".repeat(64))],
      ["rollbackSkill", (c) => rollbackSkill(c, skill, 1)],
      ["releaseHold", (c) => releaseHold(c, skill)],
      ["decideAudienceChange", (c) => decideAudienceChange(c, skill, "confirm")],
      ["approveImportVersions", (c) => approveImportVersions(c, "00000000-0000-0000-0000-000000000000")],
      ["decideCollectionChange", (c) => decideCollectionChange(c, "no-such-collection", "approve")],
    ];
    for (const [name, decide] of decisions) {
      await expect(decide({ db, settings, actor: reviewer, viaAgent: true }), name).rejects.toThrow(ForbiddenError);
      await expect(decide({ db, settings, actor: reviewer, viaAgent: true }), name).rejects.toThrow(/a person's decision in the Thaliyola web app/);
      await expect(decide({ db, settings, actor: reviewer, viaToken: true }), name).rejects.toThrow(/API and OAuth tokens, which Claude and scripts use, can't approve/);
    }
    expect((await db.query("SELECT state FROM skill_versions WHERE skill_id = $1", [r.json.id])).rows[0].state).toBe("pending");
    // The same person in the web app approves it.
    expect((await app.call("reviewer", "POST", `/api/skills/${r.json.id}/versions/1/approve`, {})).status).toBe(200);
  });

  it("refuses review decisions sent over REST with a personal API token (what Claude Code holds), and keeps reads working", async () => {
    const r = await call("manager", "propose_skill", { skill_md: md("token-proof") });
    const { token } = await createApiToken(db, id("reviewer"), "Claude Code on laptop");
    const send = async (method: string, p: string, body?: unknown) => {
      const res = await fetch(app.base + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, body: (await res.json()) as any };
    };
    const approve = await send("POST", `/api/skills/${r.json.id}/versions/1/approve`, {});
    expect(approve.status).toBe(403);
    expect(approve.body.error).toMatch(/signed in to the Thaliyola web app[\s\S]*API and OAuth tokens/);
    expect((await send("POST", `/api/skills/${r.json.id}/versions/1/reject`, { reason: "no" })).status).toBe(403);
    expect((await send("POST", `/api/skills/${r.json.id}/rollback`, { version: 1 })).status).toBe(403);
    expect((await send("POST", `/api/skills/${r.json.id}/audience-change`, { decision: "confirm" })).status).toBe(403);
    // The token still reads, and still writes what isn't a review decision.
    expect((await send("GET", `/api/skills/${r.json.id}`)).status).toBe(200);
    expect((await db.query("SELECT state FROM skill_versions WHERE skill_id = $1", [r.json.id])).rows[0].state).toBe("pending");
    // The same reviewer, signed in to the app, approves it.
    expect((await app.call("reviewer", "POST", `/api/skills/${r.json.id}/versions/1/approve`, {})).status).toBe(200);
  });
});

describe("the web editor's create path", () => {
  it("lets a Project admin create their project's own skill with files over POST /api/skills, and refuses one without a project", async () => {
    const without = await app.call("carol", "POST", "/api/skills", { skill_md: md("carol-web"), files: [{ path: "references/a.md", text: "A\n" }] });
    expect(without.status).toBe(403);
    expect(without.body.error).toMatch(/organisation-wide|Manage skills/);
    const big = "x".repeat(1536 * 1024); // over the 1 MB default body limit: the editor's path takes a whole skill
    const r = await app.call("carol", "POST", "/api/skills", {
      skill_md: md("carol-web"),
      project: "vault",
      files: [
        { path: "references/a.md", text: "A\n" },
        { path: "references/big.md", text: big },
        { path: "scripts/run.sh", text: "#!/bin/sh\necho hi\n" },
      ],
      summary: "From the web",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ name: "carol-web", version: 1, state: "pending", owner_scope_id: vault });
    expect(r.body.files.map((f: { path: string }) => f.path)).toEqual(["SKILL.md", "references/a.md", "references/big.md", "scripts/run.sh"]);
    // A member who doesn't manage the vault can't.
    expect((await app.call("alice", "POST", "/api/skills", { skill_md: md("alice-web"), project: "vault" })).status).toBe(403);
  });
});

describe("assign_skill and unassign_skill", () => {
  let skillId: string;
  beforeAll(async () => {
    const r = await call("manager", "propose_skill", { skill_md: md("give-me"), collection: "giving" });
    skillId = r.json.id;
    expect((await app.call("reviewer", "POST", `/api/skills/${skillId}/versions/1/approve`, {})).status).toBe(200);
  });

  it("shows who would gain it in a dry run, saving nothing (audited as a preview)", async () => {
    const r = await call("manager", "assign_skill", { skill: "give-me", to: "everyone", dry_run: true });
    expect(r.isError, r.text).toBe(false);
    expect(r.json).toMatchObject({ dry_run: true, nothing_saved: true, skill: { name: "give-me" }, results: [{ label: "Everyone", already: false }] });
    expect(r.json.people_gaining).toBeGreaterThan(5);
    expect((await db.query("SELECT 1 FROM skill_assignments WHERE skill_id = $1", [skillId])).rowCount).toBe(0);
    const [row] = (await auditRows("preview_skill_assignment")).rows;
    expect(row).toMatchObject({ target_id: skillId, via: "mcp", is_read: true });
    expect((await auditRows("assign_skill")).rows).toEqual([]);
  });

  it("gives it to a team, roles and a project, mirroring the web's inputs, and audits each", async () => {
    await db.query("INSERT INTO teams (slug, name) VALUES ('platform', 'Platform') ON CONFLICT DO NOTHING");
    const team = await call("manager", "assign_skill", { skill: "give-me", to: "team", team: "Platform" });
    expect(team.json.results).toEqual([{ label: "The Platform team", created: true, gains: { people: 0, audiences: ["The Platform team"] } }]);
    const roles = await call("manager", "assign_skill", { skill: skillId, to: "project_role", roles: ["Contributor", "Reviewer"] });
    expect(roles.json.results.map((x: { label: string }) => x.label)).toEqual(["Contributor in any project", "Reviewer in any project"]);
    const again = await call("manager", "assign_skill", { skill: skillId, to: "project_role", roles: ["Contributor"] });
    expect(again.json.results).toEqual([expect.objectContaining({ created: false, gains: { people: 0, audiences: [] } })]);
    expect(again.json.assignments.map((a: { label: string }) => a.label)).toEqual(["The Platform team", "Contributor in any project", "Reviewer in any project"]);
    expect((await call("manager", "assign_skill", { skill: skillId, to: "org_role" })).text).toBe("to org_role needs roles");
    expect((await call("manager", "assign_skill", { skill: skillId, to: "everyone", roles: ["Contributor"] })).text).toMatch(/roles go with to: org_role or project_role/);
    expect((await call("manager", "assign_skill", { skill: skillId, collection: "giving", to: "everyone" })).text).toMatch(/one of the two/);
    const rows = (await auditRows("assign_skill")).rows.filter((r) => !r.via);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ target_id: skillId, target_kind: "skill", target_label: "give-me", details: { name: "give-me", audience: "project_role", role: "reviewer" } });
  });

  it("takes it away by the same inputs or by id, and lists assignments when given neither", async () => {
    const list = await call("manager", "unassign_skill", { skill: "give-me" });
    expect(list.json).toMatchObject({ changed: false });
    expect(list.json.assignments).toHaveLength(3);
    const byTo = await call("manager", "unassign_skill", { skill: "give-me", to: "project_role", roles: ["Reviewer"] });
    expect(byTo.json.removed).toEqual(["Reviewer in any project"]);
    const teamId = list.json.assignments.find((a: { label: string }) => a.label === "The Platform team").id;
    expect((await call("manager", "unassign_skill", { skill: "give-me", assignment_id: teamId })).json.removed).toEqual(["The Platform team"]);
    expect((await call("manager", "unassign_skill", { skill: "give-me", to: "everyone" })).text).toMatch(/no such assignment; current: .*Contributor in any project/);
    const [row] = (await auditRows("unassign_skill")).rows.filter((r) => !r.via);
    expect(row).toMatchObject({ target_id: skillId, target_kind: "skill", target_label: "give-me", details: { name: "give-me", audience: "team", team: "Platform" } });
    expect((await auditRows("list_skill_assignments")).rows[0]).toMatchObject({ via: "mcp", is_read: true });
  });

  it("gives a whole collection, with a dry run", async () => {
    const dry = await call("manager", "assign_skill", { collection: "giving", to: "everyone", dry_run: true });
    expect(dry.json).toMatchObject({ dry_run: true, collection: { slug: "giving" }, results: [{ label: "Everyone" }] });
    expect((await db.query("SELECT 1 FROM skill_assignments a JOIN skill_collections c ON c.id = a.collection_id WHERE c.slug = 'giving'")).rowCount).toBe(0);
    const real = await call("manager", "assign_skill", { collection: "giving", to: "everyone" });
    expect(real.json.results).toEqual([expect.objectContaining({ label: "Everyone", created: true })]);
    expect(real.json.assignments.map((a: { label: string }) => a.label)).toEqual(["Everyone"]);
    expect((await auditRows("map_skill_collection")).rows[0]).toMatchObject({ target_kind: "skill_collection" });
    expect((await call("manager", "unassign_skill", { collection: "giving", to: "everyone" })).json.removed).toEqual(["Everyone"]);
  });

  it("is refused without Manage skills", async () => {
    expect((await call("rita", "assign_skill", { skill: "give-me", to: "everyone" })).text).toMatch(/no skill 'give-me' that you manage/);
    expect((await call("auditor", "assign_skill", { skill: "give-me", to: "everyone" })).text).toMatch(/changing this skill needs Manage skills/);
    expect((await call("auditor", "unassign_skill", { skill: "give-me", to: "project_role", roles: ["Contributor"] })).text).toMatch(/changing this skill needs Manage skills/);
    expect((await call("rita", "assign_skill", { collection: "giving", to: "everyone" })).text).toBe("skill collection 'giving' not found");
  });

  it("never names a members-only project to someone who can't read it", async () => {
    // An Administrator gives give-me to the members-only vault; the Skills manager can't read the vault.
    expect((await app.call("admin", "POST", `/api/skills/${skillId}/assignments`, { audience: "project", project: "vault" })).status).toBe(200);
    const seen = await call("manager", "unassign_skill", { skill: "give-me" });
    expect(seen.json.assignments.map((a: { label: string }) => a.label)).toContain("A members-only project (and the projects under it)");
    expect(seen.text).not.toMatch(/Vault|vault/);
    const assigned = await call("manager", "assign_skill", { skill: "give-me", to: "org_role", roles: ["Auditor"] });
    expect(assigned.text).not.toMatch(/Vault|vault/);
    // Naming it doesn't help: it's "not found", as on the web.
    expect((await call("manager", "assign_skill", { skill: "give-me", to: "project", project: "vault", dry_run: true })).text).toMatch(/project 'vault' not found/);
    // The admin, who reads it, sees its name.
    expect((await call("admin", "unassign_skill", { skill: "give-me" })).text).toMatch(/Vault \(and the projects under it\)/);
  });

  it("keeps a project's own skill inside the project; its Project admin assigns it there", async () => {
    const own = await call("carol", "assign_skill", { skill: "vault-steps", to: "project", dry_run: true });
    expect(own.json.results).toEqual([{ label: "Vault (and the projects under it)", already: false, gains: { people: 2, audiences: ["Vault (and the projects under it)"] } }]);
    expect((await call("carol", "assign_skill", { skill: "vault-steps", to: "everyone" })).text).toMatch(/only to that project and the projects under it/);
    const saved = await call("carol", "assign_skill", { skill: "vault-steps", to: "project_role", roles: ["Viewer"] });
    expect(saved.json.results[0]).toMatchObject({ label: "Viewer in Vault", created: true });
    expect(saved.json.note).toBe("Nobody gets it until a reviewer publishes its first version in the web app.");
  });

  it("counts each person once across several roles, in a dry run and when saving", async () => {
    // bob is both an Auditor and a Skills manager: he'd gain the skill once, not once per role.
    await db.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'auditor'), ($1, 'skills_manager') ON CONFLICT DO NOTHING", [id("bob")]);
    const fresh = await call("manager", "propose_skill", { skill_md: md("overlap") });
    expect((await app.call("reviewer", "POST", `/api/skills/${fresh.json.id}/versions/1/approve`, {})).status).toBe(200);
    const one = async (role: string) => (await call("manager", "assign_skill", { skill: "overlap", to: "org_role", roles: [role], dry_run: true })).json.people_gaining as number;
    const auditors = await one("auditor");
    const managers = await one("skills_manager");
    expect([auditors, managers]).toEqual([2, 3]);
    const both = await call("manager", "assign_skill", { skill: "overlap", to: "org_role", roles: ["auditor", "skills_manager"], dry_run: true });
    expect(both.json.people_gaining).toBe(4);
    expect(both.json.results.map((r: { gains: { people: number } }) => r.gains.people)).toEqual([2, 2]);
    expect(both.json.people_gaining_note).toMatch(/Each person counts once/);
    const everyone = await call("manager", "assign_skill", { skill: "overlap", to: "everyone", dry_run: true });
    expect(both.json.people_gaining).toBeLessThanOrEqual(everyone.json.people_gaining);
    const saved = await call("manager", "assign_skill", { skill: "overlap", to: "org_role", roles: ["auditor", "skills_manager"] });
    expect(saved.json.people_gaining).toBe(4);
    // A collection counts the same way.
    await call("manager", "propose_skill", { skill_md: md("overlap-coll"), collection: "overlapping" });
    await db.query("UPDATE skill_versions v SET state = 'published' FROM skills s WHERE s.id = v.skill_id AND s.name = 'overlap-coll'");
    await db.query("UPDATE skills s SET current_version_id = v.id FROM skill_versions v WHERE v.skill_id = s.id AND s.name = 'overlap-coll'");
    const coll = await call("manager", "assign_skill", { collection: "overlapping", to: "org_role", roles: ["auditor", "skills_manager"], dry_run: true });
    expect(coll.json.people_gaining).toBe(4);
    const collSaved = await call("manager", "assign_skill", { collection: "overlapping", to: "org_role", roles: ["auditor", "skills_manager"] });
    expect(collSaved.json.people_gaining).toBe(4);
  });

  it("never names a members-only project to someone who can't read it, for collections too", async () => {
    // The admin gives the giving collection to the members-only vault; the Skills manager can't read the vault.
    expect((await app.call("admin", "POST", "/api/skill-collections/giving/assignments", { audience: "project", project: "vault" })).status).toBe(200);
    const listed = await call("manager", "unassign_skill", { collection: "giving" });
    expect(listed.json.assignments.map((a: { label: string }) => a.label)).toContain("A members-only project (and the projects under it)");
    expect(listed.text).not.toMatch(/Vault|vault/);
    const dry = await call("manager", "assign_skill", { collection: "giving", to: "org_role", roles: ["auditor"], dry_run: true });
    expect(dry.isError, dry.text).toBe(false);
    expect(dry.text).not.toMatch(/Vault|vault/);
    const saved = await call("manager", "assign_skill", { collection: "giving", to: "org_role", roles: ["auditor"] });
    expect(saved.json.assignments.map((a: { label: string }) => a.label)).toEqual(expect.arrayContaining(["A members-only project (and the projects under it)", "Auditor (organisation role)"]));
    expect(saved.text).not.toMatch(/Vault|vault/);
    expect((await call("admin", "unassign_skill", { collection: "giving" })).text).toMatch(/Vault \(and the projects under it\)/);
  });
});

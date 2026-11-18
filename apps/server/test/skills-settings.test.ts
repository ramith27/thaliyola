import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Settings } from "../src/config.js";
import { isReadAction } from "../src/core/audit-log.js";
import { deliveryState } from "../src/core/skills/delivery.js";
import { updateSystemSettings } from "../src/core/system.js";
import { actorById } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { mcpCatalog } from "../src/mcp/catalog.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";
import { startApp, type TestApp } from "./skills-helpers.js";

/**
 * The Skills for Claude system settings (delivery mode and self-approval): validated, audited with from and to, and
 * read fresh by every instance; the roles catalogue; and how the audit log classifies and labels skill actions.
 */

let db: Db;
let app: TestApp;
const settings: Settings = { ...TEST_SETTINGS };

beforeAll(async () => {
  ({ db } = await freshDb());
  app = await startApp(db, settings);
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("Skills for Claude settings", () => {
  it("validate, audit from and to, and take effect on another instance without a reload", async () => {
    const admin = { db, settings, actor: (await actorById(db, app.ids.admin))! };
    await expect(updateSystemSettings(admin, { skills_delivery: "sometimes" })).rejects.toThrow(/one of on, admins, off/);
    await expect(updateSystemSettings(admin, { skills_self_approval: "yes" })).rejects.toThrow();
    const view = await updateSystemSettings(admin, { skills_delivery: "admins" });
    expect(view.settings.find((s) => s.key === "skills_delivery")).toMatchObject({ value: "admins", group: "skills", env: "SKILLS_ENABLED" });
    const row = (await db.query("SELECT details FROM audit_log WHERE tool = 'update_system_settings' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(JSON.stringify(row.details)).toMatch(/skills_delivery/);
    expect(JSON.stringify(row.details)).toMatch(/admins/);
    // Another instance, whose settings still say "on", reads the row.
    const other = { db, settings: { ...TEST_SETTINGS, skillsDelivery: "on" as const }, actor: (await actorById(db, app.ids.alice))! };
    expect((await deliveryState(other)).state).toBe("admins_only");
    expect((await app.call("manager", "GET", "/api/me")).body.skills).toEqual({ delivery: "admins", send_to_claude: true, state: "admins_only" });
    await updateSystemSettings(admin, { skills_delivery: null });
    expect((await deliveryState(other)).state).toBe("on");
    // Not for anyone else.
    expect((await app.call("manager", "PATCH", "/api/system/settings", { skills_delivery: "off" })).status).toBe(403);
  });

  it("environment default: SKILLS_ENABLED=false switches delivery off until an Administrator changes it", async () => {
    const ctx = { db, settings: { ...TEST_SETTINGS, skillsDelivery: "off" as const }, actor: (await actorById(db, app.ids.alice))! };
    expect(await deliveryState(ctx)).toMatchObject({ mode: "off", state: "off", message: "Skills are switched off by an Administrator." });
  });

  it("the Connect page's catalog lists the skill tools, with the skills bullet unless delivery is off", async () => {
    const ctx = { db, settings: { ...TEST_SETTINGS }, actor: (await actorById(db, app.ids.alice))! };
    const on = await mcpCatalog(ctx);
    expect(on.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["list_skills", "get_skill", "get_skill_file", "report_skill_problem"]));
    expect(on.instructions).toMatch(/^TEAM SKILLS FIRST\./);
    const off = await mcpCatalog({ ...ctx, settings: { ...TEST_SETTINGS, skillsDelivery: "off" } });
    expect(off.instructions).not.toMatch(/TEAM SKILLS/);
    expect(off.tools).toHaveLength(on.tools.length);
  });

  it("the Connect page shows the sync command, the hook and the last sync check", async () => {
    const c = await app.call("alice", "GET", "/api/connect-info");
    expect(c.body.skills).toMatchObject({
      delivery: "on",
      state: "on",
      script_url: expect.stringMatching(/\/skills-sync\.py$/),
      sync_command: expect.stringMatching(/connect\.sh \| sh -s -- --skills$/),
      last_sync_at: null,
    });
    expect(c.body.skills.hook_snippet.hooks.SessionStart[0].hooks[0].command).toBe('python3 -I "$HOME/.config/thaliyola/skills-sync.py" --quiet --max-age 300 --budget 20');
    const script = await fetch(`${app.base}/skills-sync.py`);
    expect(script.status).toBe(200);
    const text = await script.text();
    expect(text).toContain(`DEFAULT_URL = "${app.base}"`);
    expect(text).not.toContain("__THALIYOLA_URL__");
  });
});

describe("roles and the audit log", () => {
  it("adds Manage skills and Review skills, a built-in Skills manager role, and both for Administrators", async () => {
    const roles = (await app.call("admin", "GET", "/api/roles")).body;
    const list = (roles.roles ?? roles) as { key: string; permissions: string[] }[];
    expect(list.find((r) => r.key === "skills_manager")!.permissions.sort()).toEqual(["manage_skills", "review_skills"]);
    expect(list.find((r) => r.key === "admin")!.permissions).toEqual(expect.arrayContaining(["manage_skills", "review_skills"]));
    expect((await app.call("manager", "GET", "/api/me")).body.permissions).toEqual(expect.arrayContaining(["manage_skills", "review_skills"]));
  });

  it("classifies skill reads as reads, and changes and downloads as changes", () => {
    for (const a of ["list_skills", "get_skill", "get_skill_file", "list_my_skills", "get_skill_detail", "get_skills_sync", "get_skill_bundle", "list_all_skills", "get_skill_usage", "list_skill_review", "get_skill_review_counts"]) expect(isReadAction(a), a).toBe(true);
    for (const a of ["report_skill_problem", "download_skill", "set_skill_preference", "publish_skill_version", "assign_skill", "sync_skill_source", "import_skills"]) expect(isReadAction(a), a).toBe(false);
  });

  it("labels a project's own skill with its project, and never records a token", async () => {
    const vault = (await db.query<{ id: string }>("INSERT INTO scopes (kind, slug, name, visibility) VALUES ('project', 'vault', 'Vault', 'members') RETURNING id")).rows[0]!.id;
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner')", [vault, app.ids.carol]);
    const c = await app.call("carol", "POST", "/api/skills", { skill_md: "---\nname: vault-audit\ndescription: Use when checking how the audit log labels a project's own skill.\n---\n\n# x\n", project: "vault", summary: "New", request_review: true });
    expect(c.status).toBe(200);
    const log = await app.call("admin", "GET", "/api/audit?action=create_skill");
    const entry = log.body.entries.find((e: { action: string }) => e.action === "create_skill");
    expect(entry.target).toMatchObject({ kind: "skill", label: "vault-audit (in Vault)" });
    expect(entry.details).toMatchObject({ name: "vault-audit", project: "vault", version: 1, state: "pending" });
    const src = await app.call("manager", "POST", "/api/skill-sources", { name: "Tokens", provider: "github", repository: "o/r", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB" });
    // Without CONNECTIONS_KEY the token can't be stored, and the refusal doesn't echo it.
    expect(src.status).toBe(400);
    expect(JSON.stringify(src.body)).not.toContain("ghp_");
    const rows = (await db.query("SELECT details::text AS d FROM audit_log WHERE details IS NOT NULL")).rows.map((r) => r.d).join("\n");
    expect(rows).not.toContain("ghp_abcdefghij");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, listManagedProjects, setProjectsVisibility } from "../src/core/admin.js";
import { setUserRoles } from "../src/core/roles.js";
import { listProjects } from "../src/core/scopes.js";
import { applySystemPreset, getSystemSettings, loadSystemSettings, SYSTEM_PRESETS, updateSystemSettings } from "../src/core/system.js";
import type { Settings } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
// Each test file's own settings object: system settings change it in place.
const settings: Settings = { ...TEST_SETTINGS, slackWebhookUrl: undefined, mailFrom: "Thaliyola <t@example.com>", defaultProjectVisibility: "members" };
const as = (email: string) => ctxFor(db, { email, settings });

beforeAll(async () => {
  ({ db } = await freshDb());
});
afterAll(() => db.end());

describe("system settings", () => {
  it("are for admins only", async () => {
    await expect(getSystemSettings(await as("someone@example.com"))).rejects.toThrow(/only admins/);
    await expect(updateSystemSettings(await as("someone@example.com"), { require_approval: true })).rejects.toThrow(/only admins/);
    const view = await getSystemSettings(await as("admin@example.com"));
    expect(view.settings.find((s) => s.key === "require_approval")).toMatchObject({ value: false, source: "environment", env: "REQUIRE_APPROVAL" });
    expect(view.environment).toMatchObject({ auth_mode: "dev" });
    expect(view.counts.projects).toBeGreaterThan(0);
  });

  it("apply at once, override the environment until reset, and reach other instances", async () => {
    const admin = await as("admin@example.com");
    const view = await updateSystemSettings(admin, { require_approval: true, digest_hour: 17, default_project_visibility: "team" });
    expect(settings).toMatchObject({ requireApproval: true, digestHour: 17, defaultProjectVisibility: "team" });
    expect(view.settings.find((s) => s.key === "digest_hour")).toMatchObject({ value: 17, source: "here", env_value: TEST_SETTINGS.digestHour, updated_by: "admin@example.com" });

    // Another server instance picks them up from the database.
    const other: Settings = { ...TEST_SETTINGS };
    await loadSystemSettings(db, other);
    expect(other).toMatchObject({ requireApproval: true, digestHour: 17 });

    await updateSystemSettings(admin, { digest_hour: null, default_project_visibility: null });
    expect(settings).toMatchObject({ digestHour: TEST_SETTINGS.digestHour, defaultProjectVisibility: "members", requireApproval: true });
    await updateSystemSettings(admin, { require_approval: null });
    expect(settings.requireApproval).toBe(false);
  });

  it("check values, and never send secrets back", async () => {
    const admin = await as("admin@example.com");
    await expect(updateSystemSettings(admin, { digest_hour: 24 })).rejects.toThrow(/between 0 and 23/);
    await expect(updateSystemSettings(admin, { duplicate_threshold: "lots" })).rejects.toThrow(/a number/);
    await expect(updateSystemSettings(admin, { default_project_visibility: "public" })).rejects.toThrow(/one of members, team/);
    await expect(updateSystemSettings(admin, { database_url: "x" })).rejects.toThrow(/unknown setting/);
    await expect(updateSystemSettings(admin, { slack_webhook_url: "https://evil.example.com/x" })).rejects.toThrow(/hooks.slack.com/);
    const view = await updateSystemSettings(admin, { slack_webhook_url: "https://hooks.slack.com/services/T000/B000/abcdWXYZ" });
    expect(settings.slackWebhookUrl).toMatch(/abcdWXYZ$/);
    expect(view.settings.find((s) => s.key === "slack_webhook_url")).toMatchObject({ value: null, is_set: true, hint: "…WXYZ" });
    expect(JSON.stringify(view)).not.toContain("hooks.slack.com/services");
    await updateSystemSettings(admin, { slack_webhook_url: "" });
    expect(settings.slackWebhookUrl).toBeUndefined();
  });
});

describe("system presets", () => {
  it("show exactly what each would change, and apply only that", async () => {
    const admin = await as("admin@example.com");
    // Start from Thaliyola's defaults.
    await applySystemPreset(admin, "default");
    let view = await getSystemSettings(admin);
    expect(view.presets.map((p) => p.name)).toEqual(["looser", "default", "stricter"]);
    expect(view.presets.find((p) => p.name === "default")).toMatchObject({ current: true, changes: [] });
    const stricter = view.presets.find((p) => p.name === "stricter")!;
    expect(stricter.current).toBe(false);
    expect(stricter.changes).toEqual([
      { key: "direct_publish", label: expect.any(String), from: true, to: false },
      { key: "session_ttl_hours", label: expect.any(String), from: 168, to: 12 },
      { key: "duplicate_threshold", label: expect.any(String), from: 0.6, to: 0.5 },
      { key: "duplicate_similarity", label: expect.any(String), from: 0.8, to: 0.75 },
    ]);

    // Settings outside the presets are never touched.
    await updateSystemSettings(admin, { digest_hour: 6 });
    const out = await applySystemPreset(admin, "stricter");
    expect(out.changed).toEqual(["direct_publish", "session_ttl_hours", "duplicate_threshold", "duplicate_similarity"]);
    expect(settings).toMatchObject({ directPublish: false, sessionTtlHours: 12, duplicateThreshold: 0.5, digestHour: 6, requireApproval: true });
    view = await getSystemSettings(admin);
    expect(view.presets.find((p) => p.name === "stricter")!.current).toBe(true);
    // A preset already in place changes nothing.
    expect((await applySystemPreset(admin, "stricter")).changed).toEqual([]);

    const looser = await applySystemPreset(admin, "looser");
    expect(Object.keys(SYSTEM_PRESETS.looser.values).sort()).toEqual(expect.arrayContaining(looser.changed.sort()));
    expect(settings).toMatchObject({ requireApproval: false, directPublish: true, defaultProjectVisibility: "team", sessionTtlHours: 720 });

    // Back to the environment for the tests after this one.
    await updateSystemSettings(admin, Object.fromEntries([...Object.keys(SYSTEM_PRESETS.default.values), "digest_hour"].map((k) => [k, null])));
  });

  it("are for admins only and must exist", async () => {
    await expect(applySystemPreset(await as("someone@example.com"), "looser")).rejects.toThrow(/only admins/);
    await expect(applySystemPreset(await as("admin@example.com"), "toString")).rejects.toThrow(/unknown preset/);
    await expect(applySystemPreset(await as("admin@example.com"), "anything")).rejects.toThrow(/unknown preset/);
  });
});

describe("project management", () => {
  it("makes new projects members-only, owned by whoever created them", async () => {
    const admin = await as("admin@example.com");
    await setUserRoles(admin, (await as("pc@example.com")).actor.id, ["project_creator"]);
    const creator = await as("pc@example.com");
    expect(await adminCreateProject(creator, { slug: "quiet", name: "Quiet" })).toMatchObject({ visibility: "members" });
    expect((await listProjects(creator)).map((p) => p.slug)).toContain("quiet");
    expect((await listProjects(await as("someone@example.com"))).map((p) => p.slug)).not.toContain("quiet");
    const mine = await listManagedProjects(creator);
    expect(mine.projects.map((p: { slug: string }) => p.slug)).toEqual(["quiet"]);
    expect(mine.projects[0]).toMatchObject({ owners: ["pc@example.com"], visibility: "members", can_manage: true });
  });

  it("lets admins see every project and change visibility in bulk; others only their own", async () => {
    const admin = await as("admin@example.com");
    const all = await listManagedProjects(admin);
    expect(all.projects.length).toBeGreaterThanOrEqual(3);
    const open = all.projects.filter((p: { visibility: string }) => p.visibility === "team").map((p: { slug: string }) => p.slug);
    expect(open.length).toBeGreaterThan(0);
    const out = await setProjectsVisibility(admin, open, "members");
    expect(out.changed).toBe(open.length);
    expect((await listManagedProjects(admin)).projects.every((p: { visibility: string }) => p.visibility === "members")).toBe(true);

    const creator = await as("pc@example.com");
    const mixed = await setProjectsVisibility(creator, ["quiet", "order-service"], "team");
    expect(mixed.results).toEqual([{ slug: "quiet", ok: true }, expect.objectContaining({ slug: "order-service", ok: false })]);
  });
});

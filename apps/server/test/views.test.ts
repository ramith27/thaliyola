import { mkdtempSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { SYSTEM_PRESETS, updateSystemSettings } from "../src/core/system.js";
import { upsertUser } from "../src/core/users.js";
import { createView, deleteView, listViews, MAX_VIEWS_PER_AREA, saveViews, updateView } from "../src/core/views.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;
const as = (email: string) => ctxFor(db, { email });

beforeAll(async () => {
  ({ db } = await freshDb());
  const web = mkdtempSync(path.join(tmpdir(), "thaliyola-web-"));
  writeFileSync(path.join(web, "index.html"), "<!doctype html><title>Thaliyola</title>");
  server = createApp({ db, authenticate: devAuthenticator("user=alice@example.com,bob=bob@example.com,admin=admin@example.com"), settings: TEST_SETTINGS, webDist: web }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

async function call(token: string | null, method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("saved views", () => {
  it("saves, lists, renames, re-filters and deletes a person's own views", async () => {
    const me = await as("views-owner@example.com");
    const v = await createView(me, { area: "review", name: "  My   checkout queue ", filters: { scope: "order-service", category: "new", q: "" } });
    expect(v).toMatchObject({ area: "review", name: "My checkout queue", filters: { scope: "order-service", category: "new" }, is_default: false });
    expect((await listViews(me, "review")).views.map((x) => x.name)).toEqual(["My checkout queue"]);
    expect((await listViews(me, "inbox")).views).toEqual([]);

    const renamed = await updateView(me, v.id, { name: "Checkout", filters: { state: "approved" } });
    expect(renamed).toMatchObject({ name: "Checkout", filters: { state: "approved" } });
    await deleteView(me, v.id);
    expect((await listViews(me, "review")).views).toEqual([]);
  });

  it("keeps one default per page", async () => {
    const me = await as("views-default@example.com");
    const a = await createView(me, { area: "inbox", name: "New", filters: { status: "new" }, is_default: true });
    const b = await createView(me, { area: "inbox", name: "Dismissed", filters: { status: "dismissed" } });
    // Another page's default is untouched.
    const c = await createView(me, { area: "security", name: "Critical", filters: { severity: "critical" }, is_default: true });
    await updateView(me, b.id, { is_default: true });
    const inbox = (await listViews(me, "inbox")).views;
    expect(inbox.find((x) => x.id === a.id)!.is_default).toBe(false);
    expect(inbox.find((x) => x.id === b.id)!.is_default).toBe(true);
    expect((await listViews(me, "security")).views.find((x) => x.id === c.id)!.is_default).toBe(true);
    // A new default replaces the old one too.
    await createView(me, { area: "inbox", name: "Filed", filters: { status: "filed" }, is_default: true });
    expect((await listViews(me, "inbox")).views.filter((x) => x.is_default).map((x) => x.name)).toEqual(["Filed"]);
    await updateView(me, b.id, { is_default: false });
  });

  it("refuses duplicate names, other pages' filter keys, bad values and too many views", async () => {
    const me = await as("views-rules@example.com");
    await createView(me, { area: "projects", name: "Open", filters: { show: "team" } });
    await expect(createView(me, { area: "projects", name: "open", filters: {} })).rejects.toThrow(/already have a view called/);
    await expect(createView(me, { area: "projects", name: "Mine", filters: { severity: "critical" } })).rejects.toThrow(/'severity' is not a filter on this page/);
    await expect(createView(me, { area: "projects", name: "Odd", filters: { q: 5 } })).rejects.toThrow(/must be text/);
    await expect(createView(me, { area: "projects", name: "   ", filters: {} })).rejects.toThrow(/give the view a name/);
    await expect(createView(me, { area: "projects", name: "x".repeat(61), filters: {} })).rejects.toThrow(/at most 60/);
    // The same name on another page is fine.
    await createView(me, { area: "inbox", name: "Open", filters: {} });
    for (let i = 1; i < MAX_VIEWS_PER_AREA; i++) await createView(me, { area: "projects", name: `View ${i}`, filters: {} });
    await expect(createView(me, { area: "projects", name: "One too many", filters: {} })).rejects.toThrow(/up to 50 views/);
  });

  it("are private: nobody else can see, change or delete them", async () => {
    const owner = await as("views-private@example.com");
    const other = await as("views-snoop@example.com");
    const v = await createView(owner, { area: "security", name: "Mine", filters: { project: "order-service" } });
    expect((await listViews(other, "security")).views).toEqual([]);
    await expect(updateView(other, v.id, { name: "Taken" })).rejects.toThrow(/saved view not found/);
    await expect(updateView(other, v.id, { is_default: true })).rejects.toThrow(/saved view not found/);
    await expect(deleteView(other, v.id)).rejects.toThrow(/saved view not found/);
    expect((await listViews(owner, "security")).views[0]).toMatchObject({ name: "Mine", is_default: false });
  });

  it("are for people, not service accounts", async () => {
    const svc = await ctxFor(db, { email: "views-bot@example.com", service: true });
    await expect(listViews(svc, "review")).rejects.toThrow(/for people/);
    await expect(createView(svc, { area: "review", name: "x", filters: {} })).rejects.toThrow(/for people/);
  });

  it("over HTTP: signed-in only, validated, and scoped to the caller", async () => {
    expect((await call(null, "GET", "/api/views?area=review")).status).toBe(401);
    expect((await call("user", "GET", "/api/views?area=nowhere")).status).toBe(400);
    const made = await call("user", "POST", "/api/views", { area: "review", name: "Waiting", filters: { assigned: "to_review" }, is_default: true });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ name: "Waiting", is_default: true, filters: { assigned: "to_review" } });
    expect((await call("user", "GET", "/api/views?area=review")).body.views).toHaveLength(1);
    expect((await call("bob", "GET", "/api/views?area=review")).body.views).toHaveLength(0);
    expect((await call("bob", "PATCH", `/api/views/${made.body.id}`, { name: "Mine now" })).status).toBe(404);
    expect((await call("bob", "DELETE", `/api/views/${made.body.id}`)).status).toBe(404);
    expect((await call("user", "POST", "/api/views", { area: "review", name: "Bad", filters: { password: "x" } })).status).toBe(400);
    expect((await call("user", "PATCH", `/api/views/${made.body.id}`, { name: "Waiting for me", is_default: false })).body).toMatchObject({ name: "Waiting for me", is_default: false });
    expect((await call("user", "DELETE", `/api/views/${made.body.id}`)).body).toEqual({ deleted: true, id: made.body.id });
    expect((await call("user", "GET", "/api/views?area=review")).body.views).toHaveLength(0);
  });
});

describe("managing views in one save", () => {
  const names = async (ctx: Awaited<ReturnType<typeof as>>) => (await listViews(ctx, "review")).views.map((v) => `${v.name}${v.is_default ? "*" : ""}`);

  it("swaps names, reuses a name another rename or delete frees, and sets the default, all at once", async () => {
    const me = await as("views-manage@example.com");
    const a = await createView(me, { area: "review", name: "Alpha", filters: { state: "pending" } });
    const b = await createView(me, { area: "review", name: "Beta", filters: { state: "approved" }, is_default: true });
    const c = await createView(me, { area: "review", name: "Gamma", filters: {} });
    const out = await saveViews(me, "review", { rename: [{ id: a.id, name: "Beta" }, { id: b.id, name: "alpha" }], default: a.id });
    expect(out.views.map((v) => [v.id, v.name, v.is_default])).toEqual([
      [b.id, "alpha", false],
      [a.id, "Beta", true],
      [c.id, "Gamma", false],
    ]);
    // Filters are untouched by a rename.
    expect(out.views.find((v) => v.id === a.id)!.filters).toEqual({ state: "pending" });
    // Delete one and give its name to another; clear the default.
    await saveViews(me, "review", { delete: [c.id], rename: [{ id: a.id, name: "Gamma" }], default: null });
    expect(await names(me)).toEqual(["alpha", "Gamma"]);
    // Leaving the default out keeps it.
    await saveViews(me, "review", { default: b.id });
    await saveViews(me, "review", { rename: [{ id: b.id, name: "Alpha again" }] });
    expect(await names(me)).toEqual(["Alpha again*", "Gamma"]);
  });

  it("changes nothing when any part fails", async () => {
    const me = await as("views-atomic@example.com");
    const a = await createView(me, { area: "review", name: "One", filters: {} });
    const b = await createView(me, { area: "review", name: "Two", filters: {}, is_default: true });
    await expect(saveViews(me, "review", { delete: [a.id], rename: [{ id: b.id, name: "one" }, { id: a.id, name: "x" }] })).rejects.toThrow(/renamed and deleted/);
    await expect(saveViews(me, "review", { rename: [{ id: a.id, name: "Two" }] })).rejects.toThrow(/already have a view called “Two”/);
    await expect(saveViews(me, "review", { rename: [{ id: a.id, name: "Same" }, { id: b.id, name: "same" }] })).rejects.toThrow(/already have a view called/);
    await expect(saveViews(me, "review", { rename: [{ id: a.id, name: " " }] })).rejects.toThrow(/give the view a name/);
    await expect(saveViews(me, "review", { delete: [b.id], default: b.id })).rejects.toThrow(/can't be the default/);
    // A view on another page counts as missing, and the delete before it is rolled back.
    const other = await createView(me, { area: "inbox", name: "Elsewhere", filters: {} });
    await expect(saveViews(me, "review", { delete: [a.id], rename: [{ id: other.id, name: "Moved" }] })).rejects.toThrow(/saved view not found/);
    expect(await names(me)).toEqual(["One", "Two*"]);
  });

  it("only touches the caller's own views, and not for service accounts", async () => {
    const owner = await as("views-manage-owner@example.com");
    const snoop = await as("views-manage-snoop@example.com");
    const v = await createView(owner, { area: "review", name: "Private", filters: {} });
    await expect(saveViews(snoop, "review", { rename: [{ id: v.id, name: "Mine" }] })).rejects.toThrow(/saved view not found/);
    await expect(saveViews(snoop, "review", { delete: [v.id] })).rejects.toThrow(/saved view not found/);
    await expect(saveViews(snoop, "review", { default: v.id })).rejects.toThrow(/saved view not found/);
    expect(await names(owner)).toEqual(["Private"]);
    const svc = await ctxFor(db, { email: "views-manage-bot@example.com", service: true });
    await expect(saveViews(svc, "review", {})).rejects.toThrow(/for people/);
  });

  it("over HTTP: validated and scoped to the caller", async () => {
    const x = (await call("user", "POST", "/api/views", { area: "inbox", name: "X", filters: {} })).body;
    const y = (await call("user", "POST", "/api/views", { area: "inbox", name: "Y", filters: {} })).body;
    const swapped = await call("user", "POST", "/api/views/manage", { area: "inbox", rename: [{ id: x.id, name: "Y" }, { id: y.id, name: "X" }], default: y.id });
    expect(swapped.status).toBe(200);
    expect(swapped.body.views.map((v: { id: string; name: string; is_default: boolean }) => [v.id, v.name, v.is_default])).toEqual([
      [y.id, "X", true],
      [x.id, "Y", false],
    ]);
    expect((await call("bob", "POST", "/api/views/manage", { area: "inbox", delete: [x.id] })).status).toBe(404);
    expect((await call("user", "POST", "/api/views/manage", { area: "inbox", delete: ["not-a-uuid"] })).status).toBe(400);
    expect((await call("user", "POST", "/api/views/manage", { area: "elsewhere" })).status).toBe(400);
    expect((await call(null, "POST", "/api/views/manage", { area: "inbox" })).status).toBe(401);
    expect((await call("user", "GET", "/api/views?area=inbox")).body.views).toHaveLength(2);
  });
});

describe("writing guide", () => {
  it("is served for every article and finding type, to anyone signed in", async () => {
    const runbook = await call("user", "GET", "/api/writing-guide/article/runbook");
    expect(runbook.status).toBe(200);
    expect(runbook.body.sections[0]).toEqual({ heading: "Trigger", hint: expect.stringContaining("alert") });
    expect(runbook.body.checklist).toContain("Each step can be followed by someone on call who has never seen this system");
    const finding = await call("user", "GET", "/api/writing-guide/finding/data_gotcha");
    expect(finding.body.sections.map((s: { field: string }) => s.field)).toEqual(["symptoms", "root_cause", "fix"]);
    expect((await call("user", "GET", "/api/writing-guide/finding/runbook")).status).toBe(400);
    expect((await call("user", "GET", "/api/writing-guide/post/runbook")).status).toBe(400);
    expect((await call(null, "GET", "/api/writing-guide/article/runbook")).status).toBe(401);
  });
});

describe("system presets over HTTP", () => {
  it("refuse people who aren't admins, and unknown presets", async () => {
    expect((await call("user", "POST", "/api/system/presets/looser")).status).toBe(403);
    expect((await call("user", "POST", "/api/system/presets/nope")).status).toBe(400);
    expect((await call(null, "POST", "/api/system/presets/looser")).status).toBe(401);
  });

  it("let an admin apply Looser, which lets everyone waiting for approval in, and is audited", async () => {
    const admin = await as("admin@example.com");
    await updateSystemSettings(admin, { require_approval: true });
    try {
      const waiting = await upsertUser(db, { subject: "dev:waiting@example.com", email: "waiting@example.com", kind: "human" }, { approval: true });
      expect(waiting.approved).toBe(false);
      const res = await call("admin", "POST", "/api/system/presets/looser");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ preset: "looser", let_in: 1 });
      expect(res.body.changed).toContain("require_approval");
      expect(TEST_SETTINGS.requireApproval).toBe(false);
      const row = (await db.query<{ approved_at: Date | null; approved_by: string | null }>("SELECT approved_at, approved_by FROM users WHERE id = $1", [waiting.id])).rows[0]!;
      expect(row.approved_at).not.toBeNull();
      expect(row.approved_by).toBe(admin.actor.id);
      const audited = (
        await db.query<{ tool: string; details: { preset?: string; changed?: string[]; changes?: { setting: string }[] } | null }>(
          "SELECT tool, details FROM audit_log WHERE actor_id = $1 AND tool IN ('apply_system_preset', 'update_system_settings') ORDER BY id DESC LIMIT 2",
          [admin.actor.id],
        )
      ).rows;
      const preset = audited.find((r) => r.tool === "apply_system_preset");
      expect(preset?.details).toMatchObject({ preset: "looser" });
      expect(preset?.details?.changed).toContain("require_approval");
      const settingsRow = audited.find((r) => r.tool === "update_system_settings");
      expect(settingsRow?.details?.changes?.map((c) => c.setting)).toContain("require_approval");
      // Applying it again changes nothing and lets nobody else in.
      expect((await call("admin", "POST", "/api/system/presets/looser")).body).toMatchObject({ changed: [], let_in: 0 });
    } finally {
      await updateSystemSettings(admin, Object.fromEntries(Object.keys(SYSTEM_PRESETS.default.values).map((k) => [k, null])));
    }
  });
});

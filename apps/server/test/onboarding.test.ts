import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chain, devAuthenticator, sessionAuthenticator } from "../src/auth/index.js";
import { createInvitation } from "../src/auth/invitations.js";
import { adminCreateProject, adminSetMember, adminUpdateScope } from "../src/core/admin.js";
import { exportMarkdown } from "../src/core/exporter.js";
import { importDocs, parseUpload } from "../src/core/importer.js";
import { getArticle } from "../src/core/items.js";
import { flushDeliveries, outbox } from "../src/core/notify.js";
import { onboarding } from "../src/core/onboarding.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let server: Server;
let base: string;
let settings: typeof TEST_SETTINGS;

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator("adm=admin@example.com"), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  settings = { ...TEST_SETTINGS, authMode: "local", mailTransport: "json", publicUrl: base };
  await new Promise((r) => server.close(r));
  server = createApp({ db, authenticate: chain(sessionAuthenticator(db), devAuthenticator("adm=admin@example.com")), settings }).listen(Number(new URL(base).port));
  await new Promise((r) => server.once("listening", r));
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});
beforeEach(async () => {
  await flushDeliveries();
  outbox.length = 0;
});

const admin = () => ctxFor(db, { email: "admin@example.com", settings });

describe("invitations", () => {
  it("emails a one-time link; the invitee sets a password, joins the project and is signed in", async () => {
    const me = await admin();
    const inv = await createInvitation(db, settings, me.actor.id, { email: "New.Person@example.com", name: "New Person", scope: "order-service", role: "writer" });
    await flushDeliveries();
    expect(inv.emailed).toBe(true);
    const mail = outbox.find((m) => m.to === "new.person@example.com")!;
    expect(mail.subject).toMatch(/invited you to Cairn/);
    const token = /#\/invite\/([\w-]+)/.exec(mail.html)![1]!;
    expect(inv.link).toBe(`${base}/#/invite/${token}`);

    const info = await fetch(`${base}/auth/invite/${token}`).then((r) => r.json());
    expect(info).toMatchObject({ email: "new.person@example.com", name: "New Person" });

    const weak = await fetch(`${base}/auth/invite/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "short" }) });
    expect(weak.status).toBe(400);
    const ok = await fetch(`${base}/auth/invite/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "a-long-enough-passphrase-9" }) });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/cairn_session=/);
    const who = await fetch(`${base}/api/me`, { headers: { cookie: cookie.split(";")[0]!, origin: base } }).then((r) => r.json());
    expect(who.email).toBe("new.person@example.com");
    const role = await db.query("SELECT m.role FROM scope_members m JOIN users u ON u.id = m.user_id JOIN scopes s ON s.id = m.scope_id WHERE u.email = $1 AND s.slug = 'order-service'", ["new.person@example.com"]);
    expect(role.rows[0].role).toBe("writer");

    const again = await fetch(`${base}/auth/invite/${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "a-long-enough-passphrase-9" }) });
    expect(again.status).toBe(404);
    await expect(createInvitation(db, settings, me.actor.id, { email: "new.person@example.com" })).rejects.toThrow(/already has an account/);
  });

  it("is only for local sign-in, and only admins can invite over HTTP", async () => {
    await expect(createInvitation(db, TEST_SETTINGS, (await admin()).actor.id, { email: "x@example.com" })).rejects.toThrow(/local sign-in/);
    const res = await fetch(`${base}/api/invitations`, { method: "POST", headers: { authorization: "Bearer someone", "content-type": "application/json" }, body: "{}" });
    expect([401, 403]).toContain(res.status);
  });
});

describe("project starter pack", () => {
  it("creates components and outline articles, with the contract linked between backend and frontend", async () => {
    const res = await adminCreateProject(await admin(), {
      slug: "loyalty",
      name: "Loyalty points",
      components: [
        { slug: "api", kind: "backend" },
        { slug: "web", kind: "frontend" },
      ],
      starter: true,
    });
    expect(res.components).toBe(2);
    expect(res.starter.map((s) => s.type)).toEqual(["project_overview", "design_doc", "runbook", "api_contract"]);
    const contract = await getArticle(await admin(), res.starter[3]!.id);
    expect(contract.status).toBe("published");
    expect(contract.body_md).toContain("## Errors");
    expect(contract.related.map((r) => r.relation).sort()).toEqual(["consumed_by", "provided_by"]);
  });
});

describe("import", () => {
  it("reads Markdown, HTML (with tables) and Notion-style zips, with folders and images", () => {
    const zip = zipSync({
      "Export/Payments 0123456789abcdef0123456789abcdef.md": strToU8("# Payments\n\nHow we take money.\n\n![flow](Payments%200123456789abcdef0123456789abcdef/flow.png)"),
      "Export/Payments 0123456789abcdef0123456789abcdef/flow.png": PNG,
      "Export/Guides/Refunds.html": strToU8("<html><head><title>Refunds</title></head><body><h1>Refunds</h1><p>Use the <b>refund</b> API.</p><table><tr><th>Code</th><th>Meaning</th></tr><tr><td>409</td><td>Already refunded</td></tr></table></body></html>"),
      "Export/notes.docx": strToU8("binary"),
      "Export/.DS_Store": strToU8("x"),
    });
    const parsed = parseUpload("export.zip", zip);
    expect(parsed.format).toBe("notion");
    const byTitle = Object.fromEntries(parsed.pages.map((p) => [p.title, p]));
    expect(Object.keys(byTitle).sort()).toEqual(["Payments", "Refunds"]);
    expect(byTitle.Payments!.images).toHaveLength(1);
    expect(byTitle.Payments!.body_md).not.toMatch(/^# Payments/);
    expect(byTitle.Refunds!.path).toBe("Guides");
    expect(byTitle.Refunds!.body_md).toContain("| Code | Meaning |");
    expect(byTitle.Refunds!.body_md).toContain("Use the **refund** API.");
    expect(parsed.skipped).toEqual([expect.objectContaining({ file: "Export/notes.docx", reason: expect.stringContaining("export as HTML or Markdown") })]);
  });

  it("extracts a Confluence page from its export chrome", () => {
    const html = `<html><head><title>Engineering : Deploy checklist</title><meta name="generator" content="Confluence"></head><body>
      <div id="breadcrumb-section">Home / Engineering</div><h1 id="title-heading"><span id="title-text">Engineering : Deploy checklist</span></h1>
      <div id="main-content"><h2>Before</h2><ul><li>Tag the release</li></ul></div><div id="footer">Generated by Confluence</div></body></html>`;
    const page = parseUpload("Deploy-checklist_12345.html", strToU8(html)).pages[0]!;
    expect(page.title).toBe("Deploy checklist");
    expect(page.body_md).toMatch(/^## Before\n\n-\s+Tag the release$/);
    expect(page.body_md).not.toMatch(/Home \/ Engineering|Generated by/);
  });

  it("previews with a dry run, then imports through the review path with images attached", async () => {
    // The zip's own top folder ("Docs") is dropped; folders under it are kept.
    const zip = zipSync({ "Docs/Runbooks/Cache flush.md": strToU8("# Cache flush\n\n## Steps\n\nFlush it. Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n\n![diagram](img/d.png)"), "Docs/Runbooks/img/d.png": PNG, "Docs/About.md": strToU8("# About\n\nThese are our docs.") });
    const owner = await admin();
    const dry = await importDocs(owner, { filename: "docs.zip", data: zip, scope: "team", type: "runbook", dryRun: true });
    expect(dry).toMatchObject({ dry_run: true, pages: expect.arrayContaining([expect.objectContaining({ title: "Cache flush", path: "Runbooks", images: 1 })]) });
    expect((await db.query("SELECT count(*)::int AS n FROM articles WHERE title = 'Cache flush'")).rows[0].n).toBe(0);

    const done = await importDocs(owner, { filename: "docs.zip", data: zip, scope: "team", type: "runbook", folder: "Imported" });
    expect(done.imported).toEqual(expect.arrayContaining([expect.objectContaining({ title: "Cache flush", published: true })]));
    const a = await getArticle(owner, done.imported!.find((i) => i.title === "Cache flush")!.id);
    expect(a.path).toBe("Imported/Runbooks");
    expect(a.body_md).toMatch(/!\[diagram\]\(asset:[0-9a-f-]{36}\)/);
    expect(a.body_md).not.toContain("ghp_abcdef");
    expect(a.assets).toHaveLength(1);

    // Someone who can't approve: proposals, and one message to reviewers for the batch.
    const writer = await ctxFor(db, { email: "importer@example.com", settings });
    const two = zipSync({ "a.md": strToU8("# Page A\n\nText A"), "b.md": strToU8("# Page B\n\nText B") });
    const proposed = await importDocs(writer, { filename: "two.zip", data: two, scope: "team", type: "design_doc" });
    expect(proposed.imported!.every((i) => !i.published)).toBe(true);
    await flushDeliveries();
    const notes = await db.query("SELECT title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'admin@example.com' AND n.title LIKE 'Review: 2 imported%'");
    expect(notes.rowCount).toBe(1);
  });

  it("accepts raw uploads over HTTP", async () => {
    const res = await fetch(`${base}/api/import?scope=team&type=design_doc&filename=one.md&dry_run=true`, {
      method: "POST",
      headers: { authorization: "Bearer adm", "content-type": "application/octet-stream" },
      body: strToU8("# One page\n\nBody"),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).pages[0].title).toBe("One page");
  });
});

describe("export", () => {
  it("zips readable items as Markdown with front matter and attachments, leaving out members-only projects", async () => {
    const out = await exportMarkdown(await admin());
    const files = unzipSync(out.zip);
    const names = Object.keys(files);
    expect(names).toContain("README.md");
    const cvr = names.find((n) => n.endsWith("conversion-rate.md"))!;
    expect(cvr.startsWith("team/")).toBe(true);
    const text = strFromU8(files[cvr]!);
    expect(text).toMatch(/^---\ntitle: "Conversion rate"\nid: "[0-9a-f-]+"\ntype: "metric"/);
    // The image attached by the import test above.
    expect(names.some((n) => n.startsWith("assets/"))).toBe(true);
    const withImage = names.filter((n) => n.endsWith(".md")).map((n) => strFromU8(files[n]!)).find((t) => t.includes("](../") && t.includes("assets/"));
    expect(withImage).toBeTruthy();

    // A members-only project vanishes from a non-member's export.
    const a = await admin();
    await adminSetMember(a, "order-service", "admin@example.com", "owner");
    await adminUpdateScope(a, "order-service", { visibility: "members" });
    const outsider = unzipSync((await exportMarkdown(await ctxFor(db, { email: "outsider@example.com", settings }))).zip);
    expect(Object.keys(outsider).some((n) => n.startsWith("order-service/"))).toBe(false);
    await adminUpdateScope(a, "order-service", { visibility: "team" });
    void ids;
  });
});

describe("first-run checklist", () => {
  it("works out each step from what has happened", async () => {
    const fresh = await ctxFor(db, { email: "brand-new@example.com", settings });
    const steps = Object.fromEntries((await onboarding(fresh)).steps.map((s) => [s.key, s.done]));
    expect(steps).toEqual({ connect: false, write: false, follow: false });
    const adminSteps = Object.fromEntries((await onboarding(await admin())).steps.map((s) => [s.key, s.done]));
    expect(adminSteps).toMatchObject({ project: true, invite: true, email: true, write: true });
  });
});

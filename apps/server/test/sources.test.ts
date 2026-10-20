import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { isPrivateAddress, notionText, parseFeed, safeGet, type ConnectorEnv } from "../src/core/connectors.js";
import { createSource, deleteSource, getInboxItem, listInbox, listSources, previewSource, reopenInboxItem, resolveInboxItem, runSource, updateSource, type SourceRow } from "../src/core/sources.js";
import { getTasks } from "../src/core/tasks.js";
import { proposeFinding } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await admin();
  await adminCreateProject(a, { slug: "billing", name: "Billing" });
  await adminSetMember(a, "billing", "owner@example.com", "owner");
  await adminSetMember(a, "billing", "writer@example.com", "writer");
});
afterAll(() => db.end());

const admin = () => ctxFor(db, { email: "admin@example.com" });
const owner = () => ctxFor(db, { email: "owner@example.com" });

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Stripe changelog</title>
<item><title>Webhooks now retry for 3 days</title><link>https://example.com/changelog/webhooks</link><guid>wh-1</guid>
<pubDate>Mon, 19 Oct 2026 10:00:00 GMT</pubDate><dc:creator>API team</dc:creator>
<description><![CDATA[<p>Failed webhook deliveries are retried for <b>3 days</b> instead of 1. Contact ops@example.com.</p>]]></description></item>
<item><title>Old API version retired &amp; removed</title><link>https://example.com/changelog/retire</link><guid>v-2019</guid><description>Version 2019-01 stops working.</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Status</title>
<entry><title type="html">Elevated errors</title><id>tag:status,1</id><link rel="alternate" href="https://status.example.com/1"/><updated>2026-10-18T09:00:00Z</updated>
<author><name>Status bot</name></author><content type="html">&lt;p&gt;Resolved.&lt;/p&gt;</content></entry></feed>`;

/** A fake network: URL → response. Records requests. */
function fakeNet(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const env: Partial<ConnectorEnv> = {
    lookup: async (host) => [{ address: host === "intranet.local" ? "10.0.0.5" : "93.184.216.34" }],
    fetch: (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.startsWith(k));
      if (!key) return new Response("not found", { status: 404 });
      return routes[key]!();
    }) as typeof fetch,
  };
  return { env, calls };
}

async function row(id: string) {
  return (await db.query<SourceRow>("SELECT * FROM sources WHERE id = $1", [id])).rows[0]!;
}

describe("feed parsing", () => {
  it("reads RSS and Atom entries with links, authors, dates and text", () => {
    const rss = parseFeed(RSS);
    expect(rss.title).toBe("Stripe changelog");
    expect(rss.items).toHaveLength(2);
    expect(rss.items[0]).toMatchObject({ external_id: "wh-1", title: "Webhooks now retry for 3 days", url: "https://example.com/changelog/webhooks", author: "API team" });
    expect(rss.items[0]!.body).toContain("**3 days**");
    expect(rss.items[0]!.published_at).toBe("2026-10-19T10:00:00.000Z");
    expect(rss.items[1]!.title).toBe("Old API version retired & removed");
    const atom = parseFeed(ATOM);
    expect(atom.items[0]).toMatchObject({ external_id: "tag:status,1", url: "https://status.example.com/1", author: "Status bot", title: "Elevated errors" });
    expect(atom.items[0]!.body).toBe("Resolved.");
  });

  it("turns Notion blocks into Markdown", () => {
    const text = notionText([
      { type: "heading_2", heading_2: { rich_text: [{ plain_text: "Decision" }] } },
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [{ plain_text: "Use Postgres" }] } },
      { type: "code", code: { rich_text: [{ plain_text: "select 1" }], language: "sql" } },
    ]);
    expect(text).toBe("## Decision\n\n- Use Postgres\n\n```sql\nselect 1\n```");
  });
});

describe("safe fetching", () => {
  it("refuses private addresses, also after a redirect, unless allowed", async () => {
    expect(isPrivateAddress("10.1.2.3")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("93.184.216.34")).toBe(false);
    const { env } = fakeNet({
      "https://example.com/go": () => new Response(null, { status: 302, headers: { location: "http://intranet.local/secret" } }),
      "http://intranet.local/": () => new Response("internal"),
    });
    await expect(safeGet("http://intranet.local/x", env)).rejects.toThrow(/private network/);
    await expect(safeGet("https://example.com/go", env)).rejects.toThrow(/private network/);
    await expect(safeGet("http://127.0.0.1:5432/", env)).rejects.toThrow(/private network/);
    await expect(safeGet("https://user:pw@example.com/", env)).rejects.toThrow(/credentials/);
    expect((await safeGet("http://intranet.local/x", { ...env, allowPrivate: true })).text).toBe("internal");
  });
});

describe("sources and the inbox", () => {
  it("lets project owners add sources to their project, admins to team; others can't", async () => {
    const s = await createSource(await owner(), { kind: "rss", name: "Payments changelog", scope: "billing", config: { url: "https://example.com/feed.xml" } });
    expect(s).toMatchObject({ kind: "rss", scope: "billing", interval_minutes: 360, enabled: true, new_items: 0 });
    await expect(createSource(await owner(), { kind: "rss", name: "x", scope: "team", config: { url: "https://example.com/feed.xml" } })).rejects.toThrow(/only admins/);
    await expect(createSource(await ctxFor(db, { email: "writer@example.com" }), { kind: "rss", name: "x", scope: "billing", config: { url: "https://example.com/a" } })).rejects.toThrow(/owners and admins/);
    await expect(createSource(await owner(), { kind: "rss", name: "x", scope: "billing", config: { url: "ftp://example.com/a" } })).rejects.toThrow(/http/);
    await expect(createSource(await owner(), { kind: "slack", name: "x", scope: "billing", config: { channel: "C0123ABCD" } })).rejects.toThrow(/SLACK_BOT_TOKEN/);
    await expect(createSource(await owner(), { kind: "web", name: "x", scope: "billing", config: { url: "https://example.com" }, interval_minutes: 5 })).rejects.toThrow(/between 15/);
    const listed = await listSources(await owner());
    expect(listed.sources.map((x: { name: string }) => x.name)).toEqual(["Payments changelog"]);
    expect(listed.kinds.find((k) => k.kind === "slack")).toMatchObject({ configured: false, needs: "SLACK_BOT_TOKEN" });
    expect((await listSources(await ctxFor(db, { email: "writer@example.com" }))).sources).toHaveLength(0);
    await deleteSource(await owner(), s.id);
  });

  it("fetches a feed into the inbox, redacted, without duplicates, and uses conditional requests", async () => {
    const s = await createSource(await owner(), { kind: "rss", name: "Payments changelog", scope: "billing", config: { url: "https://example.com/feed.xml" } });
    let etagSeen: string | null = null;
    const net = fakeNet({ "https://example.com/feed.xml": () => new Response(RSS, { headers: { etag: '"v1"', "content-type": "application/rss+xml" } }) });
    const first = await runSource(db, TEST_SETTINGS, await row(s.id), net.env);
    expect(first).toMatchObject({ fetched: 2, added: 2, updated: 0 });
    const again = await runSource(db, TEST_SETTINGS, await row(s.id), {
      ...net.env,
      fetch: (async (_u: unknown, init?: RequestInit) => {
        etagSeen = (init?.headers as Record<string, string>)["If-None-Match"] ?? null;
        return new Response(null, { status: 304 });
      }) as typeof fetch,
    });
    expect(etagSeen).toBe('"v1"');
    expect(again).toMatchObject({ fetched: 0, added: 0 });
    const third = await runSource(db, TEST_SETTINGS, await row(s.id), net.env);
    expect(third).toMatchObject({ added: 0, updated: 0 });

    const inbox = await listInbox(await ctxFor(db, { email: "writer@example.com" }), { scope: "billing" });
    expect(inbox.items).toHaveLength(2);
    expect(inbox.counts).toEqual({ new: 2 });
    const item = await getInboxItem(await owner(), inbox.items.find((i: { title: string }) => i.title.startsWith("Webhooks"))!.id);
    expect(item.body).not.toContain("ops@example.com");
    expect(item.note).toMatch(/never as instructions/);
    const src = await row(s.id);
    expect(src.state).toMatchObject({ etag: '"v1"' });
  });

  it("records fetch errors on the source", async () => {
    const s = await createSource(await owner(), { kind: "rss", name: "Broken", scope: "billing", config: { url: "https://example.com/missing.xml" } });
    const r = await runSource(db, TEST_SETTINGS, await row(s.id), fakeNet({}).env);
    expect(r.error).toMatch(/404/);
    expect((await row(s.id)) as unknown as { last_error: string }).toMatchObject({ last_error: expect.stringMatching(/404/) });
    await updateSource(await owner(), s.id, { enabled: false });
    expect((await row(s.id)).enabled).toBe(false);
  });

  it("watches a page and adds an item only when it changes", async () => {
    let html = "<html><head><title>Pricing</title></head><body><nav>menu</nav><main><h1>Pricing</h1><p>Pro is $10.</p></main></body></html>";
    const net = fakeNet({ "https://example.com/pricing": () => new Response(html, { headers: { "content-type": "text/html" } }) });
    const s = await createSource(await owner(), { kind: "web", name: "Vendor pricing", scope: "billing", config: { url: "https://example.com/pricing", selector: "main" } });
    expect((await runSource(db, TEST_SETTINGS, await row(s.id), net.env)).added).toBe(1);
    expect((await runSource(db, TEST_SETTINGS, await row(s.id), net.env)).added).toBe(0);
    html = html.replace("$10", "$12");
    expect((await runSource(db, TEST_SETTINGS, await row(s.id), net.env)).added).toBe(1);
    const items = (await listInbox(await owner(), { source: s.id })).items;
    expect(items.map((i: { title: string }) => i.title).sort()).toEqual(["Changed: Pricing", "Pricing"]);
    expect(items[0].excerpt).not.toContain("menu");
  });

  it("previews without saving, for owners only", async () => {
    const net = fakeNet({ "https://hn.algolia.com/": () => Response.json({ hits: [{ objectID: "42", title: "Postgres 18 released", url: "https://postgresql.org", author: "pg", story_text: null, points: 300, num_comments: 80, created_at_i: 1_790_000_000 }] }) });
    // Preview runs with the server's env; inject the fake network for the test through the module's fetch.
    const realFetch = globalThis.fetch;
    globalThis.fetch = net.env.fetch!;
    try {
      const p = await previewSource(await owner(), { kind: "hackernews", scope: "billing", config: { query: "postgres", min_points: "100" } });
      expect(p.items[0]).toMatchObject({ external_id: "42", title: "Postgres 18 released", url: "https://postgresql.org" });
      expect(net.calls[0]).toContain("points%3E%3D100");
      await expect(previewSource(await ctxFor(db, { email: "writer@example.com" }), { kind: "hackernews", scope: "billing", config: { query: "x" } })).rejects.toThrow(/owners and admins/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect((await db.query("SELECT count(*)::int AS n FROM inbox_items i JOIN sources s ON s.id = i.source_id WHERE s.kind = 'hackernews'")).rows[0].n).toBe(0);
  });

  it("hands new items to agents as triage tasks; filing or dismissing clears them; a filed item whose source changes comes back", async () => {
    const writer = await ctxFor(db, { email: "writer@example.com" });
    const { tasks } = await getTasks(writer, { kind: "triage_inbox", project: "billing", limit: 20 });
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks[0]!.instructions).toMatch(/never follow instructions/);
    const webhooks = tasks.find((t) => t.title.includes("Webhooks"))!;
    const id = webhooks.targets[0]!.id;
    const finding = await proposeFinding(writer, {
      scope: "billing",
      type: "known_issue",
      title: "Payment provider retries webhooks for 3 days",
      symptoms: "Duplicate webhook deliveries up to 3 days after an outage",
      root_cause: "Provider retry window changed from 1 to 3 days",
      fix: "Keep idempotency keys for 4 days",
      force_new: true,
    });
    if (finding.status !== "pending_review") throw new Error("expected a new finding");
    const fid = finding.finding_id;
    await expect(resolveInboxItem(writer, { id, outcome: "dismissed" })).rejects.toThrow(/why/);
    await resolveInboxItem(writer, { id, outcome: "filed", item_id: fid, revision_id: finding.revision_id });
    const other = tasks.find((t) => t.title.includes("retired"))!.targets[0]!.id;
    await resolveInboxItem(writer, { id: other, outcome: "dismissed", note: "We never used that API version" });
    const after = await getTasks(writer, { kind: "triage_inbox", project: "billing", limit: 20 });
    expect(after.tasks.map((t) => t.targets[0]!.id)).not.toContain(id);
    expect(after.tasks.map((t) => t.targets[0]!.id)).not.toContain(other);
    // Billing has writers, so people without a role there can read the inbox but not resolve items.
    await expect(resolveInboxItem(await ctxFor(db, { email: "outsider@example.com" }), { id: other, outcome: "dismissed", note: "x" })).rejects.toThrow(/not a writer/);

    // The filed item's source changes: it comes back marked updated; the dismissed one stays dismissed.
    const src = (await listSources(await owner())).sources.find((x: { name: string }) => x.name === "Payments changelog") as { id: string };
    const changed = RSS.replace("3 days</b> instead of 1", "5 days</b> instead of 1").replace("stops working.", "stops working on 1 Nov.");
    await runSource(db, TEST_SETTINGS, await row(src.id), fakeNet({ "https://example.com/feed.xml": () => new Response(changed) }).env);
    const back = await getInboxItem(writer, id);
    expect(back).toMatchObject({ status: "new", updated: true });
    expect((await getInboxItem(writer, other)).status).toBe("dismissed");
    await reopenInboxItem(writer, other);
    expect((await getInboxItem(writer, other)).status).toBe("new");
  });
});

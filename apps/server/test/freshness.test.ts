import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { adminSetMember } from "../src/core/admin.js";
import { markStale, needsAttention } from "../src/core/freshness.js";
import { searchKnowledge } from "../src/core/search.js";
import { verifyEntry } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];

beforeAll(async () => {
  ({ db, ids } = await freshDb());
});
afterAll(async () => {
  await db.end();
});

describe("freshness", () => {
  it("flags entries not verified within the window, separately for findings and articles", async () => {
    await db.query("UPDATE findings SET last_verified_at = now() - interval '100 days' WHERE id = $1", [ids.rca]);
    await db.query("UPDATE articles SET last_verified_at = now() - interval '100 days' WHERE id IN ($1, $2)", [ids.runbook, ids.cvr]);
    expect(await markStale(db, { findingDays: 90, articleDays: 180 })).toEqual({ findings: 1, articles: 0 });
    expect(await markStale(db, { findingDays: 90, articleDays: 90 })).toEqual({ findings: 0, articles: 2 });
    const ctx = await ctxFor(db);
    const hits = await searchKnowledge(ctx, { query: "payment provider rate limit" });
    expect(hits.findings[0]).toMatchObject({ id: ids.rca, status: "possibly_stale" });
    expect(hits.findings[0]!.warning).toBeTruthy();
  });

  it("lists what needs attention, including overdue reviews, until verified", async () => {
    await db.query("UPDATE articles SET review_due = current_date - 1 WHERE id = $1", [ids.dataTable]);
    const ctx = await ctxFor(db);
    const before = (await needsAttention(ctx)).entries.map((e: { id: string; reason: string }) => `${e.id}:${e.reason}`);
    expect(before).toEqual(
      expect.arrayContaining([`${ids.rca}:not verified recently`, `${ids.runbook}:not verified recently`, `${ids.dataTable}:review overdue`]),
    );
    await verifyEntry(ctx, { id: ids.rca, still_valid: true });
    const after = (await needsAttention(ctx)).entries.map((e: { id: string }) => e.id);
    expect(after).not.toContain(ids.rca);
    const libraryOnly = (await needsAttention(ctx, { scope: "library" })).entries.map((e: { id: string }) => e.id);
    expect(libraryOnly).toEqual([ids.dataTable]);
  });

  it("moves an overdue review date on when someone confirms the article is still accurate", async () => {
    const ctx = await ctxFor(db, { email: "admin@example.com" });
    await db.query("UPDATE articles SET status = 'published', review_due = current_date - 3 WHERE id = $1", [ids.dataTable]);
    const res = await verifyEntry(ctx, { id: ids.dataTable, still_valid: true });
    const due = (await db.query<{ days: number }>("SELECT (review_due - current_date)::int AS days FROM articles WHERE id = $1", [ids.dataTable])).rows[0]!.days;
    expect(due).toBe(180);
    expect(res).toMatchObject({ status: "verified", item_status: "published" });
    expect((await needsAttention(ctx, { scope: "library" })).entries.map((e: { id: string }) => e.id)).not.toContain(ids.dataTable);

    // A review date still ahead is left alone.
    await db.query("UPDATE articles SET review_due = current_date + 30 WHERE id = $1", [ids.dataTable]);
    await verifyEntry(ctx, { id: ids.dataTable, still_valid: true });
    expect((await db.query<{ days: number }>("SELECT (review_due - current_date)::int AS days FROM articles WHERE id = $1", [ids.dataTable])).rows[0]!.days).toBe(30);
  });
});

describe("who moves an overdue review date on", () => {
  let server: Server;
  let base: string;
  const overdue = (id: string) => db.query("UPDATE articles SET status = 'published', review_due = current_date - 3 WHERE id = $1", [id]);
  const daysLeft = async (id: string) =>
    (await db.query<{ days: number }>("SELECT (review_due - current_date)::int AS days FROM articles WHERE id = $1", [id])).rows[0]!.days;
  const verifiedJustNow = async (id: string) =>
    (await db.query<{ fresh: boolean }>("SELECT last_verified_at > now() - interval '1 minute' AS fresh FROM articles WHERE id = $1", [id])).rows[0]!.fresh;

  beforeAll(async () => {
    const admin = await ctxFor(db, { email: "admin@example.com" });
    await ctxFor(db, { email: "fresh-bot@example.com", service: true });
    await adminSetMember(admin, "order-service", "quinn@example.com", "qa");
    await adminSetMember(admin, "order-service", "will@example.com", "writer");
    await adminSetMember(admin, "order-service", "fresh-bot@example.com", "writer");
    await adminSetMember(admin, "order-service", "rev@example.com", "reviewer");
    server = createApp({ db, authenticate: devAuthenticator("admin=admin@example.com,rev=rev@example.com"), settings: TEST_SETTINGS }).listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it("leaves it alone when a QA person, a contributor or a service account confirms: they only refresh freshness", async () => {
    for (const who of [{ email: "quinn@example.com" }, { email: "will@example.com" }, { email: "fresh-bot@example.com", service: true }]) {
      await overdue(ids.decision);
      await db.query("UPDATE articles SET last_verified_at = now() - interval '200 days' WHERE id = $1", [ids.decision]);
      const res = await verifyEntry(await ctxFor(db, who), { id: ids.decision, still_valid: true });
      expect(res).toMatchObject({ status: "verified", item_status: "published" });
      expect(await daysLeft(ids.decision)).toBe(-3);
      expect(await verifiedJustNow(ids.decision)).toBe(true);
    }
    const admin = await ctxFor(db, { email: "admin@example.com" });
    expect((await needsAttention(admin, { scope: "order-service" })).entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: ids.decision, reason: "review overdue" })]),
    );
  });

  it("leaves it alone for anyone confirming in an open scope without Review there", async () => {
    await overdue(ids.dataTable);
    await verifyEntry(await ctxFor(db, { email: "passer-by@example.com" }), { id: ids.dataTable, still_valid: true });
    expect(await daysLeft(ids.dataTable)).toBe(-3);
  });

  it("moves it on for a person with Review in the project, confirming in the app", async () => {
    await overdue(ids.decision);
    await verifyEntry(await ctxFor(db, { email: "rev@example.com" }), { id: ids.decision, still_valid: true });
    expect(await daysLeft(ids.decision)).toBe(180);

    // Over HTTP too (the app's "Confirm still accurate").
    await overdue(ids.decision);
    const res = await fetch(`${base}/api/verify/${ids.decision}`, {
      method: "POST",
      headers: { authorization: "Bearer rev", "content-type": "application/json" },
      body: JSON.stringify({ still_valid: true }),
    });
    expect(res.status).toBe(200);
    expect(await daysLeft(ids.decision)).toBe(180);
  });

  it("leaves it alone when an agent confirms through MCP verify_entry, even for an Administrator", async () => {
    await overdue(ids.decision);
    await db.query("UPDATE articles SET last_verified_at = now() - interval '200 days' WHERE id = $1", [ids.decision]);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer admin" } } }));
    try {
      const result = await client.callTool({ name: "verify_entry", arguments: { id: ids.decision, still_valid: true } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toMatchObject({ status: "verified" });
    } finally {
      await client.close();
    }
    expect(await daysLeft(ids.decision)).toBe(-3);
    expect(await verifiedJustNow(ids.decision)).toBe(true);
  });
});

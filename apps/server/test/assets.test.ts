import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { adminSetMember } from "../src/core/admin.js";
import { deleteAsset, getAsset, uploadAsset } from "../src/core/assets.js";
import { ForbiddenError } from "../src/core/context.js";
import { getArticle } from "../src/core/items.js";
import { getProjectContext } from "../src/core/projects.js";
import { approveRevision } from "../src/core/review.js";
import { searchKnowledge } from "../src/core/search.js";
import { addSourceLinkTo, shareToLibrary } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

// 1×1 transparent PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let server: Server;
let base: string;

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator("user=alice@example.com,admin=admin@example.com"), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

describe("assets", () => {
  it("stores a screenshot, lists it on the item and returns the same bytes", async () => {
    const ctx = await ctxFor(db);
    const up = await uploadAsset(ctx, { target_id: ids.dataTable, filename: "../../empty state.png", mime: "image/png", data: PNG, alt_text: "Empty state" });
    expect(up).toMatchObject({ filename: "empty state.png", size_bytes: PNG.length });
    const article = await getArticle(ctx, ids.dataTable);
    expect(article.assets).toEqual([expect.objectContaining({ id: up.asset_id, mime: "image/png", alt_text: "Empty state" })]);
    const { data, meta } = await getAsset(ctx, up.asset_id);
    expect(data.equals(PNG)).toBe(true);
    expect(meta.target_id).toBe(ids.dataTable);
  });

  it("checks the declared type against the bytes, size and allowed types", async () => {
    const ctx = await ctxFor(db);
    await expect(uploadAsset(ctx, { target_id: ids.screen, filename: "x.png", mime: "image/png", data: Buffer.from("GIF89a....") })).rejects.toThrow(/not image\/png/);
    await expect(uploadAsset(ctx, { target_id: ids.screen, filename: "x.svg", mime: "image/svg+xml", data: Buffer.from("<svg/>") })).rejects.toThrow(/unsupported type/);
    await expect(uploadAsset(ctx, { target_id: ids.screen, filename: "big.png", mime: "image/png", data: Buffer.concat([PNG, Buffer.alloc(TEST_SETTINGS.assetMaxBytes)]) })).rejects.toThrow(/larger than/);
    await expect(uploadAsset(ctx, { target_id: ids.screen, filename: "bad.json", mime: "application/json", data: Buffer.from("{nope") })).rejects.toThrow(/not application\/json/);
  });

  it("redacts text files such as token JSON", async () => {
    const ctx = await ctxFor(db);
    const up = await uploadAsset(ctx, {
      target_id: ids.tokens,
      filename: "tokens.json",
      mime: "application/json",
      data: Buffer.from(JSON.stringify({ color: { primary: "#1F6FEB" }, figma_token: "figd_abc", api_key: "sk-ant-api03-abcdefghijklmnopqrstuv" })),
    });
    expect(up.redactions).toEqual([
      { kind: "api_key", count: 1 },
      { kind: "secret", count: 1 },
    ]);
    const { data } = await getAsset(ctx, up.asset_id);
    expect(JSON.parse(data.toString())).toEqual({ color: { primary: "#1F6FEB" }, figma_token: "[REDACTED:secret]", api_key: "[REDACTED:api_key]" });
  });

  it("lets only the uploader or a scope owner remove an asset", async () => {
    const uploader = await ctxFor(db, { email: "designer@example.com" });
    const up = await uploadAsset(uploader, { target_id: ids.screen, filename: "s.png", mime: "image/png", data: PNG });
    await expect(deleteAsset(await ctxFor(db, { email: "someone@example.com" }), up.asset_id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteAsset(uploader, up.asset_id);
    expect((await getArticle(uploader, ids.screen)).assets.map((a) => a.id)).not.toContain(up.asset_id);
    await expect(getAsset(uploader, up.asset_id)).rejects.toThrow(/not found/);
  });

  it("serves raw files sandboxed, and only to signed-in users", async () => {
    const ctx = await ctxFor(db);
    const up = await uploadAsset(ctx, { target_id: ids.dataTable, filename: "frame.png", mime: "image/png", data: PNG });
    expect((await fetch(`${base}/api/assets/${up.asset_id}`)).status).toBe(401);
    const res = await fetch(`${base}/api/assets/${up.asset_id}`, { headers: { authorization: "Bearer user" } });
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("returns images to agents as MCP image content and accepts uploads", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer user" } } }));
    const up = await client.callTool({
      name: "upload_asset",
      arguments: { target_id: ids.screen, filename: "orders.png", mime_type: "image/png", data_base64: PNG.toString("base64"), alt_text: "Orders list" },
    });
    const assetId = JSON.parse((up.content as { text: string }[])[0]!.text).asset_id;
    const got = await client.callTool({ name: "get_asset", arguments: { id: assetId } });
    const content = got.content as { type: string; data?: string; mimeType?: string; text?: string }[];
    expect(content[1]).toEqual({ type: "image", data: PNG.toString("base64"), mimeType: "image/png" });
    expect(JSON.parse(content[0]!.text!).alt_text).toBe("Orders list");
    await client.close();
  });
});

describe("source links", () => {
  it("adds a Figma link to a design item and refuses non-http links", async () => {
    const ctx = await ctxFor(db);
    await addSourceLinkTo(ctx, ids.screen, { system: "figma", url: "https://www.figma.com/design/abc/Orders?node-id=4-2", label: "Orders list frame" });
    expect((await getArticle(ctx, ids.screen)).source_links).toEqual([{ system: "figma", url: "https://www.figma.com/design/abc/Orders?node-id=4-2", label: "Orders list frame" }]);
    await expect(addSourceLinkTo(ctx, ids.screen, { system: "other", url: "javascript:alert(1)" })).rejects.toThrow(/http/);
  });
});

describe("share_to_library", () => {
  it("copies an approved item into the library, links the project to it and keeps assets and sources", async () => {
    const member = await ctxFor(db, { project: "order-service" });
    await uploadAsset(member, { target_id: ids.decision, filename: "diagram.png", mime: "image/png", data: PNG });
    await db.query("INSERT INTO source_links (target_kind, target_id, system, url) VALUES ('article', $1, 'pr', 'https://github.com/example/orders-api/pull/9')", [ids.decision]);

    const res = await shareToLibrary(member, { id: ids.decision, summary: "Idempotency keys apply to every write API", path: "Patterns/APIs" });
    await expect(shareToLibrary(member, { id: ids.decision, summary: "again" })).rejects.toThrow(/already pending/);

    // Library owners approve, not project owners.
    await adminSetMember(await ctxFor(db, { email: "admin@example.com" }), "order-service", "po@example.com", "owner");
    await expect(approveRevision(await ctxFor(db, { email: "po@example.com" }), res.revision_id)).rejects.toBeInstanceOf(ForbiddenError);
    const approved = await approveRevision(await ctxFor(db, { email: "admin@example.com" }), res.revision_id);
    const copyId = approved.library_copy_id as string;

    const copy = await getArticle(member, copyId);
    expect(copy).toMatchObject({ scope: { slug: "library", kind: "library" }, status: "published", path: "Patterns/APIs", title: "Use idempotency keys for order creation" });
    expect(copy.assets.map((a) => a.filename)).toEqual(["diagram.png"]);
    expect(copy.source_links.map((l) => l.url)).toEqual(["https://github.com/example/orders-api/pull/9"]);
    expect(copy.related).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: "published_as", direction: "in", id: ids.decision }),
        expect.objectContaining({ relation: "uses", direction: "in", kind: "scope", scope: "order-service" }),
      ]),
    );

    const other = await ctxFor(db, { project: "merchant-portal" });
    const hits = await searchKnowledge(other, { query: "idempotency key header" });
    expect(hits.articles.map((h) => h.id)).toContain(copyId);
    expect((await getProjectContext(member)).uses.map((u: { id: string }) => u.id)).toContain(copyId);

    await db.query("DELETE FROM scope_members");
    await expect(shareToLibrary(member, { id: ids.decision, summary: "again" })).rejects.toThrow(/already published/);
    await expect(shareToLibrary(member, { id: copyId, summary: "x" })).rejects.toThrow(/already in the library/);
    // A draft can be proposed, but the share can't be approved before the draft itself.
    const draftShare = await shareToLibrary(member, { id: ids.draft, summary: "x" });
    await expect(approveRevision(await ctxFor(db, { email: "admin@example.com" }), draftShare.revision_id)).rejects.toThrow(/still a draft/);
  });
});

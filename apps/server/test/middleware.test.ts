import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { accessLog } from "../src/http/middleware.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let server: Server;
let base: string;

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({
    db,
    authenticate: devAuthenticator("a=a@example.com,b=b@example.com,c=c@example.com"),
    settings: { ...TEST_SETTINGS, rateLimitPerMinute: 5, assetMaxBytes: 3 * 1024 * 1024 },
  }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

describe("rate limiting", () => {
  it("limits each user separately and says when to retry", async () => {
    const get = (token: string) => fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; i < 5; i++) expect((await get("a")).status).toBe(200);
    const limited = await get("a");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await get("b")).status).toBe(200);
  });
});

describe("request size", () => {
  it("caps bodies at 1 MB except on authenticated upload routes", async () => {
    const big = JSON.stringify({ q: "x".repeat(2 * 1024 * 1024) });
    const anon = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(anon.status).toBe(401); // rejected before the body is parsed
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: big });
    expect(login.status).toBe(413);
    const malformed = await fetch(`${base}/api/me`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer b" }, body: "{nope" });
    expect(malformed.status).toBe(400);
  });

  it("still accepts large uploads on the asset route once signed in", async () => {
    const target = (await db.query("SELECT id FROM articles LIMIT 1")).rows[0].id;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1.5 * 1024 * 1024)]);
    const res = await fetch(`${base}/api/assets`, {
      method: "POST",
      headers: { authorization: "Bearer c", "content-type": "application/json" },
      body: JSON.stringify({ target_id: target, filename: "big.png", mime: "image/png", data_base64: png.toString("base64") }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).size_bytes).toBe(png.length);
  });
});

describe("health and logging", () => {
  it("reports database and embeddings status", async () => {
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true, database: "ok", embeddings: "off" });
  });

  it("logs one JSON line per request without query strings", async () => {
    const lines: string[] = [];
    const mw = accessLog((l) => lines.push(l));
    const res = { locals: { actor: { id: "u1" } }, statusCode: 200, on: (_e: string, fn: () => void) => fn() };
    mw({ method: "GET", path: "/api/search" } as never, res as never, () => undefined);
    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({ method: "GET", path: "/api/search", status: 200, user: "u1" });
    expect(entry).not.toHaveProperty("query");
  });
});

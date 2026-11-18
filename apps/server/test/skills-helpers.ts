import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { apiTokenAuthenticator, chain, devAuthenticator } from "../src/auth/index.js";
import type { Settings } from "../src/config.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { upsertUser } from "../src/core/users.js";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills");

/** The fixture marketplace as files (path → bytes), optionally edited. */
export function fixtureFiles(edit?: (files: Map<string, Uint8Array>) => void): Map<string, Uint8Array> {
  const root = path.join(FIXTURES, "marketplace");
  const out = new Map<string, Uint8Array>();
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.set(r, new Uint8Array(readFileSync(p)));
    }
  };
  walk(root, "");
  edit?.(out);
  return out;
}

export function zipOfFiles(files: Map<string, Uint8Array>, top = "fixture-repo"): Buffer {
  return Buffer.from(zipSync(Object.fromEntries([...files].map(([p, d]) => [top ? `${top}/${p}` : p, d]))));
}

export const TOKENS = {
  admin: "admin@example.com",
  admin2: "admin2@example.com",
  manager: "manager@example.com",
  reviewer: "reviewer@example.com",
  alice: "alice@example.com",
  bob: "bob@example.com",
  auditor: "auditor@example.com",
  carol: "carol@example.com",
  svc: "svc-bot@example.com",
};

export interface TestApp {
  server: Server;
  base: string;
  ids: Record<keyof typeof TOKENS, string>;
  call: (who: keyof typeof TOKENS | string, method: string, p: string, body?: unknown) => Promise<{ status: number; body: any; headers: Headers }>;
  raw: (who: keyof typeof TOKENS | string, method: string, p: string, body: Buffer, headers?: Record<string, string>) => Promise<{ status: number; body: any; buf: Buffer; headers: Headers }>;
  close: () => Promise<void>;
}

/** Starts the app with dev tokens named after TOKENS and creates their accounts (the managers get Skills manager). */
export async function startApp(db: Db, settings: Settings, extra: Record<string, string> = {}): Promise<TestApp> {
  const pairs = Object.entries({ ...TOKENS, ...extra }).map(([t, e]) => `${t}=${e}`).join(",");
  const ids = {} as Record<keyof typeof TOKENS, string>;
  for (const [t, email] of Object.entries({ ...TOKENS, ...extra })) {
    const a = await upsertUser(db, { subject: `dev:${email}`, email, kind: email.startsWith("svc-") ? "service" : "human" });
    ids[t as keyof typeof TOKENS] = a.id;
  }
  await db.query("UPDATE users SET approved_at = now() WHERE approved_at IS NULL");
  await db.query("UPDATE users SET is_admin = true WHERE email = $1", [TOKENS.admin2]);
  await db.query("INSERT INTO user_roles (user_id, role) VALUES ($1, 'skills_manager'), ($2, 'skills_manager'), ($3, 'auditor') ON CONFLICT DO NOTHING", [ids.manager, ids.reviewer, ids.auditor]);
  // The port is bound only once the accounts exist, so nothing reaches the server half set up.
  // Personal API tokens work too, as in every mode (authenticatorFor chains them first).
  const server = createApp({ db, authenticate: chain(apiTokenAuthenticator(db), devAuthenticator(pairs)), settings }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: TestApp["call"] = async (who, method, p, body) => {
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${who}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const raw: TestApp["raw"] = async (who, method, p, body, headers = {}) => {
    const withBody = method !== "GET" && method !== "HEAD";
    const res = await fetch(base + p, { method, headers: { authorization: `Bearer ${who}`, ...(withBody ? { "content-type": "application/octet-stream" } : {}), ...headers }, body: withBody ? new Uint8Array(body) : undefined });
    const buf = Buffer.from(await res.arrayBuffer());
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(buf.toString("utf8"));
    } catch {
      /* binary */
    }
    return { status: res.status, body: parsed, buf, headers: res.headers };
  };
  return { server, base, ids, call, raw, close: () => new Promise((r) => server.close(() => r())) };
}

export const enc = new TextEncoder();

import express from "express";
import { readdirSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiTokenAuthenticator, chain, devAuthenticator, sessionAuthenticator } from "../src/auth/index.js";
import { createLocalUser } from "../src/auth/local.js";
import { trustProxyFrom } from "../src/config.js";
import { EMBEDDING_DIMS, startIndexer, type Embedder } from "../src/core/embeddings.js";
import { ChangeBus, CHANGES_CHANNEL, startChangeRelay, waitFor, wake, WAKE_CHANNEL, type ChangeRelay } from "../src/core/events.js";
import { startJobs } from "../src/core/freshness.js";
import { flushDeliveries, track } from "../src/core/notify.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { seedDemo } from "../src/scripts/demo-data.js";
import { closeServer, drainSteps, Lifecycle, shutdown } from "../src/http/lifecycle.js";
import { freshDb, TEST_DATABASE_URL, TEST_SETTINGS } from "./helpers.js";

/** Running several replicas: migrations, probes, graceful shutdown, live updates across pods, shared throttling, jobs. */

let db: Db;
const pools: Db[] = [];
const servers: Server[] = [];
const pool = () => {
  const p = createPool(TEST_DATABASE_URL);
  pools.push(p);
  return p;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(20);
  }
  return false;
}
async function listen(app: express.Express) {
  const server = app.listen(0);
  servers.push(server);
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  ({ db } = await freshDb());
});
afterAll(async () => {
  for (const s of servers) if (s.listening) await new Promise((r) => s.close(r));
  for (const p of pools) await p.end().catch(() => undefined);
  await db.end();
});

describe("migrations", () => {
  it("apply once when several replicas start together", async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const [a, b, c] = [pool(), pool(), pool()];
    await Promise.all([migrate(a), migrate(b), migrate(c)]);
    const files = readdirSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations")).filter((f) => f.endsWith(".sql"));
    const { rows } = await db.query("SELECT count(*)::int AS n, count(DISTINCT name)::int AS d FROM schema_migrations");
    expect(rows[0]).toEqual({ n: files.length, d: files.length });
    // And again: nothing left to do.
    await Promise.all([migrate(a), migrate(b)]);
    expect((await db.query("SELECT count(*)::int AS n FROM schema_migrations")).rows[0].n).toBe(files.length);
    await seedDemo(db);
  });
});

describe("probes", () => {
  it("/readyz is 503 while starting and shutting down, 200 when ready; /livez never asks the database", async () => {
    const lifecycle = new Lifecycle();
    const { base } = await listen(createApp({ db, authenticate: devAuthenticator("t=a@example.com"), settings: TEST_SETTINGS, lifecycle }));
    const get = async (p: string) => {
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json(), connection: res.headers.get("connection"), cache: res.headers.get("cache-control") };
    };
    expect(await get("/readyz")).toMatchObject({ status: 503, body: { ready: false, phase: "starting" }, cache: "no-store" });
    lifecycle.phase = "ready";
    expect(await get("/readyz")).toMatchObject({ status: 200, body: { ready: true, phase: "ready", database: "ok" } });
    expect(await get("/livez")).toMatchObject({ status: 200, body: { ok: true } });
    expect((await get("/healthz")).body).toMatchObject({ ok: true, database: "ok" });
    lifecycle.phase = "stopping";
    const stopping = await get("/readyz");
    expect(stopping).toMatchObject({ status: 503, body: { ready: false, phase: "stopping" } });
    // Keep-alive connections are told to close, so clients reconnect to another replica.
    expect(stopping.connection).toBe("close");
    expect((await get("/livez")).status).toBe(200);
  });

  it("/readyz is 503 when the database is unreachable, while /livez stays 200", async () => {
    const lifecycle = new Lifecycle();
    lifecycle.phase = "ready";
    const broken = createPool("postgres://nobody:nothing@127.0.0.1:1/none");
    pools.push(broken);
    const { base } = await listen(createApp({ db: broken, authenticate: devAuthenticator("t=a@example.com"), settings: TEST_SETTINGS, lifecycle }));
    const res = await fetch(`${base}/readyz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false, phase: "ready", database: "unreachable" });
    expect((await fetch(`${base}/livez`)).status).toBe(200);
  });
});

describe("graceful shutdown", () => {
  function slowApp(ms: () => number) {
    const app = express();
    app.get("/slow", async (_req, res) => {
      await sleep(ms());
      res.json({ done: true });
    });
    return app;
  }

  it("stops taking new connections, lets in-flight requests finish, then runs the remaining steps in order", async () => {
    const lifecycle = new Lifecycle();
    lifecycle.phase = "ready";
    const { server, base } = await listen(slowApp(() => 300));
    const inflight = fetch(`${base}/slow`).then((r) => r.json());
    await sleep(50);
    const order: string[] = [];
    const done = shutdown(lifecycle, {
      server,
      timeoutMs: 3000,
      before: [{ name: "streams", run: () => void order.push("streams") }],
      after: [
        { name: "jobs", run: async () => void (await sleep(20), order.push("jobs")) },
        { name: "pool", run: () => void order.push("pool") },
      ],
      log: (m) => order.push(`log: ${m}`),
    });
    expect(lifecycle.phase).toBe("stopping");
    await sleep(20);
    await expect(fetch(`${base}/slow`)).rejects.toThrow();
    expect(await inflight).toEqual({ done: true });
    expect(await done).toBe(true);
    expect(order).toEqual(["streams", "jobs", "pool"]);
    expect(server.listening).toBe(false);
  });

  it("cuts off requests still running when time is up, and still closes the pool", async () => {
    const lifecycle = new Lifecycle();
    const { server, base } = await listen(slowApp(() => 5000));
    const inflight = fetch(`${base}/slow`).then(
      () => "answered",
      () => "cut off",
    );
    await sleep(50);
    const logs: string[] = [];
    let closed = false;
    const t0 = Date.now();
    const clean = await shutdown(lifecycle, { server, timeoutMs: 300, after: [{ name: "pool", run: () => void (closed = true) }], log: (m) => logs.push(m) });
    expect(clean).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(await inflight).toBe("cut off");
    expect(closed).toBe(true);
    expect(logs.join("\n")).toMatch(/cut off/);
  });

  it("still sends pending notifications when a job run outlasts the timeout, and closes the pool", async () => {
    const lifecycle = new Lifecycle();
    const { server } = await listen(slowApp(() => 0));
    const sent: string[] = [];
    // An email a request queued just before the signal, and one the job queues while it runs.
    void track(sleep(300).then(() => sent.push("from a request")));
    const job = (async () => {
      await sleep(100);
      void track(sleep(200).then(() => sent.push("from the job")));
      await sleep(60_000); // a long advisory refresh that can't be interrupted
    })();
    let closed = false;
    const logs: string[] = [];
    const t0 = Date.now();
    const clean = await shutdown(lifecycle, {
      server,
      timeoutMs: 2000,
      after: drainSteps({ jobs: () => job, flush: () => flushDeliveries(), relay: async () => undefined, closePool: async () => void (closed = true), reserveMs: 500 }),
      log: (m) => logs.push(m),
    });
    expect(clean).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3500);
    expect(sent).toEqual(["from a request", "from the job"]);
    expect(closed).toBe(true);
    expect(logs).toEqual(["background jobs: still running when time was up"]);
  });

  it("closeServer resolves at once for a server that isn't listening", async () => {
    const { server } = await listen(slowApp(() => 0));
    await new Promise((r) => server.close(r));
    expect(await closeServer(server, 1000)).toBe("drained");
  });

  it("ends open event streams so browsers reconnect elsewhere", async () => {
    const bus = new ChangeBus();
    const app = express();
    app.get("/events", (req, res) => bus.stream(req, res));
    const { base } = await listen(app);
    const res = await fetch(`${base}/events`);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toMatch(/retry: 5000/);
    expect(await until(() => bus.openStreams === 1)).toBe(true);
    bus.closeStreams();
    let ended = false;
    for (let i = 0; i < 5 && !ended; i++) ended = (await reader.read()).done;
    expect(ended).toBe(true);
    expect(bus.openStreams).toBe(0);
  });

  it("background jobs' stop() waits for the run in progress and starts no more", async () => {
    await db.query("UPDATE chunks SET embedding = NULL");
    let calls = 0;
    let finished = 0;
    const slow: Embedder = {
      model: "slow-test",
      dims: EMBEDDING_DIMS,
      embedQuery: async () => new Array(EMBEDDING_DIMS).fill(0.1),
      embedDocuments: async (texts) => {
        calls++;
        await sleep(200);
        finished++;
        return texts.map(() => new Array(EMBEDDING_DIMS).fill(0.1));
      },
    };
    const indexer = startIndexer(db, slow);
    expect(await until(() => calls === 1)).toBe(true);
    await indexer.stop();
    expect(finished).toBe(calls);
    const after = calls;
    await sleep(300);
    expect(calls).toBe(after);
  });
});

describe("background jobs with several replicas", () => {
  it("maintenance runs on one replica at a time (advisory lock)", async () => {
    const holder = await db.connect();
    try {
      await db.query("INSERT INTO auth_throttle (key, failures, reset_at) VALUES ('old', 3, now() - interval '1 hour')");
      // Another replica holds the maintenance lock: this one skips its run.
      await holder.query("SELECT pg_advisory_lock(7402211)");
      const jobs = startJobs(db, { findingDays: 90, articleDays: 90, intervalHours: 6 }, () => {});
      await jobs.run();
      expect((await db.query("SELECT 1 FROM auth_throttle WHERE key = 'old'")).rowCount).toBe(1);
      await holder.query("SELECT pg_advisory_unlock(7402211)");
      await jobs.run();
      expect((await db.query("SELECT 1 FROM auth_throttle WHERE key = 'old'")).rowCount).toBe(0);
      await jobs.stop();
    } finally {
      holder.release();
    }
  });
});

describe("live page refresh across replicas", () => {
  const relays: ChangeRelay[] = [];
  afterAll(async () => {
    for (const r of relays) await r.stop();
  });
  const replica = async () => {
    const bus = new ChangeBus();
    const relay = startChangeRelay(pool(), bus, () => {}, { publishDelayMs: 10, retryMs: 100 });
    relays.push(relay);
    await relay.ready;
    let heard = 0;
    bus.subscribe(() => heard++);
    return { bus, relay, heard: () => heard };
  };

  it("a change on one replica reaches the pages on the others, once, and the sender doesn't hear its own echo", async () => {
    const a = await replica();
    const b = await replica();
    const c = await replica();
    expect(a.relay.listening && b.relay.listening && c.relay.listening).toBe(true);
    a.bus.emit();
    expect(await until(() => b.heard() === 1 && c.heard() === 1)).toBe(true);
    await sleep(150);
    expect([a.heard(), b.heard(), c.heard()]).toEqual([1, 1, 1]);
    // Bursts become one message.
    for (let i = 0; i < 20; i++) b.bus.emit();
    expect(await until(() => a.heard() === 2)).toBe(true);
    await sleep(150);
    expect([a.heard(), b.heard(), c.heard()]).toEqual([2, 21, 2]);
  });

  it("says only that something changed", async () => {
    const listener = await db.connect();
    try {
      const got: string[] = [];
      listener.on("notification", (m) => got.push(m.payload ?? ""));
      await listener.query(`LISTEN ${CHANGES_CHANNEL}`);
      const a = await replica();
      a.bus.emit();
      expect(await until(() => got.length === 1)).toBe(true);
      expect(Object.keys(JSON.parse(got[0]!))).toEqual(["from"]);
    } finally {
      await listener.query(`UNLISTEN ${CHANGES_CHANNEL}`);
      listener.release();
    }
  });

  it("reconnects after losing its connection, and refreshes pages in case it missed something", async () => {
    const a = await replica();
    const b = await replica();
    await db.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database() AND query = ANY($1)",
      [[`LISTEN ${CHANGES_CHANNEL}`, `LISTEN ${WAKE_CHANNEL}`]],
    );
    expect(await until(() => b.heard() >= 1 && b.relay.listening && a.relay.listening)).toBe(true);
    const before = b.heard();
    a.bus.emit();
    expect(await until(() => b.heard() === before + 1)).toBe(true);
  });

  it("carries session wake-ups between replicas, as opaque keys only", async () => {
    const listener = await db.connect();
    try {
      const got: string[] = [];
      listener.on("notification", (m) => got.push(m.payload ?? ""));
      await listener.query(`LISTEN ${WAKE_CHANNEL}`);
      const a = await replica();
      // A wake here goes to the other replicas…
      wake(["q:one", null, "s:two"]);
      expect(await until(() => got.length === 1)).toBe(true);
      expect(JSON.parse(got[0]!).keys).toEqual(["q:one", "s:two"]);
      // …and one from another replica wakes waiters here.
      const waiting = waitFor(["s:remote"], 3000);
      await db.query("SELECT pg_notify($1, $2)", [WAKE_CHANNEL, JSON.stringify({ from: "another-replica", keys: ["s:remote"] })]);
      expect(await waiting).toBe(true);
      // Junk is harmless: the relay keeps working.
      await db.query("SELECT pg_notify($1, $2)", [WAKE_CHANNEL, "not json"]);
      const after = waitFor(["s:after"], 3000);
      await db.query("SELECT pg_notify($1, $2)", [WAKE_CHANNEL, JSON.stringify({ from: "another-replica", keys: ["s:after"] })]);
      expect(await after).toBe(true);
      expect(a.relay.listening).toBe(true);
    } finally {
      await listener.query(`UNLISTEN ${WAKE_CHANNEL}`);
      listener.release();
    }
  });

  it("stops: sends what is pending, then hears nothing more", async () => {
    const a = await replica();
    const b = await replica();
    a.bus.emit();
    await a.relay.stop();
    expect(await until(() => b.heard() === 1)).toBe(true);
    await b.relay.stop();
    const c = await replica();
    c.bus.emit();
    await sleep(200);
    expect(b.heard()).toBe(1);
    expect(a.relay.listening || b.relay.listening).toBe(false);
  });
});

describe("sign-in throttling", () => {
  const settings = { ...TEST_SETTINGS, authMode: "local" as const, adminEmails: [] };
  const replicaApp = (trustProxy?: boolean | number | string) =>
    listen(createApp({ db, authenticate: chain(apiTokenAuthenticator(db), sessionAuthenticator(db)), settings, trustProxy }));
  const login = (base: string, password: string, ip = "203.0.113.7") =>
    fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify({ email: "rep@example.com", password }) }).then(
      (r) => r.status,
    );

  beforeAll(async () => {
    await createLocalUser(db, { email: "rep@example.com", password: "replica password 1" });
  });

  it("is shared by every replica and survives a restart, and stores no emails or addresses", async () => {
    const a = await replicaApp();
    const b = await replicaApp();
    for (let i = 0; i < 5; i++) expect(await login(a.base, "nope")).toBe(401);
    for (let i = 0; i < 5; i++) expect(await login(b.base, "nope")).toBe(401);
    expect(await login(a.base, "replica password 1")).toBe(429);
    expect(await login(b.base, "replica password 1")).toBe(429);
    // A deploy restarts every replica: the count stays.
    const c = await replicaApp();
    expect(await login(c.base, "replica password 1")).toBe(429);
    const keys = (await db.query("SELECT key FROM auth_throttle")).rows.map((r: { key: string }) => r.key);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{64}$/);
    // Another client address isn't blocked by this one's failures.
    expect(await login(c.base, "replica password 1", "203.0.113.8")).toBe(200);
  });

  it("believes X-Forwarded-For only from trusted proxies (TRUST_PROXY)", async () => {
    expect(trustProxyFrom("loopback")).toBe("loopback");
    expect(trustProxyFrom("uniquelocal, loopback")).toBe("uniquelocal, loopback");
    expect(trustProxyFrom("2")).toBe(2);
    expect(trustProxyFrom("true")).toBe(true);
    expect(trustProxyFrom("false")).toBe(false);
    // Not trusted: every client looks the same (the proxy), so the address blocked above blocks this one too.
    const untrusting = await replicaApp(false);
    await db.query("DELETE FROM auth_throttle");
    for (let i = 0; i < 10; i++) await login(untrusting.base, "nope", `198.51.100.${i}`);
    expect(await login(untrusting.base, "replica password 1", "198.51.100.200")).toBe(429);
  });

  it("with TRUST_PROXY=1 behind one load balancer, a forged X-Forwarded-For can't dodge the per-account limit", async () => {
    // The test client stands in for the load balancer (a private address appending the client's address).
    const forged = (i: number) => `198.18.${i}.1, 10.0.0.9`;
    const oneHop = await replicaApp(trustProxyFrom("1"));
    await db.query("DELETE FROM auth_throttle");
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) statuses.push(await login(oneHop.base, "nope", forged(i)));
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    // Why not uniquelocal: it believes every private-address hop, so a client on a private address picks its own.
    const everyPrivateHop = await replicaApp(trustProxyFrom("loopback, uniquelocal"));
    await db.query("DELETE FROM auth_throttle");
    const dodged: number[] = [];
    for (let i = 0; i < 30; i++) dodged.push(await login(everyPrivateHop.base, "nope", forged(i)));
    expect(dodged.every((s) => s === 401)).toBe(true);
    await db.query("DELETE FROM auth_throttle");
  });
});

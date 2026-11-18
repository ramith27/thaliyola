import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, settingsFrom } from "../src/config.js";
import { checkComplete, validateConfig, validateOptions, validateSecretInput, defaultName, showsTail, targetChanged } from "../src/core/connections/kinds.js";
import { addressClass, canonicalIp, ownDatabaseHosts, pinnedFetch, resolveTarget, type NetPolicy } from "../src/core/connections/network.js";
import { retryAfterMs } from "../src/core/connections/remote.js";
import { errorText } from "../src/core/connections/sync.js";
import { hintOf, open, openJson, parseKey, scrubSecrets, seal, sealJson, SecretsUnavailableError } from "../src/core/secrets.js";

const keyA = randomBytes(32);
const keyB = randomBytes(32);

describe("secrets", () => {
  it("seals and opens, with a fresh IV each time", () => {
    const a = seal("hunter2-very-secret", { key: keyA }, "connection:1");
    const b = seal("hunter2-very-secret", { key: keyA }, "connection:1");
    expect(a).toMatch(/^v1\$[\w-]+\$[\w-]+\$[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("hunter2");
    expect(open(a, { key: keyA }, "connection:1")).toEqual({ plain: "hunter2-very-secret", rotated: false });
    expect(openJson(sealJson({ password: "p", token: "t" }, { key: keyA }, "x"), { key: keyA }, "x").value).toEqual({ password: "p", token: "t" });
  });

  it("detects tampering, the wrong key and a value moved to another row", () => {
    const blob = seal("secret value", { key: keyA }, "connection:1");
    const [v, iv, tag, ct] = blob.split("$") as [string, string, string, string];
    const flipped = Buffer.from(ct, "base64url");
    flipped[0]! ^= 1;
    expect(() => open([v, iv, tag, flipped.toString("base64url")].join("$"), { key: keyA }, "connection:1")).toThrow(SecretsUnavailableError);
    const badTag = Buffer.from(tag, "base64url");
    badTag[3]! ^= 1;
    expect(() => open([v, iv, badTag.toString("base64url"), ct].join("$"), { key: keyA }, "connection:1")).toThrow(SecretsUnavailableError);
    expect(() => open(blob, { key: keyB }, "connection:1")).toThrow(/CONNECTIONS_KEY/);
    expect(() => open(blob, { key: keyA }, "connection:2")).toThrow(SecretsUnavailableError);
    expect(() => open("v2$a$b$c", { key: keyA }, "connection:1")).toThrow(/format/);
  });

  it("rotates: the old key still opens, and says so", () => {
    const blob = seal("rotate me", { key: keyA }, "c");
    expect(open(blob, { key: keyB, oldKey: keyA }, "c")).toEqual({ plain: "rotate me", rotated: true });
    expect(open(seal("new", { key: keyB, oldKey: keyA }, "c"), { key: keyB, oldKey: keyA }, "c")).toEqual({ plain: "new", rotated: false });
  });

  it("refuses to seal or open without a key", () => {
    expect(() => seal("x", undefined, "c")).toThrow(/CONNECTIONS_KEY isn't set/);
    expect(() => seal("x", {}, "c")).toThrow(SecretsUnavailableError);
    expect(() => open(seal("x", { key: keyA }, "c"), {}, "c")).toThrow(/CONNECTIONS_KEY isn't set/);
  });

  it("parses keys: 32 bytes of base64 or base64url only", () => {
    expect(parseKey(keyA.toString("base64"))).toEqual(keyA);
    expect(parseKey(keyA.toString("base64url"))).toEqual(keyA);
    expect(() => parseKey(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
    expect(() => parseKey("not a key!")).toThrow(/base64/);
  });

  it("validates keys in the config, and keeps them out of everything printable", () => {
    const base = { DATABASE_URL: "postgres://t:t@db.internal:5432/t" };
    expect(() => loadConfig({ ...base, CONNECTIONS_KEY: "short" })).toThrow(/CONNECTIONS_KEY/);
    expect(() => loadConfig({ ...base, CONNECTIONS_KEY_OLD: keyA.toString("base64") })).toThrow(/needs CONNECTIONS_KEY/);
    const s = settingsFrom(loadConfig({ ...base, CONNECTIONS_KEY: keyA.toString("base64"), CONNECTIONS_KEY_OLD: keyB.toString("base64"), QUERY_MAX_ROWS: "50" }));
    expect(s.connections).toMatchObject({ enabled: true, allowPrivate: false, queryMaxRows: 50, queryTimeoutMs: 15000, ownHosts: ["db.internal"] });
    expect(s.connections!.keys.key).toEqual(keyA);
    expect(s.connections!.keys.oldKey).toEqual(keyB);
    expect(s.connections!.allowLocal).toBeUndefined();
    expect(() => loadConfig({ ...base, QUERY_MAX_ROWS: "5000" })).toThrow();
  });

  it("hints only long secrets and scrubs secrets from messages", () => {
    expect(hintOf("xoxb-1234567890-abcd")).toBe("abcd");
    expect(hintOf("short-pass")).toBe("");
    expect(hintOf("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe("");
    expect(scrubSecrets('password "p@ss w0rd" rejected for p%40ss%20w0rd', ["p@ss w0rd"])).toBe('password "[secret]" rejected for [secret]');
    expect(errorText(new Error("connect to postgres://u:hunter22@db failed with hunter22"), { password: "hunter22" })).not.toContain("hunter22");
  });
});

describe("network guards", () => {
  it("classifies addresses, including mapped and metadata ones", () => {
    expect(addressClass("8.8.8.8")).toBe("public");
    expect(addressClass("10.1.2.3")).toBe("private");
    expect(addressClass("172.20.0.1")).toBe("private");
    expect(addressClass("100.64.0.1")).toBe("private");
    expect(addressClass("127.0.0.1")).toBe("loopback");
    expect(addressClass("::1")).toBe("loopback");
    expect(addressClass("::ffff:127.0.0.1")).toBe("loopback");
    expect(addressClass("::ffff:7f00:1")).toBe("loopback");
    expect(addressClass("169.254.169.254")).toBe("link_local");
    expect(addressClass("fd00:ec2::254")).toBe("link_local");
    expect(addressClass("fe80::1")).toBe("link_local");
    expect(addressClass("::ffff:a9fe:a9fe")).toBe("link_local");
    expect(addressClass("0.0.0.0")).toBe("unspecified");
    expect(addressClass("::")).toBe("unspecified");
    expect(addressClass("fd12::1")).toBe("private");
    expect(addressClass("2606:4700::1")).toBe("public");
  });

  it("sees through every way of writing an IPv4 address as IPv6", () => {
    // IPv4-mapped, expanded or zero-prefixed: the OS sends these to the IPv4 address.
    for (const ip of ["0::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:FFFF:7F00:0001", "::FFFF:127.0.0.1", "0:0:0:0:0:ffff:127.0.0.1", "[::ffff:7f00:1]"])
      expect(addressClass(ip), ip).toBe("loopback");
    // IPv4-compatible (::/96), IPv4-translated (::ffff:0:0:0/96) and NAT64 (64:ff9b::/96).
    expect(addressClass("::7f00:1")).toBe("loopback");
    expect(addressClass("::127.0.0.1")).toBe("loopback");
    expect(addressClass("::ffff:0:7f00:1")).toBe("loopback");
    expect(addressClass("64:ff9b::7f00:1")).toBe("loopback");
    for (const ip of ["0:0:0:0:0:ffff:a9fe:a9fe", "0::ffff:a9fe:a9fe", "::a9fe:a9fe", "64:ff9b::169.254.169.254"]) expect(addressClass(ip), ip).toBe("link_local");
    expect(addressClass("0:0:0:0:0:ffff:a00:9")).toBe("private");
    expect(addressClass("0:0:0:0:0:0:0:1")).toBe("loopback");
    expect(addressClass("0000::0001")).toBe("loopback");
    expect(addressClass("0:0:0:0:0:0:0:0")).toBe("unspecified");
    expect(addressClass("not-an-ip")).toBe("unspecified");

    expect(canonicalIp("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
    expect(canonicalIp("::ffff:10.0.0.9")).toBe("10.0.0.9");
    expect(canonicalIp("2001:0DB8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8::1");
    expect(canonicalIp("2001:db8:0:1:0:0:0:1")).toBe("2001:db8:0:1::1");
    expect(canonicalIp("[fe80::1%en0]")).toBe("fe80::1");
    expect(canonicalIp("::1")).toBe("::1");
    expect(canonicalIp("::")).toBe("::");
    expect(canonicalIp("db.example.com")).toBeNull();
  });

  const dns: Record<string, string[]> = {
    "api.example.com": ["93.184.216.34"],
    "intranet.example.com": ["10.0.0.5"],
    "mixed.example.com": ["93.184.216.34", "10.0.0.5"],
    "metadata.example.com": ["169.254.169.254"],
    "localhost": ["127.0.0.1"],
    "db.internal": ["10.0.0.9"],
    "replica-alias.internal": ["10.0.0.9"],
  };
  const policy = (p: Partial<NetPolicy> = {}): NetPolicy => ({
    allowPrivate: false,
    ownHosts: ["db.internal"],
    lookup: async (h) => {
      const a = dns[h];
      if (!a) throw new Error("ENOTFOUND");
      return a.map((address) => ({ address }));
    },
    ...p,
  });

  it("HTTP kinds reach public addresses only, unless private networks are allowed", async () => {
    await expect(resolveTarget("api.example.com", "http", policy())).resolves.toMatchObject({ address: "93.184.216.34", family: 4 });
    await expect(resolveTarget("intranet.example.com", "http", policy())).rejects.toThrow(/private network.*CONNECTIONS_ALLOW_PRIVATE/);
    await expect(resolveTarget("mixed.example.com", "http", policy())).rejects.toThrow(/private network/);
    await expect(resolveTarget("intranet.example.com", "http", policy({ allowPrivate: true }))).resolves.toMatchObject({ address: "10.0.0.5" });
    await expect(resolveTarget("nowhere.example.com", "http", policy())).rejects.toThrow(/couldn't be found/);
  });

  it("databases may be private, but never loopback, metadata or Thaliyola's own database", async () => {
    await expect(resolveTarget("intranet.example.com", "database", policy())).resolves.toMatchObject({ address: "10.0.0.5" });
    for (const host of ["localhost", "127.0.0.1", "[::1]", "::ffff:127.0.0.1"]) await expect(resolveTarget(host, "database", policy({ allowPrivate: true }))).rejects.toThrow(/loopback/);
    for (const host of ["metadata.example.com", "169.254.169.254", "fd00:ec2::254"]) await expect(resolveTarget(host, "database", policy({ allowPrivate: true }))).rejects.toThrow(/metadata/);
    await expect(resolveTarget("0.0.0.0", "database", policy())).rejects.toThrow(/isn't a host address/);
    await expect(resolveTarget("DB.internal", "database", policy())).rejects.toThrow(/Thaliyola's own database/);
    await expect(resolveTarget("replica-alias.internal", "database", policy())).rejects.toThrow(/Thaliyola's own database/);
    await expect(resolveTarget("10.0.0.9", "database", policy())).rejects.toThrow(/Thaliyola's own database/);
    // However its address is written.
    for (const host of ["::ffff:10.0.0.9", "[0:0:0:0:0:ffff:a00:9]", "::ffff:a00:9"]) await expect(resolveTarget(host, "database", policy()), host).rejects.toThrow(/Thaliyola's own database/);
    await expect(resolveTarget("10.0.0.9", "database", policy({ ownHosts: ["::ffff:10.0.0.9"] }))).rejects.toThrow(/Thaliyola's own database/);
    await expect(resolveTarget("2001:db8::9", "database", policy({ ownHosts: ["2001:0db8:0:0:0:0:0:9"] }))).rejects.toThrow(/Thaliyola's own database/);
    // A DNS answer in a mapped form is checked as the address it routes to.
    const mapped = policy({ lookup: async (h) => [{ address: h === "sneaky.example.com" ? "0:0:0:0:0:ffff:7f00:1" : "::ffff:a00:9" }] });
    await expect(resolveTarget("sneaky.example.com", "database", mapped)).rejects.toThrow(/loopback/);
    await expect(resolveTarget("alias.example.com", "database", mapped)).rejects.toThrow(/Thaliyola's own database/);
    // Loopback and metadata addresses in any spelling.
    for (const host of ["0::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::7f00:1"]) await expect(resolveTarget(host, "database", policy()), host).rejects.toThrow(/loopback/);
    await expect(resolveTarget("0:0:0:0:0:ffff:a9fe:a9fe", "database", policy())).rejects.toThrow(/metadata/);
    // What's connected to is the canonical address.
    await expect(resolveTarget("::ffff:10.0.0.5", "database", policy())).resolves.toEqual({ host: "10.0.0.5", address: "10.0.0.5", family: 4 });
    expect(ownDatabaseHosts("postgres://u:p@[::ffff:10.0.0.9]:5432/x")).toEqual(["10.0.0.9"]);
    expect(ownDatabaseHosts("postgres://u:p@[::1]:5432/x")).toEqual(["::1"]);
    expect(ownDatabaseHosts("not a url")).toEqual([]);
  });

  describe("pinned HTTP", () => {
    let server: Server;
    let port: number;
    const seen: { url: string; host: string; auth?: string }[] = [];
    let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => res.end("ok");
    beforeAll(async () => {
      server = createServer((req, res) => {
        seen.push({ url: req.url ?? "", host: req.headers.host ?? "", auth: req.headers.authorization });
        handler(req, res);
      }).listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      port = (server.address() as AddressInfo).port;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it("connects to the checked address and never looks the name up again (DNS rebinding)", async () => {
      let lookups = 0;
      // The first answer is checked and used; a rebinding server would answer differently the second time.
      const p: NetPolicy = { allowPrivate: false, allowLocal: true, lookup: async () => (lookups++ === 0 ? [{ address: "127.0.0.1" }] : [{ address: "10.9.9.9" }]) };
      handler = (_req, res) => res.end("pinned");
      const res = await pinnedFetch(`http://api.rebind.test:${port}/hello`, "http", p);
      expect(res).toMatchObject({ status: 200, text: "pinned" });
      expect(lookups).toBe(1);
      expect(seen.at(-1)).toMatchObject({ url: "/hello", host: `api.rebind.test:${port}` });
    });

    it("checks every redirect, and drops credentials when one leaves the origin", async () => {
      const p: NetPolicy = { allowPrivate: false, allowLocal: true, lookup: async (h) => [{ address: h === "inside.test" ? "10.0.0.7" : "127.0.0.1" }] };
      handler = (req, res) => {
        if (req.url === "/to-private") return void res.writeHead(302, { location: "http://inside.test/secret" }).end();
        if (req.url === "/to-other") return void res.writeHead(302, { location: `http://other.test:${port}/landing` }).end();
        if (req.url === "/to-metadata") return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
        res.end("landed");
      };
      await expect(pinnedFetch(`http://api.test:${port}/to-private`, "http", p)).rejects.toThrow(/private network/);
      await expect(pinnedFetch(`http://api.test:${port}/to-metadata`, "http", p)).rejects.toThrow(/metadata/);
      // Database mode never follows a redirect: the redirect itself comes back, and nothing else is requested.
      const before = seen.length;
      const r = await pinnedFetch(`http://api.test:${port}/to-metadata`, "database", p, { headers: { "x-clickhouse-key": "pw" } });
      expect(r.status).toBe(302);
      expect(seen.length).toBe(before + 1);
      const res = await pinnedFetch(`http://api.test:${port}/to-other`, "http", p, { headers: { authorization: "Bearer top-secret" } });
      expect(res.text).toBe("landed");
      expect(seen.at(-2)).toMatchObject({ url: "/to-other", auth: "Bearer top-secret" });
      expect(seen.at(-1)).toMatchObject({ url: "/landing", auth: undefined });
    });

    it("refuses URLs with credentials or other schemes, caps responses and times out", async () => {
      const p: NetPolicy = { allowPrivate: false, allowLocal: true, lookup: async () => [{ address: "127.0.0.1" }] };
      await expect(pinnedFetch(`http://user:pw@api.test:${port}/`, "http", p)).rejects.toThrow(/user name or password/);
      await expect(pinnedFetch("file:///etc/passwd", "http", p)).rejects.toThrow(/only http and https/);
      handler = (_req, res) => res.end("x".repeat(5000));
      await expect(pinnedFetch(`http://api.test:${port}/big`, "http", p, { maxBytes: 1000 })).rejects.toThrow(/larger than/);
      handler = () => undefined;
      await expect(pinnedFetch(`http://api.test:${port}/slow`, "http", p, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
      // Without the test-only allowance, the loopback mock is out of reach.
      await expect(pinnedFetch(`http://127.0.0.1:${port}/`, "http", { allowPrivate: true })).rejects.toThrow(/loopback/);
    });
  });
});

describe("kinds", () => {
  it("validates and normalises fields, with defaults and patterns", () => {
    expect(validateConfig("postgres", { host: " db.example.com ", database: "orders", user: "reader", extra: "dropped" })).toEqual({
      host: "db.example.com",
      port: "5432",
      database: "orders",
      user: "reader",
      sslmode: "verify-full",
    });
    expect(() => validateConfig("postgres", { database: "orders", user: "reader" })).toThrow(/Host is required/);
    expect(() => validateConfig("postgres", { host: "https://db.example.com", database: "d", user: "u" })).toThrow(/without a scheme/);
    expect(() => validateConfig("mysql", { host: "db", port: "70000", database: "d", user: "u" })).toThrow(/Port is between/);
    expect(() => validateConfig("mysql", { host: "db", database: "d'; drop", user: "u" })).toThrow(/Database/);
    expect(() => validateConfig("postgres", { host: "db", database: "d", user: "u", sslmode: "allow" })).toThrow(/Encryption is one of/);
    expect(validateConfig("http_api", { base_url: "https://api.example.com/v1", auth_type: "none", auth_name: "X-Key" })).toEqual({ base_url: "https://api.example.com/v1", auth_type: "none" });
    expect(validateConfig("http_api", { base_url: "https://api.example.com", auth_type: "header", auth_name: "X-Api-Key" })).toMatchObject({ auth_name: "X-Api-Key" });
    expect(() => validateConfig("trello", { list_id: "nope" })).toThrow(/24 letters/);
    expect(() => validateConfig("git", { provider: "github", api_url: "http://git.example.com" })).toThrow(/https/);
    // IP addresses are stored in one spelling; something that looks like IPv6 but isn't is refused.
    expect(validateConfig("postgres", { host: "0:0:0:0:0:ffff:a00:9", database: "d", user: "u" }).host).toBe("10.0.0.9");
    expect(validateConfig("postgres", { host: "[2001:DB8:0:0:0:0:0:1]", database: "d", user: "u" }).host).toBe("2001:db8::1");
    expect(validateConfig("mysql", { host: "DB.Example.com", database: "d", user: "u" }).host).toBe("db.example.com");
    expect(() => validateConfig("postgres", { host: "::ffff:7f00:1:", database: "d", user: "u" })).toThrow(/Host is a host name or IP address/);
    // A ClickHouse address is just the server.
    expect(validateConfig("clickhouse", { url: "https://ch.example.com:8443/" })).toMatchObject({ url: "https://ch.example.com:8443/" });
    for (const url of ["http://intranet:8080/admin/delete", "https://ch.example.com:8443/?x=1", "https://ch.example.com#x"])
      expect(() => validateConfig("clickhouse", { url }), url).toThrow(/without a path/);
    expect(defaultName("postgres", { database: "orders" })).toBe("PostgreSQL: orders");
    expect(defaultName("http_api", { base_url: "https://api.example.com/v1" })).toBe("HTTP API: api.example.com");
  });

  it("checks secret input and what each kind needs", () => {
    expect(validateSecretInput("postgres", { password: "  pw  " })).toEqual({ password: "pw" });
    expect(validateSecretInput("postgres", { password: "" })).toEqual({});
    expect(validateSecretInput("postgres", { password: null })).toEqual({ password: null });
    expect(() => validateSecretInput("postgres", { passwd: "x" })).toThrow(/no secret field passwd/);
    expect(() => validateSecretInput("slack", { bot_token: "abc" })).toThrow(/xoxb-/);
    expect(() => validateSecretInput("slack", { webhook_url: "https://evil.example.com/hook" })).toThrow(/hooks.slack.com/);
    expect(() => validateSecretInput("snowflake", { private_key: "not pem" })).toThrow(/PEM/);
    expect(() => validateSecretInput("bigquery", { service_account_json: '{"type":"user"}' })).toThrow(/service account key/);
    expect(() => checkComplete("postgres", {}, new Set())).toThrow(/Password is required/);
    expect(() => checkComplete("http_api", { auth_type: "bearer" }, new Set())).toThrow(/Token, key or password is required/);
    expect(() => checkComplete("http_api", { auth_type: "none" }, new Set())).not.toThrow();
    expect(() => checkComplete("slack", {}, new Set())).toThrow(/bot token or an incoming webhook/);
    expect(() => checkComplete("slack", {}, new Set(["bot_token"]))).toThrow(/Channel ID is required/);
    expect(() => checkComplete("slack", {}, new Set(["webhook_url"]))).not.toThrow();
  });

  it("treats a database's encryption as part of where its secrets go", () => {
    const before = validateConfig("postgres", { host: "db.example.com", database: "d", user: "u" });
    for (const kind of ["postgres", "redshift", "mysql"] as const) {
      expect(targetChanged(kind, before, { ...before, sslmode: "require" })).toBe(true);
      expect(targetChanged(kind, before, { ...before, sslmode: "disable" })).toBe(true);
      expect(targetChanged(kind, before, { ...before, user: "other" })).toBe(false);
    }
  });

  it("shows the tail of random tokens and keys only, never of passwords", () => {
    for (const [kind, key] of [["git", "token"], ["slack", "bot_token"], ["slack", "webhook_url"], ["trello", "api_key"], ["trello", "token"]] as const) expect(showsTail(kind, key, {}), `${kind}.${key}`).toBe(true);
    expect(showsTail("http_api", "auth_value", { auth_type: "bearer" })).toBe(true);
    expect(showsTail("http_api", "auth_value", { auth_type: "basic" })).toBe(false);
    for (const kind of ["postgres", "redshift", "mysql", "clickhouse"] as const) expect(showsTail(kind, "password", {}), kind).toBe(false);
    expect(showsTail("snowflake", "private_key_passphrase", {})).toBe(false);
    expect(showsTail("snowflake", "private_key", {})).toBe(false);
    expect(showsTail("bigquery", "service_account_json", {})).toBe(false);
  });

  it("keeps only the options that apply to the kind", () => {
    expect(validateOptions("postgres", { allow_query: true, schemas_include: ["public"], allow_write_methods: ["POST"], max_objects: 100 })).toEqual({
      allow_query: true,
      schemas_include: ["public"],
      max_objects: 100,
    });
    expect(validateOptions("http_api", { allow_write_methods: ["post", "POST"], path_prefixes: ["/v1/orders"], allow_query: true })).toEqual({
      allow_write_methods: ["POST"],
      path_prefixes: ["/v1/orders"],
    });
    expect(() => validateOptions("http_api", { allow_write_methods: ["TRACE"] })).toThrow(/allow_write_methods/);
    expect(() => validateOptions("http_api", { path_prefixes: ["/v1/../admin"] })).toThrow(/path_prefixes/);
    expect(() => validateOptions("mysql", { max_objects: 0 })).toThrow(/max_objects/);
    expect(validateOptions("slack", { allow_query: true })).toEqual({});
  });
});

describe("Retry-After", () => {
  it("reads seconds or an HTTP date, and ignores what it can't read", () => {
    const at = (v: string | undefined) => retryAfterMs({ headers: { "retry-after": v } }, Date.parse("2026-11-13T10:00:00Z"));
    expect(at("3")).toBe(3000);
    expect(at("0.5")).toBe(500);
    expect(at("Fri, 13 Nov 2026 10:00:30 GMT")).toBe(30_000);
    expect(at("Fri, 13 Nov 2026 09:00:00 GMT")).toBe(0);
    expect(at("soon")).toBeUndefined();
    expect(at(undefined)).toBeUndefined();
  });
});

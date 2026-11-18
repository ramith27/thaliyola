import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { ConnectionSettings, Settings } from "../src/config.js";
import { adminCreateProject, adminSetMember, updateComponent } from "../src/core/admin.js";
import { NotFoundError, ValidationError, type RequestContext } from "../src/core/context.js";
import { callApi, CALLS_PER_MINUTE, listApiEndpoints, readRepoFile, shapeResponse } from "../src/core/connections/calls.js";
import { getApi, listConnectionsFor, projectData, projectDataSources } from "../src/core/connections/data.js";
import { checkRef, checkRepoFilePath, repoPathOf, servesHost } from "../src/core/connections/git.js";
import { pathAllowed, prepareCall } from "../src/core/connections/http-api.js";
import { renderApiBlock } from "../src/core/connections/apis.js";
import { createConnection, deleteConnection, syncConnection, updateConnection } from "../src/core/connections/manage.js";
import { pinnedFetch } from "../src/core/connections/network.js";
import { describeEndpointChange, diffEndpoint, endpointHash, parseOpenApi, parseSpecText, type EndpointDef } from "../src/core/connections/openapi.js";
import { runDueConnections } from "../src/core/connections/sync.js";
import type { ConnTarget } from "../src/core/connections/types.js";
import { flushDeliveries } from "../src/core/notify.js";
import { getProjectContext } from "../src/core/projects.js";
import { detectRepos } from "../src/core/repo-detect.js";
import { scrubSecrets } from "../src/core/secrets.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

// ---- Specs -----------------------------------------------------------------------------------------------------------

const SPEC_V1 = {
  openapi: "3.0.3",
  info: { title: "Orders API", version: "1.2.0", description: "Orders and refunds. Questions: api-team@example.com" },
  servers: [{ url: "https://api.example.com/v1" }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    parameters: { Limit: { name: "limit", in: "query", schema: { type: "integer" } } },
    schemas: {
      Order: { type: "object", required: ["id"], properties: { id: { type: "integer" }, status: { type: "string", enum: ["open", "paid"] }, lines: { type: "array", items: { $ref: "#/components/schemas/Line" } } } },
      Line: { type: "object", properties: { sku: { type: "string" }, order: { $ref: "#/components/schemas/Order" } } },
    },
  },
  paths: {
    "/orders": {
      get: { tags: ["Orders"], summary: "List orders", parameters: [{ $ref: "#/components/parameters/Limit" }], responses: { "200": { description: "ok", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Order" } } } } } } },
      post: { tags: ["Orders"], summary: "Create an order", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, responses: { "201": { description: "created" } } },
    },
    "/orders/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
      get: { tags: ["Orders"], summary: "Get an order", operationId: "getOrder", responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } }, "404": { description: "not found" } } },
    },
    "/refunds": { get: { tags: ["Refunds"], summary: "List refunds", responses: { "200": { description: "ok" } } } },
  },
};

const SPEC_YAML = `swagger: "2.0"
info:
  title: Legacy billing
  version: "0.9"
host: billing.example.com
basePath: /api
schemes: [https]
securityDefinitions:
  key:
    type: apiKey
    in: header
    name: X-Billing-Key
definitions:
  Invoice:
    type: object
    properties:
      number: { type: string }
      total: { type: number, format: double }
paths:
  /invoices/{number}:
    get:
      summary: One invoice
      parameters:
        - { name: number, in: path, required: true, type: string }
      responses:
        "200":
          description: ok
          schema: { $ref: "#/definitions/Invoice" }
  /invoices:
    post:
      consumes: [application/json]
      parameters:
        - { name: invoice, in: body, required: true, schema: { $ref: "#/definitions/Invoice" } }
      responses:
        "201": { description: created }
`;

// ---- Unit: parsing, diffing, building requests ---------------------------------------------------------------------

describe("OpenAPI and Swagger specs", () => {
  it("reads OpenAPI 3: endpoints, shared and referenced parameters, bodies, responses, shapes and auth", () => {
    const spec = parseOpenApi(SPEC_V1);
    expect(spec).toMatchObject({ format: "OpenAPI 3.0.3", title: "Orders API", version: "1.2.0", servers: ["https://api.example.com/v1"], total: 4 });
    // Text from the spec goes through the redaction rules.
    expect(spec.description).toContain("[REDACTED:email]");
    expect(spec.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /orders", "POST /orders", "GET /orders/{id}", "GET /refunds"]);
    const list = spec.endpoints[0]!;
    expect(list.params).toEqual([{ name: "limit", in: "query", required: false, type: "integer" }]);
    // The shape spells out the named schema, so a change inside it is a change of the response.
    expect(list.responses).toEqual([{ status: "200", description: "ok", type: "array<Order>", shape: 'array<{id: integer, status?: "open" | "paid", lines?: array<Line>}>' }]);
    expect(spec.endpoints[1]!.body).toEqual({ content_type: "application/json", type: "Order", required: true });
    expect(spec.endpoints[2]).toMatchObject({ operation_id: "getOrder", params: [{ name: "id", in: "path", required: true, type: "integer" }], auth: ["bearerAuth"] });
    // Shapes that refer to each other don't loop.
    expect(spec.schemas.find((s) => s.name === "Order")!.type).toBe('{id: integer, status?: "open" | "paid", lines?: array<Line>}');
    expect(spec.auth).toEqual([{ name: "bearerAuth", detail: "bearer token (JWT)" }]);
  });

  it("reads Swagger 2 in YAML: body and path parameters, the host and base path", () => {
    const spec = parseOpenApi(parseSpecText(SPEC_YAML));
    expect(spec).toMatchObject({ format: "Swagger 2.0", title: "Legacy billing", servers: ["https://billing.example.com/api"], auth: [{ name: "key", detail: "API key in the header `X-Billing-Key`" }] });
    const [get, post] = spec.endpoints;
    expect(get).toMatchObject({ method: "GET", path: "/invoices/{number}", params: [{ name: "number", in: "path", type: "string" }], responses: [{ status: "200", type: "Invoice" }] });
    expect(post).toMatchObject({ method: "POST", params: [], body: { content_type: "application/json", type: "Invoice", required: true } });
    expect(spec.schemas).toEqual([{ name: "Invoice", type: "{number?: string, total?: number(double)}" }]);
  });

  it("refuses what isn't a spec, and YAML alias bombs", () => {
    expect(() => parseOpenApi(parseSpecText("hello: world"))).toThrow(/OpenAPI 3 or Swagger 2/);
    expect(() => parseOpenApi({ openapi: "4.0.0" })).toThrow(/isn't supported/);
    expect(() => parseSpecText("   ")).toThrow(/empty/);
    expect(() => parseSpecText("a: [unclosed")).toThrow(/valid JSON or YAML/);
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]", ...Array.from({ length: 8 }, (_, i) => `${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(10).fill(`*${String.fromCharCode(97 + i)}`).join(", ")}]`)].join("\n");
    expect(() => parseSpecText(bomb)).toThrow(/valid JSON or YAML/);
    // Paths that aren't paths are skipped; endpoints past the cap are counted, not kept.
    const many = parseOpenApi({ openapi: "3.1.0", paths: { "no-slash": { get: {} }, "/a": { get: {}, post: {} }, "/b": { get: {} } } }, { maxEndpoints: 2 });
    expect(many.endpoints).toHaveLength(2);
    expect(many.total).toBe(3);
  });

  it("tells which endpoint changes callers must follow", () => {
    const base: EndpointDef = { method: "GET", path: "/x", tags: [], params: [{ name: "a", in: "query", required: false, type: "string" }], body: null, responses: [{ status: "200" }] };
    expect(diffEndpoint(base, { ...base, params: [...base.params, { name: "b", in: "query", required: false, type: "string" }] })).toEqual({ breaking: false, params_added: ["b"] });
    expect(diffEndpoint(base, { ...base, params: [...base.params, { name: "b", in: "query", required: true, type: "string" }] })).toMatchObject({ breaking: true, now_required: ["b"] });
    expect(diffEndpoint(base, { ...base, params: [{ ...base.params[0]!, type: "integer" }] })).toMatchObject({ breaking: true, type_changed: [{ param: "a", from: "string", to: "integer" }] });
    expect(diffEndpoint(base, { ...base, responses: [{ status: "200" }, { status: "404" }], deprecated: true })).toEqual({ breaking: false, responses_added: ["404"], deprecated: true });
  });

  it("tells when a response returns something else: a changed or removed success response is breaking", () => {
    const spec = (schema: unknown) => parseOpenApi({ openapi: "3.0.0", paths: { "/orders/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema } } }, "404": { description: "no" } } } } } }).endpoints[0]!;
    const before = spec({ type: "object", properties: { id: { type: "string" }, total: { type: "number" } } });
    const after = spec({ type: "object", properties: { id: { type: "integer" } } });
    expect(endpointHash(before)).not.toBe(endpointHash(after));
    const d = diffEndpoint(before, after);
    expect(d).toEqual({ breaking: true, responses_changed: [{ status: "200", from: "{id?: string, total?: number}", to: "{id?: integer}" }] });
    expect(describeEndpointChange("GET /orders/{id}", d)).toBe("GET /orders/{id}: 200 response changed from {id?: string, total?: number} to {id?: integer}");
    // A success response that's gone is breaking; an error response that's gone isn't.
    expect(diffEndpoint(before, { ...before, responses: before.responses.filter((r) => r.status !== "200") })).toMatchObject({ breaking: true, responses_removed: ["200"] });
    expect(diffEndpoint(before, { ...before, responses: before.responses.filter((r) => r.status !== "404") })).toEqual({ breaking: false, responses_removed: ["404"] });
    // A response the spec only now describes isn't a change callers must follow.
    const untyped = { ...before, responses: [{ status: "200" }] };
    expect(diffEndpoint(untyped, before)).toMatchObject({ breaking: false, responses_changed: [{ status: "200", from: null }] });

    // A named schema's fields count: a field dropped from Order changes GET /orders/{id}, whose 200 returns an Order.
    const v2 = structuredClone(SPEC_V1);
    delete (v2.components.schemas.Order.properties as Record<string, unknown>).status;
    const [o1, o2] = [parseOpenApi(SPEC_V1), parseOpenApi(v2)].map((s) => s.endpoints.find((e) => e.path === "/orders/{id}")!);
    expect(o1!.responses[0]).toMatchObject({ status: "200", type: "Order", shape: '{id: integer, status?: "open" | "paid", lines?: array<Line>}' });
    expect(diffEndpoint(o1!, o2!)).toMatchObject({ breaking: true, responses_changed: [{ status: "200", to: "{id: integer, lines?: array<Line>}" }] });
    // Lists of it too.
    const [l1, l2] = [parseOpenApi(SPEC_V1), parseOpenApi(v2)].map((s) => s.endpoints.find((e) => e.method === "GET" && e.path === "/orders")!);
    expect(diffEndpoint(l1!, l2!).breaking).toBe(true);
    // The same shape inline or by name is the same.
    const inline = spec({ type: "object", required: ["id"], properties: { id: { type: "integer" } } });
    const named = parseOpenApi({ openapi: "3.0.0", components: { schemas: { O: { type: "object", required: ["id"], properties: { id: { type: "integer" } } } } }, paths: { "/orders/{id}": { get: { responses: { "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/O" } } } }, "404": { description: "no" } } } } } }).endpoints[0]!;
    expect(diffEndpoint(inline, named).responses_changed).toBeUndefined();
  });

  it("puts untagged endpoints last in the API article, as the Data view does", () => {
    const spec = parseOpenApi({ openapi: "3.0.0", info: { title: "T", version: "1" }, paths: { "/a": { get: { responses: {} } }, "/b": { get: { tags: ["Refunds"], responses: {} } } } });
    const block = renderApiBlock(spec, spec.endpoints, { connection: "T", kind: "HTTP API", total: 2 });
    expect(block.indexOf("#### Refunds")).toBeGreaterThan(-1);
    expect(block.indexOf("#### Other")).toBeGreaterThan(block.indexOf("#### Refunds"));
  });
});

describe("call_api requests", () => {
  const target = (options: ConnTarget["options"] = {}, config: Record<string, string> = {}, secret: Record<string, string> = {}): ConnTarget => ({
    id: "c",
    kind: "http_api",
    config: { base_url: "https://api.example.com/v1", auth_type: "bearer", ...config },
    secret: { auth_value: "s3cret-token-value", ...secret },
    options,
  });

  it("keeps the path under the base URL and the allowed prefixes", () => {
    const p = prepareCall(target(), { method: "get", path: "/orders/7", query: { expand: "lines", tag: ["a", "b"] } });
    expect(p.url.toString()).toBe("https://api.example.com/v1/orders/7?expand=lines&tag=a&tag=b");
    expect(p.headers.authorization).toBe("Bearer s3cret-token-value");
    expect(p.logText).toBe("GET /orders/7?expand=lines&tag=a&tag=b");
    for (const path of ["orders", "/../admin", "/orders/../../admin", "/%2e%2e/admin", "/a%2Fb", "//evil.example.com/x", "/a\\b", "/a?x=1", "/a#b", "/a b"]) expect(() => prepareCall(target(), { method: "GET", path })).toThrow();
    const t = target({ path_prefixes: ["/orders", "/refunds/"] });
    expect(pathAllowed(t, "/orders")).toBe(true);
    expect(pathAllowed(t, "/orders/1")).toBe(true);
    expect(pathAllowed(t, "/ordersX")).toBe(false);
    expect(pathAllowed(t, "/refunds/9")).toBe(true);
    expect(() => prepareCall(t, { method: "GET", path: "/admin/users" })).toThrow(/isn't under the paths/);
  });

  it("refuses dot segments with path parameters, double encoding and other spellings of ..", () => {
    const pub = target({ path_prefixes: ["/public"] });
    for (const path of ["/public/..;/admin", "/public/..%3b/admin", "/public/..%3B/admin", "/public/%252e%252e/admin", "/public/%25252e%25252e/admin", "/public/.%252e/admin", "/public/x;y", "/public/%3b", "/public/%EF%BC%8E%EF%BC%8E/admin", "/public/%c0%ae%c0%ae/admin", "/public/%E0%A4%A"])
      expect(() => prepareCall(pub, { method: "GET", path }), path).toThrow(ValidationError);
    for (const path of ["/..;/admin", "/..%3b/internal", "/%252e%252e/internal"]) expect(() => prepareCall(target(), { method: "GET", path }), path).toThrow(ValidationError);
    // Encoded letters are fine, but the path must be under the prefix both as sent and as decoded.
    expect(prepareCall(pub, { method: "GET", path: "/public/caf%C3%A9" }).url.pathname).toBe("/v1/public/caf%C3%A9");
    expect(() => prepareCall(pub, { method: "GET", path: "/%70ublic/x" })).toThrow(/isn't under the paths/);
  });

  it("allows GET and HEAD, other methods only when the connection does, and bodies only with them", () => {
    expect(() => prepareCall(target(), { method: "POST", path: "/orders", body: { a: 1 } })).toThrow(/POST isn't allowed/);
    expect(() => prepareCall(target(), { method: "TRACE", path: "/orders" })).toThrow(/method is one of/);
    expect(() => prepareCall(target(), { method: "GET", path: "/orders", body: { a: 1 } })).toThrow(/don't take a body/);
    const p = prepareCall(target({ allow_write_methods: ["POST"] }), { method: "POST", path: "/orders", body: { a: 1 } });
    expect(p).toMatchObject({ method: "POST", body: '{"a":1}' });
    expect(p.headers["content-type"]).toBe("application/json");
    expect(() => prepareCall(target({ allow_write_methods: ["POST"] }), { method: "POST", path: "/orders", body: "x".repeat(300 * 1024) })).toThrow(/larger than 256 KB/);
  });

  it("never lets the caller stand in for the connection's credentials", () => {
    const q = target({}, { auth_type: "query", auth_name: "api_key" });
    expect(prepareCall(q, { method: "GET", path: "/x" }).url.searchParams.get("api_key")).toBe("s3cret-token-value");
    expect(() => prepareCall(q, { method: "GET", path: "/x", query: { api_key: "mine" } })).toThrow(/carries the connection's key/);
    for (const k of ["API_KEY", "api_key ", " Api_Key"]) expect(() => prepareCall(q, { method: "GET", path: "/x", query: { [k]: "mine" } })).toThrow(/carries the connection's key/);
    expect(() => prepareCall(target(), { method: "GET", path: "/x", headers: { Authorization: "Bearer mine" } })).toThrow(/can't be set/);
    expect(() => prepareCall(target(), { method: "GET", path: "/x", headers: { "X-Forwarded-For": "1.2.3.4" } })).toThrow(/can't be set/);
    expect(() => prepareCall(target({}, { auth_type: "header", auth_name: "X-Key" }), { method: "GET", path: "/x", headers: { "x-key": "mine" } })).toThrow(/can't be set/);
    expect(() => prepareCall(target(), { method: "GET", path: "/x", headers: { "x-trace": "a\r\nb: c" } })).toThrow(/one line/);
    const basic = prepareCall(target({}, { auth_type: "basic", username: "svc" }, { auth_value: "pw" }), { method: "GET", path: "/x", headers: { "If-None-Match": "abc" } });
    expect(basic.headers).toMatchObject({ authorization: `Basic ${Buffer.from("svc:pw").toString("base64")}`, "if-none-match": "abc" });
  });

  it("redacts responses and scrubs the connection's own secrets from them", () => {
    const r = shapeResponse({ status: 200, url: "", headers: { "content-type": "application/json", "set-cookie": ["sid=1"], etag: "x" }, text: JSON.stringify({ token: "s3cret-token-value", who: "ann@example.com", n: 1 }) }, "GET", ["s3cret-token-value"]);
    expect(r).toMatchObject({ status: 200, ok: true, headers: { "content-type": "application/json", etag: "x" }, body: { token: "[secret]", who: "[REDACTED:email]", n: 1 } });
    expect(r.headers).not.toHaveProperty("set-cookie");
    expect(shapeResponse({ status: 200, url: "", headers: { "content-type": "image/png" }, text: "\u0000PNG" }, "GET", [])).toMatchObject({ body: null, note: expect.stringMatching(/image\/png/) });
    expect(shapeResponse({ status: 302, url: "", headers: { location: "https://elsewhere.example.com" }, text: "moved" }, "GET", [])).toMatchObject({ body: null, note: expect.stringMatching(/Redirects aren't followed/) });
    expect(shapeResponse({ status: 200, url: "", headers: {}, text: "x".repeat(300_000) }, "GET", [])).toMatchObject({ truncated: true });
  });

  it("scrubs a query-parameter key however the URL spells it", () => {
    for (const secret of ["Zx9~Qw!e(r)t yU1", "a1b2~c3d4e5f6g7h8", "p@ss/w*rd'é"]) {
      const p = prepareCall(target({}, { auth_type: "query", auth_name: "appid" }, { auth_value: secret }), { method: "GET", path: "/items", query: { page: 2 } });
      const sent = p.url.toString();
      const r = shapeResponse({ status: 302, url: "", headers: { location: sent, link: `<${sent.replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase())}>; rel="next"` }, text: "" }, "GET", [secret]);
      expect(r.headers.location, secret).toBe("https://api.example.com/v1/items?page=2&appid=[secret]");
      expect(r.headers.link, secret).toContain("appid=[secret]");
      for (const text of [secret, encodeURIComponent(secret), encodeURI(secret), new URLSearchParams({ k: secret }).toString().slice(2).replace(/\+/g, "%20")]) expect(scrubSecrets(`x ${text} y`, [secret])).toBe("x [secret] y");
    }
  });
});

describe("git paths", () => {
  const gh: ConnTarget = { id: "g", kind: "git", config: { provider: "github" }, secret: {}, options: {} };
  const ghe: ConnTarget = { ...gh, config: { provider: "github", api_url: "https://git.example.com/api/v3" } };
  const gl: ConnTarget = { ...gh, config: { provider: "gitlab" } };
  it("sends a token only to the host it's for", () => {
    expect(servesHost(gh, "github.com")).toBe(true);
    expect(servesHost(gh, "gitlab.com")).toBe(false);
    expect(servesHost(ghe, "git.example.com")).toBe(true);
    expect(servesHost(ghe, "github.com")).toBe(false);
    expect(servesHost({ ...gh, config: { provider: "github", api_url: "https://api.acme.ghe.com" } }, "acme.ghe.com")).toBe(true);
    expect(servesHost(gl, "gitlab.com")).toBe(true);
  });
  it("checks repository, file paths and refs", () => {
    expect(repoPathOf(gh, "acme/api.git")).toBe("acme/api");
    expect(() => repoPathOf(gh, "acme/api/extra")).toThrow();
    expect(repoPathOf(gl, "group/sub/project")).toBe("group/sub/project");
    expect(() => repoPathOf(gl, "group/../x")).toThrow();
    expect(checkRepoFilePath("/src/index.ts")).toBe("src/index.ts");
    expect(checkRepoFilePath("")).toBe("");
    for (const p of ["../etc/passwd", "src/../../x", "a//b", "a\\b", "a\u0000b"]) expect(() => checkRepoFilePath(p)).toThrow();
    expect(checkRef("release/1.2")).toBe("release/1.2");
    for (const r of ["a..b", "-x", "a b", "x;y"]) expect(() => checkRef(r)).toThrow();
  });
});

// ---- Integration: a project with an API and a git host (mock servers) ------------------------------------------------

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let mock: Server;
let mockBase: string;
let mockPort: number;
const routes = new Map<string, Handler>();
const hits: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[] = [];
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));

const key = randomBytes(32);
let db: Db;
const TOKEN = "api-token-1234567890";
const GIT_TOKEN = "ghp_projecttoken00000000000000000000000000";

function connSettings(extra: Partial<ConnectionSettings> = {}): Settings {
  return {
    ...TEST_SETTINGS,
    connections: {
      enabled: true,
      keys: { key },
      allowPrivate: false,
      queryMaxRows: 200,
      queryTimeoutMs: 5000,
      ownHosts: [],
      allowLocal: true,
      endpoints: { github: mockBase, gitlab: `${mockBase}/gl/api/v4` },
      ...extra,
    },
  };
}
async function as(email: string, settings = connSettings()): Promise<RequestContext> {
  return { ...(await ctxFor(db, { email })), settings };
}
const owner = () => as("owner@example.com");
const writer = () => as("writer@example.com");
const reader = () => as("reader@example.com");
/** Someone with no role in the members-only project. */
const outsider = () => as("nobody@example.com");

let apiId: string;
let specVersion: Record<string, unknown> = SPEC_V1;

beforeAll(async () => {
  mock = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ method: req.method ?? "GET", url: req.url ?? "", headers: req.headers, body });
      const path = (req.url ?? "").split("?")[0]!;
      const h = routes.get(`${req.method} ${path}`);
      if (h) h(req, body, res);
      else json(res, 404, { message: "Not Found" });
    });
    // Both stacks: "localhost" (another origin for the tests) resolves to ::1 first on some machines.
  }).listen({ port: 0, host: "::", ipv6Only: false });
  await new Promise((r) => mock.once("listening", r));
  mockPort = (mock.address() as AddressInfo).port;
  mockBase = `http://127.0.0.1:${mockPort}`;
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, {
    slug: "shop",
    name: "Shop",
    visibility: "members",
    components: [
      { slug: "orders", kind: "backend", repo_url: "https://github.com/acme/orders" },
      { slug: "web", kind: "frontend", repo_url: "https://gitlab.com/acme/shop/web" },
    ],
  });
  await adminSetMember(a, "shop", "owner@example.com", "owner");
  await adminSetMember(a, "shop", "writer@example.com", "writer");
  await adminSetMember(a, "shop", "reader@example.com", "reader");
});
afterAll(async () => {
  await flushDeliveries();
  if (mock) await new Promise((r) => mock.close(r));
  await db?.end();
});
beforeEach(async () => {
  hits.length = 0;
  routes.clear();
  routes.set("GET /v1", (_q, _b, res) => json(res, 200, { ok: true }));
  routes.set("GET /v1/openapi.json", (_q, _b, res) => json(res, 200, specVersion));
  // Tests, syncs and calls each have a per-minute budget; this file runs many quickly.
  await db.query("UPDATE audit_log SET at = at - interval '2 minutes' WHERE tool IN ('test_connection', 'test_connection_draft', 'sync_connection')");
  await db.query("UPDATE connection_calls SET at = at - interval '2 minutes'");
});

describe("HTTP API connections", () => {
  it("imports the spec: one endpoint each, one api_contract article, credentials only to the API's own origin", async () => {
    const o = await owner();
    const c = await createConnection(o, "shop", {
      kind: "http_api",
      name: "Orders API",
      config: { base_url: `${mockBase}/v1`, spec_url: `${mockBase}/v1/openapi.json`, auth_type: "bearer" },
      secret: { auth_value: TOKEN },
      options: { path_prefixes: ["/orders"] },
      component: "orders",
    });
    apiId = c.id;
    expect(c).toMatchObject({ sync_kind: "api", syncs: true, spec: null });
    const r = await syncConnection(o, c.id);
    expect(r).toMatchObject({ ok: true, sync: { endpoints: 4, title: "Orders API", version: "1.2.0" } });
    expect(r.ok && r.detail).toMatch(/Synced 4 endpoints of Orders API/);
    // The spec on the API's own origin got the token.
    expect(hits.find((h) => h.url === "/v1/openapi.json")!.headers.authorization).toBe(`Bearer ${TOKEN}`);

    const objs = (await db.query<{ key: string; article_id: string }>("SELECT key, article_id FROM connection_objects WHERE connection_id = $1 ORDER BY key", [c.id])).rows;
    expect(objs.map((x) => x.key)).toEqual(["GET /orders", "GET /orders/{id}", "GET /refunds", "POST /orders"]);
    const art = (await db.query<{ id: string; type: string; title: string; body_md: string; version: number; status: string; path: string; component_ids: string[] }>("SELECT * FROM articles WHERE id = $1", [objs[0]!.article_id])).rows[0]!;
    expect(art).toMatchObject({ type: "api_contract", title: "Orders API", status: "published", version: 1, path: "APIs" });
    expect(art.component_ids).toHaveLength(1);
    expect(art.body_md).toMatch(/^## Interface \(synced\)\n\n<!-- thaliyola:sync -->/);
    expect(art.body_md).toContain("#### Refunds");
    expect(art.body_md).toContain("| GET | `/orders/{id}` | Get an order |");
    expect(art.body_md).toContain("`bearerAuth`: bearer token (JWT)");
    expect(art.body_md).toContain("## Errors");
    expect(art.body_md).not.toContain(TOKEN);
    expect((await db.query("SELECT 1 FROM relations WHERE from_id = $1 AND kind = 'provided_by'", [art.id])).rowCount).toBe(1);

    // Again with nothing changed: no new version.
    await syncConnection(o, c.id);
    expect((await db.query<{ version: number }>("SELECT version FROM articles WHERE id = $1", [art.id])).rows[0]!.version).toBe(1);

    // A spec on another origin doesn't get the credentials.
    hits.length = 0;
    await updateConnection(o, c.id, { config: { base_url: `${mockBase}/v1`, spec_url: `http://localhost:${mockPort}/v1/openapi.json`, auth_type: "bearer" } });
    await syncConnection(o, c.id);
    expect(hits.find((h) => h.url === "/v1/openapi.json")!.headers.authorization).toBeUndefined();
    await updateConnection(o, c.id, { config: { base_url: `${mockBase}/v1`, spec_url: `${mockBase}/v1/openapi.json`, auth_type: "bearer" } });
  });

  it("records endpoint changes, raises impact notices and tells the people who care", async () => {
    const o = await owner();
    // The spec drops /refunds and makes /orders need a new parameter.
    const v2 = structuredClone(SPEC_V1) as typeof SPEC_V1 & { paths: Record<string, unknown> };
    delete (v2.paths as Record<string, unknown>)["/refunds"];
    (v2.paths["/orders"] as { get: { parameters: unknown[] } }).get.parameters.push({ name: "region", in: "query", required: true, schema: { type: "string" } });
    (v2.paths as Record<string, unknown>)["/customers"] = { get: { summary: "List customers", responses: { "200": { description: "ok" } } } };
    specVersion = v2;
    const r = await syncConnection(o, apiId);
    specVersion = SPEC_V1;
    expect(r).toMatchObject({ ok: true, sync: { endpoints: 4, added: 1, changed: 1, removed: 1 } });
    const changes = (await db.query<{ object_key: string; change: string; detail: Record<string, unknown> }>("SELECT object_key, change, detail FROM connection_changes WHERE connection_id = $1 ORDER BY object_key", [apiId])).rows;
    expect(changes).toEqual([
      { object_key: "GET /customers", change: "added", detail: { kind: "endpoint" } },
      { object_key: "GET /orders", change: "changed", detail: { breaking: true, params_added: ["region"], now_required: ["region"] } },
      { object_key: "GET /refunds", change: "removed", detail: { kind: "endpoint" } },
    ]);
    const art = (await db.query<{ id: string; version: number; body_md: string }>("SELECT a.id, a.version, a.body_md FROM articles a JOIN connections c ON a.id::text = c.state->>'api_article' WHERE c.id = $1", [apiId])).rows[0]!;
    expect(art.version).toBe(2);
    expect(art.body_md).not.toContain("/refunds");
    const notices = (await db.query<{ summary: string }>("SELECT summary FROM impact_notices WHERE source_id = $1", [art.id])).rows;
    expect(notices.map((n) => n.summary)).toEqual(["Orders API: GET /orders: now requires region; new parameters region; GET /refunds: endpoint removed"]);
    await flushDeliveries();
    const told = (await db.query<{ title: string; link: string }>("SELECT n.title, n.link FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'owner@example.com' AND n.kind = 'connection'")).rows;
    expect(told).toEqual([{ title: "API changed: Orders API (Shop)", link: `#/article/${art.id}` }]);
    const removed = (await db.query<{ removed_at: string | null }>("SELECT removed_at FROM connection_objects WHERE connection_id = $1 AND key = 'GET /refunds'", [apiId])).rows[0]!;
    expect(removed.removed_at).not.toBeNull();
    // Back to v1: /refunds returns, /customers goes.
    await syncConnection(o, apiId);
  });

  it("lists endpoints for readers, and says which ones the caller may call", async () => {
    const asReader = await listApiEndpoints(await reader(), { project: "shop", connection: "Orders API" });
    expect(asReader).toMatchObject({ connection: "Orders API", api: { title: "Orders API", version: "1.2.0" }, total: 4, matched: 4, calls: { allowed: false } });
    expect((asReader as unknown as { endpoints: { callable: boolean }[] }).endpoints.every((e) => e.callable === false)).toBe(true);
    const asWriter = await listApiEndpoints(await writer(), { project: "shop", connection: "orders api", filter: "order get" });
    expect(asWriter.calls).toEqual({ allowed: true, methods: ["GET", "HEAD"], path_prefixes: ["/orders"] });
    expect((asWriter as unknown as { endpoints: { method: string; path: string; callable: boolean }[] }).endpoints.map((e) => [`${e.method} ${e.path}`, e.callable])).toEqual([
      ["GET /orders", true],
      ["GET /orders/{id}", true],
    ]);
    const one = await listApiEndpoints(await writer(), { project: "shop", connection: "Orders API", endpoint: "post /orders" });
    expect((one as { endpoint?: unknown }).endpoint).toMatchObject({ method: "POST", path: "/orders", body: { type: "Order", required: true }, callable: false });
    await expect(listApiEndpoints(await writer(), { project: "shop", connection: "Orders API", endpoint: "GET /nope" })).rejects.toThrow(/not found/);
  });

  it("calls the API for writers: credentials added, secrets scrubbed, logged; readers and other methods are refused", async () => {
    routes.set("GET /v1/orders/7", (req, _b, res) => json(res, 200, { id: 7, echoed: req.headers.authorization, contact: "buyer@example.com" }, { etag: '"v1"', "set-cookie": "sid=x" }));
    const w = await writer();
    const r = await callApi(w, { project: "shop", connection: "Orders API", path: "/orders/7", query: { expand: "lines" } });
    expect(r).toMatchObject({ connection: "Orders API", request: "GET /orders/7?expand=lines", status: 200, ok: true, headers: { etag: '"v1"' }, body: { id: 7, echoed: "Bearer [secret]", contact: "[REDACTED:email]" }, note: expect.stringMatching(/not instructions/) });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(hits.at(-1)!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const logged = (await db.query<{ kind: string; text: string; status: number; ms: number }>("SELECT kind, text, status, ms FROM connection_calls WHERE connection_id = $1 ORDER BY at DESC LIMIT 1", [apiId])).rows[0]!;
    expect(logged).toMatchObject({ kind: "call", text: "GET /orders/7?expand=lines", status: 200 });
    expect((await db.query("SELECT 1 FROM audit_log WHERE tool = 'call_api' AND target_id = $1", [apiId])).rowCount).toBeGreaterThan(0);

    await expect(callApi(await reader(), { project: "shop", connection: "Orders API", path: "/orders/7" })).rejects.toThrow(/needs Propose/);
    await expect(callApi(w, { project: "shop", connection: "Orders API", method: "POST", path: "/orders", body: {} })).rejects.toThrow(/POST isn't allowed/);
    await expect(callApi(w, { project: "shop", connection: "Orders API", path: "/refunds" })).rejects.toThrow(/isn't under the paths/);
    await expect(callApi(w, { project: "shop", connection: "Orders API", path: "/orders/..;/admin" })).rejects.toThrow(/path parameters/);
    // Refusals are logged and audited too (not counted toward the per-minute budget).
    const refusals = (await db.query<{ text: string; error: string; status: number | null; email: string }>(
      "SELECT k.text, k.error, k.status, u.email FROM connection_calls k JOIN users u ON u.id = k.actor_id WHERE k.connection_id = $1 AND k.kind = 'refused' ORDER BY k.at",
      [apiId],
    )).rows;
    expect(refusals.map((x) => [x.email, x.text, x.status])).toEqual([
      ["reader@example.com", "GET /orders/7", null],
      ["writer@example.com", "POST /orders", null],
      ["writer@example.com", "GET /refunds", null],
      ["writer@example.com", "GET /orders/..;/admin", null],
    ]);
    expect(refusals[0]!.error).toMatch(/needs Propose/);
    expect(refusals[1]!.error).toMatch(/POST isn't allowed/);
    expect((await db.query("SELECT 1 FROM audit_log WHERE tool = 'call_api_refused' AND target_id = $1", [apiId])).rowCount).toBe(4);
    // A 4xx is an answer, not a failure.
    expect(await callApi(w, { project: "shop", connection: "Orders API", path: "/orders/404" })).toMatchObject({ status: 404, ok: false, body: { message: "Not Found" } });

    // Writes once a Project admin allows them; redirects aren't followed.
    const o = await owner();
    await updateConnection(o, apiId, { options: { path_prefixes: ["/orders"], allow_write_methods: ["post"] } });
    routes.set("POST /v1/orders", (_q, body, res) => json(res, 201, { received: JSON.parse(body) }));
    expect(await callApi(w, { project: "shop", connection: "Orders API", method: "POST", path: "/orders", body: { sku: "A1" } })).toMatchObject({ status: 201, body: { received: { sku: "A1" } } });
    routes.set("GET /v1/orders/old", (_q, _b, res) => res.writeHead(302, { location: `${mockBase}/v1/admin` }).end());
    expect(await callApi(w, { project: "shop", connection: "Orders API", path: "/orders/old" })).toMatchObject({ status: 302, body: null });
    expect(hits.some((h) => h.url === "/v1/admin")).toBe(false);

    // Calls turned off.
    await updateConnection(o, apiId, { options: { path_prefixes: ["/orders"], allow_calls: false } });
    await expect(callApi(w, { project: "shop", connection: "Orders API", path: "/orders/7" })).rejects.toThrow(/calls aren't allowed/);
    expect((await db.query("SELECT 1 FROM connection_calls WHERE connection_id = $1 AND kind = 'refused' AND error LIKE 'calls aren''t allowed%'", [apiId])).rowCount).toBe(1);
    await updateConnection(o, apiId, { options: { path_prefixes: ["/orders"] } });
  });

  it("scrubs a query-parameter key with special characters from echoed URLs and bodies", async () => {
    const secret = "Zx9~Qw!e(r)t yU1";
    const o = await owner();
    const c = await createConnection(o, "shop", { kind: "http_api", name: "Echo API", config: { base_url: `${mockBase}/v1`, auth_type: "query", auth_name: "appid" }, secret: { auth_value: secret } });
    routes.set("GET /v1/echo", (req, _b, res) => res.writeHead(302, { location: `${mockBase}${req.url}`, link: `<${mockBase}${req.url}>; rel="next"` }).end());
    routes.set("GET /v1/self", (req, _b, res) => json(res, 200, { self: `${mockBase}${req.url}`, lower: `${mockBase}${(req.url ?? "").replace(/%[0-9A-F]{2}/g, (x) => x.toLowerCase())}` }));
    try {
      const w = await writer();
      const moved = await callApi(w, { project: "shop", connection: "Echo API", path: "/echo", query: { page: 2 } });
      // The API got the real key, form-encoded.
      expect(hits.at(-1)!.url).toBe(`/v1/echo?page=2&${new URLSearchParams({ appid: secret })}`);
      expect(moved).toMatchObject({ status: 302, headers: { location: `${mockBase}/v1/echo?page=2&appid=[secret]` } });
      expect((moved.headers as Record<string, string>).link).toContain("appid=[secret]");
      const self = await callApi(w, { project: "shop", connection: "Echo API", path: "/self" });
      expect((self as { body?: unknown }).body).toEqual({ self: `${mockBase}/v1/self?appid=[secret]`, lower: `${mockBase}/v1/self?appid=[secret]` });
      for (const out of [moved, self]) {
        expect(JSON.stringify(out)).not.toContain("Zx9");
        expect(JSON.stringify(out)).not.toContain("yU1");
      }
    } finally {
      await deleteConnection(o, c.id);
    }
  });

  it("limits calls per person, times out, and keeps to public addresses", async () => {
    const w = await writer();
    routes.set("GET /v1/orders/slow", () => undefined);
    await expect(callApi(await as("writer@example.com", connSettings({ callTimeoutMs: 300 })), { project: "shop", connection: "Orders API", path: "/orders/slow" })).rejects.toThrow(/timed out/);
    expect((await db.query<{ error: string }>("SELECT error FROM connection_calls WHERE text = 'GET /orders/slow'")).rows[0]!.error).toMatch(/timed out/);
    await expect(callApi(await as("writer@example.com", connSettings({ allowLocal: false })), { project: "shop", connection: "Orders API", path: "/orders/7" })).rejects.toThrow(/loopback|not allowed|private/i);

    const actor = (await db.query<{ id: string }>("SELECT id FROM users WHERE email = 'writer@example.com'")).rows[0]!.id;
    // Refused attempts don't use up the budget.
    await db.query("INSERT INTO connection_calls (connection_id, actor_id, kind, text, error) SELECT $1, $2, 'refused', 'POST /x', 'no' FROM generate_series(1, $3)", [apiId, actor, CALLS_PER_MINUTE * 2]);
    expect(await callApi(w, { project: "shop", connection: "Orders API", path: "/orders/8" })).toMatchObject({ status: 404 });
    await db.query("INSERT INTO connection_calls (connection_id, actor_id, kind, text) SELECT $1, $2, 'call', 'GET /x' FROM generate_series(1, $3)", [apiId, actor, CALLS_PER_MINUTE]);
    await expect(callApi(w, { project: "shop", connection: "Orders API", path: "/orders/7" })).rejects.toThrow(/30 calls in a minute/);
  });

  it("takes a pasted spec (YAML) and refuses one that isn't a spec", async () => {
    const o = await owner();
    await expect(createConnection(o, "shop", { kind: "http_api", name: "Bad", config: { base_url: `${mockBase}/v1` }, spec: "just: text" })).rejects.toThrow(/OpenAPI 3 or Swagger 2/);
    await expect(createConnection(o, "shop", { kind: "postgres", name: "PG", config: { host: "db.example.com", database: "x", user: "y" }, secret: { password: "p" }, spec: SPEC_YAML })).rejects.toThrow(/only HTTP API/);
    const c = await createConnection(o, "shop", { kind: "http_api", name: "Billing", config: { base_url: `${mockBase}/v1` }, spec: SPEC_YAML });
    expect(c.spec).toEqual({ pasted: true, bytes: Buffer.byteLength(SPEC_YAML.trim()) });
    expect(JSON.stringify(c)).not.toContain("Legacy billing");
    const r = await syncConnection(o, c.id);
    expect(r).toMatchObject({ ok: true, sync: { endpoints: 2, title: "Legacy billing", format: "Swagger 2.0" } });
    const articleOf = async () => (await db.query<{ id: string; status: string }>("SELECT a.id, a.status FROM articles a JOIN connections c ON a.id::text = c.state->>'api_article' WHERE c.id = $1", [c.id])).rows[0]!;
    expect((await articleOf()).status).toBe("published");
    const noticesBefore = (await db.query("SELECT 1 FROM impact_notices")).rowCount;

    // The spec removed: its endpoints are no longer listed, the article is possibly stale, and nothing is announced.
    await updateConnection(o, c.id, { spec: null });
    const again = await syncConnection(o, c.id);
    expect(again.ok && again.detail).toMatch(/spec was removed from this connection: its 2 endpoints are no longer listed/);
    expect((await db.query("SELECT 1 FROM connection_objects WHERE connection_id = $1 AND removed_at IS NULL", [c.id])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM connection_changes WHERE connection_id = $1 AND change = 'removed' AND detail->>'spec_removed' = 'true'", [c.id])).rowCount).toBe(2);
    expect((await articleOf()).status).toBe("possibly_stale");
    expect((await db.query("SELECT 1 FROM impact_notices")).rowCount).toBe(noticesBefore);
    expect(await getApi(await reader(), c.id)).toMatchObject({ spec_removed: true, title: "Legacy billing" });
    expect(await listApiEndpoints(await reader(), { project: "shop", connection: "Billing" })).toMatchObject({ total: 0, hint: expect.stringMatching(/spec was removed/) });
    // Synced again without one: the same state, nothing new recorded.
    expect((await syncConnection(o, c.id)).ok && true).toBe(true);
    expect((await db.query("SELECT 1 FROM connection_changes WHERE connection_id = $1 AND change = 'removed'", [c.id])).rowCount).toBe(2);
    expect(await getApi(await reader(), c.id)).toMatchObject({ spec_removed: true });

    // Given back: the endpoints return and the article is current again.
    await updateConnection(o, c.id, { spec: SPEC_YAML });
    expect(await syncConnection(o, c.id)).toMatchObject({ ok: true, sync: { endpoints: 2, added: 2 } });
    expect((await articleOf()).status).toBe("published");
    expect(await getApi(await reader(), c.id)).toMatchObject({ spec_removed: false });

    // A connection that never had a spec has nothing to import.
    const bare = await createConnection(o, "shop", { kind: "http_api", name: "Bare", config: { base_url: `${mockBase}/v1` } });
    const none = await syncConnection(o, bare.id);
    expect(none.ok && none.detail).toMatch(/No OpenAPI spec yet/);
    await deleteConnection(o, bare.id);
  });

  it("shows APIs in the Data view and to agents", async () => {
    const data = await projectData(await reader(), "shop");
    expect(data.apis.map((a) => [a.name, a.endpoints, a.title])).toEqual([
      ["Billing", 2, "Legacy billing"],
      ["Orders API", 4, "Orders API"],
    ]);
    const api = await getApi(await reader(), apiId);
    expect(api).toMatchObject({ title: "Orders API", can_call: false, article: { title: "Orders API" } });
    expect(api.endpoints.filter((e) => !e.removed_at)).toHaveLength(4);
    expect(api.changes.length).toBeGreaterThan(0);
    const ds = await projectDataSources(await reader(), data.apis[0]!.id ? (await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0]!.id : "");
    expect(ds!.apis!.map((a) => a.name)).toEqual(["Billing", "Orders API"]);
    const list = await listConnectionsFor(await writer(), "shop");
    expect(list.connections.find((x) => x.name === "Orders API")).toMatchObject({ endpoints: 4, calls: true });
  });

  it("shows nothing of a members-only project's APIs to people outside it, and logs nothing for them", async () => {
    const out = await outsider();
    const before = (await db.query("SELECT 1 FROM connection_calls")).rowCount;
    await expect(listApiEndpoints(out, { project: "shop", connection: "Orders API" })).rejects.toThrow(NotFoundError);
    await expect(listApiEndpoints(out, { project: "shop", connection: "Orders API", endpoint: "GET /orders" })).rejects.toThrow(NotFoundError);
    await expect(getApi(out, apiId)).rejects.toThrow(NotFoundError);
    await expect(callApi(out, { project: "shop", connection: "Orders API", path: "/orders/7" })).rejects.toThrow(NotFoundError);
    await expect(projectData(out, "shop")).rejects.toThrow(NotFoundError);
    expect((await db.query("SELECT 1 FROM connection_calls")).rowCount).toBe(before);
    expect(hits.some((h) => h.url.startsWith("/v1/orders/7"))).toBe(false);
  });
});

describe("git connections", () => {
  let gitId: string;
  const gh = (path: string, h: Handler) => routes.set(`GET ${path}`, h);
  function githubRepo() {
    gh("/user", (_q, _b, res) => json(res, 200, { login: "acme-bot" }));
    gh("/repos/acme/orders", (req, _b, res) => (req.headers.authorization === `Bearer ${GIT_TOKEN}` ? json(res, 200, { default_branch: "main", visibility: "private", pushed_at: "2026-11-01T10:00:00Z" }) : json(res, 404, {})));
    gh("/repos/acme/orders/commits", (_q, _b, res) => json(res, 200, [{ sha: "abc123", commit: { message: "Fix refunds (ops@example.com)\n\nlong body", author: { name: "Ann", date: "2026-11-01T09:00:00Z" } } }]));
    gh("/repos/acme/orders/languages", (_q, _b, res) => json(res, 200, { TypeScript: 9000, Dockerfile: 10 }));
    gh("/repos/acme/orders/pulls", (_q, _b, res) => json(res, 200, [{}], { link: `<${mockBase}/repos/acme/orders/pulls?state=open&per_page=1&page=2>; rel="next", <${mockBase}/repos/acme/orders/pulls?state=open&per_page=1&page=7>; rel="last"` }));
    gh("/repos/acme/orders/contents/src/config.ts", (_q, _b, res) => json(res, 200, { type: "file", size: 60, encoding: "base64", content: Buffer.from(`export const url = "postgres://app:hunter2@db/x";\n// ${GIT_TOKEN}\n`).toString("base64") }));
    gh("/repos/acme/orders/contents/src", (_q, _b, res) => json(res, 200, [{ name: "config.ts", path: "src/config.ts", type: "file", size: 60 }, { name: "lib", path: "src/lib", type: "dir" }]));
    gh("/repos/acme/orders/contents/logo.png", (_q, _b, res) => json(res, 200, { type: "file", size: 4, encoding: "base64", content: Buffer.from([0x89, 0, 1, 2]).toString("base64") }));
  }

  it("syncs the project's repositories on its host: branch, last commit, languages, open pull requests", async () => {
    githubRepo();
    const o = await owner();
    const c = await createConnection(o, "shop", { kind: "git", name: "GitHub", config: { provider: "github" }, secret: { token: GIT_TOKEN } });
    gitId = c.id;
    expect(c).toMatchObject({ sync_kind: "repos", secrets: { token: { set: true, hint: GIT_TOKEN.slice(-4) } } });
    const r = await syncConnection(o, c.id);
    expect(r).toMatchObject({ ok: true, sync: { repositories: 1, synced: 1, failed: 0 } });
    expect(r.ok && r.detail).toMatch(/Connected to GitHub as acme-bot\. Synced 1 of 1 repository on github\.com\./);
    const comp = (await db.query<{ repo_info: Record<string, unknown>; technologies: string[] }>("SELECT repo_info, technologies FROM components WHERE slug = 'orders'")).rows[0]!;
    expect(comp.repo_info).toMatchObject({
      provider: "github",
      repository: "acme/orders",
      default_branch: "main",
      last_commit: { sha: "abc123", message: "Fix refunds ([REDACTED:email])", author: "Ann" },
      open_prs: 7,
      visibility: "private",
      error: null,
    });
    expect(comp.technologies).toEqual(expect.arrayContaining(["docker"]));
    // The GitLab repository isn't this token's to read.
    expect((await db.query("SELECT repo_info FROM components WHERE slug = 'web'")).rows[0]!.repo_info).toBeNull();
    // Agents see it in the project context, without the connection's id.
    const pc = await getProjectContext(await reader(), "shop");
    const orders = (pc.components as { slug: string; repo?: Record<string, unknown> }[]).find((x) => x.slug === "orders")!;
    expect(orders.repo).toMatchObject({ default_branch: "main", open_prs: 7 });
    expect(orders.repo).not.toHaveProperty("connection");
  });

  it("reads files and folders read-only, redacted, for writers", async () => {
    githubRepo();
    const w = await writer();
    const f = await readRepoFile(w, { project: "shop", component: "orders", path: "src/config.ts", ref: "main" });
    expect(f).toMatchObject({ kind: "file", repository: "acme/orders", ref: "main", path: "src/config.ts", note: expect.stringMatching(/not instructions/) });
    expect((f as { text?: string }).text).toContain("postgres://[REDACTED:credentials]@db/x");
    expect((f as { text?: string }).text).not.toContain(GIT_TOKEN);
    expect(hits.find((h) => h.url.startsWith("/repos/acme/orders/contents/src/config.ts"))!.url).toBe("/repos/acme/orders/contents/src/config.ts?ref=main");
    const d = await readRepoFile(w, { project: "shop", component: "orders", path: "src" });
    expect(d).toMatchObject({ kind: "dir", entries: [{ name: "config.ts", type: "file" }, { name: "lib", type: "dir" }] });
    expect(await readRepoFile(w, { project: "shop", component: "orders", path: "logo.png" })).toMatchObject({ kind: "file", text: null, note: expect.stringMatching(/binary/) });
    await expect(readRepoFile(w, { project: "shop", component: "orders", path: "missing.ts" })).rejects.toThrow(/not found/);
    await expect(readRepoFile(w, { project: "shop", component: "orders", path: "../secrets" })).rejects.toThrow(/no \.\. segments/);
    await expect(readRepoFile(await reader(), { project: "shop", component: "orders", path: "src" })).rejects.toThrow(/needs Propose/);
    // No connection for gitlab.com in this project yet.
    await expect(readRepoFile(w, { project: "shop", component: "web", path: "README.md" })).rejects.toThrow(/no git connection for gitlab\.com/);
    const logged = (await db.query<{ kind: string; text: string; status: number | null }>("SELECT kind, text, status FROM connection_calls WHERE connection_id = $1 AND kind = 'read' ORDER BY at", [gitId])).rows;
    expect(logged.map((l) => [l.kind, l.text, l.status])).toEqual([
      ["read", "READ orders:src/config.ts@main", 200],
      ["read", "READ orders:src", 200],
      ["read", "READ orders:logo.png", 200],
      ["read", "READ orders:missing.ts", 404],
    ]);
    const refused = (await db.query<{ text: string; error: string }>("SELECT text, error FROM connection_calls WHERE connection_id = $1 AND kind = 'refused' ORDER BY at", [gitId])).rows;
    expect(refused.map((r) => r.text)).toEqual(["READ orders:../secrets", "READ orders:src"]);
    expect(refused[1]!.error).toMatch(/needs Propose/);
    // Without a git connection for the host there's no connection to log it on; the audit log has it.
    expect((await db.query("SELECT 1 FROM audit_log WHERE tool = 'read_repo_file_refused'")).rowCount).toBe(3);

    // Nobody outside the members-only project reads anything, or learns which files exist.
    hits.length = 0;
    await expect(readRepoFile(await outsider(), { project: "shop", component: "orders", path: "src/config.ts" })).rejects.toThrow(NotFoundError);
    expect(hits).toEqual([]);
    await expect(getProjectContext(await outsider(), "shop")).rejects.toThrow(NotFoundError);
  });

  function gitlabRepo() {
    const gl = (path: string, h: Handler) => routes.set(`GET /gl/api/v4${path}`, h);
    const proj = `/projects/${encodeURIComponent("acme/shop/web")}`;
    gl("/user", (_q, _b, res) => json(res, 200, { username: "bot" }));
    gl(proj, (req, _b, res) => (req.headers["private-token"] === "glpat-abcdefghijklmnop" ? json(res, 200, { default_branch: "trunk", visibility: "internal" }) : json(res, 401, { message: "401 Unauthorized" })));
    gl(`${proj}/repository/commits`, (_q, _b, res) => json(res, 200, [{ id: "def456", title: "Ship it", author_name: "Bo", committed_date: "2026-11-02T00:00:00Z" }]));
    gl(`${proj}/languages`, (_q, _b, res) => json(res, 200, { Vue: 80, TypeScript: 20 }));
    gl(`${proj}/merge_requests`, (_q, _b, res) => json(res, 200, [{}], { "x-total": "3" }));
    gl(`${proj}/repository/files/${encodeURIComponent("README.md")}`, (_q, _b, res) => json(res, 200, { size: 5, encoding: "base64", content: Buffer.from("hello").toString("base64") }));
    routes.set(`HEAD /gl/api/v4${proj}/repository/files/${encodeURIComponent("README.md")}`, (_q, _b, res) => res.writeHead(200, { "x-gitlab-size": "5" }).end());
    // 2.5 MB: its base64 JSON would be over the 3 MB response cap.
    routes.set(`HEAD /gl/api/v4${proj}/repository/files/${encodeURIComponent("dist/big.js")}`, (_q, _b, res) => res.writeHead(200, { "x-gitlab-size": String(2.5 * 1024 * 1024) }).end());
    gl(`${proj}/repository/files/${encodeURIComponent("dist/big.js")}`, (_q, _b, res) => json(res, 200, { size: 2.5 * 1024 * 1024, encoding: "base64", content: Buffer.alloc(2.5 * 1024 * 1024, 97).toString("base64") }));
  }

  it("reads GitLab projects too, with the API's total for open merge requests", async () => {
    gitlabRepo();
    const o = await owner();
    const c = await createConnection(o, "shop", { kind: "git", name: "GitLab", config: { provider: "gitlab" }, secret: { token: "glpat-abcdefghijklmnop" }, component: "web" });
    const r = await syncConnection(o, c.id);
    expect(r).toMatchObject({ ok: true, sync: { repositories: 1, synced: 1 } });
    expect((await db.query<{ repo_info: Record<string, unknown> }>("SELECT repo_info FROM components WHERE slug = 'web'")).rows[0]!.repo_info).toMatchObject({ provider: "gitlab", default_branch: "trunk", open_prs: 3, last_commit: { sha: "def456" } });
    const f = await readRepoFile(await writer(), { project: "shop", component: "web", path: "README.md" });
    expect(f).toMatchObject({ kind: "file", ref: "trunk", text: "hello" });
    expect(hits.some((h) => h.url.includes("/repository/files/README.md?ref=trunk"))).toBe(true);
    // A file over 1 MB is said to be too large (its size from HEAD), not fetched.
    const big = await readRepoFile(await writer(), { project: "shop", component: "web", path: "dist/big.js" });
    expect(big).toMatchObject({ kind: "file", text: null, size: 2.5 * 1024 * 1024, note: expect.stringMatching(/over the 1 MB/) });
    expect(hits.some((h) => h.method === "GET" && h.url.includes("dist%2Fbig.js"))).toBe(false);
  });

  it("is used by stack detection in preference to the server's token, and only for its host", async () => {
    githubRepo();
    const seen: string[] = [];
    routes.set("GET /repos/acme/orders/dependency-graph/sbom", (req, _b, res) => {
      seen.push(String(req.headers.authorization));
      json(res, 200, { sbom: { packages: [{ externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:npm/left-pad@1.3.0" }] }] } });
    });
    const globalCalls: string[] = [];
    const settings: Settings = {
      ...connSettings(),
      security: {
        enabled: true,
        osvUrl: "http://osv.invalid",
        kevUrl: "http://kev.invalid",
        githubUrl: mockBase,
        githubToken: "global-token",
        fetch: (async (url: string, init?: RequestInit) => {
          globalCalls.push(`${url} ${(init?.headers as Record<string, string>)?.Authorization ?? ""}`);
          return new Response(JSON.stringify({}), { status: 404 });
        }) as typeof fetch,
      },
    };
    const ingested: string[] = [];
    const scope = (await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0]!.id;
    const res = await detectRepos(db, settings, async (_s, component, packages) => void ingested.push(`${component}:${packages.map((p) => p.name).join(",")}`), { scopeId: scope });
    expect(res.find((r) => r.repository === "orders")).toMatchObject({ technologies: ["docker"], packages: 1 });
    expect(seen).toEqual([`Bearer ${GIT_TOKEN}`]);
    expect(ingested).toEqual(["orders:left-pad"]);
    // The server's token was never used for github.com here (the project has its own).
    expect(globalCalls.filter((c) => c.includes("/repos/acme/orders"))).toEqual([]);

    // Paused: back to the server's token.
    await updateConnection(await owner(), gitId, { enabled: false });
    await detectRepos(db, settings, async () => undefined, { scopeId: scope });
    expect(globalCalls.some((c) => c.includes("/repos/acme/orders/languages") && c.endsWith("Bearer global-token"))).toBe(true);
    await updateConnection(await owner(), gitId, { enabled: true });
  });

  it("syncs on the schedule, and agents use it all over MCP", async () => {
    githubRepo();
    gitlabRepo();
    routes.set("GET /v1/orders/7", (_q, _b, res) => json(res, 200, { id: 7 }));
    await db.query("UPDATE connections SET next_run_at = now() - interval '1 minute' WHERE scope_id = (SELECT id FROM scopes WHERE slug = 'shop')");
    const logs: string[] = [];
    await runDueConnections(db, connSettings(), (m) => logs.push(m));
    expect(logs).toEqual([]);

    const server: Server = createApp({ db, authenticate: devAuthenticator("w-token=writer@example.com,r-token=reader@example.com,n-token=nobody@example.com"), settings: connSettings() }).listen(0);
    await new Promise((r) => server.once("listening", r));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
    const connect = async (token: string) => {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}`, "x-thaliyola-project": "shop" } } }));
      return client;
    };
    const parse = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0]!.text);
    try {
      const client = await connect("w-token");
      const eps = parse(await client.callTool({ name: "list_api_endpoints", arguments: { connection: "Orders API", filter: "/orders/{id}" } }));
      expect(eps.endpoints[0]).toMatchObject({ method: "GET", path: "/orders/{id}", callable: true });
      const called = parse(await client.callTool({ name: "call_api", arguments: { connection: "Orders API", path: "/orders/7" } }));
      expect(called).toMatchObject({ status: 200, body: { id: 7 } });
      const bad = await client.callTool({ name: "call_api", arguments: { connection: "Orders API", method: "DELETE", path: "/orders/7" } });
      expect(bad.isError).toBe(true);
      const file = parse(await client.callTool({ name: "read_repo_file", arguments: { component: "orders", path: "src/config.ts" } }));
      expect(file).toMatchObject({ kind: "file", path: "src/config.ts" });
      const ctxOut = parse(await client.callTool({ name: "get_project_context", arguments: {} }));
      expect(ctxOut.data_sources.apis.map((a: { name: string }) => a.name)).toEqual(["Billing", "Orders API"]);
      await client.close();

      const base = url.toString().replace(/\/mcp$/, "/api");
      const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: "Bearer r-token" } });
      const api = await (await get(`/apis/${apiId}`)).json();
      expect(api.endpoints.length).toBeGreaterThanOrEqual(4);
      const scopes = await (await get("/scopes")).json();
      const shop = scopes.scopes.find((s: { slug: string }) => s.slug === "shop");
      expect(shop.components.find((c: { slug: string }) => c.slug === "orders").git).toMatchObject({ default_branch: "main", open_prs: 7 });

      // Outside the members-only project: no API, and no repository facts.
      const asNobody = (path: string) => fetch(`${base}${path}`, { headers: { authorization: "Bearer n-token" } });
      expect((await asNobody(`/apis/${apiId}`)).status).toBe(404);
      const theirs = await (await asNobody("/scopes")).json();
      expect(theirs.scopes.some((s: { slug: string }) => s.slug === "shop")).toBe(false);
      expect(JSON.stringify(theirs)).not.toContain("acme/orders");
      const nobody = await connect("n-token").catch((err: unknown) => err);
      expect(nobody).toBeInstanceOf(Client);
      if (nobody instanceof Client) {
        const r = await nobody.callTool({ name: "list_api_endpoints", arguments: { connection: "Orders API" } });
        expect(r.isError).toBe(true);
        const f = await nobody.callTool({ name: "read_repo_file", arguments: { component: "orders", path: "src/config.ts" } });
        expect(f.isError).toBe(true);
        expect(JSON.stringify(f)).not.toContain("postgres://");
        await nobody.close();
      }
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("forgets what it read when the repository URL changes or the git connection is deleted", async () => {
    const facts = async (slug: string) => (await db.query<{ repo_info: Record<string, unknown> | null; repo_synced_at: string | null }>("SELECT repo_info, repo_synced_at FROM components WHERE slug = $1", [slug])).rows[0]!;
    expect((await facts("web")).repo_info).not.toBeNull();
    expect((await facts("orders")).repo_info).not.toBeNull();
    const a = await as("admin@example.com");
    // Saved with the same URL: kept.
    await updateComponent(a, "shop", "orders", { description: "Orders service", repo_url: "https://github.com/acme/orders" });
    expect((await facts("orders")).repo_info).not.toBeNull();
    await updateComponent(a, "shop", "orders", { repo_url: "https://github.com/acme/orders-v2" });
    expect(await facts("orders")).toEqual({ repo_info: null, repo_synced_at: null });

    const gitlab = (await db.query<{ id: string }>("SELECT id FROM connections WHERE name = 'GitLab'")).rows[0]!.id;
    await deleteConnection(await owner(), gitlab);
    expect(await facts("web")).toEqual({ repo_info: null, repo_synced_at: null });
    const pc = await getProjectContext(await reader(), "shop");
    expect((pc.components as { slug: string; repo?: unknown }[]).every((c) => !c.repo)).toBe(true);
  });
});

describe("pinned requests", () => {
  it("can return a redirect instead of following it", async () => {
    const s = createServer((req, res) => (req.url === "/a" ? res.writeHead(302, { location: "/b" }).end() : res.writeHead(200).end("b"))).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    const u = `http://127.0.0.1:${(s.address() as AddressInfo).port}/a`;
    try {
      expect((await pinnedFetch(u, "http", { allowPrivate: false, allowLocal: true })).text).toBe("b");
      expect((await pinnedFetch(u, "http", { allowPrivate: false, allowLocal: true }, { followRedirects: false })).status).toBe(302);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });
});

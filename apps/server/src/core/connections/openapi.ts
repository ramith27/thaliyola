import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { ValidationError } from "../context.js";
import { redact } from "../redaction.js";

/**
 * OpenAPI 3.x and Swagger 2.0 specs (JSON or YAML) as endpoint objects: one per method and path, with parameters,
 * request body and responses summarised as short type strings, plus the spec's named data shapes and how requests
 * authenticate. Specs come from outside: every text in them is cut short and goes through the redaction rules, $refs
 * are only followed inside the document (never fetched), and loops and depth are bounded.
 */

export const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"] as const;

export interface EndpointParam {
  name: string;
  in: string;
  required: boolean;
  type: string;
  description?: string;
}

export interface EndpointDef {
  method: string;
  path: string;
  operation_id?: string;
  summary?: string;
  description?: string;
  tags: string[];
  deprecated?: boolean;
  params: EndpointParam[];
  body: { content_type: string; type: string; required: boolean } | null;
  /**
   * type: the schema as a short type string ("Order"); shape: for a schema that's a named one (or an array of one),
   * that one's fields too, so a change inside it shows as a change of the response.
   */
  responses: { status: string; description?: string; type?: string; shape?: string }[];
  /** Names of the security schemes it accepts (empty: the spec's default, or none). */
  auth?: string[];
}

export interface ApiSpec {
  format: string;
  title: string;
  version: string;
  description?: string;
  servers: string[];
  endpoints: EndpointDef[];
  schemas: { name: string; type: string; description?: string }[];
  auth: { name: string; detail: string }[];
}

const MAX_TEXT = 500;
const MAX_TYPE = 300;
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** Text from the spec: one paragraph, cut, redacted. */
function text(v: unknown, max = MAX_TEXT): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const t = String(v).replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return redact(t.length > max ? `${t.slice(0, max)}…` : t).text;
}

/** A spec's text as a document: JSON, else YAML (aliases bounded, no custom tags). */
export function parseSpecText(raw: string): unknown {
  const t = raw.replace(/^﻿/, "").trim();
  if (!t) throw new ValidationError("the spec is empty");
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      // Flow-style YAML starts with { too.
    }
  }
  try {
    return parseYaml(t, { maxAliasCount: 100, schema: "core", prettyErrors: false, uniqueKeys: false });
  } catch (err) {
    throw new ValidationError(`the spec isn't valid JSON or YAML: ${String((err as Error).message ?? err).split("\n")[0]!.slice(0, 200)}`);
  }
}

/** Follows a local $ref ("#/components/schemas/Order"); anything else isn't followed. */
function deref(doc: Obj, v: unknown, depth = 0): unknown {
  if (!isObj(v) || typeof own(v, "$ref") !== "string" || depth > 10) return v;
  const ref = own(v, "$ref") as string;
  if (!ref.startsWith("#/")) return v;
  let cur: unknown = doc;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObj(cur)) return v;
    cur = own(cur, key);
  }
  return cur === undefined ? v : deref(doc, cur, depth + 1);
}

const refName = (ref: string) => ref.split("/").pop()!.replace(/~1/g, "/").replace(/~0/g, "~");

/** A schema as a short type string: Order, array<Order>, {id: integer, note?: string}, "a" | "b"… */
export function typeOf(doc: Obj, schema: unknown, depth = 0, seen: Set<unknown> = new Set()): string {
  const out = typeInner(doc, schema, depth, seen);
  return out.length > MAX_TYPE ? `${out.slice(0, MAX_TYPE)}…` : out;
}

function typeInner(doc: Obj, s: unknown, depth: number, seen: Set<unknown>): string {
  if (!isObj(s)) return "any";
  const ref = own(s, "$ref");
  if (typeof ref === "string") return text(refName(ref), 80) ?? "object";
  if (seen.has(s) || depth > 3) return "object";
  seen = new Set(seen).add(s);
  for (const k of ["oneOf", "anyOf", "allOf"]) {
    const list = own(s, k);
    if (Array.isArray(list) && list.length) {
      const parts = list.slice(0, 6).map((x) => typeInner(doc, x, depth + 1, seen));
      return parts.join(k === "allOf" ? " & " : " | ");
    }
  }
  const en = own(s, "enum");
  if (Array.isArray(en) && en.length) {
    const vals = en.slice(0, 6).map((x) => (typeof x === "string" ? JSON.stringify(text(x, 40) ?? "") : String(x)));
    return vals.join(" | ") + (en.length > 6 ? " | …" : "");
  }
  let type = own(s, "type");
  if (Array.isArray(type)) type = type.filter((t) => t !== "null")[0];
  const nullable = own(s, "nullable") === true || (Array.isArray(own(s, "type")) && (own(s, "type") as unknown[]).includes("null"));
  const suffix = nullable ? " | null" : "";
  const items = own(s, "items");
  const props = own(s, "properties");
  if (type === "array" || (type === undefined && items !== undefined)) return `array<${typeInner(doc, items, depth + 1, seen)}>${suffix}`;
  if (type === "object" || (type === undefined && isObj(props))) {
    if (!isObj(props) || !Object.keys(props).length || depth >= 2) {
      const extra = own(s, "additionalProperties");
      return isObj(extra) ? `map<string, ${typeInner(doc, extra, depth + 1, seen)}>${suffix}` : `object${suffix}`;
    }
    const required = new Set(Array.isArray(own(s, "required")) ? (own(s, "required") as unknown[]).map(String) : []);
    const keys = Object.keys(props);
    const fields = keys.slice(0, 8).map((k) => `${text(k, 60) ?? "?"}${required.has(k) ? "" : "?"}: ${typeInner(doc, own(props, k), depth + 1, seen)}`);
    return `{${fields.join(", ")}${keys.length > 8 ? ", …" : ""}}${suffix}`;
  }
  if (typeof type === "string") {
    const format = own(s, "format");
    return `${text(type, 40) ?? "any"}${typeof format === "string" ? `(${text(format, 40)})` : ""}${suffix}`;
  }
  return "any";
}

function paramOf(doc: Obj, raw: unknown, swagger: boolean): (EndpointParam & { schema?: unknown }) | null {
  const p = deref(doc, raw);
  if (!isObj(p)) return null;
  const name = text(own(p, "name"), 120);
  const where = text(own(p, "in"), 20);
  if (!name || !where) return null;
  const schema = swagger && where !== "body" ? p : own(p, "schema") ?? (isObj(own(p, "content")) ? Object.values(own(p, "content") as Obj).map((c) => (isObj(c) ? own(c, "schema") : undefined))[0] : undefined);
  return {
    name,
    in: where,
    required: own(p, "required") === true || where === "path",
    type: typeOf(doc, schema),
    ...(text(own(p, "description"), 200) ? { description: text(own(p, "description"), 200) } : {}),
    ...(swagger && where === "body" ? { schema: own(p, "schema") } : {}),
  };
}

/** The first content type of a content map, JSON first. */
function pickContent(content: unknown): [string, unknown] | null {
  if (!isObj(content)) return null;
  const keys = Object.keys(content);
  if (!keys.length) return null;
  const key = keys.find((k) => /json/i.test(k)) ?? keys[0]!;
  const c = own(content, key);
  return [key, isObj(c) ? own(c, "schema") : undefined];
}

function securityNames(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return [...new Set(v.flatMap((req) => (isObj(req) ? Object.keys(req) : [])).map((n) => text(n, 60)).filter((n): n is string => !!n))];
}

function describeScheme(s: Obj): string {
  const type = String(own(s, "type") ?? "");
  const where = text(own(s, "in"), 20);
  const name = text(own(s, "name"), 80);
  switch (type) {
    case "apiKey":
      return `API key in the ${where ?? "header"}${name ? ` \`${name}\`` : ""}`;
    case "http": {
      const scheme = String(own(s, "scheme") ?? "").toLowerCase();
      return scheme === "basic" ? "user name and password (HTTP basic)" : scheme === "bearer" ? `bearer token${own(s, "bearerFormat") ? ` (${text(own(s, "bearerFormat"), 40)})` : ""}` : `HTTP ${text(scheme, 40) ?? "auth"}`;
    }
    case "basic":
      return "user name and password (HTTP basic)";
    case "oauth2":
      return "OAuth 2.0";
    case "openIdConnect":
      return "OpenID Connect";
    case "mutualTLS":
      return "mutual TLS";
    default:
      return text(type, 40) ?? "unknown";
  }
}

/** A named schema's fields (or an array of one's): "{id: integer, total?: number}" where typeOf says "Order". */
function shapeOf(doc: Obj, schema: unknown): string {
  const top = deref(doc, schema);
  const items = isObj(top) ? own(top, "items") : undefined;
  return typeOf(doc, isObj(top) && isObj(items) ? { ...top, items: deref(doc, items) } : top);
}

/** Endpoints, shapes and auth of an OpenAPI 3.x or Swagger 2.0 document. */
export function parseOpenApi(input: unknown, opts: { maxEndpoints?: number } = {}): ApiSpec & { total: number } {
  if (!isObj(input)) throw new ValidationError("the spec isn't an OpenAPI document (expected an object at the top)");
  const doc = input;
  const swagger = typeof own(doc, "swagger") === "string" && String(own(doc, "swagger")).startsWith("2");
  const openapi = typeof own(doc, "openapi") === "string" ? String(own(doc, "openapi")) : null;
  if (!swagger && !openapi) throw new ValidationError("the spec isn't OpenAPI 3 or Swagger 2 (no openapi or swagger field)");
  if (openapi && !/^3\./.test(openapi)) throw new ValidationError(`OpenAPI ${text(openapi, 20)} isn't supported (3.x and Swagger 2.0 are)`);
  const paths = own(doc, "paths");
  if (paths !== undefined && !isObj(paths)) throw new ValidationError("the spec's paths isn't an object");
  const info = isObj(own(doc, "info")) ? (own(doc, "info") as Obj) : {};
  const globalSecurity = securityNames(own(doc, "security"));

  const servers: string[] = [];
  if (swagger) {
    const host = text(own(doc, "host"), 200);
    const basePath = text(own(doc, "basePath"), 200) ?? "";
    const schemes = Array.isArray(own(doc, "schemes")) ? (own(doc, "schemes") as unknown[]).map(String) : ["https"];
    if (host) servers.push(`${schemes.includes("https") ? "https" : (schemes[0] ?? "https")}://${host}${basePath}`);
    else if (basePath) servers.push(basePath);
  } else if (Array.isArray(own(doc, "servers"))) {
    for (const s of (own(doc, "servers") as unknown[]).slice(0, 5)) if (isObj(s) && text(own(s, "url"), 300)) servers.push(text(own(s, "url"), 300)!);
  }

  const endpoints: EndpointDef[] = [];
  let total = 0;
  const max = opts.maxEndpoints ?? Infinity;
  for (const [path, rawItem] of Object.entries(isObj(paths) ? paths : {})) {
    const item = deref(doc, rawItem);
    if (!isObj(item) || !path.startsWith("/") || path.length > 500 || /[\s\u0000-\u001f]/.test(path)) continue;
    const shared = Array.isArray(own(item, "parameters")) ? (own(item, "parameters") as unknown[]) : [];
    for (const m of METHODS) {
      const op = own(item, m);
      if (!isObj(op)) continue;
      total++;
      if (endpoints.length >= max) continue;
      const params = new Map<string, EndpointParam & { schema?: unknown }>();
      for (const raw of [...shared, ...(Array.isArray(own(op, "parameters")) ? (own(op, "parameters") as unknown[]) : [])].slice(0, 100)) {
        const p = paramOf(doc, raw, swagger);
        if (p) params.set(`${p.in}\0${p.name}`, p);
      }
      let body: EndpointDef["body"] = null;
      if (swagger) {
        const b = [...params.values()].find((p) => p.in === "body");
        const form = [...params.values()].filter((p) => p.in === "formData");
        const consumes = Array.isArray(own(op, "consumes")) ? (own(op, "consumes") as unknown[]) : Array.isArray(own(doc, "consumes")) ? (own(doc, "consumes") as unknown[]) : [];
        if (b) body = { content_type: String(consumes[0] ?? "application/json"), type: typeOf(doc, b.schema), required: b.required };
        else if (form.length) body = { content_type: String(consumes[0] ?? "application/x-www-form-urlencoded"), type: `{${form.map((f) => `${f.name}${f.required ? "" : "?"}: ${f.type}`).join(", ")}}`.slice(0, MAX_TYPE), required: form.some((f) => f.required) };
        for (const [k, p] of params) if (p.in === "body" || p.in === "formData") params.delete(k);
      } else {
        const rb = deref(doc, own(op, "requestBody"));
        const c = isObj(rb) ? pickContent(own(rb, "content")) : null;
        if (isObj(rb) && c) body = { content_type: text(c[0], 100) ?? "application/json", type: typeOf(doc, c[1]), required: own(rb, "required") === true };
      }
      const responses: EndpointDef["responses"] = [];
      const rs = own(op, "responses");
      for (const [status, rawRes] of Object.entries(isObj(rs) ? rs : {}).slice(0, 30)) {
        if (!/^([1-5][0-9X]{2}|default)$/i.test(status)) continue;
        const r = deref(doc, rawRes);
        if (!isObj(r)) continue;
        const schema = swagger ? own(r, "schema") : pickContent(own(r, "content"))?.[1];
        const type = schema !== undefined ? typeOf(doc, schema) : undefined;
        const shape = schema !== undefined ? shapeOf(doc, schema) : undefined;
        responses.push({
          status: status.toUpperCase() === "DEFAULT" ? "default" : status.toUpperCase(),
          ...(text(own(r, "description"), 200) ? { description: text(own(r, "description"), 200) } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(shape !== undefined && shape !== type ? { shape } : {}),
        });
      }
      const tags = Array.isArray(own(op, "tags")) ? (own(op, "tags") as unknown[]).map((t) => text(t, 80)).filter((t): t is string => !!t).slice(0, 5) : [];
      const auth = securityNames(own(op, "security")) ?? globalSecurity;
      endpoints.push({
        method: m.toUpperCase(),
        path,
        ...(text(own(op, "operationId"), 120) ? { operation_id: text(own(op, "operationId"), 120) } : {}),
        ...(text(own(op, "summary"), 200) ? { summary: text(own(op, "summary"), 200) } : {}),
        ...(text(own(op, "description")) ? { description: text(own(op, "description")) } : {}),
        tags,
        ...(own(op, "deprecated") === true ? { deprecated: true } : {}),
        params: [...params.values()].map(({ schema: _s, ...p }) => p),
        body,
        responses,
        ...(auth ? { auth } : {}),
      });
    }
  }

  const named = swagger ? own(doc, "definitions") : isObj(own(doc, "components")) ? own(own(doc, "components") as Obj, "schemas") : undefined;
  const schemas = Object.entries(isObj(named) ? named : {})
    .slice(0, 200)
    .map(([name, s]) => ({ name: text(name, 120) ?? "?", type: typeOf(doc, s), ...(isObj(s) && text(own(s, "description"), 200) ? { description: text(own(s, "description"), 200) } : {}) }));

  const schemes = swagger ? own(doc, "securityDefinitions") : isObj(own(doc, "components")) ? own(own(doc, "components") as Obj, "securitySchemes") : undefined;
  const auth = Object.entries(isObj(schemes) ? schemes : {})
    .slice(0, 20)
    .map(([name, s]) => ({ name: text(name, 60) ?? "?", detail: isObj(deref(doc, s)) ? describeScheme(deref(doc, s) as Obj) : "unknown" }));

  return {
    format: swagger ? "Swagger 2.0" : `OpenAPI ${text(openapi, 20)}`,
    title: text(own(info, "title"), 200) ?? "",
    version: text(own(info, "version"), 60) ?? "",
    ...(text(own(info, "description"), 1000) ? { description: text(own(info, "description"), 1000) } : {}),
    servers,
    endpoints,
    schemas,
    auth,
    total,
  };
}

export const endpointKey = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

/** What a response returns, as compared between syncs: its fields when it's a named schema, else its type. */
const responseType = (r: EndpointDef["responses"][number]): string | null => r.shape ?? r.type ?? null;

/** What a sync compares for an endpoint: its signature (not its wording). */
export function endpointHash(e: EndpointDef): string {
  const shape = {
    params: e.params.map((p) => [p.in, p.name, p.required, p.type]).sort(),
    body: e.body ? [e.body.content_type, e.body.type, e.body.required] : null,
    responses: e.responses.map((r) => [r.status, responseType(r)]).sort(),
    deprecated: !!e.deprecated,
  };
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

export interface EndpointChange {
  params_added?: string[];
  params_removed?: string[];
  now_required?: string[];
  type_changed?: { param: string; from: string; to: string }[];
  body?: { from: string | null; to: string | null };
  responses_added?: string[];
  responses_removed?: string[];
  /** A response whose type changed (from or to null: the spec stopped or started saying what it returns). */
  responses_changed?: { status: string; from: string | null; to: string | null }[];
  deprecated?: boolean;
  /**
   * Callers may need to change: a new required parameter, a parameter's type, a body that's now required or changed,
   * or a success (2xx) response that's gone or returns something else.
   */
  breaking: boolean;
}

/** How an endpoint's signature changed between two syncs. */
export function diffEndpoint(before: EndpointDef, after: EndpointDef): EndpointChange {
  const id = (p: EndpointParam) => `${p.in}:${p.name}`;
  const old = new Map(before.params.map((p) => [id(p), p]));
  const now = new Map(after.params.map((p) => [id(p), p]));
  const out: EndpointChange = { breaking: false };
  const added = after.params.filter((p) => !old.has(id(p)));
  const removed = before.params.filter((p) => !now.has(id(p)));
  const nowRequired = after.params.filter((p) => p.required && (!old.has(id(p)) || !old.get(id(p))!.required));
  const typed = after.params.filter((p) => old.has(id(p)) && old.get(id(p))!.type !== p.type).map((p) => ({ param: p.name, from: old.get(id(p))!.type, to: p.type }));
  if (added.length) out.params_added = added.map((p) => p.name);
  if (removed.length) out.params_removed = removed.map((p) => p.name);
  if (nowRequired.length) out.now_required = nowRequired.map((p) => p.name);
  if (typed.length) out.type_changed = typed;
  const bodyText = (b: EndpointDef["body"]) => (b ? `${b.type}${b.required ? "" : " (optional)"}` : null);
  if (bodyText(before.body) !== bodyText(after.body)) out.body = { from: bodyText(before.body), to: bodyText(after.body) };
  const st = (e: EndpointDef) => new Set(e.responses.map((r) => r.status));
  const ra = [...st(after)].filter((s) => !st(before).has(s));
  const rr = [...st(before)].filter((s) => !st(after).has(s));
  if (ra.length) out.responses_added = ra;
  if (rr.length) out.responses_removed = rr;
  const was = new Map(before.responses.map((r) => [r.status, responseType(r)]));
  const retyped = after.responses.filter((r) => was.has(r.status) && was.get(r.status) !== responseType(r)).map((r) => ({ status: r.status, from: was.get(r.status)!, to: responseType(r) }));
  if (retyped.length) out.responses_changed = retyped;
  if (!!after.deprecated !== !!before.deprecated) out.deprecated = !!after.deprecated;
  const success = (status: string) => /^2/.test(status);
  // A success response that's gone, or whose type changed (one the spec only now describes isn't a change for callers).
  const responseBreaks = rr.some(success) || retyped.some((r) => success(r.status) && r.from !== null);
  out.breaking = nowRequired.length > 0 || typed.length > 0 || (!!out.body && !!after.body && (after.body.required || !!before.body)) || responseBreaks;
  return out;
}

/** One line for an endpoint change. */
export function describeEndpointChange(key: string, d: Partial<EndpointChange>): string {
  const parts: string[] = [];
  if (d.now_required?.length) parts.push(`now requires ${d.now_required.join(", ")}`);
  if (d.params_added?.length) parts.push(`new parameters ${d.params_added.join(", ")}`);
  if (d.params_removed?.length) parts.push(`parameters ${d.params_removed.join(", ")} removed`);
  for (const t of d.type_changed ?? []) parts.push(`${t.param} changed from ${t.from} to ${t.to}`);
  if (d.body) parts.push(d.body.to ? `request body is now ${d.body.to}` : "request body removed");
  if (d.responses_removed?.length) parts.push(`responses ${d.responses_removed.join(", ")} removed`);
  if (d.responses_added?.length) parts.push(`new responses ${d.responses_added.join(", ")}`);
  for (const r of d.responses_changed ?? []) parts.push(r.to === null ? `${r.status} response no longer says what it returns (was ${r.from})` : r.from === null ? `${r.status} response now returns ${r.to}` : `${r.status} response changed from ${r.from} to ${r.to}`);
  if (d.deprecated !== undefined) parts.push(d.deprecated ? "deprecated" : "no longer deprecated");
  return `${key}: ${parts.length ? parts.join("; ") : "changed"}`;
}

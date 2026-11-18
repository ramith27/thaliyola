import { NAME_RE } from "./types.js";

/**
 * A plugin's .mcp.json (the connectors it needs), checked like ci/validate.py's validate_mcp_json:
 * {"mcpServers": {"<name>": {"type": "http"|"sse", "url": "https://<host>/…"}}} and nothing else (no headers, no
 * query strings, no credentials). Plus strict JSON (duplicate keys refused, like load_json_strict).
 */

export interface Connector {
  name: string;
  type: "http" | "sse";
  url: string;
}

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export class DuplicateKeyError extends Error {}

/** JSON.parse that refuses duplicate keys in any object (Python's object_pairs_hook=_no_dup_pairs). */
export function parseJsonStrict(text: string): unknown {
  const value = JSON.parse(text) as unknown;
  // Second pass: walk the text and track the keys of each open object.
  const stack: (Set<string> | null)[] = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "{") {
      stack.push(new Set());
      expectKey = true;
    } else if (c === "[") {
      stack.push(null);
      expectKey = false;
    } else if (c === "}" || c === "]") {
      stack.pop();
      expectKey = false;
    } else if (c === ",") expectKey = stack[stack.length - 1] instanceof Set;
    else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        const keys = stack[stack.length - 1] as Set<string>;
        if (keys.has(key)) throw new DuplicateKeyError(`duplicate key '${key}'`);
        keys.add(key);
        expectKey = false;
      }
      i = j;
    }
  }
  return value;
}

/** The connectors a .mcp.json declares, and the problems that make it unusable (then no connectors are kept). */
export function parseConnectors(text: string, where = ".mcp.json"): { connectors: Connector[]; errors: string[] } {
  const errors: string[] = [];
  let doc: unknown;
  try {
    doc = parseJsonStrict(text);
  } catch (err) {
    return { connectors: [], errors: [`${where}: invalid JSON (${(err as Error).message})`] };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || Object.keys(doc).length !== 1 || !("mcpServers" in doc)) {
    return { connectors: [], errors: [`${where}: must be an object with exactly one key, 'mcpServers'`] };
  }
  const servers = (doc as { mcpServers: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers) || !Object.keys(servers).length) {
    return { connectors: [], errors: [`${where}: 'mcpServers' must be a non-empty object of name → server`] };
  }
  const connectors: Connector[] = [];
  for (const [name, srv] of Object.entries(servers as Record<string, unknown>)) {
    const sw = `${where} mcpServers['${name}']`;
    const before = errors.length;
    if (!NAME_RE.test(name) || name.length > 64) errors.push(`${sw}: server name must be lowercase-hyphen, ≤ 64 chars`);
    if (!srv || typeof srv !== "object" || Array.isArray(srv)) {
      errors.push(`${sw}: must be an object`);
      continue;
    }
    const s = srv as Record<string, unknown>;
    const extra = Object.keys(s).filter((k) => k !== "type" && k !== "url").sort();
    if (extra.length) {
      const local = extra.some((k) => ["command", "args", "env", "cwd"].includes(k));
      const why = local ? "local/stdio servers cannot be delivered through an org plugin" : extra.includes("headers") ? "credentials and options must not live in the repo" : "unknown keys";
      errors.push(`${sw}: keys ${JSON.stringify(extra)} not allowed (${why}); allowed: ["type", "url"]`);
    }
    if (s.type !== "http" && s.type !== "sse") errors.push(`${sw}: 'type' must be one of ["http", "sse"], got ${JSON.stringify(s.type)}`);
    const url = s.url;
    if (typeof url !== "string" || !url) {
      errors.push(`${sw}: 'url' is required`);
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
    if (!m) {
      errors.push(`${sw}: url must be https://host[/path], got '${url}'`);
      continue;
    }
    const netloc = m[2]!;
    const hostport = netloc.includes("@") ? netloc.slice(netloc.lastIndexOf("@") + 1) : netloc;
    const pm = /^(.*?)(?::(\d*))?$/.exec(hostport)!;
    const host = pm[1]!.toLowerCase();
    if (pm[2] !== undefined && pm[2] !== "" && Number(pm[2]) > 65535) {
      errors.push(`${sw}: malformed url '${url}' (port out of range 0-65535)`);
      continue;
    }
    if (m[1]!.toLowerCase() !== "https" || !host) errors.push(`${sw}: url must be https://host[/path], got '${url}'`);
    else if (!HOSTNAME_RE.test(host)) errors.push(`${sw}: url host '${host}' is not a valid hostname`);
    if (netloc.includes("@")) errors.push(`${sw}: url must not embed credentials`);
    if ([...url].some((ch) => /\s/.test(ch) || ch.charCodeAt(0) < 32)) errors.push(`${sw}: url contains whitespace or control characters`);
    if (m[4] || m[5]) errors.push(`${sw}: url must not carry a query string or fragment (tokens do not belong here)`);
    if (errors.length === before) connectors.push({ name, type: s.type as Connector["type"], url });
  }
  return errors.length ? { connectors: [], errors } : { connectors, errors };
}

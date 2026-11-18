import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { ValidationError } from "../context.js";

/**
 * Where connections may reach, checked before every connection and on every redirect, with the checked address
 * pinned for the actual connection (no second DNS lookup, so a rebinding DNS answer can't swap in another address).
 *
 * - HTTP kinds (APIs, Slack, Trello, git hosts, spec URLs): public addresses only, unless CONNECTIONS_ALLOW_PRIVATE.
 * - Database kinds: private networks are fine (RDS lives inside the VPC).
 * - Never: loopback, link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10, fd00:ec2::254), unspecified
 *   and multicast addresses, and the host of Thaliyola's own database.
 */

export interface NetPolicy {
  /** HTTP kinds may reach private networks (CONNECTIONS_ALLOW_PRIVATE). */
  allowPrivate: boolean;
  /** Tests only (never from the environment): loopback and Thaliyola's own database host are allowed. */
  allowLocal?: boolean;
  /** Thaliyola's own database host(s), from DATABASE_URL. */
  ownHosts?: string[];
  /** Injected in tests. */
  lookup?: (host: string) => Promise<{ address: string; family?: number }[]>;
  /**
   * Hosts (exact, lowercase names) that may resolve to a private address even though allowPrivate is off: skill
   * imports' SKILLS_GIT_HOSTS. Loopback, link-local and metadata addresses stay refused for them too.
   */
  allowPrivateHosts?: ReadonlySet<string>;
  /** Overrides the private-network refusal message (skill imports name SKILLS_GIT_HOSTS instead). */
  privateHint?: string;
}

export type NetMode = "http" | "database";

export type AddressClass = "public" | "private" | "loopback" | "link_local" | "unspecified" | "multicast";

/**
 * Expands an IPv6 address to its 8 groups, including a trailing dotted IPv4 part ("::ffff:127.0.0.1"). Null when it
 * isn't an IPv6 address.
 */
function groups6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  if (isIP(ip) !== 6) return null;
  const v4 = ip.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1]!.split(".").map(Number) as [number, number, number, number];
    ip = `${ip.slice(0, -v4[1]!.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = ip.split("::") as [string, string | undefined];
  const part = (s: string | undefined) => (s ? s.split(":").map((g) => parseInt(g, 16)) : []);
  const a = part(head);
  const b = part(tail);
  if (tail === undefined) return a.length === 8 ? a : null;
  const fill = 8 - a.length - b.length;
  return fill < 0 ? null : [...a, ...new Array<number>(fill).fill(0), ...b];
}

const dotted = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/**
 * The IPv4 address an IPv6 address carries, for the forms the OS (or a NAT64 gateway) sends to that IPv4 address:
 * IPv4-mapped ::ffff:0:0/96, IPv4-compatible ::/96 (not :: and ::1), IPv4-translated ::ffff:0:0:0/96 and NAT64
 * 64:ff9b::/96. Written any way (expanded, zero-padded, dotted or hex).
 */
function embeddedV4(g: number[]): string | null {
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  const v4 = dotted(g[6]!, g[7]!);
  if (zero(0, 5) && g[5] === 0xffff) return v4;
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4;
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4;
  if (zero(0, 6) && !(g[6] === 0 && g[7]! <= 1)) return v4;
  return null;
}

/**
 * One spelling per address, so addresses compare as strings: IPv4 as it is, IPv6 that carries an IPv4 address as that
 * IPv4 address, other IPv6 lowercase and compressed (RFC 5952). Brackets and zone ids are dropped. Not an IP: null.
 */
export function canonicalIp(raw: string): string | null {
  const ip = raw.trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (isIP(ip) === 4) return ip;
  const g = groups6(ip);
  if (!g) return null;
  const v4 = embeddedV4(g);
  if (v4) return v4;
  // The longest run of two or more zero groups becomes "::" (the first one when runs tie).
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j;
  }
  const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(":");
  return best < 0 ? hex(g) : `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}`;
}

export function addressClass(raw: string): AddressClass {
  const ip = canonicalIp(raw);
  if (!ip) return "unspecified";
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    if (a === 0) return "unspecified";
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link_local";
    if (a >= 224) return "multicast";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)))
      return "private";
    return "public";
  }
  const g = groups6(ip)!;
  if (g.every((x) => x === 0)) return "unspecified";
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  const first = g[0]!;
  if ((first & 0xffc0) === 0xfe80) return "link_local";
  // AWS's IPv6 instance metadata endpoint.
  if (first === 0xfd00 && g[1] === 0xec2 && g.slice(2, 7).every((x) => x === 0) && g[7] === 0x254) return "link_local";
  if ((first & 0xff00) === 0xff00) return "multicast";
  if ((first & 0xfe00) === 0xfc00) return "private";
  return "public";
}

const defaultLookup = (host: string) => dnsLookup(host, { all: true, verbatim: true });

/** Hosts Thaliyola's own database runs on; refused as a connection target. */
export function ownDatabaseHosts(databaseUrl: string | undefined): string[] {
  if (!databaseUrl) return [];
  try {
    const host = new URL(databaseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host ? [canonicalIp(host) ?? host] : [];
  } catch {
    return [];
  }
}

/**
 * Resolves a host and checks every address it resolves to. Returns the address to connect to (pinned: callers
 * connect to this address, not to the name again). Throws a ValidationError that says why a host isn't allowed.
 */
export async function resolveTarget(rawHost: string, mode: NetMode, policy: NetPolicy): Promise<{ host: string; address: string; family: 4 | 6 }> {
  const name = rawHost.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!name) throw new ValidationError("a host is required");
  // An IP literal is compared and connected to in one spelling (::ffff:127.0.0.1, 0::ffff:7f00:1 → 127.0.0.1).
  const host = canonicalIp(name) ?? name;
  const lookup = policy.lookup ?? defaultLookup;
  let addrs: string[];
  if (isIP(host)) addrs = [host];
  else {
    try {
      addrs = (await lookup(host)).map((a) => canonicalIp(a.address) ?? a.address);
    } catch {
      throw new ValidationError(`${host} couldn't be found (DNS lookup failed)`);
    }
  }
  if (!addrs.length) throw new ValidationError(`${host} couldn't be found (DNS lookup failed)`);

  if (!policy.allowLocal && policy.ownHosts?.length) {
    const own = new Set(policy.ownHosts.map((h) => { const n = h.trim().replace(/^\[|\]$/g, "").toLowerCase(); return canonicalIp(n) ?? n; }));
    const ownAddrs = new Set<string>();
    for (const h of own) {
      if (isIP(h)) ownAddrs.add(h);
      else for (const a of await lookup(h).catch(() => [] as { address: string }[])) ownAddrs.add(canonicalIp(a.address) ?? a.address);
    }
    if (own.has(host) || addrs.some((a) => ownAddrs.has(a))) throw new ValidationError(`${host} is where Thaliyola's own database runs; connections can't reach it`);
  }

  for (const address of addrs) {
    const cls = addressClass(address);
    if (cls === "link_local") throw new ValidationError(`${host} resolves to a link-local or cloud metadata address (${address}); connections never reach those`);
    if (cls === "unspecified" || cls === "multicast") throw new ValidationError(`${host} resolves to ${address}, which isn't a host address`);
    if (cls === "loopback" && !policy.allowLocal) throw new ValidationError(`${host} resolves to ${address} (this server itself); connections can't reach loopback addresses`);
    if (cls === "private" && mode === "http" && !policy.allowPrivate && !policy.allowPrivateHosts?.has(host))
      throw new ValidationError(`${host} is on a private network (${address}); ${policy.privateHint ?? "an Administrator can set CONNECTIONS_ALLOW_PRIVATE=true to allow internal APIs"}`);
  }
  const address = addrs[0]!;
  return { host, address, family: isIP(address) === 6 ? 6 : 4 };
}

// ---- HTTP with the address pinned --------------------------------------------------------------------

export interface PinnedRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  /** Past maxBytes, return what was read so far (marked `cut`) instead of failing. */
  truncate?: boolean;
  maxRedirects?: number;
  /** false: a redirect is returned as it is, never followed (call_api: a redirect could leave the allowed paths). */
  followRedirects?: boolean;
  /** Keep the body as bytes in `body` (archives); `text` is then empty. */
  binary?: boolean;
}

export interface PinnedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  url: string;
  /** The raw body, for binary requests only. */
  body?: Buffer;
  /** The body stopped at maxBytes (requests with `truncate` only). */
  cut?: boolean;
}

export const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const UA = "Thaliyola/1.0 (+team knowledge base; connections)";
/** Headers kept when a redirect leaves the original origin (credentials never follow). */
const CROSS_ORIGIN_SAFE = new Set(["accept", "content-type", "user-agent", "accept-encoding"]);

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

function checkUrl(raw: string | URL): URL {
  let url: URL;
  try {
    url = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new ValidationError(`not a valid URL: ${String(raw).slice(0, 200)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new ValidationError("only http and https URLs can be used");
  if (url.username || url.password) throw new ValidationError("URLs with a user name or password in them aren't allowed; use the secret fields");
  return url;
}

function once(url: URL, address: string, family: 4 | 6, req: PinnedRequest, deadline: number): Promise<PinnedResponse> {
  const lib = url.protocol === "https:" ? https : http;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const pinned: LookupFunction = (_hostname, options, callback) => {
    const cb = callback as (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;
    if ((options as { all?: boolean }).all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
  const maxBytes = req.maxBytes ?? MAX_RESPONSE_BYTES;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, value?: PinnedResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        r.destroy();
        reject(err);
      } else resolve(value!);
    };
    const r = lib.request(
      {
        method: req.method ?? "GET",
        hostname: host,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        headers: { "user-agent": UA, "accept-encoding": "identity", ...req.headers },
        lookup: pinned,
        agent: false,
        ...(url.protocol === "https:" && !isIP(host) ? { servername: host } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const tooBig = () => new ValidationError(`the response is larger than ${maxBytes >= 1024 * 1024 ? `${Math.round(maxBytes / 1024 / 1024)} MB` : `${Math.ceil(maxBytes / 1024)} KB`}`);
        if (!req.truncate && Number(res.headers["content-length"]) > maxBytes) return finish(tooBig());
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            if (!req.truncate) return finish(tooBig());
            chunks.push(c.subarray(0, c.length - (size - maxBytes)));
            finish(null, { status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8"), url: url.toString(), cut: true });
            return r.destroy();
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const all = Buffer.concat(chunks);
          finish(null, req.binary ? { status: res.statusCode ?? 0, headers: res.headers, text: "", body: all, url: url.toString() } : { status: res.statusCode ?? 0, headers: res.headers, text: all.toString("utf8"), url: url.toString() });
        });
        res.on("error", (err) => finish(err));
        res.on("close", () => finish(new Error("the connection closed before the response was complete")));
      },
    );
    const timer = setTimeout(() => finish(new TimeoutError("timed out")), Math.max(1, deadline - Date.now()));
    r.on("error", (err) => finish(err));
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/**
 * An HTTP request to a user-supplied URL: the URL is checked, its host resolved and checked, and the request goes to
 * that address (TLS still verifies the certificate for the host name). In "http" mode redirects are followed (3 at
 * most) and each new location is checked the same way; credentials don't follow a redirect to another origin. In
 * "database" mode redirects aren't followed. Responses are capped
 * at 3 MB and the whole exchange at the timeout (20 s by default).
 */
export async function pinnedFetch(raw: string | URL, mode: NetMode, policy: NetPolicy, req: PinnedRequest = {}): Promise<PinnedResponse> {
  const deadline = Date.now() + (req.timeoutMs ?? 20_000);
  let url = checkUrl(raw);
  const origin = url.origin;
  let current: PinnedRequest = { ...req };
  for (let hop = 0; ; hop++) {
    const target = await resolveTarget(url.hostname, mode, policy);
    const res = await once(url, target.address, target.family, current, deadline);
    const location = res.headers.location;
    // Database kinds may reach private networks, so they never follow a redirect: the response is returned as it is
    // (and their drivers don't read much of it back), which keeps a database URL from being bent into another request.
    if (![301, 302, 303, 307, 308].includes(res.status) || !location || mode === "database" || req.followRedirects === false) return res;
    if (hop >= (req.maxRedirects ?? 3)) throw new ValidationError("too many redirects");
    url = checkUrl(new URL(location, url));
    const headers = { ...(current.headers ?? {}) };
    if (url.origin !== origin) for (const k of Object.keys(headers)) if (!CROSS_ORIGIN_SAFE.has(k.toLowerCase())) delete headers[k];
    current = res.status === 303 || ((res.status === 301 || res.status === 302) && current.method && current.method !== "GET" && current.method !== "HEAD")
      ? { ...current, method: "GET", body: undefined, headers }
      : { ...current, headers };
  }
}

/** JSON body of a response, or a short error that never echoes much of what the remote sent. */
export function jsonOf<T>(res: PinnedResponse, what: string): T {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new ValidationError(`${what} didn't answer with JSON (HTTP ${res.status})`);
  }
}

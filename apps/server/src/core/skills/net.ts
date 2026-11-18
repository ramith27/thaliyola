import type { Settings } from "../../config.js";
import { ValidationError } from "../context.js";
import type { NetPolicy, PinnedResponse } from "../connections/network.js";
import type { DriverEnv } from "../connections/types.js";
import { redact } from "../redaction.js";

/**
 * The network boundary for skill imports. Public hosts only, whatever CONNECTIONS_ALLOW_PRIVATE says; a host in
 * SKILLS_GIT_HOSTS (exact names) may resolve to a private address (a VPN-only GitLab). Loopback, link-local and
 * metadata addresses stay refused for everyone. Errors carry the status and the provider's own short message only.
 */

export function skillsNetPolicy(settings: Settings): NetPolicy {
  const c = settings.connections;
  return {
    allowPrivate: false,
    allowLocal: c?.allowLocal,
    ownHosts: c?.ownHosts ?? [],
    lookup: c?.lookup,
    allowPrivateHosts: new Set((settings.skills?.gitHosts ?? []).map((h) => h.toLowerCase())),
    privateHint: "an Administrator can add it to SKILLS_GIT_HOSTS (CONNECTIONS_ALLOW_PRIVATE doesn't apply to skill imports), or upload the repository as a .zip or .tar.gz",
  };
}

export function skillsEnv(settings: Settings, timeoutMs = 60_000): DriverEnv {
  return { net: skillsNetPolicy(settings), timeoutMs, endpoints: settings.connections?.endpoints };
}

export const PUBLIC_GIT_HOSTS = new Set(["gitlab.com", "api.github.com", "github.com"]);

/**
 * An own-token source's API URL: https, and a host that is gitlab.com, api.github.com (github.com is mapped to it) or
 * listed in SKILLS_GIT_HOSTS. Anything else needs a git connection an Administrator set up. Returns the API base.
 */
export function checkSkillApiUrl(raw: string | null | undefined, provider: "gitlab" | "github", settings: Settings): string {
  const fallback = provider === "gitlab" ? "https://gitlab.com/api/v4" : "https://api.github.com";
  if (!raw?.trim()) return settings.connections?.endpoints?.[provider]?.replace(/\/+$/, "") ?? fallback;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ValidationError("api_url isn't a URL");
  }
  if (url.username || url.password || url.search || url.hash) throw new ValidationError("api_url must not carry credentials, a query string or a fragment");
  const host = url.hostname.toLowerCase();
  const local = !!settings.connections?.allowLocal && (host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]");
  if (url.protocol !== "https:" && !local) throw new ValidationError("api_url must be https://");
  const allowed = PUBLIC_GIT_HOSTS.has(host) || (settings.skills?.gitHosts ?? []).includes(host) || local;
  if (!allowed) {
    throw new ValidationError(`${host} isn't one of the git hosts skill sources may use with their own token (gitlab.com, api.github.com${settings.skills?.gitHosts?.length ? `, ${settings.skills.gitHosts.join(", ")}` : ""}); use a git connection an Administrator set up, or ask them to add the host to SKILLS_GIT_HOSTS`);
  }
  if (host === "github.com") return "https://api.github.com";
  let path = url.pathname.replace(/\/+$/, "");
  if (provider === "gitlab" && !path) path = "/api/v4";
  return `${url.protocol}//${url.host}${path}`;
}

/** "GitLab answered 404: 404 Project Not Found": the status and the provider's short message, never a raw body. */
export function gitError(res: Pick<PinnedResponse, "status" | "text" | "body" | "headers">, provider: "gitlab" | "github", secrets: string[] = []): string {
  const who = provider === "gitlab" ? "GitLab" : "GitHub";
  const body = res.text || (res.body ? res.body.subarray(0, 4096).toString("utf8") : "");
  let msg = "";
  const type = String(res.headers?.["content-type"] ?? "");
  if (!/html/i.test(type)) {
    try {
      const j = JSON.parse(body) as Record<string, unknown>;
      const pick = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && !Array.isArray(v) ? pick((v as Record<string, unknown>).message) : "");
      msg = pick(j.message) || pick(j.error_description) || pick(j.error);
    } catch {
      msg = "";
    }
  }
  msg = msg.replace(/[\r\n]+/g, " ").replace(/<[^>]*>/g, "").trim();
  for (const s of secrets) if (s) msg = msg.split(s).join("[hidden]");
  msg = redact(msg).text;
  if (msg.length > 200) msg = `${msg.slice(0, 200)}…`;
  return `${who} answered ${res.status}${msg ? `: ${msg}` : ""}`;
}

/** Fixed texts for network failures (never an address). */
export function networkError(err: unknown, host: string): string {
  const m = (err as Error)?.message ?? "";
  if (/private network/.test(m)) return `${host} is on a private network; an Administrator can add it to SKILLS_GIT_HOSTS`;
  if (/couldn't be found|ENOTFOUND|EAI_AGAIN/.test(m)) return `couldn't resolve ${host}`;
  if (/timed out|ETIMEDOUT/i.test(m) || (err as Error)?.name === "TimeoutError") return `${host} timed out`;
  if (/certificate|TLS|SSL|self[- ]signed/i.test(m)) return `TLS error talking to ${host}`;
  if (/loopback|link-local|metadata|isn't a host address|own database/.test(m)) return `${host} can't be reached from skill imports`;
  if (/larger than/.test(m)) return m;
  return `couldn't reach ${host}`;
}

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ValidationError } from "./context.js";
import { htmlToMarkdown } from "./importer.js";

/**
 * Fetchers for team sources. Each one turns a source's config (and the state it
 * left last time) into raw items plus new state. No model is involved: deciding
 * what's worth keeping is left to people and connected agents (the inbox).
 * Credentials live in the server's environment, never in the database.
 */

export const SOURCE_KINDS = ["rss", "web", "hackernews", "slack", "notion", "tavily", "github_prs", "sentry_issues", "confluence", "linear", "gdrive"] as const;
/** Kinds that receive webhooks at a secret URL instead of being fetched on a schedule. */
export const PUSH_KINDS: readonly SourceKind[] = ["github_prs", "sentry_issues"];
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface RawItem {
  external_id: string;
  title: string;
  url?: string | null;
  author?: string | null;
  body: string;
  published_at?: string | null;
}

export interface FetchResult {
  items: RawItem[];
  state: Record<string, unknown>;
}

export interface ConnectorEnv {
  slackToken?: string;
  notionToken?: string;
  tavilyKey?: string;
  confluence?: { url: string; email: string; token: string };
  linearKey?: string;
  /** A Google service account's JSON key. */
  googleServiceAccount?: string;
  /** Allow feeds and pages on private networks (intranet wikis). Off by default. */
  allowPrivate?: boolean;
  /** Injected in tests. */
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<{ address: string }[]>;
}

export const MAX_BODY = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
const UA = "Thaliyola/1.0 (+team knowledge base; source fetcher)";

/** What each kind needs, for validation and the UI. */
export const SOURCE_FIELDS: Record<SourceKind, { label: string; needs?: keyof ConnectorEnv; push?: boolean; fields: { key: string; label: string; required?: boolean; hint?: string }[] }> = {
  github_prs: {
    label: "GitHub merged pull requests (webhook)",
    push: true,
    fields: [
      { key: "branch", label: "Only pull requests merged into", hint: "optional, e.g. main" },
      { key: "repos", label: "Only these repositories", hint: "optional, comma-separated owner/name" },
    ],
  },
  sentry_issues: {
    label: "Sentry resolved issues (webhook)",
    push: true,
    fields: [
      { key: "projects", label: "Only these Sentry projects", hint: "optional, comma-separated project slugs" },
      { key: "incidents", label: "Open incidents from alerts", hint: "on: a Sentry alert (issue or metric alert rule) opens an incident here, or joins the open one" },
    ],
  },
  rss: { label: "RSS or Atom feed", fields: [{ key: "url", label: "Feed URL", required: true }] },
  web: {
    label: "Web page (changes)",
    fields: [
      { key: "url", label: "Page URL", required: true },
      { key: "selector", label: "CSS selector for the part to watch", hint: "optional, e.g. main or #changelog" },
    ],
  },
  hackernews: {
    label: "Hacker News search",
    fields: [
      { key: "query", label: "Search terms", required: true },
      { key: "min_points", label: "Minimum points", hint: "optional, e.g. 50" },
    ],
  },
  slack: {
    label: "Slack channel threads",
    needs: "slackToken",
    fields: [
      { key: "channel", label: "Channel ID", required: true, hint: "e.g. C0123ABCD; invite the bot to the channel" },
      { key: "min_replies", label: "Minimum replies", hint: "threads with at least this many replies (default 2)" },
      { key: "reaction", label: "Only threads marked with a reaction", hint: "optional, e.g. pushpin: anyone reacts :pushpin: to a thread worth keeping" },
    ],
  },
  confluence: {
    label: "Confluence space",
    needs: "confluence",
    fields: [
      { key: "space", label: "Space key", required: true, hint: "e.g. ENG; pages with view restrictions are never imported" },
      { key: "label", label: "Only pages with this label", hint: "optional" },
    ],
  },
  linear: {
    label: "Linear completed issues",
    needs: "linearKey",
    fields: [
      { key: "team", label: "Team key", required: true, hint: "e.g. ENG; private teams aren't imported" },
      { key: "label", label: "Only issues with this label", hint: "optional, e.g. postmortem or decision" },
    ],
  },
  gdrive: {
    label: "Google Drive folder (Docs)",
    needs: "googleServiceAccount",
    fields: [{ key: "folder_id", label: "Folder ID or link", required: true, hint: "share the folder with the service account's email; it sees nothing else" }],
  },
  notion: {
    label: "Notion pages",
    needs: "notionToken",
    fields: [{ key: "database_id", label: "Database ID", hint: "optional; otherwise every page shared with the integration" }],
  },
  tavily: {
    label: "Web search (Tavily)",
    needs: "tavilyKey",
    fields: [
      { key: "query", label: "Search query", required: true },
      { key: "topic", label: "Topic", hint: "general or news" },
    ],
  },
};

export function validateConfig(kind: SourceKind, config: Record<string, unknown>, env: ConnectorEnv): Record<string, string> {
  const spec = SOURCE_FIELDS[kind];
  if (!spec) throw new ValidationError(`unknown source kind ${kind}`);
  if (spec.needs && !env[spec.needs]) throw new ValidationError(`${spec.label} isn't configured on this server (${ENV_NAME[spec.needs]})`);
  const out: Record<string, string> = {};
  for (const f of spec.fields) {
    const v = config[f.key];
    const s = v === undefined || v === null ? "" : String(v).trim();
    if (f.required && !s) throw new ValidationError(`${f.label} is required`);
    if (s) out[f.key] = s.slice(0, 500);
  }
  if (out.url && !/^https?:\/\//i.test(out.url)) throw new ValidationError("URL must start with http:// or https://");
  if (out.min_points && !/^\d+$/.test(out.min_points)) throw new ValidationError("Minimum points must be a number");
  if (out.min_replies && !/^\d+$/.test(out.min_replies)) throw new ValidationError("Minimum replies must be a number");
  if (out.channel && !/^[CGD][A-Z0-9]{6,}$/.test(out.channel)) throw new ValidationError("Slack channel ID looks like C0123ABCD (channel details → bottom)");
  if (out.database_id) out.database_id = out.database_id.replace(/^.*?([0-9a-f]{32}|[0-9a-f-]{36}).*$/i, "$1");
  if (out.topic && !["general", "news"].includes(out.topic)) throw new ValidationError("Topic is general or news");
  if (out.reaction) out.reaction = out.reaction.replace(/^:|:$/g, "");
  if (out.reaction && !/^[a-z0-9_+-]{1,60}$/.test(out.reaction)) throw new ValidationError("Reaction is an emoji name, like pushpin");
  if (out.space && !/^~?[A-Za-z0-9_-]{1,255}$/.test(out.space)) throw new ValidationError("Space key looks like ENG");
  if (out.team && !/^[A-Za-z0-9]{1,10}$/.test(out.team)) throw new ValidationError("Team key looks like ENG");
  if (out.folder_id) out.folder_id = out.folder_id.replace(/^.*\/folders\/([A-Za-z0-9_-]+).*$/, "$1");
  if (out.folder_id && !/^[A-Za-z0-9_-]{10,100}$/.test(out.folder_id)) throw new ValidationError("Folder ID is the part after /folders/ in the folder's link");
  return out;
}

export const ENV_NAME: Record<string, string> = {
  slackToken: "SLACK_BOT_TOKEN",
  notionToken: "NOTION_TOKEN",
  tavilyKey: "TAVILY_API_KEY",
  confluence: "CONFLUENCE_URL, CONFLUENCE_EMAIL and CONFLUENCE_TOKEN",
  linearKey: "LINEAR_API_KEY",
  googleServiceAccount: "GOOGLE_SERVICE_ACCOUNT_JSON",
};

export function hashText(s: string) {
  return createHash("sha256").update(s).digest("hex");
}

const clip = (s: string, n = MAX_BODY) => (s.length > n ? `${s.slice(0, n)}\n\n…(truncated)` : s);

// ---- Safe fetching of user-supplied URLs --------------------------------------------------------

/** Loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff");
}

async function assertPublic(url: URL, env: ConnectorEnv) {
  if (!["http:", "https:"].includes(url.protocol)) throw new ValidationError("only http and https URLs can be fetched");
  if (url.username || url.password) throw new ValidationError("URLs with credentials aren't allowed");
  if (env.allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await (env.lookup ?? ((h: string) => lookup(h, { all: true })))(host);
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address)))
    throw new ValidationError(`${url.hostname} is on a private network; set SOURCES_ALLOW_PRIVATE=true to fetch internal pages`);
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new ValidationError("the page is larger than 3 MB");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

/** GET a user-supplied URL: public addresses only (checked on every redirect), time and size capped. */
export async function safeGet(raw: string, env: ConnectorEnv, headers: Record<string, string> = {}): Promise<{ status: number; text: string; headers: Headers; url: string }> {
  const f = env.fetch ?? fetch;
  let url = new URL(raw);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url, env);
    const res = await f(url, { redirect: "manual", headers: { "User-Agent": UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (res.status === 304) return { status: 304, text: "", headers: res.headers, url: url.toString() };
    if (!res.ok) throw new ValidationError(`${url.hostname} answered ${res.status}`);
    return { status: res.status, text: await readCapped(res), headers: res.headers, url: url.toString() };
  }
  throw new ValidationError("too many redirects");
}

async function getJson<T>(env: ConnectorEnv, url: string, init: RequestInit = {}): Promise<T> {
  const res = await (env.fetch ?? fetch)(url, { ...init, headers: { "User-Agent": UA, ...(init.headers as Record<string, string>) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new ValidationError(`${new URL(url).hostname} answered ${res.status}${res.status === 401 || res.status === 403 ? " (check the token and its access)" : ""}`);
  return (await res.json()) as T;
}

// ---- RSS / Atom ------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : (ENTITIES[e.toLowerCase()] ?? m),
  );
}
function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  if (!m) return undefined;
  const inner = m[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return cdata ? cdata[1]! : decodeEntities(inner);
}
function htmlText(html: string) {
  return /<[a-z][\s\S]*>/i.test(html) ? htmlToMarkdown(`<body>${html}</body>`).body_md : html.trim();
}

export function parseFeed(xml: string): { title: string; items: RawItem[] } {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = xml.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const first = xml.search(atom ? /<entry[\s>]/i : /<item[\s>]/i);
  const head = first > 0 ? xml.slice(0, first) : xml;
  const items = blocks.slice(0, 50).map((b): RawItem => {
    const title = htmlText(tag(b, "title") ?? "").replace(/\s+/g, " ").trim() || "(untitled)";
    const link = atom
      ? (/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i.exec(b) ?? /<link[^>]*href=["']([^"']+)["']/i.exec(b))?.[1]
      : (tag(b, "link") ?? /<link[^>]*href=["']([^"']+)["']/i.exec(b)?.[1]);
    const id = tag(b, atom ? "id" : "guid") ?? link ?? title;
    const body = tag(b, "content:encoded") ?? tag(b, "content") ?? tag(b, "description") ?? tag(b, "summary") ?? "";
    const date = tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date");
    const author = tag(b, "dc:creator") ?? tag(tag(b, "author") ?? "", "name") ?? tag(b, "author");
    const when = date ? new Date(date) : null;
    return {
      external_id: id.trim().slice(0, 500),
      title: title.slice(0, 300),
      url: link ? decodeEntities(link.trim()) : null,
      author: author?.replace(/<[^>]+>/g, "").trim().slice(0, 200) || null,
      body: clip(htmlText(body)),
      published_at: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
    };
  });
  return { title: htmlText(tag(head, "title") ?? "").trim(), items };
}

// ---- Connectors ---------------------------------------------------------------------------------------

type Fetcher = (config: Record<string, string>, state: Record<string, unknown>, env: ConnectorEnv) => Promise<FetchResult>;

const rss: Fetcher = async (config, state, env) => {
  const headers: Record<string, string> = { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5" };
  if (typeof state.etag === "string") headers["If-None-Match"] = state.etag;
  if (typeof state.modified === "string") headers["If-Modified-Since"] = state.modified;
  const res = await safeGet(config.url!, env, headers);
  if (res.status === 304) return { items: [], state };
  if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(res.text.slice(0, 4000))) throw new ValidationError("that URL isn't an RSS or Atom feed");
  return { items: parseFeed(res.text).items, state: { etag: res.headers.get("etag") ?? undefined, modified: res.headers.get("last-modified") ?? undefined } };
};

const web: Fetcher = async (config, state, env) => {
  const res = await safeGet(config.url!, env, { Accept: "text/html, text/plain;q=0.8" });
  let html = res.text;
  if (config.selector) {
    const { createRequire } = await import("node:module");
    const domino = createRequire(import.meta.url)("@mixmark-io/domino") as { createDocument(h: string, f?: boolean): { title: string; querySelector(s: string): { outerHTML: string } | null } };
    const doc = domino.createDocument(html, true);
    let part: { outerHTML: string } | null = null;
    try {
      part = doc.querySelector(config.selector);
    } catch {
      throw new ValidationError(`invalid CSS selector ${config.selector}`);
    }
    if (!part) throw new ValidationError(`nothing on the page matches ${config.selector}`);
    html = `<html><head><title>${doc.title}</title></head><body>${part.outerHTML}</body></html>`;
  }
  const page = /html/i.test(res.headers.get("content-type") ?? "html") ? htmlToMarkdown(html) : { title: "", body_md: html };
  const hash = hashText(page.body_md);
  if (state.hash === hash) return { items: [], state };
  const title = page.title || new URL(config.url!).hostname;
  return {
    items: [
      {
        external_id: `${config.url}#${hash.slice(0, 16)}`,
        title: (state.hash ? `Changed: ${title}` : title).slice(0, 300),
        url: res.url,
        body: clip(page.body_md),
        published_at: new Date().toISOString(),
      },
    ],
    state: { hash },
  };
};

const hackernews: Fetcher = async (config, state, env) => {
  const since = typeof state.since === "number" ? state.since : Math.floor(Date.now() / 1000) - 7 * 86400;
  const filters = [`created_at_i>${since}`, ...(config.min_points ? [`points>=${Number(config.min_points)}`] : [])];
  const q = new URLSearchParams({ query: config.query!, tags: "story", numericFilters: filters.join(","), hitsPerPage: "30" });
  const data = await getJson<{ hits: { objectID: string; title: string; url: string | null; author: string; story_text: string | null; points: number; num_comments: number; created_at_i: number }[] }>(
    env,
    `https://hn.algolia.com/api/v1/search_by_date?${q}`,
  );
  const newest = Math.max(since, ...data.hits.map((h) => h.created_at_i));
  return {
    items: data.hits.map((h) => ({
      external_id: h.objectID,
      title: h.title.slice(0, 300),
      url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
      author: h.author,
      body: clip(`${h.story_text ? `${htmlText(h.story_text)}\n\n` : ""}${h.points} points, ${h.num_comments} comments: https://news.ycombinator.com/item?id=${h.objectID}`),
      published_at: new Date(h.created_at_i * 1000).toISOString(),
    })),
    state: { since: newest },
  };
};

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  reply_count?: number;
  thread_ts?: string;
  subtype?: string;
  reactions?: { name: string; count: number }[];
}

const slack: Fetcher = async (config, _state, env) => {
  if (!env.slackToken) throw new ValidationError("SLACK_BOT_TOKEN isn't set on this server");
  const call = async <T>(method: string, params: Record<string, string>) => {
    const r = await getJson<T & { ok: boolean; error?: string }>(env, `https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${env.slackToken}` } });
    if (!r.ok) throw new ValidationError(`Slack ${method}: ${r.error}${r.error === "not_in_channel" ? " (invite the bot to the channel)" : ""}`);
    return r;
  };
  // Look back three days each run so threads that grow after they start are picked up again.
  const oldest = String(Math.floor(Date.now() / 1000) - 3 * 86400);
  const minReplies = Number(config.min_replies ?? 2);
  const hist = await call<{ messages: SlackMessage[] }>("conversations.history", { channel: config.channel!, oldest, limit: "200" });
  const users = new Map<string, string>();
  const name = async (id?: string) => {
    if (!id) return "someone";
    if (!users.has(id)) {
      try {
        const u = await call<{ user: { real_name?: string; name: string } }>("users.info", { user: id });
        users.set(id, u.user.real_name || u.user.name);
      } catch {
        users.set(id, id);
      }
    }
    return users.get(id)!;
  };
  const items: RawItem[] = [];
  const marked = (m: SlackMessage) => !config.reaction || (m.reactions ?? []).some((r) => r.name === config.reaction);
  for (const m of hist.messages.filter((x) => (x.reply_count ?? 0) >= minReplies && !x.subtype && marked(x)).slice(0, 25)) {
    const thread = await call<{ messages: SlackMessage[] }>("conversations.replies", { channel: config.channel!, ts: m.ts, limit: "100" });
    const lines: string[] = [];
    for (const r of thread.messages) lines.push(`**${await name(r.user)}:** ${(r.text ?? "").replace(/<@(U[A-Z0-9]+)>/g, "@$1")}`);
    let url: string | null = null;
    try {
      url = (await call<{ permalink: string }>("chat.getPermalink", { channel: config.channel!, message_ts: m.ts })).permalink;
    } catch {
      /* permalink is optional */
    }
    const first = (m.text ?? "").replace(/\s+/g, " ").trim();
    items.push({
      external_id: m.ts,
      title: (first.length > 120 ? `${first.slice(0, 117)}…` : first) || "Slack thread",
      url,
      author: await name(m.user),
      body: clip(lines.join("\n\n")),
      published_at: new Date(Number(m.ts) * 1000).toISOString(),
    });
  }
  return { items, state: {} };
};

interface NotionPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, { type: string; title?: { plain_text: string }[] }>;
}
interface NotionBlock {
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

const notion: Fetcher = async (config, state, env) => {
  if (!env.notionToken) throw new ValidationError("NOTION_TOKEN isn't set on this server");
  const headers = { Authorization: `Bearer ${env.notionToken}`, "Notion-Version": "2022-06-28", "Content-Type": "application/json" };
  const since = typeof state.since === "string" ? state.since : null;
  const body = config.database_id
    ? { sorts: [{ timestamp: "last_edited_time", direction: "descending" }], page_size: 25, ...(since ? { filter: { timestamp: "last_edited_time", last_edited_time: { after: since } } } : {}) }
    : { sort: { timestamp: "last_edited_time", direction: "descending" }, filter: { property: "object", value: "page" }, page_size: 25 };
  const url = config.database_id ? `https://api.notion.com/v1/databases/${config.database_id}/query` : "https://api.notion.com/v1/search";
  const res = await getJson<{ results: NotionPage[] }>(env, url, { method: "POST", headers, body: JSON.stringify(body) });
  const pages = res.results.filter((p) => !since || p.last_edited_time > since).slice(0, 15);
  const items: RawItem[] = [];
  for (const p of pages) {
    const title = Object.values(p.properties).find((x) => x.type === "title")?.title?.map((t) => t.plain_text).join("") || "Untitled";
    const blocks = await getJson<{ results: NotionBlock[] }>(env, `https://api.notion.com/v1/blocks/${p.id}/children?page_size=100`, { headers });
    items.push({ external_id: p.id, title: title.slice(0, 300), url: p.url, body: clip(notionText(blocks.results)), published_at: p.last_edited_time });
  }
  const newest = pages.reduce((m, p) => (p.last_edited_time > m ? p.last_edited_time : m), since ?? "");
  return { items, state: newest ? { since: newest } : state };
};

export function notionText(blocks: NotionBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const data = b[b.type] as { rich_text?: { plain_text: string }[]; language?: string; checked?: boolean } | undefined;
    const text = data?.rich_text?.map((t) => t.plain_text).join("") ?? "";
    switch (b.type) {
      case "heading_1": out.push(`# ${text}`); break;
      case "heading_2": out.push(`## ${text}`); break;
      case "heading_3": out.push(`### ${text}`); break;
      case "bulleted_list_item": out.push(`- ${text}`); break;
      case "numbered_list_item": out.push(`1. ${text}`); break;
      case "to_do": out.push(`- [${data?.checked ? "x" : " "}] ${text}`); break;
      case "quote": case "callout": out.push(`> ${text}`); break;
      case "code": out.push(`\`\`\`${data?.language ?? ""}\n${text}\n\`\`\``); break;
      case "divider": out.push("---"); break;
      default: if (text) out.push(text);
    }
  }
  return out.join("\n\n");
}

const tavily: Fetcher = async (config, state, env) => {
  if (!env.tavilyKey) throw new ValidationError("TAVILY_API_KEY isn't set on this server");
  const res = await getJson<{ results: { title: string; url: string; content: string; published_date?: string }[] }>(env, "https://api.tavily.com/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.tavilyKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: config.query, topic: config.topic ?? "general", max_results: 10, ...(config.topic === "news" ? { days: 7 } : {}) }),
  });
  return {
    items: res.results.map((r) => ({ external_id: r.url, title: r.title.slice(0, 300), url: r.url, body: clip(r.content ?? ""), published_at: r.published_date ? new Date(r.published_date).toISOString() : null })),
    state,
  };
};

// Push kinds have nothing to fetch: their items arrive as webhooks (sources.ts receiveWebhook).
const pushed: Fetcher = async (_c, state) => ({ items: [], state });
// ---- Confluence ---------------------------------------------------------------------------------------

interface ConfluencePage {
  id: string;
  title: string;
  body?: { storage?: { value: string } };
  version?: { when: string; by?: { displayName?: string } };
  history?: { createdBy?: { displayName?: string } };
  restrictions?: { read?: { restrictions?: { user?: { results?: unknown[] }; group?: { results?: unknown[] } } } };
  _links?: { webui?: string };
}

/** Pages of a Confluence space changed since last time. Pages with view restrictions are skipped: they aren't for everyone in the space. */
const confluence: Fetcher = async (config, state, env) => {
  const c = env.confluence;
  if (!c) throw new ValidationError("Confluence isn't configured on this server (CONFLUENCE_URL, CONFLUENCE_EMAIL, CONFLUENCE_TOKEN)");
  const base = c.url.replace(/\/+$/, "").replace(/\/wiki$/, "");
  const since = typeof state.since === "string" ? state.since : null;
  const cql = [`space = "${config.space}"`, "type = page", config.label ? `label = "${config.label.replace(/"/g, "")}"` : null, since ? `lastmodified > "${since.slice(0, 16).replace("T", " ")}"` : null]
    .filter(Boolean)
    .join(" AND ");
  const url = `${base}/wiki/rest/api/content/search?${new URLSearchParams({ cql: `${cql} ORDER BY lastmodified DESC`, limit: "25", expand: "body.storage,version,history,restrictions.read.restrictions.user,restrictions.read.restrictions.group" })}`;
  const data = await getJson<{ results: ConfluencePage[] }>(env, url, { headers: { Authorization: `Basic ${Buffer.from(`${c.email}:${c.token}`).toString("base64")}`, Accept: "application/json" } });
  const open = (p: ConfluencePage) => {
    const r = p.restrictions?.read?.restrictions;
    return !(r?.user?.results?.length || r?.group?.results?.length);
  };
  const items = data.results.filter(open).map((p) => ({
    external_id: p.id,
    title: p.title.slice(0, 300),
    url: p._links?.webui ? `${base}/wiki${p._links.webui}` : null,
    author: p.version?.by?.displayName ?? p.history?.createdBy?.displayName ?? null,
    body: clip(htmlToMarkdown(`<body>${p.body?.storage?.value ?? ""}</body>`).body_md),
    published_at: p.version?.when ?? null,
  }));
  const newest = data.results.map((p) => p.version?.when ?? "").filter(Boolean).sort().at(-1) ?? since;
  return { items, state: newest ? { since: newest } : {} };
};

// ---- Linear -------------------------------------------------------------------------------------------

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  completedAt: string;
  creator?: { name?: string } | null;
  labels?: { nodes: { name: string }[] };
  comments?: { nodes: { body: string; user?: { name?: string } | null }[] };
}

/** A Linear team's completed issues since last time, with their comments. Private teams are refused. */
const linear: Fetcher = async (config, state, env) => {
  if (!env.linearKey) throw new ValidationError("LINEAR_API_KEY isn't set on this server");
  const since = typeof state.since === "string" ? state.since : new Date(Date.now() - 30 * 86_400_000).toISOString();
  const query = `query($team: String!, $since: DateTimeOrDuration!) {
    teams(filter: { key: { eq: $team } }) { nodes { key private issues(first: 50, filter: { completedAt: { gt: $since } }, orderBy: updatedAt) {
      nodes { id identifier title description url completedAt creator { name } labels { nodes { name } } comments(first: 20) { nodes { body user { name } } } } } } }
  }`;
  const res = await getJson<{ data?: { teams: { nodes: { key: string; private: boolean; issues: { nodes: LinearIssue[] } }[] } }; errors?: { message: string }[] }>(env, "https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: env.linearKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { team: config.team, since } }),
  });
  if (res.errors?.length) throw new ValidationError(`Linear: ${res.errors[0]!.message}`);
  const team = res.data?.teams.nodes[0];
  if (!team) throw new ValidationError(`Linear has no team ${config.team} that this key can see`);
  if (team.private) throw new ValidationError(`Linear team ${team.key} is private; its issues aren't imported`);
  const want = config.label?.toLowerCase();
  const issues = team.issues.nodes.filter((i) => !want || (i.labels?.nodes ?? []).some((l) => l.name.toLowerCase() === want));
  const items = issues.map((i) => ({
    external_id: i.id,
    title: `${i.identifier}: ${i.title}`.slice(0, 300),
    url: i.url,
    author: i.creator?.name ?? null,
    body: clip([i.description ?? "", ...(i.comments?.nodes ?? []).map((c) => `**${c.user?.name ?? "Someone"}:** ${c.body}`)].filter(Boolean).join("\n\n")),
    published_at: i.completedAt,
  }));
  const newest = team.issues.nodes.map((i) => i.completedAt).sort().at(-1) ?? since;
  return { items, state: { since: newest } };
};

// ---- Google Drive --------------------------------------------------------------------------------------

/** An access token for a service account (JWT bearer grant), read-only Drive. */
async function googleToken(env: ConnectorEnv): Promise<string> {
  let key: { client_email: string; private_key: string; token_uri?: string };
  try {
    key = JSON.parse(env.googleServiceAccount!);
  } catch {
    throw new ValidationError("GOOGLE_SERVICE_ACCOUNT_JSON isn't a service account's JSON key");
  }
  const { SignJWT, importPKCS8 } = await import("jose");
  const tokenUri = key.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/drive.readonly" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(key.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(await importPKCS8(key.private_key, "RS256"));
  const r = await getJson<{ access_token: string }>(env, tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  return r.access_token;
}

/** Google Docs in a Drive folder shared with the service account, changed since last time, as Markdown. */
const gdrive: Fetcher = async (config, state, env) => {
  if (!env.googleServiceAccount) throw new ValidationError("GOOGLE_SERVICE_ACCOUNT_JSON isn't set on this server");
  const token = await googleToken(env);
  const auth = { Authorization: `Bearer ${token}` };
  const since = typeof state.since === "string" ? state.since : null;
  const q = [`'${config.folder_id}' in parents`, "mimeType = 'application/vnd.google-apps.document'", "trashed = false", since ? `modifiedTime > '${since}'` : null].filter(Boolean).join(" and ");
  const list = await getJson<{ files: { id: string; name: string; webViewLink?: string; modifiedTime: string; lastModifyingUser?: { displayName?: string } }[] }>(
    env,
    `https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, orderBy: "modifiedTime desc", pageSize: "25", fields: "files(id,name,webViewLink,modifiedTime,lastModifyingUser(displayName))", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`,
    { headers: auth },
  );
  const items: RawItem[] = [];
  for (const f of list.files) {
    const res = await (env.fetch ?? fetch)(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}/export?mimeType=text%2Fmarkdown`, { headers: { ...auth, "User-Agent": UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) continue;
    items.push({ external_id: f.id, title: f.name.slice(0, 300), url: f.webViewLink ?? `https://docs.google.com/document/d/${f.id}`, author: f.lastModifyingUser?.displayName ?? null, body: clip(await res.text()), published_at: f.modifiedTime });
  }
  const newest = list.files.map((f) => f.modifiedTime).sort().at(-1) ?? since;
  return { items, state: newest ? { since: newest } : {} };
};

const FETCHERS: Record<SourceKind, Fetcher> = { rss, web, hackernews, slack, notion, tavily, github_prs: pushed, sentry_issues: pushed, confluence, linear, gdrive };

export async function fetchSource(kind: SourceKind, config: Record<string, string>, state: Record<string, unknown>, env: ConnectorEnv): Promise<FetchResult> {
  const r = await FETCHERS[kind](config, state, env);
  // Drop undefined keys so state round-trips through jsonb cleanly.
  return { items: r.items, state: JSON.parse(JSON.stringify(r.state ?? {})) };
}

import { ValidationError } from "../context.js";
import type { PinnedResponse } from "./network.js";
import { base, call, failWith, reasonOf, RemoteError, retryAfterMs } from "./remote.js";
import type { ConnTarget, DriverEnv, TestResult } from "./types.js";

/**
 * Issue trackers: Jira Cloud (site URL, email and API token, a default project and issue type), Linear (an API key
 * and a team) and ClickUp (an API token and a list). Thaliyola opens issues from findings and articles, and reads linked issues' status. Nothing else: no
 * comments, transitions or deletes. Credentials only ever go to the tracker the connection was set up for (Jira: its
 * Atlassian site; Linear: api.linear.app), and redirects aren't followed.
 */

export type Tracker = "jira" | "linear" | "clickup";
export const TRACKERS: readonly Tracker[] = ["jira", "linear", "clickup"];
export const isTracker = (kind: string): kind is Tracker => (TRACKERS as readonly string[]).includes(kind);

/** Where an issue stands, in one vocabulary for both trackers. */
export type TicketCategory = "todo" | "in_progress" | "done" | "canceled" | "unknown";

export interface TicketInfo {
  key: string;
  /** The issue's page, as people open it. */
  url: string;
  title: string;
  status: string;
  category: TicketCategory;
}

export interface NewTicket {
  title: string;
  /** Plain text; paragraphs separated by blank lines. */
  description: string;
  /** Back to the item in Thaliyola (added after the description, as a link). */
  link: string;
  linkLabel: string;
}

/** An issue URL as Thaliyola stores it, and what it names. */
export interface ParsedTicketUrl {
  tracker: Tracker;
  key: string;
  /** Canonical: https://<site>/browse/KEY-1, or https://linear.app/<workspace>/issue/KEY-1. */
  url: string;
  host: string;
  /** Linear: the workspace's URL key. ClickUp: the Workspace (team) ID of a custom task ID. */
  workspace?: string;
}

/** ClickUp task IDs (86a1b2c3d) as they appear in https://app.clickup.com/t/<id>. */
export const CLICKUP_TASK = /^[a-z0-9]{5,20}$/;

/** Jira issue keys (PROJ-123) and Linear identifiers (ENG-42). */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]{0,19}-[1-9]\d{0,9}$/;
export const JIRA_SITE = /^https:\/\/[a-z0-9][a-z0-9-]{0,62}\.(atlassian\.net|jira\.com)\/?$/i;

/** Jira or Linear issue URL → tracker, key and canonical URL. Null for anything else (boards, filters, other sites). */
export function parseTicketUrl(raw: string): ParsedTicketUrl | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  if (/^[a-z0-9][a-z0-9-]{0,62}\.(atlassian\.net|jira\.com)$/.test(host)) {
    const m = /^\/browse\/([^/]+)\/?$/.exec(u.pathname);
    const key = (m?.[1] ?? u.searchParams.get("selectedIssue") ?? "").toUpperCase();
    if (!ISSUE_KEY.test(key)) return null;
    return { tracker: "jira", key, url: `https://${host}/browse/${key}`, host };
  }
  if (host === "linear.app") {
    const m = /^\/([a-z0-9][a-z0-9-]{0,63})\/issue\/([A-Za-z0-9_]+-\d+)(?:\/[^/]*)?\/?$/i.exec(u.pathname);
    if (!m) return null;
    const key = m[2]!.toUpperCase();
    if (!ISSUE_KEY.test(key)) return null;
    const workspace = m[1]!.toLowerCase();
    return { tracker: "linear", key, url: `https://linear.app/${workspace}/issue/${key}`, host, workspace };
  }
  if (host === "app.clickup.com") {
    // /t/<task id>, or /t/<workspace id>/<custom task id> when the Workspace uses custom task IDs.
    const custom = /^\/t\/(\d{1,20})\/([A-Za-z0-9_]+-\d+)\/?$/.exec(u.pathname);
    if (custom) {
      const key = custom[2]!.toUpperCase();
      if (!ISSUE_KEY.test(key)) return null;
      return { tracker: "clickup", key, url: `https://app.clickup.com/t/${custom[1]}/${key}`, host, workspace: custom[1] };
    }
    const m = /^\/t\/([A-Za-z0-9]+)\/?$/.exec(u.pathname);
    const key = m?.[1]?.toLowerCase() ?? "";
    if (!CLICKUP_TASK.test(key)) return null;
    return { tracker: "clickup", key, url: `https://app.clickup.com/t/${key}`, host };
  }
  return null;
}

/** Whether a connection is for this issue's tracker and site: Jira on its own site; Linear any (its key decides). */
export function reachesSite(c: Pick<ConnTarget, "kind" | "config">, t: Pick<ParsedTicketUrl, "tracker" | "host"> & { workspace?: string }): boolean {
  if (c.kind !== t.tracker) return false;
  if (t.tracker === "jira") return jiraHost(c) === t.host;
  // ClickUp: a custom task ID names its Workspace; it must be the connection's.
  if (t.tracker === "clickup" && t.workspace && c.config.team_id) return t.workspace === c.config.team_id;
  return true;
}

/**
 * The issue keys a connection reads (their prefix: OPS in OPS-12): its own project (Jira) or team (Linear), and those
 * a Project admin allowed on it (allowed_projects / allowed_teams; "*" for any the account can see).
 */
export function readKeys(c: Pick<ConnTarget, "kind" | "config" | "options">): string[] {
  // ClickUp: list IDs (a task's ID doesn't say which list it's in; reading it checks).
  if (c.kind === "clickup") return [...new Set([c.config.list_id, ...(c.options?.allowed_lists ?? [])].filter((k): k is string => !!k))];
  const own = c.kind === "jira" ? c.config.project_key : c.config.team;
  const extra = (c.kind === "jira" ? c.options?.allowed_projects : c.options?.allowed_teams) ?? [];
  return [...new Set([own, ...extra].filter((k): k is string => !!k).map((k) => k.toUpperCase()))];
}

/** Whether a connection may read an issue at this URL: its tracker and site, and a key in a project it reads. */
export function servesTicket(c: Pick<ConnTarget, "kind" | "config" | "options">, t: Pick<ParsedTicketUrl, "tracker" | "host" | "key"> & { workspace?: string }): boolean {
  if (!reachesSite(c, t)) return false;
  // ClickUp: which list a task is in is only known by reading it; fetchClickup refuses tasks outside the lists.
  if (t.tracker === "clickup") return true;
  const keys = readKeys(c);
  const prefix = t.key.slice(0, t.key.lastIndexOf("-")).toUpperCase();
  return keys.includes("*") || keys.includes(prefix);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ---- Jira Cloud --------------------------------------------------------------------------------------------------

export function jiraHost(c: Pick<ConnTarget, "config">): string {
  try {
    return new URL(c.config.site_url ?? "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** The site's REST root: the configured site (tests: the mock standing in for it). */
function jiraRoot(c: ConnTarget, env: DriverEnv): string {
  return (env.endpoints?.jira ?? c.config.site_url ?? "").replace(/\/+$/, "");
}

function jiraHeaders(c: ConnTarget): Record<string, string> {
  const basic = Buffer.from(`${c.config.email ?? ""}:${c.secret.api_token ?? ""}`).toString("base64");
  return { authorization: `Basic ${basic}`, accept: "application/json" };
}

/** Jira's errors: {errorMessages: [...], errors: {field: message}}. */
function jiraReason(res: PinnedResponse): string {
  try {
    const b = JSON.parse(res.text) as { errorMessages?: string[]; errors?: Record<string, string> };
    const parts = [...(b.errorMessages ?? []), ...Object.entries(b.errors ?? {}).map(([k, v]) => `${k}: ${v}`)].filter((x) => typeof x === "string" && x.trim());
    if (parts.length) return clip(parts.join("; ").replace(/\s+/g, " "), 300);
  } catch {
    // not JSON
  }
  return reasonOf(res);
}

async function jira(c: ConnTarget, env: DriverEnv, path: string, init: { method?: string; body?: unknown } = {}): Promise<PinnedResponse> {
  return call(`${jiraRoot(c, env)}${path}`, "http", env, {
    method: init.method ?? "GET",
    headers: { ...jiraHeaders(c), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    followRedirects: false,
  });
}

function jiraFail(res: PinnedResponse, what: string): never {
  if (res.status === 401) throw new RemoteError("Jira didn't accept the email and API token (HTTP 401). Check both, and that the token hasn't expired.", 401);
  const reason = jiraReason(res);
  if (res.status === 400 || res.status === 403 || res.status === 404) throw new RemoteError(`Jira ${what} (HTTP ${res.status})${reason ? `: ${reason}` : ""}`, res.status);
  failWith(res, "Jira");
}

const parseJson = <T>(res: PinnedResponse, what: string): T => {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new ValidationError(`${what} didn't answer with JSON (HTTP ${res.status})`);
  }
};

function jiraCategory(key: string | undefined): TicketCategory {
  if (key === "new") return "todo";
  if (key === "indeterminate") return "in_progress";
  if (key === "done") return "done";
  return "unknown";
}

interface JiraIssue {
  key: string;
  fields?: { summary?: string; status?: { name?: string; statusCategory?: { key?: string } } };
}

function jiraInfo(c: ConnTarget, i: JiraIssue): TicketInfo {
  return {
    key: i.key,
    url: `https://${jiraHost(c)}/browse/${i.key}`,
    title: i.fields?.summary ?? "",
    status: i.fields?.status?.name ?? "",
    category: jiraCategory(i.fields?.status?.statusCategory?.key),
  };
}

export async function testJira(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const me = await jira(c, env, "/rest/api/3/myself");
  if (me.status !== 200) jiraFail(me, "didn't let the account in");
  const who = parseJson<{ displayName?: string }>(me, "Jira").displayName ?? c.config.email;
  const key = c.config.project_key!;
  const p = await jira(c, env, `/rest/api/3/project/${encodeURIComponent(key)}`);
  if (p.status === 404) throw new ValidationError(`Jira has no project ${key} that ${who} can see (check the project key, and the account's access to it)`);
  if (p.status !== 200) jiraFail(p, `couldn't read project ${key}`);
  const project = parseJson<{ name?: string; issueTypes?: { name: string; subtask?: boolean }[] }>(p, "Jira");
  const types = (project.issueTypes ?? []).filter((t) => !t.subtask).map((t) => t.name);
  const type = c.config.issue_type || "Task";
  const has = !types.length || types.some((t) => t.toLowerCase() === type.toLowerCase());
  return {
    detail: `Connected to Jira as ${who}. New issues go to ${key}${project.name ? ` (${project.name})` : ""} as ${type}.`,
    warning: has ? undefined : `Project ${key} has no issue type "${type}"; it has ${types.slice(0, 8).join(", ")}. Creating tickets will fail until the issue type matches.`,
  };
}

interface AdfNode {
  type: string;
  text?: string;
  marks?: { type: string; attrs?: Record<string, string> }[];
  content?: AdfNode[];
}

/** Atlassian Document Format: paragraphs (lines kept with hard breaks), then a paragraph with the link back. */
export function jiraDescription(t: NewTicket): { type: "doc"; version: 1; content: AdfNode[] } {
  const paragraphs: AdfNode[] = t.description
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({
      type: "paragraph",
      content: p.split("\n").flatMap((line, i): AdfNode[] => [...(i ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
    }));
  paragraphs.push({ type: "paragraph", content: [{ type: "text", text: "From Thaliyola: " }, { type: "text", text: t.linkLabel, marks: [{ type: "link", attrs: { href: t.link } }] }] });
  return { type: "doc", version: 1, content: paragraphs };
}

export async function createJira(c: ConnTarget, env: DriverEnv, t: NewTicket): Promise<TicketInfo> {
  const res = await jira(c, env, "/rest/api/3/issue", {
    method: "POST",
    body: {
      fields: {
        project: { key: c.config.project_key },
        issuetype: { name: c.config.issue_type || "Task" },
        summary: t.title,
        description: jiraDescription(t),
      },
    },
  });
  if (res.status !== 201 && res.status !== 200) jiraFail(res, "didn't create the issue");
  const made = parseJson<{ key?: string }>(res, "Jira");
  if (!made.key || !ISSUE_KEY.test(made.key)) throw new ValidationError("Jira created the issue but didn't say its key");
  // Its status, as the project's workflow starts it (best effort: the issue exists either way).
  try {
    return await getJira(c, env, made.key);
  } catch {
    // fall through
  }
  return { key: made.key, url: `https://${jiraHost(c)}/browse/${made.key}`, title: t.title, status: "", category: "unknown" };
}

/** One issue (GET /issue/KEY): right after creating it, when search may not know it yet; or the only one asked for. */
async function getJira(c: ConnTarget, env: DriverEnv, key: string): Promise<TicketInfo> {
  const res = await jira(c, env, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`);
  if (res.status === 404) throw new ValidationError(`Jira has no issue ${key} that the connection's account can see`);
  if (res.status !== 200) jiraFail(res, `couldn't read ${key}`);
  return jiraInfo(c, parseJson<JiraIssue>(res, "Jira"));
}

/** Keys Jira's JQL errors name as missing ("An issue with key 'OPS-9' does not exist for field 'key'."). */
function missingKeys(res: PinnedResponse, asked: Set<string>): string[] {
  try {
    const b = JSON.parse(res.text) as { errorMessages?: string[] };
    return [...new Set((b.errorMessages ?? []).flatMap((m) => [...String(m).matchAll(/'([A-Z][A-Z0-9_]*-\d+)'/g)].map((x) => x[1]!)).filter((k) => asked.has(k)))];
  } catch {
    return [];
  }
}

/**
 * Each issue's summary and status: one search request for all of them (POST /search/jql, key in (...)); a failure is
 * that issue's, not the batch's. Jira refuses a search naming an issue that doesn't exist, so those are left out and
 * the search asked once more; when Jira doesn't say which, they're read one at a time until `deadline` (then null:
 * not checked this time). Credentials that don't work (401) and rate limits (429) end the batch: they're thrown.
 */
export async function fetchJira(c: ConnTarget, env: DriverEnv, keys: string[], deadline?: number): Promise<(TicketInfo | Error | null)[]> {
  if (!keys.length) return [];
  const found = new Map<string, TicketInfo | Error | null>();
  if (keys.length === 1) {
    try {
      found.set(keys[0]!, await getJira(c, env, keys[0]!));
    } catch (err) {
      if (err instanceof RemoteError && (err.status === 401 || err.status === 429)) throw err;
      found.set(keys[0]!, err instanceof Error ? err : new Error(String(err)));
    }
    return keys.map((k) => found.get(k) ?? null);
  }
  let ask = [...new Set(keys)];
  for (let attempt = 0; attempt < 2 && ask.length; attempt++) {
    // Keys are checked (ISSUE_KEY) before they're stored, so they're safe in JQL as they are.
    const res = await jira(c, env, "/rest/api/3/search/jql", { method: "POST", body: { jql: `key in (${ask.join(", ")})`, fields: ["summary", "status"], maxResults: ask.length } });
    if (res.status === 200) {
      const body = parseJson<{ issues?: JiraIssue[] }>(res, "Jira");
      for (const i of body.issues ?? []) if (ask.includes(i.key)) found.set(i.key, jiraInfo(c, i));
      for (const k of ask) if (!found.has(k)) found.set(k, new ValidationError(`Jira has no issue ${k} that the connection's account can see`));
      ask = [];
      break;
    }
    if (res.status !== 400) jiraFail(res, "couldn't search for the issues");
    const missing = missingKeys(res, new Set(ask));
    if (!missing.length) break;
    for (const k of missing) found.set(k, new ValidationError(`Jira has no issue ${k} that the connection's account can see`));
    ask = ask.filter((k) => !missing.includes(k));
  }
  // Jira didn't say which keys it refused: one at a time, while there's time.
  for (const key of ask) {
    if (deadline && Date.now() >= deadline) break;
    try {
      found.set(key, await getJira(c, env, key));
    } catch (err) {
      if (err instanceof RemoteError && (err.status === 401 || err.status === 429)) throw err;
      found.set(key, err instanceof Error ? err : new Error(String(err)));
    }
  }
  return keys.map((k) => found.get(k) ?? null);
}

// ---- Linear ------------------------------------------------------------------------------------------------------

interface GqlError {
  message?: string;
  path?: (string | number)[];
  extensions?: { userPresentableMessage?: string; code?: string };
}

async function linear<T>(c: ConnTarget, env: DriverEnv, query: string, variables: Record<string, unknown>): Promise<{ data: T | null; errors: GqlError[] }> {
  const key = c.secret.api_key ?? "";
  const res = await call(`${base(env, "linear", "https://api.linear.app")}/graphql`, "http", env, {
    method: "POST",
    // Personal API keys go as they are; OAuth tokens as Bearer.
    headers: { authorization: key.startsWith("lin_oauth_") ? `Bearer ${key}` : key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    followRedirects: false,
  });
  let body: { data?: T; errors?: GqlError[] } = {};
  try {
    body = JSON.parse(res.text) as typeof body;
  } catch {
    if (res.status >= 200 && res.status < 300) throw new ValidationError(`Linear didn't answer with JSON (HTTP ${res.status})`);
  }
  const errors = body.errors ?? [];
  const auth = errors.some((e) => /authenticat|api key/i.test(e.message ?? "") || e.extensions?.code === "AUTHENTICATION_ERROR");
  if (res.status === 401 || auth) throw new RemoteError("Linear didn't accept the API key. Check it, and that it hasn't been revoked.", 401);
  // Linear says it's rate limited with HTTP 400 (or 429) and the code RATELIMITED.
  if (res.status === 429 || errors.some((e) => e.extensions?.code === "RATELIMITED")) {
    throw new RemoteError("Linear is rate limiting the API key; Thaliyola tries again later.", 429, retryAfterMs(res));
  }
  if (res.status < 200 || (res.status >= 300 && !body.data)) {
    if (errors.length) throw new RemoteError(`Linear said: ${clip(errors.map(gqlMessage).join("; "), 300)}`, res.status);
    failWith(res, "Linear");
  }
  return { data: body.data ?? null, errors };
}

const gqlMessage = (e: GqlError) => (e.extensions?.userPresentableMessage || e.message || "an error").replace(/\s+/g, " ").trim();

function linearCategory(type: string | undefined): TicketCategory {
  if (type === "backlog" || type === "unstarted" || type === "triage") return "todo";
  if (type === "started") return "in_progress";
  if (type === "completed") return "done";
  if (type === "canceled") return "canceled";
  return "unknown";
}

interface LinearIssue {
  identifier: string;
  url: string;
  title: string;
  state?: { name?: string; type?: string } | null;
}
const ISSUE_FIELDS = "identifier url title state { name type }";

function linearInfo(i: LinearIssue): TicketInfo {
  // Stored canonical (no title slug), so the same issue always has the same link.
  const parsed = parseTicketUrl(i.url);
  return { key: i.identifier, url: parsed?.url ?? i.url, title: i.title ?? "", status: i.state?.name ?? "", category: linearCategory(i.state?.type) };
}

async function linearTeam(c: ConnTarget, env: DriverEnv) {
  const key = c.config.team!;
  const { data, errors } = await linear<{ viewer?: { name?: string }; organization?: { name?: string; urlKey?: string }; teams?: { nodes: { id: string; key: string; name: string }[] } }>(
    c,
    env,
    "query Team($key: String!) { viewer { name } organization { name urlKey } teams(filter: { key: { eq: $key } }) { nodes { id key name } } }",
    { key },
  );
  if (!data) throw new ValidationError(`Linear said: ${clip(errors.map(gqlMessage).join("; ") || "nothing", 300)}`);
  const team = data.teams?.nodes.find((t) => t.key.toUpperCase() === key.toUpperCase());
  if (!team) throw new ValidationError(`Linear has no team with the key ${key} that this API key can see (the key is the prefix of its issues, as in ${key}-123)`);
  return { team, viewer: data.viewer?.name ?? "", organization: data.organization };
}

export async function testLinear(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const { team, viewer, organization } = await linearTeam(c, env);
  return { detail: `Connected to Linear${organization?.name ? ` (${organization.name})` : ""}${viewer ? ` as ${viewer}` : ""}. New issues go to the ${team.name} team (${team.key}).` };
}

export function linearDescription(t: NewTicket): string {
  // Markdown: our text as it is, then the link back. Square brackets in the label can't end the link early.
  const label = t.linkLabel.replace(/[[\]]/g, "");
  return `${t.description.trim()}${t.description.trim() ? "\n\n" : ""}From Thaliyola: [${label}](${t.link})`;
}

export async function createLinear(c: ConnTarget, env: DriverEnv, t: NewTicket): Promise<TicketInfo> {
  const { team } = await linearTeam(c, env);
  const { data, errors } = await linear<{ issueCreate?: { success: boolean; issue?: LinearIssue | null } }>(
    c,
    env,
    `mutation Create($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
    { input: { teamId: team.id, title: t.title, description: linearDescription(t) } },
  );
  const issue = data?.issueCreate?.issue;
  if (!data?.issueCreate?.success || !issue) throw new ValidationError(`Linear didn't create the issue${errors.length ? `: ${clip(errors.map(gqlMessage).join("; "), 300)}` : ""}`);
  return linearInfo(issue);
}

/** Every issue in one request (an alias each); a missing one is that issue's failure, not the batch's. */
export async function fetchLinear(c: ConnTarget, env: DriverEnv, keys: string[]): Promise<(TicketInfo | Error | null)[]> {
  if (!keys.length) return [];
  const vars = Object.fromEntries(keys.map((k, i) => [`k${i}`, k]));
  const query = `query Issues(${keys.map((_, i) => `$k${i}: String!`).join(", ")}) { ${keys.map((_, i) => `i${i}: issue(id: $k${i}) { ${ISSUE_FIELDS} }`).join(" ")} }`;
  const { data, errors } = await linear<Record<string, LinearIssue | null>>(c, env, query, vars);
  return keys.map((k, i) => {
    const issue = data?.[`i${i}`];
    if (issue) return linearInfo(issue);
    const why = errors.find((e) => e.path?.[0] === `i${i}`);
    return new ValidationError(why && !/not found|entity not found/i.test(gqlMessage(why)) ? `Linear said: ${clip(gqlMessage(why), 200)}` : `Linear has no issue ${k} that the API key can see`);
  });
}

// ---- ClickUp ---------------------------------------------------------------------------------------------------

interface ClickUpTask {
  id: string;
  custom_id?: string | null;
  name: string;
  url: string;
  status?: { status?: string; type?: string } | null;
  list?: { id?: string; name?: string } | null;
  team_id?: string | null;
}

async function clickup(c: ConnTarget, env: DriverEnv, path: string, init: { method?: string; body?: unknown } = {}): Promise<PinnedResponse> {
  const res = await call(`${base(env, "clickup", "https://api.clickup.com/api/v2")}${path}`, "http", env, {
    method: init.method ?? "GET",
    headers: { authorization: c.secret.api_token ?? "", accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    followRedirects: false,
  });
  if (res.status === 401) throw new RemoteError("ClickUp didn't accept the API token. Check it, and that it hasn't been regenerated.", 401);
  if (res.status === 429) throw new RemoteError("ClickUp is rate limiting the token; Thaliyola tries again later.", 429, retryAfterMs(res));
  return res;
}

function clickupJson<T>(res: PinnedResponse, what: string): T {
  if (res.status < 200 || res.status >= 300) {
    let err = "";
    try {
      err = (JSON.parse(res.text) as { err?: string }).err ?? "";
    } catch {
      /* not JSON */
    }
    if (err) throw new RemoteError(`ClickUp said: ${clip(err, 200)}`, res.status);
    failWith(res, what);
  }
  return JSON.parse(res.text) as T;
}

function clickupCategory(s: ClickUpTask["status"]): TicketCategory {
  const name = (s?.status ?? "").toLowerCase();
  if (/cancel|won.?t do|wontfix|rejected/.test(name)) return "canceled";
  if (s?.type === "open") return "todo";
  if (s?.type === "custom") return "in_progress";
  if (s?.type === "done" || s?.type === "closed") return "done";
  return "unknown";
}

function clickupInfo(t: ClickUpTask, teamId?: string): TicketInfo {
  const custom = t.custom_id && (teamId ?? t.team_id) ? `https://app.clickup.com/t/${teamId ?? t.team_id}/${t.custom_id}` : null;
  return { key: t.custom_id || t.id, url: custom ?? `https://app.clickup.com/t/${t.id}`, title: t.name ?? "", status: t.status?.status ?? "", category: clickupCategory(t.status) };
}

export async function testClickup(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const user = clickupJson<{ user?: { username?: string } }>(await clickup(c, env, "/user"), "ClickUp");
  const list = clickupJson<{ name?: string; space?: { name?: string } }>(await clickup(c, env, `/list/${encodeURIComponent(c.config.list_id!)}`), "ClickUp");
  return { detail: `Connected to ClickUp${user.user?.username ? ` as ${user.user.username}` : ""}. New tasks go to ${list.name ?? "the list"}${list.space?.name ? ` (${list.space.name})` : ""}.` };
}

export function clickupDescription(t: NewTicket): string {
  const label = t.linkLabel.replace(/[[\]]/g, "");
  return `${t.description.trim()}${t.description.trim() ? "\n\n" : ""}From Thaliyola: [${label}](${t.link})`;
}

export async function createClickup(c: ConnTarget, env: DriverEnv, t: NewTicket): Promise<TicketInfo> {
  const task = clickupJson<ClickUpTask>(
    await clickup(c, env, `/list/${encodeURIComponent(c.config.list_id!)}/task`, { method: "POST", body: { name: t.title, markdown_description: clickupDescription(t) } }),
    "ClickUp",
  );
  return clickupInfo(task, c.config.team_id);
}

/** Each task by its ID (or custom ID, with the Workspace ID); one outside the lists the connection reads is refused. */
export async function fetchClickup(c: ConnTarget, env: DriverEnv, keys: string[], deadline?: number): Promise<(TicketInfo | Error | null)[]> {
  const lists = readKeys(c);
  const out: (TicketInfo | Error | null)[] = [];
  for (const key of keys) {
    if (deadline && Date.now() > deadline) {
      out.push(null);
      continue;
    }
    try {
      const custom = ISSUE_KEY.test(key);
      if (custom && !c.config.team_id) throw new ValidationError(`${key} is a custom task ID; set the Workspace ID on the connection to read it`);
      const res = await clickup(c, env, `/task/${encodeURIComponent(key)}${custom ? `?${new URLSearchParams({ custom_task_ids: "true", team_id: c.config.team_id! })}` : ""}`);
      if (res.status === 404 || res.status === 401) throw new ValidationError(`ClickUp has no task ${key} that the token can see`);
      const task = clickupJson<ClickUpTask>(res, "ClickUp");
      if (!lists.includes("*") && !lists.includes(task.list?.id ?? "")) throw new ValidationError(`Not in a list this connection reads: it reads list ${lists.join(", ")} only (a Project admin can allow more).`);
      out.push(clickupInfo(task, c.config.team_id));
    } catch (err) {
      if (err instanceof RemoteError && (err.status === 429 || err.status === 401)) throw err;
      out.push(err as Error);
    }
  }
  return out;
}

// ---- One interface for all ---------------------------------------------------------------------------------------

export const TRACKER_DRIVERS: Record<Tracker, { label: string; create: typeof createJira; fetch: typeof fetchJira }> = {
  jira: { label: "Jira", create: createJira, fetch: fetchJira },
  linear: { label: "Linear", create: createLinear, fetch: fetchLinear },
  clickup: { label: "ClickUp", create: createClickup, fetch: fetchClickup },
};

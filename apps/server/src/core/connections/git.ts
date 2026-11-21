import { NotFoundError, ValidationError } from "../context.js";
import { redact } from "../redaction.js";
import type { PinnedResponse } from "./network.js";
import { base, call, callJson, failWith } from "./remote.js";
import type { ConnTarget, DriverEnv, TestResult } from "./types.js";

/** A project's own GitHub or GitLab token (and API URL for self-hosted servers), for its repositories. */

export function gitApi(c: ConnTarget, env: DriverEnv): string {
  return c.config.provider === "gitlab" ? base(env, "gitlab", "https://gitlab.com/api/v4", c.config.api_url) : base(env, "github", "https://api.github.com", c.config.api_url);
}

export function gitHeaders(c: ConnTarget): Record<string, string> {
  return c.config.provider === "gitlab"
    ? { "private-token": c.secret.token ?? "", accept: "application/json" }
    : { authorization: `Bearer ${c.secret.token ?? ""}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
}

export async function testGit(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  const api = gitApi(c, env);
  if (c.config.provider === "gitlab") {
    const me = await callJson<{ username: string }>(`${api}/user`, "http", env, "GitLab", { headers: gitHeaders(c) });
    return { detail: `Connected to GitLab as ${me.username}.` };
  }
  const res = await call(`${api}/user`, "http", env, { headers: gitHeaders(c) });
  if (res.status === 200) return { detail: `Connected to GitHub as ${(JSON.parse(res.text) as { login: string }).login}.` };
  // Some fine-grained and app tokens can't read /user; the rate-limit endpoint still tells a valid token from a bad one.
  if (res.status === 403) {
    await callJson(`${api}/rate_limit`, "http", env, "GitHub", { headers: gitHeaders(c) });
    return { detail: "Connected to GitHub (the token works but can't read its own user)." };
  }
  failWith(res, "GitHub");
}

// ---- Which repositories a git connection serves ------------------------------------------------------------------

/** The host whose repositories the connection's token is for: github.com, gitlab.com, or the API URL's host. */
export function gitHost(c: Pick<ConnTarget, "config">): string {
  if (c.config.api_url) return new URL(c.config.api_url).hostname.toLowerCase();
  return c.config.provider === "gitlab" ? "gitlab.com" : "github.com";
}

/**
 * Whether the connection's token may be sent for a repository on `host`: only the host it was set up for (GitHub
 * Enterprise Cloud's api.<host> counts as <host>). A token never goes to another host.
 */
export function servesHost(c: Pick<ConnTarget, "config">, host: string): boolean {
  const mine = gitHost(c);
  const h = host.toLowerCase();
  return mine === h || mine === `api.${h}`;
}

/** A repository path as the provider names it: owner/repo on GitHub, group/…/project on GitLab. */
export function repoPathOf(c: Pick<ConnTarget, "config">, path: string): string {
  const p = path.replace(/\.git$/i, "").replace(/^\/+|\/+$/g, "");
  const ok = c.config.provider === "gitlab" ? /^[\w.-]+(\/[\w.-]+){1,9}$/.test(p) : /^[\w.-]+\/[\w.-]+$/.test(p);
  if (!ok || p.split("/").some((s) => s === "." || s === "..")) throw new ValidationError(`${path.slice(0, 200)} isn't a ${c.config.provider === "gitlab" ? "GitLab project path" : "GitHub owner/repository"}`);
  return p;
}

const repoBase = (c: ConnTarget, env: DriverEnv, repo: string) =>
  c.config.provider === "gitlab" ? `${gitApi(c, env)}/projects/${encodeURIComponent(repo)}` : `${gitApi(c, env)}/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;

// ---- Repository facts ------------------------------------------------------------------------------------------

export interface RepoInfo {
  provider: "github" | "gitlab";
  repository: string;
  default_branch: string | null;
  last_commit: { sha: string; message: string; author: string | null; at: string | null } | null;
  languages: Record<string, number>;
  open_prs: number | null;
  archived?: boolean;
  visibility?: string | null;
  pushed_at?: string | null;
}

/** How many items a list has, from its Link header's last page (GitHub) or X-Total (GitLab), else the page's length. */
function totalOf(res: PinnedResponse, pageLength: number): number {
  const total = res.headers["x-total"];
  if (typeof total === "string" && /^\d+$/.test(total)) return Number(total);
  const link = res.headers.link;
  const last = typeof link === "string" ? /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link) : null;
  return last ? Number(last[1]) : pageLength;
}

const firstLine = (s: unknown) => redact(String(s ?? "").split("\n")[0]!.trim().slice(0, 200)).text;

/** Default branch, last commit on it, languages and open pull (merge) requests of one repository. */
export async function repoInfo(c: ConnTarget, env: DriverEnv, repository: string): Promise<RepoInfo> {
  const repo = repoPathOf(c, repository);
  const b = repoBase(c, env, repo);
  const headers = gitHeaders(c);
  if (c.config.provider === "gitlab") {
    const p = await callJson<{ default_branch?: string; archived?: boolean; visibility?: string; last_activity_at?: string }>(b, "http", env, "GitLab", { headers });
    const branch = p.default_branch ?? null;
    const commits = branch ? await callJson<{ id: string; title?: string; message?: string; author_name?: string; committed_date?: string }[]>(`${b}/repository/commits?ref_name=${encodeURIComponent(branch)}&per_page=1`, "http", env, "GitLab", { headers }) : [];
    const langs = await callJson<Record<string, number>>(`${b}/languages`, "http", env, "GitLab", { headers }).catch(() => ({}));
    const mrs = await call(`${b}/merge_requests?state=opened&per_page=1`, "http", env, { headers });
    const c0 = commits[0];
    return {
      provider: "gitlab",
      repository: repo,
      default_branch: branch,
      last_commit: c0 ? { sha: c0.id, message: firstLine(c0.title ?? c0.message), author: c0.author_name ?? null, at: c0.committed_date ?? null } : null,
      languages: langs,
      open_prs: mrs.status === 200 ? totalOf(mrs, (JSON.parse(mrs.text) as unknown[]).length) : null,
      archived: !!p.archived,
      visibility: p.visibility ?? null,
      pushed_at: p.last_activity_at ?? null,
    };
  }
  const r = await callJson<{ default_branch?: string; archived?: boolean; visibility?: string; private?: boolean; pushed_at?: string }>(b, "http", env, "GitHub", { headers });
  const branch = r.default_branch ?? null;
  const commits = branch
    ? await callJson<{ sha: string; commit?: { message?: string; author?: { name?: string; date?: string } } }[]>(`${b}/commits?sha=${encodeURIComponent(branch)}&per_page=1`, "http", env, "GitHub", { headers }).catch(() => [])
    : [];
  const langs = await callJson<Record<string, number>>(`${b}/languages`, "http", env, "GitHub", { headers }).catch(() => ({}));
  const prs = await call(`${b}/pulls?state=open&per_page=1`, "http", env, { headers });
  const c0 = commits[0];
  return {
    provider: "github",
    repository: repo,
    default_branch: branch,
    last_commit: c0 ? { sha: c0.sha, message: firstLine(c0.commit?.message), author: c0.commit?.author?.name ?? null, at: c0.commit?.author?.date ?? null } : null,
    languages: langs,
    open_prs: prs.status === 200 ? totalOf(prs, (JSON.parse(prs.text) as unknown[]).length) : null,
    archived: !!r.archived,
    visibility: r.visibility ?? (r.private === undefined ? null : r.private ? "private" : "public"),
    pushed_at: r.pushed_at ?? null,
  };
}

// ---- read_repo_file ------------------------------------------------------------------------------------------------

/** Files bigger than this aren't returned (GitHub's contents API stops at 1 MB too). */
export const MAX_FILE_BYTES = 1024 * 1024;

export type RepoEntry = { name: string; path: string; type: string; size?: number };
export type RepoRead =
  | { kind: "file"; path: string; ref: string | null; size: number; content: Buffer | null; too_large?: boolean }
  | { kind: "dir"; path: string; ref: string | null; entries: RepoEntry[]; truncated: boolean };

/** A file path in a repository: no leading slash, no dot segments, no backslashes or control characters. */
export function checkRepoFilePath(path: string): string {
  const p = String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (p.length > 1000 || /[\\\u0000-\u001f\u007f]/.test(p) || p.split("/").some((s) => s === "." || s === ".." || (s === "" && p !== ""))) throw new ValidationError("path is a file or folder path in the repository, like src/index.ts (no .. segments)");
  return p;
}

export function checkRef(ref: string | undefined): string | undefined {
  if (ref === undefined || ref === "") return undefined;
  if (!/^[\w./@+-]{1,200}$/.test(ref) || ref.includes("..") || ref.startsWith("-")) throw new ValidationError("ref is a branch, tag or commit SHA");
  return ref;
}

/** Reads a file (or lists a folder) through the provider's API, read-only. */
export async function readRepo(c: ConnTarget, env: DriverEnv, repository: string, path: string, ref?: string): Promise<RepoRead> {
  const repo = repoPathOf(c, repository);
  const b = repoBase(c, env, repo);
  const headers = gitHeaders(c);
  const p = checkRepoFilePath(path);
  const r = checkRef(ref);
  const req = { headers, maxBytes: 3 * MAX_FILE_BYTES };
  if (c.config.provider === "gitlab") {
    const at = r ?? (await callJson<{ default_branch?: string }>(b, "http", env, "GitLab", { headers })).default_branch ?? "HEAD";
    if (p) {
      const fileUrl = `${b}/repository/files/${encodeURIComponent(p)}?ref=${encodeURIComponent(at)}`;
      // The size first (GitLab's HEAD answers with X-Gitlab-Size): a big file's base64 JSON would pass the response
      // cap and fail, instead of saying it's too large to read.
      const head = await call(fileUrl, "http", env, { ...req, method: "HEAD" });
      const headSize = Number(head.headers["x-gitlab-size"]);
      if (head.status === 200 && Number.isFinite(headSize) && headSize > MAX_FILE_BYTES) return { kind: "file", path: p, ref: at, size: headSize, content: null, too_large: true };
      const res = head.status === 404 ? head : await call(fileUrl, "http", env, req);
      if (res.status === 200) {
        const f = JSON.parse(res.text) as { size?: number; content?: string; encoding?: string };
        const size = Number(f.size ?? 0);
        if (size > MAX_FILE_BYTES) return { kind: "file", path: p, ref: at, size, content: null, too_large: true };
        return { kind: "file", path: p, ref: at, size, content: Buffer.from(f.content ?? "", f.encoding === "base64" ? "base64" : "utf8") };
      }
      if (res.status !== 404) failWith(res, "GitLab");
    }
    const tree = await call(`${b}/repository/tree?ref=${encodeURIComponent(at)}&per_page=100${p ? `&path=${encodeURIComponent(p)}` : ""}`, "http", env, req);
    if (tree.status === 404) throw new NotFoundError(`${p || "/"} in ${repo}${r ? ` at ${r}` : ""}`);
    if (tree.status !== 200) failWith(tree, "GitLab");
    const list = JSON.parse(tree.text) as { name: string; path: string; type: string }[];
    if (!list.length && p) throw new NotFoundError(`${p} in ${repo}${r ? ` at ${r}` : ""}`);
    return { kind: "dir", path: p, ref: at, entries: list.map((e) => ({ name: e.name, path: e.path, type: e.type === "tree" ? "dir" : e.type === "blob" ? "file" : e.type })), truncated: totalOf(tree, list.length) > list.length };
  }
  const res = await call(`${b}/contents/${p.split("/").map(encodeURIComponent).join("/")}${r ? `?ref=${encodeURIComponent(r)}` : ""}`, "http", env, req);
  if (res.status === 404) throw new NotFoundError(`${p || "/"} in ${repo}${r ? ` at ${r}` : ""}`);
  if (res.status !== 200) failWith(res, "GitHub");
  const body = JSON.parse(res.text) as unknown;
  if (Array.isArray(body)) {
    const list = body as { name: string; path: string; type: string; size?: number }[];
    return { kind: "dir", path: p, ref: r ?? null, entries: list.slice(0, 1000).map((e) => ({ name: e.name, path: e.path, type: e.type, ...(e.type === "file" ? { size: e.size } : {}) })), truncated: list.length > 1000 };
  }
  const f = body as { type?: string; size?: number; content?: string; encoding?: string };
  if (f.type !== "file") throw new ValidationError(`${p} is a ${f.type ?? "special entry"}, not a file or folder`);
  const size = Number(f.size ?? 0);
  if (size > MAX_FILE_BYTES || f.encoding === "none" || (!f.content && size > 0)) return { kind: "file", path: p, ref: r ?? null, size, content: null, too_large: true };
  return { kind: "file", path: p, ref: r ?? null, size, content: Buffer.from(f.content ?? "", "base64") };
}

// ---- Pull requests (PR briefings) ------------------------------------------------------------------------------

/** At most this many changed files are read from a pull request (GitHub lists up to 3,000; briefings need the gist). */
export const MAX_PR_FILES = 300;

/** The paths a pull (merge) request changes, renames included under their new name. */
export async function prFiles(c: ConnTarget, env: DriverEnv, repository: string, number: number): Promise<string[]> {
  const repo = repoPathOf(c, repository);
  const b = repoBase(c, env, repo);
  const headers = gitHeaders(c);
  if (c.config.provider === "gitlab") {
    const r = await callJson<{ changes?: { new_path?: string; old_path?: string }[] }>(`${b}/merge_requests/${number}/changes`, "http", env, "GitLab", { headers, maxBytes: 20 * 1024 * 1024, truncate: false });
    return [...new Set((r.changes ?? []).map((f) => f.new_path ?? f.old_path ?? "").filter(Boolean))].slice(0, MAX_PR_FILES);
  }
  const out: string[] = [];
  for (let page = 1; out.length < MAX_PR_FILES && page <= 3; page++) {
    const list = await callJson<{ filename: string }[]>(`${b}/pulls/${number}/files?per_page=100&page=${page}`, "http", env, "GitHub", { headers });
    out.push(...list.map((f) => f.filename));
    if (list.length < 100) break;
  }
  return [...new Set(out)].slice(0, MAX_PR_FILES);
}

/**
 * Creates the briefing comment on a pull (merge) request, or edits the one posted before (by id). Returns its id.
 * A comment deleted by someone is posted again.
 */
export async function upsertPrComment(c: ConnTarget, env: DriverEnv, repository: string, number: number, body: string, commentId: string | null): Promise<string> {
  const repo = repoPathOf(c, repository);
  const b = repoBase(c, env, repo);
  const headers = { ...gitHeaders(c), "content-type": "application/json" };
  const gitlab = c.config.provider === "gitlab";
  const what = gitlab ? "GitLab" : "GitHub";
  if (commentId && /^\d+$/.test(commentId)) {
    const url = gitlab ? `${b}/merge_requests/${number}/notes/${commentId}` : `${b}/issues/comments/${commentId}`;
    const res = await call(url, "http", env, { method: gitlab ? "PUT" : "PATCH", headers, body: JSON.stringify({ body }) });
    if (res.status >= 200 && res.status < 300) return commentId;
    if (res.status !== 404) failWith(res, what);
  }
  const url = gitlab ? `${b}/merge_requests/${number}/notes` : `${b}/issues/${number}/comments`;
  const created = await callJson<{ id: number | string }>(url, "http", env, what, { method: "POST", headers, body: JSON.stringify({ body }) });
  return String(created.id);
}

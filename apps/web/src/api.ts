/** Thin client for the Cairn REST API. */

const TOKEN_KEY = "cairn.devToken";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token lasts for this page only */
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: any,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  // Behind Cloudflare Access the browser is authenticated by Access itself; the token is for dev mode.
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const issues = body?.issues?.map((i: { path: string[]; message: string }) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ApiError(res.status, issues ? `${body.error}: ${issues}` : (body?.error ?? res.statusText), body);
  }
  return body as T;
}

// ---- Shapes returned by the API (only the fields the UI uses) ----------------

export interface Me {
  id: string;
  email: string | null;
  kind: string;
  admin: boolean;
}

export interface ScopeInfo {
  kind: "team" | "project" | "library";
  slug: string;
  name: string;
  description: string;
  components: { slug: string; kind: string; repo_url: string | null }[];
}

export interface Related {
  relation: string;
  direction: "in" | "out";
  kind: string;
  id: string;
  label: string;
  type: string | null;
  status: string | null;
  scope: string | null;
}

export interface SourceLink {
  system: string;
  url: string;
  label: string;
}

export interface Article {
  id: string;
  title: string;
  type: string;
  status: string;
  scope: { slug: string; kind: string };
  path: string;
  owner: string | null;
  tags: string[];
  components: string[];
  version: number;
  last_verified_at: string | null;
  updated_at: string;
  sections: string[];
  body_md: string;
  related: Related[];
  source_links: SourceLink[];
  entities: { kind: string; name: string }[];
}

export interface Finding {
  id: string;
  title: string;
  type: string;
  status: string;
  scope: { slug: string; kind: string };
  symptoms: string;
  root_cause: string;
  fix: string;
  tags: string[];
  components: string[];
  author: string | null;
  version: number;
  last_verified_at: string | null;
  updated_at: string;
  related: Related[];
  source_links: SourceLink[];
  entities: { kind: string; name: string }[];
  history: { op: string; state: string; reason: string | null; created_at: string; author: string }[];
}

export interface SearchHit {
  kind: "article" | "finding";
  id: string;
  title: string;
  type: string;
  status: string;
  section: string | null;
  snippet: string;
  scope: { slug: string; kind: string };
  via_uses_link: boolean;
  warning?: string;
}

export interface Folder {
  folders: Record<string, Folder>;
  articles: { id: string; title: string; type: string; status: string }[];
}

export interface RevisionSummary {
  id: string;
  op: string;
  state: string;
  summary: string;
  redactions: { kind: string; count: number }[];
  created_at: string;
  target_kind: "article" | "finding";
  target_id: string;
  target_title: string;
  target_type: string;
  scope: string;
  author: string;
  reviewer: string | null;
  reason: string | null;
}

export interface Notice {
  id: string;
  summary: string;
  source_id: string;
  source_title: string;
  source_scope: string;
  source_version: number;
  component: string | null;
  created_at: string;
}

/** Result of a create/edit from the UI: published directly, or queued for review. */
export interface WriteResult {
  status: string;
  published?: boolean;
  revision_id?: string;
  article_id?: string;
  finding_id?: string;
  duplicates?: { id: string; title: string; status: string; scope: string; overlap: number }[];
  missing_template_sections?: string[];
  redactions?: { kind: string; count: number }[];
}

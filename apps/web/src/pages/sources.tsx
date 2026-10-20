import { useState } from "react";
import { api, type Me, type ScopeInfo } from "../api";
import { I } from "../components/icons";
import { ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { useApi, useLiveRefresh } from "../hooks";
import { href, navigate, type Route } from "../router";

type Kind = "rss" | "web" | "hackernews" | "slack" | "notion" | "tavily";

interface KindInfo {
  kind: Kind;
  label: string;
  fields: { key: string; label: string; required?: boolean; hint?: string }[];
  configured: boolean;
  needs: string | null;
}

interface Source {
  id: string;
  kind: Kind;
  name: string;
  scope: string;
  scope_name: string;
  config: Record<string, string>;
  interval_minutes: number;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_error: string | null;
  last_count: number | null;
  new_items: number;
}

interface InboxItem {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  excerpt: string;
  published_at: string | null;
  fetched_at: string;
  status: "new" | "filed" | "dismissed";
  updated: boolean;
  resolution_note: string | null;
  item_kind: "article" | "finding" | null;
  item_id: string | null;
  source: string;
  source_kind: Kind;
  scope: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

const KIND_TEXT: Record<Kind, string> = { rss: "Feed", web: "Page", hackernews: "Hacker News", slack: "Slack", notion: "Notion", tavily: "Web search" };

const INTERVALS: [number, string][] = [
  [60, "Every hour"],
  [180, "Every 3 hours"],
  [360, "Every 6 hours"],
  [720, "Twice a day"],
  [1440, "Daily"],
  [10080, "Weekly"],
];

function Tabs({ active }: { active: "inbox" | "sources" }) {
  return (
    <nav className="tabs settings-tabs" aria-label="Inbox sections">
      <a className={active === "inbox" ? "active" : ""} href={href("/inbox")}>
        Inbox
      </a>
      <a className={active === "sources" ? "active" : ""} href={href("/sources")}>
        Sources
      </a>
    </nav>
  );
}

/** Markdown excerpt as plain text for the list. */
function plain(md: string) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- Inbox --------------------------------------------------------------------------------------------

export function InboxPage({ route, scopes }: { route: Route; scopes: ScopeInfo[] }) {
  const status = (route.query.get("status") ?? "new") as "new" | "filed" | "dismissed";
  const scope = route.query.get("scope") ?? "";
  const q = new URLSearchParams({ status, limit: "100", ...(scope ? { scope } : {}) });
  const { data, error, reload } = useApi<{ items: InboxItem[]; counts: Record<string, number> }>(`/inbox?${q}`);
  useLiveRefresh(reload);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const go = (patch: Record<string, string>) => navigate("/inbox", { status, scope, ...patch });
  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      reload();
    } catch (e) {
      setActionError(e as Error);
    }
  }
  async function draft(item: InboxItem) {
    await act(async () => {
      const full = await api<{ title: string; body: string; url: string | null }>(`/inbox/${item.id}`);
      try {
        sessionStorage.setItem("thaliyola.pasteDraft", `${full.title}\n\n${full.body}${full.url ? `\n\nSource: ${full.url}` : ""}`);
      } catch {
        /* storage unavailable: the paste page opens empty */
      }
      navigate("/new/paste");
    });
  }

  return (
    <div className="page inbox-page">
      <h1>Inbox</h1>
      <p className="lead">
        What your team's sources brought in: feeds, watched pages, Slack threads, Notion pages and searches. Connected agents triage it (
        <code>/mcp__thaliyola__triage-inbox</code>), or file and dismiss items here.
      </p>
      <Tabs active="inbox" />
      <div className="inbox-filters">
        <div className="chips" role="tablist" aria-label="Status">
          {(["new", "filed", "dismissed"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} className={`chip ${status === s ? "active" : ""}`} onClick={() => go({ status: s })}>
              {s === "new" ? "New" : s === "filed" ? "Filed" : "Dismissed"}
              {data?.counts[s] ? ` (${data.counts[s]})` : ""}
            </button>
          ))}
        </div>
        <select value={scope} onChange={(e) => go({ scope: e.target.value })} aria-label="Scope">
          <option value="">Everywhere</option>
          {scopes.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={error ?? actionError} />
      {!data ? (
        <Loading />
      ) : !data.items.length ? (
        <div className="empty-state">
          <p className="muted">
            {status === "new" ? "Nothing waiting." : `Nothing ${status} yet.`}{" "}
            {status === "new" && (
              <a href={href("/sources")}>Add a source</a>
            )}
          </p>
        </div>
      ) : (
        <ul className="plain inbox-list">
          {data.items.map((i) => (
            <li key={i.id} className="inbox-item">
              <div className="inbox-meta small muted">
                <span className="badge badge-type">{KIND_TEXT[i.source_kind]}</span> {i.source} · {i.scope}
                {i.author ? ` · ${i.author}` : ""} · {formatDate(i.published_at ?? i.fetched_at)}
                {i.updated && <span className="badge badge-possibly_stale">updated</span>}
              </div>
              <h3 className="inbox-title">
                {i.url ? (
                  <a href={i.url} target="_blank" rel="noopener noreferrer nofollow">
                    {i.title}
                  </a>
                ) : (
                  i.title
                )}
              </h3>
              <p className="inbox-excerpt">{plain(i.excerpt)}</p>
              {i.status !== "new" && (
                <p className="small muted">
                  {i.status === "filed" ? "Filed" : "Dismissed"}
                  {i.resolved_by ? ` by ${i.resolved_by}` : ""} {formatDate(i.resolved_at)}
                  {i.resolution_note ? `: ${i.resolution_note}` : ""}
                  {i.item_id && (
                    <>
                      {" "}
                      · <a href={href(`/${i.item_kind}/${i.item_id}`)}>open the {i.item_kind}</a>
                    </>
                  )}
                </p>
              )}
              {dismissing === i.id ? (
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act(() => api(`/inbox/${i.id}/resolve`, { method: "POST", body: { outcome: "dismissed", note: reason } })).then(() => {
                      setDismissing(null);
                      setReason("");
                    });
                  }}
                >
                  <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. already known, off-topic" aria-label="Reason" required />
                  <button className="btn btn-small btn-primary">Dismiss</button>
                  <button type="button" className="btn btn-small" onClick={() => setDismissing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <div className="row-actions">
                  {i.status === "new" ? (
                    <>
                      <button className="btn btn-small" onClick={() => draft(i)}>
                        Draft from this
                      </button>
                      <button className="btn btn-small" onClick={() => setDismissing(i.id)}>
                        Dismiss
                      </button>
                    </>
                  ) : (
                    <button className="btn btn-small" onClick={() => act(() => api(`/inbox/${i.id}/reopen`, { method: "POST" }))}>
                      Back to new
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Sources -------------------------------------------------------------------------------------------

export function SourcesPage({ scopes, me }: { scopes: ScopeInfo[]; me: Me }) {
  const { data, error, reload } = useApi<{ sources: Source[]; kinds: KindInfo[]; enabled: boolean }>("/sources");
  const [actionError, setActionError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const manageable = scopes.filter((s) => me.admin || (s.kind === "project" && s.my_role === "owner"));

  async function act(fn: () => Promise<string | void>) {
    setActionError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      reload();
    } catch (e) {
      setActionError(e as Error);
    }
  }

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="page sources-page">
      <h1>Inbox</h1>
      <p className="lead">
        Thaliyola checks these on a schedule and puts what's new in the inbox. Nothing is published by itself: people and connected agents decide what becomes knowledge.
      </p>
      <Tabs active="sources" />
      {!data.enabled && <Notice kind="warn">Fetching is turned off on this server (SOURCES=off). Sources are kept but not checked.</Notice>}
      <ErrorBox error={actionError} />
      {notice && <Notice kind="ok">{notice}</Notice>}

      {manageable.length > 0 &&
        (adding ? (
          <AddSource kinds={data.kinds} scopes={manageable} onDone={(msg) => (setAdding(false), setNotice(msg), reload())} onCancel={() => setAdding(false)} />
        ) : (
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <I name="plus" size={16} /> Add a source
          </button>
        ))}
      {!manageable.length && <p className="muted small">Project owners add sources to their projects; admins to Team and Library.</p>}

      {!data.sources.length ? (
        <p className="muted">No sources yet.</p>
      ) : (
        <ul className="plain source-list">
          {data.sources.map((s) => (
            <li key={s.id} className={`source ${s.enabled ? "" : "is-off"}`}>
              <div className="source-main">
                <div>
                  <span className="badge badge-type">{KIND_TEXT[s.kind]}</span> <strong>{s.name}</strong>{" "}
                  <span className="muted small">
                    → {s.scope_name} · {INTERVALS.find(([m]) => m === s.interval_minutes)?.[1].toLowerCase() ?? `every ${s.interval_minutes} min`}
                  </span>
                </div>
                <div className="small muted source-detail">{s.config.url ?? s.config.query ?? s.config.channel ?? s.config.database_id ?? "all shared pages"}</div>
                <div className="small muted">
                  {s.enabled ? (s.last_run_at ? `Checked ${formatDate(s.last_run_at)}` : "Not checked yet") : "Paused"}
                  {s.last_count ? ` · ${s.last_count} new last time` : ""}
                  {s.new_items > 0 && (
                    <>
                      {" · "}
                      <a href={href("/inbox", { scope: s.scope })}>{s.new_items} waiting</a>
                    </>
                  )}
                </div>
                {s.last_error && <div className="small error-text">Last check failed: {s.last_error}</div>}
              </div>
              <div className="row-actions">
                <button
                  className="btn btn-small"
                  onClick={() =>
                    act(async () => {
                      const r = await api<{ added: number; updated: number; error?: string }>(`/sources/${s.id}/run`, { method: "POST" });
                      if (r.error) throw new Error(r.error);
                      return `${s.name}: ${r.added} new, ${r.updated} updated.`;
                    })
                  }
                >
                  Check now
                </button>
                <button className="btn btn-small" onClick={() => act(() => api(`/sources/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }))}>
                  {s.enabled ? "Pause" : "Resume"}
                </button>
                <button
                  className="link-btn small danger"
                  onClick={() => {
                    if (confirm(`Remove ${s.name} and its inbox items?`)) void act(() => api(`/sources/${s.id}`, { method: "DELETE" }).then(() => `Removed ${s.name}.`));
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <details className="sources-help">
        <summary>Slack, Notion and web search</summary>
        <p className="small">These need a credential in the server's environment (admins set it in the env file and restart):</p>
        <ul className="list small">
          <li>
            <strong>Slack:</strong> <code>SLACK_BOT_TOKEN</code>, a bot with <code>channels:history</code> (<code>groups:history</code> for private channels) and <code>users:read</code>. Invite it to each channel you add.
          </li>
          <li>
            <strong>Notion:</strong> <code>NOTION_TOKEN</code> from an internal integration; share the pages or database with it.
          </li>
          <li>
            <strong>Web search:</strong> <code>TAVILY_API_KEY</code>.
          </li>
          <li>
            Feeds and pages on an internal network need <code>SOURCES_ALLOW_PRIVATE=true</code>.
          </li>
        </ul>
      </details>
    </div>
  );
}

function AddSource({ kinds, scopes, onDone, onCancel }: { kinds: KindInfo[]; scopes: ScopeInfo[]; onDone: (msg: string) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>("rss");
  const [scope, setScope] = useState(scopes[0]?.slug ?? "");
  const [name, setName] = useState("");
  const [every, setEvery] = useState(360);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ items: { title: string; url?: string | null; published_at?: string | null }[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const info = kinds.find((k) => k.kind === kind)!;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card add-source editor"
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          const s = await api<{ id: string; name: string }>("/sources", { method: "POST", body: { kind, scope, name, config, interval_minutes: every } });
          // Fill the inbox right away instead of waiting for the schedule.
          const r = await api<{ added: number; error?: string }>(`/sources/${s.id}/run`, { method: "POST" });
          onDone(r.error ? `Added ${s.name}, but the first check failed: ${r.error}` : `Added ${s.name}: ${r.added} item${r.added === 1 ? "" : "s"} in the inbox.`);
        });
      }}
    >
      <h2>Add a source</h2>
      <label>What to watch</label>
      <div className="chips" role="radiogroup" aria-label="Kind">
        {kinds.map((k) => (
          <button
            type="button"
            key={k.kind}
            role="radio"
            aria-checked={kind === k.kind}
            className={`chip ${kind === k.kind ? "active" : ""}`}
            onClick={() => (setKind(k.kind), setConfig({}), setPreview(null))}
            title={k.configured ? undefined : `Needs ${k.needs} on the server`}
          >
            {k.label}
            {!k.configured && " (not set up)"}
          </button>
        ))}
      </div>
      {!info.configured && <Notice kind="warn">{info.label} needs {info.needs} in the server's environment. An admin can add it and restart the service.</Notice>}
      {info.fields.map((f) => (
        <div key={f.key}>
          <label htmlFor={`src-${f.key}`}>
            {f.label}
            {!f.required && <span className="muted small"> (optional)</span>}
          </label>
          <input id={`src-${f.key}`} value={config[f.key] ?? ""} onChange={(e) => (setConfig({ ...config, [f.key]: e.target.value }), setPreview(null))} required={f.required} />
          {f.hint && <p className="muted small">{f.hint}</p>}
        </div>
      ))}
      <div className="form-row">
        <div>
          <label htmlFor="src-scope">Inbox for</label>
          <select id="src-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            {scopes.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="src-interval">Check</label>
          <select id="src-interval" value={every} onChange={(e) => setEvery(Number(e.target.value))}>
            {INTERVALS.map(([m, label]) => (
              <option key={m} value={m}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <label htmlFor="src-name">
        Name <span className="muted small">(optional)</span>
      </label>
      <input id="src-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Payment provider changelog" />
      <ErrorBox error={error} />
      {preview && (
        <div className="preview-box">
          <strong className="small">
            {preview.total ? `${preview.total} item${preview.total === 1 ? "" : "s"} found${preview.total > preview.items.length ? `, first ${preview.items.length}` : ""}:` : "Nothing found right now."}
          </strong>
          <ul className="list small">
            {preview.items.map((p, n) => (
              <li key={n}>
                {p.title} {p.published_at && <span className="muted">· {formatDate(p.published_at)}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy || !info.configured}
          onClick={() => run(async () => setPreview(await api("/sources/preview", { method: "POST", body: { kind, scope, config } })))}
        >
          Preview
        </button>
        <button className="btn btn-primary" disabled={busy || !info.configured}>
          {busy ? "Working…" : "Add source"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

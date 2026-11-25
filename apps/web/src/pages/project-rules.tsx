import { useState } from "react";
import { api, type ScopeInfo } from "../api";
import { ErrorBox, formatDate } from "../components/ui";
import { useApi } from "../hooks";
import { href } from "../router";

/**
 * Project settings › Rules for agents: paths with something to know before an agent edits them. The Claude Code
 * plugin's edit hook enforces them: read first (the first edit is stopped until the page is read), never edit
 * (the person decides each time), heads-up (Claude is told). Below: what happened lately.
 */

type Kind = "read_first" | "never_edit" | "heads_up";
interface Rule {
  id: string;
  component: string | null;
  kind: Kind;
  paths: string[];
  article: { id: string; title: string } | null;
  message: string;
  enabled: boolean;
}
interface RuleEvent {
  id: string;
  kind: Kind;
  message: string;
  path: string;
  outcome: "stopped" | "read" | "asked" | "told";
  created_at: string;
  session: string | null;
  person: string | null;
}

const KIND: Record<Kind, { label: string; help: string }> = {
  read_first: { label: "Read first", help: "The first edit in a session is stopped until Claude has read the page." },
  never_edit: { label: "Never edit", help: "The person is asked every time; it's their call." },
  heads_up: { label: "Heads-up", help: "Claude is told; nothing is stopped." },
};
const OUTCOME: Record<RuleEvent["outcome"], string> = { stopped: "Stopped until read", read: "Edited after reading", asked: "Person asked", told: "Told Claude" };

export function RulesSettings({ scope }: { scope: ScopeInfo }) {
  const slug = encodeURIComponent(scope.slug);
  const rules = useApi<{ rules: Rule[] }>(`/scopes/${slug}/rules`);
  const events = useApi<{ events: RuleEvent[] }>(`/scopes/${slug}/rules/events`);
  const [error, setError] = useState<Error | null>(null);
  const reload = () => {
    rules.reload();
    events.reload();
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err as Error);
    }
  };
  return (
    <section className="rules-settings">
      <p className="muted small">
        Paths in this project's repositories with something an agent must know before editing them. The Claude Code plugin (0.5.0 and later) enforces them on every edit; other clients see
        them in the project's context.
      </p>
      <ErrorBox error={rules.error as Error | null} />
      {(rules.data?.rules.length ?? 0) === 0 ? (
        <p className="muted">No rules yet.</p>
      ) : (
        <ul className="plain rules-list">
          {rules.data!.rules.map((r) => (
            <li key={r.id} className={`card rules-row${r.enabled ? "" : " is-off"}`}>
              <div className="rules-head">
                <span className={`badge ${r.kind === "never_edit" ? "badge-danger" : r.kind === "read_first" ? "badge-warning" : "badge-type"}`}>{KIND[r.kind].label}</span>
                <code>{r.paths.join(", ")}</code>
                {r.component && <span className="muted small">in {r.component}</span>}
              </div>
              <p className="small">
                {r.message}
                {r.article && (
                  <>
                    {" "}
                    Read: <a href={href(`/article/${r.article.id}`)}>{r.article.title}</a>
                  </>
                )}
              </p>
              <div className="rules-actions">
                <button className="btn btn-small" onClick={() => void act(() => api(`/scopes/${slug}/rules/${r.id}`, { method: "PUT", body: { ...rest(r), enabled: !r.enabled } }))}>
                  {r.enabled ? "Turn off" : "Turn on"}
                </button>
                <button className="btn btn-small btn-ghost" onClick={() => void act(() => api(`/scopes/${slug}/rules/${r.id}`, { method: "DELETE" }))}>
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <NewRule scope={scope} onSaved={reload} />
      <ErrorBox error={error} />
      {(events.data?.events.length ?? 0) > 0 && (
        <>
          <h3>What happened lately</h3>
          <ul className="plain rules-events small">
            {events.data!.events.map((e) => (
              <li key={e.id}>
                <strong>{OUTCOME[e.outcome]}</strong> · <code>{e.path}</code> · {e.session ?? e.person ?? "a session"} · <span className="muted">{formatDate(e.created_at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const rest = (r: Rule) => ({ kind: r.kind, paths: r.paths, component: r.component, article_id: r.article?.id ?? null, message: r.message });

function NewRule({ scope, onSaved }: { scope: ScopeInfo; onSaved(): void }) {
  const [kind, setKind] = useState<Kind>("heads_up");
  const [paths, setPaths] = useState("");
  const [component, setComponent] = useState("");
  const [message, setMessage] = useState("");
  const [q, setQ] = useState("");
  const [article, setArticle] = useState<{ id: string; title: string } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const found = useApi<{ articles: { id: string; title: string }[] }>(kind === "read_first" && q.trim().length >= 2 && !article ? `/search?${new URLSearchParams({ q, scope: scope.slug, limit: "5" })}` : null);
  return (
    <form
      className="card rules-new"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api(`/scopes/${encodeURIComponent(scope.slug)}/rules`, {
            method: "POST",
            body: { kind, paths: paths.split(/[\n,]+/).map((p) => p.trim()).filter(Boolean), component: component || null, article_id: article?.id ?? null, message },
          });
          setPaths("");
          setMessage("");
          setArticle(null);
          setQ("");
          onSaved();
        } catch (err) {
          setError(err as Error);
        }
      }}
    >
      <h3>Add a rule</h3>
      <label>
        Kind{" "}
        <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
          {(Object.keys(KIND) as Kind[]).map((k) => (
            <option key={k} value={k}>
              {KIND[k].label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">{KIND[kind].help}</p>
      <label>
        Paths (globs, one per line or comma-separated: <code>src/payments/**</code>, <code>migrations/*.sql</code>, <code>infra/</code>)
        <textarea rows={2} value={paths} onChange={(e) => setPaths(e.target.value)} required />
      </label>
      {scope.components.length > 1 && (
        <label>
          Repository{" "}
          <select value={component} onChange={(e) => setComponent(e.target.value)}>
            <option value="">All</option>
            {scope.components.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.slug}
              </option>
            ))}
          </select>
        </label>
      )}
      {kind === "read_first" && (
        <div className="rules-article">
          {article ? (
            <p className="small">
              Page to read: <a href={href(`/article/${article.id}`)}>{article.title}</a>{" "}
              <button type="button" className="link-btn" onClick={() => setArticle(null)}>
                Change
              </button>
            </p>
          ) : (
            <>
              <label>
                Page to read first <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this project's pages" />
              </label>
              <ul className="plain small">
                {(found.data?.articles ?? []).map((a) => (
                  <li key={a.id}>
                    <button type="button" className="link-btn" onClick={() => setArticle(a)}>
                      {a.title}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      <label>
        What Claude should know or do
        <textarea rows={2} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} required />
      </label>
      <button className="btn btn-primary" type="submit" disabled={kind === "read_first" && !article}>
        Add rule
      </button>
      <ErrorBox error={error} />
    </form>
  );
}

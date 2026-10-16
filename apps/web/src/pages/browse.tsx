import type { Folder, Me, Notice as NoticeT, ScopeInfo, SearchHit } from "../api";
import { WatchButton } from "../components/notifications";
import { AnswerCard, FavouriteButton } from "../components/find";
import { api } from "../api";
import { ErrorBox, formatDate, itemHref, Loading, Notice, ScopeBadge, Snippet, StatusBadge, TypeBadge } from "../components/ui";
import { useApi } from "../hooks";
import { href, type Route } from "../router";
import { useState } from "react";

export function SearchPage({ route }: { route: Route }) {
  const q = route.query.get("q") ?? "";
  const scope = route.query.get("scope") ?? "all";
  const drafts = route.query.get("drafts") === "1";
  const params = new URLSearchParams({ q, scope, ...(drafts ? { statuses: "draft,published,possibly_stale" } : {}) });
  const { data, error, loading } = useApi<{ articles: SearchHit[]; findings: SearchHit[] }>(q ? `/search?${params}` : null);

  return (
    <div className="page">
      <h1>Search</h1>
      <div className="filters">
        <span className="muted small">Scope:</span>
        {[
          ["all", "Everything"],
          ["team", "Team"],
          ["library", "Library"],
        ].map(([value, text]) => (
          <a key={value} className={`chip ${scope === value ? "active" : ""}`} href={href("/search", { q, scope: value, drafts: drafts ? "1" : undefined })}>
            {text}
          </a>
        ))}
        <a className={`chip ${drafts ? "active" : ""}`} href={href("/search", { q, scope, drafts: drafts ? undefined : "1" })}>
          Include drafts
        </a>
      </div>
      <ErrorBox error={error} />
      {q && <AnswerCard q={q} />}
      {loading && <Loading />}
      {data && (
        <>
          {/* Whichever group holds the strongest match comes first. */}
          {(data.findings[0]?.score ?? 0) > (data.articles[0]?.score ?? 0) * 1.25 ? (
            <>
              <HitList title="Findings" hits={data.findings} />
              <HitList title="Articles" hits={data.articles} />
            </>
          ) : (
            <>
              <HitList title="Articles" hits={data.articles} />
              <HitList title="Findings" hits={data.findings} />
            </>
          )}
          {!data.articles.length && !data.findings.length && <p className="muted">Nothing found for “{q}”.</p>}
        </>
      )}
    </div>
  );
}

function HitList({ title, hits }: { title: string; hits: SearchHit[] }) {
  if (!hits.length) return null;
  return (
    <section>
      <h2>{title}</h2>
      <ul className="hits">
        {hits.map((h) => (
          <li key={h.id} className="hit">
            <div className="hit-head">
              <a href={itemHref(h.kind, h.id) + (h.section ? `?section=${encodeURIComponent(h.section)}` : "")}>{h.title}</a>
              {h.section && <span className="muted"> › {h.section}</span>}
            </div>
            <div className="badges">
              <TypeBadge type={h.type} />
              <ScopeBadge scope={h.scope} />
              {h.status !== "published" && <StatusBadge status={h.status} />}
              {h.via_uses_link && <span className="muted small">linked by this project</span>}
              {h.match === "semantic" && <span className="muted small">similar meaning</span>}
            </div>
            <p className="snippet">
              <Snippet text={h.snippet} />
            </p>
            {h.warning && <p className="warn small">{h.warning}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ScopePage({ slug, scopes, me }: { slug: string; scopes: ScopeInfo[]; me: Me }) {
  const scope = scopes.find((s) => s.slug === slug);
  const { data, error } = useApi<{ tree: Folder }>(`/scopes/${encodeURIComponent(slug)}/tree`);
  return (
    <div className="page">
      <h1>{scope?.name ?? slug}</h1>
      {scope?.description && <p className="lead">{scope.description}</p>}
      <div className="actions">
        <a className="btn" href={href("/new/article", { scope: slug })}>
          New article
        </a>
        <a className="btn" href={href("/new/finding", { scope: slug })}>
          New finding
        </a>
        {scope && <WatchButton id={scope.id} />}
        {scope && <FavouriteButton id={scope.id} />}
        {me.admin && (
          <a className="btn" href={href(`/scope/${slug}/settings`)}>
            Settings
          </a>
        )}
      </div>
      <ErrorBox error={error} />
      {data ? <TreeTable folder={data.tree} path="" /> : !error && <Loading />}
    </div>
  );
}

function TreeTable({ folder, path }: { folder: Folder; path: string }) {
  return (
    <>
      {folder.articles.length > 0 && (
        <section>
          {path && <h2>{path}</h2>}
          <ul className="list">
            {folder.articles.map((a) => (
              <li key={a.id}>
                <a href={href(`/article/${a.id}`)}>{a.title}</a> <TypeBadge type={a.type} />
                {a.status !== "published" && <StatusBadge status={a.status} />}
              </li>
            ))}
          </ul>
        </section>
      )}
      {Object.entries(folder.folders).map(([name, sub]) => (
        <TreeTable key={name} folder={sub} path={path ? `${path} / ${name}` : name} />
      ))}
    </>
  );
}

interface ProjectContext {
  project: { id: string; slug: string; name: string; description: string };
  component: { slug: string; kind: string } | null;
  components: { slug: string; kind: string; repo_url: string | null }[];
  open_impact_notices: (NoticeT & { source_title: string })[];
  overview: { id: string; title: string; body_md: string } | null;
  contracts?: { provides: { id: string; title: string; version: number }[]; consumes: { id: string; title: string; version: number }[] };
  recent_records: { id: string; title: string; type: string; status: string; updated_at: string }[];
  uses: { kind: string; id: string; title: string; type: string; scope: string; scope_kind: string }[];
  open_known_issues: { id: string; title: string; status: string; updated_at: string }[];
}

export function ProjectPage({ slug, route, me }: { slug: string; route: Route; me: Me }) {
  const component = route.query.get("component") ?? undefined;
  const path = `/projects/${encodeURIComponent(slug)}/context${component ? `?component=${encodeURIComponent(component)}` : ""}`;
  const { data, error, reload } = useApi<ProjectContext>(path);
  const [ackError, setAckError] = useState<Error | null>(null);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  async function ack(id: string) {
    setAckError(null);
    try {
      await api(`/notices/${id}/ack`, { method: "POST" });
      reload();
    } catch (e) {
      setAckError(e as Error);
    }
  }

  return (
    <div className="page">
      <h1>{data.project.name}</h1>
      <p className="lead">{data.project.description}</p>
      <div className="filters">
        <span className="muted small">View as:</span>
        <a className={`chip ${!component ? "active" : ""}`} href={href(`/project/${slug}`)}>
          Whole project
        </a>
        {data.components.map((c) => (
          <a key={c.slug} className={`chip ${component === c.slug ? "active" : ""}`} href={href(`/project/${slug}`, { component: c.slug })}>
            {c.slug}
          </a>
        ))}
      </div>

      <ErrorBox error={ackError} />
      {data.open_impact_notices.length > 0 && (
        <section>
          <h2>Upstream changes to handle</h2>
          <ul className="list">
            {data.open_impact_notices.map((n) => (
              <li key={n.id} className="notice-row">
                <div>
                  <strong>{n.summary}</strong>
                  <div className="small muted">
                    <a href={href(`/article/${n.source_id}`)}>{n.source_title}</a> v{n.source_version}
                    {n.component ? ` · for ${n.component}` : " · whole project"} · {formatDate(n.created_at)}
                  </div>
                </div>
                <button className="btn btn-small" onClick={() => ack(n.id)}>
                  Mark handled
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="actions">
        <a className="btn" href={href(`/scope/${slug}`)}>
          All articles
        </a>
        <a className="btn" href={href("/new/article", { scope: slug })}>
          New article
        </a>
        <a className="btn" href={href("/new/finding", { scope: slug })}>
          New finding
        </a>
        <a className="btn" href={href("/graph", { scope: slug })}>
          Graph
        </a>
        <WatchButton id={data.project.id} />
        <FavouriteButton id={data.project.id} />
        {me.admin && (
          <a className="btn" href={href(`/scope/${slug}/settings`)}>
            Settings
          </a>
        )}
      </div>

      {data.contracts && (
        <section>
          <h2>Contracts</h2>
          <div className="two-col">
            <div>
              <h3>Provides</h3>
              <LinkList items={data.contracts.provides.map((c) => ({ id: c.id, title: `${c.title} (v${c.version})` }))} kind="article" />
            </div>
            <div>
              <h3>Consumes</h3>
              <LinkList items={data.contracts.consumes.map((c) => ({ id: c.id, title: `${c.title} (v${c.version})` }))} kind="article" />
            </div>
          </div>
        </section>
      )}

      {data.overview ? (
        <section>
          <h2>
            <a href={href(`/article/${data.overview.id}`)}>{data.overview.title}</a>
          </h2>
        </section>
      ) : (
        <Notice>
          No project overview yet. <a href={href("/new/article", { scope: slug, type: "project_overview" })}>Write one</a>.
        </Notice>
      )}

      <div className="two-col">
        <section>
          <h2>Recent decisions and designs</h2>
          <ul className="list">
            {data.recent_records.map((r) => (
              <li key={r.id}>
                <a href={href(`/article/${r.id}`)}>{r.title}</a> <TypeBadge type={r.type} />
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2>Uses from shared scopes</h2>
          <ul className="list">
            {data.uses.map((u) => (
              <li key={u.id}>
                <a href={itemHref(u.kind, u.id)}>{u.title}</a> <TypeBadge type={u.type} /> <ScopeBadge scope={{ slug: u.scope, kind: u.scope_kind }} />
              </li>
            ))}
            {!data.uses.length && <li className="muted">Nothing linked yet.</li>}
          </ul>
        </section>
      </div>

      <section>
        <h2>Open known issues</h2>
        <LinkList items={data.open_known_issues} kind="finding" empty="None." />
      </section>
    </div>
  );
}

function LinkList({ items, kind, empty = "None." }: { items: { id: string; title: string }[]; kind: string; empty?: string }) {
  return (
    <ul className="list">
      {items.map((i) => (
        <li key={i.id}>
          <a href={itemHref(kind, i.id)}>{i.title}</a>
        </li>
      ))}
      {!items.length && <li className="muted">{empty}</li>}
    </ul>
  );
}

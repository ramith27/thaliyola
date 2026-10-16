import { useEffect, useState } from "react";
import { api, ApiError, type Article, type Finding, type ScopeInfo, type WriteResult } from "../api";
import {
  ErrorBox,
  formatDate,
  Loading,
  Markdown,
  Notice,
  RelatedList,
  ScopeBadge,
  SourceLinks,
  StatusBadge,
  TypeBadge,
  WriteOutcome,
} from "../components/ui";
import { AddLinkForm, ShareToLibrary } from "../components/actions";
import { Attachments } from "../components/assets";
import { useApi } from "../hooks";
import { href, navigate, type Route } from "../router";

function Meta({ item }: { item: Article | Finding }) {
  return (
    <div className="badges">
      <TypeBadge type={item.type} />
      <ScopeBadge scope={item.scope} />
      <StatusBadge status={item.status} />
      <span className="muted small">
        v{item.version} · updated {formatDate(item.updated_at)} · verified {formatDate(item.last_verified_at)}
      </span>
    </div>
  );
}

function StaleWarning({ status }: { status: string }) {
  if (status === "possibly_stale") return <Notice kind="warn">Not verified recently. Confirm it still holds before relying on it.</Notice>;
  if (status === "draft") return <Notice>Draft: waiting for review.</Notice>;
  if (status === "superseded") return <Notice kind="warn">Superseded: kept for history.</Notice>;
  if (status === "rejected") return <Notice kind="warn">Rejected in review.</Notice>;
  return null;
}

function Facts({ item, reload }: { item: Article | Finding; reload: () => void }) {
  const owner = "owner" in item ? item.owner : item.author;
  return (
    <>
      {(owner || item.components.length > 0 || item.tags.length > 0 || item.entities.length > 0) && (
        <section className="side-block">
          {owner && (
            <p className="small">
              <span className="muted">{"owner" in item ? "Owner" : "Author"}:</span> {owner}
            </p>
          )}
          {item.components.length > 0 && (
            <p className="small">
              <span className="muted">Components:</span> {item.components.join(", ")}
            </p>
          )}
          {item.entities.length > 0 && (
            <p className="small">
              <span className="muted">About:</span> {item.entities.map((e) => e.name).join(", ")}
            </p>
          )}
          {item.tags.length > 0 && (
            <p className="small">
              <span className="muted">Tags:</span> {item.tags.map((t) => `#${t}`).join(" ")}
            </p>
          )}
        </section>
      )}
      <RelatedList items={item.related} />
      <SourceLinks links={item.source_links} />
      <div className="side-block-plain">
        <AddLinkForm targetId={item.id} onAdded={reload} />
      </div>
      <Attachments targetId={item.id} assets={item.assets} onChange={reload} />
    </>
  );
}

/** Shared verify action: marks an entry still valid (applies immediately). */
function VerifyButton({ id, status, onDone }: { id: string; status: string; onDone: () => void }) {
  const [error, setError] = useState<Error | null>(null);
  if (status !== "published" && status !== "possibly_stale") return null;
  return (
    <>
      <button
        className="btn"
        title="Confirm this is still correct"
        onClick={async () => {
          setError(null);
          try {
            await verify(id);
            onDone();
          } catch (e) {
            setError(e as Error);
          }
        }}
      >
        Still valid
      </button>
      <ErrorBox error={error} />
    </>
  );
}

// Verification goes through the same core path as the MCP tool.
async function verify(id: string) {
  await api(`/verify/${id}`, { method: "POST", body: { still_valid: true } });
}

// ---- Articles ----------------------------------------------------------------

export function ArticlePage({ id, route }: { id: string; route: Route }) {
  const editing = route.path[2] === "edit";
  const section = route.query.get("section");
  const { data, error, reload } = useApi<Article>(`/articles/${id}`);

  useEffect(() => {
    if (!data || !section) return;
    const el = document.getElementById(`section-${slugify(section)}`);
    el?.scrollIntoView({ block: "start" });
  }, [data, section]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (editing) return <ArticleEditor article={data} onSaved={reload} />;

  return (
    <div className="page with-side">
      <article>
        <p className="breadcrumbs muted small">
          <a href={href(data.scope.kind === "project" ? `/project/${data.scope.slug}` : `/scope/${data.scope.slug}`)}>{data.scope.slug}</a>
          {data.path && ` / ${data.path.split("/").join(" / ")}`}
        </p>
        <h1>{data.title}</h1>
        <Meta item={data} />
        <StaleWarning status={data.status} />
        <div className="actions">
          <a className="btn" href={href(`/article/${id}/edit`)}>
            Edit
          </a>
          <VerifyButton id={id} status={data.status} onDone={reload} />
          <ShareToLibrary id={id} scopeKind={data.scope.kind} status={data.status} publishedAs={publishedAs(data)} />
        </div>
        <SectionedMarkdown body={data.body_md} />
      </article>
      <aside className="side">
        {data.sections.length > 1 && (
          <section className="side-block">
            <h3>Sections</h3>
            <ul className="plain">
              {data.sections.map((s) => (
                <li key={s}>
                  <a href={href(`/article/${id}`, { section: s })}>{s}</a>
                </li>
              ))}
            </ul>
          </section>
        )}
        <Facts item={data} reload={reload} />
      </aside>
    </div>
  );
}

function publishedAs(item: Article | Finding) {
  return item.related.find((r) => r.relation === "published_as" && r.direction === "out")?.id;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Renders markdown with an anchor before each ## section so search hits can jump to it. */
function SectionedMarkdown({ body }: { body: string }) {
  const chunks = body.split(/\n(?=#{1,2}\s)/);
  return (
    <>
      {chunks.map((chunk, i) => {
        const heading = /^#{1,2}\s+(.+?)\s*#*\s*$/m.exec(chunk.split("\n")[0] ?? "")?.[1];
        return (
          <div key={i} id={heading ? `section-${slugify(heading)}` : undefined}>
            <Markdown text={chunk} />
          </div>
        );
      })}
    </>
  );
}

function ConflictNotice({ error }: { error: Error | null }) {
  if (!(error instanceof ApiError) || error.status !== 409) return <ErrorBox error={error} />;
  return (
    <Notice kind="warn">
      Someone changed this since you opened it (now v{error.body?.current?.version}). Copy your text, reload, and re-apply your edit.
    </Notice>
  );
}

function ArticleEditor({ article, onSaved }: { article: Article; onSaved: () => void }) {
  const [title, setTitle] = useState(article.title);
  const [body, setBody] = useState(article.body_md);
  const [summary, setSummary] = useState("");
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api<WriteResult>(`/articles/${article.id}`, {
        method: "PUT",
        body: { version: article.version, summary, body_md: body, title: title !== article.title ? title : undefined },
      });
      setResult(res);
      if (res.published) {
        onSaved();
        navigate(`/article/${article.id}`);
      }
    } catch (e) {
      setError(e as Error);
    } finally {
      setSaving(false);
    }
  }

  if (result && !result.published) {
    return (
      <div className="page">
        <WriteOutcome published={false} />
        <p>
          <a href={href(`/review/${result.revision_id}`)}>View the proposal</a> · <a href={href(`/article/${article.id}`)}>Back to the article</a>
        </p>
      </div>
    );
  }

  return (
    <div className="page editor">
      <h1>Edit article</h1>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </label>
      <div className="tabs">
        <button className={!preview ? "active" : ""} onClick={() => setPreview(false)}>
          Write
        </button>
        <button className={preview ? "active" : ""} onClick={() => setPreview(true)}>
          Preview
        </button>
      </div>
      {preview ? <Markdown text={body} /> : <textarea className="body-input" value={body} onChange={(e) => setBody(e.target.value)} rows={24} />}
      <label>
        What changed (shown to reviewers and in impact notices)
        <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} placeholder="e.g. GET /orders now requires status" />
      </label>
      <ConflictNotice error={error} />
      <div className="actions">
        <button className="btn btn-primary" disabled={saving || !summary.trim()} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
        <a className="btn" href={href(`/article/${article.id}`)}>
          Cancel
        </a>
      </div>
    </div>
  );
}

// ---- Findings ----------------------------------------------------------------

export function FindingPage({ id, route }: { id: string; route: Route }) {
  const editing = route.path[2] === "edit";
  const { data, error, reload } = useApi<Finding>(`/findings/${id}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  if (editing) return <FindingEditor finding={data} onSaved={reload} />;

  return (
    <div className="page with-side">
      <article>
        <p className="breadcrumbs muted small">
          <a href={href(data.scope.kind === "project" ? `/project/${data.scope.slug}` : `/scope/${data.scope.slug}`)}>{data.scope.slug}</a> / findings
        </p>
        <h1>{data.title}</h1>
        <Meta item={data} />
        <StaleWarning status={data.status} />
        <div className="actions">
          <a className="btn" href={href(`/finding/${id}/edit`)}>
            Edit
          </a>
          <VerifyButton id={id} status={data.status} onDone={reload} />
          <ShareToLibrary id={id} scopeKind={data.scope.kind} status={data.status} publishedAs={publishedAs(data)} />
        </div>
        <h2>Symptoms</h2>
        <Markdown text={data.symptoms} />
        <h2>Root cause</h2>
        <Markdown text={data.root_cause} />
        {data.fix && (
          <>
            <h2>Fix or workaround</h2>
            <Markdown text={data.fix} />
          </>
        )}
        {data.history.length > 0 && (
          <>
            <h2>History</h2>
            <ul className="list small">
              {data.history.map((h, i) => (
                <li key={i}>
                  {formatDate(h.created_at)} · {h.op} by {h.author} · {h.state}
                  {h.reason ? ` (${h.reason})` : ""}
                </li>
              ))}
            </ul>
          </>
        )}
      </article>
      <aside className="side">
        <Facts item={data} reload={reload} />
      </aside>
    </div>
  );
}

function FindingEditor({ finding, onSaved }: { finding: Finding; onSaved: () => void }) {
  const [fields, setFields] = useState({ title: finding.title, symptoms: finding.symptoms, root_cause: finding.root_cause, fix: finding.fix });
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const set = (k: keyof typeof fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));

  async function save() {
    setError(null);
    const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== finding[k as keyof typeof fields]));
    try {
      const res = await api<WriteResult>(`/findings/${finding.id}`, { method: "PUT", body: { version: finding.version, summary, patch } });
      setResult(res);
      if (res.published) {
        onSaved();
        navigate(`/finding/${finding.id}`);
      }
    } catch (e) {
      setError(e as Error);
    }
  }

  if (result && !result.published) {
    return (
      <div className="page">
        <WriteOutcome published={false} />
        <a href={href(`/finding/${finding.id}`)}>Back to the finding</a>
      </div>
    );
  }

  return (
    <div className="page editor">
      <h1>Edit finding</h1>
      <label>
        Title
        <input value={fields.title} onChange={set("title")} maxLength={200} />
      </label>
      <label>
        Symptoms (as first observed)
        <textarea value={fields.symptoms} onChange={set("symptoms")} rows={4} />
      </label>
      <label>
        Root cause
        <textarea value={fields.root_cause} onChange={set("root_cause")} rows={4} />
      </label>
      <label>
        Fix or workaround
        <textarea value={fields.fix} onChange={set("fix")} rows={3} />
      </label>
      <label>
        What changed
        <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} />
      </label>
      <ConflictNotice error={error} />
      <div className="actions">
        <button className="btn btn-primary" disabled={!summary.trim()} onClick={save}>
          Save
        </button>
        <a className="btn" href={href(`/finding/${finding.id}`)}>
          Cancel
        </a>
      </div>
    </div>
  );
}

// ---- Creating ----------------------------------------------------------------

function ScopeSelect({ scopes, value, onChange }: { scopes: ScopeInfo[]; value: string; onChange: (v: string) => void }) {
  return (
    <label>
      Scope
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {scopes.map((s) => (
          <option key={s.slug} value={s.slug}>
            {s.name} ({s.kind})
          </option>
        ))}
      </select>
    </label>
  );
}

function ComponentPicker({ scope, value, onChange }: { scope?: ScopeInfo; value: string[]; onChange: (v: string[]) => void }) {
  if (!scope?.components.length) return null;
  return (
    <fieldset className="checks">
      <legend>Components</legend>
      {scope.components.map((c) => (
        <label key={c.slug} className="inline">
          <input
            type="checkbox"
            checked={value.includes(c.slug)}
            onChange={(e) => onChange(e.target.checked ? [...value, c.slug] : value.filter((v) => v !== c.slug))}
          />
          {c.slug}
        </label>
      ))}
    </fieldset>
  );
}

export function NewArticlePage({ route, scopes, articleTypes }: { route: Route; scopes: ScopeInfo[]; articleTypes: string[] }) {
  const [scope, setScope] = useState(route.query.get("scope") || scopes[0]?.slug || "team");
  const [type, setType] = useState(route.query.get("type") || "design_doc");
  const [title, setTitle] = useState("");
  const [path, setPath] = useState("");
  const [body, setBody] = useState("");
  const [components, setComponents] = useState<string[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const scopeInfo = scopes.find((s) => s.slug === scope);

  useEffect(() => {
    api<{ body_md: string }>(`/templates/${type}`)
      .then((t) => setBody((b) => (b.trim() === "" || /^(## .+\n\n)+$/.test(b) ? t.body_md : b)))
      .catch(() => undefined);
  }, [type]);
  useEffect(() => setComponents([]), [scope]);

  async function save() {
    setError(null);
    try {
      const res = await api<WriteResult>("/articles", { method: "POST", body: { scope, type, title, path, body_md: body, components } });
      setResult(res);
      if (res.published) navigate(`/article/${res.article_id}`);
    } catch (e) {
      setError(e as Error);
    }
  }

  if (result && !result.published) {
    return (
      <div className="page">
        <WriteOutcome published={false} />
        <a href={href(`/article/${result.article_id}`)}>View the draft</a>
      </div>
    );
  }

  return (
    <div className="page editor">
      <h1>New article</h1>
      <div className="row">
        <ScopeSelect scopes={scopes} value={scope} onChange={setScope} />
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {articleTypes.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </label>
      <label>
        Folder (optional)
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="e.g. Contracts or Systems/Payments" />
      </label>
      <ComponentPicker scope={scopeInfo} value={components} onChange={setComponents} />
      <label>
        Body (markdown; sections follow the type's template)
        <textarea className="body-input" value={body} onChange={(e) => setBody(e.target.value)} rows={22} />
      </label>
      <ErrorBox error={error} />
      <div className="actions">
        <button className="btn btn-primary" disabled={!title.trim()} onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

export function NewFindingPage({ route, scopes, findingTypes }: { route: Route; scopes: ScopeInfo[]; findingTypes: string[] }) {
  const [scope, setScope] = useState(route.query.get("scope") || scopes[0]?.slug || "team");
  const [type, setType] = useState("rca");
  const [fields, setFields] = useState({ title: "", symptoms: "", root_cause: "", fix: "" });
  const [components, setComponents] = useState<string[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const set = (k: keyof typeof fields) => (e: { target: { value: string } }) => setFields((f) => ({ ...f, [k]: e.target.value }));
  const scopeInfo = scopes.find((s) => s.slug === scope);
  useEffect(() => setComponents([]), [scope]);

  async function save(forceNew = false) {
    setError(null);
    try {
      const res = await api<WriteResult>("/findings", {
        method: "POST",
        body: { scope, type, ...fields, components, force_new: forceNew || undefined },
      });
      setResult(res);
      if (res.published) navigate(`/finding/${res.finding_id}`);
    } catch (e) {
      setError(e as Error);
    }
  }

  if (result?.status === "pending_review" && !result.published) {
    return (
      <div className="page">
        <WriteOutcome published={false} />
        <a href={href(`/finding/${result.finding_id}`)}>View the draft</a>
      </div>
    );
  }

  return (
    <div className="page editor">
      <h1>New finding</h1>
      <div className="row">
        <ScopeSelect scopes={scopes} value={scope} onChange={setScope} />
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            {findingTypes.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Title
        <input value={fields.title} onChange={set("title")} maxLength={200} />
      </label>
      <label>
        Symptoms, as first observed
        <textarea value={fields.symptoms} onChange={set("symptoms")} rows={4} placeholder="What someone searching later would type" />
      </label>
      <label>
        Root cause
        <textarea value={fields.root_cause} onChange={set("root_cause")} rows={4} />
      </label>
      <label>
        Fix or workaround
        <textarea value={fields.fix} onChange={set("fix")} rows={3} />
      </label>
      <ComponentPicker scope={scopeInfo} value={components} onChange={setComponents} />
      {result?.status === "duplicates_found" && (
        <Notice kind="warn">
          <p>These look like the same problem. Update one of them instead, or save anyway if it is different:</p>
          <ul className="plain">
            {result.duplicates?.map((d) => (
              <li key={d.id}>
                <a href={href(`/finding/${d.id}`)}>{d.title}</a> <ScopeBadge scope={d.scope} />{" "}
                <span className="muted small">{Math.round(d.overlap * 100)}% overlap</span>
              </li>
            ))}
          </ul>
          <button className="btn btn-small" onClick={() => save(true)}>
            Save anyway
          </button>
        </Notice>
      )}
      <ErrorBox error={error} />
      <div className="actions">
        <button className="btn btn-primary" disabled={!fields.title.trim() || !fields.symptoms.trim() || !fields.root_cause.trim()} onClick={() => save()}>
          Save
        </button>
      </div>
    </div>
  );
}

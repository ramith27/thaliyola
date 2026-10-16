import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Article, type Finding, type Me, type ScopeInfo, type WriteResult } from "../api";
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
import { AddLinkForm, PurgeZone, ShareToLibrary } from "../components/actions";
import { MoreActions } from "../components/more";
import { MoveItem } from "../components/move";
import { DeleteItemButton, TrashedNotice } from "./trash";
import { Attachments } from "../components/assets";
import { useApi } from "../hooks";
import { RelationsPanel } from "./graph";
import { WatchButton } from "../components/notifications";
import { FavouriteButton, recordVisit, SectionLink, ShareButton } from "../components/find";
import { clearDraft, DraftOffer, Editor, useAutosave } from "../components/editor";
import { takePrefill } from "../paste";
import { I } from "../components/icons";
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

/** Moving needs approval rights where the item is now: admins and the scope's owners. */
function canMoveFrom(me: Me | undefined, scopes: ScopeInfo[], slug: string) {
  return !!me?.admin || scopes.find((s) => s.slug === slug)?.my_role === "owner";
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
              <span className="muted">About:</span>{" "}
              {item.entities.map((e, i) => (
                <span key={`${e.kind}:${e.name}`}>
                  {i > 0 && ", "}
                  <a href={href(`/entity/${e.kind}/${e.name}`)}>{e.name}</a>
                </span>
              ))}
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

export function ArticlePage({ id, route, me, scopes = [] }: { id: string; route: Route; me?: Me; scopes?: ScopeInfo[] }) {
  const [moving, setMoving] = useState(false);
  const editing = route.path[2] === "edit";
  const section = route.query.get("section");
  const { data, error, reload } = useApi<Article>(`/articles/${id}`);

  useEffect(() => {
    if (data) recordVisit({ kind: "article", id, title: data.title, link: href(`/article/${id}`) });
  }, [data, id]);

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
          <WatchButton id={id} />
          <FavouriteButton id={id} />
          <ShareButton title={data.title} />
          <MoreActions>
            <a className="btn" href={href(`/history/${id}`)}>
              <I name="history" size={16} /> History
            </a>
            <VerifyButton id={id} status={data.status} onDone={reload} />
            <ShareToLibrary id={id} scopeKind={data.scope.kind} status={data.status} publishedAs={publishedAs(data)} />
            {canMoveFrom(me, scopes, data.scope.slug) && !moving && (
              <button className="btn" onClick={() => setMoving(true)}>
                Move…
              </button>
            )}
            {canMoveFrom(me, scopes, data.scope.slug) && data.status !== "deleted" && (
              <DeleteItemButton id={id} kind="article" title={data.title} scopeLink={href(data.scope.kind === "project" ? `/project/${data.scope.slug}` : `/scope/${data.scope.slug}`)} />
            )}
          </MoreActions>
        </div>
        {data.status === "deleted" && <TrashedNotice id={id} onRestored={reload} />}
        {moving && (
          <MoveItem
            id={id}
            kind="article"
            from={data.scope.slug}
            path={data.path}
            scopes={scopes}
            onCancel={() => setMoving(false)}
            onDone={() => window.location.reload()}
          />
        )}
        <SectionedMarkdown body={data.body_md} articleId={id} />
        <RelationsPanel id={id} />
        {me?.admin && <PurgeZone id={id} title={data.title} kind="article" />}
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
function SectionedMarkdown({ body, articleId }: { body: string; articleId: string }) {
  const chunks = body.split(/\n(?=#{1,2}\s)/);
  return (
    <>
      {chunks.map((chunk, i) => {
        const heading = /^#{1,2}\s+(.+?)\s*#*\s*$/m.exec(chunk.split("\n")[0] ?? "")?.[1];
        return (
          <div key={i} id={heading ? `section-${slugify(heading)}` : undefined} className={heading ? "section-wrap" : undefined}>
            {heading && <SectionLink link={href(`/article/${articleId}`, { section: heading })} />}
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const draftKey = `article:${article.id}:v${article.version}`;
  const autosave = useAutosave(draftKey, body, article.body_md);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api<WriteResult>(`/articles/${article.id}`, {
        method: "PUT",
        body: { version: article.version, summary, body_md: body, title: title !== article.title ? title : undefined },
      });
      clearDraft(draftKey);
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
      <DraftOffer
        offer={autosave.offer}
        onRestore={(t) => {
          setBody(t);
          autosave.dismiss();
        }}
        onDiscard={() => {
          clearDraft(draftKey);
          autosave.dismiss();
        }}
      />
      <Editor value={body} onChange={setBody} uploadTarget={article.id} rows={24} />
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

export function FindingPage({ id, route, me, scopes = [] }: { id: string; route: Route; me?: Me; scopes?: ScopeInfo[] }) {
  const [moving, setMoving] = useState(false);
  const editing = route.path[2] === "edit";
  const { data, error, reload } = useApi<Finding>(`/findings/${id}`);
  useEffect(() => {
    if (data) recordVisit({ kind: "finding", id, title: data.title, link: href(`/finding/${id}`) });
  }, [data, id]);
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
          <WatchButton id={id} />
          <FavouriteButton id={id} />
          <ShareButton title={data.title} />
          <MoreActions>
            <a className="btn" href={href(`/history/${id}`)}>
              <I name="history" size={16} /> History
            </a>
            <VerifyButton id={id} status={data.status} onDone={reload} />
            <ShareToLibrary id={id} scopeKind={data.scope.kind} status={data.status} publishedAs={publishedAs(data)} />
            {canMoveFrom(me, scopes, data.scope.slug) && !moving && (
              <button className="btn" onClick={() => setMoving(true)}>
                Move…
              </button>
            )}
            {canMoveFrom(me, scopes, data.scope.slug) && data.status !== "deleted" && (
              <DeleteItemButton id={id} kind="finding" title={data.title} scopeLink={href(data.scope.kind === "project" ? `/project/${data.scope.slug}` : `/scope/${data.scope.slug}`)} />
            )}
          </MoreActions>
        </div>
        {data.status === "deleted" && <TrashedNotice id={id} onRestored={reload} />}
        {moving && (
          <MoveItem
            id={id}
            kind="finding"
            from={data.scope.slug}
            
            scopes={scopes}
            onCancel={() => setMoving(false)}
            onDone={() => window.location.reload()}
          />
        )}
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
        <RelationsPanel id={id} />
        {me?.admin && <PurgeZone id={id} title={data.title} kind="finding" />}
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

type FindingText = { title: string; symptoms: string; root_cause: string; fix: string };

/** Title plus the three finding fields, each a compact markdown editor. */
function FindingFields({ fields, onChange, uploadTarget }: { fields: FindingText; onChange: (f: FindingText) => void; uploadTarget?: string }) {
  const set = (k: keyof FindingText) => (v: string) => onChange({ ...fields, [k]: v });
  return (
    <>
      <label>
        Title
        <input value={fields.title} onChange={(e) => set("title")(e.target.value)} maxLength={200} />
      </label>
      <div className="field">
        <span className="field-label">Symptoms, as first observed</span>
        <Editor compact label="Symptoms" value={fields.symptoms} onChange={set("symptoms")} rows={4} uploadTarget={uploadTarget} placeholder="What someone searching later would type" />
      </div>
      <div className="field">
        <span className="field-label">Root cause</span>
        <Editor compact label="Root cause" value={fields.root_cause} onChange={set("root_cause")} rows={4} uploadTarget={uploadTarget} />
      </div>
      <div className="field">
        <span className="field-label">Fix or workaround</span>
        <Editor compact label="Fix" value={fields.fix} onChange={set("fix")} rows={3} uploadTarget={uploadTarget} />
      </div>
    </>
  );
}

function FindingEditor({ finding, onSaved }: { finding: Finding; onSaved: () => void }) {
  const initial = { title: finding.title, symptoms: finding.symptoms, root_cause: finding.root_cause, fix: finding.fix ?? "" };
  const [fields, setFields] = useState<FindingText>(initial);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const draftKey = `finding:${finding.id}:v${finding.version}`;
  const autosave = useAutosave(draftKey, JSON.stringify(fields), JSON.stringify(initial));

  async function save() {
    setError(null);
    const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== finding[k as keyof typeof fields]));
    try {
      const res = await api<WriteResult>(`/findings/${finding.id}`, { method: "PUT", body: { version: finding.version, summary, patch } });
      clearDraft(draftKey);
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
      <DraftOffer
        offer={autosave.offer}
        onRestore={(t) => {
          setFields(JSON.parse(t));
          autosave.dismiss();
        }}
        onDiscard={() => {
          clearDraft(draftKey);
          autosave.dismiss();
        }}
      />
      <FindingFields fields={fields} onChange={setFields} uploadTarget={finding.id} />
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
  const [prefill] = useState(() => takePrefill("article"));
  const [scope, setScope] = useState(route.query.get("scope") || scopes[0]?.slug || "team");
  const [type, setType] = useState(prefill?.type || route.query.get("type") || "design_doc");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [path, setPath] = useState("");
  const [body, setBody] = useState(prefill?.body_md ?? "");
  const template = useRef("");
  const autosave = useAutosave("new-article", JSON.stringify({ title, body }), JSON.stringify({ title: prefill?.title ?? "", body: prefill?.body_md ?? template.current }));
  const [components, setComponents] = useState<string[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const scopeInfo = scopes.find((s) => s.slug === scope);

  // The type's template, with writing hints as HTML comments (removed on save). Only replaces an untouched body.
  useEffect(() => {
    api<{ body_md: string }>(`/templates/${type}?hints=true`)
      .then((t) => {
        setBody((b) => (b.trim() === "" || b === template.current ? t.body_md : b));
        template.current = t.body_md;
      })
      .catch(() => undefined);
  }, [type]);
  useEffect(() => setComponents([]), [scope]);

  async function save() {
    setError(null);
    try {
      const res = await api<WriteResult>("/articles", { method: "POST", body: { scope, type, title, path, body_md: body, components } });
      clearDraft("new-article");
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
      {prefill && <Notice>Drafted from pasted text. Check every section before saving.</Notice>}
      <DraftOffer
        offer={autosave.offer}
        onRestore={(t) => {
          const d = JSON.parse(t);
          setTitle(d.title);
          setBody(d.body);
          autosave.dismiss();
        }}
        onDiscard={() => {
          clearDraft("new-article");
          autosave.dismiss();
        }}
      />
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
      <div className="field">
        <span className="field-label">Body</span>
        <span className="muted small">Sections follow the type's template. The <code>{"<!-- Hint -->"}</code> lines are removed when you save. Images can be added once the article exists.</span>
        <Editor value={body} onChange={setBody} rows={22} />
      </div>
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
  const [prefill] = useState(() => takePrefill("finding"));
  const [scope, setScope] = useState(route.query.get("scope") || scopes[0]?.slug || "team");
  const [type, setType] = useState(prefill?.type ?? "rca");
  const empty = { title: prefill?.title ?? "", symptoms: prefill?.symptoms ?? "", root_cause: prefill?.root_cause ?? "", fix: prefill?.fix ?? "" };
  const [fields, setFields] = useState<FindingText>(empty);
  const autosave = useAutosave("new-finding", JSON.stringify(fields), JSON.stringify(empty));
  const [components, setComponents] = useState<string[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);
  const scopeInfo = scopes.find((s) => s.slug === scope);
  useEffect(() => setComponents([]), [scope]);

  async function save(forceNew = false) {
    setError(null);
    try {
      const res = await api<WriteResult>("/findings", {
        method: "POST",
        body: { scope, type, ...fields, components, force_new: forceNew || undefined },
      });
      if (res.status !== "duplicates_found") clearDraft("new-finding");
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
      {prefill && <Notice>Drafted from pasted text. Check the root cause and fix before saving.</Notice>}
      <DraftOffer
        offer={autosave.offer}
        onRestore={(t) => {
          setFields(JSON.parse(t));
          autosave.dismiss();
        }}
        onDiscard={() => {
          clearDraft("new-finding");
          autosave.dismiss();
        }}
      />
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
      <FindingFields fields={fields} onChange={setFields} />
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

import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, getToken, type ScopeInfo } from "../api";
import { I } from "../components/icons";
import { ErrorBox, Notice } from "../components/ui";
import { useApi } from "../hooks";
import { href, navigate } from "../router";

// ---- First-run checklist -------------------------------------------------------

interface Step {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  link: string;
}

/** The checklist, or `fallback` once it's finished or hidden. */
export function Checklist({ fallback = null }: { fallback?: ReactNode }) {
  const { data, reload } = useApi<{ steps: Step[]; dismissed: boolean }>("/onboarding");
  if (!data) return null;
  if (data.dismissed || data.steps.every((s) => s.done)) return <>{fallback}</>;
  const done = data.steps.filter((s) => s.done).length;
  return (
    <section className="card checklist" aria-label="Getting started">
      <div className="checklist-head">
        <div>
          <h3>Get set up</h3>
          <p className="muted small">
            {done} of {data.steps.length} done
          </p>
        </div>
        <div className="checklist-bar" role="progressbar" aria-valuemin={0} aria-valuemax={data.steps.length} aria-valuenow={done}>
          <span style={{ width: `${(done / data.steps.length) * 100}%` }} />
        </div>
        <button
          className="link-btn small"
          onClick={async () => {
            await api("/account/prefs", { method: "PUT", body: { onboarding_dismissed: true } });
            reload();
          }}
        >
          Hide
        </button>
      </div>
      <ol className="plain checklist-steps">
        {data.steps.map((s) => (
          <li key={s.key} className={s.done ? "done" : ""}>
            <span className="check" aria-hidden="true">
              {s.done ? <I name="review" size={16} /> : null}
            </span>
            <div>
              {s.done ? (
                <span className="step-title">{s.title}</span>
              ) : (
                <a className="step-title" href={s.link} target={s.link.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
                  {s.title}
                </a>
              )}
              {!s.done && <div className="muted small">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---- New project with a starter pack ------------------------------------------------

const REPO_KINDS = ["backend", "frontend", "mobile", "data", "infra", "other"] as const;
type RepoRow = { url: string; slug: string; kind: string };
const repoName = (url: string) => (url.replace(/(\.git)?\/*$/, "").split(/[/:]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");

export function NewProjectPage() {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [repos, setRepos] = useState<RepoRow[]>([{ url: "", slug: "", kind: "backend" }]);
  const [starter, setStarter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const autoSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const finalSlug = slug || autoSlug;
  const filled = repos.filter((r) => r.url.trim() || r.slug.trim());
  const kinds = new Set(filled.map((r) => r.kind));
  const setRepo = (i: number, patch: Partial<RepoRow>) => setRepos((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="page editor">
      <h1>New project</h1>
      <p className="lead">A project holds the design docs, contracts, decisions and findings for one product or service, with its own members, teams and settings.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api("/projects", {
              method: "POST",
              body: {
                slug: finalSlug,
                name,
                description: description || undefined,
                components: filled.map((r) => ({ slug: r.slug || repoName(r.url) || r.kind, kind: r.kind, repo_url: r.url.trim() || undefined })),
                starter,
              },
            });
            navigate(`/scope/${finalSlug}/settings`, { tab: "access" });
            window.location.reload();
          } catch (err) {
            setError(err as Error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="row">
          <label>
            Name
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Order service v2" maxLength={200} />
          </label>
          <label>
            Short name (used in links and by Claude)
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={autoSlug || "order-service"} pattern="[a-z0-9][a-z0-9-]*" />
          </label>
        </div>
        <label>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does, in one line" />
        </label>
        <div className="field">
          <span className="field-label">Repositories</span>
          <span className="muted small">All the codebases in this project. A Claude session in any of them finds the project on its own. You can add more later.</span>
          {repos.map((r, i) => (
            <div key={i} className="repo-row">
              <input value={r.url} onChange={(e) => setRepo(i, { url: e.target.value })} placeholder="https://github.com/acme/orders-api" aria-label={`Repository ${i + 1} URL`} />
              <input value={r.slug} onChange={(e) => setRepo(i, { slug: e.target.value })} placeholder={repoName(r.url) || "name"} aria-label={`Repository ${i + 1} name`} pattern="[a-z0-9][a-z0-9-]*" />
              <select value={r.kind} onChange={(e) => setRepo(i, { kind: e.target.value })} aria-label={`Repository ${i + 1} kind`}>
                {REPO_KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
              <button type="button" className="link-btn small danger" onClick={() => setRepos((rs) => rs.filter((_, j) => j !== i))} aria-label="Remove repository">
                Remove
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-small" onClick={() => setRepos((rs) => [...rs, { url: "", slug: "", kind: "frontend" }])}>
              Add another repository
            </button>
          </div>
        </div>
        <label className="inline starter-toggle">
          <input type="checkbox" checked={starter} onChange={(e) => setStarter(e.target.checked)} />
          <span>
            <strong>Add a starter pack</strong>
            <span className="muted small">
              {" "}
              Outlines for a project overview, a design doc and an on-call runbook
              {kinds.has("backend") && (kinds.has("frontend") || kinds.has("mobile")) ? ", plus the API contract between backend and client (so contract changes notify the client side)" : ""}. Each
              section says what to write.
            </span>
          </span>
        </label>
        <ErrorBox error={error} />
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={busy || !name.trim()}>
            {busy ? "Creating…" : "Create project"}
          </button>
          <a className="btn" href={href("/")}>
            Cancel
          </a>
        </div>
        <p className="muted small">Next you'll add the people and teams who work on it.</p>
      </form>
    </div>
  );
}

// ---- Import --------------------------------------------------------------------------

interface ImportPreview {
  dry_run: boolean;
  format: string;
  pages: { title: string; path: string; source: string; chars: number; images: number; warnings: string[] }[];
  skipped: { file: string; reason: string }[];
  imported?: { title: string; id: string; published: boolean; revision_id: string }[];
  failed?: { title: string; error: string }[];
}

const FORMAT_TEXT: Record<string, string> = { notion: "Notion export", confluence: "Confluence export", zip: "zip of pages", html: "HTML page", markdown: "Markdown" };

async function upload(file: File, query: Record<string, string>) {
  const headers: Record<string, string> = { "content-type": "application/octet-stream", accept: "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`/api/import?${new URLSearchParams({ ...query, filename: file.name })}`, { method: "POST", headers, body: file, credentials: "same-origin" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.error ?? res.statusText, body);
  return body as ImportPreview;
}

export function ImportPage({ scopes, articleTypes }: { scopes: ScopeInfo[]; articleTypes: string[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [scope, setScope] = useState(scopes.find((s) => s.kind === "team")?.slug ?? scopes[0]?.slug ?? "team");
  const [type, setType] = useState("design_doc");
  const [folder, setFolder] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const query = { scope, type, ...(folder ? { folder } : {}) };

  useEffect(() => {
    setPreview(null);
    setResult(null);
    if (!file) return;
    setBusy(true);
    setError(null);
    upload(file, { ...query, dry_run: "true" })
      .then(setPreview)
      .catch(setError)
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, folder]);

  return (
    <div className="page page-wide editor">
      <h1>Import documents</h1>
      <p className="lead">
        Bring existing docs into Thaliyola: Markdown or HTML files, or a zip of them. Notion (Export → Markdown &amp; CSV), Confluence (Space export → HTML) and Google Docs
        (Download → Web page) exports work as they are. Images in the zip become attachments; secrets are redacted.
      </p>
      <div className="row">
        <label>
          Into
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            {scopes.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          As
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
        Folder (optional)
        <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. Imported/Confluence" />
      </label>
      <label
        className={`dropzone ${file ? "has-file" : ""}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) setFile(f);
        }}
      >
        <input type="file" accept=".zip,.md,.markdown,.txt,.html,.htm" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <I name="inbox" size={22} />
        <span>{file ? `${file.name} (${Math.ceil(file.size / 1024)} KB)` : "Drop a file here, or choose one"}</span>
      </label>
      <ErrorBox error={error} />
      {busy && <p className="muted">Reading…</p>}

      {preview && !result && (
        <section>
          <h2>
            {preview.pages.length} page{preview.pages.length === 1 ? "" : "s"} found <span className="muted small">{FORMAT_TEXT[preview.format] ?? preview.format}</span>
          </h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Folder</th>
                  <th className="num">Size</th>
                  <th className="num">Images</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {preview.pages.map((p) => (
                  <tr key={p.source}>
                    <td>{p.title}</td>
                    <td className="muted">{p.path || "—"}</td>
                    <td className="num">{Math.ceil(p.chars / 100) / 10}k</td>
                    <td className="num">{p.images || ""}</td>
                    <td className="small warn">{p.warnings.join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.skipped.length > 0 && (
            <details className="small">
              <summary>{preview.skipped.length} file(s) skipped</summary>
              <ul>
                {preview.skipped.map((s) => (
                  <li key={s.file}>
                    {s.file}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="actions">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setResult(await upload(file!, query));
                } catch (err) {
                  setError(err as Error);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Import {preview.pages.length} page{preview.pages.length === 1 ? "" : "s"}
            </button>
            <span className="muted small">If you can't approve in {scope}, they go to review first.</span>
          </div>
        </section>
      )}

      {result && (
        <section>
          <Notice kind={result.failed?.length ? "warn" : "ok"}>
            Imported {result.imported?.length ?? 0}
            {result.imported?.some((i) => !i.published) ? `; ${result.imported.filter((i) => !i.published).length} waiting for review` : ""}
            {result.failed?.length ? `; ${result.failed.length} failed` : ""}.
          </Notice>
          <ul className="plain import-results">
            {result.imported?.map((i) => (
              <li key={i.id}>
                <a href={href(`/article/${i.id}`)}>{i.title}</a> {!i.published && <span className="badge badge-pending">in review</span>}
              </li>
            ))}
            {result.failed?.map((f) => (
              <li key={f.title} className="error small">
                {f.title}: {f.error}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---- Export --------------------------------------------------------------------------

export function ExportButton({ scope, label = "Export as Markdown", site = false }: { scope?: string; label?: string; site?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const token = getToken();
          const res = await fetch(`/api/export${site ? "/site" : ""}${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
          if (!res.ok) throw new Error(`export failed (${res.status})`);
          const url = URL.createObjectURL(await res.blob());
          const a = document.createElement("a");
          a.href = url;
          a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? (site ? "thaliyola-site.zip" : "thaliyola-export.zip");
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } finally {
          setBusy(false);
        }
      }}
    >
      <I name="doc" size={16} /> {busy ? "Exporting…" : label}
    </button>
  );
}

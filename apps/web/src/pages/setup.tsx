import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, canIn, getToken, may, type Me, type ScopeInfo } from "../api";
import { useBoot } from "../components/boot";
import { I } from "../components/icons";
import { humanize, plural, REPO_KIND, typeLabel } from "../components/labels";
import { can } from "../components/permissions";
import {
  Badge,
  Button,
  Callout,
  Checkbox,
  ChoiceCards,
  DataTable,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  FileDrop,
  focusFirstInvalid,
  FormActions,
  FormSection,
  IconButton,
  ListRow,
  Page,
  PageHeader,
  ProjectPicker,
  RowList,
  Select,
  SkeletonRows,
  Stepper,
  TextInput,
  useToast,
  type Crumb,
} from "../components/kit";
import { useAppRoute, useDebouncedValue } from "../hooks";
import { href, navigate } from "../router";

// ---- New project with a starter pack ------------------------------------------------

const REPO_KINDS = ["backend", "frontend", "mobile", "data", "infra", "other"] as const;
const KIND_OPTIONS = REPO_KINDS.map((k) => ({ value: k, label: REPO_KIND[k] ?? humanize(k) }));
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
type RepoRow = { id: number; url: string; slug: string; kind: string };
const repoName = (url: string) => (url.replace(/(\.git)?\/*$/, "").split(/[/:]/).pop() ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
/** A blank row with the next free id (pure, so StrictMode's double-run updaters can't give two rows one id). */
const newRow = (rows: RepoRow[], kind: string): RepoRow => ({ id: rows.reduce((m, r) => Math.max(m, r.id), 0) + 1, url: "", slug: "", kind });

/** The projects above one, top first. */
function chain(scope: ScopeInfo | undefined, scopes: ScopeInfo[]): ScopeInfo[] {
  const bySlug = new Map(scopes.map((s) => [s.slug, s]));
  const out: ScopeInfo[] = [];
  for (let p = scope, guard = 0; p && guard < 10; guard++) {
    out.unshift(p);
    p = p.parent ? bySlug.get(p.parent) : undefined;
  }
  return out;
}

export function NewProjectPage({ me, scopes = [], parent: initialParent }: { me: Me; scopes?: ScopeInfo[]; parent?: string }) {
  const boot = useBoot();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  // Possible parents: projects whose settings the person manages (Manage settings), in tree order.
  const parents = scopes.filter((s) => s.kind === "project" && canIn(s, "manage_settings", me));
  // Without Create projects (Administrators, Project creators), people can only add sub-projects to projects they manage.
  const creator = may(me, "create_projects");
  const fromParent = initialParent && parents.some((p) => p.slug === initialParent) ? initialParent : undefined;
  const [parent, setParent] = useState(fromParent ?? (creator ? "" : (parents[0]?.slug ?? "")));
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [repos, setRepos] = useState<RepoRow[]>([{ id: 1, url: "", slug: "", kind: "backend" }]);
  const [starter, setStarter] = useState(true);
  const [visibility, setVisibility] = useState(me.default_project_visibility ?? "members");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<{ name?: string; slug?: string; repos?: Record<number, string> }>({});
  const autoSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const finalSlug = slugEdited ? slug.trim() : autoSlug;
  const filled = repos.filter((r) => r.url.trim() || r.slug.trim());
  const kinds = new Set(filled.map((r) => r.kind));
  const contract = kinds.has("backend") && (kinds.has("frontend") || kinds.has("mobile"));
  const setRepo = (id: number, patch: Partial<RepoRow>) => setRepos((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const parentScope = scopes.find((s) => s.slug === fromParent);
  const listAccess = can.manageProjectsList(me, scopes);
  const crumbs: Crumb[] = parentScope
    ? chain(parentScope, scopes).map((s) => ({ label: s.name, href: href(`/project/${s.slug}`) }))
    : listAccess
      ? [{ label: "Admin", href: href("/admin") }, { label: "Projects", href: href("/admin/projects") }]
      : [];
  const cancelHref = parentScope ? href(`/project/${parentScope.slug}`) : listAccess ? href("/admin/projects") : href("/");

  if (!creator && !parents.length)
    return (
      <Page width="form">
        <PageHeader title="New project" crumbs={crumbs} hideTabBar />
        <EmptyState
          variant="locked"
          title="You can't create projects"
          description="Creating projects needs Create projects (Administrators and Project creators have it), or Manage settings in a project to add a sub-project to it. Ask an Administrator or a Project creator, or a team lead to start one for their team. Claude's create_project files a request for you."
          primary={<Button href={href("/teams")}>Teams</Button>}
          secondary={
            <Button variant="ghost" href={href("/roles")}>
              What the roles allow
            </Button>
          }
        />
      </Page>
    );

  async function submit(e: FormEvent) {
    e.preventDefault();
    const repoErrors: Record<number, string> = {};
    for (const r of filled) if (r.slug.trim() && !SLUG_PATTERN.test(r.slug.trim())) repoErrors[r.id] = "Use lowercase letters, numbers and dashes.";
    const next = {
      name: name.trim() ? undefined : "Give the project a name.",
      slug: !name.trim() && !slugEdited ? undefined : !finalSlug ? "Give it a short name." : !SLUG_PATTERN.test(finalSlug) ? "Use lowercase letters, numbers and dashes, starting with a letter or number." : undefined,
      repos: Object.keys(repoErrors).length ? repoErrors : undefined,
    };
    setErrors(next);
    if (next.name || next.slug || next.repos) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/projects", {
        method: "POST",
        body: {
          slug: finalSlug,
          name: name.trim(),
          description: description || undefined,
          components: filled.map((r) => ({ slug: r.slug.trim() || repoName(r.url) || r.kind, kind: r.kind, repo_url: r.url.trim() || undefined })),
          starter,
          visibility,
          parent: parent || undefined,
        },
      });
      await boot.reloadScopes().catch(() => undefined);
      navigate(`/scope/${finalSlug}/settings`, { tab: "access" });
      toast.success("Project created", { description: "Now add the people who work on it." });
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Page width="form">
      <PageHeader
        title="New project"
        crumbs={crumbs}
        description="A project holds the knowledge, members and repositories for one product or service."
        scope={fromParent}
        hideTabBar
      />
      <form ref={formRef} className="pj-form" onSubmit={(e) => void submit(e)} noValidate>
        <FormSection title="Basics">
          <Field label="Name" error={errors.name}>
            <TextInput value={name} onChange={(e) => (setName(e.target.value), setErrors((x) => ({ ...x, name: undefined })))} placeholder="Order service v2" maxLength={200} autoFocus />
          </Field>
          <Field
            label="Short name"
            error={errors.slug}
            hint={
              <>
                Used in links and by Claude; it can't change later. Link: <code>#/project/{finalSlug || "…"}</code>
              </>
            }
          >
            <TextInput
              value={finalSlug}
              onChange={(e) => (setSlugEdited(true), setSlug(e.target.value), setErrors((x) => ({ ...x, slug: undefined })))}
              placeholder="order-service"
             
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Description" optional>
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does, in one line" maxLength={2000} />
          </Field>
        </FormSection>

        {parents.length > 0 && (
          <FormSection title="Part of" description="A sub-project of a product or system. Everyone with a role there gets the same role here.">
            <Field
              label="Parent project"
              hint={creator ? undefined : "You can add sub-projects to projects you manage. Ask an Administrator or a Project creator to create a top-level project."}
            >
              <ProjectPicker
                searchable
                value={parent}
                onChange={setParent}
                scopes={scopes}
                includeSpaces={false}
                filter={(s) => parents.some((p) => p.slug === s.slug)}
                noneLabel={creator ? "Nothing: a top-level project" : undefined}
              />
            </Field>
          </FormSection>
        )}

        <FormSection title="Repositories" description="All the codebases in this project. A Claude session in any of them finds the project on its own. You can add more later.">
          <div className="pj-repo-rows">
            <div className="pj-repo-row pj-repo-head" aria-hidden="true">
              <span>URL</span>
              <span>Short name</span>
              <span>Kind</span>
              <span />
            </div>
            {repos.map((r, i) => {
              const onlyEmpty = repos.length === 1 && !r.url && !r.slug;
              const err = errors.repos?.[r.id];
              return (
                <div key={r.id} className="pj-repo-row" data-invalid={err ? true : undefined}>
                  <TextInput
                    value={r.url}
                    onChange={(e) => setRepo(r.id, { url: e.target.value })}
                    placeholder="https://github.com/acme/orders-api"
                    aria-label={`Repository ${i + 1} URL`}
                    inputMode="url"
                  />
                  <TextInput
                    value={r.slug}
                    onChange={(e) => (setRepo(r.id, { slug: e.target.value }), setErrors((x) => ({ ...x, repos: undefined })))}
                    placeholder={repoName(r.url) || "short name"}
                    aria-label={`Repository ${i + 1} short name`}
                    aria-invalid={err ? true : undefined}
                   
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <Select value={r.kind} onChange={(e) => setRepo(r.id, { kind: e.target.value })} aria-label={`Repository ${i + 1} kind`} options={KIND_OPTIONS} />
                  <span className="pj-repo-remove">
                    {!onlyEmpty && <IconButton icon="x" label={`Remove repository ${i + 1}`} size="sm" onClick={() => setRepos((rs) => (rs.length === 1 ? [newRow(rs, "backend")] : rs.filter((x) => x.id !== r.id)))} />}
                  </span>
                  {err && (
                    <p className="field-error pj-repo-error">
                      <I name="alert" size={14} />
                      {err}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <div>
            <Button size="sm" icon="plus" onClick={() => setRepos((rs) => [...rs, newRow(rs, "frontend")])}>
              Add another repository
            </Button>
          </div>
        </FormSection>

        <FormSection title="Who can see it">
          <ChoiceCards
            name="pj-new-visibility"
            legend="Who can see it"
            legendHidden
            value={visibility}
            onChange={(v) => setVisibility(v as "members" | "team")}
            options={[
              {
                value: "members",
                label: "Members only",
                icon: "lock",
                description: "Only the people and teams you add next, and people who can see every project (Administrators, Auditors), can see it.",
              },
              { value: "team", label: "Everyone in Thaliyola", icon: "globe", description: "Anyone signed in can read it; members decide who writes and approves." },
            ]}
          />
        </FormSection>

        <FormSection title="Starter pack">
          <Checkbox
            checked={starter}
            onChange={(e) => setStarter(e.target.checked)}
            label="Add a starter pack"
            description={
              <span className="pj-starter">
                <span>Outlines where each section says what to write:</span>
                <span className="pj-badges">
                  <Badge>Project overview</Badge>
                  <Badge>Design doc</Badge>
                  <Badge>On-call runbook</Badge>
                  {contract && <Badge tone="accent">API contract</Badge>}
                </span>
                {contract && <span>The API contract sits between the backend and its clients, so contract changes notify the client side.</span>}
              </span>
            }
          />
        </FormSection>

        {error ? <ErrorState compact error={error} title="Couldn't create the project" /> : null}
        <FormActions sticky hint="Next you'll add the people and teams who work on it.">
          <Button variant="ghost" href={cancelHref}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText="Creating">
            Create project
          </Button>
        </FormActions>
      </form>
    </Page>
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

const size = (chars: number) => (chars < 1000 ? `${chars} characters` : `${(Math.round(chars / 100) / 10).toLocaleString("en-GB")}k characters`);

export function ImportPage({ scopes, articleTypes }: { scopes: ScopeInfo[]; articleTypes: string[] }) {
  const route = useAppRoute();
  const { me } = useBoot();
  const asked = route.query.get("scope");
  const fallback = scopes.find((s) => s.kind === "team")?.slug ?? scopes[0]?.slug ?? "team";
  const [file, setFile] = useState<File | null>(null);
  const [scope, setScope] = useState(asked && scopes.some((s) => s.slug === asked) ? asked : fallback);
  const [type, setType] = useState(articleTypes.includes("design_doc") ? "design_doc" : (articleTypes[0] ?? "design_doc"));
  const [folder, setFolder] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  // Any change re-runs the dry run, 400ms after the last one.
  const current = JSON.stringify({ scope, type, folder });
  const options = useDebouncedValue(current, 400);
  // Between a change and its dry run the preview describes the old options: dim it and hold the Import button.
  const refreshing = checking || (!!file && options !== current);
  const query = { scope, type, ...(folder ? { folder } : {}) };
  const into = scopes.find((s) => s.slug === scope);
  const publishes = !!into && can.publishIn(into, me);

  useEffect(() => {
    if (!file) return;
    let stale = false;
    const o = JSON.parse(options) as { scope: string; type: string; folder: string };
    setChecking(true);
    setError(null);
    upload(file, { scope: o.scope, type: o.type, ...(o.folder ? { folder: o.folder } : {}), dry_run: "true" })
      .then((p) => !stale && setPreview(p))
      .catch((e) => !stale && setError(e))
      .finally(() => !stale && setChecking(false));
    return () => {
      stale = true;
    };
  }, [file, options, attempt]);

  async function runImport() {
    if (!file) return;
    setImporting(true);
    setError(null);
    try {
      setResult(await upload(file, query));
    } catch (e) {
      setError(e);
    } finally {
      setImporting(false);
    }
  }

  function again() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
  }

  const n = preview?.pages.length ?? 0;
  const crumbs: Crumb[] = asked && into && into.slug === asked ? [{ label: into.name, href: href(into.kind === "project" ? `/project/${into.slug}` : `/scope/${into.slug}`) }] : [];
  const waiting = result?.imported?.filter((i) => !i.published).length ?? 0;

  const review = file && !result && (
    <div className="pj-stack">
      <div className="pj-import-options">
        <Field label="Into">
          <ProjectPicker searchable value={scope} onChange={setScope} scopes={scopes} />
        </Field>
        <Field label="As">
          <Select value={type} onChange={(e) => setType(e.target.value)} options={articleTypes.map((t) => ({ value: t, label: typeLabel(t) }))} />
        </Field>
        <Field label="Folder" optional>
          <TextInput value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="e.g. Imported/Confluence" />
        </Field>
      </div>
      {error ? <ErrorState compact error={error} title="Couldn't read the file" onRetry={() => setAttempt((a) => a + 1)} /> : null}
      {!preview && checking && <SkeletonRows count={3} />}
      {preview && (
        <div className="async-block" aria-busy={refreshing || undefined} data-refreshing={refreshing || undefined}>
          <div className="pj-stack">
          <p className="pj-preview-line">
            <strong>{plural(n, "page")}</strong> · {FORMAT_TEXT[preview.format] ?? preview.format}
          </p>
          <DataTable
            caption="Pages that will be imported"
            rows={preview.pages}
            getRowId={(p) => p.source}
            density="compact"
            columns={[
              { key: "title", header: "Title", primary: true, cell: (p) => p.title },
              { key: "folder", header: "Folder", cell: (p) => p.path || <span className="muted">—</span> },
              { key: "size", header: "Size", numeric: true, cell: (p) => size(p.chars) },
              { key: "images", header: "Images", numeric: true, cell: (p) => p.images || "" },
              {
                key: "notes",
                header: "Notes",
                cell: (p) =>
                  p.warnings.length ? (
                    <span className="pj-warn">
                      <I name="alert" size={14} /> {p.warnings.join("; ")}
                    </span>
                  ) : (
                    ""
                  ),
              },
            ]}
            empty={<EmptyState variant="compact" icon="doc" title="No pages found in this file" description="Choose a Markdown or HTML file, or a zip of them." />}
          />
          {preview.skipped.length > 0 && (
            <Disclosure summary={`${plural(preview.skipped.length, "file")} skipped`}>
              <ul className="pj-plain-list">
                {preview.skipped.map((s) => (
                  <li key={s.file}>
                    <code>{s.file}</code>: {s.reason}
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          {n > 0 && (
            <FormActions
              hint={
                publishes
                  ? `These will be published in ${into?.name ?? scope}.`
                  : `These go to review first: you can't approve in ${into?.name ?? scope}, so a Reviewer or Project admin there approves them.`
              }
            >
              <Button variant="ghost" onClick={again} disabled={importing}>
                Choose another file
              </Button>
              <Button variant="primary" icon="upload" loading={importing} loadingText={`Importing ${plural(n, "page")}`} disabled={refreshing} onClick={() => void runImport()}>
                Import {plural(n, "page")}
              </Button>
            </FormActions>
          )}
          </div>
        </div>
      )}
    </div>
  );

  const done = result && (
    <div className="pj-stack">
      <Callout tone={result.failed?.length ? "warning" : "success"} title={`Imported ${plural(result.imported?.length ?? 0, "page")}`}>
        {[waiting ? `${waiting} waiting for review` : "", result.failed?.length ? `${result.failed.length} failed` : ""].filter(Boolean).join("; ") || "All published."}
      </Callout>
      {(result.imported?.length ?? 0) + (result.failed?.length ?? 0) > 0 && (
        <RowList label="Imported pages" density="compact">
          {result.imported?.map((i) => (
            <ListRow
              key={i.id}
              leading={<I name="doc" size={16} />}
              title={i.title}
              href={href(`/article/${i.id}`)}
              badges={
                !i.published && (
                  <Badge tone="warning" icon="clock">
                    In review
                  </Badge>
                )
              }
            />
          ))}
          {result.failed?.map((f) => <ListRow key={f.title} leading={<I name="alert" size={16} />} title={f.title} error={f.error} />)}
        </RowList>
      )}
      <div className="actions">
        {into && (
          <Button variant="primary" href={href(into.kind === "project" ? `/project/${into.slug}` : `/scope/${into.slug}`)}>
            Open {into.kind === "personal" ? "your personal space" : into.name}
          </Button>
        )}
        {waiting > 0 && <Button href={href("/review", { scope })}>Go to Review</Button>}
        <Button variant="ghost" icon="upload" onClick={again}>
          Import another file
        </Button>
      </div>
    </div>
  );

  return (
    <Page width="content">
      <PageHeader
        title="Import documents"
        crumbs={crumbs}
        scope={asked && into?.slug === asked ? asked : undefined}
        description="Bring existing docs into Thaliyola: Markdown or HTML files, or a zip of them. Images in the zip become attachments; secrets are redacted."
        hideTabBar
      />
      <Stepper
        steps={[
          {
            id: "file",
            title: "Choose file",
            status: file ? "done" : "current",
            content: !result && (
              <div className="pj-stack">
                <FileDrop
                  label="File to import"
                  accept=".zip,.md,.markdown,.txt,.html,.htm"
                  file={file}
                  onFile={(f) => (setFile(f), setPreview(null), setResult(null), setError(null))}
                  busy={checking}
                  busyText="Reading file"
                  hint=".zip, .md, .markdown, .txt, .html or .htm"
                />
                <Disclosure summary="Exporting from Notion, Confluence or Google Docs">
                  <ul className="pj-plain-list">
                    <li>Notion: Export → Markdown &amp; CSV.</li>
                    <li>Confluence: Space export → HTML.</li>
                    <li>Google Docs: Download → Web page.</li>
                  </ul>
                  <p className="pj-note">These exports work as they are; upload the zip.</p>
                </Disclosure>
              </div>
            ),
          },
          { id: "review", title: "Review", status: result ? "done" : file ? "current" : "todo", content: review || undefined },
          { id: "done", title: "Done", status: result ? "current" : "todo", content: done || undefined },
        ]}
      />
    </Page>
  );
}

// ---- Export --------------------------------------------------------------------------

export function ExportButton({ scope, label = "Export as Markdown", site = false }: { scope?: string; label?: string; site?: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function run() {
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
      toast.success("Download started");
    } catch (e) {
      toast.error(e, { title: "Couldn't export", action: { label: "Try again", onClick: () => void run() } });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button icon="download" loading={busy} loadingText="Exporting" onClick={() => void run()}>
      {label}
    </Button>
  );
}

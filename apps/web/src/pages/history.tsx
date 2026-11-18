import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type WriteResult } from "../api";
import { AsyncBlock, Badge, Button, DiffView, EmptyState, ErrorState, Field, Page, PageHeader, PersonChip, projectSwitcher, RelativeTime, Select, SkeletonRows, SkeletonText, useConfirm, useToast, type Crumb } from "../components/kit";
import { useBoot } from "../components/boot";
import { useApi } from "../hooks";
import { href } from "../router";

interface VersionList {
  kind: "article" | "finding";
  id: string;
  title: string;
  current_version: number;
  can_restore: boolean;
  versions: {
    version: number;
    title: string;
    summary: string;
    created_at: string;
    author: string | null;
    approver: string | null;
    /** Articles: the version's tags, and what it added and removed against the one before (none for old snapshots). */
    tags?: string[] | null;
    tags_added?: string[];
    tags_removed?: string[];
  }[];
}

interface Version {
  kind: "article" | "finding";
  version: number;
  title: string;
  content: { body_md?: string; symptoms?: string; root_cause?: string; fix?: string | null; tags?: string[] };
}

/** The parts of a version that are compared, each with its label. Articles: title and body; findings: each field. */
function parts(v: Version | null): { key: string; label: string; text: string; markdown: boolean }[] {
  if (!v) return [];
  if (v.kind === "article")
    return [
      { key: "title", label: "Title", text: v.title, markdown: false },
      { key: "body", label: "Body", text: v.content.body_md ?? "", markdown: true },
      // Versions saved since 1.1.0 keep the article's tags.
      { key: "tags", label: "Tags", text: (v.content.tags ?? []).map((t) => `#${t}`).join(" "), markdown: false },
    ];
  const c = v.content;
  return [
    { key: "title", label: "Title", text: v.title, markdown: false },
    { key: "symptoms", label: "Symptoms", text: c.symptoms ?? "", markdown: true },
    { key: "root_cause", label: "Root cause", text: c.root_cause ?? "", markdown: true },
    { key: "fix", label: "Fix or workaround", text: c.fix ?? "", markdown: true },
    { key: "tags", label: "Tags", text: (c.tags ?? []).map((t) => `#${t}`).join(" "), markdown: false },
  ];
}

const person = (who: string) => (who.includes("@") ? { email: who } : { name: who });

export function HistoryPage({ id }: { id: string }) {
  const list = useApi<VersionList>(`/items/${id}/versions`);
  const kind = list.data?.kind;
  // The item itself, for the breadcrumb and the sidebar highlight.
  const item = useApi<{ title: string; scope: { slug: string; kind: string }; path?: string }>(kind ? `/${kind}s/${id}` : null);
  const [picked, setPicked] = useState<number | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const toast = useToast();
  const listRef = useRef<HTMLUListElement>(null);
  const boot = useBoot();

  const d = list.data;
  const versions = d?.versions ?? [];
  const selected = picked ?? versions[0]?.version ?? null;
  const previous = versions.find((v) => selected !== null && v.version < selected)?.version ?? null;
  const against = compare ?? previous;
  const a = useApi<Version>(selected !== null ? `/items/${id}/versions/${selected}` : null);
  const b = useApi<Version>(against !== null ? `/items/${id}/versions/${against}` : null);

  const title = d?.title ?? item.data?.title ?? "";
  const scope = item.data?.scope;
  const crumbs: Crumb[] = [];
  if (scope)
    crumbs.push({
      label: boot.scope(scope.slug)?.name ?? scope.slug,
      href: href(scope.kind === "project" ? `/project/${scope.slug}` : `/scope/${scope.slug}`),
      switcher: scope.kind === "project" ? projectSwitcher(boot.scopes, scope.slug, (s) => href(`/project/${s}`)) : undefined,
    });
  if (d) crumbs.push({ label: d.title, href: href(`/${d.kind}/${id}`) });

  function select(v: number) {
    setPicked(v);
    setCompare(null);
  }

  function onListKey(e: ReactKeyboardEvent<HTMLUListElement>) {
    if (!versions.length || selected === null) return;
    const i = versions.findIndex((v) => v.version === selected);
    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? versions.length - 1 : null;
    if (next === null || next < 0 || next >= versions.length) return;
    e.preventDefault();
    select(versions[next]!.version);
    listRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  async function restore(version: number) {
    if (!d) return;
    const next = d.current_version + 1;
    if (d.can_restore) {
      const ok = await confirm({
        title: `Restore version ${version} as a new version (${next})?`,
        body: "Nothing is lost: the current text stays in the history.",
        confirmLabel: `Restore version ${version}`,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const res = await api<WriteResult>(`/items/${id}/restore`, { method: "POST", body: { version } });
      setPicked(null);
      setCompare(null);
      list.reload();
      if (res.published) toast.success(`Restored as version ${next}`, { link: { label: "View", href: href(`/${d.kind}/${id}`) } });
      else toast.success("Restore proposed for review", { link: { label: "Open proposal", href: href(`/review/${res.revision_id}`) } });
    } catch (e) {
      toast.error(e, { title: `Couldn't restore version ${version}` });
    } finally {
      setBusy(false);
    }
  }

  const sel = versions.find((v) => v.version === selected);
  const restoreButton =
    d && selected !== null && selected !== d.current_version ? (
      d.can_restore ? (
        <Button variant="primary" icon="undo" loading={busy} loadingText="Restoring" onClick={() => void restore(selected)}>
          Restore version {selected}…
        </Button>
      ) : (
        <Button icon="undo" loading={busy} loadingText="Proposing" onClick={() => void restore(selected)}>
          Propose restoring version {selected}
        </Button>
      )
    ) : null;

  const diffParts = (() => {
    const after = parts(a.data);
    const before = against !== null ? parts(b.data) : [];
    return after.map((p) => ({ ...p, before: before.find((x) => x.key === p.key)?.text ?? "" }));
  })();
  const diffReady = a.data?.version === selected && (against === null || b.data?.version === against);

  return (
    <Page width="wide">
      <PageHeader
        crumbs={crumbs}
        title="Version history"
        documentTitle={title ? `Version history · ${title}` : "Version history"}
        description="Every published version is kept. Restoring creates a new version."
        scope={scope?.slug ?? null}
      />
      <AsyncBlock
        result={list}
        label="Loading versions"
        skeleton={<SkeletonRows count={4} />}
        isEmpty={(x) => !x.versions.length}
        empty={<EmptyState icon="history" title="No published versions yet" description="Versions appear here once a change is published." />}
      >
        {(data) => (
          <div className="it-history">
            <nav className="it-history-nav" aria-label="Versions">
              <ul ref={listRef} className="it-version-list" onKeyDown={onListKey}>
                {data.versions.map((v) => {
                  const current = v.version === selected;
                  return (
                    <li key={v.version}>
                      <button type="button" className="it-version" aria-current={current ? "true" : undefined} onClick={() => select(v.version)}>
                        <span className="it-version-head">
                          <span className="it-version-number">Version {v.version}</span>
                          {v.version === data.current_version && (
                            <Badge tone="accent" variant="outline">
                              Current
                            </Badge>
                          )}
                        </span>
                        <span className="it-version-summary" data-empty={!v.summary || undefined}>
                          {v.summary || "No summary"}
                        </span>
                        <span className="it-version-meta">
                          {v.author ? <PersonChip size="sm" {...person(v.author)} /> : <span>Imported</span>}
                          <RelativeTime date={v.created_at} />
                        </span>
                        {v.approver && v.approver !== v.author && <span className="it-version-approver">
                            approved by <PersonChip size="sm" {...person(v.approver)} />
                          </span>}
                        {(v.tags_added?.length || v.tags_removed?.length) ? (
                          <span className="it-version-tags small">
                            {[...(v.tags_added ?? []).map((t) => `+#${t}`), ...(v.tags_removed ?? []).map((t) => `−#${t}`)].join(" ")}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
            <section className="it-history-pane" aria-labelledby="it-history-pane-title">
              <div className="it-history-pane-head">
                <h2 id="it-history-pane-title" className="it-history-pane-title">
                  {selected === null ? "" : against !== null ? `Version ${selected} compared with version ${against}` : `Version ${selected} (first version)`}
                </h2>
                {restoreButton}
              </div>
              <div className="it-history-controls">
                {data.versions.length > 1 && selected !== null && (
                  <Field label="Compare with" className="it-history-compare">
                    <Select
                      value={against === null ? "" : String(against)}
                      onChange={(e) => setCompare(e.target.value === "" ? null : Number(e.target.value))}
                      options={[
                        // With no older version, the default is to show the selected one as new. Keep that choice in the list so the
                        // select shows what the pane shows, and so every other version fires a change when picked.
                        ...(previous === null ? [{ value: "", label: "Nothing (show as new)" }] : []),
                        ...data.versions
                          .filter((v) => v.version !== selected)
                          .map((v) => ({ value: String(v.version), label: `Version ${v.version}${v.version === previous ? " (previous)" : ""}${v.version === data.current_version ? " (current)" : ""}` })),
                      ]}
                    />
                  </Field>
                )}
                {sel && sel.title !== title && <p className="it-history-title-note">Title then: {sel.title}</p>}
              </div>
              {a.error || b.error ? (
                <ErrorState
                  error={a.error ?? b.error}
                  title="Couldn't load this version"
                  onRetry={() => {
                    a.reload();
                    b.reload();
                  }}
                />
              ) : !diffReady ? (
                <div aria-busy="true">
                  <span className="sr-only" role="status">
                    Loading the comparison
                  </span>
                  <SkeletonText lines={8} />
                </div>
              ) : (
                <div className="it-history-diffs">
                  {diffParts
                    .filter((p) => p.key === "body" || p.text !== p.before || against === null)
                    .filter((p) => p.text || p.before)
                    .map((p) => (
                      <div key={p.key} className="it-history-diff">
                        <h3 className="it-history-part">{p.label}</h3>
                        {against === null && !p.markdown ? (
                          <p className="it-history-plain">{p.text}</p>
                        ) : (
                        <DiffView
                          before={p.before}
                          after={p.text}
                          markdown={p.markdown}
                          mode={p.markdown ? mode : "source"}
                          onModeChange={setMode}
                          showModeToggle={p.markdown && (p.key === "body" || p.key === "symptoms")}
                          isNew={against === null}
                          labels={against !== null ? { before: `Version ${against}`, after: `Version ${selected}` } : undefined}
                        />
                        )}
                      </div>
                    ))}
                  {diffParts.every((p) => p.text === p.before) && against !== null && <p className="it-history-same">These two versions have the same text.</p>}
                </div>
              )}
            </section>
          </div>
        )}
      </AsyncBlock>
    </Page>
  );
}

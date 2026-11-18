/**
 * What's new and features (#/whats-new): Thaliyola's release notes and its feature catalog. Tools area (tl-).
 *
 * - Latest: the newest published release, its features grouped by area.
 * - All releases: a timeline of versions; ?release=x.y.z opens one.
 * - Feature catalog: every feature ever added, by area, searchable and filterable, each with "Added in vX.Y.Z".
 *
 * Administrators and people with Manage releases also see drafts and write here: New release, Add feature, edit,
 * reorder, screenshots, publish and unpublish. Opening the page marks the newest release as seen (the Help dot).
 */
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, fileToBase64 } from "../api";
import { AssetImage } from "../components/assets";
import { useBoot } from "../components/boot";
import { can } from "../components/permissions";
import {
  AREAS,
  AUDIENCES,
  byArea,
  countsText,
  isVersion,
  KIND_TONE,
  KINDS,
  latestPublished,
  matchFeatures,
  nextMinor,
  normalizeRoute,
  parseTags,
  releaseDate,
  versionText,
  type Audience,
  type Feature,
  type FeatureArea,
  type FeatureKind,
  type Release,
  type ReleaseList,
} from "../components/releases";
import { Markdown } from "../components/ui";
import {
  AsyncBlock,
  Badge,
  Button,
  Callout,
  Card,
  Chip,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  FileDrop,
  FilterBar,
  IconButton,
  OverflowMenu,
  Page,
  PageHeader,
  SegmentedControl,
  Select,
  SkeletonRows,
  Switch,
  Tabs,
  Textarea,
  TextInput,
  useConfirm,
  useToast,
  type MenuItemSpec,
} from "../components/kit";
import { useApi, useAppRoute, useQueryState } from "../hooks";
import { href } from "../router";

type Tab = "latest" | "releases" | "catalog";
const TABS: { id: Tab; label: string }[] = [
  { id: "latest", label: "Latest" },
  { id: "releases", label: "All releases" },
  { id: "catalog", label: "Feature catalog" },
];

const areaOptions = (empty?: string) => [...(empty ? [{ value: "", label: empty }] : []), ...Object.entries(AREAS).map(([value, label]) => ({ value, label }))];
const kindOptions = (empty?: string) => [...(empty ? [{ value: "", label: empty }] : []), ...Object.entries(KINDS).map(([value, label]) => ({ value, label }))];
const audienceOptions = Object.entries(AUDIENCES).map(([value, label]) => ({ value, label }));

/** What a manager does to a release's features; the page reloads after each. */
interface Manage {
  release: Release;
  onChanged: () => void;
}

export function WhatsNewPage() {
  const route = useAppRoute();
  const [q, setQ] = useQueryState(route, { tab: "latest", release: "", q: "", area: "", kind: "", drafts: "" });
  const { me, updateMe } = useBoot();
  const manage = can.manageReleases(me);
  const result = useApi<ReleaseList>("/releases?features=true");
  const [creating, setCreating] = useState(false);
  const tab = (TABS.some((t) => t.id === q.tab) ? q.tab : "latest") as Tab;

  // Seen: the Help dot and the sidebar's "New" go away once the newest release has been opened here.
  const unseen = !!me.whats_new?.unseen;
  useEffect(() => {
    if (!unseen) return;
    api("/releases/seen", { method: "POST", body: {} })
      .then((status) => updateMe({ whats_new: status }))
      .catch(() => undefined);
  }, [unseen, updateMe]);

  const releases = result.data?.releases ?? [];
  const latest = latestPublished(releases);
  const newestDraft = releases.find((r) => r.status === "draft" && (!latest || releases.indexOf(r) < releases.indexOf(latest)));

  return (
    <Page width="content">
      <PageHeader
        title="What's new and features"
        icon="sparkle"
        nav="whats-new"
        description="Every Thaliyola release, and how to use each feature."
        meta={me.build ? <span className="tl-wn-meta">You're on Thaliyola {versionText(me.build)}</span> : undefined}
        primary={
          manage ? (
            <Button variant="primary" icon="plus" aria-haspopup="dialog" onClick={() => setCreating(true)}>
              New release
            </Button>
          ) : undefined
        }
        tabs={
          <Tabs
            label="What's new"
            idPrefix="tl-wn"
            value={tab}
            onChange={(id) => setQ({ tab: id, release: undefined }, { push: true })}
            items={TABS}
          />
        }
      />
      <div role="tabpanel" id={`tl-wn-panel-${tab}`} aria-labelledby={`tl-wn-tab-${tab}`} className="tl-tabpanel">
        <AsyncBlock result={result} label="Loading what's new" skeleton={<SkeletonRows count={4} />}>
          {(data) => (
            <div className="tl-stack-lg">
              {manage && newestDraft && tab !== "releases" && (
                <Callout
                  tone="info"
                  title={`Thaliyola ${newestDraft.version} is a draft`}
                  actions={
                    <Button size="sm" href={href("/whats-new", { tab: "releases", release: newestDraft.version })}>
                      Edit and publish
                    </Button>
                  }
                >
                  Only Administrators and people with Manage releases see it. {countsText(newestDraft.counts)} so far.
                </Callout>
              )}
              {tab === "latest" &&
                (latest ? (
                  <ReleaseView release={latest} manage={manage ? { release: latest, onChanged: result.reload } : null} releases={data.releases} headingLevel={2} />
                ) : (
                  <EmptyState icon="sparkle" title="No release notes yet" description={manage ? "Publish a release to tell everyone what's new." : "When a new version of Thaliyola is released, what changed shows up here."} />
                ))}
              {tab === "releases" && (
                <ReleasesTab
                  releases={data.releases}
                  selected={q.release ?? ""}
                  current={data.current?.version}
                  manage={manage}
                  onChanged={result.reload}
                  onCreate={() => setCreating(true)}
                />
              )}
              {tab === "catalog" && <CatalogTab releases={data.releases} manage={manage} q={q} setQ={setQ} onChanged={result.reload} />}
            </div>
          )}
        </AsyncBlock>
      </div>
      {manage && (
        <ReleaseDialog
          open={creating}
          suggested={nextMinor(releases[0]?.version)}
          onClose={() => setCreating(false)}
          onSaved={(r) => {
            setCreating(false);
            result.reload();
            setQ({ tab: "releases", release: r.version }, { push: true });
          }}
        />
      )}
    </Page>
  );
}
WhatsNewPage.keepMountedOnQuery = true;

// ---- One release ----------------------------------------------------------------------------------------------

/** "Thaliyola 1.0.0: Connections and Skills"; a title that only repeats the name ("Thaliyola 1.0") is left out. */
function releaseHeading(r: Release) {
  return r.title && !/^thaliyola\b/i.test(r.title.trim()) ? `Thaliyola ${r.version}: ${r.title}` : `Thaliyola ${r.version}`;
}

function ReleaseMeta({ r }: { r: Release }) {
  return (
    <span className="tl-row tl-wn-release-meta">
      {r.status === "draft" ? <Badge tone="warning">Draft</Badge> : <Badge tone="success">Published</Badge>}
      {r.released_on && <span>{releaseDate(r.released_on)}</span>}
      <span>{countsText(r.counts)}</span>
    </span>
  );
}

/** A release: heading, summary, its features by area; for managers the editing controls. */
function ReleaseView({ release, manage, releases, headingLevel = 2 }: { release: Release; manage: Manage | null; releases: Release[]; headingLevel?: 2 | 3 }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const features = release.features ?? [];
  const H = headingLevel === 2 ? "h2" : "h3";

  async function act(what: "publish" | "unpublish" | "delete") {
    if (!manage) return;
    if (what === "publish") {
      const ok = await confirm({
        title: `Publish Thaliyola ${release.version}?`,
        body: release.published_at
          ? "Everyone can read it again. Nobody is notified a second time."
          : `Everyone can read it, and everyone signed in gets a notification: “Thaliyola ${release.version}: ${countsText(release.counts)}”.`,
        confirmLabel: "Publish",
      });
      if (!ok) return;
    }
    if (what === "unpublish") {
      const ok = await confirm({ title: `Unpublish Thaliyola ${release.version}?`, body: "It goes back to a draft that only release managers see.", confirmLabel: "Unpublish" });
      if (!ok) return;
    }
    if (what === "delete") {
      const ok = await confirm({
        title: `Delete the draft ${release.version}?`,
        body: `Its ${features.length === 1 ? "feature" : `${features.length} features`} and their screenshots go too. This can't be undone.`,
        confirmLabel: "Delete",
        tone: "danger",
      });
      if (!ok) return;
    }
    setBusy(what);
    try {
      const path = `/releases/${release.version}`;
      if (what === "delete") await api(path, { method: "DELETE" });
      else {
        const r = await api<{ notified?: number }>(`${path}/${what}`, { method: "POST" });
        if (what === "publish") toast.success(`Published Thaliyola ${release.version}${r.notified ? `: ${r.notified === 1 ? "1 person" : `${r.notified} people`} notified` : ""}`);
        else toast.success(`Thaliyola ${release.version} is a draft again`);
      }
      if (what === "delete") toast.success(`Deleted the draft ${release.version}`);
      manage.onChanged();
    } catch (e) {
      toast.error(e, { title: `Couldn't ${what} ${release.version}` });
    } finally {
      setBusy(null);
    }
  }

  async function move(f: Feature, delta: -1 | 1) {
    if (!manage) return;
    const ids = features.map((x) => x.id);
    const i = ids.indexOf(f.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    try {
      await api(`/releases/${release.version}/features/order`, { method: "PUT", body: { ids } });
      manage.onChanged();
    } catch (e) {
      toast.error(e, { title: "Couldn't reorder the features" });
    }
  }

  const menu: MenuItemSpec[] = manage
    ? [
        { id: "edit", label: "Edit release", icon: "pencil", onSelect: () => setEditing(true) },
        { id: "add", label: "Add feature", icon: "plus", onSelect: () => setAdding(true) },
        ...(release.status === "published"
          ? [{ type: "separator" as const }, { id: "unpublish", label: "Unpublish", icon: "eye-off" as const, onSelect: () => void act("unpublish") }]
          : [{ type: "separator" as const }, { id: "delete", label: "Delete draft…", icon: "trash" as const, tone: "danger" as const, onSelect: () => void act("delete") }]),
      ]
    : [];

  return (
    <article className="tl-wn-release" aria-labelledby={`tl-wn-r-${release.version}`}>
      <header className="tl-wn-release-head">
        <div className="tl-wn-release-title">
          <H id={`tl-wn-r-${release.version}`} className="tl-wn-h">
            {releaseHeading(release)}
          </H>
          <ReleaseMeta r={release} />
        </div>
        {manage && (
          <div className="tl-row-actions">
            {release.status === "draft" && (
              <Button
                variant="primary"
                size="sm"
                icon="check"
                loading={busy === "publish"}
                loadingText="Publishing"
                disabledReason={features.length ? undefined : "Add a feature first"}
                onClick={() => void act("publish")}
              >
                Publish
              </Button>
            )}
            <Button size="sm" icon="plus" aria-haspopup="dialog" onClick={() => setAdding(true)}>
              Add feature
            </Button>
            <OverflowMenu size="sm" label={`More actions for ${release.version}`} items={menu} />
          </div>
        )}
      </header>
      {editing && manage ? (
        <ReleaseEditor
          release={release}
          onDone={(saved) => {
            setEditing(false);
            if (saved) manage.onChanged();
          }}
        />
      ) : (
        release.summary && (
          <div className="tl-wn-summary">
            <Markdown text={release.summary} />
          </div>
        )
      )}
      {manage && release.status === "draft" && !editing && (
        <Callout tone="info">
          A draft: only Administrators and people with Manage releases see it.{" "}
          {release.source === "changelog" ? "It was drafted from CHANGELOG.md, one feature per bullet: check each one's area, wording and how-to before publishing." : ""}
        </Callout>
      )}
      {features.length === 0 ? (
        <EmptyState
          variant="compact"
          icon="sparkle"
          title="No features yet"
          description={manage ? "Add what this release brings, with how to use it." : undefined}
          primary={
            manage ? (
              <Button icon="plus" onClick={() => setAdding(true)}>
                Add feature
              </Button>
            ) : undefined
          }
        />
      ) : (
        byArea(features).map((g) => (
          <section key={g.area} className="tl-wn-area" aria-labelledby={`tl-wn-${release.version}-${g.area}`}>
            <h3 id={`tl-wn-${release.version}-${g.area}`} className="tl-wn-area-title">
              {AREAS[g.area]} <span className="tl-wn-count">{g.items.length}</span>
            </h3>
            <ul className="plain tl-wn-features">
              {g.items.map((f) => (
                <li key={f.id}>
                  <FeatureCard
                    feature={f}
                    manage={manage}
                    releases={releases}
                    howToOpen={false}
                    onMove={(d) => void move(f, d)}
                    first={features[0]?.id === f.id}
                    last={features[features.length - 1]?.id === f.id}
                  />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {manage && (
        <FeatureDialog
          open={adding}
          version={release.version}
          releases={releases}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            manage.onChanged();
          }}
        />
      )}
    </article>
  );
}

/** Inline edit of a release: version, title, date and the summary with a preview. */
function ReleaseEditor({ release, onDone }: { release: Release; onDone: (saved: boolean) => void }) {
  const toast = useToast();
  const [version, setVersion] = useState(release.version);
  const [title, setTitle] = useState(release.title);
  const [date, setDate] = useState(release.released_on ?? "");
  const [summary, setSummary] = useState(release.summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const badVersion = !isVersion(version);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (badVersion) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/releases/${release.version}`, { method: "PATCH", body: { version: version.trim(), title, summary, released_on: date || null } });
      toast.success(`Saved Thaliyola ${version.trim()}`);
      onDone(true);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Card as="section" title="Edit release" titleLevel={3} className="tl-wn-editor">
      <form className="tl-stack" noValidate onSubmit={save}>
        <div className="tl-wn-form-row">
          <Field label="Version" hint="major.minor.patch" error={badVersion ? "Use a version like 1.2.0" : null}>
            <TextInput value={version} onChange={(e) => setVersion(e.target.value)} inputMode="decimal" maxLength={20} required />
          </Field>
          <Field label="Release date" optional hint="Set when it's published, if empty.">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Title" optional counter={{ value: title.length, max: 200 }}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <MarkdownField label="Summary" optional value={summary} onChange={setSummary} max={8000} rows={5} hint="Markdown. Shown above the features." />
        {!!error && <ErrorState compact error={error} title="Couldn't save the release" />}
        <div className="tl-row tl-wn-form-actions">
          <Button variant="ghost" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText="Saving" disabledReason={badVersion ? "Fix the version" : undefined}>
            Save release
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ---- One feature ----------------------------------------------------------------------------------------------

function FeatureCard({
  feature: f,
  manage,
  releases,
  showVersion,
  howToOpen,
  onMove,
  first,
  last,
}: {
  feature: Feature;
  manage: Manage | null;
  releases: Release[];
  showVersion?: boolean;
  howToOpen?: boolean;
  onMove?: (delta: -1 | 1) => void;
  first?: boolean;
  last?: boolean;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [shooting, setShooting] = useState(false);

  async function remove() {
    if (!manage) return;
    const ok = await confirm({ title: `Remove “${f.title}”?`, body: `It leaves Thaliyola ${f.version}'s notes and the catalog.`, confirmLabel: "Remove", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/features/${f.id}`, { method: "DELETE" });
      toast.success(`Removed ${f.title}`);
      manage.onChanged();
    } catch (e) {
      toast.error(e, { title: `Couldn't remove ${f.title}` });
    }
  }

  async function removeShot(id: string, name: string) {
    if (!manage) return;
    const ok = await confirm({ title: `Remove ${name}?`, confirmLabel: "Remove", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/assets/${id}`, { method: "DELETE" });
      manage.onChanged();
    } catch (e) {
      toast.error(e, { title: `Couldn't remove ${name}` });
    }
  }

  const items: MenuItemSpec[] = manage
    ? [
        { id: "edit", label: "Edit", icon: "pencil", onSelect: () => setEditing(true) },
        { id: "shot", label: "Add screenshot", icon: "image", onSelect: () => setShooting(true) },
        ...(onMove
          ? [
              { id: "up", label: "Move up", icon: "chevron-left" as const, disabledReason: first ? "Already first" : undefined, onSelect: () => onMove(-1) },
              { id: "down", label: "Move down", icon: "chevron-right" as const, disabledReason: last ? "Already last" : undefined, onSelect: () => onMove(1) },
            ]
          : []),
        { type: "separator" },
        { id: "remove", label: "Remove…", icon: "trash", tone: "danger", onSelect: () => void remove() },
      ]
    : [];

  return (
    <Card as="article" padding="md" className="tl-wn-feature">
      <div className="tl-wn-feature-head">
        <h4 className="tl-wn-feature-title">{f.title}</h4>
        {manage && <OverflowMenu size="sm" label={`Actions for ${f.title}`} items={items} />}
      </div>
      <div className="tl-row tl-wn-badges">
        <Badge tone={KIND_TONE[f.kind]}>{f.kind_name}</Badge>
        {showVersion && (
          <a className="tl-wn-added" href={href("/whats-new", { tab: "releases", release: f.version })}>
            <Badge tone="neutral" variant="outline">
              Added in v{f.version}
            </Badge>
          </a>
        )}
        {showVersion && f.release_status === "draft" && <Badge tone="warning">Draft</Badge>}
        {f.audience !== "everyone" && (
          <Badge tone="neutral" icon="key" title="Who it's for">
            For {f.audience_name}
          </Badge>
        )}
      </div>
      {f.description && (
        <div className="tl-wn-text">
          <Markdown text={f.description} />
        </div>
      )}
      {f.screenshots.length > 0 && (
        <ul className="plain tl-wn-shots">
          {f.screenshots.map((s) => (
            <li key={s.id} className="tl-wn-shot">
              <AssetImage id={s.id} alt={s.alt_text || `${f.title}: screenshot`} />
              {manage && <IconButton icon="x" size="sm" label={`Remove ${s.filename}`} onClick={() => void removeShot(s.id, s.filename)} />}
            </li>
          ))}
        </ul>
      )}
      {f.how_to && (
        <Disclosure summary="How to use it" defaultOpen={howToOpen} className="tl-wn-howto">
          <div className="tl-wn-text">
            <Markdown text={f.how_to} />
          </div>
        </Disclosure>
      )}
      {(f.app_route || f.docs_url || f.tags.length > 0) && (
        <div className="tl-row tl-wn-links">
          {f.app_route && (
            <Button size="sm" icon="arrow" href={f.app_route}>
              Open it
            </Button>
          )}
          {f.docs_url && (
            <Button size="sm" variant="ghost" icon="book" href={f.docs_url} external>
              Docs
            </Button>
          )}
          {f.tags.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
      )}
      {manage && (
        <>
          <FeatureDialog
            open={editing}
            version={f.version}
            feature={f}
            releases={releases}
            onClose={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              manage.onChanged();
            }}
          />
          <ScreenshotDialog
            open={shooting}
            feature={f}
            onClose={() => setShooting(false)}
            onUploaded={() => {
              setShooting(false);
              manage.onChanged();
            }}
          />
        </>
      )}
    </Card>
  );
}

// ---- All releases -----------------------------------------------------------------------------------------------

function ReleasesTab({
  releases,
  selected,
  current,
  manage,
  onChanged,
  onCreate,
}: {
  releases: Release[];
  selected: string;
  current?: string;
  manage: boolean;
  onChanged: () => void;
  onCreate: () => void;
}) {
  const open = selected ? releases.find((r) => r.version === selected) : null;
  if (selected && !open) {
    return (
      <EmptyState
        icon="sparkle"
        title={`No release ${selected}`}
        description="It may not be published yet, or the version changed."
        primary={<Button href={href("/whats-new", { tab: "releases" })}>All releases</Button>}
      />
    );
  }
  if (open) {
    return (
      <div className="tl-stack">
        <a className="tl-wn-back" href={href("/whats-new", { tab: "releases" })}>
          ← All releases
        </a>
        <ReleaseView release={open} manage={manage ? { release: open, onChanged } : null} releases={releases} headingLevel={2} />
      </div>
    );
  }
  if (!releases.length) {
    return (
      <EmptyState
        icon="sparkle"
        title="No releases yet"
        description={manage ? "Start one for the version you're preparing." : "Releases show up here once they're published."}
        primary={
          manage ? (
            <Button variant="primary" icon="plus" onClick={onCreate}>
              New release
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <ol className="plain tl-wn-timeline" aria-label="Releases, newest first">
      {releases.map((r) => (
        <li key={r.id} className="tl-wn-step" data-draft={r.status === "draft" || undefined}>
          <span className="tl-wn-node" aria-hidden="true" />
          <Card
            as="article"
            padding="md"
            title={`Thaliyola ${r.version}`}
            titleLevel={2}
            description={r.title && !/^thaliyola\b/i.test(r.title) ? r.title : undefined}
            href={href("/whats-new", { tab: "releases", release: r.version })}
            className="tl-wn-step-card"
          >
            <span className="tl-row">
              <ReleaseMeta r={r} />
              {r.version === current && <Badge tone="accent">Running now</Badge>}
            </span>
            {r.summary && <p className="tl-wn-step-summary">{firstLine(r.summary)}</p>}
          </Card>
        </li>
      ))}
    </ol>
  );
}

/** The summary's first paragraph, as plain text, cut to a line or two. */
function firstLine(md: string) {
  const p = md.split(/\n\s*\n/)[0]!.replace(/[*_`#>]/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  return p.length > 220 ? `${p.slice(0, 217).replace(/\s+\S*$/, "")}…` : p;
}

// ---- The feature catalog ----------------------------------------------------------------------------------------

function CatalogTab({
  releases,
  manage,
  q,
  setQ,
  onChanged,
}: {
  releases: Release[];
  manage: boolean;
  q: Record<string, string>;
  setQ: (patch: Record<string, string | undefined>) => void;
  onChanged: () => void;
}) {
  const drafts = manage && q.drafts === "1";
  const area = (q.area && q.area in AREAS ? q.area : "") as FeatureArea | "";
  const kind = (q.kind && q.kind in KINDS ? q.kind : "") as FeatureKind | "";
  const all = useMemo(() => releases.filter((r) => drafts || r.status === "published").flatMap((r) => r.features ?? []), [releases, drafts]);
  const shown = useMemo(() => matchFeatures(all, q.q ?? "").filter((f) => (!area || f.area === area) && (!kind || f.kind === kind)), [all, q.q, area, kind]);
  const groups = byArea(shown);
  const active = [
    ...(area ? [{ id: "area", label: `Area: ${AREAS[area]}`, onRemove: () => setQ({ area: undefined }) }] : []),
    ...(kind ? [{ id: "kind", label: `Kind: ${KINDS[kind]}`, onRemove: () => setQ({ kind: undefined }) }] : []),
  ];

  return (
    <div className="tl-stack-lg">
      <FilterBar
        search={{ value: q.q ?? "", onChange: (v) => setQ({ q: v || undefined }), label: "Search features", placeholder: "Search features" }}
        filters={
          <>
            <Field label="Area" labelHidden>
              <Select aria-label="Area" value={area} onChange={(e) => setQ({ area: e.target.value || undefined })} options={areaOptions("Every area")} />
            </Field>
            <Field label="Kind" labelHidden>
              <Select aria-label="Kind" value={kind} onChange={(e) => setQ({ kind: e.target.value || undefined })} options={kindOptions("New, improved and fixed")} />
            </Field>
            {manage && <Switch checked={drafts} onChange={(on) => setQ({ drafts: on ? "1" : undefined })} label="Include drafts" />}
          </>
        }
        active={active}
        onClearAll={active.length ? () => setQ({ area: undefined, kind: undefined }) : undefined}
        result={<span>{shown.length === 1 ? "1 feature" : `${shown.length} features`}</span>}
      />
      {groups.length === 0 ? (
        <EmptyState
          icon="search"
          title={all.length ? "No feature matches" : "No features yet"}
          description={all.length ? "Try other words, or every area." : "Features appear here once their release is published."}
          primary={
            all.length && (q.q || area || kind) ? (
              <Button onClick={() => setQ({ q: undefined, area: undefined, kind: undefined })}>Clear search and filters</Button>
            ) : undefined
          }
        />
      ) : (
        groups.map((g) => (
          <section key={g.area} className="tl-wn-area" aria-labelledby={`tl-wn-cat-${g.area}`}>
            <h2 id={`tl-wn-cat-${g.area}`} className="tl-wn-area-title tl-wn-area-title-lg">
              {AREAS[g.area]} <span className="tl-wn-count">{g.items.length}</span>
            </h2>
            <ul className="plain tl-wn-features">
              {g.items.map((f) => {
                const release = releases.find((r) => r.id === f.release_id);
                return (
                  <li key={f.id}>
                    <FeatureCard feature={f} manage={manage && release ? { release, onChanged } : null} releases={releases} showVersion howToOpen={!!q.q} />
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}

// ---- Forms ------------------------------------------------------------------------------------------------------

/** A markdown textarea with Write / Preview. */
function MarkdownField({
  label,
  value,
  onChange,
  max,
  rows = 6,
  hint,
  optional,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  rows?: number;
  hint?: ReactNode;
  optional?: boolean;
  required?: boolean;
}) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  return (
    <div className="tl-wn-md">
      <div className="tl-wn-md-switch">
        <SegmentedControl size="sm" label={`${label}: write or preview`} value={mode} onChange={setMode} options={[{ value: "write", label: "Write" }, { value: "preview", label: "Preview" }]} />
      </div>
      {mode === "write" ? (
        <Field label={label} hint={hint} optional={optional} counter={{ value: value.length, max }}>
          <Textarea value={value} onChange={(e) => onChange(e.target.value)} autoGrow minRows={rows} maxRows={18} maxLength={max} required={required} />
        </Field>
      ) : (
        <div className="tl-wn-preview" aria-label={`${label}: preview`} role="region">
          <span className="tl-wn-preview-label">{label}</span>
          {value.trim() ? <Markdown text={value} /> : <p className="muted">Nothing to preview yet.</p>}
        </div>
      )}
    </div>
  );
}

/** New release: version (the next minor by default), title, date and summary. */
function ReleaseDialog({ open, suggested, onClose, onSaved }: { open: boolean; suggested: string; onClose: () => void; onSaved: (r: Release) => void }) {
  const [version, setVersion] = useState(suggested);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setVersion(suggested);
      setTitle("");
      setSummary("");
      setError(null);
      setTried(false);
    }
  }, [open, suggested]);
  const bad = !isVersion(version);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (bad) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Release>("/releases", { method: "POST", body: { version: version.trim(), title: title || undefined, summary: summary || undefined } });
      setBusy(false);
      onSaved(r);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      dismissible={!busy}
      title="New release"
      description="It starts as a draft only release managers see. Add its features, then publish it."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="tl-wn-new-release" loading={busy} loadingText="Creating">
            Create draft
          </Button>
        </>
      }
    >
      <form id="tl-wn-new-release" className="tl-stack" noValidate onSubmit={submit}>
        <Field label="Version" hint="major.minor.patch, e.g. 1.1.0" error={tried && bad ? "Use a version like 1.2.0" : null}>
          <TextInput value={version} onChange={(e) => setVersion(e.target.value)} inputMode="decimal" maxLength={20} required autoFocus />
        </Field>
        <Field label="Title" optional hint="A few words, e.g. “Connections and Skills”." counter={{ value: title.length, max: 200 }}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <MarkdownField label="Summary" optional value={summary} onChange={setSummary} max={8000} rows={3} hint="Markdown." />
        {!!error && <ErrorState compact error={error} title="Couldn't create the release" />}
      </form>
    </Dialog>
  );
}

interface FeatureDraft {
  title: string;
  area: FeatureArea;
  kind: FeatureKind;
  audience: Audience;
  description: string;
  how_to: string;
  app_route: string;
  docs_url: string;
  tags: string;
  release: string;
}

const draftOf = (f: Feature | undefined, version: string): FeatureDraft => ({
  title: f?.title ?? "",
  area: f?.area ?? "knowledge",
  kind: f?.kind ?? "new",
  audience: f?.audience ?? "everyone",
  description: f?.description ?? "",
  how_to: f?.how_to ?? "",
  app_route: f?.app_route ?? "",
  docs_url: f?.docs_url ?? "",
  tags: f?.tags.join(", ") ?? "",
  release: version,
});

/** Add or edit a feature: what it is, how to use it, where it lives, who it's for. */
function FeatureDialog({
  open,
  version,
  feature,
  releases,
  onClose,
  onSaved,
}: {
  open: boolean;
  version: string;
  feature?: Feature;
  releases: Release[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [d, setD] = useState<FeatureDraft>(() => draftOf(feature, version));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (open) {
      setD(draftOf(feature, version));
      setError(null);
      setTried(false);
    }
  }, [open, feature, version]);
  const set = <K extends keyof FeatureDraft>(k: K, v: FeatureDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const titleMissing = !d.title.trim();
  const badDocs = !!d.docs_url.trim() && !/^https?:\/\/\S+$/i.test(d.docs_url.trim());
  const formId = `tl-wn-feature-${feature?.id ?? "new"}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTried(true);
    if (titleMissing || badDocs) return;
    setBusy(true);
    setError(null);
    const body = {
      title: d.title.trim(),
      area: d.area,
      kind: d.kind,
      audience: d.audience,
      description: d.description,
      how_to: d.how_to,
      app_route: normalizeRoute(d.app_route) || null,
      docs_url: d.docs_url.trim() || null,
      tags: parseTags(d.tags),
    };
    try {
      if (feature) await api(`/features/${feature.id}`, { method: "PATCH", body: { ...body, ...(d.release !== feature.version ? { release: d.release } : {}) } });
      else await api(`/releases/${version}/features`, { method: "POST", body });
      toast.success(feature ? `Saved ${body.title}` : `Added ${body.title} to ${version}`);
      setBusy(false);
      onSaved();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => !busy && onClose()}
      dismissible={!busy}
      size="lg"
      title={feature ? `Edit “${feature.title}”` : `Add a feature to ${version}`}
      description="Say what it does and how to use it: where to find it and the steps."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Saving">
            {feature ? "Save feature" : "Add feature"}
          </Button>
        </>
      }
    >
      <form id={formId} className="tl-stack" noValidate onSubmit={submit}>
        <Field label="Title" error={tried && titleMissing ? "Give the feature a title" : null} counter={{ value: d.title.length, max: 200 }}>
          <TextInput value={d.title} onChange={(e) => set("title", e.target.value)} maxLength={200} required autoFocus />
        </Field>
        <div className="tl-wn-form-row">
          <Field label="Area">
            <Select value={d.area} onChange={(e) => set("area", e.target.value as FeatureArea)} options={areaOptions()} />
          </Field>
          <Field label="Kind">
            <Select value={d.kind} onChange={(e) => set("kind", e.target.value as FeatureKind)} options={kindOptions()} />
          </Field>
          <Field label="For" hint="Informational: everyone can read it.">
            <Select value={d.audience} onChange={(e) => set("audience", e.target.value as Audience)} options={audienceOptions} />
          </Field>
        </div>
        <MarkdownField label="What it does" value={d.description} onChange={(v) => set("description", v)} max={20000} rows={4} hint="Markdown." />
        <MarkdownField label="How to use it" value={d.how_to} onChange={(v) => set("how_to", v)} max={20000} rows={4} hint="Markdown: where to find it, then the steps (1. 2. 3.)." />
        <div className="tl-wn-form-row">
          <Field label="In-app link" optional hint="A route, e.g. #/admin/audit">
            <TextInput value={d.app_route} onChange={(e) => set("app_route", e.target.value)} placeholder="#/admin/audit" maxLength={300} />
          </Field>
          <Field label="Docs link" optional error={tried && badDocs ? "Use an http(s) address" : null}>
            <TextInput type="url" value={d.docs_url} onChange={(e) => set("docs_url", e.target.value)} placeholder="https://" maxLength={500} />
          </Field>
        </div>
        <div className="tl-wn-form-row">
          <Field label="Tags" optional hint="Comma-separated, at most 12.">
            <TextInput value={d.tags} onChange={(e) => set("tags", e.target.value)} maxLength={600} />
          </Field>
          {feature && (
            <Field label="Release" hint="Move it to another release.">
              <Select value={d.release} onChange={(e) => set("release", e.target.value)} options={releases.map((r) => ({ value: r.version, label: `${r.version}${r.status === "draft" ? " (draft)" : ""}` }))} />
            </Field>
          )}
        </div>
        {!!error && <ErrorState compact error={error} title="Couldn't save the feature" />}
      </form>
    </Dialog>
  );
}

/** A screenshot for a feature, stored with the existing assets. */
function ScreenshotDialog({ open, feature, onClose, onUploaded }: { open: boolean; feature: Feature; onClose: () => void; onUploaded: () => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [missing, setMissing] = useState(false);
  const formId = `tl-wn-shot-${feature.id}`;

  function close() {
    if (busy) return;
    setFile(null);
    setAlt("");
    setError(null);
    setMissing(false);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setMissing(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/assets", { method: "POST", body: { target_id: feature.id, filename: file.name, mime: file.type, data_base64: await fileToBase64(file), alt_text: alt.trim() || undefined } });
      toast.success(`Added ${file.name}`);
      setBusy(false);
      setFile(null);
      setAlt("");
      onUploaded();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!busy}
      title={`Screenshot for “${feature.title}”`}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Uploading">
            Upload
          </Button>
        </>
      }
    >
      <form id={formId} className="tl-stack" noValidate onSubmit={submit}>
        <FileDrop
          label="Image"
          accept="image/png,image/jpeg,image/webp,image/gif"
          file={file}
          busy={busy}
          busyText="Uploading"
          onFile={(f) => {
            setFile(f);
            setMissing(false);
          }}
          hint="PNG, JPEG, WebP or GIF."
        />
        {missing && (
          <p className="tl-wn-error" role="alert">
            Choose an image to upload.
          </p>
        )}
        <Field label="Description" optional hint="Used as the image's alt text.">
          <TextInput value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={300} />
        </Field>
        <Callout tone="warning">Screenshots aren't scanned for secrets. Don't upload ones that show any.</Callout>
        {!!error && <ErrorState compact error={error} title="Couldn't upload it" />}
      </form>
    </Dialog>
  );
}

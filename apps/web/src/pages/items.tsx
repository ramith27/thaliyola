import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { isLineage, lineageText, repoOfLabel } from "../components/lineage";
import { api, ApiError, type Article, type Finding, type ItemTickets, type Me, type Related, type ScopeInfo, type SearchHit, type WriteResult } from "../api";
import { Markdown } from "../components/ui";
import { AddLinkForm, canShareToLibrary, PurgeZone, ShareToLibrary } from "../components/actions";
import { ClaimsPanel } from "../components/claims";
import { MoveItem, useFolders } from "../components/move";
import { TrashedNotice } from "./trash";
import { Attachments } from "../components/assets";
import { filledSections, useGuidePlacement, WritingGuide, WritingGuideToggle } from "../components/guide";
import { CreateTicketDialog, LinkTicketDialog, TicketsCard } from "../components/tickets";
import { refreshCounts, replaceRoute, useApi, useDebouncedValue, useLiveRefresh, useMediaQuery, useShortcuts } from "../hooks";
import { RelationsPanel } from "./graph";
import { WatchButton } from "../components/notifications";
import { FavouriteButton, recordVisit, SectionLink, ShareButton } from "../components/find";
import { clearDraft, DraftOffer, Editor, useAutosave } from "../components/editor";
import { takePrefill } from "../paste";
import { I } from "../components/icons";
import { href, navigate, type Route } from "../router";
import { useBoot } from "../components/boot";
import { can } from "../components/permissions";
import { clearInboxOrigin, completeInboxHandoff, peekInboxOrigin, type InboxOrigin } from "../components/handoff";
import { ARTICLE_TYPES, entityKindLabel, FINDING_TYPES, labelFrom, LINK_SYSTEM, opLabel, plural, REPO_KIND, SCOPE_KIND, typeDescription, typeLabel } from "../components/labels";
import {
  AsyncBlock,
  Badge,
  Button,
  Callout,
  Card,
  Chip,
  ChipGroup,
  DiffView,
  Dialog,
  Disclosure,
  ErrorState,
  Facts,
  Field,
  FormActions,
  LocationLabel,
  MetaLine,
  Page,
  PageHeader,
  PersonChip,
  ProjectPicker,
  RelativeTime,
  Select,
  Skeleton,
  SkeletonRows,
  SkeletonText,
  StatusBadge,
  TextInput,
  TypeLabel,
  focusFirstInvalid,
  useAsyncAction,
  useConfirm,
  useToast,
  useUnsavedChangesGuard,
  projectSwitcher,
  type Crumb,
  type MenuItemSpec,
} from "../components/kit";

const noop = () => undefined;
type Item = Article | Finding;
type Kind = "article" | "finding";

// ---- Places ----------------------------------------------------------------------------------------------------

/** The scope page, or a folder in it (`?folder=`, owned by browse). */
function scopeHref(scope: { slug: string; kind: string }, folder?: string) {
  if (scope.kind === "project") return href(`/project/${scope.slug}`, folder ? { tab: "pages", folder } : undefined);
  return href(`/scope/${scope.slug}`, folder ? { folder } : undefined);
}

function findingsHref(scope: { slug: string; kind: string }) {
  return scope.kind === "project" ? href(`/project/${scope.slug}`, { tab: "pages" }) : href(`/scope/${scope.slug}`, { tab: "findings" });
}

/** A scope's name for people: the project name, "Team space" etc.; the slug only as a last resort. */
function scopeName(scopes: ScopeInfo[], scope: { slug: string; kind: string } | undefined) {
  if (!scope) return "";
  const info = scopes.find((s) => s.slug === scope.slug);
  if (info?.kind === "personal") return SCOPE_KIND.personal!;
  return info?.name ?? (scope.kind !== "project" && scope.slug === scope.kind ? (SCOPE_KIND[scope.kind] ?? scope.slug) : scope.slug);
}

/** Article: Project › Folder › Subfolder (every folder linked). Finding: Project › Findings. */
function itemCrumbs(kind: Kind, item: { scope: { slug: string; kind: string }; path?: string }, scopes: ScopeInfo[], switchable = false): Crumb[] {
  // On a page you read (not an editor), the project crumb switches to another project's home.
  const switcher = switchable ? projectSwitcher(scopes, item.scope.slug, (slug) => href(`/project/${slug}`)) : undefined;
  const crumbs: Crumb[] = [{ label: scopeName(scopes, item.scope), href: scopeHref(item.scope), switcher }];
  if (kind === "finding") crumbs.push({ label: "Findings", href: findingsHref(item.scope) });
  else if (item.path) {
    const parts = item.path.split("/").filter(Boolean);
    parts.forEach((p, i) => crumbs.push({ label: p, href: scopeHref(item.scope, parts.slice(0, i + 1).join("/")) }));
  }
  return crumbs;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function publishedAs(item: Item) {
  return item.related.find((r) => r.relation === "published_as" && r.direction === "out")?.id;
}

const daysSince = (iso: string | null) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)) : null);

// ---- Live item -------------------------------------------------------------------------------------------------

/**
 * The item, refreshed from server events (paused while editing). A newer version that arrives while the person
 * is reading is held back ("This page was updated · Show changes") instead of swapping the text under them.
 * `reload` (after the person's own actions) always shows the result.
 */
function useLiveItem<T extends Item>(path: string, editing: boolean) {
  const result = useApi<T>(path);
  const [shown, setShown] = useState<T | null>(null);
  const shownRef = useRef<T | null>(null);
  const accept = useRef(true);
  useEffect(() => {
    const d = result.data;
    if (!d) return;
    const cur = shownRef.current;
    if (!cur || accept.current || editing || cur.id !== d.id || d.version <= cur.version) {
      accept.current = false;
      shownRef.current = d;
      setShown(d);
    }
  }, [result.data, editing]);
  const { reload: fetchAgain } = result;
  const reload = useCallback(() => {
    accept.current = true;
    fetchAgain();
  }, [fetchAgain]);
  useLiveRefresh(editing ? noop : fetchAgain);
  const latest = result.data;
  const pending = shown && latest && latest.id === shown.id && latest.version > shown.version ? latest : null;
  const showLatest = () => {
    if (!latest) return;
    shownRef.current = latest;
    setShown(latest);
  };
  // `fetched`: the latest copy from the server (it changes on every live refresh), for things that refresh along with it.
  return { data: shown, error: result.error, loading: result.loading, reload, pending, showLatest, fetched: latest };
}

function DocumentSkeleton() {
  return (
    <div className="it-doc-skeleton">
      <Skeleton width="30%" height={14} />
      <Skeleton width="70%" height={32} />
      <Skeleton width="45%" height={14} />
      <SkeletonText lines={8} />
    </div>
  );
}

function ItemLoading({ result, kind }: { result: { data: unknown; error: unknown; loading: boolean; reload: () => void }; kind: Kind }) {
  return (
    <Page width="reading">
      <AsyncBlock result={result} label={`Loading the ${kind}`} skeleton={<DocumentSkeleton />} errorTitle={`Couldn't open this ${kind}`}>
        {() => null}
      </AsyncBlock>
    </Page>
  );
}

// ---- Article ---------------------------------------------------------------------------------------------------

export function ArticlePage({ id, route, me, scopes = [] }: { id: string; route: Route; me?: Me; scopes?: ScopeInfo[] }) {
  const editing = route.path[2] === "edit";
  const section = route.query.get("section");
  const item = useLiveItem<Article>(`/articles/${id}`, editing);
  const data = item.data;

  useEffect(() => {
    if (data) recordVisit({ kind: "article", id, title: data.title, link: href(`/article/${id}`) });
  }, [data?.title, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?section= deep links scroll to that section, on load and when the link changes.
  const loaded = !!data;
  useEffect(() => {
    if (!loaded || !section || editing) return;
    document.getElementById(`section-${slugify(section)}`)?.scrollIntoView({ block: "start" });
  }, [loaded, section, editing]);

  if (!data) return <ItemLoading result={item} kind="article" />;
  if (editing) return <ArticleEditor article={data} scopes={scopes} onSaved={item.reload} />;
  return <ItemView kind="article" item={data} me={me} scopes={scopes} live={item} />;
}
// Section links change only ?section=, so the page stays mounted (and scrolls) instead of reloading.
ArticlePage.keepMountedOnQuery = true;

// ---- Finding ---------------------------------------------------------------------------------------------------

export function FindingPage({ id, route, me, scopes = [] }: { id: string; route: Route; me?: Me; scopes?: ScopeInfo[] }) {
  const editing = route.path[2] === "edit";
  const item = useLiveItem<Finding>(`/findings/${id}`, editing);
  const data = item.data;
  useEffect(() => {
    if (data) recordVisit({ kind: "finding", id, title: data.title, link: href(`/finding/${id}`) });
  }, [data?.title, id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data) return <ItemLoading result={item} kind="finding" />;
  if (editing) return <FindingEditor finding={data} scopes={scopes} onSaved={item.reload} />;
  return <ItemView kind="finding" item={data} me={me} scopes={scopes} live={item} />;
}

// ---- The reading page (T2) ---------------------------------------------------------------------------------------

type Live<T> = { reload: () => void; pending: T | null; showLatest: () => void; fetched?: T | null };

function ItemView({ kind, item, me, scopes, live }: { kind: Kind; item: Item; me?: Me; scopes: ScopeInfo[]; live: Live<Item> }) {
  const id = item.id;
  const toast = useToast();
  const confirm = useConfirm();
  const narrow = useMediaQuery("(max-width: 1100px)");
  const [dialog, setDialog] = useState<null | "move" | "share" | "purge" | "changes" | "ticket" | "link-ticket">(null);
  const [proposed, setProposed] = useState<string | null>(null);
  const [claims, setClaims] = useState({ total: 0, stale: 0 });
  const [openClaims, setOpenClaims] = useState(0);
  const [trashing, setTrashing] = useState(false);
  const scopeInfo = scopes.find((s) => s.slug === item.scope.slug);
  const canMove = can.moveFrom(scopeInfo, me ?? { admin: false });
  const article = kind === "article" ? (item as Article) : null;
  const finding = kind === "finding" ? (item as Finding) : null;
  const deleted = item.status === "deleted";
  const verifiable = item.status === "published" || item.status === "possibly_stale";
  const libraryCopy = publishedAs(item);
  const shareable = canShareToLibrary(item.scope.kind, item.status) && !libraryCopy && !proposed;
  const sections = article?.sections ?? [];
  const showToc = sections.length > 1;
  // Jira and Linear tickets: their status is refreshed when this asks (cached for five minutes on the server).
  const tickets = useApi<ItemTickets>(deleted ? null : `/items/${id}/tickets`);
  const mayAddTickets = !deleted && item.status !== "rejected" && can.addTickets(scopeInfo, me ?? { admin: false });
  const ticketsChanged = () => {
    tickets.reload();
    live.reload();
  };
  // The tickets refresh with the item (live refresh: the job's status updates, tickets linked by agents), and when
  // its links change (a Jira or Linear link added from External links).
  const firstFetch = useRef(true);
  const reloadTickets = tickets.reload;
  useEffect(() => {
    if (firstFetch.current) {
      firstFetch.current = false;
      return;
    }
    if (!deleted) reloadTickets();
  }, [live.fetched, item.source_links.length, deleted, reloadTickets]);

  const verify = useAsyncAction(() => api(`/verify/${id}`, { method: "POST", body: { still_valid: true } }), {
    success: "Marked as verified today",
    error: "Couldn't confirm it",
    onDone: () => live.reload(),
  });

  async function moveToTrash() {
    // Same behaviour as DeleteItemButton (tools), as a ⋯ menu item.
    if (trashing) return;
    const ok = await confirm({
      title: `Move “${item.title}” to the trash?`,
      body: "Nobody else can see it there, and search and agents ignore it. You can restore it from the trash.",
      confirmLabel: "Move to trash",
      tone: "danger",
    });
    if (!ok) return;
    setTrashing(true);
    try {
      await api(`/items/${id}/delete`, { method: "POST" });
      window.location.hash = scopeHref(item.scope).slice(1);
      toast.success("Moved to trash", {
        undo: async () => {
          await api(`/trash/items/${id}/restore`, { method: "POST" });
          navigate(`/${kind}/${id}`);
        },
      });
    } catch (e) {
      toast.error(e, { title: "Couldn't move it to the trash" });
    } finally {
      setTrashing(false);
    }
  }

  const danger: MenuItemSpec[] = [
    ...(canMove && !deleted ? [{ id: "trash", label: "Move to trash…", icon: "trash" as const, tone: "danger" as const, disabledReason: trashing ? "Moving to trash…" : undefined, onSelect: () => void moveToTrash() }] : []),
    ...(me && can.purge(me) ? [{ id: "purge", label: "Delete permanently…", icon: "alert" as const, tone: "danger" as const, onSelect: () => setDialog("purge") }] : []),
  ];
  const menu: MenuItemSpec[] = [
    { id: "history", label: `Version history (v${item.version})`, icon: "history", href: href(`/history/${id}`) },
    ...(verifiable
      ? [{ id: "verify", label: "Confirm still accurate", icon: "check" as const, hint: "Marks it as verified today", disabledReason: verify.busy ? "Confirming…" : undefined, onSelect: () => void verify.run() }]
      : []),
    ...(mayAddTickets
      ? [
          {
            id: "ticket",
            label: "Create ticket…",
            icon: "ticket" as const,
            hint: "In Jira or Linear, linking back here",
            disabledReason: !tickets.data ? (tickets.error ? "Couldn't load the issue trackers" : "Loading issue trackers…") : (tickets.data.create_blocked ?? undefined),
            onSelect: () => setDialog("ticket"),
          },
        ]
      : []),
    ...(shareable ? [{ id: "share", label: "Share to library…", icon: "library" as const, hint: "Let other projects reuse it", onSelect: () => setDialog("share") }] : []),
    ...(libraryCopy ? [{ id: "library-copy", label: "Open library copy", icon: "library" as const, href: href(`/article/${libraryCopy}`) }] : []),
    ...(canMove ? [{ id: "move", label: "Move…", icon: "move" as const, onSelect: () => setDialog("move") }] : []),
    ...(danger.length ? [{ type: "separator" as const }, ...danger] : []),
  ];

  const owner = article ? article.owner : finding!.author;
  const ownerName = article ? article.owner_name : finding!.author_name;
  const meta = (
    <>
      <MetaLine
        items={[
          article ? <TypeLabel type={item.type} kind="article" /> : null,
          <span>
            <RelativeTime date={item.updated_at} prefix="Updated" />
            {owner ? (
              <>
                {" by "}
                <span title={owner.includes("@") ? owner : undefined}>{ownerName || (owner.includes("@") ? owner.split("@")[0] : owner)}</span>
              </>
            ) : null}
          </span>,
          item.last_verified_at ? (
            <RelativeTime date={item.last_verified_at} prefix="Verified" />
          ) : (
            <Badge tone="warning" variant="outline" icon="clock">
              Never verified
            </Badge>
          ),
        ]}
      />
      {libraryCopy ? (
        <p className="it-library-line">
          <I name="library" size={14} /> Shared in the library · <a href={href(`/article/${libraryCopy}`)}>Open library copy</a>
        </p>
      ) : proposed ? (
        <p className="it-library-line">
          <I name="library" size={14} /> Proposed for the library · <a href={href(`/review/${proposed}`)}>View the proposal</a>
        </p>
      ) : null}
    </>
  );

  const header = (
    <PageHeader
      size="document"
      crumbs={itemCrumbs(kind, { scope: item.scope, path: article?.path }, scopes, true)}
      eyebrow={finding ? `Finding · ${typeLabel(item.type)}` : undefined}
      title={item.title}
      status={item.status !== "published" ? <StatusBadge domain="item" value={item.status} /> : undefined}
      meta={meta}
      actions={
        <>
          <WatchButton id={id} iconOnly="phone" />
          <FavouriteButton id={id} iconOnly="phone" />
          <ShareButton title={item.title} />
        </>
      }
      primary={
        <Button variant="primary" icon="pencil" href={href(`/${kind}/${id}/edit`)}>
          Edit
        </Button>
      }
      menu={menu}
      scope={item.scope.slug}
    />
  );

  const rail = (
    <>
      {showToc && !narrow && <OnThisPage id={id} sections={sections} />}
      <ItemDetails item={item} kind={kind} />
      {article?.type === "table" && <LineageCard article={article} />}
      <RelatedItems items={article?.type === "table" ? item.related.filter((r) => !isLineage(r.relation)) : item.related} />
      <TicketsCard result={tickets} canLink={mayAddTickets && !!tickets.data?.can_link} onLink={() => setDialog("link-ticket")} />
      <ExternalLinks item={item} ticketUrls={tickets.data?.tickets.map((t) => t.url)} onChange={live.reload} />
      <Attachments targetId={id} assets={item.assets} onChange={live.reload} />
    </>
  );

  const body = article ? (
    <SectionedMarkdown body={article.body_md} articleId={id} />
  ) : (
    <FindingBody finding={finding!} />
  );

  return (
    <div className="it-doc">
      {header}
      <div className="it-callouts">
        <StatusCallout item={item} kind={kind} verify={verify} onRestored={live.reload} />
        {live.pending && (
          <Callout
            tone="info"
            icon="refresh"
            title="This page was updated"
            actions={
              <>
                <Button size="sm" onClick={() => setDialog("changes")}>
                  Show changes
                </Button>
                <Button size="sm" variant="ghost" onClick={live.showLatest}>
                  Load version {live.pending.version}
                </Button>
              </>
            }
          >
            Version {live.pending.version} was published while you were reading.
          </Callout>
        )}
        {claims.stale > 0 && !deleted && (
          <Callout
            tone="warning"
            icon="clock"
            className="it-callout-inline"
            actions={
              <Button
                size="sm"
                onClick={() => {
                  setOpenClaims((n) => n + 1);
                  requestAnimationFrame(() => document.getElementById("fact-check")?.scrollIntoView({ block: "start", behavior: "smooth" }));
                }}
              >
                Review
              </Button>
            }
          >
            {plural(claims.stale, "statement")} may be out of date.
          </Callout>
        )}
      </div>
      {narrow && (
        <div className="it-narrow-rail">
          {showToc && (
            <Disclosure summary="On this page" className="it-toc-disclosure">
              <TocLinks id={id} sections={sections} />
            </Disclosure>
          )}
          <Disclosure summary="Details" className="it-details-disclosure" storageKey="items.details">
            <div className="it-rail-stack">{rail}</div>
          </Disclosure>
        </div>
      )}
      <Page width="reading" rail={narrow ? undefined : rail} railLabel="About this page">
        <div className="it-body">{body}</div>
        {article && <ClaimsPanel articleId={id} canEdit={!deleted} openSignal={openClaims} onCounts={setClaims} />}
        <RelationsPanel id={id} />
        {finding && <Activity finding={finding} />}
      </Page>

      {dialog === "move" && (
        <MoveItem
          id={id}
          kind={kind}
          from={item.scope.slug}
          path={article?.path}
          scopes={scopes}
          onCancel={() => setDialog(null)}
          onDone={(to) => {
            setDialog(null);
            live.reload();
            toast.success(to === item.scope.slug ? "Location saved" : `Moved to ${scopeName(scopes, scopes.find((s) => s.slug === to) ?? { slug: to, kind: "project" })}`);
          }}
        />
      )}
      {mayAddTickets && (
        <>
          <CreateTicketDialog id={id} kind={kind} title={item.title} data={tickets.data} open={dialog === "ticket"} onClose={() => setDialog(null)} onCreated={ticketsChanged} />
          <LinkTicketDialog id={id} open={dialog === "link-ticket"} onClose={() => setDialog(null)} onLinked={ticketsChanged} />
        </>
      )}
      {shareable && <ShareToLibrary id={id} open={dialog === "share"} onClose={() => setDialog(null)} onProposed={setProposed} />}
      {me && can.purge(me) && <PurgeZone id={id} title={item.title} kind={kind} open={dialog === "purge"} onClose={() => setDialog(null)} />}
      {live.pending && (
        <ChangesDialog
          open={dialog === "changes"}
          onClose={() => setDialog(null)}
          before={itemText(item)}
          after={itemText(live.pending)}
          version={live.pending.version}
          onShow={() => {
            setDialog(null);
            live.showLatest();
          }}
        />
      )}
    </div>
  );
}

function itemText(item: Item) {
  if ("body_md" in item) return `# ${item.title}\n\n${item.body_md}`;
  return [`# ${item.title}`, `## Symptoms\n\n${item.symptoms}`, `## Root cause\n\n${item.root_cause}`, ...(item.fix ? [`## Fix or workaround\n\n${item.fix}`] : [])].join("\n\n");
}

function ChangesDialog({ open, onClose, before, after, version, onShow }: { open: boolean; onClose: () => void; before: string; after: string; version: number; onShow: () => void }) {
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={`What changed in version ${version}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" onClick={onShow}>
            Show version {version}
          </Button>
        </>
      }
    >
      <DiffView before={before} after={after} markdown mode={mode} onModeChange={setMode} showModeToggle labels={{ before: "What you were reading", after: `Version ${version}` }} />
    </Dialog>
  );
}

/** One status callout at a time, the most important first, each with its next step. */
function StatusCallout({ item, kind, verify, onRestored }: { item: Item; kind: Kind; verify: { run: () => void; busy: boolean }; onRestored: () => void }) {
  switch (item.status) {
    case "deleted":
      return <TrashedNotice id={item.id} onRestored={onRestored} />;
    case "rejected":
      return (
        <Callout
          tone="danger"
          title="Rejected in review."
          actions={
            <Button size="sm" href={href(`/history/${item.id}`)}>
              See version history
            </Button>
          }
        >
          This version wasn't approved, so it isn't what others read.
        </Callout>
      );
    case "superseded": {
      const newer = item.related.find((r) => r.relation === "supersedes" && r.direction === "in");
      const link = newer ? relatedHref(newer) : undefined;
      return (
        <Callout
          tone="neutral"
          title="Replaced by a newer entry."
          actions={
            link ? (
              <Button size="sm" href={link}>
                Go to the newer version
              </Button>
            ) : undefined
          }
        >
          It's kept for history{newer ? `: “${newer.label}” replaces it.` : "."}
        </Callout>
      );
    }
    case "draft":
      return (
        <Callout
          tone="info"
          title="Waiting for review."
          actions={
            <Button size="sm" href={href("/review", { q: item.title })}>
              Find the proposal
            </Button>
          }
        >
          This {kind} is a draft until a Reviewer or Project admin approves it.
        </Callout>
      );
    case "possibly_stale": {
      const days = daysSince(item.last_verified_at);
      return (
        <Callout
          tone="warning"
          icon="clock"
          title="Needs a check"
          actions={
            <Button size="sm" icon="check" loading={verify.busy} loadingText="Confirming" onClick={() => void verify.run()}>
              Confirm still accurate
            </Button>
          }
        >
          {days === null ? "Never verified." : `Not verified in ${plural(days, "day")}.`} Confirm it still holds before relying on it.
        </Callout>
      );
    }
    default:
      return null;
  }
}

// ---- Body -------------------------------------------------------------------------------------------------------

/** Renders markdown with an anchor before each # / ## section so search hits and "On this page" can jump to it. */
function SectionedMarkdown({ body, articleId }: { body: string; articleId: string }) {
  const chunks = body.split(/\n(?=#{1,2}\s)/);
  return (
    <>
      {chunks.map((chunk, i) => {
        const heading = /^#{1,2}\s+(.+?)\s*#*\s*$/m.exec(chunk.split("\n")[0] ?? "")?.[1];
        return (
          <div key={i} id={heading ? `section-${slugify(heading)}` : undefined} className={heading ? "it-section" : undefined}>
            {heading && <SectionLink link={href(`/article/${articleId}`, { section: heading })} />}
            <Markdown text={chunk} />
          </div>
        );
      })}
    </>
  );
}

function FindingBody({ finding }: { finding: Finding }) {
  return (
    <div className="it-finding">
      <FindingPart title="Symptoms" text={finding.symptoms} />
      <FindingPart title="Root cause" text={finding.root_cause} />
      {finding.fix ? (
        <FindingPart title="Fix or workaround" text={finding.fix} tone="fix" />
      ) : (
        <section className="it-finding-part" data-tone="missing" aria-label="Fix or workaround">
          <p className="it-finding-missing">
            No fix recorded yet · <a href={href(`/finding/${finding.id}/edit`)}>Add a fix</a>
          </p>
        </section>
      )}
    </div>
  );
}

function FindingPart({ title, text, tone }: { title: string; text: string; tone?: "fix" }) {
  const id = useId();
  return (
    <section className="it-finding-part" data-tone={tone} aria-labelledby={id}>
      <h2 id={id} className="it-finding-title">
        {tone === "fix" && <I name="check-circle" size={16} />}
        {title}
      </h2>
      <Markdown text={text} />
    </section>
  );
}

const ACTIVITY: Record<string, string> = {
  create: "created this",
  update: "edited this",
  promote: "added this to an article",
  move: "moved this",
  share: "shared this to the library",
  verify: "marked this as outdated",
};

/** Findings: what happened to it, in plain words (the full record is in Version history). */
function Activity({ finding }: { finding: Finding }) {
  if (!finding.history.length) return null;
  return (
    <section className="it-activity" aria-labelledby="it-activity-title">
      <div className="it-activity-head">
        <h2 id="it-activity-title" className="it-activity-title">
          Activity
        </h2>
        <a href={href(`/history/${finding.id}`)}>See all versions</a>
      </div>
      <ol className="it-timeline">
        {finding.history.map((h, i) => (
          <li key={i} className="it-timeline-row">
            <PersonChip size="sm" {...(h.author?.includes("@") ? { email: h.author, name: h.author_name } : { name: h.author_name || h.author })} />
            <span className="it-timeline-text">
              {h.state === "pending" && h.op === "move" ? "proposed moving this" : (ACTIVITY[h.op] ?? opLabel(h.op).toLowerCase())}
            </span>
            <StatusBadge domain="proposal" value={h.state} />
            <RelativeTime date={h.created_at} />
            {h.reason && <span className="it-timeline-reason">“{h.reason}”</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

// ---- Rail ------------------------------------------------------------------------------------------------------

function useScrollSpy(ids: string[]) {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join("|");
  useEffect(() => {
    if (ids.length < 2 || typeof IntersectionObserver === "undefined") return;
    const visible = new Map<string, boolean>();
    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        const first = ids.find((i) => visible.get(i));
        if (first) setActive(first);
      },
      { rootMargin: "-72px 0px -55% 0px" },
    );
    for (const i of ids) {
      const el = document.getElementById(i);
      if (el) obs.observe(el);
    }
    return () => obs.disconnect();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

function TocLinks({ id, sections }: { id: string; sections: string[] }) {
  const ids = useMemo(() => sections.map((s) => `section-${slugify(s)}`), [sections]);
  const active = useScrollSpy(ids);
  return (
    <ul className="it-toc">
      {sections.map((s, i) => (
        <li key={s}>
          <a
            href={href(`/article/${id}`, { section: s })}
            aria-current={active === ids[i] ? "location" : undefined}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              document.getElementById(ids[i]!)?.scrollIntoView({ block: "start", behavior: "smooth" });
              replaceRoute(`/article/${id}`, { section: s });
            }}
          >
            {s}
          </a>
        </li>
      ))}
    </ul>
  );
}

function OnThisPage({ id, sections }: { id: string; sections: string[] }) {
  return (
    <Card title="On this page" padding="sm" as="section">
      <nav aria-label="On this page">
        <TocLinks id={id} sections={sections} />
      </nav>
    </Card>
  );
}

function ItemDetails({ item, kind }: { item: Item; kind: Kind }) {
  const owner = "owner" in item ? item.owner : item.author;
  const ownerName = "owner" in item ? item.owner_name : item.author_name;
  const facts: { term: string; value: ReactNode }[] = [];
  if (owner)
    facts.push({
      term: kind === "article" ? "Owner" : "Author",
      value: owner.includes("@") ? <PersonChip size="sm" email={owner} showEmail name={ownerName} /> : <PersonChip size="sm" name={ownerName || owner} />,
    });
  if (item.components.length)
    facts.push({
      term: item.components.length === 1 ? "Repository" : "Repositories",
      value: (
        <span className="it-inline-list">
          {item.components.map((c) =>
            item.scope.kind === "project" ? (
              <a key={c} href={href(`/project/${item.scope.slug}`, { component: c })}>
                {c}
              </a>
            ) : (
              <span key={c}>{c}</span>
            ),
          )}
        </span>
      ),
    });
  if (item.entities.length)
    facts.push({
      term: "Topics",
      value: (
        <span className="it-inline-list">
          {item.entities.map((e) => (
            <a key={`${e.kind}:${e.name}`} href={href(`/entity/${e.kind}/${e.name}`)} title={entityKindLabel(e.kind)}>
              {e.name}
            </a>
          ))}
        </span>
      ),
    });
  if (item.tags.length)
    facts.push({
      term: "Tags",
      value: (
        <span className="it-tags">
          {item.tags.map((t) => (
            <a key={t} className="it-tag" href={href("/search", { q: `#${t}` })}>
              #{t}
            </a>
          ))}
        </span>
      ),
    });
  if (!facts.length) return null;
  return (
    <Card title="Details" padding="sm" as="section">
      <Facts items={facts} />
    </Card>
  );
}

const RELATION_TEXT: Record<string, [string, string]> = {
  uses: ["uses", "used by"],
  depends_on: ["depends on", "needed by"],
  provided_by: ["provided by", "provides"],
  consumed_by: ["consumed by", "consumes"],
  related: ["related", "related"],
  same_root_cause: ["same root cause", "same root cause"],
  supersedes: ["supersedes", "superseded by"],
  promoted_into: ["promoted into", "includes finding"],
  published_as: ["published as", "published from"],
  // Lineage: a repository reads or writes a table.
  reads: ["reads", "read by"],
  writes: ["writes", "written by"],
};

function relatedHref(r: Related) {
  if (r.kind === "article") return href(`/article/${r.id}`);
  if (r.kind === "finding") return href(`/finding/${r.id}`);
  // A repository ("Project / repo"), e.g. one that reads or writes a table: its project page, on that repository.
  if (r.kind === "component" && r.scope) return href(`/project/${r.scope}`, { component: repoOfLabel(r.label) });
  return undefined;
}

/**
 * A table article's lineage: the repositories that read or write the table. They're added and removed in the Data
 * view (or with link_entries), so this links there when a database sync wrote the article.
 */
function LineageCard({ article }: { article: Article }) {
  const rows = article.related.filter((r) => isLineage(r.relation) && r.direction === "in");
  const table = article.synced_table;
  if (!rows.length && !table) return null;
  return (
    <Card
      title="Used by"
      padding="sm"
      as="section"
      actions={
        table ? (
          <Button size="sm" variant="ghost" icon="table" href={href(`/project/${table.project}`, { tab: "data", table: table.id })}>
            {rows.length ? "Edit" : "Add"}
          </Button>
        ) : undefined
      }
    >
      {rows.length ? (
        <ul className="it-rail-list">
          {rows.map((r) => {
            const link = relatedHref(r);
            return (
              <li key={`${r.relation}-${r.id}`} className="it-rail-row">
                <span className="it-rail-label">{lineageText(r.relation, "table")}</span>
                {link ? <a href={link}>{r.label}</a> : <span>{r.label}</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="it-rail-empty">No repository is linked yet. Say which ones read or write this table, so their projects hear about schema changes.</p>
      )}
    </Card>
  );
}

function RelatedItems({ items }: { items: Related[] }) {
  if (!items.length) return null;
  return (
    <Card title="Related items" padding="sm" as="section">
      <ul className="it-rail-list">
        {items.map((r) => {
          const link = relatedHref(r);
          return (
            <li key={`${r.relation}-${r.direction}-${r.id}`} className="it-rail-row">
              <span className="it-rail-label">{RELATION_TEXT[r.relation]?.[r.direction === "out" ? 0 : 1] ?? r.relation}</span>
              {link ? <a href={link}>{r.label}</a> : <span>{r.label}</span>}
              {r.scope && <LocationLabel scope={r.scope} />}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Evidence and design links; Jira and Linear tickets show in the Tickets card instead. */
function ExternalLinks({ item, ticketUrls, onChange }: { item: Item; ticketUrls?: string[]; onChange: () => void }) {
  const links = item.source_links.filter((l) => !l.ticket && !ticketUrls?.includes(l.url));
  return (
    <Card title="External links" padding="sm" as="section" actions={<AddLinkForm targetId={item.id} onAdded={onChange} />}>
      {links.length === 0 ? (
        <p className="it-rail-empty">No links yet. Add a Figma file, pull request or Sentry issue.</p>
      ) : (
        <ul className="it-rail-list">
          {links.map((l) => (
            <li key={l.url} className="it-rail-row">
              <span className="it-rail-label">{labelFrom(LINK_SYSTEM, l.system)}</span>
              <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="it-external">
                {l.label || l.url}
                <I name="external" size={12} />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---- Editors (T4) ----------------------------------------------------------------------------------------------

const ARTICLE_GROUPS: { label: string; types: string[] }[] = [
  { label: "How things work", types: ["system", "table", "metric"] },
  { label: "How to act", types: ["runbook", "decision", "note"] },
  { label: "Project docs", types: ["project_overview", "design_doc", "tech_spec", "api_contract"] },
  { label: "Design library", types: ["screen_spec", "ui_component", "ux_pattern", "design_tokens", "pattern"] },
];

function typeGroups(kind: Kind, available: string[]) {
  const known = kind === "article" ? ARTICLE_GROUPS : [{ label: "Findings", types: [...FINDING_TYPES] }];
  const listed = new Set(known.flatMap((g) => g.types));
  const groups = known
    .map((g) => ({ label: g.label, options: g.types.filter((t) => available.includes(t)).map((t) => ({ value: t, label: typeLabel(t) })) }))
    .filter((g) => g.options.length);
  const other = available.filter((t) => !listed.has(t));
  if (other.length) groups.push({ label: "Other", options: other.map((t) => ({ value: t, label: typeLabel(t) })) });
  return kind === "finding" && groups.length === 1 ? { options: groups[0]!.options } : { groups };
}

/** The `## ` headings of a template, for the Type hint. */
const templateSections = (md: string) => [...md.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]!);

function RepoChips({ scope, value, onChange }: { scope?: ScopeInfo; value: string[]; onChange: (v: string[]) => void }) {
  if (!scope?.components.length) return null;
  return (
    <div className="field">
      <span className="field-label" aria-hidden="true">
        Repositories<span className="field-optional"> (optional)</span>
      </span>
      <ChipGroup
        label="Repositories (optional)"
        multiple
        options={scope.components.map((c) => ({ value: c.slug, label: c.slug, hint: labelFrom(REPO_KIND, c.kind) }))}
        value={value}
        onChange={(v: string[]) => onChange(v)}
      />
      <p className="field-hint">Which of {scope.name}'s codebases this is about.</p>
    </div>
  );
}

function FolderSuggestions({ scope, id }: { scope: string; id: string }) {
  const folders = useFolders(scope);
  return (
    <datalist id={id}>
      {folders.map((f) => (
        <option key={f} value={f} />
      ))}
    </datalist>
  );
}

function AutosaveStatus({ savedAt }: { savedAt: number | null }) {
  if (!savedAt) return null;
  return (
    <>
      <I name="check" size={14} /> Draft saved in this browser · <RelativeTime date={new Date(savedAt).toISOString()} />
    </>
  );
}

function InboxCallout({ origin }: { origin: InboxOrigin | null }) {
  if (!origin) return null;
  return (
    <Callout
      tone="info"
      icon="inbox"
      actions={
        origin.url ? (
          <Button size="sm" variant="ghost" href={origin.url} external icon="external">
            Open original
          </Button>
        ) : undefined
      }
    >
      From the inbox: {origin.source_name} · {origin.title}. Saving files the inbox item.
    </Callout>
  );
}

/** Files the inbox item a draft came from, after the save itself has succeeded. */
async function finishHandoff(origin: InboxOrigin | null, result: { item_id?: string; revision_id?: string }, toast: ReturnType<typeof useToast>) {
  if (!origin) return;
  try {
    await completeInboxHandoff(origin, result);
    clearInboxOrigin();
    toast.success("Filed from the inbox");
  } catch (e) {
    toast.error(e, { title: "Saved, but the inbox item wasn't filed" });
  }
}

function outcomeNotes(res: WriteResult) {
  const redacted = (res.redactions ?? []).reduce((n, r) => n + r.count, 0);
  const notes: string[] = [];
  if (redacted) notes.push(`${plural(redacted, "secret")} ${redacted === 1 ? "was" : "were"} removed before saving.`);
  if (res.missing_template_sections?.length) notes.push(`Still empty: ${res.missing_template_sections.join(", ")}.`);
  return notes;
}

/** After a save that became a proposal: what happens next, what the server changed, and where to go. */
function ProposalOutcome({ res, kind, itemId, isNew }: { res: WriteResult; kind: Kind; itemId: string; isNew: boolean }) {
  const redacted = (res.redactions ?? []).reduce((n, r) => n + r.count, 0);
  const missing = res.missing_template_sections ?? [];
  return (
    <Callout
      tone="success"
      live
      title="Submitted for review"
      actions={
        <>
          {res.revision_id && (
            <Button variant="primary" size="sm" href={href(`/review/${res.revision_id}`)}>
              View proposal
            </Button>
          )}
          <Button size="sm" href={href(`/${kind}/${itemId}`)}>
            {isNew ? "View the draft" : `Back to the ${kind}`}
          </Button>
        </>
      }
    >
      <p>Saved as a proposal. A Reviewer or Project admin there will review it.</p>
      {redacted > 0 && (
        <p>
          {plural(redacted, "secret")} {redacted === 1 ? "was" : "were"} removed before saving.
        </p>
      )}
      {missing.length > 0 && (
        <p>
          Still empty: {missing.join(", ")} · <a href={href(`/${kind}/${itemId}/edit`)}>Edit to add them</a>
        </p>
      )}
    </Callout>
  );
}

function conflictVersion(e: unknown): number | null {
  return e instanceof ApiError && e.status === 409 ? Number(e.body?.current?.version) || null : null;
}

function ConflictCallout({ version, onCompare, onUseMine }: { version: number | null; onCompare: () => void; onUseMine: () => void }) {
  return (
    <Callout
      tone="danger"
      live
      title={version ? `Someone published version ${version} while you were editing.` : "Someone published a newer version while you were editing."}
      actions={
        <>
          <Button size="sm" onClick={onCompare}>
            Compare with the latest
          </Button>
          <Button size="sm" variant="ghost" onClick={onUseMine}>
            Use my text on top of version {version ?? "the latest"}
          </Button>
        </>
      }
    >
      Your text is kept. Compare it with the latest, then save again.
    </Callout>
  );
}

function CompareDialog({ path, mine, toText, onClose }: { path: string; mine: string; toText: (latest: any) => string; onClose: () => void }) {
  const latest = useApi<any>(path);
  const [mode, setMode] = useState<"rendered" | "source">("rendered");
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Compare with the latest"
      description="The latest published version, and your text."
      footer={
        <Button variant="primary" onClick={onClose}>
          Back to editing
        </Button>
      }
    >
      <AsyncBlock result={latest} label="Loading the latest version" skeleton={<SkeletonText lines={8} />}>
        {(d) => <DiffView before={toText(d)} after={mine} markdown mode={mode} onModeChange={setMode} showModeToggle labels={{ before: `Version ${d.version}`, after: "Your text" }} />}
      </AsyncBlock>
    </Dialog>
  );
}

/** ⌘S and ⌘Enter save from anywhere on an editor page (also while typing). */
function useSaveKeys(save: () => void, enabled: boolean) {
  useShortcuts({ "mod+s": save, "mod+Enter": save }, enabled, { labels: { "mod+s": "Save", "mod+Enter": "Save" }, group: "Editor" });
}

function primaryLabel(publish: boolean, isNew: boolean) {
  return publish ? (isNew ? "Publish" : "Publish changes") : "Submit for review";
}

function reviewHint(publish: boolean, name: string) {
  return publish ? undefined : `A reviewer in ${name || "this project"} approves it before it's published.`;
}

const SUMMARY_ERROR = "Describe what changed. Reviewers and impact notices use it.";

function SummaryField({ value, onChange, error }: { value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <Field label="Summary of changes" hint="Shown to reviewers and in impact notices." error={error} counter={{ value: value.length, max: 300 }} className="it-summary">
      <TextInput value={value} onChange={(e) => onChange(e.target.value)} maxLength={300} placeholder="e.g. GET /orders now requires status" />
    </Field>
  );
}

// ---- Edit article ----

function ArticleEditor({ article, scopes, onSaved }: { article: Article; scopes: ScopeInfo[]; onSaved: () => void }) {
  const { me } = useBoot();
  const toast = useToast();
  const scope = scopes.find((s) => s.slug === article.scope.slug);
  const name = scopeName(scopes, article.scope);
  const publish = can.publishIn(scope, me);
  const [title, setTitle] = useState(article.title);
  const [body, setBody] = useState(article.body_md);
  const [tags, setTags] = useState<string[]>(article.tags);
  const [summary, setSummary] = useState("");
  const [base, setBase] = useState(article.version);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<{ title?: string; summary?: string }>({});
  const [result, setResult] = useState<WriteResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  // On small phones the summary field would make a sticky footer cover half the editor: it sits at the end instead.
  const smallScreen = useMediaQuery("(max-width: 640px)");
  const draftKey = `article:${article.id}:v${article.version}`;
  const autosave = useAutosave(draftKey, JSON.stringify({ title, body }), JSON.stringify({ title: article.title, body: article.body_md }));
  const tagsChanged = tags.join("\n") !== article.tags.join("\n");
  const dirty = title !== article.title || body !== article.body_md || tagsChanged;
  useUnsavedChangesGuard(dirty && !saving && !result);
  const conflict = conflictVersion(error);

  async function save() {
    if (saving) return;
    const errs = { title: title.trim() ? undefined : "Enter a title", summary: summary.trim() ? undefined : SUMMARY_ERROR };
    setErrors(errs);
    if (errs.title || errs.summary) return requestAnimationFrame(() => focusFirstInvalid(form.current));
    setSaving(true);
    setError(null);
    try {
      const res = await api<WriteResult>(`/articles/${article.id}`, {
        method: "PUT",
        body: {
          version: base,
          summary: summary.trim(),
          // A tags-only change sends no body, so it isn't also proposed as an edit of the text.
          body_md: body !== article.body_md || !tagsChanged ? body : undefined,
          title: title !== article.title ? title : undefined,
          tags: tagsChanged ? tags : undefined,
        },
      });
      clearDraft(draftKey);
      setResult(res);
      refreshCounts();
      if (res.published) {
        onSaved();
        navigate(`/article/${article.id}`);
        toast.success("Changes published", { description: outcomeNotes(res).join(" ") || undefined });
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }
  useSaveKeys(() => void save(), !result);

  const header = (
    <PageHeader
      crumbs={[...itemCrumbs("article", article, scopes), { label: article.title, href: href(`/article/${article.id}`) }]}
      eyebrow="Edit article"
      title={article.title}
      documentTitle={`Edit “${article.title}”`}
      scope={article.scope.slug}
      actions={<WritingGuideToggle />}
      hideTabBar
    />
  );
  const guide = useGuidePlacement(<WritingGuide kind="article" type={article.type} filled={filledSections(body)} />);

  if (result && !result.published)
    return (
      <Page width="form">
        {header}
        <ProposalOutcome res={result} kind="article" itemId={article.id} isNew={false} />
      </Page>
    );

  return (
    <Page width="content" rail={guide.rail} railLabel="Writing guide">
      {header}
      {guide.top}
      <form ref={form} className="it-editor" noValidate onSubmit={(e: FormEvent) => (e.preventDefault(), void save())}>
        <DraftOffer
          offer={autosave.offer}
          onRestore={(t) => {
            const d = parseDraft<{ title: string; body: string }>(t);
            if (d && typeof d.body === "string") {
              setTitle(d.title ?? article.title);
              setBody(d.body);
            } else setBody(t); // drafts saved before titles were kept hold only the body
            autosave.dismiss();
          }}
          onDiscard={() => {
            clearDraft(draftKey);
            autosave.dismiss();
          }}
        />
        <Field label="Title" error={errors.title} counter={{ value: title.length, max: 200 }}>
          <TextInput className="it-title-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <TagEditor tags={tags} onChange={setTags} original={article.tags} />
        <Field label="Body" hint="Paste or drop images to attach them.">
          <Editor value={body} onChange={setBody} uploadTarget={article.id} rows={24} label="Body" />
        </Field>
        {conflict !== null || (error instanceof ApiError && error.status === 409) ? (
          <ConflictCallout
            version={conflict}
            onCompare={() => setComparing(true)}
            onUseMine={() => {
              if (conflict) setBase(conflict);
              setError(null);
            }}
          />
        ) : error ? (
          <ErrorState compact error={error} title="Couldn't save" />
        ) : null}
        <FormActions
          sticky={!smallScreen}
          status={<AutosaveStatus savedAt={autosave.savedAt} />}
          hint={reviewHint(publish, name)}
          extra={<SummaryField value={summary} onChange={setSummary} error={errors.summary} />}
        >
          <Button variant="ghost" href={href(`/article/${article.id}`)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={saving} loadingText="Saving…" shortcut="mod+s">
            {primaryLabel(publish, false)}
          </Button>
        </FormActions>
      </form>
      {comparing && <CompareDialog path={`/articles/${article.id}`} mine={body} toText={(d: Article) => d.body_md} onClose={() => setComparing(false)} />}
    </Page>
  );
}

/** A tag as the server stores it: lower case, hyphens for spaces and underscores, no leading #. */
export function normalTag(raw: string): string {
  return raw
    .trim()
    .replace(/^#+/, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.:/-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * An article's tags as chips: × removes one, typing a tag and Enter (or a comma) adds it. Changes go through the same
 * review as text; the line under it says what's added and removed.
 */
function TagEditor({ tags, onChange, original }: { tags: string[]; onChange: (tags: string[]) => void; original: string[] }) {
  const [draft, setDraft] = useState("");
  const inputId = useId();
  function add(raw: string) {
    const next = [...tags];
    for (const part of raw.split(",")) {
      const t = normalTag(part);
      if (t && !next.includes(t) && next.length < 20) next.push(t);
    }
    if (next.length !== tags.length) onChange(next);
    setDraft("");
  }
  const added = tags.filter((t) => !original.includes(t));
  const removed = original.filter((t) => !tags.includes(t));
  return (
    <Field label="Tags" hint="Press Enter or type a comma to add a tag. Tag changes are reviewed like the text.">
      <div className="it-tag-field">
      <div className="it-tag-editor">
        {tags.map((t) => (
          <Chip key={t} onRemove={() => onChange(tags.filter((x) => x !== t))} removeLabel={`Remove tag ${t}`}>
            #{t}
          </Chip>
        ))}
        <input
          id={inputId}
          className="it-tag-input"
          value={draft}
          placeholder={tags.length ? "Add a tag" : "Add tags"}
          aria-label="Add a tag"
          maxLength={60}
          onChange={(e) => (e.target.value.includes(",") ? add(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add(draft);
            } else if (e.key === "Backspace" && !draft && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={() => draft.trim() && add(draft)}
        />
      </div>
      {(added.length > 0 || removed.length > 0) && <TagChanges added={added} removed={removed} />}
      </div>
    </Field>
  );
}

/** "Adds #a, #b · Removes #c": what a tag change does (the editor and the proposal page). */
export function TagChanges({ added, removed }: { added: string[]; removed: string[] }) {
  return (
    <p className="it-tag-changes small">
      {added.length > 0 && (
        <span className="it-tag-added">
          Adds {added.map((t) => `#${t}`).join(", ")}
        </span>
      )}
      {added.length > 0 && removed.length > 0 && " · "}
      {removed.length > 0 && (
        <span className="it-tag-removed">
          Removes {removed.map((t) => `#${t}`).join(", ")}
        </span>
      )}
    </p>
  );
}

function parseDraft<T>(text: string): T | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

// ---- Finding fields ----

type FindingText = { title: string; symptoms: string; root_cause: string; fix: string };
type FindingErrors = Partial<Record<keyof FindingText, string>>;

function validateFinding(f: FindingText): FindingErrors {
  return {
    title: f.title.trim() ? undefined : "Enter a title",
    symptoms: f.symptoms.trim() ? undefined : "Add the symptoms",
    root_cause: f.root_cause.trim() ? undefined : "Add the root cause",
  };
}

/** Title plus the three finding fields, each a compact markdown editor. */
function FindingFields({ fields, onChange, uploadTarget, errors, before }: { fields: FindingText; onChange: (f: FindingText) => void; uploadTarget?: string; errors: FindingErrors; before?: ReactNode }) {
  const set = (k: keyof FindingText) => (v: string) => onChange({ ...fields, [k]: v });
  return (
    <>
      <Field label="Title" error={errors.title} counter={{ value: fields.title.length, max: 200 }}>
        <TextInput className="it-title-input" value={fields.title} onChange={(e) => set("title")(e.target.value)} maxLength={200} />
      </Field>
      {before}
      <Field label="Symptoms" hint="What you saw, as first observed." error={errors.symptoms}>
        <Editor compact label="Symptoms" value={fields.symptoms} onChange={set("symptoms")} rows={4} uploadTarget={uploadTarget} placeholder="What someone searching later would type" />
      </Field>
      <Field label="Root cause" hint="Why it happened." error={errors.root_cause}>
        <Editor compact label="Root cause" value={fields.root_cause} onChange={set("root_cause")} rows={4} uploadTarget={uploadTarget} />
      </Field>
      <Field label="Fix or workaround" optional hint="What fixed it, or how to work around it.">
        <Editor compact label="Fix" value={fields.fix} onChange={set("fix")} rows={3} uploadTarget={uploadTarget} />
      </Field>
    </>
  );
}

/** The finding fields that have text, for the writing guide's ticks. */
const filledFields = (f: FindingText) => new Set((["symptoms", "root_cause", "fix"] as const).filter((k) => f[k].trim()));

const findingText = (f: FindingText) => [`# ${f.title}`, `## Symptoms\n\n${f.symptoms}`, `## Root cause\n\n${f.root_cause}`, `## Fix or workaround\n\n${f.fix}`].join("\n\n");

// ---- Edit finding ----

function FindingEditor({ finding, scopes, onSaved }: { finding: Finding; scopes: ScopeInfo[]; onSaved: () => void }) {
  const { me } = useBoot();
  const toast = useToast();
  const scope = scopes.find((s) => s.slug === finding.scope.slug);
  const publish = can.publishIn(scope, me);
  const initial = { title: finding.title, symptoms: finding.symptoms, root_cause: finding.root_cause, fix: finding.fix ?? "" };
  const [fields, setFields] = useState<FindingText>(initial);
  const [summary, setSummary] = useState("");
  const [base, setBase] = useState(finding.version);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<FindingErrors & { summary?: string }>({});
  const [result, setResult] = useState<WriteResult | null>(null);
  const [comparing, setComparing] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const smallScreen = useMediaQuery("(max-width: 640px)");
  const draftKey = `finding:${finding.id}:v${finding.version}`;
  const autosave = useAutosave(draftKey, JSON.stringify(fields), JSON.stringify(initial));
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial);
  useUnsavedChangesGuard(dirty && !saving && !result);
  const conflict = conflictVersion(error);

  async function save() {
    if (saving) return;
    const errs = { ...validateFinding(fields), summary: summary.trim() ? undefined : SUMMARY_ERROR };
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return requestAnimationFrame(() => focusFirstInvalid(form.current));
    setSaving(true);
    setError(null);
    const patch = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== (finding[k as keyof Finding] ?? "")));
    try {
      const res = await api<WriteResult>(`/findings/${finding.id}`, { method: "PUT", body: { version: base, summary: summary.trim(), patch } });
      clearDraft(draftKey);
      setResult(res);
      refreshCounts();
      if (res.published) {
        onSaved();
        navigate(`/finding/${finding.id}`);
        toast.success("Changes published", { description: outcomeNotes(res).join(" ") || undefined });
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }
  useSaveKeys(() => void save(), !result);

  const header = (
    <PageHeader
      crumbs={[...itemCrumbs("finding", finding, scopes), { label: finding.title, href: href(`/finding/${finding.id}`) }]}
      eyebrow="Edit finding"
      title={finding.title}
      documentTitle={`Edit “${finding.title}”`}
      scope={finding.scope.slug}
      actions={<WritingGuideToggle />}
      hideTabBar
    />
  );
  const guide = useGuidePlacement(<WritingGuide kind="finding" type={finding.type} filled={filledFields(fields)} />);

  if (result && !result.published)
    return (
      <Page width="form">
        {header}
        <ProposalOutcome res={result} kind="finding" itemId={finding.id} isNew={false} />
      </Page>
    );

  return (
    <Page width="form" rail={guide.rail} railLabel="Writing guide">
      {header}
      {guide.top}
      <form ref={form} className="it-editor" noValidate onSubmit={(e: FormEvent) => (e.preventDefault(), void save())}>
        <DraftOffer
          offer={autosave.offer}
          onRestore={(t) => {
            const d = parseDraft<FindingText>(t);
            if (d) setFields({ ...initial, ...d });
            autosave.dismiss();
          }}
          onDiscard={() => {
            clearDraft(draftKey);
            autosave.dismiss();
          }}
        />
        <FindingFields fields={fields} onChange={setFields} uploadTarget={finding.id} errors={errors} />
        {conflict !== null || (error instanceof ApiError && error.status === 409) ? (
          <ConflictCallout
            version={conflict}
            onCompare={() => setComparing(true)}
            onUseMine={() => {
              if (conflict) setBase(conflict);
              setError(null);
            }}
          />
        ) : error ? (
          <ErrorState compact error={error} title="Couldn't save" />
        ) : null}
        <FormActions
          sticky={!smallScreen}
          status={<AutosaveStatus savedAt={autosave.savedAt} />}
          hint={reviewHint(publish, scopeName(scopes, finding.scope))}
          extra={<SummaryField value={summary} onChange={setSummary} error={errors.summary} />}
        >
          <Button variant="ghost" href={href(`/finding/${finding.id}`)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={saving} loadingText="Saving…" shortcut="mod+s">
            {primaryLabel(publish, false)}
          </Button>
        </FormActions>
      </form>
      {comparing && (
        <CompareDialog
          path={`/findings/${finding.id}`}
          mine={findingText(fields)}
          toText={(d: Finding) => findingText({ title: d.title, symptoms: d.symptoms, root_cause: d.root_cause, fix: d.fix ?? "" })}
          onClose={() => setComparing(false)}
        />
      )}
    </Page>
  );
}

// ---- New article ----

/**
 * The draft handed over by paste or the inbox. Read without removing it first (StrictMode's double render and a
 * remount would otherwise read it twice and get nothing the second time), then cleared once the editor has mounted.
 */
function usePrefill<K extends "finding" | "article">(kind: K): ReturnType<typeof takePrefill<K>> {
  const [prefill] = useState(() => {
    try {
      const raw = sessionStorage.getItem("thaliyola.prefill");
      const v = raw ? JSON.parse(raw) : null;
      return (v?.kind === kind ? v : null) as ReturnType<typeof takePrefill<K>>;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (prefill) takePrefill(kind);
  }, [kind, prefill]);
  return prefill;
}

export function NewArticlePage({ route, scopes, articleTypes }: { route: Route; scopes: ScopeInfo[]; articleTypes: string[] }) {
  const { me } = useBoot();
  const toast = useToast();
  const confirm = useConfirm();
  const prefill = usePrefill("article");
  const [origin] = useState(() => peekInboxOrigin("article"));
  const [scope, setScope] = useState(route.query.get("scope") || scopes[0]?.slug || "team");
  const [type, setType] = useState(prefill?.type || route.query.get("type") || "design_doc");
  const [title, setTitle] = useState(prefill?.title ?? "");
  const [path, setPath] = useState("");
  const [body, setBody] = useState(prefill?.body_md ?? "");
  const [template, setTemplate] = useState("");
  // The chosen type's template, for the Type hint. Set before asking whether to replace the text, so the hint
  // never pairs the new type with the previous template's sections.
  const [typeTemplate, setTypeTemplate] = useState("");
  const templateRef = useRef("");
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const typeChosen = useRef(false);
  const autosave = useAutosave("new-article", JSON.stringify({ title, body }), JSON.stringify({ title: prefill?.title ?? "", body: prefill?.body_md ?? template }));
  const [components, setComponents] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<{ title?: string }>({});
  const [result, setResult] = useState<WriteResult | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const folderList = useId();
  const scopeInfo = scopes.find((s) => s.slug === scope);
  const publish = can.publishIn(scopeInfo, me);
  const dirty = !!title.trim() || (body.trim() !== "" && body !== template && body !== (prefill?.body_md ?? ""));
  useUnsavedChangesGuard(dirty && !saving && !result);

  // The type's template, with writing hints as HTML comments (removed on save). An untouched body is replaced;
  // edited text is replaced only when the person agrees (after they change the type themselves).
  useEffect(() => {
    let stale = false;
    api<{ body_md: string }>(`/templates/${type}?hints=true`)
      .then(async (t) => {
        if (stale) return;
        setTypeTemplate(t.body_md);
        const current = bodyRef.current;
        const untouched = current.trim() === "" || current === templateRef.current;
        let replace = untouched;
        if (!untouched && typeChosen.current && current !== t.body_md) {
          const ok = await confirm({
            title: `Replace your text with the ${typeLabel(type)} template?`,
            body: "Your text is replaced by the template's sections.",
            confirmLabel: "Replace",
            cancelLabel: "Keep my text",
          });
          replace = !!ok;
        }
        if (stale) return;
        if (replace) setBody(t.body_md);
        templateRef.current = t.body_md;
        setTemplate(t.body_md);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setComponents([]), [scope]);

  async function save() {
    if (saving) return;
    const errs = { title: title.trim() ? undefined : "Enter a title" };
    setErrors(errs);
    if (errs.title) return requestAnimationFrame(() => focusFirstInvalid(form.current));
    setSaving(true);
    setError(null);
    try {
      const res = await api<WriteResult>("/articles", { method: "POST", body: { scope, type, title: title.trim(), path: path.trim(), body_md: body, components } });
      clearDraft("new-article");
      setResult(res);
      refreshCounts();
      await finishHandoff(origin, { item_id: res.article_id, revision_id: res.revision_id }, toast);
      if (res.published) {
        navigate(`/article/${res.article_id}`);
        toast.success("Published", { description: outcomeNotes(res).join(" ") || undefined });
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }
  useSaveKeys(() => void save(), !result);

  const sections = templateSections(typeTemplate);
  const typeHint = [typeDescription(type), sections.length ? `Sections: ${sections.join(", ")}` : null].filter(Boolean).join(". ");
  const header = (
    <PageHeader crumbs={scopeInfo ? [{ label: scopeName(scopes, scopeInfo), href: scopeHref(scopeInfo) }] : []} title="New article" scope={scope} actions={<WritingGuideToggle />} hideTabBar />
  );
  const guide = useGuidePlacement(<WritingGuide kind="article" type={type} filled={filledSections(body)} />);

  if (result && !result.published && result.article_id)
    return (
      <Page width="form">
        {header}
        <ProposalOutcome res={result} kind="article" itemId={result.article_id} isNew />
      </Page>
    );

  return (
    <Page width="content" rail={guide.rail} railLabel="Writing guide">
      {header}
      {guide.top}
      <form ref={form} className="it-editor" noValidate onSubmit={(e: FormEvent) => (e.preventDefault(), void save())}>
        <InboxCallout origin={origin} />
        {prefill && <Callout tone="warning">Drafted from pasted text. Check every section before saving.</Callout>}
        <DraftOffer
          offer={autosave.offer}
          onRestore={(t) => {
            const d = parseDraft<{ title: string; body: string }>(t);
            if (d) {
              setTitle(d.title ?? "");
              setBody(d.body ?? "");
            }
            autosave.dismiss();
          }}
          onDiscard={() => {
            clearDraft("new-article");
            autosave.dismiss();
          }}
        />
        <div className="it-editor-row">
          <Field label="Where">
            <ProjectPicker searchable value={scope} onChange={setScope} scopes={scopes} />
          </Field>
          <Field label="Type" hint={typeHint}>
            <Select
              value={type}
              onChange={(e) => {
                typeChosen.current = true;
                setType(e.target.value);
              }}
              {...typeGroups("article", articleTypes.length ? articleTypes : [...ARTICLE_TYPES])}
            />
          </Field>
        </div>
        <Field label="Title" error={errors.title} counter={{ value: title.length, max: 200 }}>
          <TextInput className="it-title-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Folder" optional hint="Pick an existing folder or type a new one.">
          <TextInput list={folderList} value={path} onChange={(e) => setPath(e.target.value)} placeholder="e.g. Contracts or Systems/Payments" autoComplete="off" />
        </Field>
        <FolderSuggestions scope={scope} id={folderList} />
        <RepoChips scope={scopeInfo} value={components} onChange={setComponents} />
        <Field
          label="Body"
          hint={
            <>
              Sections follow the {typeLabel(type)} template. The grey <code>{"<!-- Hint -->"}</code> lines are removed when you save. You can add images once the article exists.
            </>
          }
        >
          <Editor value={body} onChange={setBody} rows={22} label="Body" />
        </Field>
        {!!error && <ErrorState compact error={error} title="Couldn't save" />}
        <FormActions sticky status={<AutosaveStatus savedAt={autosave.savedAt} />} hint={reviewHint(publish, scopeName(scopes, scopeInfo))}>
          <Button variant="ghost" href={scopeInfo ? scopeHref(scopeInfo) : href("/")}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={saving} loadingText="Saving…" shortcut="mod+s">
            {primaryLabel(publish, true)}
          </Button>
        </FormActions>
      </form>
    </Page>
  );
}

// ---- New finding ----

function SimilarFindings({ title }: { title: string }) {
  const q = useDebouncedValue(title.trim(), 500);
  const search = useApi<{ articles: SearchHit[]; findings: SearchHit[] }>(q.length >= 3 ? `/search?${new URLSearchParams({ q, limit: "5" })}` : null);
  const hits = q.length >= 3 ? (search.data?.findings ?? []) : [];
  return (
    <Card title="Similar findings" padding="sm" as="section" description="Update one of these instead if it's the same problem.">
      {q.length < 3 ? (
        <p className="it-rail-empty">Findings with a similar title show up here as you type.</p>
      ) : search.loading && !search.data ? (
        <SkeletonRows count={2} density="compact" />
      ) : search.error ? (
        <ErrorState compact error={search.error} onRetry={search.reload} title="Couldn't look for similar findings" />
      ) : hits.length === 0 ? (
        <p className="it-rail-empty">Nothing similar yet.</p>
      ) : (
        <ul className="it-rail-list" aria-busy={search.loading || undefined}>
          {hits.map((h) => (
            <li key={h.id} className="it-rail-row">
              <a href={href(`/finding/${h.id}`)}>{h.title}</a>
              <span className="it-rail-meta">
                <LocationLabel scope={h.scope} /> · <TypeLabel type={h.type} kind="finding" />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function NewFindingPage({ route, scopes, findingTypes }: { route: Route; scopes: ScopeInfo[]; findingTypes: string[] }) {
  const { me } = useBoot();
  const toast = useToast();
  const prefill = usePrefill("finding");
  const [origin] = useState(() => peekInboxOrigin("finding"));
  const [scope, setScope] = useState(route.query.get("scope") || scopes[0]?.slug || "team");
  const [type, setType] = useState(prefill?.type ?? "rca");
  const empty = { title: prefill?.title ?? "", symptoms: prefill?.symptoms ?? "", root_cause: prefill?.root_cause ?? "", fix: prefill?.fix ?? "" };
  const [fields, setFields] = useState<FindingText>(empty);
  const autosave = useAutosave("new-finding", JSON.stringify(fields), JSON.stringify(empty));
  const [components, setComponents] = useState<string[]>([]);
  const [saving, setSaving] = useState<false | "save" | "new">(false);
  const [error, setError] = useState<unknown>(null);
  const [errors, setErrors] = useState<FindingErrors>({});
  const [result, setResult] = useState<WriteResult | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const scopeInfo = scopes.find((s) => s.slug === scope);
  const publish = can.publishIn(scopeInfo, me);
  const dirty = JSON.stringify(fields) !== JSON.stringify(empty);
  useUnsavedChangesGuard(dirty && !saving && !(result && result.status !== "duplicates_found"));
  useEffect(() => setComponents([]), [scope]);

  async function save(forceNew = false) {
    if (saving) return;
    const errs = validateFinding(fields);
    setErrors(errs);
    if (Object.values(errs).some(Boolean)) return requestAnimationFrame(() => focusFirstInvalid(form.current));
    setSaving(forceNew ? "new" : "save");
    setError(null);
    try {
      const res = await api<WriteResult>("/findings", {
        method: "POST",
        body: { scope, type, ...fields, title: fields.title.trim(), components, force_new: forceNew || undefined },
      });
      setResult(res);
      if (res.status !== "duplicates_found") {
        clearDraft("new-finding");
        refreshCounts();
        await finishHandoff(origin, { item_id: res.finding_id, revision_id: res.revision_id }, toast);
      }
      if (res.published) {
        navigate(`/finding/${res.finding_id}`);
        toast.success("Published", { description: outcomeNotes(res).join(" ") || undefined });
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }
  useSaveKeys(() => void save(), !(result && result.status === "pending_review"));

  const header = (
    <PageHeader crumbs={scopeInfo ? [{ label: scopeName(scopes, scopeInfo), href: findingsHref(scopeInfo) }] : []} title="New finding" scope={scope} actions={<WritingGuideToggle />} hideTabBar />
  );
  const guide = useGuidePlacement(<WritingGuide kind="finding" type={type} filled={filledFields(fields)} />);

  if (result?.status === "pending_review" && !result.published && result.finding_id)
    return (
      <Page width="form">
        {header}
        <ProposalOutcome res={result} kind="finding" itemId={result.finding_id} isNew />
      </Page>
    );

  return (
    <Page
      width="form"
      rail={
        <>
          {guide.rail}
          <SimilarFindings title={fields.title} />
        </>
      }
      railLabel="Writing guide and similar findings"
    >
      {header}
      {guide.top}
      <form ref={form} className="it-editor" noValidate onSubmit={(e: FormEvent) => (e.preventDefault(), void save())}>
        <InboxCallout origin={origin} />
        {prefill && <Callout tone="warning">Drafted from pasted text. Check the root cause and fix before saving.</Callout>}
        <DraftOffer
          offer={autosave.offer}
          onRestore={(t) => {
            const d = parseDraft<FindingText>(t);
            if (d) setFields({ ...empty, ...d });
            autosave.dismiss();
          }}
          onDiscard={() => {
            clearDraft("new-finding");
            autosave.dismiss();
          }}
        />
        <div className="it-editor-row">
          <Field label="Where">
            <ProjectPicker searchable value={scope} onChange={setScope} scopes={scopes} />
          </Field>
          <Field label="Type" hint={typeDescription(type)}>
            <Select value={type} onChange={(e) => setType(e.target.value)} {...typeGroups("finding", findingTypes.length ? findingTypes : [...FINDING_TYPES])} />
          </Field>
        </div>
        <FindingFields fields={fields} onChange={setFields} errors={errors} before={<RepoChips scope={scopeInfo} value={components} onChange={setComponents} />} />
        {result?.status === "duplicates_found" && (
          <Callout
            tone="warning"
            live
            title="This looks like a finding that already exists"
            actions={
              <Button size="sm" loading={saving === "new"} loadingText="Saving…" onClick={() => void save(true)}>
                Save as new
              </Button>
            }
          >
            <p>Update one of them instead, or save this as a new finding if it's a different problem.</p>
            <ul className="it-duplicates">
              {result.duplicates?.map((d) => (
                <li key={d.id}>
                  <a href={href(`/finding/${d.id}`)}>{d.title}</a> <LocationLabel scope={d.scope} /> <span className="it-overlap">{Math.round(d.overlap * 100)}% overlap</span>
                </li>
              ))}
            </ul>
          </Callout>
        )}
        {!!error && <ErrorState compact error={error} title="Couldn't save" />}
        <FormActions sticky status={<AutosaveStatus savedAt={autosave.savedAt} />} hint={reviewHint(publish, scopeName(scopes, scopeInfo))}>
          <Button variant="ghost" href={scopeInfo ? findingsHref(scopeInfo) : href("/")}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={saving === "save"} loadingText="Saving…" shortcut="mod+s">
            {primaryLabel(publish, true)}
          </Button>
        </FormActions>
      </form>
    </Page>
  );
}

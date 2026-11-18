import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type Me, type ScopeInfo, type SearchHit } from "../api";
import { useBoot } from "../components/boot";
import { useLiveSearch } from "../components/find";
import { setInboxOrigin, type InboxOrigin } from "../components/handoff";
import { I, type IconName } from "../components/icons";
import {
  AsyncBlock,
  BulkBar,
  Button,
  Callout,
  Checkbox,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  focusFirstInvalid,
  humanizeError,
  ListRow,
  LoadMore,
  LocationLabel,
  MetaLine,
  NewItemsPill,
  OverflowMenu,
  Page,
  PageHeader,
  ProjectPicker,
  RelativeTime,
  RowList,
  RunWithClaude,
  SearchInput,
  Section,
  SegmentedControl,
  Select,
  Sheet,
  SkeletonRows,
  SplitButton,
  SplitView,
  Spinner,
  StatusBadge,
  TextInput,
  TypeLabel,
  ChoiceCards,
  useConfirm,
  useSplitView,
  useToast,
} from "../components/kit";
import { plural, SOURCE_KIND } from "../components/labels";
import { can } from "../components/permissions";
import { Markdown } from "../components/ui";
import { refreshCounts, replaceRoute, useApi, useAppRoute, useLiveRefresh, useMediaQuery, useQueryState, useShortcuts } from "../hooks";
import { pickFilters, SavedViews } from "../components/saved-views";
import { draftArticle, draftFinding, setPrefill } from "../paste";
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

interface SourcesData {
  sources: Source[];
  kinds: KindInfo[];
  enabled: boolean;
}

type Status = "new" | "filed" | "dismissed";

interface InboxItem {
  id: string;
  title: string;
  url: string | null;
  author: string | null;
  excerpt: string;
  published_at: string | null;
  fetched_at: string;
  status: Status;
  updated: boolean;
  resolution_note: string | null;
  item_kind: "article" | "finding" | null;
  item_id: string | null;
  source_id: string;
  source: string;
  source_kind: Kind;
  scope: string;
  resolved_by: string | null;
  resolved_at: string | null;
}

interface InboxList {
  items: InboxItem[];
  counts: Record<string, number>;
}

interface FullItem {
  title: string;
  body: string;
  url: string | null;
}

const KIND_ICON: Record<Kind, IconName> = { rss: "rss", web: "globe", hackernews: "hash", slack: "message", notion: "doc", tavily: "search" };

const KIND_DESCRIPTION: Record<Kind, string> = {
  rss: "New posts from an RSS or Atom feed.",
  web: "Changes to a web page, or to one part of it.",
  hackernews: "Hacker News stories that match your search.",
  slack: "Busy threads from a Slack channel.",
  notion: "Pages shared with your Notion integration.",
  tavily: "New web search results for a query.",
};

const kindLabel = (k: string) => SOURCE_KIND[k] ?? k;

const INTERVALS: [number, string][] = [
  [60, "Every hour"],
  [180, "Every 3 hours"],
  [360, "Every 6 hours"],
  [720, "Twice a day"],
  [1440, "Daily"],
  [10080, "Weekly"],
];

const intervalText = (m: number) => INTERVALS.find(([n]) => n === m)?.[1] ?? `Every ${m} min`;

const STATUSES: { value: Status; label: string }[] = [
  { value: "new", label: "New" },
  { value: "filed", label: "Filed" },
  { value: "dismissed", label: "Dismissed" },
];

const DISMISS_PRESETS = ["Already known", "Off-topic", "Duplicate", "Not relevant"];
const DISMISS_REASON = { label: "Why?", required: true, placeholder: "e.g. already known, off-topic", presets: DISMISS_PRESETS, maxLength: 1000 };

const PAGE_SIZE = 100;
/** The inbox filters a saved view keeps (server: core/views.ts). */
const INBOX_VIEW_KEYS = ["status", "scope", "source"] as const;

/** Where sources can be added: projects with Manage settings; Team space and Library for Administrators. */
const managesSourcesIn = (me: Me) => (s: ScopeInfo) =>
  s.kind === "project" ? can.inScope(s, "manage_settings", me) : (s.kind === "team" || s.kind === "library") && can.manageSpaceSettings(me);

/** Markdown excerpt as plain text for the list. */
function plain(md: string) {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#*_`>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const draftText = (f: FullItem) => `${f.title}\n\n${f.body}${f.url ? `\n\nSource: ${f.url}` : ""}`;
const originOf = (i: InboxItem): InboxOrigin => ({ inbox_id: i.id, title: i.title, source_name: i.source, url: i.url });
const quoted = (t: string, max = 40) => `“${t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t}”`;

/** Runs `fn` over `list` with at most `limit` calls in flight. */
async function pool<T>(list: T[], limit: number, fn: (t: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < list.length) await fn(list[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

// ---- Inbox --------------------------------------------------------------------------------------------

type RowState = { busy?: "draft" | "file" | "dismiss" | "reopen"; error?: { message: string; retry?: () => void } };

export function InboxPage({ route, scopes }: { route: Route; scopes: ScopeInfo[] }) {
  const boot = useBoot();
  const me = boot.me;
  const toast = useToast();
  const confirm = useConfirm();
  const phone = useMediaQuery("(max-width: 860px)");
  const [query, setQuery] = useQueryState(route, { status: "new", scope: "", source: "" });
  const status: Status = STATUSES.some((s) => s.value === query.status) ? (query.status as Status) : "new";
  const scope = query.scope ?? "";
  const source = query.source ?? "";
  const path = `/inbox?${new URLSearchParams({ status, limit: String(PAGE_SIZE), ...(scope ? { scope } : {}), ...(source ? { source } : {}) })}`;
  const result = useApi<InboxList>(path);
  const { data, reload } = result;
  const sourceList = useApi<SourcesData>("/sources");
  const manager = scopes.some(managesSourcesIn(me));

  const [extra, setExtra] = useState<InboxItem[]>([]);
  const [lastPageFull, setLastPageFull] = useState<boolean | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [pending, setPending] = useState(0);
  const [filing, setFiling] = useState<InboxItem | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  // ≥ 1280px: the chosen row (click, or j/k) shows in a pane on the right with its full text and actions.
  const split = useSplitView();
  const [cursorId, setCursorId] = useState<string | null>(null);

  // A new filter is a new list: drop what belonged to the old one.
  useEffect(() => {
    setExtra([]);
    setLastPageFull(null);
    setHidden(new Set());
    setSelected(new Set());
    setRows({});
    setPending(0);
    setCursorId(null);
  }, [path]);

  const items = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    return [...data.items, ...extra].filter((i) => !hidden.has(i.id) && !seen.has(i.id) && (seen.add(i.id), true));
  }, [data, extra, hidden]);

  // Source names for the Source filter: what the list has shown plus the sources this person manages.
  const sourceNames = useRef(new Map<string, string>());
  for (const s of sourceList.data?.sources ?? []) sourceNames.current.set(s.id, s.name);
  for (const i of [...(data?.items ?? []), ...extra]) sourceNames.current.set(i.source_id, i.source);
  const sourceOptions = [...sourceNames.current.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));

  // Live updates: new rows wait behind a pill so the list doesn't move under the reader.
  const pathRef = useRef(path);
  pathRef.current = path;
  const shownRef = useRef<Set<string>>(new Set());
  shownRef.current = new Set(items.map((i) => i.id));
  const onLive = useCallback(() => {
    const p = pathRef.current;
    api<InboxList>(p)
      .then((d) => {
        if (p !== pathRef.current) return;
        const fresh = d.items.filter((i) => !shownRef.current.has(i.id)).length;
        if (fresh > 0 && shownRef.current.size > 0) setPending(fresh);
        else reload();
      })
      .catch(() => {
        /* the next change or a manual action refreshes it */
      });
  }, [reload]);
  useLiveRefresh(onLive);

  const scopeInfo = (slug: string) => boot.scope(slug) ?? scopes.find((s) => s.slug === slug);
  const scopeName = (slug: string) => scopeInfo(slug)?.name ?? slug;
  const blockedReason = (i: InboxItem) => (can.inScope(scopeInfo(i.scope), "propose", me) ? undefined : `You can't add knowledge in ${scopeName(i.scope)}`);

  const patchRow = (id: string, patch: RowState | null) =>
    setRows((r) => {
      const next = { ...r };
      if (patch === null) delete next[id];
      else next[id] = { ...r[id], ...patch };
      return next;
    });
  const hide = (id: string) => setHidden((h) => new Set(h).add(id));
  const unhide = (id: string) =>
    setHidden((h) => {
      const next = new Set(h);
      next.delete(id);
      return next;
    });
  const unselect = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  const afterChange = () => {
    refreshCounts();
    reload();
  };

  /** Runs a row action with its busy state; a failure shows on the row with Try again. */
  async function onRow(item: InboxItem, busy: NonNullable<RowState["busy"]>, fn: () => Promise<void>) {
    patchRow(item.id, { busy, error: undefined });
    try {
      await fn();
      patchRow(item.id, null);
    } catch (e) {
      patchRow(item.id, { busy: undefined, error: { message: humanizeError(e).title, retry: () => void onRow(item, busy, fn) } });
    }
  }

  const fetchFull = (i: InboxItem) => api<FullItem>(`/inbox/${i.id}`);
  const reopen = async (id: string) => {
    await api(`/inbox/${id}/reopen`, { method: "POST" });
    unhide(id);
    afterChange();
  };

  function createDraft(item: InboxItem) {
    void onRow(item, "draft", async () => {
      const full = await fetchFull(item);
      try {
        sessionStorage.setItem("thaliyola.pasteDraft", draftText(full));
      } catch {
        /* storage unavailable: the paste page opens empty */
      }
      setInboxOrigin(originOf(item), "finding");
      navigate("/new/paste", { inbox: item.id, scope: item.scope });
    });
  }

  function draftNow(item: InboxItem, kind: "finding" | "article") {
    void onRow(item, "draft", async () => {
      const text = draftText(await fetchFull(item));
      setPrefill(kind === "finding" ? draftFinding(text) : draftArticle(text));
      setInboxOrigin(originOf(item), kind);
      navigate(`/new/${kind}`, { scope: item.scope });
    });
  }

  async function dismiss(item: InboxItem) {
    const r = await confirm({
      title: `Dismiss ${quoted(item.title)}?`,
      body: "It moves to Dismissed with your reason. Back to new brings it back.",
      confirmLabel: "Dismiss",
      reason: DISMISS_REASON,
    });
    if (!r) return;
    await onRow(item, "dismiss", async () => {
      await api(`/inbox/${item.id}/resolve`, { method: "POST", body: { outcome: "dismissed", note: r.reason } });
      hide(item.id);
      unselect(item.id);
      afterChange();
      toast.success("Dismissed", { undo: () => reopen(item.id) });
    });
  }

  function backToNew(item: InboxItem) {
    void onRow(item, "reopen", async () => {
      await api(`/inbox/${item.id}/reopen`, { method: "POST" });
      hide(item.id);
      afterChange();
      const outcome = item.status;
      toast.success("Moved back to New", {
        undo:
          outcome === "new"
            ? undefined
            : async () => {
                await api(`/inbox/${item.id}/resolve`, {
                  method: "POST",
                  body: { outcome, ...(item.resolution_note ? { note: item.resolution_note } : {}), ...(item.item_id ? { item_id: item.item_id } : {}) },
                });
                unhide(item.id);
                afterChange();
              },
      });
    });
  }

  function onFiled(item: InboxItem, hit: SearchHit) {
    setFiling(null);
    hide(item.id);
    unselect(item.id);
    afterChange();
    toast.success(`Filed to ${quoted(hit.title)}`, { undo: () => reopen(item.id) });
  }

  async function bulkDismiss() {
    const list = items.filter((i) => selected.has(i.id));
    if (!list.length) return;
    const r = await confirm({
      title: `Dismiss ${plural(list.length, "item")}?`,
      body: "They move to Dismissed with the same reason. Back to new brings any of them back.",
      confirmLabel: `Dismiss ${list.length}`,
      reason: DISMISS_REASON,
    });
    if (!r) return;
    setBulkBusy(true);
    const done: InboxItem[] = [];
    const failed: { item: InboxItem; error: unknown }[] = [];
    await pool(list, 3, async (item) => {
      try {
        await api(`/inbox/${item.id}/resolve`, { method: "POST", body: { outcome: "dismissed", note: r.reason } });
        done.push(item);
        hide(item.id);
      } catch (error) {
        failed.push({ item, error });
      }
    });
    setBulkBusy(false);
    setSelected(new Set(failed.map((f) => f.item.id)));
    for (const f of failed) patchRow(f.item.id, { error: { message: `Couldn't dismiss: ${humanizeError(f.error).title}` } });
    afterChange();
    const undo = done.length ? () => Promise.all(done.map((i) => reopen(i.id))) : undefined;
    if (!failed.length) toast.success(`Dismissed ${plural(done.length, "item")}`, { undo });
    else
      toast.warning(`Dismissed ${done.length} of ${list.length}`, {
        description: `Couldn't dismiss: ${failed.map((f) => quoted(f.item.title, 30)).join(", ")}. They stay selected.`,
        undo,
      });
  }

  async function loadMore() {
    setMoreBusy(true);
    try {
      const d = await api<InboxList>(`${path}&offset=${items.length}`);
      setExtra((e) => [...e, ...d.items]);
      setLastPageFull(d.items.length >= PAGE_SIZE);
    } catch (e) {
      toast.error(e, { title: "Couldn't load more items" });
    } finally {
      setMoreBusy(false);
    }
  }

  function showPending() {
    setPending(0);
    reload();
  }

  const paneItem = split ? ((cursorId ? items.find((i) => i.id === cursorId) : undefined) ?? items[0]) : undefined;
  const sourceHrefOf = (i: InboxItem) => href("/inbox", { status: status === "new" ? undefined : status, scope: scope || undefined, source: i.source_id });
  const handlersFor = (i: InboxItem) => ({
    onCreateDraft: () => createDraft(i),
    onDraftNow: (k: "finding" | "article") => draftNow(i, k),
    onFile: () => setFiling(i),
    onDismiss: () => void dismiss(i),
    onBackToNew: () => backToNew(i),
  });
  /** j/k in the split view: the next or previous row, scrolled into view. */
  const step = (delta: number) => {
    if (!items.length) return;
    const at = paneItem ? items.findIndex((i) => i.id === paneItem.id) : -1;
    const next = items[Math.max(0, Math.min(items.length - 1, at + delta))]!;
    setCursorId(next.id);
    document.getElementById(`ib-row-${next.id}`)?.scrollIntoView({ block: "nearest" });
  };
  useShortcuts({ j: () => step(1), k: () => step(-1) }, split && items.length > 0, { group: "Inbox", labels: { j: "Next item", k: "Previous item" } });
  /** A click on a row (not on its links, buttons or checkbox) chooses it for the pane. */
  const chooseRow = (e: React.MouseEvent) => {
    if (!split) return;
    const t = e.target as HTMLElement;
    if (t.closest("a, button, input, label, [role='menu'], .popover")) return;
    const li = t.closest<HTMLElement>('li[id^="ib-row-"]');
    if (li) setCursorId(li.id.slice("ib-row-".length));
  };

  const counts = data?.counts ?? {};
  const selectable = status === "new" ? items.filter((i) => !blockedReason(i)) : [];
  const allSelected = selectable.length > 0 && selectable.every((i) => selected.has(i.id));
  const total = source ? undefined : (counts[status] ?? 0);
  const canLoadMore = total !== undefined ? items.length < total : (lastPageFull ?? (data?.items.length ?? 0) >= PAGE_SIZE);

  const statusControl = (
    <SegmentedControl
      label="Status"
      options={STATUSES.map((s) => ({ value: s.value, label: s.label, count: counts[s.value] ?? 0 }))}
      value={status}
      onChange={(v) => setQuery({ status: v })}
    />
  );
  // With no source at all and nothing ever received, the filters and zero counts are noise: show only the empty state.
  const noSources = !!data && !!sourceList.data && sourceList.data.sources.length === 0 && !Object.values(counts).some((n) => n > 0) && !scope && !source;
  const active = [
    ...(scope ? [{ id: "scope", label: `Where: ${scopeName(scope)}`, onRemove: () => setQuery({ scope: undefined }) }] : []),
    ...(source ? [{ id: "source", label: `Source: ${sourceNames.current.get(source) ?? "One source"}`, onRemove: () => setQuery({ source: undefined }) }] : []),
  ];

  return (
    <Page width={split ? "wide" : "content"}>
      <PageHeader
        title="Inbox"
        nav="inbox"
        description="New items from your team's feeds, watched pages, Slack threads, Notion pages and searches. Turn useful ones into drafts or dismiss the rest."
        info={{
          label: "Let Claude triage this",
          content: (
            <div className="ib-info">
              <p>Claude, connected to Thaliyola, can go through the inbox for you: it drafts what's worth keeping for review and dismisses the rest with a reason.</p>
              <RunWithClaude command="/mcp__thaliyola__triage-inbox" description="The triage-inbox prompt works through the New items you can see." />
            </div>
          ),
        }}
        actions={
          <Button href={href("/sources")} icon="rss">
            {manager ? "Manage sources" : "Sources"}
          </Button>
        }
      />

      {phone && !noSources && <div className="ib-status">{statusControl}</div>}
      {!noSources && (
      <FilterBar
        segments={phone ? undefined : statusControl}
        filters={
          <>
            <Field label="Where" labelHidden className="ib-filter">
              <ProjectPicker value={scope} onChange={(v) => setQuery({ scope: v || undefined })} scopes={scopes} noneLabel="Everywhere" />
            </Field>
            <Field label="Source" labelHidden className="ib-filter">
              <Select value={source} onChange={(e) => setQuery({ source: e.target.value || undefined })} options={[{ value: "", label: "All sources" }, ...sourceOptions]} />
            </Field>
          </>
        }
        views={
          <SavedViews
            area="inbox"
            current={pickFilters(route.query, INBOX_VIEW_KEYS)}
            apply={(v) => setQuery(Object.fromEntries(INBOX_VIEW_KEYS.map((k) => [k, v[k]])))}
            summary={[`Status: ${STATUSES.find((s) => s.value === status)!.label}`, ...active.map((a) => a.label)]}
          />
        }
        active={active}
        onClearAll={active.length ? () => setQuery({ scope: undefined, source: undefined }) : undefined}
        result={data ? (total !== undefined ? plural(total, `${status === "new" ? "new" : status} item`) : plural(items.length, "item")) : undefined}
      />
      )}

      <NewItemsPill count={pending} noun={["item", "items"]} onShow={showPending} />

      <AsyncBlock result={result} label="Loading the inbox" skeleton={<SkeletonRows count={5} />} errorTitle="Couldn't load the inbox">
        {() =>
          !items.length ? (
            <InboxEmpty
              status={status}
              filtered={!!(scope || source)}
              onClear={() => setQuery({ scope: undefined, source: undefined })}
              hasSources={(sourceList.data?.sources.length ?? 0) > 0 || Object.values(counts).some((n) => n > 0)}
              manager={manager}
            />
          ) : (
            <>
              {selectable.length > 0 && (
                <div className="ib-select-all">
                  <Checkbox
                    label={`Select all ${plural(selectable.length, "item")} shown`}
                    checked={allSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((i) => i.id)) : new Set())}
                  />
                </div>
              )}
              <BulkBar count={selected.size} noun={["item", "items"]} onClear={() => setSelected(new Set())}>
                <Button size="sm" icon="x" loading={bulkBusy} loadingText="Dismissing" onClick={() => void bulkDismiss()}>
                  Dismiss {selected.size}…
                </Button>
              </BulkBar>
              <SplitView
                active={split}
                detailLabel="Selected item"
                detail={
                  paneItem && (
                    <InboxPane key={paneItem.id} item={paneItem} state={rows[paneItem.id] ?? {}} blocked={blockedReason(paneItem)} sourceHref={sourceHrefOf(paneItem)} {...handlersFor(paneItem)} />
                  )
                }
                list={
                  <div className="ib-list" onClick={chooseRow}>
                    <RowList label={`${STATUSES.find((s) => s.value === status)!.label} inbox items`} refreshing={result.loading}>
                      {items.map((i) => (
                        <InboxRow
                          key={i.id}
                          item={i}
                          state={rows[i.id] ?? {}}
                          blocked={blockedReason(i)}
                          sourceHref={sourceHrefOf(i)}
                          selected={status === "new" && !blockedReason(i) ? { checked: selected.has(i.id), onChange: (on) => (on ? setSelected((s) => new Set(s).add(i.id)) : unselect(i.id)) } : undefined}
                          inSplit={split}
                          cursor={split && paneItem?.id === i.id}
                          {...handlersFor(i)}
                        />
                      ))}
                    </RowList>
                    <LoadMore shown={items.length} total={total} noun={["item", "items"]} busy={moreBusy} onMore={canLoadMore ? () => void loadMore() : undefined} />
                  </div>
                }
              />
            </>
          )
        }
      </AsyncBlock>

      {filing && <FileDialog item={filing} onClose={() => setFiling(null)} onFiled={(hit) => onFiled(filing, hit)} />}
    </Page>
  );
}
InboxPage.keepMountedOnQuery = true;

function InboxEmpty({ status, filtered, onClear, hasSources, manager }: { status: Status; filtered: boolean; onClear(): void; hasSources: boolean; manager: boolean }) {
  if (filtered)
    return (
      <EmptyState
        variant="search"
        title={status === "new" ? "Nothing new here" : status === "filed" ? "Nothing filed here" : "Nothing dismissed here"}
        description="Nothing matches this place or source. Try another, or clear the filters."
        primary={<Button onClick={onClear}>Clear filters</Button>}
      />
    );
  if (status === "filed")
    return <EmptyState title="Nothing filed yet" description="Items that become drafts, or that you file to an existing article or finding, show up here." />;
  if (status === "dismissed") return <EmptyState title="Nothing dismissed yet" description="Items you dismiss show up here with the reason." />;
  if (hasSources)
    return (
      <EmptyState
        variant="positive"
        title="You're all caught up"
        description="Nothing waiting. New items from your sources show up here."
        secondary={<Button href={href("/sources")}>{manager ? "Manage sources" : "See sources"}</Button>}
      />
    );
  if (manager)
    return (
      <EmptyState
        icon="rss"
        title="No sources yet"
        description="Nothing waiting. Add a feed, a watched page, a Slack channel, Notion pages or a web search, and new items show up here."
        primary={
          <Button variant="primary" icon="plus" href={href("/sources", { add: "1" })}>
            Add a source
          </Button>
        }
      />
    );
  return (
    <EmptyState
      variant="locked"
      title="No sources yet"
      description="Nothing waiting. Project admins (Manage settings) add sources to their projects; Administrators to Team and Library."
      secondary={<Button href={href("/sources")}>See sources</Button>}
    />
  );
}

interface RowHandlers {
  onCreateDraft(): void;
  onDraftNow(kind: "finding" | "article"): void;
  onFile(): void;
  onDismiss(): void;
  onBackToNew(): void;
}

function InboxRow({
  item,
  state,
  blocked,
  sourceHref,
  selected,
  inSplit,
  cursor,
  ...handlers
}: {
  item: InboxItem;
  state: RowState;
  blocked?: string;
  sourceHref: string;
  selected?: { checked: boolean; onChange(on: boolean): void };
  /** In the split view the pane carries the full text and the actions. */
  inSplit?: boolean;
  cursor?: boolean;
} & RowHandlers) {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<{ body?: string; error?: unknown; loading?: boolean }>({});
  const bodyId = useId();
  const excerpt = plain(item.excerpt);
  const excerptRef = useRef<HTMLParagraphElement>(null);
  const [clipped, setClipped] = useState(false);
  // The server cuts the excerpt at 400 characters; anything that long has more to show.
  const truncated = item.excerpt.length >= 400;

  // Offer "Show full text" whenever the 3-line clamp actually hides something, at any width.
  useLayoutEffect(() => {
    const el = excerptRef.current;
    if (!el) return;
    const check = () => setClipped(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", check);
      return () => window.removeEventListener("resize", check);
    }
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [excerpt, open]);

  async function loadFull() {
    setFull({ loading: true });
    try {
      setFull({ body: (await api<FullItem>(`/inbox/${item.id}`)).body });
    } catch (error) {
      setFull({ error });
    }
  }

  function toggleFull() {
    const next = !open;
    setOpen(next);
    if (next && full.body === undefined && !full.loading) void loadFull();
  }

  const showFull = open && !inSplit;
  return (
    <ListRow
      id={`ib-row-${item.id}`}
      cursor={cursor}
      title={<InboxTitle item={item} />}
      badges={item.updated ? <StatusBadge domain="inbox" value="updated" /> : undefined}
      selectable={selected ? { ...selected, label: `Select ${item.title}` } : undefined}
      selected={selected?.checked}
      error={state.error ? <RowError state={state} /> : undefined}
      extra={
        <>
          <div className="ib-meta">
            <InboxMeta item={item} sourceHref={sourceHref} />
          </div>
          {showFull ? (
            <div className="ib-full" id={bodyId}>
              {full.loading ? (
                <SkeletonRows count={2} density="compact" />
              ) : full.error ? (
                <ErrorState compact error={full.error} title="Couldn't load the full text" onRetry={() => void loadFull()} />
              ) : (
                <Markdown text={full.body || excerpt} />
              )}
            </div>
          ) : (
            excerpt && (
              <p className="ib-excerpt" ref={excerptRef}>
                {excerpt}
              </p>
            )
          )}
          {!inSplit && (open || clipped || truncated) && (
            <button type="button" className="link-btn ib-more" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={toggleFull}>
              {open ? "Show less" : "Show full text"}
            </button>
          )}
          {!inSplit && <Resolution item={item} />}
          {!inSplit && <InboxActions item={item} state={state} blocked={blocked} {...handlers} />}
        </>
      }
    />
  );
}

function InboxTitle({ item }: { item: InboxItem }) {
  return item.url ? (
    <a className="ib-title-link" href={item.url} target="_blank" rel="noopener noreferrer nofollow">
      {item.title}
      <I name="external" size={14} />
      <span className="sr-only"> (opens the original in a new tab)</span>
    </a>
  ) : (
    <>{item.title}</>
  );
}

function InboxMeta({ item, sourceHref }: { item: InboxItem; sourceHref: string }) {
  return (
    <MetaLine
      items={[
        <span key="k" className="ib-kind">
          <I name={KIND_ICON[item.source_kind] ?? "rss"} size={14} />
          {kindLabel(item.source_kind)}
        </span>,
        <a key="s" href={sourceHref} title="Show only this source">
          {item.source}
        </a>,
        <LocationLabel key="l" scope={item.scope} />,
        item.author ? <span key="a">by {item.author}</span> : null,
        <RelativeTime key="t" date={item.published_at ?? item.fetched_at} />,
      ]}
    />
  );
}

function RowError({ state }: { state: RowState }) {
  if (!state.error) return null;
  return (
    <>
      {state.error.message}{" "}
      {state.error.retry && (
        <button type="button" className="link-btn" onClick={state.error.retry}>
          Try again
        </button>
      )}
    </>
  );
}

/** "Filed by … · Open the finding", for items no longer new. */
function Resolution({ item }: { item: InboxItem }) {
  if (item.status === "new") return null;
  return (
    <p className="ib-resolution">
      <I name={item.status === "filed" ? "check-circle" : "x"} size={14} />
      <span>
        {item.status === "filed" ? "Filed" : "Dismissed"}
        {item.resolved_by ? ` by ${item.resolved_by}` : ""}
        {item.resolved_at && (
          <>
            {" · "}
            <RelativeTime date={item.resolved_at} />
          </>
        )}
        {item.resolution_note ? `: ${item.resolution_note}` : ""}
        {item.item_id && item.item_kind && (
          <>
            {" · "}
            <a href={href(`/${item.item_kind}/${item.item_id}`)}>Open the {item.item_kind}</a>
          </>
        )}
      </span>
    </p>
  );
}

/** Create draft ▾, File to existing…, Dismiss… (new items) or Back to new. */
function InboxActions({ item, state, blocked, onCreateDraft, onDraftNow, onFile, onDismiss, onBackToNew }: { item: InboxItem; state: RowState; blocked?: string } & RowHandlers) {
  return item.status === "new" ? (
    <div className="ib-actions">
      <SplitButton
        variant="secondary"
        icon="pencil"
        label="Create draft"
        onClick={onCreateDraft}
        loading={state.busy === "draft"}
        loadingText="Opening the draft"
        disabledReason={blocked}
        menuLabel="More ways to draft"
        menu={[
          { id: "finding", label: "Draft a finding now", hint: "Skip the paste step", onSelect: () => onDraftNow("finding") },
          { id: "article", label: "Draft an article now", hint: "Skip the paste step", onSelect: () => onDraftNow("article") },
        ]}
      />
      <Button variant="ghost" icon="link" disabledReason={blocked} loading={state.busy === "file"} onClick={onFile}>
        File to existing…
      </Button>
      <Button variant="ghost" icon="x" disabledReason={blocked} loading={state.busy === "dismiss"} loadingText="Dismissing" onClick={onDismiss}>
        Dismiss…
      </Button>
    </div>
  ) : (
    <div className="ib-actions">
      <Button size="sm" icon="undo" disabledReason={blocked} loading={state.busy === "reopen"} loadingText="Moving back" onClick={onBackToNew}>
        Back to new
      </Button>
    </div>
  );
}

/** The split view's pane: the selected item's full text and its actions. */
function InboxPane({ item, state, blocked, sourceHref, ...handlers }: { item: InboxItem; state: RowState; blocked?: string; sourceHref: string } & RowHandlers) {
  const full = useApi<FullItem>(`/inbox/${item.id}`);
  return (
    <div className="ib-pane">
      <div className="ib-pane-head">
        <h2 className="ib-pane-title">
          <InboxTitle item={item} />
        </h2>
        <InboxMeta item={item} sourceHref={sourceHref} />
      </div>
      <InboxActions item={item} state={state} blocked={blocked} {...handlers} />
      {state.error && (
        <p className="ib-pane-error" role="alert">
          <RowError state={state} />
        </p>
      )}
      {blocked && <p className="muted small">{blocked}.</p>}
      <Resolution item={item} />
      <div className="ib-pane-body">
        {full.error ? (
          <ErrorState compact error={full.error} title="Couldn't load the full text" onRetry={full.reload} />
        ) : !full.data ? (
          <div aria-busy="true">
            <span className="sr-only" role="status">
              Loading the full text
            </span>
            <SkeletonRows count={3} density="compact" />
          </div>
        ) : (
          <Markdown text={full.data.body || plain(item.excerpt)} />
        )}
      </div>
    </div>
  );
}

/** "File to existing…": pick an article or finding; the inbox item is filed against it. */
function FileDialog({ item, onClose, onFiled }: { item: InboxItem; onClose(): void; onFiled(hit: SearchHit): void }) {
  const [q, setQ] = useState("");
  const hits = useLiveSearch(q, 8);
  const [pick, setPick] = useState<SearchHit | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const name = useId();

  async function file() {
    if (!pick) {
      setPickError("Choose an article or finding first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/inbox/${item.id}/resolve`, { method: "POST", body: { outcome: "filed", item_id: pick.id } });
      onFiled(pick);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!busy}
      title="File to an existing article or finding"
      description={`${quoted(item.title, 60)} moves to Filed and links to what you pick.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} loadingText="Filing" onClick={() => void file()}>
            File here
          </Button>
        </>
      }
    >
      <div className="ib-file">
        <SearchInput value={q} onChange={setQ} label="Find an article or finding" placeholder="Search by title or words in it" autoFocus resultCount={hits?.length} />
        {hits === null ? (
          <p className="ib-hint">Type at least 2 characters to search.</p>
        ) : !hits.length ? (
          <EmptyState variant="compact" icon="search" title="No matches" description="Try other words, or create a draft instead." />
        ) : (
          <fieldset className="ib-pick-list">
            <legend className="sr-only">Matches</legend>
            {hits.map((h) => (
              <label key={h.id} className="ib-pick" data-state={pick?.id === h.id ? "checked" : undefined}>
                <input
                  type="radio"
                  name={name}
                  checked={pick?.id === h.id}
                  onChange={() => {
                    setPick(h);
                    setPickError(null);
                  }}
                />
                <span className="ib-pick-text">
                  <span className="ib-pick-title">{h.title}</span>
                  <span className="ib-pick-meta">
                    <MetaLine items={[<TypeLabel key="t" type={h.type} kind={h.kind} withIcon />, <LocationLabel key="l" scope={h.scope} />]} />
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {pickError && (
          <p className="ib-field-error" role="alert">
            {pickError}
          </p>
        )}
        {error ? <ErrorState compact error={error} title="Couldn't file it" /> : null}
      </div>
    </Dialog>
  );
}

// ---- Sources -------------------------------------------------------------------------------------------

const health = (s: Source) => (!s.enabled ? "paused" : s.last_error ? "failing" : s.last_run_at ? "ok" : "never");
const watched = (s: Source) => s.config.url ?? s.config.query ?? s.config.channel ?? s.config.database_id ?? "all shared pages";

export function SourcesPage({ scopes, me }: { scopes: ScopeInfo[]; me: Me }) {
  const route = useAppRoute();
  const result = useApi<SourcesData>("/sources");
  const { data, reload } = result;
  const toast = useToast();
  const confirm = useConfirm();
  // Projects where they have Manage settings; Team space and Library for Administrators.
  const manageable = scopes.filter(managesSourcesIn(me));
  const [sheet, setSheet] = useState<{ source: Source | null } | null>(route.query.get("add") === "1" && manageable.length ? { source: null } : null);
  const [rows, setRows] = useState<Record<string, { busy?: "check" | "toggle" | "remove"; error?: string }>>({});

  const patchRow = (id: string, patch: { busy?: "check" | "toggle" | "remove"; error?: string } | null) =>
    setRows((r) => {
      const next = { ...r };
      if (patch === null) delete next[id];
      else next[id] = { ...r[id], ...patch };
      return next;
    });

  function closeSheet() {
    setSheet(null);
    if (route.query.get("add")) replaceRoute("/sources");
  }

  async function checkNow(s: Source) {
    patchRow(s.id, { busy: "check", error: undefined });
    try {
      const r = await api<{ added: number; updated: number; error?: string }>(`/sources/${s.id}/run`, { method: "POST" });
      patchRow(s.id, null);
      if (r.error) toast.error(r.error, { title: `Couldn't check ${s.name}` });
      else toast.success(`${s.name}: ${r.added} new, ${r.updated} updated.`, r.added ? { link: { label: "View new items", href: href("/inbox", { source: s.id }) } } : undefined);
      reload();
      refreshCounts();
    } catch (e) {
      patchRow(s.id, { error: `Couldn't check it: ${humanizeError(e).title}` });
    }
  }

  async function setEnabled(s: Source, enabled: boolean) {
    await api(`/sources/${s.id}`, { method: "PATCH", body: { enabled } });
    reload();
  }

  async function toggle(s: Source) {
    patchRow(s.id, { busy: "toggle", error: undefined });
    try {
      await setEnabled(s, !s.enabled);
      patchRow(s.id, null);
      toast.success(s.enabled ? `Paused ${s.name}` : `Resumed ${s.name}`, { undo: () => setEnabled(s, s.enabled) });
    } catch (e) {
      patchRow(s.id, { error: `Couldn't ${s.enabled ? "pause" : "resume"} it: ${humanizeError(e).title}` });
    }
  }

  async function remove(s: Source) {
    const ok = await confirm({
      title: `Remove ${s.name} and its inbox items?`,
      body: `It stops being checked, and its items leave the inbox${s.new_items ? ` (${plural(s.new_items, "item")} waiting)` : ""}. This can't be undone.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    patchRow(s.id, { busy: "remove", error: undefined });
    try {
      await api(`/sources/${s.id}`, { method: "DELETE" });
      patchRow(s.id, null);
      toast.success(`Removed ${s.name}`);
      reload();
      refreshCounts();
    } catch (e) {
      patchRow(s.id, { error: `Couldn't remove it: ${humanizeError(e).title}` });
    }
  }

  const groups = useMemo(() => {
    const out: { scope: string; name: string; sources: Source[] }[] = [];
    for (const s of data?.sources ?? []) {
      const g = out.find((x) => x.scope === s.scope);
      if (g) g.sources.push(s);
      else out.push({ scope: s.scope, name: s.scope_name, sources: [s] });
    }
    return out;
  }, [data]);

  return (
    <Page width="content">
      <PageHeader
        title="Sources"
        nav="inbox"
        crumbs={[{ label: "Inbox", href: href("/inbox") }]}
        description="Where the inbox gets new items. Checked on a schedule; nothing is published automatically."
        primary={
          manageable.length > 0 ? (
            <Button variant="primary" icon="plus" onClick={() => setSheet({ source: null })} disabledReason={data ? undefined : "Wait for the page to load"}>
              Add a source
            </Button>
          ) : undefined
        }
      />

      {data && !data.enabled && (
        <Callout tone="warning" title="Sources are kept but not checked right now.">
          Fetching is turned off on this server, so nothing new arrives until an Administrator turns it back on.
        </Callout>
      )}
      {!manageable.length && (
        <Callout tone="info" title="You can't manage sources here.">
          Project admins (Manage settings) add sources to their projects; Administrators to Team and Library.
        </Callout>
      )}

      <AsyncBlock result={result} label="Loading sources" skeleton={<SkeletonRows count={3} />} errorTitle="Couldn't load sources">
        {(d) =>
          !d.sources.length ? (
            manageable.length ? (
              <EmptyState
                icon="rss"
                title="No sources yet"
                description="Add a feed, a watched page, a Slack channel, Notion pages or a web search. New items land in the inbox for your team to sort."
                secondary={
                  <Button icon="plus" onClick={() => setSheet({ source: null })}>
                    Add a source
                  </Button>
                }
              />
            ) : null
          ) : (
            <div className="ib-groups">
              {groups.map((g) => (
                <Section key={g.scope} title={g.name} count={g.sources.length}>
                  <RowList label={`Sources for ${g.name}`} refreshing={result.loading}>
                    {g.sources.map((s) => {
                      const row = rows[s.id] ?? {};
                      return (
                        <ListRow
                          key={s.id}
                          leading={<I name={KIND_ICON[s.kind] ?? "rss"} size={20} />}
                          title={s.name}
                          badges={<StatusBadge domain="source" value={health(s)} />}
                          description={<span className="ib-watched">{watched(s)}</span>}
                          meta={
                            <MetaLine
                              items={[
                                kindLabel(s.kind),
                                `→ ${s.scope_name}`,
                                intervalText(s.interval_minutes),
                                s.last_run_at ? <RelativeTime key="c" prefix="Checked " date={s.last_run_at} /> : s.enabled ? "Not checked yet" : null,
                                s.last_count ? `${s.last_count} new last time` : null,
                                s.new_items > 0 ? (
                                  <a key="w" href={href("/inbox", { scope: s.scope, source: s.id })}>
                                    {s.new_items} waiting
                                  </a>
                                ) : null,
                              ]}
                            />
                          }
                          extra={
                            s.last_error ? (
                              <Disclosure summary={<span className="ib-error-text">Last check failed</span>}>
                                <p className="ib-error-detail">{s.last_error}</p>
                              </Disclosure>
                            ) : undefined
                          }
                          error={row.error}
                          actions={
                            <>
                              {row.busy === "toggle" || row.busy === "remove" ? (
                                <span className="ib-row-busy" role="status">
                                  <Spinner />
                                  {row.busy === "remove" ? "Removing…" : s.enabled ? "Pausing…" : "Resuming…"}
                                </span>
                              ) : (
                                <Button size="sm" icon="refresh" loading={row.busy === "check"} loadingText="Checking…" onClick={() => void checkNow(s)}>
                                  Check now
                                </Button>
                              )}
                              <OverflowMenu
                                label={`More actions for ${s.name}`}
                                size="sm"
                                items={[
                                  {
                                    id: "edit",
                                    label: "Edit…",
                                    icon: "pencil",
                                    onSelect: () => setSheet({ source: s }),
                                    disabledReason: row.busy === "remove" ? "Wait for the current action to finish" : undefined,
                                  },
                                  {
                                    id: "toggle",
                                    label: s.enabled ? "Pause" : "Resume",
                                    icon: s.enabled ? "pause" : "play",
                                    onSelect: () => void toggle(s),
                                    disabledReason: row.busy ? "Wait for the current action to finish" : undefined,
                                  },
                                  { type: "separator" },
                                  {
                                    id: "remove",
                                    label: "Remove…",
                                    icon: "trash",
                                    tone: "danger",
                                    onSelect: () => void remove(s),
                                    disabledReason: row.busy ? "Wait for the current action to finish" : undefined,
                                  },
                                ]}
                              />
                            </>
                          }
                        />
                      );
                    })}
                  </RowList>
                </Section>
              ))}
            </div>
          )
        }
      </AsyncBlock>

      <Disclosure summary="Setup details: Slack, Notion and web search" className="ib-setup">
        <div className="ib-setup-body">
          <p>These need a credential in the server's environment (an Administrator sets it in the env file and restarts):</p>
          <ul>
            <li>
              <strong>Slack:</strong> <code>SLACK_BOT_TOKEN</code>, a bot with <code>channels:history</code> (<code>groups:history</code> for private channels) and <code>users:read</code>.
              Invite it to each channel you add.
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
        </div>
      </Disclosure>

      {sheet && data && manageable.length > 0 && (
        <SourceSheet
          source={sheet.source}
          kinds={data.kinds}
          scopes={scopes}
          manageable={manageable}
          onClose={closeSheet}
          onSaved={() => {
            closeSheet();
            reload();
            refreshCounts();
          }}
        />
      )}
    </Page>
  );
}

interface SourceForm {
  kind: Kind;
  config: Record<string, string>;
  scope: string;
  every: number;
  name: string;
}

/** Add a source, or edit one (`source`): a right sheet on desktop, a bottom sheet on phones. */
function SourceSheet({
  source,
  kinds,
  scopes,
  manageable,
  onClose,
  onSaved,
}: {
  source: Source | null;
  kinds: KindInfo[];
  scopes: ScopeInfo[];
  manageable: ScopeInfo[];
  onClose(): void;
  onSaved(): void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const editing = !!source;
  const initial = useMemo<SourceForm>(
    () =>
      source
        ? { kind: source.kind, config: { ...source.config }, scope: source.scope, every: source.interval_minutes, name: source.name }
        : { kind: kinds.find((k) => k.kind === "rss")?.kind ?? kinds[0]!.kind, config: {}, scope: manageable[0]?.slug ?? "", every: 360, name: "" },
    [source, kinds, manageable],
  );
  const [form, setForm] = useState<SourceForm>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<{ items: { title: string; url?: string | null; published_at?: string | null }[]; total: number } | null>(null);
  const [busy, setBusy] = useState<"preview" | "save" | null>(null);
  const [error, setError] = useState<{ during: "preview" | "save"; error: unknown } | null>(null);
  const info = kinds.find((k) => k.kind === form.kind) ?? kinds[0]!;
  const notSetUp = info.configured ? undefined : `${info.label} needs ${info.needs} in the server's environment. An Administrator can add it and restart the service.`;
  const notSetUpKinds = kinds.filter((k) => !k.configured);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const manageableSlugs = new Set(manageable.map((s) => s.slug));
  const phone = useMediaQuery("(max-width: 640px)");
  const intervals = INTERVALS.some(([m]) => m === form.every) ? INTERVALS : [...INTERVALS, [form.every, intervalText(form.every)] as [number, string]];

  const set = (patch: Partial<SourceForm>) => setForm((f) => ({ ...f, ...patch }));
  const setField = (key: string, value: string) => {
    setForm((f) => ({ ...f, config: { ...f.config, [key]: value } }));
    setErrors((e) => ({ ...e, [key]: "" }));
    setPreview(null);
  };

  function pickKind(kind: Kind) {
    const next = kinds.find((k) => k.kind === kind);
    if (!next) return;
    // Keep what was typed into fields both kinds share (a URL, a query); drop the rest.
    setForm((f) => ({ ...f, kind, config: Object.fromEntries(Object.entries(f.config).filter(([key]) => next.fields.some((x) => x.key === key))) }));
    setErrors({});
    setPreview(null);
  }

  function validate() {
    const errs: Record<string, string> = {};
    for (const f of info.fields) {
      const v = (form.config[f.key] ?? "").trim();
      if (f.required && !v) errs[f.key] = `Add the ${f.label.charAt(0).toLowerCase()}${f.label.slice(1)}.`;
      else if (v && f.key === "url" && !/^https?:\/\/\S+\.\S+/i.test(v)) errs[f.key] = "Enter a full web address, starting with https://";
    }
    if (!form.scope) errs.scope = "Choose where the items go.";
    setErrors(errs);
    if (Object.keys(errs).length) {
      requestAnimationFrame(() => formRef.current && focusFirstInvalid(formRef.current));
      return false;
    }
    return true;
  }

  const tidy = (c: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(c)
        .map(([k, v]) => [k, String(v ?? "").trim()] as const)
        .filter(([key, v]) => v && info.fields.some((f) => f.key === key))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  const config = () => tidy(form.config);
  // Sending config resets the source's fetch state (feed etag, page hash, "since" marks), so only send it when it changed.
  const configChanged = () => !source || JSON.stringify(config()) !== JSON.stringify(tidy(source.config));

  async function run(kind: "preview" | "save", fn: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError({ during: kind, error: e });
    } finally {
      setBusy(null);
    }
  }

  function doPreview() {
    if (!validate()) return;
    void run("preview", async () => setPreview(await api("/sources/preview", { method: "POST", body: { kind: form.kind, scope: form.scope, config: config() } })));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !validate()) return;
    void run("save", async () => {
      if (source) {
        const s = await api<{ name: string }>(`/sources/${source.id}`, {
          method: "PATCH",
          body: { name: form.name.trim(), scope: form.scope, interval_minutes: form.every, ...(configChanged() ? { config: config() } : {}) },
        });
        toast.success(`Saved ${s.name}`);
        onSaved();
        return;
      }
      const s = await api<{ id: string; name: string }>("/sources", {
        method: "POST",
        body: { kind: form.kind, scope: form.scope, name: form.name.trim(), config: config(), interval_minutes: form.every },
      });
      // Fill the inbox right away instead of waiting for the schedule.
      const r = await api<{ added: number; error?: string }>(`/sources/${s.id}/run`, { method: "POST" }).catch((err: unknown) => ({ added: 0, error: humanizeError(err).title }));
      if (r.error) toast.warning(`Added ${s.name}, but the first check failed: ${r.error}`, { duration: 10000 });
      else toast.success(`Added ${s.name}: ${plural(r.added, "item")} in the inbox`, r.added ? { link: { label: "Open the inbox", href: href("/inbox", { source: s.id }) } } : undefined);
      onSaved();
    });
  }

  async function close() {
    if (busy) return;
    if (dirty) {
      const ok = await confirm({
        title: editing ? "Discard your changes?" : "Discard this source?",
        body: "What you entered here is lost.",
        confirmLabel: "Discard",
        cancelLabel: "Keep editing",
        tone: "danger",
      });
      if (!ok) return;
    }
    onClose();
  }

  return (
    <Sheet
      open
      side={phone ? "bottom" : "right"}
      onClose={() => void close()}
      dismissible={!busy}
      title={editing ? `Edit ${source!.name}` : "Add a source"}
      description={editing ? undefined : "Thaliyola checks it on a schedule and puts what's new in the inbox."}
      footer={
        <>
          <Button variant="ghost" onClick={() => void close()} disabled={!!busy}>
            Cancel
          </Button>
          <Button onClick={doPreview} loading={busy === "preview"} loadingText="Previewing…" disabledReason={notSetUp ?? (busy === "save" ? "Wait for the save to finish" : undefined)}>
            Preview
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={busy === "save"}
            loadingText={editing ? "Saving…" : "Adding and checking…"}
            disabledReason={notSetUp ?? (busy === "preview" ? "Wait for the preview to finish" : undefined)}
          >
            {editing ? "Save changes" : "Add source"}
          </Button>
        </>
      }
    >
      <form id={formId} ref={formRef} className="ib-source-form" onSubmit={submit} noValidate>
        {editing ? (
          <p className="ib-kind-fixed">
            <I name={KIND_ICON[form.kind] ?? "rss"} size={16} /> {info.label}
          </p>
        ) : (
          <ChoiceCards
            name={`${formId}-kind`}
            legend="What to watch"
            value={form.kind}
            onChange={(v) => pickKind(v as Kind)}
            options={kinds.map((k) => ({
              value: k.kind,
              label: k.label,
              icon: KIND_ICON[k.kind] ?? "rss",
              description: KIND_DESCRIPTION[k.kind],
              badge: k.configured ? undefined : "Needs Administrator setup",
              disabledReason: k.configured ? undefined : `Needs ${k.needs} on the server.`,
            }))}
          />
        )}
        {!editing && notSetUpKinds.length > 0 && (
          <p className="ib-setup-note">
            {notSetUpKinds.map((k) => k.label).join(", ")} {notSetUpKinds.length === 1 ? "needs" : "need"} {notSetUpKinds.map((k) => k.needs).join(", ")} in the server's
            environment. An Administrator can add {notSetUpKinds.length === 1 ? "it" : "them"} and restart the service.
          </p>
        )}
        {editing && notSetUp && <Callout tone="warning">{notSetUp}</Callout>}

        {info.fields.map((f) => (
          <Field key={`${form.kind}-${f.key}`} label={f.label} optional={!f.required} hint={f.hint} error={errors[f.key] || null}>
            <TextInput
              value={form.config[f.key] ?? ""}
              onChange={(e) => setField(f.key, e.target.value)}
              inputMode={f.key === "url" ? "url" : undefined}
              spellCheck={f.key === "url" || f.key.endsWith("_id") || f.key === "channel" ? false : undefined}
            />
          </Field>
        ))}

        <Field label="Send items to" error={errors.scope || null}>
          <ProjectPicker
            searchable
            value={form.scope}
            onChange={(v) => {
              set({ scope: v });
              setErrors((e) => ({ ...e, scope: "" }));
            }}
            scopes={scopes}
            filter={(s) => manageableSlugs.has(s.slug)}
          />
        </Field>
        <Field label="How often to check">
          <Select value={String(form.every)} onChange={(e) => set({ every: Number(e.target.value) })} options={intervals.map(([m, label]) => ({ value: String(m), label }))} />
        </Field>
        <Field label="Name" optional hint={editing ? undefined : "Leave it empty to use the address or search terms."}>
          <TextInput value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Payment provider changelog" maxLength={120} />
        </Field>

        {preview && (
          <section className="ib-preview" aria-label="What we found">
            <h3 className="ib-preview-title">What we found</h3>
            <p className="ib-preview-count">
              {preview.total
                ? `${plural(preview.total, "item")} found${preview.total > preview.items.length ? `, first ${preview.items.length}` : ""}:`
                : "Nothing found right now."}
            </p>
            {preview.items.length > 0 && (
              <ul className="ib-preview-list">
                {preview.items.map((p, n) => (
                  <li key={n}>
                    <span className="ib-preview-item">{p.title}</span>
                    {p.published_at && (
                      <span className="ib-preview-date">
                        {" · "}
                        <RelativeTime date={p.published_at} />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {error && <ErrorState compact error={error.error} title={error.during === "preview" ? "Couldn't preview this source" : editing ? "Couldn't save your changes" : "Couldn't add the source"} />}
      </form>
    </Sheet>
  );
}

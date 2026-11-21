/**
 * Review (SPEC §6.5): the queue of proposals, Needs a check, Suggestions and New projects, and the proposal page.
 * Prefix for page CSS: rv- (styles/pages/review.css).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type RevisionSummary } from "../api";
import { useBoot } from "../components/boot";
import { CATEGORY, REPO_KIND, humanize, labelFrom, plural, summaryText, typeLabel, type Category } from "../components/labels";
import { can } from "../components/permissions";
import { Markdown } from "../components/ui";
import { I } from "../components/icons";
import { pickFilters, SavedViews } from "../components/saved-views";
import { SkillReviewTab } from "./skills";
import {
  Badge,
  BulkBar,
  Button,
  Callout,
  Card,
  CategoryBadge,
  ChipGroup,
  Disclosure,
  DiffView,
  EmptyState,
  ErrorState,
  Facts,
  Field,
  FilterBar,
  GroupHeader,
  InfoTip,
  ItemRow,
  KeyHint,
  ListRow,
  LoadMore,
  LocationLabel,
  MetaLine,
  NewItemsPill,
  OverflowMenu,
  Page,
  PageHeader,
  PersonChip,
  ProjectPicker,
  RelativeTime,
  RowList,
  RunWithClaude,
  Section,
  SegmentedControl,
  Select,
  SkeletonRows,
  SkeletonText,
  SplitView,
  StatusBadge,
  Tabs,
  Textarea,
  TextInput,
  TypeLabel,
  useConfirm,
  useToast,
  useSplitView,
  useUnsavedChangesGuard,
  type MenuItemSpec,
} from "../components/kit";
import { refreshCounts, useApi, useLiveRefresh, useMediaQuery, useQueryState, useShortcuts } from "../hooks";
import { href, navigate, type Route } from "../router";

// ---- Shared constants ----------------------------------------------------------------------------------

/** Review category of each proposal operation. */
const CATEGORY_OF: Record<string, Category> = { create: "new", update: "edit", promote: "edit", move: "move", share: "share", verify: "retire" };
/** Category groups keep this order. */
const CATEGORY_ORDER: Category[] = ["new", "edit", "move", "share", "retire"];
const STATES = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
] as const;
/** Query parameters the queue keeps in the URL, so a filtered view can be bookmarked or shared. */
const FILTER_KEYS = ["state", "category", "scope", "type", "author", "assigned", "q", "sort", "group"] as const;
/** The ones "Clear all" removes (state, sort and group are kept). */
const CLEARABLE = ["category", "scope", "type", "author", "assigned", "q"] as const;
type GroupBy = "category" | "project" | "type" | "none";

const REJECT_PRESETS = ["Duplicate", "Not accurate", "Wrong place", "Needs more detail"];
const OUTDATED_REASON = "Outdated: the entry changed since this was proposed.";
const WHO_APPROVES = "Proposals from agents and teammates. Whoever has Review where a proposal lands (Reviewers, Moderators and Project admins) approves it.";

const AUTHOR_LABEL: Record<string, string> = { people: "People", agents: "AI agents", me: "Mine" };
const ASSIGNED_LABEL: Record<string, string> = { to_review: "Waiting for me", me: "Assigned to me", none: "Unassigned" };

/** Whole calendar days since `iso`, rounded the way RelativeTime rounds them (so "Waiting 1 day" and "yesterday" agree). */
const age = (iso: string) => {
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.max(0, Math.round((dayStart(new Date()) - dayStart(new Date(iso))) / 86_400_000));
};
const isEmail = (s: string | null | undefined) => !!s && s.includes("@");
/** A person shown by display name (the part before @ for an email); the email stays the tooltip. */
/** A person from the API: an email or identifier (`who`) and their display name when the server sent one. */
const person = (who: string | null | undefined, kind?: "human" | "service", size: "sm" | "md" = "sm", name?: string | null) =>
  who ? <PersonChip name={name || (isEmail(who) ? null : who)} email={isEmail(who) ? who : null} kind={kind ?? "human"} size={size} /> : null;
/** In a sentence: their name, else the start of their email, else the identifier as is. */
const nameOf = (who: string | null | undefined, name?: string | null) => name || (!who ? "someone" : isEmail(who) ? who.split("@")[0]! : who);
const reword403 = (e: unknown) => (e instanceof ApiError && e.status === 403 ? new Error(`You can't approve here: ${e.message}`) : e);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** "4 Nov", or "4 Nov 2025" in another year (for sentences; lists use RelativeTime). */
const shortDate = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
};

/** Runs `fn` over `items`, at most `limit` at a time, reporting progress. */
async function runPool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>, onProgress: (done: number) => void) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        await fn(item);
      } finally {
        onProgress(++done);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---- Queue context (shared with the proposal page) ------------------------------------------------------

const QUEUE_KEY = "thaliyola.reviewQueue";
interface QueueRow {
  author: string;
  author_name?: string | null;
  author_kind?: "human" | "service";
  created_at: string;
  reviewer: string | null;
  reviewer_name?: string | null;
  decided_via?: string | null;
  state: string;
  reason: string | null;
  category: string;
  scope_name?: string;
  can_review?: boolean;
}
interface QueueContext {
  query: string;
  ids: string[];
  rows: Record<string, QueueRow>;
}

function readQueue(): QueueContext | null {
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueueContext) : null;
  } catch {
    return null;
  }
}
function writeQueue(ctx: QueueContext) {
  try {
    sessionStorage.setItem(QUEUE_KEY, JSON.stringify(ctx));
  } catch {
    // Storage full or blocked: the proposal page falls back to today's rules.
  }
}
/** The stored queue view ("Review" crumb and "Back to the queue"), or the plain queue. */
function queueHref(ctx = readQueue()): string {
  return ctx ? href("/review", Object.fromEntries(new URLSearchParams(ctx.query))) : href("/review");
}
function goToQueue() {
  window.location.hash = queueHref().replace(/^#/, "");
}

// ---- Page --------------------------------------------------------------------------------------------

type TabId = "proposals" | "check" | "suggestions" | "projects" | "skills";

export function ReviewQueuePage({ route }: { route: Route }) {
  const raw = route.query.get("tab");
  const { me } = useBoot();
  const seesSkills = can.reviewSkills(me) || can.manageSkills(me);
  const tab: TabId = raw === "check" || raw === "suggestions" || raw === "projects" || (raw === "skills" && seesSkills) ? raw : "proposals";
  // Tab counts, where the data is loaded: proposals always (cheap), the others while their tab is open.
  const pending = useApi<{ facets?: { states?: Record<string, number>; to_review?: number } }>("/revisions?state=pending&limit=1&facets=true");
  // The same number as the sidebar's Review badge: the ones waiting for you when there are any, else all pending.
  const toReviewCount = pending.data?.facets?.to_review ?? 0;
  const proposalsCount = toReviewCount > 0 ? toReviewCount : pending.data?.facets?.states?.pending;
  const reloadPending = pending.reload;
  useEffect(() => {
    window.addEventListener("thaliyola:counts", reloadPending);
    return () => window.removeEventListener("thaliyola:counts", reloadPending);
  }, [reloadPending]);
  const [counts, setCounts] = useState<{ check?: number; projects?: number }>({});
  const skillCounts = useApi<{ to_review: number; pending: number; feedback: number }>(seesSkills ? "/skills/review/counts" : null);
  const reloadSkillCounts = skillCounts.reload;
  const report = useCallback((k: "check" | "projects", n: number) => setCounts((c) => (c[k] === n ? c : { ...c, [k]: n })), []);
  // Suggestions are loaded here so the header's Refresh can show its busy state.
  const sugg = useApi<Suggestions>(tab === "suggestions" ? "/suggestions" : null);
  const tasks = useApi<TaskSummary>(tab === "suggestions" ? "/tasks" : null);
  const phone = useMediaQuery("(max-width: 860px)");
  // On phones header actions fold into a "More actions" sheet; a lone Refresh reads better in the tab itself.
  const refresh = (
    <Button
      icon="refresh"
      size={phone ? "sm" : "md"}
      loading={sugg.loading || tasks.loading}
      loadingText="Refreshing"
      onClick={() => {
        sugg.reload();
        tasks.reload();
      }}
    >
      Refresh
    </Button>
  );

  const split = useSplitView();
  return (
    <Page width={split && tab === "proposals" ? "wide" : "content"}>
      <PageHeader
        title="Review"
        nav="review"
        description="Changes proposed by teammates and AI agents. Nothing is published until someone with review rights approves it."
        info={{ label: "Who can approve?", content: <p>{WHO_APPROVES}</p> }}
        actions={tab === "suggestions" && !phone ? refresh : undefined}
        tabs={
          <Tabs
            label="Review"
            value={tab}
            items={[
              { id: "proposals", label: "Proposals", href: href("/review"), count: proposalsCount, countTone: toReviewCount > 0 ? "accent" : "neutral" },
              { id: "check", label: "Needs a check", href: href("/review", { tab: "check" }), count: counts.check },
              { id: "suggestions", label: "Suggestions", href: href("/review", { tab: "suggestions" }) },
              { id: "projects", label: "New projects", href: href("/review", { tab: "projects" }), count: counts.projects },
              {
                id: "skills",
                label: "Skills",
                href: href("/review", { tab: "skills" }),
                hidden: !seesSkills,
                // Like the sidebar: the ones waiting for you when there are any, else everything open.
                count: skillCounts.data ? skillCounts.data.to_review || skillCounts.data.pending + skillCounts.data.feedback || undefined : undefined,
                countTone: (skillCounts.data?.to_review ?? 0) > 0 ? "accent" : "neutral",
              },
            ]}
          />
        }
      />
      {tab === "check" ? (
        <CheckTab route={route} onCount={(n) => report("check", n)} />
      ) : tab === "suggestions" ? (
        <SuggestionsTab sugg={sugg} tasks={tasks} refresh={phone ? refresh : undefined} />
      ) : tab === "projects" ? (
        <ProjectRequestsTab onCount={(n) => report("projects", n)} />
      ) : tab === "skills" ? (
        <SkillReviewTab onChanged={reloadSkillCounts} />
      ) : (
        <Queue route={route} />
      )}
    </Page>
  );
}
ReviewQueuePage.keepMountedOnQuery = true;

// ---- Queue -------------------------------------------------------------------------------------------

interface Facets {
  states: Record<string, number>;
  categories: Record<string, number>;
  projects: { slug: string; name: string; kind: string; count: number }[];
  types: Record<string, number>;
  authors: Record<string, number>;
  to_review: number;
}
type QueueData = { revisions: RevisionSummary[]; facets?: Facets };

interface Group {
  key: string;
  label: string;
  hint?: string;
  tone?: "success" | "accent" | "neutral" | "danger";
  /** The filter that shows only this group. */
  filter: Record<string, string>;
  rows: RevisionSummary[];
}

/** Splits the (already sorted) rows into groups, in a stable order: categories as listed, projects and types by size. */
function groupRows(rows: RevisionSummary[], by: GroupBy): Group[] {
  if (by === "none") return rows.length ? [{ key: "all", label: "All", filter: {}, rows }] : [];
  const map = new Map<string, Group>();
  for (const r of rows) {
    const key = by === "category" ? (CATEGORY_OF[r.op] ?? r.op) : by === "project" ? r.scope : r.target_type;
    let g = map.get(key);
    if (!g) {
      const cat = CATEGORY[key as Category];
      g =
        by === "category"
          ? { key, label: cat?.label ?? humanize(key), hint: cat?.hint, tone: cat?.tone as Group["tone"], filter: { category: key }, rows: [] }
          : by === "project"
            ? { key, label: r.scope_name ?? r.scope, hint: r.scope_kind && r.scope_kind !== "project" ? humanize(r.scope_kind) : undefined, filter: { scope: key }, rows: [] }
            : { key, label: typeLabel(key), filter: { type: key }, rows: [] };
      map.set(key, g);
    }
    g.rows.push(r);
  }
  const groups = [...map.values()];
  if (by === "category") groups.sort((a, b) => CATEGORY_ORDER.indexOf(a.key as Category) - CATEGORY_ORDER.indexOf(b.key as Category));
  else groups.sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
  return groups;
}

interface BulkResult {
  verb: "Approved" | "Rejected";
  done: number;
  total: number;
  failed: { id: string; error?: string; title: string }[];
}

function Queue({ route }: { route: Route }) {
  const [f, setQuery] = useQueryState(route);
  const toast = useToast();
  const confirm = useConfirm();

  // Older links used mine=1 / assigned=1.
  useEffect(() => {
    if (f.mine === "1") setQuery({ mine: undefined, author: "me" });
    if (f.assigned === "1") setQuery({ assigned: "me" });
  }, [f.mine, f.assigned, setQuery]);

  const state = f.state || "pending";
  const pending = state === "pending";
  const groupBy: GroupBy = (f.group as GroupBy) || (f.category ? "project" : "category");
  const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, f[k]]).filter(([k, v]) => v && !(k === "assigned" && v === "1"))) as Record<string, string>;
  const query = new URLSearchParams({ ...filters, facets: "true", limit: "200" }).toString();
  const path = `/revisions?${query}`;
  const result = useApi<QueueData>(path);
  const { data, error, loading, reload } = result;
  const facets = data?.facets;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [rowBusy, setRowBusy] = useState<Record<string, "approve" | "reject">>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<"approve" | "reject" | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const [newCount, setNewCount] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  // ≥ 1280px: the row under the cursor (click, or j/k) shows in a pane on the right with its main actions.
  const split = useSplitView();

  // Filter changes clear the selection and the keyboard cursor.
  const filterKey = FILTER_KEYS.map((k) => f[k] ?? "").join("|");
  useEffect(() => {
    setSelected(new Set());
    setCursorId(null);
    setPreview(new Set());
  }, [filterKey]);
  // Fresh data replaces the rows hidden after an action, and drops selected rows that are no longer there.
  useEffect(() => {
    setGone(new Set());
    setNewCount(0);
    const ids = new Set(data?.revisions.map((r) => r.id));
    setSelected((s) => ([...s].every((id) => ids.has(id)) ? s : new Set([...s].filter((id) => ids.has(id)))));
  }, [data]);

  const rows = useMemo(() => (data?.revisions ?? []).filter((r) => !gone.has(r.id)), [data, gone]);
  const reviewable = useMemo(() => rows.filter((r) => pending && r.can_review), [rows, pending]);
  const groups = useMemo(() => groupRows(rows, groupBy), [rows, groupBy]);
  const visible = useMemo(() => groups.flatMap((g) => (collapsed.has(g.key) ? [] : g.rows)), [groups, collapsed]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  // Save the queue context on every load, for the proposal page's crumbs, meta and "Next in queue".
  useEffect(() => {
    if (!data) return;
    const ctx: QueueContext = {
      query: new URLSearchParams(filters).toString(),
      ids: data.revisions.map((r) => r.id),
      rows: Object.fromEntries(
        data.revisions.map((r) => [
          r.id,
          {
            author: r.author,
            author_name: r.author_name,
            author_kind: r.author_kind,
            created_at: r.created_at,
            reviewer: r.reviewer,
            reviewer_name: r.reviewer_name,
            decided_via: r.decided_via,
            state: r.state,
            reason: r.reason,
            category: CATEGORY_OF[r.op] ?? r.op,
            scope_name: r.scope_name,
            can_review: r.can_review,
          },
        ]),
      ),
    };
    writeQueue(ctx);
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  // Live updates: new proposals wait behind a pill so rows don't move under the reader; other changes refetch.
  const known = useRef<Set<string>>(new Set());
  known.current = new Set(data?.revisions.map((r) => r.id));
  useLiveRefresh(
    useCallback(() => {
      api<QueueData>(path)
        .then((fresh) => {
          const added = fresh.revisions.filter((r) => !known.current.has(r.id)).length;
          if (added > 0) setNewCount(added);
          else reload();
        })
        .catch(() => undefined);
    }, [path, reload]),
  );

  const toggle = (id: string, on?: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });

  // ---- Keyboard: j/k move real focus between rows; x, o, a, r act on the focused row; A, R on the selection.
  const rowLinks = () => Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>('li[id^="rv-row-"] .list-row-title > a') ?? []);
  const focusedId = () => {
    const li = (document.activeElement as HTMLElement | null)?.closest?.('li[id^="rv-row-"]');
    return li ? li.id.slice("rv-row-".length) : cursorId;
  };
  const move = (delta: number) => {
    const links = rowLinks();
    if (!links.length) return;
    const id = focusedId();
    const i = id ? links.findIndex((a) => a.closest("li")?.id === `rv-row-${id}`) : -1;
    const next = links[i < 0 ? 0 : Math.max(0, Math.min(links.length - 1, i + delta))];
    next?.focus();
    next?.closest("li")?.scrollIntoView({ block: "nearest" });
  };
  /** After a row is approved or rejected, focus moves to the next row. */
  const focusAfter = (id: string) => {
    const links = rowLinks();
    const i = links.findIndex((a) => a.closest("li")?.id === `rv-row-${id}`);
    const target = links[i + 1] ?? links[i - 1];
    const targetId = target?.closest("li")?.id;
    requestAnimationFrame(() => (targetId ? document.getElementById(targetId)?.querySelector<HTMLAnchorElement>(".list-row-title > a")?.focus() : undefined));
  };

  async function decideRow(r: RevisionSummary, verb: "approve" | "reject") {
    let reason: string | undefined;
    if (verb === "reject") {
      const res = await confirm({
        title: `Reject “${r.summary || r.target_title}”?`,
        body: "The author sees your reason.",
        confirmLabel: "Reject",
        tone: "danger",
        reason: { label: "Why (the authors see this)", required: true, maxLength: 2000, presets: r.outdated ? [OUTDATED_REASON, ...REJECT_PRESETS] : REJECT_PRESETS },
      });
      if (!res) return;
      reason = res.reason;
    }
    setRowBusy((b) => ({ ...b, [r.id]: verb }));
    setRowError((e) => {
      const { [r.id]: _, ...rest } = e;
      return rest;
    });
    try {
      await api(`/revisions/${r.id}/${verb}`, { method: "POST", body: verb === "approve" ? {} : { reason } });
      focusAfter(r.id);
      setGone((g) => new Set(g).add(r.id));
      setSelected((s) => {
        const next = new Set(s);
        next.delete(r.id);
        return next;
      });
      toast.success(`${verb === "approve" ? "Approved" : "Rejected"} “${(r.summary || r.target_title).slice(0, 40)}”`);
      refreshCounts();
      reload();
    } catch (e) {
      setRowError((x) => ({ ...x, [r.id]: errText(reword403(e)) }));
    } finally {
      setRowBusy((b) => {
        const { [r.id]: _, ...rest } = b;
        return rest;
      });
    }
  }

  async function bulk(verb: "approve" | "reject") {
    const ids = [...selected].filter((id) => byId.get(id)?.can_review);
    if (!ids.length) return;
    let reason: string | undefined;
    const picked = ids.map((id) => byId.get(id)!);
    if (verb === "approve") {
      const risky = picked.some((r) => r.op === "move" || r.op === "verify");
      if (ids.length > 10 || risky) {
        const byCat = CATEGORY_ORDER.map((c) => [c, picked.filter((r) => CATEGORY_OF[r.op] === c).length] as const).filter(([, n]) => n > 0);
        const ok = await confirm({
          title: `Approve ${plural(ids.length, "proposal")}?`,
          body: (
            <>
              <p>Each one is published as proposed.</p>
              <ul>
                {byCat.map(([c, n]) => (
                  <li key={c}>
                    {CATEGORY[c].label}: {n}
                  </li>
                ))}
              </ul>
              {risky && <p>Moves re-file items in another place, and “Marked outdated” replaces them.</p>}
            </>
          ),
          confirmLabel: `Approve ${ids.length}`,
        });
        if (!ok) return;
      }
    } else {
      const res = await confirm({
        title: `Reject ${plural(ids.length, "proposal")}?`,
        body: "The authors see your reason.",
        confirmLabel: `Reject ${ids.length}`,
        tone: "danger",
        reason: { label: "Why (the authors see this)", required: true, maxLength: 2000, presets: REJECT_PRESETS },
      });
      if (!res) return;
      reason = res.reason;
    }
    setBulkBusy(verb);
    setBulkResult(null);
    try {
      const out = await api<{ approved?: number; rejected?: number; results: { id: string; ok: boolean; error?: string }[] }>(`/revisions/bulk-${verb}`, {
        method: "POST",
        body: verb === "approve" ? { ids } : { ids, reason },
      });
      const done = out.approved ?? out.rejected ?? out.results.filter((x) => x.ok).length;
      const failed = out.results.filter((x) => !x.ok).map((x) => ({ ...x, title: byId.get(x.id)?.summary || byId.get(x.id)?.target_title || "A proposal" }));
      const verbText = verb === "approve" ? "Approved" : "Rejected";
      setBulkResult({ verb: verbText, done, total: ids.length, failed });
      if (failed.length) toast.warning(`${verbText} ${done} of ${ids.length}`, { description: "See the list above the queue for the ones that failed." });
      else toast.success(`${verbText} ${plural(done, "proposal")}`);
      setSelected(new Set());
      refreshCounts();
      reload();
    } catch (e) {
      toast.error(reword403(e), { title: verb === "approve" ? "Couldn't approve them" : "Couldn't reject them" });
    } finally {
      setBulkBusy(null);
    }
  }

  const listKeys = {
    j: () => move(1),
    k: () => move(-1),
    x: () => {
      const id = focusedId();
      const r = id ? byId.get(id) : undefined;
      if (r && pending && r.can_review) toggle(r.id);
    },
    o: () => {
      const id = focusedId();
      if (id) navigate(`/review/${id}`);
    },
    a: () => {
      const r = byId.get(focusedId() ?? "");
      if (r && pending && r.can_review && !r.outdated && !rowBusy[r.id]) void decideRow(r, "approve");
    },
    r: () => {
      const r = byId.get(focusedId() ?? "");
      if (r && pending && r.can_review && !rowBusy[r.id]) void decideRow(r, "reject");
    },
    A: () => selected.size > 0 && !bulkBusy && void bulk("approve"),
    R: () => selected.size > 0 && !bulkBusy && void bulk("reject"),
  };
  useShortcuts(listKeys, visible.length > 0, {
    target: listRef,
    group: "Review queue",
    labels: { j: "Next proposal", k: "Previous proposal", x: "Select or clear the proposal", o: "Open the proposal", a: "Approve the proposal", r: "Reject the proposal…", A: "Approve the selected proposals", R: "Reject the selected proposals…" },
  });
  // From outside the list, j or k jumps into it (the list's own handler runs first inside it).
  useShortcuts({ j: () => move(0), k: () => move(0) }, visible.length > 0);
  // The BulkBar handles Escape; this only lists it in the shortcut sheet.
  useShortcuts({}, selected.size > 0, { group: "Review queue", labels: { Escape: "Clear the selection" } });

  // The pane shows the cursor row, else the first one shown.
  const paneRow = split ? ((cursorId ? visible.find((r) => r.id === cursorId) : undefined) ?? visible[0]) : undefined;
  // A pointer click on a row's title shows it in the pane; Enter on a focused title (a click with detail 0) still opens it.
  const selectRow = (e: React.MouseEvent) => {
    if (!split || e.defaultPrevented || e.detail === 0 || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('li[id^="rv-row-"] .list-row-title > a');
    if (!a) return;
    e.preventDefault();
    a.focus();
    setCursorId(a.closest("li")!.id.slice("rv-row-".length));
  };

  const anyFilter = CLEARABLE.some((k) => f[k]);
  const clearFilters = () => setQuery(Object.fromEntries(CLEARABLE.map((k) => [k, undefined])));
  const total = facets ? Object.values(facets.categories).reduce((a, b) => a + b, 0) : 0;
  const types = Object.entries(facets?.types ?? {}).sort(([a], [b]) => typeLabel(a).localeCompare(typeLabel(b)));
  const scopeName = (slug: string) => facets?.projects.find((p) => p.slug === slug)?.name ?? slug;
  const sort = f.sort || (pending ? "oldest" : "newest");
  const allState: boolean | "mixed" = reviewable.length === 0 ? false : reviewable.every((r) => selected.has(r.id)) ? true : reviewable.some((r) => selected.has(r.id)) ? "mixed" : false;

  const active = [
    f.q && { id: "q", label: `Search: ${f.q}`, onRemove: () => setQuery({ q: undefined }) },
    f.category && { id: "category", label: `Category: ${CATEGORY[f.category as Category]?.label ?? humanize(f.category)}`, onRemove: () => setQuery({ category: undefined }) },
    f.scope && { id: "scope", label: `Where: ${scopeName(f.scope)}`, onRemove: () => setQuery({ scope: undefined }) },
    f.type && { id: "type", label: `Type: ${typeLabel(f.type)}`, onRemove: () => setQuery({ type: undefined }) },
    f.author && { id: "author", label: `Author: ${AUTHOR_LABEL[f.author] ?? f.author}`, onRemove: () => setQuery({ author: undefined }) },
    f.assigned && f.assigned !== "1" && { id: "assigned", label: `Reviewer: ${ASSIGNED_LABEL[f.assigned] ?? f.assigned}`, onRemove: () => setQuery({ assigned: undefined }) },
  ].filter(Boolean) as { id: string; label: string; onRemove(): void }[];

  const view: MenuItemSpec[] = [
    { type: "group", label: "Sort" },
    { id: "sort-oldest", label: "Oldest first", checked: sort === "oldest", onSelect: () => setQuery({ sort: "oldest" }) },
    { id: "sort-newest", label: "Newest first", checked: sort === "newest", onSelect: () => setQuery({ sort: "newest" }) },
    { type: "separator" },
    { type: "group", label: "Group by" },
    ...(["category", "project", "type", "none"] as GroupBy[]).map((g) => ({
      id: `group-${g}`,
      label: g === "none" ? "No grouping" : g === "project" ? "Project or space" : humanize(g),
      checked: groupBy === g,
      onSelect: () => setQuery({ group: g }),
    })),
  ];

  const toReview = facets?.to_review ?? 0;
  const waiting = pending && (toReview > 0 || f.assigned === "to_review");
  const stateWord = state === "pending" ? "pending" : state;

  return (
    <div className="rv-queue">
      <FilterBar
        search={{ value: f.q ?? "", onChange: (v) => setQuery({ q: v.trim() || undefined }), label: "Search proposals", placeholder: "Search summaries and titles", debounceMs: 350 }}
        segments={
          <SegmentedControl
            label="State"
            size="sm"
            value={state as (typeof STATES)[number]["value"]}
            onChange={(v) => setQuery({ state: v === "pending" ? undefined : v, sort: undefined })}
            options={STATES.map((s) => ({ value: s.value, label: s.label, count: facets?.states[s.value] || undefined }))}
          />
        }
        filters={
          <>
            {waiting && (
              <ChipGroup
                label="Quick filter"
                multiple
                value={f.assigned === "to_review" ? ["to_review"] : []}
                onChange={(v: string[]) => setQuery({ assigned: v.includes("to_review") ? "to_review" : undefined })}
                options={[{ value: "to_review", label: "Waiting for me", count: toReview, hint: "Proposals you can review" }]}
              />
            )}
            <ChipGroup
              label="Category"
              value={f.category ?? ""}
              onChange={(v: string) => setQuery({ category: v || undefined })}
              options={[
                { value: "", label: "All", count: total },
                // Zero-count categories are clutter: hide them unless one is the active filter.
                ...CATEGORY_ORDER.filter((c) => (facets?.categories[c] ?? 0) > 0 || f.category === c || !facets).map((c) => ({ value: c, label: CATEGORY[c].label, count: facets?.categories[c] ?? 0, hint: CATEGORY[c].hint })),
              ]}
            />
          </>
        }
        more={{
          count: ["scope", "type", "author", "assigned"].filter((k) => f[k] && f[k] !== "1").length,
          content: (
            <div className="rv-filter-fields">
              <Field label="Where">
                <Select
                  aria-required={false}
                  value={f.scope ?? ""}
                  onChange={(e) => setQuery({ scope: e.target.value || undefined })}
                  options={[
                    { value: "", label: "All projects and spaces" },
                    ...(facets?.projects ?? []).map((p) => ({ value: p.slug, label: `${p.name} (${p.count})` })),
                    ...(f.scope && !facets?.projects.some((p) => p.slug === f.scope) ? [{ value: f.scope, label: `${scopeName(f.scope)} (0)` }] : []),
                  ]}
                />
              </Field>
              <Field label="Type">
                <Select
                  aria-required={false}
                  value={f.type ?? ""}
                  onChange={(e) => setQuery({ type: e.target.value || undefined })}
                  options={[
                    { value: "", label: "Any type" },
                    ...types.map(([t, n]) => ({ value: t, label: `${typeLabel(t)} (${n})` })),
                    ...(f.type && !facets?.types[f.type] ? [{ value: f.type, label: `${typeLabel(f.type)} (0)` }] : []),
                  ]}
                />
              </Field>
              <Field label="Author">
                <Select
                  aria-required={false}
                  value={f.author ?? ""}
                  onChange={(e) => setQuery({ author: e.target.value || undefined })}
                  options={[
                    { value: "", label: "Anyone" },
                    { value: "people", label: `People${facets?.authors.people ? ` (${facets.authors.people})` : ""}` },
                    { value: "agents", label: `AI agents${facets?.authors.agents ? ` (${facets.authors.agents})` : ""}` },
                    { value: "me", label: "Mine" },
                  ]}
                />
              </Field>
              <Field label="Reviewer">
                <Select
                  aria-required={false}
                  value={f.assigned === "1" ? "me" : (f.assigned ?? "")}
                  onChange={(e) => setQuery({ assigned: e.target.value || undefined })}
                  options={[
                    { value: "", label: "Any reviewer" },
                    ...(pending || f.assigned === "to_review" ? [{ value: "to_review", label: "Waiting for me" }] : []),
                    { value: "me", label: "Assigned to me" },
                    { value: "none", label: "Unassigned" },
                  ]}
                />
              </Field>
            </div>
          ),
        }}
        view={view}
        views={
          <SavedViews
            area="review"
            current={pickFilters(route.query, FILTER_KEYS)}
            apply={(v) => setQuery(Object.fromEntries(FILTER_KEYS.map((k) => [k, v[k]])))}
            summary={[`State: ${humanize(state)}`, ...active.map((a) => a.label), ...(f.sort ? [`Sort: ${sort === "oldest" ? "Oldest first" : "Newest first"}`] : []), ...(f.group ? [`Group by: ${humanize(groupBy)}`] : [])]}
          />
        }
        active={active}
        onClearAll={clearFilters}
        result={data ? (rows.length >= 200 ? `First 200 ${stateWord} proposals` : plural(rows.length, `${stateWord} proposal`)) : undefined}
      />

      {bulkResult && (bulkResult.failed.length > 0 || bulkResult.done > 0) && (
        <Callout
          tone={bulkResult.failed.length ? "warning" : "success"}
          title={bulkResult.failed.length ? `${bulkResult.verb} ${bulkResult.done} of ${bulkResult.total}` : `${bulkResult.verb} ${plural(bulkResult.done, "proposal")}.`}
          onDismiss={() => setBulkResult(null)}
          live
        >
          {bulkResult.failed.length > 0 && (
            <ul className="rv-failures">
              {bulkResult.failed.map((x) => (
                <li key={x.id}>
                  <a href={href(`/review/${x.id}`)}>{x.title}</a>: {x.error ?? "it couldn't be changed"}
                </li>
              ))}
            </ul>
          )}
        </Callout>
      )}

      {error && data && <ErrorState compact error={error} onRetry={reload} title="Couldn't refresh the queue" />}

      {!data ? (
        error ? (
          <ErrorState error={error} onRetry={reload} title="Couldn't load the queue" />
        ) : (
          <div aria-busy="true">
            <span className="sr-only" role="status">
              Loading proposals
            </span>
            <SkeletonRows count={5} />
          </div>
        )
      ) : rows.length === 0 ? (
        anyFilter ? (
          <EmptyState variant="search" title="Nothing matches these filters" description="Try another search, or clear the filters." primary={<Button onClick={clearFilters}>Clear filters</Button>} />
        ) : pending ? (
          <EmptyState
            variant="positive"
            title="You're all caught up"
            description="New proposals from teammates and Claude show up here."
            secondary={<Button onClick={() => setQuery({ state: "approved", sort: undefined })}>See approved</Button>}
          />
        ) : (
          <EmptyState title={`Nothing ${state} yet`} description={`Proposals that are ${state} show up here.`} />
        )
      ) : (
        <>
          {reviewable.length > 0 && (
            <div className="rv-listhead">
              <label className="rv-selectall">
                <SelectAllBox
                  checked={allState}
                  onChange={(on) => setSelected(on ? new Set(reviewable.map((r) => r.id)) : new Set())}
                  label={`Select all you can review (${reviewable.length})`}
                />
                <span>Select all you can review ({reviewable.length})</span>
              </label>
              <KeyHint
                items={[
                  { keys: "j k", label: "move" },
                  { keys: "x", label: "select" },
                  { keys: "o", label: "open" },
                  { keys: "a", label: "approve" },
                  { keys: "r", label: "reject" },
                ]}
              />
            </div>
          )}
          <BulkBar count={selected.size} noun={["proposal", "proposals"]} onClear={() => setSelected(new Set())}>
            <Button size="sm" variant="primary" icon="check" loading={bulkBusy === "approve"} loadingText="Approving" disabledReason={bulkBusy ? "Wait for the current action to finish" : undefined} onClick={() => void bulk("approve")}>
              Approve {selected.size}
            </Button>
            <Button size="sm" variant="danger" loading={bulkBusy === "reject"} loadingText="Rejecting" disabledReason={bulkBusy ? "Wait for the current action to finish" : undefined} onClick={() => void bulk("reject")}>
              Reject…
            </Button>
          </BulkBar>
          <NewItemsPill count={newCount} noun={["proposal", "proposals"]} onShow={reload} />
          <SplitView
            active={split}
            detailLabel="Selected proposal"
            detail={
              paneRow ? (
                <ProposalPane
                  key={paneRow.id}
                  r={paneRow}
                  pending={pending}
                  busy={rowBusy[paneRow.id]}
                  error={rowError[paneRow.id]}
                  onDecide={(verb) => void decideRow(paneRow, verb)}
                />
              ) : (
                <p className="rv-muted">Select a proposal to see it here.</p>
              )
            }
            list={
              <>
                <div
                  className="rv-list"
                  data-gutter={pending || undefined}
                  onClick={selectRow}
                  onFocus={(e) => {
                    const li = (e.target as HTMLElement).closest('li[id^="rv-row-"]');
                    if (li) setCursorId(li.id.slice("rv-row-".length));
                  }}
                >
                  <RowList label={`${humanize(stateWord)} proposals`} keyboardRef={listRef} refreshing={loading}>
                    {groups.map((g) => {
                      const open = !collapsed.has(g.key);
                      const mine = g.rows.filter((r) => pending && r.can_review);
                      const picked = mine.filter((r) => selected.has(r.id)).length;
                      const oldest = pending ? Math.max(...g.rows.map((r) => age(r.created_at))) : 0;
                      return [
                        groupBy !== "none" && (
                          <li key={`g-${g.key}`} className="rv-group">
                            <GroupHeader
                              label={g.label}
                              count={g.rows.length}
                              hint={g.hint}
                              tone={groupBy === "category" ? g.tone : undefined}
                              open={open}
                              onToggle={() =>
                                setCollapsed((c) => {
                                  const next = new Set(c);
                                  if (next.has(g.key)) next.delete(g.key);
                                  else next.add(g.key);
                                  return next;
                                })
                              }
                              selectAll={
                                mine.length > 0
                                  ? {
                                      checked: picked === 0 ? false : picked === mine.length ? true : "mixed",
                                      label: `Select all in ${g.label}`,
                                      onChange: (on) =>
                                        setSelected((s) => {
                                          const next = new Set(s);
                                          for (const r of mine) on ? next.add(r.id) : next.delete(r.id);
                                          return next;
                                        }),
                                    }
                                  : undefined
                              }
                              warning={
                                oldest >= 7 ? (
                                  <>
                                    <I name="clock" size={14} /> Oldest waits {plural(oldest, "day")}
                                  </>
                                ) : undefined
                              }
                              action={
                                Object.keys(g.filter).length > 0 ? (
                                  <button type="button" className="link-btn" onClick={() => setQuery(g.filter)}>
                                    Show only
                                  </button>
                                ) : undefined
                              }
                            />
                          </li>
                        ),
                        ...(open
                          ? g.rows.map((r) => (
                              <ProposalRow
                                key={r.id}
                                r={r}
                                groupBy={groupBy}
                                pending={pending}
                                filters={filters}
                                inSplit={split}
                                cursor={split ? paneRow?.id === r.id : cursorId === r.id}
                                selected={selected.has(r.id)}
                                onSelect={(on) => toggle(r.id, on)}
                                busy={rowBusy[r.id]}
                                error={rowError[r.id]}
                                previewOpen={preview.has(r.id)}
                                onPreview={() =>
                                  setPreview((p) => {
                                    const next = new Set(p);
                                    if (next.has(r.id)) next.delete(r.id);
                                    else next.add(r.id);
                                    return next;
                                  })
                                }
                                onDecide={(verb) => void decideRow(r, verb)}
                              />
                            ))
                          : []),
                      ];
                    })}
                  </RowList>
                </div>
                {(data.revisions.length >= 200 || rows.length >= 200) && <LoadMore shown={rows.length} noun={["proposal", "proposals"]} capNote="Showing the first 200. Narrow the filters to see the rest." />}
              </>
            }
          />
        </>
      )}
    </div>
  );
}

/** A select-all checkbox with the mixed state. */
function SelectAllBox({ checked, onChange, label }: { checked: boolean | "mixed"; onChange(on: boolean): void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === "mixed";
  }, [checked]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={checked === true} onChange={(e) => onChange(e.target.checked)} />;
}

function ProposalRow({
  r,
  groupBy,
  pending,
  filters,
  cursor,
  selected,
  onSelect,
  busy,
  error,
  previewOpen,
  onPreview,
  onDecide,
  inSplit,
}: {
  r: RevisionSummary;
  groupBy: GroupBy;
  pending: boolean;
  filters: Record<string, string>;
  /** In the split view the pane carries the actions and the preview. */
  inSplit?: boolean;
  cursor: boolean;
  selected: boolean;
  onSelect(on: boolean): void;
  busy?: "approve" | "reject";
  error?: string;
  previewOpen: boolean;
  onPreview(): void;
  onDecide(verb: "approve" | "reject"): void;
}) {
  const days = age(r.created_at);
  const title = r.summary ? summaryText(r.summary) : r.target_title;
  const canAct = pending && !!r.can_review;
  const category = CATEGORY_OF[r.op];
  const showTarget = !!r.summary && !!r.target_title && !r.summary.toLowerCase().includes(r.target_title.toLowerCase());
  const meta: ReactNode[] = [
    groupBy !== "project" ? (
      <a key="loc" className="rv-above rv-scope-link" href={href("/review", { ...filters, scope: r.scope })} title="Show only this project or space">
        <LocationLabel scope={{ slug: r.scope, kind: r.scope_kind }} />
      </a>
    ) : null,
    groupBy !== "type" ? <TypeLabel key="type" type={r.target_type} kind={r.target_kind} /> : null,
    <span key="who" className="rv-above">
      {person(r.author, r.author_kind, "sm", r.author_name)}
    </span>,
    pending ? (
      <span key="age" className="rv-age" data-late={days >= 7 || undefined} title={new Date(r.created_at).toLocaleString("en-GB")}>
        {days >= 7 && <I name="clock" size={14} />}
        {days === 0 ? "Today" : `Waiting ${plural(days, "day")}`}
      </span>
    ) : (
      <RelativeTime key="age" date={r.created_at} prefix="Proposed" />
    ),
    r.assignee ? <span key="as">Assigned to {nameOf(r.assignee_email ?? r.assignee, r.assignee_name)}</span> : null,
    r.comments ? <span key="c">{plural(r.comments, "comment")}</span> : null,
    r.reviewer ? (
      <span key="by">
        {humanize(r.state)} by {nameOf(r.reviewer, r.reviewer_name)} <ViaClaude via={r.decided_via} />
      </span>
    ) : null,
  ];
  return (
    <ListRow
      id={`rv-row-${r.id}`}
      title={title}
      href={href(`/review/${r.id}`)}
      cursor={cursor}
      selected={selected}
      selectable={canAct ? { checked: selected, onChange: onSelect, label: `Select ${title}` } : undefined}
      leading={canAct ? undefined : pending ? <span className="rv-gutter-spacer" aria-hidden="true" /> : undefined}
      description={showTarget ? r.target_title : undefined}
      badges={
        <>
          {groupBy !== "category" && category && <CategoryBadge category={category} />}
          {r.outdated && (
            <span className="rv-above rv-badge-tip">
              <Badge tone="warning" icon="alert">
                Outdated
              </Badge>
              <InfoTip label="What does outdated mean?">The entry changed since this was proposed; approving will fail. Reject it and ask for a new one.</InfoTip>
            </span>
          )}
          {r.redactions.length > 0 && <StatusBadge domain="proposal" value="redacted" />}
        </>
      }
      meta={previewOpen && !inSplit ? undefined : <MetaLine items={meta} />}
      extra={
        <>
          {previewOpen && !inSplit && (
            <p className="rv-meta">
              <MetaLine items={meta} />
            </p>
          )}
          {r.state === "rejected" && r.reason && <p className="rv-reason">“{r.reason}”</p>}
          {pending && !r.can_review && <p className="rv-note">You can't review this space.</p>}
          {previewOpen && !inSplit && <RowPreview id={r.id} />}
        </>
      }
      error={error}
      actions={
        inSplit ? undefined : (
          <>
            {canAct && (
              <>
                <Button size="sm" loading={busy === "approve"} loadingText="Approving" disabledReason={r.outdated ? "This proposal is outdated" : busy ? "Wait for the current action to finish" : undefined} onClick={() => onDecide("approve")}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" loading={busy === "reject"} loadingText="Rejecting" disabledReason={busy ? "Wait for the current action to finish" : undefined} onClick={() => onDecide("reject")}>
                  Reject…
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" icon={previewOpen ? "chevron-down" : "eye"} aria-expanded={previewOpen} onClick={onPreview}>
              {previewOpen ? "Hide preview" : "Preview"}
            </Button>
          </>
        )
      }
    />
  );
}

/** The split view's pane: the proposal under the cursor, its change and its main actions. */
function ProposalPane({ r, pending, busy, error, onDecide }: { r: RevisionSummary; pending: boolean; busy?: "approve" | "reject"; error?: string; onDecide(verb: "approve" | "reject"): void }) {
  const result = useApi<RevisionDetail>(`/revisions/${r.id}`);
  const title = r.summary ? summaryText(r.summary) : r.target_title;
  const category = CATEGORY_OF[r.op];
  const canAct = pending && !!r.can_review;
  return (
    <div className="rv-pane">
      <div className="rv-pane-head">
        <p className="rv-pane-where">
          {category && <CategoryBadge category={category} />}
          <LocationLabel scope={{ slug: r.scope, kind: r.scope_kind }} />
          <TypeLabel type={r.target_type} kind={r.target_kind} />
        </p>
        <h2 className="rv-pane-title">{title}</h2>
        {!!r.summary && !!r.target_title && !r.summary.toLowerCase().includes(r.target_title.toLowerCase()) && <p className="rv-pane-target">{r.target_title}</p>}
        <MetaLine
          items={[
            <span key="who">{person(r.author, r.author_kind, "sm", r.author_name)}</span>,
            <RelativeTime key="age" date={r.created_at} prefix="Proposed" />,
            r.assignee ? <span key="as">Assigned to {nameOf(r.assignee_email ?? r.assignee, r.assignee_name)}</span> : null,
            r.comments ? <span key="c">{plural(r.comments, "comment")}</span> : null,
          ]}
        />
      </div>
      <div className="rv-pane-actions">
        {canAct && (
          <>
            <Button variant="primary" icon="check" loading={busy === "approve"} loadingText="Approving" disabledReason={r.outdated ? "This proposal is outdated" : busy ? "Wait for the current action to finish" : undefined} onClick={() => onDecide("approve")}>
              Approve
            </Button>
            <Button variant="secondary" loading={busy === "reject"} loadingText="Rejecting" disabledReason={busy ? "Wait for the current action to finish" : undefined} onClick={() => onDecide("reject")}>
              Reject…
            </Button>
          </>
        )}
        <Button variant="ghost" iconEnd="chevron-right" href={href(`/review/${r.id}`)}>
          Open the proposal
        </Button>
      </div>
      {error && (
        <p className="rv-pane-error" role="alert">
          <I name="alert" size={14} /> {error}
        </p>
      )}
      {r.outdated && <Callout tone="warning">The entry changed since this was proposed; approving will fail. Reject it and ask for a new one.</Callout>}
      {r.state === "rejected" && r.reason && <p className="rv-reason">“{r.reason}”</p>}
      {pending && !r.can_review && <p className="rv-note">You can't review this space.</p>}
      {result.error ? (
        <ErrorState compact error={result.error} onRetry={result.reload} title="Couldn't load the proposal" />
      ) : !result.data ? (
        <div aria-busy="true">
          <span className="sr-only" role="status">
            Loading the proposal
          </span>
          <SkeletonText lines={6} />
        </div>
      ) : (
        <ProposedChange data={result.data} compact />
      )}
    </div>
  );
}

/** The change, compact, inside a queue row. */
function RowPreview({ id }: { id: string }) {
  const result = useApi<RevisionDetail>(`/revisions/${id}`);
  return (
    <div className="rv-above rv-preview">
      {result.error ? (
        <ErrorState compact error={result.error} onRetry={result.reload} title="Couldn't load the preview" />
      ) : !result.data ? (
        <div aria-busy="true">
          <span className="sr-only" role="status">
            Loading the preview
          </span>
          <SkeletonText lines={4} />
        </div>
      ) : (
        <>
          <ProposedChange data={result.data} compact />
          <p className="rv-preview-foot">
            <a href={href(`/review/${id}`)}>Open the proposal</a>
          </p>
        </>
      )}
    </div>
  );
}

// ---- Proposal page -----------------------------------------------------------------------------------

interface RevisionDetail {
  id: string;
  op: string;
  state: string;
  summary: string;
  stale: boolean;
  target_kind: "article" | "finding";
  target_id: string;
  assignee_id: string | null;
  author_id?: string;
  /** Decided through Claude ("mcp") or with an API token ("token"); null in the web app. */
  decided_via?: string | null;
  payload: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  current: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  proposed: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const FINDING_FIELDS = [
  ["title", "Title"],
  ["symptoms", "Symptoms"],
  ["root_cause", "Root cause"],
  ["fix", "Fix"],
] as const;
const FIELD_LABEL: Record<string, string> = Object.fromEntries(FINDING_FIELDS);

type Edits = { title?: string; body_md?: string; patch?: Record<string, string> };

/** What the reviewer can edit, pre-filled from the proposal; null if this kind of proposal can't be edited. */
function editableFields(d: RevisionDetail): { fields: { key: string; label: string; value: string; long: boolean }[] } | null {
  const { op, target_kind, current, payload } = d;
  if (op === "create" && target_kind === "article") {
    return { fields: [{ key: "title", label: "Title", value: current.title ?? "", long: false }, { key: "body_md", label: "Body", value: current.body_md ?? "", long: true }] };
  }
  if (op === "create" && target_kind === "finding") {
    return { fields: FINDING_FIELDS.map(([k, label]) => ({ key: `patch.${k}`, label, value: current[k] ?? "", long: k !== "title" })) };
  }
  if ((op === "update" || op === "promote") && target_kind === "article") {
    return {
      fields: [
        ...(payload.title ? [{ key: "title", label: "Title", value: payload.title as string, long: false }] : []),
        { key: "body_md", label: payload.section ? `New text for “${payload.section}”` : "New body", value: payload.text ?? "", long: true },
      ],
    };
  }
  if (op === "update" && target_kind === "finding") {
    const patch = (payload.patch ?? {}) as Record<string, unknown>;
    return {
      fields: FINDING_FIELDS.filter(([k]) => typeof patch[k] === "string").map(([k, label]) => ({ key: `patch.${k}`, label, value: patch[k] as string, long: k !== "title" })),
    };
  }
  return null;
}

/** The pending proposal after this one: the stored queue first (skipping ones you can't review), else today's rule (only when this proposal wasn't opened from the queue). */
async function nextPendingId(id: string): Promise<string | null> {
  const ctx = readQueue();
  if (ctx) {
    const i = ctx.ids.indexOf(id);
    const after = [...ctx.ids.slice(i + 1), ...ctx.ids.slice(0, Math.max(i, 0))];
    const hit = after.find((x) => x !== id && ctx.rows[x]?.state === "pending" && ctx.rows[x]?.can_review !== false);
    if (hit) return hit;
    // The filtered queue has nothing else waiting: go back to it (still filtered) rather than jump outside the filter.
    if (ctx.ids.includes(id)) return null;
  }
  const { revisions } = await api<{ revisions: { id: string }[] }>("/revisions?state=pending&limit=200");
  const after = revisions.findIndex((r) => r.id === id);
  const target = revisions[after + 1] ?? revisions.find((r) => r.id !== id);
  return target?.id ?? null;
}

function markDecided(id: string, state: string, reviewer: string | null, reason: string | null, reviewerName?: string | null) {
  const ctx = readQueue();
  if (!ctx?.rows[id]) return;
  ctx.rows[id] = { ...ctx.rows[id]!, state, reviewer, reviewer_name: reviewerName ?? null, reason };
  writeQueue(ctx);
}

export function RevisionPage({ id }: { id: string }) {
  const result = useApi<RevisionDetail>(`/revisions/${id}`);
  const { data, error, reload } = result;
  const { me, scope: scopeInfo } = useBoot();
  const toast = useToast();
  const confirm = useConfirm();
  const phone = useMediaQuery("(max-width: 860px)");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [decided, setDecided] = useState<{ state: string; reason?: string } | null>(null);
  const [nexting, setNexting] = useState(false);
  const ctxRow = useMemo(() => readQueue()?.rows[id], [id, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = data ? editableFields(data) : null;
  // From the last queue load, else the scope's permissions (not for Library shares, which the Library's reviewers
  // decide). Unknown means the buttons stay; the server decides either way.
  const itemScope: string | undefined = data?.current.scope?.slug ?? (typeof data?.current.scope === "string" ? data.current.scope : undefined);
  const info = itemScope && data?.op !== "share" ? scopeInfo(itemScope) : undefined;
  const cantReview = ctxRow ? ctxRow.can_review === false : info ? !can.inScope(info, "review", me) : false;
  const lockReason = cantReview ? "You can't review in this space" : undefined;
  const isPending = data?.state === "pending";
  const canAct = isPending && !data.stale;
  const dirty = !!editing && !!editable && editable.fields.some((f) => (editing[f.key] ?? f.value) !== f.value);
  useUnsavedChangesGuard(dirty, "Leave without approving? Your edits will be lost.");

  async function approve() {
    if (!data || busy) return;
    setBusy("approve");
    setActionError(null);
    try {
      let body: unknown = {};
      if (editing && editable) {
        const edits: Edits = {};
        for (const f of editable.fields) {
          const v = editing[f.key];
          if (v === undefined || v === f.value) continue;
          if (f.key.startsWith("patch.")) edits.patch = { ...edits.patch, [f.key.slice(6)]: v };
          else (edits as Record<string, string>)[f.key] = v;
        }
        if (Object.keys(edits).length) body = { edits };
      }
      await api(`/revisions/${id}/approve`, { method: "POST", body });
      setEditing(null);
      setDecided({ state: "approved" });
      markDecided(id, "approved", me.email ?? null, null, me.name);
      toast.success(`Approved “${data.summary.slice(0, 40)}”`);
      refreshCounts();
      reload();
    } catch (e) {
      setActionError(reword403(e));
    } finally {
      setBusy(null);
    }
  }

  async function reject(prefill?: string) {
    if (!data || busy) return;
    const res = await confirm({
      title: `Reject “${data.summary}”?`,
      body: "The author sees your reason and can propose again.",
      confirmLabel: "Reject",
      tone: "danger",
      reason: { label: "Reason for rejecting", required: true, maxLength: 2000, presets: prefill ? [prefill, ...REJECT_PRESETS] : REJECT_PRESETS, hint: "Press ⌘ or Ctrl and Enter to reject." },
    });
    if (!res) return;
    setBusy("reject");
    setActionError(null);
    try {
      await api(`/revisions/${id}/reject`, { method: "POST", body: { reason: res.reason } });
      setEditing(null);
      setDecided({ state: "rejected", reason: res.reason });
      markDecided(id, "rejected", me.email ?? null, res.reason ?? null, me.name);
      toast.success(`Rejected “${data.summary.slice(0, 40)}”`);
      refreshCounts();
      reload();
    } catch (e) {
      setActionError(reword403(e));
    } finally {
      setBusy(null);
    }
  }

  async function next() {
    if (nexting) return;
    setNexting(true);
    try {
      const target = await nextPendingId(id);
      if (target) navigate(`/review/${target}`);
      else goToQueue();
    } catch (e) {
      toast.error(e, { title: "Couldn't find the next proposal" });
    } finally {
      setNexting(false);
    }
  }

  const startEdit = () => editable && setEditing(Object.fromEntries(editable.fields.map((f) => [f.key, f.value])));

  const keys = {
    a: () => canAct && !cantReview && !busy && void approve(),
    e: () => canAct && !cantReview && editable && !editing && startEdit(),
    r: () => isPending && !cantReview && !busy && void reject(data?.stale ? OUTDATED_REASON : undefined),
    n: () => void next(),
    u: () => goToQueue(),
  };
  useShortcuts(keys, !!data, {
    group: "Proposal",
    labels: { a: "Approve", e: "Edit before approving", r: "Reject…", n: "Next in queue", u: "Back to the queue" },
  });

  const crumbs = [{ label: "Review", href: queueHref() }, ...(data ? [{ label: CATEGORY[CATEGORY_OF[data.op] ?? "edit"]?.label ?? humanize(data.op) }] : [])];

  if (!data) {
    return (
      <Page width="content">
        <PageHeader title="Proposal" size="document" nav="review" hideTabBar crumbs={[{ label: "Review", href: queueHref() }]} />
        {error ? (
          <ErrorState error={error} onRetry={reload} title="Couldn't load this proposal" />
        ) : (
          <div aria-busy="true">
            <span className="sr-only" role="status">
              Loading the proposal
            </span>
            <SkeletonText lines={8} />
          </div>
        )}
      </Page>
    );
  }

  const scopeSlug: string | undefined = data.current.scope?.slug ?? (typeof data.current.scope === "string" ? data.current.scope : undefined);
  const itemLink = href(`/${data.target_kind}/${data.target_id}`);
  const decidedState = data.state !== "pending" ? data.state : null;
  const decidedBy = ctxRow && ctxRow.state === data.state ? ctxRow.reviewer : null;
  const decidedReason = decided?.reason ?? (ctxRow && ctxRow.state === "rejected" ? ctxRow.reason : null);

  const decisionBar = isPending && (
    <div className="rv-decision" role="group" aria-label="Decision">
      <div className="rv-decision-actions">
        <Button
          variant="primary"
          icon="check"
          loading={busy === "approve"}
          loadingText="Approving"
          disabledReason={lockReason ?? (data.stale ? "This entry changed after the proposal was made, so approving is refused" : busy ? "Wait for the current action to finish" : undefined)}
          onClick={() => void approve()}
        >
          {editing ? (phone ? "Approve edits" : "Approve with my edits") : "Approve"}
        </Button>
        {editable && !data.stale && (
          <Button
            icon={editing ? "x" : "pencil"}
            aria-label={editing ? "Discard edits" : "Edit before approving"}
            disabledReason={lockReason ?? (busy ? "Wait for the current action to finish" : undefined)}
            onClick={() => (editing ? setEditing(null) : startEdit())}
          >
            {editing ? (phone ? "Discard" : "Discard edits") : phone ? "Edit" : "Edit before approving"}
          </Button>
        )}
        <Button variant="danger" loading={busy === "reject"} loadingText="Rejecting" disabledReason={lockReason ?? (busy === "approve" ? "Wait for the current action to finish" : undefined)} onClick={() => void reject(data.stale ? OUTDATED_REASON : undefined)}>
          Reject…
        </Button>
      </div>
      {!phone && (
        <KeyHint
          items={[
            ...(canAct && !cantReview ? [{ keys: "a", label: "approve" }] : []),
            ...(canAct && !cantReview && editable ? [{ keys: "e", label: "edit" }] : []),
            ...(!cantReview ? [{ keys: "r", label: "reject" }] : []),
            { keys: "n", label: "next" },
            { keys: "u", label: "back to queue" },
          ]}
        />
      )}
    </div>
  );

  return (
    <Page width="content">
      <PageHeader
        size="document"
        nav="review"
        hideTabBar
        scope={scopeSlug ?? null}
        crumbs={crumbs}
        title={summaryText(data.summary)}
        status={
          <>
            <StatusBadge domain="proposal" value={data.state} />
            {data.payload.reviewer_edited && <StatusBadge domain="proposal" value="reviewer_edited" />}
          </>
        }
        meta={
          <MetaLine
            items={[
              data.current.type ? <TypeLabel key="t" type={data.current.type} kind={data.target_kind} /> : null,
              scopeSlug ? <LocationLabel key="l" scope={scopeSlug} link /> : null,
              ctxRow ? (
                <span key="by" className="rv-proposed-by">
                  Proposed by{" "}
                  <PersonChip
                    name={ctxRow.author_name || (isEmail(ctxRow.author) ? null : ctxRow.author)}
                    email={isEmail(ctxRow.author) ? ctxRow.author : null}
                    kind={ctxRow.author_kind ?? "human"}
                    size="sm"
                    showEmail
                  />{" "}
                  <RelativeTime date={ctxRow.created_at} />
                </span>
              ) : null,
              <a key="open" href={itemLink}>
                Open {data.target_kind}
              </a>,
              decidedState && decidedBy ? (
                <span key="dec">
                  {humanize(decidedState)} by {nameOf(decidedBy, ctxRow?.reviewer_name)} <ViaClaude via={data.decided_via ?? ctxRow?.decided_via} />
                </span>
              ) : null,
            ]}
          />
        }
      />

      {cantReview && isPending && (
        <Callout tone="neutral" icon="lock" title="You can't review in this space">
          Reviewers, Moderators and Project admins there approve or reject it. You can still comment.
        </Callout>
      )}

      {data.stale && isPending && (
        <Callout
          tone="warning"
          title="This entry changed after the proposal was made"
          actions={
            cantReview ? undefined : (
              <Button size="sm" onClick={() => void reject(OUTDATED_REASON)}>
                Reject and ask for a new one
              </Button>
            )
          }
        >
          {cantReview
            ? `Approving is refused. A reviewer can reject it and ask the author for a new proposal based on the current ${data.target_kind}.`
            : `Approving is refused. Reject it and ask the author for a new proposal based on the current ${data.target_kind}.`}
        </Callout>
      )}

      {decidedState && (
        <Callout
          tone={decidedState === "approved" ? "success" : "neutral"}
          title={decided ? `You ${decidedState} this proposal` : `This proposal was ${decidedState}`}
          live={!!decided}
          actions={
            <>
              <Button size="sm" variant="primary" icon="arrow" loading={nexting} loadingText="Finding the next one" onClick={() => void next()}>
                Next in queue
              </Button>
              <Button size="sm" href={queueHref()}>
                Back to the queue
              </Button>
            </>
          }
        >
          {decidedState === "approved" ? (
            <>
              The change is published. <a href={itemLink}>Open the {data.target_kind}</a>
            </>
          ) : decidedReason ? (
            <>Reason: “{decidedReason}”</>
          ) : (
            "The author was told."
          )}
        </Callout>
      )}

      {decisionBar}
      {isPending && actionError ? <ErrorState compact error={actionError} title={busy === null ? "That didn't work" : undefined} /> : null}
      {isPending && <AssigneePicker id={id} assigneeId={data.assignee_id} meId={me.id} onChange={reload} />}

      {editing && editable ? (
        <Section title="Edit before approving" description="Your changes are applied with the proposal and noted in its history. The author is told it was approved.">
          <div className="rv-edit-fields">
            {editable.fields.map((f) => (
              <Field key={f.key} label={f.label}>
                {f.long ? (
                  <Textarea autoGrow mono={f.key === "body_md"} minRows={f.key === "body_md" ? 8 : 4} maxRows={30} value={editing[f.key] ?? ""} onChange={(e) => setEditing({ ...editing, [f.key]: e.target.value })} />
                ) : (
                  <TextInput value={editing[f.key] ?? ""} onChange={(e) => setEditing({ ...editing, [f.key]: e.target.value })} />
                )}
              </Field>
            ))}
          </div>
        </Section>
      ) : (
        <ProposedChange data={data} author={ctxRow ? nameOf(ctxRow.author, ctxRow.author_name) : undefined} />
      )}

      <Comments id={id} meEmail={me.email} />
      {isPending && <div className="rv-decision-spacer" aria-hidden="true" />}
    </Page>
  );
}

function AssigneePicker({ id, assigneeId, meId, onChange }: { id: string; assigneeId: string | null; meId: string; onChange: () => void }) {
  const { data, error: loadError } = useApi<{ reviewers: { id: string; email: string; name: string }[] }>(`/revisions/${id}/reviewers`);
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (loadError) return null;
  if (!data) return <div className="rv-assignee" aria-hidden="true" />;
  const meEligible = data.reviewers.some((r) => r.id === meId);
  async function assign(userId: string | null) {
    setError(null);
    setSaving(true);
    try {
      await api(`/revisions/${id}/assignee`, { method: "PUT", body: { user_id: userId } });
      const who = data!.reviewers.find((r) => r.id === userId);
      toast.success(who ? `Assigned to ${userId === meId ? "you" : who.name || who.email}` : "Unassigned");
      onChange();
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="rv-assignee">
      <Field label="Reviewer" error={error} hint={data.reviewers.length ? undefined : "Nobody else can review here yet."}>
        <Select
          value={assigneeId ?? ""}
          aria-required={false}
          disabled={saving}
          onChange={(e) => void assign(e.target.value || null)}
          options={[{ value: "", label: "Unassigned" }, ...data.reviewers.map((r) => ({ value: r.id, label: r.id === meId ? `${r.name || r.email} (you)` : r.name || r.email }))]}
        />
      </Field>
      {meEligible && assigneeId !== meId && (
        <button type="button" className="link-btn rv-assign-me" disabled={saving} onClick={() => void assign(meId)}>
          Assign to me
        </button>
      )}
    </div>
  );
}

interface Comment {
  id: string;
  body: string;
  author: string;
  author_name?: string | null;
  author_email?: string | null;
  created_at: string;
  mine: boolean;
}

function Comments({ id, meEmail }: { id: string; meEmail: string | null }) {
  const { data, error: loadError, reload } = useApi<{ comments: Comment[] }>(`/revisions/${id}/comments`);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/revisions/${id}/comments`, { method: "POST", body: { body } });
      setBody("");
      reload();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Discussion" count={data?.comments.length || undefined}>
      {loadError && !data && <ErrorState compact error={loadError} onRetry={reload} title="Couldn't load the comments" />}
      {data && !data.comments.length && <p className="rv-muted">No comments yet. Ask the author a question or explain a change.</p>}
      {data && data.comments.length > 0 && (
        <ol className="rv-comments">
          {data.comments.map((c) => (
            <li key={c.id} className="rv-comment" data-mine={c.mine || undefined}>
              <div className="rv-comment-head">
                <PersonChip
                  name={c.author_name ?? (isEmail(c.author) ? null : c.author)}
                  email={c.author_email ?? (isEmail(c.author) ? c.author : null)}
                  showEmail={!c.mine}
                  size="sm"
                  you={c.mine || (!!meEmail && (c.author_email ?? c.author) === meEmail)}
                />
                <RelativeTime date={c.created_at} />
              </div>
              <div className="rv-comment-body">
                <Markdown text={c.body} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <form
        className="rv-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Add a comment" hint="Markdown works. Press ⌘ or Ctrl and Enter to send." error={error}>
          <Textarea
            autoGrow
            minRows={3}
            aria-required={false}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Ask the author a question or explain a change"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
        <div className="rv-composer-actions">
          <Button type="submit" size="sm" icon="message" loading={busy} loadingText="Sending">
            Comment
          </Button>
        </div>
      </form>
    </Section>
  );
}

/** Text for a field value (arrays joined). */
const fieldText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : v === null || v === undefined ? "" : String(v));

function ItemPreview({ data, maxChars }: { data: RevisionDetail; maxChars?: number }) {
  const { current, target_kind } = data;
  const body = target_kind === "article" ? String(current.body_md ?? "") : `**Symptoms.** ${current.symptoms ?? ""}\n\n**Root cause.** ${current.root_cause ?? ""}${maxChars ? "" : `\n\n**Fix.** ${current.fix ?? ""}`}`;
  return (
    <Card padding="sm" className="rv-item-preview" title={current.title}>
      <div className="rv-preview-body">
        <Markdown text={maxChars && body.length > maxChars ? `${body.slice(0, maxChars)}…` : body} comments="all" />
      </div>
    </Card>
  );
}

/** "via Claude": a decision made through Claude (MCP) or with an API token, in review history. */
function ViaClaude({ via }: { via?: string | null }) {
  if (via !== "mcp" && via !== "token") return null;
  return (
    <Badge variant="outline" icon="sparkle" title={via === "mcp" ? "Decided by asking Claude (the Thaliyola connector)" : "Decided with an API token (Claude Code or a script)"}>
      via Claude
    </Badge>
  );
}

/** An article edit's tag changes: what it adds and removes, and the tags it leaves. */
function ProposedTags({ added, removed, after }: { added: string[]; removed: string[]; after: string[] }) {
  return (
    <div className="rv-tags-change">
      <span className="rv-tags-label">Tags:</span>
      {removed.map((t) => (
        <del key={`r-${t}`} className="rv-tag rv-tag-removed">
          #{t}
        </del>
      ))}
      {added.map((t) => (
        <ins key={`a-${t}`} className="rv-tag rv-tag-added">
          #{t}
        </ins>
      ))}
      {!added.length && !removed.length && <span className="muted">no change</span>}
      <span className="sr-only">. After this edit: {after.map((t) => `#${t}`).join(", ") || "no tags"}</span>
    </div>
  );
}

/** The proposed change, per operation. `compact` is the queue's inline preview. */
function ProposedChange({ data, author, compact }: { data: RevisionDetail; author?: string; compact?: boolean }) {
  const { op, target_kind, current, proposed, payload } = data;
  const H = compact ? "h4" : "h2";
  const wrap = (title: string, children: ReactNode) =>
    compact ? (
      <div className="rv-change">
        <H className="rv-change-title">{title}</H>
        {children}
      </div>
    ) : (
      <Section title={title}>{children}</Section>
    );

  if (op === "create") {
    const after =
      target_kind === "article"
        ? `# ${current.title ?? ""}\n\n${current.body_md ?? ""}`
        : `# ${current.title ?? ""}\n\n${FINDING_FIELDS.slice(1)
            .map(([f, name]) => `### ${name}\n\n${fieldText(current[f])}`)
            .join("\n\n")}`;
    return wrap(`New ${target_kind}`, <DiffView before="" after={after} markdown isNew showModeToggle={!compact} />);
  }
  if (op === "share") {
    return wrap(
      "Add to the Library",
      <>
        <Facts items={[{ term: "Library folder", value: payload.path ? payload.path : "Top level" }]} />
        <p className="rv-explain">
          On approval a Library copy is created, with its links and files, and {current.scope?.slug ? <LocationLabel scope={current.scope.slug} /> : "the project"} is linked to it.
        </p>
        {!compact && <ItemPreview data={data} />}
      </>,
    );
  }
  if (op === "move") {
    const fromSlug = current.scope?.slug as string | undefined;
    const sameFolder = target_kind === "article" && !payload.folder ? (payload.to === fromSlug ? " (same folder)" : " (top level)") : "";
    return wrap(
      "Move",
      <>
        <Facts
          items={[
            { term: "From", value: fromSlug ? <LocationLabel scope={fromSlug} path={current.path || undefined} link={!compact} /> : "—" },
            {
              term: "To",
              value: (
                <>
                  <strong>{payload.to_name ?? payload.to}</strong>
                  {payload.folder ? ` › ${payload.folder}` : sameFolder}
                </>
              ),
            },
            ...(payload.repo ? [{ term: "Repository", value: <code>{payload.repo}</code> }] : []),
          ]}
        />
        <p className="rv-explain">On approval it keeps its history and links; the destination's members and settings apply. Approving needs Review in both places.</p>
        {!compact && <ItemPreview data={data} maxChars={1500} />}
      </>,
    );
  }
  if (op === "verify") {
    return wrap(
      "Mark as outdated",
      <>
        <Callout tone="danger" title={`Marked as outdated${author ? ` by ${nameOf(author)}` : ""}`}>
          {payload.note ? <p>{payload.note}</p> : <p>No note was given.</p>}
          <p>On approval the {target_kind} is marked as replaced.</p>
        </Callout>
        {!compact && <ItemPreview data={data} maxChars={1500} />}
      </>,
    );
  }
  if (target_kind === "article") {
    return wrap(
      payload.section ? `Changes to “${payload.section}”` : "Changes",
      <>
        {payload.title && payload.title !== current.title && (
          <p className="rv-title-change">
            Title: <del>{current.title}</del> <span aria-hidden="true">→</span>
            <span className="sr-only"> becomes </span> <ins>{payload.title}</ins>
          </p>
        )}
        {Array.isArray(payload.tags) && <ProposedTags added={payload.tags_added ?? []} removed={payload.tags_removed ?? []} after={payload.tags} />}
        {payload.text === undefined || payload.text === null ? (
          <p className="rv-tags-only small muted">The text doesn't change.</p>
        ) : (
          <DiffView before={current.body_md ?? ""} after={proposed.body_md ?? ""} markdown showModeToggle={!compact} />
        )}
      </>,
    );
  }
  const patch = (payload.patch ?? {}) as Record<string, unknown>;
  return wrap(
    "Changes",
    <div className="rv-field-diffs">
      {Object.entries(patch).map(([field, value]) => (
        <div key={field} className="rv-field-diff">
          <h3 className="rv-field-label">{FIELD_LABEL[field] ?? humanize(field)}</h3>
          <DiffView before={fieldText(current[field])} after={fieldText(value)} markdown={field !== "title"} showModeToggle={!compact && field !== "title"} labels={{ before: "Now", after: "Proposed" }} />
        </div>
      ))}
    </div>,
  );
}

// ---- Needs a check -----------------------------------------------------------------------------------

interface AttentionEntry {
  kind: "article" | "finding";
  id: string;
  title: string;
  type: string;
  status: string;
  scope: string;
  last_verified_at: string | null;
  review_due: string | null;
  reason: string;
  owner: string | null;
  owner_name?: string | null;
}

const REASONS = [
  { value: "", label: "All" },
  { value: "not verified recently", label: "Not verified recently" },
  { value: "review overdue", label: "Review overdue" },
];

function CheckTab({ route, onCount }: { route: Route; onCount(n: number): void }) {
  const [f, setQuery] = useQueryState(route);
  const { me, scopes, scope: scopeInfo } = useBoot();
  const toast = useToast();
  const confirm = useConfirm();
  const result = useApi<{ entries: AttentionEntry[] }>(`/attention?limit=200${f.scope ? `&scope=${encodeURIComponent(f.scope)}` : ""}`);
  const { data, error, loading, reload } = result;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<{ id: string; title: string; error: string }[]>([]);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (data) onCount(data.entries.length);
  }, [data, onCount]);
  useEffect(() => {
    setGone(new Set());
  }, [data]);
  useEffect(() => {
    setSelected(new Set());
    setCursorId(null);
  }, [f.scope, f.reason, f.q]);

  const canVerify = (e: AttentionEntry) => can.inScope(scopeInfo(e.scope), "verify", me);
  const q = (f.q ?? "").toLowerCase();
  const rows = (data?.entries ?? []).filter((e) => !gone.has(e.id) && (!f.reason || e.reason === f.reason) && (!q || e.title.toLowerCase().includes(q)));
  const verifiable = rows.filter(canVerify);
  const byId = new Map(rows.map((e) => [e.id, e]));
  const reasonCount = (r: string) => (data?.entries ?? []).filter((e) => !gone.has(e.id) && e.reason === r).length;
  const anyFilter = !!(f.scope || f.reason || f.q);

  async function confirmOne(e: AttentionEntry) {
    setRowBusy((b) => ({ ...b, [e.id]: true }));
    setRowError((x) => ({ ...x, [e.id]: "" }));
    try {
      await api(`/verify/${e.id}`, { method: "POST", body: { still_valid: true } });
      setGone((g) => new Set(g).add(e.id));
      toast.success("Marked as verified today");
      refreshCounts();
    } catch (err) {
      setRowError((x) => ({ ...x, [e.id]: errText(err) }));
    } finally {
      setRowBusy((b) => ({ ...b, [e.id]: false }));
    }
  }

  async function outdated(e: AttentionEntry) {
    const res = await confirm({
      title: `Mark “${e.title}” as outdated?`,
      body: "This sends a proposal to review. Once approved, the item is marked as replaced.",
      confirmLabel: "Send for review",
      tone: "danger",
      reason: { label: "What's no longer true?", required: true, maxLength: 2000 },
    });
    if (!res) return;
    try {
      const out = await api<{ revision_id?: string }>(`/verify/${e.id}`, { method: "POST", body: { still_valid: false, note: res.reason } });
      toast.success("Sent for review", out.revision_id ? { link: { label: "View proposal", href: href(`/review/${out.revision_id}`) } } : undefined);
      refreshCounts();
    } catch (err) {
      toast.error(err, { title: "Couldn't mark it as outdated" });
    }
  }

  async function confirmSelected() {
    const items = [...selected].map((id) => byId.get(id)).filter((e): e is AttentionEntry => !!e).slice(0, 100);
    if (!items.length) return;
    const failed: { id: string; title: string; error: string }[] = [];
    setFailures([]);
    setProgress({ done: 0, total: items.length });
    await runPool(
      items,
      3,
      async (e) => {
        try {
          await api(`/verify/${e.id}`, { method: "POST", body: { still_valid: true } });
          setGone((g) => new Set(g).add(e.id));
        } catch (err) {
          failed.push({ id: e.id, title: e.title, error: errText(err) });
        }
      },
      (done) => setProgress({ done, total: items.length }),
    );
    setProgress(null);
    setFailures(failed);
    setSelected(new Set());
    const ok = items.length - failed.length;
    if (failed.length) toast.warning(`Confirmed ${ok} of ${items.length}`);
    else toast.success(`Confirmed ${plural(ok, "item")}`);
    refreshCounts();
  }

  const rowLinks = () => Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>('li[id^="rv-chk-"] .list-row-title > a') ?? []);
  const focusedId = () => {
    const li = (document.activeElement as HTMLElement | null)?.closest?.('li[id^="rv-chk-"]');
    return li ? li.id.slice("rv-chk-".length) : cursorId;
  };
  const move = (delta: number) => {
    const links = rowLinks();
    const id = focusedId();
    const i = id ? links.findIndex((a) => a.closest("li")?.id === `rv-chk-${id}`) : -1;
    links[i < 0 ? 0 : Math.max(0, Math.min(links.length - 1, i + delta))]?.focus();
  };
  useShortcuts(
    {
      j: () => move(1),
      k: () => move(-1),
      x: () => {
        const e = byId.get(focusedId() ?? "");
        if (e && canVerify(e))
          setSelected((s) => {
            const n = new Set(s);
            if (n.has(e.id)) n.delete(e.id);
            else n.add(e.id);
            return n;
          });
      },
      a: () => {
        const e = byId.get(focusedId() ?? "");
        if (e && canVerify(e) && !rowBusy[e.id]) void confirmOne(e);
      },
    },
    rows.length > 0,
    { target: listRef, group: "Needs a check", labels: { j: "Next item", k: "Previous item", x: "Select or clear the item", a: "Confirm still accurate" } },
  );
  useShortcuts({ j: () => move(0), k: () => move(0) }, rows.length > 0);
  useShortcuts({}, selected.size > 0, { group: "Needs a check", labels: { Escape: "Clear the selection" } });

  const allState: boolean | "mixed" = verifiable.length === 0 ? false : verifiable.every((e) => selected.has(e.id)) ? true : verifiable.some((e) => selected.has(e.id)) ? "mixed" : false;
  const scopeLabel = (slug: string) => scopeInfo(slug)?.name ?? slug;
  const checkActive = [
    f.q && { id: "q", label: `Search: ${f.q}`, onRemove: () => setQuery({ q: undefined }) },
    f.reason && { id: "reason", label: `Reason: ${REASONS.find((r) => r.value === f.reason)?.label ?? humanize(f.reason)}`, onRemove: () => setQuery({ reason: undefined }) },
    f.scope && { id: "scope", label: `Where: ${scopeLabel(f.scope)}`, onRemove: () => setQuery({ scope: undefined }) },
  ].filter(Boolean) as { id: string; label: string; onRemove(): void }[];

  return (
    <div className="rv-check">
      {(anyFilter || (data?.entries.length ?? 0) > 0) && (
        <FilterBar
          search={{ value: f.q ?? "", onChange: (v) => setQuery({ q: v.trim() || undefined }), label: "Search titles", placeholder: "Search titles", debounceMs: 150 }}
          filters={
            <ChipGroup
              label="Reason"
              value={f.reason ?? ""}
              onChange={(v: string) => setQuery({ reason: v || undefined })}
              options={REASONS.map((r) => ({ ...r, count: r.value ? reasonCount(r.value) : undefined }))}
            />
          }
          more={{
            count: f.scope ? 1 : 0,
            content: (
              <div className="rv-filter-fields">
                <Field label="Where">
                  <ProjectPicker value={f.scope ?? ""} onChange={(slug) => setQuery({ scope: slug || undefined })} scopes={scopes} noneLabel="Everywhere" />
                </Field>
              </div>
            ),
          }}
          active={checkActive}
          onClearAll={() => setQuery({ scope: undefined, reason: undefined, q: undefined })}
          result={data ? plural(rows.length, "item") : undefined}
        />
      )}

      {progress && (
        <p className="rv-progress" role="status">
          Confirmed {progress.done} of {progress.total}…
        </p>
      )}
      {failures.length > 0 && (
        <Callout tone="warning" title={`${plural(failures.length, "item")} couldn't be confirmed`} onDismiss={() => setFailures([])}>
          <ul className="rv-failures">
            {failures.map((x) => (
              <li key={x.id}>
                <a href={href(`/${byId.get(x.id)?.kind ?? "article"}/${x.id}`)}>{x.title}</a>: {x.error}
              </li>
            ))}
          </ul>
        </Callout>
      )}

      {error && data && <ErrorState compact error={error} onRetry={reload} />}
      {!data ? (
        error ? (
          <ErrorState error={error} onRetry={reload} title="Couldn't load what needs a check" />
        ) : (
          <div aria-busy="true">
            <span className="sr-only" role="status">
              Loading items that need a check
            </span>
            <SkeletonRows count={5} />
          </div>
        )
      ) : rows.length === 0 ? (
        anyFilter ? (
          <EmptyState
            variant="search"
            title="Nothing matches these filters"
            primary={<Button onClick={() => setQuery({ scope: undefined, reason: undefined, q: undefined })}>Clear filters</Button>}
          />
        ) : (
          <EmptyState variant="positive" title="Everything is fresh" description="Entries that haven't been verified recently show up here." />
        )
      ) : (
        <>
          {verifiable.length > 0 && (
            <div className="rv-listhead">
              <label className="rv-selectall">
                <SelectAllBox checked={allState} onChange={(on) => setSelected(on ? new Set(verifiable.slice(0, 100).map((e) => e.id)) : new Set())} label={`Select all you can verify (${verifiable.length})`} />
                <span>Select all you can verify ({verifiable.length})</span>
              </label>
              <KeyHint
                items={[
                  { keys: "j k", label: "move" },
                  { keys: "x", label: "select" },
                  { keys: "a", label: "confirm" },
                ]}
              />
            </div>
          )}
          <BulkBar count={selected.size} noun={["item", "items"]} onClear={() => setSelected(new Set())}>
            <Button size="sm" variant="primary" icon="check" loading={!!progress} loadingText="Confirming" onClick={() => void confirmSelected()}>
              Confirm {Math.min(selected.size, 100)}
            </Button>
            {selected.size > 100 && <span className="rv-muted">At most 100 at a time.</span>}
          </BulkBar>
          <div
            className="rv-list"
            onFocus={(e) => {
              const li = (e.target as HTMLElement).closest('li[id^="rv-chk-"]');
              if (li) setCursorId(li.id.slice("rv-chk-".length));
            }}
          >
            <RowList label="Items that need a check" keyboardRef={listRef} refreshing={loading}>
              {rows.map((e) => {
                const ok = canVerify(e);
                const menu: MenuItemSpec[] = [
                  { id: "edit", label: "Edit", icon: "pencil", href: href(`/${e.kind}/${e.id}/edit`) },
                  ...(ok ? [{ type: "separator" } as const, { id: "outdated", label: "Mark as outdated…", icon: "alert", tone: "danger", onSelect: () => void outdated(e) } as MenuItemSpec] : []),
                ];
                return (
                  <ItemRow
                    key={e.id}
                    id={`rv-chk-${e.id}`}
                    item={{ kind: e.kind, id: e.id, title: e.title, type: e.type, scope: e.scope }}
                    show={{ status: false, updated: false }}
                    cursor={cursorId === e.id}
                    selectable={
                      ok
                        ? {
                            checked: selected.has(e.id),
                            label: `Select ${e.title}`,
                            onChange: (on) =>
                              setSelected((s) => {
                                const n = new Set(s);
                                if (on) n.add(e.id);
                                else n.delete(e.id);
                                return n;
                              }),
                          }
                        : undefined
                    }
                    badges={
                      <Badge tone="warning" icon="clock">
                        {e.reason === "review overdue" ? "Review overdue" : "Not verified recently"}
                      </Badge>
                    }
                    metaExtra={[
                      <RelativeTime key="v" date={e.last_verified_at} prefix="Last verified" />,
                      e.review_due ? <span key="d">Review due {shortDate(e.review_due)}</span> : null,
                      e.owner ? (
                        <span key="o" className="rv-above">
                          {person(e.owner, "human", "sm", e.owner_name)}
                        </span>
                      ) : null,
                    ]}
                    note={!ok ? <p className="rv-note">You can't verify in this space.</p> : undefined}
                    error={rowError[e.id] || undefined}
                    actions={
                      <>
                        {ok && (
                          <Button size="sm" icon="check" loading={!!rowBusy[e.id]} loadingText="Confirming" onClick={() => void confirmOne(e)}>
                            Confirm still accurate
                          </Button>
                        )}
                        <OverflowMenu items={menu} size="sm" label={`More actions for ${e.title}`} />
                      </>
                    }
                  />
                );
              })}
            </RowList>
          </div>
          {(data.entries.length >= 200) && <LoadMore shown={rows.length} noun={["item", "items"]} capNote="Showing the first 200. Choose a project to see the rest." />}
        </>
      )}
    </div>
  );
}

// ---- Suggestions -------------------------------------------------------------------------------------

interface Suggestions {
  promote: {
    finding: { id: string; title: string; scope: string };
    recurrences: number;
    verifications: number;
    suggested_article: { id: string; title: string; type: string; version: number } | null;
  }[];
  duplicates: { similarity: number; a: { id: string; title: string; scope: string }; b: { id: string; title: string; scope: string } }[];
  conflicts?: { similarity: number; a: { id: string; title: string; scope: string }; b: { id: string; title: string; scope: string } }[];
  note?: string;
}

type ApiResult<T> = { data: T | null; error: unknown; loading: boolean; reload: () => void };

function SuggestionsTab({ sugg, tasks, refresh }: { sugg: ApiResult<Suggestions>; tasks: ApiResult<TaskSummary>; refresh?: ReactNode }) {
  const toast = useToast();
  const [done, setDone] = useState<Record<string, { label: string; revision?: string }>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  async function act(key: string, fn: () => Promise<{ revision_id?: string }>, label: string) {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const res = await fn();
      setDone((d) => ({ ...d, [key]: { label, revision: res?.revision_id } }));
      toast.success(label, res?.revision_id ? { link: { label: "View proposal", href: href(`/review/${res.revision_id}`) } } : undefined);
      if (res?.revision_id) refreshCounts();
    } catch (e) {
      toast.error(e, { title: label === "Linked" ? "Couldn't link them" : "Couldn't propose it" });
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  }

  const data = sugg.data;
  return (
    <div className="rv-suggestions">
      {refresh && <div className="rv-refresh">{refresh}</div>}
      <AgentTasks result={tasks} />

      <Section title="Recurring root causes" description="Findings that keep coming back. Fold them into the article people read first.">
        {!data ? (
          sugg.error ? (
            <ErrorState error={sugg.error} onRetry={sugg.reload} title="Couldn't load suggestions" />
          ) : (
            <SkeletonRows count={3} />
          )
        ) : !data.promote.length ? (
          <EmptyState variant="compact" icon="check-circle" title="Nothing recurring right now" />
        ) : (
          <div className="rv-list">
          <RowList label="Recurring root causes" refreshing={sugg.loading}>
            {data.promote.map((p) => {
              const d = done[p.finding.id];
              return (
                <ListRow
                  key={p.finding.id}
                  title={p.finding.title}
                  href={href(`/finding/${p.finding.id}`)}
                  leading={<I name="bolt" size={16} />}
                  meta={
                    <MetaLine
                      items={[
                        <LocationLabel key="l" scope={p.finding.scope} />,
                        p.recurrences ? <span key="r">Came back {plural(p.recurrences, "time")}</span> : null,
                        p.verifications ? <span key="v">Verified {plural(p.verifications, "time")}</span> : null,
                      ]}
                    />
                  }
                  extra={
                    d ? (
                      <p className="rv-done rv-above">
                        <I name="check" size={14} /> Proposed{d.revision ? <> · <a href={href(`/review/${d.revision}`)}>View proposal</a></> : null}
                      </p>
                    ) : !p.suggested_article ? (
                      <p className="rv-note">No obvious article yet: consider writing a runbook.</p>
                    ) : undefined
                  }
                  actions={
                    !d && p.suggested_article ? (
                      <Button
                        size="sm"
                        loading={!!busy[p.finding.id]}
                        loadingText="Proposing"
                        onClick={() =>
                          void act(
                            p.finding.id,
                            () => api("/promote", { method: "POST", body: { finding_id: p.finding.id, article_id: p.suggested_article!.id, version: p.suggested_article!.version } }),
                            "Proposed",
                          )
                        }
                      >
                        Add to “{p.suggested_article.title}”
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </RowList>
          </div>
        )}
      </Section>

      <Section title="Possible duplicates" description="Findings that look alike. Link them if they share a root cause.">
        {!data ? (
          sugg.error ? null : <SkeletonRows count={2} />
        ) : (
          <>
            {data.note && <Callout tone="neutral">{data.note}</Callout>}
            {!data.note && !data.duplicates.length && <EmptyState variant="compact" icon="check-circle" title="No unlinked look-alikes" />}
            {data.duplicates.length > 0 && (
              <div className="rv-dupes">
                {data.duplicates.map((d) => {
                  const key = `${d.a.id}:${d.b.id}`;
                  return (
                    <Card key={key} padding="sm" className="rv-dupe">
                      <div className="rv-dupe-pair">
                        {[d.a, d.b].map((x) => (
                          <div key={x.id} className="rv-dupe-side">
                            <a href={href(`/finding/${x.id}`)}>{x.title}</a>
                            <LocationLabel scope={x.scope} />
                          </div>
                        ))}
                      </div>
                      <div className="rv-dupe-foot">
                        <Badge tone="neutral">{Math.round(d.similarity * 100)}% similar</Badge>
                        {done[key] ? (
                          <span className="rv-done">
                            <I name="check" size={14} /> Linked
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            icon="link"
                            loading={!!busy[key]}
                            loadingText="Linking"
                            onClick={() => void act(key, () => api("/links", { method: "POST", body: { from: d.a.id, to: d.b.id, relation: "same_root_cause" } }), "Linked")}
                          >
                            Same root cause
                          </Button>
                        )}
                      </div>
                    </Card>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Section>

      {data && (data.conflicts?.length ?? 0) > 0 && (
        <Section title="Decisions that may conflict" description="Decisions whose choices are about the same thing. Mark the one that holds as superseding the other, or say they don't conflict.">
          <div className="rv-dupes">
            {data.conflicts!.map((d) => {
              const key = `c:${d.a.id}:${d.b.id}`;
              return (
                <Card key={key} padding="sm" className="rv-dupe">
                  <div className="rv-dupe-pair">
                    {[d.a, d.b].map((x) => (
                      <div key={x.id} className="rv-dupe-side">
                        <a href={href(`/article/${x.id}`)}>{x.title}</a>
                        <LocationLabel scope={x.scope} />
                      </div>
                    ))}
                  </div>
                  <div className="rv-dupe-foot">
                    <Badge tone="neutral">{Math.round(d.similarity * 100)}% alike</Badge>
                    {done[key] ? (
                      <span className="rv-done">
                        <I name="check" size={14} /> {done[key]!.label}
                      </span>
                    ) : (
                      <>
                        <Button size="sm" loading={!!busy[key]} onClick={() => void act(key, () => api("/decisions/conflicts", { method: "POST", body: { a: d.a.id, b: d.b.id, outcome: "supersedes" } }), "First supersedes second")}>
                          First replaces second
                        </Button>
                        <Button size="sm" loading={!!busy[key]} onClick={() => void act(key, () => api("/decisions/conflicts", { method: "POST", body: { a: d.b.id, b: d.a.id, outcome: "supersedes" } }), "Second supersedes first")}>
                          Second replaces first
                        </Button>
                        <Button size="sm" variant="ghost" loading={!!busy[key]} onClick={() => void act(key, () => api("/decisions/conflicts", { method: "POST", body: { a: d.a.id, b: d.b.id, outcome: "not_a_conflict" } }), "Not a conflict")}>
                          Not a conflict
                        </Button>
                      </>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        </Section>
      )}
    </div>
  );
}

const TASK_TEXT: Record<string, string> = {
  file_into_project: "Filed in Team but about a project",
  tag_repository: "Project pages without their repository",
  merge_duplicates: "Look-alike findings",
  promote_recurring: "Recurring problems to fold into articles",
  fill_outline: "Articles with empty sections",
  verify_stale: "Entries to re-check",
  write_overview: "Projects without an overview",
  link_related: "Entries with no links",
  answer_gap: "Searches that found nothing",
  stale_claims: "Documentation facts whose code changed",
  triage_inbox: "New items from team sources",
};

interface TaskSummary {
  open: number;
  by_kind: Record<string, number>;
  done_this_week: number;
  recent: { key: string; kind: string; outcome: string; note: string | null; completed_at: string; revision_id: string | null; by: string }[];
  sample: { id: string; kind: string; title: string; project: string | null }[];
}

/** Curation work Thaliyola hands to connected Claude sessions, and what they did with it. */
function AgentTasks({ result }: { result: ApiResult<TaskSummary> }) {
  const data = result.data;
  if (!data) return result.error ? <ErrorState compact error={result.error} onRetry={result.reload} title="Couldn't load the work for Claude" /> : null;
  return (
    <Card
      as="section"
      className="rv-agent-tasks"
      title="Work for Claude"
      titleLevel={2}
      description="Thaliyola finds what needs judgment; a connected Claude does it with its own model and proposes changes here for review."
    >
      {!data.open ? (
        <p className="rv-muted">Nothing waiting. The knowledge base looks tidy.</p>
      ) : (
        <ul className="rv-task-kinds">
          {Object.entries(data.by_kind)
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <li key={k}>
                <span className="rv-task-count">{n}</span> {TASK_TEXT[k] ?? humanize(k)}
              </li>
            ))}
        </ul>
      )}
      <p className="rv-muted rv-done-week">{plural(data.done_this_week, "task")} done this week</p>
      <RunWithClaude
        title="Run it in Claude Code"
        command="/mcp__thaliyola__curate"
        description={<p>Or ask Claude to “curate the Thaliyola knowledge base”, or schedule it.</p>}
      />
      {data.recent.length > 0 && (
        <Disclosure summary={`Recently handled by agents (${data.recent.length})`} storageKey="rv-agent-recent">
          <ul className="rv-recent">
            {data.recent.map((r) => (
              <li key={r.key}>
                <span>{TASK_TEXT[r.kind] ?? humanize(r.kind)}</span>
                <MetaLine
                  items={[
                    <strong key="o">{humanize(r.outcome)}</strong>,
                    <span key="b">by {nameOf(r.by)}</span>,
                    <RelativeTime key="d" date={r.completed_at} />,
                    r.revision_id ? (
                      <a key="p" href={href(`/review/${r.revision_id}`)}>
                        View proposal
                      </a>
                    ) : null,
                    r.note ? <span key="n">{r.note}</span> : null,
                  ]}
                />
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </Card>
  );
}

// ---- New projects ------------------------------------------------------------------------------------

interface ProjectRequest {
  id: string;
  slug: string;
  name: string;
  description: string;
  repos: { slug: string; kind: string; repo_url?: string; description?: string }[];
  reason: string;
  state: string;
  decision_note: string | null;
  created_at: string;
  requested_by?: string;
}

const REQUEST_STATE: Record<string, { label: string; tone: "warning" | "success" | "neutral"; icon: "clock" | "check" | "x" }> = {
  pending: { label: "Waiting", tone: "warning", icon: "clock" },
  approved: { label: "Created", tone: "success", icon: "check" },
  declined: { label: "Declined", tone: "neutral", icon: "x" },
};

/**
 * Projects that people or their agents asked for. Whoever the server shows `requested_by` to (people who can create
 * projects) creates it or declines with a reason; the server refuses everyone else.
 */
function ProjectRequestsTab({ onCount }: { onCount(n: number): void }) {
  const pendingRes = useApi<{ requests: ProjectRequest[] }>("/project-requests");
  const { reloadScopes } = useBoot();
  const toast = useToast();
  const confirm = useConfirm();
  const [show, setShowRaw] = useState<"pending" | "decided">("pending");
  // For people who can create projects the plain call returns pending requests only, so decided ones need their own
  // calls (made once the Decided segment has been opened). Everyone else gets their own requests in every state from
  // any call; merging by id covers them.
  const [wantDecided, setWantDecided] = useState(false);
  const setShow = (v: "pending" | "decided") => {
    setShowRaw(v);
    if (v === "decided") setWantDecided(true);
  };
  const approvedRes = useApi<{ requests: ProjectRequest[] }>(wantDecided ? "/project-requests?state=approved" : null);
  const declinedRes = useApi<{ requests: ProjectRequest[] }>(wantDecided ? "/project-requests?state=declined" : null);
  const [busy, setBusy] = useState<Record<string, "create" | "decline">>({});

  const pendingRows = pendingRes.data?.requests.filter((r) => r.state === "pending") ?? [];
  const pendingCount = pendingRows.length;
  useEffect(() => {
    if (pendingRes.data) onCount(pendingCount);
  }, [pendingRes.data, pendingCount, onCount]);

  const decidedLoaded = !!(pendingRes.data && approvedRes.data && declinedRes.data);
  const decidedRows = useMemo(() => {
    if (!decidedLoaded) return [];
    const byId = new Map<string, ProjectRequest>();
    for (const r of [...pendingRes.data!.requests, ...approvedRes.data!.requests, ...declinedRes.data!.requests]) if (r.state !== "pending") byId.set(r.id, r);
    return [...byId.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }, [decidedLoaded, pendingRes.data, approvedRes.data, declinedRes.data]);

  const reload = () => {
    pendingRes.reload();
    if (wantDecided) {
      approvedRes.reload();
      declinedRes.reload();
    }
  };
  const cur =
    show === "pending"
      ? { data: pendingRes.data ? pendingRows : null, error: pendingRes.error, loading: pendingRes.loading }
      : {
          data: decidedLoaded ? decidedRows : null,
          error: pendingRes.error ?? approvedRes.error ?? declinedRes.error,
          loading: pendingRes.loading || approvedRes.loading || declinedRes.loading,
        };

  async function create(r: ProjectRequest) {
    setBusy((b) => ({ ...b, [r.id]: "create" }));
    try {
      await api(`/project-requests/${r.id}/approve`, { method: "POST", body: {} });
      toast.success(`Created ${r.name}`, { link: { label: "Open project", href: href(`/project/${r.slug}`) } });
      reloadScopes();
      reload();
    } catch (e) {
      toast.error(e, { title: `Couldn't create ${r.name}` });
    } finally {
      setBusy(({ [r.id]: _, ...rest }) => rest);
    }
  }
  async function decline(r: ProjectRequest) {
    const res = await confirm({
      title: `Decline ${r.name}?`,
      body: "The requester sees your reason.",
      confirmLabel: "Decline",
      tone: "danger",
      reason: { label: `Why decline ${r.name}?`, required: true, maxLength: 1000, presets: ["A project for this already exists", "Belongs in an existing project", "Not needed"] },
    });
    if (!res) return;
    setBusy((b) => ({ ...b, [r.id]: "decline" }));
    try {
      await api(`/project-requests/${r.id}/decline`, { method: "POST", body: { note: res.reason } });
      toast.success(`Declined ${r.name}`);
      reload();
    } catch (e) {
      toast.error(e, { title: `Couldn't decline ${r.name}` });
    } finally {
      setBusy(({ [r.id]: _, ...rest }) => rest);
    }
  }

  const { data, error, loading } = cur;
  const list = data ?? [];
  return (
    <div className="rv-requests">
      <p className="rv-intro">
        When a Claude session works in code that has no project here, it asks for one through Claude{" "}
        <InfoTip label="How Claude asks">Claude uses its create_project tool.</InfoTip> instead of filing its notes in the shared space. Sessions of people who can create projects (Administrators,
        Project creators) create them directly; these came from everyone else.
      </p>
      <div className="rv-requests-bar">
        <SegmentedControl
          label="Requests"
          size="sm"
          value={show}
          onChange={setShow}
          options={[
            { value: "pending", label: "Pending", count: pendingRes.data ? pendingCount : undefined },
            { value: "decided", label: "Decided", count: decidedLoaded ? decidedRows.length : undefined },
          ]}
        />
      </div>
      {error && data && <ErrorState compact error={error} onRetry={reload} />}
      {!data ? (
        error ? (
          <ErrorState error={error} onRetry={reload} title="Couldn't load project requests" />
        ) : (
          <div aria-busy="true">
            <span className="sr-only" role="status">
              Loading project requests
            </span>
            <SkeletonRows count={3} />
          </div>
        )
      ) : !list.length ? (
        show === "pending" ? (
          <EmptyState variant="positive" title="No project requests waiting" description="Requests from Claude sessions for a new project show up here." />
        ) : (
          <EmptyState variant="compact" title="No decided requests yet" />
        )
      ) : (
        <div className="rv-request-list" aria-busy={loading || undefined}>
          {list.map((r) => {
            const st = REQUEST_STATE[r.state] ?? { label: humanize(r.state), tone: "neutral" as const, icon: "clock" as const };
            const canDecide = r.state === "pending" && r.requested_by !== undefined;
            return (
              <Card
                key={r.id}
                as="article"
                className="rv-request"
                title={
                  <span className="rv-request-title">
                    {r.name} <code className="rv-slug">{r.slug}</code>
                  </span>
                }
                actions={
                  <Badge tone={st.tone} icon={st.icon}>
                    {st.label}
                  </Badge>
                }
                footer={
                  r.state === "pending" ? (
                    canDecide ? (
                      <div className="rv-request-actions">
                        <Button variant="primary" size="sm" icon="folder-plus" loading={busy[r.id] === "create"} loadingText="Creating" disabledReason={busy[r.id] ? "Wait for the current action to finish" : undefined} onClick={() => void create(r)}>
                          Create project
                        </Button>
                        <Button size="sm" loading={busy[r.id] === "decline"} loadingText="Declining" disabledReason={busy[r.id] ? "Wait for the current action to finish" : undefined} onClick={() => void decline(r)}>
                          Decline…
                        </Button>
                      </div>
                    ) : (
                      <p className="rv-muted">Waiting for someone who can create projects (an Administrator or Project creator).</p>
                    )
                  ) : undefined
                }
              >
                {r.description && <p className="rv-request-desc">{r.description}</p>}
                {r.repos.length > 0 && (
                  <Facts
                    items={[
                      {
                        term: r.repos.length === 1 ? "Repository" : "Repositories",
                        value: (
                          <ul className="rv-repos">
                            {r.repos.map((x) => (
                              <li key={x.slug}>
                                <code>{x.slug}</code> <span className="rv-muted">{labelFrom(REPO_KIND, x.kind)}</span>
                                {x.repo_url && (
                                  <>
                                    {" "}
                                    <a href={x.repo_url} target="_blank" rel="noopener noreferrer">
                                      {x.repo_url}
                                      <span className="sr-only"> (opens in a new tab)</span>
                                    </a>
                                  </>
                                )}
                              </li>
                            ))}
                          </ul>
                        ),
                      },
                    ]}
                  />
                )}
                {r.reason && <blockquote className="rv-quote">“{r.reason}”</blockquote>}
                <p className="rv-request-meta">
                  <MetaLine items={[r.requested_by ? <span key="by">Asked by {nameOf(r.requested_by)}</span> : null, <RelativeTime key="t" date={r.created_at} />]} />
                </p>
                {r.state !== "pending" && r.decision_note && <p className="rv-request-note">Decision: {r.decision_note}</p>}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

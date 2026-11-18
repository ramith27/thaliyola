import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, type Me } from "../api";
import { useBoot } from "../components/boot";
import { ChartCard, LineChart, StackedColumns, StatTile } from "../components/charts";
import { plural } from "../components/labels";
import { can } from "../components/permissions";
import {
  AsyncBlock,
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  ItemRow,
  RelativeTime,
  RowList,
  SegmentedControl,
  SkeletonCard,
  SkeletonRows,
  SkeletonTiles,
  Tabs,
  useToast,
} from "../components/kit";
import { Page, PageHeader, TileGrid } from "../components/kit";
import { useApi, useMediaQuery, useQueryState } from "../hooks";
import { setPrefill } from "../paste";
import { href, navigate, type Route } from "../router";

interface Success {
  days: number;
  reuse: { verifications: number; proposals: number; agent_reads: number; agent_searches: number; rate: number | null };
  search: { total: number; answered: number; from_agents: number; hit_rate: number | null; keyword_hit_rate: number | null; agent_hit_rate: number | null };
  weekly: { week: string; searches: number; answered: number; verifications: number; proposals: number }[];
  review: { median_hours: number | null; p90_hours: number | null; decided: number; pending: number; oldest_pending_days: number | null };
  repeats: { id: string; title: string; type: string; scope: string; occurrences: number; last_seen: string }[];
  hygiene: { unowned_articles: number; stale: number; overdue_reviews: number; total: number };
  unowned: { id: string; title: string; type: string; scope: string; updated_at: string }[];
  gaps_visible: boolean;
}

interface Gap {
  query: string;
  searches: number;
  people: number;
  from_agents: number;
  last_searched: string;
  kind: "none" | "loose";
}

interface AttentionEntry {
  kind: "article" | "finding";
  id: string;
  title: string;
  type: string;
  status: string;
  scope: string;
  last_verified_at: string | null;
  review_due: string | null;
  reason: "not verified recently" | "review overdue";
  owner: string | null;
}

const PERIODS = ["30", "90", "180"] as const;
const GAP_PERIODS = ["7", "30", "90"] as const;

const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
const pct = (v: number | null) => (v === null ? null : `${Math.round(v)}%`);
const hours = (h: number | null) => (h === null ? null : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

/** Is the knowledge base working? Reuse, answers found, review speed, what needs attention, repeat problems, gaps. */
export function MetricsPage({ me: _me, route }: { me: Me; route: Route }) {
  const [q, setQ] = useQueryState(route, { days: "90", gapsDays: "30", focus: "" });
  const days = (PERIODS as readonly string[]).includes(q.days!) ? q.days! : "90";
  const result = useApi<Success>(`/success?days=${days}`);
  const attentionRef = useRef<HTMLDivElement>(null);
  const phone = useMediaQuery("(max-width: 860px)");
  const period = (
    <SegmentedControl
      label="Period"
      size="sm"
      options={PERIODS.map((d) => ({ value: d, label: `${d} days` }))}
      value={days as (typeof PERIODS)[number]}
      onChange={(v) => setQ({ days: v })}
    />
  );

  // The "Needs attention" tile links here (?focus=attention): scroll to the card, then drop the flag.
  useEffect(() => {
    if (q.focus !== "attention" || !result.data) return;
    const el = attentionRef.current;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    el?.querySelector<HTMLElement>("[role=tab][aria-selected=true]")?.focus({ preventScroll: true });
    setQ({ focus: undefined });
  }, [q.focus, result.data, setQ]);

  return (
    <Page width="wide">
      <PageHeader
        title="Metrics"
        description="Is your knowledge base paying off? How often people and agents find answers, reuse what exists, and how fast reviews happen."
        actions={phone ? undefined : period}
      />
      {/* On phones the header folds its actions into a sheet; the period stays visible under the header instead. */}
      {phone && <div className="tl-period">{period}</div>}
      <AsyncBlock
        result={result}
        label="Loading metrics"
        errorTitle="Couldn't load the metrics"
        skeleton={
          <div className="tl-stack-lg">
            <SkeletonTiles count={5} />
            <div className="tl-grid-2">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          </div>
        }
      >
        {(data) => (
          <MetricsBody
            data={data}
            days={days}
            attentionRef={attentionRef}
            attentionHref={href("/metrics", { days: days === "90" ? undefined : days, gapsDays: q.gapsDays === "30" ? undefined : q.gapsDays, focus: "attention" })}
            gapsDays={q.gapsDays!}
            setGapsDays={(v) => setQ({ gapsDays: v })}
          />
        )}
      </AsyncBlock>
    </Page>
  );
}
MetricsPage.keepMountedOnQuery = true;

function MetricsBody({
  data,
  days,
  attentionRef,
  attentionHref,
  gapsDays,
  setGapsDays,
}: {
  data: Success;
  days: string;
  attentionRef: RefObject<HTMLDivElement>;
  attentionHref: string;
  gapsDays: string;
  setGapsDays: (v: string) => void;
}) {
  const weeks = data.weekly.map((w) => ({ ...w, missed: w.searches - w.answered }));
  const h = data.hygiene;
  const attention = h.unowned_articles + h.stale + h.overdue_reviews;
  const period = `last ${days} days`;
  return (
    <div className="tl-stack-lg">
      <TileGrid>
        <StatTile
          label="Searches answered"
          value={pct(data.search.hit_rate)}
          icon="search"
          note={`${data.search.answered} of ${plural(data.search.total, "search", "searches")}`}
          emptyNote="No searches in this period"
          trend={data.weekly.map((w) => (w.searches ? w.answered / w.searches : 0))}
          info="Answered means at least one result came back. Searches made while typing aren't counted."
        />
        <StatTile
          label="Answered for agents"
          value={pct(data.search.agent_hit_rate)}
          icon="bot"
          note={plural(data.search.from_agents, "agent search", "agent searches")}
          emptyNote={
            <>
              No agent searches yet · <a href={href("/connect")}>Connect Claude</a>
            </>
          }
          info="The share of searches from AI agents (Claude and others) that found at least one result."
        />
        <StatTile
          label="Reuse rate"
          value={pct(data.reuse.rate)}
          icon="review"
          note={`${data.reuse.verifications} confirmed vs ${data.reuse.proposals} new`}
          emptyNote="Nothing confirmed or new yet"
          info="Confirmations that an entry is still accurate, as a share of confirmations plus new proposals. High means people find and trust what's there instead of solving it again."
        />
        <StatTile
          label="Review time"
          value={hours(data.review.median_hours)}
          icon="clock"
          href={href("/review")}
          note={`Median · 90% within ${hours(data.review.p90_hours) ?? "—"}`}
          emptyNote="None decided in this period"
          info="How long proposals wait between being submitted and being approved or rejected."
        />
        <StatTile
          label="Needs attention"
          value={attention}
          icon="alert"
          href={attentionHref}
          tone={h.stale + h.overdue_reviews > 0 ? "warning" : undefined}
          note={`${h.unowned_articles} without an owner · ${h.stale} need a check · ${h.overdue_reviews} overdue`}
          info={`Articles without an owner, items not verified recently and articles past their review date, out of ${plural(h.total, "item")}. One article can count twice.`}
        />
      </TileGrid>

      <div ref={attentionRef} className="tl-anchor">
        <NeedsAttention data={data} />
      </div>
      <Card
          as="section"
          titleLevel={2}
          title="Problems that keep coming back"
          description="Findings linked as the same root cause. Fix the cause, or fold them into a runbook."
        >
          {data.repeats.length ? (
            <RowList label="Problems that keep coming back" density="compact">
              {data.repeats.map((r) => (
                <ItemRow
                  key={r.id}
                  density="compact"
                  item={{ kind: "finding", id: r.id, title: r.title, type: r.type, scope: r.scope }}
                  show={{ updated: false, status: false }}
                  note={<RelativeTime date={r.last_seen} prefix="Last" />}
                  actions={<Badge tone="warning">{plural(r.occurrences + 1, "time")}</Badge>}
                />
              ))}
            </RowList>
          ) : (
            <EmptyState variant="compact" icon="bolt" title="No repeats linked yet" description="Link findings as the same root cause and they show up here." />
          )}
        </Card>

      <div className="tl-grid-2">
        <ChartCard
          title="Searches"
          subtitle={`Per week, from people and agents, ${period}`}
          summary={`${data.search.answered} of ${plural(data.search.total, "search", "searches")} found something in the ${period}.`}
          empty={<EmptyState variant="compact" icon="search" title={`No searches in the ${period}`} />}
          table={{ columns: ["Week of", "Answered", "Nothing found"], rows: weeks.map((w) => [short(w.week), w.answered, w.missed]) }}
        >
          <StackedColumns
            data={weeks}
            xLabel={(d) => short(String(d.week))}
            series={[
              { key: "answered", label: "Answered", color: "var(--series-1)" },
              { key: "missed", label: "Nothing found", color: "var(--neutral-mark)" },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Reuse vs new"
          subtitle={`Entries confirmed still accurate vs new proposals, per week, ${period}`}
          summary={`${data.reuse.verifications} confirmed vs ${data.reuse.proposals} new in the ${period}.`}
          empty={<EmptyState variant="compact" icon="review" title={`Nothing confirmed or proposed in the ${period}`} />}
          table={{ columns: ["Week of", "Confirmed", "New"], rows: data.weekly.map((w) => [short(w.week), w.verifications, w.proposals]) }}
        >
          <LineChart
            data={data.weekly}
            xLabel={(d) => short(String(d.week))}
            series={[
              { key: "verifications", label: "Confirmed", color: "var(--series-1)" },
              { key: "proposals", label: "New", color: "var(--series-2)" },
            ]}
          />
        </ChartCard>
      </div>

      {data.gaps_visible && <Gaps days={(GAP_PERIODS as readonly string[]).includes(gapsDays) ? gapsDays : "30"} setDays={setGapsDays} />}
    </div>
  );
}

const ATTENTION_TABS = [
  { id: "unowned", label: "Without an owner" },
  { id: "stale", label: "Not verified recently" },
  { id: "overdue", label: "Review overdue" },
] as const;
type AttentionTab = (typeof ATTENTION_TABS)[number]["id"];

const SHOWN = 5;

/** Unowned, stale and overdue items, one tab each; the last two can be confirmed here. */
function NeedsAttention({ data }: { data: Success }) {
  const h = data.hygiene;
  const [tab, setTab] = useState<AttentionTab>("unowned");
  const [all, setAll] = useState(false);
  const attention = useApi<{ entries: AttentionEntry[] }>("/attention?limit=50");
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const { me, scope } = useBoot();
  // Only people who can verify in the item's project get the button (and, for an overdue review, only those with Review
  // there, since nobody else's confirmation moves the review date on); everyone else just opens the item.
  const canVerify = (e: AttentionEntry) =>
    can.inScope(scope(e.scope), "verify", me) && (e.reason !== "review overdue" || can.inScope(scope(e.scope), "review", me));
  const counts: Record<AttentionTab, number> = {
    unowned: h.unowned_articles,
    stale: Math.max(0, h.stale - countIn(confirmed, attention.data?.entries, "not verified recently")),
    overdue: Math.max(0, h.overdue_reviews - countIn(confirmed, attention.data?.entries, "review overdue")),
  };

  async function confirmStill(e: AttentionEntry) {
    setBusy(e.id);
    try {
      await api(`/verify/${e.id}`, { method: "POST", body: { still_valid: true } });
      setConfirmed((s) => new Set(s).add(e.id));
      toast.success(`Confirmed “${truncate(e.title)}”`);
    } catch (err) {
      toast.error(err, { title: "Couldn't confirm it", action: { label: "Try again", onClick: () => void confirmStill(e) } });
    } finally {
      setBusy(null);
    }
  }

  let body: ReactNode;
  if (tab === "unowned") {
    const rows = data.unowned;
    const shown = all ? rows : rows.slice(0, SHOWN);
    body = rows.length ? (
      <>
        <RowList label="Articles without an owner" density="compact">
          {shown.map((a) => (
            <ItemRow
              key={a.id}
              density="compact"
              item={{ kind: "article", id: a.id, title: a.title, type: a.type, scope: a.scope, updated_at: a.updated_at }}
              show={{ status: false }}
            />
          ))}
        </RowList>
        <ShowAll shown={shown.length} listed={rows.length} total={h.unowned_articles} all={all} onAll={() => setAll(true)} noun="article" />
        <p className="muted small">Give an article an owner by editing it. Owners are asked to re-check what goes stale.</p>
      </>
    ) : (
      <EmptyState variant="positive" title="Every article has an owner" />
    );
  } else {
    const reason = tab === "stale" ? "not verified recently" : "review overdue";
    body = (
      <AsyncBlock result={attention} label="Loading items that need a check" errorTitle="Couldn't load the list" skeleton={<SkeletonRows count={3} density="compact" />}>
        {(d) => {
          const rows = d.entries.filter((e) => e.reason === reason && !confirmed.has(e.id));
          const shown = all ? rows : rows.slice(0, SHOWN);
          if (!rows.length)
            return <EmptyState variant="positive" title={tab === "stale" ? "Everything has been verified recently." : "No reviews are overdue."} />;
          return (
            <>
              <RowList label={tab === "stale" ? "Not verified recently" : "Review overdue"} density="compact">
                {shown.map((e) => (
                  <ItemRow
                    key={e.id}
                    density="compact"
                    item={{ kind: e.kind, id: e.id, title: e.title, type: e.type, scope: e.scope }}
                    show={{ status: false, updated: false }}
                    note={
                      tab === "overdue" && e.review_due ? (
                        <span className="muted small">
                          Review was due <RelativeTime date={e.review_due} />
                        </span>
                      ) : e.last_verified_at ? (
                        <span className="muted small">
                          <RelativeTime date={e.last_verified_at} prefix="Last verified" />
                        </span>
                      ) : undefined
                    }
                    actions={
                      canVerify(e) ? (
                      <Button size="sm" icon="check" loading={busy === e.id} loadingText="Confirming" onClick={() => void confirmStill(e)}>
                        Confirm still accurate
                      </Button>
                      ) : undefined
                    }
                  />
                ))}
              </RowList>
              <ShowAll shown={shown.length} listed={rows.length} total={counts[tab]} all={all} onAll={() => setAll(true)} noun="item" />
            </>
          );
        }}
      </AsyncBlock>
    );
  }

  return (
    <Card as="section" titleLevel={2} title="Needs attention" description="Articles without an owner, and items to confirm or review again.">
      <div className="tl-stack">
        <div className="tl-wrap-tabs">
          <Tabs
            label="Needs attention"
            idPrefix="tl-attention"
            value={tab}
            onChange={(id) => {
              setTab(id as AttentionTab);
              setAll(false);
            }}
            items={ATTENTION_TABS.map((t) => ({ id: t.id, label: t.label, count: counts[t.id], countTone: t.id === "unowned" ? "neutral" : "accent" }))}
          />
        </div>
        <div role="tabpanel" id={`tl-attention-panel-${tab}`} aria-labelledby={`tl-attention-tab-${tab}`} className="tl-tabpanel">
          {body}
        </div>
      </div>
    </Card>
  );
}

function countIn(ids: Set<string>, entries: AttentionEntry[] | undefined, reason: AttentionEntry["reason"]) {
  return (entries ?? []).filter((e) => e.reason === reason && ids.has(e.id)).length;
}

const truncate = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "Show all" after five rows, and a note when the server lists fewer than it counts. */
function ShowAll({ shown, listed, total, all, onAll, noun }: { shown: number; listed: number; total: number; all: boolean; onAll: () => void; noun: string }) {
  if (!all && listed > shown) {
    return (
      <div className="tl-row">
        <Button size="sm" variant="ghost" onClick={onAll}>
          {total > listed ? `Show ${listed} of ${total}` : `Show all ${listed}`}
        </Button>
        {total > listed && <span className="muted small">The server lists the oldest {listed}.</span>}
      </div>
    );
  }
  if (total > listed) return <p className="muted small">Showing the {plural(listed, `oldest ${noun}`, `oldest ${noun}s`)} of {total}.</p>;
  return null;
}

/** Searches with no answer: what to write next. Shown to people with See usage (the server sets gaps_visible). */
function Gaps({ days, setDays }: { days: string; setDays: (v: string) => void }) {
  const result = useApi<{ gaps: Gap[] }>(`/gaps?days=${days}`);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  // On phones the card header is too narrow for the period control next to the description.
  const phone = useMediaQuery("(max-width: 860px)");
  const period = (
    <SegmentedControl
      label="Show searches from the last"
      labelVisible
      size="sm"
      options={GAP_PERIODS.map((d) => ({ value: d, label: `${d} days` }))}
      value={days as (typeof GAP_PERIODS)[number]}
      onChange={setDays}
    />
  );

  async function dismiss(g: Gap) {
    setBusy(g.query);
    try {
      await api("/gaps/dismiss", { method: "POST", body: { query: g.query } });
      setDismissed((s) => new Set(s).add(g.query));
      toast.success(`Dismissed “${truncate(g.query)}”`);
      result.reload();
    } catch (err) {
      toast.error(err, { title: "Couldn't dismiss it", action: { label: "Try again", onClick: () => void dismiss(g) } });
    } finally {
      setBusy(null);
    }
  }

  function writeIt(g: Gap) {
    setPrefill({ kind: "article", type: "note", title: g.query.charAt(0).toUpperCase() + g.query.slice(1), body_md: "" });
    navigate("/new/article");
  }

  return (
    <Card
      as="section"
      titleLevel={2}
      title="Searches with no answer"
      description={
        <>
          What people and agents searched for without a keyword match: candidates for new articles. Queries are redacted. Only people with See usage (Auditors and
          Administrators) see this.
        </>
      }
      actions={phone ? undefined : period}
    >
      {phone && <div className="tl-period">{period}</div>}
      <AsyncBlock result={result} label="Loading searches with no answer" errorTitle="Couldn't load searches with no answer" skeleton={<SkeletonRows count={4} density="compact" />}>
        {(d) => (
          <DataTable
            caption="Searches with no answer"
            density="compact"
            rows={d.gaps.filter((g) => !dismissed.has(g.query))}
            getRowId={(g) => g.query}
            columns={[
              {
                key: "query",
                header: "Searched for",
                primary: true,
                cell: (g) => (
                  <>
                    <span className="tl-query">{g.query}</span>
                    {g.from_agents > 0 && <span className="muted small"> · {g.from_agents} from agents</span>}
                  </>
                ),
              },
              { key: "times", header: "Times", numeric: true, cell: (g) => g.searches },
              { key: "people", header: "People", numeric: true, cell: (g) => g.people },
              {
                key: "result",
                header: "Result",
                cell: (g) =>
                  g.kind === "none" ? (
                    <Badge tone="warning" icon="alert">
                      No results
                    </Badge>
                  ) : (
                    <Badge>Loose matches</Badge>
                  ),
              },
              { key: "last", header: "Last searched", cell: (g) => <RelativeTime date={g.last_searched} /> },
            ]}
            rowAction={(g) => (
              <span className="tl-row-actions">
                <Button size="sm" icon="pencil" onClick={() => writeIt(g)}>
                  Write it
                </Button>
                <Button size="sm" variant="ghost" loading={busy === g.query} loadingText="Dismissing" onClick={() => void dismiss(g)}>
                  Dismiss
                </Button>
              </span>
            )}
            empty={<EmptyState variant="positive" title="No gaps: every search matched something" />}
          />
        )}
      </AsyncBlock>
    </Card>
  );
}

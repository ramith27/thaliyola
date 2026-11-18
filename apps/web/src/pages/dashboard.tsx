import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Me, type RevisionSummary, type ScopeInfo } from "../api";
import { ChartCard, HBars, LineChart, StackedColumns, StatTile, StatusBar } from "../components/charts";
import { I, type IconName } from "../components/icons";
import { itemHref } from "../components/ui";
import { refreshCounts, useApi, useMediaQuery } from "../hooks";
import { HomeSearch } from "../components/find";
import { Checklist, ConnectClaudeCard, checklistFinished, type OnboardingData } from "../components/checklist";
import { href } from "../router";
import type { ConnectInfo } from "./connect";
import { useBoot } from "../components/boot";
import { can } from "../components/permissions";
import { CREATE_ACTIONS, visible } from "../components/nav";
import { formatTimestamp, plural, statusMeta, typeLabel } from "../components/labels";
import {
  AsyncBlock,
  Badge,
  Button,
  Card,
  CategoryBadge,
  Disclosure,
  EmptyState,
  ErrorState,
  ItemRow,
  ListRow,
  MetaLine,
  Page,
  PageHeader,
  PersonChip,
  RelativeTime,
  RowList,
  Section,
  Skeleton,
  SkeletonRows,
  SkeletonTiles,
  SplitButton,
  useToast,
  type MenuItemSpec,
} from "../components/kit";

interface Insights {
  totals: { articles: number; findings: number; projects: number; pending: number; attention: number };
  growth: { week: string; articles: number; findings: number }[];
  activity: { day: string; agents: number; web: number }[];
  statuses: { published?: number; possibly_stale?: number; draft?: number };
  types: { type: string; n: number }[];
  contributors: { name: string; approved: number }[];
  review: { approved: number; rejected: number; median_hours: number | null };
  recent: { id: string; op: string; summary: string; decided_at: string; target_kind: string; target_id: string; scope: string; author: string }[];
}

interface AttentionEntry {
  kind: "article" | "finding";
  id: string;
  title: string;
  type: string;
  scope: string;
  reason: string;
  last_verified_at: string;
}

type Facets = { to_review: number };

const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const capitalise = (t: string) => (t ? t[0]!.toUpperCase() + t.slice(1) : t);

/** "Good morning, Rita": the first word of their display name, else of their email. */
function greeting(email: string | null, displayName?: string | null) {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const fromName = displayName?.trim().split(/\s+/)[0];
  const name = fromName || (email ? email.split("@")[0]!.split(/[._-]/)[0]! : "");
  return `${part}${name ? `, ${name[0]!.toUpperCase()}${name.slice(1)}` : ""}`;
}

/** "Waiting 3 days" (the full timestamp as the tooltip). */
function Waiting({ since }: { since: string }) {
  const ms = Date.now() - new Date(since).getTime();
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  const text = hours < 1 ? "Waiting less than an hour" : hours < 24 ? `Waiting ${plural(hours, "hour")}` : `Waiting ${plural(days, "day")}`;
  return (
    <time className="relative-time" dateTime={since} title={formatTimestamp(since)}>
      {text}
    </time>
  );
}

/** Review categories for an operation (the server's REVIEW_CATEGORIES). */
const OP_CATEGORY: Record<string, "new" | "edit" | "move" | "share" | "retire"> = { create: "new", update: "edit", promote: "edit", move: "move", share: "share", verify: "retire" };

/** Recently approved: an icon plus a word for each operation, never a colour-only dot. */
const OP_DONE: Record<string, { label: string; icon: IconName; tone: "success" | "accent" | "neutral" | "warning" }> = {
  create: { label: "New", icon: "plus", tone: "success" },
  update: { label: "Updated", icon: "pencil", tone: "accent" },
  promote: { label: "Added to article", icon: "link", tone: "accent" },
  move: { label: "Moved", icon: "move", tone: "neutral" },
  share: { label: "Shared", icon: "library", tone: "accent" },
  verify: { label: "Marked outdated", icon: "alert", tone: "warning" },
};

const TRY = ["how do we handle refunds?", "what does 409 mean on POST /orders?", "who owns checkout?"];

export function Dashboard({ scopes, me }: { scopes: ScopeInfo[]; me: Me }) {
  const boot = useBoot();
  const toast = useToast();
  const phone = useMediaQuery("(max-width: 860px)");
  const insights = useApi<Insights>("/insights");
  const review = useApi<{ revisions: RevisionSummary[]; facets?: Facets }>("/revisions?state=pending&assigned=to_review&sort=oldest&limit=3&facets=true");
  const mine = useApi<{ revisions: RevisionSummary[] }>("/revisions?state=pending&author=me&limit=3&sort=newest");
  const [showAllAttention, setShowAllAttention] = useState(false);
  const attention = useApi<{ entries: AttentionEntry[] }>(`/attention?limit=${showAllAttention ? 50 : 6}`);
  const onboarding = useApi<OnboardingData>("/onboarding");
  const setupFinished = onboarding.data ? checklistFinished(onboarding.data) : false;
  const connect = useApi<ConnectInfo>(setupFinished ? "/connect-info" : null);

  const projects = scopes.filter((s) => s.kind === "project");
  const spaces = scopes.filter((s) => s.kind !== "project");
  const readable = new Set(projects.map((p) => p.slug));
  const topLevel = projects.filter((p) => !p.parent || !readable.has(p.parent));
  const children = (slug: string) => projects.filter((p) => p.parent === slug).length;
  // As in the sidebar: Project creators start projects; Project admins (Manage settings) start sub-projects of theirs.
  const canCreateProject = can.newProjectEntry(me, scopes);

  const ctx = { me, scopes, current: null };
  const createActions = visible(CREATE_ACTIONS, ctx);
  const createMenu: MenuItemSpec[] = createActions
    .filter((a) => a.id !== "article")
    .map((a) => ({ id: a.id, label: a.label(ctx), hint: a.hint(ctx), icon: a.icon, href: a.href(ctx) }));
  // The Projects section's button is the same entry as the header menu's ("New project" or "New sub-project").
  const projectAction = createActions.find((a) => a.id === "project" || a.id === "sub-project");

  // Confirmed rows collapse at once. `seen` is the /insights result showing when the confirm landed: the confirm is
  // subtracted from the total only until a newer /insights result (which already leaves it out) arrives.
  const [confirmed, setConfirmed] = useState<{ id: string; seen: Insights | null }[]>([]);
  const latestInsights = useRef(insights.data);
  latestInsights.current = insights.data;
  const [verifying, setVerifying] = useState<string | null>(null);
  // After a confirm, keyboard focus moves to the row that took its place (or the card's heading).
  const focusRowAfter = useRef<number | null>(null);
  const verify = async (e: AttentionEntry, index: number) => {
    setVerifying(e.id);
    try {
      await api(`/verify/${e.id}`, { method: "POST", body: { still_valid: true } });
      focusRowAfter.current = index;
      setConfirmed((c) => [...c, { id: e.id, seen: latestInsights.current }]);
      toast.success("Marked as verified today", { description: e.title });
      refreshCounts();
      insights.reload();
      attention.reload(); // the next entries move up into view
    } catch (err) {
      toast.error(err, { title: "Couldn't confirm it", action: { label: "Try again", onClick: () => void verify(e, index) } });
    } finally {
      setVerifying(null);
    }
  };
  useEffect(() => {
    const i = focusRowAfter.current;
    if (i === null) return;
    focusRowAfter.current = null;
    // Only when focus was lost with the collapsed row; never pull it away from somewhere the person moved it.
    if (document.activeElement && document.activeElement !== document.body) return;
    const links = document.querySelectorAll<HTMLElement>("#hm-attention-list .list-row-title a");
    (links[Math.min(i, links.length - 1)] ?? document.getElementById("hm-attention-title") ?? document.getElementById("hm-for-you-title"))?.focus();
  }, [confirmed]);

  // After Hide, focus moves to whatever took the checklist's place.
  const focusAfterHide = useRef(false);
  useEffect(() => {
    if (!focusAfterHide.current || !setupFinished || (!connect.data && !connect.error)) return;
    focusAfterHide.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    (document.getElementById("hm-connect-title") ?? document.querySelector<HTMLElement>(".hm-for-you .hm-action-title") ?? document.getElementById("hm-for-you-title"))?.focus();
  }, [setupFinished, connect.data, connect.error]);

  const toReview = review.data?.facets?.to_review ?? review.data?.revisions.length ?? 0;
  const confirmedIds = new Set(confirmed.map((c) => c.id));
  const attentionRows = (attention.data?.entries ?? []).filter((e) => !confirmedIds.has(e.id));
  const unsynced = confirmed.filter((c) => c.seen !== null && c.seen === insights.data).length;
  const serverAttention = insights.data?.totals.attention;
  const attentionTotal = serverAttention !== undefined ? Math.max(attentionRows.length, serverAttention - unsynced) : attentionRows.length;
  // "Everything is fresh" only once the list has loaded and nothing is left: never while loading or after an error.
  const attentionKnown = !!attention.data && !attention.error;
  const myProposals = mine.data?.revisions ?? [];

  const description =
    review.data && toReview > 0
      ? `${plural(toReview, "proposal is", "proposals are")} waiting for your review.`
      : (insights.data || attention.data) && attentionTotal > 0
        ? `${plural(attentionTotal, "entry needs", "entries need")} a check.`
        : review.data && attentionKnown
          ? "You're all caught up. Here's what your team knows."
          : "What needs you, and what your team knows.";

  // For-you cards: a card with nothing to show collapses; loading and errors keep their place.
  const settled = (r: { data: unknown; error: unknown }) => !!r.data || !!r.error;
  const showReview = !settled(review) || !!review.error || toReview > 0;
  const showAttention = !settled(attention) || !!attention.error || attentionTotal > 0;
  const showMine = !!mine.error || myProposals.length > 0;
  // The slot stays while /connect-info loads after the checklist is hidden, so the band doesn't jump twice.
  const showSetup = !settled(onboarding) || !!onboarding.error || !setupFinished || !settled(connect) || (!!connect.data && !connect.data.has_connected);
  const allSettled = settled(review) && settled(attention) && settled(mine) && settled(onboarding) && (!setupFinished || settled(connect));
  const caughtUp = allSettled && !showReview && !showAttention && !showMine && !showSetup;

  const firstProject = topLevel[0] ?? projects[0];
  const visibleAttention = showAllAttention ? attentionRows : attentionRows.slice(0, 3);

  const search = (
    <div className="hm-search">
      <HomeSearch />
      <p className="hm-try">
        <span className="hm-try-label">Try:</span>
        {TRY.map((q) => (
          <a key={q} className="chip" href={href("/search", { q })}>
            {q}
          </a>
        ))}
      </p>
    </div>
  );

  const forYou = (
    <section className="hm-for-you-wrap" aria-labelledby="hm-for-you-title">
      <h2 id="hm-for-you-title" className="sr-only" tabIndex={-1}>
        For you
      </h2>
      {caughtUp ? (
        <EmptyState variant="positive" title="You're all caught up" description="Nothing is waiting for your review, and everything is fresh." />
      ) : (
        <div className="hm-for-you">
          {showReview && (
            <ActionCard
              id="hm-review"
              title="Waiting for your review"
              count={review.data ? toReview : undefined}
              footer={
                review.data ? (
                  <a href={href("/review", { assigned: "to_review" })}>
                    Review all <I name="chevron-right" size={14} />
                  </a>
                ) : null
              }
            >
              <AsyncBlock result={review} label="Loading proposals for you" errorTitle="Couldn't load your review queue" skeleton={<SkeletonRows count={3} />}>
                {(d) => (
                  <RowList label="Oldest proposals waiting for your review">
                    {d.revisions.map((r) => (
                      <ListRow
                        key={r.id}
                        href={href(`/review/${r.id}`)}
                        title={r.target_title || r.summary}
                        badges={OP_CATEGORY[r.op] ? <CategoryBadge category={OP_CATEGORY[r.op]!} /> : undefined}
                        meta={<MetaLine items={[<PersonChip key="p" name={r.author_name} email={r.author} kind={r.author_kind ?? "human"} size="sm" you={r.author === me.email} />, <Waiting key="w" since={r.created_at} />]} />}
                      />
                    ))}
                  </RowList>
                )}
              </AsyncBlock>
            </ActionCard>
          )}

          {showAttention && (
            <ActionCard
              id="hm-attention"
              wide={showAllAttention}
              title="Needs attention"
              count={attention.data || insights.data ? attentionTotal : undefined}
              footer={
                showAllAttention || attentionTotal > 3 ? (
                  <button type="button" className="link-btn" onClick={() => setShowAllAttention((v) => !v)} aria-controls="hm-attention-list" aria-expanded={showAllAttention}>
                    {showAllAttention ? "Show fewer" : `Show all (${attentionTotal})`}
                  </button>
                ) : null
              }
            >
              <AsyncBlock result={attention} label="Loading entries that need a check" errorTitle="Couldn't load what needs attention" skeleton={<SkeletonRows count={3} />}>
                {() => (
                  <div id="hm-attention-list">
                    {visibleAttention.length === 0 ? (
                      <p className="hm-attention-more muted">
                        {attention.loading ? "Loading the next entries…" : <a href={href("/review", { tab: "check" })}>See them in Review</a>}
                      </p>
                    ) : (
                      <RowList label="Entries that need a check" refreshing={attention.loading}>
                        {visibleAttention.map((e, i) => {
                          const scope = boot.scope(e.scope);
                          // An overdue review is cleared only by someone with Review there (POST /verify moves the date on for
                          // them); anyone else's confirmation would leave the row overdue, so they just open the article.
                          const canVerify =
                            !!scope && can.inScope(scope, "verify", me) && (e.reason !== "review overdue" || can.inScope(scope, "review", me));
                          return (
                            <ItemRow
                              key={e.id}
                              density="compact"
                              item={{ kind: e.kind, id: e.id, title: e.title, type: e.type, scope: e.scope }}
                              show={{ status: false, updated: false }}
                              note={
                                <p className="hm-attention-note">
                                  <span className="hm-attention-reason">
                                    <I name="clock" size={14} /> {capitalise(e.reason)}
                                  </span>
                                  <span className="muted">
                                    <RelativeTime date={e.last_verified_at} prefix="Verified" />
                                  </span>
                                  {canVerify && (
                                    <span className="hm-row-action">
                                      <Button size="sm" icon="check" loading={verifying === e.id} loadingText="Confirming" onClick={() => void verify(e, i)}>
                                        Confirm still accurate
                                      </Button>
                                    </span>
                                  )}
                                </p>
                              }
                            />
                          );
                        })}
                      </RowList>
                    )}
                  </div>
                )}
              </AsyncBlock>
            </ActionCard>
          )}

          {showMine && (
            <ActionCard
              id="hm-mine"
              title="Your proposals"
              count={myProposals.length}
              footer={
                <a href={href("/review", { author: "me" })}>
                  See all <I name="chevron-right" size={14} />
                </a>
              }
            >
              <AsyncBlock result={mine} label="Loading your proposals" errorTitle="Couldn't load your proposals" skeleton={<SkeletonRows count={2} />}>
                {(d) => (
                  <RowList label="Your proposals waiting for review">
                    {d.revisions.map((r) => (
                      <ListRow
                        key={r.id}
                        href={href(`/review/${r.id}`)}
                        title={r.target_title || r.summary}
                        badges={OP_CATEGORY[r.op] ? <CategoryBadge category={OP_CATEGORY[r.op]!} /> : undefined}
                        meta={<MetaLine items={[<span key="s">{r.scope_name ?? r.scope}</span>, <Waiting key="w" since={r.created_at} />]} />}
                      />
                    ))}
                  </RowList>
                )}
              </AsyncBlock>
            </ActionCard>
          )}

          {showSetup && (
            <div className="hm-setup-slot">
              <Checklist
                result={onboarding}
                followHref={firstProject ? href(`/project/${firstProject.slug}`) : undefined}
                onHidden={() => {
                  focusAfterHide.current = true;
                }}
                fallback={connect.data && !connect.data.has_connected ? <ConnectClaudeCard /> : null}
              />
            </div>
          )}
        </div>
      )}
      {!caughtUp && <QuietLines review={review.data ? toReview : null} attention={attentionKnown ? attentionTotal : null} />}
    </section>
  );

  return (
    <Page width="wide">
      <PageHeader
        size="document"
        nav="home"
        title={greeting(me.email, me.name)}
        description={description}
        primary={<SplitButton label="New article" icon="plus" href={href("/new/article")} menu={createMenu} menuLabel="More ways to add knowledge" />}
      />

      <div className="hm-home">
        {/* Phones put For you first. The DOM order changes too, so focus and reading order follow what's on screen. */}
        {phone ? forYou : search}
        {phone ? search : forYou}

        <div className="hm-places">
          <Section title="Spaces">
            <div className="hm-space-grid">
              {spaces.map((s) => (
                <Card
                  key={s.slug}
                  padding="sm"
                  href={href(`/scope/${s.slug}`)}
                  title={
                    <span className="hm-card-title">
                      <I name={s.kind === "library" ? "library" : s.kind === "personal" ? "user" : "team"} size={16} />
                      {s.name}
                    </span>
                  }
                  description={s.description || undefined}
                />
              ))}
            </div>
          </Section>

          <Section
            title={`Projects (${projects.length})`}
            description={<span className="muted">{plural(projects.length, "project")} you can read. Sub-projects open from their parent.</span>}
            actions={
              projectAction ? (
                <Button variant="ghost" icon="folder-plus" href={projectAction.href(ctx)}>
                  {projectAction.label(ctx)}
                </Button>
              ) : undefined
            }
          >
            {topLevel.length ? (
              <div className="hm-project-grid">
                {topLevel.map((p) => (
                  <ProjectCard key={p.slug} project={p} subProjects={children(p.slug)} defaultVisibility={me.default_project_visibility} />
                ))}
              </div>
            ) : (
              <EmptyState
                variant="compact"
                icon="folder"
                title="No projects yet"
                description={canCreateProject ? "Projects hold a team's knowledge, with their own members and repositories." : "Ask an Administrator or a Project creator to start one, or to add you to an existing project."}
                primary={
                  projectAction ? (
                    <Button href={projectAction.href(ctx)} icon="folder-plus">
                      {projectAction.id === "project" ? "Create a project" : "Create a sub-project"}
                    </Button>
                  ) : undefined
                }
              />
            )}
          </Section>
        </div>

        <Glance insights={insights} toReview={review.data ? toReview : null} />
      </div>
    </Page>
  );
}

/** One "For you" card: a heading with a count, up to three rows and a footer link. */
function ActionCard({ id, title, count, footer, wide, children }: { id: string; title: string; count?: number; footer?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <section className="hm-action" id={id} data-wide={wide || undefined} aria-labelledby={`${id}-title`}>
      <div className="hm-action-head">
        {/* tabIndex -1: focus lands here when the card's last row is confirmed, or after the checklist is hidden. */}
        <h3 className="hm-action-title" id={`${id}-title`} tabIndex={-1}>
          {title}
          {count !== undefined && <span className="hm-action-count tabular"> ({count})</span>}
        </h3>
      </div>
      {children}
      {footer && <div className="hm-action-foot">{footer}</div>}
    </section>
  );
}

/** What a collapsed For-you card would have said, so a positive state is never lost. */
function QuietLines({ review, attention }: { review: number | null; attention: number | null }) {
  const lines: string[] = [];
  if (review === 0) lines.push("Nothing is waiting for your review.");
  if (attention === 0) lines.push("Everything is fresh.");
  if (!lines.length) return null;
  return (
    <p className="hm-quiet">
      <I name="check-circle" size={16} />
      {lines.join(" ")}
    </p>
  );
}

function ProjectCard({ project: p, subProjects, defaultVisibility }: { project: ScopeInfo; subProjects: number; defaultVisibility: Me["default_project_visibility"] }) {
  const vis = p.visibility !== defaultVisibility ? statusMeta("visibility", p.visibility) : null;
  return (
    <Card
      padding="sm"
      className="hm-project-card"
      href={href(`/project/${p.slug}`)}
      title={
        <span className="hm-card-title">
          <I name="folder" size={16} />
          {p.name}
        </span>
      }
    >
      <div className="hm-project-body">
        {vis && (
          <div>
            <Badge icon={p.visibility === "members" ? "lock" : "globe"} variant="outline">
              {vis.label}
            </Badge>
          </div>
        )}
        {p.description ? (
          <p className="hm-project-desc">{p.description}</p>
        ) : (
          <p className="hm-project-desc muted">
            No description yet.
            {can.manageSettings(p) && (
              <>
                {" "}
                <a className="hm-project-add" href={href(`/scope/${p.slug}/settings`)}>
                  Add one
                </a>
              </>
            )}
          </p>
        )}
        {(p.components.length > 0 || subProjects > 0) && (
          <div className="hm-project-meta">
            {p.components.map((c) => (
              <Badge key={c.slug} icon="git-branch">
                {c.slug}
              </Badge>
            ))}
            {subProjects > 0 && <span className="muted hm-project-subs">{plural(subProjects, "sub-project")}</span>}
          </div>
        )}
      </div>
    </Card>
  );
}

// ---- Team knowledge at a glance ----------------------------------------------------------------------------------

function Glance({ insights, toReview }: { insights: { data: Insights | null; error: unknown; loading: boolean; reload: () => void }; toReview: number | null }) {
  const { data, error, reload } = insights;
  if (!data) {
    return (
      <section className="hm-glance-wrap" aria-label="Team knowledge at a glance">
        {error ? (
          <>
            <h2 className="hm-glance-heading">Team knowledge at a glance</h2>
            <ErrorState error={error} title="Couldn't load the numbers" onRetry={reload} />
          </>
        ) : (
          <div className="hm-glance-loading" aria-busy="true">
            <span className="sr-only" role="status">
              Loading team numbers
            </span>
            <Skeleton width={260} height={20} />
            <SkeletonTiles count={4} />
          </div>
        )}
      </section>
    );
  }
  const t = data.totals;
  const entries = t.articles + t.findings;
  return (
    <section className="hm-glance-wrap" aria-label="Team knowledge at a glance">
      <Disclosure
        storageKey="thaliyola.home.glance"
        defaultOpen={entries >= 20}
        className="hm-glance"
        summary={
          <span className="hm-glance-summary">
            <span className="hm-glance-heading">Team knowledge at a glance</span>
            <span className="hm-glance-counts muted">
              {plural(t.articles, "article")} · {plural(t.findings, "finding")} · {plural(t.pending, "proposal")} pending
            </span>
          </span>
        }
      >
        <GlanceBody data={data} toReview={toReview} />
      </Disclosure>
    </section>
  );
}

function GlanceBody({ data, toReview }: { data: Insights; toReview: number | null }) {
  const t = data.totals;
  const addedArticles = sum(data.growth.map((g) => g.articles));
  const addedFindings = sum(data.growth.map((g) => g.findings));
  const claude = sum(data.activity.map((a) => a.agents));
  const people = sum(data.activity.map((a) => a.web));
  const published = data.statuses.published ?? 0;
  const stale = data.statuses.possibly_stale ?? 0;
  const drafts = data.statuses.draft ?? 0;
  const topType = data.types[0];
  const topPerson = data.contributors[0];
  const types = useMemo(() => data.types.map((x) => ({ label: typeLabel(x.type), value: x.n })), [data.types]);

  return (
    <div className="hm-glance-body">
      <div className="hm-tiles">
        <StatTile label="Articles" value={t.articles} icon="doc" trend={data.growth.map((g) => g.articles)} note="12 weeks" info={`${plural(addedArticles, "article")} added in the last 12 weeks. The line shows each week.`} />
        <StatTile label="Findings" value={t.findings} icon="bolt" trend={data.growth.map((g) => g.findings)} note="12 weeks" info={`${plural(addedFindings, "finding")} added in the last 12 weeks. The line shows each week.`} />
        <StatTile
          label="Waiting for review"
          value={t.pending}
          icon="inbox"
          href={href("/review")}
          note={data.review.median_hours !== null ? `median ${data.review.median_hours}h to decide` : "proposals"}
          // Everyone's pending proposals, not only the ones assigned to this person (the header and For you count those).
          info={`All pending proposals you can see, from everyone.${toReview !== null ? ` ${plural(toReview, "is", "are")} waiting for your review.` : ""}`}
        />
        <StatTile label="Needs attention" value={t.attention} icon="alert" tone={t.attention ? "warning" : undefined} href={href("/review", { tab: "check" })} note={t.attention ? "stale or overdue" : "Everything is fresh"} />
      </div>

      <div className="hm-charts">
        <ChartCard
          title="Knowledge added"
          subtitle="New articles and findings per week, last 12 weeks"
          summary={`${plural(addedArticles, "article")} and ${plural(addedFindings, "finding")} added in the last 12 weeks.`}
          table={{ columns: ["Week of", "Articles", "Findings"], rows: data.growth.map((g) => [short(g.week), g.articles, g.findings]) }}
          empty={<p className="muted small">Nothing added in the last 12 weeks.</p>}
        >
          <StackedColumns
            data={data.growth}
            xLabel={(d) => short(String(d.week))}
            series={[
              { key: "articles", label: "Articles", color: "var(--series-1)" },
              { key: "findings", label: "Findings", color: "var(--series-2)" },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Claude vs people using Thaliyola"
          subtitle="Requests per day, last 30 days"
          summary={`${claude.toLocaleString("en-GB")} requests from Claude (connector) and ${people.toLocaleString("en-GB")} from people in the web app.`}
          table={{ columns: ["Day", "Claude", "People"], rows: data.activity.map((a) => [short(a.day), a.agents, a.web]) }}
          empty={<p className="muted small">No requests in the last 30 days.</p>}
        >
          <LineChart
            data={data.activity}
            xLabel={(d) => short(String(d.day))}
            series={[
              { key: "agents", label: "Claude (connector)", color: "var(--series-1)" },
              { key: "web", label: "People (web)", color: "var(--series-2)" },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Freshness"
          subtitle="Articles and findings by state"
          summary={`${plural(published, "entry", "entries")} published, ${stale} not verified recently, ${plural(drafts, "draft")}.`}
          table={{
            columns: ["State", "Count"],
            rows: [
              ["Published", published],
              ["Not verified recently", stale],
              ["Drafts, waiting for review", drafts],
            ],
          }}
        >
          <StatusBar
            parts={[
              { key: "published", label: "published", value: published, color: "var(--status-good)", note: "verified recently" },
              { key: "stale", label: "not verified recently", value: stale, color: "var(--status-warning)", note: "ranked lower until checked" },
              { key: "draft", label: "drafts", value: drafts, color: "var(--neutral-mark)", note: "waiting for review" },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Knowledge by type"
          subtitle="Published articles and findings"
          summary={topType ? `${plural(data.types.length, "type")} in use; the most common is ${typeLabel(topType.type)} (${topType.n}).` : "Nothing published yet."}
          table={{ columns: ["Type", "Count"], rows: types.map((x) => [x.label, x.value]) }}
        >
          {types.length ? <HBars data={types.slice(0, 8)} /> : <p className="muted small">Nothing published yet.</p>}
        </ChartCard>
        <ChartCard
          title="Top contributors"
          subtitle="Approved proposals, last 90 days"
          summary={topPerson ? `${topPerson.name} has the most approved proposals (${topPerson.approved}).` : undefined}
          table={{ columns: ["Person", "Approved"], rows: data.contributors.map((c) => [c.name, c.approved]) }}
        >
          {data.contributors.length ? <HBars data={data.contributors.map((c) => ({ label: c.name, value: c.approved }))} /> : <p className="muted small">No approved proposals yet.</p>}
        </ChartCard>
        <RecentlyApproved recent={data.recent} />
      </div>
    </div>
  );
}

function RecentlyApproved({ recent }: { recent: Insights["recent"] }) {
  const boot = useBoot();
  return (
    <Card
      as="section"
      title="Recently approved"
      className="hm-recent"
      actions={
        <a className="small" href={href("/review", { state: "approved" })}>
          All approved
        </a>
      }
    >
      {recent.length ? (
        <ul className="hm-feed">
          {recent.map((r) => {
            const op = OP_DONE[r.op] ?? { label: capitalise(r.op), icon: "check" as IconName, tone: "neutral" as const };
            return (
              <li key={r.id} className="hm-feed-row">
                <Badge tone={op.tone} icon={op.icon}>
                  {op.label}
                </Badge>
                <div className="hm-feed-main">
                  <a href={itemHref(r.target_kind, r.target_id)}>{r.summary}</a>
                  <MetaLine items={[<span key="a">{r.author}</span>, <span key="s">{boot.scope(r.scope)?.name ?? r.scope}</span>, <RelativeTime key="t" date={r.decided_at} />]} />
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState variant="compact" icon="check-circle" title="Nothing approved yet" description="Approved proposals show up here." />
      )}
    </Card>
  );
}


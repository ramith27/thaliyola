import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, getToken, type ScopeInfo } from "../api";
import { useBoot } from "../components/boot";
import { pickFilters, SavedViews } from "../components/saved-views";
import { ChartCard, LineChart, StatTile } from "../components/charts";
import { I } from "../components/icons";
import {
  AsyncBlock,
  Badge,
  Button,
  Callout,
  ChipGroup,
  CodeBlock,
  CopyButton,
  DataTable,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  Facts,
  Field,
  FilterBar,
  InfoTip,
  ListRow,
  LoadMore,
  MetaLine,
  OverflowMenu,
  Page,
  PageHeader,
  Popover,
  ProjectPicker,
  RelativeTime,
  RowList,
  RunWithClaude,
  Section,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonRows,
  SkeletonText,
  SkeletonTiles,
  StatusBadge,
  Tabs,
  TileGrid,
  projectSwitcher,
  type Crumb,
  TextInput,
  Textarea,
  Tooltip,
  focusFirstInvalid,
  useConfirm,
  useToast,
  type Column,
  type MenuItemSpec,
} from "../components/kit";
import { humanize, plural, statusMeta } from "../components/labels";
import { Markdown } from "../components/ui";
import { refreshCounts, useApi, useLiveRefresh, useMediaQuery, useQueryState } from "../hooks";
import { href, type Route } from "../router";

type Severity = "critical" | "high" | "medium" | "low" | "unknown";
type Status = "open" | "acknowledged" | "fixed" | "accepted" | "false_positive";

interface Vuln {
  id: string;
  source: "osv" | "reported";
  advisory_id: string | null;
  aliases: string[];
  title: string;
  ecosystem: string | null;
  package: string | null;
  version: string | null;
  fixed_versions: string[];
  location: string | null;
  severity: Severity;
  cvss_score: string | null;
  kev: boolean;
  kev_due: string | null;
  status: Status;
  status_note: string | null;
  first_seen: string;
  resolved_at: string | null;
  project: string;
  project_name: string;
  repository: string;
}

interface VulnPage {
  total: number;
  vulnerabilities: Vuln[];
}

interface Counts {
  project: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface Coverage {
  project: string;
  project_name: string;
  repository: string;
  kind: string;
  deps_scanned_at: string | null;
  deps_sha: string | null;
  deps_count: number | null;
  reviewed_at: string | null;
  details: boolean;
}

interface Overview {
  tiles: Record<string, number | null>;
  by_project: (Counts & { name: string; repository: string; kev: number })[];
  trend: { day: string; critical: number; high: number; other: number }[];
  top_packages: { ecosystem: string; package: string; open: number; repositories: number; worst: number; fixable: boolean }[];
  coverage: Coverage[];
  reviews: Review[];
  counts_only: Counts[];
  kev_catalog_size: number;
  last_check: string | null;
  can_upload: boolean;
}

interface Review {
  id: string;
  kind: "dependencies" | "code";
  project: string;
  project_name: string;
  repository: string;
  head_sha: string | null;
  summary: string;
  areas: string[];
  tools: string[];
  counts: Partial<Record<Severity, number>>;
  created_at: string;
  by: string | null;
}

const CLAUDE_FULL = "/mcp__thaliyola__security-check full";
const CLAUDE_DEPS = "/mcp__thaliyola__security-check";
const SCAN_VARIANTS = [
  { label: "Dependencies and code", command: CLAUDE_FULL },
  { label: "Dependencies only", command: CLAUDE_DEPS },
];

const SEVERITY_TEXT: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", unknown: "Not yet scored" };
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--sev-critical)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  unknown: "var(--sev-low)",
};
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
const WORST: Severity[] = ["critical", "high", "medium", "low", "unknown"];
const statusText = (s: string) => statusMeta("vulnerability", s).label;

const shortDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-GB", { month: "short", day: "numeric" });
/** "4 Nov", or "4 Nov 2025" in another year (SPEC §1.2 rule 10), for sentences. */
function day(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}
const num = (n: number) => n.toLocaleString("en-GB");
const sha = (s: string | null | undefined) => (s ? s.slice(0, 8) : "");
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** Severity always shows as a coloured dot plus its name and score, never colour alone. */
export function SeverityBadge({ severity, score }: { severity: Severity; score?: string | number | null }) {
  const value = score === null || score === undefined || score === "" ? null : Number(score);
  return (
    <span className="sc-sev" data-sev={severity}>
      <span className="sc-sev-dot" aria-hidden="true" />
      {SEVERITY_TEXT[severity] ?? humanize(severity)}
      {value !== null && !Number.isNaN(value) && (
        <span className="sc-sev-score">
          <span className="sr-only">, severity score </span>
          {value.toFixed(1)}
        </span>
      )}
    </span>
  );
}

function KevBadge({ due }: { due?: string | null }) {
  const tip = due ? `Known to be used in real attacks. CISA asks US federal agencies to fix it by ${day(due)}.` : "Known to be used in real attacks (on CISA's actively exploited list).";
  return (
    <Tooltip content={tip}>
      <span className="sc-kev" tabIndex={0}>
        <Badge tone="danger" icon="alert">
          Actively exploited
        </Badge>
      </span>
    </Tooltip>
  );
}

/** "2 critical · 1 high" with dots; optional links to the filtered list. */
function SeverityCounts({ counts, link }: { counts: Partial<Record<Severity, number>>; link?: (s: Severity) => string }) {
  const parts = (["critical", "high", "medium", "low"] as const).filter((k) => counts[k]);
  if (!parts.length) return <span className="sc-muted">Nothing open</span>;
  return (
    <span className="sc-sev-counts">
      {parts.map((k) => {
        const body = (
          <>
            <span className="sc-sev-dot" aria-hidden="true" />
            {counts[k]} {SEVERITY_TEXT[k].toLowerCase()}
          </>
        );
        return link ? (
          <a key={k} className="sc-sev sc-sev-link" data-sev={k} href={link(k)}>
            {body}
          </a>
        ) : (
          <span key={k} className="sc-sev" data-sev={k}>
            {body}
          </span>
        );
      })}
    </span>
  );
}

// ---- URL helpers ------------------------------------------------------------------------------------------------

const VIEWS = ["overview", "vulnerabilities", "advisories", "repositories"] as const;
type View = (typeof VIEWS)[number];
const LIST_KEYS = ["severity", "status", "kev", "fixable", "q", "repository"] as const;
const FEEDS = ["affecting", "major", "all"] as const;
type FeedView = (typeof FEEDS)[number];
const LIST_STORE = "thaliyola.security.list";

/** A link into the dashboard; empty values are dropped. */
const secHref = (query: Record<string, string | undefined>) => href("/security", query);

/** Old links ended in "#list" (the list anchor); strip it from values and remember it meant the list. */
function cleanQuery(raw: Record<string, string>): { values: Record<string, string>; legacyList: boolean } {
  let legacyList = /#list$/.test(typeof window === "undefined" ? "" : window.location.hash);
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v.endsWith("#list")) legacyList = true;
    values[k] = v.replace(/#list$/, "");
  }
  return { values, legacyList };
}

function rememberList(url: string) {
  try {
    sessionStorage.setItem(LIST_STORE, url);
  } catch {
    /* storage unavailable: the crumb falls back to the plain list */
  }
}
function storedList(): string | null {
  try {
    return sessionStorage.getItem(LIST_STORE);
  } catch {
    return null;
  }
}

// ---- Dashboard -------------------------------------------------------------------------------------------------

interface Feed {
  view: FeedView;
  counts: { major: number; affecting: number; all: number };
  total: number;
  affecting_your_projects: number;
  last_refresh: string | null;
  advisories: Advisory[];
}

export function SecurityPage({ route, scopes, isAdmin = false }: { route: Route; scopes: ScopeInfo[]; isAdmin?: boolean }) {
  const [raw, setQ] = useQueryState(route);
  const { values: q, legacyList } = cleanQuery(raw);
  const project = q.project ?? "";
  const hasListFilter = LIST_KEYS.some((k) => !!q[k]);
  const view: View = (VIEWS as readonly string[]).includes(q.view ?? "") ? (q.view as View) : hasListFilter || legacyList ? "vulnerabilities" : "overview";

  const overview = useApi<Overview>(`/security${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  useLiveRefresh(overview.reload);
  const attentionParams = new URLSearchParams({ view: "affecting", days: "30", limit: "3" });
  if (project) attentionParams.set("project", project);
  const attention = useApi<Feed>(`/advisories?${attentionParams}`);
  useLiveRefresh(attention.reload);

  const [publishOpen, setPublishOpen] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [feedSignal, setFeedSignal] = useState(0);

  const t = overview.data?.tiles;
  const tabHref = (id: View) => secHref({ ...q, view: id === "overview" ? (hasListFilter ? "overview" : undefined) : id });
  const affectingCount = attention.data?.counts.affecting ?? 0;
  const tabs = (
    <Tabs
      label="Security views"
      value={view}
      items={[
        { id: "overview", label: "Overview", href: tabHref("overview") },
        { id: "vulnerabilities", label: "Vulnerabilities", href: tabHref("vulnerabilities"), count: t?.open ?? undefined, countTone: t?.critical ? "danger" : "neutral" },
        { id: "advisories", label: "Advisories", href: tabHref("advisories"), count: affectingCount || undefined, countTone: "danger" },
        { id: "repositories", label: "Repositories", href: tabHref("repositories") },
      ]}
    />
  );

  const projectId = "sc-project";
  const projectSelect = (
    <div className="sc-inline-field">
      <label htmlFor={projectId} className="sc-inline-label">
        Project
      </label>
      <ProjectPicker
        id={projectId}
        value={project}
        onChange={(slug) => setQ({ project: slug || undefined, repository: undefined }, { push: true })}
        scopes={scopes}
        includeSpaces={false}
        noneLabel="All projects"
      />
    </div>
  );

  // On phones PageHeader folds `actions` into "More actions"; the project choice scopes everything, so it stays in view.
  const phone = useMediaQuery("(max-width: 860px)");
  const lastCheck = overview.data?.last_check;
  const lastRefresh = attention.data?.last_refresh;

  return (
    <Page width="wide">
      <PageHeader
        title="Security"
        nav="security"
        description="Known vulnerabilities in your projects' dependencies and code, and new critical advisories that may affect you."
        info={{
          label: "About these sources",
          content: (
            <>
              <p>
                Your projects' dependencies are matched against OSV.dev every day. Vulnerabilities in your code are reported by AI agents and people. New critical
                advisories come from NVD, GitHub advisories and CISA's Known Exploited Vulnerabilities catalogue (shown here as "Actively exploited"), checked every 6
                hours.
              </p>
              <p>Critical and actively exploited ones are announced to each project's Contributors and Project admins.</p>
              {(lastCheck || lastRefresh) && (
                <p className="sc-muted">
                  {lastCheck ? `Dependencies re-checked ${day(lastCheck)}.` : ""} {lastRefresh ? `Advisories updated ${day(lastRefresh)}.` : ""}
                </p>
              )}
            </>
          ),
        }}
        actions={phone ? undefined : projectSelect}
        primary={
          isAdmin ? (
            <Button variant="primary" icon="alert" onClick={() => setPublishOpen(true)}>
              Publish an advisory
            </Button>
          ) : undefined
        }
        tabs={tabs}
      />

      {phone && <div className="sc-phone-project">{projectSelect}</div>}
      {view === "overview" && <OverviewTab overview={overview} attention={attention} project={project} scopes={scopes} isAdmin={isAdmin} />}
      {view === "vulnerabilities" && <VulnerabilitiesTab q={q} setQ={setQ} project={project} coverage={overview.data?.coverage ?? []} />}
      {view === "advisories" && (
        <AdvisoriesTab
          q={q}
          setQ={setQ}
          project={project}
          isAdmin={isAdmin}
          defaultFeed={attention.data ? (attention.data.counts.affecting > 0 ? "affecting" : "major") : attention.error ? "major" : null}
          highlight={highlight}
          signal={feedSignal}
        />
      )}
      {view === "repositories" && <RepositoriesTab overview={overview} project={project} />}

      {isAdmin && (
        <PublishAdvisoryDialog
          open={publishOpen}
          onClose={() => setPublishOpen(false)}
          projects={scopes.filter((s) => s.kind === "project")}
          onPublished={(id) => {
            setPublishOpen(false);
            setHighlight(id);
            setFeedSignal((n) => n + 1);
            attention.reload();
            setQ({ view: "advisories", feed: project ? undefined : "all" }, { push: true });
          }}
        />
      )}
    </Page>
  );
}
SecurityPage.keepMountedOnQuery = true;

type ApiResult<T> = { data: T | null; error: unknown; loading: boolean; reload: () => void };

// ---- Overview tab -------------------------------------------------------------------------------------------------

function OverviewTab({
  overview,
  attention,
  project,
  scopes,
  isAdmin,
}: {
  overview: ApiResult<Overview>;
  attention: ApiResult<Feed>;
  project: string;
  scopes: ScopeInfo[];
  isAdmin: boolean;
}) {
  const cardMode = useMediaQuery("(max-width: 760px)");
  const urgentParams = new URLSearchParams({ status: "open", severity: "critical,high", limit: "5" });
  if (project) urgentParams.set("project", project);
  const urgent = useApi<VulnPage>(`/vulnerabilities?${urgentParams}`);
  useLiveRefresh(urgent.reload);
  const list = (extra: Record<string, string>) => secHref({ project: project || undefined, view: "vulnerabilities", ...extra });

  return (
    <div className="sc-stack" role="region" aria-label="Overview">
      <AsyncBlock
        result={overview}
        label="Loading the security overview"
        errorTitle="Couldn't load the security overview"
        skeleton={
          <div className="sc-stack">
            <SkeletonRows count={3} />
            <SkeletonTiles count={5} />
            <div className="sc-grid-2">
              <Skeleton height={240} />
              <Skeleton height={240} />
            </div>
          </div>
        }
      >
        {(data) => {
          const t = data.tiles;
          const nothingVisible = !data.by_project.length && !t.fixed_30d && !data.counts_only.length;
          const neverScanned = nothingVisible && !data.coverage.some((c) => c.deps_scanned_at || c.reviewed_at) && !data.reviews.length;
          const uncovered = data.coverage.filter((c) => !c.deps_scanned_at).length;
          const affecting = attention.data?.advisories ?? [];
          const urgentRows = urgent.data?.vulnerabilities ?? [];
          const showAttention = affecting.length > 0 || urgentRows.length > 0;
          return (
            <div className="sc-stack">
              {showAttention ? (
                <Section
                  title="Needs attention"
                  description="Advisories that may affect your projects, and the most urgent open vulnerabilities (actively exploited first)."
                  actions={
                    <Button size="sm" variant="ghost" iconEnd="chevron-right" href={list({})}>
                      View all vulnerabilities
                    </Button>
                  }
                >
                  <div className="sc-stack-sm">
                    {affecting.length > 0 && (
                      <ul className="sc-advisory-list" aria-label="Advisories affecting your projects">
                        {affecting.map((a) => (
                          <AdvisoryItem key={a.id} a={a} isAdmin={isAdmin} onChange={attention.reload} compactAffects />
                        ))}
                        {(attention.data?.counts.affecting ?? 0) > affecting.length && (
                          <li className="sc-more-link">
                            <a href={secHref({ project: project || undefined, view: "advisories", feed: project ? undefined : "affecting" })}>
                              See all {attention.data!.counts.affecting} advisories affecting your projects
                            </a>
                          </li>
                        )}
                      </ul>
                    )}
                    {urgentRows.length > 0 && (
                      <DataTable
                        caption="Most urgent open vulnerabilities"
                        columns={vulnColumns({ compact: true })}
                        rows={urgentRows}
                        getRowId={(v) => v.id}
                        // Kit bug: compact density pins td height in card mode, so cells overlap on phones.
                        density={cardMode ? undefined : "compact"}
                        empty={null}
                      />
                    )}
                  </div>
                </Section>
              ) : (
                !nothingVisible &&
                urgent.data &&
                attention.data && (
                  <Callout tone="success" icon="check-circle" title="Nothing urgent">
                    No advisories affect your projects in the last 30 days, and there are no open critical or high vulnerabilities.
                  </Callout>
                )
              )}

              {neverScanned && (
                <div className="sc-empty">
                  <EmptyState
                    icon="shield"
                    title={`No vulnerabilities${project ? " in this project" : ""} yet`}
                    description="Nothing has been scanned yet. Scan a repository's dependencies and review its code with Claude, or upload lockfiles from CI on every merge."
                    primary={
                      <Button variant="secondary" icon="upload" href={secHref({ project: project || undefined, view: "repositories" })}>
                        Scan a repository
                      </Button>
                    }
                  />
                  <RunWithClaude command={CLAUDE_FULL} variants={SCAN_VARIANTS} description="Open the repository in Claude Code and run:" />
                </div>
              )}

              {/* Until something is scanned, tiles of 0 and empty charts are noise (rule 9): lead with the empty state. */}
              {!neverScanned && (
              <Section title="In your dependencies and code">
                {/* Critical and High (short labels) sit 2-across on phones; the longer labels take the full row. */}
                <TileGrid phoneFullFrom={3}>
                  <StatTile
                    label="Critical"
                    value={t.critical ?? 0}
                    icon="alert"
                    tone={t.critical ? "danger" : undefined}
                    note={t.oldest_critical_days != null ? `Oldest has been open ${plural(t.oldest_critical_days, "day")}` : "None open"}
                    href={list({ severity: "critical" })}
                  />
                  <StatTile label="High" value={t.high ?? 0} icon="shield" note={`${num(t.medium ?? 0)} medium · ${num(t.low ?? 0)} low`} href={list({ severity: "high" })} />
                  <StatTile
                    label="Actively exploited"
                    value={t.kev ?? 0}
                    icon="bolt"
                    tone={t.kev ? "danger" : undefined}
                    note="Known to be used in real attacks"
                    info={<p>Matched against CISA's Known Exploited Vulnerabilities catalogue, which lists {num(data.kev_catalog_size)} known vulnerabilities.</p>}
                    href={list({ kev: "true" })}
                  />
                  <StatTile label="Fix available" value={t.fixable ?? 0} icon="arrow" note={`of ${num(t.open ?? 0)} open`} href={list({ fixable: "true" })} />
                  <StatTile
                    label="Fixed in the last 30 days"
                    value={t.fixed_30d ?? 0}
                    icon="check-circle"
                    note={t.median_fix_days != null ? `Typical fix time ${plural(t.median_fix_days, "day")} (critical and high)` : `${num(t.new_30d ?? 0)} new`}
                    trend={data.trend.map((d) => d.critical + d.high)}
                    href={list({ status: "resolved" })}
                  />
                </TileGrid>
              </Section>
              )}

              {!neverScanned && nothingVisible && (
                <EmptyState variant="positive" icon="check-circle" title={`No open vulnerabilities${project ? " in this project" : ""}`} description="Every scanned repository is clear." />
              )}

              {data.counts_only.length > 0 && <CountsOnly rows={data.counts_only} scopes={scopes} />}

              {!neverScanned && (
              <div className="sc-grid-2">
                <ChartCard
                  title="Open vulnerabilities"
                  subtitle="Each day, last 90 days"
                  summary={trendSummary(data.trend)}
                  empty={<p className="sc-muted">No open vulnerabilities in the last 90 days.</p>}
                  table={{ columns: ["Day", "Critical", "High", "Medium and low"], rows: data.trend.map((d) => [d.day, d.critical, d.high, d.other]) }}
                >
                  <LineChart
                    data={data.trend}
                    xLabel={(d) => shortDay(String(d.day))}
                    series={[
                      { key: "critical", label: "Critical", color: "var(--sev-critical)" },
                      { key: "high", label: "High", color: "var(--sev-high)" },
                      { key: "other", label: "Medium and low", color: "var(--sev-medium)" },
                    ]}
                  />
                </ChartCard>
                <ChartCard
                  title="Open by repository"
                  subtitle="Most urgent first"
                  table={{
                    columns: ["Project", "Repository", "Critical", "High", "Medium", "Low", "Actively exploited"],
                    rows: data.by_project.map((r) => [r.name, r.repository || "Whole project", r.critical, r.high, r.medium, r.low, r.kev]),
                  }}
                >
                  {data.by_project.length ? (
                    <>
                      <SeverityBars
                        rows={data.by_project.slice(0, 10).map((r) => ({
                          label: `${r.name} · ${r.repository || "whole project"}`,
                          link: secHref({ project: r.project, view: "vulnerabilities", repository: r.repository || undefined }),
                          values: { critical: r.critical, high: r.high, medium: r.medium, low: r.low },
                          kev: r.kev,
                        }))}
                      />
                      {data.by_project.length > 10 && (
                        <p className="sc-muted sc-small">
                          Showing 10 of {data.by_project.length} · <a href={list({})}>See all</a> (or switch to Table)
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="sc-muted">Nothing open.</p>
                  )}
                </ChartCard>
              </div>
              )}

              {neverScanned ? (
                <CoverageSummary data={data} uncovered={uncovered} project={project} />
              ) : (
                <div className="sc-grid-2">
                  <Packages rows={data.top_packages} project={project} />
                  <CoverageSummary data={data} uncovered={uncovered} project={project} />
                </div>
              )}
            </div>
          );
        }}
      </AsyncBlock>
      {project && <DependencyExports project={project} />}
    </div>
  );
}

function trendSummary(trend: Overview["trend"]): string | undefined {
  const last = trend[trend.length - 1];
  if (!last) return undefined;
  return `Today: ${last.critical} critical, ${last.high} high, ${last.other} medium and low open.`;
}

function CountsOnly({ rows, scopes }: { rows: Counts[]; scopes: ScopeInfo[] }) {
  const name = (slug: string) => scopes.find((s) => s.slug === slug)?.name ?? slug;
  return (
    <section className="sc-card" aria-labelledby="sc-counts-only">
      <div className="sc-card-head">
        <h3 id="sc-counts-only" className="sc-card-title">
          <I name="lock" size={16} /> Projects where you see counts only
        </h3>
        <InfoTip label="Why only counts?">Only people with Security in a project see the details of its vulnerabilities. Ask one of its Project admins if you need them.</InfoTip>
      </div>
      <div className="table-wrap">
        <table className="table sc-counts-table">
          <caption className="sr-only">Open vulnerabilities in projects where you see counts only</caption>
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col" className="num">
                Critical
              </th>
              <th scope="col" className="num">
                High
              </th>
              <th scope="col" className="num">
                Other
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.project}>
                <td>
                  <span className="sc-lock-name">
                    <I name="lock" size={14} label="Details for people with Security in this project" />
                    {name(c.project)}
                  </span>
                </td>
                <td className="num">{c.critical}</td>
                <td className="num">{c.high}</td>
                <td className="num">{c.medium + c.low}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Packages({ rows, project }: { rows: Overview["top_packages"]; project: string }) {
  return (
    <section className="sc-card" aria-labelledby="sc-packages">
      <div className="sc-card-head">
        <h3 id="sc-packages" className="sc-card-title">
          Most affected packages
        </h3>
      </div>
      {!rows.length ? (
        <p className="sc-muted">Nothing open.</p>
      ) : (
        <RowList label="Most affected packages" density="compact">
          {rows.map((p) => (
            <ListRow
              key={`${p.ecosystem}/${p.package}`}
              leading={<SeverityBadge severity={WORST[p.worst] ?? "unknown"} />}
              title={<code>{p.package}</code>}
              href={secHref({ project: project || undefined, view: "vulnerabilities", q: p.package })}
              badges={
                p.fixable ? (
                  <Badge tone="success" icon="check">
                    Fix available
                  </Badge>
                ) : undefined
              }
              meta={<MetaLine items={[p.ecosystem, `${p.open} open`, `in ${plural(p.repositories, "repository", "repositories")}`]} />}
            />
          ))}
        </RowList>
      )}
    </section>
  );
}

function CoverageSummary({ data, uncovered, project }: { data: Overview; uncovered: number; project: string }) {
  const total = data.coverage.length;
  return (
    <section className="sc-card" aria-labelledby="sc-coverage-summary">
      <div className="sc-card-head">
        <h3 id="sc-coverage-summary" className="sc-card-title">
          Repositories
        </h3>
        <Button size="sm" variant="ghost" iconEnd="chevron-right" href={secHref({ project: project || undefined, view: "repositories" })}>
          Open repositories
        </Button>
      </div>
      <p>
        {uncovered
          ? `${uncovered} of ${plural(total, "repository", "repositories")} ${uncovered === 1 ? "has" : "have"} never been scanned.`
          : total
            ? "Every repository has been scanned."
            : "No repositories yet."}
      </p>
      <p className="sc-muted sc-small">{data.last_check ? <>Daily re-check <RelativeTime date={data.last_check} /></> : "Daily re-check pending"}</p>
    </section>
  );
}

/** Horizontal stacked bars by severity: 2px surface gaps, rounded data-end, labels and counts outside the marks, hover detail. */
function SeverityBars({ rows }: { rows: { label: string; link: string; values: Record<"critical" | "high" | "medium" | "low", number>; kev: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const keys = ["critical", "high", "medium", "low"] as const;
  const max = Math.max(1, ...rows.map((r) => keys.reduce((s, k) => s + r.values[k], 0)));
  const barH = 12;
  return (
    <div className="sc-bars" ref={ref}>
      <div className="legend">
        {keys.map((k) => (
          <span key={k} className="legend-item">
            <span className="legend-swatch" style={{ background: SEVERITY_COLOR[k] }} />
            {SEVERITY_TEXT[k]}
          </span>
        ))}
      </div>
      <ul className="sc-bars-list">
        {rows.map((r, i) => {
          const total = keys.reduce((s, k) => s + r.values[k], 0);
          const track = Math.max(0, width - 56);
          let x = 0;
          const parts = keys.filter((k) => r.values[k] > 0);
          const spoken = keys.map((k) => `${r.values[k]} ${SEVERITY_TEXT[k].toLowerCase()}`).join(", ");
          return (
            <li key={r.label}>
              <a
                className="sc-bar-row"
                data-active={hover === i || undefined}
                href={r.link}
                aria-label={`${r.label}: ${total} open (${spoken}${r.kev ? `, ${r.kev} actively exploited` : ""})`}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              >
                <span className="sc-bar-label">{r.label}</span>
                <span className="sc-bar-track" aria-hidden="true">
                  <svg width={track} height={barH}>
                    {parts.map((k, j) => {
                      const w = (r.values[k] / max) * track - (j > 0 ? 2 : 0);
                      const x0 = x + (j > 0 ? 2 : 0);
                      x += (r.values[k] / max) * track;
                      const last = j === parts.length - 1;
                      const rr = Math.min(4, w / 2, barH / 2);
                      const d = last
                        ? `M${x0},0H${x0 + w - rr}Q${x0 + w},0 ${x0 + w},${rr}V${barH - rr}Q${x0 + w},${barH} ${x0 + w - rr},${barH}H${x0}Z`
                        : `M${x0},0H${x0 + w}V${barH}H${x0}Z`;
                      return w > 0 ? <path key={k} d={d} fill={SEVERITY_COLOR[k]} /> : null;
                    })}
                  </svg>
                  <span className="sc-bar-total">{total}</span>
                </span>
                <span className="sc-bar-counts" aria-hidden="true">
                  {parts.map((k) => `${r.values[k]} ${SEVERITY_TEXT[k].toLowerCase()}`).join(" · ")}
                  {r.kev ? ` · ${r.kev} actively exploited` : ""}
                </span>
                {hover === i && (
                  <span className="sc-bar-tip" aria-hidden="true">
                    <strong>{r.label}</strong>
                    {keys.map((k) => (
                      <span key={k} className="sc-bar-tip-row">
                        <span className="legend-swatch" style={{ background: SEVERITY_COLOR[k] }} />
                        {SEVERITY_TEXT[k]}
                        <span className="sc-bar-tip-val">{r.values[k]}</span>
                      </span>
                    ))}
                  </span>
                )}
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- Vulnerabilities tab ------------------------------------------------------------------------------------------

function vulnFix(v: Vuln): ReactNode {
  if (v.package) return v.fixed_versions.length ? <span>Upgrade to <code>{v.fixed_versions[0]}</code></span> : <span className="sc-muted">No fix yet</span>;
  if (v.location) return <code className="sc-wrap">{v.location}</code>;
  return <span className="sc-muted">—</span>;
}

function vulnColumns({ compact = false }: { compact?: boolean } = {}): Column<Vuln>[] {
  const cols: Column<Vuln>[] = [
    { key: "severity", header: "Severity", cell: (v) => <SeverityBadge severity={v.severity} score={v.cvss_score} />, sortable: !compact, width: "9.5rem" },
    {
      key: "title",
      header: "Vulnerability",
      primary: true,
      cell: (v) => {
        const cve = v.aliases.find((a) => a.startsWith("CVE-") && a !== v.advisory_id);
        const id = v.advisory_id ?? (v.source === "reported" ? "Reported" : "");
        return (
          <div className="sc-vuln-title">
            <a href={href(`/security/${v.id}`)}>{v.title}</a>
            {(v.kev || id || cve) && (
              <span className="sc-vuln-ids">
                {v.kev && <KevBadge due={v.kev_due} />}
                {id && <span>{id}</span>}
                {cve && <span>{cve}</span>}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: "package",
      header: "Package and fix",
      mobileLabel: "Package",
      sortable: !compact,
      cell: (v) => (
        <span className="sc-pkg">
          {v.package ? (
            <code className="sc-wrap">
              {v.package} {v.version}
            </code>
          ) : null}
          <span className={v.package ? "sc-small" : undefined}>{vulnFix(v)}</span>
        </span>
      ),
    },
    {
      key: "where",
      header: "Where",
      cell: (v) => (
        <span className="sc-where">
          <span>{v.project_name}</span>
          <span className="sc-muted sc-small">{v.repository || "Whole project"}</span>
        </span>
      ),
    },
    { key: "found", header: "Found", sortable: !compact, cell: (v) => <RelativeTime date={v.first_seen} /> },
    { key: "status", header: "Status", sortable: !compact, cell: (v) => <StatusBadge domain="vulnerability" value={v.status} /> },
  ];
  return compact ? cols.filter((c) => c.key !== "status") : cols;
}

function sortRows(rows: Vuln[], sort: { key: string; dir: "asc" | "desc" } | undefined): Vuln[] {
  if (!sort) return rows;
  const val = (v: Vuln): string | number => {
    switch (sort.key) {
      case "severity":
        return SEVERITY_RANK[v.severity] * 100 - (Number(v.cvss_score) || 0);
      case "package":
        return (v.package ?? v.location ?? "").toLowerCase();
      case "found":
        return v.first_seen;
      case "status":
        return statusText(v.status);
      default:
        return "";
    }
  };
  const out = [...rows].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return sort.dir === "desc" ? out.reverse() : out;
}

const PAGE_SIZE = 100;
/** The list filters a saved view keeps, the project included (server: core/views.ts). */
const SECURITY_VIEW_KEYS = ["project", "severity", "status", "kev", "fixable", "repository", "q", "sort"] as const;

function VulnerabilitiesTab({
  q,
  setQ: setQueryRaw,
  project,
  coverage,
}: {
  q: Record<string, string>;
  setQ: (patch: Record<string, string | undefined>, opts?: { push?: boolean }) => void;
  project: string;
  coverage: Coverage[];
}) {
  const toast = useToast();
  // Pin the tab: on a legacy link (no ?view=) the tab is inferred from the filters, so clearing them would jump to Overview.
  const setQ = (patch: Record<string, string | undefined>, opts?: { push?: boolean }) => setQueryRaw({ ...patch, view: "vulnerabilities" }, opts);
  const sevs = (q.severity ?? "").split(",").filter(Boolean) as Severity[];
  const status = ["open", "resolved", "all"].includes(q.status ?? "") ? q.status! : "open";
  const kev = q.kev === "true";
  const fixable = q.fixable === "true";
  const repository = q.repository ?? "";
  const text = q.q ?? "";
  const params = new URLSearchParams({ status, limit: String(PAGE_SIZE) });
  if (project) params.set("project", project);
  if (repository) params.set("repository", repository);
  if (sevs.length) params.set("severity", sevs.join(","));
  if (kev) params.set("kev", "true");
  if (fixable) params.set("fixable", "true");
  if (text) params.set("q", text);
  const key = params.toString();
  const list = useApi<VulnPage>(`/vulnerabilities?${key}`);
  useLiveRefresh(list.reload);
  const [extra, setExtra] = useState<{ key: string; rows: Vuln[] }>({ key, rows: [] });
  const [moreBusy, setMoreBusy] = useState(false);
  const more = extra.key === key ? extra.rows : [];

  const listUrl = secHref({ ...q, view: "vulnerabilities" });
  useEffect(() => rememberList(listUrl), [listUrl]);

  async function loadMore() {
    setMoreBusy(true);
    try {
      const r = await api<VulnPage>(`/vulnerabilities?${key}&offset=${PAGE_SIZE + more.length}`);
      setExtra({ key, rows: [...more, ...r.vulnerabilities] });
    } catch (e) {
      toast.error(e, { title: "Couldn't load more vulnerabilities" });
    } finally {
      setMoreBusy(false);
    }
  }

  const sort = useMemo(() => {
    const [k, d] = (q.sort ?? "").split(":");
    return k ? { key: k, dir: (d === "desc" ? "desc" : "asc") as "asc" | "desc" } : undefined;
  }, [q.sort]);

  const repoNames = [...new Set(coverage.filter((c) => !project || c.project === project).map((c) => c.repository).filter(Boolean))].sort();
  if (repository && !repoNames.includes(repository)) repoNames.unshift(repository);

  const active: { id: string; label: string; onRemove(): void }[] = [
    ...sevs.map((s) => ({ id: `sev-${s}`, label: `Severity: ${SEVERITY_TEXT[s] ?? s}`, onRemove: () => setQ({ severity: sevs.filter((x) => x !== s).join(",") || undefined }) })),
    ...(status !== "open" ? [{ id: "status", label: `Status: ${status === "resolved" ? "Resolved" : "All"}`, onRemove: () => setQ({ status: undefined }) }] : []),
    ...(kev ? [{ id: "kev", label: "Actively exploited", onRemove: () => setQ({ kev: undefined }) }] : []),
    ...(fixable ? [{ id: "fixable", label: "Fix available", onRemove: () => setQ({ fixable: undefined }) }] : []),
    ...(repository ? [{ id: "repository", label: `Repository: ${repository}`, onRemove: () => setQ({ repository: undefined }) }] : []),
    ...(text ? [{ id: "q", label: `Search: ${text}`, onRemove: () => setQ({ q: undefined }) }] : []),
  ];
  const clearAll = () => setQ({ severity: undefined, status: undefined, kev: undefined, fixable: undefined, repository: undefined, q: undefined });

  const total = list.data?.total;
  const shownRows = list.data ? [...list.data.vulnerabilities, ...more] : [];

  return (
    <div className="sc-stack" role="region" aria-label="Vulnerabilities" id="list">
      <FilterBar
        search={{ value: text, onChange: (v) => setQ({ q: v.trim() || undefined }), label: "Search vulnerabilities", placeholder: "Package, CVE or GHSA" }}
        segments={
          <SegmentedControl
            label="Status"
            labelVisible
            size="sm"
            value={status as "open" | "resolved" | "all"}
            onChange={(v) => setQ({ status: v === "open" ? undefined : v })}
            options={[
              { value: "open", label: "Open" },
              { value: "resolved", label: "Resolved" },
              { value: "all", label: "All" },
            ]}
          />
        }
        filters={
          <>
            <div className="sc-filter-group">
              <span className="sc-inline-label" aria-hidden="true">
                Severity
              </span>
              <ChipGroup
              label="Severity"
              multiple
              value={sevs}
              onChange={(v: Severity[]) => setQ({ severity: WORST.filter((s) => v.includes(s)).join(",") || undefined })}
              options={WORST.map((s) => ({ value: s, label: SEVERITY_TEXT[s], dotColor: SEVERITY_COLOR[s] }))}
              />
            </div>
            <div className="sc-filter-group">
              <span className="sc-inline-label" aria-hidden="true">
                Only show
              </span>
              <ChipGroup
              label="Only show"
              multiple
              value={[...(kev ? ["kev"] : []), ...(fixable ? ["fixable"] : [])]}
              onChange={(v: string[]) => setQ({ kev: v.includes("kev") ? "true" : undefined, fixable: v.includes("fixable") ? "true" : undefined })}
              options={[
                { value: "kev", label: "Actively exploited", hint: "Known to be used in real attacks" },
                { value: "fixable", label: "Fix available", hint: "A fixed version has been published" },
              ]}
              />
            </div>
            <div className="sc-inline-field">
              <label htmlFor="sc-repo" className="sc-inline-label">
                Repository
              </label>
              <Select
                id="sc-repo"
                value={repository}
                onChange={(e) => setQ({ repository: e.target.value || undefined })}
                options={[{ value: "", label: "All repositories" }, ...repoNames.map((r) => ({ value: r, label: r }))]}
              />
            </div>
          </>
        }
        views={
          <SavedViews
            area="security"
            current={pickFilters(new URLSearchParams(q), SECURITY_VIEW_KEYS)}
            apply={(v) => setQ(Object.fromEntries(SECURITY_VIEW_KEYS.map((k) => [k, v[k]])))}
            summary={[...(project ? [`Project: ${project}`] : []), ...(status === "open" ? ["Status: Open"] : []), ...active.map((a) => a.label)]}
          />
        }
        active={active}
        onClearAll={clearAll}
        result={
          total
            ? total > shownRows.length
              ? `${plural(total, "vulnerability", "vulnerabilities")}, first ${num(shownRows.length)} shown`
              : plural(total, "vulnerability", "vulnerabilities")
            : undefined
        }
      />
      <AsyncBlock
        result={list}
        label="Loading vulnerabilities"
        errorTitle="Couldn't load vulnerabilities"
        skeleton={<SkeletonRows count={6} density="compact" />}
        isEmpty={(d) => !d.vulnerabilities.length}
        empty={
          active.length ? (
            <EmptyState
              variant="search"
              title="No vulnerabilities match these filters"
              description="Try another severity or status, or clear the filters."
              primary={<Button onClick={clearAll}>Clear filters</Button>}
            />
          ) : (
            <EmptyState variant="positive" icon="check-circle" title={`No open vulnerabilities${project ? " in this project" : ""}`} description="New ones appear here after a scan or a report." />
          )
        }
      >
        {() => (
          <>
            <DataTable
              caption="Vulnerabilities"
              columns={vulnColumns()}
              rows={sortRows(shownRows, sort)}
              getRowId={(v) => v.id}
              sort={sort}
              onSortChange={(s) => setQ({ sort: `${s.key}:${s.dir}` })}
              empty={null}
            />
            <LoadMore shown={shownRows.length} total={total} noun={["vulnerability", "vulnerabilities"]} onMore={loadMore} busy={moreBusy} />
          </>
        )}
      </AsyncBlock>
    </div>
  );
}

// ---- Advisories ---------------------------------------------------------------------------------------------------

type AdvisoryResponse = "investigating" | "affected" | "not_affected" | "patched";
const RESPONSES: AdvisoryResponse[] = ["investigating", "affected", "not_affected", "patched"];

interface Advisory {
  id: string;
  name: string | null;
  title: string;
  summary: string;
  severity: Severity;
  cvss_score: number | null;
  kev: boolean;
  kev_due: string | null;
  cve_ids: string[];
  ghsa_ids: string[];
  technologies: { id: string; label: string }[];
  packages: { ecosystem: string; name: string; fixed?: string | null }[];
  sources: string[];
  published_at: string;
  refs: { url: string; type?: string }[];
  manual: boolean;
  affects: { project: string; name: string; because: string[]; can_respond: boolean; response: { status: AdvisoryResponse; note: string | null; updated_at: string } | null }[];
}

const SOURCE_TEXT: Record<string, string> = { nvd: "NVD", ghsa: "GitHub", kev: "CISA (actively exploited)", manual: "Team advisory" };

const FEED_TEXT: Record<FeedView, { label: string; short: string; help: string }> = {
  affecting: { label: "Affecting our projects", short: "Affecting", help: "Matched to a technology or package one of your projects uses." },
  major: { label: "Major", short: "Major", help: "Affecting your projects, actively exploited, or in widely used technologies like PHP, Node.js, OpenSSL or nginx." },
  all: { label: "All critical", short: "All", help: "Every critical vulnerability published in the period." },
};

function AdvisoriesTab({
  q,
  setQ,
  project,
  isAdmin,
  defaultFeed,
  highlight,
  signal,
}: {
  q: Record<string, string>;
  setQ: (patch: Record<string, string | undefined>, opts?: { push?: boolean }) => void;
  project: string;
  isAdmin: boolean;
  defaultFeed: FeedView | null;
  highlight: string | null;
  signal: number;
}) {
  const shortLabels = useMediaQuery("(max-width: 640px)");
  const explicit = (FEEDS as readonly string[]).includes(q.feed ?? "") ? (q.feed as FeedView) : null;
  const feed: FeedView | null = project ? "affecting" : (explicit ?? defaultFeed);
  const days = ["7", "30", "90"].includes(q.days ?? "") ? q.days! : "30";
  const [limit, setLimit] = useState(12);
  useEffect(() => setLimit(12), [feed, days, project]);
  const params = new URLSearchParams({ days, limit: String(limit) });
  if (project) params.set("project", project);
  else if (feed) params.set("view", feed);
  const res = useApi<Feed>(feed ? `/advisories?${params}` : null);
  useLiveRefresh(res.reload);
  const { reload } = res;
  useEffect(() => {
    if (signal) reload();
  }, [signal, reload]);
  const [moreBusy, setMoreBusy] = useState(false);
  useEffect(() => {
    if (!res.loading) setMoreBusy(false);
  }, [res.loading]);

  const counts = res.data?.counts;
  const lastRefresh = res.data?.last_refresh;
  const emptyText =
    feed === "affecting"
      ? project
        ? "Nothing in this period touches this project's technologies or packages."
        : "Nothing in this period touches your projects' technologies or packages."
      : feed === "major"
        ? "No major critical vulnerabilities in this period. See All critical for everything."
        : "No critical vulnerabilities in this period.";

  return (
    <div className="sc-stack" role="region" aria-label="Advisories">
      <Section
        title="Latest critical vulnerabilities"
        description={
          <span className="sc-desc-row">
            <span>
              New critical vulnerabilities published worldwide, checked every 6 hours, and the projects they may affect.
              {lastRefresh ? (
                <>
                  {" "}
                  Last checked <RelativeTime date={lastRefresh} />.
                </>
              ) : null}
            </span>
            <InfoTip label="About these sources">
              <p>New critical CVEs from NVD, GitHub advisories and CISA's known-exploited list, checked every 6 hours.</p>
              <p>
                Major ones (core technologies like PHP, Node.js, OpenSSL or nginx, and anything actively exploited) always show; each is matched to the projects that use the
                technology or package.
              </p>
            </InfoTip>
          </span>
        }
      >
        <div className="sc-feed-controls">
          {!project && (
            <div className="sc-feed-view">
              <SegmentedControl
                label="Which advisories"
                size="sm"
                value={feed ?? "major"}
                onChange={(v) => setQ({ feed: v })}
                options={FEEDS.map((f) => ({ value: f, label: shortLabels ? FEED_TEXT[f].short : FEED_TEXT[f].label, count: counts?.[f] }))}
              />
              {feed && <p className="sc-muted sc-small">{FEED_TEXT[feed].help}</p>}
            </div>
          )}
          {project && <p className="sc-muted sc-small">Showing advisories that may affect this project.</p>}
          <div className="sc-inline-field">
            <label htmlFor="sc-days" className="sc-inline-label">
              Period
            </label>
            <Select
              id="sc-days"
              value={days}
              onChange={(e) => setQ({ days: e.target.value === "30" ? undefined : e.target.value })}
              options={[
                { value: "7", label: "Last 7 days" },
                { value: "30", label: "Last 30 days" },
                { value: "90", label: "Last 90 days" },
              ]}
            />
          </div>
        </div>

        {!feed ? (
          <div aria-busy="true">
            <span className="sr-only" role="status">
              Loading advisories
            </span>
            <SkeletonRows count={5} />
          </div>
        ) : (
          <AsyncBlock
            result={res}
            label="Loading advisories"
            errorTitle="Couldn't load advisories"
            skeleton={<SkeletonRows count={5} />}
            isEmpty={(d) => !d.advisories.length}
            empty={
              <EmptyState
                variant="compact"
                icon="shield"
                title={emptyText}
                description={
                  feed === "affecting" ? (
                    <>
                      Thaliyola reads each repository's languages from GitHub or GitLab every day. You can also list what a project runs on in its settings, under
                      General › Technologies
                      {project ? (
                        <>
                          {" "}
                          (<a href={href(`/project/${project}/settings`)}>open the settings</a>)
                        </>
                      ) : null}
                      .
                    </>
                  ) : undefined
                }
                secondary={
                  feed === "major" && !project ? (
                    <Button size="sm" onClick={() => setQ({ feed: "all" })}>
                      Show all critical
                    </Button>
                  ) : undefined
                }
              />
            }
          >
            {(d) => (
              <>
                <ul className="sc-advisory-list" aria-label="Advisories">
                  {d.advisories.map((a) => (
                    <AdvisoryItem key={a.id} a={a} isAdmin={isAdmin} onChange={reload} highlight={a.id === highlight} />
                  ))}
                </ul>
                {d.total > d.advisories.length && (
                  <div className="sc-show-more">
                    <Button
                      size="sm"
                      loading={moreBusy}
                      loadingText="Loading more"
                      onClick={() => {
                        setMoreBusy(true);
                        setLimit((l) => l + 20);
                      }}
                    >
                      Show more ({d.total - d.advisories.length})
                    </Button>
                  </div>
                )}
              </>
            )}
          </AsyncBlock>
        )}
      </Section>
    </div>
  );
}

/** One advisory. Those that affect a project are full cards (danger bar, affected projects, Respond); others are compact rows that expand. */
function AdvisoryItem({ a, isAdmin, onChange, highlight, compactAffects }: { a: Advisory; isAdmin: boolean; onChange: () => void; highlight?: boolean; compactAffects?: boolean }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();
  const ref = useRef<HTMLLIElement>(null);
  const affecting = a.affects.length > 0;
  const detailsId = `sc-adv-${a.id}`;

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight]);

  async function hide() {
    const r = await confirm({
      title: `Hide "${a.name ?? a.title}" from everyone's feed?`,
      body: "Nobody sees it in the advisories feed any more. You can undo this straight away.",
      confirmLabel: "Hide",
      tone: "danger",
    });
    if (!r) return;
    try {
      await api(`/advisories/${a.id}/hide`, { method: "POST", body: { hidden: true } });
      onChange();
      toast.success("Advisory hidden", {
        undo: async () => {
          await api(`/advisories/${a.id}/hide`, { method: "POST", body: { hidden: false } });
          onChange();
        },
      });
    } catch (e) {
      toast.error(e, { title: "Couldn't hide the advisory" });
    }
  }

  const menu: MenuItemSpec[] = isAdmin ? [{ id: "hide", label: "Hide from everyone's feed…", icon: "eye-off", tone: "danger", onSelect: () => void hide() }] : [];
  const meta = (
    <div className="sc-adv-meta">
      {(a.severity !== "unknown" || !a.kev) && <SeverityBadge severity={a.severity} score={a.cvss_score} />}
      {a.kev && <KevBadge due={a.kev_due} />}
      {a.name && a.name !== a.title && <span className="sc-adv-name">{a.name}</span>}
      <span className="sc-muted sc-small">
        <MetaLine items={[<RelativeTime key="d" date={a.published_at} />, a.sources.map((s) => SOURCE_TEXT[s] ?? s).join(", ")]} />
      </span>
    </div>
  );

  const tags = (a.cve_ids.length > 0 || a.technologies.length > 0 || a.packages.length > 0) && (
    <ul className="sc-tags" aria-label="Identifiers, technologies and packages">
      {a.cve_ids.map((c) => (
        <li key={c}>
          <a className="sc-tag" href={`https://nvd.nist.gov/vuln/detail/${c}`} target="_blank" rel="noopener noreferrer">
            {c}
            <I name="external" size={12} />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </li>
      ))}
      {a.technologies.map((t) => (
        <li key={t.id}>
          <span className="sc-tag" data-kind="tech">
            {t.label}
          </span>
        </li>
      ))}
      {a.packages.slice(0, 6).map((p) => (
        <li key={`${p.ecosystem}/${p.name}`}>
          <span className="sc-tag">
            <code>{p.name}</code>
            {p.fixed ? ` → ${p.fixed}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );

  const refs = a.refs.slice(0, 4);
  const details = (
    <div className="sc-adv-details" id={detailsId}>
      <Markdown text={a.summary || "_No description yet._"} />
      {refs.length > 0 && (
        <p className="sc-adv-refs">
          <span className="sc-muted">References:</span>
          {refs.map((r) => (
            <a key={r.url} href={r.url} target="_blank" rel="noopener noreferrer nofollow" title={r.type}>
              {hostOf(r.url)}
              {r.type ? <span className="sr-only"> ({r.type})</span> : null}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          ))}
        </p>
      )}
    </div>
  );

  const toggle = (
    <Button variant="ghost" size="sm" iconEnd={open ? undefined : "chevron-down"} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={open ? detailsId : undefined}>
      {open ? "Hide details" : "Details"}
    </Button>
  );

  if (!affecting) {
    return (
      <li ref={ref} className="sc-adv-row" data-highlight={highlight || undefined}>
        <div className="sc-adv-row-main">
          {meta}
          <p className="sc-adv-row-title">{a.title}</p>
          <div className="sc-adv-foot">
            {toggle}
            {menu.length > 0 && <OverflowMenu items={menu} size="sm" label={`More actions for ${a.name ?? a.title}`} />}
          </div>
        </div>
        {open && (
          <div className="sc-adv-row-body">
            {tags}
            <p className="sc-muted sc-small">No project lists this technology or depends on these packages.</p>
            {details}
          </div>
        )}
      </li>
    );
  }

  return (
    <li ref={ref} className="sc-advisory" data-highlight={highlight || undefined}>
      <div className="sc-adv-head">
        {meta}
        {menu.length > 0 && <OverflowMenu items={menu} size="sm" label={`More actions for ${a.name ?? a.title}`} />}
      </div>
      <h3 className="sc-adv-title">{a.title}</h3>
      {!compactAffects && tags}
      <ul className="sc-affects" aria-label="Affected projects">
        {a.affects.map((x) => (
          <li key={x.project} className="sc-affect">
            <div className="sc-affect-main">
              <a href={href(`/project/${x.project}`)} className="sc-affect-name">
                {x.name}
              </a>
              {x.because.length > 0 && <span className="sc-muted sc-small">because it uses {x.because.join(", ")}</span>}
            </div>
            <div className="sc-affect-status">
              {x.response ? (
                <Tooltip content={x.response.note ?? statusMeta("advisory", x.response.status).label}>
                  <span tabIndex={0} className="sc-kev">
                    <StatusBadge domain="advisory" value={x.response.status} />
                  </span>
                </Tooltip>
              ) : (
                <StatusBadge domain="advisory" value="none" />
              )}
              {x.can_respond && <RespondButton advisory={a} affect={x} onSaved={onChange} />}
            </div>
            {x.response?.note && <p className="sc-affect-note sc-muted sc-small">{x.response.note}</p>}
          </li>
        ))}
      </ul>
      <div className="sc-adv-foot">{toggle}</div>
      {open && (
        <>
          {compactAffects && tags}
          {details}
        </>
      )}
    </li>
  );
}

function RespondButton({ advisory, affect, onSaved }: { advisory: Advisory; affect: Advisory["affects"][number]; onSaved: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AdvisoryResponse>(affect.response?.status ?? "investigating");
  const [note, setNote] = useState(affect.response?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const noteId = `sc-note-${advisory.id}-${affect.project}`;

  function start() {
    setStatus(affect.response?.status ?? "investigating");
    setNote(affect.response?.note ?? "");
    setError(null);
    setOpen((o) => !o);
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/advisories/${advisory.id}/responses`, { method: "POST", body: { project: affect.project, status, note: note.trim() || undefined } });
      setOpen(false);
      toast.success(`Response saved for ${affect.name}`);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Button ref={ref} size="sm" onClick={start} aria-expanded={open} aria-haspopup="dialog">
        {affect.response ? "Update" : "Respond"}
      </Button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} label={`Response for ${affect.name}`} placement="bottom-end" sheetOnMobile className="sc-respond">
        <form onSubmit={save} className="sc-respond-form">
          <p className="sc-respond-title">How does this affect {affect.name}?</p>
          <SegmentedControl label="Response" size="sm" value={status} onChange={setStatus} options={RESPONSES.map((r) => ({ value: r, label: statusMeta("advisory", r).label }))} />
          <Field label="Note" optional>
            <TextInput id={noteId} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. runs PHP 8.4.14 (fixed)" maxLength={1000} />
          </Field>
          {error ? <ErrorState compact error={error} title="Couldn't save the response" /> : null}
          <div className="sc-dialog-actions">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy} loadingText="Saving…">
              Save
            </Button>
          </div>
        </form>
      </Popover>
    </>
  );
}

function PublishAdvisoryDialog({ open, onClose, onPublished, projects }: { open: boolean; onClose: () => void; onPublished: (id: string) => void; projects: ScopeInfo[] }) {
  const toast = useToast();
  const empty = { name: "", title: "", summary: "", cves: "", technologies: "", severity: "critical", url: "" };
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof empty, string>>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const firstProject = projects[0]?.slug;
  const techs = useApi<{ known: Record<string, string> }>(open && firstProject ? `/projects/${encodeURIComponent(firstProject)}/technologies` : null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (open) {
      setForm(empty);
      setErrors({});
      setError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cves = form.cves.split(/[\s,]+/).filter(Boolean);
    const technologies = form.technologies
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const next: typeof errors = {};
    if (!form.title.trim()) next.title = "Give the advisory a title.";
    if (!technologies.length) next.technologies = "Name at least one technology, so Thaliyola can tell which projects are affected.";
    const bad = cves.find((c) => !/^CVE-\d{4}-\d{4,}$/i.test(c));
    if (bad) next.cves = `${bad} isn't a CVE ID (for example CVE-2026-12345).`;
    if (form.url.trim() && !/^https?:\/\//i.test(form.url.trim())) next.url = "Use a full link starting with https://";
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => formRef.current && focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ id: string; notified_projects?: number }>("/advisories", {
        method: "POST",
        body: {
          name: form.name.trim() || undefined,
          title: form.title.trim(),
          summary: form.summary,
          cve_ids: cves,
          technologies,
          severity: form.severity,
          url: form.url.trim() || undefined,
        },
      });
      const n = r.notified_projects ?? 0;
      toast.success("Advisory published", { description: n ? `${plural(n, "project")} notified.` : undefined });
      onPublished(r.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const known = Object.entries(techs.data?.known ?? {});
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Publish an advisory"
      size="lg"
      dismissible={!busy}
      description="For breaking news before NVD has it, or to give several CVEs one name. Projects that use these technologies are notified, and matching NVD and GitHub entries are folded under it."
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" form="sc-publish-form" variant="primary" loading={busy} loadingText="Publishing…">
            Publish
          </Button>
        </>
      }
    >
      <form id="sc-publish-form" ref={formRef} className="sc-form" onSubmit={submit} noValidate>
        <div className="sc-form-row">
          <Field label="Name" optional hint="A short name people will recognise.">
            <TextInput value={form.name} onChange={set("name")} placeholder="e.g. PHP2Shell" maxLength={80} />
          </Field>
          <Field label="Severity">
            <Select
              value={form.severity}
              onChange={set("severity")}
              options={[
                { value: "critical", label: "Critical" },
                { value: "high", label: "High" },
              ]}
            />
          </Field>
        </div>
        <Field label="Title" error={errors.title}>
          <TextInput value={form.title} onChange={set("title")} placeholder="Unauthenticated remote code execution in core PHP" maxLength={300} />
        </Field>
        <div className="sc-form-row">
          <Field label="CVE IDs" optional hint="Separate them with commas or spaces." error={errors.cves}>
            <TextInput value={form.cves} onChange={set("cves")} placeholder="CVE-2026-109618, CVE-2026-109619" />
          </Field>
          <Field label="Affected technologies" hint="Separate them with commas." error={errors.technologies}>
            <TextInput value={form.technologies} onChange={set("technologies")} placeholder="php" list="sc-tech-list" />
          </Field>
        </div>
        {known.length > 0 && (
          <datalist id="sc-tech-list">
            {known.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </datalist>
        )}
        <Field label="What happened and what to do" optional>
          <Textarea value={form.summary} onChange={set("summary")} minRows={4} autoGrow />
        </Field>
        <Field label="Announcement link" optional error={errors.url}>
          <TextInput type="url" value={form.url} onChange={set("url")} placeholder="https://" />
        </Field>
        {error ? <ErrorState compact error={error} title="Couldn't publish the advisory" /> : null}
      </form>
    </Dialog>
  );
}

// ---- Repositories tab ---------------------------------------------------------------------------------------------

function RepositoriesTab({ overview, project }: { overview: ApiResult<Overview>; project: string }) {
  const [scan, setScan] = useState<{ repo: string; command: string } | null>(null);
  const [scanError, setScanError] = useState<{ repo: string; error: unknown } | null>(null);
  const [busyRow, setBusyRow] = useState<string | null>(null);

  async function link(c: Coverage) {
    const id = `${c.project}/${c.repository}`;
    setScanError(null);
    setBusyRow(id);
    try {
      const r = await api<{ command: string }>("/dependencies/upload-link", { method: "POST", body: { project: c.project, component: c.repository } });
      setScan({ repo: `${c.project_name} · ${c.repository}`, command: r.command });
    } catch (e) {
      setScanError({ repo: `${c.project_name} · ${c.repository}`, error: e });
    } finally {
      setBusyRow(null);
    }
  }

  return (
    <div className="sc-stack" role="region" aria-label="Repositories">
      <AsyncBlock
        result={overview}
        label="Loading repositories"
        errorTitle="Couldn't load repositories"
        skeleton={
          <div className="sc-stack">
            <SkeletonText lines={2} />
            <SkeletonRows count={4} density="compact" />
          </div>
        }
      >
        {(data) => {
          const uncovered = data.coverage.filter((c) => !c.deps_scanned_at).length;
          const cols: Column<Coverage>[] = [
            { key: "repository", header: "Repository", primary: true, cell: (c) => <strong>{c.repository || "Whole project"}</strong> },
            { key: "project", header: "Project", cell: (c) => c.project_name },
            {
              key: "deps",
              header: "Dependencies scanned",
              cell: (c) =>
                c.deps_scanned_at ? (
                  <span className="sc-where">
                    <RelativeTime date={c.deps_scanned_at} />
                    {c.deps_sha && <code className="sc-small">{sha(c.deps_sha)}</code>}
                  </span>
                ) : (
                  <Badge tone="warning" variant="outline" icon="clock">
                    Never
                  </Badge>
                ),
            },
            { key: "packages", header: "Packages", numeric: true, cell: (c) => (c.deps_count != null ? num(c.deps_count) : <span className="sc-muted">—</span>) },
            {
              key: "review",
              header: "Code reviewed",
              cell: (c) => (c.reviewed_at ? <RelativeTime date={c.reviewed_at} /> : <span className="sc-muted">No code review yet</span>),
            },
          ];
          return (
            <div className="sc-stack">
              <Section
                title="Repositories"
                description={
                  <>
                    {uncovered
                      ? `${uncovered} of ${plural(data.coverage.length, "repository", "repositories")} ${uncovered === 1 ? "has" : "have"} never been scanned. `
                      : data.coverage.length
                        ? "Every repository has been scanned. "
                        : ""}
                    {data.last_check ? (
                      <>
                        Daily re-check <RelativeTime date={data.last_check} />.
                      </>
                    ) : (
                      "Daily re-check pending."
                    )}
                  </>
                }
              >
                {scanError && (
                  <Callout tone="danger" title={`Couldn't create a scan link for ${scanError.repo}`} onDismiss={() => setScanError(null)}>
                    <ErrorState compact error={scanError.error} />
                  </Callout>
                )}
                <DataTable
                  caption="Repository scan coverage"
                  columns={cols}
                  rows={data.coverage}
                  getRowId={(c) => `${c.project}/${c.repository}`}
                  rowAction={(c) =>
                    data.can_upload && c.details ? (
                      <Button size="sm" icon="upload" loading={busyRow === `${c.project}/${c.repository}`} loadingText="Creating link" onClick={() => void link(c)}>
                        Scan
                      </Button>
                    ) : null
                  }
                  empty={
                    <EmptyState
                      variant="compact"
                      icon="git-branch"
                      title={project ? "This project has no repositories yet" : "No repositories yet"}
                      description="Add a repository in a project's settings, then scan it with Claude."
                    />
                  }
                />
                <div className="sc-scan-help">
                  <RunWithClaude
                    title="Scan with Claude"
                    command={CLAUDE_FULL}
                    variants={SCAN_VARIANTS}
                    description="Open the repository in Claude Code and run this to scan its dependencies and review its code. Dependencies only is quicker."
                  />
                  <p className="sc-muted sc-small">
                    CI can upload lockfiles on every merge. <a href={href("/connect")}>See how in Connect</a>.
                  </p>
                </div>
              </Section>
              <RecentReviews reviews={data.reviews} />
            </div>
          );
        }}
      </AsyncBlock>

      <Dialog
        open={!!scan}
        onClose={() => setScan(null)}
        title="Scan this repository"
        description={scan ? `From the root of ${scan.repo}.` : undefined}
        footer={
          <Button variant="primary" onClick={() => setScan(null)}>
            Done
          </Button>
        }
      >
        {scan && (
          <div className="sc-stack-sm">
            <CodeBlock code={scan.command} language="shell" label="One-time command" />
            <p className="sc-muted sc-small">Run this from the repository root. The link works once, for 30 minutes.</p>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function RecentReviews({ reviews }: { reviews: Review[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? reviews : reviews.slice(0, 5);
  return (
    <Section
      title="Recent scans and reviews"
      description="Scans and reviews run with Claude appear here."
      actions={
        reviews.length > 5 ? (
          <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)} aria-expanded={all}>
            {all ? "Show the latest 5" : `View all (${reviews.length})`}
          </Button>
        ) : undefined
      }
    >
      {!reviews.length ? (
        <EmptyState variant="compact" icon="history" title="No scans yet" />
      ) : (
        <RowList label="Recent scans and reviews">
          {shown.map((r) => (
            <ListRow
              key={r.id}
              title={`${r.project_name} · ${r.repository || "whole project"}`}
              badges={
                <>
                  <Badge tone={r.kind === "code" ? "accent" : "neutral"} icon={r.kind === "code" ? "code" : "list"}>
                    {r.kind === "code" ? "Code review" : "Dependencies"}
                  </Badge>
                  <SeverityCounts counts={r.counts} />
                </>
              }
              description={r.summary || undefined}
              extra={
                r.areas.length || r.tools.length ? (
                  <p className="sc-muted sc-small">
                    {r.areas.length > 0 && `Covered: ${r.areas.join(", ")}`}
                    {r.areas.length > 0 && r.tools.length > 0 && " · "}
                    {r.tools.length > 0 && `Tools: ${r.tools.join(", ")}`}
                  </p>
                ) : undefined
              }
              meta={<MetaLine items={[<RelativeTime key="d" date={r.created_at} />, r.by, r.head_sha ? <code key="s">{sha(r.head_sha)}</code> : null]} />}
            />
          ))}
        </RowList>
      )}
    </Section>
  );
}

// ---- One vulnerability --------------------------------------------------------------------------------------------

interface VulnDetail extends Vuln {
  details: string;
  cwe: string | null;
  cvss_vector: string | null;
  refs: { type: string; url: string }[];
  reported_by: string | null;
  resolved_by: string | null;
  manifest: string | null;
  kev_entry: { cve: string; name: string; due_date: string | null; date_added: string | null; ransomware: boolean } | null;
  events: { at: string; event: string; note: string | null; by: string | null }[];
  elsewhere: { id: string; project: string; repository: string; package: string | null; version: string | null; status: Status }[];
  can_accept: boolean;
}

const STATUS_DONE: Record<Status, string> = {
  open: "Reopened",
  acknowledged: "Marked as being fixed",
  fixed: "Marked as fixed",
  accepted: "Risk accepted",
  false_positive: "Marked as not a real issue",
};

export function VulnerabilityPage({ id }: { id: string }) {
  const result = useApi<VulnDetail>(`/vulnerabilities/${id}`);
  useLiveRefresh(result.reload);
  if (result.data)
    return (
      <AsyncBlock result={result} label="Loading the vulnerability" errorTitle="Couldn't refresh this vulnerability" skeleton={null}>
        {(v) => <VulnerabilityView v={v} reload={result.reload} />}
      </AsyncBlock>
    );
  // Loading and errors keep the page frame: one header, the Security crumb back, and the nav highlight.
  return (
    <Page width="content">
      <PageHeader title="Vulnerability" nav="security" crumbs={[{ label: "Security", href: storedList() ?? secHref({ view: "vulnerabilities" }) }]} />
      <AsyncBlock
        result={result}
        label="Loading the vulnerability"
        errorTitle="Couldn't load this vulnerability"
        skeleton={
          <div className="sc-stack">
            <Skeleton width="40%" />
            <Skeleton width="70%" height={28} />
            <SkeletonText lines={6} />
          </div>
        }
      >
        {() => null}
      </AsyncBlock>
    </Page>
  );
}

function VulnerabilityView({ v, reload }: { v: VulnDetail; reload: () => void }) {
  const boot = useBoot();
  const toast = useToast();
  const confirm = useConfirm();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Status | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const open = v.status === "open" || v.status === "acknowledged";
  const aliases = v.aliases.filter((a) => a !== v.advisory_id);
  const listHref = storedList() ?? secHref({ view: "vulnerabilities" });

  async function setStatus(status: Status, reason?: string) {
    const previous = v.status;
    // The server needs a note for accepted and not-a-real-issue, and a status change without one clears the stored note.
    const previousNote = v.status_note || (previous === "accepted" || previous === "false_positive" ? "Restored by undo" : undefined);
    setBusy(status);
    setActionError(null);
    try {
      await api(`/vulnerabilities/${v.id}/status`, { method: "POST", body: { status, note: reason ?? (note.trim() || undefined) } });
      setNote("");
      reload();
      refreshCounts();
      toast.success(STATUS_DONE[status], {
        undo: async () => {
          // A failure here is shown by the kit's toast as "Couldn't undo".
          await api(`/vulnerabilities/${v.id}/status`, { method: "POST", body: { status: previous, note: previousNote } });
          reload();
          refreshCounts();
        },
      });
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function withReason(status: "accepted" | "false_positive") {
    const r = await confirm({
      title: status === "accepted" ? `Accept the risk of "${v.title}"?` : `Mark "${v.title}" as not a real issue?`,
      body: (
        <>
          <p>{status === "accepted" ? "It stops counting as open. Anyone can reopen it later." : "It stops counting as open, and is kept in the history. Anyone can reopen it later."}</p>
          {note.trim() && (
            <p className="sc-muted">
              Your note isn't saved with this change; the reason below is. Your note: “{note.trim()}”
            </p>
          )}
        </>
      ),
      confirmLabel: status === "accepted" ? "Accept risk" : "Mark as not a real issue",
      reason: {
        label: status === "accepted" ? "Why is this safe?" : "Why isn't this a real issue?",
        required: true,
        maxLength: 1000,
        hint: "Explain why this is safe; it's shown in the history.",
      },
    });
    if (!r) return;
    await setStatus(status, r.reason);
  }

  const acceptReason = v.can_accept ? undefined : "Only Project admins and Security leads can do this";
  const crumbs: Crumb[] = [
    { label: "Security", href: listHref },
    // The project crumb switches to another project's security overview.
    { label: v.project_name, href: secHref({ project: v.project }), switcher: projectSwitcher(boot.scopes, v.project, (slug) => secHref({ project: slug })) },
    ...(v.repository ? [{ label: v.repository, href: secHref({ project: v.project, view: "vulnerabilities", repository: v.repository }) }] : []),
  ];

  const fixedList = v.fixed_versions.map((f, i) => (
    <span key={f}>
      {i > 0 && " or "}
      <code>{f}</code>
    </span>
  ));
  const facts = [
    ...(v.package
      ? [
          {
            term: "Package",
            value: (
              <span>
                <code className="sc-wrap">
                  {v.package} {v.version}
                </code>{" "}
                <span className="sc-muted">{v.ecosystem}</span>
              </span>
            ),
          },
          { term: "Fix", value: v.fixed_versions.length ? <span>Upgrade to {fixedList}</span> : <span className="sc-muted">No fixed version published yet</span> },
        ]
      : []),
    ...(v.manifest ? [{ term: "Lockfile", value: <code className="sc-wrap">{v.manifest}</code> }] : []),
    ...(v.location ? [{ term: "Location", value: <code className="sc-wrap">{v.location}</code> }] : []),
    { term: "Where", value: `${v.project_name} · ${v.repository || "whole project"}` },
  ];

  const rail = (
    <div className="sc-rail">
      <section className="sc-card" aria-labelledby="sc-status-title">
        <div className="sc-card-head">
          <h2 id="sc-status-title" className="sc-card-title">
            Status
          </h2>
          <StatusBadge domain="vulnerability" value={v.status} />
        </div>
        {(v.status_note || (v.resolved_by && v.resolved_at)) && (
          <p className="sc-small">
            {v.status_note && <span>{v.status_note}</span>}
            {v.resolved_by && v.resolved_at ? (
              <span className="sc-muted">
                {" "}
                {statusText(v.status)} by {v.resolved_by}, <RelativeTime date={v.resolved_at} />
              </span>
            ) : null}
          </p>
        )}
        <Field label="Note" optional hint={
            open
              ? `Saved with Mark as fixed${v.status === "open" ? " or Start fixing" : ""}. Accept risk and Not a real issue ask for their own reason.`
              : "Saved with Reopen."
          }>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} minRows={2} maxRows={6} maxLength={1000} />
        </Field>
        {actionError ? <ErrorState compact error={actionError} title="Couldn't change the status" /> : null}
        <div className="sc-status-actions">
          {open ? (
            <>
              <Button variant="primary" block loading={busy === "fixed"} loadingText="Saving…" disabled={!!busy && busy !== "fixed"} onClick={() => void setStatus("fixed")}>
                Mark as fixed
              </Button>
              {v.status === "open" && (
                <Button block loading={busy === "acknowledged"} loadingText="Saving…" disabled={!!busy && busy !== "acknowledged"} onClick={() => void setStatus("acknowledged")}>
                  Start fixing
                </Button>
              )}
              <div className="sc-status-row">
                <Button block disabledReason={acceptReason} loading={busy === "accepted"} disabled={!!busy && busy !== "accepted"} onClick={() => void withReason("accepted")}>
                  Accept risk…
                </Button>
                <Button
                  block
                  disabledReason={acceptReason}
                  loading={busy === "false_positive"}
                  disabled={!!busy && busy !== "false_positive"}
                  onClick={() => void withReason("false_positive")}
                >
                  Not a real issue…
                </Button>
              </div>
            </>
          ) : (
            <Button block loading={busy === "open"} loadingText="Saving…" onClick={() => void setStatus("open")}>
              Reopen
            </Button>
          )}
        </div>
        {v.source === "osv" && open && <p className="sc-muted sc-small">Dependency vulnerabilities also close by themselves when a new scan no longer has this version.</p>}
      </section>

      {v.elsewhere.length > 0 && (
        <section className="sc-card" aria-labelledby="sc-elsewhere">
          <div className="sc-card-head">
            <h2 id="sc-elsewhere" className="sc-card-title">
              Same advisory elsewhere
            </h2>
          </div>
          <ul className="sc-plain-list">
            {v.elsewhere.map((e) => (
              <li key={e.id}>
                <a href={href(`/security/${e.id}`)}>
                  {boot.scope(e.project)?.name ?? e.project} · {e.repository || "whole project"}
                </a>
                <span className="sc-elsewhere-meta">
                  {e.package && (
                    <code className="sc-small">
                      {e.package} {e.version}
                    </code>
                  )}
                  <StatusBadge domain="vulnerability" value={e.status} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="sc-card" aria-labelledby="sc-history">
        <div className="sc-card-head">
          <h2 id="sc-history" className="sc-card-title">
            History
          </h2>
        </div>
        <ol className="sc-timeline">
          {v.events.map((e, i) => (
            <li key={i}>
              <span className="sc-timeline-dot" aria-hidden="true" />
              <div>
                <strong>{e.event === "found" ? "Found" : e.event === "reported" ? "Reported" : statusText(e.event)}</strong>
                <span className="sc-muted sc-small">
                  {" "}
                  <MetaLine items={[<RelativeTime key="d" date={e.at} />, e.by]} />
                </span>
                {e.note && <p className="sc-timeline-note">{e.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );

  return (
    <Page width="content" rail={rail} railLabel="Status and history">
      <PageHeader
        title={v.title}
        nav="security"
        crumbs={crumbs}
        status={
          <span className="sc-head-badges">
            <SeverityBadge severity={v.severity} score={v.cvss_score} />
            {v.kev && <KevBadge due={v.kev_due} />}
            <StatusBadge domain="vulnerability" value={v.status} />
          </span>
        }
        meta={
          <MetaLine
            items={[
              v.advisory_id ?? "Reported",
              aliases.length ? `also ${aliases.join(", ")}` : null,
              <RelativeTime key="f" date={v.first_seen} prefix="Found" />,
              v.reported_by ? `Reported by ${v.reported_by}` : null,
            ]}
          />
        }
      />
      <div className="sc-stack">
        {v.package ? (
          v.fixed_versions.length ? (
            <Callout tone="info" icon="arrow" title="How to fix" actions={<CopyButton text={v.fixed_versions[0]!} label="Copy version" />}>
              Upgrade <code>{v.package}</code> to {fixedList}.
            </Callout>
          ) : (
            <Callout tone="warning" title="How to fix">
              No fixed version yet. Consider accepting the risk or mitigating it.
            </Callout>
          )
        ) : null}
        {v.kev_entry && (
          <Callout tone="danger" icon="alert" title="Actively exploited">
            {v.kev_entry.cve} is in CISA's {v.kev_entry.name || "Known Exploited Vulnerabilities catalogue"}
            {v.kev_entry.date_added ? ` since ${day(v.kev_entry.date_added)}` : ""}
            {v.kev_entry.due_date ? `; US federal agencies must fix it by ${day(v.kev_entry.due_date)}` : ""}
            {v.kev_entry.ransomware ? ". It is used in ransomware campaigns." : "."}
          </Callout>
        )}
        <section className="sc-card" aria-label="Facts">
          <Facts items={facts} />
          {(v.cvss_vector || v.cwe) && (
            <Disclosure summary="Technical details">
              <Facts
                items={[
                  ...(v.cvss_vector ? [{ term: "Severity score vector (CVSS)", value: <code className="sc-wrap">{v.cvss_vector}</code> }] : []),
                  ...(v.cwe ? [{ term: "Weakness (CWE)", value: v.cwe }] : []),
                ]}
              />
            </Disclosure>
          )}
        </section>
        {v.details && (
          <section className="sc-details" aria-labelledby="sc-details-h">
            <h2 id="sc-details-h">Details</h2>
            <Markdown text={v.details} />
          </section>
        )}
        {v.refs.length > 0 && (
          <section aria-labelledby="sc-refs-h">
            <h2 id="sc-refs-h">References</h2>
            <ul className="sc-refs">
              {v.refs.map((r) => (
                <li key={r.url}>
                  <a href={r.url} target="_blank" rel="noopener noreferrer nofollow">
                    {hostOf(r.url)}
                    <I name="external" size={12} />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <span className="sc-muted sc-small">{humanize(r.type.toLowerCase())}</span>
                  <span className="sc-ref-url sc-muted sc-small">{r.url}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Page>
  );
}

// ---- Project page widget ------------------------------------------------------------------------------------------

/** The project page's security summary: open counts, last scan and review, recent advisories and how to run a scan. */
export function ProjectSecurity({ project, component }: { project: string; component?: string }) {
  const result = useApi<Overview>(`/security?project=${encodeURIComponent(project)}`);
  const feed = useApi<Feed>(`/advisories?${new URLSearchParams({ project, days: "30", limit: "5" })}`);
  return (
    <section className="sc-card sc-project" aria-labelledby="sc-project-title">
      <div className="sc-card-head">
        <h2 id="sc-project-title" className="sc-card-title">
          <I name="shield" size={16} /> Security
        </h2>
        <a className="sc-small" href={secHref({ project })}>
          Open the dashboard
        </a>
      </div>
      {result.data ? (
        <ProjectSecurityBody data={result.data} feed={feed.data} project={project} component={component} />
      ) : result.error ? (
        <ErrorState compact error={result.error} title="Couldn't load security" onRetry={result.reload} />
      ) : (
        <div aria-busy="true">
          <span className="sr-only" role="status">
            Loading security
          </span>
          <SkeletonText lines={3} />
        </div>
      )}
    </section>
  );
}

function ProjectSecurityBody({ data, feed, project, component }: { data: Overview; feed: Feed | null; project: string; component?: string }) {
  const t = data.tiles;
  const hidden = data.counts_only[0];
  const counts = hidden ? { critical: hidden.critical, high: hidden.high, medium: hidden.medium, low: hidden.low } : { critical: t.critical ?? 0, high: t.high ?? 0, medium: t.medium ?? 0, low: t.low ?? 0 };
  const repos = data.coverage.filter((c) => !component || c.repository === component);
  const lastScan = repos.map((c) => c.deps_scanned_at).filter((d): d is string => !!d).sort().pop() ?? null;
  const lastReview = repos.map((c) => c.reviewed_at).filter((d): d is string => !!d).sort().pop() ?? null;
  const open = counts.critical + counts.high + counts.medium + counts.low;
  const link = (s: Severity) => secHref({ project, view: "vulnerabilities", severity: s, repository: component || undefined });
  const advisories = feed?.advisories ?? [];

  const headline = counts.critical ? (
    <p className="sc-headline" data-tone="danger">
      <I name="alert" size={16} /> {counts.critical} critical open
    </p>
  ) : open ? (
    <p className="sc-headline" data-tone="warning">
      <I name="shield" size={16} /> {plural(open, "open vulnerability", "open vulnerabilities")}
    </p>
  ) : lastScan || lastReview ? (
    <p className="sc-headline" data-tone="success">
      <I name="check-circle" size={16} /> No open vulnerabilities.
    </p>
  ) : (
    <p className="sc-headline">
      <I name="shield" size={16} /> Not scanned yet.
    </p>
  );

  return (
    <div className="sc-stack-sm">
      {headline}
      {open > 0 && (
        <div className="sc-project-counts">
          <SeverityCounts counts={counts} link={hidden ? undefined : link} />
          {!hidden && (t.kev ?? 0) > 0 && <KevBadge />}
        </div>
      )}
      {hidden && <p className="sc-muted sc-small">Counts only · details for people with Security in this project.</p>}
      <p className="sc-muted sc-small">
        <MetaLine
          items={[
            lastScan ? <RelativeTime key="s" date={lastScan} prefix="Dependencies scanned" /> : "Dependencies never scanned",
            lastReview ? <RelativeTime key="r" date={lastReview} prefix="code reviewed" /> : "no code review yet",
          ]}
        />
      </p>
      {advisories.length > 0 && (
        <div className="sc-project-advisories">
          <h3 className="sc-subtitle">Recent critical vulnerabilities that may affect this project</h3>
          <ul className="sc-plain-list">
            {advisories.map((a) => {
              const mine = a.affects.find((x) => x.project === project) ?? a.affects[0];
              return (
                <li key={a.id} className="sc-project-advisory">
                  <span className="sc-adv-meta">
                    {(a.severity !== "unknown" || !a.kev) && <SeverityBadge severity={a.severity} score={a.cvss_score} />}
                    {a.kev && <KevBadge due={a.kev_due} />}
                  </span>
                  <a href={secHref({ project, view: "advisories" })}>
                    {a.name && a.name !== a.title ? `${a.name}: ` : ""}
                    {a.title}
                  </a>
                  <span className="sc-muted sc-small">
                    <MetaLine
                      items={[
                        mine?.because.length ? `uses ${mine.because.join(", ")}` : null,
                        mine?.response ? statusMeta("advisory", mine.response.status).label : "No response yet",
                      ]}
                    />
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <RunWithClaude title="Scan with Claude" command={CLAUDE_FULL} variants={SCAN_VARIANTS} description="Open the repository in Claude Code and run this. Leave out full to scan dependencies only." />
    </div>
  );
}

interface LicenceReport {
  dependencies: number;
  by_licence: { license: string; packages: number }[];
  flagged: { repository: string; package: string; version: string; licenses: string[]; risk: "strong_copyleft" | "weak_copyleft" | "unknown" }[];
  counts: { strong_copyleft: number; weak_copyleft: number; unknown: number };
  note: string;
}

const RISK_TEXT = { strong_copyleft: "Strong copyleft", weak_copyleft: "Weak copyleft", unknown: "Unknown licence" } as const;

/** A project's SBOM download and licence check (for those who see its vulnerability details). */
function DependencyExports({ project }: { project: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [licences, setLicences] = useState<LicenceReport | null>(null);
  async function sbom(withLicences: boolean) {
    setBusy(withLicences ? "sbom-l" : "sbom");
    try {
      const token = getToken();
      const res = await fetch(`/api/scopes/${encodeURIComponent(project)}/sbom${withLicences ? "?licenses=true" : ""}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `${project}-sbom.cdx.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error(e, { title: "Couldn't export the SBOM" });
    } finally {
      setBusy(null);
    }
  }
  async function check() {
    setBusy("licences");
    try {
      setLicences(await api<LicenceReport>(`/scopes/${encodeURIComponent(project)}/licenses`));
    } catch (e) {
      toast.error(e, { title: "Couldn't check licences" });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Section
      title="Dependencies"
      description="Everything the scanned lockfiles list, as a CycloneDX software bill of materials with its open vulnerabilities, and a licence check (licences from deps.dev)."
      actions={
        <>
          <Button size="sm" onClick={() => sbom(false)} disabled={!!busy}>
            {busy === "sbom" ? "Exporting…" : "Download SBOM"}
          </Button>
          <Button size="sm" onClick={() => sbom(true)} disabled={!!busy}>
            {busy === "sbom-l" ? "Looking up licences…" : "SBOM with licences"}
          </Button>
          <Button size="sm" variant="primary" onClick={check} disabled={!!busy}>
            {busy === "licences" ? "Checking…" : "Check licences"}
          </Button>
        </>
      }
    >
      {licences && (
        <div className="sc-stack">
          <p className="sc-muted">
            {licences.dependencies} dependencies: {licences.counts.strong_copyleft} strong copyleft, {licences.counts.weak_copyleft} weak copyleft, {licences.counts.unknown} unknown.{" "}
            {licences.by_licence
              .slice(0, 6)
              .map((l) => `${l.license} ${l.packages}`)
              .join(" · ")}
          </p>
          {licences.flagged.length > 0 && (
            <ul className="plain sc-licences">
              {licences.flagged.slice(0, 100).map((f) => (
                <li key={`${f.repository}-${f.package}-${f.version}`}>
                  <Badge tone={f.risk === "strong_copyleft" ? "danger" : f.risk === "weak_copyleft" ? "warning" : "neutral"}>{RISK_TEXT[f.risk]}</Badge> <code>{f.package}</code> {f.version}
                  {f.repository ? ` · ${f.repository}` : ""}
                  {f.licenses.length ? ` · ${f.licenses.join(", ")}` : ""}
                </li>
              ))}
            </ul>
          )}
          <p className="sc-muted small">{licences.note}</p>
        </div>
      )}
    </Section>
  );
}

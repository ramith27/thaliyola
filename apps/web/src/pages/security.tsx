import { useEffect, useRef, useState } from "react";
import { api, type ScopeInfo } from "../api";
import { ChartCard, LineChart, StatTile } from "../components/charts";
import { CopyBlock } from "./connect";
import { I } from "../components/icons";
import { ErrorBox, formatDate, Loading, Markdown, Notice } from "../components/ui";
import { useApi, useLiveRefresh } from "../hooks";
import { href, navigate, type Route } from "../router";

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

interface Counts {
  project: string;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

interface Overview {
  tiles: Record<string, number | null>;
  by_project: (Counts & { name: string; repository: string; kev: number })[];
  trend: { day: string; critical: number; high: number; other: number }[];
  top_packages: { ecosystem: string; package: string; open: number; repositories: number; worst: number; fixable: boolean }[];
  coverage: { project: string; project_name: string; repository: string; kind: string; deps_scanned_at: string | null; deps_sha: string | null; deps_count: number | null; reviewed_at: string | null; details: boolean }[];
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

const SEVERITY_TEXT: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", unknown: "Unrated" };
const SEVERITY_COLOR: Record<Severity, string> = {
  critical: "var(--sev-critical)",
  high: "var(--sev-high)",
  medium: "var(--sev-medium)",
  low: "var(--sev-low)",
  unknown: "var(--sev-low)",
};
const STATUS_TEXT: Record<Status, string> = { open: "Open", acknowledged: "Being fixed", fixed: "Fixed", accepted: "Risk accepted", false_positive: "False positive" };
const WORST: Severity[] = ["critical", "high", "medium", "low", "unknown"];

/** Severity always shows as a coloured dot plus its name, never colour alone. */
export function SeverityBadge({ severity, score }: { severity: Severity; score?: string | null }) {
  return (
    <span className={`sev sev-${severity}`}>
      <span className="sev-dot" aria-hidden="true" />
      {SEVERITY_TEXT[severity]}
      {score ? <span className="sev-score">{Number(score).toFixed(1)}</span> : null}
    </span>
  );
}

function KevBadge({ due }: { due?: string | null }) {
  return (
    <span className="badge badge-kev" title={due ? `CISA due date ${formatDate(due)}` : "In CISA's Known Exploited Vulnerabilities catalog"}>
      <I name="alert" size={12} /> Actively exploited
    </span>
  );
}

const shortDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// ---- Dashboard -------------------------------------------------------------------------------------------------

export function SecurityPage({ route, scopes }: { route: Route; scopes: ScopeInfo[] }) {
  const project = route.query.get("project") ?? "";
  const { data, error, reload } = useApi<Overview>(`/security${project ? `?project=${encodeURIComponent(project)}` : ""}`);
  useLiveRefresh(reload);
  const projects = scopes.filter((s) => s.kind === "project");

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const t = data.tiles;
  const nothingVisible = !data.by_project.length && !t.fixed_30d && !data.counts_only.length;
  const uncovered = data.coverage.filter((c) => !c.deps_scanned_at);

  return (
    <div className="page security-page">
      <div className="page-head">
        <div>
          <h1>Security</h1>
          <p className="lead">
            Vulnerabilities in your projects' dependencies (matched against OSV.dev and re-checked daily) and those reported by agents and people. Critical and actively
            exploited ones are announced to the project's writers and owners.
          </p>
        </div>
        <select value={project} onChange={(e) => navigate("/security", { project: e.target.value })} aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      <div className="tiles">
        <StatTile label="Critical" value={t.critical ?? 0} icon="alert" tone={t.critical ? "warn" : undefined} note={t.oldest_critical_days != null ? `oldest open ${t.oldest_critical_days} days` : "none open"} href={href("/security", { project, severity: "critical" })} />
        <StatTile label="High" value={t.high ?? 0} icon="shield" note={`${t.medium ?? 0} medium · ${t.low ?? 0} low`} href={href("/security", { project, severity: "high" })} />
        <StatTile label="Actively exploited" value={t.kev ?? 0} icon="bolt" tone={t.kev ? "warn" : undefined} note={`CISA KEV · ${data.kev_catalog_size.toLocaleString()} known`} href={href("/security", { project, kev: "true" })} />
        <StatTile label="Fix available" value={t.fixable ?? 0} icon="arrow" note={`of ${t.open ?? 0} open`} href={href("/security", { project, fixable: "true" })} />
        <StatTile
          label="Fixed, 30 days"
          value={t.fixed_30d ?? 0}
          icon="review"
          note={t.median_fix_days != null ? `median ${t.median_fix_days} days (crit/high)` : `${t.new_30d ?? 0} new`}
          trend={data.trend.map((d) => d.critical + d.high)}
        />
      </div>

      {nothingVisible && (
        <Notice>
          No vulnerabilities{project ? " in this project" : ""} yet. Upload a repository's lockfiles below, or ask a connected agent: <code>/mcp__thaliyola__security-check</code>.
        </Notice>
      )}
      {data.counts_only.length > 0 && (
        <Notice>
          Projects where you aren't a writer show counts only:{" "}
          {data.counts_only.map((c) => `${c.project} (${c.critical} critical, ${c.high} high, ${c.medium + c.low} other)`).join(" · ")}.
        </Notice>
      )}

      <div className="grid-2">
        <ChartCard
          title="Open vulnerabilities"
          subtitle="Each day, last 90 days"
          table={{ columns: ["Day", "Critical", "High", "Medium and low"], rows: data.trend.map((d) => [d.day, d.critical, d.high, d.other]) }}
        >
          <LineChart
            data={data.trend}
            xLabel={(d) => shortDay(String(d.day))}
            series={[
              { key: "critical", label: "Critical", color: "var(--sev-critical)" },
              { key: "high", label: "High", color: "var(--sev-high)" },
              { key: "other", label: "Medium and low", color: "var(--sev-low)" },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Open by repository"
          subtitle="Most urgent first"
          table={{
            columns: ["Project", "Repository", "Critical", "High", "Medium", "Low", "Actively exploited"],
            rows: data.by_project.map((r) => [r.name, r.repository || "(whole project)", r.critical, r.high, r.medium, r.low, r.kev]),
          }}
        >
          {data.by_project.length ? (
            <SeverityBars
              rows={data.by_project.slice(0, 10).map((r) => ({
                label: `${r.name} · ${r.repository || "project"}`,
                link: href("/security", { project: r.project, repository: r.repository }),
                values: { critical: r.critical, high: r.high, medium: r.medium, low: r.low },
              }))}
            />
          ) : (
            <p className="muted small">Nothing open.</p>
          )}
        </ChartCard>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h3>Most affected packages</h3>
          </div>
          {!data.top_packages.length ? (
            <p className="muted small">Nothing open.</p>
          ) : (
            <ul className="plain pkg-list">
              {data.top_packages.map((p) => (
                <li key={`${p.ecosystem}/${p.package}`}>
                  <SeverityBadge severity={WORST[p.worst] ?? "unknown"} />
                  <a href={href("/security", { project, q: p.package })}>
                    <code>{p.package}</code>
                  </a>
                  <span className="muted small">
                    {p.ecosystem} · {p.open} open in {p.repositories} {p.repositories === 1 ? "repository" : "repositories"}
                    {p.fixable ? " · fix available" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <Coverage coverage={data.coverage} uncovered={uncovered.length} lastCheck={data.last_check} canUpload={data.can_upload} />
      </div>

      <Reviews reviews={data.reviews} />

      <VulnList route={route} project={project} />
    </div>
  );
}

function ReviewCounts({ counts }: { counts: Partial<Record<Severity, number>> }) {
  const parts = (["critical", "high", "medium", "low"] as const).filter((k) => counts[k]);
  if (!parts.length) return <span className="muted small">nothing open</span>;
  return (
    <span className="review-counts">
      {parts.map((k) => (
        <span key={k} className={`sev sev-${k}`}>
          <span className="sev-dot" aria-hidden="true" />
          {counts[k]} {SEVERITY_TEXT[k].toLowerCase()}
        </span>
      ))}
    </span>
  );
}

function Reviews({ reviews }: { reviews: Review[] }) {
  return (
    <section className="card reviews-card">
      <div className="card-head">
        <h3>Recent scans and reviews</h3>
        <span className="muted small">
          Run <code>{CLAUDE_FULL}</code> in Claude Code
        </span>
      </div>
      {!reviews.length ? (
        <p className="muted small">No scans yet.</p>
      ) : (
        <ul className="plain review-list">
          {reviews.map((r) => (
            <li key={r.id}>
              <div className="review-head">
                <span className="badge badge-type">{r.kind === "code" ? "Code review" : "Dependencies"}</span>
                <strong>
                  {r.project_name} · {r.repository || "project"}
                </strong>
                <span className="muted small">
                  {formatDate(r.created_at)}
                  {r.by ? ` · ${r.by}` : ""}
                  {r.head_sha ? ` · ${r.head_sha.slice(0, 8)}` : ""}
                </span>
                <ReviewCounts counts={r.counts} />
              </div>
              <p className="small review-summary">{r.summary}</p>
              {(r.areas.length > 0 || r.tools.length > 0) && (
                <p className="muted small">
                  {r.areas.length > 0 && `Covered: ${r.areas.join(", ")}`}
                  {r.areas.length > 0 && r.tools.length > 0 && " · "}
                  {r.tools.length > 0 && `Tools: ${r.tools.join(", ")}`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The project page's security summary: open counts, last scan and review, and how to run one. */
export function ProjectSecurity({ project, component }: { project: string; component?: string }) {
  const { data } = useApi<Overview>(`/security?project=${encodeURIComponent(project)}`);
  if (!data) return null;
  const t = data.tiles;
  const hidden = data.counts_only[0];
  const counts = hidden ? { critical: hidden.critical, high: hidden.high, medium: hidden.medium, low: hidden.low } : { critical: t.critical ?? 0, high: t.high ?? 0, medium: t.medium ?? 0, low: t.low ?? 0 };
  const repos = data.coverage.filter((c) => !component || c.repository === component);
  const lastScan = repos.map((c) => c.deps_scanned_at).filter(Boolean).sort().pop() ?? null;
  const lastReview = repos.map((c) => c.reviewed_at).filter(Boolean).sort().pop() ?? null;
  const open = counts.critical + counts.high + counts.medium + counts.low;
  return (
    <section className="card project-security">
      <div className="card-head">
        <h3>
          <I name="shield" size={16} /> Security
        </h3>
        <a className="small" href={href("/security", { project })}>
          Open the dashboard
        </a>
      </div>
      <div className="project-security-body">
        {open ? <ReviewCounts counts={counts} /> : <span className="small">{lastScan || lastReview ? "No open vulnerabilities." : "Not scanned yet."}</span>}
        {!hidden && (t.kev ?? 0) > 0 && <KevBadge />}
        <span className="muted small">
          {lastScan ? `Dependencies scanned ${formatDate(lastScan)}` : "Dependencies never scanned"} · {lastReview ? `code reviewed ${formatDate(lastReview)}` : "no code review yet"}
          {hidden ? " · details for writers and owners" : ""}
        </span>
      </div>
      <p className="muted small">
        To scan: open the repository in Claude Code and run <code>{CLAUDE_FULL}</code> (or without <code>full</code> for dependencies only).
      </p>
    </section>
  );
}

/** Horizontal stacked bars by severity: 2px surface gaps, rounded data-end, labels outside the marks, hover detail. */
function SeverityBars({ rows }: { rows: { label: string; link: string; values: Record<"critical" | "high" | "medium" | "low", number> }[] }) {
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
  const barH = 14;
  return (
    <div className="chart sev-bars" ref={ref}>
      <div className="legend">
        {keys.map((k) => (
          <span key={k} className="legend-item">
            <span className="legend-swatch" style={{ background: SEVERITY_COLOR[k] }} />
            {SEVERITY_TEXT[k]}
          </span>
        ))}
      </div>
      {rows.map((r, i) => {
        const total = keys.reduce((s, k) => s + r.values[k], 0);
        const track = Math.max(0, width - 48);
        let x = 0;
        const parts = keys.filter((k) => r.values[k] > 0);
        return (
          <a key={r.label} className={`sev-bar-row ${hover === i ? "active" : ""}`} href={r.link} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
            <span className="sev-bar-label">{r.label}</span>
            <span className="sev-bar-track">
              <svg width={track} height={barH} aria-hidden="true">
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
              <span className="sev-bar-total">{total}</span>
            </span>
            {hover === i && (
              <span className="chart-tooltip sev-bar-tip">
                <strong>{r.label}</strong>
                {keys.map((k) => (
                  <span key={k} className="tt-row">
                    <span className="legend-swatch" style={{ background: SEVERITY_COLOR[k] }} />
                    {SEVERITY_TEXT[k]}
                    <span className="tt-val">{r.values[k]}</span>
                  </span>
                ))}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}

function Coverage({ coverage, uncovered, lastCheck, canUpload }: { coverage: Overview["coverage"]; uncovered: number; lastCheck: string | null; canUpload: boolean }) {
  const [scan, setScan] = useState<{ repo: string; command: string } | null>(null);
  const [error, setError] = useState<Error | null>(null);
  async function link(c: Overview["coverage"][number]) {
    setError(null);
    try {
      const r = await api<{ command: string }>("/dependencies/upload-link", { method: "POST", body: { project: c.project, component: c.repository } });
      setScan({ repo: `${c.project_name} · ${c.repository}`, command: r.command });
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <h3>Repositories</h3>
        <span className="muted small">{lastCheck ? `re-checked ${formatDate(lastCheck)}` : "daily re-check pending"}</span>
      </div>
      <p className="muted small">
        {uncovered ? `${uncovered} of ${coverage.length} repositories have never been scanned. ` : coverage.length ? "Every repository has been scanned. " : "No repositories yet. "}
        In Claude Code, open a repository and run <code>{CLAUDE_FULL}</code> to scan its dependencies and review its code; CI can upload lockfiles on every merge (see
        Connect).
      </p>
      <ErrorBox error={error} />
      {scan && <CopyBlock label={`From the root of ${scan.repo} (link works once, for 30 minutes):`} text={scan.command} />}
      <ul className="plain coverage-list">
        {coverage.slice(0, 12).map((c) => (
          <li key={`${c.project}/${c.repository}`}>
            <span className={`cov-dot ${c.deps_scanned_at ? "ok" : "none"}`} aria-hidden="true" />
            <span>
              <strong>{c.project_name}</strong> · {c.repository}
              <div className="muted small">
                {c.deps_scanned_at ? `${c.deps_count ?? 0} packages · scanned ${formatDate(c.deps_scanned_at)}${c.deps_sha ? ` at ${c.deps_sha.slice(0, 8)}` : ""}` : "Dependencies never scanned"}
                {" · "}
                {c.reviewed_at ? `code reviewed ${formatDate(c.reviewed_at)}` : "no code review yet"}
              </div>
            </span>
            {canUpload && c.details && (
              <button className="btn btn-small" onClick={() => link(c)}>
                Scan
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- List --------------------------------------------------------------------------------------------------

function VulnList({ route, project }: { route: Route; project: string }) {
  const q = route.query;
  const severity = q.get("severity") ?? "";
  const status = q.get("status") ?? "open";
  const kev = q.get("kev") === "true";
  const fixable = q.get("fixable") === "true";
  const repository = q.get("repository") ?? "";
  const text = q.get("q") ?? "";
  const [search, setSearch] = useState(text);
  const params = new URLSearchParams({ status, limit: "200" });
  if (project) params.set("project", project);
  if (repository) params.set("repository", repository);
  if (severity) params.set("severity", severity);
  if (kev) params.set("kev", "true");
  if (fixable) params.set("fixable", "true");
  if (text) params.set("q", text);
  const { data, error, reload } = useApi<{ total: number; vulnerabilities: Vuln[] }>(`/vulnerabilities?${params}`);
  useLiveRefresh(reload);
  const current = { project, severity, status, kev: kev ? "true" : "", fixable: fixable ? "true" : "", repository, q: text };
  const go = (patch: Partial<typeof current>) => navigate("/security", { ...current, ...patch });
  const sevs = severity ? severity.split(",") : [];
  const toggleSev = (s: Severity) => go({ severity: (sevs.includes(s) ? sevs.filter((x) => x !== s) : [...sevs, s]).join(",") });

  return (
    <section className="vuln-list-section" id="list">
      <h2>Vulnerabilities</h2>
      <div className="vuln-filters">
        <div className="chips" aria-label="Severity">
          {(["critical", "high", "medium", "low"] as const).map((s) => (
            <button key={s} className={`chip ${sevs.includes(s) ? "active" : ""}`} aria-pressed={sevs.includes(s)} onClick={() => toggleSev(s)}>
              <span className={`sev-dot sev-dot-${s}`} aria-hidden="true" /> {SEVERITY_TEXT[s]}
            </button>
          ))}
          <button className={`chip ${kev ? "active" : ""}`} aria-pressed={kev} onClick={() => go({ kev: kev ? "" : "true" })}>
            Actively exploited
          </button>
          <button className={`chip ${fixable ? "active" : ""}`} aria-pressed={fixable} onClick={() => go({ fixable: fixable ? "" : "true" })}>
            Fix available
          </button>
        </div>
        <div className="vuln-filter-right">
          <select value={status} onChange={(e) => go({ status: e.target.value })} aria-label="Status">
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              go({ q: search });
            }}
          >
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Package, CVE or GHSA…" aria-label="Search vulnerabilities" />
          </form>
        </div>
      </div>
      {repository && (
        <p className="small">
          Repository <strong>{repository}</strong> ·{" "}
          <button className="link-btn" onClick={() => go({ repository: "" })}>
            show all
          </button>
        </p>
      )}
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : !data.vulnerabilities.length ? (
        <p className="muted">Nothing matches.</p>
      ) : (
        <>
          <p className="muted small">
            {data.total} {data.total === 1 ? "vulnerability" : "vulnerabilities"}
            {data.total > data.vulnerabilities.length ? `, first ${data.vulnerabilities.length}` : ""}
          </p>
          <div className="table-wrap">
            <table className="table vuln-table">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Vulnerability</th>
                  <th>Package</th>
                  <th>Where</th>
                  <th>Found</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.vulnerabilities.map((v) => (
                  <tr key={v.id}>
                    <td className="vt-sev">
                      <SeverityBadge severity={v.severity} score={v.cvss_score} />
                    </td>
                    <td className="vuln-title">
                      <a href={href(`/security/${v.id}`)}>{v.title}</a>
                      <div className="small muted">
                        {v.kev && <KevBadge due={v.kev_due} />} {v.advisory_id ?? (v.source === "reported" ? "Reported" : "")}
                        {v.aliases.find((a) => a.startsWith("CVE-") && a !== v.advisory_id) ? ` · ${v.aliases.find((a) => a.startsWith("CVE-"))}` : ""}
                      </div>
                    </td>
                    <td data-label="Package">
                      <div>
                      {v.package ? (
                        <>
                          <code>
                            {v.package} {v.version}
                          </code>
                          {v.fixed_versions.length > 0 && <div className="small muted">upgrade to {v.fixed_versions[0]}</div>}
                        </>
                      ) : v.location ? (
                        <code className="small">{v.location}</code>
                      ) : (
                        <span className="muted">-</span>
                      )}
                      </div>
                    </td>
                    <td data-label="Where">
                      <div>
                        {v.project_name}
                        <div className="small muted">{v.repository || "whole project"}</div>
                      </div>
                    </td>
                    <td className="small" data-label="Found">
                      {formatDate(v.first_seen)}
                    </td>
                    <td className="small" data-label="Status">
                      {STATUS_TEXT[v.status]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

// ---- One vulnerability -------------------------------------------------------------------------------------

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

export function VulnerabilityPage({ id }: { id: string }) {
  const { data, error, reload } = useApi<VulnDetail>(`/vulnerabilities/${id}`);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const v = data;
  const open = v.status === "open" || v.status === "acknowledged";

  async function setStatus(status: Status) {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/vulnerabilities/${id}/status`, { method: "POST", body: { status, note: note || undefined } });
      setNote("");
      reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page vuln-page">
      <p className="breadcrumbs muted small">
        <a href={href("/security")}>Security</a> / <a href={href("/security", { project: v.project })}>{v.project_name}</a>
        {v.repository ? ` / ${v.repository}` : ""}
      </p>
      <div className="vuln-head">
        <SeverityBadge severity={v.severity} score={v.cvss_score} />
        {v.kev && <KevBadge due={v.kev_due} />}
        <span className={`badge ${open ? "badge-pending" : "badge-published"}`}>{STATUS_TEXT[v.status]}</span>
      </div>
      <h1>{v.title}</h1>
      <p className="muted small">
        {v.advisory_id ?? "Reported"}
        {v.aliases.filter((a) => a !== v.advisory_id).length ? ` · also ${v.aliases.filter((a) => a !== v.advisory_id).join(", ")}` : ""} · found {formatDate(v.first_seen)}
        {v.reported_by ? ` by ${v.reported_by}` : ""}
      </p>

      <div className="vuln-grid">
        <div>
          {v.kev_entry && (
            <Notice kind="warn">
              <strong>Actively exploited.</strong> {v.kev_entry.cve} is in CISA's Known Exploited Vulnerabilities catalog
              {v.kev_entry.date_added ? ` since ${formatDate(v.kev_entry.date_added)}` : ""}
              {v.kev_entry.due_date ? `; federal agencies must fix it by ${formatDate(v.kev_entry.due_date)}` : ""}
              {v.kev_entry.ransomware ? ". Used in ransomware campaigns." : "."}
            </Notice>
          )}
          <section className="card vuln-facts">
            <dl className="facts">
              {v.package && (
                <>
                  <dt>Package</dt>
                  <dd>
                    <code>
                      {v.package} {v.version}
                    </code>{" "}
                    <span className="muted small">{v.ecosystem}</span>
                  </dd>
                  <dt>Fix</dt>
                  <dd>{v.fixed_versions.length ? <>Upgrade to {v.fixed_versions.map((f) => <code key={f}>{f}</code>).reduce<React.ReactNode[]>((a, c, i) => (i ? [...a, " or ", c] : [c]), [])}</> : <span className="muted">No fixed version published yet</span>}</dd>
                </>
              )}
              {v.manifest && (
                <>
                  <dt>Lockfile</dt>
                  <dd>
                    <code>{v.manifest}</code>
                  </dd>
                </>
              )}
              {v.location && (
                <>
                  <dt>Location</dt>
                  <dd>
                    <code>{v.location}</code>
                  </dd>
                </>
              )}
              <dt>Where</dt>
              <dd>
                {v.project_name} · {v.repository || "whole project"}
              </dd>
              {v.cvss_vector && (
                <>
                  <dt>CVSS</dt>
                  <dd>
                    <code className="small">{v.cvss_vector}</code>
                  </dd>
                </>
              )}
              {v.cwe && (
                <>
                  <dt>Weakness</dt>
                  <dd>{v.cwe}</dd>
                </>
              )}
            </dl>
          </section>
          {v.details && (
            <section className="vuln-details">
              <h2>Details</h2>
              <Markdown text={v.details} />
            </section>
          )}
          {v.refs.length > 0 && (
            <section>
              <h2>References</h2>
              <ul className="list small vuln-refs">
                {v.refs.map((r) => (
                  <li key={r.url}>
                    <a href={r.url} target="_blank" rel="noopener noreferrer nofollow">
                      {r.url}
                    </a>{" "}
                    <span className="muted">{r.type.toLowerCase()}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside>
          <section className="card">
            <h3>Status</h3>
            <p className="small">
              <strong>{STATUS_TEXT[v.status]}</strong>
              {v.status_note ? `: ${v.status_note}` : ""}
              {v.resolved_by && v.resolved_at ? <span className="muted"> · {v.resolved_by}, {formatDate(v.resolved_at)}</span> : null}
            </p>
            <textarea className="note-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (required to accept a risk or mark a false positive)" aria-label="Note" />
            <ErrorBox error={actionError} />
            <div className="vuln-actions">
              {open ? (
                <>
                  {v.status === "open" && (
                    <button className="btn btn-small" disabled={busy} onClick={() => setStatus("acknowledged")}>
                      Being fixed
                    </button>
                  )}
                  <button className="btn btn-small btn-primary" disabled={busy} onClick={() => setStatus("fixed")}>
                    Mark fixed
                  </button>
                  {v.can_accept && (
                    <>
                      <button className="btn btn-small" disabled={busy || !note.trim()} onClick={() => setStatus("accepted")} title="Owners and admins">
                        Accept risk
                      </button>
                      <button className="btn btn-small" disabled={busy || !note.trim()} onClick={() => setStatus("false_positive")} title="Owners and admins">
                        False positive
                      </button>
                    </>
                  )}
                </>
              ) : (
                <button className="btn btn-small" disabled={busy} onClick={() => setStatus("open")}>
                  Reopen
                </button>
              )}
            </div>
            {v.source === "osv" && open && <p className="muted small">Dependency vulnerabilities also close by themselves when a new scan no longer has this version.</p>}
          </section>

          {v.elsewhere.length > 0 && (
            <section className="card">
              <h3>Same advisory elsewhere</h3>
              <ul className="plain small elsewhere">
                {v.elsewhere.map((e) => (
                  <li key={e.id}>
                    <a href={href(`/security/${e.id}`)}>
                      {e.project} · {e.repository || "project"}
                    </a>{" "}
                    <span className="muted">
                      {e.package} {e.version} · {STATUS_TEXT[e.status].toLowerCase()}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <h3>History</h3>
            <ul className="plain small timeline">
              {v.events.map((e, i) => (
                <li key={i}>
                  <strong>{e.event === "found" ? "Found" : e.event === "reported" ? "Reported" : STATUS_TEXT[e.event as Status] ?? e.event}</strong>
                  <span className="muted">
                    {" "}
                    · {formatDate(e.at)}
                    {e.by ? ` · ${e.by}` : ""}
                  </span>
                  {e.note && <div className="muted">{e.note}</div>}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

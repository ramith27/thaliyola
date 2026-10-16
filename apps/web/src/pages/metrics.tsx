import { useState } from "react";
import { api, type Me } from "../api";
import { ChartCard, LineChart, StackedColumns, StatTile } from "../components/charts";
import { ErrorBox, formatDate, Loading, ScopeBadge, TypeBadge } from "../components/ui";
import { useApi } from "../hooks";
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

const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v)}%`);
const hours = (h: number | null) => (h === null ? "–" : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h}h` : `${Math.round(h / 24)}d`);

/** Is the knowledge base working? Reuse, answers found, review speed, repeat problems, gaps. */
export function MetricsPage({ me, route }: { me: Me; route: Route }) {
  const days = Number(route.query.get("days") ?? 90);
  const { data, error } = useApi<Success>(`/success?days=${days}`);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const weeks = data.weekly.map((w) => ({ ...w, missed: w.searches - w.answered }));

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>Metrics</h1>
          <p className="lead">Is the knowledge base paying off? Whether people and agents find answers, reuse what exists, and keep it current.</p>
        </div>
        <div className="filters">
          {[30, 90, 180].map((d) => (
            <a key={d} className={`chip ${d === days ? "active" : ""}`} href={href("/metrics", { days: String(d) })}>
              {d} days
            </a>
          ))}
        </div>
      </div>

      <div className="tiles">
        <StatTile label="Searches answered" value={pct(data.search.hit_rate)} icon="search" note={`${data.search.answered} of ${data.search.total} searches`} trend={data.weekly.map((w) => (w.searches ? w.answered / w.searches : 0))} />
        <StatTile label="Agents answered" value={pct(data.search.agent_hit_rate)} icon="plug" note={`${data.search.from_agents} agent searches`} />
        <StatTile label="Reuse rate" value={pct(data.reuse.rate)} icon="review" note={`${data.reuse.verifications} confirmed vs ${data.reuse.proposals} new`} />
        <StatTile label="Review time" value={hours(data.review.median_hours)} icon="inbox" note={`median · 90% within ${hours(data.review.p90_hours)}`} href={href("/review")} />
        <StatTile
          label="Needs an owner or a check"
          value={data.hygiene.unowned_articles + data.hygiene.stale + data.hygiene.overdue_reviews}
          icon="alert"
          tone={data.hygiene.stale + data.hygiene.overdue_reviews ? "warn" : undefined}
          note={`of ${data.hygiene.total} items`}
        />
      </div>
      <p className="muted small metric-notes">
        <strong>Reuse rate</strong> is confirmations of existing entries (“still valid”) as a share of confirmations plus new proposals: high means people find and
        trust what's there instead of re-solving it. <strong>Answered</strong> means at least one result came back; searches while typing aren't counted.
      </p>

      <div className="grid-2">
        <ChartCard
          title="Searches"
          subtitle="Per week, from people and agents, last 12 weeks"
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
          subtitle="Entries confirmed still valid vs new proposals per week"
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

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <div>
              <h3>Problems that keep coming back</h3>
              <p>Findings linked as the same root cause. Fix the cause, or fold them into a runbook.</p>
            </div>
          </div>
          {!data.repeats.length ? (
            <p className="muted small">No repeats linked yet.</p>
          ) : (
            <ul className="plain metric-list">
              {data.repeats.map((r) => (
                <li key={r.id}>
                  <a href={href(`/finding/${r.id}`)}>{r.title}</a>
                  <span className="metric-count">{r.occurrences + 1}×</span>
                  <div className="badges">
                    <TypeBadge type={r.type} />
                    <ScopeBadge scope={r.scope} />
                    <span className="muted small">last {formatDate(r.last_seen)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="card">
          <div className="card-head">
            <div>
              <h3>Articles without an owner</h3>
              <p>
                {data.hygiene.unowned_articles} unowned · {data.hygiene.stale} not verified recently · {data.hygiene.overdue_reviews} past their review date. Owners are
                asked to re-check what goes stale.
              </p>
            </div>
          </div>
          {!data.unowned.length ? (
            <p className="muted small">Every article has an owner.</p>
          ) : (
            <ul className="plain metric-list">
              {data.unowned.map((a) => (
                <li key={a.id}>
                  <a href={href(`/article/${a.id}`)}>{a.title}</a>
                  <div className="badges">
                    <TypeBadge type={a.type} />
                    <ScopeBadge scope={a.scope} />
                    <span className="muted small">updated {formatDate(a.updated_at)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {data.gaps_visible && me.admin && <Gaps />}
      {me.admin && <PurgeLog />}
    </div>
  );
}

function Gaps() {
  const [days, setDays] = useState(30);
  const { data, error, reload } = useApi<{ gaps: Gap[] }>(`/gaps?days=${days}`);
  return (
    <section className="card gaps">
      <div className="card-head gaps-head">
        <div>
          <h3>Knowledge gaps</h3>
          <p>What people and agents searched for without a keyword match: candidates for new articles. Only admins see this. Queries are redacted.</p>
        </div>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Period">
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {data && !data.gaps.length && <p className="muted small">No gaps: every search matched something.</p>}
      {!!data?.gaps.length && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Searched for</th>
                <th className="num">Times</th>
                <th className="num">People</th>
                <th>Result</th>
                <th>Last</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.gaps.map((g) => (
                <tr key={g.query}>
                  <td>
                    {g.query}
                    {g.from_agents > 0 && <span className="muted small"> · {g.from_agents} from agents</span>}
                  </td>
                  <td className="num">{g.searches}</td>
                  <td className="num">{g.people}</td>
                  <td>{g.kind === "none" ? <span className="badge badge-possibly_stale">nothing</span> : <span className="muted small">loose matches only</span>}</td>
                  <td className="small">{formatDate(g.last_searched)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        className="link-btn small"
                        onClick={() => {
                          setPrefill({ kind: "article", type: "design_doc", title: g.query.charAt(0).toUpperCase() + g.query.slice(1), body_md: "" });
                          navigate("/new/article");
                        }}
                      >
                        Write it
                      </button>
                      <button className="link-btn small" onClick={() => api("/gaps/dismiss", { method: "POST", body: { query: g.query } }).then(reload)}>
                        Dismiss
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PurgeLog() {
  const { data } = useApi<{ purges: { id: string; target_kind: string; reason: string; at: string; by: string; removed: Record<string, number> }[] }>("/purges");
  if (!data?.purges.length) return null;
  return (
    <section className="card gaps">
      <div className="card-head">
        <div>
          <h3>Purge log</h3>
          <p>Items deleted permanently by admins. Only the reason is kept.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Reason</th>
              <th>By</th>
            </tr>
          </thead>
          <tbody>
            {data.purges.map((p) => (
              <tr key={p.id}>
                <td className="small">{formatDate(p.at)}</td>
                <td>{p.target_kind}</td>
                <td>{p.reason}</td>
                <td className="small">{p.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

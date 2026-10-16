import type { Me, ScopeInfo } from "../api";
import { ChartCard, HBars, LineChart, StackedColumns, StatTile, StatusBar } from "../components/charts";
import { I } from "../components/icons";
import { formatDate, itemHref, Loading, ScopeBadge, TypeBadge } from "../components/ui";
import { useApi } from "../hooks";
import { href } from "../router";
import { GetStartedBanner } from "./connect";
import { NewProjectForm } from "./settings";

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

const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const human = (t: string) => t.replace(/_/g, " ");

function greeting(email: string | null) {
  const h = new Date().getHours();
  const part = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const name = email ? email.split("@")[0]!.split(/[._-]/)[0]! : "";
  return `${part}${name ? `, ${name[0]!.toUpperCase()}${name.slice(1)}` : ""}`;
}

export function Dashboard({ scopes, me }: { scopes: ScopeInfo[]; me: Me }) {
  const { data } = useApi<Insights>("/insights");
  const attention = useApi<{ entries: { kind: string; id: string; title: string; type: string; scope: string; reason: string; last_verified_at: string }[] }>("/attention?limit=6");
  const projects = scopes.filter((s) => s.kind === "project");

  return (
    <div className="page page-wide">
      <GetStartedBanner />
      <div className="page-head">
        <div>
          <h1>{greeting(me.email)}</h1>
          <p className="lead">What your team knows, how it's growing, and what needs a look.</p>
        </div>
        <div className="actions">
          <a className="btn" href={href("/new/finding")}>
            <I name="bolt" size={16} /> New finding
          </a>
          <a className="btn btn-primary" href={href("/new/article")}>
            <I name="plus" size={16} /> New article
          </a>
        </div>
      </div>

      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="tiles">
            <StatTile label="Articles" value={data.totals.articles} icon="doc" trend={data.growth.map((g) => g.articles)} note="12 weeks" />
            <StatTile label="Findings" value={data.totals.findings} icon="bolt" trend={data.growth.map((g) => g.findings)} note="12 weeks" />
            <StatTile label="Projects" value={data.totals.projects} icon="folder" note={`${data.totals.projects === 1 ? "1 project" : `${data.totals.projects} projects`} you can read`} />
            <StatTile label="Waiting for review" value={data.totals.pending} icon="inbox" href={href("/review")} note={data.review.median_hours !== null ? `median ${data.review.median_hours}h to decide` : "proposals"} />
            <StatTile label="Needs attention" value={data.totals.attention} icon="alert" tone={data.totals.attention ? "warn" : undefined} note="stale or overdue" />
          </div>

          <div className="grid-2">
            <ChartCard
              title="Knowledge added"
              subtitle="New articles and findings per week, last 12 weeks"
              table={{ columns: ["Week of", "Articles", "Findings"], rows: data.growth.map((g) => [short(g.week), g.articles, g.findings]) }}
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
              title="Activity"
              subtitle="Requests per day: agents over MCP vs people in the web app, last 30 days"
              table={{ columns: ["Day", "Agents", "Web"], rows: data.activity.map((a) => [short(a.day), a.agents, a.web]) }}
            >
              <LineChart
                data={data.activity}
                xLabel={(d) => short(String(d.day))}
                series={[
                  { key: "agents", label: "Agents (MCP)", color: "var(--series-1)" },
                  { key: "web", label: "Web app", color: "var(--series-2)" },
                ]}
              />
            </ChartCard>
          </div>

          <div className="grid-3">
            <ChartCard
              title="Freshness"
              subtitle="Articles and findings by state"
              table={{
                columns: ["State", "Count"],
                rows: [
                  ["Published", data.statuses.published ?? 0],
                  ["Not verified recently", data.statuses.possibly_stale ?? 0],
                  ["Draft, waiting for review", data.statuses.draft ?? 0],
                ],
              }}
            >
              <StatusBar
                parts={[
                  { key: "published", label: "published", value: data.statuses.published ?? 0, color: "var(--status-good)", note: "verified within the window" },
                  { key: "stale", label: "not verified recently", value: data.statuses.possibly_stale ?? 0, color: "var(--status-warning)", note: "ranked lower until checked" },
                  { key: "draft", label: "drafts", value: data.statuses.draft ?? 0, color: "var(--neutral-mark)", note: "waiting for review" },
                ]}
              />
            </ChartCard>
            <ChartCard title="Knowledge by type" subtitle="Published articles and findings" table={{ columns: ["Type", "Count"], rows: data.types.map((t) => [human(t.type), t.n]) }}>
              <HBars data={data.types.slice(0, 8).map((t) => ({ label: human(t.type), value: t.n }))} />
            </ChartCard>
            <ChartCard
              title="Top contributors"
              subtitle="Approved proposals, last 90 days"
              table={{ columns: ["Person", "Approved"], rows: data.contributors.map((c) => [c.name, c.approved]) }}
            >
              {data.contributors.length ? (
                <HBars data={data.contributors.map((c) => ({ label: c.name, value: c.approved }))} />
              ) : (
                <p className="muted small">No approved proposals yet.</p>
              )}
            </ChartCard>
          </div>

          <div className="grid-2">
            <section className="card">
              <header className="card-head">
                <h3>Recently approved</h3>
                <a className="small" href={href("/review", { state: "approved" })}>
                  All
                </a>
              </header>
              {data.recent.length ? (
                <ul className="feed">
                  {data.recent.map((r) => (
                    <li key={r.id}>
                      <span className={`feed-dot op-${r.op}`} />
                      <div>
                        <a href={itemHref(r.target_kind, r.target_id)}>{r.summary}</a>
                        <div className="muted small">
                          {r.author} · {r.scope} · {formatDate(r.decided_at)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">Nothing approved yet.</p>
              )}
            </section>
            <section className="card">
              <header className="card-head">
                <h3>Needs attention</h3>
              </header>
              {attention.data?.entries.length ? (
                <ul className="feed">
                  {attention.data.entries.map((e) => (
                    <li key={e.id}>
                      <span className="feed-dot op-stale" />
                      <div>
                        <a href={itemHref(e.kind, e.id)}>{e.title}</a>
                        <div className="muted small">
                          <TypeBadge type={e.type} /> <ScopeBadge scope={e.scope} /> {e.reason} · verified {formatDate(e.last_verified_at)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">Everything is fresh.</p>
              )}
            </section>
          </div>
        </>
      )}

      <div className="section-head">
        <h2>Projects</h2>
        {me.admin && <NewProjectForm />}
      </div>
      <div className="cards">
        {scopes
          .filter((s) => s.kind !== "project")
          .map((s) => (
            <a key={s.slug} className="card card-link" href={href(`/scope/${s.slug}`)}>
              <div className="card-link-head">
                <span className="tile-icon">
                  <I name={s.kind === "library" ? "library" : "team"} size={16} />
                </span>
                <h3>{s.name}</h3>
              </div>
              <p className="muted small">{s.description}</p>
            </a>
          ))}
        {projects.map((p) => (
          <a key={p.slug} className="card card-link" href={href(`/project/${p.slug}`)}>
            <div className="card-link-head">
              <span className="tile-icon">
                <I name={p.visibility === "members" ? "lock" : "folder"} size={16} />
              </span>
              <h3>{p.name}</h3>
            </div>
            <p className="muted small">{p.description}</p>
            {p.components.length > 0 && (
              <div className="chips">
                {p.components.map((c) => (
                  <span key={c.slug} className="chip-static">
                    {c.slug}
                  </span>
                ))}
              </div>
            )}
          </a>
        ))}
      </div>
    </div>
  );
}

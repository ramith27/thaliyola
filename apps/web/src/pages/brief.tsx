import { useState } from "react";
import { Page, PageHeader } from "../components/kit";
import { ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { useApi } from "../hooks";
import { href } from "../router";

/** What happened in a project lately: for people joining or coming back. */

interface Brief {
  project: string;
  name: string;
  since: string;
  weeks: number;
  items: number;
  prs_merged: { title: string; url: string | null }[];
  decisions: { id: string; title: string; created_at: string }[];
  decisions_due: { id: string; title: string; review_due: string }[];
  incidents: { id: string; title: string; severity: string; status: string; started_at: string }[];
  sentry_resolved: { title: string; url: string | null }[];
  new_knowledge: { kind: string; id: string; title: string; type: string }[];
  answers_saved: number;
  vulnerabilities: { opened: number; fixed: number; open_critical: number };
  design: { differences: number; previous: number | null } | null;
  active: { name: string; changes: number }[];
}

export function BriefPage({ slug }: { slug: string }) {
  const [weeks, setWeeks] = useState(1);
  const { data, error } = useApi<Brief>(`/scopes/${encodeURIComponent(slug)}/brief?weeks=${weeks}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const ext = (url: string | null, text: string) =>
    url ? (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {text}
      </a>
    ) : (
      text
    );
  return (
    <Page width="content">
      <PageHeader
        title={`${data.name}: what happened`}
        documentTitle={`${data.name}: brief`}
        icon="clock"
        crumbs={[{ label: data.name, href: href(`/project/${slug}`) }, { label: "Brief", muted: true }]}
        meta={<span className="muted small">Since {formatDate(data.since)}</span>}
        actions={
          <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Period">
            <option value={1}>This week</option>
            <option value={2}>Two weeks</option>
            <option value={4}>Four weeks</option>
          </select>
        }
      />
      {data.items === 0 && <Notice>Quiet: nothing recorded in this period.</Notice>}
      <div className="brief-grid">
        {data.incidents.length > 0 && (
          <section className="card">
            <h2>Incidents</h2>
            <ul>
              {data.incidents.map((i) => (
                <li key={i.id}>
                  <a href={href(`/incidents/${i.id}`)}>
                    {i.severity.toUpperCase()} {i.title}
                  </a>{" "}
                  <span className="muted small">({i.status})</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {data.prs_merged.length > 0 && (
          <section className="card">
            <h2>Pull requests merged ({data.prs_merged.length})</h2>
            <ul>
              {data.prs_merged.map((p, i) => (
                <li key={i}>{ext(p.url, p.title.replace(/^Merged: /, ""))}</li>
              ))}
            </ul>
          </section>
        )}
        {(data.decisions.length > 0 || data.decisions_due.length > 0) && (
          <section className="card">
            <h2>Decisions</h2>
            <ul>
              {data.decisions.map((d) => (
                <li key={d.id}>
                  <a href={href(`/article/${d.id}`)}>{d.title}</a> <span className="muted small">new</span>
                </li>
              ))}
              {data.decisions_due.map((d) => (
                <li key={d.id}>
                  <a href={href(`/article/${d.id}`)}>{d.title}</a> <span className="muted small">revisit by {d.review_due}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {data.new_knowledge.length > 0 && (
          <section className="card">
            <h2>New knowledge</h2>
            <ul>
              {data.new_knowledge.map((k) => (
                <li key={k.id}>
                  <a href={href(`/${k.kind}/${k.id}`)}>{k.title}</a>
                </li>
              ))}
            </ul>
          </section>
        )}
        {data.sentry_resolved.length > 0 && (
          <section className="card">
            <h2>Sentry issues resolved</h2>
            <ul>
              {data.sentry_resolved.map((s, i) => (
                <li key={i}>{ext(s.url, s.title.replace(/^Resolved: /, ""))}</li>
              ))}
            </ul>
          </section>
        )}
        <section className="card">
          <h2>In numbers</h2>
          <ul className="plain">
            <li>
              Vulnerabilities: {data.vulnerabilities.opened} new, {data.vulnerabilities.fixed} fixed
              {data.vulnerabilities.open_critical ? `, ${data.vulnerabilities.open_critical} critical open` : ""}
            </li>
            <li>Session answers kept as findings: {data.answers_saved}</li>
            {data.design && <li>Design drift: {data.design.previous !== null ? `${data.design.previous} → ` : ""}{data.design.differences} differences</li>}
            {data.active.length > 0 && <li>Most active: {data.active.map((a) => `${a.name} (${a.changes})`).join(", ")}</li>}
          </ul>
        </section>
      </div>
    </Page>
  );
}

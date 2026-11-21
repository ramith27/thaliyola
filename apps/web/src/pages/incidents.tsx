import { useState } from "react";
import { api, type ScopeInfo } from "../api";
import { Page, PageHeader } from "../components/kit";
import { ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { refreshCounts, useApi, useLiveRefresh } from "../hooks";
import { href, navigate } from "../router";

/** Incidents: open ones first, declaring one, and each incident's live timeline with notes and status. */

type Severity = "sev1" | "sev2" | "sev3" | "sev4";
type Status = "open" | "mitigated" | "resolved";
interface Row {
  id: string;
  title: string;
  severity: Severity;
  status: Status;
  started_at: string;
  resolved_at: string | null;
  declared_via: string;
  project: string;
  project_name: string;
  events: number;
}
interface Event {
  at: string;
  kind: string;
  text: string;
  url: string | null;
  actor: string | null;
}
interface Incident extends Omit<Row, "events"> {
  summary: string;
  commander: string | null;
  mitigated_at: string | null;
  rca_finding_id: string | null;
  events: Event[];
}

const SEVERITY_LABEL: Record<Severity, string> = { sev1: "SEV1", sev2: "SEV2", sev3: "SEV3", sev4: "SEV4" };
const STATUS_TONE: Record<Status, string> = { open: "badge-danger", mitigated: "badge-pending", resolved: "badge-published" };
const KIND_LABEL: Record<string, string> = { declared: "Declared", note: "Note", status: "Status", severity: "Severity", commander: "Lead", sentry: "Sentry", pr: "Pull request", question: "Question", answer: "Answer", link: "Link" };

export function IncidentsPage({ id, scopes }: { id?: string; scopes: ScopeInfo[] }) {
  return id ? <IncidentDetail id={id} /> : <IncidentList scopes={scopes} />;
}

function IncidentList({ scopes }: { scopes: ScopeInfo[] }) {
  const { data, error, reload } = useApi<{ incidents: Row[]; open: number }>("/incidents?status=all");
  useLiveRefresh(reload);
  const [declaring, setDeclaring] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <Page width="wide">
      <PageHeader
        title="Incidents"
        icon="alert"
        meta={<span className="muted small">Something broken right now: everyone in the project hears about it, and its timeline fills itself with notes, Sentry alerts, merged pull requests and sessions' questions.</span>}
        actions={
          <button className="btn btn-primary" onClick={() => setDeclaring((d) => !d)}>
            {declaring ? "Close" : "Declare incident"}
          </button>
        }
      />
      {declaring && <DeclareForm scopes={scopes.filter((s) => s.kind === "project")} />}
      {data.incidents.length === 0 ? (
        <Notice kind="ok">No incidents yet.</Notice>
      ) : (
        <ul className="plain incident-list">
          {data.incidents.map((i) => (
            <li key={i.id} className={`card incident-row is-${i.status}`}>
              <a href={href(`/incidents/${i.id}`)} className="incident-title">
                <span className={`badge ${STATUS_TONE[i.status]}`}>{i.status}</span> <strong>{SEVERITY_LABEL[i.severity]}</strong> {i.title}
              </a>
              <div className="small muted">
                {i.project_name} · started {formatDate(i.started_at)}
                {i.resolved_at ? ` · resolved ${formatDate(i.resolved_at)}` : ""} · {i.events} events{i.declared_via !== "web" ? ` · from ${i.declared_via}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function DeclareForm({ scopes }: { scopes: ScopeInfo[] }) {
  const [project, setProject] = useState(scopes[0]?.slug ?? "");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<Severity>("sev3");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card incident-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const r = await api<{ id: string }>("/incidents", { method: "POST", body: { project, title, severity, summary: summary || undefined } });
          refreshCounts();
          navigate(`/incidents/${r.id}`);
        } catch (err) {
          setError(err as Error);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="incident-form-row">
        <label>
          Project
          <select value={project} onChange={(e) => setProject(e.target.value)} required>
            {scopes.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Severity
          <select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            <option value="sev1">SEV1: everyone down or data at risk</option>
            <option value="sev2">SEV2: a major feature broken</option>
            <option value="sev3">SEV3: degraded or partly broken</option>
            <option value="sev4">SEV4: minor</option>
          </select>
        </label>
      </div>
      <label>
        What's broken
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required placeholder="e.g. Checkout returns 502 for card payments" />
      </label>
      <label>
        What we know <span className="muted small">(optional: since when, who's affected)</span>
        <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <div className="actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Declaring…" : "Declare and tell the project"}
        </button>
      </div>
    </form>
  );
}

function IncidentDetail({ id }: { id: string }) {
  const { data, error, reload } = useApi<Incident>(`/incidents/${id}`);
  useLiveRefresh(reload);
  const [note, setNote] = useState("");
  const [err, setErr] = useState<Error | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const patch = async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      await api(`/incidents/${id}`, { method: "PATCH", body });
      refreshCounts();
      reload();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Page width="wide">
      <PageHeader
        title={data.title}
        documentTitle={`Incident: ${data.title}`}
        icon="alert"
        crumbs={[{ label: "Incidents", href: href("/incidents") }, { label: data.project_name, muted: true }]}
        meta={
          <span className="small">
            <span className={`badge ${STATUS_TONE[data.status]}`}>{data.status}</span> <strong>{SEVERITY_LABEL[data.severity]}</strong> · {data.project_name} · started {formatDate(data.started_at)}
            {data.commander ? ` · led by ${data.commander}` : ""}
          </span>
        }
        actions={
          <>
            {data.status === "open" && (
              <button className="btn" onClick={() => patch({ status: "mitigated" })}>
                Mark mitigated
              </button>
            )}
            {data.status !== "resolved" ? (
              <button className="btn btn-primary" onClick={() => patch({ status: "resolved" })}>
                Resolve
              </button>
            ) : (
              <button className="btn" onClick={() => patch({ status: "open" })}>
                Reopen
              </button>
            )}
          </>
        }
      />
      <ErrorBox error={err} />
      {data.summary && <p className="incident-summary">{data.summary}</p>}
      {data.rca_finding_id && (
        <Notice kind="info">
          A <a href={href(`/finding/${data.rca_finding_id}`)}>root-cause finding</a> was drafted from the timeline and waits for review. In Claude Code, <code>/mcp__thaliyola__write-rca {data.id}</code> works out the cause.
        </Notice>
      )}
      <div className="incident-controls small">
        <label>
          Severity{" "}
          <select value={data.severity} onChange={(e) => patch({ severity: e.target.value })}>
            {(["sev1", "sev2", "sev3", "sev4"] as Severity[]).map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <section className="card">
        <h2>Timeline</h2>
        <ol className="plain incident-timeline">
          {data.events.map((e, i) => (
            <li key={i} className={`incident-event kind-${e.kind}`}>
              <time className="small muted">{new Date(e.at).toLocaleString()}</time>
              <span className="badge badge-type">{KIND_LABEL[e.kind] ?? e.kind}</span>
              <span>
                {e.url && !e.url.startsWith("#") ? (
                  <a href={e.url} target="_blank" rel="noopener noreferrer">
                    {e.text}
                  </a>
                ) : e.url ? (
                  <a href={e.url}>{e.text}</a>
                ) : (
                  e.text
                )}
                {e.actor ? <span className="muted small"> · {e.actor}</span> : null}
              </span>
            </li>
          ))}
        </ol>
        {data.status !== "resolved" && (
          <form
            className="incident-note"
            onSubmit={async (ev) => {
              ev.preventDefault();
              setErr(null);
              try {
                await api(`/incidents/${id}/notes`, { method: "POST", body: { text: note } });
                setNote("");
                reload();
              } catch (e) {
                setErr(e as Error);
              }
            }}
          >
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add what you found or did (a cause ruled out, a fix deployed)" maxLength={2000} required aria-label="Add a note" />
            <button className="btn btn-primary">Add</button>
          </form>
        )}
      </section>
    </Page>
  );
}

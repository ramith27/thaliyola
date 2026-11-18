import { useState } from "react";
import { api, type ScopeInfo } from "../api";
import { Page, PageHeader } from "../components/kit";
import { ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { useApi, useLiveRefresh } from "../hooks";
import { href, navigate, type Route } from "../router";

interface Session {
  handle: string;
  client: string;
  project: string | null;
  repository: string | null;
  description: string;
  visibility: "project" | "private";
  listening: boolean;
  last_seen_at: string;
  online: boolean;
  mine: boolean;
  owner: string;
  waiting: number;
}

interface Question {
  id: string;
  status: "pending" | "claimed" | "answered" | "declined" | "expired" | "cancelled";
  question: string;
  context: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
  expires_at: string;
  saved_item_id: string | null;
  from_session: string;
  from_person: string;
  asked_by_me: boolean;
  asked: string;
  answered_by_session: string | null;
  answered_by: string | null;
  for_me: boolean;
}

const STATUS_TEXT: Record<Question["status"], string> = {
  pending: "Waiting",
  claimed: "Being answered",
  answered: "Answered",
  declined: "Declined",
  expired: "Expired",
  cancelled: "Cancelled",
};

const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : formatDate(iso);
};

export function SessionsPage({ route, scopes }: { route: Route; scopes: ScopeInfo[] }) {
  const tab = (route.query.get("tab") ?? "open") as "open" | "closed" | "all";
  const [offline, setOffline] = useState(false);
  const sessions = useApi<{ sessions: Session[] }>(`/agent-sessions${offline ? "?include_offline=true" : ""}`);
  const questions = useApi<{ questions: Question[] }>(`/questions?status=${tab}`);
  useLiveRefresh(() => (sessions.reload(), questions.reload()));
  const projects = scopes.filter((s) => s.kind === "project");

  return (
    <Page width="content">
      <div className="sessions-page">
        <PageHeader
          title="Sessions"
          icon="chat"
          nav="sessions"
          description="Claude sessions (yours and teammates', on any machine) ask each other questions here. A listening session answers within seconds, a busy one when it finishes its task, and you can answer for any session or project you belong to."
        />

        <section className="sessions-online">
          <div className="section-head">
            <h2>Who can be asked</h2>
            <label className="inline small">
              <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} /> Include offline (last 7 days)
            </label>
          </div>
          <ErrorBox error={sessions.error} />
          {!sessions.data ? (
            <Loading />
          ) : !sessions.data.sessions.length ? (
            <Notice>
              No sessions online. In Claude Code with the Thaliyola plugin, every session joins automatically; elsewhere run <code>/mcp__thaliyola__listen</code>.
            </Notice>
          ) : (
            <ul className="plain session-list">
              {sessions.data.sessions.map((s) => (
                <li key={s.handle} className={`session ${s.online ? "" : "is-offline"}`}>
                  <span className={`presence ${s.online ? (s.listening ? "listening" : "busy") : "offline"}`} aria-hidden="true" />
                  <div className="session-main">
                    <div>
                      <code>{s.handle}</code> {s.mine && <span className="badge badge-type">you</span>}
                      {s.visibility === "private" && <span className="badge badge-type">private</span>}
                    </div>
                    <div className="small muted">
                      {s.online ? (s.listening ? "Listening" : "Busy, answers when it finishes") : `Offline, seen ${ago(s.last_seen_at)}`}
                      {s.project ? ` · ${s.project}${s.repository ? `/${s.repository}` : ""}` : ""} · {s.owner}
                      {s.waiting ? ` · ${s.waiting} waiting` : ""}
                    </div>
                    {s.description && <div className="small">{s.description}</div>}
                  </div>
                  {!s.mine && (
                    <a className="btn btn-small" href={href("/sessions", { tab, to: s.handle })}>
                      Ask
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <AskForm
          initialTo={route.query.get("to") ?? ""}
          suggestions={[...(sessions.data?.sessions.filter((s) => !s.mine).map((s) => s.handle) ?? []), ...projects.map((p) => p.slug)]}
          onAsked={() => questions.reload()}
        />

        <section>
          <div className="section-head">
            <h2>Questions</h2>
            <div className="chips" role="tablist" aria-label="Which questions">
              {(
                [
                  ["open", "Open"],
                  ["closed", "Answered and closed"],
                  ["all", "All"],
                ] as const
              ).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={`chip ${tab === k ? "active" : ""}`} onClick={() => navigate("/sessions", { tab: k })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <ErrorBox error={questions.error} />
          {!questions.data ? (
            <Loading />
          ) : !questions.data.questions.length ? (
            <p className="muted">{tab === "open" ? "No open questions." : "Nothing here yet."}</p>
          ) : (
            <ul className="plain question-list">
              {questions.data.questions.map((q) => (
                <QuestionCard key={q.id} q={q} projects={projects} onChange={() => questions.reload()} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </Page>
  );
}

function AskForm({ initialTo, suggestions, onAsked }: { initialTo: string; suggestions: string[]; onAsked: () => void }) {
  const [to, setTo] = useState(initialTo);
  const [question, setQuestion] = useState("");
  const [context, setContext] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <form
      className="card ask-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        setSent(null);
        try {
          const r = await api<{ status: string; to?: string; to_online?: boolean }>("/questions", { method: "POST", body: { to, question, context: context || undefined, wait_seconds: 0 } });
          setSent(r.to_online === false ? `Sent to ${r.to}. Nobody is online there, so its owner was notified.` : `Sent to ${r.to}. The answer shows below when it arrives.`);
          setQuestion("");
          setContext("");
          onAsked();
        } catch (err) {
          setError(err as Error);
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Ask a session</h2>
      <div className="ask-row">
        <label htmlFor="ask-to">To</label>
        <input id="ask-to" value={to} onChange={(e) => setTo(e.target.value)} list="ask-targets" placeholder="a session handle, a person's email, or a project" required />
        <datalist id="ask-targets">
          {[...new Set(suggestions)].map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <label htmlFor="ask-q">Question</label>
      <textarea id="ask-q" rows={3} value={question} onChange={(e) => setQuestion(e.target.value)} required placeholder="e.g. Which endpoint does the refund button call?" />
      <label htmlFor="ask-c">
        Context <span className="muted small">(optional: what you already know or tried)</span>
      </label>
      <textarea id="ask-c" rows={2} value={context} onChange={(e) => setContext(e.target.value)} />
      <ErrorBox error={error} />
      {sent && <Notice kind="ok">{sent}</Notice>}
      <div className="actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? "Sending…" : "Ask"}
        </button>
      </div>
    </form>
  );
}

function QuestionCard({ q, projects, onChange }: { q: Question; projects: ScopeInfo[]; onChange: () => void }) {
  const [mode, setMode] = useState<null | "answer" | "decline">(null);
  const [text, setText] = useState("");
  const [saveAs, setSaveAs] = useState("");
  const [saveTo, setSaveTo] = useState(projects.find((p) => q.asked.startsWith(`${p.slug}`))?.slug ?? "");
  const [error, setError] = useState<Error | null>(null);
  const open = q.status === "pending" || q.status === "claimed";
  async function act(path: string, body: unknown) {
    setError(null);
    try {
      await api(path, { method: "POST", body });
      setMode(null);
      setText("");
      onChange();
    } catch (err) {
      setError(err as Error);
    }
  }
  return (
    <li className={`card question q-${q.status}`}>
      <div className="question-meta small muted">
        <span className={`badge ${open ? "badge-pending" : q.status === "answered" ? "badge-published" : "badge-type"}`}>{STATUS_TEXT[q.status]}</span>
        <span>
          <code>{q.from_session}</code> ({q.from_person}) → <code>{q.asked}</code> · {ago(q.created_at)}
        </span>
      </div>
      <p className="question-text">{q.question}</p>
      {q.context && <p className="small muted question-context">{q.context}</p>}
      {q.answer && (
        <div className={`answer ${q.status === "declined" ? "is-declined" : ""}`}>
          <div className="small muted">
            {q.status === "declined" ? "Declined" : "Answer"} by {q.answered_by_session ? <code>{q.answered_by_session}</code> : q.answered_by} {q.answered_at ? `· ${ago(q.answered_at)}` : ""}
          </div>
          <p>{q.answer}</p>
          {q.saved_item_id && (
            <a className="small" href={href(`/finding/${q.saved_item_id}`)}>
              Saved as a finding
            </a>
          )}
        </div>
      )}
      {open && q.status === "claimed" && !q.answer && <p className="small muted">A session is answering it now.</p>}
      {open && (
        <div className="row-actions">
          {q.for_me && mode === null && (
            <>
              <button className="btn btn-small btn-primary" onClick={() => setMode("answer")}>
                Answer
              </button>
              <button className="btn btn-small" onClick={() => setMode("decline")}>
                Decline
              </button>
            </>
          )}
          {q.asked_by_me && mode === null && (
            <button className="link-btn small" onClick={() => act(`/questions/${q.id}/cancel`, {})}>
              Cancel question
            </button>
          )}
        </div>
      )}
      {mode && (
        <form
          className="answer-form"
          onSubmit={(e) => {
            e.preventDefault();
            void (mode === "answer"
              ? act(`/questions/${q.id}/answer`, { answer: text, ...(saveAs ? { save_as: saveAs, save_to: saveTo || undefined } : {}) })
              : act(`/questions/${q.id}/decline`, { reason: text }));
          }}
        >
          <textarea
            autoFocus
            rows={mode === "answer" ? 4 : 2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            aria-label={mode === "answer" ? "Answer" : "Reason"}
            placeholder={mode === "answer" ? "Your answer" : "Why it can't be answered here, and who might know"}
          />
          {mode === "answer" && (
            <div className="inline-form small">
              <label htmlFor={`save-${q.id}`}>Also save as a finding</label>
              <select id={`save-${q.id}`} value={saveAs} onChange={(e) => setSaveAs(e.target.value)}>
                <option value="">No</option>
                <option value="known_issue">Known issue</option>
                <option value="data_gotcha">Data gotcha</option>
                <option value="query_recipe">Query recipe</option>
                <option value="rca">Root cause</option>
              </select>
              {saveAs && (
                <select value={saveTo} onChange={(e) => setSaveTo(e.target.value)} aria-label="Where">
                  <option value="team">Team</option>
                  {projects.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
          <ErrorBox error={error} />
          <div className="actions">
            <button className="btn btn-small btn-primary">{mode === "answer" ? "Send answer" : "Decline"}</button>
            <button type="button" className="btn btn-small" onClick={() => setMode(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {!mode && <ErrorBox error={error} />}
    </li>
  );
}

import { useState } from "react";
import { api } from "../api";
import { CopyBlock } from "./connect";
import { Page, PageHeader } from "../components/kit";
import { ErrorBox, formatDate, Loading, Notice } from "../components/ui";
import { useApi, useLiveRefresh } from "../hooks";
import { href } from "../router";

/**
 * A project's pull-request briefings (what Thaliyola knew about each PR's changed files, as commented on it), and,
 * for Project admins, turning briefings on and giving git connections their pull-request webhook.
 */

interface Briefing {
  docs: { article_id: string; title: string; claims: number; paths: string[] }[];
  contracts: { article_id: string; title: string; consumers: { project: string; repository: string | null }[]; hidden_consumers: number }[];
  known_issues: { finding_id: string; title: string; matched: string | null }[];
  vulnerabilities: { id: string; title: string; severity: string; location: string | null }[];
  lockfiles: string[];
  design: { differences: number; hardcoded_here: { file: string; value: string; suggestion: string }[] } | null;
  working_here: { session: string; owner: string; paths: string[] }[];
}
interface Row {
  id: string;
  repository: string;
  provider: string;
  number: number;
  title: string;
  url: string | null;
  author: string | null;
  files: string[];
  briefing: Briefing;
  items: number;
  status: "pending" | "posted" | "skipped" | "failed";
  error: string | null;
  updated_at: string;
  docs_check: DocsCheck | null;
  docs_state: "success" | "failure" | "pending" | null;
  docs_ack_by: string | null;
  merged_at: string | null;
  docs_applied_at: string | null;
}
interface DocsCheck {
  facts: { claim_id: string; article_id: string; article: string; path: string; start: number; end: number; outcome: "changed" | "removed" | "moved" | "unknown"; to?: { path: string; start: number; end: number } }[];
  changed: number;
  removed: number;
  moved: number;
  unknown: number;
}
type DocsMode = "off" | "warn" | "block";
const OUTCOME: Record<DocsCheck["facts"][number]["outcome"], string> = { changed: "lines changed", removed: "file deleted", unknown: "diff too large to check", moved: "moves" };
type Mode = "off" | "relevant" | "always";
interface Question {
  id: string;
  repository: string;
  provider: string;
  number: number;
  author: string | null;
  question: string;
  path: string | null;
  line: number | null;
  confidence: "good" | "partial" | "none" | null;
  sources: number;
  status: "replied" | "relayed" | "answered" | "declined" | "failed";
  error: string | null;
  created_at: string;
}
const Q_STATUS: Record<Question["status"], string> = { replied: "Replied", relayed: "Asked sessions", answered: "Session answered", declined: "Session couldn't answer", failed: "Couldn't reply" };

/** Questions asked with @thaliyola in this project's pull requests. */
function QuestionList({ rows }: { rows: Question[] }) {
  return (
    <>
      <h2 className="pr-section">Questions asked in pull requests</h2>
      <ul className="plain pr-list">
        {rows.map((q) => (
          <li key={q.id} className="card pr-row">
            <div className="pr-head">
              <span>
                <strong>
                  {q.repository}
                  {q.provider === "gitlab" ? "!" : "#"}
                  {q.number}
                </strong>{" "}
                {q.question}
              </span>
              <span className={`badge ${q.status === "answered" ? "badge-published" : q.status === "failed" ? "badge-danger" : "badge-type"}`}>{Q_STATUS[q.status]}</span>
            </div>
            <div className="small muted">
              {q.author ? `${q.author} · ` : ""}
              {q.path ? `${q.path}${q.line ? `:${q.line}` : ""} · ` : ""}
              {q.sources ? `${q.sources} source${q.sources === 1 ? "" : "s"} quoted` : "nothing known yet"} · {formatDate(q.created_at)}
            </div>
            {q.error && <p className="small pr-error">{q.error}</p>}
          </li>
        ))}
      </ul>
    </>
  );
}

const STATUS: Record<Row["status"], string> = { pending: "Working", posted: "Commented", skipped: "Nothing to say", failed: "Couldn't comment" };

export function PullRequestsPage({ slug, canManage }: { slug: string; canManage: boolean }) {
  const { data, error, reload } = useApi<{ project: string; mode: Mode; questions: "off" | "on"; docs_check: DocsMode; briefings: Row[] }>(`/scopes/${encodeURIComponent(slug)}/pr-briefings`);
  const questions = useApi<Question[]>(`/scopes/${encodeURIComponent(slug)}/pr-questions`);
  useLiveRefresh(() => {
    reload();
    questions.reload();
  });
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <Page width="wide">
      <PageHeader
        title="Pull requests"
        documentTitle={`${slug}: pull requests`}
        icon="git-branch"
        scope={slug}
        crumbs={[{ label: slug, href: href(`/project/${slug}`) }, { label: "Pull requests", muted: true }]}
        meta={<span className="muted small">What Thaliyola knew about each pull request's changed files, as it commented on it.</span>}
      />
      {canManage && <BriefingSettings slug={slug} mode={data.mode} questions={data.questions} docsMode={data.docs_check} onChanged={reload} />}
      {!canManage && data.mode === "off" && <Notice>PR briefings are off for this project; a Project admin turns them on here.</Notice>}
      {(questions.data?.length ?? 0) > 0 && <QuestionList rows={questions.data!} />}
      <h2 className="pr-section">Briefings</h2>
      {data.briefings.length === 0 ? (
        <p className="muted">No pull requests briefed yet.</p>
      ) : (
        <ul className="plain pr-list">
          {data.briefings.map((r) => (
            <li key={r.id} className="card pr-row">
              <div className="pr-head">
                <button className="link-btn" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                  <strong>
                    {r.repository}#{r.number}
                  </strong>{" "}
                  {r.title}
                </button>
                <span className="pr-badges">
                  {r.docs_check && <DocsBadge r={r} />}
                  <span className={`badge ${r.status === "posted" ? "badge-published" : r.status === "failed" ? "badge-danger" : "badge-type"}`}>{STATUS[r.status]}</span>
                </span>
              </div>
              <div className="small muted">
                {r.author ? `${r.author} · ` : ""}
                {r.files.length} files · {r.items} item{r.items === 1 ? "" : "s"} known · {formatDate(r.updated_at)}
                {r.url && (
                  <>
                    {" "}
                    ·{" "}
                    <a href={r.url} target="_blank" rel="noopener noreferrer">
                      Open on {r.provider === "gitlab" ? "GitLab" : "GitHub"}
                    </a>
                  </>
                )}
              </div>
              {r.error && <p className="small pr-error">{r.error}</p>}
              {open === r.id && r.docs_check && <DocsCheckView slug={slug} r={r} canAcknowledge={canManage} onChanged={reload} />}
              {open === r.id && <BriefingView b={r.briefing} />}
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}

function DocsBadge({ r }: { r: Row }) {
  const d = r.docs_check!;
  const look = d.changed + d.removed + d.unknown;
  if (r.docs_applied_at) return <span className="badge badge-type">Docs updated on merge</span>;
  if (!look) return <span className="badge badge-published">Docs fine</span>;
  if (r.docs_ack_by) return <span className="badge badge-published">Docs acknowledged</span>;
  return <span className={`badge ${r.docs_state === "failure" ? "badge-danger" : "badge-warning"}`}>{look} fact{look === 1 ? "" : "s"} to check</span>;
}

/** The facts a pull request affects, and (reviewers) acknowledging them so a blocking check passes. */
function DocsCheckView({ slug, r, canAcknowledge, onChanged }: { slug: string; r: Row; canAcknowledge: boolean; onChanged(): void }) {
  const d = r.docs_check!;
  const [error, setError] = useState<Error | null>(null);
  const look = d.facts.filter((f) => f.outcome !== "moved");
  return (
    <div className="pr-briefing small">
      <h3>Docs check</h3>
      {d.facts.length === 0 ? (
        <p className="muted">No documented facts cite the lines this changes.</p>
      ) : (
        <ul>
          {d.facts.map((f) => (
            <li key={`${f.claim_id}-${f.path}-${f.start}`}>
              <a href={href(`/article/${f.article_id}`)}>{f.article}</a>: <code>{`${f.path}:${f.start}${f.end !== f.start ? `-${f.end}` : ""}`}</code> {OUTCOME[f.outcome]}
              {f.to && f.outcome === "moved" && (
                <>
                  {" "}
                  to <code>{`${f.to.path}:${f.to.start}-${f.to.end}`}</code>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {r.docs_applied_at ? (
        <p className="muted">Merged: moved facts now cite their new lines; facts whose lines changed are marked stale for the next docs run.</p>
      ) : r.docs_ack_by ? (
        <p className="muted">Acknowledged by {r.docs_ack_by} for this commit.</p>
      ) : (
        look.length > 0 &&
        canAcknowledge && (
          <button
            className="btn btn-small"
            onClick={async () => {
              setError(null);
              try {
                await api(`/scopes/${encodeURIComponent(slug)}/pr-briefings/${r.id}/acknowledge-docs`, { method: "POST" });
                onChanged();
              } catch (err) {
                setError(err as Error);
              }
            }}
          >
            The docs are fine (or updated): pass the check
          </button>
        )
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function BriefingView({ b }: { b: Briefing }) {
  const empty = !b.docs.length && !b.contracts.length && !b.known_issues.length && !b.vulnerabilities.length && !b.lockfiles.length && !b.design && !b.working_here.length;
  if (empty) return <p className="small muted">Nothing recorded about these files.</p>;
  return (
    <div className="pr-briefing small">
      {b.docs.length > 0 && (
        <>
          <h3>Docs that describe this code</h3>
          <ul>
            {b.docs.map((d) => (
              <li key={d.article_id}>
                <a href={href(`/article/${d.article_id}`)}>{d.title}</a>: {d.claims ? `${d.claims} facts cite` : "covers"} {d.paths.join(", ")}
              </li>
            ))}
          </ul>
        </>
      )}
      {b.contracts.length > 0 && (
        <>
          <h3>Contracts this repository provides</h3>
          <ul>
            {b.contracts.map((c) => (
              <li key={c.article_id}>
                <a href={href(`/article/${c.article_id}`)}>{c.title}</a>
                {c.consumers.length || c.hidden_consumers ? `, used by ${[...c.consumers.map((x) => `${x.project}${x.repository ? `/${x.repository}` : ""}`), ...(c.hidden_consumers ? [`${c.hidden_consumers} more`] : [])].join(", ")}` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {b.known_issues.length > 0 && (
        <>
          <h3>Known issues</h3>
          <ul>
            {b.known_issues.map((k) => (
              <li key={k.finding_id}>
                <a href={href(`/finding/${k.finding_id}`)}>{k.title}</a>
                {k.matched ? ` (mentions ${k.matched})` : ""}
              </li>
            ))}
          </ul>
        </>
      )}
      {(b.vulnerabilities.length > 0 || b.lockfiles.length > 0) && (
        <>
          <h3>Security</h3>
          <ul>
            {b.vulnerabilities.map((v) => (
              <li key={v.id}>
                {v.severity}: <a href={href(`/security/${v.id}`)}>{v.title}</a> in {v.location}
              </li>
            ))}
            {b.lockfiles.length > 0 && <li>Dependencies change: {b.lockfiles.join(", ")}</li>}
          </ul>
        </>
      )}
      {b.design && (b.design.hardcoded_here.length > 0 || b.design.differences > 0) && (
        <>
          <h3>Design</h3>
          <ul>
            {b.design.hardcoded_here.map((h) => (
              <li key={`${h.file}-${h.value}`}>
                {h.file} hard-codes {h.value}: {h.suggestion}
              </li>
            ))}
            {!b.design.hardcoded_here.length && <li>Style files change; the last design check found {b.design.differences} differences.</li>}
          </ul>
        </>
      )}
      {b.working_here.length > 0 && (
        <>
          <h3>Also being worked on</h3>
          <ul>
            {b.working_here.map((w) => (
              <li key={w.session}>
                {w.session} ({w.owner}): {w.paths.join(", ")}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface GitConnection {
  id: string;
  name: string;
  kind: string;
  webhook_secret_hint?: string | null;
}

/** Project admins: the mode, and each git connection's pull-request webhook. */
function BriefingSettings({ slug, mode, questions, docsMode, onChanged }: { slug: string; mode: Mode; questions: "off" | "on"; docsMode: DocsMode; onChanged(): void }) {
  const conns = useApi<{ connections: GitConnection[] }>(`/projects/${encodeURIComponent(slug)}/connections`);
  const [error, setError] = useState<Error | null>(null);
  const [hook, setHook] = useState<{ name: string; url: string; secret: string; how: string } | null>(null);
  const git = (conns.data?.connections ?? []).filter((c) => c.kind === "git");
  return (
    <section className="card pr-settings">
      <h2>PR briefings</h2>
      <p className="small muted">
        When a pull request opens or gets new commits, Thaliyola comments with what it knows about the changed files: docs whose facts cite them, contracts and their consumers, known issues,
        vulnerabilities, design drift and other sessions working there. Titles and links only. The git connection's token must be able to write pull-request comments.
      </p>
      <label className="small" htmlFor="pr-mode">
        Comment on pull requests
      </label>{" "}
      <select
        id="pr-mode"
        value={mode}
        onChange={async (e) => {
          setError(null);
          try {
            await api(`/scopes/${encodeURIComponent(slug)}/pr-briefings`, { method: "PUT", body: { mode: e.target.value } });
            onChanged();
          } catch (err) {
            setError(err as Error);
          }
        }}
      >
        <option value="off">Off</option>
        <option value="relevant">When there's something to say</option>
        <option value="always">Always</option>
      </select>
      <h3>Docs check</h3>
      <p className="small muted">
        A commit status (<code>thaliyola/docs</code>) on each pull request: which documented facts cite lines it changes, moves or deletes. When it merges, facts whose lines only moved follow
        them and the others are marked stale. The token needs permission to write commit statuses.
      </p>
      <label className="small" htmlFor="pr-docs">
        Docs check
      </label>{" "}
      <select
        id="pr-docs"
        value={docsMode}
        onChange={async (e) => {
          setError(null);
          try {
            await api(`/scopes/${encodeURIComponent(slug)}/pr-docs-check`, { method: "PUT", body: { mode: e.target.value } });
            onChanged();
          } catch (err) {
            setError(err as Error);
          }
        }}
      >
        <option value="off">Off</option>
        <option value="warn">Report, never block</option>
        <option value="block">Block until the docs are checked</option>
      </select>
      <h3>Questions in pull requests</h3>
      <label className="small pr-toggle">
        <input
          type="checkbox"
          checked={questions === "on"}
          onChange={async (e) => {
            setError(null);
            try {
              await api(`/scopes/${encodeURIComponent(slug)}/pr-questions`, { method: "PUT", body: { on: e.target.checked } });
              onChanged();
            } catch (err) {
              setError(err as Error);
            }
          }}
        />{" "}
        Answer comments that ask <code>@thaliyola</code>
      </label>
      <p className="small muted">
        Thaliyola replies in the thread with short excerpts from this project's, Team and Library knowledge (never other projects'), how fresh they are and where they disagree, and asks this
        project's Claude sessions; a session's answer is posted in the thread too. Everyone who can see the pull request reads the replies. The webhook also needs comment events.
      </p>
      <h3>Pull-request webhook</h3>
      {git.length === 0 ? (
        <p className="small muted">
          Add a GitHub or GitLab connection first (project <a href={href(`/scope/${slug}/settings`, { tab: "connections" })}>settings → Connections</a>).
        </p>
      ) : (
        <ul className="plain">
          {git.map((c) => (
            <li key={c.id} className="pr-conn">
              {c.name}{" "}
              <button
                className="btn btn-small"
                onClick={async () => {
                  setError(null);
                  try {
                    const r = await api<{ url: string; secret: string; how: string }>(`/connections/${c.id}/webhook`, { method: "POST" });
                    setHook({ name: c.name, ...r });
                  } catch (err) {
                    setError(err as Error);
                  }
                }}
              >
                {c.webhook_secret_hint ? "New webhook secret" : "Set up the webhook"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {hook && (
        <div className="pr-hook">
          <Notice kind="warn">Copy these now: the secret is shown only once. Making a new one stops the old one working.</Notice>
          <CopyBlock label={`Webhook URL for ${hook.name}`} text={hook.url} />
          <CopyBlock label="Secret" text={hook.secret} />
          <p className="small">{hook.how}</p>
        </div>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

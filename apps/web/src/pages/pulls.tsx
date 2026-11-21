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
}
type Mode = "off" | "relevant" | "always";

const STATUS: Record<Row["status"], string> = { pending: "Working", posted: "Commented", skipped: "Nothing to say", failed: "Couldn't comment" };

export function PullRequestsPage({ slug, canManage }: { slug: string; canManage: boolean }) {
  const { data, error, reload } = useApi<{ project: string; mode: Mode; briefings: Row[] }>(`/scopes/${encodeURIComponent(slug)}/pr-briefings`);
  useLiveRefresh(reload);
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
      {canManage && <BriefingSettings slug={slug} mode={data.mode} onChanged={reload} />}
      {!canManage && data.mode === "off" && <Notice>PR briefings are off for this project; a Project admin turns them on here.</Notice>}
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
                <span className={`badge ${r.status === "posted" ? "badge-published" : r.status === "failed" ? "badge-danger" : "badge-type"}`}>{STATUS[r.status]}</span>
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
              {open === r.id && <BriefingView b={r.briefing} />}
            </li>
          ))}
        </ul>
      )}
    </Page>
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
function BriefingSettings({ slug, mode, onChanged }: { slug: string; mode: Mode; onChanged(): void }) {
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

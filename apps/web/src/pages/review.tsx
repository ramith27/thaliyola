import { useState } from "react";
import { api, ApiError, type RevisionSummary } from "../api";
import { Badge, Diff, ErrorBox, formatDate, Loading, Markdown, Notice, ScopeBadge, StatusBadge, TypeBadge } from "../components/ui";
import { useApi } from "../hooks";
import { href, navigate, type Route } from "../router";

const OP_TEXT: Record<string, string> = { create: "new", update: "edit", promote: "promote", verify: "retire", share: "share" };

export function ReviewQueuePage({ route }: { route: Route }) {
  if (route.query.get("tab") === "suggestions") return <SuggestionsPage />;
  const state = route.query.get("state") ?? "pending";
  const mine = route.query.get("mine") === "1";
  const { data, error } = useApi<{ revisions: RevisionSummary[] }>(`/revisions?state=${state}${mine ? "&mine=true" : ""}`);
  return (
    <div className="page">
      <h1>Review</h1>
      <p className="lead">Agent and teammate proposals. Scope owners and admins approve them.</p>
      <div className="filters">
        {["pending", "approved", "rejected"].map((s) => (
          <a key={s} className={`chip ${state === s ? "active" : ""}`} href={href("/review", { state: s, mine: mine ? "1" : undefined })}>
            {s}
          </a>
        ))}
        <a className={`chip ${mine ? "active" : ""}`} href={href("/review", { state, mine: mine ? undefined : "1" })}>
          Mine only
        </a>
        <a className="chip" href={href("/review", { tab: "suggestions" })}>
          Suggestions
        </a>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        !error && <Loading />
      ) : data.revisions.length === 0 ? (
        <p className="muted">Nothing {state}.</p>
      ) : (
        <ul className="hits">
          {data.revisions.map((r) => (
            <li key={r.id} className="hit">
              <div className="hit-head">
                <a href={href(`/review/${r.id}`)}>{r.summary || r.target_title}</a>
              </div>
              <div className="badges">
                <Badge kind="op">{OP_TEXT[r.op] ?? r.op}</Badge>
                <TypeBadge type={r.target_type} />
                <ScopeBadge scope={r.scope} />
                {r.redactions.length > 0 && <Badge kind="possibly_stale">redacted</Badge>}
                <span className="muted small">
                  {r.author} · {formatDate(r.created_at)}
                  {r.reviewer ? ` · ${r.state} by ${r.reviewer}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface RevisionDetail {
  id: string;
  op: string;
  state: string;
  summary: string;
  stale: boolean;
  target_kind: "article" | "finding";
  target_id: string;
  payload: Record<string, any>;
  current: Record<string, any>;
  proposed: Record<string, any>;
}

const FINDING_FIELDS = [
  ["title", "Title"],
  ["symptoms", "Symptoms"],
  ["root_cause", "Root cause"],
  ["fix", "Fix"],
] as const;

export function RevisionPage({ id }: { id: string }) {
  const { data, error, reload } = useApi<RevisionDetail>(`/revisions/${id}`);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Error | null>(null);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const itemLink = href(`/${data.target_kind}/${data.target_id}`);

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setActionError(null);
    try {
      await api(`/revisions/${id}/${action}`, { method: "POST", body: action === "reject" ? { reason } : {} });
      reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <p className="muted small">
        <a href={href("/review")}>Review</a> / {OP_TEXT[data.op] ?? data.op}
      </p>
      <h1>{data.summary}</h1>
      <div className="badges">
        <StatusBadge status={data.state} />
        <TypeBadge type={data.current.type} />
        <ScopeBadge scope={data.current.scope} />
        <a href={itemLink} className="small">
          Open {data.target_kind}
        </a>
      </div>
      {data.stale && data.state === "pending" && (
        <Notice kind="warn">The {data.target_kind} changed after this was proposed. Approving is refused; reject it and ask for a new proposal.</Notice>
      )}

      <ProposedChange data={data} />

      {data.state === "pending" && (
        <section className="decide">
          <ErrorBox error={actionError instanceof ApiError && actionError.status === 403 ? new Error(`You can't approve here: ${actionError.message}`) : actionError} />
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || data.stale} onClick={() => decide("approve")}>
              Approve
            </button>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for rejecting" aria-label="Reason for rejecting" />
            <button className="btn btn-danger" disabled={busy || !reason.trim()} onClick={() => decide("reject")}>
              Reject
            </button>
          </div>
        </section>
      )}
      {data.state !== "pending" && (
        <p>
          <button className="btn" onClick={() => navigate("/review")}>
            Back to the queue
          </button>
        </p>
      )}
    </div>
  );
}

function ProposedChange({ data }: { data: RevisionDetail }) {
  const { op, target_kind, current, proposed, payload } = data;
  if (op === "create") {
    return (
      <section>
        <h2>New {target_kind}</h2>
        {target_kind === "article" ? (
          <Diff before="" after={`# ${current.title}\n\n${current.body_md}`} />
        ) : (
          <Diff before="" after={FINDING_FIELDS.map(([f, name]) => `${name}:\n${current[f] ?? ""}`).join("\n\n")} />
        )}
      </section>
    );
  }
  if (op === "share") {
    return (
      <section>
        <h2>Publish to the library{payload.path ? ` (folder “${payload.path}”)` : ""}</h2>
        <p className="muted">
          On approval a library copy is created, with its links and files, and {current.scope?.slug} is linked to it.
        </p>
        {target_kind === "article" ? (
          <div className="preview-box">
            <Markdown text={`# ${current.title}\n\n${current.body_md}`} />
          </div>
        ) : (
          <div className="preview-box">
            <h3>{current.title}</h3>
            <Markdown text={`**Symptoms:** ${current.symptoms}\n\n**Root cause:** ${current.root_cause}\n\n**Fix:** ${current.fix}`} />
          </div>
        )}
      </section>
    );
  }
  if (op === "verify") {
    return (
      <section>
        <h2>Mark as no longer valid</h2>
        <p>{payload.note}</p>
      </section>
    );
  }
  if (target_kind === "article") {
    return (
      <section>
        <h2>Changes{payload.section ? ` to “${payload.section}”` : ""}</h2>
        {payload.title && payload.title !== current.title && (
          <p>
            Title: <del>{current.title}</del> → <ins>{payload.title}</ins>
          </p>
        )}
        <Diff before={current.body_md} after={proposed.body_md} />
      </section>
    );
  }
  const patch = (payload.patch ?? {}) as Record<string, unknown>;
  return (
    <section>
      <h2>Changes</h2>
      {Object.entries(patch).map(([field, value]) => (
        <div key={field}>
          <h3>{field.replace(/_/g, " ")}</h3>
          <Diff before={Array.isArray(current[field]) ? current[field].join(", ") : String(current[field] ?? "")} after={Array.isArray(value) ? value.join(", ") : String(value)} />
        </div>
      ))}
    </section>
  );
}

interface Suggestions {
  promote: {
    finding: { id: string; title: string; scope: string };
    recurrences: number;
    verifications: number;
    suggested_article: { id: string; title: string; type: string; version: number } | null;
  }[];
  duplicates: { similarity: number; a: { id: string; title: string; scope: string }; b: { id: string; title: string; scope: string } }[];
  note?: string;
}

function SuggestionsPage() {
  const { data, error, reload } = useApi<Suggestions>("/suggestions");
  const [done, setDone] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<Error | null>(null);

  async function act(key: string, fn: () => Promise<{ revision_id?: string }>, label: string) {
    setActionError(null);
    try {
      const res = await fn();
      setDone((d) => ({ ...d, [key]: res.revision_id ? `${label}: proposal ${res.revision_id.slice(0, 8)}` : label }));
    } catch (e) {
      setActionError(e as Error);
    }
  }

  return (
    <div className="page">
      <h1>Review</h1>
      <div className="filters">
        <a className="chip" href={href("/review")}>
          pending
        </a>
        <a className="chip active" href={href("/review", { tab: "suggestions" })}>
          Suggestions
        </a>
      </div>
      <ErrorBox error={error ?? actionError} />
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <section>
            <h2>Recurring root causes</h2>
            <p className="muted small">Findings that keep coming back. Fold them into the article people read first.</p>
            {!data.promote.length && <p className="muted">Nothing recurring right now.</p>}
            <ul className="hits">
              {data.promote.map((p) => (
                <li key={p.finding.id} className="hit">
                  <div className="hit-head">
                    <a href={href(`/finding/${p.finding.id}`)}>{p.finding.title}</a> <ScopeBadge scope={p.finding.scope} />
                  </div>
                  <p className="small muted">
                    {p.recurrences ? `${p.recurrences} linked recurrence${p.recurrences > 1 ? "s" : ""}` : ""}
                    {p.recurrences && p.verifications ? " · " : ""}
                    {p.verifications ? `verified ${p.verifications} times` : ""}
                  </p>
                  {done[p.finding.id] ? (
                    <Notice kind="ok">{done[p.finding.id]}</Notice>
                  ) : p.suggested_article ? (
                    <button
                      className="btn btn-small"
                      onClick={() =>
                        act(
                          p.finding.id,
                          () => api("/promote", { method: "POST", body: { finding_id: p.finding.id, article_id: p.suggested_article!.id, version: p.suggested_article!.version } }),
                          "Promotion proposed",
                        )
                      }
                    >
                      Promote into “{p.suggested_article.title}”
                    </button>
                  ) : (
                    <p className="small muted">No obvious article yet: consider writing a runbook.</p>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Possible duplicates</h2>
            {data.note && <p className="muted small">{data.note}</p>}
            {!data.note && !data.duplicates.length && <p className="muted">No unlinked look-alikes.</p>}
            <ul className="hits">
              {data.duplicates.map((d) => {
                const key = `${d.a.id}:${d.b.id}`;
                return (
                  <li key={key} className="hit">
                    <div>
                      <a href={href(`/finding/${d.a.id}`)}>{d.a.title}</a> <ScopeBadge scope={d.a.scope} />
                    </div>
                    <div>
                      <a href={href(`/finding/${d.b.id}`)}>{d.b.title}</a> <ScopeBadge scope={d.b.scope} />
                    </div>
                    <p className="small muted">{Math.round(d.similarity * 100)}% similar</p>
                    {done[key] ? (
                      <Notice kind="ok">{done[key]}</Notice>
                    ) : (
                      <button className="btn btn-small" onClick={() => act(key, () => api("/links", { method: "POST", body: { from: d.a.id, to: d.b.id, relation: "same_root_cause" } }), "Linked")}>
                        Same root cause
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          <button className="btn" onClick={reload}>
            Refresh
          </button>
        </>
      )}
    </div>
  );
}

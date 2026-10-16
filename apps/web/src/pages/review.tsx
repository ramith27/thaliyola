import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type RevisionSummary } from "../api";
import { Badge, Diff, ErrorBox, formatDate, Loading, Markdown, Notice, ScopeBadge, StatusBadge, TypeBadge } from "../components/ui";
import { useApi, useShortcuts } from "../hooks";
import { href, navigate, type Route } from "../router";

const OP_TEXT: Record<string, string> = { create: "new", update: "edit", promote: "promote", verify: "retire", share: "share", move: "move" };

export function ReviewQueuePage({ route }: { route: Route }) {
  if (route.query.get("tab") === "suggestions") return <SuggestionsPage />;
  return <Queue route={route} />;
}

function Queue({ route }: { route: Route }) {
  const state = route.query.get("state") ?? "pending";
  const mine = route.query.get("mine") === "1";
  const assigned = route.query.get("assigned") === "1";
  const { data, error, reload } = useApi<{ revisions: RevisionSummary[] }>(
    `/revisions?state=${state}${mine ? "&mine=true" : ""}${assigned ? "&assigned=true" : ""}`,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ approved: number; failed: { id: string; error?: string }[] } | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const rows = data?.revisions ?? [];
  const pending = state === "pending";
  const listRef = useRef<HTMLUListElement>(null);

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const keys = useMemo(
    () => ({
      j: () => setCursor((c) => Math.min(c + 1, rows.length - 1)),
      k: () => setCursor((c) => Math.max(c - 1, 0)),
      x: () => pending && rows[cursor] && toggle(rows[cursor]!.id),
      o: () => rows[cursor] && navigate(`/review/${rows[cursor]!.id}`),
      Enter: () => rows[cursor] && navigate(`/review/${rows[cursor]!.id}`),
    }),
    [rows, cursor, pending],
  );
  useShortcuts(keys);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-row="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  async function approveSelected() {
    setBusy(true);
    setActionError(null);
    try {
      const out = await api<{ approved: number; results: { id: string; ok: boolean; error?: string }[] }>("/revisions/bulk-approve", {
        method: "POST",
        body: { ids: [...selected] },
      });
      setResult({ approved: out.approved, failed: out.results.filter((r) => !r.ok) });
      setSelected(new Set());
      reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  const link = (q: Record<string, string | undefined>) => href("/review", { state, mine: mine ? "1" : undefined, assigned: assigned ? "1" : undefined, ...q });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="page">
      <h1>Review</h1>
      <p className="lead">Agent and teammate proposals. Scope owners and admins approve them.</p>
      <div className="filters">
        {["pending", "approved", "rejected"].map((s) => (
          <a key={s} className={`chip ${state === s ? "active" : ""}`} href={link({ state: s })}>
            {s}
          </a>
        ))}
        <a className={`chip ${mine ? "active" : ""}`} href={link({ mine: mine ? undefined : "1" })}>
          Mine only
        </a>
        <a className={`chip ${assigned ? "active" : ""}`} href={link({ assigned: assigned ? undefined : "1" })}>
          Assigned to me
        </a>
        <a className="chip" href={href("/review", { tab: "suggestions" })}>
          Suggestions
        </a>
      </div>
      <ErrorBox error={error ?? actionError} />
      {result && (
        <Notice kind={result.failed.length ? "warn" : "ok"}>
          Approved {result.approved}.
          {result.failed.map((f) => (
            <span key={f.id}>
              {" "}
              <a href={href(`/review/${f.id}`)}>One could not be approved</a>: {f.error}.
            </span>
          ))}
        </Notice>
      )}
      {pending && rows.length > 0 && (
        <div className="bulk-bar">
          <label className="inline">
            <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /> Select all
          </label>
          <button className="btn btn-primary btn-small" disabled={busy || selected.size === 0} onClick={approveSelected}>
            Approve selected{selected.size ? ` (${selected.size})` : ""}
          </button>
          <span className="muted small shortcut-hint">
            <kbd>j</kbd> <kbd>k</kbd> move · <kbd>x</kbd> select · <kbd>o</kbd> open
          </span>
        </div>
      )}
      {!data ? (
        !error && <Loading />
      ) : rows.length === 0 ? (
        <p className="muted">Nothing {state}{assigned ? " assigned to you" : ""}.</p>
      ) : (
        <ul className="hits" ref={listRef}>
          {rows.map((r, i) => (
            <li key={r.id} data-row={i} className={`hit ${pending ? "hit-select" : ""} ${i === cursor ? "hit-cursor" : ""}`} onMouseEnter={() => setCursor(i)}>
              {pending && <input type="checkbox" aria-label={`Select ${r.summary}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />}
              <div>
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
                    {r.assignee ? ` · assigned to ${r.assignee}` : ""}
                    {r.comments ? ` · ${r.comments} comment${r.comments > 1 ? "s" : ""}` : ""}
                    {r.reviewer ? ` · ${r.state} by ${r.reviewer}` : ""}
                  </span>
                </div>
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
  assignee_id: string | null;
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

type Edits = { title?: string; body_md?: string; patch?: Record<string, string> };

/** What the reviewer can edit, pre-filled from the proposal; null if this kind of proposal can't be edited. */
function editableFields(d: RevisionDetail): { fields: { key: string; label: string; value: string; long: boolean }[] } | null {
  const { op, target_kind, current, payload } = d;
  if (op === "create" && target_kind === "article") {
    return { fields: [{ key: "title", label: "Title", value: current.title, long: false }, { key: "body_md", label: "Body", value: current.body_md, long: true }] };
  }
  if (op === "create" && target_kind === "finding") {
    return { fields: FINDING_FIELDS.map(([k, label]) => ({ key: `patch.${k}`, label, value: current[k] ?? "", long: k !== "title" })) };
  }
  if ((op === "update" || op === "promote") && target_kind === "article") {
    return {
      fields: [
        ...(payload.title ? [{ key: "title", label: "Title", value: payload.title as string, long: false }] : []),
        { key: "body_md", label: payload.section ? `New text for “${payload.section}”` : "New body", value: payload.text ?? "", long: true },
      ],
    };
  }
  if (op === "update" && target_kind === "finding") {
    const patch = (payload.patch ?? {}) as Record<string, unknown>;
    return {
      fields: FINDING_FIELDS.filter(([k]) => typeof patch[k] === "string").map(([k, label]) => ({ key: `patch.${k}`, label, value: patch[k] as string, long: k !== "title" })),
    };
  }
  return null;
}

export function RevisionPage({ id }: { id: string }) {
  const { data, error, reload } = useApi<RevisionDetail>(`/revisions/${id}`);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Record<string, string> | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const editable = data ? editableFields(data) : null;
  const canAct = data?.state === "pending" && !data.stale;

  async function decide(action: "approve" | "reject") {
    setBusy(true);
    setActionError(null);
    try {
      let body: unknown = action === "reject" ? { reason } : {};
      if (action === "approve" && editing && editable) {
        const edits: Edits = {};
        for (const f of editable.fields) {
          const v = editing[f.key];
          if (v === undefined || v === f.value) continue;
          if (f.key.startsWith("patch.")) edits.patch = { ...edits.patch, [f.key.slice(6)]: v };
          else (edits as Record<string, string>)[f.key] = v;
        }
        if (Object.keys(edits).length) body = { edits };
      }
      await api(`/revisions/${id}/${action}`, { method: "POST", body });
      setEditing(null);
      reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    const { revisions } = await api<{ revisions: { id: string }[] }>("/revisions?state=pending&limit=200");
    const after = revisions.findIndex((r) => r.id === id);
    const target = revisions[after + 1] ?? revisions.find((r) => r.id !== id);
    navigate(target ? `/review/${target.id}` : "/review");
  }

  const startEdit = () => editable && setEditing(Object.fromEntries(editable.fields.map((f) => [f.key, f.value])));

  const keys = useMemo(
    () => ({
      a: () => canAct && !busy && decide("approve"),
      r: () => data?.state === "pending" && reasonRef.current?.focus(),
      e: () => canAct && !editing && startEdit(),
      n: () => void next(),
      u: () => navigate("/review"),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canAct, busy, data, editing, id],
  );
  useShortcuts(keys);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const itemLink = href(`/${data.target_kind}/${data.target_id}`);

  return (
    <div className="page">
      <p className="muted small">
        <a href={href("/review")}>Review</a> / {OP_TEXT[data.op] ?? data.op}
      </p>
      <h1>{data.summary}</h1>
      <div className="badges">
        <StatusBadge status={data.state} />
        {data.payload.reviewer_edited && <Badge kind="op">edited by reviewer</Badge>}
        <TypeBadge type={data.current.type} />
        <ScopeBadge scope={data.current.scope} />
        <a href={itemLink} className="small">
          Open {data.target_kind}
        </a>
      </div>
      {data.stale && data.state === "pending" && (
        <Notice kind="warn">The {data.target_kind} changed after this was proposed. Approving is refused; reject it and ask for a new proposal.</Notice>
      )}
      {data.state === "pending" && <AssigneePicker id={id} assigneeId={data.assignee_id} onChange={reload} />}

      {editing && editable ? (
        <section className="editor">
          <h2>Edit before approving</h2>
          <p className="muted small">Your changes are applied with the proposal and noted in its history. The author is told it was approved.</p>
          {editable.fields.map((f) => (
            <label key={f.key}>
              {f.label}
              {f.long ? (
                <textarea className="body-input" rows={f.key === "body_md" ? 16 : 5} value={editing[f.key] ?? ""} onChange={(e) => setEditing({ ...editing, [f.key]: e.target.value })} />
              ) : (
                <input value={editing[f.key] ?? ""} onChange={(e) => setEditing({ ...editing, [f.key]: e.target.value })} />
              )}
            </label>
          ))}
        </section>
      ) : (
        <ProposedChange data={data} />
      )}

      {data.state === "pending" && (
        <section className="decide">
          <ErrorBox error={actionError instanceof ApiError && actionError.status === 403 ? new Error(`You can't approve here: ${actionError.message}`) : actionError} />
          <div className="actions">
            <button className="btn btn-primary" disabled={busy || data.stale} onClick={() => decide("approve")}>
              {editing ? "Approve with my edits" : "Approve"}
            </button>
            {editable && !data.stale && (
              <button className="btn" disabled={busy} onClick={() => (editing ? setEditing(null) : startEdit())}>
                {editing ? "Discard edits" : "Edit before approving"}
              </button>
            )}
            <input ref={reasonRef} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for rejecting" aria-label="Reason for rejecting" />
            <button className="btn btn-danger" disabled={busy || !reason.trim()} onClick={() => decide("reject")}>
              Reject
            </button>
          </div>
          <p className="muted small shortcut-hint">
            <kbd>a</kbd> approve · <kbd>e</kbd> edit · <kbd>r</kbd> reject reason · <kbd>n</kbd> next · <kbd>u</kbd> back to queue
          </p>
        </section>
      )}
      {data.state !== "pending" && (
        <p className="actions">
          <button className="btn" onClick={() => navigate("/review")}>
            Back to the queue
          </button>
          <button className="btn" onClick={() => void next()}>
            Next pending
          </button>
        </p>
      )}
      <Comments id={id} />
    </div>
  );
}

function AssigneePicker({ id, assigneeId, onChange }: { id: string; assigneeId: string | null; onChange: () => void }) {
  const { data } = useApi<{ reviewers: { id: string; email: string; name: string }[] }>(`/revisions/${id}/reviewers`);
  const [error, setError] = useState<Error | null>(null);
  if (!data) return null;
  return (
    <div className="assignee">
      <label className="inline small">
        Reviewer
        <select
          value={assigneeId ?? ""}
          onChange={async (e) => {
            setError(null);
            try {
              await api(`/revisions/${id}/assignee`, { method: "PUT", body: { user_id: e.target.value || null } });
              onChange();
            } catch (err) {
              setError(err as Error);
            }
          }}
        >
          <option value="">Unassigned</option>
          {data.reviewers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      {error && <span className="error small">{error.message}</span>}
    </div>
  );
}

function Comments({ id }: { id: string }) {
  const { data, reload } = useApi<{ comments: { id: string; body: string; author: string; created_at: string; mine: boolean }[] }>(`/revisions/${id}/comments`);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  return (
    <section className="comments">
      <h2>Discussion</h2>
      {data && !data.comments.length && <p className="muted small">No comments yet. Ask the author a question or explain a change.</p>}
      <ul className="plain comment-list">
        {data?.comments.map((c) => (
          <li key={c.id} className={c.mine ? "mine" : ""}>
            <div className="comment-head">
              <span className="avatar">{c.author[0]?.toUpperCase()}</span>
              <strong>{c.author}</strong>
              <span className="muted small">{formatDate(c.created_at)}</span>
            </div>
            <Markdown text={c.body} />
          </li>
        ))}
      </ul>
      <form
        className="mini-form wide"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!body.trim()) return;
          setBusy(true);
          setError(null);
          try {
            await api(`/revisions/${id}/comments`, { method: "POST", body: { body } });
            setBody("");
            reload();
          } catch (err) {
            setError(err as Error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment (Markdown)" aria-label="Comment" />
        <ErrorBox error={error} />
        <div>
          <button className="btn btn-small" disabled={busy || !body.trim()}>
            Comment
          </button>
        </div>
      </form>
    </section>
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
  if (op === "move") {
    return (
      <section>
        <h2>Move</h2>
        <dl className="facts">
          <dt>From</dt>
          <dd>
            {current.scope?.slug}
            {current.path ? ` / ${current.path}` : ""}
          </dd>
          <dt>To</dt>
          <dd>
            <strong>{payload.to_name ?? payload.to}</strong>
            {payload.folder ? ` / ${payload.folder}` : target_kind !== "article" ? "" : payload.to === current.scope?.slug ? " (same folder)" : " (top level)"}
            {payload.repo ? ` · repository ${payload.repo}` : ""}
          </dd>
        </dl>
        <p className="muted small">On approval it keeps its history and links; the destination's members and settings apply. Approving needs owner rights in both places.</p>
        <div className="preview-box">
          <h3>{current.title}</h3>
          {target_kind === "article" ? <Markdown text={String(current.body_md ?? "").slice(0, 1500)} /> : <Markdown text={`**Symptoms.** ${current.symptoms}\n\n**Root cause.** ${current.root_cause}`} />}
        </div>
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
      <AgentTasks />
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

const TASK_TEXT: Record<string, string> = {
  file_into_project: "Filed in Team but about a project",
  tag_repository: "Project pages without their repository",
  merge_duplicates: "Look-alike findings",
  promote_recurring: "Recurring problems to fold into articles",
  fill_outline: "Articles with empty sections",
  verify_stale: "Entries to re-check",
  write_overview: "Projects without an overview",
  link_related: "Entries with no links",
  answer_gap: "Searches that found nothing",
};

interface TaskSummary {
  open: number;
  by_kind: Record<string, number>;
  done_this_week: number;
  recent: { key: string; kind: string; outcome: string; note: string | null; completed_at: string; revision_id: string | null; by: string }[];
  sample: { id: string; kind: string; title: string; project: string | null }[];
}

/** Curation work Thaliyola hands to connected Claude sessions, and what they did with it. */
function AgentTasks() {
  const { data } = useApi<TaskSummary>("/tasks");
  if (!data) return null;
  return (
    <section className="card agent-tasks">
      <div className="card-head">
        <div>
          <h3>Work for Claude</h3>
          <p>
            Thaliyola finds what needs judgment; a connected Claude does it with its own model and proposes changes here for review. Run <code>/mcp__thaliyola__curate</code> in Claude
            Code (or ask it to “curate the Thaliyola knowledge base”), or schedule it.
          </p>
        </div>
        <span className="muted small">{data.done_this_week} done this week</span>
      </div>
      {!data.open ? (
        <p className="muted small">Nothing waiting. The knowledge base looks tidy.</p>
      ) : (
        <ul className="plain task-kinds">
          {Object.entries(data.by_kind)
            .sort((a, b) => b[1] - a[1])
            .map(([k, n]) => (
              <li key={k}>
                <span className="metric-count-inline">{n}</span> {TASK_TEXT[k] ?? k}
              </li>
            ))}
        </ul>
      )}
      {data.recent.length > 0 && (
        <details className="small">
          <summary>Recently handled by agents</summary>
          <ul>
            {data.recent.map((r) => (
              <li key={r.key}>
                {TASK_TEXT[r.kind] ?? r.kind}: <strong>{r.outcome.replace("_", " ")}</strong> by {r.by} · {formatDate(r.completed_at)}
                {r.revision_id && (
                  <>
                    {" "}
                    · <a href={href(`/review/${r.revision_id}`)}>proposal</a>
                  </>
                )}
                {r.note && <span className="muted"> · {r.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

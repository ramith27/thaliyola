import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { formatDate } from "./ui";

interface Claim {
  id: string;
  section: string;
  text: string;
  status: "ok" | "stale";
  stale_reason: string | null;
  verified_at: string;
  evidence: { path: string; start?: number; end?: number; sha?: string; url: string | null }[];
}

const where = (e: Claim["evidence"][number]) => `${e.path}${e.start ? `:${e.start}${e.end && e.end !== e.start ? `–${e.end}` : ""}` : ""}`;

/** The grounded facts behind a generated page: each statement, the source lines it rests on, and whether the code has moved since. */
export function ClaimsPanel({ articleId, canEdit }: { articleId: string; canEdit: boolean }) {
  const { data, reload } = useApi<{ claims: Claim[]; stale: number }>(`/items/${articleId}/claims`);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  if (!data?.claims.length) return null;
  const sections = [...new Set(data.claims.map((c) => c.section))];
  async function act(id: string, kind: "confirm" | "retire") {
    setBusy(id);
    try {
      await api(`/items/${articleId}/claims/resolve`, { method: "POST", body: kind === "confirm" ? { confirm: [{ id }] } : { retire: [{ id, reason: "retired in the web app" }] } });
      reload();
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className={`claims-panel ${data.stale ? "has-stale" : ""}`}>
      <button className="claims-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span>
          <strong>Sources</strong> · {data.claims.length} grounded fact{data.claims.length === 1 ? "" : "s"}
          {data.stale > 0 && <span className="badge badge-possibly_stale">{data.stale} may be out of date</span>}
        </span>
        <span className="muted small">{open ? "Hide" : "Show"}</span>
      </button>
      {open && (
        <div className="claims-body">
          <p className="muted small">Each statement on this page points at the code it was written from. When that code changes, the statement is flagged until someone checks it.</p>
          {sections.map((s) => (
            <div key={s || "_"}>
              {s && <h4>{s}</h4>}
              <ul className="plain claim-list">
                {data.claims
                  .filter((c) => c.section === s)
                  .map((c) => (
                    <li key={c.id} className={c.status === "stale" ? "stale" : ""}>
                      <div>{c.text}</div>
                      <div className="claim-evidence small">
                        {c.evidence.map((e, i) =>
                          e.url ? (
                            <a key={i} href={e.url} target="_blank" rel="noopener noreferrer">
                              <code>{where(e)}</code>
                            </a>
                          ) : (
                            <code key={i}>{where(e)}</code>
                          ),
                        )}
                        {c.evidence[0]?.sha && <span className="muted"> @ {c.evidence[0].sha.slice(0, 8)}</span>}
                      </div>
                      {c.status === "stale" ? (
                        <div className="small warn">
                          {c.stale_reason ?? "Its source changed"}
                          {canEdit && (
                            <span className="claim-actions">
                              <button className="link-btn small" disabled={busy === c.id} onClick={() => act(c.id, "confirm")}>
                                Still true
                              </button>
                              <button className="link-btn small danger" disabled={busy === c.id} onClick={() => act(c.id, "retire")}>
                                No longer true
                              </button>
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="muted small">checked {formatDate(c.verified_at)}</div>
                      )}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

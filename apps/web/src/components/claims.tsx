import { useEffect, useId, useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { I } from "./icons";
import { Badge, Button, RelativeTime, useConfirm, useToast } from "./kit";
import { plural } from "./labels";

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

/**
 * Fact check: the statements in a generated page, the code each rests on, and whether that code has moved since.
 * Opens by itself when anything may be out of date. `openSignal` (a counter) opens it from outside, and
 * `onCounts` reports the totals so the page can show its own "may be out of date" callout.
 */
export function ClaimsPanel({
  articleId,
  canEdit,
  openSignal,
  onCounts,
}: {
  articleId: string;
  canEdit: boolean;
  openSignal?: number;
  onCounts?: (c: { total: number; stale: number }) => void;
}) {
  const { data, reload } = useApi<{ claims: Claim[]; stale: number }>(`/items/${articleId}/claims`);
  const [open, setOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const confirm = useConfirm();
  const bodyId = useId();
  const total = data?.claims.length ?? 0;
  const stale = data?.stale ?? 0;

  useEffect(() => {
    if (data) onCounts?.({ total, stale });
  }, [data, total, stale]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (openSignal) setOpen(true);
  }, [openSignal]);

  if (!data?.claims.length) return null;
  const expanded = open ?? stale > 0;
  const sections = [...new Set(data.claims.map((c) => c.section))];

  async function stillTrue(c: Claim) {
    setBusy(c.id);
    try {
      await api(`/items/${articleId}/claims/resolve`, { method: "POST", body: { confirm: [{ id: c.id }] } });
      reload();
      toast.success("Marked as still true");
    } catch (e) {
      toast.error(e, { title: "Couldn't mark it as still true" });
    } finally {
      setBusy(null);
    }
  }

  async function noLongerTrue(c: Claim) {
    const r = await confirm({
      title: "Mark this statement as no longer true?",
      body: <q>{c.text}</q>,
      confirmLabel: "Mark as no longer true",
      reason: { label: "What changed", required: false, maxLength: 300, placeholder: "e.g. the retry limit moved to config" },
    });
    if (!r) return;
    setBusy(c.id);
    try {
      await api(`/items/${articleId}/claims/resolve`, { method: "POST", body: { retire: [{ id: c.id, reason: r.reason?.trim() || "retired in the web app" }] } });
      reload();
      toast.success("Marked as no longer true");
    } catch (e) {
      toast.error(e, { title: "Couldn't mark it as no longer true" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="claims-panel it-fact-check" id="fact-check" aria-labelledby={`${bodyId}-title`} data-stale={stale > 0 || undefined}>
      <button type="button" className="it-fact-check-toggle" onClick={() => setOpen(!expanded)} aria-expanded={expanded} aria-controls={bodyId}>
        <I name={expanded ? "chevron-down" : "chevron-right"} size={16} />
        <span id={`${bodyId}-title`} className="it-fact-check-title">
          Fact check
        </span>
        <span className="it-fact-check-count">· {plural(total, "statement")}</span>
        {stale > 0 && (
          <Badge tone="warning" icon="clock">
            {stale} may be out of date
          </Badge>
        )}
      </button>
      {expanded && (
        <div className="claims-body" id={bodyId}>
          <p className="it-fact-check-lead">Statements in this article that are tied to code. When the code changes, they're flagged here.</p>
          {sections.map((s) => (
            <div key={s || "_"} className="it-claim-group">
              {s && <h3 className="it-claim-section">{s}</h3>}
              <ul className="plain claim-list">
                {data.claims
                  .filter((c) => c.section === s)
                  .map((c) => (
                    <li key={c.id} className="it-claim" data-state={c.status}>
                      <p className="it-claim-text">{c.text}</p>
                      <div className="claim-evidence">
                        {c.evidence.map((e, i) =>
                          e.url ? (
                            <a key={i} href={e.url} target="_blank" rel="noopener noreferrer">
                              <code>{where(e)}</code>
                              <span className="sr-only"> (opens in a new tab)</span>
                            </a>
                          ) : (
                            <code key={i}>{where(e)}</code>
                          ),
                        )}
                        {c.evidence[0]?.sha && <span className="it-claim-sha">at {c.evidence[0].sha.slice(0, 8)}</span>}
                      </div>
                      {c.status === "stale" ? (
                        <div className="it-claim-stale">
                          <span className="it-claim-reason">
                            <I name="alert" size={14} />
                            {c.stale_reason ?? "Its source changed"}
                          </span>
                          {canEdit && (
                            <span className="it-claim-actions">
                              <Button size="sm" loading={busy === c.id} loadingText="Saving" onClick={() => void stillTrue(c)}>
                                Still true
                              </Button>
                              <Button size="sm" variant="ghost" disabledReason={busy === c.id ? "Saving" : undefined} onClick={() => void noLongerTrue(c)}>
                                No longer true…
                              </Button>
                            </span>
                          )}
                        </div>
                      ) : (
                        <p className="it-claim-checked">
                          <RelativeTime date={c.verified_at} prefix="Checked" />
                        </p>
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

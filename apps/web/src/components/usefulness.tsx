import { useState } from "react";
import { api } from "../api";
import { useApi } from "../hooks";
import { ErrorBox, formatDate } from "./ui";

interface Usefulness {
  reads: number;
  quoted: number;
  helpful: number;
  outdated: number;
  wrong: number;
  mine: "helpful" | "outdated" | "wrong" | null;
  reports: { verdict: "outdated" | "wrong"; note: string | null; via_agent: boolean; created_at: string; by: string }[];
}

/**
 * "Was this useful?" under an article or finding: helpful, or outdated / wrong with what's changed (the owner is
 * told; two reports mark it possibly stale). Helpful items rank higher in search. Shows reads and open reports.
 */
export function UsefulnessBar({ id }: { id: string }) {
  const { data, reload } = useApi<Usefulness>(`/items/${id}/usefulness`);
  const [reporting, setReporting] = useState<"outdated" | "wrong" | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const send = async (verdict: "helpful" | "outdated" | "wrong", text?: string) => {
    setBusy(true);
    setError(null);
    try {
      await api(`/items/${id}/feedback`, { method: "POST", body: { verdict, ...(text ? { note: text } : {}) } });
      setReporting(null);
      setNote("");
      reload();
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="useful card" aria-label="Was this useful?">
      <div className="useful-row">
        <span className="small">Was this useful?</span>
        <button className={`btn btn-small${data.mine === "helpful" ? " btn-primary" : ""}`} disabled={busy} onClick={() => void send("helpful")}>
          Helpful{data.helpful ? ` · ${data.helpful}` : ""}
        </button>
        <button className={`btn btn-small${data.mine === "outdated" ? " btn-primary" : ""}`} disabled={busy} onClick={() => setReporting("outdated")}>
          Outdated
        </button>
        <button className={`btn btn-small${data.mine === "wrong" ? " btn-primary" : ""}`} disabled={busy} onClick={() => setReporting("wrong")}>
          Wrong
        </button>
        <span className="small muted useful-reads">
          Read {data.reads} time{data.reads === 1 ? "" : "s"}
          {data.quoted ? `, quoted ${data.quoted}` : ""} in 90 days
        </span>
      </div>
      {reporting && (
        <form
          className="useful-form"
          onSubmit={(e) => {
            e.preventDefault();
            void send(reporting, note.trim());
          }}
        >
          <label className="small" htmlFor={`useful-note-${id}`}>
            What's {reporting === "outdated" ? "out of date" : "wrong"}? The owner is told.
          </label>
          <textarea id={`useful-note-${id}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} required />
          <div className="useful-row">
            <button className="btn btn-small btn-primary" type="submit" disabled={busy || !note.trim()}>
              Report
            </button>
            <button className="btn btn-small" type="button" onClick={() => setReporting(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {data.reports.length > 0 && (
        <ul className="useful-reports small">
          {data.reports.map((r, i) => (
            <li key={i}>
              <strong>{r.verdict === "wrong" ? "Wrong" : "Outdated"}</strong>: {r.note} <span className="muted">({r.by}{r.via_agent ? " via Claude" : ""}, {formatDate(r.created_at)})</span>
            </li>
          ))}
        </ul>
      )}
      <ErrorBox error={error} />
    </section>
  );
}

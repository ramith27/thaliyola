import { useState } from "react";
import { api } from "../api";
import { href, navigate } from "../router";
import { ErrorBox, Notice } from "./ui";

const SYSTEMS = ["figma", "pr", "sentry", "slack", "trello", "dashboard", "repo", "other"];

export function AddLinkForm({ targetId, onAdded }: { targetId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [system, setSystem] = useState("figma");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<Error | null>(null);

  if (!open)
    return (
      <button className="link-btn small" onClick={() => setOpen(true)}>
        + Add link (Figma, PR, Sentry…)
      </button>
    );
  return (
    <form
      className="mini-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api(`/items/${targetId}/links`, { method: "POST", body: { system, url, label: label || undefined } });
          setOpen(false);
          setUrl("");
          setLabel("");
          onAdded();
        } catch (err) {
          setError(err as Error);
        }
      }}
    >
      <select value={system} onChange={(e) => setSystem(e.target.value)} aria-label="Link type">
        {SYSTEMS.map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
      <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="URL" />
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" aria-label="Label" />
      <div className="actions">
        <button className="btn btn-small btn-primary" type="submit">
          Add
        </button>
        <button className="btn btn-small" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <ErrorBox error={error} />
    </form>
  );
}

/** Offers to publish a project/team item to the Library (reviewed by library owners). */
export function ShareToLibrary({ id, scopeKind, status, publishedAs }: { id: string; scopeKind: string; status: string; publishedAs?: string }) {
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState<string | null>(null);

  if (scopeKind === "library" || (status !== "published" && status !== "possibly_stale")) return null;
  if (publishedAs)
    return (
      <p className="small muted">
        Shared in the library: <a href={href(`/article/${publishedAs}`)}>open the library copy</a>
      </p>
    );
  if (revision)
    return (
      <Notice>
        Proposed for the library. <a href={href(`/review/${revision}`)}>View the proposal</a>
      </Notice>
    );
  if (!open)
    return (
      <button className="btn" onClick={() => setOpen(true)} title="Let other projects reuse this">
        Share to library
      </button>
    );
  return (
    <form
      className="mini-form wide"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const res = await api<{ revision_id: string }>(`/share/${id}`, { method: "POST", body: { summary, path: path || undefined } });
          setRevision(res.revision_id);
        } catch (err) {
          setError(err as Error);
        }
      }}
    >
      <input required value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Why should other projects reuse this?" aria-label="Reason" />
      <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Library folder, e.g. UI components" aria-label="Library folder" />
      <div className="actions">
        <button className="btn btn-small btn-primary" type="submit">
          Propose
        </button>
        <button className="btn btn-small" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <ErrorBox error={error} />
    </form>
  );
}

/** Admins only: permanently delete an item (leaked secret, personal data). Needs a reason and the exact title. */
export function PurgeZone({ id, title, kind }: { id: string; title: string; kind: "article" | "finding" }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  if (!open)
    return (
      <div className="purge-zone">
        <button className="link-btn small danger" onClick={() => setOpen(true)}>
          Purge this {kind} permanently…
        </button>
      </div>
    );
  return (
    <section className="purge-zone open" aria-label="Purge">
      <h3>Purge permanently</h3>
      <p className="small">
        Deletes this {kind} with its history, proposals, comments, links and attachments. It can't be undone, and only the reason is kept. Use it for content that must
        not exist (a leaked secret, personal data). To retire something that's simply wrong, mark it no longer valid instead.
      </p>
      <form
        className="mini-form wide"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api(`/purge/${id}`, { method: "POST", body: { reason, confirm_title: confirm } });
            navigate("/");
          } catch (err) {
            setError(err as Error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="small">
          Reason (kept in the purge log)
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. contained a production database password" required minLength={5} />
        </label>
        <label className="small">
          Type the title to confirm: <strong>{title}</strong>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        <ErrorBox error={error} />
        <div className="actions">
          <button className="btn btn-danger" disabled={busy || confirm.trim() !== title.trim() || reason.trim().length < 5}>
            {busy ? "Purging…" : "Purge permanently"}
          </button>
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

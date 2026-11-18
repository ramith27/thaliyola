import { useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { href, navigate } from "../router";
import { Button, Dialog, ErrorState, Field, IconButton, Select, TextInput, Textarea, focusFirstInvalid, useToast } from "./kit";
import { LINK_SYSTEM } from "./labels";

const SYSTEMS = ["figma", "pr", "sentry", "slack", "trello", "dashboard", "repo", "other"];

const isUrl = (s: string) => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

/**
 * "+" (Add link) for the External links card: a dialog with the system, the URL and an optional label.
 * POST /items/:id/links, then the toast "Link added".
 */
export function AddLinkForm({ targetId, onAdded }: { targetId: string; onAdded: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [system, setSystem] = useState("figma");
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null);

  function close() {
    setOpen(false);
    setUrlError(null);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = !url.trim() ? "Enter the link's address" : !isUrl(url.trim()) ? "Enter a full address that starts with https://" : null;
    setUrlError(bad);
    if (bad) return requestAnimationFrame(() => focusFirstInvalid(form.current));
    setBusy(true);
    setError(null);
    try {
      await api(`/items/${targetId}/links`, { method: "POST", body: { system, url: url.trim(), label: label.trim() || undefined } });
      setUrl("");
      setLabel("");
      close();
      onAdded();
      toast.success("Link added");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <IconButton icon="plus" size="sm" label="Add link" onClick={() => setOpen(true)} aria-haspopup="dialog" />
      <Dialog
        open={open}
        onClose={close}
        dismissible={!busy}
        title="Add an external link"
        description="A Figma file, pull request, Sentry issue, Slack thread or dashboard that belongs with this page."
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={`it-link-${targetId}`} loading={busy} loadingText="Adding">
              Add link
            </Button>
          </>
        }
      >
        <form id={`it-link-${targetId}`} ref={form} className="it-dialog-form" noValidate onSubmit={submit}>
          <Field label="System">
            <Select value={system} onChange={(e) => setSystem(e.target.value)} options={SYSTEMS.map((s) => ({ value: s, label: LINK_SYSTEM[s] ?? s }))} />
          </Field>
          <Field label="Address" error={urlError}>
            <TextInput type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoComplete="off" />
          </Field>
          <Field label="Label" optional hint="Shown instead of the address.">
            <TextInput value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} />
          </Field>
          {!!error && <ErrorState compact error={error} title="Couldn't add the link" />}
        </form>
      </Dialog>
    </>
  );
}

/** Share to library is offered for project, team and personal items that are published or need a check. */
export function canShareToLibrary(scopeKind: string, status: string) {
  return scopeKind !== "library" && (status === "published" || status === "possibly_stale");
}

/**
 * Share to library: proposes publishing a copy in the Library (reviewed there). A dialog with the required reason
 * and an optional library folder. On success: `onProposed(revision)` and the toast "Proposed for the library".
 */
export function ShareToLibrary({ id, open, onClose, onProposed }: { id: string; open: boolean; onClose: () => void; onProposed: (revisionId: string) => void }) {
  const toast = useToast();
  const [summary, setSummary] = useState("");
  const [path, setPath] = useState("");
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = summary.trim() ? null : "Say why other projects should reuse this";
    setSummaryError(bad);
    if (bad) return requestAnimationFrame(() => focusFirstInvalid(form.current));
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ revision_id: string }>(`/share/${id}`, { method: "POST", body: { summary: summary.trim(), path: path.trim() || undefined } });
      onProposed(res.revision_id);
      onClose();
      toast.success("Proposed for the library", { link: { label: "View proposal", href: href(`/review/${res.revision_id}`) } });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Share to the library"
      description="Other projects can reuse a library copy. People who review the Library approve it first."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={`it-share-${id}`} loading={busy} loadingText="Proposing">
            Propose
          </Button>
        </>
      }
    >
      <form id={`it-share-${id}`} ref={form} className="it-dialog-form" noValidate onSubmit={submit}>
        <Field label="Why should other projects reuse this?" error={summaryError} counter={{ value: summary.length, max: 300 }}>
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} minRows={2} autoGrow />
        </Field>
        <Field label="Library folder" optional hint="Where it goes in the Library, e.g. UI components.">
          <TextInput value={path} onChange={(e) => setPath(e.target.value)} />
        </Field>
        {!!error && <ErrorState compact error={error} title="Couldn't propose it" />}
      </form>
    </Dialog>
  );
}

/**
 * Delete permanently (people with Delete permanently): a danger dialog with a required reason (at least 5
 * characters, kept in the log) and the exact title typed to confirm. On success: home, then "Deleted permanently".
 */
export function PurgeZone({ id, title, kind, open, onClose }: { id: string; title: string; kind: "article" | "finding"; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reasonOk = reason.trim().length >= 5;
  const titleOk = typed.trim() === title.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!reasonOk || !titleOk) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/purge/${id}`, { method: "POST", body: { reason: reason.trim(), confirm_title: typed } });
      onClose();
      navigate("/");
      toast.success("Deleted permanently");
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      size="md"
      title={`Delete “${title}” permanently?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger-solid"
            type="submit"
            form={`it-purge-${id}`}
            loading={busy}
            loadingText="Deleting"
            disabledReason={!reasonOk ? "Give a reason of at least 5 characters" : !titleOk ? "Type the title exactly to confirm" : undefined}
          >
            Delete permanently
          </Button>
        </>
      }
    >
      <form id={`it-purge-${id}`} className="it-dialog-form" noValidate onSubmit={submit}>
        <p className="it-dialog-text">
          This deletes the {kind} with its history, proposals, comments, links and files. It can't be undone; only the reason is kept. Use it for content that must not exist,
          such as a leaked secret or personal data. To retire something that's simply wrong, move it to the trash instead.
        </p>
        <Field label="Reason" hint="Kept in the log of permanent deletions. At least 5 characters.">
          <TextInput value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. contained a production database password" minLength={5} autoComplete="off" />
        </Field>
        <Field
          label={
            <>
              Type the title to confirm: <strong>{title}</strong>
            </>
          }
        >
          <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        {!!error && <ErrorState compact error={error} title="Couldn't delete it" />}
      </form>
    </Dialog>
  );
}

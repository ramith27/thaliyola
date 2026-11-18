import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type ItemTickets, type Ticket, type TrackerOption } from "../api";
import { I } from "./icons";
import { statusMeta } from "./labels";
import { Badge, Button, Card, Dialog, ErrorState, Field, IconButton, RelativeTime, Select, Skeleton, Textarea, TextInput, focusFirstInvalid, useToast } from "./kit";

/**
 * Jira and Linear tickets on a finding or article (item page): the Tickets card in the rail, "Create ticket…" (⋯ menu)
 * and "Link a ticket". The server refreshes each ticket's status when the page asks for them and the cached status is
 * over five minutes old.
 */

/** "Jira issue in OPS" / "Linear issue in ENG", for the create dialog. */
export function trackerLine(t: TrackerOption): string {
  return `${t.label} issue in ${t.destination ?? "the default project"}`;
}

/** Whether the URL looks like a Jira or Linear issue (the server decides; this only catches typos early). */
export function looksLikeTicketUrl(url: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.(atlassian\.net|jira\.com)\/\S*[A-Z][A-Z0-9_]*-\d+/i.test(url) || /^https:\/\/linear\.app\/[^/\s]+\/issue\/[A-Za-z0-9_]+-\d+/i.test(url);
}

function TicketRow({ t }: { t: Ticket }) {
  const meta = statusMeta("ticket", t.category);
  return (
    <li className="it-rail-row it-ticket">
      <span className="it-ticket-head">
        <a href={t.url} target="_blank" rel="noopener noreferrer nofollow" className="it-external it-ticket-key">
          {t.key}
          <I name="external" size={12} />
          <span className="sr-only"> (opens {t.label} in a new tab)</span>
        </a>
        <Badge tone={meta.tone} variant={meta.outline ? "outline" : "soft"} icon={meta.icon} title={t.status ? `${t.label} status: ${t.status}` : undefined}>
          {t.status || meta.label}
        </Badge>
      </span>
      {t.title && <span className="it-ticket-title">{t.title}</span>}
      <span className="it-rail-meta">
        {t.label}
        {t.connected ? (
          t.checked_at ? (
            <>
              {" · "}
              <RelativeTime date={t.checked_at} prefix="checked" />
            </>
          ) : null
        ) : t.error ? null : (
          " · no connection reads its status"
        )}
      </span>
      {t.error && (
        <span className="it-ticket-error">
          <I name="alert" size={12} /> {t.error}
        </span>
      )}
    </li>
  );
}

export function TicketsCard({ result, canLink, onLink }: { result: { data: ItemTickets | null; error: unknown; loading: boolean }; canLink: boolean; onLink: () => void }) {
  const tickets = result.data?.tickets ?? [];
  if (!canLink && !tickets.length) return null;
  return (
    <Card
      title="Tickets"
      padding="sm"
      as="section"
      actions={canLink ? <IconButton icon="plus" size="sm" label="Link a ticket" onClick={onLink} aria-haspopup="dialog" /> : undefined}
    >
      {!result.data && result.loading ? (
        <Skeleton height={40} />
      ) : !result.data && result.error ? (
        <p className="it-rail-empty">Couldn't load tickets.</p>
      ) : !tickets.length ? (
        <p className="it-rail-empty">No tickets yet. Create one from the ⋯ menu, or link a Jira or Linear issue.</p>
      ) : (
        <ul className="it-rail-list">
          {tickets.map((t) => (
            <TicketRow key={t.id} t={t} />
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Create ticket: opens an issue through one of the trackers the item can use, linking back to the item. */
export function CreateTicketDialog({
  id,
  kind,
  title,
  data,
  open,
  onClose,
  onCreated,
}: {
  id: string;
  kind: "article" | "finding";
  title: string;
  data: ItemTickets | null;
  open: boolean;
  onClose: () => void;
  onCreated: (t: Ticket) => void;
}) {
  const toast = useToast();
  const trackers = data?.trackers ?? [];
  const [tracker, setTracker] = useState("");
  const [name, setName] = useState(title);
  const [description, setDescription] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open) return;
    setTracker((t) => (trackers.some((x) => x.id === t) ? t : (trackers[0]?.id ?? "")));
    setName((n) => n || title);
    setError(null);
  }, [open, trackers, title]);

  const chosen = trackers.find((t) => t.id === tracker) ?? trackers[0];

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = name.trim() ? null : "Give the ticket a title";
    setNameError(bad);
    if (bad) return requestAnimationFrame(() => focusFirstInvalid(form.current));
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ticket: Ticket }>(`/items/${id}/tickets`, {
        method: "POST",
        body: { connection: chosen?.id, title: name.trim(), description: description.trim() || undefined },
      });
      onCreated(res.ticket);
      setDescription("");
      onClose();
      toast.success(`Created ${res.ticket.key}`, { link: { label: `Open in ${res.ticket.label}`, href: res.ticket.url } });
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
      title="Create a ticket"
      description={`Opens an issue for this ${kind}. Its description ends with a link back here, and the ticket shows on this page with its status.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={`it-ticket-${id}`} loading={busy} loadingText="Creating" disabledReason={!chosen ? "No issue tracker to create it in" : undefined}>
            Create ticket
          </Button>
        </>
      }
    >
      <form id={`it-ticket-${id}`} ref={form} className="it-dialog-form" noValidate onSubmit={submit}>
        {trackers.length > 1 ? (
          <Field label="Tracker" hint={chosen ? `${trackerLine(chosen)}, as the connection's account.` : undefined}>
            <Select
              value={chosen?.id ?? ""}
              onChange={(e) => setTracker(e.target.value)}
              options={trackers.map((t) => ({ value: t.id, label: `${t.name} (${t.destination ?? t.label})${t.scope_name ? ` · ${t.scope_name}` : ""}` }))}
            />
          </Field>
        ) : chosen ? (
          <p className="it-dialog-text">
            <I name="ticket" size={16} /> {trackerLine(chosen)}, through {chosen.name}
            {chosen.health === "failing" ? " (its last check failed)" : ""}.
          </p>
        ) : null}
        <Field label="Title" error={nameError} counter={{ value: name.length, max: 250 }}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={250} autoComplete="off" />
        </Field>
        <Field label="Description" optional hint={kind === "finding" ? "Leave empty to use the finding's symptoms, root cause and fix." : "Leave empty to use the article's opening."}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} autoGrow minRows={4} maxRows={12} maxLength={8000} />
        </Field>
        {!!error && <ErrorState compact error={error} title="Couldn't create the ticket" />}
      </form>
    </Dialog>
  );
}

/** Link a ticket: attaches an existing Jira or Linear issue by its URL. */
export function LinkTicketDialog({ id, open, onClose, onLinked }: { id: string; open: boolean; onClose: () => void; onLinked: (t: Ticket) => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const form = useRef<HTMLFormElement>(null);

  function close() {
    setUrlError(null);
    setError(null);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = url.trim();
    const bad = !v ? "Paste the issue's address" : !looksLikeTicketUrl(v) ? "Use a Jira issue (…atlassian.net/browse/OPS-12) or Linear issue (linear.app/…/issue/ENG-42) address" : null;
    setUrlError(bad);
    if (bad) return requestAnimationFrame(() => focusFirstInvalid(form.current));
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ ticket: Ticket; already_linked?: boolean; note?: string }>(`/items/${id}/tickets/link`, { method: "POST", body: { url: v } });
      onLinked(res.ticket);
      setUrl("");
      close();
      if (res.already_linked) toast.info(`${res.ticket.key} is already linked`);
      else toast.success(`Linked ${res.ticket.key}`, res.note ? { description: res.note } : undefined);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      dismissible={!busy}
      title="Link a ticket"
      description="Attach a Jira or Linear issue that's about this page. Its status shows here, read through the project's tracker connection."
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={`it-link-ticket-${id}`} loading={busy} loadingText="Linking">
            Link ticket
          </Button>
        </>
      }
    >
      <form id={`it-link-ticket-${id}`} ref={form} className="it-dialog-form" noValidate onSubmit={submit}>
        <Field label="Issue address" error={urlError}>
          <TextInput type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-team.atlassian.net/browse/OPS-12" autoComplete="off" />
        </Field>
        {!!error && <ErrorState compact error={error} title="Couldn't link the ticket" />}
      </form>
    </Dialog>
  );
}

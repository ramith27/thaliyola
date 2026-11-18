import { useState, type ReactNode } from "react";
import { api } from "../api";
import { Badge, Button, ChoiceCards, Dialog, ErrorState, SecretReveal, StatusBadge, useConfirm } from "./kit";

/**
 * API tokens, shared by Account › API tokens and Admin › Service accounts: their status, the "unused" flag and the
 * Rotate dialog (a new token with the same name and lifetime, shown once; the old one keeps working for the grace
 * period chosen here, then expires).
 */

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  rotated_at?: string | null;
  replaced_by?: string | null;
  /** Working, and not used for 90 days (or never used and older than that). */
  unused?: boolean;
}

const DAY = 86_400_000;

export const shortDate = (d: string) => new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export type TokenStatus = "active" | "expiring" | "expired" | "revoked" | "replaced";

export function tokenStatus(t: ApiToken): TokenStatus {
  if (t.revoked_at) return "revoked";
  const left = t.expires_at ? new Date(t.expires_at).getTime() - Date.now() : Infinity;
  if (left <= 0) return "expired";
  if (t.rotated_at) return "replaced";
  return left <= 7 * DAY ? "expiring" : "active";
}

/** Only working tokens that haven't been replaced yet can be rotated. */
export const canRotate = (t: ApiToken) => ["active", "expiring"].includes(tokenStatus(t));

/** "Revoked", "Never", "12 Mar 2027", or "Works until 14 Nov 2026" for a replaced token. */
export function tokenExpiryText(t: ApiToken) {
  if (t.revoked_at) return "Revoked";
  if (!t.expires_at) return "Never";
  return tokenStatus(t) === "replaced" ? `Works until ${shortDate(t.expires_at)}` : shortDate(t.expires_at);
}

/** The status badge, plus the "Unused 90+ days" flag when it applies. */
export function TokenStatusCell({ token }: { token: ApiToken }) {
  return (
    <span className="pp-token-status">
      <StatusBadge domain="token" value={tokenStatus(token)} />
      {token.unused && <StatusBadge domain="token" value="unused" />}
    </span>
  );
}

/** How many working tokens are flagged unused, as a badge (nothing when none). */
export function UnusedCount({ tokens }: { tokens: ApiToken[] }) {
  const n = tokens.filter((t) => t.unused).length;
  if (!n) return null;
  return (
    <Badge tone="warning" icon="clock">
      {n === 1 ? "1 token unused 90+ days" : `${n} tokens unused 90+ days`}
    </Badge>
  );
}

type Grace = "none" | "1d" | "7d";

export interface RotateResult {
  id: string;
  name: string;
  token: string;
  expires_at: string | null;
  lifetime_days: number | null;
  replaced: { id: string; name: string; grace: Grace; works_until: string | null };
}

/**
 * Rotate: choose how long the old token keeps working, then copy the new one (shown once). `path` is the rotate
 * endpoint; `extra` renders under the new token (e.g. how to connect Claude Code with it).
 */
export function RotateTokenDialog({
  token,
  path,
  who,
  onClose,
  onRotated,
  extra,
}: {
  token: ApiToken;
  path: string;
  /** Who uses it, for the sentences: "your tools" or "AutoCode". */
  who: string;
  onClose: () => void;
  onRotated: () => void;
  extra?: (secret: string) => ReactNode;
}) {
  const [grace, setGrace] = useState<Grace>("1d");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<RotateResult | null>(null);
  const confirm = useConfirm();
  const lifetime = token.expires_at ? Math.max(1, Math.round((new Date(token.expires_at).getTime() - new Date(token.created_at).getTime()) / DAY)) : null;

  const closeAfterReveal = async () => {
    const ok = await confirm({
      title: "Close without copying the token?",
      body: "The new token is shown only once. After you close this you can't see it again; you'd have to rotate again.",
      confirmLabel: "Close anyway",
      cancelLabel: "Keep it open",
      tone: "danger",
    });
    if (ok) onClose();
  };

  const oldLine = (r: RotateResult) =>
    r.replaced.works_until ? `The old token keeps working until ${shortDate(r.replaced.works_until)}, then stops.` : "The old token has stopped working.";

  return (
    <Dialog
      open
      title={done ? `${done.name}: copy the new token now` : `Rotate ${token.name}?`}
      description={done ? undefined : `A new token called ${token.name} that ${lifetime ? `lasts ${lifetime} ${lifetime === 1 ? "day" : "days"}` : "doesn't expire"}, like this one. Put it into ${who}, then the old one stops.`}
      dismissible={!busy}
      onClose={done ? () => void closeAfterReveal() : onClose}
    >
      {done ? (
        <SecretReveal title="New token" value={done.token} warning={`Copy it now: it won't be shown again. ${oldLine(done)}`} onDone={onClose} extra={extra?.(done.token)} />
      ) : (
        <form
          className="pp-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const res = await api<RotateResult>(path, { method: "POST", body: { grace } });
              setDone(res);
              onRotated();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <ChoiceCards
            name="grace"
            legend="The old token"
            value={grace}
            onChange={(v) => setGrace(v as Grace)}
            options={[
              { value: "none", label: "Stops now", description: "Anything still using it stops at once." },
              { value: "1d", label: "Keeps working for 1 day", description: `Time to switch ${who} over.` },
              { value: "7d", label: "Keeps working for 7 days", description: "For tools that are hard to update quickly." },
            ]}
          />
          {error ? <ErrorState compact error={error} title="Couldn't rotate the token" /> : null}
          <div className="pp-form-actions">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" icon="refresh" loading={busy} loadingText="Rotating">
              Rotate token
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

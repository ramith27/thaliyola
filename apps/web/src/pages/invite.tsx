import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, authApi, canIn, type Me, type ScopeInfo } from "../api";
import { usePageMeta } from "../components/boot";
import { useApi } from "../hooks";
import { RolePicker, roleNames, useRoles } from "../components/roles";
import {
  AsyncBlock,
  Button,
  Callout,
  DataTable,
  Disclosure,
  ErrorState,
  Field,
  focusFirstInvalid,
  GateCard,
  OverflowMenu,
  PasswordInput,
  ProjectPicker,
  RelativeTime,
  Section,
  SecretReveal,
  SkeletonRows,
  SkeletonText,
  StatusBadge,
  TextInput,
  useConfirm,
  useToast,
  type Column,
} from "../components/kit";

/** Accepting an invitation link (no account yet): choose a password, then you're signed in. */
export function InviteAcceptPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [info, setInfo] = useState<{ email: string; name: string | null; inviter: string } | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ password?: string; repeat?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  usePageMeta({ title: "Join Thaliyola" });

  useEffect(() => {
    authApi<{ email: string; name: string | null; inviter: string }>(`/invite/${encodeURIComponent(token)}`)
      .then((i) => {
        setInfo(i);
        setName(i.name ?? "");
      })
      .catch((e) => setInvalid(e instanceof ApiError ? e.message : "This invitation can't be opened."));
  }, [token]);

  const mismatch = repeat.length > 0 && password !== repeat ? "The passwords don't match." : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (password.length < 10) next.password = "Use at least 10 characters.";
    if (password !== repeat) next.repeat = "The passwords don't match.";
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi(`/invite/${encodeURIComponent(token)}`, { password, name: name || undefined });
      window.location.hash = "#/";
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (invalid)
    return (
      <GateCard title="This invitation can't be used" icon="mail" footer={<a href="#/">Go to sign in</a>}>
        <Callout tone="warning" title={invalid}>
          Ask whoever invited you to send a new invitation.
        </Callout>
      </GateCard>
    );
  if (!info)
    return (
      <GateCard title="Join Thaliyola" icon="mail">
        <div aria-busy="true">
          <span className="sr-only" role="status">
            Opening your invitation
          </span>
          <SkeletonText lines={4} />
        </div>
      </GateCard>
    );
  return (
    <GateCard
      title="Join Thaliyola"
      icon="mail"
      description={
        <p>
          <strong>{info.inviter}</strong> invited <strong>{info.email}</strong> to your team's knowledge base. Choose a password to finish.
        </p>
      }
    >
      <form ref={formRef} className="pp-gate-form" noValidate onSubmit={submit}>
        <Field label="Email" hint="The address you were invited with.">
          <TextInput type="email" value={info.email} autoComplete="username" readOnly />
        </Field>
        <Field label="Your name" optional>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </Field>
        <Field label="Password" hint="At least 10 characters." error={errors.password}>
          <PasswordInput autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} autoFocus />
        </Field>
        <Field label="Repeat password" error={errors.repeat ?? mismatch}>
          <PasswordInput autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        {error ? <ErrorState compact error={error} title="Couldn't finish setting up" /> : null}
        <Button variant="primary" size="lg" block type="submit" loading={busy} loadingText="Setting up…">
          Join Thaliyola
        </Button>
      </form>
    </GateCard>
  );
}

interface Invitation {
  id: string;
  email: string;
  name: string | null;
  created_at: string;
  expires_at: string;
  invited_by: string;
  scope: string | null;
  scope_role: string | null;
  scope_name?: string | null;
  scope_roles?: string[];
  scope_role_names?: string[];
  state: "open" | "accepted" | "revoked" | "expired";
}

/**
 * The invitation form (People › Add people): email, and optionally roles in one project where the inviter may give
 * them. Shows the result in place: "Invitation emailed" or the link to send yourself.
 */
export function InviteForm({
  scopes,
  me,
  onSent,
  onDone,
  onSecret,
}: {
  scopes: ScopeInfo[];
  me?: Me;
  onSent?: () => void;
  onDone?: () => void;
  /** Tells a surrounding dialog when the one-time invitation link is on screen ("invitation link"), or gone (null). */
  onSecret?: (what: string | null) => void;
}) {
  const catalog = useRoles();
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState("");
  const [roles, setRoles] = useState<string[]>(["writer"]);
  const [emailError, setEmailError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState<{ email: string; emailed: boolean; link: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const linkShown = Boolean(sent && !sent.emailed);
  useEffect(() => {
    onSecret?.(linkShown ? "invitation link" : null);
    return () => onSecret?.(null);
  }, [linkShown]); // eslint-disable-line react-hooks/exhaustive-deps
  // Only projects where the inviter may give roles.
  const projects = scopes.filter((s) => s.kind === "project" && canIn(s, "manage_members", me));

  if (sent)
    return sent.emailed ? (
      <div className="pp-form">
        <Callout tone="success" title={`Invitation emailed to ${sent.email}.`}>
          The link works once and expires after 7 days.
        </Callout>
        <div className="pp-form-actions">
          <Button onClick={() => setSent(null)}>Invite someone else</Button>
          {onDone && (
            <Button variant="primary" onClick={onDone}>
              Done
            </Button>
          )}
        </div>
      </div>
    ) : (
      <SecretReveal
        title="Invitation link"
        value={sent.link}
        warning={`Email isn't set up on this server, so send ${sent.email} this link yourself:`}
        doneLabel="Done"
        onDone={() => (onDone ? onDone() : setSent(null))}
      />
    );

  return (
    <form
      ref={formRef}
      className="pp-form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const bad = !email.trim() ? "Enter the email to invite." : !/^\S+@\S+\.\S+$/.test(email.trim()) ? "Enter an email address like name@company.com." : undefined;
        setEmailError(bad);
        if (bad) {
          requestAnimationFrame(() => focusFirstInvalid(formRef.current));
          return;
        }
        setBusy(true);
        setError(null);
        try {
          const res = await api<{ email: string; emailed: boolean; link: string }>("/invitations", {
            method: "POST",
            body: { email: email.trim(), scope: scope || undefined, roles: scope ? roles : undefined },
          });
          setSent(res);
          setEmail("");
          setScope("");
          setRoles(["writer"]);
          if (res.emailed) toast.success(`Invitation emailed to ${res.email}`);
          onSent?.();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Email to invite" error={emailError}>
        <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" />
      </Field>
      {projects.length > 0 && (
        <div className="pp-form-row">
          <Field label="Add to project" optional>
            <ProjectPicker searchable value={scope} onChange={setScope} scopes={scopes} includeSpaces={false} noneLabel="No project" filter={(s) => projects.some((p) => p.slug === s.slug)} />
          </Field>
          <Field label="Project roles" hint={scope ? undefined : "Choose a project first."}>
            <RolePicker roles={catalog.data?.roles} kind="project" value={roles} onChange={setRoles} label="Project roles" required empty="choose project roles" disabled={!scope} />
          </Field>
        </div>
      )}
      <p className="pp-inline-note">Organisation roles (User manager, Auditor, …) are given in the People table below once they've accepted.</p>
      {error ? <ErrorState compact error={error} title="Couldn't send the invitation" /> : null}
      <div className="pp-form-actions">
        <Button variant="primary" type="submit" icon="mail" loading={busy} loadingText="Sending">
          Send invitation
        </Button>
      </div>
    </form>
  );
}

/** People page (Manage people, local sign-in): the invitations sent, open ones first, the rest under History. */
export function Invitations({ scopes, me: _me, refreshKey = 0 }: { scopes: ScopeInfo[]; me?: Me; refreshKey?: number }) {
  const result = useApi<{ invitations: Invitation[] }>("/invitations");
  const catalog = useRoles();
  const confirm = useConfirm();
  const toast = useToast();
  const { reload } = result;
  useEffect(() => {
    if (refreshKey) reload();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const invitedTo = (i: Invitation) =>
    i.scope
      ? `${i.scope_name ?? scopes.find((s) => s.slug === i.scope)?.name ?? i.scope} · ${(i.scope_role_names?.length ? i.scope_role_names : [roleNames(catalog.data?.roles, i.scope_roles ?? (i.scope_role ? [i.scope_role] : []))]).join(", ")}`
      : "—";

  async function revoke(i: Invitation) {
    const ok = await confirm({ title: `Revoke the invitation to ${i.email}?`, body: "The link stops working. You can invite them again later.", confirmLabel: "Revoke", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/invitations/${i.id}`, { method: "DELETE" });
      toast.success(`Invitation to ${i.email} revoked`);
      reload();
    } catch (err) {
      toast.error(err, { title: "Couldn't revoke the invitation" });
    }
  }

  const columns: Column<Invitation>[] = [
    { key: "email", header: "Email", cell: (i) => i.email },
    { key: "project", header: "Project", cell: (i) => invitedTo(i) },
    { key: "state", header: "State", cell: (i) => <StatusBadge domain="invite" value={i.state} /> },
    {
      key: "sent",
      header: "Sent",
      cell: (i) => (
        <span className="pp-sent">
          <RelativeTime date={i.created_at} /> <span className="muted">by {i.invited_by}</span>
        </span>
      ),
    },
  ];
  const table = (rows: Invitation[], caption: string, muted: boolean) => (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      getRowId={(i) => i.id}
      rowTone={muted ? () => "muted" : undefined}
      rowAction={(i) => (i.state === "open" ? <OverflowMenu size="sm" label={`Actions for ${i.email}`} items={[{ id: "revoke", label: "Revoke…", icon: "x", tone: "danger", onSelect: () => void revoke(i) }]} /> : null)}
      empty={null}
    />
  );

  return (
    <AsyncBlock result={result} label="Loading invitations" skeleton={<SkeletonRows count={2} density="compact" />} errorTitle="Couldn't load the invitations">
      {(data) => {
        if (!data.invitations.length) return null;
        const open = data.invitations.filter((i) => i.state === "open");
        const rest = data.invitations.filter((i) => i.state !== "open");
        return (
          <Section title="Invitations" count={open.length} description="Links work once and expire after 7 days. Organisation roles are given in the People table once they've accepted.">
            {open.length ? table(open, "Open invitations", false) : <p className="muted small">No open invitations.</p>}
            {rest.length > 0 && (
              <Disclosure summary={`History (${rest.length})`} storageKey="people-invitations-history">
                {table(rest, "Accepted, revoked and expired invitations", true)}
              </Disclosure>
            )}
          </Section>
        );
      }}
    </AsyncBlock>
  );
}

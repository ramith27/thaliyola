import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, authApi, canIn, type AccountStatus, type Me, type PersonAccess, type ProjectsWithoutAdmin, type ScopeInfo } from "../api";
import { InviteForm, Invitations } from "./invite";
import { ExportButton } from "./setup";
import { href } from "../router";
import { NotificationPrefs } from "../components/notifications";
import { useBoot, usePageMeta } from "../components/boot";
import { can } from "../components/permissions";
import { plural } from "../components/labels";
import { canRotate, RotateTokenDialog, TokenStatusCell, tokenExpiryText, type ApiToken } from "../components/tokens";
import { I } from "../components/icons";
import { useApi, useAppRoute, useQueryState } from "../hooks";
import { SkillPreferenceSection } from "./skills";
import { ACCESS_SENTENCE, namesOr, RolePicker, TEAM_ROLE_TEXT, useRoles, type CatalogRole } from "../components/roles";
import {
  displayName,
  AdminTabs,
  AsyncBlock,
  Avatar,
  Badge,
  Button,
  Callout,
  Card,
  ChipGroup,
  ChoiceCards,
  CodeBlock,
  DataTable,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  FilterBar,
  focusFirstInvalid,
  GateCard,
  humanizeError,
  InfoTip,
  MetaLine,
  OverflowMenu,
  Page,
  PageHeader,
  PasswordInput,
  PersonChip,
  ProjectPicker,
  RelativeTime,
  Section,
  SecretReveal,
  Select,
  SkeletonRows,
  SkeletonText,
  StatusBadge,
  Switch,
  Tabs,
  TextInput,
  useConfirm,
  useToast,
  type Column,
  type MenuItemSpec,
} from "../components/kit";

// ---- Gates --------------------------------------------------------------------------------------------------

/** "Email or password is incorrect." for a refused sign-in; anything else goes through the kit's humanizer. */
function signInError(err: unknown): unknown {
  if (err instanceof ApiError && (err.status === 401 || err.status === 403)) return new Error("Email or password is incorrect.");
  return err;
}

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  usePageMeta({ title: "Sign in" });
  // Sign-in with the organisation's provider (OpenID Connect), when the server offers it.
  const [options, setOptions] = useState<{ providers: { name: string; label: string }[]; password: boolean }>({ providers: [], password: true });
  useEffect(() => {
    fetch("/auth/config", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((c: { providers?: { name: string; label: string }[]; password?: boolean }) => setOptions({ providers: c.providers ?? [], password: c.password !== false }))
      .catch(() => undefined);
  }, []);
  const returnTo = `/${window.location.hash}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!email.trim()) next.email = "Enter your email.";
    if (!password) next.password = "Enter your password.";
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await authApi("/login", { email, password });
      onSignedIn();
    } catch (err) {
      setError(signInError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <GateCard title="Sign in to Thaliyola" description={<p>Your team's knowledge base.</p>} footer={<p className="pp-gate-hint">Forgot your password? Ask an Administrator or User manager to reset it.</p>}>
      {options.providers.length > 0 && (
        <div className="pp-gate-sso">
          {options.providers.map((p) => (
            <Button key={p.name} size="lg" block href={`/auth/oidc/${encodeURIComponent(p.name)}/start?return=${encodeURIComponent(returnTo)}`}>
              Sign in with {p.label}
            </Button>
          ))}
          {options.password && <p className="pp-gate-or">or with your Thaliyola password</p>}
        </div>
      )}
      {options.password && (
      <form ref={formRef} className="pp-gate-form" noValidate onSubmit={submit}>
        <Field label="Email" error={errors.email}>
          <TextInput type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password" error={errors.password}>
          <PasswordInput autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error ? <ErrorState compact error={error} /> : null}
        <Button variant="primary" size="lg" block type="submit" loading={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      )}
    </GateCard>
  );
}

/** Current (or temporary) password, a new one of at least 10 characters, and the repeat, with an inline match check. */
function PasswordForm({ onDone, temporary, submitLabel = "Change password", busyLabel = "Changing…" }: { onDone: () => void; temporary?: boolean; submitLabel?: string; busyLabel?: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<{ current?: string; next?: string; repeat?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const mismatch = repeat.length > 0 && next !== repeat ? "The new passwords don't match." : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad: typeof errors = {};
    if (!current) bad.current = temporary ? "Enter the temporary password you were given." : "Enter your current password.";
    if (next.length < 10) bad.next = "Use at least 10 characters.";
    if (next !== repeat) bad.repeat = "The new passwords don't match.";
    setErrors(bad);
    setSaved(false);
    if (Object.keys(bad).length) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/account/password", { method: "POST", body: { current, next } });
      setCurrent("");
      setNext("");
      setRepeat("");
      setSaved(true);
      toast.success("Password changed. Other sessions were signed out.");
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="pp-form pp-form-narrow" noValidate>
      <Field label={temporary ? "Temporary password" : "Current password"} error={errors.current}>
        <PasswordInput autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus={temporary} />
      </Field>
      <Field label="New password" hint="At least 10 characters." error={errors.next}>
        <PasswordInput autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} minLength={10} />
      </Field>
      <Field label="Repeat new password" error={errors.repeat ?? mismatch}>
        <PasswordInput autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
      </Field>
      {error ? <ErrorState compact error={error} title="Couldn't change the password" /> : null}
      {saved && !temporary && (
        <Callout tone="success" live>
          Password changed. Other sessions were signed out.
        </Callout>
      )}
      <div className="pp-form-actions">
        <Button variant="primary" type="submit" loading={busy} block={temporary} size={temporary ? "lg" : "md"}>
          {busy ? busyLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function ForcedPasswordChange({ me, onDone }: { me: Me; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false);
  usePageMeta({ title: "Choose a password" });
  return (
    <GateCard
      title="Choose a password"
      icon="key"
      description={<p>{me.email} is signed in with a temporary password. Pick your own to continue.</p>}
      footer={
        <button
          type="button"
          className="link-btn"
          disabled={leaving}
          onClick={async () => {
            setLeaving(true);
            await authApi("/logout", {}).catch(() => undefined);
            onDone();
          }}
        >
          Sign out
        </button>
      }
    >
      <PasswordForm onDone={onDone} temporary submitLabel="Set password and continue" busyLabel="Saving…" />
    </GateCard>
  );
}

// ---- Account: tokens and apps --------------------------------------------------------------------------------

type Token = ApiToken;

/**
 * Closing a dialog with Esc, the backdrop or ✕ while it shows a one-time secret asks first, so the secret isn't lost
 * by accident. The secret's own "Done" button still closes straight away.
 */
function useSecretGuard() {
  const confirm = useConfirm();
  return async (what: string, close: () => void) => {
    const ok = await confirm({
      title: `Close without copying the ${what}?`,
      body: `The ${what} is shown only once. After you close this you can't see it again.`,
      confirmLabel: "Close anyway",
      cancelLabel: "Keep it open",
      tone: "danger",
    });
    if (ok) close();
  };
}

function CreateTokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [nameError, setNameError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const mcpUrl = `${window.location.origin}/mcp`;
  const guard = useSecretGuard();

  return (
    <Dialog
      open
      title={created ? `${created.name}: copy the token now` : "Create token"}
      description={created ? undefined : "For Claude Code or another MCP client on one device."}
      dismissible={!busy}
      onClose={created ? () => void guard("token", onClose) : onClose}
    >
      {created ? (
        <SecretReveal
          title="Token"
          value={created.token}
          warning={`${created.name}: copy the token now. It won't be shown again.`}
          onDone={onClose}
          extra={
            <CodeBlock
              label="Connect Claude Code"
              language="shell"
              code={`claude mcp add --transport http thaliyola ${mcpUrl} \\\n  --header "Authorization: Bearer ${created.token}"`}
            />
          }
        />
      ) : (
        <form
          ref={formRef}
          className="pp-form"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) {
              setNameError("Give the token a name, so you know where it's used.");
              requestAnimationFrame(() => focusFirstInvalid(formRef.current));
              return;
            }
            setNameError(undefined);
            setBusy(true);
            setError(null);
            try {
              const res = await api<{ token: string; name: string }>("/account/tokens", { method: "POST", body: { name: name.trim(), expires_in_days: days ? Number(days) : undefined } });
              setCreated(res);
              onCreated();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Token name" error={nameError}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="Name, e.g. Claude Code on laptop" maxLength={100} />
          </Field>
          <Field label="Expires">
            <Select
              value={days}
              onChange={(e) => setDays(e.target.value)}
              options={[
                { value: "30", label: "30 days" },
                { value: "90", label: "90 days" },
                { value: "365", label: "1 year" },
                { value: "", label: "No expiry" },
              ]}
            />
          </Field>
          {error ? <ErrorState compact error={error} title="Couldn't create the token" /> : null}
          <div className="pp-form-actions">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={busy} loadingText="Creating">
              Create token
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function ApiTokens() {
  const result = useApi<{ tokens: Token[] }>("/account/tokens");
  const { reload } = result;
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<Token | null>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const mcpUrl = `${window.location.origin}/mcp`;

  async function revoke(t: Token) {
    const ok = await confirm({ title: `Revoke ${t.name}?`, body: "Tools using it stop working.", confirmLabel: "Revoke token", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/account/tokens/${t.id}`, { method: "DELETE" });
      toast.success(`Revoked ${t.name}`);
      reload();
    } catch (err) {
      toast.error(err, { title: `Couldn't revoke ${t.name}` });
    }
  }

  const columns: Column<Token>[] = [
    { key: "name", header: "Name", cell: (t) => t.name },
    { key: "prefix", header: "Token", cell: (t) => <code>{t.prefix}…</code> },
    { key: "created", header: "Created", cell: (t) => <RelativeTime date={t.created_at} />, hideBelow: 1100 },
    { key: "used", header: "Last used", cell: (t) => <RelativeTime date={t.last_used_at} never="Never" /> },
    { key: "expires", header: "Expires", cell: (t) => tokenExpiryText(t) },
    { key: "status", header: "Status", cell: (t) => <TokenStatusCell token={t} /> },
  ];
  const table = (rows: Token[], caption: string) => (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      getRowId={(t) => t.id}
      rowTone={(t) => (t.revoked_at ? "muted" : undefined)}
      rowAction={(t) =>
        t.revoked_at ? null : (
          <OverflowMenu
            size="sm"
            label={`Actions for ${t.name}`}
            items={[
              ...(canRotate(t) ? [{ id: "rotate", label: "Rotate…", icon: "refresh" as const, onSelect: () => setRotating(t) }] : []),
              { id: "revoke", label: "Revoke…", icon: "x", tone: "danger", onSelect: () => void revoke(t) },
            ]}
          />
        )
      }
      empty={null}
    />
  );

  return (
    <Section
      title="API tokens"
      description="Tokens let Claude Code and other MCP clients act as you. They can read everything you can and propose changes in your name."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          Create token
        </Button>
      }
    >
      <AsyncBlock result={result} label="Loading your tokens" skeleton={<SkeletonRows count={3} density="compact" />} errorTitle="Couldn't load your tokens">
        {(data) => {
          const live = data.tokens.filter((t) => !t.revoked_at);
          const revoked = data.tokens.filter((t) => t.revoked_at);
          const unused = live.filter((t) => t.unused).length;
          return (
            <>
              {unused > 0 && (
                <Callout tone="warning" title={unused === 1 ? "1 token hasn't been used for 90 days" : `${unused} tokens haven't been used for 90 days`}>
                  Tokens nobody has used for 90 days are easy to forget about. Revoke the ones you no longer need, or rotate them if a tool still uses them.
                </Callout>
              )}
              {live.length ? (
                table(live, "API tokens")
              ) : (
                <EmptyState
                  variant="compact"
                  icon="key"
                  title="No tokens yet"
                  description="Create one for each device or tool that should act as you."
                  primary={
                    <Button icon="plus" onClick={() => setCreating(true)}>
                      Create token
                    </Button>
                  }
                />
              )}
              {revoked.length > 0 && (
                <Disclosure summary={`Show revoked (${revoked.length})`} storageKey="account-revoked-tokens">
                  {table(revoked, "Revoked tokens")}
                </Disclosure>
              )}
            </>
          );
        }}
      </AsyncBlock>
      <p className="pp-inline-note">
        Setting up Claude? <a href={href("/connect")}>Use Connect</a> for step-by-step instructions.
      </p>
      {creating && <CreateTokenDialog onClose={() => setCreating(false)} onCreated={reload} />}
      {rotating && (
        <RotateTokenDialog
          token={rotating}
          path={`/account/tokens/${rotating.id}/rotate`}
          who="your tools"
          onClose={() => setRotating(null)}
          onRotated={reload}
          extra={(secret) => (
            <CodeBlock label="Connect Claude Code" language="shell" code={`claude mcp add --transport http thaliyola ${mcpUrl} \\\n  --header "Authorization: Bearer ${secret}"`} />
          )}
        />
      )}
    </Section>
  );
}

interface Connection {
  client_id: string;
  name: string;
  connected_at: string;
  last_refreshed_at: string;
}

function ConnectedApps() {
  const result = useApi<{ connections: Connection[] }>("/account/connections");
  const confirm = useConfirm();
  const toast = useToast();

  async function revoke(c: Connection) {
    const ok = await confirm({ title: `Revoke ${c.name}?`, body: "It can't use Thaliyola as you any more until you connect it again.", confirmLabel: "Revoke app", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/account/connections/${encodeURIComponent(c.client_id)}`, { method: "DELETE" });
      toast.success(`Revoked ${c.name}`);
      result.reload();
    } catch (err) {
      toast.error(err, { title: `Couldn't revoke ${c.name}` });
    }
  }

  return (
    <Section title="Connected apps" description="Apps you allowed to use Thaliyola through OAuth, such as a claude.ai connector.">
      <AsyncBlock result={result} label="Loading connected apps" skeleton={<SkeletonRows count={2} density="compact" />} errorTitle="Couldn't load connected apps">
        {(data) => (
          <DataTable
            caption="Connected apps"
            columns={[
              { key: "app", header: "App", cell: (c) => c.name },
              { key: "connected", header: "Connected", cell: (c) => <RelativeTime date={c.connected_at} /> },
              { key: "refreshed", header: "Last refreshed", cell: (c) => <RelativeTime date={c.last_refreshed_at} /> },
            ]}
            rows={data.connections}
            getRowId={(c) => c.client_id}
            rowAction={(c) => <OverflowMenu size="sm" label={`Actions for ${c.name}`} items={[{ id: "revoke", label: "Revoke…", icon: "x", tone: "danger", onSelect: () => void revoke(c) }]} />}
            empty={
              <EmptyState
                variant="compact"
                icon="plug"
                title="No apps connected"
                description={
                  <>
                    <a href={href("/connect")}>Connect claude.ai from Connect</a>.
                  </>
                }
              />
            }
          />
        )}
      </AsyncBlock>
    </Section>
  );
}

/** "Show the setup checklist on Home" (onboarding_dismissed false/true). */
function ChecklistSwitch() {
  const { data } = useApi<{ prefs: { onboarding_dismissed?: boolean } }>("/account/prefs");
  const [on, setOn] = useState<boolean | null>(null);
  const [status, setStatus] = useState<"saving" | "saved" | "error" | undefined>();
  const toast = useToast();
  const checked = on ?? data?.prefs.onboarding_dismissed !== true;
  return (
    <Section title="Home" level={2}>
      <Switch
        label="Show the setup checklist on Home"
        description="The steps for connecting Claude and filling your first project."
        checked={checked}
        status={status}
        disabled={!data}
        onChange={async (next) => {
          setOn(next);
          setStatus("saving");
          try {
            await api("/account/prefs", { method: "PUT", body: { onboarding_dismissed: !next } });
            setStatus("saved");
            toast.success(next ? "Setup checklist is back on Home" : "Setup checklist hidden");
          } catch (err) {
            setOn(!next);
            setStatus("error");
            toast.error(err, { title: "Couldn't save that setting" });
          }
        }}
      />
    </Section>
  );
}

/** The role line under the Account title: Administrator (from the server settings), organisation role names, or Member. */
function RoleLine({ me }: { me: Me }) {
  if (me.admin)
    return (
      <>
        <Badge tone="accent" icon="shield">
          Administrator
        </Badge>
        {me.administrator_source === "ADMIN_EMAILS" && (
          <span className="pp-config-lock">
            from the server settings
            <InfoTip label="Where this comes from">Set by ADMIN_EMAILS in the server configuration, so it can't be changed here.</InfoTip>
          </span>
        )}
      </>
    );
  if (me.role_names?.length) return <Badge tone="neutral">{me.role_names.join(", ")}</Badge>;
  return <Badge tone="neutral">Member</Badge>;
}

const ACCOUNT_SECTIONS = ["access", "notifications", "skills", "tokens", "data", "password"] as const;

export function AccountPage({ me }: { me: Me }) {
  const route = useAppRoute();
  const [q] = useQueryState(route, { section: "access" });
  const { updateMe } = useBoot();
  const toast = useToast();
  const [naming, setNaming] = useState(false);
  const human = me.kind !== "service";
  const access = useApi<PersonAccess>("/account/access");
  const tabs = [
    { id: "access", label: "Your access", icon: "shield" as const },
    { id: "notifications", label: "Notifications", icon: "bell" as const },
    { id: "skills", label: "Skills for Claude", icon: "sparkle" as const, hidden: !human },
    { id: "tokens", label: "API tokens and apps", icon: "key" as const },
    { id: "data", label: "Your data", icon: "download" as const },
    { id: "password", label: "Password", icon: "lock" as const, hidden: !me.local_account },
  ];
  const visibleIds = tabs.filter((t) => !t.hidden).map((t) => t.id);
  const section = (ACCOUNT_SECTIONS as readonly string[]).includes(q.section!) && visibleIds.includes(q.section!) ? q.section! : "access";

  return (
    <Page width="content">
      <PageHeader
        title="Account"
        meta={
          <span className="pp-identity">
            <Avatar name={me.name} email={me.email} kind={human ? "human" : "service"} size={40} />
            <span className="pp-identity-text">
              <span className="pp-identity-name-row">
                <span className="pp-identity-email">{me.email || me.name ? displayName(me.name, me.email) : "Service account"}</span>
                {human && (
                  <Button size="sm" variant="ghost" icon="pencil" onClick={() => setNaming(true)}>
                    {me.name ? "Change name" : "Add your name"}
                  </Button>
                )}
              </span>
              {me.email && <span className="pp-identity-sub">{me.email}</span>}
              <span className="pp-identity-role">
                <RoleLine me={me} />
              </span>
            </span>
          </span>
        }
        tabs={<Tabs label="Account sections" value={section} items={tabs.map((t) => ({ ...t, href: href("/account", t.id === "access" ? {} : { section: t.id }) }))} />}
      />

      {section === "access" && (
        <Section title="Your access" description={ACCESS_SENTENCE} actions={<Button href={href("/roles")} size="sm" variant="ghost" iconEnd="chevron-right">What the roles allow</Button>}>
          <AsyncBlock result={access} label="Loading your access" skeleton={<SkeletonText lines={6} />} errorTitle="Couldn't load your access">
            {(data) => <PersonAccessView access={data} self />}
          </AsyncBlock>
        </Section>
      )}
      {section === "notifications" && (
        <div className="pp-stack">
          <NotificationPrefs />
          <ChecklistSwitch />
        </div>
      )}
      {section === "skills" && <SkillPreferenceSection me={me} />}
      {section === "tokens" && (
        <div className="pp-stack">
          <ApiTokens />
          <ConnectedApps />
        </div>
      )}
      {section === "data" && (
        <Section title="Your data" description="Download everything you can read as Markdown files with front matter, plus attachments, in a zip.">
          <div className="pp-actions">
            <ExportButton />
            <Button href={href("/import")} icon="upload">
              Import documents
            </Button>
          </div>
        </Section>
      )}
      {section === "password" && me.local_account && (
        <Section title="Password" description="Changing it signs you out everywhere else.">
          <Card>
            <PasswordForm onDone={() => undefined} />
          </Card>
        </Section>
      )}
      {naming && (
        <NameDialog
          title={me.name ? "Change your name" : "Add your name"}
          description="People see it in reviews, access lists and notifications, with your email next to it where it matters."
          initial={me.name ?? ""}
          onClose={() => setNaming(false)}
          onSave={async (name) => {
            const res = await api<{ name: string | null }>("/account", { method: "PATCH", body: { display_name: name } });
            updateMe({ name: res.name });
            toast.success(res.name ? `You're now ${res.name}` : "Name removed: people see your email instead");
          }}
        />
      )}
    </Page>
  );
}
AccountPage.keepMountedOnQuery = true;

/**
 * Edits a display name (yours on Account, anyone's on Admin › People). Empty saves no name, so people see the email.
 * `onSave` throws to keep the dialog open with the error.
 */
function NameDialog({
  title,
  description,
  initial,
  onSave,
  onClose,
}: {
  title: string;
  description: string;
  initial: string;
  onSave: (name: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const input = useRef<HTMLInputElement>(null);
  const trimmed = value.replace(/\s+/g, " ").trim();
  const tooLong = trimmed.length > NAME_MAX ? `Use at most ${NAME_MAX} characters.` : undefined;
  const hasAt = trimmed.includes("@") ? "Use the name people know, not an email." : undefined;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (tooLong || hasAt) return;
    setBusy(true);
    setError(undefined);
    try {
      await onSave(trimmed || null);
      onClose();
    } catch (err) {
      setError(humanizeError(err).title);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="sm"
      title={title}
      description={description}
      dismissible={!busy}
      onClose={onClose}
      initialFocusRef={input}
    >
      <form className="pp-form" onSubmit={submit} noValidate>
        <Field label="Name" hint="Leave it empty to show the email instead." error={tooLong ?? hasAt ?? error} counter={{ value: trimmed.length, max: NAME_MAX }}>
          <TextInput ref={input} value={value} autoComplete="name" maxLength={NAME_MAX * 2} placeholder="e.g. Rita Shah" onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="pp-form-actions">
          <Button variant="primary" type="submit" loading={busy} disabled={!!tooLong || !!hasAt || trimmed === initial.trim()}>
            Save name
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** The server's name limit (core/users.ts NAME_MAX). */
const NAME_MAX = 100;


// ---- Person access --------------------------------------------------------------------------------------------

/** One project role's source: directly, through a team, or from a project above. */
function How({ r }: { r: PersonAccess["projects"][number]["roles"][number] }) {
  if (r.via === "direct") return <>directly</>;
  if (r.via === "team" && r.team)
    return (
      <>
        through team <a href={href(`/teams/${r.team.slug}`)}>{r.team.name}</a>
      </>
    );
  if (r.from)
    return (
      <>
        from <a href={href(`/scope/${r.from.slug}/settings`, { tab: "access" })}>{r.from.name}</a> (above)
        {r.team && (
          <>
            {" "}
            through team <a href={href(`/teams/${r.team.slug}`)}>{r.team.name}</a>
          </>
        )}
      </>
    );
  return <>{r.via === "inherited" ? "from a project above" : r.via}</>;
}

/** Everything one person can access: Administrator, organisation roles, teams, and each project's roles and where they come from. */
export function PersonAccessView({ access, self = false }: { access: PersonAccess; self?: boolean }) {
  const who = self ? "You" : access.person.name || access.person.email ? displayName(access.person.name, access.person.email) : "This account";
  const projects = access.projects ?? [];
  const teams = access.teams ?? [];
  const p = access.person;
  return (
    <div className="person-access pp-access">
      <MetaLine
        items={[
          p.email ? `${displayName(p.name, p.email)} · ${p.email}` : (p.name ?? "Service account"),
          ...(p.kind === "service" ? ["Service account"] : []),
          ...(p.status ? [<StatusBadge key="s" domain="user" value={p.status} />] : []),
          ...(p.needs_approval && p.status !== "waiting_for_approval" ? ["needs approval"] : []),
        ]}
      />
      {access.administrator?.is && (
        <Callout tone="info" icon="shield" title="Administrator">
          {who} {self ? "are" : "is"} an Administrator: {self ? "you" : "they"} can do everything, including system settings and making other Administrators.
          {access.administrator.source === "ADMIN_EMAILS" && (
            <>
              {" "}It comes from the server settings, so it can't be changed here.{" "}
              <InfoTip label="Which setting">ADMIN_EMAILS in the server configuration.</InfoTip>
            </>
          )}
        </Callout>
      )}

      <section className="pp-access-part" aria-labelledby="pp-access-org">
        <h3 id="pp-access-org" className="pp-subheading">
          Organisation roles
        </h3>
        {access.org_roles?.length ? (
          <span className="pp-chips">
            {access.org_roles.map((r) => (
              <Badge key={r.key} tone={r.key === "admin" ? "accent" : "neutral"}>
                {r.name}
              </Badge>
            ))}
          </span>
        ) : (
          <p className="muted">None.</p>
        )}
        {access.reads_every_project && !access.manages_every_project && <p className="pp-inline-note">Reads every project, members-only ones included.</p>}
        {access.manages_every_project && <p className="pp-inline-note">Manages every project, as their Project admins do.</p>}
      </section>

      <section className="pp-access-part" aria-labelledby="pp-access-teams">
        <h3 id="pp-access-teams" className="pp-subheading">
          Teams
        </h3>
        <DataTable
          caption="Teams"
          density="compact"
          columns={[
            { key: "team", header: "Team", cell: (t) => <a href={href(`/teams/${t.slug}`)}>{t.name}</a> },
            { key: "place", header: "In the team", cell: (t) => (t.team_role === "lead" ? TEAM_ROLE_TEXT.lead : TEAM_ROLE_TEXT.member) },
          ]}
          rows={teams}
          getRowId={(t) => t.slug}
          empty={<p className="muted">Not in any team.</p>}
        />
      </section>

      <section className="pp-access-part" aria-labelledby="pp-access-projects">
        <h3 id="pp-access-projects" className="pp-subheading">
          Projects
        </h3>
        <DataTable
          caption="Projects and project roles"
          density="compact"
          columns={[
            {
              key: "project",
              header: "Project",
              cell: (x) => (
                <span className="pp-project-cell">
                  <a href={href(`/scope/${x.slug}/settings`, { tab: "access" })}>{x.name}</a>
                  {x.visibility === "members" && (
                    <Badge variant="outline" icon="lock">
                      Members only
                    </Badge>
                  )}
                </span>
              ),
            },
            { key: "roles", header: "Project roles", cell: (x) => [...new Set(x.roles.map((r) => r.name))].join(", ") || <span className="muted">—</span> },
            {
              key: "how",
              header: "How",
              cell: (x) => (
                <ul className="pp-how">
                  {x.roles.map((r, i) => (
                    <li key={`${r.key}-${r.via}-${r.team?.slug ?? ""}-${r.from?.slug ?? ""}-${i}`}>
                      {r.name}: <How r={r} />
                    </li>
                  ))}
                </ul>
              ),
            },
          ]}
          rows={projects}
          getRowId={(x) => x.slug}
          empty={<p className="muted">{access.reads_every_project ? "No project roles (but sees every project through an organisation role)." : "No project roles yet."}</p>}
        />
        {access.other_projects > 0 && (
          <p className="pp-inline-note">
            and {access.other_projects} {access.other_projects === 1 ? "project" : "projects"} you can't see
          </p>
        )}
      </section>
    </div>
  );
}

/** One person's access (#/admin/users/<id>): for User managers, role managers, Auditors and Administrators. */
export function PersonAccessPage({ id, me }: { id: string; me: Me }) {
  const result = useApi<PersonAccess>(`/users/${encodeURIComponent(id)}/access`);
  const { scopes } = useBoot();
  const data = result.data;
  const name = data ? (data.person.name || data.person.email ? displayName(data.person.name, data.person.email) : "Service account") : null;
  const possessive = name ? `${name.charAt(0).toUpperCase()}${name.slice(1)}${name.endsWith("s") ? "’" : "’s"}` : null;
  const crumbs = can.manageUsers(me)
    ? [
        { label: "Admin", href: href("/admin") },
        { label: "People", href: href("/admin/users") },
      ]
    : [{ label: "Roles and access", href: href("/roles") }];
  return (
    <Page width="content">
      <PageHeader
        title={possessive ? `${possessive} access` : "Access"}
        crumbs={crumbs}
        nav={can.seeAdmin(me, scopes) ? "admin" : undefined}
        description={ACCESS_SENTENCE}
      />
      <AsyncBlock result={result} label="Loading their access" skeleton={<SkeletonText lines={8} />} errorTitle="Couldn't load their access">
        {(d) => <PersonAccessView access={d} self={d.person.id === me.id} />}
      </AsyncBlock>
    </Page>
  );
}

// ---- People (admin) -------------------------------------------------------------------------------------------

interface Person {
  id: string;
  email: string;
  display_name: string | null;
  kind: "human" | "service";
  is_admin: boolean;
  /** Administrator through ADMIN_EMAILS on the server, so it can't be changed here. */
  admin_by_config: boolean;
  local: boolean;
  /** Added by email; becomes theirs at first sign-in. */
  pending: boolean;
  /** Organisation roles, "admin" first for Administrators. */
  roles: string[];
  role_names?: string[];
  status?: AccountStatus;
  /** The viewer may approve, disable, enable or reset this account. */
  can_manage_account?: boolean;
  must_change_password: boolean;
  disabled_at: string | null;
  last_seen_at: string | null;
}

interface AccessRequest {
  id: string;
  email: string | null;
  /** Display name from their sign-in, if it passed one. */
  name?: string | null;
  subject: string;
  kind: "human" | "service";
  created_at: string;
  declined: boolean;
}

/** Why the viewer can't give or take an organisation role (undefined = they can). */
function orgRoleRefusal(me: Me, r: CatalogRole, target?: { id: string; admin_by_config?: boolean }) {
  if (r.admin || r.key === "admin") {
    if (!can.makeAdministrator(me)) return "only Administrators make Administrators";
    if (target?.admin_by_config) return "set on the server, so it can't be changed here";
    if (target?.id === me.id) return "you can't remove your own Administrator role";
    return undefined;
  }
  if (!r.permissions.every((p) => can.org(me, p))) return "you can only give or take away roles whose permissions you have";
  return undefined;
}

/** The user-domain status key for a row: disabled, temporary password, the server's account status, or pending. */
function personStatus(u: Person): string {
  if (u.disabled_at) return "disabled";
  if (u.must_change_password) return "must_change_password";
  if (u.status) return u.status;
  return u.pending ? "not_signed_in" : "active";
}

/** People who signed in on their own and wait for approval. Any one Administrator or User manager approves or declines. */
function AccessRequests({ onDecided }: { onDecided: () => void }) {
  const { data, error, reload } = useApi<{ requests: AccessRequest[] }>("/access-requests");
  const [approved, setApproved] = useState<{ id: string; email: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const confirm = useConfirm();
  const toast = useToast();

  async function decide(r: AccessRequest, decision: "approve" | "decline") {
    const who = r.email ? displayName(r.name, r.email) : r.subject;
    if (decision === "decline") {
      const ok = await confirm({ title: `Decline ${who}?`, body: "They stay unable to use Thaliyola. You can still approve them later from Declined.", confirmLabel: "Decline", tone: "danger" });
      if (!ok) return;
    }
    setBusy(r.id);
    try {
      await api(`/access-requests/${r.id}/${decision}`, { method: "POST" });
      if (decision === "approve") setApproved({ id: r.id, email: who });
      else toast.success(`Declined ${who}`);
      reload();
      onDecided();
    } catch (err) {
      toast.error(err, { title: decision === "approve" ? `Couldn't approve ${who}` : `Couldn't decline ${who}` });
    } finally {
      setBusy(null);
    }
  }

  const waiting = data?.requests.filter((r) => !r.declined) ?? [];
  const declined = data?.requests.filter((r) => r.declined) ?? [];
  const row = (r: AccessRequest) => (
    <li key={r.id} className="pp-request">
      <span className="pp-request-who">
        <PersonChip email={r.email ?? r.subject} name={r.email ? r.name : r.subject} kind={r.kind} />
        {r.email && <span className="pp-request-email">{r.email}</span>}
        <span className="pp-request-meta">
          {r.declined ? "Declined · " : ""}First signed in <RelativeTime date={r.created_at} />
        </span>
      </span>
      <span className="pp-request-actions">
        <Button size="sm" variant={r.declined ? "secondary" : "primary"} loading={busy === r.id} onClick={() => void decide(r, "approve")}>
          {r.declined ? "Approve anyway" : "Approve"}
        </Button>
        {!r.declined && (
          <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => void decide(r, "decline")}>
            Decline…
          </Button>
        )}
      </span>
    </li>
  );

  return (
    <>
      {error ? <ErrorState compact error={error} title="Couldn't load who is waiting" onRetry={reload} /> : null}
      {approved && (
        <Callout tone="success" live title={`${approved.email} can sign in now.`} onDismiss={() => setApproved(null)}>
          Give them access: <a href={href("/admin/projects")}>Projects</a> · <a href={href("/teams")}>Teams</a> · <a href={href(`/admin/users/${approved.id}`)}>their access page</a>
        </Callout>
      )}
      {waiting.length > 0 ? (
        <Callout tone="warning" icon="clock" title={`${plural(waiting.length, "person", "people")} ${waiting.length === 1 ? "is" : "are"} waiting for access`}>
          <p>New people can't see or do anything until an Administrator or User manager approves them. Existing accounts are not affected.</p>
          <ul className="pp-requests">{waiting.map(row)}</ul>
        </Callout>
      ) : (
        data && (
          <p className="sr-only" role="status">
            Nobody is waiting.
          </p>
        )
      )}
      {declined.length > 0 && (
        <Disclosure summary={`Declined (${declined.length})`} storageKey="people-declined">
          <ul className="pp-requests">{declined.map(row)}</ul>
        </Disclosure>
      )}
    </>
  );
}

interface AddedPerson {
  email?: string;
  status?: "added" | "approved";
  user?: Person;
  temporary_password?: string;
  role_names?: string[];
  project?: string | null;
  project_roles?: string[];
}

/**
 * Adds someone: with your company sign-in and dev sign-in by email (approved in advance), with built-in sign-in as an
 * account with a temporary password. Both can give organisation roles and roles in one project at once.
 */
function AddPersonForm({
  me,
  scopes,
  local,
  onAdded,
  onClose,
  onSecret,
}: {
  me: Me;
  scopes: ScopeInfo[];
  local: boolean;
  onAdded: () => void;
  onClose: () => void;
  /** Tells the dialog when a one-time secret is on screen (its name), or gone (null). */
  onSecret?: (what: string | null) => void;
}) {
  const catalog = useRoles();
  const all = catalog.data?.roles;
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roles, setRoles] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [projectRoles, setProjectRoles] = useState<string[]>(["writer"]);
  const [emailError, setEmailError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [added, setAdded] = useState<AddedPerson | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const confirm = useConfirm();
  const toast = useToast();
  const projects = scopes.filter((s) => s.kind === "project" && canIn(s, "manage_members", me));
  const asAdmin = roles.includes("admin");
  const secretShown = Boolean(added?.temporary_password);
  useEffect(() => {
    onSecret?.(secretShown ? "temporary password" : null);
    return () => onSecret?.(null);
  }, [secretShown]); // eslint-disable-line react-hooks/exhaustive-deps
  const projectName = (slug: string | null | undefined) => scopes.find((s) => s.slug === slug)?.name ?? slug;
  const whatGiven = (a: AddedPerson) =>
    [a.role_names?.length ? `organisation roles: ${a.role_names.join(", ")}` : "", a.project ? `${namesOr(undefined, all, a.project_roles ?? [])} in ${projectName(a.project)}` : ""].filter(Boolean).join("; ");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = !email.trim() ? "Enter their email." : !/^\S+@\S+\.\S+$/.test(email.trim()) ? "Enter an email address like name@company.com." : undefined;
    setEmailError(bad);
    if (bad) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    if (asAdmin) {
      const ok = await confirm({ title: `Make ${email.trim()} an Administrator?`, body: "They can do everything, including system settings.", confirmLabel: "Confirm", tone: "danger" });
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<AddedPerson>("/users", {
        method: "POST",
        body: { email: email.trim(), name: name || undefined, roles, project: project || undefined, project_roles: project ? projectRoles : undefined },
      });
      onAdded();
      const what = whatGiven(res);
      if (res.temporary_password) {
        setAdded(res);
      } else {
        toast.success(res.status === "approved" ? `${res.email} was waiting for access and is now approved.` : `${res.email} can sign in now.`, {
          description: what ? `${what.charAt(0).toUpperCase()}${what.slice(1)}.` : undefined,
        });
        onClose();
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (added?.temporary_password) {
    const what = whatGiven(added);
    return (
      <SecretReveal
        title={`Temporary password for ${added.user?.email ?? added.email ?? "the new account"}`}
        value={added.temporary_password}
        warning={`Share it privately; it is shown once.${what ? ` (${what})` : ""} They choose their own password at first sign-in.`}
        doneLabel="Done"
        onDone={onClose}
      />
    );
  }

  return (
    <form ref={formRef} className="pp-form" noValidate onSubmit={submit}>
      <div className="pp-form-row">
        <Field label="Email" error={emailError} hint={local ? undefined : "Their email must also be allowed by your company sign-in."}>
          <TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" />
        </Field>
        <Field label="Name" optional>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <Field label="Organisation roles" optional hint="What they can do across all of Thaliyola. Most people need none.">
        <RolePicker roles={all} kind="org" value={roles} onChange={setRoles} label="Organisation roles" empty="No organisation roles" disabledReason={(r) => orgRoleRefusal(me, r)} />
      </Field>
      {projects.length > 0 && (
        <div className="pp-form-row">
          <Field label="Add to project" optional>
            <ProjectPicker searchable value={project} onChange={setProject} scopes={scopes} includeSpaces={false} noneLabel="No project" filter={(s) => projects.some((p) => p.slug === s.slug)} />
          </Field>
          <Field label="Project roles" hint={project ? undefined : "Choose a project first."}>
            <RolePicker roles={all} kind="project" value={projectRoles} onChange={setProjectRoles} label="Project roles" required empty="choose project roles" disabled={!project} />
          </Field>
        </div>
      )}
      {error ? <ErrorState compact error={error} title={local ? "Couldn't add the account" : "Couldn't add them"} /> : null}
      <div className="pp-form-actions">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" loading={busy} loadingText="Adding">
          {asAdmin ? (local ? "Add account as Administrator" : "Add as Administrator") : local ? "Add account" : "Add person"}
        </Button>
      </div>
    </form>
  );
}

function AddPeopleDialog({ me, scopes, local, onClose, onAdded, onInvited }: { me: Me; scopes: ScopeInfo[]; local: boolean; onClose: () => void; onAdded: () => void; onInvited: () => void }) {
  const [how, setHow] = useState<"invite" | "account">("invite");
  const [secret, setSecret] = useState<string | null>(null);
  const guard = useSecretGuard();
  return (
    <Dialog
      open
      size="lg"
      title="Add people"
      description={
        local
          ? "Invite someone by email, or add an account directly with a temporary password to change at first sign-in."
          : "They get in at their first sign-in, with these roles. Your company sign-in must also let their email through."
      }
      onClose={secret ? () => void guard(secret, onClose) : onClose}
    >
      {local ? (
        <div className="pp-form">
          {/* Hidden while a one-time secret shows, so switching can't throw it away. */}
          {!secret && (
            <ChoiceCards
              name="add-people-how"
              legend="How"
              legendHidden
              columns={2}
              value={how}
              onChange={(v) => setHow(v as "invite" | "account")}
              options={[
                { value: "invite", label: "Send an invitation (recommended)", icon: "mail", description: "They get a link to choose their own password." },
                { value: "account", label: "Create an account with a temporary password", icon: "key", description: "You share the password; they change it at first sign-in." },
              ]}
            />
          )}
          {how === "invite" ? (
            <InviteForm scopes={scopes} me={me} onSent={onInvited} onDone={onClose} onSecret={setSecret} />
          ) : (
            <AddPersonForm me={me} scopes={scopes} local onAdded={onAdded} onClose={onClose} onSecret={setSecret} />
          )}
        </div>
      ) : (
        <AddPersonForm me={me} scopes={scopes} local={false} onAdded={onAdded} onClose={onClose} onSecret={setSecret} />
      )}
    </Dialog>
  );
}

/** The Organisation roles cell of one row: a picker, confirming first before Administrator changes. */
function OrgRolesCell({ u, me, roles, onChange }: { u: Person; me: Me; roles: CatalogRole[] | undefined; onChange: (change: { add: string[]; remove: string[] }) => void }) {
  const confirm = useConfirm();
  const current = u.is_admin && !u.roles.includes("admin") ? ["admin", ...u.roles] : u.roles;
  const isAdmin = current.includes("admin");
  const who = displayName(u.display_name, u.email);
  if (u.kind === "service") return <span className="muted">—</span>;
  if ((isAdmin && !can.makeAdministrator(me)) || (u.id === me.id && !can.makeAdministrator(me))) {
    const names = namesOr(u.role_names, roles, current);
    return names === "none" ? <span className="muted">None</span> : <span>{names}</span>;
  }
  return (
    <RolePicker
      roles={roles}
      kind="org"
      value={current}
      label={`Organisation roles of ${who}`}
      empty="None"
      disabledReason={(r) => orgRoleRefusal(me, r, u)}
      onChange={async (next) => {
        const change = { add: next.filter((k) => !current.includes(k)), remove: current.filter((k) => !next.includes(k)) };
        if (!change.add.length && !change.remove.length) return;
        if (change.add.includes("admin") || change.remove.includes("admin")) {
          const making = change.add.includes("admin");
          const ok = await confirm({
            title: making ? `Make ${who} an Administrator?` : `Remove ${who}'s Administrator role?`,
            body: making ? "They can do everything, including system settings." : "They keep their other organisation roles.",
            confirmLabel: "Confirm",
            tone: "danger",
          });
          if (!ok) return;
        }
        onChange(change);
      }}
    />
  );
}

type PeopleFilter = "all" | "admins" | "disabled" | "not_signed_in" | "service";

export function UsersPage({ me, scopes }: { me: Me; scopes: ScopeInfo[] }) {
  // The route isn't gated by the shell: someone without Manage people gets a locked page, not 403s.
  if (!can.manageUsers(me))
    return (
      <Page width="wide">
        <PageHeader title="People" nav={can.seeAdmin(me, scopes) ? "admin" : undefined} tabs={can.seeAdmin(me, scopes) ? <AdminTabs current="people" /> : undefined} />
        <EmptyState
          variant="locked"
          icon="user"
          title="Only Administrators and User managers can see People"
          description="Ask one of them if someone needs adding, approving or an organisation role. You can still see what each role allows, and your own access."
          primary={
            <Button href={href("/roles")} icon="shield">
              What the roles allow
            </Button>
          }
          secondary={
            <Button variant="ghost" href={href("/account", { section: "access" })}>
              Your access
            </Button>
          }
        />
      </Page>
    );
  return <PeopleList me={me} scopes={scopes} />;
}
UsersPage.keepMountedOnQuery = true;

function PeopleList({ me, scopes }: { me: Me; scopes: ScopeInfo[] }) {
  const result = useApi<{ users: Person[] }>("/users");
  const { reload } = result;
  const route = useAppRoute();
  const [q, setQ] = useQueryState(route, { q: "", show: "all" });
  const local = me.auth_mode === "local";
  const catalog = useRoles();
  const confirm = useConfirm();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [invites, setInvites] = useState(0);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const guardSecret = useSecretGuard();
  const [warning, setWarning] = useState<string | null>(null);
  const [naming, setNaming] = useState<Person | null>(null);
  const { updateMe } = useBoot();
  /** How a row's person is named in messages: their name, else the start of their email. */
  const nameOf = (u: Person) => displayName(u.display_name, u.email);

  /** "{projects} now has/have no Project admin: make someone else Project admin there." when an action left some without one. */
  const checkAdmins = (res: ProjectsWithoutAdmin | undefined) => {
    const lost = res?.projects_without_admin ?? [];
    const other = res?.other_projects_without_admin ?? 0;
    if (!lost.length && !other) return;
    const names = [...lost.map((p) => p.name), ...(other ? [`${other} ${other === 1 ? "project" : "projects"} you can't see`] : [])].join(", ");
    setWarning(`${names} now ${lost.length + other === 1 ? "has" : "have"} no Project admin: make someone else Project admin there.`);
  };

  async function changeRoles(u: Person, change: { add: string[]; remove: string[] }) {
    try {
      const res = await api<{ added_names?: string[]; removed_names?: string[]; added?: string[]; removed?: string[]; role_names?: string[] }>(`/users/${u.id}`, { method: "PATCH", body: change });
      const all = catalog.data?.roles;
      const gave = res?.added_names ?? namesOr(undefined, all, res?.added ?? []).split(", ").filter((x: string) => x !== "none");
      const took = res?.removed_names ?? namesOr(undefined, all, res?.removed ?? []).split(", ").filter((x: string) => x !== "none");
      const parts = [gave.length ? `Gave ${nameOf(u)} ${gave.join(", ")}` : "", took.length ? `${gave.length ? "took" : "Took"} ${took.join(", ")} from ${gave.length ? "them" : nameOf(u)}` : ""].filter(Boolean);
      const now = res?.role_names?.length ? res.role_names.join(", ") : "no organisation roles";
      toast.success(`Saved ${nameOf(u)}'s organisation roles`, { description: `${parts.join("; ") || `No change to ${nameOf(u)}'s organisation roles`}. Now: ${now}.` });
      reload();
    } catch (err) {
      toast.error(err, { title: `Couldn't change ${nameOf(u)}'s organisation roles` });
      reload();
    }
  }

  async function setDisabled(u: Person, disabled: boolean, undoable = true) {
    try {
      const res = await api<ProjectsWithoutAdmin>(`/users/${u.id}`, { method: "PATCH", body: { disabled } });
      toast.success(disabled ? `${nameOf(u)} is disabled` : `${nameOf(u)} is enabled again`, disabled && undoable ? { undo: () => setDisabled(u, false, false) } : undefined);
      checkAdmins(res);
      reload();
    } catch (err) {
      toast.error(err, { title: disabled ? `Couldn't disable ${nameOf(u)}` : `Couldn't enable ${nameOf(u)}` });
    }
  }

  async function disable(u: Person) {
    const ok = await confirm({
      title: `Disable ${nameOf(u)}?`,
      body: "They are signed out at once and their API tokens stop working; their roles stay for when they are enabled again.",
      confirmLabel: "Disable",
      tone: "danger",
    });
    if (ok) await setDisabled(u, true);
  }

  async function resetPassword(u: Person) {
    const ok = await confirm({ title: `Reset ${nameOf(u)}'s password?`, body: "Their current password stops working. You get a temporary password to share; they choose their own at next sign-in.", confirmLabel: "Reset password", tone: "danger" });
    if (!ok) return;
    try {
      const res = await api<{ temporary_password: string }>(`/users/${u.id}/reset-password`, { method: "POST" });
      setSecret({ email: nameOf(u), password: res.temporary_password });
      reload();
    } catch (err) {
      toast.error(err, { title: `Couldn't reset ${nameOf(u)}'s password` });
    }
  }

  async function rename(u: Person, name: string | null) {
    if (u.id === me.id) {
      const res = await api<{ name: string | null }>("/account", { method: "PATCH", body: { display_name: name } });
      updateMe({ name: res.name });
    } else {
      await api(`/users/${u.id}`, { method: "PATCH", body: { name } });
    }
    toast.success(name ? `${u.email} is now shown as ${name}` : `Removed ${u.email}'s name: people see the email instead`);
    reload();
  }

  const rowMenu = (u: Person): MenuItemSpec[] => {
    const manageable = u.can_manage_account ?? u.id !== me.id;
    const renameable = manageable || (u.id === me.id && u.kind === "human");
    const items: MenuItemSpec[] = renameable ? [{ id: "rename", label: u.display_name ? "Change name…" : "Add a name…", icon: "pencil", onSelect: () => setNaming(u) }] : [];
    if (!manageable) return items;
    if (local && u.local) items.push({ type: "separator" }, { id: "reset", label: "Reset password…", icon: "key", onSelect: () => void resetPassword(u) });
    if (u.disabled_at) items.push({ id: "enable", label: "Enable", icon: "check", onSelect: () => void setDisabled(u, false) });
    else {
      if (items.length) items.push({ type: "separator" });
      items.push({ id: "disable", label: "Disable…", icon: "x", tone: "danger", onSelect: () => void disable(u) });
    }
    return items;
  };

  const filterRow = (u: Person, f: PeopleFilter) =>
    f === "all" ||
    (f === "admins" && (u.is_admin || u.roles.includes("admin"))) ||
    (f === "disabled" && !!u.disabled_at) ||
    (f === "not_signed_in" && (u.pending || u.status === "not_signed_in")) ||
    (f === "service" && u.kind === "service");

  const columns: Column<Person>[] = [
    {
      key: "person",
      header: "Person",
      cell: (u) => (
        <div className="pp-person-cell">
          <span className="pp-person-line">
            <PersonChip name={u.display_name} email={u.email} kind={u.kind} you={u.id === me.id} />
          </span>
          <span className="pp-person-sub">
            <span>{u.email}</span>
            {u.admin_by_config && (
              <span className="pp-config-lock">
                <I name="lock" size={14} /> Administrator from the server settings
                <InfoTip label="Why this can't be changed">Set by ADMIN_EMAILS in the server configuration; it can't be changed here.</InfoTip>
              </span>
            )}
          </span>
          <a className="pp-access-link" href={href(`/admin/users/${u.id}`)}>
            Access
          </a>
        </div>
      ),
    },
    { key: "roles", header: "Organisation roles", cell: (u) => <OrgRolesCell u={u} me={me} roles={catalog.data?.roles} onChange={(change) => void changeRoles(u, change)} /> },
    { key: "status", header: "Status", cell: (u) => <StatusBadge domain="user" value={personStatus(u)} /> },
    { key: "seen", header: "Last seen", cell: (u) => <RelativeTime date={u.last_seen_at} never="Never" /> },
  ];

  const show = (q.show ?? "all") as PeopleFilter;
  const text = (q.q ?? "").trim().toLowerCase();

  return (
    <Page width="wide">
      <PageHeader
        title="People"
        crumbs={[{ label: "Admin", href: href("/admin") }]}
        nav="admin"
        tabs={<AdminTabs current="people" />}
        description={
          <>
            Approve new people, give organisation roles (Administrator included), and disable accounts. <a href={href("/roles")}>What the roles allow</a>
          </>
        }
        info={{
          label: "How access works",
          content: (
            <>
              <p>
                {local
                  ? "Invite people by email, or add an account directly with a temporary password to change at first sign-in."
                  : "People sign in through your company sign-in. Add someone by email to let them in without waiting for approval."}
              </p>
              <p>Project access is given per project (Members and access) or through teams.</p>
            </>
          ),
        }}
        primary={
          <Button variant="primary" icon="user-plus" onClick={() => setAdding(true)}>
            Add people
          </Button>
        }
      />

      <div className="pp-stack">
        <AccessRequests onDecided={reload} />
        {local && <Invitations scopes={scopes} me={me} refreshKey={invites} />}

        <Section title="People">
          {warning && (
            <Callout tone="warning" live onDismiss={() => setWarning(null)}>
              {warning}
            </Callout>
          )}
          <AsyncBlock result={result} label="Loading people" skeleton={<SkeletonRows count={5} />} errorTitle="Couldn't load people">
            {(data) => {
              const counts: Record<PeopleFilter, number> = {
                all: data.users.length,
                admins: data.users.filter((u) => filterRow(u, "admins")).length,
                disabled: data.users.filter((u) => filterRow(u, "disabled")).length,
                not_signed_in: data.users.filter((u) => filterRow(u, "not_signed_in")).length,
                service: data.users.filter((u) => filterRow(u, "service")).length,
              };
              const rows = data.users.filter((u) => filterRow(u, show) && (!text || u.email.toLowerCase().includes(text) || (u.display_name ?? "").toLowerCase().includes(text)));
              return (
                <>
                  <FilterBar
                    search={{ value: q.q ?? "", onChange: (v) => setQ({ q: v }), label: "Find people", placeholder: "Find by name or email" }}
                    segments={
                      <ChipGroup<PeopleFilter>
                        label="Show"
                        value={show}
                        onChange={(v: PeopleFilter) => setQ({ show: v })}
                        options={[
                          { value: "all", label: "All", count: counts.all },
                          { value: "admins", label: "Administrators", count: counts.admins },
                          { value: "disabled", label: "Disabled", count: counts.disabled },
                          { value: "not_signed_in", label: "Hasn't signed in", count: counts.not_signed_in },
                          { value: "service", label: "Service accounts", count: counts.service },
                        ]}
                      />
                    }
                    result={`${plural(rows.length, "person", "people")}`}
                  />
                  <DataTable
                    caption="People"
                    columns={columns}
                    rows={rows}
                    getRowId={(u) => u.id}
                    rowTone={(u) => (u.disabled_at ? "muted" : undefined)}
                    rowAction={(u) => {
                      const items = rowMenu(u);
                      return items.length ? <OverflowMenu size="sm" label={`Actions for ${nameOf(u)}`} items={items} /> : null;
                    }}
                    empty={
                      <EmptyState
                        variant="search"
                        title="Nobody matches"
                        description="Try another name, or show everyone."
                        primary={
                          <Button size="sm" onClick={() => setQ({ q: "", show: "all" })}>
                            Show everyone
                          </Button>
                        }
                      />
                    }
                  />
                </>
              );
            }}
          </AsyncBlock>
        </Section>
      </div>

      {adding && (
        <AddPeopleDialog
          me={me}
          scopes={scopes}
          local={local}
          onClose={() => setAdding(false)}
          onAdded={reload}
          onInvited={() => setInvites((n) => n + 1)}
        />
      )}
      {naming && (
        <NameDialog
          title={naming.id === me.id ? (naming.display_name ? "Change your name" : "Add your name") : naming.display_name ? `Change ${naming.display_name}'s name` : `Add a name for ${naming.email}`}
          description={`Shown instead of ${naming.email} in reviews, access lists and notifications.`}
          initial={naming.display_name ?? ""}
          onClose={() => setNaming(null)}
          onSave={(name) => rename(naming, name)}
        />
      )}
      {secret && (
        <Dialog open title={`New temporary password for ${secret.email}`} onClose={() => void guardSecret("temporary password", () => setSecret(null))}>
          <SecretReveal title="Temporary password" value={secret.password} warning="Share it privately; it is shown once." doneLabel="Done" onDone={() => setSecret(null)} />
        </Dialog>
      )}
    </Page>
  );
}

import { useRef, useState } from "react";
import { api, canIn, type ScopeInfo } from "../api";
import { useBoot } from "../components/boot";
import { RolePicker, useRoles } from "../components/roles";
import { canRotate, RotateTokenDialog, TokenStatusCell, tokenExpiryText, UnusedCount, type ApiToken } from "../components/tokens";
import { useApi } from "../hooks";
import { href } from "../router";
import {
  AdminTabs,
  AsyncBlock,
  Badge,
  Button,
  Card,
  CodeBlock,
  DataTable,
  Dialog,
  Disclosure,
  EmptyState,
  ErrorState,
  Field,
  focusFirstInvalid,
  OverflowMenu,
  Page,
  PageHeader,
  ProjectPicker,
  RelativeTime,
  SecretReveal,
  Select,
  SkeletonRows,
  StatusBadge,
  TextInput,
  useConfirm,
  useToast,
  type Column,
} from "../components/kit";

/**
 * Admin › Service accounts: identities for other systems (AutoCode, CI jobs, scheduled agents) that call Thaliyola
 * with a token. People who manage people create them, give them tokens to share with the other system, and give them
 * project roles. Their writes always wait for review.
 */

type Token = ApiToken;
interface ServiceAccount {
  id: string;
  name: string;
  identifier: string;
  display_name: string | null;
  disabled: boolean;
  created_at: string;
  created_by: string | null;
  last_used_at: string | null;
  tokens: Token[];
  projects: { slug: string; name: string; roles: string[]; role_names: string[] }[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const label = (s: ServiceAccount) => s.display_name || s.name;

export function ServiceAccountsPage() {
  const result = useApi<{ service_accounts: ServiceAccount[] }>("/service-accounts");
  const [creating, setCreating] = useState(false);
  const [tokenFor, setTokenFor] = useState<ServiceAccount | null>(null);
  const [accessFor, setAccessFor] = useState<ServiceAccount | null>(null);

  const newButton = (
    <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
      New service account
    </Button>
  );

  return (
    <Page width="content">
      <PageHeader
        title="Service accounts"
        crumbs={[{ label: "Admin", href: href("/admin") }]}
        nav="admin"
        tabs={<AdminTabs current="service-accounts" />}
        description="Accounts for other systems, such as AutoCode or a CI job, that call Thaliyola with a token. Create one, give it a token to paste into the other system, and give it roles in the projects it should use."
        info={{
          label: "About service accounts",
          content: (
            <>
              <p>A service account reads what its project roles allow, like a person. Viewer is enough to read; Contributor also lets it propose findings and articles.</p>
              <p>Its writes always wait for a person's review: service accounts never publish or approve, and never hold organisation roles.</p>
              <p>Each token is shown once. Revoke a token to stop the system using it, or disable the account to stop all its tokens.</p>
            </>
          ),
        }}
        primary={newButton}
      />
      <AsyncBlock result={result} label="Loading service accounts" errorTitle="Couldn't load the service accounts" skeleton={<SkeletonRows count={4} />}>
        {(data) =>
          data.service_accounts.length ? (
            <div className="pp-sa-list">
              {data.service_accounts.map((s) => (
                <ServiceAccountCard key={s.id} account={s} onChanged={result.reload} onNewToken={() => setTokenFor(s)} onAddAccess={() => setAccessFor(s)} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon="key"
              title="No service accounts yet"
              description="Create one for each system that should call Thaliyola, for example AutoCode reading project context before it plans a change."
              primary={newButton}
            />
          )
        }
      </AsyncBlock>
      {creating && (
        <NewServiceAccountDialog
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            result.reload();
            // Straight on to its first token: that's what the other system needs.
            setTokenFor({ ...created, display_name: created.display_name, disabled: false, created_at: new Date().toISOString(), created_by: null, last_used_at: null, tokens: [], projects: [] });
          }}
        />
      )}
      {tokenFor && <NewTokenDialog account={tokenFor} onClose={() => setTokenFor(null)} onCreated={result.reload} />}
      {accessFor && <ProjectAccessDialog account={accessFor} onClose={() => setAccessFor(null)} onSaved={result.reload} />}
    </Page>
  );
}

function ServiceAccountCard({ account, onChanged, onNewToken, onAddAccess }: { account: ServiceAccount; onChanged: () => void; onNewToken: () => void; onAddAccess: () => void }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [rotating, setRotating] = useState<Token | null>(null);
  const live = account.tokens.filter((t) => !t.revoked_at);
  const revoked = account.tokens.filter((t) => t.revoked_at);

  async function revoke(t: Token) {
    const ok = await confirm({
      title: `Revoke ${t.name}?`,
      body: `Anything using this token as ${label(account)} stops working at once.`,
      confirmLabel: "Revoke token",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/service-accounts/${account.id}/tokens/${t.id}`, { method: "DELETE" });
      toast.success(`Revoked ${t.name}`);
      onChanged();
    } catch (err) {
      toast.error(err, { title: `Couldn't revoke ${t.name}` });
    }
  }

  async function setDisabled(disabled: boolean) {
    if (disabled) {
      const ok = await confirm({
        title: `Disable ${label(account)}?`,
        body: "All its tokens stop working until you enable it again. Its project roles stay.",
        confirmLabel: "Disable",
        tone: "danger",
      });
      if (!ok) return;
    }
    try {
      await api(`/service-accounts/${account.id}`, { method: "PATCH", body: { disabled } });
      toast.success(disabled ? `Disabled ${label(account)}` : `Enabled ${label(account)}`);
      onChanged();
    } catch (err) {
      toast.error(err, { title: `Couldn't ${disabled ? "disable" : "enable"} ${label(account)}` });
    }
  }

  async function removeAccess(p: ServiceAccount["projects"][number]) {
    const ok = await confirm({
      title: `Remove ${label(account)} from ${p.name}?`,
      body: `It loses ${p.role_names.join(", ")} there and can no longer read the project if it's members-only.`,
      confirmLabel: "Remove access",
      tone: "danger",
    });
    if (!ok) return;
    try {
      await api(`/scopes/${encodeURIComponent(p.slug)}/members`, { method: "PUT", body: { email: account.identifier, roles: [] } });
      toast.success(`Removed ${label(account)} from ${p.name}`);
      onChanged();
    } catch (err) {
      toast.error(err, { title: `Couldn't remove access to ${p.name}` });
    }
  }

  const columns: Column<Token>[] = [
    { key: "name", header: "Name", cell: (t) => t.name, primary: true },
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
              ...(canRotate(t) && !account.disabled ? [{ id: "rotate", label: "Rotate…", icon: "refresh" as const, onSelect: () => setRotating(t) }] : []),
              { id: "revoke", label: "Revoke…", icon: "x", tone: "danger", onSelect: () => void revoke(t) },
            ]}
          />
        )
      }
      empty={null}
    />
  );

  return (
    <Card
      title={
        <span className="pp-sa-title">
          {label(account)}
          {account.disabled && <Badge tone="danger">Disabled</Badge>}
          {!account.disabled && <UnusedCount tokens={live} />}
        </span>
      }
      titleLevel={2}
      description={
        <span className="pp-sa-meta">
          <code>{account.identifier}</code>
          <span aria-hidden="true">·</span>
          <span>
            Created <RelativeTime date={account.created_at} />
            {account.created_by ? ` by ${account.created_by}` : ""}
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Last used <RelativeTime date={account.last_used_at} never="never" />
          </span>
        </span>
      }
      actions={
        <div className="pp-sa-actions">
          <Button icon="key" onClick={onNewToken} disabled={account.disabled}>
            Create token
          </Button>
          <OverflowMenu
            label={`More for ${label(account)}`}
            items={[
              { id: "access-page", label: "Everything it can access", icon: "shield", href: href(`/admin/users/${account.id}`) },
              account.disabled
                ? { id: "enable", label: "Enable", icon: "check", onSelect: () => void setDisabled(false) }
                : { id: "disable", label: "Disable…", icon: "x", tone: "danger", onSelect: () => void setDisabled(true) },
            ]}
          />
        </div>
      }
    >
      <h3 className="pp-sa-heading">Tokens</h3>
      {live.length ? (
        table(live, `Tokens of ${label(account)}`)
      ) : (
        <p className="pp-sa-empty">
          No working token.{" "}
          {!account.disabled && (
            <button type="button" className="link-btn" onClick={onNewToken}>
              Create one
            </button>
          )}
        </p>
      )}
      {revoked.length > 0 && (
        <Disclosure summary={`Show revoked (${revoked.length})`} storageKey={`sa-revoked-${account.id}`}>
          {table(revoked, `Revoked tokens of ${label(account)}`)}
        </Disclosure>
      )}

      <h3 className="pp-sa-heading">Project access</h3>
      {account.projects.length ? (
        <ul className="pp-sa-projects">
          {account.projects.map((p) => (
            <li key={p.slug}>
              <a href={href(`/scope/${p.slug}/settings`, { tab: "access" })}>{p.name}</a>
              <span className="pp-sa-roles">{p.role_names.join(", ")}</span>
              <button type="button" className="link-btn danger" onClick={() => void removeAccess(p)} aria-label={`Remove ${label(account)} from ${p.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="pp-sa-empty">Not in any project or space yet: it can read the Team space and Library but write nowhere.</p>
      )}
      <Button variant="ghost" icon="plus" onClick={onAddAccess}>
        Give project access
      </Button>
      {rotating && (
        <RotateTokenDialog
          token={rotating}
          path={`/service-accounts/${account.id}/tokens/${rotating.id}/rotate`}
          who={label(account)}
          onClose={() => setRotating(null)}
          onRotated={onChanged}
          extra={(secret) => <CodeBlock label="Send it as a header" code={`Authorization: Bearer ${secret}`} wrap />}
        />
      )}
    </Card>
  );
}

function NewServiceAccountDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (s: { id: string; name: string; identifier: string; display_name: string | null }) => void }) {
  const [display, setDisplay] = useState("");
  const [name, setName] = useState("");
  const [touchedName, setTouchedName] = useState(false);
  const [nameError, setNameError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const suggested = display
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 41);
  const id = touchedName ? name : suggested;

  return (
    <Dialog open title="New service account" description="For one system that calls Thaliyola, e.g. AutoCode." dismissible={!busy} onClose={onClose}>
      <form
        ref={formRef}
        className="pp-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!NAME_PATTERN.test(id)) {
            setNameError("Use 2 to 41 lowercase letters, digits and hyphens, starting with a letter or digit, e.g. autocode.");
            requestAnimationFrame(() => focusFirstInvalid(formRef.current));
            return;
          }
          setNameError(undefined);
          setBusy(true);
          setError(null);
          try {
            const res = await api<{ id: string; name: string; identifier: string }>("/service-accounts", { method: "POST", body: { name: id, display_name: display.trim() || undefined } });
            onCreated({ ...res, display_name: display.trim() || null });
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" hint="How it appears in Thaliyola, e.g. AutoCode.">
          <TextInput value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="AutoCode" maxLength={100} autoFocus />
        </Field>
        <Field label="Identifier" hint={`Used to give it project roles: service:${id || "…"}. It can't be changed later.`} error={nameError}>
          <TextInput
            value={id}
            onChange={(e) => {
              setTouchedName(true);
              setName(e.target.value.toLowerCase());
            }}
            placeholder="autocode"
            maxLength={41}
          />
        </Field>
        {error ? <ErrorState compact error={error} title="Couldn't create the service account" /> : null}
        <div className="pp-form-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText="Creating">
            Create and make a token
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NewTokenDialog({ account, onClose, onCreated }: { account: ServiceAccount; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState(`${label(account)} token`);
  const [nameError, setNameError] = useState<string>();
  const [days, setDays] = useState("365");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const confirm = useConfirm();
  const origin = window.location.origin;

  const closeAfterReveal = async () => {
    const ok = await confirm({
      title: "Close without copying the token?",
      body: "The token is shown only once. After you close this you can't see it again; you'd have to create another.",
      confirmLabel: "Close anyway",
    });
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      title={created ? `${created.name}: copy the token now` : `Token for ${label(account)}`}
      description={created ? undefined : "Paste it into the other system's Thaliyola connection. Make one token per system or environment."}
      dismissible={!busy}
      onClose={created ? () => void closeAfterReveal() : onClose}
    >
      {created ? (
        <SecretReveal
          title="Token"
          value={created.token}
          warning={`Copy it now and paste it into the other system. It won't be shown again. It acts as ${account.identifier} with that account's project roles.`}
          onDone={onClose}
          extra={
            <>
              <CodeBlock label="Server URL" code={origin} />
              <CodeBlock label="Send it as a header" code={`Authorization: Bearer ${created.token}`} wrap />
              <CodeBlock
                label="Or connect an MCP client (e.g. Claude Code)"
                language="shell"
                code={`claude mcp add --transport http thaliyola ${origin}/mcp \\\n  --header "Authorization: Bearer ${created.token}"`}
              />
              {!account.projects.length && <p className="pp-sa-empty">It isn't in any project yet: use Give project access so it can read them.</p>}
            </>
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
              setNameError("Give the token a name, e.g. where it's used.");
              requestAnimationFrame(() => focusFirstInvalid(formRef.current));
              return;
            }
            setNameError(undefined);
            setBusy(true);
            setError(null);
            try {
              const res = await api<{ token: string; name: string }>(`/service-accounts/${account.id}/tokens`, {
                method: "POST",
                body: { name: name.trim(), expires_in_days: days ? Number(days) : undefined },
              });
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
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="AutoCode production" maxLength={100} />
          </Field>
          <Field label="Expires" hint="When it expires, the other system stops working until you give it a new token.">
            <Select
              value={days}
              onChange={(e) => setDays(e.target.value)}
              options={[
                { value: "90", label: "90 days" },
                { value: "365", label: "1 year" },
                { value: "730", label: "2 years" },
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

function ProjectAccessDialog({ account, onClose, onSaved }: { account: ServiceAccount; onClose: () => void; onSaved: () => void }) {
  const { me, scopes } = useBoot();
  const { data: catalog } = useRoles();
  const toast = useToast();
  const manageable = (s: ScopeInfo) => (s.kind === "project" || s.kind === "team" || s.kind === "library") && canIn(s, "manage_members", me) && !account.projects.some((p) => p.slug === s.slug);
  // Start on a top-level project (roles flow down to its sub-projects), not whichever nested one comes first.
  const [project, setProject] = useState(() => (scopes.find((s) => manageable(s) && !s.parent) ?? scopes.find(manageable))?.slug ?? "");
  const [roles, setRoles] = useState<string[]>(["reader"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const options = scopes.filter(manageable);

  return (
    <Dialog open title={`Give ${label(account)} access`} description="Viewer lets it read; Contributor also lets it propose findings and articles, which people review. Team and Library work too, e.g. for a bot that imports shared guides." dismissible={!busy} onClose={onClose}>
      {options.length ? (
        <form
          className="pp-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!project || !roles.length) return;
            setBusy(true);
            setError(null);
            try {
              await api(`/scopes/${encodeURIComponent(project)}/members`, { method: "PUT", body: { email: account.identifier, roles } });
              const name = scopes.find((s) => s.slug === project)?.name ?? project;
              toast.success(`${label(account)} can now use ${name}`);
              onSaved();
              onClose();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Project or space" hint="A project's roles also apply to its sub-projects.">
            <ProjectPicker searchable value={project} onChange={setProject} scopes={scopes} filter={manageable} includeSpaces />
          </Field>
          <Field label="Roles">
            <RolePicker roles={catalog?.roles} kind="project" value={roles} onChange={setRoles} label="Roles" required />
          </Field>
          {error ? <ErrorState compact error={error} title="Couldn't give access" /> : null}
          <div className="pp-form-actions">
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={busy} loadingText="Saving" disabled={!roles.length}>
              Give access
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p>There's no other project where you can manage access. Ask a Project admin of the project to add {account.identifier} in its Members and access.</p>
          <div className="pp-form-actions">
            <Button onClick={onClose}>Close</Button>
          </div>
        </>
      )}
    </Dialog>
  );
}

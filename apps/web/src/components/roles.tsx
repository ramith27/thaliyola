import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ACCOUNT_STATUS_TEXT, api, may, type AccountStatus, type Me, type ProjectsWithoutAdmin } from "../api";
import { useApi, useAppRoute } from "../hooks";
import { href, navigate } from "../router";
import { PersonInput } from "./people";
import { I } from "./icons";
import { PERMISSION_LABELS } from "./labels";
import { can } from "./permissions";
import {
  AdminTabs,
  AsyncBlock,
  Badge,
  Button,
  Card,
  Checkbox,
  ChoiceCards,
  DataTable,
  Disclosure,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  focusFirstInvalid,
  InfoTip,
  OverflowMenu,
  Page,
  PageHeader,
  Popover,
  Section,
  SplitButton,
  SkeletonRows,
  SkeletonText,
  TextInput,
  Textarea,
  useConfirm,
  useToast,
  type Column,
  type MenuItemSpec,
} from "./kit";

/**
 * Two kinds of roles, plus teams. Project roles (Viewer, Stakeholder, QA, Contributor, Reviewer, Moderator,
 * Project admin, custom roles) decide what someone can do inside a project and the projects under it; they're given
 * per project to people or teams. Organisation roles (Administrator, User manager, Project creator, Team manager,
 * Security lead, Auditor, custom roles) are jobs across all of Thaliyola, given once per person. Administrator is the
 * organisation role that can do everything. Every role has a stable key (shown only as a muted "ID") and a name.
 */

export interface CatalogRole {
  key: string;
  kind: "org" | "project";
  name: string;
  description: string;
  permissions: string[];
  builtin: boolean;
  position?: number;
  kind_name?: "Project role" | "Organisation role";
  /** Only on the Administrator row. */
  admin?: true;
  /** "Label: description" for each permission. */
  allows?: string[];
  /** Holder counts, or null when the caller can't see access. */
  holders?: { people: number; teams: number; projects: number; invitations: number } | null;
  /** Permission keys the caller may switch on this role ([] = locked). */
  editable_permissions?: string[];
  /** May change its name and description. */
  can_edit?: boolean;
  can_delete?: boolean;
  permissions_note?: string | null;
}

/** @deprecated use CatalogRole */
export type Role = CatalogRole;

export interface Catalog {
  roles: CatalogRole[];
  project_permissions: Record<string, string>;
  org_permissions: Record<string, string>;
  permission_labels?: Record<string, string>;
  model?: { project: string; org: string; admin: string; team: string; inherit: string; grant: string };
  team_roles?: { member: string; lead: string };
  can_manage_roles?: boolean;
  can_see_holders?: boolean;
}

interface RoleHolders {
  role: { key: string; name: string; kind: "org" | "project" };
  people: { id: string; email: string | null; name: string | null; status: AccountStatus; via?: "account" | "ADMIN_EMAILS" }[];
  projects: { slug: string; name: string; people: { id?: string; email: string; name: string | null }[]; teams: { slug: string; name: string }[] }[];
  other_projects: number;
}

/** The one sentence used everywhere to explain roles. */
export const ACCESS_SENTENCE =
  "Project roles decide what you can do inside a project; organisation roles, such as Administrator, decide what you can do across Thaliyola.";

export const TEAM_ROLE_TEXT = { member: "Member", lead: "Lead (chooses the team's members)" };

export function useRoles() {
  return useApi<Catalog>("/roles");
}

/** Role names for keys: "…" while the catalogue loads, "Unknown role (key)" for keys it doesn't have. */
export const roleNames = (roles: CatalogRole[] | undefined, keys: string[]) =>
  !roles ? "…" : keys.map((k) => roles.find((r) => r.key === k)?.name ?? `Unknown role (${k})`).join(", ") || "none";

/** Server-sent names when a response has them, else names from the catalogue. */
export const namesOr = (names: string[] | undefined, roles: CatalogRole[] | undefined, keys: string[]) => (names?.length ? names.join(", ") : roleNames(roles, keys));

/**
 * The one change a picker click makes, as add / remove. Sending only that (not the whole list) means two quick clicks
 * can't undo each other while the first save is still on its way.
 */
export const roleDelta = (before: string[], next: string[]) => ({
  add: next.filter((k) => !before.includes(k)),
  remove: before.filter((k) => !next.includes(k)),
});

/** "gave Reviewer", "took away QA", from a change result's names (falling back to the catalogue). */
export function changedText(
  res: { added?: string[]; removed?: string[]; added_names?: string[]; removed_names?: string[] } | undefined,
  roles: CatalogRole[] | undefined,
): string {
  if (!res) return "";
  const added = res.added_names ?? roleNames(roles, res.added ?? []).split(", ").filter((x) => x && x !== "none");
  const removed = res.removed_names ?? roleNames(roles, res.removed ?? []).split(", ").filter((x) => x && x !== "none");
  return [added.length ? `gave ${added.join(", ")}` : "", removed.length ? `took away ${removed.join(", ")}` : ""].filter(Boolean).join(", ") || "no change";
}

/** A person's name, linked to everything they can access when the viewer may see that. */
export function PersonLink({ id, name, canSee }: { id?: string; name: string; canSee: boolean }) {
  return id && canSee ? <a href={href(`/admin/users/${id}`)}>{name}</a> : <>{name}</>;
}

/** A permission's label ("Manage access"), falling back to the built-in labels, then its key, on older servers. */
export const permissionLabel = (catalog: Catalog | null | undefined, key: string) => catalog?.permission_labels?.[key] ?? PERMISSION_LABELS[key] ?? key;

/** Like the server's norm(): what a role's ID becomes for a name. */
export const roleKeyFor = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[_0-9]+|_+$/g, "");

const ROLE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/** "x people", "1 person". */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const isAdministrator = (r: CatalogRole) => !!r.admin || r.key === "admin";
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((k) => b.includes(k));

// ---- RolePicker ---------------------------------------------------------------------------------------------

/**
 * A compact multi-select (RolePicker v2): the chosen roles' names on an input-styled trigger, opening to a checklist
 * with what each role allows. Focus moves into the list (arrow keys, Home/End, Esc); changes apply when it closes,
 * as one onChange call. On phones it opens as a bottom sheet.
 */
export function RolePicker({
  roles,
  kind,
  value,
  onChange,
  label,
  empty = "none",
  required = false,
  disabledReason,
  disabled = false,
  id,
  "aria-describedby": describedBy,
}: {
  roles: CatalogRole[] | undefined;
  kind: "org" | "project";
  value: string[];
  onChange: (next: string[]) => void;
  label: string;
  empty?: string;
  /** The last chosen role can't be unchecked (access is taken away with Remove instead). */
  required?: boolean;
  /** Why a role can't be chosen or removed here (it is then disabled, with this as its description and title). */
  disabledReason?: (r: CatalogRole) => string | undefined;
  disabled?: boolean;
  /** Set by a surrounding kit Field. */
  id?: string;
  "aria-describedby"?: string;
}) {
  const options = (roles ?? []).filter((r) => r.kind === kind);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(value);
  const [blocked, setBlocked] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const names = value.length ? roleNames(roles, value) : empty;

  const show = () => {
    setDraft(value);
    setBlocked(false);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    if (!sameSet(draft, value)) onChange(draft);
  };
  const toggle = (key: string) => {
    if (draft.includes(key)) {
      if (required && draft.length === 1) {
        setBlocked(true);
        return;
      }
      setDraft(draft.filter((k) => k !== key));
    } else setDraft([...draft, key]);
    setBlocked(false);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const boxes = Array.from(e.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not(:disabled)'));
    if (!boxes.length) return;
    e.preventDefault();
    const at = boxes.indexOf(document.activeElement as HTMLInputElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? boxes.length - 1 : e.key === "ArrowDown" ? Math.min(boxes.length - 1, at + 1) : Math.max(0, at < 0 ? 0 : at - 1);
    boxes[next]?.focus();
  };

  return (
    <span className="pp-role-picker">
      <button
        type="button"
        ref={trigger}
        id={id}
        className="pp-role-picker-trigger role-picker-button"
        aria-label={`${label}: ${names}`}
        aria-describedby={describedBy}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
      >
        <span className="pp-role-picker-value" data-empty={value.length ? undefined : true}>
          {names}
        </span>
        <I name="chevron-down" size={16} className="pp-role-picker-chevron" />
      </button>
      <Popover anchorRef={trigger} open={open} onClose={close} label={label} id={menuId} sheetOnMobile className="pp-role-menu" onKeyDown={onKeyDown}>
        <p className="pp-role-menu-title">{label}</p>
        <div className="pp-role-menu-list" role="group" aria-label={label}>
          {options.map((r) => {
            const reason = disabledReason?.(r);
            const chosen = draft.includes(r.key);
            const last = required && chosen && draft.length === 1;
            return (
              <div key={r.key} className="pp-role-option" data-state={chosen ? "on" : undefined} title={reason ?? (last ? "Use Remove to take away access" : undefined)}>
                <Checkbox
                  label={r.name}
                  description={reason ?? (r.description || (r.allows?.length ? r.allows.map((a) => a.split(":")[0]).join(", ") : r.permissions.join(", ")))}
                  checked={chosen}
                  disabled={!!reason}
                  aria-disabled={last || undefined}
                  onChange={() => toggle(r.key)}
                />
              </div>
            );
          })}
          {!options.length && <p className="muted small">{roles ? "No roles of this kind." : "Loading roles"}</p>}
        </div>
        {blocked && (
          <p className="pp-role-menu-blocked" role="alert">
            <I name="alert" size={14} /> Keep at least one role. Use Remove to take away access.
          </p>
        )}
        <div className="pp-role-menu-foot">
          {required && !blocked && <span className="muted small">Use Remove to take away access.</span>}
          <Button size="sm" variant="secondary" onClick={close}>
            Done
          </Button>
        </div>
      </Popover>
    </span>
  );
}

// ---- PermissionMatrix ---------------------------------------------------------------------------------------

/** Which permissions each role has, as a table: permission labels down the side, role names across. */
export function PermissionMatrix({ catalog, kind }: { catalog: Catalog; kind: "org" | "project" }) {
  const perms = kind === "project" ? catalog.project_permissions : catalog.org_permissions;
  const roles = catalog.roles.filter((r) => r.kind === kind).sort((a, b) => Number(!!b.admin) - Number(!!a.admin));
  const yes = (r: CatalogRole, ok: boolean) => (
    <td key={r.key} aria-label={`${r.name}: ${ok ? "yes" : "no"}`}>
      {ok ? <I name="check" size={16} className="pp-perm-yes" /> : <span className="pp-perm-no" aria-hidden="true">·</span>}
    </td>
  );
  return (
    <div className="table-wrap pp-perm-wrap" tabIndex={0} role="region" aria-label={kind === "project" ? "What each project role allows" : "What each organisation role allows"}>
      <table className="table pp-perm-matrix">
        <thead>
          <tr>
            <th scope="col">{kind === "project" ? "Project permission" : "Organisation permission"}</th>
            {roles.map((r) => (
              <th key={r.key} scope="col" title={r.description}>
                {r.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(perms).map(([p, text]) => (
            <tr key={p}>
              <th scope="row" title={text}>
                <span className="pp-perm-label">{permissionLabel(catalog, p)}</span>
                <span className="pp-perm-desc">{text}</span>
              </th>
              {roles.map((r) => yes(r, r.permissions.includes(p)))}
            </tr>
          ))}
          {kind === "org" && (
            <tr>
              <th scope="row">System settings and making Administrators</th>
              {roles.map((r) => yes(r, isAdministrator(r)))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---- Roles and access page ----------------------------------------------------------------------------------

/** "Everything one person can access": a person picker for those who may see others' access, else a link to their own. */
function AccessLookup({ me }: { me: Me }) {
  const ids = useId();
  const [who, setWho] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (!can.seeAccess(me))
    return (
      <Card padding="sm" title="Your access" description="Your organisation roles, your teams and every project role you hold, with where each one comes from.">
        <Button href={href("/account", { section: "access" })} icon="shield">
          See everything you can access
        </Button>
      </Card>
    );
  return (
    <Card
      as="section"
      title="Look someone up"
      titleLevel={2}
      description={
        <>
          Everything one person can access, and why. Or <a href={href("/account", { section: "access" })}>see your own</a>.
        </>
      }
    >
      <form
        className="pp-lookup"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setProblem(null);
          const q = who.trim().toLowerCase();
          if (!q) {
            setProblem("Type a name or email to look someone up.");
            return;
          }
          setBusy(true);
          try {
            const { people } = await api<{ people: { id?: string; email: string }[] }>(`/people?q=${encodeURIComponent(q)}&limit=5`);
            const hit = people.find((p) => p.email.toLowerCase() === q) ?? (people.length === 1 ? people[0] : undefined);
            if (hit?.id) navigate(`/admin/users/${hit.id}`);
            else setProblem("No single active person matches; pick one from the list.");
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field pp-lookup-input" data-invalid={problem ? true : undefined}>
          <span className="field-label" id={`${ids}-label`}>
            Person
          </span>
          <PersonInput
            value={who}
            onChange={setWho}
            placeholder="Find a person by name or email"
            label="Person to look up"
            aria-describedby={problem ? `${ids}-problem` : undefined}
            aria-invalid={Boolean(problem)}
          />
        </div>
        <Button type="submit" loading={busy} loadingText="Looking up">
          See their access
        </Button>
      </form>
      {problem && (
        <p className="field-error" id={`${ids}-problem`} role="alert">
          {problem}
        </p>
      )}
      {error ? <ErrorState compact error={error} title="Couldn't look them up" /> : null}
    </Card>
  );
}

/** Who holds a role: people for organisation roles, projects with their people and teams for project roles. */
function Holders({ role }: { role: CatalogRole }) {
  const result = useApi<RoleHolders>(`/roles/${encodeURIComponent(role.key)}/holders`);
  return (
    <AsyncBlock result={result} label={`Loading who has ${role.name}`} skeleton={<SkeletonText lines={4} />} errorTitle="Couldn't load who has it">
      {(data) =>
        role.kind === "org" ? (
          data.people.length ? (
            <ul className="pp-holders">
              {data.people.map((p) => (
                <li key={p.id}>
                  <a href={href(`/admin/users/${p.id}`)}>{p.name ?? p.email ?? "Service account"}</a>
                  {p.name && p.email && <span className="muted"> {p.email}</span>}
                  {p.status !== "active" && <span className="muted"> · {ACCOUNT_STATUS_TEXT[p.status] ?? p.status}</span>}
                  {p.via === "ADMIN_EMAILS" && (
                    <span className="muted">
                      {" "}
                      · set on the server <InfoTip label="Which setting">ADMIN_EMAILS in the server configuration, so it can't be changed here.</InfoTip>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState variant="compact" title="Nobody holds it" />
          )
        ) : (
          <>
            {data.projects.length ? (
              <ul className="pp-holders">
                {data.projects.map((p) => (
                  <li key={p.slug}>
                    <a href={href(`/scope/${p.slug}/settings`, { tab: "access" })}>{p.name}</a>
                    <span className="pp-holders-who">
                      {p.people.map((x, i) => (
                        <span key={x.email}>
                          {i > 0 && ", "}
                          <PersonLink id={x.id} name={x.name ?? x.email} canSee />
                        </span>
                      ))}
                      {p.teams.map((t, i) => (
                        <span key={`team-${t.slug}`}>
                          {(i > 0 || p.people.length > 0) && ", "}
                          <a href={href(`/teams/${t.slug}`)}>team {t.name}</a>
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState variant="compact" title="Nobody holds it directly in a project you can see" />
            )}
            {data.other_projects > 0 && <p className="muted small">and {count(data.other_projects, "project", "projects")} you can't see</p>}
          </>
        )
      }
    </AsyncBlock>
  );
}

function heldBy(r: CatalogRole) {
  const h = r.holders;
  if (!h) return null;
  if (isAdministrator(r)) return count(h.people, "Administrator", "Administrators");
  const parts = [count(h.people, "person", "people")];
  if (r.kind === "project") parts.push(count(h.teams, "team", "teams"));
  if (h.invitations) parts.push(count(h.invitations, "open invitation", "open invitations"));
  return parts.join(" · ");
}

/** "Order service v2 and 1 project you can't see now have no Project admin." (empty when nothing lost one). */
function withoutAdminText(res: ProjectsWithoutAdmin | undefined): string {
  const lost = res?.projects_without_admin ?? [];
  const other = res?.other_projects_without_admin ?? 0;
  if (!lost.length && !other) return "";
  const names = [...lost.map((p) => p.name), ...(other ? [`${count(other, "project", "projects")} you can't see`] : [])].join(", ");
  return `${names} now ${lost.length + other === 1 ? "has" : "have"} no Project admin.`;
}

type RoleDialog = { mode: "new"; kind: "project" | "org" } | { mode: "edit"; role: CatalogRole } | { mode: "holders"; role: CatalogRole } | null;

/**
 * Roles and access, for everyone (#/roles), and the Admin tab (#/admin/roles): the model in plain words, every role
 * with what it allows and (for people who can see access) who holds it, and the dialogs to create and change custom
 * roles for those who may.
 */
export function RolesPage({ me }: { me: Me }) {
  const result = useRoles();
  const { data, reload } = result;
  const route = useAppRoute();
  const inAdmin = route.path[0] === "admin";
  const confirm = useConfirm();
  const toast = useToast();
  const [dialog, setDialog] = useState<RoleDialog>(null);

  /** After a save or delete: a success toast, or a warning that stays when projects lost their last Project admin. */
  const done = (message: string, res: ProjectsWithoutAdmin | undefined) => {
    const lost = withoutAdminText(res);
    if (lost) toast.warning(message, { description: lost, duration: 15000 });
    else toast.success(message);
    reload();
  };

  async function remove(r: CatalogRole) {
    const lose = r.holders ? `${count(r.holders.people, "person", "people")}${r.kind === "project" ? ` and ${count(r.holders.teams, "team", "teams")}` : ""} lose it.` : "Everyone who holds it loses it.";
    const ok = await confirm({ title: `Delete ${r.name}?`, body: lose, confirmLabel: "Delete role", tone: "danger" });
    if (!ok) return;
    try {
      const res = await api<ProjectsWithoutAdmin>(`/roles/${encodeURIComponent(r.key)}`, { method: "DELETE" });
      done(`Deleted ${r.name}`, res);
    } catch (err) {
      toast.error(err, { title: `Couldn't delete ${r.name}` });
    }
  }

  const canManage = !!data?.can_manage_roles;
  const header = (
    <PageHeader
      title="Roles and access"
      crumbs={inAdmin ? [{ label: "Admin", href: href("/admin") }] : undefined}
      nav={inAdmin ? "admin" : undefined}
      tabs={inAdmin ? <AdminTabs current="roles" /> : undefined}
      description={ACCESS_SENTENCE}
      primary={
        canManage ? (
          <SplitButton
            variant="primary"
            icon="plus"
            label="New role"
            onClick={() => setDialog({ mode: "new", kind: "project" })}
            menuLabel="More kinds of role"
            menu={[
              { id: "project", label: "New project role", icon: "folder", onSelect: () => setDialog({ mode: "new", kind: "project" }) },
              { id: "org", label: "New organisation role", icon: "shield", onSelect: () => setDialog({ mode: "new", kind: "org" }) },
            ]}
          />
        ) : undefined
      }
    />
  );

  return (
    <Page width="wide">
      {header}
      <AsyncBlock
        result={result}
        label="Loading roles"
        errorTitle="Couldn't load the roles"
        skeleton={
          <>
            <SkeletonText lines={3} />
            <SkeletonRows count={6} />
          </>
        }
      >
        {(catalog) => {
          const model = catalog.model;
          const holdersColumn = !!catalog.can_see_holders || catalog.roles.some((r) => r.holders);
          const columns = (kind: "project" | "org"): Column<CatalogRole>[] => {
            const perms = kind === "project" ? catalog.project_permissions : catalog.org_permissions;
            return [
              {
                key: "role",
                header: "Role",
                width: "14rem",
                cell: (r) => (
                  <div className="pp-role-cell">
                    <span className="pp-role-name">
                      <strong>{r.name}</strong>
                      {r.builtin && (
                        <Badge variant="outline" icon="lock" title="Built-in roles keep their ID">
                          Built-in
                        </Badge>
                      )}
                      <InfoTip label={`ID of ${r.name}`}>
                        Claude and the API call this role <code>{r.key}</code>.
                      </InfoTip>
                    </span>
                  </div>
                ),
              },
              {
                key: "for",
                header: "What it's for",
                cell: (r) => (
                  <div className="pp-role-for">
                    {r.description && <p>{r.description}</p>}
                    {isAdministrator(r) ? (
                      // Wrapping text, not a Badge: a one-line badge this long widens the phone layout.
                      <p className="pp-admin-all">
                        <I name="shield" size={14} /> Everything, including system settings and making other Administrators
                      </p>
                    ) : (
                      <span className="pp-chips">
                        {r.permissions.map((p) => (
                          <Badge key={p} title={perms[p]}>
                            {permissionLabel(catalog, p)}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </div>
                ),
              },
              ...(holdersColumn
                ? [
                    {
                      key: "held",
                      header: "Held by",
                      width: "13rem",
                      cell: (r: CatalogRole) => (
                        <div className="pp-held">
                          <span className="tabular">{heldBy(r) ?? <span className="muted">—</span>}</span>
                          {catalog.can_see_holders && (
                            <Button size="sm" variant="ghost" aria-haspopup="dialog" onClick={() => setDialog({ mode: "holders", role: r })}>
                              Who has it
                            </Button>
                          )}
                        </div>
                      ),
                    },
                  ]
                : []),
            ];
          };
          const rowMenu = (r: CatalogRole): MenuItemSpec[] => {
            if (isAdministrator(r)) return [];
            const mayEdit = !!r.can_edit || !!r.editable_permissions?.length;
            const items: MenuItemSpec[] = [];
            if (mayEdit) items.push({ id: "edit", label: r.builtin ? "Rename…" : "Edit…", icon: "pencil", onSelect: () => setDialog({ mode: "edit", role: r }) });
            if (r.can_delete) {
              if (items.length) items.push({ type: "separator" });
              items.push({ id: "delete", label: "Delete…", icon: "trash", tone: "danger", onSelect: () => void remove(r) });
            }
            return items;
          };
          const table = (kind: "project" | "org") => {
            const rows = catalog.roles.filter((r) => r.kind === kind).sort((a, b) => Number(!!b.admin) - Number(!!a.admin));
            return (
              <DataTable
                caption={kind === "project" ? "Project roles" : "Organisation roles"}
                columns={columns(kind)}
                rows={rows}
                getRowId={(r) => r.key}
                rowAction={(r) => {
                  const items = rowMenu(r);
                  return items.length ? <OverflowMenu items={items} size="sm" label={`Actions for ${r.name}`} /> : null;
                }}
                empty={<EmptyState variant="compact" title={kind === "project" ? "No project roles yet" : "No organisation roles yet"} />}
              />
            );
          };

          return (
            <>
              {model && (
                <Disclosure summary="How roles work" storageKey="roles.how-it-works" className="pp-model-disclosure">
                <div className="pp-model-grid">
                  <Card padding="sm" title="Project roles">
                    <p className="pp-card-text">{model.project}</p>
                  </Card>
                  <Card padding="sm" title="Organisation roles">
                    <p className="pp-card-text">{model.org}</p>
                    <p className="pp-card-text">{model.admin}</p>
                  </Card>
                  <Card padding="sm" title="Teams">
                    <p className="pp-card-text">{model.team}</p>
                  </Card>
                  <Card padding="sm" title="Rules">
                    <p className="pp-card-text">{model.inherit}</p>
                    <p className="pp-card-text">{model.grant}</p>
                  </Card>
                </div>
                </Disclosure>
              )}
              <AccessLookup me={me} />

              <Section
                title="Project roles"
                description="Given per project to people or teams, in the project's Members and access; several roles add up."
              >
                {table("project")}
                <div className="pp-matrix-block">
                  <h3 className="pp-subheading">What each project role allows</h3>
                  <PermissionMatrix catalog={catalog} kind="project" />
                </div>
              </Section>

              <Section
                title="Organisation roles"
                description={
                  <>
                    Given once per person on the {can.manageUsers(me) ? <a href={href("/admin/users")}>People</a> : "People"} page; only Administrators make
                    Administrators.
                  </>
                }
              >
                {table("org")}
                <div className="pp-matrix-block">
                  <h3 className="pp-subheading">What each organisation role allows</h3>
                  <PermissionMatrix catalog={catalog} kind="org" />
                </div>
              </Section>

              {dialog?.mode === "holders" && (
                <Dialog open title={`Who has ${dialog.role.name}`} description={heldBy(dialog.role) ?? undefined} onClose={() => setDialog(null)} footer={<Button onClick={() => setDialog(null)}>Close</Button>}>
                  <Holders role={dialog.role} />
                </Dialog>
              )}
              {(dialog?.mode === "new" || dialog?.mode === "edit") && (
                <RoleDialog
                  key={dialog.mode === "edit" ? dialog.role.key : `new-${dialog.kind}`}
                  catalog={catalog}
                  me={me}
                  role={dialog.mode === "edit" ? dialog.role : undefined}
                  initialKind={dialog.mode === "edit" ? dialog.role.kind : dialog.kind}
                  onClose={() => setDialog(null)}
                  onSaved={(message, res) => {
                    setDialog(null);
                    done(message, res);
                  }}
                />
              )}
            </>
          );
        }}
      </AsyncBlock>
    </Page>
  );
}

/** New role (kind, name, ID, description, permissions) or edit/rename one, in a dialog. The server decides what may change. */
function RoleDialog({
  catalog,
  me,
  role,
  initialKind,
  onClose,
  onSaved,
}: {
  catalog: Catalog;
  me: Me;
  role?: CatalogRole;
  initialKind: "org" | "project";
  onClose: () => void;
  onSaved: (message: string, res: ProjectsWithoutAdmin | undefined) => void;
}) {
  const [kind, setKind] = useState<"org" | "project">(initialKind);
  const [key, setKey] = useState<string | null>(null);
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [chosen, setChosen] = useState<string[]>(role?.permissions ?? (initialKind === "project" ? ["read"] : []));
  const [errors, setErrors] = useState<{ name?: string; id?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const formId = useId();
  const permissions = kind === "project" ? catalog.project_permissions : catalog.org_permissions;
  const id = key ?? roleKeyFor(name);
  const textLocked = !!role && !role.can_edit;
  const editable = (p: string) => (role ? !!role.editable_permissions?.includes(p) : kind === "project" ? p !== "read" : may(me, p));
  const kindWord = kind === "project" ? "project" : "organisation";

  async function submit() {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Give the role a name.";
    if (!role && id && !ROLE_ID_PATTERN.test(id)) next.id = "Use lowercase letters, digits and _, starting with a letter.";
    setErrors(next);
    if (Object.keys(next).length) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (role) {
        const changed = !sameSet(chosen, role.permissions);
        const patch: Record<string, unknown> = role.can_edit ? { name, description } : {};
        if (changed) patch.permissions = chosen;
        const res = await api<ProjectsWithoutAdmin>(`/roles/${encodeURIComponent(role.key)}`, { method: "PATCH", body: patch });
        onSaved(`Saved ${name || role.name}`, res);
      } else {
        const res = await api<ProjectsWithoutAdmin>("/roles", { method: "POST", body: { key: id || undefined, name, description, permissions: chosen, kind } });
        onSaved(`Created ${name}`, res);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="lg"
      title={role ? (role.builtin ? `Rename ${role.name}` : `Edit ${role.name}`) : `New ${kindWord} role`}
      description={role ? role.kind_name ?? (role.kind === "project" ? "Project role" : "Organisation role") : undefined}
      dismissible={!busy}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText={role ? "Saving" : "Creating"}>
            {role ? "Save role" : "Create role"}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        id={formId}
        className="pp-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!role && catalog.can_manage_roles && (
          <ChoiceCards
            name={`${formId}-kind`}
            legend="Kind"
            columns={2}
            value={kind}
            onChange={(v) => {
              const k = v as "org" | "project";
              setKind(k);
              setChosen(k === "project" ? ["read"] : []);
            }}
            options={[
              { value: "project", label: "Project role", description: "Given per project, to people or teams." },
              { value: "org", label: "Organisation role", description: "Given once per person, across all of Thaliyola." },
            ]}
          />
        )}
        <Field label="Name" error={errors.name}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="QA lead" maxLength={100} disabled={textLocked} />
        </Field>
        {!role && (
          <Field label="ID (used by Claude and the API)" hint="Filled in from the name. Lowercase letters, digits and _; starts with a letter." error={errors.id} optional>
            <TextInput className="pp-mono" value={id} onChange={(e) => setKey(e.target.value)} placeholder="qa_lead" maxLength={40} spellCheck={false} />
          </Field>
        )}
        <Field label="Description" optional counter={{ value: description.length, max: 500 }}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What people with this role do" maxLength={500} minRows={2} disabled={textLocked} />
        </Field>
        {textLocked && <p className="pp-inline-note">You can't rename this role; you can change the permissions that are switched on below.</p>}
        <fieldset className="pp-perm-list">
          <legend className="field-label">Permissions</legend>
          {Object.entries(permissions).map(([p, text]) => (
            <Checkbox
              key={p}
              label={permissionLabel(catalog, p)}
              description={text}
              checked={chosen.includes(p)}
              disabled={!editable(p)}
              onChange={() => setChosen((c) => (c.includes(p) ? c.filter((x) => x !== p) : [...c, p]))}
            />
          ))}
        </fieldset>
        {role?.permissions_note && <p className="pp-inline-note">{role.permissions_note}</p>}
        {!role && kind === "project" && <p className="pp-inline-note">Every project role includes Read.</p>}
        {!role && kind === "org" && !can.makeAdministrator(me) && <p className="pp-inline-note">You can only include permissions you have yourself.</p>}
        {error ? <ErrorState compact error={error} title={role ? "Couldn't save the role" : "Couldn't create the role"} /> : null}
      </form>
    </Dialog>
  );
}

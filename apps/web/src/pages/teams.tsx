import { useId, useRef, useState, type FormEvent } from "react";
import { ACCOUNT_STATUS_TEXT, api, canIn, type AccountStatus, type Me, type ScopeInfo, type TeamChange, type TeamMemberChange } from "../api";
import { useBoot } from "../components/boot";
import { can } from "../components/permissions";
import { plural } from "../components/labels";
import { useApi, useAppRoute, useQueryState } from "../hooks";
import { href, navigate } from "../router";
import { changedText, namesOr, roleDelta, RolePicker, TEAM_ROLE_TEXT, useRoles, type CatalogRole } from "../components/roles";
import { PersonInput } from "../components/people";
import {
  displayName,
  InfoTip,
  AsyncBlock,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
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
  PersonChip,
  ProjectPicker,
  RelativeTime,
  SearchInput,
  Section,
  Select,
  Sheet,
  SkeletonCard,
  SkeletonRows,
  Switch,
  TextInput,
  Textarea,
  useConfirm,
  useToast,
  type Column,
  type MenuItemSpec,
} from "../components/kit";

interface TeamSummary {
  slug: string;
  name: string;
  description: string;
  members: number;
  mine: boolean;
  /** The caller's place in the team (member or lead), not a project role. */
  my_role: "member" | "lead" | null;
  can_manage: boolean;
  projects: { slug: string; name: string; role: string; roles?: string[]; role_names?: string[] }[];
}

const TEAM_LEAD =
  "A team is a group of people that gets project roles like a person does; everyone in it gets them too. Its leads choose its members and can start projects for it. Being a lead gives no extra access.";

const slugFor = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** New team: name, description, and the link it gets (editable under Advanced). Goes to the team on success. */
function NewTeamDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [short, setShort] = useState<string | null>(null);
  const [errors, setErrors] = useState<{ name?: string; slug?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  const slug = short ?? slugFor(name);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad: typeof errors = {};
    if (!name.trim()) bad.name = "Give the team a name.";
    else if (!slug) bad.slug = "The link needs at least one letter or digit.";
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) bad.slug = "Use lowercase letters, digits and -.";
    setErrors(bad);
    if (Object.keys(bad).length) {
      requestAnimationFrame(() => focusFirstInvalid(formRef.current));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api("/teams", { method: "POST", body: { slug, name: name.trim(), description: description || undefined } });
      toast.success(`Created ${name.trim()}`);
      onClose();
      navigate(`/teams/${slug}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open title="New team" description="A group of people who get access to projects together." dismissible={!busy} onClose={onClose}>
      <form ref={formRef} className="pp-form" noValidate onSubmit={submit}>
        <Field label="Team name" error={errors.name}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Payments" maxLength={200} />
        </Field>
        <Field label="Description" optional>
          <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What they work on" />
        </Field>
        <p className="pp-inline-note">
          Link: <code>#/teams/{slug || "…"}</code>
        </p>
        <Disclosure summary="Advanced">
          <Field label="Short name (used in the link)" hint="Lowercase letters, digits and -. Filled in from the name." error={errors.slug} optional>
            <TextInput className="pp-mono" value={slug} onChange={(e) => setShort(e.target.value)} spellCheck={false} />
          </Field>
        </Disclosure>
        {error ? <ErrorState compact error={error} title="Couldn't create the team" /> : null}
        <div className="pp-form-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText="Creating">
            Create team
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function TeamCard({ t, roles }: { t: TeamSummary; roles: CatalogRole[] | undefined }) {
  return (
    <Card href={href(`/teams/${t.slug}`)} title={t.name} padding="sm" className="pp-team-card">
      {t.mine && (
        <span className="pp-team-badge">
          {t.my_role === "lead" ? (
            <Badge tone="accent">Lead</Badge>
          ) : (
            <Badge tone="neutral">Member</Badge>
          )}
        </span>
      )}
      {t.description && <p className="pp-card-text">{t.description}</p>}
      <p className="pp-team-meta">
        <span className="tabular">{plural(t.members, "member")}</span>
      </p>
      {t.projects.length ? (
        <p className="pp-team-projects">
          <span className="muted">Project roles: </span>
          {t.projects.map((p, i) => (
            <span key={p.slug}>
              {i > 0 && ", "}
              {p.name} ({namesOr(p.role_names, roles, p.roles ?? [p.role])})
            </span>
          ))}
        </p>
      ) : (
        <p className="pp-team-projects muted">No projects yet</p>
      )}
    </Card>
  );
}

/** Teams: groups of people that work on one or more projects. */
export function TeamsPage({ me }: { me: Me }) {
  const result = useApi<{ teams: TeamSummary[] }>("/teams");
  const catalog = useRoles();
  const [creating, setCreating] = useState(false);
  const route = useAppRoute();
  const [qs, setQs] = useQueryState(route, { q: "" });
  const filter = qs.q ?? "";
  const setFilter = (v: string) => setQs({ q: v });
  const mayCreate = can.manageTeams(me);

  return (
    <Page width="content">
      <PageHeader
        title="Teams"
        description="Groups of people who get the same project roles, so access follows people as they join or leave."
        info={{
          label: "How teams work",
          content: (
            <>
              {catalog.data?.model?.team ?? TEAM_LEAD} Add a team to any number of projects.
            </>
          ),
        }}
        primary={
          mayCreate ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New team
            </Button>
          ) : undefined
        }
      />
      <AsyncBlock
        result={result}
        label="Loading teams"
        errorTitle="Couldn't load the teams"
        skeleton={
          <div className="pp-card-grid">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        }
        isEmpty={(d) => !d.teams.length}
        empty={
          mayCreate ? (
            <EmptyState
              icon="team"
              title="No teams yet"
              description="Teams give a group of people the same project roles, so access follows people as they join or leave."
              primary={
                <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                  New team
                </Button>
              }
            />
          ) : (
            <EmptyState variant="locked" icon="team" title="No teams yet" description="Ask an Administrator or a Team manager to create one." />
          )
        }
      >
        {(data) => {
          const text = filter.trim().toLowerCase();
          const match = (t: TeamSummary) => !text || t.name.toLowerCase().includes(text) || t.description.toLowerCase().includes(text);
          const mine = data.teams.filter((t) => t.mine && match(t));
          const others = data.teams.filter((t) => !t.mine && match(t));
          return (
            <div className="pp-stack">
              {data.teams.length > 8 && (
                <div className="pp-filter">
                  <SearchInput value={filter} onChange={setFilter} label="Filter teams" placeholder="Filter teams" resultCount={mine.length + others.length} />
                </div>
              )}
              {mine.length > 0 && (
                <Section title="Your teams" count={mine.length}>
                  <div className="pp-card-grid">
                    {mine.map((t) => (
                      <TeamCard key={t.slug} t={t} roles={catalog.data?.roles} />
                    ))}
                  </div>
                </Section>
              )}
              {others.length > 0 && (
                <Section title={mine.length ? "Other teams" : "All teams"} count={others.length}>
                  <div className="pp-card-grid">
                    {others.map((t) => (
                      <TeamCard key={t.slug} t={t} roles={catalog.data?.roles} />
                    ))}
                  </div>
                </Section>
              )}
              {!mine.length && !others.length && (
                <EmptyState variant="search" title="No teams match" primary={<Button onClick={() => setFilter("")}>Clear the filter</Button>} />
              )}
            </div>
          );
        }}
      </AsyncBlock>
      {creating && <NewTeamDialog onClose={() => setCreating(false)} />}
    </Page>
  );
}
TeamsPage.keepMountedOnQuery = true;

interface Member {
  id: string;
  email: string;
  name: string | null;
  role: "member" | "lead";
  added_at: string;
  pending: boolean;
  status?: AccountStatus;
}

interface TeamDetail {
  slug: string;
  name: string;
  description: string;
  members: Member[];
  leads?: number;
  projects: { slug: string; name: string; kind: string; role: string; roles?: string[]; role_names?: string[] }[];
  can_manage: boolean;
  /** May change who is in the team (needs the team's project roles, unless Administrator). */
  can_change_members?: boolean;
  change_members_note?: string | null;
  can_edit_team: boolean;
}

const PLACE_OPTIONS = [
  { value: "member", label: TEAM_ROLE_TEXT.member },
  { value: "lead", label: TEAM_ROLE_TEXT.lead },
];

function EditTeamDialog({ team, onClose, onSaved }: { team: TeamDetail; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [nameError, setNameError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const toast = useToast();
  return (
    <Dialog open title="Edit name and description" dismissible={!busy} onClose={onClose}>
      <form
        ref={formRef}
        className="pp-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) {
            setNameError("Give the team a name.");
            requestAnimationFrame(() => focusFirstInvalid(formRef.current));
            return;
          }
          setNameError(undefined);
          setBusy(true);
          setError(null);
          try {
            await api(`/teams/${team.slug}`, { method: "PATCH", body: { name: name.trim(), description } });
            toast.success("Saved the team");
            onSaved();
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Team name" error={nameError}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label="Description" optional>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What they work on" minRows={2} />
        </Field>
        {error ? <ErrorState compact error={error} title="Couldn't save the team" /> : null}
        <div className="pp-form-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText="Saving">
            Save changes
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddMemberDialog({ team, onClose, onAdded }: { team: TeamDetail; onClose: () => void; onAdded: (text: string) => void }) {
  const [email, setEmail] = useState("");
  const [place, setPlace] = useState<"member" | "lead">("member");
  const [emailError, setEmailError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const ids = useId();
  return (
    <Dialog open title={`Add a member to ${team.name}`} description="They get the team's project roles on its projects." dismissible={!busy} onClose={onClose}>
      <form
        ref={formRef}
        className="pp-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!email.trim()) {
            setEmailError("Find a person, or type their email.");
            requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>("input")?.focus());
            return;
          }
          setEmailError(undefined);
          setBusy(true);
          setError(null);
          try {
            const res = await api<TeamMemberChange>(`/teams/${team.slug}/members`, { method: "PUT", body: { email: email.trim(), member: true, role: place } });
            onAdded(res?.note ? `Added ${email.trim()}. ${res.note}` : `Added ${email.trim()}`);
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field" data-invalid={emailError ? true : undefined}>
          <span className="field-label" id={`${ids}-label`}>
            Person
          </span>
          {/* Above the input: focusing it on error opens the suggestions, which would cover a message below. */}
          {emailError && (
            <p className="field-error" id={`${ids}-error`} role="alert">
              {emailError}
            </p>
          )}
          <PersonInput
            value={email}
            onChange={setEmail}
            exclude={team.members.map((m) => m.email)}
            placeholder="Find a person, or type an email"
            label="Person to add"
            aria-describedby={[emailError ? `${ids}-error` : "", `${ids}-hint`].filter(Boolean).join(" ")}
            aria-invalid={Boolean(emailError)}
          />
          <p className="field-hint" id={`${ids}-hint`}>
            Pick someone already here, or type a new email: they get access when they first sign in.
          </p>
        </div>
        <Field label="In the team">
          <Select value={place} onChange={(e) => setPlace(e.target.value as "member" | "lead")} options={PLACE_OPTIONS} />
        </Field>
        {error ? <ErrorState compact error={error} title="Couldn't add them" /> : null}
        <div className="pp-form-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText="Adding">
            Add member
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddToProjectDialog({
  team,
  scopes,
  addable,
  onClose,
  onAdded,
}: {
  team: TeamDetail;
  scopes: ScopeInfo[];
  addable: ScopeInfo[];
  onClose: () => void;
  onAdded: (text: string) => void;
}) {
  const catalog = useRoles();
  const all = catalog.data?.roles;
  const [project, setProject] = useState("");
  const [roles, setRoles] = useState<string[]>(["writer"]);
  const [projectError, setProjectError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <Dialog open title="Add to a project" description={`Everyone in ${team.name} gets these project roles there.`} dismissible={!busy} onClose={onClose}>
      <form
        ref={formRef}
        className="pp-form"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          if (!project) {
            setProjectError("Choose a project.");
            requestAnimationFrame(() => focusFirstInvalid(formRef.current));
            return;
          }
          setProjectError(undefined);
          setBusy(true);
          setError(null);
          try {
            const res = await api<TeamChange>(`/scopes/${project}/teams`, { method: "PUT", body: { team: team.slug, roles } });
            onAdded(`Added to ${res?.project_name ?? scopes.find((s) => s.slug === project)?.name ?? project}: ${namesOr(res?.role_names, all, roles)}`);
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Project" error={projectError}>
          <ProjectPicker searchable value={project} onChange={setProject} scopes={scopes} includeSpaces={false} noneLabel="Choose a project" filter={(s) => addable.some((a) => a.slug === s.slug)} />
        </Field>
        <Field label="Project roles it gives its members">
          <RolePicker roles={all} kind="project" value={roles} onChange={setRoles} label="Project roles it gives its members" required empty="choose project roles" />
        </Field>
        {error ? <ErrorState compact error={error} title="Couldn't add the team" /> : null}
        <div className="pp-form-actions">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" loading={busy} loadingText="Adding">
            Add to project
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type TeamDialog = "edit" | "member" | "project" | "new-project" | null;

export function TeamPage({ slug, scopes, me }: { slug: string; scopes: ScopeInfo[]; me: Me }) {
  const result = useApi<TeamDetail>(`/teams/${encodeURIComponent(slug)}`);
  const { data, reload } = result;
  const catalog = useRoles();
  const all = catalog.data?.roles;
  const confirm = useConfirm();
  const toast = useToast();
  const { reloadScopes } = useBoot();
  const [dialog, setDialog] = useState<TeamDialog>(null);

  /** A saved change: a toast, with the server's note (last lead, not signed in yet) as its description. */
  const saved = (text: string, note?: string | null) => {
    if (note) toast.info(text, { description: note, duration: 12000 });
    else toast.success(text);
    reload();
  };

  async function run(fn: () => Promise<unknown>, errorTitle: string) {
    try {
      return await fn();
    } catch (err) {
      toast.error(err, { title: errorTitle });
      reload();
      return undefined;
    }
  }

  async function deleteTeam(team: TeamDetail) {
    const ok = await confirm({
      title: `Delete the team ${team.name}?`,
      body: "Its members lose the access the team gave them.",
      confirmLabel: "Delete team",
      tone: "danger",
      typeToConfirm: { values: [team.name], label: `Type ${team.name} to confirm` },
    });
    if (!ok) return;
    const done = await run(() => api(`/teams/${team.slug}`, { method: "DELETE" }).then(() => true), `Couldn't delete ${team.name}`);
    if (done) {
      toast.success(`Deleted ${team.name}`);
      navigate("/teams");
    }
  }

  const header = (team?: TeamDetail) => {
    const menu: MenuItemSpec[] = [];
    if (team?.can_edit_team) {
      menu.push({ id: "edit", label: "Edit name and description…", icon: "pencil", onSelect: () => setDialog("edit") });
      menu.push({ type: "separator" });
      menu.push({ id: "delete", label: "Delete team…", icon: "trash", tone: "danger", onSelect: () => void deleteTeam(team) });
    }
    return (
      <PageHeader
        title={team?.name ?? "Team"}
        crumbs={[{ label: "Teams", href: href("/teams") }]}
        nav="teams"
        description={team?.description || undefined}
        meta={team ? `${plural(team.members.length, "member")} · ${plural(team.projects.length, "project")}` : undefined}
        menu={menu.length ? menu : undefined}
      />
    );
  };

  if (!data)
    return (
      <Page width="content">
        {header()}
        <AsyncBlock result={result} label="Loading the team" errorTitle="Couldn't load the team" skeleton={<SkeletonRows count={4} />}>
          {() => null}
        </AsyncBlock>
      </Page>
    );

  const changeMembers = data.can_manage && (data.can_change_members ?? true);
  const lockedReason = data.change_members_note ?? "You can't change who is in this team.";
  // Projects this person can add the team to: the ones where they manage access.
  const addable = scopes.filter((s) => s.kind === "project" && canIn(s, "manage_members", me) && !data.projects.some((p) => p.slug === s.slug));
  // roles replaces the team's roles there ([] removes it); add / remove change only those (one picker click).
  const setTeamRoles = (scope: string, c: { roles: string[] } | { add: string[]; remove: string[] }) =>
    api<TeamChange>(`/scopes/${scope}/teams`, { method: "PUT", body: { team: slug, ...c } });
  const seeAccess = can.seeAccess(me);
  const memberCount = plural(data.members.length, "member");

  async function changePlace(m: Member, role: "member" | "lead") {
    const res = await run(() => api<TeamMemberChange>(`/teams/${slug}/members`, { method: "PUT", body: { email: m.email, member: true, role } }), `Couldn't change ${displayName(m.name, m.email)}`);
    if (res !== undefined) saved(`${displayName(m.name, m.email)} is now ${role === "lead" ? "a lead" : "a member"}`, (res as TeamMemberChange | undefined)?.note);
  }

  async function removeMember(m: Member) {
    const ok = await confirm({
      title: `Remove ${displayName(m.name, m.email)} from ${data!.name}?`,
      body: `They lose the project roles the team gives${data!.projects.length ? ` in ${data!.projects.map((p) => p.name).join(", ")}` : ""}.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    const res = await run(() => api<TeamMemberChange>(`/teams/${slug}/members`, { method: "PUT", body: { email: m.email, member: false } }), `Couldn't remove ${displayName(m.name, m.email)}`);
    if (res !== undefined) saved(`Removed ${displayName(m.name, m.email)}`, (res as TeamMemberChange | undefined)?.note);
  }

  async function removeProject(p: TeamDetail["projects"][number], keys: string[]) {
    const ok = await confirm({
      title: `Remove ${data!.name} from ${p.name}?`,
      body: `Its ${memberCount} lose ${namesOr(p.role_names, all, keys)} there (unless they hold it another way).`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!ok) return;
    const res = await run(() => setTeamRoles(p.slug, { roles: [] }), `Couldn't remove ${data!.name} from ${p.name}`);
    if (res !== undefined) saved(`Removed from ${p.name}`);
  }

  const memberColumns: Column<Member>[] = [
    {
      key: "person",
      header: "Person",
      cell: (m) => (
        <span className="pp-person-cell">
          <PersonChip name={m.name ?? undefined} email={m.email} you={m.id === me.id} href={seeAccess ? href(`/admin/users/${m.id}`) : undefined} />
          <span className="pp-person-sub">{m.email}</span>
        </span>
      ),
    },
    {
      key: "place",
      header: "In the team",
      width: "20rem",
      cell: (m) =>
        data.can_manage ? (
          <span className="pp-place">
            <Select
              value={m.role}
              disabled={!changeMembers}
              title={changeMembers ? undefined : lockedReason}
              aria-label={`Place in the team of ${displayName(m.name, m.email)}`}
              onChange={(e) => void changePlace(m, e.target.value as "member" | "lead")}
              options={PLACE_OPTIONS}
            />
          </span>
        ) : m.role === "lead" ? (
          // Wrapping text, not a one-line Badge: this long label would widen the phone card.
          <strong className="pp-lead">{TEAM_ROLE_TEXT.lead}</strong>
        ) : (
          TEAM_ROLE_TEXT.member
        ),
    },
    {
      key: "added",
      header: "Added",
      cell: (m) =>
        m.status && m.status !== "active" ? (
          <span className="muted">{ACCOUNT_STATUS_TEXT[m.status] ?? m.status}</span>
        ) : m.pending ? (
          <span className="muted">Hasn't signed in yet</span>
        ) : (
          <RelativeTime date={m.added_at} prefix="Added" />
        ),
    },
  ];

  const projectColumns: Column<TeamDetail["projects"][number]>[] = [
    {
      key: "project",
      header: "Project",
      cell: (p) => <a href={href(p.kind === "project" ? `/project/${p.slug}` : `/scope/${p.slug}`)}>{p.name}</a>,
    },
    {
      key: "roles",
      header: "Project roles it gives its members",
      cell: (p) => {
        const keys = p.roles ?? [p.role];
        const manage = canIn(
          scopes.find((s) => s.slug === p.slug),
          "manage_members",
          me,
        );
        return manage ? (
          <RolePicker
            roles={all}
            kind="project"
            value={keys}
            required
            label={`${data.name}'s project roles in ${p.name}`}
            onChange={async (r) => {
              const res = await run(() => setTeamRoles(p.slug, roleDelta(keys, r)), `Couldn't change ${data.name}'s roles in ${p.name}`);
              if (res !== undefined) {
                const change = res as TeamChange;
                saved(`${data.name} in ${p.name}: ${changedText(change, all)}`, `Now: ${namesOr(change?.role_names, all, change?.roles ?? r)}`);
              }
            }}
          />
        ) : (
          namesOr(p.role_names, all, keys)
        );
      },
    },
  ];

  return (
    <Page width="content">
      {header(data)}
      <div className="pp-stack">
        <Section
          title="Members"
          count={data.members.length}
          description={
            <>
              Everyone here gets the team's project roles on the projects below.{" "}
              <InfoTip label="Member and Lead">
                Member or Lead is someone's place in the team, not a role: leads choose the members and can start projects for the team. Removing someone removes the access the
                team gave them.
              </InfoTip>
            </>
          }
          actions={
            data.can_manage ? (
              <Button icon="user-plus" disabledReason={changeMembers ? undefined : lockedReason} onClick={() => setDialog("member")}>
                Add member
              </Button>
            ) : undefined
          }
        >
          {data.can_manage && !changeMembers && data.change_members_note && <Callout tone="warning">{data.change_members_note}</Callout>}
          <DataTable
            caption={`Members of ${data.name}`}
            columns={memberColumns}
            rows={data.members}
            getRowId={(m) => m.id}
            rowAction={(m) =>
              data.can_manage ? (
                <OverflowMenu
                  size="sm"
                  label={`Actions for ${displayName(m.name, m.email)}`}
                  items={[{ id: "remove", label: "Remove…", icon: "x", tone: "danger", disabledReason: changeMembers ? undefined : lockedReason, onSelect: () => void removeMember(m) }]}
                />
              ) : null
            }
            empty={
              <EmptyState
                variant="compact"
                icon="team"
                title="No members yet"
                description={data.can_manage ? "Add the people who work on this team's projects." : undefined}
                primary={
                  data.can_manage && changeMembers ? (
                    <Button size="sm" icon="user-plus" onClick={() => setDialog("member")}>
                      Add member
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        </Section>

        <Section
          title="Projects"
          count={data.projects.length}
          actions={
            <>
              {addable.length > 0 && (
                <Button icon="plus" onClick={() => setDialog("project")}>
                  Add to a project…
                </Button>
              )}
              {data.can_manage && (
                <Button variant="primary" icon="folder-plus" onClick={() => setDialog("new-project")}>
                  New project for this team
                </Button>
              )}
            </>
          }
        >
          <DataTable
            caption={`Projects ${data.name} is on`}
            columns={projectColumns}
            rows={data.projects}
            getRowId={(p) => p.slug}
            rowAction={(p) =>
              canIn(
                scopes.find((s) => s.slug === p.slug),
                "manage_members",
                me,
              ) ? (
                <OverflowMenu
                  size="sm"
                  label={`Actions for ${p.name}`}
                  items={[{ id: "remove", label: "Remove from project…", icon: "x", tone: "danger", onSelect: () => void removeProject(p, p.roles ?? [p.role]) }]}
                />
              ) : null
            }
            empty={<EmptyState variant="compact" icon="folder" title="Not on any project yet" description={addable.length || data.can_manage ? "Add the team to a project, or start a new one for it." : undefined} />}
          />
        </Section>
      </div>

      {dialog === "edit" && <EditTeamDialog team={data} onClose={() => setDialog(null)} onSaved={reload} />}
      {dialog === "member" && <AddMemberDialog team={data} onClose={() => setDialog(null)} onAdded={(text) => saved(text)} />}
      {dialog === "project" && <AddToProjectDialog team={data} scopes={scopes} addable={addable} onClose={() => setDialog(null)} onAdded={(text) => saved(text)} />}
      {dialog === "new-project" && (
        <Sheet open side="right" title={`New project for ${data.name}`} onClose={() => setDialog(null)}>
          <TeamProjectForm
            team={data}
            me={me}
            onCancel={() => setDialog(null)}
            onCreated={async (project) => {
              setDialog(null);
              await reloadScopes();
              toast.success("Project created");
              navigate(`/scope/${project}/settings`, { tab: "repos" });
            }}
          />
        </Sheet>
      )}
    </Page>
  );
}

/** Starts a project that belongs to this team: the team gets roles on it and the chosen members are its Project admins. */
function TeamProjectForm({ team, me, onCancel, onCreated }: { team: TeamDetail; me: Me; onCancel: () => void; onCreated: (slug: string) => void }) {
  const catalog = useRoles();
  const [name, setName] = useState("");
  const [short, setShort] = useState("");
  const [description, setDescription] = useState("");
  const [teamRoles, setTeamRoles] = useState<string[]>(["writer"]);
  const leads = team.members.filter((m) => m.role === "lead").map((m) => m.email);
  const [owners, setOwners] = useState<string[]>(leads.length ? leads : me.email ? [me.email] : []);
  const [starter, setStarter] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; short?: string; roles?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const auto = slugFor(name);
  const slug = short || auto;
  // Without Manage teams, whoever starts the project is always one of its Project admins.
  const selfForced = !can.manageTeams(me) && !!me.email;

  return (
    <form
      ref={formRef}
      className="pp-form"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const bad: typeof errors = {};
        if (!name.trim()) bad.name = "Give the project a name.";
        if (short && !/^[a-z0-9][a-z0-9-]*$/.test(short)) bad.short = "Use lowercase letters, digits and -, starting with a letter or digit.";
        else if (name.trim() && !slug) bad.short = "Choose a short name: the name has no letters or digits to make one from.";
        if (!teamRoles.length) bad.roles = "Choose at least one project role.";
        setErrors(bad);
        if (Object.keys(bad).length) {
          requestAnimationFrame(() => focusFirstInvalid(formRef.current));
          return;
        }
        setBusy(true);
        setError(null);
        try {
          await api(`/teams/${team.slug}/projects`, {
            method: "POST",
            body: { slug, name: name.trim(), description: description || undefined, team_roles: teamRoles, owners, starter },
          });
          onCreated(slug);
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Name" error={errors.name}>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Referral program" maxLength={200} />
      </Field>
      <Field label="Short name (used in links and by Claude)" optional hint={`Leave empty to use ${auto || "one made from the name"}.`} error={errors.short}>
        <TextInput className="pp-mono" value={short} onChange={(e) => setShort(e.target.value)} placeholder={auto || "referrals"} spellCheck={false} />
      </Field>
      <Field label="Description" optional>
        <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it does, in one line" />
      </Field>
      <Field label={`${team.name}'s roles on it`} error={errors.roles}>
        <RolePicker roles={catalog.data?.roles} kind="project" value={teamRoles} onChange={setTeamRoles} label={`Project roles ${team.name} gets`} required empty="choose project roles" />
      </Field>
      <fieldset className="pp-checks">
        <legend className="field-label">Project admins (manage the project and approve changes)</legend>
        {team.members.map((m) => {
          const forced = selfForced && m.email === me.email;
          return (
            <Checkbox
              key={m.id}
              label={displayName(m.name, m.email)}
              description={forced ? "You start it, so you're one of its Project admins." : undefined}
              checked={forced || owners.includes(m.email)}
              disabled={forced}
              onChange={(e) => setOwners((o) => (e.target.checked ? [...o, m.email] : o.filter((x) => x !== m.email)))}
            />
          );
        })}
        {!team.members.length && <p className="pp-inline-note">Add members to the team first, or you'll be its Project admin.</p>}
      </fieldset>
      <Switch
        label="Add a starter pack"
        description="Outlines for an overview, a design doc and an on-call runbook. You add repositories next."
        checked={starter}
        onChange={setStarter}
      />
      {error ? <ErrorState compact error={error} title="Couldn't create the project" /> : null}
      <div className="pp-form-actions">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" loading={busy}>
          {busy ? "Creating…" : "Create project"}
        </Button>
      </div>
    </form>
  );
}

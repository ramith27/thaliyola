import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Me, type ScopeInfo } from "../api";
import { useBoot } from "../components/boot";
import { StatTile } from "../components/charts";
import { plural, SKILL_AUDIENCE, SKILL_DELIVERY_MODE, SKILL_REPORT_SECTION, SKILL_STATUS, skillFlagLabel } from "../components/labels";
import { can } from "../components/permissions";
import { RolePicker, useRoles } from "../components/roles";
import {
  deliveryNotice,
  downloadSkill,
  parseGlobs,
  reportCounts,
  shortSha,
  skillStatusKey,
  upstreamLabel,
  uploadSkillArchive,
  versionLine,
  type Collection,
  type Connector,
  type Delivery,
  type ImportReport,
  type MySkill,
  type MySkills,
  type SkillFeedback,
  type SkillImport,
  type SkillListRow,
  type SkillReview,
  type SkillsConnect,
  type SkillSource,
  type SkillSources,
} from "../components/skill-utils";
import { refreshCounts, useApi, useQueryState } from "../hooks";
import { href, navigate, type Route } from "../router";
import {
  AsyncBlock,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  ChoiceCards,
  CodeBlock,
  CopyButton,
  DataTable,
  Dialog,
  Disclosure,
  EmptyState,
  Facts,
  Field,
  FileDrop,
  OverflowMenu,
  Page,
  PageHeader,
  ProjectPicker,
  RelativeTime,
  SearchInput,
  Section,
  SegmentedControl,
  Select,
  SkeletonCard,
  SkeletonRows,
  SkeletonText,
  Switch,
  Tabs,
  TextInput,
  Textarea,
  useConfirm,
  useToast,
  type Column,
} from "../components/kit";

/**
 * Skills for Claude (#/skills): Claude skills published in Thaliyola, reviewed by a second person, versioned and
 * delivered to the people their assignments name, through the Thaliyola connector, an "Add to my Claude" zip and the
 * Claude Code sync. Everyone sees My skills; managers, reviewers and Auditors also see the catalogue, sources and
 * usage. Skill detail lives in skill-detail.tsx.
 */

// ---- Shared pieces --------------------------------------------------------------------------------------------------

/** The banner for a delivery state other than On. */
export function DeliveryCallout({ delivery, me }: { delivery: Pick<Delivery, "state"> | undefined; me: Me }) {
  const n = deliveryNotice(delivery?.state, me.admin);
  if (!n) return null;
  return (
    <Callout
      tone={n.tone}
      title={n.title}
      actions={
        n.action === "account" ? (
          <Button size="sm" href={href("/account", { section: "skills" })}>
            Change in Account
          </Button>
        ) : n.action === "system" ? (
          <Button size="sm" href={href("/admin/system", { section: "skills" })}>
            Admin › System
          </Button>
        ) : undefined
      }
    >
      <p>{n.body}</p>
    </Callout>
  );
}

/** A skill's state as a badge (SKILL_STATUS, including "Not published yet"). */
export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={SKILL_STATUS[status]?.tone ?? "neutral"}>{SKILL_STATUS[status]?.label ?? status}</Badge>;
}

function ConnectorsLine({ connectors, compact = false }: { connectors: Connector[]; compact?: boolean }) {
  if (!connectors.length) return null;
  if (compact)
    return (
      <p className="sk-connectors small" title={connectors.map((c) => `${c.name}: ${c.url}`).join("\n")}>
        Needs connectors: {connectors.map((c) => c.name).join(", ")}
      </p>
    );
  return (
    <p className="sk-connectors small">
      Needs connectors:{" "}
      {connectors.map((c, i) => (
        <span key={c.name}>
          {i > 0 && ", "}
          <strong>{c.name}</strong> <span className="muted sk-url">({c.url})</span>
        </span>
      ))}
      . Add them in Claude › Settings › Connectors.
    </p>
  );
}

/** Scripts, pre-approved tools, connectors and a newer version, as badges. */
function SkillBadges({ s }: { s: { has_scripts: boolean; allowed_tools: string | null; requires_connectors?: Connector[]; update_available?: boolean; version?: number; downloaded_version?: number | null } }) {
  return (
    <span className="sk-badges">
      {s.has_scripts && (
        <Badge tone="warning" icon="code" title="Has scripts: review them before running. Works best downloaded or synced to Claude Code.">
          Scripts
        </Badge>
      )}
      {s.allowed_tools && (
        <Badge tone="warning" icon="key" title={`Pre-approves tools: ${s.allowed_tools}`}>
          Pre-approves tools
        </Badge>
      )}
      {!!s.requires_connectors?.length && <Badge icon="plug">Needs connectors</Badge>}
      {s.update_available && (
        <Badge tone="accent" icon="refresh">
          Newer version (v{s.version}); you added v{s.downloaded_version}
        </Badge>
      )}
    </span>
  );
}

/** "Add to my Claude": how to upload the zip, then the download. */
export function AddToClaudeDialog({ skill, onClose, onDone }: { skill: { id: string; name: string; version: number; requires_connectors?: Connector[]; has_scripts?: boolean; update_available?: boolean }; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      await downloadSkill(skill.id, skill.name);
      toast.success(`Downloaded ${skill.name}.zip`);
      onDone?.();
      onClose();
    } catch (err) {
      toast.error(err, { title: `Couldn't download ${skill.name}` });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Add ${skill.name} to your Claude`}
      description="For Claude Desktop and claude.ai: an uploaded skill triggers on its own, without asking Thaliyola first."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="download" loading={busy} loadingText="Downloading" onClick={() => void download()}>
            Download {skill.name}.zip
          </Button>
        </>
      }
    >
      <ol className="sk-steps">
        <li>Download the zip (version {skill.version}).</li>
        <li>In Claude, open Settings › Capabilities › Skills and choose Upload skill.</li>
        <li>Pick the zip. Keep it switched on.</li>
      </ol>
      {skill.update_available && <Callout tone="info">You added an older version. Remove it in Settings › Capabilities › Skills first, then upload this one.</Callout>}
      {skill.has_scripts && <Callout tone="warning">This skill has scripts. Claude asks before running them; read what they do first.</Callout>}
      <ConnectorsLine connectors={skill.requires_connectors ?? []} />
      <p className="muted small">Thaliyola remembers which version you downloaded and tells you here when a newer one is published.</p>
    </Dialog>
  );
}

/** "This skill was wrong": lands in Review › Skills for the people who manage it. */
export function ReportProblemDialog({ skill, onClose, onDone }: { skill: { id: string; name: string; version?: number | null }; onClose: () => void; onDone?: () => void }) {
  const toast = useToast();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function send() {
    if (!body.trim()) return setError("Say what went wrong.");
    setBusy(true);
    try {
      await api(`/skills/${skill.id}/feedback`, { method: "POST", body: { body: body.trim(), ...(skill.version ? { version: skill.version } : {}) } });
      toast.success("Thanks: the people who manage this skill will look at it");
      onDone?.();
      onClose();
    } catch (err) {
      toast.error(err, { title: "Couldn't send the report" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Report a problem with ${skill.name}`}
      description="What did Claude do wrong when it followed this skill, or what's out of date? Secrets are removed automatically."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} loadingText="Sending" onClick={() => void send()}>
            Send report
          </Button>
        </>
      }
    >
      <Field label="What went wrong" error={error} counter={{ value: body.length, max: 4000 }}>
        <Textarea
          rows={6}
          maxLength={4000}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setError(null);
          }}
        />
      </Field>
    </Dialog>
  );
}

// ---- Assign (a skill, or every skill of a collection) -------------------------------------------------------------

export type AssignTarget = { kind: "skill"; id: string; name: string; owner?: { slug: string; name: string } | null } | { kind: "collection"; slug: string; name: string; owner?: { slug: string; name: string } | null };

/** A project and every project under it (parent links from /scopes). */
function subtreeOf(scopes: ScopeInfo[], root: string): Set<string> {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of scopes) if (s.parent && out.has(s.parent) && !out.has(s.slug)) (out.add(s.slug), (grew = true));
  }
  return out;
}

export function AssignDialog({ target, scopes, onClose, onDone }: { target: AssignTarget; scopes: ScopeInfo[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const roles = useRoles();
  const teams = useApi<{ teams: { slug: string; name: string }[] }>("/teams");
  const owned = target.owner ?? null;
  const inOwner = useMemo(() => (owned ? subtreeOf(scopes, owned.slug) : null), [owned, scopes]);
  const [audience, setAudience] = useState<string>(owned ? "project" : "everyone");
  const [chosenRoles, setRoles] = useState<string[]>([]);
  const [team, setTeam] = useState("");
  const [project, setProject] = useState(owned?.slug ?? "");
  const [where, setWhere] = useState<"one" | "any">("one");
  const [preview, setPreview] = useState<{ people: number; audiences: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const audiences = owned ? ["project", "project_role"] : Object.keys(SKILL_AUDIENCE);

  // Collection mode: who would gain the collection's skills, before saving.
  const bodies = (): Record<string, unknown>[] => {
    const projectSlug = audience === "project" || (audience === "project_role" && where === "one") ? project : null;
    if (audience === "org_role" || audience === "project_role") return chosenRoles.map((role) => ({ audience, role, project: projectSlug }));
    return [{ audience, team: audience === "team" ? team : null, project: projectSlug }];
  };
  const problem = (): string | null => {
    if ((audience === "org_role" || audience === "project_role") && !chosenRoles.length) return "Choose a role.";
    if (audience === "team" && !team) return "Choose a team.";
    if ((audience === "project" || (audience === "project_role" && where === "one")) && !project) return "Choose a project.";
    return null;
  };
  const key = JSON.stringify([audience, chosenRoles, team, project, where]);
  useEffect(() => {
    setPreview(null);
    if (target.kind !== "collection" || problem()) return;
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const results = await Promise.all(bodies().map((b) => api<{ gains: { people: number; audiences: string[] } }>(`/skill-collections/${target.slug}/assignments`, { method: "POST", body: { ...b, dry_run: true } })));
        if (!stale) setPreview({ people: results.reduce((a, r) => a + r.gains.people, 0), audiences: results.flatMap((r) => r.gains.audiences) });
      } catch {
        /* the save shows the error */
      }
    }, 300);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    const p = problem();
    if (p) return setError(p);
    setBusy(true);
    try {
      for (const b of bodies()) {
        if (target.kind === "skill") await api(`/skills/${target.id}/assignments`, { method: "POST", body: b });
        else await api(`/skill-collections/${target.slug}/assignments`, { method: "POST", body: b });
      }
      toast.success(target.kind === "skill" ? `Gave ${target.name} to them` : `Gave every ${target.name} skill to them`);
      onDone();
      onClose();
    } catch (err) {
      setError(null);
      toast.error(err, { title: "Couldn't save the assignment" });
    } finally {
      setBusy(false);
    }
  }

  const projectPicker = (
    <Field label={audience === "project" ? "Project (and the projects under it)" : "Project"} error={error === "Choose a project." ? error : undefined}>
      <ProjectPicker
        value={project}
        onChange={(v) => {
          setProject(v);
          setError(null);
        }}
        scopes={scopes}
        filter={(s) => s.kind === "project" && (!inOwner || inOwner.has(s.slug))}
        noneLabel="Choose a project"
        searchable
      />
    </Field>
  );

  return (
    <Dialog
      open
      size="md"
      onClose={onClose}
      title={target.kind === "skill" ? `Give ${target.name} to…` : `Give all ${target.name} skills to…`}
      description={
        target.kind === "collection"
          ? "One assignment for the whole collection: skills added to it later are included."
          : owned
            ? `${target.name} belongs to ${owned.name}, so it can only go to people in that project or the projects under it.`
            : "People get it in Claude at once, through the Thaliyola connector."
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} loadingText="Saving" onClick={() => void save()}>
            Give it to them
          </Button>
        </>
      }
    >
      <div className="sk-form">
        <ChoiceCards
          name="audience"
          legend="Who gets it"
          value={audience}
          onChange={(v) => {
            setAudience(String(v));
            setRoles([]);
            setError(null);
          }}
          columns={1}
          options={audiences.map((a) => ({ value: a, label: SKILL_AUDIENCE[a]!.label, description: SKILL_AUDIENCE[a]!.hint }))}
        />
        {(audience === "org_role" || audience === "project_role") && (
          <Field label="Role" hint="Pick several to add one assignment each." error={error === "Choose a role." ? error : undefined}>
            <RolePicker roles={roles.data?.roles} kind={audience === "org_role" ? "org" : "project"} value={chosenRoles} onChange={(v) => (setRoles(v), setError(null))} label="Roles" empty="Choose roles" />
          </Field>
        )}
        {audience === "project_role" && !owned && (
          <SegmentedControl
            label="Where"
            labelVisible
            value={where}
            onChange={setWhere}
            options={[
              { value: "one", label: "In one project" },
              { value: "any", label: "In any project" },
            ]}
          />
        )}
        {audience === "team" && (
          <Field label="Team" error={error === "Choose a team." ? error : undefined}>
            <Select
              value={team}
              onChange={(e) => (setTeam(e.target.value), setError(null))}
              options={[{ value: "", label: teams.data ? "Choose a team" : "…" }, ...(teams.data?.teams ?? []).map((t) => ({ value: t.slug, label: t.name }))]}
            />
          </Field>
        )}
        {(audience === "project" || (audience === "project_role" && where === "one")) && projectPicker}
        {preview && (
          <Callout tone={preview.people ? "info" : "neutral"} title={preview.people ? `${plural(preview.people, "person", "people")} would gain these skills` : "Nobody new would gain these skills"}>
            {preview.audiences.length > 0 && <p className="small">{preview.audiences.join("; ")}</p>}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}

// ---- Page ------------------------------------------------------------------------------------------------------------

type TabId = "mine" | "all" | "sources" | "usage";

/**
 * The Skills page's header buttons, on every tab: New skill for people who may create skills (Manage skills, or
 * Manage settings in a project for its own skills), Import skills for Manage skills (the import page's own gate).
 */
export function skillsHeaderActions(me: Me, scopes: ScopeInfo[], onNew: () => void): { primary?: ReactNode; actions?: ReactNode; meta?: ReactNode } {
  return {
    // Everyone else learns, on every tab, that skills are written here and who writes them.
    meta: can.createSkills(me, scopes) ? undefined : (
      <span className="small muted">Skills managers and Administrators write skills (Project admins, for their projects' own skills): ask one of them for a skill you need.</span>
    ),
    primary: can.createSkills(me, scopes) ? (
      <Button variant="primary" icon="plus" onClick={onNew}>
        New skill
      </Button>
    ) : undefined,
    actions: can.manageSkills(me) ? (
      <Button icon="upload" href={href("/skills/import")}>
        Import skills
      </Button>
    ) : undefined,
  };
}

export function SkillsPage({ route, me, scopes }: { route: Route; me: Me; scopes: ScopeInfo[] }) {
  const [q, setQ] = useQueryState(route, { tab: "mine" });
  const mayCreate = can.createSkills(me, scopes);
  // #/skills?new=1 (the Create menu, or New skill here) opens the dialog over whichever tab is showing.
  const openNew = () => setQ({ new: "1" });
  const header = skillsHeaderActions(me, scopes, openNew);
  const projectAdmin = scopes.some((s) => s.kind === "project" && can.inScope(s, "manage_settings", me));
  const seeAll = can.seeAllSkills(me) || projectAdmin;
  const tabs = [
    { id: "mine", label: "My skills", href: href("/skills") },
    { id: "all", label: "All skills", href: href("/skills", { tab: "all" }), hidden: !seeAll },
    { id: "sources", label: "Sources", href: href("/skills", { tab: "sources" }), hidden: !can.manageSkills(me) },
    { id: "usage", label: "Usage", href: href("/skills", { tab: "usage" }), hidden: !can.seeSkillUsage(me) },
  ];
  const visibleIds = tabs.filter((t) => !t.hidden).map((t) => t.id);
  const tab = (visibleIds.includes(q.tab!) ? q.tab : "mine") as TabId;
  return (
    <Page width="content">
      <PageHeader
        title="Skills"
        nav="skills"
        description="Claude skills your team publishes: instructions Claude follows for a task, with their references and scripts. You get the ones assigned to you, in Claude and Claude Code."
        info={{
          label: "How skills work",
          content: (
            <>
              <p>A skill is a SKILL.md file, plus references and scripts, that tells Claude how to do one kind of task.</p>
              <p>Every version is reviewed by a second person before anyone gets it. Skills go to people by role, team or project.</p>
              <p>Claude finds yours through the Thaliyola connector (list_skills). You can also add one to Claude yourself, or sync them to Claude Code.</p>
            </>
          ),
        }}
        primary={header.primary}
        actions={header.actions}
        meta={header.meta}
        tabs={<Tabs label="Skills" value={tab} items={tabs} />}
      />
      {tab === "mine" ? (
        <MySkillsTab me={me} mayCreate={mayCreate} onNew={openNew} />
      ) : tab === "all" ? (
        <AllSkillsTab me={me} scopes={scopes} q={q} setQ={setQ} />
      ) : tab === "sources" ? (
        <SourcesTab />
      ) : (
        <UsageTab />
      )}
      {q.new === "1" && mayCreate && <NewSkillDialog me={me} scopes={scopes} onClose={() => setQ({ new: undefined })} />}
    </Page>
  );
}
SkillsPage.keepMountedOnQuery = true;

// ---- My skills ------------------------------------------------------------------------------------------------------

function MySkillsTab({ me, mayCreate, onNew }: { me: Me; mayCreate: boolean; onNew: () => void }) {
  const result = useApi<MySkills>("/skills/mine");
  const [filter, setFilter] = useState("");
  const match = (s: MySkill) => !filter || `${s.name} ${s.description} ${s.collection?.name ?? ""}`.toLowerCase().includes(filter.toLowerCase());
  const [adding, setAdding] = useState<MySkill | null>(null);
  const [reporting, setReporting] = useState<MySkill | null>(null);
  return (
    <AsyncBlock result={result} label="Loading your skills" errorTitle="Couldn't load your skills" skeleton={<SkeletonRows count={4} />}>
      {(d) => (
        <div className="sk-mine">
          <DeliveryCallout delivery={d.delivery} me={me} />
          <div className="sk-mine-grid">
            <div className="sk-cards">
              {d.skills.length > 6 && <SearchInput label="Filter your skills" placeholder={`Filter ${d.skills.length} skills`} value={filter} onChange={setFilter} resultCount={filter ? d.skills.filter(match).length : undefined} />}
              {d.skills.length ? (
                d.skills.filter(match).map((s) => (
                  <MySkillCard key={s.id} skill={s} on={d.delivery.state === "on"} onAdd={() => setAdding(s)} onReport={() => setReporting(s)} />
                ))
              ) : (
                <EmptyState
                  icon="sparkle"
                  title="No skills for you yet"
                  description={
                    mayCreate
                      ? "When someone gives a skill to you, your team or a project you're in, it shows up here and Claude can use it. Write one for your team with New skill: someone else reviews it, then you give it to people."
                      : "When someone gives a skill to you, your team or a project you're in, it shows up here and Claude can use it. Skills managers and Administrators write and give out skills (and Project admins, for their projects' own skills): ask one of them for the one you need."
                  }
                  primary={
                    mayCreate ? (
                      <Button variant="primary" icon="plus" onClick={onNew}>
                        New skill
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </div>
            <div className="sk-side">
              <SkillConnectorsCard skills={d.skills} />
              <HowSkillsReachClaude lastSync={d.sync.last_seen_at} on={d.delivery.state === "on"} />
            </div>
          </div>
          {adding && <AddToClaudeDialog skill={adding} onClose={() => setAdding(null)} onDone={result.reload} />}
          {reporting && <ReportProblemDialog skill={reporting} onClose={() => setReporting(null)} />}
        </div>
      )}
    </AsyncBlock>
  );
}

function MySkillCard({ skill: s, on, onAdd, onReport }: { skill: MySkill; on: boolean; onAdd: () => void; onReport: () => void }) {
  return (
    <Card
      as="article"
      className="sk-card"
      title={<a href={href(`/skills/${s.id}`)}>{s.name}</a>}
      description={
        <span className="sk-card-meta">
          {s.collection?.name ?? s.collection?.slug ?? "No collection"} · {versionLine(s.version, s.upstream_version)}
        </span>
      }
      actions={<OverflowMenu size="sm" items={[{ id: "report", label: "Report a problem…", icon: "alert", onSelect: onReport }]} />}
      footer={
        <div className="sk-card-foot">
          <Button size="sm" icon="download" onClick={onAdd} disabledReason={on ? undefined : "Skills aren't being sent to Claude right now"}>
            {s.update_available ? "Add the new version" : s.downloaded_version ? "Add to my Claude again" : "Add to my Claude"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onReport}>
            Report a problem
          </Button>
        </div>
      }
    >
      <p className="sk-desc sk-clamp-3">{s.description}</p>
      <SkillBadges s={{ ...s, requires_connectors: [] }} />
      <ConnectorsLine connectors={s.requires_connectors} compact />
      {s.frequent && !s.downloaded_version && <p className="small muted">Use this often? Add it to Claude so it triggers on its own.</p>}
    </Card>
  );
}

/** The connectors a set of skills needs, each once (by name), in the order the skills list them. */
export function connectorsOf(skills: { requires_connectors?: Connector[] }[]): Connector[] {
  const seen = new Map<string, Connector>();
  for (const s of skills) for (const c of s.requires_connectors ?? []) if (!seen.has(c.name.toLowerCase())) seen.set(c.name.toLowerCase(), c);
  return [...seen.values()];
}

/**
 * "Your skills use: Tableau, ClickHouse, …" and how to connect each. Thaliyola can't see which connectors someone has
 * in Claude, so it lists them all; Claude is told to check before using a skill and to say which one is missing.
 */
export function SkillConnectorsCard({ skills }: { skills: { requires_connectors?: Connector[] }[] }) {
  const connectors = connectorsOf(skills);
  if (!connectors.length) return null;
  return (
    <Card as="section" className="sk-uses" title="Connectors your skills use" titleLevel={2} padding="sm" description={`Your skills use: ${connectors.map((c) => c.name).join(", ")}. Without one, Claude tells you which to add instead of running the skill.`}>
      <ul className="sk-uses-list">
        {connectors.map((c) => (
          <li key={c.name}>
            <strong>{c.name}</strong>
            <span className="sk-uses-url">
              <code className="sk-break">{c.url}</code> <CopyButton text={c.url} />
            </span>
          </li>
        ))}
      </ul>
      <Disclosure summary="How to connect one">
        <ol className="sk-steps small">
          <li>Claude Desktop and claude.ai: Settings › Connectors › Add custom connector, name it as above and paste its URL. Sign in when Claude asks.</li>
          <li>
            Claude Code: <code>claude mcp add --transport http &lt;name&gt; &lt;url&gt;</code>.
          </li>
          <li>Your organisation may already offer it under Settings › Connectors: turn it on there.</li>
        </ol>
      </Disclosure>
    </Card>
  );
}

function HowSkillsReachClaude({ lastSync, on }: { lastSync: string | null; on: boolean }) {
  return (
    <Card as="section" className="sk-how" title="How your skills reach Claude" titleLevel={2} padding="sm">
      <ol className="sk-how-list">
        <li>
          {on ? (
            <>
              <strong>Automatically, through the Thaliyola connector.</strong> Claude sees your skills in the list_skills tool and loads one when a task matches.
            </>
          ) : (
            <>
              <strong>Not right now.</strong> While skills aren't sent to Claude (see above), the connector, downloads and the Claude Code sync don't deliver them. When they are, Claude sees your skills through the Thaliyola connector.
            </>
          )}
        </li>
        <li>
          <strong>Add to my Claude.</strong> Download a skill and upload it in Settings › Capabilities › Skills. It triggers most reliably that way.
        </li>
        <li>
          <strong>Claude Code.</strong> A small script keeps them in ~/.claude/skills.{" "}
          <span className="muted">
            Last sync check: <RelativeTime date={lastSync} never="never" />
          </span>
        </li>
      </ol>
      <Button size="sm" variant="ghost" iconEnd="chevron-right" href={href("/connect")}>
        Set up on Connect Claude
      </Button>
    </Card>
  );
}

// ---- All skills (catalogue) -----------------------------------------------------------------------------------------

function AllSkillsTab({ me, scopes, q, setQ }: { me: Me; scopes: ScopeInfo[]; q: Record<string, string>; setQ: (p: Record<string, string | undefined>) => void }) {
  const params = new URLSearchParams();
  for (const k of ["status", "collection", "q", "project"]) if (q[k]) params.set(k, q[k]!);
  if (q.pending === "1") params.set("pending", "true");
  const list = useApi<{ skills: SkillListRow[]; can: { create: boolean; import: boolean } }>(`/skills?${params}`);
  const collections = useApi<{ collections: Collection[] }>("/skill-collections");
  const [mapping, setMapping] = useState<Collection | null>(null);
  const project = q.project ? scopes.find((s) => s.slug === q.project) : undefined;
  const columns: Column<SkillListRow>[] = [
    {
      key: "name",
      header: "Skill",
      primary: true,
      cell: (s) => (
        <span className="sk-name-cell">
          <span>{s.name}</span>
          {s.current && <span className="sk-clamp small muted">{s.current.description}</span>}
        </span>
      ),
    },
    { key: "collection", header: "Collection", cell: (s) => s.collection?.name ?? <span className="muted">None</span>, hideBelow: 1100 },
    {
      key: "status",
      header: "Status",
      cell: (s) => (
        <span className="sk-badges">
          <StatusBadge status={skillStatusKey(s.status, !!s.current)} />
          {s.pending && (
            <Badge tone={s.pending.high_risk ? "danger" : "warning"} icon="clock" title={s.pending.stale ? "Its base changed since" : undefined}>
              v{s.pending.version} waiting
            </Badge>
          )}
          {s.held_at_version && <Badge icon="pause">Held</Badge>}
          {s.owner_project && <Badge icon="lock">{s.owner_project.name}</Badge>}
        </span>
      ),
    },
    { key: "version", header: "Version", cell: (s) => (s.current ? versionLine(s.current.version, s.current.upstream_version) : <span className="muted">Not published</span>), hideBelow: 760 },
    { key: "flags", header: "Flags", cell: (s) => (s.current ? <SkillBadges s={{ has_scripts: s.current.has_scripts, allowed_tools: s.current.allowed_tools }} /> : null), hideBelow: 1100 },
    { key: "assigned", header: "Assigned", numeric: true, cell: (s) => (s.assignments ? plural(s.assignments, "assignment") : <span className="muted">Nobody</span>) },
    { key: "used", header: "Last used", cell: (s) => <RelativeTime date={s.last_used_at} never="Never" />, hideBelow: 760 },
  ];
  return (
    <div className="sk-stack">
      {project && (
        <Callout tone="neutral" title={`Skills owned by ${project.name}`} actions={<Button size="sm" variant="ghost" onClick={() => setQ({ project: undefined })}>Show all</Button>}>
          <p>Only people who can read {project.name} see these, and they can only go to people in it or the projects under it.</p>
        </Callout>
      )}
      <div className="sk-filters">
        <SearchInput label="Search skills" placeholder="Search by name or description" value={q.q ?? ""} onChange={(v) => setQ({ q: v || undefined })} />
        <Select
          aria-label="Collection"
          value={q.collection ?? ""}
          onChange={(e) => setQ({ collection: e.target.value || undefined })}
          options={[{ value: "", label: "All collections" }, ...(collections.data?.collections ?? []).map((c) => ({ value: c.slug, label: c.name }))]}
        />
        <Select
          aria-label="Status"
          value={q.status ?? ""}
          onChange={(e) => setQ({ status: e.target.value || undefined })}
          options={[{ value: "", label: "Any status" }, ...Object.entries(SKILL_STATUS).filter(([k]) => k !== "unpublished").map(([value, m]) => ({ value, label: m.label }))]}
        />
        <Checkbox label="Waiting for review" checked={q.pending === "1"} onChange={(e) => setQ({ pending: e.target.checked ? "1" : undefined })} />
      </div>
      <AsyncBlock result={list} label="Loading skills" errorTitle="Couldn't load the skills" skeleton={<SkeletonRows count={6} />}>
        {(d) => (
          <DataTable
            caption="All skills"
            columns={columns}
            rows={d.skills}
            getRowId={(s) => s.id}
            rowHref={(s) => href(`/skills/${s.id}`)}
            rowTone={(s) => (s.status === "active" ? undefined : "muted")}
            empty={
              <EmptyState
                icon="sparkle"
                title={params.toString() ? "No skills match" : "No skills yet"}
                description={params.toString() ? "Try other filters." : "Import a skills repository or write one here."}
                primary={
                  can.manageSkills(me) && !params.toString() ? (
                    <Button variant="primary" icon="upload" href={href("/skills/import")}>
                      Import skills
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </AsyncBlock>
      {!!collections.data?.collections.length && (
        <Section title="Collections" count={collections.data.collections.length} description="Plugins from a marketplace, or groups made here. Giving a collection to people gives them every skill in it, including skills added later.">
          <div className="sk-collections">
            {collections.data.collections.map((c) => (
              <Card
                key={c.slug}
                padding="sm"
                className="sk-collection"
                title={c.name}
                description={
                  <span className="small muted">
                    {plural(c.skills, "skill")} · {c.assignments ? plural(c.assignments, "assignment") : "not assigned"}
                    {upstreamLabel(c.upstream_version) ? ` · ${c.upstream_version}` : ""}
                    {c.owner_project ? ` · ${c.owner_project.name}` : ""}
                  </span>
                }
                actions={
                  <Button size="sm" onClick={() => setMapping(c)}>
                    Give all to…
                  </Button>
                }
              >
                {c.description && <p className="small sk-clamp">{c.description}</p>}
                <ConnectorsLine connectors={c.connectors} compact />
                <Button size="sm" variant="ghost" onClick={() => setQ({ collection: c.slug })}>
                  Show its skills
                </Button>
              </Card>
            ))}
          </div>
        </Section>
      )}
      {mapping && (
        <AssignDialog
          target={{ kind: "collection", slug: mapping.slug, name: mapping.name, owner: mapping.owner_project }}
          scopes={scopes}
          onClose={() => setMapping(null)}
          onDone={() => {
            collections.reload();
            list.reload();
          }}
        />
      )}
    </div>
  );
}

const SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when Claude should use it (one or two sentences).
---

# My skill

Steps Claude follows, in order.
`;

/** A fuller starting point: when to use it, steps, checks, and where references and scripts go. */
export const SKILL_STARTER = `---
name: my-skill
description: Use when someone asks to do the task this skill covers, in the words they'd use. It lists the steps, the checks and what to report back.
---

# My skill

## When to use it
- The situations this covers, and the ones it doesn't.

## Steps
1. First, …
2. Then, …
3. Finally, …

## Checks before you finish
- What must be true before you report back.

## References
- references/notes.md: background to read when a step needs it.
- scripts/check.sh: run it only with the user's go-ahead.
`;

/** The name in SKILL.md's front matter, if it has one (the server reads it the same way). */
export function frontmatterName(md: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const n = m ? /^name\s*:\s*["']?([^"'\n]*?)["']?\s*$/m.exec(m[1]!) : null;
  return n ? n[1]!.trim() : null;
}

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_STARTERS: Record<"reference" | "script", { path: string; text: string }> = {
  reference: { path: "references/notes.md", text: "# Notes\n\nBackground Claude reads when SKILL.md points here.\n" },
  script: { path: "scripts/check.sh", text: "#!/bin/sh\n# What this script does. Claude runs it only with the user's go-ahead.\nset -eu\n" },
};

interface DraftFile {
  key: number;
  path: string;
  text: string;
}

/** Text files from disk, kept under a folder (references/ unless the name says script); binary files are refused. */
async function readTextFiles(list: FileList, nextKey: () => number): Promise<{ files: DraftFile[]; refused: string[] }> {
  const files: DraftFile[] = [];
  const refused: string[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const f of Array.from(list)) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let text: string | null = null;
    try {
      text = bytes.includes(0) ? null : decoder.decode(bytes);
    } catch {
      text = null;
    }
    if (text === null) {
      refused.push(f.name);
      continue;
    }
    const folder = /\.(sh|bash|py|js|mjs|ts|rb|pl|ps1)$/i.test(f.name) ? "scripts" : "references";
    files.push({ key: nextKey(), path: `${folder}/${f.name}`, text });
  }
  return { files, refused };
}

/** What the server allows in one skill (core/skills/types.ts SKILL_LIMITS). */
const SKILL_FILE_BYTES = 2 * 1024 * 1024;
const SKILL_TOTAL_BYTES = 10 * 1024 * 1024;

/**
 * The New skill dialog's POST /skills body, or why it can't be sent yet: without Manage skills a skill belongs to a
 * project; file paths are trimmed and must be unique and not SKILL.md; sizes stay within the server's limits.
 */
export function newSkillRequest(d: { md: string; files: { path: string; text: string }[]; collection: string; project: string; summary: string; orgWide: boolean }):
  | { body: { skill_md: string; files: { path: string; text: string }[]; collection: string | null; project: string | null; summary: string } }
  | { error: string; title: string } {
  if (!d.orgWide && !d.project) return { error: "Choose the project it belongs to", title: "Missing project" };
  const files = d.files.map((f) => ({ path: f.path.trim().replace(/^(\.\/)+/, ""), text: f.text }));
  const empty = files.find((f) => !f.path || f.path.endsWith("/"));
  if (empty) return { error: "Give every file a path, such as references/notes.md", title: "A file has no name" };
  if (files.some((f) => f.path === "SKILL.md")) return { error: "SKILL.md is the editor above; give the file another name", title: "Two SKILL.md files" };
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.path)) return { error: `${f.path} is there twice`, title: "Duplicate file" };
    seen.add(f.path);
  }
  const size = (t: string) => new TextEncoder().encode(t).length;
  const big = files.find((f) => size(f.text) > SKILL_FILE_BYTES);
  if (big) return { error: `${big.path} is over 2 MB, the most a skill file can be`, title: "File too big" };
  if (files.reduce((n, f) => n + size(f.text), size(d.md)) > SKILL_TOTAL_BYTES) return { error: "A skill can be at most 10 MB in all", title: "Skill too big" };
  return { body: { skill_md: d.md, files, collection: d.collection || null, project: d.project || null, summary: d.summary.trim() || "First version" } };
}

export function NewSkillDialog({ me, scopes, onClose }: { me: Me; scopes: ScopeInfo[]; onClose: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const collections = useApi<{ collections: Collection[] }>("/skill-collections");
  const orgWide = can.manageSkills(me);
  // Without Manage skills, a skill must belong to a project the person manages.
  const ownable = (s: ScopeInfo) => s.kind === "project" && (s.status === undefined || s.status === "active") && (orgWide || can.skillOwner(s, me));
  const [md, setMd] = useState(SKILL_TEMPLATE);
  const [files, setFiles] = useState<DraftFile[]>([]);
  const [collection, setCollection] = useState("");
  const [project, setProject] = useState(() => (orgWide ? "" : (scopes.find(ownable)?.slug ?? "")));
  const [summary, setSummary] = useState("");
  const [askReview, setAskReview] = useState(false);
  const [busy, setBusy] = useState(false);
  // Projects where the caller's own skills publish at once (a Project admin's, like their articles).
  const catalogue = useApi<{ can: { publish_directly_projects?: string[] } }>("/skills?status=archived");
  const publishes = !!project && (catalogue.data?.can.publish_directly_projects ?? []).includes(project);
  const willPublish = publishes && !askReview;
  const seq = useRef(1);
  const picker = useRef<HTMLInputElement>(null);
  const name = frontmatterName(md);
  const nameProblem = !name ? "Add a name: line to the front matter." : !SKILL_NAME_RE.test(name) || name.length > 64 ? "Use lowercase letters, digits and single hyphens (at most 64)." : null;
  const nextKey = () => seq.current++;
  const addFile = (kind: "reference" | "script") => {
    const base = FILE_STARTERS[kind];
    let path = base.path;
    for (let i = 2; files.some((f) => f.path === path); i++) path = base.path.replace(/(\.[a-z]+)$/, `-${i}$1`);
    setFiles((fs) => [...fs, { key: nextKey(), path, text: base.text }]);
  };
  async function fromDisk(list: FileList | null) {
    if (!list?.length) return;
    const { files: read, refused } = await readTextFiles(list, nextKey);
    setFiles((fs) => [...fs.filter((f) => !read.some((r) => r.path === f.path)), ...read]);
    if (refused.length) toast.error(`${refused.join(", ")}: only text files can be added here. Import an archive for images and other binary files.`, { title: "Some files weren't added" });
  }
  async function applyStarter() {
    if (md !== SKILL_TEMPLATE && md !== SKILL_STARTER && !(await confirm({ title: "Replace your SKILL.md?", body: "The starter template replaces what you've written.", confirmLabel: "Replace" }))) return;
    setMd(SKILL_STARTER);
  }
  async function save() {
    const req = newSkillRequest({ md, files, collection, project, summary, orgWide });
    if ("error" in req) return toast.error(req.error, { title: req.title });
    setBusy(true);
    try {
      const r = await api<{ id: string; name: string; version: number; published?: boolean; message?: string }>("/skills", { method: "POST", body: { ...req.body, ...(publishes && askReview ? { request_review: true } : {}) } });
      if (r.published) toast.success(`${r.name} is published`, { description: "Give it to people on its Who gets it tab." });
      else toast.success(`${r.name} v${r.version} waits for review by someone else`, r.message ? { description: r.message } : undefined);
      refreshCounts();
      onClose();
      navigate(`/skills/${r.id}`);
    } catch (err) {
      toast.error(err, { title: "Couldn't save the skill" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title="New skill"
      description={
        publishes
          ? "A skill is a SKILL.md that tells Claude how to do one kind of task, with optional references and scripts. As a Project admin your project's own skills publish at once, unless they have high-risk content."
          : "A skill is a SKILL.md that tells Claude how to do one kind of task, with optional references and scripts. Someone else reviews it before anyone gets it."
      }
      footer={
        <>
          {publishes && <Checkbox label="Ask someone to review it first" checked={askReview} onChange={(e) => setAskReview(e.target.checked)} />}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} loadingText="Saving" disabledReason={nameProblem ?? undefined} onClick={() => void save()}>
            {willPublish ? "Publish" : "Propose for review"}
          </Button>
        </>
      }
    >
      <div className="sk-form">
        <Callout tone="neutral" title="The front matter">
          <ul className="sk-fm-help">
            <li>
              <code>name</code>: the skill's name, in lowercase letters, digits and hyphens (<code>weekly-report</code>). It must be new.
            </li>
            <li>
              <code>description</code>: what it does and when Claude should use it, with the words people use. Claude reads only this to decide when to load the skill, so keep it under 500 characters.
            </li>
            <li>
              Optional: <code>license</code>, <code>compatibility</code>, <code>allowed-tools</code> (reviewers check them) and <code>metadata</code> for your own fields.
            </li>
          </ul>
        </Callout>
        <Field label="SKILL.md" hint={name && !nameProblem ? `Saved as ${name}.` : undefined} error={nameProblem ?? undefined}>
          <Textarea className="sk-editor" rows={14} value={md} onChange={(e) => setMd(e.target.value)} spellCheck={false} />
        </Field>
        <div className="sk-actions">
          <Button size="sm" variant="ghost" icon="doc" onClick={() => void applyStarter()}>
            Use the starter template
          </Button>
        </div>
        <Section
          title="Files"
          count={files.length || undefined}
          description="References Claude reads when SKILL.md points to them, and scripts it runs only with the user's go-ahead. Text files only; paths are relative to the skill folder."
          actions={
            <div className="sk-actions">
              <Button size="sm" icon="plus" onClick={() => addFile("reference")}>
                Reference
              </Button>
              <Button size="sm" icon="code" onClick={() => addFile("script")}>
                Script
              </Button>
              <Button size="sm" icon="upload" onClick={() => picker.current?.click()}>
                From disk…
              </Button>
              <input ref={picker} type="file" multiple className="sr-only" tabIndex={-1} aria-label="Add files from disk" onChange={(e) => (void fromDisk(e.target.files), (e.target.value = ""))} />
            </div>
          }
        >
          {files.length ? (
            <ul className="sk-files-edit">
              {files.map((f) => (
                <li key={f.key} className="sk-file-edit">
                  <div className="sk-file-edit-head">
                    <TextInput aria-label="Path" className="sk-editor" value={f.path} onChange={(e) => setFiles((fs) => fs.map((x) => (x.key === f.key ? { ...x, path: e.target.value } : x)))} spellCheck={false} />
                    <Button size="sm" variant="ghost" icon="trash" aria-label={`Remove ${f.path}`} onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                      Remove
                    </Button>
                  </div>
                  <Textarea aria-label={`Contents of ${f.path}`} className="sk-editor" rows={5} value={f.text} onChange={(e) => setFiles((fs) => fs.map((x) => (x.key === f.key ? { ...x, text: e.target.value } : x)))} spellCheck={false} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">No files yet. A skill can be just its SKILL.md.</p>
          )}
        </Section>
        <div className="sk-form-row">
          <Field label="Collection" optional hint="Giving a collection to people gives them every skill in it.">
            <Select value={collection} onChange={(e) => setCollection(e.target.value)} options={[{ value: "", label: "None" }, ...(collections.data?.collections ?? []).map((c) => ({ value: c.slug, label: c.name }))]} />
          </Field>
          <Field label="Owned by a project" optional={orgWide} hint={orgWide ? "Only that project's readers see it." : "Your skills belong to a project you manage; only its readers see them."}>
            <ProjectPicker value={project} onChange={setProject} scopes={scopes} filter={ownable} noneLabel={orgWide ? "The whole organisation" : "Choose a project"} searchable />
          </Field>
        </div>
        <Field label="What this version is" optional>
          <TextInput value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="First version" />
        </Field>
        <p className="small muted">
          Next: someone with Review skills approves it (not you), then you give it to people from its page. You can also push skills from Claude Code with the Thaliyola connector (propose_skill).
        </p>
      </div>
    </Dialog>
  );
}

// ---- Sources --------------------------------------------------------------------------------------------------------

function sourceWhere(s: SkillSource): string {
  if (s.kind === "upload") return "Uploads";
  return `${s.repository ?? ""}${s.ref ? `@${s.ref}` : ""}${s.path ? ` · ${s.path}` : ""}`;
}

function SourceHealth({ s }: { s: SkillSource }) {
  if (!s.enabled) return <Badge>Paused</Badge>;
  if (s.last_import?.status === "running") return <Badge tone="accent" icon="refresh">Importing</Badge>;
  if (s.last_error) return <Badge tone="danger" title={s.last_error}>Failing</Badge>;
  if (s.last_ok_at) return <Badge tone="success" icon="check">Healthy</Badge>;
  return <Badge variant="outline">Not run yet</Badge>;
}

async function syncSource(id: string, opts: { dry_run?: boolean; force?: boolean }, toast: ReturnType<typeof useToast>) {
  try {
    const r = await api<{ import_id: string }>(`/skill-sources/${id}/sync`, { method: "POST", body: opts });
    toast.success(opts.dry_run ? "Preview started" : "Import started");
    navigate(`/skills/imports/${r.import_id}`);
  } catch (err) {
    toast.error(err, { title: "Couldn't start the import" });
  }
}

function SourcesTab() {
  const toast = useToast();
  const sources = useApi<SkillSources>("/skill-sources");
  const imports = useApi<{ imports: SkillImport[] }>("/skill-imports");
  const columns: Column<SkillSource>[] = [
    { key: "name", header: "Source", primary: true, cell: (s) => <a href={href(`/skills/sources/${s.id}`)}>{s.name}</a> },
    { key: "where", header: "Repository", cell: (s) => <code className="sk-break small">{sourceWhere(s)}</code>, hideBelow: 760 },
    { key: "health", header: "Health", cell: (s) => <SourceHealth s={s} /> },
    { key: "commit", header: "Last commit", cell: (s) => (s.last_commit ? <code>{shortSha(s.last_commit)}</code> : <span className="muted">None</span>), hideBelow: 1100 },
    { key: "run", header: "Last run", cell: (s) => <RelativeTime date={s.last_run_at} never="Never" /> },
    { key: "skills", header: "Skills", numeric: true, cell: (s) => s.skills },
  ];
  return (
    <div className="sk-stack">
      <AsyncBlock result={sources} label="Loading skill sources" errorTitle="Couldn't load the skill sources" skeleton={<SkeletonRows count={3} />}>
        {(d) => (
          <DataTable
            caption="Skill sources"
            columns={columns}
            rows={d.sources}
            getRowId={(s) => s.id}
            rowMenu={(s) =>
              s.kind === "git"
                ? [
                    { id: "sync", label: "Sync now", icon: "refresh", onSelect: () => void syncSource(s.id, {}, toast) },
                    { id: "preview", label: "Preview changes", icon: "eye", onSelect: () => void syncSource(s.id, { dry_run: true }, toast) },
                  ]
                : []
            }
            empty={
              <EmptyState
                icon="git-branch"
                title="No sources yet"
                description="Connect a GitLab or GitHub repository of skills, or upload an archive."
                primary={
                  <Button variant="primary" icon="plus" href={href("/skills/import")}>
                    Add a source
                  </Button>
                }
              />
            }
          />
        )}
      </AsyncBlock>
      <Section title="Recent imports">
        <AsyncBlock result={imports} label="Loading imports" errorTitle="Couldn't load the imports" skeleton={<SkeletonRows count={3} />}>
          {(d) => <ImportsTable imports={d.imports} />}
        </AsyncBlock>
      </Section>
    </div>
  );
}

function ImportsTable({ imports }: { imports: SkillImport[] }) {
  return (
    <DataTable
      caption="Recent imports"
      density="compact"
      rows={imports}
      getRowId={(i) => i.id}
      rowHref={(i) => href(`/skills/imports/${i.id}`)}
      columns={[
        { key: "when", header: "Started", primary: true, cell: (i) => <RelativeTime date={i.started_at} /> },
        { key: "what", header: "From", cell: (i) => i.source?.name ?? i.filename ?? (i.kind === "articles" ? "Articles" : "Upload") },
        {
          key: "status",
          header: "Result",
          cell: (i) =>
            i.status === "running" ? (
              <Badge tone="accent">Running</Badge>
            ) : i.status === "failed" ? (
              <Badge tone="danger" title={i.error ?? undefined}>Failed</Badge>
            ) : (
              <span className="small">
                {i.dry_run ? "Preview: " : ""}
                {i.counts ? `${i.counts.added ?? 0} added, ${i.counts.changed ?? 0} changed, ${i.counts.rejected ?? 0} rejected` : "Done"}
              </span>
            ),
        },
        { key: "commit", header: "Commit", cell: (i) => (i.commit ? <code>{shortSha(i.commit)}</code> : null), hideBelow: 760 },
        { key: "by", header: "By", cell: (i) => i.started_by ?? (i.scheduled ? "Schedule" : ""), hideBelow: 1100 },
      ]}
      empty={<EmptyState variant="compact" title="No imports yet" />}
    />
  );
}

// ---- Usage overview ------------------------------------------------------------------------------------------------

function UsageTab() {
  const [days, setDays] = useState("30");
  const usage = useApi<{
    days: number;
    skills: { id: string; name: string; status: string; version: number | null; uses: number; people: number; last_used_at: string | null; behind: number }[];
    unused: string[];
    sync_checks: { id: string; name: string; at: string; script: string | null }[];
  }>(`/skills/usage?days=${days}`);
  return (
    <div className="sk-stack">
      <SegmentedControl
        label="Period"
        value={days}
        onChange={setDays}
        size="sm"
        options={[
          { value: "30", label: "30 days" },
          { value: "90", label: "90 days" },
          { value: "365", label: "A year" },
        ]}
      />
      <AsyncBlock result={usage} label="Loading skill usage" errorTitle="Couldn't load skill usage" skeleton={<SkeletonRows count={5} />}>
        {(d) => (
          <>
            <div className="sk-tiles">
              <StatTile label="Skill loads" value={d.skills.reduce((a, s) => a + s.uses, 0)} icon="sparkle" />
              <StatTile label="Skills nobody used in 30 days" value={d.unused.length} icon="clock" />
              <StatTile label="People syncing to Claude Code" value={d.sync_checks.length} icon="download" />
            </div>
            <DataTable
              caption="Usage per skill"
              rows={d.skills}
              getRowId={(s) => s.id}
              rowHref={(s) => href(`/skills/${s.id}`, { tab: "usage" })}
              columns={[
                { key: "name", header: "Skill", primary: true, cell: (s) => s.name },
                { key: "uses", header: "Loads", numeric: true, cell: (s) => s.uses },
                { key: "people", header: "People", numeric: true, cell: (s) => s.people },
                { key: "behind", header: "On an older copy", numeric: true, cell: (s) => (s.behind ? <Badge tone="warning">{s.behind}</Badge> : 0), hideBelow: 760 },
                { key: "last", header: "Last used", cell: (s) => <RelativeTime date={s.last_used_at} never="Never" /> },
              ]}
              empty={<EmptyState variant="compact" title="No skills yet" />}
            />
            <Section title="Claude Code sync checks" description="The last time each person's sync script checked in.">
              <DataTable
                caption="Sync checks"
                density="compact"
                rows={d.sync_checks}
                getRowId={(s) => s.id}
                columns={[
                  { key: "who", header: "Person", primary: true, cell: (s) => s.name },
                  { key: "at", header: "Last check", cell: (s) => <RelativeTime date={s.at} /> },
                  { key: "script", header: "Script", cell: (s) => <code className="small">{s.script ?? "?"}</code>, hideBelow: 760 },
                ]}
                empty={<EmptyState variant="compact" title="Nobody syncs to Claude Code yet" />}
              />
            </Section>
          </>
        )}
      </AsyncBlock>
    </div>
  );
}

// ---- Import --------------------------------------------------------------------------------------------------------

export function SkillImportPage({ me, scopes }: { me: Me; scopes: ScopeInfo[] }) {
  const sources = useApi<SkillSources>("/skill-sources");
  return (
    <Page width="content">
      <PageHeader
        title="Import skills"
        crumbs={[{ label: "Skills", href: href("/skills", { tab: "all" }) }]}
        nav="skills"
        description="From a Claude plugin marketplace (.claude-plugin/marketplace.json), any skills/<name>/SKILL.md folders, or a single skill. Every new or changed skill waits for review."
      />
      {!can.manageSkills(me) ? (
        <EmptyState variant="locked" icon="lock" title="Importing skills needs Manage skills" description="Skills managers and Administrators import skills." />
      ) : (
        <div className="sk-stack">
          <UploadCard scopes={scopes} noDeliver={sources.data?.suggested_no_deliver ?? ["evals/**", "tasks/**"]} />
          <Card as="section" title="Connect a repository" titleLevel={2} description="Read a GitLab or GitHub repository through its API, on demand (Sync now) or on a schedule. Thaliyola keeps each skill's assignments across re-imports.">
            <AsyncBlock result={sources} label="Loading sources" errorTitle="Couldn't load the sources" skeleton={<SkeletonText lines={6} />}>
              {(d) => <SourceForm data={d} scopes={scopes} me={me} />}
            </AsyncBlock>
          </Card>
          {!!sources.data?.sources.length && (
            <Section title="Sources" count={sources.data.sources.length}>
              <ul className="sk-plain-list">
                {sources.data.sources.map((s) => (
                  <li key={s.id}>
                    <a href={href(`/skills/sources/${s.id}`)}>{s.name}</a> <span className="muted small">{sourceWhere(s)}</span> <SourceHealth s={s} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </Page>
  );
}

function UploadCard({ scopes, noDeliver }: { scopes: ScopeInfo[]; noDeliver: string[] }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [project, setProject] = useState("");
  const [collection, setCollection] = useState("");
  const [exclude, setExclude] = useState("");
  const [noDeliverText, setNoDeliver] = useState(noDeliver.join("\n"));
  const [preview, setPreview] = useState<ImportReport | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const query = (dry: boolean) => ({
    dry_run: dry ? "true" : undefined,
    project: project || undefined,
    collection: collection.trim() || undefined,
    exclude: [...parseGlobs(exclude), ...chosen].join(",") || undefined,
    no_deliver: parseGlobs(noDeliverText).join(",") || undefined,
  });
  async function run(dry: boolean) {
    if (!file) return;
    setBusy(dry ? "preview" : "import");
    try {
      const r = await uploadSkillArchive(file, query(dry));
      if (dry) {
        setPreview(r.report);
        setChosen((r.report.suggested_excludes ?? []).filter((g) => !parseGlobs(exclude).includes(g)));
        if (r.status === "failed") toast.error(r.error ?? "The archive couldn't be read", { title: "Preview failed" });
      } else {
        refreshCounts();
        toast.success("Imported: new and changed skills wait for review");
        navigate(`/skills/imports/${r.import_id}`);
      }
    } catch (err) {
      toast.error(err, { title: dry ? "Couldn't preview the archive" : "Couldn't import the archive" });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card as="section" title="Upload a .zip, .skill or .tar.gz" titleLevel={2} description="A repository archive (for example from git archive), a zipped skill folder, or a skill Claude packaged (.skill). Preview first: nothing is saved until you import.">
      <div className="sk-form">
        <FileDrop
          label="Archive"
          accept=".zip,.skill,.tar.gz,.tgz,application/zip,application/gzip"
          file={file}
          onFile={(f) => {
            setFile(f);
            setPreview(null);
          }}
          hint="Up to the server's import limit. Folders, symlinks and paths outside the archive are refused."
        />
        <div className="sk-form-row">
          <Field label="Owned by a project" optional hint="Only that project's readers see these skills.">
            <ProjectPicker value={project} onChange={setProject} scopes={scopes} filter={(s) => s.kind === "project"} noneLabel="The whole organisation" searchable />
          </Field>
          <Field label="Collection for a single skill" optional hint="Marketplaces bring their own plugins as collections.">
            <TextInput value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="e.g. im-general" />
          </Field>
        </div>
        <div className="sk-form-row">
          <Field label="Exclude" optional hint="Skill folders never imported, one pattern per line, e.g. plugins/im-knowledge-base/**">
            <Textarea rows={3} value={exclude} onChange={(e) => setExclude(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="Import for reviewers only" optional hint="Files inside a skill that are never delivered to Claude (development files).">
            <Textarea rows={3} value={noDeliverText} onChange={(e) => setNoDeliver(e.target.value)} spellCheck={false} />
          </Field>
        </div>
        {preview && (
          <div className="sk-preview">
            <h3 className="sk-subhead">Preview</h3>
            {!!preview.suggested_excludes?.length && (
              <fieldset className="sk-fieldset">
                <legend>Suggested excludes</legend>
                {preview.suggested_excludes.map((g) => (
                  <Checkbox
                    key={g}
                    label={<code>{g}</code>}
                    description="Loaders or copies of Thaliyola's own skill: their content lives in Thaliyola already."
                    checked={chosen.includes(g)}
                    onChange={(e) => setChosen((c) => (e.target.checked ? [...c, g] : c.filter((x) => x !== g)))}
                  />
                ))}
              </fieldset>
            )}
            <ImportReportView report={preview} scopes={scopes} preview />
          </div>
        )}
        <div className="sk-actions">
          <Button icon="eye" disabledReason={!file ? "Choose an archive first" : undefined} loading={busy === "preview"} loadingText="Reading" onClick={() => void run(true)}>
            {preview ? "Preview again" : "Preview"}
          </Button>
          <Button variant="primary" icon="upload" disabledReason={!file ? "Choose an archive first" : !preview ? "Preview it first" : undefined} loading={busy === "import"} loadingText="Importing" onClick={() => void run(false)}>
            Import
          </Button>
        </div>
      </div>
    </Card>
  );
}

const SCHEDULES = [
  { value: "", label: "Only when I sync" },
  { value: "360", label: "Every 6 hours" },
  { value: "1440", label: "Daily" },
  { value: "10080", label: "Weekly" },
];

function SourceForm({ data, scopes, me, source, onSaved }: { data: SkillSources; scopes: ScopeInfo[]; me: Me; source?: SkillSource; onSaved?: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(source?.name ?? "");
  const [provider, setProvider] = useState<"gitlab" | "github">(source?.provider ?? "gitlab");
  const [repository, setRepository] = useState(source?.repository ?? "");
  const [ref, setRef] = useState(source?.ref ?? "");
  const [path, setPath] = useState(source?.path ?? "");
  const [exclude, setExclude] = useState((source?.exclude ?? []).join("\n"));
  const [noDeliver, setNoDeliver] = useState((source?.no_deliver ?? data.suggested_no_deliver).join("\n"));
  const [project, setProject] = useState(source?.owner_project?.slug ?? "");
  const [auth, setAuth] = useState<"connection" | "token">(source?.connection || !data.can.store_tokens ? "connection" : source?.token.set ? "token" : data.git_connections.length ? "connection" : "token");
  const [connection, setConnection] = useState(source?.connection?.id ?? "");
  const [apiUrl, setApiUrl] = useState(source?.api_url ?? "");
  const [token, setToken] = useState("");
  const [interval, setInterval] = useState(source?.interval_minutes ? String(source.interval_minutes) : "");
  const [direct, setDirect] = useState(source?.publish_directly ?? false);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    const body = {
      name: name.trim() || repository.trim(),
      kind: "git",
      provider,
      repository: repository.trim(),
      ref: ref.trim() || null,
      path: path.trim(),
      exclude: parseGlobs(exclude),
      no_deliver: parseGlobs(noDeliver),
      ...(source ? {} : { project: project || null }),
      connection: auth === "connection" ? connection || null : null,
      api_url: auth === "token" ? apiUrl.trim() || null : null,
      ...(auth === "token" && token ? { token } : {}),
      ...(auth === "connection" && source?.token.set ? { token: null } : {}),
      interval_minutes: interval ? Number(interval) : null,
      ...(data.can.publish_directly ? { publish_directly: direct } : {}),
    };
    try {
      const r = await api<{ id: string }>(source ? `/skill-sources/${source.id}` : "/skill-sources", { method: source ? "PATCH" : "POST", body });
      setToken("");
      toast.success(source ? "Source saved" : "Source added: preview it to see what it would import");
      if (onSaved) onSaved();
      else navigate(`/skills/sources/${r.id ?? source?.id}`);
    } catch (err) {
      toast.error(err, { title: "Couldn't save the source" });
    } finally {
      setBusy(false);
    }
  }
  const hostHint = data.git_hosts.length ? `Self-hosted servers allowed for stored tokens: ${data.git_hosts.join(", ")}.` : "Stored tokens work with gitlab.com and github.com; for a self-hosted server use a git connection, or ask an Administrator to list it in SKILLS_GIT_HOSTS.";
  return (
    <div className="sk-form">
      <div className="sk-form-row">
        <Field label="Provider">
          <Select value={provider} onChange={(e) => setProvider(e.target.value as "gitlab" | "github")} options={[{ value: "gitlab", label: "GitLab" }, { value: "github", label: "GitHub" }]} />
        </Field>
        <Field label="Repository" hint={provider === "gitlab" ? "group/subgroup/project" : "owner/repo"}>
          <TextInput value={repository} onChange={(e) => setRepository(e.target.value)} placeholder={provider === "gitlab" ? "cap_tech1/ai-tools/claude-skills" : "owner/repo"} spellCheck={false} />
        </Field>
      </div>
      <div className="sk-form-row">
        <Field label="Name" optional>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={repository || "Team skills"} />
        </Field>
        <Field label="Branch, tag or commit" optional hint="Empty: the default branch.">
          <TextInput value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} />
        </Field>
      </div>
      <Field label="Only skills under this path" optional>
        <TextInput value={path} onChange={(e) => setPath(e.target.value)} placeholder="plugins/im-analytics" spellCheck={false} />
      </Field>
      <div className="sk-form-row">
        <Field label="Exclude" optional hint="One pattern per line.">
          <Textarea rows={3} value={exclude} onChange={(e) => setExclude(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="Import for reviewers only" optional hint="Files never delivered to Claude.">
          <Textarea rows={3} value={noDeliver} onChange={(e) => setNoDeliver(e.target.value)} spellCheck={false} />
        </Field>
      </div>
      {!source && (
        <Field label="Owned by a project" optional hint="Its skills are visible only to that project's readers.">
          <ProjectPicker value={project} onChange={setProject} scopes={scopes} filter={(s) => s.kind === "project"} noneLabel="The whole organisation" searchable />
        </Field>
      )}
      <SegmentedControl
        label="How Thaliyola signs in"
        labelVisible
        value={auth}
        onChange={setAuth}
        options={[
          { value: "connection", label: "A git connection" },
          { value: "token", label: "A token stored here", disabled: !data.can.store_tokens },
        ]}
      />
      {auth === "connection" ? (
        <Field label="Git connection" hint={data.git_connections.length ? "The Team space's git connections, and those of projects you manage." : undefined}>
          <Select
            value={connection}
            onChange={(e) => setConnection(e.target.value)}
            options={[
              { value: "", label: data.git_connections.length ? "Choose a connection" : "No git connections you can use" },
              ...data.git_connections.map((c) => ({ value: c.id, label: `${c.name} (${c.space === "team" ? "Team space" : c.space_name})${c.enabled ? "" : ", paused"}` })),
            ]}
          />
        </Field>
      ) : (
        <div className="sk-form-row">
          <Field label="API address" optional hint={hostHint}>
            <TextInput value={apiUrl} onChange={(e) => setApiUrl(e.target.value)} placeholder={provider === "gitlab" ? "https://gitlab.com/api/v4" : "https://api.github.com"} spellCheck={false} />
          </Field>
          <Field label="Access token" optional={!!source?.token.set} hint={source?.token.set ? `Stored (${source.token.hint ?? "set"}). Leave empty to keep it.` : "Read-only access to the repository is enough. Encrypted with CONNECTIONS_KEY."}>
            <TextInput type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
        </div>
      )}
      {!data.can.store_tokens && <p className="small muted">Stored tokens need CONNECTIONS_KEY on the server; use a git connection instead.</p>}
      <Field label="Check for changes">
        <Select value={interval} onChange={(e) => setInterval(e.target.value)} options={SCHEDULES} />
      </Field>
      {data.can.publish_directly && (
        <Switch
          label="Publish changed versions without review"
          description="Treats the repository's own merge-request review as the second person. Never applies to new skills, audience changes or versions with high-risk flags; those still wait for review."
          checked={direct}
          onChange={setDirect}
        />
      )}
      <div className="sk-actions">
        <Button variant="primary" loading={busy} loadingText="Saving" disabledReason={!repository.trim() ? "Enter the repository" : undefined} onClick={() => void save()}>
          {source ? "Save changes" : "Add source"}
        </Button>
        {!source && me.admin && (
          <Button variant="ghost" href={href("/scope/team/settings", { tab: "connections" })}>
            Team-space git connections
          </Button>
        )}
      </div>
    </div>
  );
}

// ---- Source detail ---------------------------------------------------------------------------------------------------

export function SkillSourcePage({ id, me, scopes }: { id: string; me: Me; scopes: ScopeInfo[] }) {
  const toast = useToast();
  const confirm = useConfirm();
  const sources = useApi<SkillSources>("/skill-sources");
  const imports = useApi<{ imports: SkillImport[] }>(`/skill-imports?source=${encodeURIComponent(id)}`);
  const source = sources.data?.sources.find((s) => s.id === id);
  async function remove(s: SkillSource) {
    const ok = await confirm({ title: `Remove ${s.name}?`, body: "Its skills stay, with their versions and assignments, but stop updating from the repository.", confirmLabel: "Remove source", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/skill-sources/${s.id}`, { method: "DELETE" });
      toast.success(`Removed ${s.name}`);
      navigate("/skills", { tab: "sources" });
    } catch (err) {
      toast.error(err, { title: "Couldn't remove the source" });
    }
  }
  return (
    <Page width="content">
      <PageHeader
        title={source?.name ?? "Skill source"}
        crumbs={[{ label: "Skills", href: href("/skills", { tab: "sources" }) }]}
        nav="skills"
        status={source ? <SourceHealth s={source} /> : undefined}
        description={source ? <code className="sk-break">{sourceWhere(source)}</code> : undefined}
        actions={
          source?.kind === "git" ? (
            <Button icon="eye" onClick={() => void syncSource(source.id, { dry_run: true }, toast)}>
              Preview
            </Button>
          ) : undefined
        }
        primary={
          source?.kind === "git" ? (
            <Button variant="primary" icon="refresh" onClick={() => void syncSource(source.id, {}, toast)}>
              Sync now
            </Button>
          ) : undefined
        }
        menu={source ? [{ id: "force", label: "Sync and propose everything again", icon: "refresh", onSelect: () => void syncSource(source.id, { force: true }, toast) }, { id: "remove", label: "Remove source…", icon: "trash", tone: "danger", onSelect: () => void remove(source) }] : undefined}
      />
      <AsyncBlock result={sources} label="Loading the source" errorTitle="Couldn't load the source" skeleton={<SkeletonCard />}>
        {(d) =>
          !source ? (
            <EmptyState icon="search" title="Source not found" description="It was removed, or you can't see it." />
          ) : (
            <div className="sk-stack">
              {source.last_error && (
                <Callout tone="danger" title="The last run failed">
                  <p>{source.last_error}</p>
                </Callout>
              )}
              <Card padding="sm">
                <Facts
                  columns={2}
                  items={[
                    { term: "Last commit", value: source.last_commit ? <code>{shortSha(source.last_commit)}</code> : "None yet" },
                    { term: "Last success", value: <RelativeTime date={source.last_ok_at} never="Never" /> },
                    { term: "Schedule", value: SCHEDULES.find((s) => s.value === String(source.interval_minutes ?? ""))?.label ?? `Every ${source.interval_minutes} minutes` },
                    { term: "Next run", value: <RelativeTime date={source.next_run_at} never="Not scheduled" /> },
                    { term: "Signs in with", value: source.connection ? `${source.connection.name} (git connection)` : source.token.set ? `A stored token (${source.token.hint ?? "set"})` : "No credentials" },
                    { term: "Scheduled runs act as", value: source.run_as ?? "Nobody" },
                    { term: "Owned by", value: source.owner_project?.name ?? "The organisation" },
                    { term: "Without review", value: source.publish_directly ? "Changed versions publish directly" : "Everything waits for review" },
                    { term: "Skills", value: String(source.skills) },
                  ]}
                />
              </Card>
              {source.kind === "git" && source.webhook && <WebhookCard source={source} webhook={source.webhook} manage={can.manageSkills(me)} storeTokens={d.can.store_tokens} onChanged={sources.reload} />}
              <Section title="Imports">
                <AsyncBlock result={imports} label="Loading imports" errorTitle="Couldn't load the imports" skeleton={<SkeletonRows count={3} />}>
                  {(x) => <ImportsTable imports={x.imports} />}
                </AsyncBlock>
              </Section>
              {can.manageSkills(me) && source.kind === "git" && (
                <Disclosure summary="Change this source">
                  <SourceForm data={d} scopes={scopes} me={me} source={source} onSaved={sources.reload} />
                </Disclosure>
              )}
            </div>
          )
        }
      </AsyncBlock>
    </Page>
  );
}

/**
 * The source's push webhook: the URL and a secret to paste into GitLab (Settings › Webhooks, Secret token) or GitHub,
 * so a push to the source's branch syncs it at once. The secret is shown once, when it's made.
 */
function WebhookCard({ source, webhook, manage, storeTokens, onChanged }: { source: SkillSource; webhook: NonNullable<SkillSource["webhook"]>; manage: boolean; storeTokens: boolean; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const url = webhook.url ?? `${window.location.origin}${webhook.path}`;
  async function make() {
    if (webhook.secret.set) {
      const ok = await confirm({ title: "Make a new secret?", body: "The webhook in GitLab or GitHub stops working until you paste the new secret there.", confirmLabel: "Make a new secret", tone: "danger" });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const r = await api<{ secret: string }>(`/skill-sources/${source.id}/webhook-secret`, { method: "POST" });
      setSecret(r.secret);
      onChanged();
    } catch (err) {
      toast.error(err, { title: "Couldn't make a secret" });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const ok = await confirm({ title: "Remove the webhook?", body: "Pushes stop syncing this source; Sync now and the schedule keep working. Remove the webhook in GitLab or GitHub too.", confirmLabel: "Remove webhook", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/skill-sources/${source.id}/webhook-secret`, { method: "DELETE" });
      setSecret(null);
      toast.success("Removed the webhook");
      onChanged();
    } catch (err) {
      toast.error(err, { title: "Couldn't remove the webhook" });
    }
  }
  return (
    <Card
      as="section"
      padding="sm"
      className="sk-webhook"
      title="Sync on every push"
      titleLevel={2}
      description={`A push to ${source.ref ?? "the default branch"} of ${source.repository ?? "the repository"} syncs this source at once, as ${source.run_as ?? "its owner"}. Changed skills still wait for review.`}
      actions={
        manage ? (
          <span className="sk-webhook-actions">
            {webhook.secret.set && (
              <Button size="sm" variant="danger" onClick={() => void remove()}>
                Remove
              </Button>
            )}
            <Button size="sm" icon="key" onClick={() => void make()} loading={busy} disabledReason={storeTokens ? undefined : "Storing a secret needs CONNECTIONS_KEY on the server"}>
              {webhook.secret.set ? "Make a new secret" : "Make a secret"}
            </Button>
          </span>
        ) : undefined
      }
    >
      <Facts
        columns={1}
        items={[
          { term: "Webhook URL", value: <span className="sk-webhook-url"><code className="sk-break">{url}</code> <CopyButton text={url} /></span> },
          { term: "Secret", value: webhook.secret.set ? `Set (${webhook.secret.hint ?? "hidden"})` : "Not set: the webhook is off" },
          { term: "Last push", value: <RelativeTime date={webhook.last_at} never="None yet" /> },
          ...(webhook.queued_at ? [{ term: "Queued", value: <>A push came while a sync ran; it syncs <RelativeTime date={webhook.queued_at} /></> }] : []),
        ]}
      />
      {secret && (
        <Callout tone="warning" title="Copy the secret now: it isn't shown again">
          <p className="sk-webhook-url">
            <code className="sk-break">{secret}</code> <CopyButton text={secret} />
          </p>
        </Callout>
      )}
      <Disclosure summary={source.provider === "github" ? "Add it in GitHub" : "Add it in GitLab"}>
        {source.provider === "github" ? (
          <ol className="sk-steps small">
            <li>In the repository: Settings › Webhooks › Add webhook.</li>
            <li>Payload URL: the webhook URL above. Content type: <code>application/json</code>.</li>
            <li>Secret: the secret. Events: just the push event.</li>
          </ol>
        ) : (
          <ol className="sk-steps small">
            <li>In the project: Settings › Webhooks › Add new webhook.</li>
            <li>URL: the webhook URL above. Secret token: the secret.</li>
            <li>Trigger: Push events, for the branch {source.ref ?? "the source follows"}. Keep SSL verification on.</li>
          </ol>
        )}
      </Disclosure>
    </Card>
  );
}

// ---- Import report ------------------------------------------------------------------------------------------------

export function SkillImportReportPage({ id, me, scopes }: { id: string; me: Me; scopes: ScopeInfo[] }) {
  const toast = useToast();
  const result = useApi<SkillImport>(`/skill-imports/${id}`);
  const [approving, setApproving] = useState(false);
  const waiting = (result.data?.report?.added ?? []).filter((a) => a.state === "pending").length + (result.data?.report?.changed ?? []).filter((c) => c.state === "pending").length;
  async function approveAll() {
    setApproving(true);
    try {
      const r = await api<{ approved: string[]; skipped: { name: string; reason: string }[] }>(`/skill-imports/${id}/approve`, { method: "POST", body: {} });
      if (r.approved.length) toast.success(`Published ${plural(r.approved.length, "skill")}${r.skipped.length ? `; ${r.skipped.length} need their own review in Review › Skills` : ""}`);
      else toast.info(r.skipped.length ? `Nothing published: ${r.skipped[0]!.reason}${r.skipped.length > 1 ? ` (and ${r.skipped.length - 1} more)` : ""}` : "Nothing waits for review from this import");
      refreshCounts();
    } catch (err) {
      toast.error(err, { title: "Couldn't approve them" });
    } finally {
      setApproving(false);
    }
  }
  const running = result.data?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setTimeout(result.reload, 2000);
    return () => clearTimeout(t);
  }, [running, result.reload, result.data]);
  const i = result.data;
  const title = i?.source?.name ?? i?.filename ?? "Import";
  return (
    <Page width="content">
      <PageHeader
        title={i ? `${i.dry_run ? "Preview" : "Import"}: ${title}` : "Import report"}
        crumbs={[{ label: "Skills", href: href("/skills", { tab: can.manageSkills(me) ? "sources" : "all" }) }]}
        nav="skills"
        status={i ? i.status === "running" ? <Badge tone="accent" icon="refresh">Running</Badge> : i.status === "failed" ? <Badge tone="danger">Failed</Badge> : i.dry_run ? <Badge>Preview, nothing saved</Badge> : <Badge tone="success" icon="check">Done</Badge> : undefined}
        description={
          i ? (
            <span className="small">
              {i.started_by ? `Started by ${i.started_by}` : i.scheduled ? "Scheduled" : ""} · <RelativeTime date={i.started_at} />
              {i.commit ? (
                <>
                  {" "}
                  · commit <code>{shortSha(i.commit)}</code>
                </>
              ) : null}
              {i.layout ? ` · ${i.layout} layout` : ""}
            </span>
          ) : undefined
        }
        primary={
          i?.source && i.dry_run && i.status === "done" ? (
            <Button variant="primary" icon="refresh" onClick={() => void syncSource(i.source!.id, {}, toast)}>
              Import for real
            </Button>
          ) : i && !i.dry_run && i.status === "done" && waiting > 0 && can.reviewSkills(me) ? (
            <Button variant="primary" icon="check" loading={approving} onClick={() => void approveAll()}>
              Review this import: approve all without high-risk flags
            </Button>
          ) : undefined
        }
      />
      <AsyncBlock result={result} label="Loading the import" errorTitle="Couldn't load the import" skeleton={<SkeletonRows count={6} />}>
        {(d) => (
          <div className="sk-stack">
            {d.error && (
              <Callout tone="danger" title="The import failed">
                <p>{d.error}</p>
              </Callout>
            )}
            {d.status === "running" ? <SkeletonText lines={4} /> : d.report ? <ImportReportView report={d.report} scopes={scopes} manage={can.manageSkills(me)} onChanged={result.reload} /> : null}
          </div>
        )}
      </AsyncBlock>
    </Page>
  );
}

/** The report: counts, then each non-empty section in order. */
export function ImportReportView({ report, scopes, preview = false, manage = false, onChanged }: { report: ImportReport; scopes: ScopeInfo[]; preview?: boolean; manage?: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [mapping, setMapping] = useState<{ slug: string; name: string } | null>(null);
  const counts = reportCounts(report);
  const linkByName = (name: string) => <a href={href("/skills", { tab: "all", q: name })}>{name}</a>;
  async function retire(rows: { name: string; skill_id: string }[]) {
    const ok = await confirm({ title: `Retire ${plural(rows.length, "skill")}?`, body: "They stop reaching Claude. Their versions and assignments stay.", confirmLabel: "Retire", tone: "danger" });
    if (!ok) return;
    try {
      await api("/skills/retire", { method: "POST", body: { ids: rows.map((r) => r.skill_id) } });
      toast.success(`Retired ${plural(rows.length, "skill")}`);
      onChanged?.();
    } catch (err) {
      toast.error(err, { title: "Couldn't retire them" });
    }
  }
  async function adopt(row: { name: string; skill_id: string; path: string }) {
    if (!report.source) return;
    try {
      await api(`/skills/${row.skill_id}/adopt`, { method: "POST", body: { source: report.source, path: row.path } });
      toast.success(`${row.name} now updates from ${report.source}`);
      onChanged?.();
    } catch (err) {
      toast.error(err, { title: `Couldn't link ${row.name}` });
    }
  }
  const render = (key: string): ReactNode => {
    switch (key) {
      case "added":
        return report.added!.map((a) => (
          <li key={a.name}>
            {linkByName(a.name)} <span className="muted small">{a.collection} · v{a.version}{a.upstream_version ? ` (${a.upstream_version})` : ""}</span>
            {!!a.high_risk_flags && <Badge tone="danger">{plural(a.high_risk_flags, "high-risk flag")}</Badge>}
          </li>
        ));
      case "changed": {
        const guidance = report.changed!.filter((c) => c.guidance_only);
        const other = report.changed!.filter((c) => !c.guidance_only);
        return (
          <>
            {other.map((c) => (
              <li key={c.name}>
                {linkByName(c.name)} <span className="muted small">v{c.from ?? "?"} → v{c.to ?? c.version}{c.files_changed ? ` · ${plural(c.files_changed, "file")} changed` : ""}</span>
                {!!c.high_risk_flags && <Badge tone="danger">{plural(c.high_risk_flags, "high-risk flag")}</Badge>}
              </li>
            ))}
            {guidance.length > 0 && (
              <li>
                <strong>Shared guidance only</strong> <span className="muted small">({plural(guidance.length, "skill")}: {guidance.map((g) => g.name).join(", ")}). Approve them together in Review › Skills.</span>
              </li>
            )}
          </>
        );
      }
      case "moved":
        return report.moved!.map((m) => (
          <li key={m.name}>
            {linkByName(m.name)} <span className="muted small">{m.from ?? "no collection"} → {m.to}</span>{" "}
            {m.pending ? <Badge tone="warning">Waits for a second person</Badge> : m.declined ? <Badge>Declined earlier</Badge> : <Badge tone="success">Moved</Badge>}
            {m.gains.people > 0 && <span className="small muted"> · would also reach {plural(m.gains.people, "person", "people")} ({m.gains.audiences.join("; ")})</span>}
          </li>
        ));
      case "rejected":
        return report.rejected!.map((r) => (
          <li key={(r.path ?? r.title ?? r.name)!}>
            <code className="sk-break">{r.path ?? r.title ?? r.name}</code>
            <ul className="sk-reasons">
              {r.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </li>
        ));
      case "rejected_before":
        return report.rejected_before!.map((r) => (
          <li key={r.name}>
            {linkByName(r.name)} <span className="muted small">v{r.version}{r.reason ? `: ${r.reason}` : ""}</span>
          </li>
        ));
      case "held":
        return report.held!.map((h) => (
          <li key={h.name}>
            {linkByName(h.name)} <span className="muted small">held at v{h.at}{h.upstream_changed ? "; the repository has a newer version" : ""}</span>
          </li>
        ));
      case "detached":
        return report.detached!.map((h) => (
          <li key={h.name}>
            {linkByName(h.name)} <span className="muted small">{h.upstream_changed ? "the repository changed too" : "unchanged upstream"}</span>
          </li>
        ));
      case "adoptable":
        return report.adoptable!.map((a) => (
          <li key={a.name}>
            {linkByName(a.name)} <code className="small">{a.path}</code>{" "}
            {manage && !preview && report.source && (
              <Button size="sm" variant="ghost" onClick={() => void adopt(a)}>
                Link to the repository
              </Button>
            )}
          </li>
        ));
      case "not_covered":
        return (
          <>
            {report.not_covered!.map((n) => (
              <li key={n.skill_id}>
                {linkByName(n.name)} <code className="small">{n.path}</code>
              </li>
            ))}
            {manage && !preview && (
              <li>
                <Button size="sm" onClick={() => void retire(report.not_covered!)}>
                  Retire these
                </Button>
              </li>
            )}
          </>
        );
      case "unchanged":
        return <li className="small">{report.unchanged!.map((u) => u.name).join(", ")}</li>;
      case "withdrawn":
        return report.withdrawn!.map((w) => (
          <li key={w.name}>
            {linkByName(w.name)} <span className="muted small">v{w.version}</span>
          </li>
        ));
      case "delivery_narrowed":
        return report.delivery_narrowed!.map((w) => (
          <li key={w.name}>
            {linkByName(w.name)} <span className="muted small">v{w.version} · no longer delivered: {w.withheld.join(", ")}</span>
          </li>
        ));
      case "excluded":
        return (
          <>
            {report.excluded!.map((e) => (
              <li key={e.path}>
                <code className="small">{e.path}</code> {e.suggested && <Badge>Suggested</Badge>}
              </li>
            ))}
            {!!report.ignored?.length && <li className="small muted">Ignored by .gitignore: {report.ignored.slice(0, 20).join(", ")}{report.ignored.length > 20 ? "…" : ""}</li>}
          </>
        );
      case "warnings":
        return report.warnings!.map((w, i) => (
          <li key={i}>
            {w.path && <code className="small">{w.path}</code>} {w.message}
          </li>
        ));
      default:
        return ((report as Record<string, unknown>)[key] as { name: string }[]).map((x) => <li key={x.name}>{linkByName(x.name)}</li>);
    }
  };
  return (
    <div className="sk-report">
      {report.message && <Callout tone="neutral">{report.message}</Callout>}
      <div className="sk-counts" role="list" aria-label="Summary">
        {counts.map((c) => (
          <div key={c.key} role="listitem" className="sk-count" data-zero={c.n === 0 || undefined}>
            <span className="sk-count-n">{c.n}</span>
            <span className="sk-count-label">{SKILL_REPORT_SECTION.find((s) => s.key === c.key)?.label ?? c.key}</span>
          </div>
        ))}
      </div>
      {!!report.collections?.length && (
        <Section title="Collections" level={3} count={report.collections.filter((c) => !c.not_imported && !c.removed).length}>
          <ul className="sk-plain-list">
            {report.collections.map((c) => (
              <li key={c.slug}>
                <strong>{c.name}</strong>{" "}
                <span className="muted small">
                  {c.slug} · {c.not_imported ? "not imported" : plural(c.skills, "skill")}
                  {c.created ? " · new" : ""}
                  {c.renamed_from ? ` · renamed from ${c.renamed_from}` : ""}
                  {c.removed ? " · removed upstream" : ""}
                </span>
                {c.connectors.length > 0 && <span className="small muted"> · needs {c.connectors.map((x) => x.name).join(", ")}</span>}{" "}
                {c.pending_change && <Badge tone="warning">Name, description or connectors changed: waits for review</Badge>}{" "}
                {manage && !preview && !c.removed && !c.not_imported && (
                  <Button size="sm" variant="ghost" onClick={() => setMapping({ slug: c.slug, name: c.name })}>
                    Give all {c.name} skills to…
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {SKILL_REPORT_SECTION.map((s) => {
        const rows = (report as Record<string, unknown>)[s.key];
        if (!Array.isArray(rows) || !rows.length) return null;
        const body = <ul className="sk-plain-list">{render(s.key)}</ul>;
        return s.key === "unchanged" || s.key === "excluded" || (s.key === "warnings" && rows.length > 5) ? (
          <Disclosure key={s.key} summary={`${s.label} (${rows.length})`}>
            {body}
          </Disclosure>
        ) : (
          <Section key={s.key} title={s.label} level={3} count={rows.length} description={s.hint}>
            {body}
          </Section>
        );
      })}
      {!!report.stamped?.length && (
        <Disclosure summary={`Shared guidance stamped into ${plural(report.stamped.length, "skill")}`}>
          <p className="small muted">The same core/ files and pointer blocks the repository's CI adds when it ships (sync_core.py).</p>
          <ul className="sk-plain-list">
            {report.stamped.map((s) => (
              <li key={s.name}>
                {s.name}: <span className="small muted">{s.files.join(", ")}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {mapping && <AssignDialog target={{ kind: "collection", slug: mapping.slug, name: mapping.name }} scopes={scopes} onClose={() => setMapping(null)} onDone={() => onChanged?.()} />}
    </div>
  );
}

// ---- Review › Skills --------------------------------------------------------------------------------------------------

/** Review › Skills: shared-guidance groups, versions, audience changes and problem reports. */
export function SkillReviewTab({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const result = useApi<SkillReview>("/skills/review");
  const [busy, setBusy] = useState<string | null>(null);
  const done = () => {
    result.reload();
    refreshCounts();
    onChanged?.();
  };
  async function act(key: string, fn: () => Promise<unknown>, ok: string, fail: string) {
    setBusy(key);
    try {
      await fn();
      toast.success(ok);
      done();
    } catch (err) {
      toast.error(err, { title: fail });
    } finally {
      setBusy(null);
    }
  }
  async function reject(v: { skill_id: string; name: string; version: number }) {
    const r = await confirm({ title: `Reject ${v.name} v${v.version}?`, confirmLabel: "Reject", tone: "danger", reason: { label: "Why", required: true, minLength: 3 } });
    if (!r) return;
    await act(`reject-${v.skill_id}`, () => api(`/skills/${v.skill_id}/versions/${v.version}/reject`, { method: "POST", body: { reason: r.reason } }), `Rejected ${v.name} v${v.version}`, "Couldn't reject it");
  }
  async function approveImport(g: { import_id: string; approvable: number }) {
    setBusy(`import-${g.import_id}`);
    try {
      const r = await api<{ approved: string[]; skipped: { name: string; reason: string }[] }>(`/skill-imports/${g.import_id}/approve`, { method: "POST", body: {} });
      toast.success(`Published ${plural(r.approved.length, "skill")}${r.skipped.length ? `; ${r.skipped.length} still need their own review` : ""}`);
      done();
    } catch (err) {
      toast.error(err, { title: "Couldn't approve them" });
    } finally {
      setBusy(null);
    }
  }
  return (
    <AsyncBlock result={result} label="Loading skill reviews" errorTitle="Couldn't load skill reviews" skeleton={<SkeletonRows count={4} />}>
      {(d) =>
        !d.versions.length && !d.audience_changes.length && !d.collection_changes.length && !d.feedback.length ? (
          <EmptyState variant="positive" icon="check-circle" title="No skills to review" description="New skill versions, moves that widen who gets a skill, and problem reports show up here." />
        ) : (
          <div className="sk-stack">
            {d.guidance_groups.map((g) => {
              const others = g.skills.filter((s) => !s.mine);
              return (
                <Card
                  key={g.guidance_hash}
                  as="section"
                  title={`Shared guidance update for ${plural(g.skills.length, "skill")}`}
                  titleLevel={2}
                  description="The only change in each of these is the same shared guidance the repository stamps into skills (core/ files and pointer blocks). Check one diff, then approve them together."
                  actions={
                    <Button
                      variant="primary"
                      size="sm"
                      loading={busy === g.guidance_hash}
                      disabledReason={!others.length ? "You proposed all of them: someone else must approve" : undefined}
                      onClick={() => void act(g.guidance_hash, () => api(`/skills/review/guidance/${g.guidance_hash}/approve`, { method: "POST", body: {} }), `Approved ${plural(others.length, "skill")}`, "Couldn't approve them")}
                    >
                      Approve all {others.length} (same change)
                    </Button>
                  }
                >
                  <p className="small">
                    {g.skills.map((s, i) => (
                      <span key={s.skill_id}>
                        {i > 0 && ", "}
                        <a href={href(`/skills/${s.skill_id}`, { tab: "versions", v: String(s.version) })}>{s.name}</a>
                        {s.mine && <span className="muted"> (yours, skipped)</span>}
                      </span>
                    ))}
                  </p>
                </Card>
              );
            })}
            {d.import_groups.map((g) => (
              <Card
                key={g.import_id}
                as="section"
                title={`${plural(g.approvable, "new version")} from ${g.source ?? "an upload"}${g.source_commit ? `@${shortSha(g.source_commit)}` : ""}`}
                titleLevel={2}
                description={`Approve every version from this import that has no high-risk flags and pre-approves no tools in one step; each is published and audited on its own.${g.versions > g.approvable ? ` The other ${g.versions - g.approvable} need their own review below.` : ""}`}
                actions={
                  <Button variant="primary" size="sm" loading={busy === `import-${g.import_id}`} onClick={() => void approveImport(g)}>
                    Approve {g.approvable}
                  </Button>
                }
              >
                <p className="small">
                  <a href={href(`/skills/imports/${g.import_id}`)}>Open the import report</a>
                </p>
              </Card>
            ))}
            {d.versions.length > 0 && (
              <Section title="Versions" count={d.versions.length}>
                <ul className="sk-review-list">
                  {d.versions.map((v) => {
                    const high = v.flags.filter((f) => f.high_risk);
                    const needsChecks = !!v.allowed_tools || high.length > 0;
                    return (
                      <li key={`${v.skill_id}-${v.version}`} className="sk-review-row">
                        <div className="sk-review-main">
                          <a href={href(`/skills/${v.skill_id}`, { tab: "versions", v: String(v.version) })} className="sk-review-title">
                            {v.name} v{v.version}
                          </a>
                          <span className="small muted">
                            {v.collection ?? "No collection"} · {v.base_version ? `changes v${v.base_version}` : "new skill"} · by {v.author ?? "an import"} · <RelativeTime date={v.created_at} />
                            {v.source ? ` · ${v.source}${v.source_commit ? `@${shortSha(v.source_commit)}` : ""}` : ""}
                          </span>
                          {v.summary && <span className="small">{v.summary}</span>}
                          <span className="sk-badges">
                            {flagGroups(high).map((g) => (
                              <Badge key={g.kind} tone="danger" title={g.where}>
                                {g.n > 1 ? `${skillFlagLabel(g.kind)} (${g.n})` : skillFlagLabel(g.kind)}
                              </Badge>
                            ))}
                            {v.has_scripts && !high.some((f) => f.kind === "scripts") && <Badge tone="warning">Scripts</Badge>}
                            {v.allowed_tools && <Badge tone="warning">Pre-approves tools</Badge>}
                            {v.guidance_hash && <Badge>Shared guidance only</Badge>}
                            {v.stale && <Badge tone="warning">Base changed</Badge>}
                            {v.mine && <Badge variant="outline">Yours</Badge>}
                          </span>
                        </div>
                        <div className="sk-review-actions">
                          {needsChecks || !v.can_approve ? (
                            <Button size="sm" href={href(`/skills/${v.skill_id}`, { tab: "versions", v: String(v.version) })} disabledReason={undefined}>
                              {v.can_approve ? "Review the diff" : "Open"}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="primary"
                              loading={busy === `approve-${v.skill_id}`}
                              onClick={() => void act(`approve-${v.skill_id}`, () => api(`/skills/${v.skill_id}/versions/${v.version}/approve`, { method: "POST", body: {} }), `Published ${v.name} v${v.version}`, "Couldn't approve it")}
                            >
                              Approve
                            </Button>
                          )}
                          {v.can_reject && (
                            <Button size="sm" variant="ghost" loading={busy === `reject-${v.skill_id}`} onClick={() => void reject(v)}>
                              Reject…
                            </Button>
                          )}
                          {v.mine && !v.can_approve && <span className="small muted">Someone else must approve this (you proposed it)</span>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Section>
            )}
            {d.audience_changes.length > 0 && (
              <Section title="Audience changes" count={d.audience_changes.length} description="Skills that moved to another plugin upstream. The move would also give them to more people, so a second person decides.">
                <ul className="sk-review-list">
                  {d.audience_changes.map((m) => (
                    <li key={m.skill_id} className="sk-review-row">
                      <div className="sk-review-main">
                        <a href={href(`/skills/${m.skill_id}`)} className="sk-review-title">
                          {m.name}
                        </a>
                        <span className="small muted">
                          {m.from ?? "No collection"} → {m.to}
                          {m.started_by ? ` · import by ${m.started_by}` : ""}
                        </span>
                        <span className="small">
                          Would also reach {plural(m.gains.people, "person", "people")}
                          {m.gains.audiences.length ? `: ${m.gains.audiences.join("; ")}` : ""}
                        </span>
                      </div>
                      <div className="sk-review-actions">
                        <Button size="sm" variant="primary" disabledReason={m.can_decide ? undefined : "Someone else must decide (your import moved it)"} onClick={() => void act(`move-${m.skill_id}`, () => api(`/skills/${m.skill_id}/audience-change`, { method: "POST", body: { decision: "confirm" } }), `Moved ${m.name}`, "Couldn't confirm the move")}>
                          Confirm move
                        </Button>
                        <Button size="sm" variant="ghost" disabledReason={m.can_decide ? undefined : "Someone else must decide"} onClick={() => void act(`move-${m.skill_id}`, () => api(`/skills/${m.skill_id}/audience-change`, { method: "POST", body: { decision: "decline" } }), `Kept ${m.name} where it was`, "Couldn't decline the move")}>
                          Decline
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {d.collection_changes.length > 0 && (
              <Section
                title="Collection changes"
                count={d.collection_changes.length}
                description="A plugin's name, description or connectors changed upstream. Claude and the web keep showing the published ones until a second person approves; people are told to connect what a collection lists, so check every new address."
              >
                <ul className="sk-review-list">
                  {d.collection_changes.map((c) => (
                    <li key={c.slug} className="sk-review-row">
                      <div className="sk-review-main">
                        <a href={href("/skills", { tab: "all", collection: c.slug })} className="sk-review-title">
                          {c.from.name}
                          {c.to.name !== c.from.name ? ` → ${c.to.name}` : ""}
                        </a>
                        <span className="small muted">
                          {c.slug}
                          {c.source ? ` · ${c.source}` : ""}
                          {c.started_by ? ` · import by ${c.started_by}` : ""} · <RelativeTime date={c.at} />
                        </span>
                        {c.to.description !== c.from.description && <span className="small">New description: {c.to.description || "(none)"}</span>}
                        <dl className="sk-change-connectors small">
                          <dt>Connectors now</dt>
                          <dd>{c.from.connectors.length ? c.from.connectors.map((x) => `${x.name}: ${x.url}`).join("; ") : "None"}</dd>
                          <dt>Proposed</dt>
                          <dd>{c.to.connectors.length ? c.to.connectors.map((x) => `${x.name}: ${x.url}`).join("; ") : "None"}</dd>
                        </dl>
                        {c.new_hosts.length > 0 && (
                          <span className="sk-badges">
                            {c.new_hosts.map((h) => (
                              <Badge key={h} tone="danger">
                                New host: {h}
                              </Badge>
                            ))}
                          </span>
                        )}
                      </div>
                      <div className="sk-review-actions">
                        <Button size="sm" variant="primary" loading={busy === `coll-${c.slug}`} disabledReason={c.can_decide ? undefined : "Someone else must decide (your import proposed it)"} onClick={() => void act(`coll-${c.slug}`, () => api(`/skill-collections/${c.slug}/change`, { method: "POST", body: { decision: "approve" } }), `Updated ${c.slug}`, "Couldn't approve the change")}>
                          Approve change
                        </Button>
                        <Button size="sm" variant="ghost" disabledReason={c.can_decide ? undefined : "Someone else must decide"} onClick={() => void act(`coll-${c.slug}`, () => api(`/skill-collections/${c.slug}/change`, { method: "POST", body: { decision: "decline" } }), `Kept ${c.slug} as it was`, "Couldn't decline the change")}>
                          Decline
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {d.feedback.length > 0 && (
              <Section title="Problem reports" count={d.feedback.length}>
                <FeedbackList items={d.feedback} manage onChanged={done} />
              </Section>
            )}
          </div>
        )
      }
    </AsyncBlock>
  );
}

/** Flags grouped by kind, for one badge each ("Contains scripts (26)"), with the first few places as a tooltip. */
function flagGroups(flags: { kind: string; path: string; line?: number }[]): { kind: string; n: number; where: string }[] {
  const m = new Map<string, { kind: string; n: number; places: string[] }>();
  for (const f of flags) {
    const g = m.get(f.kind) ?? { kind: f.kind, n: 0, places: [] };
    g.n++;
    if (g.places.length < 5) g.places.push(`${f.path}${f.line ? `:${f.line}` : ""}`);
    m.set(f.kind, g);
  }
  return [...m.values()].map((g) => ({ kind: g.kind, n: g.n, where: g.places.join("\n") + (g.n > g.places.length ? `\n…and ${g.n - g.places.length} more` : "") }));
}

/** Problem reports, with Resolve / Dismiss for people who manage the skill. */
export function FeedbackList({ items, manage, onChanged }: { items: SkillFeedback[]; manage: boolean; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  async function decide(f: SkillFeedback, state: "resolved" | "dismissed") {
    const r = await confirm({ title: state === "resolved" ? "Mark as resolved?" : "Dismiss this report?", confirmLabel: state === "resolved" ? "Resolve" : "Dismiss", reason: { label: "Note for the reporter", required: false, maxLength: 2000 } });
    if (!r) return;
    try {
      await api(`/skill-feedback/${f.id}`, { method: "PATCH", body: { state, resolution: r.reason || undefined } });
      toast.success(state === "resolved" ? "Resolved" : "Dismissed");
      onChanged();
    } catch (err) {
      toast.error(err, { title: "Couldn't update the report" });
    }
  }
  if (!items.length) return <EmptyState variant="compact" title="No problem reports" />;
  return (
    <ul className="sk-review-list">
      {items.map((f) => (
        <li key={f.id} className="sk-review-row">
          <div className="sk-review-main">
            <span className="sk-review-title">
              <a href={href(`/skills/${f.skill_id}`, { tab: "feedback" })}>{f.name}</a>
              {f.version ? ` v${f.version}` : ""}
            </span>
            <span className="small muted">
              {f.author ?? "Someone"} · {f.via === "mcp" ? "through Claude" : "on the web"} · <RelativeTime date={f.created_at} />
              {f.state !== "open" ? ` · ${f.state}${f.resolved_by ? ` by ${f.resolved_by}` : ""}` : ""}
            </span>
            <p className="sk-feedback-body">{f.body}</p>
            {f.resolution && <p className="small muted">Note: {f.resolution}</p>}
          </div>
          {manage && f.state === "open" && (
            <div className="sk-review-actions">
              <Button size="sm" onClick={() => void decide(f, "resolved")}>
                Resolve
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void decide(f, "dismissed")}>
                Dismiss
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---- Connect Claude › Skills -------------------------------------------------------------------------------------------

export function SkillsConnectCard({ skills, me }: { skills: SkillsConnect; me: Me }) {
  const hook = JSON.stringify(skills.hook_snippet, null, 2);
  const mine = useApi<MySkills>("/skills/mine");
  return (
    <Card as="section" className="sk-connect" title="Your skills in Claude" titleLevel={2} description="Skills your team publishes in Thaliyola reach Claude three ways. Each person gets only the skills their roles, teams and projects are given.">
      <DeliveryCallout delivery={skills} me={me} />
      {mine.data && <SkillConnectorsCard skills={mine.data.skills} />}
      <div className="sk-routes">
        <div className="sk-route">
          <h3 className="sk-subhead">Claude Desktop and claude.ai</h3>
          <p className="small">
            Nothing to install: once the Thaliyola connector is added, Claude sees your skills in the <code>list_skills</code> tool and loads one with <code>get_skill</code> when a task matches.
            Where your client lists connector commands, each skill is one too: <code>skill-&lt;name&gt;</code>.
          </p>
          <p className="small">
            For a skill you use often, <a href={href("/skills")}>Add to my Claude</a> on My skills: download it and upload it in Settings › Capabilities › Skills.
          </p>
        </div>
        <div className="sk-route">
          <h3 className="sk-subhead">Claude Code (the Code tab or the terminal)</h3>
          <p className="small">
            A small script copies your skills to <code>~/.claude/skills/thaliyola-&lt;name&gt;/</code> and removes ones you no longer have. It only ever touches its own <code>thaliyola-*</code> folders.
            Run this once; it saves your token to <code>~/.config/thaliyola/token</code> and offers to add a session-start hook:
          </p>
          <CodeBlock code={skills.sync_command} label="Set up the Claude Code sync" language="shell" wrap />
          <p className="small muted">
            Last sync check: <RelativeTime date={skills.last_sync_at} never="never" />
          </p>
          <Disclosure summary="Set it up by hand">
            <ol className="sk-steps small">
              <li>
                Save a token from <a href={href("/account", { section: "tokens" })}>Account › API tokens</a> to <code>~/.config/thaliyola/token</code> (only you may read it: <code>chmod 600</code>).
              </li>
              <li>
                Download the script to <code>~/.config/thaliyola/skills-sync.py</code>: <a href={skills.script_url}>{skills.script_url}</a>
              </li>
              <li>Run it whenever you want your skills brought up to date:</li>
            </ol>
            <CodeBlock code={skills.run_command} language="shell" wrap />
            <p className="small">To check at every session start, add this to <code>~/.claude/settings.json</code>:</p>
            <CodeBlock code={hook} language="json" label="SessionStart hook" />
            <p className="small muted">
              To remove everything it installed: <code>{skills.run_command} --remove-all</code> <CopyButton text={`${skills.run_command} --remove-all`} />
            </p>
          </Disclosure>
        </div>
      </div>
    </Card>
  );
}

// ---- Account › Skills for Claude -----------------------------------------------------------------------------------------

export function SkillPreferenceSection({ me }: { me: Me }) {
  const { updateMe } = useBoot();
  const toast = useToast();
  const [on, setOn] = useState(me.skills?.send_to_claude !== false);
  const [state, setState] = useState(me.skills?.state);
  const [status, setStatus] = useState<"saving" | "saved" | "error" | undefined>();
  const mode = me.skills?.delivery ?? "on";
  return (
    <Section title="Skills for Claude" description="Skills your team publishes reach Claude through the Thaliyola connector, downloads and the Claude Code sync.">
      <div className="sk-stack">
        <Switch
          label="Send my skills to Claude"
          description="Off: Claude gets no skills from Thaliyola for you, and the Claude Code sync removes the ones it installed. Your assignments stay."
          checked={on}
          status={status}
          onChange={async (next) => {
            setOn(next);
            setStatus("saving");
            try {
              const r = await api<{ send_to_claude: boolean; delivery: { state: typeof state } }>("/account/skills", { method: "PUT", body: { send_to_claude: next } });
              setState(r.delivery.state);
              setStatus("saved");
              updateMe({ skills: { delivery: mode, send_to_claude: next, state: r.delivery.state! } });
              toast.success(next ? "Your skills go to Claude again" : "Claude no longer gets your skills");
            } catch (err) {
              setOn(!next);
              setStatus("error");
              toast.error(err, { title: "Couldn't save that setting" });
            }
          }}
        />
        {state === "off" && <Callout tone="warning">Skills are switched off by an Administrator, for everyone. Your choice here is kept for when they're back.</Callout>}
        {state === "admins_only" && <Callout tone="neutral">Skills are being piloted by Administrators. Your choice here is kept for when the pilot ends.</Callout>}
        <p className="small muted">
          For everyone: {SKILL_DELIVERY_MODE[mode]}. <a href={href("/skills")}>See your skills</a>
        </p>
      </div>
    </Section>
  );
}

// ---- Project settings › Skills ----------------------------------------------------------------------------------------------

/** For Project admins: the project's own skills, and turning its Skills-folder articles into skills. */
export function ProjectSkillsCard({ scope }: { scope: ScopeInfo }) {
  const [converting, setConverting] = useState(false);
  return (
    <Card as="section" title="Skills for Claude" titleLevel={2} description={`Skills owned by ${scope.name}: only people who can read it see them, and they go to people in it or the projects under it.`}>
      <div className="sk-actions">
        <Button href={href("/skills", { tab: "all", project: scope.slug })} icon="sparkle">
          Project skills
        </Button>
        <Button variant="ghost" onClick={() => setConverting(true)}>
          Convert articles to skills…
        </Button>
      </div>
      {converting && <ConvertArticlesDialog scope={scope} onClose={() => setConverting(false)} />}
    </Card>
  );
}

function ConvertArticlesDialog({ scope, onClose }: { scope: ScopeInfo; onClose: () => void }) {
  const toast = useToast();
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const { scopes } = useBoot();
  async function run(dry: boolean) {
    setBusy(true);
    try {
      const r = await api<ImportReport>(`/projects/${scope.slug}/skills/convert-articles`, { method: "POST", body: { dry_run: dry } });
      if (dry) setReport(r);
      else {
        toast.success("Converted: the skills wait for review");
        refreshCounts();
        navigate("/skills", { tab: "all", project: scope.slug });
      }
    } catch (err) {
      toast.error(err, { title: "Couldn't convert the articles" });
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`Convert ${scope.name} articles to skills`}
      description="Runbooks in the Skills folder tagged claude-skill become skills owned by this project. They wait for review like any new skill."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy && !!report} loadingText="Converting" disabledReason={!report ? "Wait for the preview" : !(report.added?.length || report.changed?.length) ? "Nothing to convert" : undefined} onClick={() => void run(false)}>
            Convert
          </Button>
        </>
      }
    >
      {report ? <ImportReportView report={report} scopes={scopes} preview /> : <SkeletonText lines={5} />}
    </Dialog>
  );
}

export { SkillBadges, ConnectorsLine };

import { useState } from "react";
import { api, type Me, type ScopeInfo } from "../api";
import { HBars, StatTile } from "../components/charts";
import { plural, SKILL_STATUS, SKILL_USAGE_CHANNEL, SKILL_VERSION_STATE, skillFlagLabel } from "../components/labels";
import {
  approveBlockReason,
  bytes,
  downloadFrom,
  fileTree,
  hasInvisible,
  shortSha,
  showInvisible,
  skillStatusKey,
  sortFlags,
  versionLine,
  type Assignment,
  type FileDiff,
  type SkillDetail,
  type SkillFeedback,
  type SkillFlag,
  type SkillVersionDetail,
} from "../components/skill-utils";
import { Markdown } from "../components/ui";
import { refreshCounts, useApi, useQueryState } from "../hooks";
import { href, type Route } from "../router";
import { AddToClaudeDialog, AssignDialog, ConnectorsLine, DeliveryCallout, FeedbackList, ReportProblemDialog, SkillBadges, StatusBadge } from "./skills";
import {
  AsyncBlock,
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  CodeBlock,
  CopyButton,
  DataTable,
  Dialog,
  DiffView,
  Disclosure,
  EmptyState,
  Facts,
  Field,
  Page,
  PageHeader,
  RelativeTime,
  Section,
  SegmentedControl,
  SkeletonRows,
  SkeletonText,
  Tabs,
  Textarea,
  TextInput,
  useConfirm,
  useToast,
  type MenuItemSpec,
} from "../components/kit";

/**
 * One skill (#/skills/:id). Assignees see the published SKILL.md, its delivered files, why they have it and their own
 * reports. People who manage or review it also see every version with raw-text diffs and flags, approve or reject
 * (never their own), roll back, assign it, and see who uses it.
 */

type TabId = "overview" | "files" | "versions" | "assignments" | "usage" | "feedback";

export function SkillDetailPage({ id, route, me, scopes }: { id: string; route: Route; me: Me; scopes: ScopeInfo[] }) {
  const result = useApi<SkillDetail>(`/skills/${encodeURIComponent(id)}`);
  const [q, setQ] = useQueryState(route, { tab: "overview" });
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [editing, setEditing] = useState(false);
  const d = result.data;
  const manager = d?.view === "manager";
  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files", count: d?.current?.files.length },
    { id: "versions", label: "Versions", hidden: !manager, count: d?.versions?.filter((v) => v.state === "pending").length || undefined, countTone: "accent" as const },
    { id: "assignments", label: "Who gets it", hidden: !manager },
    { id: "usage", label: "Usage", hidden: !d?.can.usage },
    { id: "feedback", label: manager ? "Problem reports" : "Your reports" },
  ];
  const visibleIds = tabs.filter((t) => !t.hidden).map((t) => t.id);
  const tab = (visibleIds.includes(q.tab!) ? q.tab : "overview") as TabId;

  async function patch(body: Record<string, unknown>, ok: string) {
    try {
      await api(`/skills/${id}`, { method: "PATCH", body });
      toast.success(ok);
      result.reload();
    } catch (err) {
      toast.error(err, { title: "Couldn't change the skill" });
    }
  }
  async function post(path: string, ok: string, body: unknown = {}) {
    try {
      await api(`/skills/${id}${path}`, { method: "POST", body });
      toast.success(ok);
      result.reload();
      refreshCounts();
    } catch (err) {
      toast.error(err, { title: "That didn't work" });
    }
  }

  const menu: MenuItemSpec[] = [];
  if (d && manager && d.can.manage) {
    if (d.status === "active") menu.push({ id: "pause", label: "Pause delivery", icon: "pause", onSelect: () => void patch({ status: "disabled" }, `${d.name} is paused`) });
    else menu.push({ id: "resume", label: "Deliver again", icon: "play", onSelect: () => void patch({ status: "active" }, `${d.name} is delivered again`) });
    if (d.status !== "archived") menu.push({ id: "archive", label: "Archive", icon: "trash", onSelect: () => void patch({ status: "archived" }, `${d.name} is archived`) });
    menu.push({ id: "prompt", label: "Offer as a slash command", checked: !!d.as_prompt, onSelect: () => void patch({ as_prompt: !d.as_prompt }, d.as_prompt ? "No longer offered as a slash command" : "Offered as a slash command") });
    if (d.source && !d.source.detached)
      menu.push({
        id: "detach",
        label: "Detach from source…",
        icon: "git-branch",
        onSelect: async () => {
          const ok = await confirm({ title: `Detach ${d.name}?`, body: `Imports from ${d.source!.name} stop changing it, so you can edit it here. Reattach to follow the repository again.`, confirmLabel: "Detach" });
          if (ok) void post("/detach", `${d.name} is detached`);
        },
      });
    if (d.source?.detached) menu.push({ id: "reattach", label: "Reattach to source", icon: "git-branch", onSelect: () => void post("/reattach", `${d.name} follows ${d.source!.name} again`) });
  }
  if (d?.current && manager)
    menu.push({ id: "review-zip", label: "Download a review copy", icon: "download", hint: "All files, including reviewer-only ones", onSelect: () => void downloadFrom(`/skills/${id}/versions/${d.current!.version}/archive`, `${d.name}-review.zip`).catch((err) => toast.error(err, { title: "Couldn't download it" })) });

  return (
    <Page width="content">
      <PageHeader
        title={d?.name ?? "Skill"}
        crumbs={[{ label: "Skills", href: href("/skills", manager ? { tab: "all" } : {}) }]}
        nav="skills"
        status={d ? <StatusBadge status={skillStatusKey(d.status, !!d.current)} /> : undefined}
        description={d?.current?.description}
        meta={
          d ? (
            <span className="sk-head-meta">
              <span>{d.current ? versionLine(d.current.version, d.current.upstream_version).replace(/^v(\d+)/, "v$1 in Thaliyola") : "Not published yet"}</span>
              {d.source?.repository && (
                <span>
                  {d.source.repository}
                  {d.current?.source_commit ? `@${shortSha(d.current.source_commit)}` : ""}
                </span>
              )}
              {d.collection && <span>{d.collection.name}</span>}
              {d.owner_project && (
                <Badge icon="lock" title="Only people who can read this project see the skill">
                  {d.owner_project.name}
                </Badge>
              )}
              {d.held_at_version && <Badge tone="warning" icon="pause">Held at v{d.held_at_version}</Badge>}
              {d.source?.detached && <Badge>Detached from source</Badge>}
              {d.pending_move && <Badge tone="warning">Move to {d.pending_move.collection.name} waits for review</Badge>}
            </span>
          ) : undefined
        }
        actions={
          d ? (
            <>
              {d.can.report && (
                <Button icon="alert" onClick={() => setReporting(true)}>
                  Report a problem
                </Button>
              )}
              {d.can.edit && d.current && (
                <Button icon="pencil" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              )}
            </>
          ) : undefined
        }
        primary={
          d?.assigned && d.current ? (
            <Button variant="primary" icon="download" disabledReason={d.delivery.state === "on" ? undefined : (d.delivery.message ?? "Skills aren't being sent to Claude")} onClick={() => setAdding(true)}>
              Add to my Claude
            </Button>
          ) : undefined
        }
        menu={menu.length ? menu : undefined}
        tabs={<Tabs label="Skill" value={tab} items={tabs.map((t) => ({ ...t, href: href(`/skills/${id}`, t.id === "overview" ? {} : { tab: t.id }) }))} />}
      />
      <AsyncBlock result={result} label="Loading the skill" errorTitle="Couldn't load the skill" skeleton={<SkeletonText lines={10} />}>
        {(s) => (
          <div className="sk-stack">
            {s.assigned && <DeliveryCallout delivery={s.delivery} me={me} />}
            {s.held_at_version && s.can.review && (
              <Callout tone="warning" title={`Held at v${s.held_at_version}`} actions={<Button size="sm" onClick={() => void post("/release-hold", "Released: imports may propose new versions again")}>Release hold</Button>}>
                <p>It was rolled back, so imports don't propose new versions until you release the hold.</p>
              </Callout>
            )}
            {s.pending_move && (
              <Callout
                tone="warning"
                title={`Moving to ${s.pending_move.collection.name} would also give it to ${plural(s.pending_move.gains.people, "person", "people")}`}
                actions={
                  s.pending_move.can_decide ? (
                    <>
                      <Button size="sm" onClick={() => void post("/audience-change", "Moved", { decision: "confirm" })}>
                        Confirm move
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void post("/audience-change", "Kept where it was", { decision: "decline" })}>
                        Decline
                      </Button>
                    </>
                  ) : undefined
                }
              >
                {s.pending_move.gains.audiences.length > 0 && <p className="small">{s.pending_move.gains.audiences.join("; ")}</p>}
              </Callout>
            )}
            {s.status_reason && s.status !== "active" && <p className="small muted">{s.status_reason}</p>}
            {tab === "overview" ? (
              <Overview s={s} />
            ) : tab === "files" ? (
              <FilesTab s={s} />
            ) : tab === "versions" ? (
              <VersionsTab s={s} selected={q.v ? Number(q.v) : undefined} onSelect={(v) => setQ({ v: v ? String(v) : undefined })} onChanged={result.reload} />
            ) : tab === "assignments" ? (
              <AssignmentsTab s={s} scopes={scopes} />
            ) : tab === "usage" ? (
              <UsageTab id={s.id} />
            ) : (
              <FeedbackTab s={s} />
            )}
          </div>
        )}
      </AsyncBlock>
      {adding && d?.current && (
        <AddToClaudeDialog skill={{ id: d.id, name: d.name, version: d.current.version, requires_connectors: d.requires_connectors, has_scripts: d.current.has_scripts }} onClose={() => setAdding(false)} />
      )}
      {reporting && d && <ReportProblemDialog skill={{ id: d.id, name: d.name, version: d.current?.version }} onClose={() => setReporting(false)} onDone={result.reload} />}
      {editing && d?.current && <ProposeDialog s={d} onClose={() => setEditing(false)} onDone={() => (result.reload(), setQ({ tab: "versions", v: undefined }))} />}
    </Page>
  );
}
SkillDetailPage.keepMountedOnQuery = true;

// ---- Overview ---------------------------------------------------------------------------------------------------------

/** The body after the front matter. */
const bodyOf = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

const flagRow = (f: SkillFlag, i: number) => (
  <li key={i}>
    <Badge tone={f.high_risk ? "danger" : "warning"}>{skillFlagLabel(f.kind)}</Badge>{" "}
    <code className="small">
      {f.path}
      {f.line ? `:${f.line}` : ""}
    </code>{" "}
    <span className="small">{f.message}</span>
  </li>
);

export function FlagList({ flags }: { flags: SkillFlag[] }) {
  if (!flags.length) return null;
  const sorted = sortFlags(flags);
  const high = sorted.filter((f) => f.high_risk).length;
  return (
    <Callout tone={high ? "danger" : "warning"} title={high ? `${plural(high, "high-risk flag")} for reviewers` : `${plural(flags.length, "flag")} for reviewers`}>
      <ul className="sk-flags">{sorted.slice(0, 10).map(flagRow)}</ul>
      {sorted.length > 10 && (
        <Disclosure summary={`${sorted.length - 10} more`}>
          <ul className="sk-flags">{sorted.slice(10, 200).map(flagRow)}</ul>
        </Disclosure>
      )}
    </Callout>
  );
}

export function Overview({ s }: { s: SkillDetail }) {
  const [mode, setMode] = useState<"rendered" | "source">(s.view === "manager" ? "source" : "rendered");
  const c = s.current;
  if (!c) return s.view === "manager" ? <FirstReview s={s} /> : <EmptyState icon="clock" title="Not published yet" description="Its first version waits for review." />;
  const fm = Object.entries(c.frontmatter ?? {}).filter(([k]) => k !== "description");
  const md = c.skill_md ?? "";
  return (
    <div className="sk-stack">
      {s.why.length > 0 && (
        <Card padding="sm" title="Why you have it">
          <ul className="sk-plain-list small">
            {s.why.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Card>
      )}
      <SkillBadges s={{ has_scripts: c.has_scripts, allowed_tools: c.allowed_tools }} />
      <ConnectorsLine connectors={s.requires_connectors} />
      {c.allowed_tools && <p className="small">Pre-approves tools: <code>{c.allowed_tools}</code></p>}
      {c.flags && <FlagList flags={c.flags} />}
      {fm.length > 0 && (
        <Card padding="sm" title="Front matter">
          <Facts items={fm.map(([k, v]) => ({ term: k, value: <code className="sk-break small">{typeof v === "string" ? v : JSON.stringify(v)}</code> }))} />
        </Card>
      )}
      <Section
        title="SKILL.md"
        actions={
          <SegmentedControl
            label="Show"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: "rendered", label: "Rendered" },
              { value: "source", label: "Source" },
            ]}
          />
        }
      >
        {hasInvisible(md) && <Callout tone="danger">This file contains invisible characters. The Source view shows them as ⟨U+…⟩.</Callout>}
        {mode === "source" ? <CodeBlock code={showInvisible(md)} language="markdown" wrap maxHeight={640} label="SKILL.md" /> : <div className="sk-rendered"><Markdown text={bodyOf(md)} /></div>}
      </Section>
    </div>
  );
}

/**
 * A new skill's page for the people who manage it: its first version waits for review, so say who reviews it (never
 * its author, unless self-approval is on), then who gets it, as numbered next steps.
 */
export function FirstReview({ s }: { s: SkillDetail }) {
  const pending = s.versions?.find((v) => v.state === "pending");
  if (!pending) return <EmptyState icon="clock" title="Not published yet" description="No version waits for review: propose one to publish it." />;
  const reviewers = s.owner_project
    ? `Someone with Review skills who can read ${s.owner_project.name}, or a Project admin of ${s.owner_project.name}`
    : "Someone with Review skills (Skills managers and Administrators)";
  const versionHref = href(`/skills/${s.id}`, { tab: "versions", v: String(pending.version) });
  const link = typeof window === "undefined" ? versionHref : `${window.location.origin}${window.location.pathname}${versionHref}`;
  return (
    <Card as="section" title={`Version ${pending.version} waits for review`} titleLevel={2} description="Nobody gets a skill until a second person approves it. Then it reaches the people you give it to.">
      <ol className="sk-next">
        <li data-state="done">
          <div className="sk-next-body">
            <span className="sk-next-title">Written</span>
            <p className="small muted">
              {pending.mine ? "You" : (pending.author ?? "Someone")} proposed version {pending.version}
              {pending.high_risk_flags ? `, with ${plural(pending.high_risk_flags, "high-risk flag")} for the reviewer` : ""}.
            </p>
          </div>
        </li>
        <li>
          <div className="sk-next-body">
            <span className="sk-next-title">{s.can.approve ? "Review it" : "Ask a reviewer"}</span>
            <p className="small">
              {s.can.approve
                ? "You can approve it: check its files and flags first."
                : `${reviewers}${pending.mine ? ", other than you," : ""} approves it in Review › Skills. Send them the link.`}
            </p>
            <div className="sk-actions">
              <Button size="sm" variant={s.can.approve ? "primary" : "secondary"} href={versionHref}>
                {s.can.approve ? `Review version ${pending.version}` : `Open version ${pending.version}`}
              </Button>
              {!s.can.approve && <CopyButton text={link} label="Copy the link" />}
            </div>
          </div>
        </li>
        <li>
          <div className="sk-next-body">
            <span className="sk-next-title">Give it to people</span>
            <p className="small">
              Everyone, a role, a team or a project{s.owner_project ? ` (inside ${s.owner_project.name})` : ""}. You can choose now: they get it once it's published.
            </p>
            {s.can.manage && (
              <div className="sk-actions">
                <Button size="sm" icon="team" href={href(`/skills/${s.id}`, { tab: "assignments" })}>
                  Choose who gets it
                </Button>
              </div>
            )}
          </div>
        </li>
        <li>
          <div className="sk-next-body">
            <span className="sk-next-title">Claude uses it</span>
            <p className="small muted">Through the Thaliyola connector, Add to my Claude and the Claude Code sync.</p>
          </div>
        </li>
      </ol>
    </Card>
  );
}

// ---- Files ---------------------------------------------------------------------------------------------------------------

function FilesTab({ s }: { s: SkillDetail }) {
  const files = s.current?.files ?? [];
  const [open, setOpen] = useState<string>("SKILL.md");
  const toast = useToast();
  const file = files.find((f) => f.path === open);
  const content = useApi<{ path: string; size: number; kind: string; text: string | null }>(file && file.kind === "text" ? `/skills/${s.id}/file?path=${encodeURIComponent(file.path)}` : null);
  if (!files.length) return <EmptyState icon="doc" title="No files" description="It has no published version yet." />;
  return (
    <div className="sk-files">
      <nav className="sk-tree" aria-label="Files">
        <ul>
          {fileTree(files).map((n) =>
            n.kind === "folder" ? (
              <li key={`d:${n.path}`} className="sk-tree-folder" style={{ paddingInlineStart: `calc(${n.depth} * var(--space-3))` }}>
                {n.name}/
              </li>
            ) : (
              <li key={n.file.path} style={{ paddingInlineStart: `calc(${n.depth} * var(--space-3))` }}>
                <button type="button" className="sk-tree-file" aria-current={open === n.file.path ? "true" : undefined} onClick={() => setOpen(n.file.path)}>
                  {n.name}
                </button>
                <span className="sk-tree-tags">
                  {n.file.script && <Badge tone="warning">Script</Badge>}
                  {n.file.managed && <Badge title="Stamped from the repository's core/ folder">Shared guidance</Badge>}
                  {!n.file.deliver && <Badge variant="outline">Reviewers only</Badge>}
                </span>
              </li>
            ),
          )}
        </ul>
      </nav>
      <div className="sk-viewer">
        {file ? (
          file.kind === "binary" ? (
            <EmptyState
              variant="compact"
              icon="doc"
              title={`${file.path} (${bytes(file.size)})`}
              description="A binary file: download it to look inside."
              primary={
                <Button icon="download" onClick={() => void downloadFrom(`/skills/${s.id}/file?path=${encodeURIComponent(file.path)}&raw=1`, file.path.split("/").pop() ?? "file").catch((err) => toast.error(err, { title: "Couldn't download it" }))}>
                  Download
                </Button>
              }
            />
          ) : (
            <AsyncBlock result={content} label="Loading the file" errorTitle="Couldn't load the file" skeleton={<SkeletonText lines={8} />}>
              {(f) => (
                <>
                  {f.text && hasInvisible(f.text) && <Callout tone="danger">Invisible characters are shown as ⟨U+…⟩.</Callout>}
                  <CodeBlock code={showInvisible(f.text ?? "")} label={`${f.path} · ${bytes(f.size)}`} wrap maxHeight={640} language={/\.(md|markdown)$/i.test(f.path) ? "markdown" : /\.json$/i.test(f.path) ? "json" : /\.ya?ml$/i.test(f.path) ? "yaml" : /\.sh$/i.test(f.path) ? "shell" : "text"} />
                </>
              )}
            </AsyncBlock>
          )
        ) : (
          <EmptyState variant="compact" title="Choose a file" />
        )}
      </div>
    </div>
  );
}

// ---- Versions ----------------------------------------------------------------------------------------------------------

function VersionsTab({ s, selected, onSelect, onChanged }: { s: SkillDetail; selected?: number; onSelect: (v?: number) => void; onChanged: () => void }) {
  const versions = s.versions ?? [];
  const current = selected ?? versions.find((v) => v.state === "pending")?.version;
  return (
    <div className="sk-stack">
      {s.source && !s.source.detached && s.source.edit_hint && (
        <Callout tone="neutral">
          <p>
            {s.source.edit_hint}. Imports from {s.source.name} propose new versions here; to change it in Thaliyola instead, detach it (⋯ menu).
          </p>
        </Callout>
      )}
      <DataTable
        caption="Versions"
        density="compact"
        rows={versions}
        getRowId={(v) => String(v.version)}
        rowHref={(v) => href(`/skills/${s.id}`, { tab: "versions", v: String(v.version) })}
        columns={[
          { key: "v", header: "Version", primary: true, cell: (v) => <span aria-current={v.version === current ? "true" : undefined}>v{v.version}{v.upstream_version ? ` · ${v.upstream_version}` : ""}</span> },
          {
            key: "state",
            header: "State",
            cell: (v) => (
              <span className="sk-badges">
                {/* What Claude gets now is the live version; earlier published ones can be restored from their panel. */}
                {v.state === "published" && v.version === s.current?.version ? (
                  <Badge tone="success" icon="check" title="The version Claude gets now">
                    Live
                  </Badge>
                ) : v.state === "published" ? (
                  <Badge title={v.rollback ? "Published earlier; open it to roll back to it" : "Published earlier"}>Earlier</Badge>
                ) : (
                  <Badge tone={SKILL_VERSION_STATE[v.state]?.tone ?? "neutral"}>{SKILL_VERSION_STATE[v.state]?.label ?? v.state}</Badge>
                )}
                {v.high_risk_flags > 0 && <Badge tone="danger">{plural(v.high_risk_flags, "high-risk flag")}</Badge>}
                {v.stale && <Badge tone="warning">Base changed</Badge>}
                {v.restored_from && <Badge>Copy of v{v.restored_from}</Badge>}
              </span>
            ),
          },
          { key: "by", header: "By", cell: (v) => `${v.author ?? "An import"}${v.mine ? " (you)" : ""}`, hideBelow: 760 },
          { key: "commit", header: "Commit", cell: (v) => (v.source_commit ? <code>{shortSha(v.source_commit)}</code> : null), hideBelow: 1100 },
          { key: "when", header: "Proposed", cell: (v) => <RelativeTime date={v.created_at} />, hideBelow: 760 },
          {
            key: "decided",
            header: "Decided",
            cell: (v) =>
              v.decided_at ? (
                <span className="small">
                  {v.reviewer ?? (v.direct ? "Published directly" : "")} <RelativeTime date={v.decided_at} />
                  {(v.decided_via === "mcp" || v.decided_via === "token") && (
                    <>
                      {" "}
                      <Badge variant="outline" icon="sparkle" title="Decided by asking Claude">
                        via Claude
                      </Badge>
                    </>
                  )}
                </span>
              ) : null,
            hideBelow: 1100,
          },
        ]}
        empty={<EmptyState variant="compact" title="No versions" />}
      />
      {current ? <VersionPanel key={current} skill={s} version={current} onChanged={onChanged} onClose={() => onSelect(undefined)} /> : null}
    </div>
  );
}

/** One file's raw-text diff, folded unless it's SKILL.md or one of only a few changes. */
function FileDiffView({ d, open }: { d: FileDiff; open: boolean }) {
  const invisible = hasInvisible(d.after ?? "") || hasInvisible(d.before ?? "");
  return (
    <Disclosure
      className="sk-diff"
      defaultOpen={open || invisible}
      summary={
        <span className="sk-diff-head">
          <code className="sk-break">{d.path}</code>
          <Badge tone={d.change === "added" ? "success" : d.change === "removed" ? "danger" : "accent"}>{d.change === "added" ? "Added" : d.change === "removed" ? "Removed" : "Changed"}</Badge>
          {d.managed && <Badge>Shared guidance</Badge>}
          {!d.deliver && <Badge variant="outline">Reviewers only</Badge>}
          {invisible && <Badge tone="danger">Invisible characters</Badge>}
        </span>
      }
    >
      {d.kind === "binary" || (d.before == null && d.after == null) ? (
        <p className="small muted">{d.kind === "binary" ? "Binary file" : "Too large to show here; download the review copy."}</p>
      ) : (
        <DiffView before={showInvisible(d.before ?? "")} after={showInvisible(d.after ?? "")} mode="source" showModeToggle={false} markdown={false} isNew={d.change === "added"} />
      )}
    </Disclosure>
  );
}

function VersionPanel({ skill, version, onChanged, onClose }: { skill: SkillDetail; version: number; onChanged: () => void; onClose: () => void }) {
  const result = useApi<SkillVersionDetail>(`/skills/${skill.id}/versions/${version}`);
  const toast = useToast();
  const confirm = useConfirm();
  const [approving, setApproving] = useState(false);
  const [against, setAgainst] = useState<"base" | "current">("base");
  const done = () => {
    result.reload();
    onChanged();
    refreshCounts();
  };
  async function reject(v: SkillVersionDetail) {
    const r = await confirm({ title: `Reject v${v.version} of ${skill.name}?`, body: "Its author is told why. An import won't propose the same content again unless forced.", confirmLabel: "Reject", tone: "danger", reason: { label: "Why", required: true, minLength: 3 } });
    if (!r) return;
    try {
      await api(`/skills/${skill.id}/versions/${v.version}/reject`, { method: "POST", body: { reason: r.reason } });
      toast.success(`Rejected v${v.version}`);
      done();
    } catch (err) {
      toast.error(err, { title: "Couldn't reject it" });
    }
  }
  async function rollback(v: SkillVersionDetail) {
    const ok = await confirm({
      title: `Roll ${skill.name} back to v${v.version}?`,
      body: "Publishes a new version with the same files at once, and holds the skill: imports won't propose new versions until a reviewer releases the hold.",
      confirmLabel: "Roll back",
    });
    if (!ok) return;
    try {
      const r = await api<{ version: number }>(`/skills/${skill.id}/rollback`, { method: "POST", body: { version: v.version } });
      toast.success(`Published v${r.version}, a copy of v${v.version}`);
      done();
    } catch (err) {
      toast.error(err, { title: "Couldn't roll back" });
    }
  }
  return (
    <AsyncBlock result={result} label="Loading the version" errorTitle="Couldn't load the version" skeleton={<SkeletonRows count={4} />}>
      {(v) => {
        const diff = against === "current" && v.diff_against_current ? v.diff_against_current : v.diff;
        return (
          <Card
            as="section"
            className="sk-version"
            title={`Version ${v.version}`}
            titleLevel={2}
            description={
              <span className="small">
                {SKILL_VERSION_STATE[v.state]?.label ?? v.state} · {v.author ?? "an import"}
                {v.mine ? " (you)" : ""} · <RelativeTime date={v.created_at} />
                {v.base_version ? ` · changes v${v.base_version}` : " · first version"}
                {v.source_commit ? ` · commit ${shortSha(v.source_commit)}` : ""}
                {v.upstream_version ? ` · ${v.upstream_version} upstream` : ""}
              </span>
            }
            actions={
              <Button size="sm" variant="ghost" icon="x" onClick={onClose}>
                Close
              </Button>
            }
          >
            <div className="sk-stack">
              {v.summary && <p>{v.summary}</p>}
              {v.reason && <p className="small muted">{v.state === "rejected" ? "Rejected: " : "Note: "}{v.reason}</p>}
              {v.stale && <Callout tone="warning">The published version changed since this was proposed; reject it and propose again.</Callout>}
              {v.allowed_tools && (
                <Callout tone="warning" title="Pre-approves tools">
                  <p>
                    Claude Code runs these without asking while the skill is active: <code>{v.allowed_tools}</code>
                  </p>
                </Callout>
              )}
              <FlagList flags={v.flags} />
              {v.state === "pending" && (
                <div className="sk-actions">
                  {v.can.approve ? (
                    <Button variant="primary" icon="check" disabledReason={v.stale ? "The published version changed since" : undefined} onClick={() => setApproving(true)}>
                      Approve and publish
                    </Button>
                  ) : approveBlockReason(v) ? (
                    <span className="small muted">{approveBlockReason(v)}</span>
                  ) : null}
                  {v.can.reject && (
                    <Button variant="ghost" onClick={() => void reject(v)}>
                      Reject…
                    </Button>
                  )}
                </div>
              )}
              {v.can.rollback && (
                <div className="sk-actions">
                  <Button icon="undo" onClick={() => void rollback(v)}>
                    Roll back to this version
                  </Button>
                </div>
              )}
              {v.diff_against_current && (
                <SegmentedControl
                  label="Compare with"
                  labelVisible
                  size="sm"
                  value={against}
                  onChange={setAgainst}
                  options={[
                    { value: "base", label: v.base_version ? `v${v.base_version} (its base)` : "Nothing (new)" },
                    { value: "current", label: "The published version" },
                  ]}
                />
              )}
              {diff.length ? [...diff].sort((a, b) => Number(b.path === "SKILL.md") - Number(a.path === "SKILL.md")).map((x) => <FileDiffView key={x.path} d={x} open={x.path === "SKILL.md" || diff.length <= 3} />) : <p className="small muted">No file changes against {against === "current" ? "the published version" : "its base"}.</p>}
              <p className="small muted">{plural(v.files.length, "file")}: {v.files.map((f) => f.path).join(", ")}</p>
            </div>
            {approving && <ApproveDialog skill={skill} v={v} onClose={() => setApproving(false)} onDone={done} />}
          </Card>
        );
      }}
    </AsyncBlock>
  );
}

function ApproveDialog({ skill, v, onClose, onDone }: { skill: SkillDetail; v: SkillVersionDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [tools, setTools] = useState(false);
  const [flags, setFlags] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const missing = (v.can.needs_checked_tools && !tools) || (v.can.needs_checked_flags && !flags);
  async function approve() {
    setBusy(true);
    try {
      await api(`/skills/${skill.id}/versions/${v.version}/approve`, { method: "POST", body: { note: note || undefined, checked_tools: tools || undefined, checked_flags: flags || undefined } });
      toast.success(`Published ${skill.name} v${v.version}`);
      onDone();
      onClose();
    } catch (err) {
      toast.error(err, { title: "Couldn't approve it" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Publish ${skill.name} v${v.version}?`}
      description="Everyone it's assigned to gets it in Claude at once. Skills are instructions Claude follows: check the raw text, not just the rendered page."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} loadingText="Publishing" disabledReason={missing ? "Tick the checks first" : undefined} onClick={() => void approve()}>
            Publish
          </Button>
        </>
      }
    >
      <div className="sk-form">
        {v.can.needs_checked_tools && <Checkbox label="I checked the pre-approved tools" description={v.allowed_tools ?? undefined} checked={tools} onChange={(e) => setTools(e.target.checked)} />}
        {v.can.needs_checked_flags && <Checkbox label="I checked the flagged lines" description="Every high-risk flag listed on this version: new scripts, hidden text, new external addresses or Thaliyola admin tools." checked={flags} onChange={(e) => setFlags(e.target.checked)} />}
        <Field label="Note" optional>
          <TextInput value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

function ProposeDialog({ s, onClose, onDone }: { s: SkillDetail; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [md, setMd] = useState(s.current?.skill_md ?? "");
  const [summary, setSummary] = useState("");
  const [askReview, setAskReview] = useState(false);
  const [busy, setBusy] = useState(false);
  // A Project admin's edit of their project's own skill publishes at once (unless high-risk, or they ask for a review).
  const publishes = !!s.can.publish_directly;
  const willPublish = publishes && !askReview;
  async function save() {
    if (!summary.trim()) return toast.error("Say what changed", { title: "Missing summary" });
    setBusy(true);
    try {
      const r = await api<{ version: number; published?: boolean; message?: string }>(`/skills/${s.id}/versions`, {
        method: "POST",
        body: { skill_md: md, summary: summary.trim(), ...(publishes && askReview ? { request_review: true } : {}) },
      });
      if (r.published) toast.success(`v${r.version} is published`);
      else toast.success(`v${r.version} waits for someone else to review it`, r.message ? { description: r.message } : undefined);
      refreshCounts();
      onDone();
      onClose();
    } catch (err) {
      toast.error(err, { title: "Couldn't propose the version" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`Edit ${s.name}`}
      description={
        publishes
          ? "Saves a new version. Its other files stay as they are. As this project's admin your version publishes at once, unless it has high-risk content."
          : "Proposes a new version. Its other files stay as they are. Someone else reviews it before anyone gets it."
      }
      footer={
        <>
          {publishes && <Checkbox label="Ask someone to review it first" checked={askReview} onChange={(e) => setAskReview(e.target.checked)} />}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} loadingText="Saving" onClick={() => void save()}>
            {willPublish ? "Publish" : "Propose for review"}
          </Button>
        </>
      }
    >
      <div className="sk-form">
        <Field label="SKILL.md">
          <Textarea className="sk-editor" rows={16} value={md} onChange={(e) => setMd(e.target.value)} spellCheck={false} />
        </Field>
        <Field label="What changed">
          <TextInput value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

// ---- Who gets it ----------------------------------------------------------------------------------------------------------

function AssignmentsTab({ s, scopes }: { s: SkillDetail; scopes: ScopeInfo[] }) {
  const result = useApi<{ assignments: Assignment[]; collection: { slug: string; name: string; assignments: Assignment[] } | null }>(`/skills/${s.id}/assignments`);
  const toast = useToast();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  async function remove(a: Assignment) {
    const ok = await confirm({ title: `Take ${s.name} away from ${a.label}?`, body: "They stop getting it in Claude at once, unless another assignment still gives it to them.", confirmLabel: "Take it away", tone: "danger" });
    if (!ok) return;
    try {
      await api(`/skill-assignments/${a.id}`, { method: "DELETE" });
      toast.success("Assignment removed");
      result.reload();
    } catch (err) {
      toast.error(err, { title: "Couldn't remove the assignment" });
    }
  }
  return (
    <AsyncBlock result={result} label="Loading who gets it" errorTitle="Couldn't load the assignments" skeleton={<SkeletonRows count={3} />}>
      {(d) => (
        <div className="sk-stack">
          <Section
            title="Assignments"
            count={d.assignments.length}
            description={s.status !== "active" ? "The skill isn't active, so nobody gets it right now." : !s.current ? "Nobody gets it until its first version is published." : undefined}
            actions={
              s.can.manage ? (
                <Button icon="plus" onClick={() => setAdding(true)}>
                  Give it to…
                </Button>
              ) : undefined
            }
          >
            <DataTable
              caption="Assignments"
              density="compact"
              rows={d.assignments}
              getRowId={(a) => a.id}
              columns={[
                { key: "who", header: "Who", primary: true, cell: (a) => a.label },
                { key: "by", header: "Added by", cell: (a) => a.created_by ?? "", hideBelow: 760 },
                { key: "when", header: "Added", cell: (a) => <RelativeTime date={a.created_at} /> },
              ]}
              rowMenu={s.can.manage ? (a) => [{ id: "remove", label: "Take it away…", icon: "x", tone: "danger", onSelect: () => void remove(a) }] : undefined}
              empty={<EmptyState variant="compact" title="Nobody yet" description="Give it to everyone, a role, a team or a project." />}
            />
          </Section>
          {d.collection && (
            <Section title={`Through the ${d.collection.name} collection`} count={d.collection.assignments.length} description="Every skill in the collection goes to these people. Change them from Skills › All skills › Collections.">
              <ul className="sk-plain-list">
                {d.collection.assignments.length ? d.collection.assignments.map((a) => <li key={a.id}>{a.label}</li>) : <li className="muted small">None</li>}
              </ul>
            </Section>
          )}
          {adding && <AssignDialog target={{ kind: "skill", id: s.id, name: s.name, owner: s.owner_project }} scopes={scopes} onClose={() => setAdding(false)} onDone={result.reload} />}
        </div>
      )}
    </AsyncBlock>
  );
}

// ---- Usage -------------------------------------------------------------------------------------------------------------

interface Usage {
  skill: { id: string; name: string; version: number | null };
  days: number;
  total: number;
  by_channel: Record<string, number>;
  daily: { day: string; n: number }[];
  people: { id: string; name: string; email: string; uses: number; by_channel: Record<string, number>; first_at: string; last_at: string; last_version: number; behind: boolean }[];
}

function UsageTab({ id }: { id: string }) {
  const [days, setDays] = useState("90");
  const result = useApi<Usage>(`/skills/${id}/usage?days=${days}`);
  return (
    <div className="sk-stack">
      <SegmentedControl
        label="Period"
        size="sm"
        value={days}
        onChange={setDays}
        options={[
          { value: "30", label: "30 days" },
          { value: "90", label: "90 days" },
          { value: "365", label: "A year" },
        ]}
      />
      <AsyncBlock result={result} label="Loading usage" errorTitle="Couldn't load the usage" skeleton={<SkeletonRows count={4} />}>
        {(u) => (
          <>
            <div className="sk-tiles">
              <StatTile label="Loads" value={u.total} icon="sparkle" trend={u.daily.map((x) => x.n)} />
              <StatTile label="People" value={u.people.length} icon="user" />
              <StatTile label="On an older version" value={u.people.filter((p) => p.behind).length} icon="clock" tone={u.people.some((p) => p.behind) ? "warning" : undefined} />
            </div>
            {u.total > 0 && (
              <Card padding="sm" title="How it was loaded">
                <HBars data={Object.entries(u.by_channel).map(([k, n]) => ({ label: SKILL_USAGE_CHANNEL[k] ?? k, value: n }))} />
              </Card>
            )}
            <DataTable
              caption="Who used it"
              rows={u.people}
              getRowId={(p) => p.id}
              columns={[
                { key: "who", header: "Person", primary: true, cell: (p) => p.name },
                { key: "uses", header: "Loads", numeric: true, cell: (p) => p.uses },
                {
                  key: "how",
                  header: "How",
                  cell: (p) => (
                    <span className="small">
                      {Object.entries(p.by_channel)
                        .filter(([, n]) => n > 0)
                        .map(([k, n]) => `${SKILL_USAGE_CHANNEL[k] ?? k} ${n}`)
                        .join(" · ")}
                    </span>
                  ),
                  hideBelow: 760,
                },
                { key: "version", header: "Last version", cell: (p) => (p.behind ? <Badge tone="warning">still on v{p.last_version}</Badge> : `v${p.last_version}`) },
                { key: "last", header: "Last used", cell: (p) => <RelativeTime date={p.last_at} /> },
              ]}
              empty={<EmptyState variant="compact" title="Nobody used it in this period" />}
            />
          </>
        )}
      </AsyncBlock>
    </div>
  );
}

// ---- Problem reports ----------------------------------------------------------------------------------------------------

function FeedbackTab({ s }: { s: SkillDetail }) {
  const result = useApi<{ feedback: SkillFeedback[] }>(`/skills/feedback?skill=${s.id}`);
  const [reporting, setReporting] = useState(false);
  return (
    <Section
      title={s.view === "manager" ? "Problem reports" : "Your reports"}
      description="“This skill was wrong”: from people who use it, on the web or through Claude (report_skill_problem)."
      actions={
        <Button icon="alert" onClick={() => setReporting(true)}>
          Report a problem
        </Button>
      }
    >
      <AsyncBlock result={result} label="Loading reports" errorTitle="Couldn't load the reports" skeleton={<SkeletonRows count={3} />}>
        {(d) => <FeedbackList items={d.feedback} manage={s.can.manage || s.can.review} onChanged={result.reload} />}
      </AsyncBlock>
      {reporting && <ReportProblemDialog skill={{ id: s.id, name: s.name, version: s.current?.version }} onClose={() => setReporting(false)} onDone={result.reload} />}
    </Section>
  );
}

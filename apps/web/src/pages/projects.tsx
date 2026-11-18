import { useMemo, useState } from "react";
import { api } from "../api";
import { useBoot } from "../components/boot";
import { plural } from "../components/labels";
import { can } from "../components/permissions";
import { treeOrder } from "../components/tree";
import {
  displayName,
  AdminTabs,
  Badge,
  BulkBar,
  Button,
  Callout,
  ChipGroup,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  IconButton,
  Page,
  PageHeader,
  RelativeTime,
  StatusBadge,
  useConfirm,
  useToast,
  type Column,
  type MenuItemSpec,
} from "../components/kit";
import { useApi, useAppRoute, useQueryState } from "../hooks";
import { pickFilters, SavedViews } from "../components/saved-views";
import { href } from "../router";

interface ManagedProject {
  slug: string;
  name: string;
  description: string;
  visibility: "team" | "members";
  status: string;
  created_at: string;
  parent: string | null;
  owners: string[];
  /** The same people with their display names. */
  owner_list?: { email: string; name: string | null }[];
  people: number;
  teams: number;
  repositories: number;
  articles: number;
  findings: number;
  pending_reviews: number;
  last_activity: string;
  can_manage: boolean;
}

type Show = "all" | "members" | "team" | "archived";
/** The filters a saved view keeps (server: core/views.ts). */
const PROJECT_VIEW_KEYS = ["show", "q", "sort", "dir"] as const;
type Row = ManagedProject & { depth: number; children: number };
type Outcome = { changed: number; results: { slug: string; ok: boolean; error?: string }[] };

const SORTS: Record<string, (p: ManagedProject) => number | string> = {
  access: (p) => p.people + p.teams,
  content: (p) => p.articles + p.findings,
  activity: (p) => p.last_activity ?? "",
};

/**
 * Every project the caller looks after (all of them for Administrators): who can see each one, its Project admins, how big it is
 * and what's waiting, with visibility changed one at a time or in bulk.
 */
export function ProjectsPage() {
  const route = useAppRoute();
  const { me } = useBoot();
  const toast = useToast();
  const confirm = useConfirm();
  const [qs, setQs] = useQueryState(route, { show: "all", q: "", sort: "", dir: "desc" });
  const result = useApi<{ projects: ManagedProject[]; default_visibility: "members" | "team"; can_create: boolean }>("/projects/manage");
  const { data, error, reload } = result;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<{ slug: string; error?: string }[]>([]);

  const show = (["all", "members", "team", "archived"].includes(qs.show!) ? qs.show : "all") as Show;
  const q = qs.q ?? "";
  const sort = qs.sort && SORTS[qs.sort] ? { key: qs.sort, dir: (qs.dir === "asc" ? "asc" : "desc") as "asc" | "desc" } : undefined;

  const all = data?.projects ?? [];
  const active = all.filter((p) => p.status === "active");
  const counts = { all: active.length, members: active.filter((p) => p.visibility === "members").length, team: active.filter((p) => p.visibility === "team").length, archived: all.length - active.length };
  const names = new Map(all.map((p) => [p.slug, p.name]));
  const subCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of all) if (p.parent) m.set(p.parent, (m.get(p.parent) ?? 0) + 1);
    return m;
  }, [all]);
  const rows: Row[] = useMemo(() => {
    const words = q.trim().toLowerCase();
    const matching = all.filter(
      (p) =>
        (show === "archived" ? p.status !== "active" : p.status === "active" && (show === "all" || p.visibility === show)) &&
        (!words || `${p.name} ${p.slug} ${p.description} ${p.owners.join(" ")} ${(p.owner_list ?? []).map((o) => o.name ?? "").join(" ")}`.toLowerCase().includes(words)),
    );
    if (sort) {
      const key = SORTS[sort.key]!;
      const flat = [...matching].sort((a, b) => {
        const x = key(a);
        const y = key(b);
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return sort.dir === "asc" ? c : -c;
      });
      return flat.map((p) => ({ ...p, depth: 0, children: 0 }));
    }
    // As a tree: each project followed by its sub-projects (a filtered-out parent puts its children at the top level).
    return treeOrder(matching);
  }, [all, show, q, sort?.key, sort?.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  const manageable = rows.filter((p) => p.can_manage);
  const chosen = manageable.filter((p) => selected.has(p.slug)).map((p) => p.slug);
  const openOnes = active.filter((p) => p.visibility === "team" && p.can_manage);

  async function setVisibility(slugs: string[], visibility: "members" | "team", o: { undo?: boolean } = {}) {
    setBusy(true);
    setFailures([]);
    try {
      const out = await api<Outcome>("/projects/visibility", { method: "POST", body: { projects: slugs, visibility } });
      const failed = out.results.filter((r) => !r.ok);
      const changed = out.results.filter((r) => r.ok).map((r) => r.slug);
      setFailures(failed);
      setSelected(new Set());
      reload();
      const what = visibility === "members" ? "members-only" : "open to everyone";
      const title = slugs.length === 1 && out.changed === 1 ? `${names.get(slugs[0]!) ?? slugs[0]} is now ${what}` : `${plural(out.changed, "project")} ${out.changed === 1 ? "is" : "are"} now ${what}`;
      if (out.changed > 0)
        toast.success(
          title,
          o.undo && changed.length
            ? { undo: () => api("/projects/visibility", { method: "POST", body: { projects: changed, visibility: visibility === "members" ? "team" : "members" } }).then(reload) }
            : undefined,
        );
      if (failed.length) toast.warning(`${plural(failed.length, "project")} didn't change`, { description: "See the list above the table." });
    } catch (e) {
      toast.error(e, { title: "Couldn't change who can see them" });
    } finally {
      setBusy(false);
    }
  }

  async function openUp(slugs: string[]) {
    const one = slugs.length === 1 ? (names.get(slugs[0]!) ?? slugs[0]) : null;
    const ok = await confirm({
      title: one ? `Make ${one} visible to everyone signed in?` : `Make ${plural(slugs.length, "project")} visible to everyone signed in?`,
      body: "Anyone signed in can then read them. Their sub-projects keep their own visibility.",
      confirmLabel: "Open to everyone",
    });
    if (ok) await setVisibility(slugs, "team");
  }

  const columns: Column<Row>[] = [
    {
      key: "project",
      header: "Project",
      primary: true,
      cell: (p) => (
        <span className="pj-project-cell">
          <span className="pj-project-name">
            {p.depth > 0 && <span className="pj-tree-mark" aria-hidden="true" />}
            <a href={href(`/project/${p.slug}`)} className="pj-strong">
              {p.name}
            </a>
            {/* Only the exceptions: the workspace default needs no badge on every row (the chips filter by it). */}
            {p.visibility !== (data?.default_visibility ?? "members") && <StatusBadge domain="visibility" value={p.visibility} />}
          </span>
          <span className="pj-person-sub">
            {[
              p.parent && !p.depth ? `in ${names.get(p.parent) ?? p.parent}` : null,
              subCount.get(p.slug) ? plural(subCount.get(p.slug)!, "sub-project") : null,
              p.slug,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {p.description && <span className="pj-project-desc">{p.description}</span>}
        </span>
      ),
    },
    {
      key: "admins",
      header: "Project admins",
      cell: (p) =>
        p.owners.length ? (
          <span className="pj-admins" title={p.owners.join(", ")}>
            {(p.owner_list ?? p.owners.map((email) => ({ email, name: null })))
              .slice(0, 2)
              .map((o) => displayName(o.name, o.email))
              .join(", ")}
            {p.owners.length > 2 && <span className="muted"> +{p.owners.length - 2}</span>}
          </span>
        ) : (
          <span className="pj-admins">
            <Badge tone="warning" icon="alert">
              No Project admin
            </Badge>
            {p.can_manage && <a href={href(`/scope/${p.slug}/settings`, { tab: "access" })}>Add a Project admin</a>}
          </span>
        ),
    },
    {
      key: "access",
      header: "Access",
      sortable: true,
      cell: (p) => (
        <span className="pj-person pj-nowrap tabular">
          <span>{plural(p.people, "person", "people")}</span>
          {p.teams > 0 && <span className="pj-person-sub">{plural(p.teams, "team")}</span>}
        </span>
      ),
    },
    {
      key: "content",
      header: "Content",
      sortable: true,
      cell: (p) => (
        <span className="pj-person tabular">
          <span className="pj-nowrap">
            {plural(p.articles, "article")} · {plural(p.findings, "finding")}
          </span>
          <span className="pj-person-sub">{plural(p.repositories, "repository", "repositories")}</span>
          {p.pending_reviews > 0 && (
            <a href={href("/review", { scope: p.slug })} className="pj-nowrap">
              {p.pending_reviews} to review
            </a>
          )}
        </span>
      ),
    },
    { key: "activity", header: "Last activity", sortable: true, cell: (p) => <span className="pj-nowrap"><RelativeTime date={p.last_activity} /></span> },
  ];

  const rowMenu = (p: Row): MenuItemSpec[] =>
    p.can_manage && p.status === "active"
      ? [
          { id: "sub", label: "Add sub-project", icon: "folder-plus", href: href("/new/project", { parent: p.slug }) },
          p.visibility === "members"
            ? { id: "open", label: "Open to everyone…", icon: "globe", onSelect: () => void openUp([p.slug]) }
            : { id: "close", label: "Make members-only", icon: "lock", onSelect: () => void setVisibility([p.slug], "members", { undo: true }) },
        ]
      : [];

  const filtered = !!q.trim() || show !== "all";

  return (
    <Page width="wide">
      <PageHeader
        title="Projects"
        crumbs={[{ label: "Admin", href: href("/admin") }]}
        tabs={<AdminTabs current="projects" />}
        description={
          <>
            {data?.default_visibility === "team"
              ? "New projects are open to everyone signed in unless their creator makes them members-only."
              : "New projects are members-only: only the people and teams added to them, and people who can see every project (Administrators, Auditors), can see them."}{" "}
            {can.systemSettings(me) && <a href={href("/admin/system")}>Change in System settings</a>}
          </>
        }
        info={{
          label: "How projects nest",
          content:
            "Projects nest: a sub-project's members include everyone with a role in the projects above it. Open a project's settings to change its members, roles, repositories and where it sits.",
        }}
        primary={
          data?.can_create && (
            <Button variant="primary" icon="plus" href={href("/new/project")}>
              New project
            </Button>
          )
        }
      />

      <div className="pj-stack">
        {openOnes.length > 0 && show !== "archived" && (
          <Callout
            tone="warning"
            title={`${plural(openOnes.length, "project")} you manage ${openOnes.length === 1 ? "is" : "are"} open to everyone signed in`}
            actions={
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setQs({ show: "team" });
                  setSelected(new Set(openOnes.map((p) => p.slug)));
                }}
              >
                Select {openOnes.length === 1 ? "it" : "them"}
              </Button>
            }
          >
            Select {openOnes.length === 1 ? "it" : "them"} to make {openOnes.length === 1 ? "it" : "them"} members-only.
          </Callout>
        )}
        {failures.length > 0 && (
          <Callout tone="warning" title={`${plural(failures.length, "project")} didn't change`} onDismiss={() => setFailures([])}>
            <ul className="pj-plain-list">
              {failures.map((f) => (
                <li key={f.slug}>
                  {names.get(f.slug) ?? f.slug}: {f.error ?? "failed"}
                </li>
              ))}
            </ul>
          </Callout>
        )}

        <FilterBar
          search={{ value: q, onChange: (v) => setQs({ q: v }), label: "Find a project", placeholder: "Find a project, or a Project admin's name or email" }}
          segments={
            <ChipGroup<Show>
              label="Show"
              value={show}
              onChange={(v: Show) => (setQs({ show: v }), setSelected(new Set()))}
              options={[
                { value: "all", label: "All", count: counts.all },
                { value: "members", label: "Members only", count: counts.members },
                { value: "team", label: "Open to everyone", count: counts.team },
                { value: "archived", label: "Archived", count: counts.archived },
              ]}
            />
          }
          active={[
            ...(show !== "all"
              ? [{ id: "show", label: { members: "Members only", team: "Open to everyone", archived: "Archived" }[show as Exclude<Show, "all">], onRemove: () => setQs({ show: undefined }) }]
              : []),
          ]}
          views={
            <SavedViews
              area="projects"
              current={pickFilters(route.query, PROJECT_VIEW_KEYS)}
              apply={(v) => (setQs(Object.fromEntries(PROJECT_VIEW_KEYS.map((k) => [k, v[k]]))), setSelected(new Set()))}
              summary={[
                `Show: ${{ all: "All", members: "Members only", team: "Open to everyone", archived: "Archived" }[show]}`,
                ...(q ? [`Search: ${q}`] : []),
                ...(qs.sort ? [`Sorted by ${qs.sort}, ${qs.dir === "asc" ? "ascending" : "descending"}`] : []),
              ]}
            />
          }
          onClearAll={() => setQs({ show: undefined, q: undefined })}
          result={data ? plural(rows.length, "project") : undefined}
        />

        <BulkBar count={chosen.length} noun={["project", "projects"]} onClear={() => setSelected(new Set())}>
          <Button size="sm" icon="lock" loading={busy} onClick={() => void setVisibility(chosen, "members", { undo: true })}>
            Make members-only
          </Button>
          <Button size="sm" icon="globe" disabled={busy} onClick={() => void openUp(chosen)}>
            Open to everyone…
          </Button>
        </BulkBar>

        {error && !data ? (
          <ErrorState error={error} title="Couldn't load the projects" onRetry={reload} />
        ) : (
          <DataTable
            caption="Projects you manage"
            columns={columns}
            rows={rows}
            getRowId={(p) => p.slug}
            loading={!data}
            sort={sort}
            onSortChange={(s) => setQs({ sort: s.key, dir: s.dir })}
            indent={(p) => p.depth}
            rowTone={(p) => (p.status !== "active" ? "muted" : undefined)}
            selection={
              manageable.length
                ? { selected, onChange: setSelected, isSelectable: (p) => p.can_manage, label: (p) => `Select ${p.name}` }
                : undefined
            }
            rowAction={(p) =>
              p.can_manage ? (
                <IconButton size="sm" icon="settings" label={`Members and settings of ${p.name}`} href={href(`/scope/${p.slug}/settings`, { tab: "access" })} />
              ) : null
            }
            rowMenu={rowMenu}
            empty={
              all.length && filtered ? (
                <EmptyState
                  variant="search"
                  title="No projects match"
                  description="Try another word, or show all projects."
                  primary={<Button onClick={() => setQs({ show: undefined, q: undefined })}>Clear filters</Button>}
                />
              ) : all.length ? (
                <EmptyState
                  variant="search"
                  title="No projects match"
                  description={`Every project you manage is archived (${counts.archived}).`}
                  primary={<Button onClick={() => (setQs({ show: "archived" }), setSelected(new Set()))}>Show archived</Button>}
                />
              ) : (
                <EmptyState
                  icon="folder"
                  title="You don't manage any projects yet"
                  description={data?.can_create ? "Create one for a product or service your team works on." : "Projects you're a Project admin of appear here."}
                  primary={
                    data?.can_create && (
                      <Button variant="primary" icon="plus" href={href("/new/project")}>
                        New project
                      </Button>
                    )
                  }
                />
              )
            }
          />
        )}
      </div>
    </Page>
  );
}
ProjectsPage.keepMountedOnQuery = true;


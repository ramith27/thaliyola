import { useMemo, useState } from "react";
import { api } from "../api";
import { useBoot } from "../components/boot";
import { I } from "../components/icons";
import { humanize, plural } from "../components/labels";
import { can } from "../components/permissions";
import {
  AsyncBlock,
  BulkBar,
  Button,
  Callout,
  ChipGroup,
  DataTable,
  EmptyState,
  ErrorState,
  FilterBar,
  ItemRow,
  ListRow,
  MetaLine,
  OverflowMenu,
  Page,
  PageHeader,
  RelativeTime,
  RowList,
  Section,
  Select,
  SkeletonRows,
  useConfirm,
  useToast,
  type MenuItemSpec,
} from "../components/kit";
import { useApi, useAppRoute, useQueryState } from "../hooks";
import { href, navigate } from "../router";

interface TrashProject {
  slug: string;
  name: string;
  deleted_at: string;
  deleted_by: string | null;
  items: number;
}
interface TrashItem {
  kind: "article" | "finding";
  id: string;
  title: string;
  type: string;
  scope: string;
  deleted_at: string;
  deleted_by: string | null;
}
interface Trash {
  projects: TrashProject[];
  items: TrashItem[];
  can_empty: boolean;
}
interface Purge {
  id: string;
  target_kind: string;
  reason: string;
  at: string;
  by: string;
  removed: Record<string, number>;
}

type Kind = "all" | "projects" | "articles" | "findings";

const pKey = (slug: string) => `p:${slug}`;
const iKey = (id: string) => `i:${id}`;
const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const itemsText = (n: number) => (n === 1 ? "1 article or finding" : `${n} articles and findings`);

/** "Deleted 3 days ago by Rita" (by only when known). */
function Deleted({ at, by }: { at: string; by: string | null }) {
  return (
    <span>
      <RelativeTime date={at} prefix="Deleted" />
      {by ? ` by ${by}` : ""}
    </span>
  );
}

/** What's been deleted: restore it, or (with Delete permanently) delete it for good. */
export function TrashPage() {
  const route = useAppRoute();
  const [q, setQ] = useQueryState(route, { q: "", kind: "all", where: "", sort: "newest" });
  const result = useApi<Trash>("/trash");
  const { me, reloadScopes, scope } = useBoot();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<"restore" | "purge" | null>(null);

  const data = result.data;
  const canEmpty = !!data?.can_empty;
  const kind = (["all", "projects", "articles", "findings"].includes(q.kind!) ? q.kind : "all") as Kind;
  const text = q.q!.trim().toLowerCase();
  const where = q.where!;
  const placeName = (slug: string) => scope(slug)?.name ?? slug;

  const view = useMemo(() => {
    const order = (a: { deleted_at: string }, b: { deleted_at: string }) =>
      q.sort === "oldest" ? a.deleted_at.localeCompare(b.deleted_at) : b.deleted_at.localeCompare(a.deleted_at);
    const projects = (data?.projects ?? []).filter((p) => (kind === "all" || kind === "projects") && !where && (!text || p.name.toLowerCase().includes(text))).sort(order);
    const items = (data?.items ?? [])
      .filter((i) => (kind === "all" || (kind === "articles" && i.kind === "article") || (kind === "findings" && i.kind === "finding")) && (!where || i.scope === where))
      .filter((i) => !text || i.title.toLowerCase().includes(text))
      .sort(order);
    return { projects, items };
  }, [data, kind, where, text, q.sort]);

  const places = useMemo(() => {
    const slugs = Array.from(new Set((data?.items ?? []).map((i) => i.scope)));
    return slugs.map((s) => ({ value: s, label: placeName(s) })).sort((a, b) => a.label.localeCompare(b.label));
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = !!text || kind !== "all" || !!where;
  const shownKeys = new Set([...view.projects.map((p) => pKey(p.slug)), ...view.items.map((i) => iKey(i.id))]);
  const chosen = new Set([...selected].filter((k) => shownKeys.has(k)));

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      on ? n.add(key) : n.delete(key);
      return n;
    });
  const unselect = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.delete(key);
      return n;
    });

  async function restoreProject(p: TrashProject) {
    setBusyKey(pKey(p.slug), true);
    try {
      await api(`/trash/projects/${p.slug}/restore`, { method: "POST" });
      unselect(pKey(p.slug));
      result.reload();
      await reloadScopes();
      toast.success(`Restored ${short(p.name)}`, { link: { label: "Open project", href: href(`/project/${p.slug}`) } });
    } catch (e) {
      toast.error(e, { title: `Couldn't restore ${p.name}`, action: { label: "Try again", onClick: () => void restoreProject(p) } });
    } finally {
      setBusyKey(pKey(p.slug), false);
    }
  }

  async function purgeProject(p: TrashProject) {
    const ok = await confirm({
      title: `Delete ${p.name} forever?`,
      body: `This deletes ${p.name} and its ${itemsText(p.items)} forever, with their history and files. You can't undo this.`,
      confirmLabel: "Delete forever",
      tone: "danger",
      typeToConfirm: { values: [p.name, p.slug], label: "Type the project's name to confirm" },
    });
    if (!ok) return;
    setBusyKey(pKey(p.slug), true);
    try {
      await api(`/trash/projects/${p.slug}/purge`, { method: "POST", body: { confirm: ok.typed } });
      unselect(pKey(p.slug));
      result.reload();
      toast.success(`Deleted ${short(p.name)} permanently`);
    } catch (e) {
      toast.error(e, { title: `Couldn't delete ${p.name}` });
    } finally {
      setBusyKey(pKey(p.slug), false);
    }
  }

  async function restoreItem(i: TrashItem) {
    setBusyKey(iKey(i.id), true);
    try {
      await api(`/trash/items/${i.id}/restore`, { method: "POST" });
      unselect(iKey(i.id));
      result.reload();
      toast.success(`Restored “${short(i.title)}”`, { link: { label: "Open it", href: href(`/${i.kind}/${i.id}`) } });
    } catch (e) {
      toast.error(e, { title: "Couldn't restore it", action: { label: "Try again", onClick: () => void restoreItem(i) } });
    } finally {
      setBusyKey(iKey(i.id), false);
    }
  }

  async function purgeItem(i: TrashItem) {
    const ok = await confirm({
      title: `Delete “${i.title}” forever?`,
      body: "Its history and files are removed too. You can't undo this.",
      confirmLabel: "Delete forever",
      tone: "danger",
    });
    if (!ok) return;
    setBusyKey(iKey(i.id), true);
    try {
      await api(`/trash/items/${i.id}/purge`, { method: "POST" });
      unselect(iKey(i.id));
      result.reload();
      toast.success(`Deleted “${short(i.title)}” permanently`);
    } catch (e) {
      toast.error(e, { title: "Couldn't delete it" });
    } finally {
      setBusyKey(iKey(i.id), false);
    }
  }

  /** Runs one call per selected row; reports how many worked. */
  async function bulk(action: "restore" | "purge") {
    const projects = view.projects.filter((p) => chosen.has(pKey(p.slug)));
    const items = view.items.filter((i) => chosen.has(iKey(i.id)));
    const total = projects.length + items.length;
    if (action === "purge") {
      const ok = await confirm({
        title: `Delete ${plural(total, "item")} forever?`,
        body: projects.length
          ? `This includes ${plural(projects.length, "project")} and everything in them. Their history and files are removed too. You can't undo this.`
          : "Their history and files are removed too. You can't undo this.",
        confirmLabel: "Delete forever",
        tone: "danger",
        typeToConfirm: projects.length ? { values: ["delete forever"], label: "Type “delete forever” to confirm" } : undefined,
      });
      if (!ok) return;
    }
    setBulkBusy(action);
    let done = 0;
    let lastError: unknown = null;
    for (const p of projects) {
      try {
        await api(`/trash/projects/${p.slug}/${action}`, { method: "POST", body: action === "purge" ? { confirm: p.slug } : undefined });
        done++;
      } catch (e) {
        lastError = e;
      }
    }
    for (const i of items) {
      try {
        await api(`/trash/items/${i.id}/${action}`, { method: "POST" });
        done++;
      } catch (e) {
        lastError = e;
      }
    }
    setBulkBusy(null);
    setSelected(new Set());
    result.reload();
    if (action === "restore" && projects.length) await reloadScopes();
    const verb = action === "restore" ? "Restored" : "Deleted";
    if (done) toast.success(`${verb} ${plural(done, "item")}${action === "purge" ? " permanently" : ""}`);
    if (lastError) toast.error(lastError, { title: `${plural(total - done, "item")} couldn't be ${action === "restore" ? "restored" : "deleted"}` });
  }

  const toggle = (key: string) => (on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      on ? n.add(key) : n.delete(key);
      return n;
    });

  const counts = {
    all: (data?.projects.length ?? 0) + (data?.items.length ?? 0),
    projects: data?.projects.length ?? 0,
    articles: data?.items.filter((i) => i.kind === "article").length ?? 0,
    findings: data?.items.filter((i) => i.kind === "finding").length ?? 0,
  };
  const sortMenu: MenuItemSpec[] = [
    { type: "group", label: "Sort" },
    { id: "newest", label: "Deleted most recently", checked: q.sort !== "oldest", onSelect: () => setQ({ sort: "newest" }) },
    { id: "oldest", label: "Deleted longest ago", checked: q.sort === "oldest", onSelect: () => setQ({ sort: "oldest" }) },
  ];

  return (
    <Page width="content">
      <PageHeader
        title="Trash"
        description="Deleted items are hidden from search, browsing, the graph and agents. Restore them any time."
        meta={
          data ? (
            <span className="tl-meta">
              <I name={canEmpty ? "key" : "lock"} size={14} />
              {canEmpty ? "You have Delete permanently, so you can also delete them for good." : "People with Delete permanently (Administrators) can delete them for good."}
            </span>
          ) : undefined
        }
      />
      <AsyncBlock
        result={result}
        label="Loading the trash"
        errorTitle="Couldn't load the trash"
        skeleton={<SkeletonRows count={4} />}
        isEmpty={(d) => !d.projects.length && !d.items.length}
        empty={
          <EmptyState
            icon="trash"
            title="Trash is empty"
            description="Deleted projects, articles and findings show up here and can be restored."
          />
        }
      >
        {() => (
          <div className="tl-stack-lg">
            <FilterBar
              search={{ value: q.q!, onChange: (v) => setQ({ q: v }), label: "Search the trash", placeholder: "Search by title" }}
              segments={
                <ChipGroup<Kind>
                  label="Kind"
                  options={[
                    { value: "all", label: "All", count: counts.all },
                    { value: "projects", label: "Projects", count: counts.projects },
                    { value: "articles", label: "Articles", count: counts.articles },
                    { value: "findings", label: "Findings", count: counts.findings },
                  ]}
                  value={kind}
                  onChange={(v: Kind) => setQ({ kind: v || "all" })}
                />
              }
              filters={
                places.length > 1 ? (
                  <Select
                    aria-label="Where"
                    className="tl-where"
                    value={where}
                    onChange={(e) => setQ({ where: e.target.value })}
                    options={[{ value: "", label: "Anywhere" }, ...places]}
                  />
                ) : undefined
              }
              view={sortMenu}
              active={where ? [{ id: "where", label: `Where: ${placeName(where)}`, onRemove: () => setQ({ where: undefined }) }] : undefined}
              onClearAll={() => setQ({ q: undefined, kind: undefined, where: undefined })}
              result={filtered ? plural(view.projects.length + view.items.length, "result") : undefined}
            />

            <BulkBar count={chosen.size} noun={["item", "items"]} onClear={() => setSelected(new Set())}>
              <Button
                size="sm"
                icon="undo"
                loading={bulkBusy === "restore"}
                loadingText="Restoring"
                disabled={bulkBusy === "purge"}
                onClick={() => void bulk("restore")}
              >
                Restore
              </Button>
              {canEmpty && (
                <Button
                  size="sm"
                  variant="danger"
                  icon="trash"
                  loading={bulkBusy === "purge"}
                  loadingText="Deleting"
                  disabled={bulkBusy === "restore"}
                  onClick={() => void bulk("purge")}
                >
                  Delete permanently…
                </Button>
              )}
            </BulkBar>

            {filtered && !view.projects.length && !view.items.length ? (
              <EmptyState
                variant="search"
                title="Nothing in the trash matches"
                description="Try other words, or clear the filters."
                secondary={<Button onClick={() => setQ({ q: undefined, kind: undefined, where: undefined })}>Clear filters</Button>}
              />
            ) : (
              <>
                {(kind === "all" || kind === "projects") && !where && (
                  <Section title="Projects" count={view.projects.length}>
                    {view.projects.length ? (
                      <RowList label="Deleted projects">
                        {view.projects.map((p) => (
                          <ListRow
                            key={p.slug}
                            leading={<I name="folder" size={16} />}
                            title={p.name}
                            selectable={{ checked: chosen.has(pKey(p.slug)), onChange: toggle(pKey(p.slug)), label: `Select ${p.name}` }}
                            meta={<MetaLine items={[itemsText(p.items), <Deleted key="d" at={p.deleted_at} by={p.deleted_by} />]} />}
                            trailing={
                              <span className="tl-row-buttons">
                                <Button size="sm" icon="undo" loading={busy.has(pKey(p.slug))} loadingText="Restoring" onClick={() => void restoreProject(p)}>
                                  Restore
                                </Button>
                                {canEmpty && (
                                  <OverflowMenu
                                    size="sm"
                                    label={`More actions for ${p.name}`}
                                    items={[{ id: "purge", label: "Delete permanently…", icon: "trash", tone: "danger", onSelect: () => void purgeProject(p) }]}
                                  />
                                )}
                              </span>
                            }
                          />
                        ))}
                      </RowList>
                    ) : (
                      <EmptyState variant="compact" icon="folder" title={text ? "No deleted projects match." : "No deleted projects."} />
                    )}
                  </Section>
                )}
                {kind !== "projects" && (
                  <Section title={kind === "articles" ? "Articles" : kind === "findings" ? "Findings" : "Articles and findings"} count={view.items.length}>
                    {view.items.length ? (
                      <RowList label="Deleted articles and findings">
                        {view.items.map((i) => (
                          <ItemRow
                            key={i.id}
                            item={{ kind: i.kind, id: i.id, title: i.title, type: i.type, scope: i.scope }}
                            show={{ status: false, updated: false }}
                            selectable={{ checked: chosen.has(iKey(i.id)), onChange: toggle(iKey(i.id)), label: `Select ${i.title}` }}
                            metaExtra={[<Deleted key="d" at={i.deleted_at} by={i.deleted_by} />]}
                            trailing={
                              <span className="tl-row-buttons">
                                <Button size="sm" icon="undo" loading={busy.has(iKey(i.id))} loadingText="Restoring" onClick={() => void restoreItem(i)}>
                                  Restore
                                </Button>
                                {canEmpty && (
                                  <OverflowMenu
                                    size="sm"
                                    label={`More actions for ${i.title}`}
                                    items={[{ id: "purge", label: "Delete permanently…", icon: "trash", tone: "danger", onSelect: () => void purgeItem(i) }]}
                                  />
                                )}
                              </span>
                            }
                          />
                        ))}
                      </RowList>
                    ) : (
                      <EmptyState variant="compact" icon="doc" title="Nothing here" description={text || where ? "No deleted articles or findings match." : "No deleted articles or findings."} />
                    )}
                  </Section>
                )}
              </>
            )}
          </div>
        )}
      </AsyncBlock>
      {can.purge(me) && <PermanentlyDeleted />}
    </Page>
  );
}
TrashPage.keepMountedOnQuery = true;

/** The purge log: what was deleted for good, when, why and by whom. For people with Delete permanently; hidden when empty. */
function PermanentlyDeleted() {
  const result = useApi<{ purges: Purge[] }>("/purges");
  if (!result.data?.purges.length && !result.error) return null;
  return (
    <div className="tl-section-gap">
      <Section title="Permanently deleted" description="Items deleted permanently (by people with Delete permanently). Only the reason is kept.">
        {result.error && !result.data ? (
          <ErrorState compact error={result.error} title="Couldn't load the list" onRetry={result.reload} />
        ) : (
          <DataTable
            caption="Permanently deleted"
            density="compact"
            rows={result.data!.purges}
            getRowId={(p) => p.id}
            columns={[
              { key: "at", header: "When", cell: (p) => <RelativeTime date={p.at} /> },
              { key: "what", header: "What", cell: (p) => humanize(p.target_kind) },
              // The reason is the card title on phones, so long reasons wrap as a heading.
              { key: "reason", header: "Reason", primary: true, cell: (p) => p.reason },
              { key: "by", header: "By", cell: (p) => <span className="tl-break">{p.by}</span> },
            ]}
            empty={<EmptyState variant="compact" title="Nothing has been deleted permanently" />}
          />
        )}
      </Section>
    </div>
  );
}

/** Banner on a deleted article or finding, with Restore. */
export function TrashedNotice({ id, onRestored }: { id: string; onRestored: () => void }) {
  const [error, setError] = useState<unknown>(null);
  const [restoring, setRestoring] = useState(false);
  const toast = useToast();
  async function restore() {
    setError(null);
    setRestoring(true);
    try {
      await api(`/trash/items/${id}/restore`, { method: "POST" });
      toast.success("Restored from the trash");
      onRestored();
    } catch (e) {
      setError(e);
    } finally {
      setRestoring(false);
    }
  }
  return (
    <Callout
      tone="warning"
      icon="trash"
      title="This is in the trash."
      actions={
        <>
          <Button size="sm" icon="undo" loading={restoring} loadingText="Restoring" onClick={() => void restore()}>
            Restore
          </Button>
          <Button size="sm" variant="ghost" href={href("/trash")}>
            Open the trash
          </Button>
        </>
      }
    >
      <p>Nobody else can see it, and search and agents ignore it.</p>
      {!!error && <ErrorState compact error={error} title="Couldn't restore it" onRetry={() => void restore()} />}
    </Callout>
  );
}

/** Moves an article or finding to the trash after asking, then goes to its place with "Moved to trash · Undo". */
export function DeleteItemButton({ id, kind, title, scopeLink }: { id: string; kind: string; title: string; scopeLink: string }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function moveToTrash() {
    const ok = await confirm({
      title: `Move “${title}” to the trash?`,
      body: "You can restore it from the trash.",
      confirmLabel: "Move to trash",
      tone: "danger",
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(`/items/${id}/delete`, { method: "POST" });
      window.location.hash = scopeLink.replace(/^#/, "");
      toast.success("Moved to trash", {
        undo: async () => {
          await api(`/trash/items/${id}/restore`, { method: "POST" });
          navigate(`/${kind}/${id}`);
        },
      });
    } catch (e) {
      toast.error(e, { title: "Couldn't move it to the trash" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button variant="danger" icon="trash" loading={busy} loadingText="Moving" onClick={() => void moveToTrash()}>
      Move to trash…
    </Button>
  );
}

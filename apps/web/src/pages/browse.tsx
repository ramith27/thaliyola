import { MermaidDiagram } from "../components/mermaid";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { WhoKnows } from "../components/who-knows";
import type { Folder, Me, Notice as NoticeT, ScopeInfo, SearchHit } from "../api";
import { api, getToken } from "../api";
import { useBoot } from "../components/boot";
import { AnswerCard, FavouriteButton } from "../components/find";
import { SCOPE_ICON, SCOPE_KIND, labelFrom, plural, REPO_KIND, statusMeta, typeLabel } from "../components/labels";
import { MoveFolder } from "../components/move";
import { WatchButton } from "../components/notifications";
import { can } from "../components/permissions";
import { I } from "../components/icons";
import { Markdown } from "../components/ui";
import {
  AsyncBlock,
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  FilterBar,
  GroupHeader,
  humanizeError,
  ItemRow,
  LinkChip,
  ListRow,
  OverflowMenu,
  Page,
  PageHeader,
  ProjectPicker,
  projectSwitcher,
  RelativeTime,
  RowList,
  SearchInput,
  Section,
  SegmentedControl,
  Select,
  SkeletonCard,
  SkeletonRows,
  SplitButton,
  StatusBadge,
  Switch,
  Tabs,
  useToast,
  type Crumb,
  type MenuItemSpec,
} from "../components/kit";
import { useApi, useAppRoute, useLiveRefresh, useQueryState } from "../hooks";
import { setPrefill } from "../paste";
import { href, navigate, type Route } from "../router";
import { ProjectSecurity } from "./security";
import { DataView } from "./data";

// ---- Shared helpers ------------------------------------------------------------------------------------------

/** Up and Down move between the row links of a list (search results, folders). */
function useArrowRows(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const links = Array.from(el.querySelectorAll<HTMLAnchorElement>(".list-row-title > a"));
      const i = links.indexOf(document.activeElement as HTMLAnchorElement);
      if (i < 0) return;
      e.preventDefault();
      links[Math.max(0, Math.min(links.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    };
    el.addEventListener("keydown", on);
    return () => el.removeEventListener("keydown", on);
  });
}

/** Downloads the scope as a Markdown zip (the same request as ExportButton in setup.tsx). */
async function exportScope(slug: string) {
  const token = getToken();
  const res = await fetch(`/api/export?scope=${encodeURIComponent(slug)}`, { headers: token ? { authorization: `Bearer ${token}` } : {}, credentials: "same-origin" });
  if (!res.ok) throw new Error(`export failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `thaliyola-${slug}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function useExport(slug: string) {
  const toast = useToast();
  return () => {
    const id = toast.info("Preparing the export", { duration: 60_000 });
    exportScope(slug)
      .then(() => {
        toast.dismiss(id);
        toast.success("Export downloaded");
      })
      .catch((e) => {
        toast.dismiss(id);
        toast.error(e, { title: "Couldn't export" });
      });
  };
}

/** "New article ▾ New finding" for a space or project page. */
function newMenu(slug: string, extra: MenuItemSpec[] = []): MenuItemSpec[] {
  return [{ id: "finding", label: "New finding", icon: "bolt", hint: "Something that happened: incident, root cause, known issue", href: href("/new/finding", { scope: slug }) }, ...extra];
}

// ---- Search ----------------------------------------------------------------------------------------------------

const RECENT_SEARCHES = "thaliyola.recentSearches";

function getRecentSearches(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_SEARCHES) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

function recordSearch(q: string) {
  try {
    const lower = q.toLowerCase();
    // Drop the same search and any fragment typed on the way to it ("dep", "deplo" → "deploy").
    const next = [q, ...getRecentSearches().filter((r) => r.toLowerCase() !== lower && !lower.startsWith(r.toLowerCase()))].slice(0, 8);
    localStorage.setItem(RECENT_SEARCHES, JSON.stringify(next));
  } catch {
    /* storage unavailable: no history */
  }
}

const EXAMPLE_SEARCHES = ["How do we deploy?", "conversion rate", "checkout errors", "API contract"];

/** The snippet often starts with the title again; the row already shows it. */
function withoutTitle(snippet: string, title: string) {
  const s = snippet.trimStart();
  const plain = s.replace(/\*\*/g, "");
  if (!plain.toLowerCase().startsWith(title.toLowerCase())) return snippet;
  // Drop the title (and the ** markers inside it), then any joining punctuation.
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < title.length) {
    if (s.startsWith("**", i)) i += 2;
    else {
      seen++;
      i++;
    }
  }
  if (s.startsWith("**", i)) i += 2;
  const rest = s.slice(i).replace(/^[\s:.,—–-]+/, "");
  return rest || snippet;
}

/** The link a search hit opens (the same as AnswerCard's link for its best answer). */
const hitHref = (h: SearchHit) => href(`/${h.kind}/${h.id}`, { section: h.section ?? undefined });

export function SearchPage({ route }: { route: Route }) {
  const { scopes } = useBoot();
  const [qs, setQs] = useQueryState(route, { scope: "all", kind: "all" });
  const q = (qs.q ?? "").trim();
  const scope = qs.scope ?? "all";
  const drafts = qs.drafts === "1";
  const kind = qs.kind === "articles" || qs.kind === "findings" ? qs.kind : "all";
  const params = new URLSearchParams({ q, scope, ...(drafts ? { statuses: "draft,published,possibly_stale" } : {}) });
  const result = useApi<{ articles: SearchHit[]; findings: SearchHit[] }>(q ? `/search?${params}` : null);
  // Which item AnswerCard shows once it has loaded, so the matching row says "Shown above" (never while it's a skeleton).
  const [shownHref, setShownHref] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useArrowRows(listRef);

  const data = q ? result.data : null;
  // Only settled searches go into history: the query must stay put for a moment after its results arrive.
  useEffect(() => {
    if (!q || !data || result.loading) return;
    const t = setTimeout(() => recordSearch(q), 1500);
    return () => clearTimeout(t);
  }, [q, data, result.loading]);

  const articles = data?.articles ?? [];
  const findings = data?.findings ?? [];
  const total = articles.length + findings.length;
  const findingsFirst = (findings[0]?.score ?? 0) > (articles[0]?.score ?? 0) * 1.25;
  const isShown = (h: SearchHit) => !!q && !!shownHref && shownHref === hitHref(h);

  const focusFirstResult = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown") return;
    const first = listRef.current?.querySelector<HTMLAnchorElement>(".list-row-title > a");
    if (first) {
      e.preventDefault();
      first.focus();
    }
  };

  const group = (title: string, hits: SearchHit[], heading: boolean) =>
    hits.length > 0 &&
    (heading ? (
      <Section key={title} title={title} count={hits.length}>
        <HitRows label={title} hits={hits} isShown={isShown} />
      </Section>
    ) : (
      <HitRows key={title} label={title} hits={hits} isShown={isShown} />
    ));

  return (
    <Page width="content">
      <PageHeader title="Search" documentTitle={q ? `Search: “${q}”` : "Search"} nav="search" />
      <div className="br-search-field" onKeyDown={focusFirstResult}>
        <SearchInput
          value={q}
          onChange={(v) => setQs({ q: v.trim() || undefined })}
          label="Search your team's knowledge"
          placeholder="Search articles and findings"
          size="lg"
          debounceMs={300}
          resultCount={data ? total : undefined}
          autoFocus={!q}
        />
      </div>
      <FilterBar
        filters={
          <>
            <label className="br-inline-field">
              <span className="br-inline-label">Where</span>
              <ProjectPicker value={scope === "all" ? "" : scope} onChange={(v) => setQs({ scope: v || "all" })} scopes={scopes} noneLabel="Everything" />
            </label>
            <Switch checked={drafts} onChange={(next) => setQs({ drafts: next ? "1" : undefined })} label="Include drafts" />
          </>
        }
        result={q && data ? (total ? `${plural(total, "result")} for “${q}”` : `No results for “${q}”`) : undefined}
      />
      {!q ? (
        <SearchStart onPick={(v) => setQs({ q: v })} />
      ) : (
        <>
          <div className="br-answer-slot">
            <AnswerCard q={q} onResult={setShownHref} />
          </div>
          <AsyncBlock
            result={{ ...result, data }}
            label="Searching"
            skeleton={<SkeletonRows count={5} />}
            errorTitle="Search didn't work"
            isEmpty={() => total === 0}
            empty={
              <EmptyState
                variant="search"
                title={`Nothing found for “${q}”`}
                description={
                  <div className="br-tips">
                    <p>Try one of these:</p>
                    <div className="br-tip-actions">
                      {!drafts && (
                        <Button size="sm" variant="secondary" onClick={() => setQs({ drafts: "1" })}>
                          Include drafts
                        </Button>
                      )}
                      {scope !== "all" && (
                        <Button size="sm" variant="secondary" onClick={() => setQs({ scope: "all" })}>
                          Search everywhere
                        </Button>
                      )}
                      <span className="muted small">Use fewer words</span>
                    </div>
                  </div>
                }
                primary={
                  <Button
                    variant="primary"
                    icon="doc"
                    onClick={() => {
                      setPrefill({ kind: "article", type: "note", title: q, body_md: "" });
                      navigate("/new/article");
                    }}
                  >
                    Write an article about “{q}”
                  </Button>
                }
                secondary={
                  <Button icon="bolt" href={href("/new/finding")}>
                    Capture a finding
                  </Button>
                }
              />
            }
          >
            {() => (
              <>
                <Tabs
                  label="Kind"
                  idPrefix="search-kind"
                  value={kind}
                  onChange={(id) => setQs({ kind: id })}
                  items={[
                    { id: "all", label: "All", count: total },
                    { id: "articles", label: "Articles", count: articles.length },
                    { id: "findings", label: "Findings", count: findings.length },
                  ]}
                />
                <div role="tabpanel" id={`search-kind-panel-${kind}`} aria-labelledby={`search-kind-tab-${kind}`} className="br-results" ref={listRef}>
                  {kind === "all" ? (
                    // Whichever group holds the strongest match comes first.
                    findingsFirst ? (
                      <>
                        {group("Findings", findings, true)}
                        {group("Articles", articles, true)}
                      </>
                    ) : (
                      <>
                        {group("Articles", articles, true)}
                        {group("Findings", findings, true)}
                      </>
                    )
                  ) : kind === "articles" ? (
                    articles.length ? (
                      group("Articles", articles, false)
                    ) : (
                      <EmptyState variant="compact" title="No articles match" description="Findings match this search. Open the Findings tab." />
                    )
                  ) : findings.length ? (
                    group("Findings", findings, false)
                  ) : (
                    <EmptyState variant="compact" title="No findings match" description="Articles match this search. Open the Articles tab." />
                  )}
                </div>
              </>
            )}
          </AsyncBlock>
        </>
      )}
    </Page>
  );
}
SearchPage.keepMountedOnQuery = true;

function HitRows({ label, hits, isShown }: { label: string; hits: SearchHit[]; isShown: (h: SearchHit) => boolean }) {
  return (
    <RowList label={label}>
      {hits.map((h) => (
        <ItemRow
          key={`${h.id}:${h.section ?? ""}`}
          item={{ ...h, snippet: withoutTitle(h.snippet, h.title) }}
          show={{ updated: false }}
          note={
            isShown(h) ? (
              <p className="br-shown-above">
                <Badge icon="quote">Shown above</Badge>
              </p>
            ) : undefined
          }
        />
      ))}
    </RowList>
  );
}

/** Nothing typed yet: examples, recent searches and the spaces. */
function SearchStart({ onPick }: { onPick: (q: string) => void }) {
  const { scopes } = useBoot();
  const [recent] = useState(getRecentSearches);
  const spaces = scopes.filter((s) => s.kind !== "project");
  return (
    <EmptyState
      variant="search"
      title="Search your team's knowledge"
      description={
        <div className="br-start">
          <p>Ask a question or type a few words. Results cover articles and findings you can read.</p>
          {recent.length > 0 && (
            <div className="br-start-group">
              <p className="br-start-label">Recent searches</p>
              <div className="br-start-chips">
                {recent.map((r) => (
                  <LinkChip key={r} onClick={() => onPick(r)}>
                    {r}
                  </LinkChip>
                ))}
              </div>
            </div>
          )}
          <div className="br-start-group">
            <p className="br-start-label">Try</p>
            <div className="br-start-chips">
              {EXAMPLE_SEARCHES.map((r) => (
                <LinkChip key={r} onClick={() => onPick(r)}>
                  {r}
                </LinkChip>
              ))}
            </div>
          </div>
          {spaces.length > 0 && (
            <div className="br-start-group">
              <p className="br-start-label">Or browse</p>
              <div className="br-start-chips">
                {spaces.map((s) => (
                  <LinkChip key={s.slug} href={href(`/scope/${s.slug}`)}>
                    {s.kind === "personal" ? SCOPE_KIND.personal : s.name}
                  </LinkChip>
                ))}
              </div>
            </div>
          )}
        </div>
      }
    />
  );
}

// ---- Folder tree (spaces and the project Pages tab) ------------------------------------------------------------

interface FolderNode {
  name: string;
  path: string;
  articles: Folder["articles"];
  folders: FolderNode[];
  total: number;
}

function buildTree(f: Folder, name = "", path = ""): FolderNode {
  const folders = Object.entries(f.folders).map(([n, sub]) => buildTree(sub, n, path ? `${path}/${n}` : n));
  return { name, path, articles: f.articles, folders, total: f.articles.length + folders.reduce((n, x) => n + x.total, 0) };
}

/** Keeps articles whose title matches, and folders that match by name or hold a match. */
function filterTree(node: FolderNode, needle: string): FolderNode | null {
  if (!needle) return node;
  if (node.path && node.name.toLowerCase().includes(needle)) return node;
  const articles = node.articles.filter((a) => a.title.toLowerCase().includes(needle));
  const folders = node.folders.map((f) => filterTree(f, needle)).filter((f): f is FolderNode => !!f);
  if (!articles.length && !folders.length) return null;
  return { ...node, articles, folders, total: articles.length + folders.reduce((n, x) => n + x.total, 0) };
}

const folderDomId = (path: string) => `br-folder-${encodeURIComponent(path).replace(/%/g, "_")}`;

function ArticleRows({ articles, label }: { articles: Folder["articles"]; label: string }) {
  return (
    <RowList label={label} density="compact">
      {articles.map((a) => (
        <ItemRow key={a.id} density="compact" item={{ kind: "article", id: a.id, title: a.title, type: a.type, status: a.status }} show={{ location: false, updated: false }} />
      ))}
    </RowList>
  );
}

/**
 * Pages of a space or project: top-level articles first, then each folder (collapsible, with its count). A folder
 * with no articles of its own keeps its heading. `focus` (?folder=) expands that folder and scrolls to it.
 */
function FolderTree({
  tree,
  filter,
  focus,
  canMove,
  onMove,
}: {
  tree: Folder;
  filter: string;
  focus: string;
  canMove: boolean;
  onMove: (folder: string) => void;
}) {
  const root = useMemo(() => buildTree(tree), [tree]);
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => filterTree(root, needle), [root, needle]);
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const ref = useRef<HTMLDivElement>(null);
  useArrowRows(ref);

  useEffect(() => {
    if (!focus) return;
    setClosed((c) => {
      const next = new Set(c);
      const parts = focus.split("/");
      for (let i = 1; i <= parts.length; i++) next.delete(parts.slice(0, i).join("/"));
      return next;
    });
    const t = setTimeout(() => document.getElementById(folderDomId(focus))?.scrollIntoView({ block: "start", behavior: "smooth" }), 50);
    return () => clearTimeout(t);
  }, [focus, root]);

  if (!shown) return <EmptyState variant="compact" icon="search" title={`No pages match “${filter.trim()}”`} />;

  const toggle = (path: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const block = (node: FolderNode, depth: number): ReactNode => {
    const open = !!needle || !closed.has(node.path);
    const bodyId = `${folderDomId(node.path)}-body`;
    return (
      <div key={node.path} className="br-folder" id={folderDomId(node.path)} data-focus={node.path === focus || undefined} style={{ ["--br-depth" as string]: depth }}>
        <GroupHeader
          label={node.name}
          count={node.total}
          open={open}
          onToggle={() => toggle(node.path)}
          controls={bodyId}
          action={
            canMove ? (
              <OverflowMenu
                label={`Actions for the folder ${node.name}`}
                size="sm"
                items={[{ id: "move", label: "Move or make a project…", icon: "move", hint: "Move this folder into a project, or make it a project", onSelect: () => onMove(node.path) }]}
              />
            ) : undefined
          }
        />
        {open && (
          <div id={bodyId} className="br-folder-body">
            {node.articles.length > 0 && <ArticleRows articles={node.articles} label={node.path.split("/").join(" / ")} />}
            {node.folders.map((f) => block(f, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="br-tree" ref={ref}>
      {shown.articles.length > 0 && <ArticleRows articles={shown.articles} label="Pages at the top level" />}
      {shown.folders.map((f) => block(f, 0))}
    </div>
  );
}

/** The folder tree plus its filter and the Move dialog, for spaces and the project Pages tab. */
function PagesTree({
  slug,
  scope,
  me,
  scopes,
  focus,
  filter,
  onFilter,
  onMoved,
}: {
  slug: string;
  scope: ScopeInfo | undefined;
  me: Me;
  scopes: ScopeInfo[];
  focus: string;
  filter: string;
  onFilter: (v: string) => void;
  /** Refetch what the page shows beside the tree (tab counts, findings, repository cards) after a move. */
  onMoved?: () => void;
}) {
  const boot = useBoot();
  const toast = useToast();
  const tree = useApi<{ tree: Folder }>(`/scopes/${encodeURIComponent(slug)}/tree`);
  const [moving, setMoving] = useState<string | null>(null);
  const canMove = can.moveFrom(scope, me);
  const count = tree.data ? buildTree(tree.data.tree).total : 0;
  return (
    <div className="br-pages">
      {count > 0 && (
        <div className="br-filter">
          <SearchInput value={filter} onChange={onFilter} label="Filter pages" placeholder="Filter pages by title or folder" debounceMs={150} />
        </div>
      )}
      <AsyncBlock
        result={tree}
        label="Loading pages"
        skeleton={<SkeletonRows count={6} density="compact" />}
        errorTitle="The pages didn't load"
        isEmpty={(d) => buildTree(d.tree).total === 0}
        empty={
          <EmptyState
            title="No pages here yet"
            description="Articles you write here appear in this list, grouped by folder."
            primary={
              <Button icon="doc" href={href("/new/article", { scope: slug })}>
                New article
              </Button>
            }
          />
        }
      >
        {(d) => <FolderTree tree={d.tree} filter={filter} focus={focus} canMove={canMove} onMove={setMoving} />}
      </AsyncBlock>
      <Dialog open={moving !== null} onClose={() => setMoving(null)} title={`Move the folder “${moving ?? ""}”`} size="lg">
        {moving !== null && (
          <MoveFolder
            from={slug}
            folder={moving}
            scopes={scopes}
            me={me}
            onCancel={() => setMoving(null)}
            onDone={() => {
              const folder = moving;
              setMoving(null);
              tree.reload();
              onMoved?.();
              void boot.reloadScopes();
              toast.success(`Moved the folder “${folder}”`);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// ---- Space page (Team space, Library, Personal space; also a project's "All articles") -----------------------

type RepoPage = { kind: "article" | "finding"; id: string; title: string; type: string; status: string; path: string };

interface ProjectPagesT {
  repositories: { slug: string; kind: string; repo_url: string | null; description: string; pages: RepoPage[] }[];
  other: RepoPage[];
}

/** Every distinct page in /projects/:slug/pages (an item tagged with two repositories appears once). */
function allPages(d: ProjectPagesT | null): RepoPage[] {
  if (!d) return [];
  const seen = new Map<string, RepoPage>();
  for (const p of [...d.other, ...d.repositories.flatMap((r) => r.pages)]) if (!seen.has(p.id)) seen.set(p.id, p);
  return [...seen.values()];
}

function NotFoundState({ what }: { what: string }) {
  return (
    <Page width="content">
      <PageHeader title={`${what} not found`} />
      <EmptyState
        icon="search"
        title={`This ${what.toLowerCase()} doesn't exist, or you can't see it`}
        description="It may have been moved, renamed or made members-only. Ask its Project admins for access."
        primary={
          <Button variant="primary" href="#/">
            Go to Home
          </Button>
        }
      />
    </Page>
  );
}

export function ScopePage({ slug, scopes, me }: { slug: string; scopes: ScopeInfo[]; me: Me }) {
  const route = useAppRoute();
  const [qs, setQs] = useQueryState(route, { tab: "pages" });
  const scope = scopes.find((s) => s.slug === slug);
  const tab = qs.tab === "findings" ? "findings" : "pages";
  const pages = useApi<ProjectPagesT>(scope ? `/projects/${encodeURIComponent(slug)}/pages` : null);
  const doExport = useExport(slug);
  if (!scope) return <NotFoundState what="Space" />;

  const personal = scope.kind === "personal";
  const all = allPages(pages.data);
  const findings = all.filter((p) => p.kind === "finding");
  const articleCount = all.length - findings.length;
  // A project's "All articles" view sits under the project; spaces are titled with their name.
  const name = personal ? SCOPE_KIND.personal! : scope.kind === "project" ? "All articles" : scope.name || slug;
  const manage = can.manageScope(scope);
  const emptyPersonal = personal && pages.data && all.length === 0;

  return (
    <Page width="content">
      <PageHeader
        title={name}
        icon={SCOPE_ICON[scope.kind] ?? "folder"}
        description={scope.description || undefined}
        scope={slug}
        crumbs={
          scope.kind === "project" ? [{ label: scope.name, href: href(`/project/${slug}`), switcher: projectSwitcher(scopes, slug, (s) => href(`/scope/${s}`)) }] : undefined
        }
        primary={<SplitButton label="New article" icon="doc" href={href("/new/article", { scope: slug })} menu={newMenu(slug)} menuLabel="More ways to add" />}
        actions={
          personal ? undefined : (
            <>
              <WatchButton id={scope.id} iconOnly="phone" />
              <FavouriteButton id={scope.id} iconOnly="phone" />
            </>
          )
        }
        menu={[
          { id: "settings", label: manage ? "Settings" : "Who has access", icon: manage ? "settings" : "team", href: href(`/scope/${slug}/settings`) },
          ...(personal ? [] : [{ id: "design", label: "Design system", icon: "sliders" as const, href: href(`/scope/${slug}/design`) }]),
          { id: "graph", label: "Open in graph", icon: "graph", href: href("/graph", { scope: slug }) },
          { id: "export", label: "Export as Markdown", icon: "download", onSelect: doExport },
        ]}
        tabs={
          emptyPersonal ? undefined : (
            <Tabs
              label="Sections"
              value={tab}
              items={[
                { id: "pages", label: "Pages", count: pages.data ? articleCount : undefined, href: href(`/scope/${slug}`) },
                { id: "findings", label: "Findings", count: pages.data ? findings.length : undefined, href: href(`/scope/${slug}`, { tab: "findings" }) },
              ]}
            />
          )
        }
      />
      {emptyPersonal ? (
        <EmptyState
          icon="user"
          title="Your personal space is empty"
          description="Notes here are only visible to you, and Claude can read them from any project."
          primary={
            <Button icon="doc" href={href("/new/article", { scope: slug })}>
              New article
            </Button>
          }
          secondary={
            <Button icon="bolt" href={href("/new/finding", { scope: slug })}>
              New finding
            </Button>
          }
        />
      ) : tab === "pages" ? (
        <PagesTree slug={slug} scope={scope} me={me} scopes={scopes} focus={qs.folder ?? ""} filter={qs.filter ?? ""} onFilter={(v) => setQs({ filter: v || undefined })} onMoved={pages.reload} />
      ) : (
        <AsyncBlock
          result={pages}
          label="Loading findings"
          skeleton={<SkeletonRows count={4} />}
          errorTitle="The findings didn't load"
          isEmpty={() => findings.length === 0}
          empty={
            <EmptyState
              icon="bolt"
              title="No findings here yet"
              description="Findings record what happened: incidents, root causes, known issues and data gotchas."
              primary={
                <Button icon="bolt" href={href("/new/finding", { scope: slug })}>
                  New finding
                </Button>
              }
            />
          }
        >
          {() => (
            <RowList label="Findings">
              {findings.map((f) => (
                <ItemRow key={f.id} item={{ kind: "finding", id: f.id, title: f.title, type: f.type, status: f.status }} show={{ location: false, updated: false }} />
              ))}
            </RowList>
          )}
        </AsyncBlock>
      )}
    </Page>
  );
}
ScopePage.keepMountedOnQuery = true;

// ---- Project page ----------------------------------------------------------------------------------------------

interface ProjectContext {
  project: { id: string; slug: string; name: string; description: string };
  component: { slug: string; kind: string } | null;
  components: { slug: string; kind: string; repo_url: string | null }[];
  open_impact_notices: (NoticeT & { source_title: string })[];
  overview: { id: string; title: string; body_md: string } | null;
  contracts?: { provides: { id: string; title: string; version: number }[]; consumes: { id: string; title: string; version: number }[] };
  recent_records: { id: string; title: string; type: string; status: string; updated_at: string }[];
  uses: { kind: string; id: string; title: string; type: string; scope: string; scope_kind: string }[];
  open_known_issues: { id: string; title: string; status: string; updated_at: string }[];
  hierarchy?: { path: { slug: string; name: string; readable: boolean }[]; sub_projects: { slug: string; name: string; sub_projects: number }[] };
  /** Databases the project is connected to (connections with schema sync). */
  data_sources?: { connections: { name: string; kind: string; health: string; tables: number }[] };
}

/**
 * The first ~600 characters, cut at a paragraph or line break when there is one. Headings become bold lines so
 * the excerpt reads as a summary inside its card.
 */
function excerpt(source: string, max = 600): { text: string; cut: boolean } {
  const md = source.replace(/^#{1,6}\s+(.+?)\s*#*\s*$/gm, "**$1**");
  if (md.length <= max) return { text: md, cut: false };
  const para = md.lastIndexOf("\n\n", max);
  const line = md.lastIndexOf("\n", max);
  const at = para > max / 3 ? para : line > max / 3 ? line : max;
  return { text: md.slice(0, at).trimEnd() + (at === max ? "…" : ""), cut: true };
}

export function ProjectPage({ slug, route, me, scopes = [] }: { slug: string; route: Route; me: Me; scopes?: ScopeInfo[] }) {
  const info = scopes.find((s) => s.slug === slug);
  const [qs, setQs] = useQueryState(route, { tab: "overview" });
  const component = qs.component || undefined;
  const path = `/projects/${encodeURIComponent(slug)}/context${component ? `?component=${encodeURIComponent(component)}` : ""}`;
  const ctx = useApi<ProjectContext>(path);
  const pages = useApi<ProjectPagesT>(`/projects/${encodeURIComponent(slug)}/pages`);
  useLiveRefresh(() => {
    ctx.reload();
    pages.reload();
  });
  const doExport = useExport(slug);
  const data = ctx.data;
  // ADDENDUM-roles §3.1: these project-page gates stay `can_manage || admin`.
  const manage = (!!info && can.manageScope(info)) || me.admin;
  const subs = data?.hierarchy?.sub_projects ?? [];
  const showSubs = subs.length > 0 || manage;
  const pageCount = allPages(pages.data).length;
  const dataTables = data?.data_sources?.connections.reduce((n, c) => n + c.tables, 0);
  const showData = !!data?.data_sources;
  const tab = qs.tab === "pages" && !component ? "pages" : qs.tab === "sub" && showSubs ? "sub" : qs.tab === "data" && (showData || !data) && !component ? "data" : "overview";
  const name = data?.project.name ?? info?.name ?? slug;
  const id = info?.id ?? data?.project.id;
  const components = data?.components ?? info?.components ?? [];
  const nonDefaultVisibility = info && info.visibility !== (me.default_project_visibility ?? "members");

  const crumbs: Crumb[] = (data?.hierarchy?.path ?? []).map((p) => (p.readable ? { label: p.name, href: href(`/project/${p.slug}`) } : { label: p.name, muted: true }));
  // The project's own crumb carries the switcher (to another project's home), as on its other pages.
  const switcher = projectSwitcher(scopes, slug, (s) => href(`/project/${s}`));
  if (switcher) crumbs.push({ label: name, href: href(`/project/${slug}`), switcher });
  const tabHref = (t: string) => href(`/project/${slug}`, { ...(t === "overview" ? {} : { tab: t }), ...(component && t === "overview" ? { component } : {}) });

  return (
    <Page width="content">
      <PageHeader
        title={name}
        icon="folder"
        crumbs={crumbs.length ? crumbs : undefined}
        description={(data?.project.description ?? info?.description) || undefined}
        scope={slug}
        meta={
          (nonDefaultVisibility || components.length > 0) && (
            <>
              {nonDefaultVisibility && <StatusBadge domain="visibility" value={info!.visibility} />}
              {components.length > 0 && <span>{plural(components.length, "repository", "repositories")}</span>}
            </>
          )
        }
        primary={
          <SplitButton
            label="New article"
            icon="doc"
            href={href("/new/article", { scope: slug })}
            menuLabel="More ways to add"
            menu={newMenu(
              slug,
              manage ? [{ id: "sub", label: "Add sub-project", icon: "folder-plus", hint: `Part of ${name}, with its own members`, href: href("/new/project", { parent: slug }) }] : [],
            )}
          />
        }
        actions={
          id ? (
            <>
              <WatchButton id={id} iconOnly="phone" />
              <FavouriteButton id={id} iconOnly="phone" />
            </>
          ) : undefined
        }
        menu={[
          { id: "settings", label: manage ? "Settings" : "Who has access", icon: manage ? "settings" : "team", href: href(`/scope/${slug}/settings`) },
          ...(manage ? [{ id: "repos", label: "Manage repositories", icon: "git-branch" as const, href: href(`/scope/${slug}/settings`, { tab: "repos" }) }] : []),
          { id: "design", label: "Design system", icon: "sliders" as const, href: href(`/scope/${slug}/design`) },
          { id: "pulls", label: "Pull requests", icon: "git-branch" as const, href: href(`/scope/${slug}/pulls`) },
          { id: "brief", label: "What happened lately", icon: "clock" as const, href: href(`/project/${slug}/brief`) },
          { id: "all", label: "All articles", icon: "doc", href: href(`/scope/${slug}`) },
          { id: "graph", label: "Open in graph", icon: "graph", href: href("/graph", { scope: slug }) },
          { id: "export", label: "Export as Markdown", icon: "download", onSelect: doExport },
        ]}
        tabs={
          <Tabs
            label="Project sections"
            value={tab}
            items={[
              { id: "overview", label: "Overview", href: tabHref("overview") },
              { id: "pages", label: "Pages", count: pages.data ? pageCount : undefined, href: tabHref("pages"), hidden: !!component },
              { id: "sub", label: "Sub-projects", count: subs.length, href: tabHref("sub"), hidden: !showSubs },
              { id: "data", label: "Data", count: dataTables, href: tabHref("data"), hidden: !showData || !!component },
            ]}
          />
        }
      />
      {!data ? (
        ctx.error ? (
          <ErrorState error={ctx.error} title="This project didn't load" onRetry={ctx.reload} />
        ) : (
          <div className="br-stack" aria-busy="true">
            <span className="sr-only" role="status">
              Loading the project
            </span>
            <SkeletonRows count={2} />
            <SkeletonCard />
            <SkeletonRows count={3} density="compact" />
          </div>
        )
      ) : tab === "pages" ? (
        <ProjectPages
          slug={slug}
          info={info}
          me={me}
          scopes={scopes}
          manage={manage}
          pages={pages}
          qs={qs}
          setQs={setQs}
          onMoved={() => {
            pages.reload();
            ctx.reload();
          }}
        />
      ) : tab === "data" ? (
        <DataView slug={slug} table={qs.table || undefined} api={qs.api || undefined} onTable={(t) => setQs({ table: t, api: undefined }, { push: true })} onApi={(a) => setQs({ api: a, table: undefined }, { push: true })} />
      ) : tab === "sub" ? (
        <SubProjects name={name} slug={slug} subs={subs} scopes={scopes} manage={manage} />
      ) : (
        <>
          <ProjectOverview
            slug={slug}
            data={data}
            refreshing={ctx.loading}
            reload={ctx.reload}
            error={ctx.error}
            component={component}
            onComponent={(c) => setQs({ component: c || undefined })}
            canEdit={can.inScope(info, "propose", me)}
          />
          <ArchitectureCard slug={slug} />
          <WhoKnows project={slug} component={component || undefined} />
        </>
      )}
    </Page>
  );
}
ProjectPage.keepMountedOnQuery = true;

function ProjectOverview({
  slug,
  data,
  refreshing,
  reload,
  error,
  component,
  onComponent,
  canEdit,
}: {
  slug: string;
  data: ProjectContext;
  refreshing: boolean;
  reload: () => void;
  error: unknown;
  component?: string;
  onComponent: (c: string) => void;
  /** Propose in this project: may suggest an edit to the overview. */
  canEdit: boolean;
}) {
  const toast = useToast();
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, unknown>>({});
  const notices = data.open_impact_notices.filter((n) => !handled.has(n.id));
  const overview = data.overview ? excerpt(data.overview.body_md) : null;

  async function ack(id: string) {
    setBusy(id);
    setFailed(({ [id]: _, ...rest }) => rest);
    try {
      await api(`/notices/${id}/ack`, { method: "POST" });
      setHandled((h) => new Set(h).add(id));
      toast.success("Marked as handled");
      reload();
    } catch (e) {
      setFailed((f) => ({ ...f, [id]: e }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="br-stack" aria-busy={refreshing || undefined}>
      {error ? <ErrorState compact error={error} title="Couldn't refresh" onRetry={reload} /> : null}
      {(data.components.length > 0 || component) && (
        <div className="br-toolbar">
          <label className="br-inline-field">
            <span className="br-inline-label">Repository</span>
            <Select
              value={component ?? ""}
              onChange={(e) => onComponent(e.target.value)}
              options={[{ value: "", label: "All repositories" }, ...data.components.map((c) => ({ value: c.slug, label: c.slug === c.kind ? c.slug : `${c.slug} (${labelFrom(REPO_KIND, c.kind).toLowerCase()})` }))]}
            />
          </label>
          {component && <span className="muted small">Showing what concerns {component}, plus what applies to the whole project.</span>}
        </div>
      )}

      {notices.length > 0 && (
        <Section title="Changes from other teams" count={notices.length} description="Another team changed something this project depends on. Check it, then mark it as handled.">
          <RowList label="Changes from other teams">
            {notices.map((n) => (
              <ListRow
                key={n.id}
                leading={
                  <span className="br-notice-icon">
                    <I name="alert" size={16} />
                  </span>
                }
                title={n.summary}
                meta={
                  <span className="br-meta">
                    <a href={href(`/article/${n.source_id}`)}>{n.source_title}</a>
                    <span aria-hidden="true"> · </span>
                    <span>version {n.source_version}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{n.component ? `For ${n.component}` : "Whole project"}</span>
                    <span aria-hidden="true"> · </span>
                    <RelativeTime date={n.created_at} />
                  </span>
                }
                error={failed[n.id] ? <ErrorText error={failed[n.id]} /> : undefined}
                trailing={
                  <Button size="sm" loading={busy === n.id} loadingText="Marking as handled" onClick={() => void ack(n.id)}>
                    Mark as handled
                  </Button>
                }
              />
            ))}
          </RowList>
        </Section>
      )}

      {data.overview && overview ? (
        <Card
          as="section"
          titleLevel={2}
          title={<a href={href(`/article/${data.overview.id}`)}>{data.overview.title}</a>}
          className="br-overview"
          footer={
            <>
              <Button size="sm" href={href(`/article/${data.overview.id}`)}>
                {overview.cut ? "Read full overview" : "Open overview"}
              </Button>
              {canEdit && (
                <Button size="sm" variant="ghost" icon="pencil" href={href(`/article/${data.overview.id}/edit`)}>
                  Edit
                </Button>
              )}
            </>
          }
        >
          <div className="br-overview-body">
            <Markdown text={overview.text} />
          </div>
        </Card>
      ) : (
        <EmptyState
          icon="doc"
          title="No project overview yet"
          description="An overview says what the project is, its goals and its parts. It's the first thing people and Claude read."
          primary={
            <Button icon="pencil" href={href("/new/article", { scope: slug, type: "project_overview" })}>
              Write the overview
            </Button>
          }
        />
      )}

      <div className="br-grid-2">
        <Section title="Decisions and designs" count={data.recent_records.length || undefined}>
          {data.recent_records.length ? (
            <RowList label="Decisions and designs" density="compact">
              {data.recent_records.map((r) => (
                <ItemRow key={r.id} density="compact" item={{ kind: "article", ...r }} show={{ location: false, updated: false }} />
              ))}
            </RowList>
          ) : (
            <EmptyState
              variant="compact"
              icon="doc"
              title="No decisions yet"
              description="Record what was decided and why, so nobody has to ask again."
              primary={
                <Button size="sm" href={href("/new/article", { scope: slug, type: "decision" })}>
                  Record a decision
                </Button>
              }
            />
          )}
        </Section>
        <Section title="Shared items this project uses" count={data.uses.length || undefined}>
          {data.uses.length ? (
            <RowList label="Shared items this project uses" density="compact">
              {data.uses.map((u) => (
                <ItemRow
                  key={u.id}
                  density="compact"
                  item={{ kind: u.kind === "finding" ? "finding" : "article", id: u.id, title: u.title, type: u.type, scope: { slug: u.scope, kind: u.scope_kind } }}
                  show={{ updated: false }}
                />
              ))}
            </RowList>
          ) : (
            <EmptyState variant="compact" icon="link" title="Nothing linked yet" description="Link a Library pattern, design or contract from an article here and it shows up in this list." />
          )}
        </Section>
      </div>

      {data.contracts && (
        <Section title="Contracts">
          <div className="br-grid-2">
            <ContractList title="Provides" items={data.contracts.provides} />
            <ContractList title="Consumes" items={data.contracts.consumes} />
          </div>
        </Section>
      )}

      <Section title="Open known issues" count={data.open_known_issues.length || undefined}>
        {data.open_known_issues.length ? (
          <RowList label="Open known issues" density="compact">
            {data.open_known_issues.map((k) => (
              <ItemRow key={k.id} density="compact" item={{ kind: "finding", id: k.id, title: k.title, status: k.status, updated_at: k.updated_at }} show={{ location: false }} />
            ))}
          </RowList>
        ) : (
          <EmptyState variant="compact" icon="check-circle" title="No open known issues" />
        )}
      </Section>

      <div className="br-security">
        <ProjectSecurity project={slug} component={component} />
      </div>
    </div>
  );
}

function ErrorText({ error }: { error: unknown }) {
  return <>Couldn't mark it as handled. {humanizeError(error).title}</>;
}

function ContractList({ title, items }: { title: string; items: { id: string; title: string; version: number }[] }) {
  return (
    <Section title={title} level={3}>
      {items.length ? (
        <RowList label={title} density="compact">
          {items.map((c) => (
            <ListRow key={c.id} title={`${c.title} (v${c.version})`} href={href(`/article/${c.id}`)} />
          ))}
        </RowList>
      ) : (
        <p className="muted">None yet.</p>
      )}
    </Section>
  );
}

/** Pages tab: a card per repository (or the folder tree), so nothing hides in a flat list. */
function ProjectPages({
  slug,
  info,
  me,
  scopes,
  manage,
  pages,
  qs,
  setQs,
  onMoved,
}: {
  slug: string;
  info: ScopeInfo | undefined;
  me: Me;
  scopes: ScopeInfo[];
  manage: boolean;
  pages: ReturnType<typeof useApi<ProjectPagesT>>;
  qs: Record<string, string>;
  setQs: (p: Record<string, string | undefined>) => void;
  onMoved?: () => void;
}) {
  const group = qs.folder || qs.group === "folders" ? "folders" : "repos";
  return (
    <div className="br-stack">
      <div className="br-toolbar">
        <SegmentedControl
          label="Group pages by"
          labelVisible
          value={group}
          onChange={(v) => setQs({ group: v === "folders" ? "folders" : undefined, folder: undefined })}
          options={[
            { value: "repos", label: "Repository", icon: "git-branch" },
            { value: "folders", label: "Folder", icon: "folder" },
          ]}
        />
        {manage && (
          <Button size="sm" variant="ghost" icon="settings" href={href(`/scope/${slug}/settings`, { tab: "repos" })}>
            Manage repositories
          </Button>
        )}
      </div>
      {group === "folders" ? (
        <PagesTree slug={slug} scope={info} me={me} scopes={scopes} focus={qs.folder ?? ""} filter={qs.filter ?? ""} onFilter={(v) => setQs({ filter: v || undefined })} onMoved={onMoved} />
      ) : (
        <AsyncBlock
          result={pages}
          label="Loading pages"
          skeleton={
            <div className="br-repo-grid">
              <SkeletonCard />
              <SkeletonCard />
            </div>
          }
          errorTitle="The pages didn't load"
          isEmpty={(d) => !d.repositories.length && !d.other.length}
          empty={
            <EmptyState
              title="No pages yet"
              description="Articles and findings written in this project appear here, grouped by the repository they're about."
              primary={
                <Button icon="doc" href={href("/new/article", { scope: slug })}>
                  New article
                </Button>
              }
            />
          }
        >
          {(d) => (
            <div className="br-repo-grid">
              {d.repositories.map((r) => (
                <RepoCard
                  key={r.slug}
                  title={r.slug}
                  link={href(`/project/${slug}`, { component: r.slug })}
                  sub={[r.kind && r.kind !== r.slug ? labelFrom(REPO_KIND, r.kind) : "", r.description].filter(Boolean).join(" · ")}
                  pages={r.pages}
                />
              ))}
              {d.other.length > 0 && <RepoCard title="Whole project" sub="Not about one repository" pages={d.other} />}
            </div>
          )}
        </AsyncBlock>
      )}
    </div>
  );
}

function RepoCard({ title, sub, link, pages }: { title: string; sub?: string; link?: string; pages: RepoPage[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? pages : pages.slice(0, 6);
  return (
    <Card
      title={link ? <a href={link}>{title}</a> : title}
      description={
        <>
          {sub && <span>{sub} · </span>}
          <span>{plural(pages.length, "page")}</span>
        </>
      }
      padding="sm"
    >
      {pages.length ? (
        <ul className="br-page-list">
          {shown.map((p) => (
            <li key={p.id}>
              <a href={href(`/${p.kind}/${p.id}`)}>{p.title}</a>
              <span className="br-page-meta">{p.kind === "finding" ? typeLabel(p.type) : p.path ? p.path.split("/").join(" / ") : typeLabel(p.type)}</span>
              {!statusMeta("item", p.status).hiddenInLists && <StatusBadge domain="item" value={p.status} />}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No pages yet.</p>
      )}
      {pages.length > 6 && (
        <button type="button" className="link-btn br-show-all" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${pages.length}`}
        </button>
      )}
    </Card>
  );
}

function SubProjects({ name, slug, subs, scopes, manage }: { name: string; slug: string; subs: { slug: string; name: string; sub_projects: number }[]; scopes: ScopeInfo[]; manage: boolean }) {
  return (
    <Section
      title="Sub-projects"
      count={subs.length || undefined}
      actions={
        manage ? (
          <Button size="sm" icon="folder-plus" href={href("/new/project", { parent: slug })}>
            Add sub-project
          </Button>
        ) : undefined
      }
    >
      {subs.length ? (
        <div className="br-sub-grid">
          {subs.map((c) => {
            const s = scopes.find((x) => x.slug === c.slug);
            return (
              <Card
                key={c.slug}
                href={href(`/project/${c.slug}`)}
                title={c.name}
                padding="sm"
                description={
                  <>
                    {s?.description && <span className="br-sub-desc">{s.description}</span>}
                    <span className="br-sub-meta">
                      <span className="br-mono">{c.slug}</span>
                      {c.sub_projects ? ` · ${plural(c.sub_projects, "sub-project")}` : ""}
                    </span>
                  </>
                }
              />
            );
          })}
        </div>
      ) : (
        <EmptyState
          variant="compact"
          icon="folder"
          title="No sub-projects yet"
          description={`Split a product into its services or apps; members of ${name} get their roles in each.`}
          primary={
            manage ? (
              <Button size="sm" icon="folder-plus" href={href("/new/project", { parent: slug })}>
                Add sub-project
              </Button>
            ) : undefined
          }
        />
      )}
    </Section>
  );
}

/** The project's repositories and the contracts between them (and other projects), drawn from what Thaliyola knows. */
function ArchitectureCard({ slug }: { slug: string }) {
  const { data } = useApi<{ mermaid: string; repositories: string[]; contracts: number; note: string }>(`/scopes/${encodeURIComponent(slug)}/architecture`);
  if (!data || !data.repositories.length || (!data.contracts && data.repositories.length < 2)) return null;
  return (
    <Section title="Architecture" description="Repositories and the contracts between them, from what Thaliyola knows. Docs runs start their architecture page from this.">
      <div className="br-architecture">
        <MermaidDiagram code={data.mermaid} />
      </div>
    </Section>
  );
}

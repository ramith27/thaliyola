/**
 * The app shell (SPEC §2.2–§2.10, §6.1.2): skip link and landmarks, the sidebar (fixed header with New, scrolling
 * body, fixed footer), the top bar (search trigger, Help, bell, user menu), the phone tab bar, drawer and Create
 * sheet, nav counts, page meta (document title, highlight, phone title, hideTabBar), global shortcuts, the shortcut
 * sheet, the glossary and the route announcer.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { api, authApi, type Folder, type Me, type ScopeInfo } from "../api";
import { openShellPanel, remountPage, useApi, useMediaQuery, useShellPanelRequests, useShortcutRegistry, useShortcuts, useSingleKeyShortcuts } from "../hooks";
import { href, navigate, type Route } from "../router";
import { getTheme, setTheme, type Theme } from "../theme";
import { documentTitle, hashPath, useCurrentPageMeta } from "./boot";
import { favouriteLink, SearchOverlay, SearchTrigger, useFavourites, useRecent } from "./find";
import { I, type IconName } from "./icons";
import { GLOSSARY, orgRoleLine, plural, SCOPE_ICON } from "./labels";
import {
  adminEntry,
  CREATE_ACTIONS,
  createContextLine,
  EXPLORE_NAV,
  FOOTER_NAV,
  navIdForRoute,
  PRIMARY_NAV,
  USER_MENU,
  visible,
  type AdminTabId,
  type NavContext,
  type NavId,
  type NavItem,
} from "./nav";
import { can } from "./permissions";
import { treeOrder } from "./tree";
import { NotificationBell } from "./notifications";
import { Button, IconButton } from "./kit/button";
import { Avatar, Badge, CountBadge, displayName, Kbd } from "./kit/display";
import { useToast } from "./kit/feedback";
import { Switch } from "./kit/form";
import { Dialog, Menu, MenuButton, Sheet, Tooltip, type MenuItemSpec } from "./kit/overlay";
import { AdminTabs } from "./kit/page";
import { AboutDialog } from "./about";
import { aboutLine } from "./releases";

// ---- Small helpers --------------------------------------------------------------------------------------------

/** Per-browser UI memory (open groups). Storage may be missing; the shell works without it. */
function readStore<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}
function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: remembered for this page only */
  }
}

function useStoredState<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [v, setV] = useState<T>(() => readStore(key, fallback));
  const set = useCallback(
    (next: T) => {
      setV(next);
      writeStore(key, next);
    },
    [key],
  );
  return [v, set];
}

/** An open dialog, sheet or popover owns the keyboard: global single keys wait. */
const overlayOpen = () => !!document.querySelector("dialog[open], .popover");

/** The project or space a route belongs to, before the page reports its own (page meta wins). */
export function routeScope(route: Pick<Route, "path" | "query">): string | null {
  const [first, second] = route.path;
  if ((first === "scope" || first === "project") && second) return second;
  if (first === "new" && (second === "article" || second === "finding")) return route.query.get("scope");
  if (first === "import") return route.query.get("scope");
  if (first === "new" && second === "project") return route.query.get("parent");
  return null;
}

// ---- Counts (SPEC §2.8) ------------------------------------------------------------------------------------

export interface NavCounts {
  /** Proposals plus, for people who manage or review skills, skill versions and audience changes (`skills` keeps that part for the tooltip). */
  review: { toReview: number; pending: number; skills?: { toReview: number; pending: number } } | null;
  inbox: number | null;
  /** Open questions addressed to the caller or their sessions. */
  sessions: number | null;
  /** Open incidents in projects the caller can read. */
  incidents: number | null;
  security: number | null;
}

/**
 * Sidebar and tab-bar counts: cheap limit=1 requests, refreshed on every route change, every 60s while the tab is
 * visible, on window focus and on the thaliyola:counts event (refreshCounts()).
 */
/** The Review badge with skill review folded in: versions the caller may approve plus audience changes, and all pending versions plus open problem reports. */
export function withSkillCounts(review: { toReview: number; pending: number }, skills: { to_review: number; pending: number; feedback: number } | null | undefined): NonNullable<NavCounts["review"]> {
  if (!skills) return review;
  const part = { toReview: skills.to_review, pending: skills.pending + skills.feedback };
  return { toReview: review.toReview + part.toReview, pending: review.pending + part.pending, skills: part };
}

export function useNavCounts(routeKey: string, skills = false): NavCounts {
  const [counts, setCounts] = useState<NavCounts>({ review: null, inbox: null, sessions: null, incidents: null, security: null });
  const load = useCallback(async () => {
    const [review, inbox, security, skill, questions, incidents] = await Promise.allSettled([
      api<{ facets?: { to_review?: number; states?: Record<string, number> } }>("/revisions?state=pending&limit=1&facets=true"),
      api<{ counts?: Record<string, number> }>("/inbox?limit=1"),
      api<{ total?: number }>("/vulnerabilities?severity=critical&limit=1"),
      skills ? api<{ to_review: number; pending: number; feedback: number }>("/skills/review/counts") : Promise.resolve(null),
      api<{ questions?: { for_me: boolean }[] }>("/questions?status=open&limit=100"),
      api<{ open?: number }>("/incidents?status=open&limit=20"),
    ]);
    setCounts((c) => ({
      review:
        review.status === "fulfilled"
          ? withSkillCounts({ toReview: review.value.facets?.to_review ?? 0, pending: review.value.facets?.states?.pending ?? 0 }, skill.status === "fulfilled" ? skill.value : null)
          : c.review,
      inbox: inbox.status === "fulfilled" ? (inbox.value.counts?.new ?? 0) : c.inbox,
      sessions: questions.status === "fulfilled" ? (questions.value.questions ?? []).filter((q) => q.for_me).length : c.sessions,
      incidents: incidents.status === "fulfilled" ? (incidents.value.open ?? 0) : c.incidents,
      security: security.status === "fulfilled" ? (security.value.total ?? 0) : c.security,
    }));
  }, [skills]);
  useEffect(() => {
    void load();
  }, [load, routeKey]);
  useEffect(() => {
    const tick = setInterval(() => !document.hidden && void load(), 60_000);
    const on = () => void load();
    window.addEventListener("focus", on);
    window.addEventListener("thaliyola:counts", on);
    return () => {
      clearInterval(tick);
      window.removeEventListener("focus", on);
      window.removeEventListener("thaliyola:counts", on);
    };
  }, [load]);
  return counts;
}

/** Whether Claude has been connected ("Set up" until it has); fetched once per session. */
let connectedCache: boolean | null = null;
function useConnected(): boolean | null {
  const [v, setV] = useState<boolean | null>(() => {
    if (connectedCache !== null) return connectedCache;
    try {
      const s = sessionStorage.getItem("thaliyola.connected");
      return s === null ? null : s === "1";
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (v !== null) return;
    let stale = false;
    api<{ has_connected: boolean }>("/connect-info")
      .then((r) => {
        connectedCache = !!r.has_connected;
        try {
          sessionStorage.setItem("thaliyola.connected", connectedCache ? "1" : "0");
        } catch {
          /* fine */
        }
        if (!stale) setV(connectedCache);
      })
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [v]);
  return v;
}

/** The page's own h1, for pages that don't report page meta yet (document title, phone title, announcer). */
function useHeadingText(mainRef: RefObject<HTMLElement>, path: string): string | null {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const h1 = main.querySelector("h1");
      const t = h1?.textContent?.replace(/\s+/g, " ").trim() || null;
      setText((old) => (old === t ? old : t));
    };
    read();
    const obs = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(read);
    });
    obs.observe(main, { childList: true, subtree: true, characterData: true });
    return () => {
      obs.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [mainRef, path]);
  return text;
}

const ADMIN_TAB_FOR: Record<string, AdminTabId> = { users: "people", roles: "roles", projects: "projects", notifications: "notifications", audit: "audit", system: "system" };

// ---- Layout ----------------------------------------------------------------------------------------------------

export function Layout({ me, scopes, route, children }: { me: Me; scopes: ScopeInfo[]; route: Route; children: ReactNode }) {
  const phone = useMediaQuery("(max-width: 860px)");
  const meta = useCurrentPageMeta();
  const path = hashPath();
  const first = route.path[0];
  const routeKey = route.path.join("/") + "?" + route.query.toString();
  const toast = useToast();

  const [overlay, setOverlay] = useState<{ open: boolean; query?: string }>({ open: false });
  const [createMenu, setCreateMenu] = useState(false);
  const [createSheet, setCreateSheet] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [glossary, setGlossary] = useState(false);
  const [about, setAbout] = useState(false);
  const createBtn = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  // Highlight and context: page meta first, then what the route says.
  const baseCtx: NavContext = useMemo(() => ({ me, scopes }), [me, scopes]);
  const navId: NavId | null = meta?.nav ?? navIdForRoute(path.replace(/^\//, ""), route.query, baseCtx);
  const scopeSlug = meta?.scope ?? routeScope(route);
  const current = scopeSlug ? (scopes.find((s) => s.slug === scopeSlug) ?? null) : null;
  const ctx: NavContext = useMemo(() => ({ me, scopes, current }), [me, scopes, current]);
  const counts = useNavCounts(routeKey, can.reviewSkills(me) || can.manageSkills(me));

  // Titles: PageHeader's report, else the page's h1, else the nav label.
  const heading = useHeadingText(mainRef, path);
  const navLabel = [...PRIMARY_NAV, ...EXPLORE_NAV, ...FOOTER_NAV].find((n) => n.id === navId)?.label;
  const knownTitle = path === "/" ? "Home" : meta?.title || heading || navLabel || current?.name || null;
  const pageTitle = knownTitle ?? "Thaliyola";
  useEffect(() => {
    if (!meta) document.title = documentTitle(knownTitle);
  }, [meta, knownTitle]);

  // The route announcer reads the new page's title once per path change.
  const [announced, setAnnounced] = useState("");
  const lastAnnounced = useRef<string | null>(path);
  useEffect(() => {
    if (lastAnnounced.current === path) return;
    const t = setTimeout(() => {
      lastAnnounced.current = path;
      setAnnounced(pageTitle);
    }, 500);
    return () => clearTimeout(t);
  }, [path, pageTitle]);

  // Focus moves to the new page's h1 after a path change (SPEC §5.5 "Focus"), without a visible ring. It waits up to
  // 3s for the h1 to render, and leaves focus alone when the page (or a dialog) has already taken it, so editors and
  // search fields that focus themselves keep doing so. Query-only changes (tabs, filters) never move focus.
  const lastFocused = useRef<string>(path);
  useEffect(() => {
    if (lastFocused.current === path) return;
    lastFocused.current = path;
    const main = mainRef.current;
    if (!main) return;
    let tries = 0;
    let timer = 0;
    const attempt = () => {
      // Focus left on a shell control (the link, the drawer's Menu button, the search trigger) moves on; focus the
      // page itself placed (an editor's first field, a search box) keeps it. It waits while a dialog (search) is closing.
      const active = document.activeElement;
      if (active && active !== main && main.contains(active)) return;
      const h1 = document.querySelector("dialog[open]") ? null : main.querySelector<HTMLElement>("h1");
      if (h1) {
        if (!h1.hasAttribute("tabindex")) h1.setAttribute("tabindex", "-1");
        h1.focus({ preventScroll: true });
        return;
      }
      if (++tries < 30) timer = window.setTimeout(attempt, 100);
    };
    timer = window.setTimeout(attempt, 50);
    return () => window.clearTimeout(timer);
  }, [path]);

  // Panels close when the route changes.
  useEffect(() => {
    setDrawer(false);
    setCreateSheet(false);
    setCreateMenu(false);
  }, [routeKey]);

  const openSearch = useCallback((query?: string) => setOverlay({ open: true, query }), []);
  const openCreate = useCallback(() => {
    if (window.matchMedia("(max-width: 860px)").matches) setCreateSheet(true);
    else setCreateMenu(true);
  }, []);

  useShellPanelRequests((panel, detail) => {
    if (panel === "search") openSearch(detail.query);
    else if (panel === "create") openCreate();
    else if (panel === "shortcuts") setShortcuts(true);
    else if (panel === "glossary") setGlossary(true);
  });

  // Global keys (SPEC §2.10). ⌘K works everywhere, even in fields; single keys obey the switch and wait for overlays.
  useShortcuts({
    "mod+k": () => setOverlay((o) => (o.open ? { open: false } : { open: true })),
    "/": () => {
      if (overlayOpen()) return;
      const home = document.getElementById("home-search");
      if (home) home.focus();
      else openSearch();
    },
    c: () => !overlayOpen() && openCreate(),
    "?": () => !overlayOpen() && setShortcuts(true),
  });

  async function gettingStarted() {
    try {
      await api("/account/prefs", { method: "PUT", body: { onboarding_dismissed: false } });
      if (path === "/") remountPage();
      else navigate("/");
      toast.success("Setup checklist is back on Home");
    } catch (e) {
      toast.error(e, { title: "Couldn't bring the checklist back" });
    }
  }

  const createItems = useMemo<MenuItemSpec[]>(() => {
    const line = createContextLine(ctx);
    const items: MenuItemSpec[] = visible(CREATE_ACTIONS, ctx).map((a) => ({ id: a.id, label: a.label(ctx), hint: a.hint(ctx), icon: a.icon, href: a.href(ctx) }));
    return line ? [{ type: "group", label: line }, ...items] : items;
  }, [ctx]);

  const searchQuery = first === "search" ? (route.query.get("q") ?? "") : "";
  // Never two search fields: Home has its own; /search has its own once the page reports meta (its PageHeader).
  const showTrigger = path !== "/" && !(first === "search" && meta);
  const hideTabBar = !!meta?.hideTabBar;
  const adminTab = first === "admin" && !route.path[2] && !meta ? (ADMIN_TAB_FOR[route.path[1] ?? ""] ?? "people") : null;

  const newButton = (
    <>
      <button
        ref={createBtn}
        type="button"
        className="btn btn-secondary sidebar-new"
        aria-haspopup="menu"
        aria-expanded={createMenu}
        aria-keyshortcuts="C"
        onClick={() => setCreateMenu((o) => !o)}
      >
        <I name="plus" size={16} />
        <span>New</span>
        <I name="chevron-down" size={16} />
      </button>
      <Menu items={createItems} open={createMenu} onClose={() => setCreateMenu(false)} anchorRef={createBtn} label="Create" className="create-menu" />
    </>
  );

  return (
    <div className="app" data-tabbar={hideTabBar ? "hidden" : undefined}>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          mainRef.current?.focus();
          mainRef.current?.scrollIntoView();
        }}
      >
        Skip to content
      </a>
      {!phone && (
        <aside className="sidebar">
          <Sidebar ctx={ctx} navId={navId} scopeSlug={scopeSlug} route={route} counts={counts} newButton={newButton} />
        </aside>
      )}

      <div className="main">
        <header className="topbar">
          {phone ? (
            <div className="topbar-phone-title">
              {meta?.back && <IconButton icon="chevron-left" label={`Back to ${meta.back.label}`} href={meta.back.href} />}
              {path === "/" ? (
                <a className="brand brand-phone" href="#/">
                  <img src="/favicon.svg" alt="" width={24} height={24} />
                  <span>Thaliyola</span>
                </a>
              ) : (
                <span className="topbar-title">{pageTitle}</span>
              )}
            </div>
          ) : (
            showTrigger && <SearchTrigger query={searchQuery || undefined} onOpen={() => openSearch()} />
          )}
          <div className="topbar-right">
            {!phone && <HelpMenu me={me} onShortcuts={() => setShortcuts(true)} onGlossary={() => setGlossary(true)} onGettingStarted={gettingStarted} onAbout={() => setAbout(true)} />}
            <NotificationBell />
            <UserMenu
              me={me}
              ctx={ctx}
              phone={phone}
              onShortcuts={() => setShortcuts(true)}
              onGlossary={() => setGlossary(true)}
              onGettingStarted={gettingStarted}
              onAbout={() => setAbout(true)}
            />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="content" ref={mainRef}>
          {me.demo && (
            <div className="demo-banner" role="note">
              <strong>Demo.</strong> Everything here is wiped and re-seeded every {me.demo.reset_hours} hours (next at{" "}
              {new Date(me.demo.resets_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}). Try anything; don't put real data here.{" "}
              <a href="https://github.com/ramith27/thaliyola" target="_blank" rel="noopener noreferrer">
                Run your own
              </a>
            </div>
          )}
          {adminTab && (
            <div className="shell-admin-tabs">
              <AdminTabs current={adminTab} />
            </div>
          )}
          {children}
        </main>
      </div>

      {phone && !hideTabBar && (
        <TabBar
          navId={navId}
          counts={counts}
          drawerOpen={drawer}
          whatsNew={!!me.whats_new?.unseen}
          onSearch={() => openSearch()}
          onCreate={() => setCreateSheet(true)}
          onMenu={() => setDrawer(true)}
        />
      )}
      {phone && (
        <Sheet open={drawer} side="left" title="Menu" onClose={() => setDrawer(false)}>
          <div className="drawer">
            <Sidebar
              ctx={ctx}
              navId={navId}
              scopeSlug={scopeSlug}
              route={route}
              counts={counts}
              drawer
              newButton={
                <button
                  type="button"
                  className="btn btn-secondary sidebar-new"
                  aria-haspopup="dialog"
                  onClick={() => {
                    setDrawer(false);
                    setCreateSheet(true);
                  }}
                >
                  <I name="plus" size={16} />
                  <span>New</span>
                </button>
              }
            />
          </div>
        </Sheet>
      )}
      <Sheet open={createSheet} side="bottom" title="Create" description={createContextLine(ctx) ?? undefined} onClose={() => setCreateSheet(false)}>
        <ul className="plain create-sheet">
          {visible(CREATE_ACTIONS, ctx).map((a) => (
            <li key={a.id}>
              <a className="create-sheet-item" href={a.href(ctx)} onClick={() => setCreateSheet(false)}>
                <span className="create-sheet-icon" aria-hidden="true">
                  <I name={a.icon} size={18} />
                </span>
                <span className="create-sheet-text">
                  <span className="create-sheet-label">{a.label(ctx)}</span>
                  <span className="create-sheet-hint">{a.hint(ctx)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </Sheet>

      <SearchOverlay open={overlay.open} initialQuery={overlay.query ?? searchQuery} context={ctx} onClose={() => setOverlay({ open: false })} />
      <ShortcutSheet open={shortcuts} onClose={() => setShortcuts(false)} />
      <GlossaryDialog open={glossary} onClose={() => setGlossary(false)} />
      <AboutDialog open={about} onClose={() => setAbout(false)} me={me} />
      <div id="route-announcer" className="sr-only" aria-live="polite" aria-atomic="true">
        {announced}
      </div>
    </div>
  );
}

// ---- Sidebar (SPEC §2.2) --------------------------------------------------------------------------------------

function Sidebar({
  ctx,
  navId,
  scopeSlug,
  route,
  counts,
  newButton,
  drawer,
}: {
  ctx: NavContext;
  navId: NavId | null;
  scopeSlug: string | null;
  route: Route;
  counts: NavCounts;
  newButton: ReactNode;
  drawer?: boolean;
}) {
  const favourites = useFavourites();
  const recent = useRecent();
  const connected = useConnected();
  const favIds = new Set(favourites.map((f) => f.id));
  const recentOnly = recent.filter((r) => !favIds.has(r.id)).slice(0, 5);
  const [recentOpen, setRecentOpen] = useStoredState("thaliyola.nav.recent", true);
  const scopes = ctx.scopes as ScopeInfo[];
  const spaces = scopes.filter((s) => s.kind !== "project");
  const admin = adminEntry(ctx);
  const currentArticle = route.path[0] === "article" ? route.path[1] : undefined;
  const body = useRef<HTMLDivElement>(null);

  // Locate me: bring the highlighted scope into view inside the sidebar (never scrolls the page).
  useEffect(() => {
    // In the phone drawer the sheet's body scrolls, not the sidebar body.
    const el = drawer ? (body.current?.closest<HTMLElement>(".dialog-body") ?? null) : body.current;
    if (!el || !scopeSlug) return;
    const t = setTimeout(() => {
      const row = el.querySelector<HTMLElement>(`a.nav-link[aria-current="page"]`);
      if (!row) return;
      const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      if (top < el.scrollTop || top + row.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    }, 50);
    return () => clearTimeout(t);
  }, [scopeSlug, drawer]);

  return (
    <nav className="sidebar-nav" aria-label="Primary" data-variant={drawer ? "drawer" : undefined}>
      <div className="sidebar-head">
        {!drawer && (
          <a className="brand" href="#/">
            <img src="/favicon.svg" alt="" width={24} height={24} />
            <span>Thaliyola</span>
          </a>
        )}
        {newButton}
      </div>
      <div className="sidebar-body" ref={body}>
        <ul className="plain nav-list">
          {PRIMARY_NAV.map((item) => (
            <NavRow key={item.id} item={item} active={navId === item.id} counts={counts} />
          ))}
        </ul>
        <NavGroup label="Explore">
          {EXPLORE_NAV.map((item) => (
            <NavRow key={item.id} item={item} active={navId === item.id} counts={counts} />
          ))}
        </NavGroup>
        {favourites.length > 0 && (
          <NavGroup label="Favourites">
            {favourites.map((f) => (
              <li key={f.id}>
                <a className="nav-link" href={favouriteLink(f)} title={f.title}>
                  <I name="star" size={16} />
                  <span className="nav-label">{f.title}</span>
                </a>
              </li>
            ))}
          </NavGroup>
        )}
        <NavGroup label="Spaces">
          {spaces.map((s) => (
            <li key={s.slug}>
              <ScopeLink scope={s} active={scopeSlug === s.slug} me={ctx.me as Me} />
              {scopeSlug === s.slug && (
                <ul className="plain nav-tree nav-tree-sub">
                  <PagesRow slug={s.slug} currentArticle={currentArticle} />
                </ul>
              )}
            </li>
          ))}
        </NavGroup>
        <ProjectsGroup ctx={ctx} scopeSlug={scopeSlug} currentArticle={currentArticle} />
        {recentOnly.length > 0 && (
          <div className="nav-group">
            <button type="button" className="nav-group-toggle" aria-expanded={recentOpen} aria-controls="nav-recent" onClick={() => setRecentOpen(!recentOpen)}>
              <span>Recent</span>
              <I name={recentOpen ? "chevron-down" : "chevron-right"} size={14} />
            </button>
            {recentOpen && (
              <ul className="plain nav-list" id="nav-recent">
                {recentOnly.map((r) => (
                  <li key={r.id}>
                    <a className="nav-link" href={r.link} title={r.title}>
                      <I name="clock" size={16} />
                      <span className="nav-label">{r.title}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="sidebar-foot">
        <ul className="plain nav-list">
          <li>
            <a className="nav-link" href="#/connect" aria-current={navId === "connect" ? "page" : undefined}>
              <I name="plug" size={16} />
              <span className="nav-label">Connect Claude</span>
              {connected === false && <Badge tone="neutral">Set up</Badge>}
            </a>
          </li>
          <li>
            <a className="nav-link" href="#/whats-new" aria-current={navId === "whats-new" ? "page" : undefined}>
              <I name="sparkle" size={16} />
              <span className="nav-label">What's new</span>
              {(ctx.me as Me).whats_new?.unseen && <Badge tone="accent">New</Badge>}
            </a>
          </li>
          <li>
            <a className="nav-link" href="#/guide" aria-current={navId === "guide" ? "page" : undefined}>
              <I name="book" size={16} />
              <span className="nav-label">Guide</span>
            </a>
          </li>
          <li>
            <a className="nav-link" href="#/trash" aria-current={navId === "trash" ? "page" : undefined}>
              <I name="trash" size={16} />
              <span className="nav-label">Trash</span>
            </a>
          </li>
          {admin && (
            <li>
              <a className="nav-link" href={admin.href} aria-current={navId === "admin" ? "page" : undefined}>
                <I name={admin.icon} size={16} />
                <span className="nav-label">{admin.label}</span>
              </a>
            </li>
          )}
        </ul>
      </div>
    </nav>
  );
}

function NavGroup({ label, action, children }: { label: string; action?: ReactNode; children: ReactNode }) {
  const id = `nav-group-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div className="nav-group">
      <div className="nav-group-head">
        <h2 className="nav-title" id={id}>
          {label}
        </h2>
        {action}
      </div>
      <ul className="plain nav-list" aria-labelledby={id}>
        {children}
      </ul>
    </div>
  );
}

/** A top-level item with its count (Review: accent when waiting for you, else neutral; Inbox neutral; Security danger). */
function NavRow({ item, active, counts }: { item: NavItem; active: boolean; counts: NavCounts }) {
  let badge: ReactNode = null;
  let tip: string | null = null;
  if (item.count === "review" && counts.review) {
    const { toReview, pending } = counts.review;
    if (toReview > 0) badge = <CountBadge value={toReview} tone="accent" label={`, ${toReview} waiting for your review`} />;
    else if (pending > 0) badge = <CountBadge value={pending} tone="neutral" label={`, ${plural(pending, "proposal")} pending`} />;
    if (toReview > 0 || pending > 0) tip = `${toReview} waiting for you · ${pending} pending${counts.review.skills && (counts.review.skills.toReview || counts.review.skills.pending) ? ` (skills: ${counts.review.skills.toReview} for you, ${counts.review.skills.pending} pending)` : ""}`;
  } else if (item.count === "inbox" && counts.inbox) {
    badge = <CountBadge value={counts.inbox} tone="neutral" label={`, ${plural(counts.inbox, "new item")}`} />;
  } else if (item.count === "sessions" && counts.sessions) {
    badge = <CountBadge value={counts.sessions} tone="accent" label={`, ${plural(counts.sessions, "question")} waiting for you`} />;
  } else if (item.count === "incidents" && counts.incidents) {
    badge = <CountBadge value={counts.incidents} tone="danger" label={`, ${plural(counts.incidents, "open incident")}`} />;
  } else if (item.count === "security" && counts.security) {
    badge = <CountBadge value={counts.security} tone="danger" label={`, ${plural(counts.security, "critical vulnerability", "critical vulnerabilities")}`} />;
  }
  const link = (
    <a className="nav-link" href={item.href} aria-current={active ? "page" : undefined}>
      <I name={item.icon} size={16} />
      <span className="nav-label">{item.label}</span>
      {badge}
    </a>
  );
  return <li>{tip ? <Tooltip content={tip} describe={false}>{link}</Tooltip> : link}</li>;
}

function ScopeLink({ scope, active, me, depth = 0 }: { scope: ScopeInfo; active: boolean; me: Me; depth?: number }) {
  const icon: IconName = SCOPE_ICON[scope.kind] ?? "folder";
  // A lock or globe only when the visibility differs from the workspace default.
  const marker = scope.kind === "project" && me.default_project_visibility && scope.visibility !== me.default_project_visibility;
  return (
    <a className="nav-link" href={href(scope.kind === "project" ? `/project/${scope.slug}` : `/scope/${scope.slug}`)} aria-current={active ? "page" : undefined} data-depth={depth || undefined}>
      <I name={icon} size={16} />
      <span className="nav-label">{scope.name}</span>
      {marker && (
        <span className="nav-marker">
          <I name={scope.visibility === "members" ? "lock" : "globe"} size={12} />
          <span className="sr-only">{scope.visibility === "members" ? "Members only" : "Everyone"}</span>
        </span>
      )}
    </a>
  );
}

type TreeProject = ScopeInfo & { depth: number; children: number };

/** Projects: disclosure-navigation tree (not an ARIA tree), path to the current scope open, a filter above 10. */
function ProjectsGroup({ ctx, scopeSlug, currentArticle }: { ctx: NavContext; scopeSlug: string | null; currentArticle?: string }) {
  const me = ctx.me as Me;
  const scopes = ctx.scopes as ScopeInfo[];
  const projects = useMemo(() => treeOrder(scopes.filter((s) => s.kind === "project")), [scopes]);
  const bySlug = useMemo(() => new Map(projects.map((p) => [p.slug, p])), [projects]);
  const kids = useMemo(() => {
    const m = new Map<string | null, TreeProject[]>();
    for (const p of projects) {
      const parent = p.parent && bySlug.has(p.parent) ? p.parent : null;
      m.set(parent, [...(m.get(parent) ?? []), p]);
    }
    return m;
  }, [projects, bySlug]);
  const [stored, setStored] = useStoredState<Record<string, boolean>>("thaliyola.nav.open", {});
  const [filter, setFilter] = useState("");

  // The current scope and its ancestors are open by default.
  const onPath = useMemo(() => {
    const s = new Set<string>();
    let at = scopeSlug ? bySlug.get(scopeSlug) : undefined;
    while (at && !s.has(at.slug)) {
      s.add(at.slug);
      at = at.parent ? bySlug.get(at.parent) : undefined;
    }
    return s;
  }, [scopeSlug, bySlug]);

  // Filtering keeps the ancestors of matches visible.
  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return null;
    const keep = new Set<string>();
    for (const p of projects) {
      if (!p.name.toLowerCase().includes(term) && !p.slug.includes(term)) continue;
      let at: TreeProject | undefined = p;
      while (at && !keep.has(at.slug)) {
        keep.add(at.slug);
        at = at.parent ? bySlug.get(at.parent) : undefined;
      }
    }
    return keep;
  }, [filter, projects, bySlug]);

  const isOpen = (slug: string) => (shown ? true : (stored[slug] ?? onPath.has(slug)));
  const toggle = (slug: string) => setStored({ ...stored, [slug]: !isOpen(slug) });
  const canNew = can.newProjectEntry(me, scopes);
  const plusLabel = can.createProject(me) ? "New project" : "New sub-project";

  const renderNodes = (parent: string | null): ReactNode =>
    (kids.get(parent) ?? [])
      .filter((p) => !shown || shown.has(p.slug))
      .map((p) => {
        const active = scopeSlug === p.slug;
        const children = (kids.get(p.slug) ?? []).filter((c) => !shown || shown.has(c.slug));
        const expandable = children.length > 0 || active;
        const open = expandable && isOpen(p.slug);
        const groupId = `nav-proj-${p.slug}`;
        return (
          <li key={p.slug}>
            <div className="nav-tree-row">
              {expandable ? (
                <button
                  type="button"
                  className="nav-disclosure"
                  aria-expanded={open}
                  aria-controls={groupId}
                  aria-label={`${open ? "Collapse" : "Expand"} ${p.name}`}
                  onClick={() => toggle(p.slug)}
                >
                  <I name={open ? "chevron-down" : "chevron-right"} size={14} />
                </button>
              ) : (
                <span className="nav-disclosure-spacer" aria-hidden="true" />
              )}
              <ScopeLink scope={p} active={active} me={me} depth={p.depth} />
            </div>
            {open && (
              <ul className="plain nav-tree nav-tree-sub" id={groupId}>
                {renderNodes(p.slug)}
                {active && <PagesRow slug={p.slug} currentArticle={currentArticle} />}
              </ul>
            )}
          </li>
        );
      });

  return (
    <div className="nav-group">
      <div className="nav-group-head">
        <h2 className="nav-title" id="nav-group-projects">
          Projects
        </h2>
        {canNew && <IconButton icon="plus" label={plusLabel} size="sm" href="#/new/project" className="nav-add" />}
      </div>
      {projects.length > 10 && (
        <div className="nav-filter">
          <I name="filter" size={14} />
          <input type="search" aria-label="Filter projects" placeholder="Filter projects…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      {projects.length ? (
        <ul className="plain nav-tree" aria-labelledby="nav-group-projects">
          {renderNodes(null)}
          {shown && shown.size === 0 && <li className="nav-empty">No projects match.</li>}
        </ul>
      ) : canNew ? (
        <ul className="plain nav-list">
          <li>
            <a className="nav-link" href="#/new/project">
              <I name="plus" size={16} />
              <span className="nav-label">Create a project</span>
            </a>
          </li>
        </ul>
      ) : (
        <p className="nav-empty">No projects yet</p>
      )}
    </div>
  );
}

const countArticles = (f: Folder): number => f.articles.length + Object.values(f.folders).reduce((n, sub) => n + countArticles(sub), 0);

/** "Pages (n)": the active scope's folder tree, collapsed by default (remembered per browser). */
function PagesRow({ slug, currentArticle }: { slug: string; currentArticle?: string }) {
  const { data } = useApi<{ tree: Folder }>(`/scopes/${encodeURIComponent(slug)}/tree`);
  const [open, setOpen] = useStoredState("thaliyola.nav.pages", false);
  const id = `nav-pages-${slug}`;
  if (!data) return null;
  const n = countArticles(data.tree);
  if (!n) return null;
  const containsCurrent = !!currentArticle && JSON.stringify(data.tree).includes(`"${currentArticle}"`);
  const expanded = open || containsCurrent;
  return (
    <li className="nav-pages">
      <div className="nav-tree-row">
        <button type="button" className="nav-disclosure" aria-expanded={expanded} aria-controls={id} aria-label={`${expanded ? "Collapse" : "Expand"} pages`} onClick={() => setOpen(!expanded)}>
          <I name={expanded ? "chevron-down" : "chevron-right"} size={14} />
        </button>
        <button type="button" className="nav-link nav-pages-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => setOpen(!expanded)}>
          <I name="doc" size={16} />
          <span className="nav-label">Pages ({n})</span>
        </button>
      </div>
      {expanded && (
        <div id={id} className="nav-folders">
          <FolderView folder={data.tree} currentArticle={currentArticle} />
        </div>
      )}
    </li>
  );
}

function FolderView({ folder, currentArticle }: { folder: Folder; currentArticle?: string }) {
  return (
    <ul className="plain nav-folder">
      {/* Unfiled articles first, so they don't read as part of the folder above them. */}
      {folder.articles.map((a) => (
        <li key={a.id}>
          <a className="nav-page" href={href(`/article/${a.id}`)} aria-current={a.id === currentArticle ? "page" : undefined} title={a.title}>
            <span className="nav-label">{a.title}</span>
            {a.status === "draft" && <span className="nav-draft">Draft</span>}
          </a>
        </li>
      ))}
      {Object.entries(folder.folders).map(([name, sub]) => (
        <li key={name}>
          <details open className="nav-folder-group">
            <summary>
              <I name="folder" size={14} />
              <span>{name}</span>
            </summary>
            <FolderView folder={sub} currentArticle={currentArticle} />
          </details>
        </li>
      ))}
    </ul>
  );
}

// ---- Top bar menus (SPEC §2.6) ------------------------------------------------------------------------------

/** Help's "What's new" item: says which release is new until this person has seen it. */
export function whatsNewItem(me: Pick<Me, "whats_new">): MenuItemSpec {
  const w = me.whats_new;
  return {
    id: "whats-new",
    label: "What's new and features",
    icon: "sparkle",
    hint: w?.unseen && w.latest ? `New: Thaliyola ${w.latest.version}` : "Releases and how to use every feature",
    href: "#/whats-new",
  };
}

function HelpMenu({
  me,
  onShortcuts,
  onGlossary,
  onGettingStarted,
  onAbout,
}: {
  me: Me;
  onShortcuts: () => void;
  onGlossary: () => void;
  onGettingStarted: () => void;
  onAbout: () => void;
}) {
  const unseen = !!me.whats_new?.unseen;
  return (
    // The dot sits on the Help button until the newest release has been seen.
    <span className="tl-help" data-unseen={unseen || undefined}>
      <MenuButton
        label={unseen ? "Help (a new release is out)" : "Help"}
        icon="help"
        iconOnly
        variant="ghost"
        align="end"
        items={[
          whatsNewItem(me),
          { id: "guide", label: "Guide: features and commands", icon: "book", hint: "What's on here, how to use each feature, every command", href: "#/guide" },
          { type: "separator" },
          { id: "shortcuts", label: "Keyboard shortcuts", icon: "keyboard", shortcut: "?", onSelect: onShortcuts },
          { id: "glossary", label: "What the words mean", icon: "quote", onSelect: onGlossary },
          { id: "start", label: "Getting started", icon: "check-circle", hint: "Bring the setup checklist back on Home", onSelect: onGettingStarted },
          { type: "separator" },
          { id: "connect", label: "Connect Claude", icon: "plug", href: "#/connect" },
          { id: "about", label: aboutLine(me.build), icon: "info", onSelect: onAbout },
        ]}
      />
      {unseen && <span className="tl-help-dot" aria-hidden="true" />}
    </span>
  );
}

const THEME_OPTIONS: { id: Theme; label: string; icon: IconName }[] = [
  { id: "system", label: "System", icon: "monitor" },
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
];

function UserMenu({
  me,
  ctx,
  phone,
  onShortcuts,
  onGlossary,
  onGettingStarted,
  onAbout,
}: {
  me: Me;
  ctx: NavContext;
  phone: boolean;
  onShortcuts: () => void;
  onGlossary: () => void;
  onGettingStarted: () => void;
  onAbout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setT] = useState<Theme>(getTheme);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const items = visible(USER_MENU, ctx);
  const section = (s: string) => items.filter((i) => i.section === s && i.href).map((i) => ({ id: i.id, label: i.label, icon: i.icon, href: i.href }) as MenuItemSpec);
  const signOut = items.some((i) => i.action === "signout");

  const menu: MenuItemSpec[] = [
    { type: "group", label: "You" },
    ...section("you"),
    { type: "separator" },
    { type: "group", label: "Workspace" },
    ...section("workspace"),
    { type: "separator" },
    {
      type: "choice",
      label: "Theme",
      options: THEME_OPTIONS.map((o) => ({ ...o, checked: theme === o.id })),
      onSelect: (id) => {
        setTheme(id as Theme);
        setT(id as Theme);
      },
    },
    { id: "shortcuts", label: "Keyboard shortcuts", icon: "keyboard", shortcut: phone ? undefined : "?", onSelect: onShortcuts },
    // Phones have no Help button in the top bar: its items live here.
    ...(phone
      ? ([
          whatsNewItem(me),
          { id: "glossary", label: "What the words mean", icon: "quote", onSelect: onGlossary },
          { id: "start", label: "Getting started", icon: "check-circle", onSelect: onGettingStarted },
          { id: "about", label: aboutLine(me.build), icon: "info", onSelect: onAbout },
        ] as MenuItemSpec[])
      : []),
    ...(signOut
      ? ([
          { type: "separator" },
          {
            id: "signout",
            label: "Sign out",
            icon: "logout",
            onSelect: async () => {
              await authApi("/logout", {}).catch(() => undefined);
              window.location.hash = "";
              // Allowed reload (SPEC §6.1.2): a clean start after signing out.
              window.location.reload();
            },
          },
        ] as MenuItemSpec[])
      : []),
  ];

  const header = (
    <div className="user-menu-head">
      <Avatar name={me.name} email={me.email} kind={me.kind === "service" ? "service" : "human"} size={40} />
      <div className="user-menu-who">
        <div className="user-menu-email">{me.email || me.name ? displayName(me.name, me.email) : "Service account"}</div>
        {me.email && <div className="user-menu-sub">{me.email}</div>}
        <div className="user-menu-role">{orgRoleLine(me)}</div>
        {me.auth_mode === "cloudflare" && <div className="user-menu-note">Signed in with your company account</div>}
      </div>
    </div>
  );

  return (
    <>
      <button
        ref={button}
        type="button"
        className="avatar-button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          setT(getTheme());
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Avatar name={me.name} email={me.email} kind={me.kind === "service" ? "service" : "human"} size={32} />
      </button>
      <Menu items={menu} open={open} onClose={() => setOpen(false)} anchorRef={button} label="Account menu" id={menuId} align="end" header={header} className="user-menu" />
    </>
  );
}

// ---- Phone tab bar (SPEC §2.9) --------------------------------------------------------------------------------

function TabBar({
  navId,
  counts,
  drawerOpen,
  whatsNew,
  onSearch,
  onCreate,
  onMenu,
}: {
  navId: NavId | null;
  counts: NavCounts;
  drawerOpen: boolean;
  /** A release this person hasn't seen: its "New" badge is in the drawer. */
  whatsNew?: boolean;
  onSearch: () => void;
  onCreate: () => void;
  onMenu: () => void;
}) {
  const review = counts.review;
  const reviewCount = review ? (review.toReview > 0 ? review.toReview : review.pending) : 0;
  return (
    <nav className="tabbar" aria-label="Main">
      <a className="tabbar-item" href="#/" aria-current={navId === "home" ? "page" : undefined}>
        <I name="home" size={22} />
        <span>Home</span>
      </a>
      <button type="button" className="tabbar-item" aria-haspopup="dialog" onClick={onSearch}>
        <I name="search" size={22} />
        <span>Search</span>
      </button>
      <button type="button" className="tabbar-item tabbar-create" aria-label="Create" aria-haspopup="dialog" onClick={onCreate}>
        <span className="tabbar-create-icon">
          <I name="plus" size={22} />
        </span>
        <span aria-hidden="true">Create</span>
      </button>
      <a className="tabbar-item" href="#/review" aria-current={navId === "review" ? "page" : undefined}>
        <span className="tabbar-icon">
          <I name="review" size={22} />
          {reviewCount > 0 && (
            <span aria-hidden="true">
              <CountBadge value={reviewCount} tone={review!.toReview > 0 ? "accent" : "neutral"} label="" />
            </span>
          )}
        </span>
        <span>Review</span>
        {/* After the visible label, so the accessible name starts with it (WCAG 2.5.3). */}
        {reviewCount > 0 && (
          <span className="sr-only">{review!.toReview > 0 ? `, ${reviewCount} waiting for your review` : `, ${plural(reviewCount, "proposal")} pending`}</span>
        )}
      </a>
      <button type="button" className="tabbar-item" aria-haspopup="dialog" aria-expanded={drawerOpen} onClick={onMenu}>
        <span className="tabbar-icon">
          <I name="menu" size={22} />
          {(!!counts.inbox || whatsNew) && <span className="tabbar-dot" aria-hidden="true" />}
        </span>
        <span>Menu</span>
        {!!counts.inbox && <span className="sr-only">, Inbox has new items</span>}
        {whatsNew && <span className="sr-only">, a new Thaliyola release</span>}
      </button>
    </nav>
  );
}

// ---- Shortcut sheet and glossary (SPEC §2.6, §2.10) -----------------------------------------------------------

const GLOBAL_KEYS: { keys: string; label: string; single?: boolean }[] = [
  { keys: "mod+k", label: "Search or jump to" },
  { keys: "/", label: "Search (on Home: the Home search field)", single: true },
  { keys: "c", label: "Create", single: true },
  { keys: "?", label: "Keyboard shortcuts", single: true },
  { keys: "esc", label: "Close the topmost dialog, menu or panel" },
];

function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const registry = useShortcutRegistry();
  const [singleKeys, setSingleKeys] = useSingleKeyShortcuts();
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string }[]>();
    for (const r of registry) {
      const list = m.get(r.group) ?? [];
      if (!list.some((x) => x.key === r.key)) list.push({ key: r.key, label: r.label });
      m.set(r.group, list);
    }
    return [...m.entries()];
  }, [registry]);
  const keyText = (k: string) => (k.length === 1 && k !== k.toLowerCase() ? `shift+${k.toLowerCase()}` : k === "Escape" ? "esc" : k === "Enter" ? "enter" : k);
  const isSingle = (k: string) => !/^mod\+/i.test(k) && k !== "Escape" && k !== "Enter";
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" size="md">
      <div className="shortcut-sheet">
        <Switch
          label="Single-key shortcuts"
          description="Keys like / , c and ? work without a modifier. Turn this off if you use speech input or they get in your way."
          checked={singleKeys}
          onChange={setSingleKeys}
        />
        <section aria-labelledby="shortcuts-global">
          <h3 id="shortcuts-global" className="shortcut-heading">
            Global shortcuts
          </h3>
          <dl className="shortcut-list">
            {GLOBAL_KEYS.map((k) => (
              <div key={k.keys} className="shortcut-row" data-off={k.single && !singleKeys ? "" : undefined}>
                <dt>
                  <Kbd keys={k.keys} />
                </dt>
                <dd>
                  {k.label}
                  {k.single && !singleKeys && <span className="shortcut-off"> (off)</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
        {groups.map(([group, keys]) => (
          <section key={group} aria-label={group}>
            <h3 className="shortcut-heading">{group}</h3>
            <dl className="shortcut-list">
              {keys.map((k) => (
                <div key={k.key} className="shortcut-row" data-off={isSingle(k.key) && !singleKeys ? "" : undefined}>
                  <dt>
                    <Kbd keys={keyText(k.key)} />
                  </dt>
                  <dd>
                    {k.label}
                    {isSingle(k.key) && !singleKeys && <span className="shortcut-off"> (off)</span>}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        {!groups.length && <p className="muted small">This page has no shortcuts of its own.</p>}
      </div>
    </Dialog>
  );
}

function GlossaryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const rows = GLOSSARY.filter((g) => !q.trim() || `${g.term} ${g.say}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="What the words mean"
      description="Thaliyola uses plain words in the app. When you meet an older or technical word (in Claude, the API or docs), this is what it means here."
      size="lg"
    >
      <div className="glossary">
        <input type="search" className="glossary-filter" aria-label="Filter words" placeholder="Filter words…" value={q} onChange={(e) => setQ(e.target.value)} />
        <dl className="glossary-list">
          {rows.map((g) => (
            <div key={g.term} className="glossary-row">
              <dt>{g.term}</dt>
              <dd>
                {g.say}
                {g.where && <span className="glossary-where"> · still seen in {g.where}</span>}
              </dd>
            </div>
          ))}
        </dl>
        {!rows.length && <p className="muted">No words match “{q.trim()}”.</p>}
      </div>
    </Dialog>
  );
}

/** Opens the search overlay from anywhere (NotFound's "Search" button). */
export const openSearchOverlay = (query?: string) => openShellPanel("search", { query });

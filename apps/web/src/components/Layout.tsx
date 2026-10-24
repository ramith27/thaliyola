import { useEffect, useRef, useState, type ReactNode } from "react";
import { authApi, type Folder, type Me, type ScopeInfo } from "../api";
import { useApi } from "../hooks";
import { href, navigate, type Route } from "../router";
import { getTheme, setTheme, type Theme } from "../theme";
import { I, type IconName } from "./icons";
import { CommandPalette, favouriteLink, InstantSearch, useFavourites, useRecent } from "./find";
import { NotificationBell } from "./notifications";

export function Layout({ me, scopes, route, children }: { me: Me; scopes: ScopeInfo[]; route: Route; children: ReactNode }) {
  const q = route.path[0] === "search" ? (route.query.get("q") ?? "") : "";
  const [menuOpen, setMenuOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const pending = useApi<{ revisions: unknown[] }>("/revisions?state=pending&limit=200");
  const inbox = useApi<{ counts: Record<string, number> }>("/inbox?limit=1");
  const critical = useApi<{ total: number }>("/vulnerabilities?severity=critical&limit=1");
  const favourites = useFavourites();
  const recent = useRecent();

  useEffect(() => {
    setMenuOpen(false);
    pending.reload();
  }, [route, pending.reload]);

  // ⌘K / Ctrl+K opens the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const section = route.path[0];
  const activeScope = section === "scope" || section === "project" ? route.path[1] : undefined;
  const shared = scopes.filter((s) => s.kind !== "project");
  const projects = scopes.filter((s) => s.kind === "project");
  const pendingCount = pending.data?.revisions.length ?? 0;
  const favIds = new Set(favourites.map((f) => f.id));
  const recentOnly = recent.filter((r) => !favIds.has(r.id)).slice(0, 5);

  return (
    <div className="app">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <a className="brand" href={href("/")}>
          <img src="/favicon.svg" alt="" width={24} height={24} />
          <span>Thaliyola</span>
        </a>
        <nav className="nav">
          <NavLink to="/" icon="home" label="Home" active={section === undefined} />
          <NavLink to="/graph" icon="graph" label="Knowledge graph" active={section === "graph"} />
          <NavLink to="/review" icon="review" label="Review" active={section === "review"} count={pendingCount} />
          <NavLink to="/inbox" icon="inbox" label="Inbox" active={section === "inbox" || section === "sources"} count={inbox.data?.counts.new ?? 0} />
          <NavLink to="/security" icon="shield" label="Security" active={section === "security"} count={critical.data?.total ?? 0} />
          <NavLink to="/metrics" icon="chart" label="Metrics" active={section === "metrics"} />
          <NavLink to="/connect" icon="plug" label="Connect" active={section === "connect"} />
        </nav>
        {favourites.length > 0 && (
          <div className="nav-group">
            <div className="nav-title">Favourites</div>
            {favourites.map((f) => (
              <a key={f.id} className="nav-link nav-link-sm" href={favouriteLink(f)} title={f.title}>
                <I name="star" size={16} />
                <span>{f.title}</span>
              </a>
            ))}
          </div>
        )}
        <div className="nav-group">
          <div className="nav-title">Shared</div>
          {shared.map((s) => (
            <ScopeLink key={s.slug} scope={s} active={activeScope === s.slug} />
          ))}
        </div>
        <div className="nav-group">
          <div className="nav-title nav-title-action">
            <span>Projects</span>
            {me.admin && (
              <a className="nav-add" href={href("/new/project")} title="New project" aria-label="New project">
                <I name="plus" size={14} />
              </a>
            )}
          </div>
          {projects.map((s) => (
            <ScopeLink key={s.slug} scope={s} active={activeScope === s.slug} />
          ))}
          {!projects.length &&
            (me.admin ? (
              <a className="nav-link nav-link-sm" href={href("/new/project")}>
                <I name="plus" size={16} />
                <span>Create a project</span>
              </a>
            ) : (
              <div className="muted small nav-empty">No projects yet</div>
            ))}
        </div>
        {recentOnly.length > 0 && (
          <div className="nav-group">
            <div className="nav-title">Recent</div>
            {recentOnly.map((r) => (
              <a key={r.id} className="nav-link nav-link-sm" href={r.link} title={r.title}>
                <I name="clock" size={16} />
                <span>{r.title}</span>
              </a>
            ))}
          </div>
        )}
        <div className="sidebar-foot">
          <a className="btn btn-block" href={href("/new/article", { scope: activeScope })}>
            <I name="plus" size={16} /> New article
          </a>
        </div>
      </aside>
      {menuOpen && <div className="scrim" onClick={() => setMenuOpen(false)} />}

      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" aria-label="Menu" onClick={() => setMenuOpen((o) => !o)}>
            <I name="menu" />
          </button>
          <InstantSearch key={route.path.join("/") + q} initial={q} onOpenPalette={() => setPalette(true)} />
          <div className="topbar-right">
            <NotificationBell />
            <UserMenu me={me} />
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
      {palette && <CommandPalette scopes={scopes} onClose={() => setPalette(false)} />}
      <MobileTabs
        section={section}
        pendingCount={pendingCount}
        admin={me.admin}
        onSearch={() => setPalette(true)}
        onMenu={() => setMenuOpen((o) => !o)}
        scope={activeScope}
      />
    </div>
  );
}

function NavLink({ to, icon, label, active, count }: { to: string; icon: IconName; label: string; active: boolean; count?: number }) {
  return (
    <a className={`nav-link ${active ? "active" : ""}`} href={href(to)}>
      <I name={icon} />
      <span>{label}</span>
      {!!count && <span className="count">{count}</span>}
    </a>
  );
}

function ScopeLink({ scope, active }: { scope: ScopeInfo; active: boolean }) {
  const icon: IconName = scope.kind === "library" ? "library" : scope.kind === "team" ? "team" : scope.visibility === "members" ? "lock" : "folder";
  return (
    <div>
      <a className={`nav-link ${active ? "active" : ""}`} href={href(scope.kind === "project" ? `/project/${scope.slug}` : `/scope/${scope.slug}`)}>
        <I name={icon} />
        <span>{scope.name}</span>
      </a>
      {active && <ScopeTree slug={scope.slug} />}
    </div>
  );
}

function UserMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const initial = (me.email ?? "?")[0]!.toUpperCase();
  return (
    <div className="user-menu" ref={ref}>
      <button className="avatar-btn" onClick={() => setOpen((o) => !o)} aria-label="Account menu" aria-expanded={open}>
        <span className="avatar">{initial}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div className="avatar avatar-lg">{initial}</div>
            <div>
              <div className="menu-email">{me.email ?? "service account"}</div>
              <div className="muted small">{me.admin ? "Admin" : "Member"}</div>
            </div>
          </div>
          <a className="menu-item" href={href("/account")} onClick={() => setOpen(false)}>
            <I name="user" size={16} /> Account and tokens
          </a>
          <a className="menu-item" href={href("/teams")} onClick={() => setOpen(false)}>
            <I name="team" size={16} /> Teams
          </a>
          <a className="menu-item" href={href("/trash")} onClick={() => setOpen(false)}>
            <I name="trash" size={16} /> Trash
          </a>
          <a className="menu-item" href={href("/connect")} onClick={() => setOpen(false)}>
            <I name="plug" size={16} /> Connect your tools
          </a>
          {me.admin && me.auth_mode === "local" && (
            <a className="menu-item" href={href("/admin/users")} onClick={() => setOpen(false)}>
              <I name="team" size={16} /> Users
            </a>
          )}
          <ThemeSwitch />
          {me.auth_mode === "local" && (
            <button
              className="menu-item"
              onClick={async () => {
                await authApi("/logout", {});
                window.location.hash = "";
                window.location.reload();
              }}
            >
              <I name="logout" size={16} /> Sign out
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ThemeSwitch() {
  const [theme, setT] = useState<Theme>(getTheme());
  const options: { value: Theme; icon: IconName; label: string }[] = [
    { value: "system", icon: "monitor", label: "System" },
    { value: "light", icon: "sun", label: "Light" },
    { value: "dark", icon: "moon", label: "Dark" },
  ];
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={theme === o.value}
          className={theme === o.value ? "active" : ""}
          onClick={() => {
            setTheme(o.value);
            setT(o.value);
          }}
        >
          <I name={o.icon} size={14} /> {o.label}
        </button>
      ))}
    </div>
  );
}

function ScopeTree({ slug }: { slug: string }) {
  const { data } = useApi<{ tree: Folder }>(`/scopes/${encodeURIComponent(slug)}/tree`);
  if (!data) return null;
  return <FolderView folder={data.tree} />;
}

function FolderView({ folder }: { folder: Folder }) {
  return (
    <ul className="plain tree">
      {/* Unfiled articles first, so they don't read as part of the folder above them. */}
      {folder.articles.map((a) => (
        <li key={a.id}>
          <a href={href(`/article/${a.id}`)} className={a.status === "draft" ? "muted" : ""}>
            {a.title}
          </a>
        </li>
      ))}
      {Object.entries(folder.folders).map(([name, sub]) => (
        <li key={name}>
          <details open>
            <summary>{name}</summary>
            <FolderView folder={sub} />
          </details>
        </li>
      ))}
    </ul>
  );
}

/** Phone navigation: a bottom tab bar within thumb reach, with a sheet for creating things. */
function MobileTabs({
  section,
  pendingCount,
  admin,
  onSearch,
  onMenu,
  scope,
}: {
  section: string | undefined;
  pendingCount: number;
  admin: boolean;
  onSearch: () => void;
  onMenu: () => void;
  scope?: string;
}) {
  const [sheet, setSheet] = useState(false);
  useEffect(() => {
    const close = () => setSheet(false);
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, []);
  const create: { to: string; icon: IconName; label: string; hint: string; show?: boolean }[] = [
    { to: href("/new/article", { scope }), icon: "doc", label: "New article", hint: "A system, runbook, decision, design or contract" },
    { to: href("/new/finding", { scope }), icon: "bolt", label: "New finding", hint: "Something that happened: incident, root cause, known issue" },
    { to: href("/new/paste"), icon: "inbox", label: "Paste to draft", hint: "Turn a Slack thread, email or notes into a draft" },
    { to: href("/import"), icon: "library", label: "Import documents", hint: "Markdown, HTML, Notion or Confluence exports" },
    { to: href("/new/project"), icon: "folder", label: "New project", hint: "With its repositories and a starter pack", show: admin },
  ];
  return (
    <>
      <nav className="mobile-tabs" aria-label="Main">
        <a className={section === undefined ? "active" : ""} href={href("/")}>
          <I name="home" size={22} />
          <span>Home</span>
        </a>
        <button onClick={onSearch}>
          <I name="search" size={22} />
          <span>Search</span>
        </button>
        <button className="mobile-tabs-new" onClick={() => setSheet(true)} aria-label="Create">
          <I name="plus" size={24} />
        </button>
        <a className={section === "review" ? "active" : ""} href={href("/review")}>
          <span className="tab-icon">
            <I name="review" size={22} />
            {pendingCount > 0 && <span className="tab-badge">{pendingCount > 99 ? "99+" : pendingCount}</span>}
          </span>
          <span>Review</span>
        </a>
        <button onClick={onMenu}>
          <I name="menu" size={22} />
          <span>Menu</span>
        </button>
      </nav>
      {sheet && (
        <div className="sheet-scrim" onClick={() => setSheet(false)}>
          <div className="sheet" role="dialog" aria-label="Create" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-handle" />
            <h3>Create</h3>
            {create
              .filter((c) => c.show !== false)
              .map((c) => (
                <a key={c.label} className="sheet-item" href={c.to}>
                  <span className="tile-icon">
                    <I name={c.icon} size={18} />
                  </span>
                  <span>
                    <strong>{c.label}</strong>
                    <span className="muted small">{c.hint}</span>
                  </span>
                </a>
              ))}
          </div>
        </div>
      )}
    </>
  );
}

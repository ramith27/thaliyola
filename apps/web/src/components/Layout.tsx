import { useEffect, useRef, useState, type ReactNode } from "react";
import { authApi, type Folder, type Me, type ScopeInfo } from "../api";
import { useApi } from "../hooks";
import { href, navigate, type Route } from "../router";
import { getTheme, setTheme, type Theme } from "../theme";
import { I, type IconName } from "./icons";
import { NotificationBell } from "./notifications";

export function Layout({ me, scopes, route, children }: { me: Me; scopes: ScopeInfo[]; route: Route; children: ReactNode }) {
  const [q, setQ] = useState(route.path[0] === "search" ? (route.query.get("q") ?? "") : "");
  const [menuOpen, setMenuOpen] = useState(false);
  const pending = useApi<{ revisions: unknown[] }>("/revisions?state=pending&limit=200");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMenuOpen(false);
    pending.reload();
  }, [route, pending.reload]);

  // ⌘K / Ctrl+K focuses search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
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
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

  return (
    <div className="app">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <a className="brand" href={href("/")}>
          <img src="/favicon.svg" alt="" width={24} height={24} />
          <span>Cairn</span>
        </a>
        <nav className="nav">
          <NavLink to="/" icon="home" label="Home" active={section === undefined} />
          <NavLink to="/graph" icon="graph" label="Knowledge graph" active={section === "graph"} />
          <NavLink to="/review" icon="review" label="Review" active={section === "review"} count={pendingCount} />
          <NavLink to="/connect" icon="plug" label="Connect" active={section === "connect"} />
        </nav>
        <div className="nav-group">
          <div className="nav-title">Shared</div>
          {shared.map((s) => (
            <ScopeLink key={s.slug} scope={s} active={activeScope === s.slug} />
          ))}
        </div>
        <div className="nav-group">
          <div className="nav-title">Projects</div>
          {projects.map((s) => (
            <ScopeLink key={s.slug} scope={s} active={activeScope === s.slug} />
          ))}
          {!projects.length && <div className="muted small nav-empty">No projects yet</div>}
        </div>
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
          <form
            className="search-form"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) navigate("/search", { q: q.trim() });
            }}
          >
            <I name="search" size={16} />
            <input ref={searchRef} type="search" placeholder="Search knowledge…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
          </form>
          <div className="topbar-right">
            <NotificationBell />
            <UserMenu me={me} />
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
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

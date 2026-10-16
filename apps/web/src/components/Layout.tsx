import { useEffect, useState, type ReactNode } from "react";
import { authApi, type Folder, type Me, type ScopeInfo } from "../api";
import { useApi } from "../hooks";
import { href, navigate, type Route } from "../router";

export function Layout({ me, scopes, route, children }: { me: Me; scopes: ScopeInfo[]; route: Route; children: ReactNode }) {
  const [q, setQ] = useState(route.path[0] === "search" ? (route.query.get("q") ?? "") : "");
  const [menuOpen, setMenuOpen] = useState(false);
  const pending = useApi<{ revisions: unknown[] }>("/revisions?state=pending&limit=200");

  useEffect(() => {
    setMenuOpen(false);
    pending.reload();
  }, [route, pending.reload]);

  const activeScope = route.path[0] === "scope" || route.path[0] === "project" ? route.path[1] : undefined;
  const team = scopes.filter((s) => s.kind !== "project");
  const projects = scopes.filter((s) => s.kind === "project");

  return (
    <div className="app">
      <header className="topbar">
        <button className="menu-btn" aria-label="Menu" onClick={() => setMenuOpen((o) => !o)}>
          ☰
        </button>
        <a className="brand" href={href("/")}>
          <img src="/favicon.svg" alt="" width={22} height={22} /> Cairn
        </a>
        <form
          className="search-form"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim()) navigate("/search", { q: q.trim() });
          }}
        >
          <input type="search" placeholder="Search knowledge…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        </form>
        <nav className="top-links">
          <a href={href("/review")} className={route.path[0] === "review" ? "active" : ""}>
            Review{pending.data?.revisions.length ? <span className="count">{pending.data.revisions.length}</span> : null}
          </a>
          {me.admin && me.auth_mode === "local" && (
            <a href={href("/admin/users")} className={route.path[0] === "admin" ? "active" : ""}>
              Users
            </a>
          )}
          <a href={href("/account")} className={`small me ${route.path[0] === "account" ? "active" : ""}`} title="Account and API tokens">
            {me.email ?? "service"}
          </a>
          {me.auth_mode === "local" && (
            <button
              className="link-btn small"
              onClick={async () => {
                await authApi("/logout", {});
                window.location.hash = "";
                window.location.reload();
              }}
            >
              Sign out
            </button>
          )}
        </nav>
      </header>
      <div className="body">
        <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
          <SidebarGroup title="Shared" scopes={team} active={activeScope} />
          <SidebarGroup title="Projects" scopes={projects} active={activeScope} />
          <div className="sidebar-actions">
            <a className="btn btn-small" href={href("/new/article", { scope: activeScope })}>
              New article
            </a>
            <a className="btn btn-small" href={href("/new/finding", { scope: activeScope })}>
              New finding
            </a>
          </div>
        </aside>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

function SidebarGroup({ title, scopes, active }: { title: string; scopes: ScopeInfo[]; active?: string }) {
  if (!scopes.length) return null;
  return (
    <section>
      <h4 className="sidebar-title">{title}</h4>
      <ul className="plain">
        {scopes.map((s) => (
          <li key={s.slug}>
            <a className={`scope-link ${active === s.slug ? "active" : ""}`} href={href(s.kind === "project" ? `/project/${s.slug}` : `/scope/${s.slug}`)}>
              {s.name}
            </a>
            {active === s.slug && <ScopeTree slug={s.slug} />}
          </li>
        ))}
      </ul>
    </section>
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
      {Object.entries(folder.folders).map(([name, sub]) => (
        <li key={name}>
          <details open>
            <summary>{name}</summary>
            <FolderView folder={sub} />
          </details>
        </li>
      ))}
      {folder.articles.map((a) => (
        <li key={a.id}>
          <a href={href(`/article/${a.id}`)} className={a.status === "draft" ? "muted" : ""}>
            {a.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

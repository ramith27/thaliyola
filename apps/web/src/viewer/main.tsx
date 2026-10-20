import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "../styles.css";
import { setStaticAssets } from "../components/assets";
import { Markdown, TypeBadge } from "../components/ui";
import { GraphCanvas } from "../pages/graph";
import { applyTheme } from "../theme";

/**
 * The static export of a Thaliyola project or scope: a read-only reader with
 * the page index, search, the knowledge graph, and each page's grounded facts.
 * Everything comes from wiki.json next to this file.
 */

interface Page {
  id: string;
  kind: "article" | "finding";
  title: string;
  type: string;
  scope: string;
  folder: string;
  body_md: string;
  updated: string;
  claims: { section: string; text: string; status: string; evidence: { path: string; start?: number; end?: number; url: string | null }[] }[];
}
interface Wiki {
  title: string;
  exported: string;
  pages: Page[];
  graph: { nodes: never[]; edges: never[] };
  assets: Record<string, string>;
}

function useHash() {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => {
      setHash(window.location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function Viewer({ wiki }: { wiki: Wiki }) {
  const hash = useHash();
  const [q, setQ] = useState("");
  const m = /^#\/(article|finding)\/([0-9a-f-]+)/.exec(hash);
  const page = m ? wiki.pages.find((p) => p.id === m[2]) : undefined;
  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return wiki.pages.filter((p) => !t || p.title.toLowerCase().includes(t) || p.body_md.toLowerCase().includes(t));
  }, [q, wiki.pages]);
  const groups = useMemo(() => {
    const g = new Map<string, Page[]>();
    for (const p of list) {
      const key = [p.scope, p.folder].filter(Boolean).join(" / ");
      g.set(key, [...(g.get(key) ?? []), p]);
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list]);

  return (
    <div className="viewer">
      <aside className="viewer-side">
        <a className="brand" href="#/">
          <span>{wiki.title}</span>
        </a>
        <input className="viewer-search" placeholder="Search pages…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search pages" />
        <nav>
          {groups.map(([folder, pages]) => (
            <div key={folder} className="nav-group">
              <div className="nav-title">{folder}</div>
              {pages.map((p) => (
                <a key={p.id} className={`nav-link nav-link-sm ${page?.id === p.id ? "active" : ""}`} href={`#/${p.kind}/${p.id}`}>
                  <span>{p.title}</span>
                </a>
              ))}
            </div>
          ))}
          {!groups.length && <p className="muted small">No pages match.</p>}
        </nav>
      </aside>
      <main className="viewer-main">
        {page ? (
          <article className="page">
            <p className="breadcrumbs muted small">{[page.scope, page.folder].filter(Boolean).join(" / ")}</p>
            <h1>{page.title}</h1>
            <div className="badges">
              <TypeBadge type={page.type} />
              <span className="muted small">updated {new Date(page.updated).toLocaleDateString()}</span>
            </div>
            <Markdown text={page.body_md} />
            {page.claims.length > 0 && (
              <section className="claims-panel">
                <div className="claims-body">
                  <h3>Sources</h3>
                  <ul className="plain claim-list">
                    {page.claims.map((c, i) => (
                      <li key={i} className={c.status === "stale" ? "stale" : ""}>
                        <div>{c.text}</div>
                        <div className="claim-evidence small">
                          {c.evidence.map((e, j) => {
                            const label = `${e.path}${e.start ? `:${e.start}${e.end && e.end !== e.start ? `–${e.end}` : ""}` : ""}`;
                            return e.url ? (
                              <a key={j} href={e.url} target="_blank" rel="noopener noreferrer">
                                <code>{label}</code>
                              </a>
                            ) : (
                              <code key={j}>{label}</code>
                            );
                          })}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            )}
          </article>
        ) : (
          <div className="page page-wide">
            <h1>{wiki.title}</h1>
            <p className="lead">
              {wiki.pages.length} pages, exported {new Date(wiki.exported).toLocaleDateString()}. Pick a page on the left, or explore how they connect.
            </p>
            <section className="card graph-card">
              <GraphCanvas nodes={wiki.graph.nodes} edges={wiki.graph.edges} query="" />
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

applyTheme();
fetch("./wiki.json")
  .then((r) => r.json() as Promise<Wiki>)
  .then((wiki) => {
    document.title = wiki.title;
    setStaticAssets(wiki.assets);
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Viewer wiki={wiki} />
      </StrictMode>,
    );
  })
  .catch(() => {
    document.getElementById("root")!.textContent = "Couldn't load wiki.json. Serve this folder over HTTP (e.g. GitHub Pages or `npx serve`); browsers block it when opened as a file.";
  });

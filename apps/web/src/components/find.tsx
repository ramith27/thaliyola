import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type ScopeInfo, type SearchHit } from "../api";
import { href, navigate } from "../router";
import { setTheme } from "../theme";
import { I, type IconName } from "./icons";
import { Markdown, ScopeBadge, TypeBadge } from "./ui";

// ---- Recently viewed (per browser) ---------------------------------------------

export interface RecentItem {
  kind: "article" | "finding" | "scope" | "entity";
  id: string;
  title: string;
  link: string;
}
const RECENT_KEY = "cairn.recent";

export function getRecent(): RecentItem[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.slice(0, 8) : [];
  } catch {
    return [];
  }
}

export function recordVisit(item: RecentItem) {
  try {
    const next = [item, ...getRecent().filter((r) => r.id !== item.id)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event("cairn:recent"));
  } catch {
    /* storage unavailable: no history */
  }
}

export function useRecent() {
  const [items, setItems] = useState(getRecent);
  useEffect(() => {
    const on = () => setItems(getRecent());
    window.addEventListener("cairn:recent", on);
    return () => window.removeEventListener("cairn:recent", on);
  }, []);
  return items;
}

// ---- Favourites (stored on the server) -------------------------------------------

export interface Favourite {
  kind: "article" | "finding" | "scope";
  id: string;
  title: string;
  scope: string;
  scope_kind: string | null;
}

export function favouriteLink(f: { kind: string; id: string; scope: string; scope_kind?: string | null }) {
  if (f.kind === "scope") return href(f.scope_kind === "project" ? `/project/${f.scope}` : `/scope/${f.scope}`);
  return href(`/${f.kind}/${f.id}`);
}

export function useFavourites() {
  const [items, setItems] = useState<Favourite[]>([]);
  const load = useCallback(() => {
    api<{ favourites: Favourite[] }>("/favourites")
      .then((r) => setItems(r.favourites))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("cairn:favourites", load);
    return () => window.removeEventListener("cairn:favourites", load);
  }, [load]);
  return items;
}

export function FavouriteButton({ id }: { id: string }) {
  const favourites = useFavourites();
  const on = favourites.some((f) => f.id === id);
  return (
    <button
      className={`btn ${on ? "btn-on" : ""}`}
      aria-pressed={on}
      title={on ? "Remove from favourites" : "Add to favourites (shown in the sidebar)"}
      onClick={async () => {
        await api(`/favourites/${id}`, { method: on ? "DELETE" : "PUT" });
        window.dispatchEvent(new Event("cairn:favourites"));
      }}
    >
      <I name="star" size={16} /> {on ? "Favourited" : "Favourite"}
    </button>
  );
}

// ---- Links ----------------------------------------------------------------------

export function absoluteLink(hash: string) {
  return `${window.location.origin}${window.location.pathname}${hash}`;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Shares the current page: the native share sheet on phones, otherwise copies the link. */
export function ShareButton({ title }: { title: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn share-btn"
      onClick={async () => {
        const url = window.location.href;
        if (typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches) {
          await navigator.share({ title, url }).catch(() => undefined);
          return;
        }
        if (await copy(url)) {
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        }
      }}
    >
      <I name="share" size={16} /> {done ? "Link copied" : "Share"}
    </button>
  );
}

/** A small "copy link to this section" button shown beside a heading. */
export function SectionLink({ link }: { link: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={`section-link ${done ? "done" : ""}`}
      title={done ? "Link copied" : "Copy link to this section"}
      aria-label="Copy link to this section"
      onClick={async () => {
        if (await copy(absoluteLink(link))) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      <I name={done ? "review" : "link"} size={14} />
    </button>
  );
}

// ---- Search as you type ---------------------------------------------------------------

type Hits = { articles: SearchHit[]; findings: SearchHit[] };

/** Debounced live search; returns the best few hits across articles and findings. */
export function useLiveSearch(q: string, limit = 6) {
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api<Hits>(`/search?${new URLSearchParams({ q: term, limit: String(limit), prefix: "true" })}`)
        .then((r) => !cancelled && setHits([...r.articles, ...r.findings].sort((a, b) => b.score - a.score).slice(0, limit)))
        .catch(() => !cancelled && setHits([]));
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, limit]);
  return hits;
}

const hitLink = (h: SearchHit) => href(`/${h.kind}/${h.id}`, { section: h.section ?? undefined });

export function InstantSearch({ initial, onOpenPalette }: { initial: string; onOpenPalette: () => void }) {
  const [q, setQ] = useState(initial);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const hits = useLiveSearch(q);
  const ref = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    // "/" jumps to search, like most sites.
    const slash = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !el.isContentEditable) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", slash);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", slash);
    };
  }, []);
  useEffect(() => setCursor(-1), [hits]);

  const list = hits ?? [];
  return (
    <form
      ref={ref}
      className="search-form"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        setOpen(false);
        if (cursor >= 0 && list[cursor]) window.location.hash = hitLink(list[cursor]!).slice(1);
        else if (q.trim()) navigate("/search", { q: q.trim() });
      }}
    >
      <I name="search" size={16} />
      <input
        ref={input}
        type="search"
        placeholder="Search knowledge…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, list.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, -1));
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
        aria-label="Search"
        aria-expanded={open && list.length > 0}
        aria-controls="instant-results"
        role="combobox"
        autoComplete="off"
      />
      <button type="button" className="kbd-btn" onClick={onOpenPalette} title="Open the command palette">
        <kbd>{isMac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      {open && hits && q.trim().length >= 2 && (
        <div className="instant" id="instant-results" role="listbox">
          {list.map((h, i) => (
            <a key={h.id + (h.section ?? "")} role="option" aria-selected={i === cursor} className={`instant-row ${i === cursor ? "active" : ""}`} href={hitLink(h)} onClick={() => setOpen(false)}>
              <I name={h.kind === "article" ? "doc" : "bolt"} size={16} />
              <span className="instant-title">
                {h.title}
                {h.section && <span className="muted"> › {h.section}</span>}
              </span>
              <ScopeBadge scope={h.scope} />
            </a>
          ))}
          {!list.length && <div className="instant-empty muted small">No matches yet. Press Enter to search everything.</div>}
          <a className="instant-row instant-all" href={href("/search", { q: q.trim() })} onClick={() => setOpen(false)}>
            <I name="sparkle" size={16} />
            <span className="instant-title">Ask Cairn: “{q.trim()}”</span>
            <I name="arrow" size={14} />
          </a>
        </div>
      )}
    </form>
  );
}

// ---- Ask Cairn ------------------------------------------------------------------------

interface AskResult {
  question: string;
  best: (SearchHit & { answer_md: string; truncated: boolean; confidence: "strong" | "weak" }) | null;
}

/** The single best answer, quoted from the team's own text, above the full results. */
export function AnswerCard({ q }: { q: string }) {
  const [res, setRes] = useState<AskResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    setRes(null);
    api<AskResult>(`/ask?${new URLSearchParams({ q })}`)
      .then((r) => !cancelled && setRes(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [q]);
  if (!res?.best) return null;
  const b = res.best;
  return (
    <section className={`answer-card ${b.confidence}`} aria-label="Best answer">
      <div className="answer-head">
        <span className="answer-label">
          <I name="sparkle" size={16} /> {b.confidence === "strong" ? "Best answer" : "Closest match"}
        </span>
        <TypeBadge type={b.type} />
        <ScopeBadge scope={b.scope} />
      </div>
      <h2>
        <a href={hitLink(b)}>
          {b.title}
          {b.section && <span className="muted"> › {b.section}</span>}
        </a>
      </h2>
      <div className="answer-body">
        <Markdown text={b.answer_md} />
      </div>
      <div className="answer-foot muted small">
        {b.warning && <span className="warn">{b.warning} · </span>}
        Quoted from the knowledge base, not generated.{" "}
        <a href={hitLink(b)}>{b.truncated ? "Read the rest" : "Open"}</a>
      </div>
    </section>
  );
}

export function AskBox() {
  const [q, setQ] = useState("");
  return (
    <form
      className="ask-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (q.trim()) navigate("/search", { q: q.trim() });
      }}
    >
      <I name="sparkle" size={18} />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask Cairn: how do we handle refunds? what does 409 mean on POST /orders?" aria-label="Ask Cairn" />
      <button className="btn btn-primary" disabled={!q.trim()}>
        Ask
      </button>
    </form>
  );
}

// ---- Command palette ---------------------------------------------------------------------

interface Command {
  id: string;
  group: string;
  label: ReactNode;
  text: string;
  icon: IconName;
  hint?: ReactNode;
  run: () => void;
}

export function CommandPalette({ scopes, onClose }: { scopes: ScopeInfo[]; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const recent = useRecent();
  const favourites = useFavourites();
  const hits = useLiveSearch(q, 6);
  const [entities, setEntities] = useState<{ kind: string; name: string; items: number }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setEntities([]);
    const t = setTimeout(() => {
      api<{ entities: { kind: string; name: string; items: number }[] }>(`/entities?${new URLSearchParams({ q: term, limit: "4" })}`)
        .then((r) => setEntities(r.entities))
        .catch(() => setEntities([]));
    }, 160);
    return () => clearTimeout(t);
  }, [q]);

  const go = (link: string) => () => {
    window.location.hash = link.slice(1);
    onClose();
  };

  const commands = useMemo<Command[]>(() => {
    const term = q.trim().toLowerCase();
    const match = (c: Command) => !term || c.text.toLowerCase().includes(term);
    const nav: Command[] = ([
      { id: "home", group: "Go to", label: "Home", text: "home dashboard", icon: "home", run: go(href("/")) },
      { id: "review", group: "Go to", label: "Review queue", text: "review queue proposals approve", icon: "review", run: go(href("/review")) },
      { id: "teams", group: "Go to", label: "Teams", text: "teams groups people members access", icon: "team", run: go(href("/teams")) },
      { id: "metrics", group: "Go to", label: "Metrics", text: "metrics success reuse knowledge gaps", icon: "chart", run: go(href("/metrics")) },
      { id: "graph", group: "Go to", label: "Knowledge graph", text: "knowledge graph", icon: "graph", run: go(href("/graph")) },
      { id: "connect", group: "Go to", label: "Connect your tools", text: "connect claude mcp token", icon: "plug", run: go(href("/connect")) },
      { id: "account", group: "Go to", label: "Account and tokens", text: "account tokens password notifications", icon: "user", run: go(href("/account")) },
      { id: "new-article", group: "Create", label: "New article", text: "new article create write", icon: "plus", run: go(href("/new/article")) },
      { id: "new-finding", group: "Create", label: "New finding", text: "new finding incident rca known issue", icon: "bolt", run: go(href("/new/finding")) },
      { id: "import", group: "Create", label: "Import documents", text: "import markdown html notion confluence google docs zip", icon: "inbox", run: go(href("/import")) },
      { id: "new-paste", group: "Create", label: "Draft from pasted text", text: "paste slack thread email import draft", icon: "inbox", run: go(href("/new/paste")) },
      ...(["light", "dark", "system"] as const).map((t) => ({
        id: `theme-${t}`,
        group: "Theme",
        label: `Theme: ${t}`,
        text: `theme ${t} ${t === "dark" ? "night" : ""}`,
        icon: (t === "light" ? "sun" : t === "dark" ? "moon" : "monitor") as IconName,
        run: () => {
          setTheme(t);
          onClose();
        },
      })),
      ...scopes.map((s) => ({
        id: `scope-${s.slug}`,
        group: "Scopes",
        label: s.name,
        text: `${s.name} ${s.slug} ${s.kind}`,
        icon: (s.kind === "library" ? "library" : s.kind === "team" ? "team" : "folder") as IconName,
        run: go(href(s.kind === "project" ? `/project/${s.slug}` : `/scope/${s.slug}`)),
      })),
    ] as Command[]).filter(match);
    const favs: Command[] = favourites
      .map((f) => ({ id: `fav-${f.id}`, group: "Favourites", label: f.title, text: f.title, icon: "star" as IconName, run: go(favouriteLink(f)) }))
      .filter(match);
    const rec: Command[] = term
      ? []
      : recent.map((r) => ({ id: `recent-${r.id}`, group: "Recent", label: r.title, text: r.title, icon: "clock" as IconName, run: go(r.link) }));
    const found: Command[] = (hits ?? []).map((h) => ({
      id: `hit-${h.id}-${h.section ?? ""}`,
      group: "Knowledge",
      label: (
        <>
          {h.title}
          {h.section && <span className="muted"> › {h.section}</span>}
        </>
      ),
      text: h.title,
      icon: (h.kind === "article" ? "doc" : "bolt") as IconName,
      hint: <ScopeBadge scope={h.scope} />,
      run: go(hitLink(h)),
    }));
    const ents: Command[] = entities.map((e) => ({
      id: `entity-${e.kind}-${e.name}`,
      group: "Entities",
      label: e.name,
      text: e.name,
      icon: "hash" as IconName,
      hint: <span className="muted small">{e.kind} · {e.items}</span>,
      run: go(href(`/entity/${e.kind}/${e.name}`)),
    }));
    const askCmd: Command[] = term
      ? [{ id: "ask", group: "Ask", label: <>Ask Cairn: “{q.trim()}”</>, text: q, icon: "sparkle", hint: <kbd>↵</kbd>, run: go(href("/search", { q: q.trim() })) }]
      : [];
    return term ? [...askCmd, ...found, ...ents, ...favs, ...nav] : [...rec, ...favs, ...nav];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, hits, entities, favourites, recent, scopes]);

  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  let lastGroup = "";
  return (
    <div className="palette-scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <I name="search" size={18} />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search, ask, or jump to…"
            aria-label="Command"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, commands.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                commands[cursor]?.run();
              } else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={listRef}>
          {commands.map((c, i) => {
            const head = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {head}
                <button data-i={i} className={`palette-row ${i === cursor ? "active" : ""}`} onMouseMove={() => setCursor(i)} onClick={c.run}>
                  <I name={c.icon} size={16} />
                  <span className="palette-label">{c.label}</span>
                  {c.hint}
                </button>
              </div>
            );
          })}
          {!commands.length && <div className="instant-empty muted small">Nothing matches.</div>}
        </div>
        <div className="palette-foot muted small">
          <kbd>↑</kbd> <kbd>↓</kbd> move · <kbd>↵</kbd> open · <kbd>/</kbd> search box
        </div>
      </div>
    </div>
  );
}

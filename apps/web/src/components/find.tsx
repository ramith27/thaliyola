import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { api, type SearchHit } from "../api";
import { href, navigate } from "../router";
import { getTheme, setTheme, type Theme } from "../theme";
import { openShellPanel } from "../hooks";
import { I, type IconName } from "./icons";
import { Markdown, ScopeBadge, TypeBadge } from "./ui";
import { Button, ToggleButton } from "./kit/button";
import { SkeletonText, Spinner, useToast } from "./kit/feedback";
import { Kbd } from "./kit/display";
import { lockScroll } from "./kit/util";
import { useOptionalBoot } from "./boot";
import { CREATE_ACTIONS, GO_TO, visible, type NavContext } from "./nav";
import { can } from "./permissions";
import { entityKindLabel, plural, SCOPE_ICON, SCOPE_KIND } from "./labels";
import { treeOrder } from "./tree";

// ---- Recently viewed (per browser) ---------------------------------------------

export interface RecentItem {
  kind: "article" | "finding" | "scope" | "entity";
  id: string;
  title: string;
  link: string;
}
const RECENT_KEY = "thaliyola.recent";

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
    window.dispatchEvent(new Event("thaliyola:recent"));
  } catch {
    /* storage unavailable: no history */
  }
}

export function useRecent() {
  const [items, setItems] = useState(getRecent);
  useEffect(() => {
    const on = () => setItems(getRecent());
    window.addEventListener("thaliyola:recent", on);
    return () => window.removeEventListener("thaliyola:recent", on);
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
    window.addEventListener("thaliyola:favourites", load);
    return () => window.removeEventListener("thaliyola:favourites", load);
  }, [load]);
  return items;
}

/**
 * Favourite / Favourited (shown in the sidebar). Updates at once, reverts with an error toast if the server says
 * no, and keeps its size while the current state loads. `iconOnly` for tight toolbars.
 */
export function FavouriteButton({ id, iconOnly }: { id: string; iconOnly?: boolean | "phone" }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let stale = false;
    const load = () =>
      api<{ favourites: Favourite[] }>("/favourites")
        .then((r) => !stale && setOn(r.favourites.some((f) => f.id === id)))
        .catch(() => !stale && setOn((v) => v ?? false));
    load();
    window.addEventListener("thaliyola:favourites", load);
    return () => {
      stale = true;
      window.removeEventListener("thaliyola:favourites", load);
    };
  }, [id]);
  return (
    <ToggleButton
      pressed={!!on}
      loading={on === null}
      icon="star"
      label="Favourite"
      pressedLabel="Favourited"
      iconOnly={iconOnly}
      tooltip="Add to favourites (shown in the sidebar)"
      pressedTooltip="Remove from favourites"
      onPressedChange={async (next) => {
        await api(`/favourites/${id}`, { method: next ? "PUT" : "DELETE" });
        setOn(next);
        window.dispatchEvent(new Event("thaliyola:favourites"));
      }}
    />
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

/** Shares the current page: the native share sheet on touch devices, otherwise copies the link (toast "Link copied"). */
export function ShareButton({ title }: { title: string }) {
  const toast = useToast();
  return (
    <Button
      variant="secondary"
      icon="share"
      className="share-btn"
      onClick={async () => {
        const url = window.location.href;
        if (typeof navigator.share === "function" && matchMedia("(pointer: coarse)").matches) {
          await navigator.share({ title, url }).catch(() => undefined);
          return;
        }
        if (await copy(url)) toast.success("Link copied", { description: "Paste it anywhere to share this page." });
        else toast.error("Couldn't copy the link", { description: url });
      }}
    >
      Share
    </Button>
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

// ---- Search as you type ---------------------------------------------------------------------------------

type Hits = { articles: SearchHit[]; findings: SearchHit[] };
type LiveStatus = "idle" | "loading" | "done" | "error";

/** Debounced (160ms) prefix search over articles and findings, best `limit` hits first, with its status. */
function useLiveKnowledge(q: string, limit = 6): { hits: SearchHit[] | null; status: LiveStatus } {
  const [state, setState] = useState<{ hits: SearchHit[] | null; status: LiveStatus }>({ hits: null, status: "idle" });
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setState({ hits: null, status: "idle" });
      return;
    }
    let cancelled = false;
    setState((s) => ({ hits: s.hits, status: "loading" }));
    const t = setTimeout(() => {
      api<Hits>(`/search?${new URLSearchParams({ q: term, limit: String(limit), prefix: "true" })}`)
        .then((r) => !cancelled && setState({ hits: [...r.articles, ...r.findings].sort((a, b) => b.score - a.score).slice(0, limit), status: "done" }))
        .catch(() => !cancelled && setState({ hits: [], status: "error" }));
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, limit]);
  return state;
}

/** Debounced live search; returns the best few hits across articles and findings (null under 2 characters). */
export function useLiveSearch(q: string, limit = 6) {
  const { hits, status } = useLiveKnowledge(q, limit);
  return status === "idle" ? null : status === "error" ? [] : hits;
}

interface Topic {
  kind: string;
  name: string;
  items: number;
}

/** Topics (entities) matching `q`: up to 4, debounced like knowledge. */
function useLiveTopics(q: string): { topics: Topic[]; status: LiveStatus } {
  const [state, setState] = useState<{ topics: Topic[]; status: LiveStatus }>({ topics: [], status: "idle" });
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setState({ topics: [], status: "idle" });
      return;
    }
    let cancelled = false;
    setState((s) => ({ topics: s.topics, status: "loading" }));
    const t = setTimeout(() => {
      api<{ entities: Topic[] }>(`/entities?${new URLSearchParams({ q: term, limit: "4" })}`)
        .then((r) => !cancelled && setState({ topics: r.entities.slice(0, 4), status: "done" }))
        .catch(() => !cancelled && setState({ topics: [], status: "error" }));
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q]);
  return state;
}

const hitLink = (h: SearchHit) => href(`/${h.kind}/${h.id}`, { section: h.section ?? undefined });

// ---- One result model for the overlay and the Home field (SPEC §2.5) --------------------------------------

interface ResultRow {
  id: string;
  label: ReactNode;
  /** Plain text of the label (typeahead, announcements). */
  text: string;
  icon: IconName;
  /** Muted text on the right: where it lives, a kind and count, a hint. */
  meta?: ReactNode;
  /** A link target, or an action. */
  href?: string;
  action?: () => void;
  /** Marks the current theme. */
  checked?: boolean;
  /** The "Search everything" row. */
  primary?: boolean;
}

interface ResultGroup {
  id: string;
  label: string;
  rows: ResultRow[];
}

export interface SearchModel {
  groups: ResultGroup[];
  rows: ResultRow[];
  /** typing: whether a query is being searched; status: of the live knowledge search. */
  typing: boolean;
  status: "idle" | "searching" | "error" | "empty" | "results";
}

const THEMES: { value: Theme; label: string; icon: IconName; keywords: string }[] = [
  { value: "system", label: "Theme: System", icon: "monitor", keywords: "theme system auto os appearance" },
  { value: "light", label: "Theme: Light", icon: "sun", keywords: "theme light day appearance" },
  { value: "dark", label: "Theme: Dark", icon: "moon", keywords: "theme dark night appearance" },
];

/** Every word of the query appears in the text (case-insensitive). */
const matches = (term: string, text: string) => {
  const hay = text.toLowerCase();
  return term
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

/**
 * Builds the rows. Before typing: Recent, Favourites, Go to, Create, Projects and spaces, Theme, Help. While typing:
 * "Search everything", Knowledge (6), Topics (4), Projects and spaces (+ "Settings: name"), then matching
 * favourites and commands. Every command passes the same permission check as its other entry points (nav.ts).
 */
function useSearchModel(q: string, context: NavContext | null | undefined, opts: { idle: boolean }): SearchModel {
  const boot = useOptionalBoot();
  const recent = useRecent();
  const favourites = useFavourites();
  const knowledge = useLiveKnowledge(q, 6);
  const topics = useLiveTopics(q);
  const term = q.trim();
  const typing = term.length > 0;

  return useMemo(() => {
    const ctx: NavContext | null = context ?? (boot ? { me: boot.me, scopes: boot.scopes } : null);
    const scopes = boot?.scopes ?? [];
    const scopeName = (slug: string) => boot?.scope(slug)?.name ?? slug;
    const theme = getTheme();

    const goTo: ResultRow[] = ctx
      ? visible(GO_TO, ctx).map((g) => ({ id: `go-${g.id}`, label: g.label, text: `${g.label} ${g.keywords}`, icon: g.icon, href: g.href }))
      : [];
    const create: ResultRow[] = ctx
      ? visible(CREATE_ACTIONS, ctx).map((c) => ({ id: `create-${c.id}`, label: c.label(ctx), text: `${c.label(ctx)} ${c.keywords}`, icon: c.icon, meta: c.hint(ctx), href: c.href(ctx) }))
      : [];
    const spaces = scopes.filter((s) => s.kind !== "project");
    const projects = treeOrder(scopes.filter((s) => s.kind === "project"));
    const places: ResultRow[] = [...spaces, ...projects].map((s) => ({
      id: `scope-${s.slug}`,
      label: s.name,
      text: `${s.name} ${s.slug} ${SCOPE_KIND[s.kind] ?? s.kind}`,
      icon: SCOPE_ICON[s.kind] ?? "folder",
      meta: s.kind === "project" ? (s.parent && boot?.scope(s.parent) ? `in ${scopeName(s.parent)}` : SCOPE_KIND.project) : SCOPE_KIND[s.kind],
      href: href(s.kind === "project" ? `/project/${s.slug}` : `/scope/${s.slug}`),
    }));
    const settings: ResultRow[] = [...spaces, ...projects]
      .filter((s) => can.manageScope(s))
      .map((s) => ({ id: `settings-${s.slug}`, label: `Settings: ${s.name}`, text: `settings ${s.name} ${s.slug} members access`, icon: "settings" as IconName, href: href(`/scope/${s.slug}/settings`) }));
    const themes: ResultRow[] = THEMES.map((t) => ({
      id: `theme-${t.value}`,
      label: t.label,
      text: `${t.label} ${t.keywords}`,
      icon: t.icon,
      checked: theme === t.value,
      action: () => setTheme(t.value),
    }));
    const help: ResultRow[] = [
      { id: "help-shortcuts", label: "Keyboard shortcuts", text: "help keyboard shortcuts keys", icon: "keyboard", action: () => openShellPanel("shortcuts") },
      { id: "help-glossary", label: "What the words mean", text: "help glossary words terms meaning", icon: "help", action: () => openShellPanel("glossary") },
    ];
    const favs: ResultRow[] = favourites.map((f) => ({
      id: `fav-${f.id}`,
      label: f.title,
      text: f.title,
      icon: "star",
      meta: f.kind === "scope" ? undefined : scopeName(f.scope),
      href: favouriteLink(f),
    }));

    const groups: ResultGroup[] = [];
    const add = (id: string, label: string, rows: ResultRow[]) => rows.length && groups.push({ id, label, rows });

    if (!typing) {
      if (opts.idle) {
        const favIds = new Set(favourites.map((f) => f.id));
        add(
          "recent",
          "Recent",
          recent
            .filter((r) => !favIds.has(r.id))
            .slice(0, 5)
            .map((r) => ({ id: `recent-${r.id}`, label: r.title, text: r.title, icon: "clock" as IconName, href: r.link })),
        );
        add("favourites", "Favourites", favs);
        add("goto", "Go to", goTo);
        add("create", "Create", create);
        add("places", "Projects and spaces", places);
        add("theme", "Theme", themes);
        add("help", "Help", help);
      }
    } else {
      add("all", "Search", [{ id: "search-all", label: <>Search everything for “{term}”</>, text: `Search everything for ${term}`, icon: "search", href: href("/search", { q: term }), primary: true }]);
      add(
        "knowledge",
        "Knowledge",
        (knowledge.hits ?? []).map((h) => ({
          id: `hit-${h.kind}-${h.id}-${h.section ?? ""}`,
          label: (
            <>
              {h.title}
              {h.section && <span className="search-overlay-section"> › {h.section}</span>}
            </>
          ),
          text: h.section ? `${h.title} › ${h.section}` : h.title,
          icon: (h.kind === "article" ? "doc" : "bolt") as IconName,
          meta: scopeName(h.scope.slug),
          href: hitLink(h),
        })),
      );
      add(
        "topics",
        "Topics",
        topics.topics.map((t) => ({
          id: `topic-${t.kind}-${t.name}`,
          label: t.name,
          text: t.name,
          icon: "hash" as IconName,
          meta: `${entityKindLabel(t.kind)} · ${plural(t.items, "item")}`,
          href: href(`/entity/${t.kind}/${t.name}`),
        })),
      );
      add("places", "Projects and spaces", [...places, ...settings].filter((r) => matches(term, r.text)).slice(0, 8));
      add("favourites", "Favourites", favs.filter((r) => matches(term, r.text)));
      add("goto", "Go to", goTo.filter((r) => matches(term, r.text)));
      add("create", "Create", create.filter((r) => matches(term, r.text)));
      add("theme", "Theme", themes.filter((r) => matches(term, r.text)));
      add("help", "Help", help.filter((r) => matches(term, r.text)));
    }

    const rows = groups.flatMap((g) => g.rows);
    const live = term.length >= 2 ? knowledge.status : "idle";
    const others = rows.filter((r) => !r.primary).length;
    const status: SearchModel["status"] = !typing
      ? "idle"
      : live === "error"
        ? "error"
        : live === "loading" || topics.status === "loading"
          ? others
            ? "results"
            : "searching"
          : others
            ? "results"
            : "empty";
    return { groups, rows, typing, status: status === "results" && live === "loading" ? "searching" : status };
  }, [boot, context, favourites, recent, knowledge, topics, term, typing, opts.idle]);
}

/** The status line under the rows and what the live region says. */
function statusText(model: SearchModel): string | null {
  if (model.status === "searching") return "Searching…";
  if (model.status === "error") return "Search isn't responding. Press Enter to open full search.";
  if (model.status === "empty") return "Nothing matches. Press Enter to search everything.";
  return null;
}

/** Runs a row: follows its link or calls its action. */
function runRow(row: ResultRow) {
  if (row.action) row.action();
  else if (row.href) window.location.hash = row.href.replace(/^#/, "");
}

/** Up/Down moves (wrapping), Enter runs; the active row scrolls into view. Shared by the overlay and HomeSearch. */
function useResultCursor(model: SearchModel, q: string, listRef: RefObject<HTMLElement>) {
  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor(0), [q]);
  const count = model.rows.length;
  const index = count ? Math.min(cursor, count - 1) : -1;
  useEffect(() => {
    if (index < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index, listRef]);
  const onKeyDown = (e: ReactKeyboardEvent, onEnterWithout: () => void, after?: () => void) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!count) return;
      setCursor((c) => (e.key === "ArrowDown" ? (Math.min(c, count - 1) + 1) % count : (Math.min(c, count - 1) - 1 + count) % count));
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const row = index >= 0 ? model.rows[index] : undefined;
      if (row) {
        after?.();
        runRow(row);
      } else onEnterWithout();
    }
  };
  return { index, setCursor, onKeyDown };
}

function ResultList({
  model,
  listId,
  index,
  onHover,
  onRun,
  listRef,
  label,
}: {
  model: SearchModel;
  listId: string;
  index: number;
  onHover: (i: number) => void;
  onRun: (row: ResultRow) => void;
  listRef: RefObject<HTMLDivElement>;
  label: string;
}) {
  let n = -1;
  const status = statusText(model);
  return (
    <div className="search-overlay-list" role="listbox" id={listId} aria-label={label} ref={listRef}>
      {model.groups.map((g) => (
        <div key={g.id} role="group" aria-labelledby={`${listId}-${g.id}`} className="search-overlay-group">
          {g.id !== "all" && (
            <div id={`${listId}-${g.id}`} className="search-overlay-group-label" role="presentation">
              {g.label}
            </div>
          )}
          {g.id === "all" && (
            <span id={`${listId}-${g.id}`} className="sr-only">
              {g.label}
            </span>
          )}
          {g.rows.map((row) => {
            n += 1;
            const i = n;
            return (
              <div
                key={row.id}
                id={`${listId}-row-${i}`}
                data-row={i}
                role="option"
                aria-selected={i === index}
                className="search-overlay-row"
                data-primary={row.primary || undefined}
                onMouseMove={() => i !== index && onHover(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onRun(row)}
              >
                <I name={row.icon} size={16} />
                <span className="search-overlay-label">{row.label}</span>
                {row.checked && <I name="check" size={16} label="Current" />}
                {row.meta && <span className="search-overlay-meta">{row.meta}</span>}
                {row.primary && <I name="arrow" size={14} />}
              </div>
            );
          })}
        </div>
      ))}
      {status && (
        <div className="search-overlay-status" role="presentation">
          {model.status === "searching" && <Spinner size={16} />}
          <span>{status}</span>
        </div>
      )}
    </div>
  );
}

/** "6 results", "Searching", or the failure line, for the polite live region (announced once it settles). */
function useAnnouncement(model: SearchModel): string {
  const [text, setText] = useState("");
  const next = !model.typing
    ? ""
    : model.status === "results"
      ? plural(model.rows.filter((r) => !r.primary).length, "result")
      : (statusText(model) ?? "");
  useEffect(() => {
    const t = setTimeout(() => setText(next), 350);
    return () => clearTimeout(t);
  }, [next]);
  return text;
}

// ---- SearchOverlay ---------------------------------------------------------------------------------------

export interface SearchOverlayProps {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
  /** The shell's navigation context (who, which scopes, the current project for Create). */
  context?: NavContext | null;
}

/**
 * The one search surface (SPEC §2.5): opened by the top-bar trigger, `/`, ⌘K / Ctrl K and the phone Search tab.
 * A 640px panel under the top bar on desktop, full screen with Cancel on phones. A modal <dialog> (focus trap,
 * Escape, inert page) holding a combobox over grouped results.
 */
export function SearchOverlay(props: SearchOverlayProps) {
  if (!props.open) return null;
  return <SearchOverlayPanel {...props} />;
}

function SearchOverlayPanel({ onClose, initialQuery = "", context }: SearchOverlayProps) {
  const [q, setQ] = useState(initialQuery);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const model = useSearchModel(q, context, { idle: true });
  const { index, setCursor, onKeyDown } = useResultCursor(model, q, listRef);
  const announce = useAnnouncement(model);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const downOnBackdrop = useRef(false);

  useLayoutEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const prev = document.activeElement as HTMLElement | null;
    try {
      if (!d.open) d.showModal();
    } catch {
      d.setAttribute("open", "");
    }
    const unlock = lockScroll();
    input.current?.focus();
    input.current?.select();
    const nav = () => closeRef.current();
    window.addEventListener("hashchange", nav);
    return () => {
      window.removeEventListener("hashchange", nav);
      unlock();
      if (d.open) d.close();
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);

  const run = (row: ResultRow) => {
    closeRef.current();
    runRow(row);
  };

  return (
    <dialog
      ref={dialog}
      className="search-overlay"
      aria-label="Search"
      onCancel={(e) => {
        e.preventDefault();
        closeRef.current();
      }}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) closeRef.current();
        downOnBackdrop.current = false;
      }}
    >
      <div className="search-overlay-panel">
        <div className="search-overlay-input">
          <I name="search" size={18} />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label="Search or jump to"
            aria-expanded={model.rows.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={index >= 0 ? `${listId}-row-${index}` : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search or jump to…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) =>
              onKeyDown(
                e,
                () => {
                  if (!q.trim()) return;
                  closeRef.current();
                  navigate("/search", { q: q.trim() });
                },
                () => closeRef.current(),
              )
            }
          />
          <span className="search-overlay-esc" aria-hidden="true">
            <Kbd keys="esc" />
          </span>
          <button type="button" className="link-btn search-overlay-cancel" onClick={() => closeRef.current()}>
            Cancel
          </button>
        </div>
        <ResultList model={model} listId={listId} index={index} onHover={setCursor} onRun={run} listRef={listRef} label="Search results" />
        <p className="search-overlay-foot" aria-hidden="true">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </p>
        <div className="sr-only" aria-live="polite">
          {announce}
        </div>
      </div>
    </dialog>
  );
}

/**
 * The top-bar search button (SPEC §2.3): field-shaped, opens the SearchOverlay. Shows the current query on /search.
 */
export function SearchTrigger({ query, onOpen }: { query?: string; onOpen?: () => void }) {
  return (
    <button
      type="button"
      className="search-trigger"
      aria-haspopup="dialog"
      aria-keyshortcuts="/ Meta+K Control+K"
      aria-label={query ? `Search: ${query}` : "Search or jump to…"}
      onClick={() => (onOpen ? onOpen() : openShellPanel("search", { query }))}
    >
      <I name="search" size={16} />
      <span className="search-trigger-text" data-query={query ? "" : undefined}>
        {query || "Search or jump to…"}
      </span>
      <Kbd keys="mod+k" />
    </button>
  );
}

// ---- Home search -------------------------------------------------------------------------------------------

/**
 * The Home hero field (SPEC §6.1.3): a real search input with the overlay's live rows anchored under it after 2
 * characters. Enter opens #/search?q= (or the highlighted row); an empty submit just focuses the field.
 * `/` on Home focuses it (the shell looks for #home-search).
 */
export function HomeSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const model = useSearchModel(q, null, { idle: false });
  const { index, setCursor, onKeyDown } = useResultCursor(model, q, listRef);
  const announce = useAnnouncement(model);
  const showing = open && q.trim().length >= 2;

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => form.current && !form.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const submit = () => {
    const term = q.trim();
    if (!term) {
      input.current?.focus();
      return;
    }
    setOpen(false);
    navigate("/search", { q: term });
  };

  return (
    <form
      ref={form}
      role="search"
      className="home-search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="home-search-field">
        <I name="search" size={20} />
        <input
          ref={input}
          id="home-search"
          type="search"
          role="combobox"
          aria-label="Search"
          aria-expanded={showing && model.rows.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showing && index >= 0 ? `${listId}-row-${index}` : undefined}
          autoComplete="off"
          placeholder="Search your team's knowledge, e.g. how do we handle refunds?"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              if (showing) {
                e.preventDefault();
                setOpen(false);
              }
              return;
            }
            if (!showing) return;
            onKeyDown(e, submit, () => setOpen(false));
          }}
        />
        <Button type="submit" variant="primary">
          Search
        </Button>
      </div>
      {showing && (
        <div className="home-search-results">
          <ResultList
            model={model}
            listId={listId}
            index={index}
            onHover={setCursor}
            onRun={(row) => {
              setOpen(false);
              runRow(row);
            }}
            listRef={listRef}
            label="Search results"
          />
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {showing ? announce : ""}
      </div>
    </form>
  );
}

// ---- Best answer (search results page) ------------------------------------------------------------------------

interface AskResult {
  question: string;
  best: (SearchHit & { answer_md: string; truncated: boolean; confidence: "strong" | "weak" }) | null;
}

/**
 * The single best answer, quoted from the team's own text, above the full results. Reserves its space with a
 * skeleton while it loads, and renders nothing when there is no answer.
 */
export function AnswerCard({ q, onResult }: { q: string; /** The link of the answer shown once it has loaded (null: none). */ onResult?: (href: string | null) => void }) {
  const [res, setRes] = useState<AskResult | null | undefined>(undefined);
  const report = useRef(onResult);
  report.current = onResult;
  useEffect(() => {
    let cancelled = false;
    setRes(undefined);
    report.current?.(null);
    api<AskResult>(`/ask?${new URLSearchParams({ q })}`)
      .then((r) => {
        if (cancelled) return;
        setRes(r);
        report.current?.(r?.best ? hitLink(r.best) : null);
      })
      .catch(() => {
        if (cancelled) return;
        setRes(null);
        report.current?.(null);
      });
    return () => {
      cancelled = true;
    };
  }, [q]);
  if (res === undefined) {
    return (
      <section className="answer-card weak" aria-busy="true" aria-label="Best answer">
        <span className="sr-only" role="status">
          Finding the best answer
        </span>
        <SkeletonText lines={4} />
      </section>
    );
  }
  if (!res?.best) return null;
  const b = res.best;
  return (
    <section className={`answer-card ${b.confidence}`} aria-label="Best answer">
      <div className="answer-head">
        <span className="answer-label">
          <I name={b.confidence === "strong" ? "check-circle" : "quote"} size={16} /> {b.confidence === "strong" ? "Best answer" : "Closest match"}
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
        Quoted from your knowledge base, not generated.{" "}
        <a href={hitLink(b)}>{b.truncated ? "Read the rest" : "Open"}</a>
      </div>
    </section>
  );
}

/** @deprecated The Home field is HomeSearch; kept as an alias until Home switches to it (SPEC §6.1.3). */
export const AskBox = HomeSearch;

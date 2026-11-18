/**
 * Boot state and page meta (SPEC §5.16).
 * - BootProvider holds who is signed in and the readable scopes; `reloadScopes()` re-fetches /scopes so the
 *   sidebar and pages update without a full reload, and `updateMe()` applies a change to your own account (your name).
 * - PageMetaProvider + usePageMeta: each page's header reports its title, owning scope, nav highlight and
 *   whether the phone tab bar hides. The shell reads it for document.title, the highlight and the phone title.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Me, type ScopeInfo } from "../api";
import type { NavId } from "./nav";

export interface BootData {
  me: Me;
  scopes: ScopeInfo[];
  articleTypes: string[];
  findingTypes: string[];
}

export interface BootValue extends BootData {
  scope(slug: string | null | undefined): ScopeInfo | undefined;
  reloadScopes(): Promise<void>;
  /** Applies a change to the signed-in account (e.g. a new display name) everywhere at once. */
  updateMe(patch: Partial<Me>): void;
}

const BootContext = createContext<BootValue | null>(null);

interface ScopesResponse {
  scopes: ScopeInfo[];
  article_types: string[];
  finding_types: string[];
}

/** Wraps the signed-in app. `initial` is what App loaded at boot. */
export function BootProvider({ initial, children }: { initial: BootData; children: ReactNode }) {
  const [data, setData] = useState<BootData>(initial);
  // A new boot (sign-in as someone else, retry) replaces everything.
  useEffect(() => setData(initial), [initial]);

  const reloadScopes = useCallback(async () => {
    const s = await api<ScopesResponse>("/scopes");
    setData((d) => ({ ...d, scopes: s.scopes, articleTypes: s.article_types ?? d.articleTypes, findingTypes: s.finding_types ?? d.findingTypes }));
  }, []);

  const updateMe = useCallback((patch: Partial<Me>) => setData((d) => ({ ...d, me: { ...d.me, ...patch } })), []);

  const value = useMemo<BootValue>(() => {
    const bySlug = new Map(data.scopes.map((s) => [s.slug, s]));
    return { ...data, scope: (slug) => (slug ? bySlug.get(slug) : undefined), reloadScopes, updateMe };
  }, [data, reloadScopes, updateMe]);

  return <BootContext.Provider value={value}>{children}</BootContext.Provider>;
}

/** The boot state. Throws outside BootProvider; use `useOptionalBoot` where the static viewer may render. */
export function useBoot(): BootValue {
  const v = useContext(BootContext);
  if (!v) throw new Error("useBoot() needs a BootProvider");
  return v;
}

/** The boot state, or null outside the signed-in app (static viewer, gates). */
export function useOptionalBoot(): BootValue | null {
  return useContext(BootContext);
}

// ---- Page meta ----------------------------------------------------------------------------------

export interface PageMeta {
  title: string;
  /** The owning project or space slug: highlights it in the sidebar and expands its ancestors. */
  scope?: string | null;
  /** Overrides the sidebar item derived from the route. */
  nav?: NavId;
  /** Phones: hide the bottom tab bar (editors, forms, the proposal page). */
  hideTabBar?: boolean;
  /** Phones: the top bar's back chevron (the last linked breadcrumb). */
  back?: { label: string; href: string } | null;
}

/** What the shell keeps: the meta plus the hash path it was reported on. */
interface StoredMeta extends PageMeta {
  path: string;
}

interface PageMetaStore {
  meta: StoredMeta | null;
  set(meta: StoredMeta | null): void;
}

const PageMetaContext = createContext<PageMetaStore | null>(null);

/** The hash path ("/article/abc") without the query: page meta belongs to one path. */
export const hashPath = (hash: string = typeof window === "undefined" ? "" : window.location.hash) => hash.replace(/^#/, "").split("?")[0] || "/";

export function PageMetaProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<StoredMeta | null>(null);
  const store = useMemo<PageMetaStore>(() => ({ meta, set: setMeta }), [meta]);
  return <PageMetaContext.Provider value={store}>{children}</PageMetaContext.Provider>;
}

/**
 * What the current page reported, or null until its PageHeader mounts. Meta reported on another path is ignored,
 * so every path change falls back to the route's defaults without a reset effect racing the new page's report.
 */
export function useCurrentPageMeta(): PageMeta | null {
  const meta = useContext(PageMetaContext)?.meta ?? null;
  return meta && meta.path === hashPath() ? meta : null;
}

/** Clears the reported meta (meta is already ignored after a path change; kept for callers that want it gone). */
export function useResetPageMeta(): () => void {
  const store = useContext(PageMetaContext);
  return useCallback(() => store?.set(null), [store]);
}

/** "{title} · Thaliyola" (just "Thaliyola" without a title). */
export const documentTitle = (title: string | null | undefined) => (title ? `${title} · Thaliyola` : "Thaliyola");

/**
 * Called by PageHeader (pages without one, such as gates, don't). Sets document.title and reports the rest
 * to the shell. Works without a PageMetaProvider (document.title only).
 */
export function usePageMeta(meta: PageMeta) {
  const store = useContext(PageMetaContext);
  const setRef = useRef(store?.set);
  setRef.current = store?.set;
  const { title, scope = null, nav, hideTabBar = false, back = null } = meta;
  const backHref = back?.href ?? null;
  const backLabel = back?.label ?? null;
  useEffect(() => {
    document.title = documentTitle(title);
    setRef.current?.({ title, scope, nav, hideTabBar, back: backHref ? { href: backHref, label: backLabel ?? "" } : null, path: hashPath() });
  }, [title, scope, nav, hideTabBar, backHref, backLabel]);
}

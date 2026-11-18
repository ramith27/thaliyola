/**
 * Page structure (SPEC §5.3–§5.5, §5.11): Page, PageHeader, Breadcrumbs, Section, Card, Disclosure, Tabs,
 * SegmentedControl, ChipGroup, FilterBar, AdminTabs, Stepper.
 */
import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { ScopeInfo } from "../../api";
import { useMediaQuery } from "../../hooks";
import { usePageMeta, useOptionalBoot } from "../boot";
import { I, type IconName } from "../icons";
import { plural } from "../labels";
import { ADMIN_TABS, visible, type AdminTabId, type NavId } from "../nav";
import { Button, IconButton } from "./button";
import { CountBadge } from "./display";
import { projectOptions, SearchInput } from "./form";
import { ComboboxPanel, type ComboOption } from "./combobox";
import { InfoTip, MenuButton, OverflowMenu, Popover, Sheet, type MenuItemSpec } from "./overlay";
import { cx, useOverflowX } from "./util";

// ---- Page ---------------------------------------------------------------------------------------------------

export interface PageProps {
  width?: "reading" | "form" | "content" | "wide";
  rail?: ReactNode;
  railLabel?: string;
  children: ReactNode;
}

/** The page frame: a max width, and an optional sticky rail (stacks below 1100px). */
export function Page({ width = "content", rail, railLabel = "Details", children }: PageProps) {
  if (!rail) return <div className={cx("page-frame", `page-frame-${width}`)}>{children}</div>;
  return (
    <div className={cx("page-frame", `page-frame-${width}`, "page-with-rail")}>
      <div className="page-main">{children}</div>
      <aside className="page-rail" aria-label={railLabel}>
        {rail}
      </aside>
    </div>
  );
}

// ---- SplitView ----------------------------------------------------------------------------------------------

/** Where a list and the selected row's preview sit side by side (Review, Inbox). */
export const SPLIT_VIEW_QUERY = "(min-width: 1280px)";

/** True while the window is wide enough for a SplitView. */
export function useSplitView(): boolean {
  return useMediaQuery(SPLIT_VIEW_QUERY);
}

export interface SplitViewProps {
  /** Side by side only while true (pass useSplitView()); otherwise just the list. */
  active: boolean;
  list: ReactNode;
  /** The selected row, with its main actions. */
  detail: ReactNode;
  detailLabel: string;
}

/** A list with a sticky preview pane on its right. Below 1280px it renders the list alone, as before. */
export function SplitView({ active, list, detail, detailLabel }: SplitViewProps) {
  if (!active) return <>{list}</>;
  return (
    <div className="split-view">
      <div className="split-view-list">{list}</div>
      <aside className="split-view-detail" aria-label={detailLabel}>
        {detail}
      </aside>
    </div>
  );
}

// ---- Breadcrumbs -------------------------------------------------------------------------------------------

export interface Crumb {
  label: string;
  href?: string;
  muted?: boolean;
  /** Turns the crumb into a switcher: a button next to it opens a searchable list of places to go instead. */
  switcher?: CrumbSwitcher;
}

export interface CrumbSwitcher {
  /** "Switch project". */
  label: string;
  /** The value of the place the crumb stands for (shown as chosen). */
  current: string;
  options: ComboOption[];
  /** Where picking an option goes (the same section in the other place, where it makes sense). */
  hrefFor(value: string): string;
}

/** "Order service v2 › Contracts". The current page is the h1, not a crumb. Phones show "… › parent". */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (!items.length) return null;
  const long = items.length > 2;
  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol>
        {items.map((c, i) => (
          <li key={`${c.label}-${i}`} className={cx("breadcrumbs-item", long && i < items.length - 1 && !c.switcher && "breadcrumbs-collapsible")}>
            {i > 0 && (
              <span className="breadcrumbs-sep" aria-hidden="true">
                ›
              </span>
            )}
            {c.href ? (
              <a href={c.href} className={c.muted ? "breadcrumbs-muted" : undefined}>
                {c.label}
              </a>
            ) : (
              <span className={c.muted ? "breadcrumbs-muted" : undefined}>{c.label}</span>
            )}
            {c.switcher && <CrumbSwitch crumb={c.label} switcher={c.switcher} />}
          </li>
        ))}
        {long && (
          <li className="breadcrumbs-ellipsis" aria-hidden="true">
            …
          </li>
        )}
      </ol>
    </nav>
  );
}

/**
 * A project crumb's switcher: every project you can read (`scopes` holds only those), going to `hrefFor(slug)`.
 * Undefined unless `current` is a project and there is another one to go to.
 */
export function projectSwitcher(scopes: ScopeInfo[], current: string, hrefFor: (slug: string) => string): CrumbSwitcher | undefined {
  const options = projectOptions(scopes, { includeSpaces: false });
  if (!options.some((o) => o.value === current) || options.length < 2) return undefined;
  return { label: "Switch project", current, options, hrefFor };
}

/** The ▾ after a switchable crumb: a searchable list; picking one goes there. */
function CrumbSwitch({ crumb, switcher }: { crumb: string; switcher: CrumbSwitcher }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const id = useId();
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="breadcrumbs-switch"
        aria-label={`${switcher.label} (now ${crumb})`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <I name="chevron-down" size={14} />
      </button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)} label={switcher.label} id={id} sheetOnMobile className="combobox-popover">
        <ComboboxPanel
          title={switcher.label}
          options={switcher.options}
          value={switcher.current}
          searchLabel={switcher.label}
          placeholder="Find a project"
          emptyText="No project matches."
          onPick={(v) => {
            setOpen(false);
            if (v !== switcher.current) window.location.hash = switcher.hrefFor(v).replace(/^#/, "");
          }}
        />
      </Popover>
    </>
  );
}

// ---- PageHeader ------------------------------------------------------------------------------------------

export interface PageHeaderProps {
  title: ReactNode;
  documentTitle?: string;
  size?: "page" | "document";
  crumbs?: Crumb[];
  eyebrow?: ReactNode;
  icon?: IconName;
  status?: ReactNode;
  description?: ReactNode;
  info?: { label: string; content: ReactNode };
  meta?: ReactNode;
  actions?: ReactNode;
  primary?: ReactNode;
  menu?: MenuItemSpec[];
  tabs?: ReactNode;
  scope?: string | null;
  nav?: NavId;
  hideTabBar?: boolean;
}

/**
 * The one header anatomy: crumbs; icon, title, status, actions, primary, ⋯; description, meta; tabs.
 * The title is the page's only h1. Sets the document title and reports page meta to the shell.
 * ≤ 860px: actions (except toggle buttons) and the ⋯ menu fold into one "More actions" sheet.
 */
export function PageHeader({
  title,
  documentTitle,
  size = "page",
  crumbs,
  eyebrow,
  icon,
  status,
  description,
  info,
  meta,
  actions,
  primary,
  menu,
  tabs,
  scope,
  nav,
  hideTabBar,
}: PageHeaderProps) {
  // The phone top bar's back chevron goes to the last linked crumb.
  const back = [...(crumbs ?? [])].reverse().find((c) => c.href && !c.muted);
  usePageMeta({ title: documentTitle ?? (typeof title === "string" ? title : ""), scope, nav, hideTabBar, back: back ? { label: back.label, href: back.href! } : null });
  const phone = useMediaQuery("(max-width: 860px)");
  // ≤ 360px even toggle buttons (Watch, Favourite) fold into the sheet, so the primary and ⋯ share one row.
  const tiny = useMediaQuery("(max-width: 360px)");
  const actionsRef = useRef<HTMLDivElement>(null);
  const [foldable, setFoldable] = useState(false);
  const [sheet, setSheet] = useState(false);
  useLayoutEffect(() => {
    const el = actionsRef.current;
    setFoldable(!!el && Array.from(el.children).some((c) => (tiny || !c.classList.contains("btn-toggle")) && !c.classList.contains("sr-only")));
  });
  const hasMenu = !!menu?.some((m) => m.type === undefined);
  const showMore = phone && (foldable || hasMenu);

  return (
    <header className="page-header" data-size={size}>
      {crumbs && crumbs.length > 0 && (
        <div className="page-header-crumbs">
          <Breadcrumbs items={crumbs} />
        </div>
      )}
      {/* On phones a toolbar without a primary holds only icon buttons (toggles and ⋯), so it stays on the title row. */}
      <div className="page-header-main" data-inline-toolbar={phone && !primary ? "" : undefined}>
        {icon && (
          <span className="page-header-icon" aria-hidden="true">
            <I name={icon} size={18} />
          </span>
        )}
        <div className="page-header-heading">
          {eyebrow && <p className="page-header-eyebrow">{eyebrow}</p>}
          <div className="page-header-titlerow">
            <h1 className="page-header-title" tabIndex={-1}>
              {title}
            </h1>
            {info && <InfoTip label={info.label}>{info.content}</InfoTip>}
            {status && <span className="page-header-status">{status}</span>}
          </div>
        </div>
        {(actions || primary || hasMenu) && (
          <div className="page-header-toolbar">
            {actions && (
              <div ref={actionsRef} className="page-header-actions" data-folded={phone ? (tiny ? "all" : "toolbar") : undefined}>
                {actions}
              </div>
            )}
            {primary}
            {!phone && hasMenu && <OverflowMenu items={menu!} />}
            {showMore && <IconButton icon="more" label="More actions" aria-haspopup="dialog" aria-expanded={sheet} onClick={() => setSheet(true)} />}
          </div>
        )}
      </div>
      {description && <div className="page-header-description">{description}</div>}
      {meta && <div className="page-header-meta">{meta}</div>}
      {tabs && <div className="page-header-tabs">{tabs}</div>}
      {showMore && (
        <Sheet open={sheet} side="bottom" title="More actions" onClose={() => setSheet(false)}>
          <div className="page-header-sheet" onClick={(e) => (e.target as HTMLElement).closest("a, button") && setSheet(false)}>
            {foldable && (
              <div className="page-header-sheet-actions" data-all={tiny || undefined}>
                {actions}
              </div>
            )}
            {hasMenu && (
              <div className="page-header-sheet-menu">
                {menu!.map((m, i) =>
                  m.type === "choice" ? null : m.type === "separator" ? (
                    <hr key={`s${i}`} className="menu-separator" />
                  ) : m.type === "group" ? (
                    <p key={`g${i}`} className="menu-group-label">
                      {m.label}
                    </p>
                  ) : (
                    <Button
                      key={m.id}
                      variant={m.tone === "danger" ? "danger" : "ghost"}
                      icon={m.checked !== undefined ? (m.checked ? "check" : undefined) : m.icon}
                      aria-pressed={m.checked}
                      href={m.href}
                      external={m.external}
                      disabledReason={m.disabledReason}
                      block
                      onClick={() => m.onSelect?.()}
                    >
                      {m.label}
                    </Button>
                  ),
                )}
              </div>
            )}
          </div>
        </Sheet>
      )}
    </header>
  );
}

// ---- Section, Card, Disclosure ---------------------------------------------------------------------------

export interface SectionProps {
  title: string;
  level?: 2 | 3;
  description?: ReactNode;
  count?: number;
  actions?: ReactNode;
  id?: string;
  children: ReactNode;
}

/** An unboxed section: a heading row (title, count, actions) and its content. */
export function Section({ title, level = 2, description, count, actions, id, children }: SectionProps) {
  const H = level === 3 ? "h3" : "h2";
  const headingId = useId();
  return (
    <section className="section" id={id} aria-labelledby={headingId} data-level={level}>
      <div className="section-head">
        <div className="section-title-row">
          <H id={headingId} className="section-heading">
            {title}
          </H>
          {count !== undefined && <CountBadge value={count} label={plural(count, "item")} tone="neutral" />}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </div>
      {description && <div className="section-description">{description}</div>}
      {children}
    </section>
  );
}

export interface CardProps {
  title?: ReactNode;
  titleLevel?: 2 | 3;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  padding?: "md" | "sm" | "none";
  tone?: "default" | "danger";
  href?: string;
  as?: "section" | "div" | "article";
  className?: string;
  children?: ReactNode;
}

/** A hairline card. With `href` the whole card is a link (hover, focus ring and a chevron). */
export function Card({ title, titleLevel = 3, description, actions, footer, padding = "md", tone = "default", href, as = "div", className, children }: CardProps) {
  const Tag = as;
  const H = titleLevel === 2 ? "h2" : "h3";
  const headingId = useId();
  const hasHead = title || description || actions;
  return (
    <Tag
      className={cx("card", "kit-card", tone === "danger" && "card-danger", href && "card-link", className)}
      data-padding={padding}
      aria-labelledby={as === "section" && title ? headingId : undefined}
    >
      {hasHead && (
        <div className="card-head">
          <div className="card-heading">
            {title && (
              <H id={headingId} className="card-title">
                {href ? (
                  <a className="card-link-anchor" href={href}>
                    {title}
                  </a>
                ) : (
                  title
                )}
              </H>
            )}
            {description && <div className="card-description">{description}</div>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
          {href && <I name="chevron-right" size={16} className="card-chevron" />}
        </div>
      )}
      {children !== undefined && children !== null && <div className="card-body">{children}</div>}
      {footer && <div className="card-foot">{footer}</div>}
    </Tag>
  );
}

export interface DisclosureProps {
  summary: ReactNode;
  defaultOpen?: boolean;
  storageKey?: string;
  children: ReactNode;
  className?: string;
}

function readOpen(key: string | undefined, fallback: boolean): boolean {
  if (!key) return fallback;
  try {
    const v = localStorage.getItem(`thaliyola.disclosure.${key}`);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

/** A <details> with a chevron. With `storageKey`, the open state is remembered in this browser. */
export function Disclosure({ summary, defaultOpen = false, storageKey, children, className }: DisclosureProps) {
  const [open] = useState(() => readOpen(storageKey, defaultOpen));
  return (
    <details
      className={cx("disclosure", className)}
      open={open}
      onToggle={(e) => {
        if (!storageKey) return;
        try {
          localStorage.setItem(`thaliyola.disclosure.${storageKey}`, (e.currentTarget as HTMLDetailsElement).open ? "1" : "0");
        } catch {
          /* storage unavailable */
        }
      }}
    >
      <summary className="disclosure-summary">
        <I name="chevron-right" size={16} className="disclosure-chevron" />
        <span>{summary}</span>
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

// ---- Tabs ------------------------------------------------------------------------------------------------

export interface TabItem {
  id: string;
  label: string;
  href?: string;
  count?: number;
  countTone?: "neutral" | "accent" | "danger";
  icon?: IconName;
  hidden?: boolean;
}
export interface TabsProps {
  label: string;
  items: TabItem[];
  value: string;
  onChange?: (id: string) => void;
  idPrefix?: string;
}

/** Arrow keys, Home and End across a row of radio-like or tab-like buttons. Returns the new index. */
function rovingIndex(e: ReactKeyboardEvent, i: number, n: number, vertical = false): number | null {
  const next = vertical ? "ArrowDown" : "ArrowRight";
  const prev = vertical ? "ArrowUp" : "ArrowLeft";
  if (e.key === next || (!vertical && e.key === "ArrowDown")) return (i + 1) % n;
  if (e.key === prev || (!vertical && e.key === "ArrowUp")) return (i - 1 + n) % n;
  if (e.key === "Home") return 0;
  if (e.key === "End") return n - 1;
  return null;
}

/**
 * URL tabs (`href` on items: a nav with aria-current) or in-page tabs (role="tablist" with arrow keys; render the
 * panel as <div role="tabpanel" id={`${idPrefix}-panel-${id}`} aria-labelledby={`${idPrefix}-tab-${id}`}>).
 */
export function Tabs({ label, items, value, onChange, idPrefix = "tabs" }: TabsProps) {
  const shown = items.filter((t) => !t.hidden);
  const ref = useRef<HTMLDivElement>(null);
  const over = useOverflowX(ref, [shown.length]);
  // On narrow screens the strip scrolls: keep the current tab in view (the strip only, never the page).
  useLayoutEffect(() => {
    const strip = ref.current;
    const cur = strip?.querySelector<HTMLElement>('[aria-current="page"], [aria-selected="true"]');
    if (!strip || !cur) return;
    const a = strip.getBoundingClientRect();
    const b = cur.getBoundingClientRect();
    if (b.left < a.left || b.right > a.right) strip.scrollLeft += b.left - a.left - Math.max(0, (a.width - b.width) / 2);
  }, [value, shown.length]);
  const body = (t: TabItem) => (
    <>
      {t.icon && <I name={t.icon} size={16} />}
      <span>{t.label}</span>
      {t.count !== undefined && t.count > 0 && <CountBadge value={t.count} tone={t.countTone ?? "neutral"} label={`${t.count}`} />}
    </>
  );
  if (shown.some((t) => t.href)) {
    return (
      <nav className="tabs kit-tabs" aria-label={label} data-overflow={over || undefined}>
        <div className="tabs-scroll" ref={ref}>
          {shown.map((t) => (
            <a key={t.id} className="tab" href={t.href} aria-current={t.id === value ? "page" : undefined} onClick={() => onChange?.(t.id)}>
              {body(t)}
            </a>
          ))}
        </div>
      </nav>
    );
  }
  return (
    <div className="tabs kit-tabs" data-overflow={over || undefined}>
      <div className="tabs-scroll" ref={ref} role="tablist" aria-label={label}>
        {shown.map((t, i) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={t.id === value}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={t.id === value ? 0 : -1}
            onClick={() => onChange?.(t.id)}
            onKeyDown={(e) => {
              const j = rovingIndex(e, i, shown.length);
              if (j === null) return;
              e.preventDefault();
              const next = shown[j]!;
              onChange?.(next.id);
              (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
            }}
          >
            {body(t)}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- SegmentedControl ------------------------------------------------------------------------------------

export interface SegmentedControlProps<T extends string> {
  label: string;
  labelVisible?: boolean;
  options: { value: T; label: string; count?: number; icon?: IconName; disabled?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  size?: "sm" | "md";
}

/** One choice among 2–5 (status, period, Graph | List, Chart | Table, theme). A radio group with arrow keys. */
export function SegmentedControl<T extends string>({ label, labelVisible, options, value, onChange, size = "md" }: SegmentedControlProps<T>) {
  const labelId = useId();
  const enabled = options.filter((o) => !o.disabled);
  return (
    <div className="segmented-field">
      {labelVisible && (
        <span id={labelId} className="segmented-label">
          {label}
        </span>
      )}
      <div className="segmented" role="radiogroup" aria-label={labelVisible ? undefined : label} aria-labelledby={labelVisible ? labelId : undefined} data-size={size}>
        {options.map((o) => {
          const checked = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              className="segmented-option"
              aria-checked={checked}
              disabled={o.disabled}
              tabIndex={checked || (!options.some((x) => x.value === value) && o === enabled[0]) ? 0 : -1}
              onClick={() => onChange(o.value)}
              onKeyDown={(e) => {
                const i = enabled.indexOf(o);
                const j = rovingIndex(e, i, enabled.length);
                if (j === null) return;
                e.preventDefault();
                const next = enabled[j]!;
                onChange(next.value);
                const group = e.currentTarget.parentElement;
                const idx = options.indexOf(next);
                (group?.children[idx] as HTMLElement | undefined)?.focus();
              }}
            >
              {o.icon && <I name={o.icon} size={16} />}
              <span>{o.label}</span>
              {o.count !== undefined && <span className="segmented-count">{o.count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---- ChipGroup -------------------------------------------------------------------------------------------

export interface ChipGroupProps<T extends string> {
  label: string;
  multiple?: boolean;
  options: { value: T; label: string; count?: number; hint?: string; dotColor?: string }[];
  value: T | T[];
  onChange: (v: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const isAll = (v: string) => v === "" || v === "all";

/** Toggle chips. Multiple: aria-pressed. Single: a radio group (clicking the current chip clears to "All"). */
export function ChipGroup<T extends string>({ label, multiple, options, value, onChange }: ChipGroupProps<T>) {
  const selected = Array.isArray(value) ? value : [value];
  const all = options.find((o) => isAll(o.value));
  const content = (o: ChipGroupProps<T>["options"][number], on: boolean) => (
    <>
      {on ? <I name="check" size={14} className="chip-check" /> : o.dotColor && <span className="chip-dot" style={{ background: o.dotColor }} aria-hidden="true" />}
      <span>{o.label}</span>
      {o.count !== undefined && <span className="chip-count">{o.count}</span>}
    </>
  );
  if (multiple) {
    return (
      <div className="chip-group" role="group" aria-label={label}>
        {options.map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className="chip"
              aria-pressed={on}
              title={o.hint}
              onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}
            >
              {content(o, on)}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <div className="chip-group" role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const on = selected[0] === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            className="chip"
            aria-checked={on}
            title={o.hint}
            tabIndex={on || (!options.some((x) => x.value === selected[0]) && i === 0) ? 0 : -1}
            onClick={() => onChange(on && all && !isAll(o.value) ? all.value : o.value)}
            onKeyDown={(e) => {
              const j = rovingIndex(e, i, options.length);
              if (j === null) return;
              e.preventDefault();
              onChange(options[j]!.value);
              (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus();
            }}
          >
            {content(o, on)}
          </button>
        );
      })}
    </div>
  );
}

// ---- FilterBar -------------------------------------------------------------------------------------------

export interface FilterBarProps {
  search?: { value: string; onChange(v: string): void; label: string; placeholder: string; debounceMs?: number };
  segments?: ReactNode;
  filters?: ReactNode;
  more?: { count: number; content: ReactNode };
  view?: MenuItemSpec[];
  /** Saved views (a SavedViews menu): stays in the row on phones too. */
  views?: ReactNode;
  active?: { id: string; label: string; onRemove(): void }[];
  onClearAll?: () => void;
  result?: ReactNode;
}

/**
 * Search, segments, ≤ 3 inline filters, "Filters (n)" and "View". A second row shows removable chips, Clear all
 * and the result count (polite). ≤ 860px: everything but search goes in a "Filters" sheet.
 */
export function FilterBar({ search, segments, filters, more, view, views, active, onClearAll, result }: FilterBarProps) {
  const phone = useMediaQuery("(max-width: 860px)");
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const moreId = useId();
  const activeCount = (active?.length ?? 0) || (more?.count ?? 0);
  const hasHidden = !!(segments || filters || more || (view && view.length));
  const filtersLabel = `Filters${phone ? (activeCount ? ` (${activeCount})` : "") : more?.count ? ` (${more.count})` : ""}`;

  return (
    <div className="filter-bar">
      <div className="filter-bar-row">
        {search && (
          <div className="filter-bar-search">
            <SearchInput value={search.value} onChange={search.onChange} label={search.label} placeholder={search.placeholder} debounceMs={search.debounceMs} />
          </div>
        )}
        {!phone && segments}
        {!phone && filters}
        {(phone ? hasHidden : !!more) && (
          <Button
            ref={moreRef}
            icon="filter"
            aria-expanded={moreOpen}
            aria-controls={moreOpen ? moreId : undefined}
            aria-haspopup="dialog"
            onClick={() => setMoreOpen((o) => !o)}
          >
            {filtersLabel}
          </Button>
        )}
        {!phone && view && view.length > 0 && <MenuButton label="View" icon="sort" items={view} align="end" />}
        {views}
      </div>
      {!phone && more && (
        <Popover anchorRef={moreRef} open={moreOpen} onClose={() => setMoreOpen(false)} label="Filters" id={moreId} placement="bottom-end" className="filter-bar-popover">
          {more.content}
        </Popover>
      )}
      {phone && (
        <Sheet
          open={moreOpen}
          side="bottom"
          title="Filters"
          onClose={() => setMoreOpen(false)}
          footer={
            <>
              {onClearAll && (active?.length ?? 0) > 0 && (
                <Button variant="ghost" onClick={onClearAll}>
                  Clear all
                </Button>
              )}
              <Button variant="primary" onClick={() => setMoreOpen(false)}>
                Show results
              </Button>
            </>
          }
        >
          <div className="filter-bar-sheet">
            {segments}
            {filters}
            {more?.content}
            {view && view.length > 0 && (
              <fieldset className="filter-bar-view">
                <legend className="field-label">View</legend>
                {view.map((v, i) =>
                  v.type === "separator" || v.type === "choice" ? null : v.type === "group" ? (
                    <p key={`g${i}`} className="menu-group-label">
                      {v.label}
                    </p>
                  ) : (
                    <button key={v.id} type="button" className="menu-item" role="menuitemcheckbox" aria-checked={!!v.checked} onClick={() => v.onSelect?.()}>
                      <span className="menu-item-check" aria-hidden="true">
                        {v.checked && <I name="check" size={16} />}
                      </span>
                      <span className="menu-item-label">{v.label}</span>
                    </button>
                  ),
                )}
              </fieldset>
            )}
          </div>
        </Sheet>
      )}
      {((active && active.length > 0) || result) && (
        <div className="filter-bar-active">
          {active?.map((a) => (
            <span key={a.id} className="chip chip-removable">
              <span>{a.label}</span>
              <button type="button" className="chip-remove" aria-label={`Remove filter ${a.label}`} onClick={a.onRemove}>
                <I name="x" size={14} />
              </button>
            </span>
          ))}
          {onClearAll && active && active.length > 0 && (
            <button type="button" className="link-btn" onClick={onClearAll}>
              Clear all
            </button>
          )}
          {result && (
            <span className="filter-bar-result" role="status">
              {result}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---- AdminTabs -------------------------------------------------------------------------------------------

/** The Admin tabs (People, Roles and access, Projects, System), filtered by permission; hidden when only one. */
export function AdminTabs({ current }: { current: AdminTabId }) {
  const boot = useOptionalBoot();
  if (!boot) return null;
  const tabs = visible(ADMIN_TABS, { me: boot.me, scopes: boot.scopes });
  if (tabs.length <= 1) return null;
  return <Tabs label="Admin" value={current} items={tabs.map((t) => ({ id: t.id, label: t.label, href: t.href, icon: t.icon }))} />;
}

// ---- Stepper ---------------------------------------------------------------------------------------------

export interface StepperProps {
  steps: { id: string; title: string; status: "done" | "current" | "todo"; content?: ReactNode }[];
}

/** Numbered steps (Connect, setup). Done steps show a check; the current one has aria-current="step". */
export function Stepper({ steps }: StepperProps) {
  return (
    <ol className="stepper">
      {steps.map((s, i) => (
        <li key={s.id} className="stepper-item" data-status={s.status} aria-current={s.status === "current" ? "step" : undefined}>
          <span className="stepper-number" aria-hidden="true">
            {s.status === "done" ? <I name="check" size={14} /> : i + 1}
          </span>
          <div className="stepper-main">
            <p className="stepper-title">
              {s.title}
              <span className="sr-only">{s.status === "done" ? " (done)" : s.status === "current" ? " (current step)" : ""}</span>
            </p>
            {s.content && <div className="stepper-content">{s.content}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

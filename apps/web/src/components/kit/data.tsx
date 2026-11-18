/**
 * Tables and lists (SPEC §5.6): DataTable (card mode ≤ 760px), RowList/ListRow (whole-row links, keyboard cursor,
 * selection), ItemRow (the one way to draw an article or finding), GroupHeader, BulkBar, LoadMore, MetaLine, Facts.
 */
import { forwardRef, Fragment, useEffect, useRef, type ReactNode, type RefObject } from "react";
import { href as hashHref } from "../../router";
import { useShortcuts } from "../../hooks";
import { I } from "../icons";
import { plural, statusMeta } from "../labels";
import { Button } from "./button";
import { CountBadge, LocationLabel, RelativeTime, StatusBadge, TypeLabel } from "./display";
import { Skeleton } from "./feedback";
import { InfoTip, OverflowMenu, type MenuItemSpec } from "./overlay";
import { cx } from "./util";

// ---- DataTable ----------------------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "start" | "end";
  width?: string;
  sortable?: boolean;
  numeric?: boolean;
  mobileLabel?: string;
  hideBelow?: 760 | 1100;
  primary?: boolean;
}
export interface DataTableProps<T> {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  sort?: { key: string; dir: "asc" | "desc" };
  onSortChange?: (s: { key: string; dir: "asc" | "desc" }) => void;
  selection?: { selected: Set<string>; onChange: (next: Set<string>) => void; isSelectable?: (row: T) => boolean; label: (row: T) => string };
  rowHref?: (row: T) => string | undefined;
  rowAction?: (row: T) => ReactNode;
  rowMenu?: (row: T) => MenuItemSpec[];
  rowTone?: (row: T) => "muted" | undefined;
  indent?: (row: T) => number;
  loading?: boolean;
  empty: ReactNode;
  density?: "comfortable" | "compact";
}

function SelectAll({ checked, onChange, label }: { checked: boolean | "mixed"; onChange: (b: boolean) => void; label: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked === "mixed";
  }, [checked]);
  return <input ref={ref} type="checkbox" checked={checked === true} aria-checked={checked === "mixed" ? "mixed" : checked} aria-label={label} onChange={(e) => onChange(e.target.checked)} />;
}

/** A semantic table: sticky sentence-case headers, sortable columns, selection, one inline action plus ⋯. */
export function DataTable<T>({
  caption,
  columns,
  rows,
  getRowId,
  sort,
  onSortChange,
  selection,
  rowHref,
  rowAction,
  rowMenu,
  rowTone,
  indent,
  loading,
  empty,
  density = "comfortable",
}: DataTableProps<T>) {
  if (!loading && rows.length === 0) return <>{empty}</>;
  const primaryKey = (columns.find((c) => c.primary) ?? columns[0])?.key;
  const selectable = selection ? rows.filter((r) => selection.isSelectable?.(r) ?? true) : [];
  const selectedCount = selection ? selectable.filter((r) => selection.selected.has(getRowId(r))).length : 0;
  const allState: boolean | "mixed" = selectedCount === 0 ? false : selectedCount === selectable.length ? true : "mixed";
  const hasActions = !!(rowAction || rowMenu);
  const cellClass = (c: Column<T>) => cx((c.numeric || c.align === "end") && "cell-num", c.key === primaryKey && "cell-primary", c.hideBelow && `hide-below-${c.hideBelow}`);

  return (
    <div className="data-table-wrap">
      <table className="table data-table" data-density={density} aria-busy={loading || undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {selection && (
              <th scope="col" className="cell-select">
                <SelectAll
                  checked={allState}
                  label="Select all"
                  onChange={(on) => {
                    const next = new Set(selection.selected);
                    for (const r of selectable) on ? next.add(getRowId(r)) : next.delete(getRowId(r));
                    selection.onChange(next);
                  }}
                />
              </th>
            )}
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cellClass(c)}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : c.sortable ? "none" : undefined}
                >
                  {c.sortable && onSortChange ? (
                    <button type="button" className="data-table-sort" onClick={() => onSortChange({ key: c.key, dir: active && sort!.dir === "asc" ? "desc" : "asc" })}>
                      {c.header}
                      <I name={active ? "sort" : "sort"} size={14} className={cx("data-table-sort-icon", active && `is-${sort!.dir}`)} />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
            {hasActions && (
              <th scope="col" className="cell-actions">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0
            ? Array.from({ length: 4 }, (_, i) => (
                <tr key={`sk-${i}`} aria-hidden="true">
                  {selection && <td className="cell-select" />}
                  {columns.map((c) => (
                    <td key={c.key} className={cellClass(c)}>
                      <Skeleton width={c.key === primaryKey ? "70%" : "50%"} />
                    </td>
                  ))}
                  {hasActions && <td className="cell-actions" />}
                </tr>
              ))
            : rows.map((row) => {
                const id = getRowId(row);
                const link = rowHref?.(row);
                const canSelect = selection && (selection.isSelectable?.(row) ?? true);
                const depth = indent?.(row) ?? 0;
                return (
                  <tr key={id} data-tone={rowTone?.(row)} data-selected={selection?.selected.has(id) || undefined} data-linked={link ? true : undefined}>
                    {selection && (
                      <td className="cell-select">
                        {canSelect && (
                          <input
                            type="checkbox"
                            aria-label={selection.label(row)}
                            checked={selection.selected.has(id)}
                            onChange={(e) => {
                              const next = new Set(selection.selected);
                              e.target.checked ? next.add(id) : next.delete(id);
                              selection.onChange(next);
                            }}
                          />
                        )}
                      </td>
                    )}
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={cellClass(c)}
                        data-label={c.key === primaryKey ? undefined : (c.mobileLabel ?? c.header)}
                        style={c.key === primaryKey && depth ? ({ "--indent": `${depth * 1.25}rem` } as React.CSSProperties) : undefined}
                      >
                        {c.key === primaryKey && link ? (
                          <a className="data-table-link" href={link}>
                            {c.cell(row)}
                          </a>
                        ) : (
                          c.cell(row)
                        )}
                      </td>
                    ))}
                    {hasActions && (
                      <td className="cell-actions">
                        <div className="cell-actions-inner">
                          {rowAction?.(row)}
                          {rowMenu && <OverflowMenu items={rowMenu(row)} size="sm" />}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
        </tbody>
      </table>
    </div>
  );
}

// ---- RowList / ListRow ---------------------------------------------------------------------------------

export interface RowListProps {
  label: string;
  children: ReactNode;
  keyboardRef?: RefObject<HTMLUListElement>;
  density?: "comfortable" | "compact";
  refreshing?: boolean;
}

/** A list of rows. Pass `keyboardRef` to bind list-scoped keys (j/k, x, o) with useShortcuts({ target }). */
export const RowList = forwardRef<HTMLUListElement, RowListProps>(function RowList({ label, children, keyboardRef, density = "comfortable", refreshing }, ref) {
  return (
    <ul ref={keyboardRef ?? ref} className="row-list" aria-label={label} data-density={density} aria-busy={refreshing || undefined} data-refreshing={refreshing || undefined}>
      {children}
    </ul>
  );
});

export interface ListRowProps {
  title: ReactNode;
  href?: string;
  external?: boolean;
  leading?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  badges?: ReactNode;
  trailing?: ReactNode;
  actions?: ReactNode;
  selectable?: { checked: boolean; onChange(next: boolean): void; label: string };
  cursor?: boolean;
  selected?: boolean;
  unread?: boolean;
  tone?: "muted";
  error?: ReactNode;
  id?: string;
  /** Lines under the description that must not be clamped (warnings, markers, notes). */
  extra?: ReactNode;
}

/** One row: the whole row is clickable through the title link; inner controls sit above it. */
export function ListRow({ title, href, external, leading, description, meta, badges, trailing, actions, selectable, cursor, selected, unread, tone, error, id, extra }: ListRowProps) {
  return (
    <li className="list-row" id={id} data-cursor={cursor || undefined} data-selected={selected || undefined} data-unread={unread || undefined} data-tone={tone} data-linked={href ? true : undefined}>
      {selectable && (
        <span className="list-row-gutter">
          <input type="checkbox" checked={selectable.checked} aria-label={selectable.label} onChange={(e) => selectable.onChange(e.target.checked)} />
        </span>
      )}
      {leading && <span className="list-row-leading">{leading}</span>}
      <div className="list-row-main">
        <div className="list-row-title">
          {href ? (
            <a href={href} target={external ? "_blank" : undefined} rel={external ? "noopener noreferrer" : undefined}>
              {unread && (
                <span className="list-row-unread">
                  <span className="sr-only">Unread: </span>
                </span>
              )}
              {title}
              {external && (
                <>
                  <I name="external" size={14} />
                  <span className="sr-only"> (opens in a new tab)</span>
                </>
              )}
            </a>
          ) : (
            <span>
              {unread && (
                <span className="list-row-unread">
                  <span className="sr-only">Unread: </span>
                </span>
              )}
              {title}
            </span>
          )}
          {badges && <span className="list-row-badges">{badges}</span>}
        </div>
        {description && <div className="list-row-description">{description}</div>}
        {extra && <div className="list-row-extra">{extra}</div>}
        {meta && <div className="list-row-meta">{meta}</div>}
        {error && (
          <div className="list-row-error" role="alert">
            {error}
          </div>
        )}
      </div>
      {trailing && <div className="list-row-trailing">{trailing}</div>}
      {actions && <div className="list-row-actions">{actions}</div>}
    </li>
  );
}

// ---- ItemRow -----------------------------------------------------------------------------------------

export interface ItemRowProps {
  item: {
    kind: "article" | "finding";
    id: string;
    title: string;
    type?: string;
    status?: string;
    scope?: string | { slug: string; kind?: string } | null;
    path?: string;
    section?: string | null;
    updated_at?: string;
    snippet?: string;
    warning?: string;
    via_uses_link?: boolean;
    match?: string;
  };
  show?: { location?: boolean; type?: boolean; status?: boolean; updated?: boolean };
  density?: "comfortable" | "compact";
  actions?: ReactNode;
  note?: ReactNode;
  /** A checkbox gutter for bulk actions. */
  selectable?: ListRowProps["selectable"];
  id?: string;
  cursor?: boolean;
  /** Badges after the status badge (or instead of it, with show.status false). */
  badges?: ReactNode;
  /** Meta items after location · type · updated. */
  metaExtra?: ReactNode[];
  trailing?: ReactNode;
  error?: ReactNode;
}

/** Search snippets mark matches with **…** and code with `…`. */
function SnippetText({ text }: { text: string }) {
  return (
    <>
      {text.split("**").map((part, i) =>
        i % 2 ? (
          <mark key={i}>{part}</mark>
        ) : (
          <Fragment key={i}>{part.split("`").map((p, j) => (j % 2 ? <code key={j}>{p}</code> : <Fragment key={j}>{p}</Fragment>))}</Fragment>
        ),
      )}
    </>
  );
}

/** The one way to draw an article or finding in a list (search, spaces, projects, Home, Trash, Review). */
export function ItemRow({ item, show = {}, density = "comfortable", actions, note, selectable, id, cursor, badges, metaExtra, trailing, error }: ItemRowProps) {
  const { location = true, type = true, status = true, updated = true } = show;
  const link = hashHref(`/${item.kind}/${item.id}`, { section: item.section ?? undefined });
  const kindLabel = item.kind === "finding" ? "Finding" : "Article";
  const showStatus = status && item.status && !statusMeta("item", item.status).hiddenInLists;
  const meta = [
    location && item.scope ? <LocationLabel key="loc" scope={item.scope} path={item.path} /> : null,
    type && item.type ? <TypeLabel key="type" type={item.type} kind={item.kind} /> : null,
    updated && item.updated_at ? <RelativeTime key="upd" date={item.updated_at} prefix="Updated" /> : null,
    ...(metaExtra ?? []),
  ].filter(Boolean) as ReactNode[];
  return (
    <ListRow
      title={
        <>
          {item.title}
          {item.section && <span className="item-row-section"> › {item.section}</span>}
        </>
      }
      href={link}
      leading={
        <span className="item-row-kind">
          <I name={item.kind === "finding" ? "bolt" : "doc"} size={16} />
          <span className="sr-only">{kindLabel}: </span>
        </span>
      }
      id={id}
      cursor={cursor}
      selectable={selectable}
      selected={selectable?.checked}
      trailing={trailing}
      error={error}
      badges={
        showStatus || badges ? (
          <>
            {showStatus && <StatusBadge domain="item" value={item.status} />}
            {badges}
          </>
        ) : undefined
      }
      description={density === "comfortable" && item.snippet ? <SnippetText text={item.snippet} /> : undefined}
      extra={
        item.warning || item.via_uses_link || item.match === "semantic" || note ? (
          <>
            {item.warning && (
              <p className="item-row-warning">
                <I name="alert" size={14} /> {item.warning}
              </p>
            )}
            {(item.via_uses_link || item.match === "semantic") && (
              <p className="item-row-markers">
                {item.via_uses_link && (
                  <span className="item-row-marker">
                    <I name="link" size={14} /> Used by this project
                  </span>
                )}
                {item.match === "semantic" && (
                  <span className="item-row-marker">
                    <I name="sparkle" size={14} /> Related match
                    <InfoTip label="What is a related match?">It matches what you searched for by meaning, not by the exact words.</InfoTip>
                  </span>
                )}
              </p>
            )}
            {note}
          </>
        ) : undefined
      }
      meta={meta.length ? <MetaLine items={meta} /> : undefined}
      actions={actions}
    />
  );
}

// ---- TileGrid ------------------------------------------------------------------------------------------

export interface TileGridProps {
  children: ReactNode;
  /**
   * On phones, tiles sit two across; from this tile on (1-based) each takes the whole row instead, for tiles whose
   * labels or notes are too long for half a phone.
   */
  phoneFullFrom?: number;
}

/**
 * Stat tiles in three columns, so no label or note is cut off at 1280px. A last tile alone in a row of two spans
 * both (five tiles sit 3 + 2); phones show two across (2 + 2 + 1).
 */
export function TileGrid({ children, phoneFullFrom }: TileGridProps) {
  return (
    <div className="tile-grid" data-phone-full-from={phoneFullFrom}>
      {children}
    </div>
  );
}

// ---- GroupHeader, BulkBar, LoadMore -------------------------------------------------------------------

export interface GroupHeaderProps {
  label: string;
  count: number;
  hint?: string;
  warning?: ReactNode;
  open: boolean;
  onToggle(): void;
  selectAll?: { checked: boolean | "mixed"; onChange(b: boolean): void; label: string };
  action?: ReactNode;
  tone?: "success" | "accent" | "neutral" | "danger";
  /** The id of the group's content (for aria-controls). */
  controls?: string;
}

/** A collapsible group in a list: select-all, a disclosure button, the label and count, a hint and an action. */
export function GroupHeader({ label, count, hint, warning, open, onToggle, selectAll, action, tone, controls }: GroupHeaderProps) {
  return (
    <div className="group-header" data-tone={tone}>
      {selectAll && (
        <span className="list-row-gutter">
          <SelectAll checked={selectAll.checked} onChange={selectAll.onChange} label={selectAll.label} />
        </span>
      )}
      <button type="button" className="group-header-toggle" aria-expanded={open} aria-controls={controls} onClick={onToggle}>
        <I name="chevron-right" size={16} className="group-header-chevron" />
        <span className="group-header-label">{label}</span>
        <CountBadge value={count} label={`${count}`} />
      </button>
      {hint && <span className="group-header-hint">{hint}</span>}
      {warning && <span className="group-header-warning">{warning}</span>}
      {action && <span className="group-header-action">{action}</span>}
    </div>
  );
}

export interface BulkBarProps {
  count: number;
  noun: [string, string];
  onClear(): void;
  children: ReactNode;
}

/** "3 selected · {actions} · Clear (Esc)". Appears only when something is selected. */
export function BulkBar({ count, noun, onClear, children }: BulkBarProps) {
  useShortcuts({ Escape: onClear }, count > 0);
  if (count <= 0) return null;
  return (
    <div className="bulk-bar kit-bulk-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-bar-count" aria-live="polite">
        {count} {count === 1 ? noun[0] : noun[1]} selected
      </span>
      <div className="bulk-bar-actions">{children}</div>
      <button type="button" className="link-btn bulk-bar-clear" onClick={onClear}>
        Clear <span className="bulk-bar-key">(Esc)</span>
      </button>
    </div>
  );
}

export interface LoadMoreProps {
  shown: number;
  total?: number;
  noun: [string, string];
  onMore?: () => void;
  busy?: boolean;
  capNote?: string;
}

/** "Showing 100 of 240 · Load more", or the cap note for capped lists. */
export function LoadMore({ shown, total, noun, onMore, busy, capNote }: LoadMoreProps) {
  if (total !== undefined && shown >= total && !capNote) return null;
  return (
    <div className="load-more">
      <span className="load-more-count" aria-live="polite">
        {capNote ?? (total !== undefined ? `Showing ${shown.toLocaleString("en-GB")} of ${plural(total, noun[0], noun[1])}` : `Showing ${plural(shown, noun[0], noun[1])}`)}
      </span>
      {onMore && (total === undefined || shown < total) && (
        <Button size="sm" loading={busy} loadingText="Loading more" onClick={onMore}>
          Load more
        </Button>
      )}
    </div>
  );
}

/** "Order service v2 · Runbook · Updated 2 days ago". */
export function MetaLine({ items }: { items: ReactNode[] }) {
  const shown = items.filter((i) => i !== null && i !== undefined && i !== false && i !== "");
  return (
    <span className="meta-line">
      {shown.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span className="meta-line-sep" aria-hidden="true">
              ·
            </span>
          )}
          <span className="meta-line-item">{item}</span>
        </Fragment>
      ))}
    </span>
  );
}

/** A definition list of facts; one column ≤ 860px. */
export function Facts({ items, columns = 1 }: { items: { term: string; value: ReactNode; hint?: string }[]; columns?: 1 | 2 }) {
  return (
    <dl className="facts" data-columns={columns}>
      {items.map((f) => (
        <div key={f.term} className="facts-row">
          <dt>{f.term}</dt>
          <dd>
            {f.value}
            {f.hint && <span className="facts-hint">{f.hint}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

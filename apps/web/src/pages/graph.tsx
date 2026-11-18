import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ScopeInfo } from "../api";
import { humanize, plural, typeLabel } from "../components/labels";
import {
  AsyncBlock,
  Badge,
  Button,
  Chip,
  DataTable,
  Disclosure,
  EmptyState,
  IconButton,
  LocationLabel,
  Page,
  PageHeader,
  ProjectPicker,
  SearchInput,
  Section,
  SegmentedControl,
  Skeleton,
  Switch,
  type Column,
} from "../components/kit";
import { useApi, useLiveRefresh, useQueryState } from "../hooks";
import { href, type Route } from "../router";

interface GNode extends SimulationNodeDatum {
  id: string;
  kind: "article" | "finding" | "project" | "component";
  label: string;
  type: string;
  status: string;
  scope: string;
  scope_kind: string;
  degree: number;
}
interface GEdge extends SimulationLinkDatum<GNode> {
  kind: string;
}
type RawNode = Omit<GNode, "degree">;
type RawEdge = { source: string; target: string; kind: string };

// Identity is colour AND shape, so it never relies on colour alone (three validated slots, all-pairs).
// A repository (component) is a hollow square in the project colour.
const KIND: Record<GNode["kind"], { label: string; color: string; shape: "circle" | "diamond" | "square"; hollow?: boolean }> = {
  article: { label: "Article", color: "var(--series-1)", shape: "circle" },
  finding: { label: "Finding", color: "var(--series-2)", shape: "diamond" },
  project: { label: "Project", color: "var(--series-3)", shape: "square" },
  component: { label: "Repository", color: "var(--series-3)", shape: "square", hollow: true },
};

const RELATION: Record<string, string> = {
  uses: "uses",
  depends_on: "depends on",
  provided_by: "provided by",
  consumed_by: "consumed by",
  related: "related",
  same_root_cause: "same root cause",
  supersedes: "replaces",
  promoted_into: "added to",
  published_as: "published as",
  reads: "reads",
  writes: "writes",
  part_of: "part of",
  belongs_to: "in",
};
const relation = (kind: string) => RELATION[kind] ?? humanize(kind).toLowerCase();

const MIN_K = 0.3;
const MAX_K = 3;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl";

function Shape({ node, r, stroke, dashed }: { node: Pick<GNode, "kind">; r: number; stroke?: string; dashed?: boolean }) {
  const k = KIND[node.kind];
  const fill = k.hollow ? "var(--surface)" : k.color;
  const line = k.hollow ? k.color : (stroke ?? "var(--surface)");
  const common = { fill, stroke: line, strokeWidth: 2, strokeDasharray: dashed ? "3 2" : undefined };
  if (k.shape === "circle") return <circle r={r} {...common} />;
  if (k.shape === "diamond") return <rect x={-r * 0.85} y={-r * 0.85} width={r * 1.7} height={r * 1.7} transform="rotate(45)" rx={2} {...common} />;
  return <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={node.kind === "project" ? 4 : 2} {...common} />;
}

function itemHref(n: Pick<GNode, "kind" | "id" | "scope" | "label">) {
  if (n.kind === "article") return href(`/article/${n.id}`);
  if (n.kind === "finding") return href(`/finding/${n.id}`);
  return href(`/project/${n.scope}`, n.kind === "component" ? { component: n.label.split(" · ")[1] } : undefined);
}

/** Components show just their name; the edge to the project says which project. */
function nodeName(n: Pick<GNode, "kind" | "label">) {
  return n.kind === "component" ? (n.label.split(" · ")[1] ?? n.label) : n.label;
}

function shortLabel(n: GNode) {
  const text = nodeName(n);
  return text.length > 32 ? `${text.slice(0, 31)}…` : text;
}

function radius(n: GNode) {
  if (n.kind === "project") return 13;
  if (n.kind === "component") return 7;
  return Math.min(13, 6 + Math.sqrt(n.degree) * 2.2);
}

function matches(n: Pick<GNode, "label">, q: string) {
  return !!q && n.label.toLowerCase().includes(q);
}

// ---- Page --------------------------------------------------------------------------------------------------------

interface GraphData {
  nodes: RawNode[];
  edges: RawEdge[];
  truncated: boolean;
}

export function GraphPage({ route, scopes }: { route: Route; scopes: ScopeInfo[] }) {
  const [qs, setQs] = useQueryState(route, { view: "graph", list: "items" });
  const scope = qs.scope ?? "";
  const focus = qs.focus ?? "";
  const query = qs.q ?? "";
  const showUnlinked = qs.unlinked === "1";
  const view = qs.view === "list" ? "list" : "graph";
  const params = new URLSearchParams({ ...(scope ? { scope } : {}), ...(focus ? { focus, depth: "2" } : {}) }).toString();
  const result = useApi<GraphData>(`/graph${params ? `?${params}` : ""}`);
  useLiveRefresh(result.reload);
  const data = result.data;
  const whereRef = useRef<HTMLSpanElement>(null);
  const [fitMatches, setFitMatches] = useState(0);
  const focusNode = focus ? data?.nodes.find((n) => n.id === focus) : undefined;

  // Unlinked items scatter across the canvas and bury the structure; show them on request.
  const shown = useMemo(() => {
    if (!data) return null;
    const linked = new Set(data.edges.flatMap((e) => [e.source, e.target]));
    const unlinked = data.nodes.filter((n) => !linked.has(n.id)).length;
    const nodes = showUnlinked || linked.size === 0 ? data.nodes : data.nodes.filter((n) => linked.has(n.id));
    return { nodes, unlinked };
  }, [data, showUnlinked]);
  const q = query.trim().toLowerCase();
  const matchCount = q && shown ? shown.nodes.filter((n) => matches(n, q)).length : 0;

  return (
    <Page width="wide">
      <PageHeader
        title="Knowledge graph"
        nav="graph"
        description="How projects, contracts, designs, shared library items and findings connect."
        info={{
          label: "How to use the graph",
          content: (
            <>
              <p>Hover or tap a node to trace its links. Click it to pin its details; double-click (or tap it again) to open it.</p>
              <p>Hold {MOD} and scroll to zoom (or click the canvas first) · drag to pan · drag a node to pin it · + and − zoom, 0 fits.</p>
              <p>The List view shows the same items and links as tables, for keyboards and screen readers.</p>
            </>
          ),
        }}
      />
      <div className="gr-toolbar">
        <SegmentedControl
          label="View"
          value={view}
          onChange={(v) => setQs({ view: v })}
          options={[
            { value: "graph", label: "Graph", icon: "graph" },
            { value: "list", label: "List", icon: "list" },
          ]}
        />
        <label className="gr-field">
          <span className="gr-field-label">Where</span>
          <span ref={whereRef} className="gr-where">
            <ProjectPicker value={scope} onChange={(v) => setQs({ scope: v || undefined })} scopes={scopes} noneLabel="All spaces" />
          </span>
        </label>
        <div
          className="gr-highlight"
          onKeyDown={(e) => {
            if (e.key === "Enter" && q) {
              e.preventDefault();
              setFitMatches((n) => n + 1);
            }
          }}
        >
          <SearchInput value={query} onChange={(v) => setQs({ q: v || undefined })} label="Highlight items" placeholder="Highlight items" debounceMs={200} />
          {q && shown && (
            <span className="gr-match-count" role="status">
              {matchCount ? plural(matchCount, "match", "matches") : "No items match"}
            </span>
          )}
        </div>
        {shown && shown.unlinked > 0 && (
          <Switch checked={showUnlinked} onChange={(next) => setQs({ unlinked: next ? "1" : undefined })} label={`Show ${plural(shown.unlinked, "unlinked item")}`} />
        )}
      </div>
      {(focus || data?.truncated) && (
        <div className="gr-notes">
          {focus && <Chip onRemove={() => setQs({ focus: undefined })} removeLabel="Show the whole graph">Around {focusNode ? nodeName({ ...focusNode }) : "this item"}</Chip>}
          {data?.truncated && (
            <span className="gr-truncated">
              <Badge tone="warning" icon="alert">
                Showing the most recently updated items
              </Badge>
              <button type="button" className="link-btn" onClick={() => whereRef.current?.querySelector("select")?.focus()}>
                Pick a space to see all of it
              </button>
            </span>
          )}
        </div>
      )}
      <AsyncBlock
        result={result}
        label="Loading the graph"
        skeleton={<Skeleton height={480} />}
        errorTitle="The graph didn't load"
        isEmpty={(d) => d.nodes.length === 0}
        empty={<EmptyState icon="graph" title="Nothing to map yet" description="As articles, findings and links are added, they appear here." />}
      >
        {(d) =>
          view === "list" ? (
            <GraphList nodes={shown!.nodes} edges={d.edges} q={q} list={qs.list === "links" ? "links" : "items"} onList={(v) => setQs({ list: v })} />
          ) : (
            <GraphCanvas
              key={`${scope}:${focus}`}
              nodes={shown!.nodes}
              edges={d.edges}
              query={query}
              focusId={focus || undefined}
              fitMatches={fitMatches}
              onFocusNode={(id) => setQs({ focus: id }, { push: true })}
            />
          )
        }
      </AsyncBlock>
    </Page>
  );
}
GraphPage.keepMountedOnQuery = true;

// ---- List view (the keyboard-accessible alternative to the canvas) -------------------------------------------------

type ListNode = RawNode & { degree: number };
type ListEdge = { id: string; from: RawNode; to: RawNode; kind: string };

function NodeLink({ n }: { n: RawNode }) {
  return (
    <span className="gr-node-link">
      <a href={itemHref(n)}>{nodeName(n)}</a>
      <span className="gr-kind">{KIND[n.kind].label}</span>
    </span>
  );
}

function GraphList({ nodes, edges, q, list, onList }: { nodes: RawNode[]; edges: RawEdge[]; q: string; list: "items" | "links"; onList: (v: "items" | "links") => void }) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "links", dir: "desc" });
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const items: ListNode[] = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const rows = nodes.filter((n) => !q || matches(n, q)).map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
    const dir = sort.dir === "asc" ? 1 : -1;
    return rows.sort((a, b) => (sort.key === "links" ? (a.degree - b.degree) * dir || nodeName(a).localeCompare(nodeName(b)) : nodeName(a).localeCompare(nodeName(b)) * dir));
  }, [nodes, edges, q, sort]);
  const links: ListEdge[] = useMemo(
    () =>
      edges
        .map((e, i) => ({ id: String(i), from: byId.get(e.source), to: byId.get(e.target), kind: e.kind }))
        .filter((e): e is ListEdge => !!e.from && !!e.to && (!q || matches(e.from, q) || matches(e.to, q))),
    [edges, byId, q],
  );

  const nodeColumns: Column<ListNode>[] = [
    { key: "item", header: "Item", primary: true, sortable: true, cell: (n) => <NodeLink n={n} /> },
    { key: "space", header: "Space", cell: (n) => <LocationLabel scope={{ slug: n.scope, kind: n.scope_kind }} />, mobileLabel: "Space" },
    { key: "type", header: "Type", hideBelow: 1100, cell: (n) => (n.kind === "article" || n.kind === "finding" ? typeLabel(n.type) : "—") },
    { key: "links", header: "Links", numeric: true, align: "end", sortable: true, cell: (n) => n.degree, mobileLabel: "Links" },
  ];
  const edgeColumns: Column<ListEdge>[] = [
    { key: "from", header: "From", primary: true, cell: (e) => <NodeLink n={e.from} /> },
    { key: "relation", header: "Relation", cell: (e) => <span className="muted">{relation(e.kind)}</span>, mobileLabel: "Relation" },
    { key: "to", header: "To", cell: (e) => <NodeLink n={e.to} />, mobileLabel: "To" },
  ];

  return (
    <div className="gr-list">
      <SegmentedControl
        label="Show"
        size="sm"
        value={list}
        onChange={onList}
        options={[
          { value: "items", label: "Items", count: items.length },
          { value: "links", label: "Links", count: links.length },
        ]}
      />
      {list === "items" ? (
        <DataTable
          caption="Items in the graph"
          columns={nodeColumns}
          rows={items}
          getRowId={(n) => n.id}
          sort={{ key: sort.key === "item" ? "item" : sort.key, dir: sort.dir }}
          onSortChange={(s) => setSort(s)}
          empty={<EmptyState variant="compact" icon="search" title="No items match" />}
        />
      ) : (
        <DataTable caption="Links between items" columns={edgeColumns} rows={links} getRowId={(e) => e.id} empty={<EmptyState variant="compact" icon="link" title={q ? "No links match" : "No links yet"} />} />
      )}
    </div>
  );
}

// ---- Canvas -------------------------------------------------------------------------------------------------------

export function GraphCanvas({
  nodes: rawNodes,
  edges: rawEdges,
  query = "",
  focusId,
  height,
  compact = false,
  fitMatches,
  onFocusNode,
}: {
  nodes: RawNode[];
  edges: RawEdge[];
  query?: string;
  focusId?: string;
  height?: number;
  compact?: boolean;
  /** Bump to zoom to the nodes matching `query` (Enter in the highlight field). */
  fitMatches?: number;
  /** Shows "Focus here" in the details panel (the graph page). */
  onFocusNode?: (id: string) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: height ?? 560 });
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [armed, setArmed] = useState(false);
  const [hint, setHint] = useState(false);
  const drag = useRef<{ mode: "pan" | "node"; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  // Touch: active pointers for pinch-to-zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; k: number } | null>(null);
  const lastClick = useRef<{ id: string; t: number } | null>(null);
  const userMoved = useRef(false);
  const hintTimer = useRef<number>();
  // Live values for the native wheel listener.
  const live = useRef({ view, size, armed });
  live.current = { view, size, armed };

  const { nodes, edges, sim } = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of rawEdges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    // Nodes already on screen keep their place when the graph refreshes; new ones settle in around them.
    const nodes: GNode[] = rawNodes.map((n) => {
      const p = positions.current.get(n.id);
      return { ...n, degree: degree.get(n.id) ?? 0, ...(p ? { x: p.x, y: p.y } : {}) };
    });
    const ids = new Set(nodes.map((n) => n.id));
    const edges: GEdge[] = rawEdges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e) => ({ ...e }));
    const sim = forceSimulation(nodes)
      // Small graphs get more room so their (always shown) labels don't collide.
      .force("link", forceLink<GNode, GEdge>(edges).id((d) => d.id).distance((l) => (l.kind === "part_of" ? 55 : l.kind === "belongs_to" ? 80 : 105) * (nodes.length < 20 ? 1.45 : 1)).strength(0.55))
      .force("charge", forceManyBody().strength(nodes.length < 20 ? -700 : -340))
      .force("collide", forceCollide<GNode>().radius((d) => radius(d) + (nodes.length < 20 ? 38 : 22)))
      .force("x", forceX().strength(0.04))
      .force("y", forceY().strength(0.06))
      .force("center", forceCenter(0, 0))
      .stop();
    return { nodes, edges, sim };
  }, [rawNodes, rawEdges]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: height ?? Math.max(460, Math.min(720, window.innerHeight - 260)) }));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [height]);

  /** Zoom and centre so the given nodes (all by default), with room for labels, fit the canvas. */
  const fit = (subset?: GNode[], s = live.current.size) => {
    const list = subset?.length ? subset : nodes;
    if (!list.length || !s.w) return;
    const xs = list.map((n) => n.x ?? 0);
    const ys = list.map((n) => n.y ?? 0);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 90, Math.max(...xs) + 90, Math.min(...ys) - 40, Math.max(...ys) + 50];
    const k = Math.min(1.3, clampK(Math.min(s.w / (x1 - x0), s.h / (y1 - y0))));
    setView({ k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k });
  };

  useEffect(() => {
    // Settle most of the layout before the first paint, then animate the rest.
    const known = nodes.filter((n) => positions.current.has(n.id)).length;
    const refreshing = known > nodes.length / 2;
    for (let i = 0; i < (refreshing ? 15 : 160); i++) sim.tick();
    if (!refreshing) fit();
    let frame = 0;
    sim.on("tick", () => {
      for (const n of nodes) positions.current.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 });
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((t) => t + 1));
    });
    sim.alpha(refreshing ? 0.08 : 0.3).restart();
    return () => {
      sim.stop();
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim]);

  // Until the person zooms or pans, keep the whole graph in view when the canvas changes size.
  useEffect(() => {
    if (!userMoved.current) fit(undefined, size);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h]);

  const q = query.trim().toLowerCase();
  useEffect(() => {
    if (!fitMatches || !q) return;
    userMoved.current = true;
    fit(nodes.filter((n) => matches(n, q)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitMatches]);

  const zoomAt = (cx: number, cy: number, factor: number) => {
    userMoved.current = true;
    setView((v) => {
      const s = live.current.size;
      const k = clampK(v.k * factor);
      const wx = (cx - s.w / 2 - v.x) / v.k;
      const wy = (cy - s.h / 2 - v.y) / v.k;
      return { k, x: cx - s.w / 2 - wx * k, y: cy - s.h / 2 - wy * k };
    });
  };
  const zoomCentre = (factor: number) => zoomAt(live.current.size.w / 2, live.current.size.h / 2, factor);

  // Wheel zoom only with ⌘/Ctrl held (trackpad pinch sends ctrlKey too), or once the canvas was clicked or focused.
  // Otherwise the page scrolls and a short hint says how to zoom. A native listener, so preventDefault works.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const on = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey || live.current.armed)) {
        setHint(true);
        window.clearTimeout(hintTimer.current);
        hintTimer.current = window.setTimeout(() => setHint(false), 2000);
        return;
      }
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    el.addEventListener("wheel", on, { passive: false });
    return () => {
      el.removeEventListener("wheel", on);
      window.clearTimeout(hintTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = hover ?? selected;
  const neighbors = useMemo(() => {
    if (!active) return null;
    const set = new Set([active]);
    for (const e of edges) {
      const s = (e.source as GNode).id;
      const t = (e.target as GNode).id;
      if (s === active) set.add(t);
      if (t === active) set.add(s);
    }
    return set;
  }, [active, edges]);

  const toWorld = (cx: number, cy: number) => ({ x: (cx - size.w / 2 - view.x) / view.k, y: (cy - size.h / 2 - view.y) / view.k });
  const local = (e: React.PointerEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return { cx: e.clientX - r.left, cy: e.clientY - r.top };
  };
  const shownNode = active ? nodes.find((n) => n.id === active) : undefined;
  const pinned = !!selected && shownNode?.id === selected;
  const showAllLabels = view.k >= 1.35 || nodes.length <= 25;
  const open = (n: GNode) => {
    window.location.hash = itemHref(n).slice(1);
  };

  return (
    <div className="gr-card">
      <div className="gr-legend" data-compact={compact || undefined}>
        {(["article", "finding", "project", "component"] as const).map((k) => (
          <span key={k} className="gr-legend-item">
            <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
              <Shape node={{ kind: k }} r={k === "component" ? 4 : 5} stroke="none" />
            </svg>
            {KIND[k].label}
          </span>
        ))}
        <span className="gr-legend-item">
          <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true">
            <circle r={5} className="gr-legend-stale" />
          </svg>
          Needs a check
        </span>
        {!compact && <span className="gr-hint">{MOD} + scroll to zoom · drag to pan · drag a node to pin it</span>}
      </div>
      <div
        ref={wrap}
        className="gr-wrap"
        style={{ height: size.h }}
        tabIndex={0}
        role="group"
        aria-label={`Graph canvas, ${plural(nodes.length, "item")}. Plus and minus zoom, 0 fits, arrow keys pan. The List view lists the same items.`}
        data-armed={armed || undefined}
        onFocus={(e) => e.target === e.currentTarget && setArmed(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setArmed(false)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const pan = (dx: number, dy: number) => {
            userMoved.current = true;
            setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
          };
          const keys: Record<string, () => void> = {
            "+": () => zoomCentre(1.25),
            "=": () => zoomCentre(1.25),
            "-": () => zoomCentre(1 / 1.25),
            "0": () => fit(),
            ArrowLeft: () => pan(60, 0),
            ArrowRight: () => pan(-60, 0),
            ArrowUp: () => pan(0, 60),
            ArrowDown: () => pan(0, -60),
            Escape: () => setSelected(null),
          };
          const fn = keys[e.key];
          if (!fn || e.metaKey || e.ctrlKey || e.altKey) return;
          if (e.key === "Escape" && !selected) return;
          e.preventDefault();
          fn();
        }}
        onPointerDown={(e) => {
          if ((e.target as Element).closest("a, button, .gr-panel")) return; // the details panel and the zoom buttons
          setArmed(true);
          const target = (e.target as Element).closest("[data-node]");
          const { cx, cy } = local(e);
          pointers.current.set(e.pointerId, { x: cx, y: cy });
          if (pointers.current.size === 2) {
            // Second finger: pinch to zoom instead of dragging.
            const [a, b] = [...pointers.current.values()];
            pinch.current = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, k: view.k };
            drag.current = null;
            return;
          }
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = target
            ? { mode: "node", id: target.getAttribute("data-node")!, sx: cx, sy: cy, vx: view.x, vy: view.y, moved: false }
            : { mode: "pan", sx: cx, sy: cy, vx: view.x, vy: view.y, moved: false };
        }}
        onPointerMove={(e) => {
          const { cx, cy } = local(e);
          if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: cx, y: cy });
          if (pinch.current && pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()];
            const k = clampK((pinch.current.k * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / pinch.current.dist);
            const mx = (a!.x + b!.x) / 2;
            const my = (a!.y + b!.y) / 2;
            const w = toWorld(mx, my);
            userMoved.current = true;
            setView({ k, x: mx - size.w / 2 - w.x * k, y: my - size.h / 2 - w.y * k });
            return;
          }
          const d = drag.current;
          if (!d) return;
          if (Math.abs(cx - d.sx) + Math.abs(cy - d.sy) > 3) d.moved = true;
          if (!d.moved) return;
          if (d.mode === "pan") {
            userMoved.current = true;
            setView((v) => ({ ...v, x: d.vx + cx - d.sx, y: d.vy + cy - d.sy }));
          } else {
            const n = nodes.find((x) => x.id === d.id)!;
            const w = toWorld(cx, cy);
            n.fx = w.x;
            n.fy = w.y;
            sim.alphaTarget(0.2).restart();
          }
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          if (pinch.current) {
            if (pointers.current.size < 2) pinch.current = null;
            drag.current = null;
            return;
          }
          const d = drag.current;
          drag.current = null;
          sim.alphaTarget(0);
          if (d?.mode === "node" && !d.moved) {
            const n = nodes.find((x) => x.id === d.id);
            if (!n) return;
            const now = Date.now();
            const touch = e.pointerType !== "mouse";
            // Mouse: a click pins the details, a double click opens. Touch: the first tap selects, the second opens.
            const again = touch ? selected === n.id : lastClick.current?.id === n.id && now - lastClick.current.t < 450;
            lastClick.current = { id: n.id, t: now };
            if (again) open(n);
            else setSelected(n.id);
          } else if (d?.mode === "pan" && !d.moved) {
            setSelected(null);
            setHover(null);
          }
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          pinch.current = null;
          drag.current = null;
        }}
      >
        <svg width={size.w} height={size.h} role="img" aria-label="Knowledge graph">
          <g transform={`translate(${size.w / 2 + view.x},${size.h / 2 + view.y}) scale(${view.k})`}>
            {edges.map((e, i) => {
              const s = e.source as GNode;
              const t = e.target as GNode;
              const on = neighbors ? neighbors.has(s.id) && neighbors.has(t.id) && (s.id === active || t.id === active) : false;
              return (
                <g key={i} className={neighbors && !on ? "gr-dim" : undefined}>
                  <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} className="gr-edge" data-active={on || undefined} />
                  {on && (
                    <text x={((s.x ?? 0) + (t.x ?? 0)) / 2} y={((s.y ?? 0) + (t.y ?? 0)) / 2} className="gr-edge-label" textAnchor="middle" dy="-0.35em">
                      {relation(e.kind)}
                    </text>
                  )}
                </g>
              );
            })}
            {nodes.map((n) => {
              const r = radius(n);
              const match = matches(n, q);
              const dim = (neighbors && !neighbors.has(n.id)) || (q && !match);
              const isFocus = n.id === focusId;
              const stale = n.status === "possibly_stale";
              const label = showAllLabels || isFocus || n.kind === "project" || n.degree >= 4 || neighbors?.has(n.id) || match;
              return (
                <g
                  key={n.id}
                  data-node={n.id}
                  transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                  className={`gr-node${dim ? " gr-dim" : ""}${stale ? " gr-node-stale" : ""}`}
                  data-selected={n.id === selected || undefined}
                  onPointerEnter={(e) => e.pointerType === "mouse" && setHover(n.id)}
                  onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
                >
                  <circle r={r + 8} fill="transparent" />
                  {(match || isFocus || n.id === selected) && <circle r={r + 5} className={isFocus || n.id === selected ? "gr-focus-ring" : "gr-match-ring"} />}
                  <Shape node={n} r={r} dashed={stale} stroke={stale ? KIND[n.kind].color : undefined} />
                  {label && (
                    <text y={r + 14} textAnchor="middle" className="gr-node-label">
                      {shortLabel(n)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        {shownNode && (
          <div className="gr-panel" data-pinned={pinned || undefined} role={pinned ? "region" : undefined} aria-label={pinned ? `Details: ${nodeName(shownNode)}` : undefined}>
            <div className="gr-panel-head">
              <span className="gr-panel-kind">
                {[KIND[shownNode.kind].label, shownNode.kind === "article" || shownNode.kind === "finding" ? typeLabel(shownNode.type) : null].filter(Boolean).join(" · ")}
                {" · "}
                <LocationLabel scope={{ slug: shownNode.scope, kind: shownNode.scope_kind }} />
              </span>
              {pinned && <IconButton icon="x" size="sm" label="Close details" onClick={() => setSelected(null)} />}
            </div>
            <strong className="gr-panel-title">{nodeName(shownNode)}</strong>
            <span className="gr-panel-meta">
              {plural(shownNode.degree, "link")}
              {shownNode.status === "possibly_stale" ? " · Not verified recently" : ""}
            </span>
            {pinned && (
              <span className="gr-panel-actions">
                <Button size="sm" variant="primary" href={itemHref(shownNode)}>
                  Open
                </Button>
                {onFocusNode && shownNode.id !== focusId && (
                  <Button size="sm" icon="graph" onClick={() => onFocusNode(shownNode.id)}>
                    Focus here
                  </Button>
                )}
              </span>
            )}
          </div>
        )}
        {hint && (
          <div className="gr-scroll-hint" role="status">
            Use {MOD} + scroll to zoom
          </div>
        )}
        <div className="gr-zoom">
          <IconButton icon="zoom-in" variant="secondary" label="Zoom in (+)" onClick={() => zoomCentre(1.25)} />
          <IconButton icon="zoom-out" variant="secondary" label="Zoom out (−)" onClick={() => zoomCentre(1 / 1.25)} />
          <IconButton
            icon="fit"
            variant="secondary"
            label="Fit to view (0)"
            onClick={() => {
              userMoved.current = false;
              fit();
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ---- Item pages -------------------------------------------------------------------------------------------------------

/** Local graph of one item's connections (two hops), for article and finding pages. Hidden when it has no links. */
export function RelationsPanel({ id }: { id: string }) {
  const { data } = useApi<{ nodes: RawNode[]; edges: RawEdge[] }>(`/graph?focus=${id}&depth=2`);
  if (!data || data.edges.length === 0) return null;
  const canvas: ReactNode = <GraphCanvas nodes={data.nodes} edges={data.edges} focusId={id} height={340} compact />;
  return (
    <div className="gr-relations">
      <Section
        title="Relationship graph"
        actions={
          <Button size="sm" icon="graph" href={href("/graph", { focus: id })}>
            Open in graph
          </Button>
        }
      >
        {data.nodes.length < 3 ? <Disclosure summary={`Show relationship graph (${data.nodes.length})`}>{canvas}</Disclosure> : canvas}
      </Section>
    </div>
  );
}

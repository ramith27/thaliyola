import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ScopeInfo } from "../api";
import { I } from "../components/icons";
import { ErrorBox, Loading } from "../components/ui";
import { useApi } from "../hooks";
import { href, navigate, type Route } from "../router";

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

// Identity is colour AND shape, so it never relies on colour alone (three validated slots, all-pairs).
const KIND: Record<GNode["kind"], { label: string; color: string; shape: "circle" | "diamond" | "square" }> = {
  article: { label: "Article", color: "var(--series-1)", shape: "circle" },
  finding: { label: "Finding", color: "var(--series-2)", shape: "diamond" },
  project: { label: "Project", color: "var(--series-3)", shape: "square" },
  component: { label: "Component", color: "var(--series-3)", shape: "square" },
};

const RELATION: Record<string, string> = {
  uses: "uses",
  depends_on: "depends on",
  provided_by: "provided by",
  consumed_by: "consumed by",
  related: "related",
  same_root_cause: "same root cause",
  supersedes: "supersedes",
  promoted_into: "promoted into",
  published_as: "published as",
  part_of: "part of",
};

function Shape({ node, r, fill, stroke }: { node: GNode; r: number; fill: string; stroke: string }) {
  const shape = KIND[node.kind].shape;
  if (shape === "circle") return <circle r={r} fill={fill} stroke={stroke} strokeWidth={2} />;
  if (shape === "diamond") return <rect x={-r * 0.85} y={-r * 0.85} width={r * 1.7} height={r * 1.7} transform="rotate(45)" rx={2} fill={fill} stroke={stroke} strokeWidth={2} />;
  return <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={node.kind === "project" ? 4 : 2} fill={fill} stroke={stroke} strokeWidth={2} />;
}

function itemHref(n: GNode) {
  if (n.kind === "article") return href(`/article/${n.id}`);
  if (n.kind === "finding") return href(`/finding/${n.id}`);
  return href(`/project/${n.scope}`, n.kind === "component" ? { component: n.label.split(" · ")[1] } : undefined);
}

export function GraphPage({ route, scopes }: { route: Route; scopes: ScopeInfo[] }) {
  const scope = route.query.get("scope") ?? "";
  const { data, error } = useApi<{ nodes: Omit<GNode, "degree">[]; edges: { source: string; target: string; kind: string }[]; truncated: boolean }>(
    `/graph${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`,
  );
  const [query, setQuery] = useState("");
  const [asTable, setAsTable] = useState(false);
  const [showUnlinked, setShowUnlinked] = useState(false);
  // Unlinked items scatter across the canvas and bury the structure; show them on request.
  const view = useMemo(() => {
    if (!data) return null;
    const linked = new Set(data.edges.flatMap((e) => [e.source, e.target]));
    const unlinked = data.nodes.filter((n) => !linked.has(n.id)).length;
    const nodes = showUnlinked || linked.size === 0 ? data.nodes : data.nodes.filter((n) => linked.has(n.id));
    return { nodes, unlinked };
  }, [data, showUnlinked]);

  return (
    <div className="page page-wide">
      <div className="page-head">
        <div>
          <h1>Knowledge graph</h1>
          <p className="lead">How projects, contracts, designs, shared library items and findings connect. Hover to trace links; click to open.</p>
        </div>
      </div>
      <div className="toolbar">
        <select value={scope} onChange={(e) => navigate("/graph", { scope: e.target.value || undefined })} aria-label="Scope">
          <option value="">All scopes</option>
          {scopes.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
        <div className="toolbar-search">
          <I name="search" size={16} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Highlight items…" aria-label="Highlight items" />
        </div>
        {view && view.unlinked > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={showUnlinked} onChange={(e) => setShowUnlinked(e.target.checked)} />
            Show {view.unlinked} unlinked item{view.unlinked === 1 ? "" : "s"}
          </label>
        )}
        <button className="btn" onClick={() => setAsTable((t) => !t)}>
          <I name={asTable ? "graph" : "table"} size={16} /> {asTable ? "Graph" : "Table"}
        </button>
      </div>
      <ErrorBox error={error} />
      {!data ? (
        !error && <Loading />
      ) : data.nodes.length === 0 ? (
        <div className="empty card">
          <I name="graph" size={28} />
          <p>Nothing to map yet. As articles, findings and links are added, they appear here.</p>
        </div>
      ) : asTable ? (
        <GraphTable nodes={data.nodes} edges={data.edges} />
      ) : (
        <GraphCanvas key={`${scope}:${showUnlinked}`} nodes={view!.nodes} edges={data.edges} query={query} />
      )}
      {data?.truncated && <p className="muted small">Showing the most recently updated items. Pick a scope to see all of it.</p>}
    </div>
  );
}

function GraphTable({ nodes, edges }: { nodes: Omit<GNode, "degree">[]; edges: { source: string; target: string; kind: string }[] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>From</th>
            <th>Relation</th>
            <th>To</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((e, i) => {
            const a = byId.get(e.source)!;
            const b = byId.get(e.target)!;
            return (
              <tr key={i}>
                <td>
                  <a href={itemHref({ ...a, degree: 0 })}>{a.label}</a> <span className="muted small">{KIND[a.kind].label.toLowerCase()}</span>
                </td>
                <td className="muted">{RELATION[e.kind] ?? e.kind}</td>
                <td>
                  <a href={itemHref({ ...b, degree: 0 })}>{b.label}</a> <span className="muted small">{KIND[b.kind].label.toLowerCase()}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GraphCanvas({ nodes: rawNodes, edges: rawEdges, query }: { nodes: Omit<GNode, "degree">[]; edges: { source: string; target: string; kind: string }[]; query: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ mode: "pan" | "node"; id?: string; sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);

  const { nodes, edges, sim } = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of rawEdges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const nodes: GNode[] = rawNodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 }));
    const edges: GEdge[] = rawEdges.map((e) => ({ ...e }));
    const sim = forceSimulation(nodes)
      .force("link", forceLink<GNode, GEdge>(edges).id((d) => d.id).distance((l) => (l.kind === "part_of" ? 55 : 105)).strength(0.55))
      .force("charge", forceManyBody().strength(-340))
      .force("collide", forceCollide<GNode>().radius((d) => radius(d) + 22))
      .force("x", forceX().strength(0.04))
      .force("y", forceY().strength(0.06))
      .force("center", forceCenter(0, 0))
      .stop();
    return { nodes, edges, sim };
  }, [rawNodes, rawEdges]);

  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e!.contentRect.width, h: Math.max(460, Math.min(720, window.innerHeight - 260)) }));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  /** Zoom and centre so the whole graph (with room for labels) fits the canvas. */
  const fit = () => {
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const [x0, x1, y0, y1] = [Math.min(...xs) - 90, Math.max(...xs) + 90, Math.min(...ys) - 40, Math.max(...ys) + 50];
    const k = Math.min(1.3, Math.max(0.3, Math.min(size.w / (x1 - x0), size.h / (y1 - y0))));
    setView({ k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k });
  };

  useEffect(() => {
    // Settle most of the layout before the first paint, then animate the rest.
    for (let i = 0; i < 160; i++) sim.tick();
    fit();
    let frame = 0;
    sim.on("tick", () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setTick((t) => t + 1));
    });
    sim.alpha(0.3).restart();
    return () => {
      sim.stop();
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sim, size.w]);

  const q = query.trim().toLowerCase();
  const neighbors = useMemo(() => {
    if (!hover) return null;
    const set = new Set([hover]);
    for (const e of edges) {
      const s = (e.source as GNode).id;
      const t = (e.target as GNode).id;
      if (s === hover) set.add(t);
      if (t === hover) set.add(s);
    }
    return set;
  }, [hover, edges]);

  const toWorld = (cx: number, cy: number) => ({ x: (cx - size.w / 2 - view.x) / view.k, y: (cy - size.h / 2 - view.y) / view.k });
  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return { cx: e.clientX - r.left, cy: e.clientY - r.top };
  };
  const hovered = hover ? nodes.find((n) => n.id === hover) : undefined;
  const showAllLabels = view.k >= 1.35 || nodes.length <= 25;

  return (
    <div className="card graph-card">
      <div className="graph-legend">
        {(["article", "finding", "project", "component"] as const).map((k) => (
          <span key={k} className="legend-item">
            <svg width="14" height="14" viewBox="-7 -7 14 14">
              <Shape node={{ kind: k } as GNode} r={k === "component" ? 4 : 5} fill={KIND[k].color} stroke="none" />
            </svg>
            {KIND[k].label}
          </span>
        ))}
        <span className="muted small graph-hint">Scroll to zoom · drag to pan · drag a node to pin it</span>
      </div>
      <div
        ref={wrap}
        className="graph-wrap"
        style={{ height: size.h }}
        onWheel={(e) => {
          const { cx, cy } = local(e);
          const k = Math.min(3, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
          const w = toWorld(cx, cy);
          setView({ k, x: cx - size.w / 2 - w.x * k, y: cy - size.h / 2 - w.y * k });
        }}
        onPointerDown={(e) => {
          const target = (e.target as Element).closest("[data-node]");
          const { cx, cy } = local(e);
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = target
            ? { mode: "node", id: target.getAttribute("data-node")!, sx: cx, sy: cy, vx: view.x, vy: view.y, moved: false }
            : { mode: "pan", sx: cx, sy: cy, vx: view.x, vy: view.y, moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const { cx, cy } = local(e);
          if (Math.abs(cx - d.sx) + Math.abs(cy - d.sy) > 3) d.moved = true;
          if (d.mode === "pan") setView((v) => ({ ...v, x: d.vx + cx - d.sx, y: d.vy + cy - d.sy }));
          else {
            const n = nodes.find((x) => x.id === d.id)!;
            const w = toWorld(cx, cy);
            n.fx = w.x;
            n.fy = w.y;
            sim.alphaTarget(0.2).restart();
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          sim.alphaTarget(0);
          if (d?.mode === "node" && !d.moved) {
            const n = nodes.find((x) => x.id === d.id);
            if (n) window.location.hash = itemHref(n).slice(1);
          }
        }}
      >
        <svg width={size.w} height={size.h} role="img" aria-label="Knowledge graph">
          <g transform={`translate(${size.w / 2 + view.x},${size.h / 2 + view.y}) scale(${view.k})`}>
            {edges.map((e, i) => {
              const s = e.source as GNode;
              const t = e.target as GNode;
              const active = neighbors ? neighbors.has(s.id) && neighbors.has(t.id) && (s.id === hover || t.id === hover) : false;
              return (
                <g key={i} className={neighbors && !active ? "dim" : ""}>
                  <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} className={`edge ${active ? "edge-active" : ""}`} />
                  {active && (
                    <text x={((s.x ?? 0) + (t.x ?? 0)) / 2} y={((s.y ?? 0) + (t.y ?? 0)) / 2} className="edge-label" textAnchor="middle" dy="-0.35em">
                      {RELATION[e.kind] ?? e.kind}
                    </text>
                  )}
                </g>
              );
            })}
            {nodes.map((n) => {
              const r = radius(n);
              const match = q && n.label.toLowerCase().includes(q);
              const dim = (neighbors && !neighbors.has(n.id)) || (q && !match);
              const label = showAllLabels || n.kind === "project" || n.degree >= 4 || neighbors?.has(n.id) || match;
              return (
                <g
                  key={n.id}
                  data-node={n.id}
                  transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                  className={`node ${dim ? "dim" : ""} ${n.status === "possibly_stale" ? "node-stale" : ""}`}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}
                >
                  <circle r={r + 8} fill="transparent" />
                  {match && <circle r={r + 5} className="match-ring" />}
                  <Shape node={n} r={r} fill={KIND[n.kind].color} stroke="var(--surface)" />
                  {label && (
                    <text y={r + 13} textAnchor="middle" className="node-label">
                      {shortLabel(n)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
        {hovered && (
          <div className="graph-tooltip">
            <div className="small muted">
              {KIND[hovered.kind].label} · {hovered.type.replace(/_/g, " ")} · {hovered.scope}
            </div>
            <strong>{hovered.label}</strong>
            <div className="small muted">
              {hovered.degree} link{hovered.degree === 1 ? "" : "s"}
              {hovered.status === "possibly_stale" ? " · not verified recently" : ""}
            </div>
          </div>
        )}
        <div className="graph-zoom">
          <button className="icon-btn" onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.25) }))} aria-label="Zoom in">
            +
          </button>
          <button className="icon-btn" onClick={() => setView((v) => ({ ...v, k: Math.max(0.3, v.k / 1.25) }))} aria-label="Zoom out">
            −
          </button>
          <button className="icon-btn" onClick={fit} aria-label="Fit to view" title="Fit to view">
            ⟲
          </button>
        </div>
      </div>
    </div>
  );
}

/** Components show just their name; the edge to the project says which project. */
function shortLabel(n: GNode) {
  const text = n.kind === "component" ? (n.label.split(" · ")[1] ?? n.label) : n.label;
  return text.length > 26 ? `${text.slice(0, 25)}…` : text;
}

function radius(n: GNode) {
  if (n.kind === "project") return 13;
  if (n.kind === "component") return 7;
  return Math.min(13, 6 + Math.sqrt(n.degree) * 2.2);
}

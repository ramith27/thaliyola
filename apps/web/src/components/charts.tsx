import { useEffect, useRef, useState, type ReactNode } from "react";
import { I, type IconName } from "./icons";

/*
 * Small SVG chart kit following the dataviz method: thin marks (columns <= 24px, 2px lines),
 * rounded data-ends anchored to the baseline, 2px surface gaps between touching marks,
 * recessive hairline axes, a legend for >= 2 series, hover tooltips on every mark, and a
 * table view on every chart. Colors come from CSS roles (--series-n, --status-*), and text
 * always wears text tokens, never a series color.
 */

export const compact = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : `${n}`);

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Clean axis maximum and ticks (0, step, 2·step, …). */
function niceTicks(max: number, count = 4) {
  if (max <= 0) return { top: count, ticks: Array.from({ length: count + 1 }, (_, i) => i) };
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const top = Math.ceil(max / step) * step;
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

/** Path for a bar with a rounded data-end (top) and a square base. */
function columnPath(x: number, y: number, w: number, h: number, r = 4) {
  if (h <= 0) return "";
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}
function barPathH(x: number, y: number, w: number, h: number, r = 4) {
  if (w <= 0) return "";
  const rr = Math.min(r, w, h / 2);
  return `M${x},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}H${x}Z`;
}

export interface Series {
  key: string;
  label: string;
  color: string; // a CSS color or var(--series-n)
}

function Legend({ series }: { series: Series[] }) {
  if (series.length < 2) return null;
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.key} className="legend-item">
          <span className="legend-swatch" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = Math.min(Math.max(x, 70), width - 70);
  return (
    <div className="chart-tooltip" style={{ left, top: y }}>
      {children}
    </div>
  );
}

/** Card frame with a title and a chart/table toggle (the table is the accessible view of the same data). */
export function ChartCard({
  title,
  subtitle,
  table,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  table: { columns: string[]; rows: (string | number)[][] };
  children: ReactNode;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`card chart-card ${className}`}>
      <header className="card-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p className="muted small">{subtitle}</p>}
        </div>
        <button className="icon-btn" onClick={() => setAsTable((t) => !t)} title={asTable ? "Show chart" : "Show table"} aria-label={asTable ? "Show chart" : "Show table"}>
          <I name={asTable ? "chart" : "table"} size={16} />
        </button>
      </header>
      {asTable ? (
        <div className="table-wrap chart-table">
          <table className="table">
            <thead>
              <tr>
                {table.columns.map((c) => (
                  <th key={c}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className={typeof v === "number" ? "num" : ""}>
                      {v}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

/** Stat tile: label, value, optional note and a sparkline (de-emphasised hue, current point in the accent). */
export function StatTile({ label, value, note, trend, icon, href, tone }: { label: string; value: number; note?: string; trend?: number[]; icon: IconName; href?: string; tone?: "warn" }) {
  const body = (
    <>
      <div className="tile-head">
        <span className={`tile-icon ${tone ? `tile-icon-${tone}` : ""}`}>
          <I name={icon} size={16} />
        </span>
        <span className="tile-label">{label}</span>
      </div>
      <div className="tile-value">{compact(value)}</div>
      <div className="tile-foot">
        {note && <span className="muted small">{note}</span>}
        {trend && trend.length > 1 && <Sparkline values={trend} />}
      </div>
    </>
  );
  return href ? (
    <a className="card tile" href={href}>
      {body}
    </a>
  ) : (
    <div className="card tile">{body}</div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const w = 84;
  const h = 26;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * (w - 6) + 3, h - 3 - (v / max) * (h - 6)] as const);
  const last = pts[pts.length - 1]!;
  return (
    <svg width={w} height={h} className="sparkline" aria-hidden="true">
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none" stroke="var(--spark)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={3} fill="var(--series-1)" stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  );
}

/** Stacked columns over time (2px surface gap between segments, rounded data-end on the top segment). */
export function StackedColumns({ data, series, xLabel }: { data: Record<string, number | string>[]; series: Series[]; xLabel: (row: Record<string, number | string>) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const m = { top: 12, right: 8, bottom: 26, left: 32 };
  const totals = data.map((d) => series.reduce((s, x) => s + Number(d[x.key] ?? 0), 0));
  const { top, ticks } = niceTicks(Math.max(...totals, 1));
  const iw = Math.max(0, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const band = iw / Math.max(1, data.length);
  const bw = Math.min(24, band * 0.62);
  const y = (v: number) => m.top + ih - (v / top) * ih;
  return (
    <div className="chart" ref={ref}>
      <Legend series={series} />
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Column chart">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
              <text x={m.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                {compact(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = m.left + band * i + band / 2;
            let acc = 0;
            const segs = series
              .map((s) => ({ s, v: Number(d[s.key] ?? 0) }))
              .filter((x) => x.v > 0)
              .map((x, k, arr) => {
                const y0 = y(acc);
                acc += x.v;
                const y1 = y(acc);
                const gap = k > 0 ? 2 : 0; // surface gap from the segment below
                const isTop = k === arr.length - 1;
                const hgt = y0 - y1 - gap;
                return isTop ? (
                  <path key={x.s.key} d={columnPath(cx - bw / 2, y1, bw, hgt)} fill={x.s.color} />
                ) : (
                  <rect key={x.s.key} x={cx - bw / 2} y={y1} width={bw} height={Math.max(0, hgt)} fill={x.s.color} />
                );
              });
            const showLabel = data.length <= 8 || i % Math.ceil(data.length / 6) === 0 || i === data.length - 1;
            return (
              <g key={i} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {hover === i && <rect x={cx - band / 2} y={m.top} width={band} height={ih} className="hover-band" />}
                {segs}
                <rect x={cx - band / 2} y={m.top} width={band} height={ih + m.bottom} fill="transparent" />
                {showLabel && (
                  <text x={cx} y={height - 8} textAnchor="middle" className="tick">
                    {xLabel(d)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <Tooltip x={m.left + band * hover + band / 2} y={y(totals[hover]!) - 8} width={width}>
          <strong>{xLabel(data[hover]!)}</strong>
          {series.map((s) => (
            <div key={s.key} className="tt-row">
              <span className="legend-swatch" style={{ background: s.color }} />
              {s.label}
              <span className="tt-val">{Number(data[hover]![s.key] ?? 0)}</span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/** Multi-line chart with a crosshair and a tooltip listing every series at the hovered point. */
export function LineChart({ data, series, xLabel }: { data: Record<string, number | string>[]; series: Series[]; xLabel: (row: Record<string, number | string>) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 220;
  const m = { top: 12, right: 12, bottom: 26, left: 32 };
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key] ?? 0))));
  const { top, ticks } = niceTicks(max);
  const iw = Math.max(0, width - m.left - m.right);
  const ih = height - m.top - m.bottom;
  const x = (i: number) => m.left + (data.length <= 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => m.top + ih - (v / top) * ih;
  const labelEvery = Math.ceil(data.length / 6);
  return (
    <div className="chart" ref={ref}>
      <Legend series={series} />
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Line chart"
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const i = Math.round(((e.clientX - r.left - m.left) / Math.max(1, iw)) * (data.length - 1));
            setHover(i >= 0 && i < data.length ? i : null);
          }}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className={t === 0 ? "axis" : "grid"} />
              <text x={m.left - 6} y={y(t)} dy="0.32em" textAnchor="end" className="tick">
                {compact(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) =>
            i % labelEvery === 0 || i === data.length - 1 ? (
              <text key={i} x={x(i)} y={height - 8} textAnchor="middle" className="tick">
                {xLabel(d)}
              </text>
            ) : null,
          )}
          {series.map((s, si) => (
            <g key={s.key}>
              {si === 0 && (
                <path
                  d={`M${x(0)},${y(0)} ${data.map((d, i) => `L${x(i)},${y(Number(d[s.key] ?? 0))}`).join(" ")} L${x(data.length - 1)},${y(0)}Z`}
                  fill={s.color}
                  opacity={0.1}
                />
              )}
              <polyline points={data.map((d, i) => `${x(i)},${y(Number(d[s.key] ?? 0))}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            </g>
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + ih} className="crosshair" />
              {series.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(Number(data[hover]![s.key] ?? 0))} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <Tooltip x={x(hover)} y={m.top} width={width}>
          <strong>{xLabel(data[hover]!)}</strong>
          {series.map((s) => (
            <div key={s.key} className="tt-row">
              <span className="legend-swatch" style={{ background: s.color }} />
              {s.label}
              <span className="tt-val">{Number(data[hover]![s.key] ?? 0)}</span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

/** Horizontal bars for a ranked single series; value at the tip, label on the left. */
export function HBars({ data, color = "var(--series-1)", format = (n: number) => String(n) }: { data: { label: string; value: number }[]; color?: string; format?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const row = 30;
  const labelW = Math.min(150, Math.max(90, width * 0.36));
  const valueW = 40;
  const height = Math.max(row, data.length * row);
  const max = Math.max(1, ...data.map((d) => d.value));
  const iw = Math.max(0, width - labelW - valueW);
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Bar chart">
          <line x1={labelW} x2={labelW} y1={0} y2={height} className="axis" />
          {data.map((d, i) => {
            const w = (d.value / max) * iw;
            const yy = i * row;
            return (
              <g key={d.label} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                {hover === i && <rect x={0} y={yy} width={width} height={row} className="hover-band" />}
                <text x={labelW - 8} y={yy + row / 2} dy="0.32em" textAnchor="end" className="bar-label">
                  {d.label.length > 22 ? `${d.label.slice(0, 21)}…` : d.label}
                </text>
                <path d={barPathH(labelW, yy + (row - 14) / 2, Math.max(w, 1), 14)} fill={color} />
                <text x={labelW + w + 6} y={yy + row / 2} dy="0.32em" className="bar-value">
                  {format(d.value)}
                </text>
                <rect x={0} y={yy} width={width} height={row} fill="transparent" />
              </g>
            );
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <Tooltip x={labelW + ((data[hover]!.value / max) * iw) / 2} y={hover * row - 4} width={width}>
          <strong>{data[hover]!.label}</strong>
          <div className="tt-row">
            <span className="tt-val">{format(data[hover]!.value)}</span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/** One 100% bar split by status (status colours always paired with an icon dot and a text label). */
export function StatusBar({ parts }: { parts: { key: string; label: string; value: number; color: string; note: string }[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  const visible = parts.filter((p) => p.value > 0);
  let acc = 0;
  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={28} role="img" aria-label="Status breakdown">
          {visible.map((p, i) => {
            const x = (acc / total) * width + (i > 0 ? 2 : 0);
            acc += p.value;
            const w = (p.value / total) * width - (i > 0 ? 2 : 0);
            const first = i === 0;
            const last = i === visible.length - 1;
            const r = 6;
            const d = `M${x + (first ? r : 0)},4 H${x + w - (last ? r : 0)} ${last ? `Q${x + w},4 ${x + w},${4 + r} V${24 - r} Q${x + w},24 ${x + w - r},24` : `V24`} H${x + (first ? r : 0)} ${first ? `Q${x},24 ${x},${24 - r} V${4 + r} Q${x},4 ${x + r},4` : `V4`}Z`;
            return <path key={p.key} d={d} fill={p.color} onMouseEnter={() => setHover(parts.indexOf(p))} onMouseLeave={() => setHover(null)} />;
          })}
        </svg>
      )}
      <ul className="status-legend">
        {parts.map((p, i) => (
          <li key={p.key} className={hover === i ? "active" : ""}>
            <span className="legend-swatch" style={{ background: p.color }} />
            <span>
              <strong>{p.value}</strong> {p.label} <span className="muted">· {Math.round((p.value / total) * 100)}%</span>
              <div className="muted small">{p.note}</div>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * DiffView (SPEC §5.14). Source mode: a line diff with a +/− gutter, word-level highlights inside changed lines and
 * collapsed unchanged runs. Rendered mode (Markdown): paragraph blocks diffed as a whole; removed/added blocks in
 * tone-barred containers; a removed block followed by an added one shows a word diff as plain text.
 */
import { diffArrays, diffLines, diffWordsWithSpace } from "diff";
import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Markdown } from "../ui";
import { Badge } from "./display";
import { SegmentedControl } from "./page";

export interface DiffViewProps {
  before: string;
  after: string;
  mode?: "rendered" | "source";
  onModeChange?: (m: "rendered" | "source") => void;
  showModeToggle?: boolean;
  markdown?: boolean;
  context?: number;
  labels?: { before: string; after: string };
  isNew?: boolean;
}

type Line = { type: "same" | "add" | "del"; text: string; pair?: string };

const withNewline = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);

function lineRows(before: string, after: string): Line[] {
  const parts = diffLines(withNewline(before), withNewline(after));
  const rows: Line[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    const lines = p.value.replace(/\n$/, "").split("\n");
    if (p.removed && parts[i + 1]?.added) {
      // Pair removed and added lines so each pair gets word-level highlights.
      const added = parts[i + 1]!.value.replace(/\n$/, "").split("\n");
      lines.forEach((t, j) => rows.push({ type: "del", text: t, pair: added[j] }));
      added.forEach((t, j) => rows.push({ type: "add", text: t, pair: lines[j] }));
      i++;
      continue;
    }
    for (const t of lines) rows.push({ type: p.added ? "add" : p.removed ? "del" : "same", text: t });
  }
  return rows;
}

function WordDiff({ from, to, side }: { from: string; to: string; side: "add" | "del" }) {
  const parts = diffWordsWithSpace(from, to);
  return (
    <>
      {parts.map((p, i) => {
        if (p.added) return side === "add" ? <ins key={i}>{p.value}</ins> : null;
        if (p.removed) return side === "del" ? <del key={i}>{p.value}</del> : null;
        return <Fragment key={i}>{p.value}</Fragment>;
      })}
    </>
  );
}

/** Splits Markdown into paragraph blocks, keeping fenced code blocks whole. */
function blocks(text: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let fence = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.trim() === "") {
      if (cur.length) out.push(cur.join("\n"));
      cur = [];
    } else cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/** Collapses long runs of unchanged items, keeping `context` on each side of a change. */
function collapse<T>(items: T[], isSame: (t: T) => boolean, context: number): ({ kind: "item"; item: T; index: number } | { kind: "gap"; from: number; to: number })[] {
  const out: ({ kind: "item"; item: T; index: number } | { kind: "gap"; from: number; to: number })[] = [];
  let i = 0;
  while (i < items.length) {
    if (!isSame(items[i]!)) {
      out.push({ kind: "item", item: items[i]!, index: i });
      i++;
      continue;
    }
    let j = i;
    while (j < items.length && isSame(items[j]!)) j++;
    const run = j - i;
    const keepBefore = i === 0 ? 0 : context;
    const keepAfter = j === items.length ? 0 : context;
    if (run > keepBefore + keepAfter && run > context * 2) {
      for (let k = i; k < i + keepBefore; k++) out.push({ kind: "item", item: items[k]!, index: k });
      out.push({ kind: "gap", from: i + keepBefore, to: j - keepAfter });
      for (let k = j - keepAfter; k < j; k++) out.push({ kind: "item", item: items[k]!, index: k });
    } else for (let k = i; k < j; k++) out.push({ kind: "item", item: items[k]!, index: k });
    i = j;
  }
  return out;
}

function GapButton({ count, noun, onExpand }: { count: number; noun: string; onExpand: () => void }) {
  return (
    <button type="button" className="diff-gap" onClick={onExpand}>
      ··· {count} unchanged {noun}
      {count === 1 ? "" : "s"}
    </button>
  );
}

function SourceDiff({ rows, context }: { rows: Line[]; context: number }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const view = collapse(rows, (r) => r.type === "same", context);
  const render = (r: Line, key: string | number) => (
    <div key={key} className="diff-line" data-type={r.type}>
      <span className="diff-gutter" aria-hidden="true">
        {r.type === "add" ? "+" : r.type === "del" ? "−" : " "}
      </span>
      <span className="diff-text">
        {r.type === "add" && <span className="sr-only">Added line: </span>}
        {r.type === "del" && <span className="sr-only">Removed line: </span>}
        {r.pair !== undefined && r.type !== "same" ? <WordDiff from={r.type === "del" ? r.text : r.pair} to={r.type === "add" ? r.text : r.pair} side={r.type} /> : r.text || " "}
      </span>
    </div>
  );
  return (
    <div className="diff-source">
      {view.map((v) =>
        v.kind === "item" ? (
          render(v.item, v.index)
        ) : expanded.has(v.from) ? (
          rows.slice(v.from, v.to).map((r, k) => render(r, `${v.from}-${k}`))
        ) : (
          <GapButton key={`gap-${v.from}`} count={v.to - v.from} noun="line" onExpand={() => setExpanded((s) => new Set(s).add(v.from))} />
        ),
      )}
    </div>
  );
}

type Block = { type: "same" | "add" | "del" | "change"; text: string; to?: string };

function RenderedDiff({ before, after, context }: { before: string; after: string; context: number }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const list = useMemo(() => {
    const parts = diffArrays(blocks(before), blocks(after));
    const out: Block[] = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i]!;
      if (p.removed && parts[i + 1]?.added) {
        const added = parts[i + 1]!.value;
        const n = Math.min(p.value.length, added.length);
        for (let k = 0; k < n; k++) out.push({ type: "change", text: p.value[k]!, to: added[k]! });
        for (let k = n; k < p.value.length; k++) out.push({ type: "del", text: p.value[k]! });
        for (let k = n; k < added.length; k++) out.push({ type: "add", text: added[k]! });
        i++;
        continue;
      }
      for (const t of p.value) out.push({ type: p.added ? "add" : p.removed ? "del" : "same", text: t });
    }
    return out;
  }, [before, after]);
  const view = collapse(list, (b) => b.type === "same", context);
  const render = (b: Block, key: string | number): ReactNode => {
    if (b.type === "same")
      return (
        <div key={key} className="diff-block" data-type="same">
          <Markdown text={b.text} comments="all" />
        </div>
      );
    if (b.type === "change") {
      // Heading markers (## Fix) read as noise in Rendered mode. A heading both sides share is shown once, as a
      // heading, above the Before/After pair; any other heading line just loses its # markers.
      const head = /^#{1,6}\s+/;
      const fromLines = b.text.split("\n");
      const toLines = (b.to ?? "").split("\n");
      const shared: string[] = [];
      while (fromLines.length > 1 && toLines.length > 1 && head.test(fromLines[0]!) && fromLines[0] === toLines[0]) {
        shared.push(fromLines.shift()!.replace(head, ""));
        toLines.shift();
      }
      const strip = (lines: string[]) => lines.map((l) => l.replace(head, "")).join("\n");
      const from = strip(fromLines);
      const to = strip(toLines);
      const cls = "diff-words";
      return (
        <div key={key} className="diff-block" data-type="change">
          <span className="sr-only">Changed paragraph: </span>
          {shared.map((h, i) => (
            <p key={i} className="diff-words diff-words-heading">
              {h}
            </p>
          ))}
          <div className="diff-pair" data-side="del">
            <span className="diff-tag" data-side="del">Before</span>
            <p className={cls}>
              <WordDiff from={from} to={to} side="del" />
            </p>
          </div>
          <div className="diff-pair" data-side="add">
            <span className="diff-tag" data-side="add">After</span>
            <p className={cls}>
              <WordDiff from={from} to={to} side="add" />
            </p>
          </div>
        </div>
      );
    }
    const Tag = b.type === "add" ? "ins" : "del";
    return (
      <Tag key={key} className="diff-block" data-type={b.type}>
        <span className="diff-tag" data-side={b.type} aria-hidden="true">
          {b.type === "add" ? "Added" : "Removed"}
        </span>
        <span className="sr-only">{b.type === "add" ? "Added: " : "Removed: "}</span>
        <Markdown text={b.text} comments="all" />
      </Tag>
    );
  };
  return (
    <div className="diff-rendered">
      {view.map((v) =>
        v.kind === "item" ? (
          render(v.item, v.index)
        ) : expanded.has(v.from) ? (
          list.slice(v.from, v.to).map((b, k) => render(b, `${v.from}-${k}`))
        ) : (
          <GapButton key={`gap-${v.from}`} count={v.to - v.from} noun="paragraph" onExpand={() => setExpanded((s) => new Set(s).add(v.from))} />
        ),
      )}
    </div>
  );
}

/** Before → after, as source lines or rendered Markdown, with a "+12 −3 lines" summary. */
export function DiffView({ before, after, mode, onModeChange, showModeToggle, markdown = false, context = 3, labels, isNew }: DiffViewProps) {
  const [ownMode, setOwnMode] = useState<"rendered" | "source">(markdown ? "rendered" : "source");
  const current = mode ?? ownMode;
  const setMode = (m: "rendered" | "source") => {
    setOwnMode(m);
    onModeChange?.(m);
  };
  const rows = useMemo(() => lineRows(before, after), [before, after]);
  const added = rows.filter((r) => r.type === "add").length;
  const removed = rows.filter((r) => r.type === "del").length;

  return (
    <div className="diff-view" data-mode={current}>
      <div className="diff-head">
        <span className="diff-summary">
          {isNew ? (
            <Badge tone="success" icon="plus">
              New
            </Badge>
          ) : (
            <>
              <span className="diff-count-add">+{added}</span> <span className="diff-count-del">−{removed}</span> lines
              <span className="sr-only">
                : {added} added, {removed} removed
              </span>
            </>
          )}
          {labels && !isNew && (
            <span className="diff-labels">
              {labels.before} → {labels.after}
            </span>
          )}
        </span>
        {showModeToggle && markdown && (
          <SegmentedControl
            label="Show changes as"
            size="sm"
            options={[
              { value: "rendered", label: "Rendered" },
              { value: "source", label: "Source" },
            ]}
            value={current}
            onChange={setMode}
          />
        )}
      </div>
      {isNew ? (
        current === "rendered" && markdown ? (
          <div className="diff-block" data-type="add">
            <Markdown text={after} comments="all" />
          </div>
        ) : (
          <SourceDiff rows={rows} context={context} />
        )
      ) : current === "rendered" && markdown ? (
        <RenderedDiff before={before} after={after} context={context} />
      ) : (
        <SourceDiff rows={rows} context={context} />
      )}
    </div>
  );
}

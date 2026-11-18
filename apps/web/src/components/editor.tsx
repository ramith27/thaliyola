import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, fileToBase64, type SearchHit } from "../api";
import { href } from "../router";
import { I, type IconName } from "./icons";
import { Button, Callout, InfoTip, SegmentedControl, ToggleButton, Tooltip, shortcutText } from "./kit";
import { SCOPE_KIND, entityKindLabel, formatRelativeTime } from "./labels";
import { useOptionalBoot } from "./boot";
import { Markdown } from "./ui";

/**
 * A markdown editor: a textarea with a formatting toolbar, "/" commands,
 * "@" links to articles and findings, "#" links to entities, image paste and
 * drop, a live side-by-side preview, and a local autosave. The text stays
 * plain markdown; this is not a WYSIWYG editor.
 */

type Mode = "write" | "split" | "preview";

interface Suggest {
  kind: "slash" | "mention" | "entity";
  start: number; // index of the trigger character
  query: string;
}

interface Item {
  key: string;
  label: string;
  hint?: string;
  insert: () => string | null; // the replacement text for trigger+query, or null to do it another way
}

const SLASH: { key: string; label: string; hint: string; text: string }[] = [
  { key: "h2", label: "Section heading", hint: "## ", text: "## " },
  { key: "h3", label: "Sub-heading", hint: "### ", text: "### " },
  { key: "list", label: "Bulleted list", hint: "- ", text: "- " },
  { key: "numbered", label: "Numbered list", hint: "1. ", text: "1. " },
  { key: "todo", label: "Checklist", hint: "- [ ] ", text: "- [ ] " },
  { key: "quote", label: "Quote", hint: "> ", text: "> " },
  { key: "code", label: "Code block", hint: "```", text: "```\n\n```" },
  { key: "sql", label: "SQL query", hint: "```sql", text: "```sql\nSELECT\n```" },
  { key: "table", label: "Table", hint: "| a | b |", text: "| Column | Column |\n| --- | --- |\n|  |  |" },
  { key: "callout", label: "Callout", hint: "> **Note:**", text: "> **Note:** " },
  { key: "divider", label: "Divider", hint: "---", text: "---\n" },
  { key: "image", label: "Image", hint: "upload", text: "" },
  { key: "link", label: "Link to an article", hint: "@", text: "@" },
];

/** Template hints are HTML comments; the preview (and the saved text) leaves them out. */
export const withoutHints = (md: string) => md.replace(/<!-- Hint: [\s\S]*?-->\n?\n?/g, "");

// ---- Local autosave ---------------------------------------------------------

const DRAFT_PREFIX = "thaliyola.draft.";

export function clearDraft(key: string) {
  try {
    localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* storage unavailable */
  }
}

function loadDraft(key: string): { text: string; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(DRAFT_PREFIX + key) ?? "null");
    return v && typeof v.text === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Keeps `value` in localStorage under `key` (700ms after the last change) and offers to bring it back.
 * `savedAt` is when the draft was last written in this browser (null when there is nothing to keep).
 */
export function useAutosave(key: string | undefined, value: string, initial: string) {
  const [offer, setOffer] = useState<{ text: string; at: number } | null>(() => {
    if (!key) return null;
    const d = loadDraft(key);
    return d && d.text !== initial && d.text.trim() ? d : null;
  });
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    if (!key || offer) return; // don't overwrite a draft the person hasn't decided about
    const t = setTimeout(() => {
      try {
        if (value === initial) {
          localStorage.removeItem(DRAFT_PREFIX + key);
          setSavedAt(null);
        } else {
          const at = Date.now();
          localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ text: value, at }));
          setSavedAt(at);
        }
      } catch {
        /* storage unavailable: no autosave */
      }
    }, 700);
    return () => clearTimeout(t);
  }, [key, value, initial, offer]);
  return { offer, dismiss: () => setOffer(null), savedAt };
}

export function DraftOffer({ offer, onRestore, onDiscard }: { offer: { text: string; at: number } | null; onRestore: (text: string) => void; onDiscard: () => void }) {
  if (!offer) return null;
  return (
    <Callout
      tone="info"
      icon="history"
      className="draft-offer"
      actions={
        <>
          <Button size="sm" variant="primary" onClick={() => onRestore(offer.text)}>
            Restore
          </Button>
          <Button size="sm" variant="ghost" onClick={onDiscard}>
            Discard
          </Button>
        </>
      }
    >
      You have unsaved changes from {formatRelativeTime(offer.at).toLowerCase()} in this browser.
    </Callout>
  );
}

// ---- Caret position (mirror-div technique) ------------------------------------

const MIRROR_PROPS = [
  "boxSizing", "width", "height", "overflowX", "overflowY", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize",
  "lineHeight", "fontFamily", "textAlign", "textTransform", "textIndent", "letterSpacing", "wordSpacing", "tabSize",
] as const;

function caretXY(el: HTMLTextAreaElement, pos: number) {
  const div = document.createElement("div");
  const style = getComputedStyle(el);
  for (const p of MIRROR_PROPS) div.style[p] = style[p];
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";
  div.textContent = el.value.slice(0, pos);
  const span = document.createElement("span");
  span.textContent = el.value.slice(pos) || ".";
  div.appendChild(span);
  document.body.appendChild(div);
  const top = span.offsetTop - el.scrollTop + parseInt(style.lineHeight || "20", 10);
  const left = Math.min(span.offsetLeft, el.clientWidth - 260);
  document.body.removeChild(div);
  return { top, left: Math.max(left, 0) };
}

function detect(text: string, caret: number): Suggest | null {
  const before = text.slice(0, caret);
  const line = before.slice(before.lastIndexOf("\n") + 1);
  const slash = /^\s*\/([\w-]{0,20})$/.exec(line);
  if (slash) return { kind: "slash", start: caret - slash[1]!.length - 1, query: slash[1]! };
  const mention = /(?:^|[\s(])@([\w.-]{0,40})$/.exec(before);
  if (mention) return { kind: "mention", start: caret - mention[1]!.length - 1, query: mention[1]! };
  const entity = /(?:^|[\s(])#([\w.-]{1,40})$/.exec(before);
  if (entity) return { kind: "entity", start: caret - entity[1]!.length - 1, query: entity[1]! };
  return null;
}

// ---- The editor -----------------------------------------------------------------

interface Tool {
  id: string;
  icon: IconName;
  label: string;
  shortcut?: string;
  run: () => void;
}

export function Editor({
  value,
  onChange,
  uploadTarget,
  rows = 20,
  compact = false,
  label,
  placeholder,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  "aria-required": required,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Item id that pasted or dropped images are attached to; without it, images are refused with a hint. */
  uploadTarget?: string;
  rows?: number;
  compact?: boolean;
  label?: string;
  placeholder?: string;
  /** Set by a surrounding Field, so its label and messages point at the textarea. */
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  "aria-required"?: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  // Scope names for the @ suggestions' location hint (names, never slugs). Read through a ref so the search effect
  // doesn't rerun when boot refreshes.
  const boot = useOptionalBoot();
  const bootRef = useRef(boot);
  bootRef.current = boot;
  const fileInput = useRef<HTMLInputElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [mode, setMode] = useState<Mode>(() => (!compact && window.innerWidth > 1100 ? "split" : "write"));
  const [compactPreview, setCompactPreview] = useState(false);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [note, setNote] = useState<string | null>(null);
  const [toolIdx, setToolIdx] = useState(0);
  const pendingCaret = useRef<number | null>(null);
  const showInput = compact ? !compactPreview : mode !== "preview";
  const showPreview = compact ? compactPreview : mode !== "write";

  // Restore the caret after a programmatic change.
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ta.current) {
      ta.current.focus();
      ta.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  // Compact editors grow with their text (up to about 20 lines, then scroll).
  useLayoutEffect(() => {
    const el = ta.current;
    if (!compact || !el) return;
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
    el.style.height = `${Math.min(el.scrollHeight + 2, line * 20)}px`;
  }, [compact, value, showInput]);

  const replaceRange = useCallback(
    (from: number, to: number, text: string, caretOffset = text.length) => {
      onChange(value.slice(0, from) + text + value.slice(to));
      pendingCaret.current = from + caretOffset;
    },
    [value, onChange],
  );

  /** Wraps the selection (or inserts a placeholder) with before/after markers. */
  function wrap(before: string, after = before, placeholderText = "text") {
    const el = ta.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const sel = value.slice(s, e) || placeholderText;
    onChange(value.slice(0, s) + before + sel + after + value.slice(e));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + before.length, s + before.length + sel.length);
    });
  }

  /** Prefixes every selected line (lists, quotes, headings). */
  function prefixLines(prefix: string | ((i: number) => string)) {
    const el = ta.current;
    if (!el) return;
    const s = value.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const e = el.selectionEnd;
    const block = value.slice(s, e) || "";
    const lines = block.split("\n").map((l, i) => (typeof prefix === "function" ? prefix(i) : prefix) + l);
    replaceRange(s, e, lines.join("\n"));
  }

  function insertBlock(text: string) {
    const el = ta.current;
    if (!el) return;
    const s = el.selectionStart;
    const needsNl = s > 0 && value[s - 1] !== "\n" ? "\n\n" : "";
    replaceRange(s, el.selectionEnd, needsNl + text + "\n", needsNl.length + text.length + 1);
  }

  // ---- Images ----
  async function upload(files: File[]) {
    const images = files.filter((f) => /^image\/(png|jpeg|gif|webp)$/.test(f.type));
    if (!images.length) return;
    if (!uploadTarget) {
      setNote("Save first, then add images while editing: files attach to an existing article or finding.");
      return;
    }
    for (const file of images) {
      const name = (file.name || "pasted image").replace(/[[\]]/g, "");
      const marker = `![Uploading ${name}…]()`;
      const el = ta.current;
      if (!el) return;
      const at = el.selectionStart;
      const current = el.value;
      onChange(current.slice(0, at) + marker + current.slice(el.selectionEnd));
      try {
        const res = await api<{ asset_id: string }>("/assets", {
          method: "POST",
          body: { target_id: uploadTarget, filename: file.name || "pasted.png", mime: file.type, data_base64: await fileToBase64(file), alt_text: name },
        });
        const latest = ta.current?.value ?? current;
        onChange(latest.replace(marker, `![${name}](asset:${res.asset_id})`));
        setNote(null);
      } catch (e) {
        onChange((ta.current?.value ?? current).replace(marker, ""));
        setNote(`Couldn't upload ${name}: ${(e as Error).message}`);
      }
    }
  }

  // ---- Suggestions ----
  function refreshSuggest() {
    const el = ta.current;
    if (!el) return;
    const s = detect(el.value, el.selectionStart);
    setSuggest(s);
    if (s) setPos(caretXY(el, s.start));
  }

  useEffect(() => {
    if (!suggest) return setItems([]);
    setCursor(0);
    const close = (replacement: string) => () => replacement;
    if (suggest.kind === "slash") {
      const q = suggest.query.toLowerCase();
      setItems(
        SLASH.filter((c) => !q || c.key.startsWith(q) || c.label.toLowerCase().includes(q)).map((c) => ({
          key: c.key,
          label: c.label,
          hint: c.hint,
          insert: c.key === "image" ? () => (fileInput.current?.click(), "") : close(c.text),
        })),
      );
      return;
    }
    if (suggest.query.length < (suggest.kind === "mention" ? 2 : 1)) return setItems([]);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        if (suggest.kind === "mention") {
          const r = await api<{ articles: SearchHit[]; findings: SearchHit[] }>(`/search?${new URLSearchParams({ q: suggest.query, limit: "6", prefix: "true" })}`);
          const seen = new Set<string>();
          const hits = [...r.articles, ...r.findings].filter((h) => !seen.has(h.id) && seen.add(h.id));
          if (!cancelled)
            setItems(
              hits.map((h) => ({
                key: h.id,
                label: h.title,
                hint: `${h.kind === "finding" ? "Finding" : "Article"} · ${bootRef.current?.scope(h.scope.slug)?.name ?? SCOPE_KIND[h.scope.kind] ?? "Elsewhere"}`,
                insert: () => `[${h.title.replace(/[[\]]/g, "")}](${href(`/${h.kind}/${h.id}`)})`,
              })),
            );
        } else {
          const r = await api<{ entities: { kind: string; name: string; items: number }[] }>(`/entities?${new URLSearchParams({ q: suggest.query, limit: "6" })}`);
          if (!cancelled)
            setItems(
              r.entities.map((e) => ({
                key: `${e.kind}:${e.name}`,
                label: e.name,
                hint: entityKindLabel(e.kind),
                insert: () => `[${e.name.replace(/[[\]]/g, "")}](${href(`/entity/${e.kind}/${e.name}`).replace(/ /g, "%20")})`,
              })),
            );
        }
      } catch {
        if (!cancelled) setItems([]);
      }
    }, 140);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [suggest?.kind, suggest?.query]); // eslint-disable-line react-hooks/exhaustive-deps

  function choose(item: Item) {
    if (!suggest || !ta.current) return;
    const end = suggest.start + 1 + suggest.query.length;
    const text = item.insert();
    setSuggest(null);
    if (text === null) return;
    if (suggest.kind === "slash" && (text.startsWith("```") || text.startsWith("| "))) {
      // Put the caret inside the block.
      const inside = text.startsWith("```") ? text.indexOf("\n") + 1 : text.lastIndexOf("|  |") + 2;
      replaceRange(suggest.start, end, text, inside);
    } else replaceRange(suggest.start, end, text);
  }

  const open = !!suggest && items.length > 0;

  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const mod = e.metaKey || e.ctrlKey;
    if (open) {
      if (e.key === "ArrowDown") return e.preventDefault(), setCursor((c) => (c + 1) % items.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setCursor((c) => (c - 1 + items.length) % items.length);
      if ((e.key === "Enter" && !mod) || e.key === "Tab") return e.preventDefault(), choose(items[cursor]!);
    }
    if (suggest && e.key === "Escape") return e.preventDefault(), e.stopPropagation(), setSuggest(null);
    if (mod && e.key.toLowerCase() === "b") return e.preventDefault(), wrap("**");
    if (mod && e.key.toLowerCase() === "i") return e.preventDefault(), wrap("_");
    // Continue lists on Enter (⌘Enter is left to the page: it submits).
    if (e.key === "Enter" && !e.shiftKey && !mod && !e.altKey) {
      const el = e.currentTarget;
      const s = el.selectionStart;
      const lineStart = value.lastIndexOf("\n", s - 1) + 1;
      const line = value.slice(lineStart, s);
      const m = /^(\s*)([-*] \[[ x]\] |[-*] |(\d+)\. |> )(.*)$/.exec(line);
      if (m) {
        e.preventDefault();
        if (!m[4]) return replaceRange(lineStart, s, ""); // empty item ends the list
        const next = m[3] ? `${Number(m[3]) + 1}. ` : m[2]!.replace("[x]", "[ ]");
        replaceRange(s, el.selectionEnd, `\n${m[1]}${next}`);
      }
    }
  }

  const groups: Tool[][] = [
    [
      { id: "heading", icon: "heading", label: "Section heading", run: () => prefixLines("## ") },
      { id: "bold", icon: "bold", label: "Bold", shortcut: "mod+b", run: () => wrap("**") },
      { id: "italic", icon: "italic", label: "Italic", shortcut: "mod+i", run: () => wrap("_") },
      { id: "code", icon: "code", label: "Inline code", run: () => wrap("`", "`", "code") },
      { id: "link", icon: "link", label: "Link", run: () => wrap("[", "](https://)", "link text") },
    ],
    [
      { id: "list", icon: "list", label: "Bulleted list", run: () => prefixLines("- ") },
      { id: "numbered", icon: "list-ordered", label: "Numbered list", run: () => prefixLines((i) => `${i + 1}. `) },
      { id: "quote", icon: "quote", label: "Quote", run: () => prefixLines("> ") },
    ],
    [
      { id: "code-block", icon: "code-block", label: "Code block", run: () => insertBlock("```\n\n```") },
      { id: "table", icon: "table", label: "Table", run: () => insertBlock("| Column | Column |\n| --- | --- |\n|  |  |") },
    ],
    [{ id: "image", icon: "image", label: uploadTarget ? "Add an image" : "Add an image (save first)", run: () => fileInput.current?.click() }],
  ];
  const flat = groups.flat();

  /** Roving tabindex: the toolbar is one tab stop; arrows, Home and End move inside it. */
  function onToolbarKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    let next: number | null = null;
    if (e.key in keys) next = (toolIdx + keys[e.key]! + flat.length) % flat.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = flat.length - 1;
    if (next === null) return;
    e.preventDefault();
    setToolIdx(next);
    toolbarRef.current?.querySelectorAll<HTMLButtonElement>("[data-tool]")[next]?.focus();
  }

  const toolbar = (
    <div className="it-md-toolbar">
      <div ref={toolbarRef} className="it-md-tools" role="toolbar" aria-label={label ? `${label} formatting` : "Formatting"} onKeyDown={onToolbarKey}>
        {groups.map((g, gi) => (
          <div key={gi} className="it-md-group">
            {g.map((t) => {
              const i = flat.indexOf(t);
              const tip = t.shortcut ? `${t.label} (${shortcutText(t.shortcut).visible})` : t.label;
              return (
                <Tooltip key={t.id} content={tip} describe={false}>
                  <button
                    type="button"
                    className="it-md-tool"
                    data-tool={t.id}
                    aria-label={t.label}
                    aria-keyshortcuts={t.shortcut ? shortcutText(t.shortcut).aria : undefined}
                    tabIndex={i === toolIdx ? 0 : -1}
                    disabled={!showInput}
                    onMouseDown={(e) => e.preventDefault()}
                    onFocus={() => setToolIdx(i)}
                    onClick={t.run}
                  >
                    <I name={t.icon} size={16} />
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => (upload([...(e.target.files ?? [])]), (e.target.value = ""))} />
      <div className="it-md-view">
        {compact ? (
          <ToggleButton size="sm" icon="eye" label="Preview" pressed={compactPreview} onPressedChange={setCompactPreview} tooltip="Show how it will look" pressedTooltip="Back to writing" />
        ) : (
          <SegmentedControl<Mode>
            label="View"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: "write", label: "Write" },
              { value: "split", label: "Split" },
              { value: "preview", label: "Preview" },
            ]}
          />
        )}
      </div>
    </div>
  );

  const activeId = open ? `${listId}-${cursor}` : undefined;

  return (
    <div className="it-md" data-mode={compact ? (compactPreview ? "preview" : "write") : mode} data-compact={compact || undefined}>
      {!compact && toolbar}
      <div className="it-md-panes">
        {showInput && (
          <div className="it-md-pane">
            <textarea
              ref={ta}
              id={id}
              className="it-md-input"
              value={value}
              rows={rows}
              aria-label={id ? undefined : (label ?? "Body")}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              aria-required={required || undefined}
              role="combobox"
              aria-multiline="true"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={activeId}
              placeholder={placeholder ?? (compact ? undefined : "Write in markdown. Type / for blocks, @ to link an article, # for a system or metric.")}
              onChange={(e) => {
                onChange(e.target.value);
                requestAnimationFrame(refreshSuggest);
              }}
              onKeyDown={onKeyDown}
              onClick={refreshSuggest}
              onBlur={() => setTimeout(() => setSuggest(null), 150)}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.some((f) => f.type.startsWith("image/"))) {
                  e.preventDefault();
                  upload(files);
                }
              }}
              onDrop={(e) => {
                const files = [...e.dataTransfer.files];
                if (files.length) {
                  e.preventDefault();
                  upload(files);
                }
              }}
            />
            {open && (
              <div id={listId} className="it-md-suggest" style={{ top: pos.top, left: pos.left }} role="listbox" aria-label={suggest!.kind === "slash" ? "Blocks" : suggest!.kind === "mention" ? "Articles and findings" : "Topics"}>
                {items.map((it, i) => (
                  <button
                    key={it.key}
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === cursor}
                    className="it-md-option"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(it);
                    }}
                  >
                    <span className="it-md-option-label">{it.label}</span>
                    {it.hint && <span className="it-md-option-hint">{it.hint}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {showPreview && (
          <div className="it-md-preview" aria-label="Preview" role="region">
            {value.trim() ? <Markdown text={withoutHints(value)} /> : <p className="it-md-empty">Nothing to preview yet.</p>}
          </div>
        )}
      </div>
      {compact && toolbar}
      {note && (
        <p className="it-md-note" role="status">
          <I name="alert" size={14} />
          {note}
        </p>
      )}
      {!compact && (
        <div className="it-md-hint">
          <span>/ for blocks · @ to link an item · # for a topic · paste images</span>
          <InfoTip label="Writing shortcuts">
            <ul className="it-md-tips">
              <li>Type / at the start of a line for headings, lists, tables, code and more.</li>
              <li>Type @ and two letters to link an article or finding.</li>
              <li>Type # to link a topic (a service, metric or table).</li>
              <li>Paste or drop images to upload them{uploadTarget ? "" : " (once the article exists)"}.</li>
              <li>
                {shortcutText("mod+b").visible} bold, {shortcutText("mod+i").visible} italic. Enter continues a list; Shift+Enter starts a plain new line.
              </li>
            </ul>
          </InfoTip>
        </div>
      )}
    </div>
  );
}

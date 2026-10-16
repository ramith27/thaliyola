import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, fileToBase64, type SearchHit } from "../api";
import { href } from "../router";
import { I } from "./icons";
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

/** Keeps `value` in localStorage under `key` and offers to bring it back. */
export function useAutosave(key: string | undefined, value: string, initial: string) {
  const [offer, setOffer] = useState<{ text: string; at: number } | null>(() => {
    if (!key) return null;
    const d = loadDraft(key);
    return d && d.text !== initial && d.text.trim() ? d : null;
  });
  useEffect(() => {
    if (!key || offer) return; // don't overwrite a draft the person hasn't decided about
    const t = setTimeout(() => {
      try {
        if (value === initial) localStorage.removeItem(DRAFT_PREFIX + key);
        else localStorage.setItem(DRAFT_PREFIX + key, JSON.stringify({ text: value, at: Date.now() }));
      } catch {
        /* storage unavailable: no autosave */
      }
    }, 700);
    return () => clearTimeout(t);
  }, [key, value, initial, offer]);
  return { offer, dismiss: () => setOffer(null) };
}

function ago(at: number) {
  const m = Math.round((Date.now() - at) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(at).toLocaleDateString();
}

export function DraftOffer({ offer, onRestore, onDiscard }: { offer: { text: string; at: number } | null; onRestore: (text: string) => void; onDiscard: () => void }) {
  if (!offer) return null;
  return (
    <div className="notice draft-offer">
      <span>You have unsaved changes from {ago(offer.at)} in this browser.</span>
      <button type="button" className="btn btn-small btn-primary" onClick={() => onRestore(offer.text)}>
        Restore
      </button>
      <button type="button" className="btn btn-small" onClick={onDiscard}>
        Discard
      </button>
    </div>
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

export function Editor({
  value,
  onChange,
  uploadTarget,
  rows = 20,
  compact = false,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Item id that pasted or dropped images are attached to; without it, images are refused with a hint. */
  uploadTarget?: string;
  rows?: number;
  compact?: boolean;
  label?: string;
  placeholder?: string;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>(() => (!compact && window.innerWidth > 1100 ? "split" : "write"));
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [note, setNote] = useState<string | null>(null);
  const pendingCaret = useRef<number | null>(null);

  // Restore the caret after a programmatic change.
  useLayoutEffect(() => {
    if (pendingCaret.current !== null && ta.current) {
      ta.current.focus();
      ta.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [value]);

  const replaceRange = useCallback(
    (from: number, to: number, text: string, caretOffset = text.length) => {
      onChange(value.slice(0, from) + text + value.slice(to));
      pendingCaret.current = from + caretOffset;
    },
    [value, onChange],
  );

  /** Wraps the selection (or inserts a placeholder) with before/after markers. */
  function wrap(before: string, after = before, placeholderText = "text") {
    const el = ta.current!;
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
    const el = ta.current!;
    const s = value.lastIndexOf("\n", el.selectionStart - 1) + 1;
    const e = el.selectionEnd;
    const block = value.slice(s, e) || "";
    const lines = block.split("\n").map((l, i) => (typeof prefix === "function" ? prefix(i) : prefix) + l);
    replaceRange(s, e, lines.join("\n"));
  }

  function insertBlock(text: string) {
    const el = ta.current!;
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
      const el = ta.current!;
      const at = el.selectionStart;
      const current = el.value;
      onChange(current.slice(0, at) + marker + current.slice(el.selectionEnd));
      try {
        const res = await api<{ asset_id: string }>("/assets", {
          method: "POST",
          body: { target_id: uploadTarget, filename: file.name || "pasted.png", mime: file.type, data_base64: await fileToBase64(file), alt_text: name },
        });
        const latest = ta.current!.value;
        onChange(latest.replace(marker, `![${name}](asset:${res.asset_id})`));
        setNote(null);
      } catch (e) {
        onChange(ta.current!.value.replace(marker, ""));
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
                hint: `${h.kind} · ${h.scope.slug}`,
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
                hint: e.kind,
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

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (suggest && items.length) {
      if (e.key === "ArrowDown") return e.preventDefault(), setCursor((c) => (c + 1) % items.length);
      if (e.key === "ArrowUp") return e.preventDefault(), setCursor((c) => (c - 1 + items.length) % items.length);
      if (e.key === "Enter" || e.key === "Tab") return e.preventDefault(), choose(items[cursor]!);
    }
    if (suggest && e.key === "Escape") return e.preventDefault(), setSuggest(null);
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "b") return e.preventDefault(), wrap("**");
    if (mod && e.key.toLowerCase() === "i") return e.preventDefault(), wrap("_");
    // Continue lists on Enter.
    if (e.key === "Enter" && !e.shiftKey) {
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

  const tools: { icon?: string; text: string; title: string; run: () => void }[] = [
    { text: "H", title: "Section heading", run: () => prefixLines("## ") },
    { text: "B", title: "Bold (Ctrl/⌘ B)", run: () => wrap("**") },
    { text: "I", title: "Italic (Ctrl/⌘ I)", run: () => wrap("_") },
    { text: "</>", title: "Inline code", run: () => wrap("`", "`", "code") },
    { text: "🔗", title: "Link", run: () => wrap("[", "](https://)", "link text") },
    { text: "•", title: "Bulleted list", run: () => prefixLines("- ") },
    { text: "1.", title: "Numbered list", run: () => prefixLines((i) => `${i + 1}. `) },
    { text: "❝", title: "Quote", run: () => prefixLines("> ") },
    { text: "{ }", title: "Code block", run: () => insertBlock("```\n\n```") },
    { text: "▦", title: "Table", run: () => insertBlock("| Column | Column |\n| --- | --- |\n|  |  |") },
  ];

  return (
    <div className={`md-editor mode-${mode} ${compact ? "compact" : ""}`}>
      <div className="md-toolbar" role="toolbar" aria-label={label ? `${label} formatting` : "Formatting"}>
        {tools.map((t) => (
          <button key={t.title} type="button" title={t.title} aria-label={t.title} onMouseDown={(e) => e.preventDefault()} onClick={t.run}>
            {t.text}
          </button>
        ))}
        <button type="button" title={uploadTarget ? "Add an image" : "Save first to add images"} aria-label="Add an image" onClick={() => fileInput.current?.click()}>
          <I name="image" size={15} />
        </button>
        <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => (upload([...(e.target.files ?? [])]), (e.target.value = ""))} />
        {!compact && (
          <div className="md-modes" role="tablist" aria-label="View">
            {(["write", "split", "preview"] as Mode[]).map((m) => (
              <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
                {m === "write" ? "Write" : m === "split" ? "Split" : "Preview"}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="md-panes">
        {mode !== "preview" && (
          <div className="md-input">
            <textarea
              ref={ta}
              className="body-input"
              value={value}
              rows={rows}
              aria-label={label ?? "Body"}
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
            {suggest && items.length > 0 && (
              <div className="md-suggest" style={{ top: pos.top, left: pos.left }} role="listbox">
                {items.map((it, i) => (
                  <button
                    key={it.key}
                    type="button"
                    role="option"
                    aria-selected={i === cursor}
                    className={i === cursor ? "active" : ""}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(it);
                    }}
                  >
                    <span>{it.label}</span>
                    {it.hint && <span className="muted small">{it.hint}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {mode !== "write" && (
          <div className="md-preview" aria-label="Preview">
            {value.trim() ? <Markdown text={withoutHints(value)} /> : <p className="muted small">Nothing to preview yet.</p>}
          </div>
        )}
      </div>
      {note && <p className="small warn md-note">{note}</p>}
    </div>
  );
}

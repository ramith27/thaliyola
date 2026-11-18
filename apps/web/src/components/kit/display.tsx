/**
 * Display (SPEC §5.7, §5.12, §5.13): badges, labels and counts; people, time and keys; code, copy and secrets.
 * Three families never look alike: status is a tinted pill with an icon; type is quiet text; location is a kind
 * icon plus a name.
 */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { href as hashHref } from "../../router";
import { useSingleKeyShortcuts } from "../../hooks";
import { useOptionalBoot } from "../boot";
import { I, type IconName } from "../icons";
import { CATEGORY, formatRelativeTime, formatTimestamp, guessStatusDomain, SCOPE_ICON, SCOPE_KIND, statusMeta, typeDescription, typeLabel, type Category, type StatusDomain, type Tone } from "../labels";
import { Button } from "./button";
import { Callout } from "./feedback";
import { Disclosure, SegmentedControl } from "./page";
import { cx, hashSlot, isMac, useOverflowX } from "./util";

// ---- Badges ------------------------------------------------------------------------------------------

export interface BadgeProps {
  tone?: Tone;
  variant?: "soft" | "outline";
  icon?: IconName;
  dot?: boolean;
  title?: string;
  children: ReactNode;
}

/** A 20px pill: soft tint plus tone text. */
export function Badge({ tone = "neutral", variant = "soft", icon, dot, title, children }: BadgeProps) {
  return (
    <span className={cx("badge", `badge-${tone}`, variant === "outline" && "badge-outline", dot && "badge-dot")} title={title}>
      {icon && <I name={icon} size={14} />}
      {children}
    </span>
  );
}

export interface StatusBadgeProps {
  domain?: StatusDomain;
  value?: string;
  /** Legacy: an item or proposal status, detected automatically. */
  status?: string;
}

/** The label, tone and icon from STATUS[domain][value]; unknown values are humanized and neutral. */
export function StatusBadge({ domain, value, status }: StatusBadgeProps) {
  const v = value ?? status ?? "";
  const meta = statusMeta(domain ?? guessStatusDomain(v), v);
  return (
    <span className={cx("badge", `badge-${meta.tone}`, meta.outline && "badge-outline", "badge-status")}>
      {meta.spinner ? <span className="spinner" data-size="12" aria-hidden="true" /> : meta.icon && <I name={meta.icon} size={14} />}
      {meta.label}
    </span>
  );
}

/** Review categories: New, Edits, Moves, Library shares, Marked outdated. */
export function CategoryBadge({ category }: { category: Category }) {
  const c = CATEGORY[category];
  if (!c) return null;
  return (
    <Badge tone={c.tone} icon={c.icon} title={c.hint}>
      {c.label}
    </Badge>
  );
}

export interface TypeLabelProps {
  type: string;
  kind?: "article" | "finding";
  withIcon?: boolean;
}

/** Quiet text, not a pill: "Root cause analysis" (the type's description as its tooltip). */
export function TypeLabel({ type, kind, withIcon }: TypeLabelProps) {
  return (
    <span className="type-label" title={typeDescription(type)}>
      {withIcon && <I name={kind === "finding" ? "bolt" : "doc"} size={14} />}
      {typeLabel(type)}
    </span>
  );
}

export interface LocationLabelProps {
  scope: string | { slug: string; kind?: string } | null | undefined;
  path?: string;
  link?: boolean;
}

/** A kind icon plus the scope's name ("Order service v2 › Contracts"); the slug is the tooltip. */
export function LocationLabel({ scope, path, link }: LocationLabelProps) {
  const boot = useOptionalBoot();
  if (!scope) return null;
  const slug = typeof scope === "string" ? scope : scope.slug;
  const info = boot?.scope(slug);
  const kind = info?.kind ?? (typeof scope === "string" ? undefined : scope.kind) ?? "project";
  const name = info?.name ?? (kind !== "project" && SCOPE_KIND[kind] && slug === kind ? SCOPE_KIND[kind] : slug);
  const text = (
    <>
      <I name={SCOPE_ICON[kind] ?? "folder"} size={14} />
      <span className="location-label-name">{name}</span>
      {path && (
        <span className="location-label-path">
          <span aria-hidden="true"> › </span>
          <span className="sr-only">, </span>
          {path}
        </span>
      )}
    </>
  );
  const title = slug !== name ? slug : undefined;
  if (link) {
    const to = kind === "project" ? hashHref(`/project/${slug}`) : hashHref(`/scope/${slug}`);
    return (
      <a className="location-label" href={to} title={title}>
        {text}
      </a>
    );
  }
  return (
    <span className="location-label" title={title}>
      {text}
    </span>
  );
}

export interface CountBadgeProps {
  value: number;
  tone?: "neutral" | "accent" | "danger";
  /** The full meaning for screen readers ("12 pending proposals"). */
  label: string;
  max?: number;
}

/** A small count. Shows "99+" above `max`; the full label is read out. */
export function CountBadge({ value, tone = "neutral", label, max = 99 }: CountBadgeProps) {
  return (
    <span className={cx("count", "kit-count", `count-${tone}`)}>
      <span aria-hidden="true">{value > max ? `${max}+` : value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export interface ChipProps {
  children: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
}

/** A filter chip, removable with its × button. */
export function Chip({ children, onRemove, removeLabel }: ChipProps) {
  return (
    <span className={cx("chip", "chip-removable", !onRemove && "chip-static-kit")}>
      <span>{children}</span>
      {onRemove && (
        <button type="button" className="chip-remove" aria-label={removeLabel ?? `Remove ${typeof children === "string" ? children : "filter"}`} onClick={onRemove}>
          <I name="x" size={14} />
        </button>
      )}
    </span>
  );
}

export interface LinkChipProps {
  children: ReactNode;
  /** A link ("#/scope/x"), or a button with onClick. */
  href?: string;
  onClick?: () => void;
  /** Muted words after the label ("Table"). */
  hint?: ReactNode;
}

/** A pill that goes somewhere or does one thing (recent searches, examples, topics). Not a filter: see ChipGroup. */
export function LinkChip({ children, href, onClick, hint }: LinkChipProps) {
  const body = (
    <>
      <span className="link-chip-label">{children}</span>
      {hint && <span className="link-chip-hint">{hint}</span>}
    </>
  );
  return href ? (
    <a className="link-chip" href={href}>
      {body}
    </a>
  ) : (
    <button type="button" className="link-chip" onClick={onClick}>
      {body}
    </button>
  );
}

// ---- People ------------------------------------------------------------------------------------------

export interface AvatarProps {
  name?: string | null;
  email?: string | null;
  kind?: "human" | "service";
  size?: 20 | 24 | 32 | 40;
  /** Announce the avatar on its own (it is decorative by default, next to a visible name). */
  label?: string;
}

export function initials(name?: string | null, email?: string | null): string {
  const n = (name ?? "").trim();
  if (n) {
    const parts = n.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
  }
  return (email ?? "?").trim().charAt(0).toUpperCase() || "?";
}

/** Initials on a stable --avatar-n colour (from the email); service accounts show the bot icon. */
export function Avatar({ name, email, kind = "human", size = 32, label }: AvatarProps) {
  const slot = hashSlot((email ?? name ?? "").toLowerCase());
  return (
    <span className="avatar" data-size={size} data-color={slot} data-kind={kind === "service" ? "service" : undefined} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {kind === "service" ? <I name="bot" size={size <= 24 ? 12 : 16} /> : initials(name, email)}
    </span>
  );
}

export interface AvatarStackProps {
  people: { name?: string | null; email?: string | null }[];
  max?: number;
}

export function AvatarStack({ people, max = 4 }: AvatarStackProps) {
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  const names = people.map((p) => p.name || p.email || "Someone");
  const label = names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${rest} more`;
  return (
    <span className="avatar-stack" role="img" aria-label={label}>
      {shown.map((p, i) => (
        <Avatar key={`${p.email ?? p.name ?? ""}-${i}`} name={p.name} email={p.email} size={24} />
      ))}
      {rest > 0 && (
        <span className="avatar avatar-more" data-size={24} aria-hidden="true">
          +{rest}
        </span>
      )}
    </span>
  );
}

export interface PersonChipProps {
  name?: string | null;
  email?: string | null;
  kind?: "human" | "service";
  you?: boolean;
  showEmail?: boolean;
  size?: "sm" | "md";
  /** Links the name (e.g. to the person's access page). */
  href?: string;
}

/** An avatar and a name ("AI agent" for service accounts, "You" for the current person). */
/** A person's display name: their name, else the local part of their email (UX rule 11: name first, email secondary). */
export function displayName(name: string | null | undefined, email?: string | null): string {
  return name || (email ? email.split("@")[0]! : "") || "Someone";
}

export function PersonChip({ name, email, kind = "human", you, showEmail, size = "md", href }: PersonChipProps) {
  const display = displayName(name, email);
  const label = href ? (
    <a className="person-chip-name" href={href}>
      {display}
    </a>
  ) : (
    <span className="person-chip-name">{display}</span>
  );
  return (
    <span className="person-chip" data-size={size}>
      <Avatar name={name} email={email} kind={kind} size={size === "sm" ? 20 : 24} />
      {label}
      {kind === "service" && (
        <Badge tone="neutral" icon="bot">
          AI agent
        </Badge>
      )}
      {you && <Badge tone="accent">You</Badge>}
      {showEmail && email && email !== display && <span className="person-chip-email">{email}</span>}
    </span>
  );
}

// ---- Time --------------------------------------------------------------------------------------------

let tick = Date.now();
const tickers = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;
function subscribeTick(l: () => void) {
  tickers.add(l);
  if (!tickTimer)
    tickTimer = setInterval(() => {
      tick = Date.now();
      tickers.forEach((t) => t());
    }, 60_000);
  return () => {
    tickers.delete(l);
    if (!tickers.size && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  };
}

export interface RelativeTimeProps {
  date: string | null | undefined;
  prefix?: string;
  never?: string;
}

/** "3 hours ago" (full timestamp as the tooltip), refreshed every minute by one shared ticker. */
export function RelativeTime({ date, prefix, never = "Never" }: RelativeTimeProps) {
  useSyncExternalStore(subscribeTick, () => tick, () => tick);
  const text = formatRelativeTime(date, new Date(), never);
  if (!date) return <span className="relative-time">{prefix ? `${prefix} ${text.toLowerCase()}` : text}</span>;
  return (
    <time className="relative-time" dateTime={date} title={formatTimestamp(date)}>
      {prefix ? `${prefix} ${text}` : text}
    </time>
  );
}

// ---- Keys --------------------------------------------------------------------------------------------

const KEY_NAMES: Record<string, string> = { mod: "Command", shift: "Shift", alt: "Option", enter: "Enter", escape: "Escape", esc: "Escape", "/": "Slash", "?": "Question mark" };

/** "mod+k" → ⌘K on a Mac, Ctrl K elsewhere. */
export function Kbd({ keys }: { keys: string }) {
  const mac = isMac();
  const parts = keys.split("+").map((p) => p.trim());
  const shown = parts.map((p) => {
    const k = p.toLowerCase();
    if (k === "mod") return mac ? "⌘" : "Ctrl";
    if (k === "shift") return mac ? "⇧" : "Shift";
    if (k === "alt") return mac ? "⌥" : "Alt";
    if (k === "enter") return "↵";
    if (k === "escape" || k === "esc") return "Esc";
    // Letters are upper case only after a modifier (⌘K); single-key shortcuts show as typed (j, k, x).
    return p.length === 1 && parts.length > 1 ? p.toUpperCase() : p;
  });
  const spoken = parts.map((p) => (p.toLowerCase() === "mod" && !mac ? "Control" : (KEY_NAMES[p.toLowerCase()] ?? p.toUpperCase()))).join(" ");
  return (
    <kbd className="kbd">
      <span aria-hidden="true">{mac ? shown.join("") : shown.join(" ")}</span>
      <span className="sr-only">{spoken}</span>
    </kbd>
  );
}

/** "j k move · x select · o open". Hidden on touch, and single keys hide when single-key shortcuts are off. */
export function KeyHint({ items }: { items: { keys: string; label: string }[] }) {
  const [singleKeys] = useSingleKeyShortcuts();
  const shown = items.filter((i) => singleKeys || /mod\+/i.test(i.keys));
  if (!shown.length) return null;
  return (
    <p className="key-hint">
      {shown.map((i, n) => (
        <span key={i.keys + i.label} className="key-hint-item">
          {n > 0 && (
            <span className="key-hint-sep" aria-hidden="true">
              ·
            </span>
          )}
          {i.keys.split(" ").map((k) => (
            <Kbd key={k} keys={k} />
          ))}{" "}
          {i.label}
        </span>
      ))}
    </p>
  );
}

// ---- Code, copy and secrets --------------------------------------------------------------------------

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const t = document.createElement("textarea");
      t.value = text;
      t.setAttribute("readonly", "");
      t.style.position = "fixed";
      t.style.opacity = "0";
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand("copy");
      t.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export interface CopyButtonProps {
  text: string;
  label?: string;
  copiedLabel?: string;
  size?: "sm" | "md";
  /** Selected when copying fails, so ⌘C works. */
  selectTarget?: React.RefObject<HTMLElement>;
}

/** Copies `text`; says "Copied" (announced) for 1.8s. If the clipboard is blocked it selects the text instead. */
export function CopyButton({ text, label = "Copy", copiedLabel = "Copied", size = "sm", selectTarget }: CopyButtonProps) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), state === "done" ? 1800 : 4000);
    return () => clearTimeout(t);
  }, [state]);
  const failedText = `Press ${isMac() ? "⌘C" : "Ctrl+C"} to copy`;
  return (
    <>
      <Button
        size={size}
        variant="ghost"
        className="copy-button"
        icon={state === "done" ? "check" : "copy"}
        onClick={async () => {
          if (await writeClipboard(text)) setState("done");
          else {
            const el = selectTarget?.current;
            if (el) {
              const range = document.createRange();
              range.selectNodeContents(el);
              const sel = window.getSelection();
              sel?.removeAllRanges();
              sel?.addRange(range);
            }
            setState("failed");
          }
        }}
      >
        {state === "done" ? copiedLabel : state === "failed" ? failedText : label}
      </Button>
      <span className="sr-only" aria-live="polite">
        {state === "done" ? copiedLabel : state === "failed" ? failedText : ""}
      </span>
    </>
  );
}

export interface CodeBlockProps {
  code: string;
  label?: string;
  language?: "shell" | "yaml" | "json" | "markdown" | "text";
  wrap?: boolean;
  placeholder?: { token: string; hint: ReactNode; action?: ReactNode };
  maxHeight?: number;
}

/** Code with its label and Copy above it (Copy never covers code). Long lines scroll sideways with an edge fade. */
export function CodeBlock({ code, label, language = "text", wrap, placeholder, maxHeight }: CodeBlockProps) {
  const pre = useRef<HTMLPreElement>(null);
  const wraps = wrap ?? (language === "markdown" || language === "text");
  const over = useOverflowX(pre, [code, wraps]);
  const parts = placeholder ? code.split(placeholder.token) : [code];
  return (
    <div className="code-panel" data-overflow={over || undefined}>
      <div className="code-panel-head">
        <span className="code-panel-label">{label ?? (language === "shell" ? "Command" : language === "text" ? "Text" : language.toUpperCase())}</span>
        {placeholder && (
          <span className="code-panel-hint">
            {placeholder.hint}
            {placeholder.action}
          </span>
        )}
        <CopyButton text={code} selectTarget={pre} />
      </div>
      <pre
        ref={pre}
        className="code-block"
        data-wrap={wraps || undefined}
        style={maxHeight ? { maxHeight } : undefined}
        tabIndex={over || maxHeight ? 0 : undefined}
        role={over || maxHeight ? "region" : undefined}
        aria-label={over || maxHeight ? (label ?? "Code") : undefined}
      >
        <code>
          {parts.map((p, i) => (
            <span key={i}>
              {p}
              {i < parts.length - 1 && <mark className="code-placeholder">{placeholder!.token}</mark>}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export interface SecretRevealProps {
  title: string;
  value: string;
  warning?: string;
  extra?: ReactNode;
  onDone(): void;
  doneLabel?: string;
}

/** A token, temporary password or invitation link shown once, with Copy and an "I've copied it" button. */
export function SecretReveal({ title, value, warning = "Copy it now. It won't be shown again.", extra, onDone, doneLabel = "I've copied it" }: SecretRevealProps) {
  return (
    <div className="secret-reveal">
      <Callout tone="warning" title={title} icon="key">
        <p>{warning}</p>
      </Callout>
      <CodeBlock code={value} label={title} wrap />
      {extra && <div className="secret-reveal-extra">{extra}</div>}
      <div className="secret-reveal-actions">
        <Button variant="primary" onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}

export interface RunWithClaudeProps {
  title?: string;
  command: string;
  description?: ReactNode;
  variants?: { label: string; command: string }[];
}

/** A collapsed "Run this in Claude Code" with the command and a link to set Claude up. */
export function RunWithClaude({ title = "Run this in Claude Code", command, description, variants }: RunWithClaudeProps) {
  const [pick, setPick] = useState(variants?.[0]?.label ?? "");
  const id = useId();
  const current = variants?.find((v) => v.label === pick)?.command ?? command;
  return (
    <div className="run-with-claude" id={id}>
      <Disclosure summary={title}>
        {description && <div className="run-with-claude-description">{description}</div>}
        {variants && variants.length > 1 && <SegmentedControl label="Where you run it" size="sm" options={variants.map((v) => ({ value: v.label, label: v.label }))} value={pick} onChange={setPick} />}
        <CodeBlock code={current} language="shell" label="In Claude Code" />
        <p className="run-with-claude-foot">
          Claude not set up yet? <a href={hashHref("/connect")}>Set up Claude</a>
        </p>
      </Disclosure>
    </div>
  );
}

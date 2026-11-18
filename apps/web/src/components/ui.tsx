import type { ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { htmlComments } from "./markdown-plugins";
import type { Related, SourceLink } from "../api";
import { AssetImage } from "./assets";
import { I } from "./icons";
import { labelFrom, LINK_SYSTEM } from "./labels";
import { MermaidDiagram } from "./mermaid";
import { href } from "../router";
import { Callout, ErrorState, SkeletonText } from "./kit/feedback";
import { LocationLabel, StatusBadge as KitStatusBadge, TypeLabel } from "./kit/display";
import { DiffView } from "./kit/diff";
import { useConfirm } from "./kit/overlay";

/**
 * Stored content is untrusted. react-markdown renders no raw HTML and strips
 * unsafe URLs (javascript: etc.); links open in a new tab without referrer.
 * HTML comments show as muted "Hidden comment" blocks, except the editor's own markers (sync markers, template
 * hints); `comments="all"` shows those too, for reviewing a proposal.
 */
export function Markdown({ text, comments = "markers" }: { text: string; comments?: "markers" | "all" }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, [htmlComments, comments]]}
        urlTransform={(url) => (/^asset:[0-9a-f-]{36}$/.test(url) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href: url, children }) =>
            // Links inside Thaliyola (@ mentions, entity links) stay in the tab.
            url?.startsWith("#/") ? (
              <a href={url}>{children}</a>
            ) : (
              <a href={url} target="_blank" rel="noopener noreferrer nofollow">
                {children}
                <I name="external" size={12} className="markdown-external" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ),
          pre: ({ node, children }) => {
            // ```mermaid blocks become diagrams.
            const code = node?.children?.[0] as { tagName?: string; properties?: { className?: string[] }; children?: { value?: string }[] } | undefined;
            if (code?.tagName === "code" && code.properties?.className?.includes("language-mermaid")) {
              return <MermaidDiagram code={(code.children ?? []).map((c) => c.value ?? "").join("")} />;
            }
            return <pre>{children}</pre>;
          },
          img: ({ src, alt }) => {
            if (typeof src !== "string") return null;
            if (src.startsWith("asset:")) return <AssetImage id={src.slice(6)} alt={alt ?? ""} />;
            return /^https:\/\//.test(src) ? <img src={src} alt={alt ?? ""} loading="lazy" /> : null;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Search snippets mark matches with **…**; render them as <mark>, everything else as plain text. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split("**");
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

/** Legacy badge: `kind` picks a style (published, draft, scope-library, type, op…). New code uses the kit Badge. */
export function Badge({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`badge ${kind ? `badge-${kind}` : ""}`}>{children}</span>;
}

/** Legacy StatusBadge({ status }): the kit StatusBadge (label maps, tone and icon), item or proposal status. */
export function StatusBadge({ status }: { status: string }) {
  return <KitStatusBadge status={status} />;
}

/** Legacy TypeBadge: the type's label (TypeLabel) in an outline badge, its description as the tooltip. */
export function TypeBadge({ type }: { type: string }) {
  return (
    <span className="badge badge-type">
      <TypeLabel type={type} />
    </span>
  );
}

/** Legacy ScopeBadge: the scope's name with its kind icon (the slug is the tooltip). */
export function ScopeBadge({ scope }: { scope: { slug: string; kind: string } | string }) {
  return <LocationLabel scope={scope} />;
}

/** Three skeleton lines that reserve space while something loads; announced politely (SPEC §5.8, §5.17). */
export function Loading() {
  return (
    <div className="loading-block" role="status" aria-busy="true">
      <span className="sr-only">Loading</span>
      <SkeletonText lines={3} />
    </div>
  );
}

/** What failed, in plain words (compact ErrorState, role="alert"), with Try again when `onRetry` is given. */
export function ErrorBox({ error, onRetry }: { error: Error | null; onRetry?: () => void }) {
  if (!error) return null;
  return <ErrorState compact error={error} onRetry={onRetry} />;
}

const NOTICE_TONE = { info: "info", warn: "warning", ok: "success" } as const;

/** Legacy Notice: a Callout (info, warning, success). */
export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "ok"; children: ReactNode }) {
  return <Callout tone={NOTICE_TONE[kind]}>{children}</Callout>;
}

/**
 * A button for an action that needs a confirmation. It opens the kit confirm dialog (nothing reflows), which
 * embedded browsers can't suppress the way they suppress window.confirm. With `typeToConfirm`, the action waits
 * until one of those values (e.g. a project's name) is typed; `onConfirm` gets the typed text.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel = label,
  typeToConfirm,
  className = "btn btn-small btn-danger",
  onConfirm,
}: {
  label: string;
  question: string;
  confirmLabel?: string;
  typeToConfirm?: string[];
  className?: string;
  onConfirm: (typed: string) => void;
}) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      className={className}
      aria-haspopup="dialog"
      onClick={async () => {
        const r = await confirm({
          title: question,
          confirmLabel,
          tone: /danger/.test(className) ? "danger" : "default",
          typeToConfirm: typeToConfirm?.length ? { values: typeToConfirm } : undefined,
        });
        if (r) onConfirm(r.typed ?? "");
      }}
    >
      {label}
    </button>
  );
}

export function itemHref(kind: string, id: string) {
  if (kind === "article") return href(`/article/${id}`);
  if (kind === "finding") return href(`/finding/${id}`);
  return undefined;
}

const RELATION_TEXT: Record<string, [string, string]> = {
  uses: ["uses", "used by"],
  depends_on: ["depends on", "needed by"],
  provided_by: ["provided by", "provides"],
  consumed_by: ["consumed by", "consumes"],
  related: ["related", "related"],
  same_root_cause: ["same root cause", "same root cause"],
  supersedes: ["supersedes", "superseded by"],
  promoted_into: ["promoted into", "includes finding"],
  published_as: ["published as", "published from"],
  // Lineage: a repository reads or writes a table.
  reads: ["reads", "read by"],
  writes: ["writes", "written by"],
};

export function RelatedList({ items }: { items: Related[] }) {
  if (!items.length) return null;
  return (
    <section className="side-block">
      <h3>Related items</h3>
      <ul className="plain">
        {items.map((r) => {
          const text = RELATION_TEXT[r.relation]?.[r.direction === "out" ? 0 : 1] ?? r.relation;
          const link = itemHref(r.kind, r.id);
          return (
            <li key={`${r.relation}-${r.direction}-${r.id}`}>
              <span className="muted small">{text}</span>{" "}
              {link ? <a href={link}>{r.label}</a> : <span>{r.label}</span>}{" "}
              {r.scope && <LocationLabel scope={r.scope} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function SourceLinks({ links }: { links: SourceLink[] }) {
  if (!links.length) return null;
  return (
    <section className="side-block">
      <h3>External links</h3>
      <ul className="plain">
        {links.map((l) => (
          <li key={l.url}>
            <span className="muted small">{labelFrom(LINK_SYSTEM, l.system)}</span>{" "}
            <a href={l.url} target="_blank" rel="noopener noreferrer nofollow">
              {l.label || l.url}
              <I name="external" size={12} className="markdown-external" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Line diff between two texts (the kit DiffView in source mode). */
export function Diff({ before, after }: { before: string; after: string }) {
  return <DiffView before={before} after={after} mode="source" />;
}

export function formatDate(iso: string | null | undefined) {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Explains the outcome of a write from the UI. */
export function WriteOutcome({ published }: { published: boolean | undefined }) {
  return published ? (
    <Notice kind="ok">Published.</Notice>
  ) : (
    <Notice>Saved as a proposal. A Reviewer or Project admin there will review it.</Notice>
  );
}

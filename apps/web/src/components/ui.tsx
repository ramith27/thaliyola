import { diffLines } from "diff";
import type { ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Related, SourceLink } from "../api";
import { AssetImage } from "./assets";
import { href } from "../router";

/**
 * Stored content is untrusted. react-markdown renders no raw HTML and strips
 * unsafe URLs (javascript: etc.); links open in a new tab without referrer.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (/^asset:[0-9a-f-]{36}$/.test(url) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ href: url, children }) =>
            // Links inside Cairn (@ mentions, entity links) stay in the tab.
            url?.startsWith("#/") ? (
              <a href={url}>{children}</a>
            ) : (
              <a href={url} target="_blank" rel="noopener noreferrer nofollow">
                {children}
              </a>
            ),
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

const label = (s: string) => s.replace(/_/g, " ");

export function Badge({ kind, children }: { kind?: string; children: ReactNode }) {
  return <span className={`badge ${kind ? `badge-${kind}` : ""}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  return <Badge kind={status}>{label(status)}</Badge>;
}

export function TypeBadge({ type }: { type: string }) {
  return <Badge kind="type">{label(type)}</Badge>;
}

export function ScopeBadge({ scope }: { scope: { slug: string; kind: string } | string }) {
  const s = typeof scope === "string" ? { slug: scope, kind: "" } : scope;
  return <Badge kind={`scope-${s.kind || "project"}`}>{s.slug}</Badge>;
}

export function Loading() {
  return <p className="muted">Loading…</p>;
}

export function ErrorBox({ error }: { error: Error | null }) {
  if (!error) return null;
  return <div className="error">{error.message}</div>;
}

export function Notice({ kind = "info", children }: { kind?: "info" | "warn" | "ok"; children: ReactNode }) {
  return <div className={`notice notice-${kind}`}>{children}</div>;
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
};

export function RelatedList({ items }: { items: Related[] }) {
  if (!items.length) return null;
  return (
    <section className="side-block">
      <h3>Links</h3>
      <ul className="plain">
        {items.map((r) => {
          const text = RELATION_TEXT[r.relation]?.[r.direction === "out" ? 0 : 1] ?? r.relation;
          const link = itemHref(r.kind, r.id);
          return (
            <li key={`${r.relation}-${r.direction}-${r.id}`}>
              <span className="muted small">{text}</span>{" "}
              {link ? <a href={link}>{r.label}</a> : <span>{r.label}</span>}{" "}
              {r.scope && <ScopeBadge scope={r.scope} />}
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
      <h3>Sources</h3>
      <ul className="plain">
        {links.map((l) => (
          <li key={l.url}>
            <Badge>{l.system}</Badge>{" "}
            <a href={l.url} target="_blank" rel="noopener noreferrer nofollow">
              {l.label || l.url}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Line diff between two texts. */
export function Diff({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before.endsWith("\n") ? before : `${before}\n`, after.endsWith("\n") ? after : `${after}\n`);
  return (
    <pre className="diff">
      {parts.map((p, i) => (
        <span key={i} className={p.added ? "diff-add" : p.removed ? "diff-del" : "diff-same"}>
          {p.value
            .replace(/\n$/, "")
            .split("\n")
            .map((line) => `${p.added ? "+ " : p.removed ? "- " : "  "}${line}`)
            .join("\n") + "\n"}
        </span>
      ))}
    </pre>
  );
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
    <Notice>Saved as a proposal. A scope owner will review it.</Notice>
  );
}

import { createRequire } from "node:module";
import path from "node:path";
import { unzipSync } from "fflate";
import TurndownService from "turndown";
import { uploadAsset } from "./assets.js";
import { reindexArticle } from "./chunking.js";
import { ValidationError, type RequestContext } from "./context.js";
import { settleProposal } from "./direct.js";
import { notify, reviewersFor, track } from "./notify.js";
import { canApprove } from "./permissions.js";
import { createArticle, type CreateArticleInput } from "./writes.js";

/**
 * Imports existing documentation: Markdown and HTML files, or a zip of them,
 * including Notion ("Markdown & CSV"), Confluence (HTML space export) and
 * Google Docs (Web page, .html zipped) exports. Each page becomes an article
 * through the normal write path (redaction, review); images inside the zip
 * become attachments.
 */

// Minimal DOM surface used here (the server has no DOM lib types).
interface El {
  textContent: string | null;
  innerHTML: string;
  getAttribute(name: string): string | null;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): ArrayLike<El>;
  remove(): void;
}
interface Doc extends El {
  title: string;
  body: El;
}
const domino = createRequire(import.meta.url)("@mixmark-io/domino") as { createDocument(html: string, force?: boolean): Doc };

export const MAX_PAGES = 200;
const MAX_UNZIPPED = 200 * 1024 * 1024;
const MAX_FILE = 20 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

export interface ImportPage {
  source: string;
  title: string;
  path: string;
  body_md: string;
  images: { ref: string; file: string }[];
  warnings: string[];
}

export interface ParsedImport {
  format: "markdown" | "html" | "notion" | "confluence" | "zip";
  pages: ImportPage[];
  skipped: { file: string; reason: string }[];
  files: Map<string, Uint8Array>;
}

// ---- HTML → Markdown -------------------------------------------------------------

function turndown() {
  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-", emDelimiter: "_" });
  td.remove(["script", "style", "noscript", "iframe", "object", "embed", "form", "button", "input", "select", "textarea"] as never);
  // GFM tables: one line per row, cell content flattened.
  td.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const table = node as unknown as El;
      const rows = Array.from(table.querySelectorAll("tr"));
      if (!rows.length) return "";
      const cells = rows.map((r) =>
        Array.from(r.querySelectorAll("th, td")).map((c) => (c.textContent ?? "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()),
      );
      const width = Math.max(...cells.map((r) => r.length));
      const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
      const [head, ...body] = cells;
      return `\n\n| ${pad(head!).join(" | ")} |\n| ${Array(width).fill("---").join(" | ")} |\n${body.map((r) => `| ${pad(r).join(" | ")} |`).join("\n")}\n\n`;
    },
  });
  // Google Docs wraps bold in <span style="font-weight:700">.
  td.addRule("gdocsBold", {
    filter: (node) => node.nodeName === "SPAN" && /font-weight:\s*(700|bold)/.test((node as unknown as El).getAttribute("style") ?? ""),
    replacement: (content) => (content.trim() ? `**${content.trim()}**` : content),
  });
  return td;
}

function htmlPage(html: string, source: string): { title: string; body_md: string; confluence: boolean } {
  const doc = domino.createDocument(html, true);
  // Confluence space exports: the page lives in #main-content; titles read "Space : Page".
  const confluence = !!doc.querySelector("#main-content") && /confluence/i.test(html.slice(0, 5000) + (doc.querySelector('meta[name="generator"]')?.getAttribute("content") ?? ""));
  const root = doc.querySelector("#main-content") ?? doc.querySelector("article") ?? doc.querySelector("main") ?? doc.body;
  for (const sel of ["#breadcrumb-section", ".page-metadata", "#footer", "nav", "header .aui-header"]) for (const el of Array.from(doc.querySelectorAll(sel))) el.remove();
  let title = (doc.querySelector("#title-text")?.textContent ?? doc.title ?? "").trim();
  if (confluence && title.includes(" : ")) title = title.split(" : ").slice(1).join(" : ").trim();
  const h1 = root.querySelector("h1");
  if (!title && h1) title = (h1.textContent ?? "").trim();
  if (h1 && (h1.textContent ?? "").trim() === title) h1.remove();
  const body_md = turndown().turndown(root.innerHTML).replace(/\n{3,}/g, "\n\n").trim();
  return { title: title || titleFromFile(source), body_md, confluence };
}

// ---- Markdown -----------------------------------------------------------------------

const NOTION_ID = /\s+[0-9a-f]{32}$/i;

function titleFromFile(file: string) {
  return path
    .basename(file, path.extname(file))
    .replace(NOTION_ID, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

function markdownPage(md: string, source: string): { title: string; body_md: string } {
  const text = md.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  // Front matter title, then a leading "# Title".
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  let body = fm ? text.slice(fm[0].length) : text;
  let title = fm ? (/^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1]!)?.[1] ?? "") : "";
  const h1 = /^\s*#\s+(.+?)\s*#*\s*\n/.exec(body);
  if (h1) {
    if (!title) title = h1[1]!;
    if (h1[1] === title) body = body.slice(h1[0].length);
  }
  return { title: title.trim() || titleFromFile(source), body_md: body.trim() };
}

// ---- Images ---------------------------------------------------------------------------

/** Relative image references that point at files in the upload. */
function findImages(body: string, pageFile: string, files: Map<string, Uint8Array>) {
  const out: { ref: string; file: string }[] = [];
  const dir = path.posix.dirname(pageFile);
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const ref = m[1]!;
    if (/^(https?:|data:|asset:)/i.test(ref)) continue;
    let decoded = ref;
    try {
      decoded = decodeURIComponent(ref);
    } catch {
      /* keep as is */
    }
    const file = path.posix.normalize(path.posix.join(dir, decoded.split(/[?#]/)[0]!));
    if (files.has(file) && IMAGE_MIME[path.extname(file).toLowerCase()]) out.push({ ref, file });
  }
  return out;
}

// ---- Parsing an upload -------------------------------------------------------------------

const isZip = (data: Uint8Array) => data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
const decode = (data: Uint8Array) => new TextDecoder("utf-8").decode(data);

export function parseUpload(filename: string, data: Uint8Array): ParsedImport {
  const files = new Map<string, Uint8Array>();
  const skipped: { file: string; reason: string }[] = [];
  if (isZip(data)) {
    let total = 0;
    const entries = unzipSync(data, {
      filter: (f) => {
        if (f.name.endsWith("/") || /(^|\/)(__MACOSX|\.)/.test(f.name)) return false;
        if (f.originalSize > MAX_FILE) {
          skipped.push({ file: f.name, reason: "larger than 20 MB" });
          return false;
        }
        total += f.originalSize;
        if (total > MAX_UNZIPPED) throw new ValidationError("the zip expands to more than 200 MB; split it into smaller exports");
        return true;
      },
    });
    for (const [name, content] of Object.entries(entries)) files.set(path.posix.normalize(name), content);
    // Notion nests a second zip inside its export zip.
    if (files.size === 1) {
      const [only] = [...files.entries()];
      if (only && isZip(only[1])) return parseUpload(only[0], only[1]);
    }
  } else {
    files.set(path.posix.basename(filename), data);
  }

  const names = [...files.keys()];
  const notion = names.some((n) => NOTION_ID.test(path.basename(n, path.extname(n))));
  // Folders become article folders; drop a single top-level folder (the export's own name).
  const tops = new Set(names.map((n) => n.split("/")[0]));
  const strip = tops.size === 1 && names.every((n) => n.includes("/")) ? `${[...tops][0]}/` : "";
  const folderOf = (file: string) =>
    path.posix
      .dirname(file.slice(strip.length))
      .split("/")
      .filter((p) => p && p !== ".")
      .map((p) => p.replace(NOTION_ID, ""))
      .join("/");

  const pages: ImportPage[] = [];
  let confluence = false;
  for (const name of names.sort()) {
    const ext = path.extname(name).toLowerCase();
    if (IMAGE_MIME[ext]) continue;
    const base = path.basename(name).toLowerCase();
    if (![".md", ".markdown", ".txt", ".html", ".htm"].includes(ext)) {
      skipped.push({ file: name, reason: ext === ".docx" || ext === ".pdf" ? `${ext} isn't supported; export as HTML or Markdown` : "not a page" });
      continue;
    }
    // Confluence and Google exports carry an index page that only links to the others.
    if (base === "index.html" && names.length > 1) {
      skipped.push({ file: name, reason: "index page" });
      continue;
    }
    const text = decode(files.get(name)!);
    const parsed = ext === ".html" || ext === ".htm" ? htmlPage(text, name) : markdownPage(text, name);
    if ("confluence" in parsed && parsed.confluence) confluence = true;
    const warnings: string[] = [];
    if (!parsed.body_md.trim()) {
      skipped.push({ file: name, reason: "empty page" });
      continue;
    }
    const images = findImages(parsed.body_md, name, files);
    const missing = [...parsed.body_md.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)].filter((m) => !/^(https?:|data:)/.test(m[1]!) && !images.some((i) => i.ref === m[1])).length;
    if (missing) warnings.push(`${missing} image${missing > 1 ? "s" : ""} not found in the upload`);
    if (/\]\((?!https?:|#|mailto:)[^)]+\.(md|html?)\)/i.test(parsed.body_md)) warnings.push("links to other imported pages point at files; update them after import");
    pages.push({ source: name, title: parsed.title.slice(0, 200), path: folderOf(name), body_md: parsed.body_md, images, warnings });
  }
  const format = notion ? "notion" : confluence ? "confluence" : files.size > 1 ? "zip" : names[0]?.match(/\.html?$/i) ? "html" : "markdown";
  return { format, pages, skipped, files };
}

// ---- Importing -----------------------------------------------------------------------------

export async function importDocs(
  ctx: RequestContext,
  input: { filename: string; data: Uint8Array; scope: string; type: CreateArticleInput["type"]; folder?: string; dryRun?: boolean },
) {
  const parsed = parseUpload(input.filename, input.data);
  if (!parsed.pages.length) throw new ValidationError(`no pages found in ${input.filename}${parsed.skipped.length ? ` (skipped: ${parsed.skipped.map((s) => `${s.file}: ${s.reason}`).join("; ")})` : ""}`);
  if (parsed.pages.length > MAX_PAGES) throw new ValidationError(`${parsed.pages.length} pages is more than ${MAX_PAGES} at once; import in parts`);
  const folder = (p: string) => [input.folder?.trim(), p].filter(Boolean).join("/");
  const summary = parsed.pages.map((p) => ({ title: p.title, path: folder(p.path), source: p.source, chars: p.body_md.length, images: p.images.length, warnings: p.warnings }));
  if (input.dryRun) return { dry_run: true, format: parsed.format, pages: summary, skipped: parsed.skipped };

  const quiet = { ...ctx, quietProposals: true };
  const imported: { title: string; id: string; published: boolean; revision_id: string }[] = [];
  const failed: { title: string; error: string }[] = [];
  let scopeId: string | null = null;
  for (const page of parsed.pages) {
    try {
      const created = await createArticle(quiet, { scope: input.scope, type: input.type, title: page.title, path: folder(page.path), body_md: page.body_md });
      const id = created.article_id;
      // Attach images from the zip and point the page at them.
      let body = (await ctx.db.query<{ body_md: string; scope_id: string }>("SELECT body_md, scope_id FROM articles WHERE id = $1", [id])).rows[0]!;
      scopeId = body.scope_id;
      let changed = false;
      for (const img of page.images) {
        try {
          const asset = await uploadAsset(ctx, { target_id: id, filename: path.basename(img.file), mime: IMAGE_MIME[path.extname(img.file).toLowerCase()]!, data: Buffer.from(parsed.files.get(img.file)!) });
          body = { ...body, body_md: body.body_md.split(`](${img.ref}`).join(`](asset:${asset.asset_id}`) };
          changed = true;
        } catch (err) {
          page.warnings.push(`image ${path.basename(img.file)}: ${(err as Error).message}`);
        }
      }
      if (changed) {
        const { rows } = await ctx.db.query("UPDATE articles SET body_md = $2 WHERE id = $1 RETURNING id, scope_id, title, body_md", [id, body.body_md]);
        await reindexArticle(ctx.db, rows[0]);
      }
      const settled = await settleProposal(quiet, body.scope_id, created);
      imported.push({ title: page.title, id, published: settled.published, revision_id: created.revision_id });
    } catch (err) {
      failed.push({ title: page.title, error: (err as Error).message });
    }
  }
  // One message to reviewers for the whole batch instead of one per page.
  const waiting = imported.filter((i) => !i.published).length;
  if (waiting && scopeId && !(await canApprove(ctx, scopeId))) {
    track(
      reviewersFor(ctx.db, ctx.settings, scopeId)
        .then((ids) =>
          notify(ctx.db, ctx.settings, ids, {
            kind: "review",
            title: `Review: ${waiting} imported article${waiting > 1 ? "s" : ""} from ${input.filename}`,
            body: `${ctx.actor.email ?? "Someone"} imported ${waiting} page${waiting > 1 ? "s" : ""} into ${input.scope}.`,
            link: "#/review",
          }, { exclude: ctx.actor.id }),
        )
        .catch((err) => console.error(`[notify] ${(err as Error).message}`)),
    );
  }
  return { dry_run: false, format: parsed.format, imported, failed, skipped: parsed.skipped, pages: summary };
}

/** HTML from anywhere (a fetched page, a feed entry) as a title and Markdown, main content only. */
export function htmlToMarkdown(html: string): { title: string; body_md: string } {
  const doc = domino.createDocument(html, true);
  for (const sel of ["script", "style", "noscript", "nav", "footer", "header", "aside", "form", "iframe"]) for (const el of Array.from(doc.querySelectorAll(sel))) el.remove();
  const root = doc.querySelector("article") ?? doc.querySelector("main") ?? doc.querySelector('[role="main"]') ?? doc.body;
  const title = (doc.title || doc.querySelector("h1")?.textContent || "").trim();
  return { title, body_md: root ? turndown().turndown(root.innerHTML).replace(/\n{3,}/g, "\n\n").trim() : "" };
}

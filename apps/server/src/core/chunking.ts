import type { Queryable } from "../db/pool.js";

export interface Section {
  heading: string;
  text: string;
}

/**
 * Splits markdown into sections at `#`/`##` headings so a search hit points at
 * one section. Text before the first heading becomes an untitled section.
 * Deeper headings stay inside their parent section.
 */
export function splitSections(markdown: string): Section[] {
  const sections: Section[] = [];
  let current: Section = { heading: "", text: "" };
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) {
      if (current.heading || current.text.trim()) sections.push(current);
      current = { heading: m[2]!, text: "" };
    } else {
      current.text += line + "\n";
    }
  }
  if (current.heading || current.text.trim()) sections.push(current);
  return sections.map((s) => ({ heading: s.heading, text: s.text.trim() }));
}

export async function reindexArticle(
  db: Queryable,
  article: { id: string; scope_id: string; title: string; body_md: string },
): Promise<void> {
  await db.query("DELETE FROM chunks WHERE parent_kind = 'article' AND parent_id = $1", [article.id]);
  const sections = splitSections(article.body_md);
  // The title is searchable even when the body is empty.
  const rows = sections.length ? sections : [{ heading: "", text: "" }];
  for (const [ord, s] of rows.entries()) {
    await db.query(
      `INSERT INTO chunks (parent_kind, parent_id, scope_id, ord, heading, text) VALUES ('article', $1, $2, $3, $4, $5)`,
      [article.id, article.scope_id, ord, s.heading || article.title, `${article.title}\n${s.text}`],
    );
  }
}

export async function reindexFinding(
  db: Queryable,
  finding: { id: string; scope_id: string; title: string; symptoms: string; root_cause: string; fix: string },
): Promise<void> {
  await db.query("DELETE FROM chunks WHERE parent_kind = 'finding' AND parent_id = $1", [finding.id]);
  const text = [finding.symptoms, finding.root_cause, finding.fix].filter(Boolean).join("\n");
  await db.query(
    `INSERT INTO chunks (parent_kind, parent_id, scope_id, ord, heading, text) VALUES ('finding', $1, $2, 0, $3, $4)`,
    [finding.id, finding.scope_id, finding.title, text],
  );
}

/**
 * Replaces the body of the `##` section named `heading` (case-insensitive), or
 * appends a new section when there is none. With `append`, adds to the end of
 * the section instead of replacing it.
 */
export function replaceSection(markdown: string, heading: string, text: string, mode: "replace" | "append" = "replace"): string {
  const lines = markdown.split("\n");
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,2})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    if (start === -1 && m[2]!.toLowerCase() === heading.toLowerCase()) {
      start = i;
    } else if (start !== -1) {
      end = i;
      break;
    }
  }
  const body = text.trim();
  if (start === -1) return `${markdown.trimEnd()}\n\n## ${heading}\n\n${body}\n`;
  const existing = lines.slice(start + 1, end).join("\n").trim();
  const next = mode === "append" && existing ? `${existing}\n${body}` : body;
  const before = lines.slice(0, start + 1).join("\n");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${next}\n${after ? `\n${after}` : ""}`;
}

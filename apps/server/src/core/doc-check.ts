import type { Queryable } from "../db/pool.js";
import type { PrChange } from "./connections/git.js";

/**
 * The docs check: which facts in a project's docs cite lines a pull request changes. Facts keep evidence as
 * {path, start, end} line ranges; the pull request's unified diff says, for each range, whether its lines were
 * changed, only moved (edits above it, or the file renamed), or deleted with the file. No code is read beyond the
 * diff and nothing is judged by a model: a changed line means the fact needs a person (or the CI docs run) to look.
 */

export interface Hunk {
  /** Old-file lines this diff deletes. */
  deleted: number[];
  /** For each added line, the old-file line it comes after (0: at the top). */
  insertedAfter: number[];
}

/** Reads a unified diff's hunks into deleted lines and insertion points, in old-file line numbers. */
export function parsePatch(patch: string): Hunk {
  const deleted: number[] = [];
  const insertedAfter: number[] = [];
  let old = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      old = Number(h[1]);
      // "-0,0" (a new file): additions come after line 0.
      if (h[2] === "0") old += 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    const c = line[0];
    if (c === "-") deleted.push(old++);
    else if (c === "+") insertedAfter.push(old - 1);
    else if (c === " " || line === "") old++;
  }
  return { deleted, insertedAfter };
}

export type Outcome = "changed" | "removed" | "moved" | "unknown";

/** What a diff does to the old-file lines start..end: nothing, changes them, or shifts them by some lines. */
export function rangeOutcome(h: Hunk, start: number, end: number): { changed: boolean; shift: number } {
  const changed = h.deleted.some((d) => d >= start && d <= end) || h.insertedAfter.some((p) => p >= start && p < end);
  const shift = h.insertedAfter.filter((p) => p < start).length - h.deleted.filter((d) => d < start).length;
  return { changed, shift };
}

export interface FactVerdict {
  claim_id: string;
  article_id: string;
  article: string;
  path: string;
  start: number;
  end: number;
  outcome: Outcome;
  /** Where the lines are after the change (moved facts). */
  to?: { path: string; start: number; end: number };
}

export interface DocsCheck {
  facts: FactVerdict[];
  changed: number;
  removed: number;
  moved: number;
  unknown: number;
}

/** Every fact in the repository's docs that cites a file this pull request touches, with what happens to it. */
export async function checkDocs(db: Queryable, scopeId: string, component: string, changes: PrChange[]): Promise<DocsCheck> {
  // Facts cite paths as they were before the change: a renamed file is found under its old name.
  const byOld = new Map<string, PrChange>();
  for (const c of changes) byOld.set(c.previous_path ?? c.path, c);
  const paths = [...byOld.keys()];
  const empty: DocsCheck = { facts: [], changed: 0, removed: 0, moved: 0, unknown: 0 };
  if (!paths.length) return empty;
  const { rows } = await db.query<{ claim_id: string; article_id: string; article: string; evidence: { path: string; start?: number; end?: number }[] }>(
    `SELECT c.id AS claim_id, c.article_id, a.title AS article, c.evidence
       FROM claims c JOIN articles a ON a.id = c.article_id
      WHERE c.status = 'ok' AND a.status IN ('published', 'possibly_stale')
        AND c.article_id IN (SELECT article_id FROM doc_pages WHERE scope_id = $1 AND component = $2)
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.evidence) e WHERE e->>'path' = ANY($3::text[]))
      ORDER BY a.title, c.created_at LIMIT 500`,
    [scopeId, component, paths],
  );
  const hunks = new Map<string, Hunk | null>();
  const facts: FactVerdict[] = [];
  for (const r of rows) {
    for (const e of r.evidence) {
      const change = byOld.get(e.path);
      if (!change || !Number.isInteger(e.start)) continue;
      const start = e.start!;
      const end = Number.isInteger(e.end) ? Math.max(e.end!, start) : start;
      const base = { claim_id: r.claim_id, article_id: r.article_id, article: r.article, path: e.path, start, end };
      if (change.status === "removed") {
        facts.push({ ...base, outcome: "removed" });
        continue;
      }
      if (!hunks.has(e.path)) hunks.set(e.path, change.patch ? parsePatch(change.patch) : null);
      const h = hunks.get(e.path);
      if (!h) {
        // A rename with no content change has no patch; anything else without one is too big to tell.
        if (change.status === "renamed") facts.push({ ...base, outcome: "moved", to: { path: change.path, start, end } });
        else facts.push({ ...base, outcome: "unknown" });
        continue;
      }
      const { changed, shift } = rangeOutcome(h, start, end);
      if (changed) facts.push({ ...base, outcome: "changed" });
      else if (shift !== 0 || change.path !== e.path) facts.push({ ...base, outcome: "moved", to: { path: change.path, start: start + shift, end: end + shift } });
    }
  }
  const count = (o: Outcome) => facts.filter((f) => f.outcome === o).length;
  return { facts, changed: count("changed"), removed: count("removed"), moved: count("moved"), unknown: count("unknown") };
}

/** Facts that need a person: their cited lines changed, were deleted, or the diff was too big to tell. */
export const needsLook = (d: DocsCheck) => d.changed + d.removed + d.unknown;

/** The commit status for a docs check. */
export function docsStatus(d: DocsCheck, mode: "warn" | "block", acknowledgedBy: string | null): { state: "success" | "failure"; description: string } {
  const look = needsLook(d);
  if (!look) return { state: "success", description: d.moved ? `Docs cite moved lines (${d.moved}); they follow the code when this merges` : "No documented facts cite the changed lines" };
  const what = [d.changed && `${d.changed} changed`, d.removed && `${d.removed} deleted`, d.unknown && `${d.unknown} unclear`].filter(Boolean).join(", ");
  if (acknowledgedBy) return { state: "success", description: `Facts citing changed lines (${what}) acknowledged by ${acknowledgedBy}` };
  if (mode === "warn") return { state: "success", description: `${look} documented fact${look === 1 ? "" : "s"} cite lines this changes (${what}); check the docs` };
  return { state: "failure", description: `${look} documented fact${look === 1 ? "" : "s"} cite lines this changes (${what}); update or acknowledge them in Thaliyola` };
}

/**
 * After the pull request merged: moved facts now cite where their code went, and facts whose lines changed or were
 * deleted are marked stale (the docs page shows them, answers flag them, and the next CI docs run re-checks them).
 */
export async function applyDocsCheck(db: Queryable, d: DocsCheck, label: string) {
  let moved = 0;
  let stale = 0;
  const byClaim = new Map<string, FactVerdict[]>();
  for (const f of d.facts) byClaim.set(f.claim_id, [...(byClaim.get(f.claim_id) ?? []), f]);
  for (const [claimId, verdicts] of byClaim) {
    const bad = verdicts.find((v) => v.outcome !== "moved");
    if (bad) {
      const reason = bad.outcome === "removed" ? `the cited file was deleted in ${label}` : bad.outcome === "changed" ? `the cited lines changed in ${label}` : `${label} changed the cited file too much to tell`;
      stale += (await db.query("UPDATE claims SET status = 'stale', stale_reason = $2 WHERE id = $1 AND status = 'ok'", [claimId, reason])).rowCount ?? 0;
      continue;
    }
    const row = (await db.query<{ evidence: { path: string; start?: number; end?: number }[] }>("SELECT evidence FROM claims WHERE id = $1", [claimId])).rows[0];
    if (!row) continue;
    const evidence = row.evidence.map((e) => {
      const v = verdicts.find((x) => x.path === e.path && x.start === e.start);
      return v?.to ? { ...e, path: v.to.path, start: v.to.start, end: v.to.end } : e;
    });
    await db.query("UPDATE claims SET evidence = $2 WHERE id = $1", [claimId, JSON.stringify(evidence)]);
    moved++;
  }
  return { moved, stale };
}

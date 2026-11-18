import { z } from "zod";
import { ValidationError, type RequestContext } from "./context.js";
import { getDesignSystem, type Tokens } from "./design.js";
import { emitChanged } from "./events.js";
import { assertCanPropose } from "./permissions.js";
import { getReadableScope } from "./scopes.js";

/**
 * Design drift: does the code still match the recorded design system? The caller (a CI step, or an agent running
 * check-design) reports what the code really defines and where it hard-codes colours; Thaliyola compares that with
 * the effective system (inheritance included) and keeps the report. Nothing here reads code: values come from the
 * caller, so this works the same for any stack.
 */

const entry = z.object({ name: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(200), dark: z.string().trim().max(200).optional() });
export const driftInputSchema = z.object({
  tokens: z
    .object({
      colors: z.array(entry).max(500).optional(),
      spacing: z.array(entry).max(300).optional(),
      radii: z.array(entry).max(100).optional(),
      shadows: z.array(entry).max(100).optional(),
      breakpoints: z.array(entry).max(50).optional(),
      fonts: z.array(z.object({ role: z.string().trim().min(1).max(40), family: z.string().trim().min(1).max(200) })).max(20).optional(),
    })
    .default({}),
  hardcoded: z
    .array(z.object({ value: z.string().trim().min(1).max(60), file: z.string().trim().min(1).max(300), line: z.number().int().min(1).optional(), count: z.number().int().min(1).optional() }))
    .max(1000)
    .optional(),
  source: z.string().trim().max(300).optional(),
  head_sha: z.string().trim().max(64).optional(),
});
export type DriftInput = z.infer<typeof driftInputSchema>;

const LIST_KINDS = ["colors", "spacing", "radii", "shadows", "breakpoints"] as const;
type Kind = (typeof LIST_KINDS)[number];

/** Token names as code spells them (`--color-primary`, `$spacing-4`, `colors.brand.primary`) reduced to the stored form. */
export function tokenKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(--|\$|@)/, "")
    .replace(/^(theme[.-])?(colors?|colours?|clr|c|spacing|space|radii|radius|rounded|shadows?|box-shadow|breakpoints?|screens?|bp)[.-]/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Values in one form: lower case, no spaces, 3-digit hex expanded. */
export function valueKey(v: string): string {
  const s = v.trim().toLowerCase().replace(/\s+/g, " ").replace(/\s*([(),/])\s*/g, "$1");
  const hex = /^#([0-9a-f]{3,4})$/.exec(s);
  if (hex) return `#${hex[1]!.slice(0, 3).replace(/./g, (c) => c + c)}`;
  // Sizes: rem and px are the same thing at the default 16px root (0.25rem = 4px); 0 needs no unit.
  const size = /^(-?\d*\.?\d+)(px|rem)$/.exec(s);
  if (size) return `${Math.round(Number(size[1]) * (size[2] === "rem" ? 16 : 1) * 100) / 100}px`;
  return s === "0px" || s === "0rem" ? "0px" : s;
}

function rgb(v: string): [number, number, number] | null {
  const s = valueKey(v);
  const h = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
  if (h) return [parseInt(h[1]!.slice(0, 2), 16), parseInt(h[1]!.slice(2, 4), 16), parseInt(h[1]!.slice(4, 6), 16)];
  const m = /^rgba?\((\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** The palette colour closest to a hard-coded value (RGB distance), light or dark. */
function nearest(value: string, colors: NonNullable<Tokens["colors"]>) {
  const x = rgb(value);
  if (!x) return null;
  let best: { name: string; value: string; distance: number; mode: "light" | "dark" } | null = null;
  for (const c of colors)
    for (const [mode, v] of [["light", c.value], ["dark", c.dark]] as const) {
      const y = v ? rgb(v) : null;
      if (!y) continue;
      const d = Math.round(Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]));
      if (!best || d < best.distance) best = { name: c.name, value: v!, distance: d, mode };
    }
  return best;
}

/** Compares what the code defines with the recorded (effective) tokens. Pure, for tests and the CI script alike. */
export function compareDesign(stored: Tokens, input: DriftInput) {
  const changed: { kind: Kind | "fonts"; name: string; stored: string; code: string; mode?: "dark" }[] = [];
  const missing: { kind: Kind; name: string; stored: string }[] = [];
  const added: { kind: Kind; name: string; code: string }[] = [];
  for (const kind of LIST_KINDS) {
    const code = input.tokens[kind];
    if (!code) continue; // not reported: say nothing about it
    const have = new Map((stored[kind] ?? []).map((t) => [tokenKey(t.name), t as { name: string; value: string; dark?: string }]));
    const seen = new Set<string>();
    for (const c of code) {
      const key = tokenKey(c.name);
      seen.add(key);
      const s = have.get(key);
      if (!s) {
        added.push({ kind, name: c.name, code: c.value });
        continue;
      }
      if (valueKey(s.value) !== valueKey(c.value)) changed.push({ kind, name: s.name, stored: s.value, code: c.value });
      if (s.dark && c.dark && valueKey(s.dark) !== valueKey(c.dark)) changed.push({ kind, name: s.name, stored: s.dark, code: c.dark, mode: "dark" });
    }
    for (const [key, s] of have) if (!seen.has(key)) missing.push({ kind, name: s.name, stored: s.value });
  }
  if (input.tokens.fonts) {
    const have = new Map((stored.typography?.fonts ?? []).map((f) => [f.role.toLowerCase(), f.family]));
    const families = (fam: string) => fam.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "").toLowerCase());
    for (const f of input.tokens.fonts) {
      const s = have.get(f.role.toLowerCase());
      // The same font when the recorded first choice is anywhere in the code's stack ("Inter Variable", Inter, …).
      if (s && !families(f.family).includes(families(s)[0]!)) changed.push({ kind: "fonts", name: f.role, stored: s, code: f.family });
    }
  }
  const palette = stored.colors ?? [];
  const hardcoded = (input.hardcoded ?? []).map((h) => {
    const n = nearest(h.value, palette);
    const suggestion = !n
      ? "not a colour that can be compared"
      : n.distance === 0
        ? `use the ${n.name} token (var(--color-${tokenKey(n.name)}))`
        : n.distance <= 24
          ? `probably meant ${n.name} (${n.value}${n.mode === "dark" ? ", dark" : ""}); use the token`
          : "not in the palette: add it to the design system or use an existing colour";
    return { ...h, nearest: n, suggestion };
  });
  const offPalette = hardcoded.filter((h) => h.nearest && h.nearest.distance > 24).length;
  return {
    changed,
    missing_in_code: missing,
    new_in_code: added,
    hardcoded,
    counts: { changed: changed.length, missing_in_code: missing.length, new_in_code: added.length, hardcoded: hardcoded.length, off_palette: offPalette },
    differences: changed.length + missing.length + added.length + hardcoded.length,
  };
}

/** Compares, stores the report (keeping the last 20 per project) and returns it. Needs Propose in the project. */
export async function checkDesignDrift(ctx: RequestContext, slug: string, raw: unknown) {
  const input = driftInputSchema.parse(raw);
  const scope = await getReadableScope(ctx, slug);
  await assertCanPropose(ctx, scope.id);
  const system = await getDesignSystem(ctx, slug);
  if (!system.exists && !system.inherited_from.length)
    throw new ValidationError(`${scope.slug} has no design system yet: capture one first (the capture-design prompt, or update_design_system)`);
  const report = compareDesign(system.tokens, input);
  const row = (
    await ctx.db.query<{ id: string; checked_at: string }>(
      "INSERT INTO design_drift_reports (scope_id, report, differences, source, head_sha, checked_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, checked_at",
      [scope.id, JSON.stringify(report), report.differences, input.source ?? "", input.head_sha ?? null, ctx.actor.id],
    )
  ).rows[0]!;
  await ctx.db.query(
    "DELETE FROM design_drift_reports WHERE scope_id = $1 AND id NOT IN (SELECT id FROM design_drift_reports WHERE scope_id = $1 ORDER BY checked_at DESC LIMIT 20)",
    [scope.id],
  );
  emitChanged();
  return {
    project: scope.slug,
    id: row.id,
    checked_at: row.checked_at,
    in_sync: report.differences === 0,
    ...report,
    how:
      report.differences === 0
        ? "The code matches the design system."
        : "Fix the code (use the tokens instead of hard-coded colours) or, when the code is right, record the new values with update_design_system. Don't change either without your person agreeing.",
  };
}

/** The latest drift report for a project (null when none). */
export async function latestDrift(ctx: RequestContext, slug: string) {
  const scope = await getReadableScope(ctx, slug);
  const r = (
    await ctx.db.query<{ report: ReturnType<typeof compareDesign>; differences: number; source: string; head_sha: string | null; checked_at: string; by: string | null }>(
      `SELECT d.report, d.differences, d.source, d.head_sha, d.checked_at, coalesce(u.display_name, u.email, substr(u.subject, 9)) AS by
         FROM design_drift_reports d LEFT JOIN users u ON u.id = d.checked_by WHERE d.scope_id = $1 ORDER BY d.checked_at DESC LIMIT 1`,
      [scope.id],
    )
  ).rows[0];
  return r ? { ...r.report, differences: r.differences, source: r.source, head_sha: r.head_sha, checked_at: r.checked_at, checked_by: r.by } : null;
}

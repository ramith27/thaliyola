import { z } from "zod";
import { similarDecisions } from "./decisions.js";
import { withTx, type Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { newArticle } from "./direct.js";
import { emitChanged } from "./events.js";
import { canApprove, hasPermission, isAdmin, readableScopes } from "./permissions.js";
import { redact } from "./redaction.js";
import { getReadableScope, type Scope } from "./scopes.js";

/**
 * Design systems: the colours, type, spacing and rules an application's UI is built from, kept as
 * structured tokens so every session and project uses the same values. A scope (usually a project)
 * can be based on another scope's system (usually the Library's) and override parts of it by name.
 * Coding agents read the effective system with get_design_system; capture-design fills it from code.
 */

// ---- Token shapes ---------------------------------------------------------------------------------------

const COLOR = /^(#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([^()]{1,80}\)|var\(--[\w-]{1,60}\)|transparent|currentcolor)$/i;
const SIZE = /^(0|-?\d*\.?\d+(px|rem|em|%|vw|vh|pt|ch)?|clamp\([^()]{1,80}\)|calc\([^()]{1,80}\))$/i;
const name = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\w .\-/]+$/, "names use letters, digits, spaces, dots, dashes and slashes");
const note = z.string().trim().max(300).optional();

export const COLOR_ROLES = ["primary", "secondary", "accent", "background", "surface", "text", "muted", "border", "success", "warning", "danger", "info", "other"] as const;

const colorSchema = z.object({
  name,
  value: z.string().trim().regex(COLOR, "a colour is hex (#2a78d6), rgb(), hsl(), oklch() or var(--x)"),
  dark: z.string().trim().regex(COLOR, "a colour is hex (#2a78d6), rgb(), hsl(), oklch() or var(--x)").optional(),
  role: z.enum(COLOR_ROLES).optional(),
  usage: note,
});
const sizeSchema = z.object({ name, value: z.string().trim().regex(SIZE, "a size is like 16px, 1rem, 0.5em or clamp(...)"), usage: note });
const shadowSchema = z.object({ name, value: z.string().trim().min(1).max(200), usage: note });
const fontSchema = z.object({
  role: z.enum(["body", "heading", "mono", "display", "other"]),
  family: z.string().trim().min(1).max(200),
  weights: z.array(z.number().int().min(100).max(1000)).max(12).optional(),
  source: z.string().trim().max(300).optional(),
});
const typeStepSchema = z.object({
  name,
  size: z.string().trim().regex(SIZE, "a size is like 16px, 1rem, 0.5em or clamp(...)"),
  line_height: z.string().trim().max(20).optional(),
  weight: z.number().int().min(100).max(1000).optional(),
  font: z.enum(["body", "heading", "mono", "display", "other"]).optional(),
  usage: note,
});
const componentSchema = z.object({ name, description: z.string().trim().max(500).optional(), path: z.string().trim().max(300).optional(), status: z.enum(["stable", "beta", "deprecated"]).optional() });

export const tokensSchema = z
  .object({
    colors: z.array(colorSchema).max(200),
    typography: z.object({ fonts: z.array(fontSchema).max(10), scale: z.array(typeStepSchema).max(40) }).partial(),
    spacing: z.array(sizeSchema).max(60),
    radii: z.array(sizeSchema).max(30),
    shadows: z.array(shadowSchema).max(30),
    breakpoints: z.array(sizeSchema).max(20),
    components: z.array(componentSchema).max(300),
    icons: z.string().trim().max(300),
    voice: z.string().trim().max(1000),
    accessibility: z.string().trim().max(1000),
  })
  .partial()
  .strict();
export type Tokens = z.infer<typeof tokensSchema>;

const LISTS = ["colors", "spacing", "radii", "shadows", "breakpoints", "components"] as const;
const TEXTS = ["icons", "voice", "accessibility"] as const;

/** Merge by name: `over` wins for entries it names, keeps the rest of `base` in order, appends new ones. */
function mergeList<T extends { name?: string; role?: string }>(base: T[] = [], over: T[] = [], key: (t: T) => string) {
  const out = base.map((b) => over.find((o) => key(o) === key(b)) ?? b);
  for (const o of over) if (!base.some((b) => key(b) === key(o))) out.push(o);
  return out;
}
const byName = (t: { name?: string }) => (t.name ?? "").toLowerCase();

export function mergeTokens(base: Tokens, over: Tokens): Tokens {
  const out: Tokens = {};
  for (const k of LISTS) {
    const merged = mergeList((base[k] ?? []) as { name: string }[], (over[k] ?? []) as { name: string }[], byName);
    if (merged.length) (out as Record<string, unknown>)[k] = merged;
  }
  const fonts = mergeList(base.typography?.fonts ?? [], over.typography?.fonts ?? [], (f) => f.role);
  const scale = mergeList(base.typography?.scale ?? [], over.typography?.scale ?? [], byName);
  if (fonts.length || scale.length) out.typography = { ...(fonts.length ? { fonts } : {}), ...(scale.length ? { scale } : {}) };
  for (const k of TEXTS) if (over[k] ?? base[k]) out[k] = over[k] ?? base[k];
  return out;
}

function removeNames(t: Tokens, remove: Partial<Record<(typeof LISTS)[number] | "fonts" | "scale", string[]>>): Tokens {
  const out: Tokens = JSON.parse(JSON.stringify(t));
  for (const k of LISTS) {
    const drop = new Set((remove[k] ?? []).map((n) => n.toLowerCase()));
    if (drop.size && out[k]) (out as Record<string, unknown>)[k] = (out[k] as { name: string }[]).filter((x) => !drop.has(x.name.toLowerCase()));
  }
  if (out.typography) {
    const fonts = new Set((remove.fonts ?? []).map((n) => n.toLowerCase()));
    const scale = new Set((remove.scale ?? []).map((n) => n.toLowerCase()));
    if (fonts.size && out.typography.fonts) out.typography.fonts = out.typography.fonts.filter((f) => !fonts.has(f.role));
    if (scale.size && out.typography.scale) out.typography.scale = out.typography.scale.filter((s) => !scale.has(s.name.toLowerCase()));
  }
  return out;
}

// ---- Contrast (WCAG 2.x) ----------------------------------------------------------------------------------

function hexRgb(v: string): [number, number, number] | null {
  let h = v.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3,8}$/i.test(h)) return null;
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).replace(/./g, (c) => c + c);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function rgbOf(v: string): [number, number, number] | null {
  const hex = hexRgb(v);
  if (hex) return hex;
  const m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/i.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
const lum = ([r, g, b]: [number, number, number]) => {
  const c = [r, g, b].map((x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
/** Contrast ratio between two colours (hex or rgb only), or null. */
export function contrast(a: string, b: string): number | null {
  const x = rgbOf(a);
  const y = rgbOf(b);
  if (!x || !y) return null;
  const [l1, l2] = [lum(x), lum(y)].sort((p, q) => q - p) as [number, number];
  return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
}

/** Text-like colours against the background, light and dark: where the palette fails WCAG AA (4.5:1). */
export function contrastChecks(t: Tokens) {
  const colors = t.colors ?? [];
  const bg = colors.find((c) => c.role === "background") ?? colors.find((c) => c.role === "surface");
  if (!bg) return [];
  const out: { name: string; mode: "light" | "dark"; ratio: number; passes: boolean }[] = [];
  for (const c of colors.filter((x) => x.role && ["text", "muted", "primary", "danger", "success", "warning", "info", "accent"].includes(x.role))) {
    const light = contrast(c.value, bg.value);
    if (light !== null) out.push({ name: c.name, mode: "light", ratio: light, passes: light >= 4.5 });
    if (c.dark && bg.dark) {
      const dark = contrast(c.dark, bg.dark);
      if (dark !== null) out.push({ name: c.name, mode: "dark", ratio: dark, passes: dark >= 4.5 });
    }
  }
  return out;
}

// ---- Exports -------------------------------------------------------------------------------------------------

const varName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function exportTokens(t: Tokens, format: "css" | "tailwind" | "json" | "w3c"): { mime: string; ext: string; text: string } {
  if (format === "json") return { mime: "application/json", ext: "json", text: JSON.stringify(t, null, 2) };
  const colors = t.colors ?? [];
  const fonts = t.typography?.fonts ?? [];
  const scale = t.typography?.scale ?? [];
  if (format === "css") {
    const lines = [":root {"];
    for (const c of colors) lines.push(`  --color-${varName(c.name)}: ${c.value};`);
    for (const f of fonts) lines.push(`  --font-${f.role}: ${f.family};`);
    for (const s of scale) lines.push(`  --text-${varName(s.name)}: ${s.size};${s.line_height ? ` /* line-height ${s.line_height} */` : ""}`);
    for (const s of t.spacing ?? []) lines.push(`  --space-${varName(s.name)}: ${s.value};`);
    for (const s of t.radii ?? []) lines.push(`  --radius-${varName(s.name)}: ${s.value};`);
    for (const s of t.shadows ?? []) lines.push(`  --shadow-${varName(s.name)}: ${s.value};`);
    lines.push("}");
    const dark = colors.filter((c) => c.dark);
    if (dark.length) {
      lines.push("", "@media (prefers-color-scheme: dark) {", "  :root {");
      for (const c of dark) lines.push(`    --color-${varName(c.name)}: ${c.dark};`);
      lines.push("  }", "}");
    }
    return { mime: "text/css", ext: "css", text: lines.join("\n") + "\n" };
  }
  if (format === "tailwind") {
    const obj = (entries: [string, unknown][]) => Object.fromEntries(entries);
    const theme = {
      colors: obj(colors.map((c) => [varName(c.name), `var(--color-${varName(c.name)}, ${c.value})`])),
      fontFamily: obj(fonts.map((f) => [f.role === "body" ? "sans" : f.role, f.family.split(",").map((x) => x.trim().replace(/^["']|["']$/g, ""))])),
      fontSize: obj(scale.map((s) => [varName(s.name), s.line_height ? [s.size, { lineHeight: s.line_height }] : s.size])),
      spacing: obj((t.spacing ?? []).map((s) => [varName(s.name), s.value])),
      borderRadius: obj((t.radii ?? []).map((s) => [varName(s.name), s.value])),
      boxShadow: obj((t.shadows ?? []).map((s) => [varName(s.name), s.value])),
      screens: obj((t.breakpoints ?? []).map((s) => [varName(s.name), s.value])),
    };
    const extend = Object.fromEntries(Object.entries(theme).filter(([, v]) => Object.keys(v as object).length));
    return { mime: "text/javascript", ext: "js", text: `// Generated by Thaliyola from the design system\nexport default {\n  theme: {\n    extend: ${JSON.stringify(extend, null, 2).replace(/\n/g, "\n    ")},\n  },\n};\n` };
  }
  // W3C Design Tokens Community Group format.
  const group = (items: { name: string; value: string }[], type: string) => Object.fromEntries(items.map((i) => [varName(i.name), { $value: i.value, $type: type }]));
  const w3c: Record<string, unknown> = {};
  if (colors.length) w3c.color = Object.fromEntries(colors.map((c) => [varName(c.name), { $value: c.value, $type: "color", ...(c.usage ? { $description: c.usage } : {}), ...(c.dark ? { $extensions: { "mode.dark": c.dark } } : {}) }]));
  if (fonts.length) w3c.font = Object.fromEntries(fonts.map((f) => [f.role, { $value: f.family, $type: "fontFamily" }]));
  if (scale.length) w3c.fontSize = Object.fromEntries(scale.map((s) => [varName(s.name), { $value: s.size, $type: "dimension" }]));
  if (t.spacing?.length) w3c.spacing = group(t.spacing, "dimension");
  if (t.radii?.length) w3c.radius = group(t.radii, "dimension");
  if (t.shadows?.length) w3c.shadow = group(t.shadows, "shadow");
  return { mime: "application/json", ext: "tokens.json", text: JSON.stringify(w3c, null, 2) };
}

// ---- Reading -------------------------------------------------------------------------------------------------

interface Row {
  scope_id: string;
  based_on: string | null;
  tokens: Tokens;
  principles: string;
  source: string | null;
  version: number;
  updated_by: string | null;
  updated_at: string;
}

const rowOf = async (db: Queryable, scopeId: string) => (await db.query<Row>("SELECT * FROM design_systems WHERE scope_id = $1", [scopeId])).rows[0];

/** The chain of systems a scope's design comes from, nearest first (cycles cut, at most 5 deep). */
async function chain(db: Queryable, scopeId: string) {
  const out: Row[] = [];
  const seen = new Set<string>();
  let id: string | null = scopeId;
  while (id && !seen.has(id) && out.length < 5) {
    seen.add(id);
    const r = await rowOf(db, id);
    if (!r) break;
    out.push(r);
    id = r.based_on;
  }
  return out;
}

async function canEdit(ctx: RequestContext, scope: Scope) {
  if (isAdmin(ctx)) return true;
  // Team and Library systems are shared by everyone: those who review there keep them. Projects: anyone whose roles
  // there (direct, through a team, or from a project above) include Propose: Contributors and up, or a custom role.
  if (scope.kind !== "project") return canApprove(ctx, scope.id);
  return hasPermission(ctx, scope.id, "propose");
}

export async function getDesignSystem(ctx: RequestContext, slug: string, opts: { format?: "css" | "tailwind" | "json" | "w3c" } = {}) {
  const scope = await getReadableScope(ctx, slug);
  const links = await chain(ctx.db, scope.id);
  const own = links[0]?.scope_id === scope.id ? links[0] : undefined;
  // Effective = the farthest base first, each nearer system overriding by name.
  const effective = [...links].reverse().reduce<Tokens>((acc, r) => mergeTokens(acc, r.tokens ?? {}), {});
  const readable = await readableScopes(ctx);
  const names = new Map(
    (await ctx.db.query<{ id: string; slug: string; name: string }>("SELECT id, slug, name FROM scopes WHERE id = ANY($1)", [links.map((l) => l.scope_id).concat(own?.based_on ? [own.based_on] : [])])).rows.map((r) => [r.id, r]),
  );
  const decisions = (
    await ctx.db.query(
      `SELECT a.id, a.title, a.type, a.status, a.updated_at, left(btrim(regexp_replace(regexp_replace(regexp_replace(a.body_md, '^#{1,6} [^\\n]*$', '', 'gn'), '_To write:[^_]*_|_Not recorded\\._', '', 'g'), '\\s+', ' ', 'g')), 220) AS excerpt
         FROM articles a WHERE a.scope_id = ANY($1) AND a.status IN ('published', 'possibly_stale', 'draft')
          AND (a.type IN ('design_tokens', 'ui_component', 'ux_pattern', 'screen_spec') OR (a.type IN ('decision', 'design_doc') AND ('design' = ANY(a.tags) OR a.path ILIKE 'design%')))
          AND ($2::uuid[] IS NULL OR a.scope_id = ANY($2))
        ORDER BY a.type = 'decision' DESC, a.updated_at DESC LIMIT 60`,
      [links.length ? links.map((l) => l.scope_id) : [scope.id], readable],
    )
  ).rows;
  const usedBy = (
    await ctx.db.query<{ slug: string; name: string }>(
      "SELECT s.slug, s.name FROM design_systems d JOIN scopes s ON s.id = d.scope_id WHERE d.based_on = $1 AND s.status = 'active' AND ($2::uuid[] IS NULL OR s.id = ANY($2)) ORDER BY s.name",
      [scope.id, readable],
    )
  ).rows;
  const base = own?.based_on ? names.get(own.based_on) : undefined;
  return {
    scope: scope.slug,
    name: scope.name,
    exists: !!own,
    based_on: base ? { slug: base.slug, name: base.name } : null,
    inherited_from: links.slice(own ? 1 : 0).map((l) => names.get(l.scope_id)?.slug).filter(Boolean),
    tokens: effective,
    own_tokens: own?.tokens ?? {},
    principles: links.map((l) => l.principles).filter(Boolean).join("\n\n"),
    own_principles: own?.principles ?? "",
    contrast: contrastChecks(effective),
    decisions,
    used_by: usedBy,
    version: own?.version ?? 0,
    source: own?.source ?? null,
    updated_at: own?.updated_at ?? null,
    can_edit: await canEdit(ctx, scope),
    ...(opts.format ? { export: exportTokens(effective, opts.format).text } : {}),
  };
}

/** Scopes with a design system the caller can read (for "based on" and the Library catalog). */
export async function listDesignSystems(ctx: RequestContext) {
  const readable = await readableScopes(ctx);
  const { rows } = await ctx.db.query(
    `SELECT s.slug, s.name, s.kind, d.version, d.updated_at, jsonb_array_length(coalesce(d.tokens->'colors', '[]'::jsonb)) AS colors, b.slug AS based_on
       FROM design_systems d JOIN scopes s ON s.id = d.scope_id LEFT JOIN scopes b ON b.id = d.based_on
      WHERE s.status = 'active' AND ($1::uuid[] IS NULL OR s.id = ANY($1))
      ORDER BY s.kind = 'library' DESC, s.kind = 'team' DESC, s.name`,
    [readable],
  );
  return { systems: rows };
}

/** Short version for get_project_context: enough for a coding agent to style consistently. */
export async function designSummary(ctx: RequestContext, slug: string) {
  const d = await getDesignSystem(ctx, slug);
  const t = d.tokens;
  if (!t.colors?.length && !t.typography?.fonts?.length && !d.decisions.length) return null;
  return {
    colors: (t.colors ?? []).slice(0, 16).map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}: ${c.value}${c.dark ? ` / dark ${c.dark}` : ""}`),
    fonts: (t.typography?.fonts ?? []).map((f) => `${f.role}: ${f.family}`),
    based_on: d.based_on?.slug ?? null,
    design_decisions: d.decisions.filter((x: { type: string }) => x.type === "decision").slice(0, 8).map((x: { id: string; title: string }) => ({ id: x.id, title: x.title })),
    hint: "Use these tokens rather than new values; get_design_system has the full system (spacing, type scale, components, rules) and exports as CSS or Tailwind.",
    ...(await driftLine(ctx, slug)),
  };
}

/** The latest drift check, in one line for the project context. */
async function driftLine(ctx: RequestContext, slug: string) {
  const r = (
    await ctx.db.query<{ differences: number; counts: Record<string, number>; checked_at: Date }>(
      `SELECT d.differences, d.report->'counts' AS counts, d.checked_at FROM design_drift_reports d JOIN scopes s ON s.id = d.scope_id
        WHERE s.slug = $1 ORDER BY d.checked_at DESC LIMIT 1`,
      [slug],
    )
  ).rows[0];
  if (!r) return {};
  const c = r.counts ?? {};
  const day = new Date(r.checked_at).toISOString().slice(0, 10);
  return {
    drift:
      r.differences === 0
        ? `The code matched the design system at the last check (${day}).`
        : `Last check (${day}): ${c.changed ?? 0} values differ from the code, ${c.hardcoded ?? 0} hard-coded colours (${c.off_palette ?? 0} off the palette). Don't add more; check_design_drift has details.`,
  };
}

// ---- Writing --------------------------------------------------------------------------------------------------

export async function updateDesignSystem(
  ctx: RequestContext,
  slug: string,
  input: {
    tokens?: unknown;
    replace?: boolean;
    remove?: Partial<Record<(typeof LISTS)[number] | "fonts" | "scale", string[]>>;
    principles?: string;
    based_on?: string | null;
    source?: string;
    note?: string;
  },
) {
  const scope = await getReadableScope(ctx, slug);
  if (!(await canEdit(ctx, scope))) throw new ForbiddenError(scope.kind === "project" ? "none of your roles here include Propose, so you can't edit the project's design (Contributors, Reviewers, Moderators and Project admins can)" : `those who review in ${scope.name}, and Administrators, edit its design`);
  const parsed = input.tokens === undefined ? undefined : tokensSchema.safeParse(input.tokens);
  if (parsed && !parsed.success) throw new ValidationError(`tokens: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  let basedOn: string | null | undefined;
  if (input.based_on === null || input.based_on === "") basedOn = null;
  else if (input.based_on) {
    const base = await getReadableScope(ctx, input.based_on);
    if (base.id === scope.id) throw new ValidationError("a design system can't be based on itself");
    if ((await chain(ctx.db, base.id)).some((l) => l.scope_id === scope.id)) throw new ValidationError(`${base.slug} is already based on ${scope.slug}`);
    basedOn = base.id;
  }
  const principles = input.principles === undefined ? undefined : redact(input.principles).text.slice(0, 20_000);
  return withTx(ctx.db, async (db) => {
    const cur = (await db.query<Row>("SELECT * FROM design_systems WHERE scope_id = $1 FOR UPDATE", [scope.id])).rows[0];
    let tokens: Tokens = cur?.tokens ?? {};
    if (parsed) tokens = input.replace ? parsed.data : mergeTokens(tokens, parsed.data);
    if (input.remove) tokens = removeNames(tokens, input.remove);
    const next = {
      tokens,
      principles: principles ?? cur?.principles ?? "",
      based_on: basedOn === undefined ? (cur?.based_on ?? null) : basedOn,
      source: input.source?.slice(0, 300) ?? cur?.source ?? null,
    };
    const version = (cur?.version ?? 0) + 1;
    await db.query(
      `INSERT INTO design_systems (scope_id, based_on, tokens, principles, source, version, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (scope_id) DO UPDATE SET based_on = EXCLUDED.based_on, tokens = EXCLUDED.tokens, principles = EXCLUDED.principles, source = EXCLUDED.source,
         version = EXCLUDED.version, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [scope.id, next.based_on, JSON.stringify(next.tokens), next.principles, next.source, version, ctx.actor.id],
    );
    await db.query(
      "INSERT INTO design_system_versions (scope_id, version, tokens, principles, based_on, source, note, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [scope.id, version, JSON.stringify(next.tokens), next.principles, next.based_on, next.source, input.note?.slice(0, 300) ?? null, ctx.actor.id],
    );
    await audit(db, ctx.actor.id, "update_design_system", scope.id);
    emitChanged();
    return { scope: scope.slug, version, colors: next.tokens.colors?.length ?? 0, contrast_failures: contrastChecks(next.tokens).filter((c) => !c.passes) };
  });
}

export async function designVersions(ctx: RequestContext, slug: string) {
  const scope = await getReadableScope(ctx, slug);
  const { rows } = await ctx.db.query(
    `SELECT v.version, v.note, v.source, v.updated_at, coalesce(u.display_name, u.email, u.subject) AS by, jsonb_array_length(coalesce(v.tokens->'colors', '[]'::jsonb)) AS colors
       FROM design_system_versions v LEFT JOIN users u ON u.id = v.updated_by WHERE v.scope_id = $1 ORDER BY v.version DESC LIMIT 50`,
    [scope.id],
  );
  return { scope: scope.slug, versions: rows };
}

export async function restoreDesignVersion(ctx: RequestContext, slug: string, version: number) {
  const scope = await getReadableScope(ctx, slug);
  const v = (await ctx.db.query<{ tokens: Tokens; principles: string; based_on: string | null }>("SELECT tokens, principles, based_on FROM design_system_versions WHERE scope_id = $1 AND version = $2", [scope.id, version])).rows[0];
  if (!v) throw new NotFoundError(`version ${version} of ${scope.slug}'s design system`);
  const base = v.based_on ? (await ctx.db.query<{ slug: string }>("SELECT slug FROM scopes WHERE id = $1", [v.based_on])).rows[0]?.slug : null;
  return updateDesignSystem(ctx, slug, { tokens: v.tokens, replace: true, principles: v.principles, based_on: base ?? null, note: `Restored version ${version}` });
}

/** A design decision: an ordinary decision article tagged "design", published at once for those who may publish directly, reviewed for others. */
export async function recordDesignDecision(
  ctx: RequestContext,
  input: { project: string; title: string; context: string; options?: string; choice: string; consequences?: string },
) {
  const scope = await getReadableScope(ctx, input.project);
  const body = [
    `## Context\n\n${input.context.trim()}`,
    `## Options considered\n\n${input.options?.trim() || "_Not recorded._"}`,
    `## Choice\n\n${input.choice.trim()}`,
    `## Consequences\n\n${input.consequences?.trim() || "_Not recorded._"}`,
  ].join("\n\n");
  const similar = await similarDecisions(ctx, scope.id, input.choice).catch(() => []);
  const r = await newArticle(ctx, { scope: scope.slug, type: "decision", title: input.title.trim().slice(0, 200), body_md: body, path: "Design decisions", tags: ["design"] });
  if (similar.length) Object.assign(r as object, { similar_decisions: similar, check: "Decisions like this one exist: if the new one replaces one, link it with supersedes (or say how they differ)." });
  emitChanged();
  return r;
}

import { withTx } from "../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";

/**
 * Saved views: a person's named filter sets on a list page. Each person sees and changes only their own; one per page
 * can be the default, which the page opens with when its link carries no filters. Filters are the page's URL query
 * values, limited to the keys that page filters on.
 */

/** The filter keys each page saves (its URL query keys; tabs, selections and cursors are not part of a view). */
export const VIEW_AREAS = {
  review: ["state", "category", "scope", "type", "author", "assigned", "q", "sort", "group"],
  inbox: ["status", "scope", "source"],
  security: ["project", "severity", "status", "kev", "fixable", "repository", "q", "sort"],
  projects: ["show", "q", "sort", "dir"],
} as const satisfies Record<string, readonly string[]>;

export type ViewArea = keyof typeof VIEW_AREAS;
export const VIEW_AREA_NAMES = Object.keys(VIEW_AREAS) as [ViewArea, ...ViewArea[]];

/** Views one person may keep per page. */
export const MAX_VIEWS_PER_AREA = 50;
const MAX_VALUE = 300;

export interface SavedView {
  id: string;
  area: ViewArea;
  name: string;
  filters: Record<string, string>;
  is_default: boolean;
  updated_at: string;
}

function assertPerson(ctx: RequestContext) {
  // Views belong to the web UI's list pages; service accounts have no pages to open them on.
  if (ctx.actor.kind !== "human") throw new ForbiddenError("saved views are for people signed in to the web app");
}

function cleanName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  if (!n) throw new ValidationError("give the view a name");
  if (n.length > 60) throw new ValidationError("a view's name is at most 60 characters");
  return n;
}

/** Keeps the page's own filter keys, drops empty values, and refuses anything else. */
function cleanFilters(area: ViewArea, filters: Record<string, unknown>): Record<string, string> {
  const allowed: readonly string[] = VIEW_AREAS[area];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (!allowed.includes(k)) throw new ValidationError(`'${k}' is not a filter on this page (use ${allowed.join(", ")})`);
    if (v === null || v === undefined || v === "") continue;
    if (typeof v !== "string") throw new ValidationError(`filter '${k}' must be text`);
    if (v.length > MAX_VALUE) throw new ValidationError(`filter '${k}' is too long`);
    out[k] = v;
  }
  return out;
}

const COLUMNS = "id, area, name, filters, is_default, updated_at";

/** Your saved views on one page, by name. */
export async function listViews(ctx: RequestContext, area: ViewArea): Promise<{ area: ViewArea; views: SavedView[] }> {
  assertPerson(ctx);
  const { rows } = await ctx.db.query<SavedView>(`SELECT ${COLUMNS} FROM saved_views WHERE user_id = $1 AND area = $2 ORDER BY lower(name)`, [ctx.actor.id, area]);
  return { area, views: rows };
}

async function own(ctx: RequestContext, id: string): Promise<SavedView> {
  const row = (await ctx.db.query<SavedView>(`SELECT ${COLUMNS} FROM saved_views WHERE id = $1 AND user_id = $2`, [id, ctx.actor.id])).rows[0];
  // Someone else's view is reported as missing, so ids reveal nothing.
  if (!row) throw new NotFoundError("saved view");
  return row;
}

function uniqueName(err: unknown, name: string): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "saved_views_name") throw new ValidationError(`you already have a view called “${name}” here`);
  // Two default changes at once: the database keeps one; the other is asked to try again.
  if (e.code === "23505" && e.constraint === "saved_views_one_default") throw new ConflictError("another default was just set for this page; try again", null);
  throw err;
}

/** Saves the filters as a named view (optionally your default for the page). */
export async function createView(ctx: RequestContext, input: { area: ViewArea; name: string; filters: Record<string, unknown>; is_default?: boolean }): Promise<SavedView> {
  assertPerson(ctx);
  const name = cleanName(input.name);
  const filters = cleanFilters(input.area, input.filters);
  return withTx(ctx.db, async (tx) => {
    // Serialise one person's writes to a page so the cap holds.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`views:${ctx.actor.id}:${input.area}`]);
    const n = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM saved_views WHERE user_id = $1 AND area = $2", [ctx.actor.id, input.area])).rows[0]!.n;
    if (n >= MAX_VIEWS_PER_AREA) throw new ValidationError(`you can keep up to ${MAX_VIEWS_PER_AREA} views on a page; delete one first`);
    if (input.is_default) await tx.query("UPDATE saved_views SET is_default = false WHERE user_id = $1 AND area = $2 AND is_default", [ctx.actor.id, input.area]);
    try {
      return (
        await tx.query<SavedView>(`INSERT INTO saved_views (user_id, area, name, filters, is_default) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`, [
          ctx.actor.id,
          input.area,
          name,
          JSON.stringify(filters),
          !!input.is_default,
        ])
      ).rows[0]!;
    } catch (err) {
      uniqueName(err, name);
    }
  });
}

/** Renames a view, replaces its filters, or makes it (or stops it being) the page's default. */
export async function updateView(ctx: RequestContext, id: string, patch: { name?: string; filters?: Record<string, unknown>; is_default?: boolean }): Promise<SavedView> {
  assertPerson(ctx);
  const view = await own(ctx, id);
  const name = patch.name === undefined ? view.name : cleanName(patch.name);
  const filters = patch.filters === undefined ? view.filters : cleanFilters(view.area, patch.filters);
  const isDefault = patch.is_default ?? view.is_default;
  return withTx(ctx.db, async (tx) => {
    if (isDefault && !view.is_default) await tx.query("UPDATE saved_views SET is_default = false WHERE user_id = $1 AND area = $2 AND is_default", [ctx.actor.id, view.area]);
    try {
      return (
        await tx.query<SavedView>(
          `UPDATE saved_views SET name = $3, filters = $4, is_default = $5, updated_at = now() WHERE id = $1 AND user_id = $2 RETURNING ${COLUMNS}`,
          [id, ctx.actor.id, name, JSON.stringify(filters), isDefault],
        )
      ).rows[0]!;
    } catch (err) {
      uniqueName(err, name);
    }
  });
}

export async function deleteView(ctx: RequestContext, id: string): Promise<{ deleted: true; id: string }> {
  assertPerson(ctx);
  await own(ctx, id);
  await ctx.db.query("DELETE FROM saved_views WHERE id = $1 AND user_id = $2", [id, ctx.actor.id]);
  return { deleted: true, id };
}

/**
 * Manage views: renames, deletes and the page's default, applied together in one transaction (so swapping two names,
 * or renaming one to a name another delete or rename frees, works, and a failure changes nothing). `default`: a view
 * id, null for none, or left out to keep it.
 */
export async function saveViews(
  ctx: RequestContext,
  area: ViewArea,
  input: { rename?: { id: string; name: string }[]; delete?: string[]; default?: string | null },
): Promise<{ area: ViewArea; views: SavedView[] }> {
  assertPerson(ctx);
  const renames = new Map<string, string>();
  for (const r of input.rename ?? []) {
    if (renames.has(r.id)) throw new ValidationError("each view can be renamed once per save");
    renames.set(r.id, cleanName(r.name));
  }
  const deletes = new Set(input.delete ?? []);
  for (const id of deletes) if (renames.has(id)) throw new ValidationError("a view can't be renamed and deleted in the same save");
  if (input.default && deletes.has(input.default)) throw new ValidationError("a deleted view can't be the default");

  await withTx(ctx.db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`views:${ctx.actor.id}:${area}`]);
    const mine = (await tx.query<{ id: string; name: string }>("SELECT id, name FROM saved_views WHERE user_id = $1 AND area = $2", [ctx.actor.id, area])).rows;
    const ids = new Set(mine.map((v) => v.id));
    // Someone else's view (or one on another page) is reported as missing, so ids reveal nothing.
    for (const id of [...renames.keys(), ...deletes, ...(input.default ? [input.default] : [])]) if (!ids.has(id)) throw new NotFoundError("saved view");

    // The names once everything is applied must be unique on the page.
    const seen = new Set<string>();
    for (const v of mine) {
      if (deletes.has(v.id)) continue;
      const name = renames.get(v.id) ?? v.name;
      if (seen.has(name.toLowerCase())) throw new ValidationError(`you already have a view called “${name}” here`);
      seen.add(name.toLowerCase());
    }

    if (deletes.size) await tx.query("DELETE FROM saved_views WHERE user_id = $1 AND id = ANY($2::uuid[])", [ctx.actor.id, [...deletes]]);
    const changed = [...renames].filter(([id, name]) => mine.find((v) => v.id === id)!.name !== name);
    // Park renamed views on a name nobody types (their own id), then give them their new names: a swap never collides.
    if (changed.length) {
      const changedIds = changed.map(([id]) => id);
      await tx.query("UPDATE saved_views SET name = '~' || id::text WHERE user_id = $1 AND id = ANY($2::uuid[])", [ctx.actor.id, changedIds]);
      await tx.query(
        `UPDATE saved_views v SET name = n.name, updated_at = now()
           FROM unnest($2::uuid[], $3::text[]) AS n(id, name)
          WHERE v.user_id = $1 AND v.id = n.id`,
        [ctx.actor.id, changedIds, changed.map(([, name]) => name)],
      );
    }
    if (input.default !== undefined) {
      await tx.query("UPDATE saved_views SET is_default = false WHERE user_id = $1 AND area = $2 AND is_default AND id IS DISTINCT FROM $3::uuid", [
        ctx.actor.id,
        area,
        input.default,
      ]);
      if (input.default) await tx.query("UPDATE saved_views SET is_default = true WHERE user_id = $1 AND id = $2 AND NOT is_default", [ctx.actor.id, input.default]);
    }
  }).catch((err) => uniqueName(err, "that name"));
  return listViews(ctx, area);
}

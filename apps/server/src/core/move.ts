import { withTx } from "../db/pool.js";
import { audit } from "./audit.js";
import { createComponent } from "./bootstrap.js";
import { ValidationError, type RequestContext } from "./context.js";
import { assertCanApprove, assertCanManage } from "./permissions.js";
import { getScopeBySlug } from "./scopes.js";

/**
 * Moves articles (a whole folder, or chosen items) and findings from one
 * scope to another, e.g. project docs that were filed under "Projects/X" in
 * the team space into project X, where its own members and settings apply.
 * Items keep their ids, history and links. Needs approval rights in both
 * scopes. Optionally the folder prefix is dropped, and first-level
 * sub-folders that are really repositories become the project's components.
 */

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "repo";

export interface MoveInput {
  from: string;
  to: string;
  /** Move every article in this folder (and its sub-folders). */
  folder?: string;
  /** Or these articles and findings. */
  ids?: string[];
  /** Drop the folder prefix from moved articles' paths ("Projects/X/api" → "api"). Default true for folder moves. */
  strip_folder?: boolean;
  /** First-level sub-folders (after stripping) that are really repositories: each becomes a component and tags its items. */
  repo_folders?: string[];
  dry_run?: boolean;
  /** Preview only: the destination is a project that will be created first (`to` doesn't exist yet). */
  new_project?: boolean;
}

export async function moveItems(ctx: RequestContext, input: MoveInput) {
  const from = await getScopeBySlug(ctx.db, input.from);
  await assertCanApprove(ctx, from.id);
  if (input.new_project && !input.dry_run) throw new ValidationError("create the project first, then move");
  const to = input.new_project ? { id: "", kind: "project", slug: input.to } : await getScopeBySlug(ctx.db, input.to);
  if (from.id === to.id) throw new ValidationError("pick a different destination");
  if (!input.new_project) await assertCanApprove(ctx, to.id);
  const repoFolders = new Set(input.repo_folders ?? []);
  if (repoFolders.size) {
    if (to.kind !== "project") throw new ValidationError("only projects have repositories");
    if (!input.new_project) await assertCanManage(ctx, to);
  }
  const folder = input.folder?.trim().replace(/^\/+|\/+$/g, "") ?? "";
  if (!folder && !input.ids?.length) throw new ValidationError("give a folder or the items to move");

  const articles = await ctx.db.query<{ id: string; title: string; path: string; status: string }>(
    `SELECT id, title, path, status FROM articles
      WHERE scope_id = $1 AND (($2 <> '' AND (path = $2 OR path LIKE $2 || '/%')) OR id = ANY($3::uuid[]))
      ORDER BY path, title`,
    [from.id, folder, input.ids ?? []],
  );
  const findings = await ctx.db.query<{ id: string; title: string }>("SELECT id, title FROM findings WHERE scope_id = $1 AND id = ANY($2::uuid[])", [from.id, input.ids ?? []]);
  const strip = input.strip_folder ?? !!folder;

  const plan = articles.rows.map((a) => {
    let path = a.path ?? "";
    if (strip && folder && (path === folder || path.startsWith(`${folder}/`))) path = path.slice(folder.length).replace(/^\/+/, "");
    let component: string | null = null;
    const [first, ...rest] = path.split("/");
    if (first && repoFolders.has(first)) {
      component = slugify(first);
      path = rest.join("/");
    }
    return { id: a.id, title: a.title, from_path: a.path, to_path: path, component };
  });
  const components = [...new Set(plan.map((p) => p.component).filter((c): c is string => !!c))];
  // First-level sub-folders after stripping: the candidates for repositories.
  const subfolders = [
    ...new Set(
      articles.rows
        .map((a) => (strip && folder ? (a.path ?? "").slice(folder.length).replace(/^\/+/, "") : (a.path ?? "")).split("/")[0])
        .filter((f): f is string => !!f),
    ),
  ].sort();
  const summary = { from: from.slug, to: to.slug, articles: plan, findings: findings.rows, new_components: components, subfolders };
  if (input.dry_run) return { dry_run: true, moved: 0, ...summary };
  if (!plan.length && !findings.rows.length) throw new ValidationError("nothing to move");

  await withTx(ctx.db, async (db) => {
    const componentIds: Record<string, string> = {};
    for (const slug of components) {
      const existing = await db.query<{ id: string }>("SELECT id FROM components WHERE scope_id = $1 AND slug = $2", [to.id, slug]);
      componentIds[slug] = existing.rows[0]?.id ?? (await createComponent(db, to.id, slug, "other"));
    }
    const ids = [...plan.map((p) => p.id), ...findings.rows.map((f) => f.id)];
    for (const p of plan) {
      // Components belong to one project, so tags from the old scope can't come along.
      await db.query("UPDATE articles SET scope_id = $2, path = $3, component_ids = $4 WHERE id = $1", [p.id, to.id, p.to_path, p.component ? [componentIds[p.component]] : []]);
    }
    if (findings.rows.length) await db.query("UPDATE findings SET scope_id = $2, component_ids = '{}' WHERE id = ANY($1::uuid[])", [findings.rows.map((f) => f.id), to.id]);
    await db.query("UPDATE chunks SET scope_id = $2 WHERE parent_id = ANY($1::uuid[])", [ids, to.id]);
    await db.query("UPDATE assets SET scope_id = $2 WHERE target_id = ANY($1::uuid[])", [ids, to.id]);
    // Open proposals follow their item, so the new scope's owners review them.
    await db.query("UPDATE revisions SET scope_id = $2 WHERE target_id = ANY($1::uuid[]) AND state = 'pending' AND op <> 'share'", [ids, to.id]);
    for (const id of ids) await audit(db, ctx.actor.id, "move_item", id);
  });
  ctx.onWrite?.();
  return { dry_run: false, moved: plan.length + findings.rows.length, ...summary };
}

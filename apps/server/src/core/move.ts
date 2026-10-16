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
 * sub-folders that are really repositories become the project's components
 * (their pages keep the folder and are tagged with the repository).
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
  /** Where in the destination the items go: a folder ("Runbooks", "api/Domains"); empty or omitted means the top level. */
  into_folder?: string;
  /** First-level sub-folders (after stripping) that are really repositories: each becomes a component and tags its items. */
  repo_folders?: string[];
  /** Tag everything moved with this repository of the destination ("" clears tags); findings use this to sit with a repository. */
  component?: string;
  dry_run?: boolean;
  /** Preview only: the destination is a project that will be created first (`to` doesn't exist yet). */
  new_project?: boolean;
}

const cleanPath = (p: string | undefined) =>
  (p ?? "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)
    .join("/");

export async function moveItems(ctx: RequestContext, input: MoveInput) {
  const from = await getScopeBySlug(ctx.db, input.from);
  await assertCanApprove(ctx, from.id);
  if (input.new_project && !input.dry_run) throw new ValidationError("create the project first, then move");
  const to = input.new_project ? { id: "", kind: "project", slug: input.to } : await getScopeBySlug(ctx.db, input.to);
  const sameScope = from.id === to.id;
  if (!input.new_project && !sameScope) await assertCanApprove(ctx, to.id);
  const repoFolders = new Set(input.repo_folders ?? []);
  if (repoFolders.size || input.component) {
    if (to.kind !== "project") throw new ValidationError("only projects have repositories");
    if (!input.new_project && repoFolders.size) await assertCanManage(ctx, to);
  }
  let fixedComponent: { id: string; slug: string } | null | undefined;
  if (input.component !== undefined) {
    if (input.component === "") fixedComponent = null;
    else {
      if (input.new_project) throw new ValidationError("a new project has no repositories yet");
      const c = await ctx.db.query<{ id: string; slug: string }>("SELECT id, slug FROM components WHERE scope_id = $1 AND slug = $2", [to.id, input.component]);
      if (!c.rows[0]) throw new ValidationError(`${to.slug} has no repository '${input.component}'`);
      fixedComponent = c.rows[0];
    }
  }
  const folder = cleanPath(input.folder);
  const into = cleanPath(input.into_folder);
  if (!folder && !input.ids?.length) throw new ValidationError("give a folder or the items to move");

  const articles = await ctx.db.query<{ id: string; title: string; path: string; status: string; component_ids: string[] }>(
    `SELECT id, title, path, status, component_ids FROM articles
      WHERE scope_id = $1 AND (($2 <> '' AND (path = $2 OR path LIKE $2 || '/%')) OR id = ANY($3::uuid[]))
      ORDER BY path, title`,
    [from.id, folder, input.ids ?? []],
  );
  const findings = await ctx.db.query<{ id: string; title: string; component_ids: string[] }>(
    "SELECT id, title, component_ids FROM findings WHERE scope_id = $1 AND id = ANY($2::uuid[])",
    [from.id, input.ids ?? []],
  );
  const strip = input.strip_folder ?? !!folder;
  const inFolder = (p: string) => !!folder && (p === folder || p.startsWith(`${folder}/`));

  const plan = articles.rows.map((a) => {
    let rel = a.path ?? "";
    if (inFolder(rel)) {
      if (strip) rel = rel.slice(folder.length).replace(/^\/+/, "");
    } else {
      // Picked one by one: it goes straight into the destination folder.
      rel = "";
    }
    // Re-filing inside the same scope without a folder keeps the current one.
    const path = !inFolder(a.path ?? "") && sameScope && input.into_folder === undefined ? (a.path ?? "") : [into, rel].filter(Boolean).join("/");
    // A repository folder stays a folder (so the tree keeps its shape) and also tags its pages with the repository.
    let component: string | null = fixedComponent === undefined ? null : (fixedComponent?.slug ?? null);
    const first = rel.split("/")[0];
    if (fixedComponent === undefined && first && repoFolders.has(first)) component = slugify(first);
    return { id: a.id, title: a.title, from_path: a.path, to_path: path, component, keep_tags: sameScope && fixedComponent === undefined && !repoFolders.size };
  });
  const findingPlan = findings.rows.map((f) => ({ id: f.id, title: f.title, component: fixedComponent?.slug ?? null, keep_tags: sameScope && fixedComponent === undefined }));
  const components = [...new Set(plan.map((p) => p.component).filter((c): c is string => !!c && c !== fixedComponent?.slug))];
  // First-level sub-folders after stripping: the candidates for repositories.
  const subfolders = [
    ...new Set(
      articles.rows
        .filter((a) => inFolder(a.path ?? ""))
        .map((a) => (strip ? (a.path ?? "").slice(folder.length).replace(/^\/+/, "") : (a.path ?? "")).split("/")[0])
        .filter((f): f is string => !!f),
    ),
  ].sort();
  const summary = {
    from: from.slug,
    to: to.slug,
    articles: plan.map(({ keep_tags: _k, ...p }) => p),
    findings: findingPlan.map(({ keep_tags: _k, ...f }) => f),
    new_components: components,
    subfolders,
  };
  if (input.dry_run) return { dry_run: true, moved: 0, ...summary };
  if (!plan.length && !findings.rows.length) throw new ValidationError("nothing to move");

  await withTx(ctx.db, async (db) => {
    const componentIds: Record<string, string> = {};
    if (fixedComponent) componentIds[fixedComponent.slug] = fixedComponent.id;
    for (const slug of components) {
      const existing = await db.query<{ id: string }>("SELECT id FROM components WHERE scope_id = $1 AND slug = $2", [to.id, slug]);
      componentIds[slug] = existing.rows[0]?.id ?? (await createComponent(db, to.id, slug, "other"));
    }
    const tags = (p: { component: string | null; keep_tags: boolean }, current: string[]) => (p.keep_tags ? current : p.component ? [componentIds[p.component]] : []);
    for (const p of plan) {
      // Components belong to one project, so tags from the old scope can't come along.
      const current = articles.rows.find((a) => a.id === p.id)!.component_ids;
      await db.query("UPDATE articles SET scope_id = $2, path = $3, component_ids = $4 WHERE id = $1", [p.id, to.id, p.to_path, tags(p, current)]);
    }
    for (const f of findingPlan) {
      const current = findings.rows.find((x) => x.id === f.id)!.component_ids;
      await db.query("UPDATE findings SET scope_id = $2, component_ids = $3 WHERE id = $1", [f.id, to.id, tags(f, current)]);
    }
    const ids = [...plan.map((p) => p.id), ...findingPlan.map((f) => f.id)];
    if (!sameScope) {
      await db.query("UPDATE chunks SET scope_id = $2 WHERE parent_id = ANY($1::uuid[])", [ids, to.id]);
      await db.query("UPDATE assets SET scope_id = $2 WHERE target_id = ANY($1::uuid[])", [ids, to.id]);
      // Open proposals follow their item, so the new scope's owners review them.
      await db.query("UPDATE revisions SET scope_id = $2 WHERE target_id = ANY($1::uuid[]) AND state = 'pending' AND op <> 'share'", [ids, to.id]);
    }
    for (const id of ids) await audit(db, ctx.actor.id, "move_item", id);
  });
  ctx.onWrite?.();
  return { dry_run: false, moved: plan.length + findingPlan.length, ...summary };
}

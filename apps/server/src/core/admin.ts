import { withTx, type Queryable } from "../db/pool.js";
import { createComponent, createScope, relate, repoKey } from "./bootstrap.js";
import { ValidationError, type RequestContext } from "./context.js";
import { newArticle } from "./direct.js";
import { ARTICLE_TEMPLATES, SECTION_HINTS } from "./templates.js";
import type { CreateArticleInput } from "./writes.js";
import { assertAdmin, assertCanManage, isAdmin } from "./permissions.js";
import { getReadableScope, getScopeBySlug } from "./scopes.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type ComponentKind = "backend" | "frontend" | "mobile" | "data" | "infra" | "other";

export interface NewProject {
  slug: string;
  name: string;
  description?: string;
  components?: { slug: string; kind: ComponentKind; repo_url?: string }[];
  starter?: boolean;
}

export async function adminCreateProject(ctx: RequestContext, input: NewProject) {
  assertAdmin(ctx);
  return createProject(ctx, input);
}

/**
 * Creates a project (callers check who may). Access is granted before the
 * starter pack is written, so whoever creates it can publish the outlines:
 * `team` gets a role on it, and `owners` (emails) become its owners.
 */
export async function createProject(ctx: RequestContext, input: NewProject, access: { owners?: string[]; team?: { id: string; role: "reader" | "writer" | "owner" } } = {}) {
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  if (!input.name.trim()) throw new ValidationError("name is required");
  for (const c of input.components ?? []) if (!SLUG.test(c.slug)) throw new ValidationError(`component slug '${c.slug}' must be lowercase letters, digits and hyphens`);
  const existing = await ctx.db.query("SELECT 1 FROM scopes WHERE slug = $1", [input.slug]);
  if (existing.rowCount) throw new ValidationError(`'${input.slug}' is already taken; choose another short name`);
  const id = await createScope(ctx.db, "project", input.slug, input.name.trim(), input.description?.trim() ?? "");
  // Every repository is kept; the starter pack links its contract to the first backend and clients.
  const components: Record<string, string> = {};
  const seen = new Set<string>();
  for (const c of input.components ?? []) {
    if (seen.has(c.slug)) throw new ValidationError(`two repositories are called '${c.slug}'`);
    seen.add(c.slug);
    await assertRepoFree(ctx, c.repo_url);
    const cid = await createComponent(ctx.db, id, c.slug, c.kind, c.repo_url || undefined);
    components[c.kind] ??= cid;
  }
  if (access.team) await ctx.db.query("INSERT INTO scope_team_roles (scope_id, team_id, role) VALUES ($1, $2, $3)", [id, access.team.id, access.team.role]);
  for (const email of new Set((access.owners ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))) {
    const user = await userForEmail(ctx.db, email);
    await ctx.db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (scope_id, user_id) DO UPDATE SET role = 'owner'", [id, user]);
  }
  const starter = input.starter ? await starterPack(ctx, input.slug, input.name.trim(), components) : [];
  return { id, slug: input.slug, components: seen.size, starter };
}

/** A user by email; people who haven't signed in yet get a placeholder their first sign-in claims. */
export async function userForEmail(db: Queryable, email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new ValidationError(`invalid email ${email}`);
  const found = await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 ORDER BY created_at LIMIT 1", [normalized]);
  if (found.rows[0]) return found.rows[0].id;
  return (await db.query<{ id: string }>("INSERT INTO users (subject, email) VALUES ($1, $2) RETURNING id", [`pending:${normalized}`, normalized])).rows[0]!.id;
}

/** Section text for a starter article: what to write there, as an italic prompt people replace. */
const prompt = (type: string) =>
  (ARTICLE_TEMPLATES[type] ?? []).map((h) => `## ${h}\n\n_To write: ${SECTION_HINTS[h] ?? "…"}_\n`).join("\n");

/**
 * The articles every project ends up needing, published as outlines so they
 * show on the project page from day one: an overview, a design doc, an
 * on-call runbook and, when there is a backend and a client, the API
 * contract between them (linked so contract changes notify the client).
 */
async function starterPack(ctx: RequestContext, project: string, name: string, components: Record<string, string>) {
  const quiet = { ...ctx, quietProposals: true };
  const made: { id: string; title: string; type: string }[] = [];
  const add = async (type: string, title: string, path: string) => {
    const res = await newArticle(quiet, { project, type: type as CreateArticleInput["type"], title, path, body_md: prompt(type) });
    made.push({ id: res.article_id, title, type });
    return res.article_id;
  };
  await add("project_overview", `${name} overview`, "");
  await add("design_doc", `${name} design`, "Design");
  await add("runbook", `${name} on-call runbook`, "Runbooks");
  const client = components.frontend ?? components.mobile;
  if (components.backend && client) {
    const contract = await add("api_contract", `${name} API`, "Contracts");
    await relate(ctx.db, { kind: "article", id: contract }, "provided_by", { kind: "component", id: components.backend });
    for (const kind of ["frontend", "mobile"]) {
      if (components[kind]) await relate(ctx.db, { kind: "article", id: contract }, "consumed_by", { kind: "component", id: components[kind]! });
    }
  }
  return made;
}

export async function adminAddComponent(ctx: RequestContext, project: string, input: { slug: string; kind: string; repo_url?: string; description?: string }) {
  const scope = await getScopeBySlug(ctx.db, project);
  if (scope.kind !== "project") throw new ValidationError("repositories belong to projects");
  await assertCanManage(ctx, scope);
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  await assertRepoFree(ctx, input.repo_url);
  const exists = await ctx.db.query("SELECT 1 FROM components WHERE scope_id = $1 AND slug = $2", [scope.id, input.slug]);
  if (exists.rowCount) throw new ValidationError(`${project} already has a component '${input.slug}'`);
  const id = await createComponent(ctx.db, scope.id, input.slug, input.kind, input.repo_url || undefined, input.description?.trim() ?? "");
  return { id, project, slug: input.slug };
}

/** A repository can belong to one project only, so a session in it always lands in the same place. */
async function assertRepoFree(ctx: RequestContext, url: string | undefined, exceptId?: string) {
  const key = repoKey(url);
  if (!key) return;
  const { rows } = await ctx.db.query<{ project: string; slug: string }>(
    "SELECT s.slug AS project, c.slug FROM components c JOIN scopes s ON s.id = c.scope_id WHERE c.repo_key = $1 AND ($2::uuid IS NULL OR c.id <> $2)",
    [key, exceptId ?? null],
  );
  if (rows[0]) throw new ValidationError(`that repository is already ${rows[0].project}/${rows[0].slug}`);
}

export async function updateComponent(
  ctx: RequestContext,
  project: string,
  slug: string,
  patch: { slug?: string; kind?: string; repo_url?: string | null; description?: string },
) {
  const scope = await getScopeBySlug(ctx.db, project);
  await assertCanManage(ctx, scope);
  const c = (await ctx.db.query<{ id: string }>("SELECT id FROM components WHERE scope_id = $1 AND slug = $2", [scope.id, slug])).rows[0];
  if (!c) throw new ValidationError(`${project} has no component '${slug}'`);
  if (patch.slug !== undefined && !SLUG.test(patch.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  if (patch.repo_url) await assertRepoFree(ctx, patch.repo_url, c.id);
  const repo = patch.repo_url === undefined ? undefined : patch.repo_url?.trim() || null;
  const { rows } = await ctx.db.query(
    `UPDATE components SET slug = coalesce($2, slug), kind = coalesce($3, kind), description = coalesce($4, description),
            repo_url = CASE WHEN $5 THEN $6 ELSE repo_url END, repo_key = CASE WHEN $5 THEN $7 ELSE repo_key END
      WHERE id = $1 RETURNING slug, kind, repo_url, description`,
    [c.id, patch.slug ?? null, patch.kind ?? null, patch.description ?? null, repo !== undefined, repo ?? null, repoKey(repo)],
  );
  return rows[0];
}

/** Removes a component; contracts and items stay, only their links to it go. */
export async function removeComponent(ctx: RequestContext, project: string, slug: string) {
  const scope = await getScopeBySlug(ctx.db, project);
  await assertCanManage(ctx, scope);
  const c = (await ctx.db.query<{ id: string }>("SELECT id FROM components WHERE scope_id = $1 AND slug = $2", [scope.id, slug])).rows[0];
  if (!c) throw new ValidationError(`${project} has no component '${slug}'`);
  await ctx.db.query("DELETE FROM relations WHERE from_id = $1 OR to_id = $1", [c.id]);
  await ctx.db.query("DELETE FROM impact_notices WHERE component_id = $1", [c.id]);
  await ctx.db.query("UPDATE articles SET component_ids = array_remove(component_ids, $1) WHERE $1 = ANY(component_ids)", [c.id]);
  await ctx.db.query("UPDATE findings SET component_ids = array_remove(component_ids, $1) WHERE $1 = ANY(component_ids)", [c.id]);
  await ctx.db.query("DELETE FROM components WHERE id = $1", [c.id]);
  return { project, removed: slug };
}

/**
 * Grants a role in a scope by email. If the person has never signed in, a
 * placeholder user is created and claimed on their first login.
 */
export async function adminSetMember(ctx: RequestContext, scopeSlug: string, email: string, role: "reader" | "writer" | "owner" | null) {
  const scope = await getScopeBySlug(ctx.db, scopeSlug);
  await assertCanManage(ctx, scope);
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new ValidationError("invalid email");
  const user =
    (await ctx.db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 ORDER BY created_at LIMIT 1", [normalized])).rows[0] ??
    (
      await ctx.db.query<{ id: string }>("INSERT INTO users (subject, email) VALUES ($1, $2) RETURNING id", [`pending:${normalized}`, normalized])
    ).rows[0]!;
  await withTx(ctx.db, async (tx) => {
    if (role === null) {
      await tx.query("DELETE FROM scope_members WHERE scope_id = $1 AND user_id = $2", [scope.id, user.id]);
    } else {
      await tx.query(
        `INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (scope_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [scope.id, user.id, role],
      );
    }
    await assertOwnerRemains(ctx, tx, scope);
  });
  return { scope: scope.slug, email: normalized, role };
}

/** A project owner (not an admin) can't leave a project without owners; admins can always fix it. */
export async function assertOwnerRemains(ctx: RequestContext, db: Queryable, scope: { id: string; kind: string }) {
  if (isAdmin(ctx) || scope.kind !== "project") return;
  const owners = await db.query("SELECT 1 FROM scope_roles WHERE scope_id = $1 AND role = 'owner' LIMIT 1", [scope.id]);
  if (!owners.rowCount) throw new ValidationError("a project needs at least one owner; make someone else owner first");
}

export async function listMembers(ctx: RequestContext, scopeSlug: string) {
  const scope = await getReadableScope(ctx, scopeSlug);
  const { rows } = await ctx.db.query(
    `SELECT coalesce(u.email, u.subject) AS email, m.role FROM scope_members m JOIN users u ON u.id = m.user_id
      WHERE m.scope_id = $1 ORDER BY m.role, email`,
    [scope.id],
  );
  return { scope: scope.slug, members: rows };
}

export async function adminUpdateScope(ctx: RequestContext, slug: string, patch: { visibility?: "team" | "members"; name?: string; description?: string }) {
  const scope = await getScopeBySlug(ctx.db, slug);
  await assertCanManage(ctx, scope);
  if (patch.visibility === "members" && scope.kind !== "project") throw new ValidationError("only projects can be members-only");
  const { rows } = await ctx.db.query(
    `UPDATE scopes SET visibility = coalesce($2, visibility), name = coalesce($3, name), description = coalesce($4, description)
      WHERE id = $1 RETURNING kind, slug, name, description, visibility`,
    [scope.id, patch.visibility ?? null, patch.name?.trim() || null, patch.description ?? null],
  );
  return rows[0];
}

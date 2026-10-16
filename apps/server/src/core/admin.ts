import { createComponent, createScope } from "./bootstrap.js";
import { ValidationError, type RequestContext } from "./context.js";
import { assertAdmin } from "./permissions.js";
import { getScopeBySlug } from "./scopes.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function adminCreateProject(ctx: RequestContext, input: { slug: string; name: string; description?: string }) {
  assertAdmin(ctx);
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  const existing = await ctx.db.query("SELECT 1 FROM scopes WHERE slug = $1", [input.slug]);
  if (existing.rowCount) throw new ValidationError(`scope '${input.slug}' already exists`);
  const id = await createScope(ctx.db, "project", input.slug, input.name.trim(), input.description?.trim() ?? "");
  return { id, slug: input.slug };
}

export async function adminAddComponent(ctx: RequestContext, project: string, input: { slug: string; kind: string; repo_url?: string }) {
  assertAdmin(ctx);
  const scope = await getScopeBySlug(ctx.db, project);
  if (scope.kind !== "project") throw new ValidationError("components belong to projects");
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  const id = await createComponent(ctx.db, scope.id, input.slug, input.kind, input.repo_url);
  return { id, project, slug: input.slug };
}

/**
 * Grants a role in a scope by email. If the person has never signed in, a
 * placeholder user is created and claimed on their first login.
 */
export async function adminSetMember(ctx: RequestContext, scopeSlug: string, email: string, role: "reader" | "writer" | "owner" | null) {
  assertAdmin(ctx);
  const scope = await getScopeBySlug(ctx.db, scopeSlug);
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(normalized)) throw new ValidationError("invalid email");
  const user =
    (await ctx.db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 ORDER BY created_at LIMIT 1", [normalized])).rows[0] ??
    (
      await ctx.db.query<{ id: string }>("INSERT INTO users (subject, email) VALUES ($1, $2) RETURNING id", [`pending:${normalized}`, normalized])
    ).rows[0]!;
  if (role === null) {
    await ctx.db.query("DELETE FROM scope_members WHERE scope_id = $1 AND user_id = $2", [scope.id, user.id]);
  } else {
    await ctx.db.query(
      `INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (scope_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [scope.id, user.id, role],
    );
  }
  return { scope: scope.slug, email: normalized, role };
}

export async function listMembers(ctx: RequestContext, scopeSlug: string) {
  const scope = await getScopeBySlug(ctx.db, scopeSlug);
  const { rows } = await ctx.db.query(
    `SELECT coalesce(u.email, u.subject) AS email, m.role FROM scope_members m JOIN users u ON u.id = m.user_id
      WHERE m.scope_id = $1 ORDER BY m.role, email`,
    [scope.id],
  );
  return { scope: scope.slug, members: rows };
}

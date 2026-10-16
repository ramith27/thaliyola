import { createComponent, createScope, relate } from "./bootstrap.js";
import { ValidationError, type RequestContext } from "./context.js";
import { newArticle } from "./direct.js";
import { ARTICLE_TEMPLATES, SECTION_HINTS } from "./templates.js";
import type { CreateArticleInput } from "./writes.js";
import { assertAdmin } from "./permissions.js";
import { getReadableScope, getScopeBySlug } from "./scopes.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type ComponentKind = "backend" | "frontend" | "mobile" | "data" | "infra" | "other";

export async function adminCreateProject(
  ctx: RequestContext,
  input: { slug: string; name: string; description?: string; components?: { slug: string; kind: ComponentKind; repo_url?: string }[]; starter?: boolean },
) {
  assertAdmin(ctx);
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  for (const c of input.components ?? []) if (!SLUG.test(c.slug)) throw new ValidationError(`component slug '${c.slug}' must be lowercase letters, digits and hyphens`);
  const existing = await ctx.db.query("SELECT 1 FROM scopes WHERE slug = $1", [input.slug]);
  if (existing.rowCount) throw new ValidationError(`scope '${input.slug}' already exists`);
  const id = await createScope(ctx.db, "project", input.slug, input.name.trim(), input.description?.trim() ?? "");
  const components: Record<string, string> = {};
  for (const c of input.components ?? []) components[c.kind] ??= await createComponent(ctx.db, id, c.slug, c.kind, c.repo_url);
  const starter = input.starter ? await starterPack(ctx, input.slug, input.name.trim(), components) : [];
  return { id, slug: input.slug, components: Object.keys(components).length, starter };
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
  const scope = await getReadableScope(ctx, scopeSlug);
  const { rows } = await ctx.db.query(
    `SELECT coalesce(u.email, u.subject) AS email, m.role FROM scope_members m JOIN users u ON u.id = m.user_id
      WHERE m.scope_id = $1 ORDER BY m.role, email`,
    [scope.id],
  );
  return { scope: scope.slug, members: rows };
}

export async function adminUpdateScope(ctx: RequestContext, slug: string, patch: { visibility?: "team" | "members"; name?: string; description?: string }) {
  assertAdmin(ctx);
  const scope = await getScopeBySlug(ctx.db, slug);
  if (patch.visibility === "members" && scope.kind !== "project") throw new ValidationError("only projects can be members-only");
  const { rows } = await ctx.db.query(
    `UPDATE scopes SET visibility = coalesce($2, visibility), name = coalesce($3, name), description = coalesce($4, description)
      WHERE id = $1 RETURNING kind, slug, name, description, visibility`,
    [scope.id, patch.visibility ?? null, patch.name?.trim() || null, patch.description ?? null],
  );
  return rows[0];
}

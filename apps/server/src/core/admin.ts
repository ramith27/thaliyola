import { withTx } from "../db/pool.js";
import { resolvePerson } from "./access.js";
import { accountNote, accountStatus, needsApproval, type AccountStatus } from "./accounts.js";
import { cleanRepoUrl, createComponent, createScope, relate, repoKey } from "./bootstrap.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { newArticle } from "./direct.js";
import { ARTICLE_TEMPLATES, SECTION_HINTS } from "./templates.js";
import type { CreateArticleInput } from "./writes.js";
import { audit } from "./audit.js";
import { assertCanManage, can, canManage, readableScopes } from "./permissions.js";
import { checkNewParent } from "./hierarchy.js";
import { keepingProjectAdmins } from "./project-admins.js";
import { applyRoleChange, assertCan, assertMayGrant, inRoleOrder, listRoles, namesOf, resolveRoles, type RoleChange } from "./roles.js";
import { getReadableScope, getScopeBySlug, getScopeFor } from "./scopes.js";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** "me" and "personal-…" name personal spaces. */
export const reservedSlug = (slug: string) => slug === "me" || slug.startsWith("personal-");

export type ComponentKind = "backend" | "frontend" | "mobile" | "data" | "infra" | "other";

export interface NewProject {
  slug: string;
  name: string;
  description?: string;
  components?: { slug: string; kind: ComponentKind; repo_url?: string; description?: string }[];
  starter?: boolean;
  /** Who can read it: members only, or everyone signed in. Defaults to DEFAULT_PROJECT_VISIBILITY. */
  visibility?: "team" | "members";
  /** Slug of the project it goes under (its members get their roles here too). */
  parent?: string;
}

async function canManageSlug(ctx: RequestContext, slug: string) {
  const scope = (await ctx.db.query<{ id: string; kind: string }>("SELECT id, kind FROM scopes WHERE slug = $1", [slug])).rows[0];
  return !!scope && (await canManage(ctx, scope));
}

export async function adminCreateProject(ctx: RequestContext, input: NewProject) {
  // Project creators make any project; a project's admins make sub-projects of it.
  if (!(input.parent && !can(ctx, "create_projects") && (await canManageSlug(ctx, input.parent)))) {
    assertCan(ctx, "create_projects", "only admins and project creators can create projects (project admins can add sub-projects to theirs)");
  }
  // Whoever creates a members-only project owns it, or they couldn't see it (only admins see every project).
  // An open project gets owners only when its creator wouldn't otherwise manage it, since listing owners limits who may propose.
  const visibility = input.visibility ?? ctx.settings.defaultProjectVisibility;
  const own = ctx.actor.kind === "human" && !!ctx.actor.email && (visibility === "members" || !can(ctx, "manage_all_projects"));
  return createProject(ctx, input, own ? { owners: [ctx.actor.email!] } : {});
}

/**
 * Projects the caller manages (all of them for admins), with what's needed to look after them:
 * visibility, owners, how many people and teams have access, repositories, content, pending reviews and last activity.
 */
export async function listManagedProjects(ctx: RequestContext) {
  const all = can(ctx, "manage_all_projects") || can(ctx, "read_all_projects");
  const { rows } = await ctx.db.query(
    `SELECT s.slug, s.name, s.description, s.visibility, s.status, s.created_at, (SELECT p.slug FROM scopes p WHERE p.id = s.parent_id) AS parent,
            coalesce((SELECT array_agg(DISTINCT coalesce(u.email, u.subject)) FROM scope_permissions p JOIN users u ON u.id = p.user_id
                       WHERE p.scope_id = s.id AND p.permission = 'manage_members' AND u.kind = 'human' AND u.disabled_at IS NULL), '{}') AS owners,
            coalesce((SELECT json_agg(json_build_object('email', o.email, 'name', o.name) ORDER BY lower(coalesce(o.name, o.email)))
                        FROM (SELECT DISTINCT coalesce(u.email, u.subject) AS email, u.display_name AS name FROM scope_permissions p JOIN users u ON u.id = p.user_id
                               WHERE p.scope_id = s.id AND p.permission = 'manage_members' AND u.kind = 'human' AND u.disabled_at IS NULL) o), '[]') AS owner_list,
            (SELECT count(DISTINCT user_id)::int FROM scope_roles r WHERE r.scope_id = s.id) AS people,
            (SELECT count(DISTINCT team_id)::int FROM scope_team_roles t WHERE t.scope_id = s.id) AS teams,
            (SELECT count(*)::int FROM components c WHERE c.scope_id = s.id) AS repositories,
            (SELECT count(*)::int FROM articles a WHERE a.scope_id = s.id AND a.status <> 'deleted') AS articles,
            (SELECT count(*)::int FROM findings f WHERE f.scope_id = s.id AND f.status <> 'deleted') AS findings,
            (SELECT count(*)::int FROM revisions v WHERE v.scope_id = s.id AND v.state = 'pending') AS pending_reviews,
            greatest((SELECT max(updated_at) FROM articles a WHERE a.scope_id = s.id), (SELECT max(updated_at) FROM findings f WHERE f.scope_id = s.id),
                     (SELECT max(created_at) FROM revisions v WHERE v.scope_id = s.id), s.created_at) AS last_activity,
            ($2 OR EXISTS (SELECT 1 FROM scope_permissions p WHERE p.scope_id = s.id AND p.user_id = $1 AND p.permission = 'manage_settings')) AS can_manage
       FROM scopes s
      WHERE s.kind = 'project' AND s.status <> 'deleted'
        AND ($3 OR EXISTS (SELECT 1 FROM scope_permissions p WHERE p.scope_id = s.id AND p.user_id = $1 AND p.permission IN ('manage_settings', 'manage_members')))
      ORDER BY s.status = 'active' DESC, s.name`,
    [ctx.actor.id, can(ctx, "manage_all_projects"), all],
  );
  return { projects: rows, default_visibility: ctx.settings.defaultProjectVisibility, can_create: can(ctx, "create_projects") };
}

/** Sets several projects' visibility at once; each is checked on its own (manage_settings there). */
export async function setProjectsVisibility(ctx: RequestContext, slugs: string[], visibility: "team" | "members") {
  const results: { slug: string; ok: boolean; error?: string }[] = [];
  for (const slug of [...new Set(slugs)]) {
    try {
      const scope = await getScopeBySlug(ctx.db, slug);
      if (scope.kind !== "project") throw new ValidationError("only projects can be members-only");
      await adminUpdateScope(ctx, slug, { visibility });
      results.push({ slug, ok: true });
    } catch (err) {
      results.push({ slug, ok: false, error: (err as Error).message });
    }
  }
  await audit(ctx.db, ctx.actor.id, "set_projects_visibility", null, {
    details: { visibility, projects: results.filter((r) => r.ok).map((r) => r.slug), refused: results.filter((r) => !r.ok).map((r) => r.slug) },
  });
  return { visibility, changed: results.filter((r) => r.ok).length, results };
}

/**
 * Creates a project (callers check who may). Access is granted before the
 * starter pack is written, so whoever creates it can publish the outlines:
 * `team` gets its roles (keys) on it, and `owners` (emails) become its Project admins.
 */
export async function createProject(ctx: RequestContext, input: NewProject, access: { owners?: string[]; team?: { id: string; roles: string[] } } = {}) {
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens");
  if (reservedSlug(input.slug)) throw new ValidationError(`'${input.slug}' is reserved for personal spaces; choose another short name`);
  if (!input.name.trim()) throw new ValidationError("name is required");
  for (const c of input.components ?? []) if (!SLUG.test(c.slug)) throw new ValidationError(`component slug '${c.slug}' must be lowercase letters, digits and hyphens`);
  const existing = await ctx.db.query("SELECT 1 FROM scopes WHERE slug = $1", [input.slug]);
  if (existing.rowCount) throw new ValidationError(`'${input.slug}' is already taken; choose another short name`);
  const visibility = input.visibility ?? ctx.settings.defaultProjectVisibility;
  const parent = input.parent ? await checkNewParent(ctx, input.parent) : null;
  const id = await createScope(ctx.db, "project", input.slug, input.name.trim(), input.description?.trim() ?? "", visibility);
  if (parent) await ctx.db.query("UPDATE scopes SET parent_id = $2 WHERE id = $1", [id, parent.id]);
  // Every repository is kept; the starter pack links its contract to the first backend and clients.
  const components: Record<string, string> = {};
  const seen = new Set<string>();
  for (const c of input.components ?? []) {
    if (seen.has(c.slug)) throw new ValidationError(`two repositories are called '${c.slug}'`);
    seen.add(c.slug);
    await assertRepoFree(ctx, c.repo_url);
    const cid = await createComponent(ctx.db, id, c.slug, c.kind, c.repo_url || undefined, c.description?.trim() ?? "");
    components[c.kind] ??= cid;
  }
  for (const role of access.team?.roles ?? []) {
    await ctx.db.query("INSERT INTO scope_team_roles (scope_id, team_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [id, access.team!.id, role]);
  }
  for (const email of new Set((access.owners ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))) {
    const user = await userForEmail(ctx, email);
    await ctx.db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [id, user]);
  }
  const starter = input.starter ? await starterPack(ctx, input.slug, input.name.trim(), components) : [];
  return { id, slug: input.slug, visibility, parent: parent?.slug ?? null, components: seen.size, starter };
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;

/**
 * The account for an email, or for the identifier shown for an account without one (a service account's subject,
 * e.g. "cf-svc:abc"). An email finds people first, then accounts that have signed in, enabled ones, the oldest.
 * With `create`, someone who hasn't signed in yet gets a placeholder their first sign-in claims; only a placeholder
 * made by someone with Manage people is approved in advance (a Project admin grants project access, not access to
 * Thaliyola). Returns null when there is no such account and `create` is off. Anything else ('me', or someone's full
 * name) must match an existing account exactly; a partial name is refused with the people it could mean.
 */
export async function userForIdentifier(ctx: RequestContext, who: string, opts: { create: boolean }): Promise<string | null> {
  const raw = who.trim();
  const normalized = raw.toLowerCase();
  if (EMAIL.test(normalized)) {
    const found = await ctx.db.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = $1
        ORDER BY kind = 'human' DESC, subject LIKE 'pending:%', disabled_at IS NOT NULL, created_at LIMIT 1`,
      [normalized],
    );
    if (found.rows[0]) return found.rows[0].id;
    if (!opts.create) return null;
    const approved = can(ctx, "manage_users");
    const { rows } = await ctx.db.query<{ id: string }>(
      "INSERT INTO users (subject, email, approved_at, approved_by) VALUES ($1, $2, CASE WHEN $3 THEN now() END, CASE WHEN $3 THEN $4::uuid END) RETURNING id",
      [`pending:${normalized}`, normalized, approved, ctx.actor.id],
    );
    return rows[0]!.id;
  }
  const bySubject = await ctx.db.query<{ id: string }>("SELECT id FROM users WHERE subject = $1 OR lower(subject) = $2 ORDER BY subject = $1 DESC LIMIT 1", [
    raw,
    normalized,
  ]);
  if (bySubject.rows[0]) return bySubject.rows[0].id;
  // A name ('me', or someone's full name) finds an existing account; a part of one is never guessed at for a change.
  return (await resolvePerson(ctx, raw, { exact: true })).id;
}

/** A user by email, made as a placeholder when they haven't signed in yet (see userForIdentifier). */
export async function userForEmail(ctx: RequestContext, email: string): Promise<string> {
  return (await userForIdentifier(ctx, email, { create: true }))!;
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
  const repo = patch.repo_url === undefined ? undefined : cleanRepoUrl(patch.repo_url);
  const { rows } = await ctx.db.query(
    `UPDATE components SET slug = coalesce($2, slug), kind = coalesce($3, kind), description = coalesce($4, description),
            repo_url = CASE WHEN $5 THEN $6 ELSE repo_url END, repo_key = CASE WHEN $5 THEN $7 ELSE repo_key END,
            -- What a git connection read about the old repository doesn't describe a new one.
            repo_info = CASE WHEN $5 AND repo_url IS DISTINCT FROM $6 THEN NULL ELSE repo_info END,
            repo_synced_at = CASE WHEN $5 AND repo_url IS DISTINCT FROM $6 THEN NULL ELSE repo_synced_at END
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

export interface MemberChange {
  scope: string;
  project_name: string;
  email: string;
  /** Their display name, if they have one. */
  name: string | null;
  roles: string[];
  role_names: string[];
  /** Keys; the *_names fields are the same roles by display name, for reporting what changed. */
  before: string[];
  added: string[];
  removed: string[];
  before_names: string[];
  added_names: string[];
  removed_names: string[];
  account: AccountStatus;
  needs_approval: boolean;
  /** Roles they still hold here through a team or a project above, grouped by where they come from. */
  still_has_access_via: { team: { slug: string; name: string } | null; from: { slug: string; name: string } | null; roles: string[]; role_names: string[] }[];
  note: string | null;
  /** Echoed only when the deprecated single `role` input was used. */
  role?: string | null;
}

/** Roles someone holds in a scope through teams or projects above, grouped by where they come from. */
export async function accessThroughOthers(ctx: RequestContext, scopeId: string, userId: string): Promise<MemberChange["still_has_access_via"]> {
  const roles = await listRoles(ctx.db, "project");
  const { rows } = await ctx.db.query<{ role: string; team_slug: string | null; team_name: string | null; from_slug: string | null; from_name: string | null }>(
    `SELECT DISTINCT r.role, t.slug AS team_slug, t.name AS team_name, a.slug AS from_slug, a.name AS from_name
       FROM scope_roles r LEFT JOIN teams t ON t.id = r.team_id LEFT JOIN scopes a ON a.id = r.inherited_from
      WHERE r.scope_id = $1 AND r.user_id = $2 AND (r.team_id IS NOT NULL OR r.inherited_from IS NOT NULL)`,
    [scopeId, userId],
  );
  const groups = new Map<string, MemberChange["still_has_access_via"][number]>();
  for (const r of rows) {
    const id = `${r.team_slug ?? ""}|${r.from_slug ?? ""}`;
    let g = groups.get(id);
    if (!g) {
      g = {
        team: r.team_slug ? { slug: r.team_slug, name: r.team_name ?? r.team_slug } : null,
        from: r.from_slug ? { slug: r.from_slug, name: r.from_name ?? r.from_slug } : null,
        roles: [],
        role_names: [],
      };
      groups.set(id, g);
    }
    g.roles.push(r.role);
  }
  for (const g of groups.values()) {
    g.roles = inRoleOrder(roles, g.roles);
    g.role_names = namesOf(roles, g.roles);
  }
  return [...groups.values()];
}

/** "They still have Contributor here through the team Payments, and Viewer here through Platform (a project above)." */
export function stillHasText(via: MemberChange["still_has_access_via"]): string {
  const parts = via.map(
    (g) =>
      `${g.role_names.join(", ")} here through ${g.from ? `${g.team ? `the team ${g.team.name} in ` : ""}${g.from.name} (a project above)` : `the team ${g.team!.name}`}`,
  );
  return parts.length ? `They still have ${parts.join(", and ")}.` : "";
}

/**
 * Gives, changes or takes away the project roles a person holds directly: `set` replaces them all ([] removes them),
 * `add` / `remove` change only those. Their team and inherited roles are unaffected (the result says what remains).
 * Needs Manage access there, and only roles whose permissions the caller holds there, given or taken away. A project
 * the caller can't read is "not found". Someone who has never signed in gets a placeholder their first sign-in claims.
 * Every project keeps at least one Project admin.
 */
export async function changeMemberRoles(ctx: RequestContext, scopeSlug: string, who: string, change: RoleChange): Promise<MemberChange> {
  const scope = await getReadableScope(ctx, scopeSlug);
  await assertCanManage(ctx, scope, "manage_members");
  const all = await listRoles(ctx.db, "project");
  const set = change.set ? await resolveRoles(ctx.db, "project", change.set) : undefined;
  const add = await resolveRoles(ctx.db, "project", change.add ?? []);
  const remove = await resolveRoles(ctx.db, "project", change.remove ?? []);
  const giving = (set?.length ?? 0) > 0 || add.length > 0;
  const existing = await userForIdentifier(ctx, who, { create: false });
  if (!existing && !giving) throw new NotFoundError(who, `${who.trim()} has no roles here`);
  const current = existing
    ? inRoleOrder(
        all,
        (await ctx.db.query<{ role: string }>("SELECT role FROM scope_members WHERE scope_id = $1 AND user_id = $2", [scope.id, existing])).rows.map((r) => r.role),
      )
    : [];
  const keys = (rs: { key: string }[]) => rs.map((r) => r.key);
  const { desired, added, removed } = applyRoleChange(current, { set: set ? keys(set) : undefined, add: keys(add), remove: keys(remove) });
  await assertMayGrant(
    ctx,
    all.filter((r) => added.includes(r.key) || removed.includes(r.key)),
    scope.id,
  );
  // Only now, with everything checked, is someone new added (as a placeholder their first sign-in claims).
  const userId = existing ?? (await userForIdentifier(ctx, who, { create: true }))!;
  if (added.length || removed.length) {
    const readable = await readableScopes(ctx);
    await withTx(ctx.db, (tx) =>
      keepingProjectAdmins(
        tx,
        [scope.id],
        async () => {
          if (removed.length) await tx.query("DELETE FROM scope_members WHERE scope_id = $1 AND user_id = $2 AND role = ANY ($3::text[])", [scope.id, userId, removed]);
          for (const k of added) await tx.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [scope.id, userId, k]);
        },
        { refuse: !can(ctx, "manage_all_projects"), readable },
      ),
    );
    await audit(ctx.db, ctx.actor.id, "set_member_roles", scope.id, {
      targetKind: "project",
      targetLabel: scope.name,
      details: { person_id: userId, person: who.trim(), before: current, after: desired, added, removed },
    });
  }
  const u = (
    await ctx.db.query<{ email: string | null; name: string | null; subject: string; approved_at: unknown; disabled_at: unknown }>(
      "SELECT email, display_name AS name, subject, approved_at, disabled_at FROM users WHERE id = $1",
      [userId],
    )
  ).rows[0]!;
  const roles = inRoleOrder(all, desired);
  const via = await accessThroughOthers(ctx, scope.id, userId);
  const removing = removed.length > 0 || remove.length > 0 || (!!set && !set.length);
  const note = [roles.length ? accountNote(u, ctx.settings, "these roles") : null, removing ? stillHasText(via) : ""].filter(Boolean).join(" ");
  return {
    scope: scope.slug,
    project_name: scope.name,
    email: EMAIL.test(who.trim().toLowerCase()) ? who.trim().toLowerCase() : (u.email ?? u.subject),
    name: u.name,
    roles,
    role_names: namesOf(all, roles),
    before: current,
    added: inRoleOrder(all, added),
    removed: inRoleOrder(all, removed),
    before_names: namesOf(all, current),
    added_names: namesOf(all, inRoleOrder(all, added)),
    removed_names: namesOf(all, inRoleOrder(all, removed)),
    account: accountStatus(u),
    needs_approval: needsApproval(u, ctx.settings),
    still_has_access_via: via,
    note: note || null,
  };
}

/** Sets the project roles a person holds directly (an empty list removes them). */
export async function setMemberRoles(ctx: RequestContext, scopeSlug: string, email: string, keys: string[]) {
  return changeMemberRoles(ctx, scopeSlug, email, { set: keys });
}

/** @deprecated use changeMemberRoles. Grants one role (replacing their others), or removes all of them with null. */
export async function adminSetMember(ctx: RequestContext, scopeSlug: string, email: string, role: string | null) {
  const res = await changeMemberRoles(ctx, scopeSlug, email, { set: role === null ? [] : [role] });
  return { ...res, role };
}

/** @deprecated use listAccess (GET /scopes/:slug/access). */
export async function listMembers(ctx: RequestContext, scopeSlug: string) {
  const scope = await getReadableScope(ctx, scopeSlug);
  const roles = await listRoles(ctx.db, "project");
  const { rows } = await ctx.db.query<{ email: string; name: string | null; roles: string[]; role: string }>(
    `SELECT coalesce(u.email, u.subject) AS email, u.display_name AS name, array_agg(m.role ORDER BY r.position) AS roles, (array_agg(m.role ORDER BY r.position))[1] AS role
       FROM scope_members m JOIN users u ON u.id = m.user_id JOIN roles r ON r.key = m.role
      WHERE m.scope_id = $1 GROUP BY u.id, u.email, u.subject ORDER BY min(r.position), email`,
    [scope.id],
  );
  return { scope: scope.slug, members: rows.map((m) => ({ ...m, role_names: namesOf(roles, m.roles) })) };
}

export async function adminUpdateScope(ctx: RequestContext, slug: string, patch: { visibility?: "team" | "members"; name?: string; description?: string }) {
  const scope = await getScopeFor(ctx, slug);
  await assertCanManage(ctx, scope);
  if (patch.visibility === "members" && scope.kind !== "project") throw new ValidationError("only projects can be members-only");
  const { rows } = await ctx.db.query(
    `UPDATE scopes SET visibility = coalesce($2, visibility), name = coalesce($3, name), description = coalesce($4, description)
      WHERE id = $1 RETURNING kind, slug, name, description, visibility`,
    [scope.id, patch.visibility ?? null, patch.name?.trim() || null, patch.description ?? null],
  );
  return rows[0];
}

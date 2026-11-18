import { audit } from "./audit.js";
import { createProject, reservedSlug, type ComponentKind } from "./admin.js";
import { ForbiddenError, nameOf, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { notify, track } from "./notify.js";
import { can, canManage } from "./permissions.js";
import { idsWithPermission } from "./roles.js";

/**
 * New projects from agents and people. Admins (and agents acting for an
 * admin) create them straight away and own them; anyone else files a request
 * that admins approve or decline in the review queue. That way an agent that
 * finds no project for its repository asks for one instead of filing project
 * knowledge in the shared team space.
 */

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface ProjectInput {
  slug: string;
  name: string;
  description?: string;
  repos?: { slug: string; kind: ComponentKind; repo_url?: string; description?: string }[];
  reason?: string;
  visibility?: "team" | "members";
  /** Put it under this project; its admins create it straight away. */
  parent?: string;
}

function validate(input: ProjectInput) {
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens, e.g. 'quilleaf'");
  if (reservedSlug(input.slug)) throw new ValidationError(`'${input.slug}' is reserved for personal spaces; choose another short name`);
  if (!input.name.trim()) throw new ValidationError("name is required");
  for (const r of input.repos ?? []) if (!SLUG.test(r.slug)) throw new ValidationError(`repository name '${r.slug}' must be lowercase letters, digits and hyphens`);
}

/** Creates the project (admins) or files a request for one (everyone else). */
export async function createOrRequestProject(ctx: RequestContext, input: ProjectInput) {
  validate(input);
  const taken = await ctx.db.query<{ status: string }>("SELECT status FROM scopes WHERE slug = $1", [input.slug]);
  if (taken.rows[0]) {
    throw new ValidationError(
      taken.rows[0].status === "deleted" ? `a project '${input.slug}' is in the trash; ask an admin to restore it` : `'${input.slug}' already exists; use it (list_projects)`,
    );
  }
  const underOwn = !!input.parent && !!(await ctx.db.query<{ id: string; kind: string }>("SELECT id, kind FROM scopes WHERE slug = $1", [input.parent]).then(async (r) => r.rows[0] && (await canManage(ctx, r.rows[0]))));
  if (can(ctx, "create_projects") || underOwn) {
    const owners = ctx.actor.email ? [ctx.actor.email] : [];
    const res = await createProject(
      ctx,
      { slug: input.slug, name: input.name, description: input.description, components: input.repos, visibility: input.visibility, parent: input.parent },
      { owners },
    );
    await audit(ctx.db, ctx.actor.id, "create_project", res.id, {
      targetKind: "project",
      targetLabel: input.name.trim(),
      details: { project: res.slug, owners, visibility: res.visibility, parent: res.parent },
    });
    return {
      status: "created" as const,
      project: input.slug,
      visibility: res.visibility,
      parent: res.parent,
      repositories: res.components,
      note: `Created. You're its Project admin${res.visibility === "members" ? "; only people with a role in it (and people who can see every project) can see it" : ""}. Give people access with set_project_access.`,
    };
  }
  const pending = await ctx.db.query<{ id: string }>("SELECT id FROM project_requests WHERE slug = $1 AND state = 'pending'", [input.slug]);
  if (pending.rows[0]) return { status: "already_requested" as const, request_id: pending.rows[0].id, project: input.slug };
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO project_requests (slug, name, description, repos, reason, requested_by, visibility) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.slug, input.name.trim(), input.description?.trim() ?? "", JSON.stringify(input.repos ?? []), input.reason?.trim() ?? "", ctx.actor.id, input.visibility ?? null],
  );
  const who = nameOf(ctx.actor, "An agent");
  // A members-only project's name, short name and reason are for the people who decide (in Thaliyola): team-wide
  // Slack channels and Trello lists only hear that one was requested.
  const membersOnly = (input.visibility ?? ctx.settings.defaultProjectVisibility) === "members";
  track(
    idsWithPermission(ctx.db, ctx.settings, "create_projects")
      .then((ids) =>
        notify(ctx.db, ctx.settings, ids, {
          kind: "review",
          title: `New project requested: ${input.name.trim()}`,
          body: `${who} asked for a project '${input.slug}'${input.reason ? `: ${input.reason}` : ""}.`,
          link: "#/review?tab=projects",
          ...(membersOnly ? { external: { title: "A members-only project was requested", body: "Open the review queue to see it and decide." } } : {}),
        }),
      )
      .catch((err) => console.error(`[notify] ${(err as Error).message}`)),
  );
  await audit(ctx.db, ctx.actor.id, "request_project", rows[0]!.id, { targetKind: "project_request", targetLabel: input.name.trim(), details: { slug: input.slug } });
  return { status: "requested" as const, request_id: rows[0]!.id, project: input.slug, note: "An Administrator or Project creator has to approve it. Write your drafts down locally and add them once it exists." };
}

export async function listProjectRequests(ctx: RequestContext, state: "pending" | "approved" | "declined" = "pending") {
  if (!can(ctx, "create_projects")) {
    // People see their own requests.
    const { rows } = await ctx.db.query(
      "SELECT id, slug, name, description, repos, reason, visibility, state, decision_note, created_at, decided_at FROM project_requests WHERE requested_by = $1 ORDER BY created_at DESC LIMIT 50",
      [ctx.actor.id],
    );
    return rows;
  }
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.slug, r.name, r.description, r.repos, r.reason, r.visibility, r.state, r.decision_note, r.created_at, r.decided_at,
            coalesce(u.display_name, u.email, u.subject) AS requested_by,
            coalesce(u.display_name, u.email, u.subject) AS requested_by_name, coalesce(u.email, u.subject) AS requested_by_email
       FROM project_requests r JOIN users u ON u.id = r.requested_by WHERE r.state = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [state],
  );
  return rows;
}

async function pendingRequest(ctx: RequestContext, id: string) {
  if (!can(ctx, "create_projects")) throw new ForbiddenError("only admins and project creators decide project requests");
  const { rows } = await ctx.db.query<{ id: string; slug: string; name: string; description: string; repos: ProjectInput["repos"]; requested_by: string; state: string; visibility: "team" | "members" | null }>(
    "SELECT id, slug, name, description, repos, requested_by, state, visibility FROM project_requests WHERE id = $1",
    [id],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError(`project request ${id}`);
  if (r.state !== "pending") throw new ValidationError(`request is already ${r.state}`);
  return r;
}

/** Creates the requested project (optionally with a different short name) and makes the requester its owner. */
export async function approveProjectRequest(ctx: RequestContext, id: string, opts: { slug?: string; name?: string } = {}) {
  const r = await pendingRequest(ctx, id);
  const slug = opts.slug ?? r.slug;
  validate({ slug, name: opts.name ?? r.name });
  const requester = (await ctx.db.query<{ email: string | null; kind: string }>("SELECT email, kind FROM users WHERE id = $1", [r.requested_by])).rows[0];
  const owners = [requester?.kind === "human" ? requester.email : null, ctx.actor.email].filter((e): e is string => !!e);
  const res = await createProject(
    ctx,
    { slug, name: opts.name ?? r.name, description: r.description, components: r.repos ?? [], visibility: r.visibility ?? undefined },
    { owners },
  );
  await ctx.db.query("UPDATE project_requests SET state = 'approved', decided_by = $2, decided_at = now(), slug = $3 WHERE id = $1", [id, ctx.actor.id, slug]);
  await audit(ctx.db, ctx.actor.id, "approve_project_request", res.id, { targetKind: "project", targetLabel: opts.name ?? r.name, details: { request_id: id, slug } });
  track(
    notify(ctx.db, ctx.settings, [r.requested_by], {
      kind: "decided",
      title: `Project created: ${opts.name ?? r.name}`,
      body: `Your request was approved. The project is '${slug}'.`,
      link: `#/project/${slug}`,
      route: false,
    }, { exclude: ctx.actor.id }).catch(() => undefined),
  );
  return { status: "approved", project: slug };
}

export async function declineProjectRequest(ctx: RequestContext, id: string, note: string) {
  const r = await pendingRequest(ctx, id);
  if (!note.trim()) throw new ValidationError("say why (the requester sees it)");
  await ctx.db.query("UPDATE project_requests SET state = 'declined', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1", [id, ctx.actor.id, note.trim()]);
  // The request is the target, so filtering by it shows the decline too. The note goes to the requester, not here.
  await audit(ctx.db, ctx.actor.id, "decline_project_request", id, { targetKind: "project_request", targetLabel: r.name, details: { slug: r.slug } });
  track(
    notify(ctx.db, ctx.settings, [r.requested_by], {
      kind: "decided",
      title: `Project request declined: ${r.name}`,
      body: note.trim(),
      link: "#/review?tab=projects",
      route: false,
    }, { exclude: ctx.actor.id }).catch(() => undefined),
  );
  return { status: "declined" };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Approves or declines a project request named by its id or by the short name it asks for (the pending one). Needs
 * Create projects, checked before anything is looked up. Declining needs a reason (the requester sees it). The result
 * names the project and the requester.
 */
export async function decideProjectRequest(
  ctx: RequestContext,
  input: { request: string; decision: "approve" | "decline"; reason?: string; slug?: string; name?: string },
) {
  if (!can(ctx, "create_projects")) throw new ForbiddenError("deciding project requests needs Create projects (Administrators and Project creators have it)");
  const ref = input.request.trim();
  const { rows } = await ctx.db.query<{ id: string; slug: string; name: string; state: string; email: string | null; display_name: string | null; subject: string }>(
    `SELECT r.id, r.slug, r.name, r.state, u.email, u.display_name, u.subject
       FROM project_requests r JOIN users u ON u.id = r.requested_by
      WHERE ${UUID.test(ref) ? "r.id = $1::uuid" : "r.slug = lower($1) AND r.state = 'pending'"}
      ORDER BY r.created_at DESC LIMIT 1`,
    [ref],
  );
  const r = rows[0];
  if (!r) throw new NotFoundError(ref, `there's no pending project request '${ref}' (list_project_requests shows them)`);
  const requester = { requested_by: r.email ?? r.subject, requested_by_name: r.display_name ?? r.email ?? r.subject };
  if (input.decision === "decline") {
    if (!input.reason?.trim()) throw new ValidationError("say why you decline it (reason): the requester sees it");
    await declineProjectRequest(ctx, r.id, input.reason);
    return { status: "declined" as const, request_id: r.id, project: r.slug, project_name: r.name, ...requester, reason: input.reason.trim() };
  }
  const res = await approveProjectRequest(ctx, r.id, { slug: input.slug, name: input.name });
  const name = input.name?.trim() || r.name;
  const admins = (
    await ctx.db.query<{ email: string | null; name: string }>(
      `SELECT u.email, coalesce(u.display_name, u.email, u.subject) AS name FROM scope_members m JOIN scopes s ON s.id = m.scope_id JOIN users u ON u.id = m.user_id
        WHERE s.slug = $1 AND m.role = 'owner' ORDER BY 2`,
      [res.project],
    )
  ).rows;
  return {
    status: "approved" as const,
    request_id: r.id,
    project: res.project,
    project_name: name,
    ...requester,
    project_admins: admins.map((a) => a.email ?? a.name),
    project_admin_names: admins.map((a) => a.name),
    summary: `Created ${name} (${res.project}). Give others access with set_project_access.`,
  };
}

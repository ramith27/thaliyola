import { audit } from "./audit.js";
import { createProject, type ComponentKind } from "./admin.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { notify, track } from "./notify.js";
import { isAdmin } from "./permissions.js";

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
}

function validate(input: ProjectInput) {
  if (!SLUG.test(input.slug)) throw new ValidationError("slug must be lowercase letters, digits and hyphens, e.g. 'quilleaf'");
  if (!input.name.trim()) throw new ValidationError("name is required");
  for (const r of input.repos ?? []) if (!SLUG.test(r.slug)) throw new ValidationError(`repository name '${r.slug}' must be lowercase letters, digits and hyphens`);
}

async function admins(ctx: RequestContext) {
  const { rows } = await ctx.db.query<{ id: string }>(
    "SELECT id FROM users WHERE kind = 'human' AND disabled_at IS NULL AND (is_admin OR lower(email) = ANY($1::text[]))",
    [ctx.settings.adminEmails],
  );
  return rows.map((r) => r.id);
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
  if (isAdmin(ctx)) {
    const owners = ctx.actor.email ? [ctx.actor.email] : [];
    const res = await createProject(ctx, { slug: input.slug, name: input.name, description: input.description, components: input.repos }, { owners });
    await audit(ctx.db, ctx.actor.id, "create_project", res.id);
    return { status: "created" as const, project: input.slug, repositories: res.components, note: "Created. You own it; add people and teams in its settings." };
  }
  const pending = await ctx.db.query<{ id: string }>("SELECT id FROM project_requests WHERE slug = $1 AND state = 'pending'", [input.slug]);
  if (pending.rows[0]) return { status: "already_requested" as const, request_id: pending.rows[0].id, project: input.slug };
  const { rows } = await ctx.db.query<{ id: string }>(
    `INSERT INTO project_requests (slug, name, description, repos, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.slug, input.name.trim(), input.description?.trim() ?? "", JSON.stringify(input.repos ?? []), input.reason?.trim() ?? "", ctx.actor.id],
  );
  const who = ctx.actor.email ?? "An agent";
  track(
    admins(ctx)
      .then((ids) =>
        notify(ctx.db, ctx.settings, ids, {
          kind: "review",
          title: `New project requested: ${input.name.trim()}`,
          body: `${who} asked for a project '${input.slug}'${input.reason ? `: ${input.reason}` : ""}.`,
          link: "#/review?tab=projects",
        }),
      )
      .catch((err) => console.error(`[notify] ${(err as Error).message}`)),
  );
  await audit(ctx.db, ctx.actor.id, "request_project", rows[0]!.id);
  return { status: "requested" as const, request_id: rows[0]!.id, project: input.slug, note: "An admin has to approve it. Write your drafts down locally and add them once it exists." };
}

export async function listProjectRequests(ctx: RequestContext, state: "pending" | "approved" | "declined" = "pending") {
  if (!isAdmin(ctx)) {
    // People see their own requests.
    const { rows } = await ctx.db.query(
      "SELECT id, slug, name, description, repos, reason, state, decision_note, created_at, decided_at FROM project_requests WHERE requested_by = $1 ORDER BY created_at DESC LIMIT 50",
      [ctx.actor.id],
    );
    return rows;
  }
  const { rows } = await ctx.db.query(
    `SELECT r.id, r.slug, r.name, r.description, r.repos, r.reason, r.state, r.decision_note, r.created_at, r.decided_at,
            coalesce(u.display_name, u.email, u.subject) AS requested_by
       FROM project_requests r JOIN users u ON u.id = r.requested_by WHERE r.state = $1 ORDER BY r.created_at DESC LIMIT 100`,
    [state],
  );
  return rows;
}

async function pendingRequest(ctx: RequestContext, id: string) {
  if (!isAdmin(ctx)) throw new ForbiddenError("only admins decide project requests");
  const { rows } = await ctx.db.query<{ id: string; slug: string; name: string; description: string; repos: ProjectInput["repos"]; requested_by: string; state: string }>(
    "SELECT id, slug, name, description, repos, requested_by, state FROM project_requests WHERE id = $1",
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
  const res = await createProject(ctx, { slug, name: opts.name ?? r.name, description: r.description, components: r.repos ?? [] }, { owners });
  await ctx.db.query("UPDATE project_requests SET state = 'approved', decided_by = $2, decided_at = now(), slug = $3 WHERE id = $1", [id, ctx.actor.id, slug]);
  await audit(ctx.db, ctx.actor.id, "approve_project_request", res.id);
  track(
    notify(ctx.db, ctx.settings, [r.requested_by], {
      kind: "decided",
      title: `Project created: ${opts.name ?? r.name}`,
      body: `Your request was approved. The project is '${slug}'.`,
      link: `#/project/${slug}`,
    }, { exclude: ctx.actor.id }).catch(() => undefined),
  );
  return { status: "approved", project: slug };
}

export async function declineProjectRequest(ctx: RequestContext, id: string, note: string) {
  const r = await pendingRequest(ctx, id);
  if (!note.trim()) throw new ValidationError("say why (the requester sees it)");
  await ctx.db.query("UPDATE project_requests SET state = 'declined', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1", [id, ctx.actor.id, note.trim()]);
  await audit(ctx.db, ctx.actor.id, "decline_project_request", null);
  track(
    notify(ctx.db, ctx.settings, [r.requested_by], {
      kind: "decided",
      title: `Project request declined: ${r.name}`,
      body: note.trim(),
      link: "#/review?tab=projects",
    }, { exclude: ctx.actor.id }).catch(() => undefined),
  );
  return { status: "declined" };
}

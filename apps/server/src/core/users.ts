import type { Settings } from "../config.js";
import { withTx, type Db, type Queryable } from "../db/pool.js";
import { createLocalUser, resetPassword, updateUser, type LocalUser } from "../auth/local.js";
import { accountStatus } from "./accounts.js";
import { resolvePerson } from "./access.js";
import { audit } from "./audit.js";
import { ForbiddenError, nameOf, NotFoundError, ValidationError, type Actor, type RequestContext } from "./context.js";
import { notify } from "./notify.js";
import { assertCanManage, can, isAdmin, readableScopes } from "./permissions.js";
import { keepingProjectAdmins, type ProjectsWithoutAdmin } from "./project-admins.js";
import { ensureServiceAccount } from "./service-accounts.js";
import {
  ADMIN_ROLE,
  applyUserRoles,
  assertCan,
  assertMayGrant,
  canSeeAccess,
  idsWithPermission,
  listRoles,
  namesOf,
  ORG_KEYS,
  orgRolesOf,
  planUserRoles,
  resolveRoles,
  roleChangeFrom,
  type Role,
  type RoleChange,
  type UserRolesPlan,
} from "./roles.js";
import { getReadableScope, type Scope } from "./scopes.js";

const ACTOR_COLUMNS = `id, subject, email, display_name AS name, kind, is_admin AS "isAdmin", disabled_at IS NOT NULL AS disabled, must_change_password AS "mustChangePassword",
  approved_at IS NOT NULL AS approved,
  ARRAY(SELECT DISTINCT p FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org', unnest(r.permissions) AS p WHERE ur.user_id = users.id) AS permissions`;

/** An account as a request's actor (with its organisation permissions), e.g. for one-click email actions. */
export async function actorById(db: Queryable, id: string): Promise<Actor | undefined> {
  const { rows } = await db.query<Actor>(`SELECT ${ACTOR_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * Finds or creates the user for an authenticated identity, and notes when it was last used.
 * - A placeholder created by an admin granting a role by email ("pending:<email>") is claimed on that person's first sign-in.
 * - Someone with a built-in account who signs in another way (Cloudflare Access, a dev token) uses that account:
 *   one person, one account, with its rights and memberships.
 * - With `approval`, someone seen for the first time starts unapproved (`created` is then set so admins can be told);
 *   without it, anyone still waiting is approved as they sign in.
 * - A `name` from the sign-in (Cloudflare Access claims) fills in an account that has no name yet; a name someone set
 *   is never overwritten, and a name the person cleared themselves stays cleared.
 */
export async function upsertUser(
  db: Queryable,
  identity: { subject: string; email: string | null; kind: Actor["kind"]; name?: string | null },
  opts: { approval?: boolean } = {},
): Promise<Actor & { created?: boolean }> {
  const approval = !!opts.approval;
  const name = identity.kind === "human" ? safeName(identity.name) : null;
  const touch = (approvalParam: string, nameParam: string) =>
    `last_seen_at = now(), approved_at = CASE WHEN ${approvalParam}::boolean THEN approved_at ELSE coalesce(approved_at, now()) END,
     display_name = CASE WHEN name_self_set THEN display_name ELSE coalesce(display_name, ${nameParam}::text) END`;
  const known = await db.query<Actor>(
    `UPDATE users SET ${touch("$2", "$4")}, email = coalesce($3, email) WHERE subject = $1 RETURNING ${ACTOR_COLUMNS}`,
    [identity.subject, approval, identity.email, name],
  );
  if (known.rows[0]) return known.rows[0];
  if (identity.email) {
    const claimed = await db.query<Actor>(
      `UPDATE users SET subject = $1, kind = $3, ${touch("$4", "$5")} WHERE subject = 'pending:' || lower($2)
         AND NOT EXISTS (SELECT 1 FROM users WHERE subject = $1)
       RETURNING ${ACTOR_COLUMNS}`,
      [identity.subject, identity.email, identity.kind, approval, name],
    );
    // Granted a project role by an owner but not approved by an admin: they wait like anyone new, and admins are told.
    if (claimed.rows[0]) return { ...claimed.rows[0], created: !claimed.rows[0].approved };
    if (!identity.subject.startsWith("local:")) {
      const linked = await db.query<Actor>(`UPDATE users SET ${touch("$2", "$3")} WHERE subject = 'local:' || lower($1) RETURNING ${ACTOR_COLUMNS}`, [
        identity.email,
        approval,
        name,
      ]);
      if (linked.rows[0]) return linked.rows[0];
    }
  }
  const { rows } = await db.query<Actor & { created: boolean }>(
    `INSERT INTO users (subject, email, kind, display_name, approved_at, last_seen_at) VALUES ($1, $2, $3, $5, CASE WHEN $4::boolean THEN NULL ELSE now() END, now())
     ON CONFLICT (subject) DO UPDATE SET email = coalesce(EXCLUDED.email, users.email), display_name = CASE WHEN users.name_self_set THEN users.display_name ELSE coalesce(users.display_name, EXCLUDED.display_name) END, last_seen_at = now()
     RETURNING ${ACTOR_COLUMNS}, xmax = 0 AS created`,
    [identity.subject, identity.email, identity.kind, approval, name],
  );
  return rows[0]!;
}

// ---- Display names ------------------------------------------------------------------------------------------

export const NAME_MAX = 100;

/**
 * Characters that hide, reorder or blank out text: controls, format characters (bidi overrides, zero-width space, soft
 * hyphen, BOM, tags) except the joiners some scripts need (U+200C, U+200D), private use and unassigned code points,
 * and letters and marks that render as nothing (Hangul fillers, the braille blank, the combining grapheme joiner,
 * Mongolian and Khmer invisibles, variation selectors beyond the first 16).
 */
const HIDDEN = /[\p{Cc}\p{Co}\p{Cs}\p{Cn}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2800\u3164\uFFA0\u{E0100}-\u{E01EF}]|(?![\u200C\u200D])\p{Cf}/u;

/**
 * A display name as typed: compatibility forms folded (NFKC: fullwidth letters become plain ones), spaces collapsed and
 * trimmed; empty means no name (null). Refused: control or invisible characters, a mark with no letter to sit on or a
 * pile of them, no letter at all, an @ (it would read like an email) and more than NAME_MAX characters.
 */
export function cleanName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const name = raw.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (HIDDEN.test(name)) throw new ValidationError("a name can't contain control or invisible characters");
  if (/(^|\s)\p{M}|\p{M}{4}/u.test(name)) throw new ValidationError("a name can't start a word with an accent or pile accents on one letter");
  if (!/\p{L}/u.test(name)) throw new ValidationError("a name needs at least one letter");
  if (name.includes("@")) throw new ValidationError("a name can't contain @; use the name people know you by, e.g. 'Rita Shah'");
  if (name.length > NAME_MAX) throw new ValidationError(`a name is at most ${NAME_MAX} characters`);
  return name;
}

/** cleanName for names from elsewhere (sign-in claims): anything unusable is dropped instead of refused. */
export function safeName(raw: string | null | undefined): string | null {
  try {
    return cleanName(raw);
  } catch {
    return null;
  }
}

/**
 * Names stand for people (lists, notifications, reviews, and a full name set by a manager or the sign-in works where
 * an email is asked for in the access tools), so a name can't look like another account's name, or like the start of
 * another account's email address (which is how people without a name are shown), or be its sign-in identifier.
 * "Looks like" compares name_key (migration 034): case, accents, lookalike letters from other scripts, fullwidth forms,
 * spaces and . _ - don't tell two names apart. `self` is the account being named (by id, or by email before it exists).
 */
export async function assertNameFree(db: Queryable, name: string, self: { id?: string; email?: string }) {
  const { rows } = await db.query<{ by: "name" | "email" }>(
    `SELECT CASE WHEN name_key(display_name) = name_key($1) THEN 'name' ELSE 'email' END AS by FROM users
      WHERE id IS DISTINCT FROM $2::uuid AND lower(coalesce(email, '')) IS DISTINCT FROM lower($3::text) AND name_key($1) <> ''
        AND (name_key(display_name) = name_key($1) OR name_key(split_part(email, '@', 1)) = name_key($1) OR name_key(subject) = name_key($1))
      ORDER BY 1 DESC LIMIT 1`,
    [name, self.id ?? null, self.email ?? null],
  );
  if (rows[0]?.by === "name") throw new ValidationError(`someone else is already called ${name} (or a name that looks the same); add something that tells you apart, e.g. a middle initial or a team`);
  if (rows[0]) throw new ValidationError(`${name} is how someone else's email address starts, so people would take it for them; use a full name, e.g. 'Rita Shah'`);
}

/** assertNameFree as a yes or no. */
export async function nameIsFree(db: Queryable, name: string, self: { id?: string; email?: string }) {
  try {
    await assertNameFree(db, name, self);
    return true;
  } catch (err) {
    if (err instanceof ValidationError) return false;
    throw err;
  }
}

/** Serialises name changes, so two people can't both take a free name at the same moment (inside a transaction). */
export async function lockNames(tx: Queryable) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext('users.display_name'))");
}

/** Saves the caller's own display name (null clears it), after checking it's free; marked as chosen by them. */
async function saveOwnName(db: Db, userId: string, raw: string | null) {
  const name = cleanName(raw);
  return withTx(db, async (tx) => {
    await lockNames(tx);
    if (name) await assertNameFree(tx, name, { id: userId });
    const before = (await tx.query<{ name: string | null }>("SELECT display_name AS name FROM users WHERE id = $1 FOR UPDATE", [userId])).rows[0];
    if (!before) throw new NotFoundError(`user ${userId}`);
    const { rows } = await tx.query<{ id: string; email: string | null; name: string | null }>(
      "UPDATE users SET display_name = $2, name_self_set = true WHERE id = $1 RETURNING id, email, display_name AS name",
      [userId, name],
    );
    return { ...rows[0]!, before: before.name };
  });
}

/** Sets (or, with null or "", clears) the caller's own display name. People only: service accounts are named by Manage people. */
export async function setMyName(ctx: RequestContext, name: string | null) {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("only people set their own name; someone with Manage people names a service account (Admin › People)");
  const { before, ...saved } = await saveOwnName(ctx.db, ctx.actor.id, name);
  // Names stand for people in reviews and access lists, so a change is recorded (before and after) like a manager's rename.
  if (before !== saved.name) {
    await audit(ctx.db, ctx.actor.id, "set_my_name", ctx.actor.id, {
      targetKind: "person",
      targetLabel: saved.email,
      details: { name_before: before, name_after: saved.name },
    });
  }
  return saved;
}

// ---- Approval -----------------------------------------------------------------------------------------------

/** Whether new identities need approval. ADMIN_EMAILS never wait (someone has to approve the rest). */
export function approvalRequired(identity: { email: string | null }, settings: Settings) {
  return settings.requireApproval && !(identity.email && settings.adminEmails.includes(identity.email.toLowerCase()));
}

/** Tells every admin that someone new is waiting; any one of them can approve. */
export async function announceAccessRequest(db: Queryable, settings: Settings, actor: Actor) {
  const who = actor.email ? (actor.name ? `${actor.name} (${actor.email})` : actor.email) : `Service ${actor.subject.replace(/^[a-z-]+:/, "")}`;
  await notify(db, settings, await idsWithPermission(db, settings, "manage_users"), {
    kind: "access",
    title: `${who} is waiting for access`,
    body: `${who} signed in for the first time. Approve or decline them on the Users page.`,
    link: "#/admin/users",
    targetId: actor.id,
  });
}

// ---- Who may change an account ----------------------------------------------------------------------------------

export type AccountVerb = "reset the password of" | "disable" | "enable" | "approve" | "decline" | "rename";

/**
 * Account actions follow the no-escalation rule: approving, declining, disabling, enabling or resetting the password
 * of someone holding organisation permissions you lack is for Administrators, and only Administrators change an
 * Administrator's account. Nobody disables or declines themselves.
 */
export async function assertMayManageAccount(ctx: RequestContext, targetId: string, verb: AccountVerb) {
  assertCan(ctx, "manage_users");
  if ((verb === "disable" || verb === "decline") && targetId === ctx.actor.id) throw new ForbiddenError("you can't remove your own admin rights or disable yourself");
  const t = (
    await ctx.db.query<{ kind: string; email: string | null; subject: string; is_admin: boolean }>("SELECT kind, email, subject, is_admin FROM users WHERE id = $1", [
      targetId,
    ])
  ).rows[0];
  if (!t) throw new NotFoundError(`user ${targetId}`);
  const admin = t.kind === "human" && (t.is_admin || (!!t.email && ctx.settings.adminEmails.includes(t.email.toLowerCase())));
  if (admin && !isAdmin(ctx)) throw new ForbiddenError("only Administrators change an Administrator's account");
  const held = await ctx.db.query<Role>(
    `SELECT r.key, r.kind, r.name, r.description, r.permissions, r.builtin, r.position
       FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org' WHERE ur.user_id = $1 ORDER BY r.position`,
    [targetId],
  );
  const who = t.email ?? t.subject;
  await assertMayGrant(
    ctx,
    held.rows,
    undefined,
    (r, labels) => `you can't ${verb} ${who}: they hold ${r.name}, which includes permissions you don't have (${labels.join(", ")}); ask an Administrator`,
  );
}

/** Whether the caller may manage this account (see assertMayManageAccount), for lists. */
function mayManageAccount(ctx: RequestContext, row: { id: string; is_admin: boolean; org_permissions: string[] }) {
  if (row.id === ctx.actor.id) return false;
  if (isAdmin(ctx)) return true;
  if (row.is_admin) return false;
  const mine = ctx.actor.permissions ?? [];
  return can(ctx, "manage_users") && row.org_permissions.every((p) => mine.includes(p));
}

/** People waiting for approval, and those declined (who can still be approved later). */
export async function listAccessRequests(ctx: RequestContext) {
  if (!can(ctx, "manage_users")) throw new ForbiddenError("approving access needs Manage people (User managers and Administrators have it)");
  const { rows } = await ctx.db.query(
    `SELECT id, email, display_name AS name, subject, kind, created_at, disabled_at IS NOT NULL AS declined
       FROM users
      WHERE approved_at IS NULL AND subject NOT LIKE 'pending:%' AND NOT (lower(coalesce(email, '')) = ANY($1::text[]))
      ORDER BY disabled_at IS NOT NULL, created_at DESC LIMIT 200`,
    [ctx.settings.adminEmails],
  );
  return rows;
}

export async function approveUser(ctx: RequestContext, id: string) {
  if (!can(ctx, "manage_users")) throw new ForbiddenError("approving access needs Manage people (User managers and Administrators have it)");
  await assertMayManageAccount(ctx, id, "approve");
  const { rows } = await ctx.db.query<{ id: string; email: string | null }>(
    "UPDATE users SET approved_at = now(), approved_by = $2, disabled_at = NULL WHERE id = $1 AND approved_at IS NULL RETURNING id, email",
    [id, ctx.actor.id],
  );
  if (!rows[0]) throw new NotFoundError(`access request ${id}`);
  await audit(ctx.db, ctx.actor.id, "approve_access", id, { targetKind: "person", targetLabel: rows[0].email, details: { status: "approved" } });
  await notify(ctx.db, ctx.settings, [id], {
    kind: "decided",
    title: "You now have access to Thaliyola",
    body: `${nameOf(ctx.actor, "An admin")} approved your access.`,
    link: "#/",
    route: false,
  });
  return { id, email: rows[0].email, approved: true };
}

/** When approval is switched off: lets in everyone still waiting (not those declined). Returns how many. */
export async function approveEveryoneWaiting(ctx: RequestContext) {
  const { rows } = await ctx.db.query<{ id: string }>(
    `UPDATE users SET approved_at = now(), approved_by = $1
      WHERE approved_at IS NULL AND disabled_at IS NULL AND subject NOT LIKE 'pending:%' RETURNING id`,
    [ctx.actor.id],
  );
  if (rows.length) {
    await notify(ctx.db, ctx.settings, rows.map((r) => r.id), {
      kind: "decided",
      title: "You now have access to Thaliyola",
      body: "Sign-ups no longer need an admin's approval.",
      link: "#/",
      route: false,
    });
  }
  return rows.length;
}

/** Declining disables the account; it stays listed so an admin can still approve it later. */
export async function declineUser(ctx: RequestContext, id: string) {
  if (!can(ctx, "manage_users")) throw new ForbiddenError("approving access needs Manage people (User managers and Administrators have it)");
  await assertMayManageAccount(ctx, id, "decline");
  const { rows } = await ctx.db.query<{ id: string; email: string | null }>(
    "UPDATE users SET disabled_at = coalesce(disabled_at, now()) WHERE id = $1 AND approved_at IS NULL RETURNING id, email",
    [id],
  );
  if (!rows[0]) throw new NotFoundError(`access request ${id}`);
  await audit(ctx.db, ctx.actor.id, "decline_access", id, { targetKind: "person", targetLabel: rows[0].email, details: { status: "declined" } });
  return { id, email: rows[0].email, declined: true };
}

/** A new temporary password (local accounts); signs them out everywhere. The account rule applies. */
export async function resetAccountPassword(ctx: RequestContext, id: string) {
  await assertMayManageAccount(ctx, id, "reset the password of");
  const temporary = await resetPassword(ctx.db, id);
  // Never the temporary password itself.
  await audit(ctx.db, ctx.actor.id, "reset_password", id, { targetKind: "person", details: { signed_out_everywhere: true } });
  return { temporary_password: temporary };
}

/**
 * Changes someone's account: organisation roles (roles replaces them, never removing Administrator; or add / remove;
 * "admin"/"Administrator" adds or removes Administrator), the deprecated is_admin flag (merged into the roles), disabled,
 * and name. Everything is checked first, then written in one transaction. Disabling someone reports the projects it
 * leaves without a Project admin (it isn't refused: people must be able to off-board).
 */
export async function updatePerson(
  ctx: RequestContext,
  id: string,
  patch: { roles?: string[]; add?: string[]; remove?: string[]; isAdmin?: boolean; disabled?: boolean; name?: string | null },
): Promise<
  {
    user: LocalUser;
    roles: string[];
    role_names: string[];
    before: string[];
    added: string[];
    removed: string[];
    before_names: string[];
    added_names: string[];
    removed_names: string[];
  } & ProjectsWithoutAdmin
> {
  assertCan(ctx, "manage_users");
  const target = (
    await ctx.db.query<{ id: string; kind: string; email: string | null; display_name: string | null; is_admin: boolean; disabled_at: unknown }>(
      "SELECT id, kind, email, display_name, is_admin, disabled_at FROM users WHERE id = $1",
      [id],
    )
  ).rows[0];
  if (!target) throw new NotFoundError(`user ${id}`);
  const adminTarget = target.kind === "human" && (target.is_admin || (!!target.email && ctx.settings.adminEmails.includes(target.email.toLowerCase())));
  if (adminTarget && !isAdmin(ctx)) throw new ForbiddenError("only Administrators change an Administrator's account");

  let change: RoleChange | null = null;
  if (patch.roles !== undefined || patch.add?.length || patch.remove?.length) change = roleChangeFrom({ roles: patch.roles, add: patch.add, remove: patch.remove });
  if (patch.isAdmin !== undefined) {
    const isA = async (inputs: string[] | undefined) => (await resolveRoles(ctx.db, "org", inputs ?? [])).some((r) => r.key === ADMIN_ROLE);
    const sentAdd = !!change && ((await isA(change.set)) || (await isA(change.add)));
    const sentRemove = !!change && (await isA(change.remove));
    if ((patch.isAdmin && sentRemove) || (!patch.isAdmin && sentAdd)) throw new ValidationError("is_admin contradicts the roles you sent");
    change = patch.isAdmin ? { ...change, add: [...(change?.add ?? []), ADMIN_ROLE] } : { ...change, remove: [...(change?.remove ?? []), ADMIN_ROLE] };
  }
  const plan: UserRolesPlan | null = change ? await planUserRoles(ctx, id, change) : null;
  const disabling = patch.disabled === true && !target.disabled_at;
  const enabling = patch.disabled === false && !!target.disabled_at;
  if (disabling || enabling) await assertMayManageAccount(ctx, id, disabling ? "disable" : "enable");
  // Renaming someone else follows the account rule too (nobody renames an account with more rights than theirs).
  const name = patch.name === undefined ? undefined : cleanName(patch.name);
  if (name !== undefined && id !== ctx.actor.id) await assertMayManageAccount(ctx, id, "rename");
  if (name) await assertNameFree(ctx.db, name, { id });

  const readable = await readableScopes(ctx);
  const scopes = disabling
    ? (await ctx.db.query<{ scope_id: string }>("SELECT DISTINCT scope_id FROM scope_permissions WHERE user_id = $1 AND permission = 'manage_members'", [id])).rows.map(
        (r) => r.scope_id,
      )
    : [];
  const out = await withTx(ctx.db, async (tx) => {
    if (plan) await applyUserRoles(tx, ctx, plan);
    return keepingProjectAdmins(tx, scopes, () => updateUser(tx, ctx.actor.id, id, { disabled: patch.disabled, name }), { refuse: false, readable });
  });
  const roles = plan?.after ?? (await orgRolesOf(ctx.db, ctx.settings, id));
  await audit(ctx.db, ctx.actor.id, "update_user", id, {
    targetKind: target.kind === "service" ? "service_account" : "person",
    targetLabel: target.email ?? target.display_name,
    details: {
      ...(plan && (plan.added.length || plan.removed.length) ? { roles_before: plan.before, roles_after: plan.after, added: plan.added, removed: plan.removed } : {}),
      ...(disabling ? { account: "disabled" } : enabling ? { account: "enabled" } : {}),
      // The name as saved (cleaned), next to the one it replaced; null is no name.
      ...(name !== undefined && name !== target.display_name ? { name_before: target.display_name, name_after: name } : {}),
    },
  });
  const orgRoles = await listRoles(ctx.db, "org");
  const before = plan?.before ?? roles;
  return {
    user: out.result,
    roles,
    role_names: namesOf(orgRoles, roles),
    before,
    added: plan?.added ?? [],
    removed: plan?.removed ?? [],
    before_names: namesOf(orgRoles, before),
    added_names: namesOf(orgRoles, plan?.added ?? []),
    removed_names: namesOf(orgRoles, plan?.removed ?? []),
    projects_without_admin: out.projects_without_admin,
    other_projects_without_admin: out.other_projects_without_admin,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Enables or disables an account named by email, full name, identifier or id, with the Users page's rules (it goes
 * through updatePerson): Manage people, checked before anyone is looked up; never yourself; only Administrators for an
 * Administrator; never someone holding permissions you don't have. Disabling signs them out everywhere and revokes
 * their API tokens and connector access. People waiting for approval are decided with decide_access_request instead.
 */
export async function setAccountStatus(ctx: RequestContext, who: string, status: "enabled" | "disabled") {
  assertCan(ctx, "manage_users");
  const raw = (who ?? "").trim();
  const id = UUID.test(raw) ? raw : (await resolvePerson(ctx, raw, { exact: true })).id;
  const t = (
    await ctx.db.query<{ id: string; kind: string; email: string | null; subject: string; display_name: string | null; approved_at: unknown; disabled_at: unknown }>(
      "SELECT id, kind, email, subject, display_name, approved_at, disabled_at FROM users WHERE id = $1",
      [id],
    )
  ).rows[0];
  if (!t) throw new NotFoundError(raw, `no account for ${raw} (list_people shows everyone)`);
  const person = t.email ?? t.subject;
  if (!t.approved_at) throw new ValidationError(`${person} is waiting for approval: approve or decline them with decide_access_request`);
  const before = t.disabled_at ? ("disabled" as const) : ("enabled" as const);
  const base = { person, person_name: t.display_name ?? person, kind: t.kind, before, status };
  const verb = status === "disabled" ? "disable" : "enable";
  if (before === status) {
    // Nothing to change, but the same refusals apply.
    await assertMayManageAccount(ctx, t.id, verb);
    return { ...base, changed: false, projects_without_admin: [], other_projects_without_admin: 0, summary: `${base.person_name} was already ${status}.` };
  }
  const res = await updatePerson(ctx, t.id, { disabled: status === "disabled" });
  return {
    ...base,
    changed: true,
    projects_without_admin: res.projects_without_admin,
    other_projects_without_admin: res.other_projects_without_admin,
    summary:
      status === "disabled"
        ? `${base.person_name} can't sign in any more: their sessions, API tokens and connector access were revoked. Their roles, teams and entries stay.`
        : `${base.person_name} can sign in again. API tokens and connectors revoked when the account was disabled stay revoked.`,
  };
}

export interface NewPersonInput {
  email: string;
  name?: string;
  /** Organisation roles (keys or names); "Administrator" makes them one (Administrators only). */
  roles?: string[];
  /** @deprecated pass roles: ["Administrator"] */
  isAdmin?: boolean;
  /** A project to give them roles in (Manage access there). */
  project?: string;
  /** Their roles there (Contributor by default). */
  projectRoles?: string[];
  /** @deprecated pass projectRoles */
  role?: string;
}

interface NewPersonPlan {
  email: string;
  name: string | null;
  admin: boolean;
  orgRoles: Role[];
  scope: Scope | null;
  projectRoles: Role[];
  existing: { id: string; pending: boolean } | null;
}

/** Everything about adding someone, checked before anything is written. */
async function planNewPerson(ctx: RequestContext, input: NewPersonInput, opts: { local: boolean }): Promise<NewPersonPlan> {
  assertCan(ctx, "manage_users", "you need Manage people to add people (User managers and Administrators have it)");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ValidationError("invalid email");
  const name = cleanName(input.name);
  if (name) await assertNameFree(ctx.db, name, { email });
  const org = await resolveRoles(ctx.db, "org", input.roles ?? []);
  const admin = !!input.isAdmin || org.some((r) => r.key === ADMIN_ROLE);
  const orgRoles = org.filter((r) => r.key !== ADMIN_ROLE);
  if (admin && !isAdmin(ctx)) throw new ForbiddenError("only Administrators make or remove Administrators");
  await assertMayGrant(ctx, orgRoles);
  let scope: Scope | null = null;
  let projectRoles: Role[] = [];
  if (input.project) {
    scope = await getReadableScope(ctx, input.project);
    await assertCanManage(ctx, scope, "manage_members");
    if (input.projectRoles && !input.projectRoles.some((r) => r.trim())) throw new ValidationError("give them at least one role in the project, e.g. project_roles: ['Contributor']");
    projectRoles = await resolveRoles(ctx.db, "project", input.projectRoles ?? (input.role ? [input.role] : ["writer"]));
    await assertMayGrant(ctx, projectRoles, scope.id);
  } else if (input.projectRoles?.length) {
    throw new ValidationError("pass project with project_roles");
  }
  const found = (
    await ctx.db.query<{ id: string; pending: boolean; approved: boolean; disabled: boolean }>(
      `SELECT id, subject LIKE 'pending:%' AS pending, approved_at IS NOT NULL AS approved, disabled_at IS NOT NULL AS disabled
         FROM users WHERE kind = 'human' AND lower(email) = $1 ORDER BY subject LIKE 'pending:%', created_at LIMIT 1`,
      [email],
    )
  ).rows[0];
  if (found && !found.pending && found.approved) {
    throw new ValidationError(`${email} already has access${found.disabled ? " but is disabled; enable them in the list below" : ""}`);
  }
  // Someone already waiting is approved by adding them (with built-in sign-in, a new account is made instead).
  if (found && !found.pending && !opts.local) await assertMayManageAccount(ctx, found.id, "approve");
  return { email, name, admin, orgRoles, scope, projectRoles, existing: found ? { id: found.id, pending: found.pending } : null };
}

/** Org and project grants for a new or approved person, inside the transaction that adds them. */
async function grantNewPerson(tx: Queryable, ctx: RequestContext, plan: NewPersonPlan, userId: string) {
  for (const r of plan.orgRoles) {
    await tx.query("INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [userId, r.key, ctx.actor.id]);
  }
  for (const r of plan.projectRoles) {
    await tx.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [plan.scope!.id, userId, r.key]);
  }
}

function newPersonResult(plan: NewPersonPlan) {
  const roles = [...(plan.admin ? [ADMIN_ROLE] : []), ...plan.orgRoles.map((r) => r.key)];
  return {
    roles,
    role_names: [...(plan.admin ? ["Administrator"] : []), ...plan.orgRoles.map((r) => r.name)],
    project: plan.scope?.slug ?? null,
    project_roles: plan.projectRoles.map((r) => r.key),
  };
}

/**
 * Adds a person by email before they first sign in (Cloudflare Access, dev tokens): an approved placeholder that
 * their first sign-in claims, with organisation roles and project roles if given. Someone already waiting is approved.
 * Everything is checked first and written in one transaction.
 */
export async function addPerson(ctx: RequestContext, input: NewPersonInput) {
  const plan = await planNewPerson(ctx, input, { local: false });
  const res = await withTx(ctx.db, async (tx) => {
    let id: string;
    let status: "added" | "approved";
    if (plan.existing && !plan.existing.pending) {
      id = plan.existing.id;
      status = "approved";
      await tx.query(
        `UPDATE users SET approved_at = now(), approved_by = $2, disabled_at = NULL, display_name = coalesce($3, display_name), name_self_set = name_self_set AND $3::text IS NULL, is_admin = is_admin OR $4
          WHERE id = $1`,
        [id, ctx.actor.id, plan.name, plan.admin],
      );
    } else if (plan.existing) {
      id = plan.existing.id;
      status = "added";
      await tx.query(
        `UPDATE users SET display_name = coalesce($2, display_name), name_self_set = name_self_set AND $2::text IS NULL, is_admin = is_admin OR $3,
                approved_at = coalesce(approved_at, now()), approved_by = coalesce(approved_by, $4)
          WHERE id = $1`,
        [id, plan.name, plan.admin, ctx.actor.id],
      );
    } else {
      status = "added";
      id = (
        await tx.query<{ id: string }>(
          `INSERT INTO users (subject, email, display_name, kind, is_admin, approved_at, approved_by)
           VALUES ('pending:' || $1, $1, $2, 'human', $3, now(), $4) RETURNING id`,
          [plan.email, plan.name, plan.admin, ctx.actor.id],
        )
      ).rows[0]!.id;
    }
    await grantNewPerson(tx, ctx, plan, id);
    return { id, status };
  });
  if (res.status === "approved") {
    await notify(ctx.db, ctx.settings, [res.id], {
      kind: "decided",
      title: "You now have access to Thaliyola",
      body: `${nameOf(ctx.actor, "An admin")} approved your access.`,
      link: "#/",
      route: false,
    });
  }
  await audit(ctx.db, ctx.actor.id, "add_person", res.id, { targetKind: "person", targetLabel: plan.email, details: { status: res.status, ...newPersonResult(plan) } });
  return { id: res.id, email: plan.email, status: res.status, ...newPersonResult(plan) };
}

/**
 * Creates a built-in (local sign-in) account with a temporary password, with organisation roles and project roles if
 * given. Everything is checked first and written in one transaction.
 */
export async function createAccount(ctx: RequestContext, input: NewPersonInput) {
  const plan = await planNewPerson(ctx, input, { local: true });
  const created = await withTx(ctx.db, async (tx) => {
    const made = await createLocalUser(tx, { email: plan.email, name: plan.name ?? undefined, isAdmin: plan.admin });
    await tx.query("UPDATE users SET approved_at = coalesce(approved_at, now()), approved_by = coalesce(approved_by, $2) WHERE id = $1", [made.user.id, ctx.actor.id]);
    await grantNewPerson(tx, ctx, plan, made.user.id);
    return made;
  });
  // Never the temporary password.
  await audit(ctx.db, ctx.actor.id, "create_user", created.user.id, { targetKind: "person", targetLabel: plan.email, details: newPersonResult(plan) });
  return { user: created.user, temporary_password: created.temporaryPassword, ...newPersonResult(plan) };
}

/**
 * Every account that can use Thaliyola (any sign-in: local, Cloudflare Access, services), for User managers and
 * Administrators. People added by email who haven't signed in yet are included (`pending`); people still waiting for
 * approval are listed separately (listAccessRequests). `roles` are organisation roles, 'admin' first for Administrators.
 */
export async function listPeople(ctx: RequestContext, opts: { query?: string } = {}) {
  assertCan(ctx, "manage_users");
  const q = (opts.query ?? "").trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const { rows } = await ctx.db.query<{
    id: string;
    is_admin: boolean;
    roles: string[];
    org_permissions: string[];
    subject: string;
    approved_at: unknown;
    disabled_at: unknown;
  }>(
    `SELECT u.id, coalesce(u.email, u.subject) AS email, u.display_name, u.kind, u.must_change_password, u.disabled_at, u.created_at,
            u.kind = 'human' AND (u.is_admin OR lower(u.email) = ANY($1::text[])) AS is_admin,
            u.kind = 'human' AND lower(u.email) = ANY($1::text[]) AS admin_by_config,
            u.subject LIKE 'local:%' AS local, u.subject LIKE 'pending:%' AS pending,
            ARRAY(SELECT ur.role FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org' WHERE ur.user_id = u.id ORDER BY r.position, r.name) AS roles,
            ARRAY(SELECT DISTINCT p FROM user_roles ur JOIN roles r ON r.key = ur.role AND r.kind = 'org', unnest(r.permissions) AS p WHERE ur.user_id = u.id) AS org_permissions,
            greatest(u.last_seen_at, (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id), (SELECT max(last_used_at) FROM api_tokens t WHERE t.user_id = u.id)) AS last_seen_at,
            u.subject, u.approved_at
       FROM users u
      WHERE u.approved_at IS NOT NULL
        AND ($2 = '' OR lower(coalesce(u.email, '')) LIKE '%' || $2 || '%' OR lower(u.subject) LIKE '%' || $2 || '%'
             OR lower(coalesce(u.display_name, '')) LIKE '%' || $2 || '%')
      ORDER BY u.kind, u.email`,
    [ctx.settings.adminEmails, q],
  );
  const roles = await listRoles(ctx.db, "org");
  return rows.map(({ org_permissions, subject, approved_at, ...u }) => {
    const keys = u.is_admin ? [ADMIN_ROLE, ...u.roles] : u.roles;
    return {
      ...u,
      roles: keys,
      role_names: namesOf(roles, keys),
      status: accountStatus({ subject, approved_at, disabled_at: u.disabled_at }),
      can_manage_account: mayManageAccount(ctx, { id: u.id, is_admin: u.is_admin, org_permissions: u.is_admin ? [...ORG_KEYS] : org_permissions }),
    };
  });
}

// ---- Directory ------------------------------------------------------------------------------------------------

/**
 * People to pick from when adding someone to a project or team: active accounts and people added ahead of their
 * first sign-in, matched on email or name, most recently active first. Names and emails only, for signed-in people
 * (not service identities); nobody waiting for approval or disabled.
 */
export async function findPeople(ctx: RequestContext, query: string, limit = 20) {
  if (ctx.actor.kind !== "human") throw new ForbiddenError("only people look others up");
  const q = query.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  const { rows } = await ctx.db.query<{ id: string; email: string; name: string | null; pending: boolean }>(
    `SELECT u.id, u.email, u.display_name AS name, u.subject LIKE 'pending:%' AS pending
       FROM users u
      WHERE u.kind = 'human' AND u.email IS NOT NULL AND u.approved_at IS NOT NULL AND u.disabled_at IS NULL
        AND ($1 = '' OR lower(u.email) LIKE '%' || $1 || '%' OR lower(coalesce(u.display_name, '')) LIKE '%' || $1 || '%')
      ORDER BY (lower(u.email) LIKE $1 || '%' OR lower(coalesce(u.display_name, '')) LIKE $1 || '%') DESC,
               u.last_seen_at DESC NULLS LAST, u.email
      LIMIT $2`,
    [q, Math.min(Math.max(limit, 1), 50)],
  );
  // The account id (to open someone's access page) only for those who may see other people's access.
  const ids = canSeeAccess(ctx);
  return rows.map(({ id, ...p }) => (ids ? { id, ...p } : p));
}

// ---- Accounts Thaliyola acts as ---------------------------------------------------------------------------------

export { SYSTEM_ACCOUNTS } from "./service-accounts.js";

/** The id of the service account `service:<name>`, created on first use (scripts, scheduled jobs). */
export async function serviceUserId(db: Queryable, name: string, displayName?: string): Promise<string> {
  return ensureServiceAccount(db, name, { displayName });
}

/**
 * "Thaliyola sync": the author of what Thaliyola writes by itself from connections (synced schemas and API
 * contracts). A service identity, so it never approves anything and never appears as a person.
 */
export async function systemActor(db: Queryable): Promise<Actor> {
  const id = await serviceUserId(db, "thaliyola-sync", "Thaliyola sync");
  if (!retired.has(db)) {
    await retireSystemAccess(db, id);
    retired.add(db);
  }
  return { id, subject: "service:thaliyola-sync", email: null, kind: "service", approved: true };
}

const retired = new WeakSet<Queryable>();

/**
 * The system account never signs in and holds no roles of its own. A service account that happened to be called
 * thaliyola-sync before the name was reserved would otherwise keep its tokens and roles while being hidden from
 * Administrators (it isn't listed any more), so whatever it had is taken away, once per process.
 */
async function retireSystemAccess(db: Queryable, id: string) {
  await db.query("UPDATE api_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
  await db.query("UPDATE oauth_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
  await db.query("DELETE FROM user_roles WHERE user_id = $1", [id]);
  await db.query("DELETE FROM scope_members WHERE user_id = $1", [id]);
  await db.query("DELETE FROM team_members WHERE user_id = $1", [id]);
  await db.query("UPDATE users SET is_admin = false WHERE id = $1 AND is_admin", [id]);
}

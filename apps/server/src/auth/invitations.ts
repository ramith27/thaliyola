import { createHash, randomBytes } from "node:crypto";
import type { Settings } from "../config.js";
import { NotFoundError, ValidationError } from "../core/context.js";
import { sendEmail } from "../core/notify.js";
import { resolveRoles } from "../core/roles.js";
import type { Db, Queryable } from "../db/pool.js";
import { withTx } from "../db/pool.js";
import { assertNameFree, cleanName, lockNames, nameIsFree, safeName } from "../core/users.js";
import { createLocalUser } from "./local.js";

/**
 * Invitations for local sign-in: a User manager or Administrator enters an email, Thaliyola emails a one-time link,
 * and the invitee sets their own password (no temporary password to pass around). An invitation into a project can
 * carry several project roles. Links are stored hashed and expire.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const INVITE_DAYS = 7;

export async function createInvitation(
  db: Db,
  settings: Settings,
  inviterId: string,
  input: { email: string; name?: string; scope?: string; roles?: string[]; role?: string },
) {
  if (settings.authMode !== "local") throw new ValidationError("invitations need local sign-in (AUTH_MODE=local); with SSO, people just sign in");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("invalid email");
  const existing = await db.query("SELECT 1 FROM users WHERE subject = $1", [`local:${email}`]);
  if (existing.rowCount) throw new ValidationError(`${email} already has an account`);
  let scopeId: string | null = null;
  let roles: string[] = [];
  if (input.scope) {
    const s = await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1", [input.scope]);
    if (!s.rows[0]) throw new NotFoundError(`scope ${input.scope}`);
    scopeId = s.rows[0].id;
    if (input.roles && !input.roles.some((r) => r.trim())) throw new ValidationError("give them at least one role in the project, e.g. roles: ['Contributor']");
    roles = (await resolveRoles(db, "project", input.roles ?? (input.role ? [input.role] : ["writer"]))).map((r) => r.key);
  }
  const name = cleanName(input.name);
  if (name) await assertNameFree(db, name, { email });
  const token = randomBytes(32).toString("base64url");
  // A new invitation replaces any open one for the same address.
  await db.query("UPDATE invitations SET revoked_at = now() WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [email]);
  const { rows } = await db.query<{ id: string; expires_at: string }>(
    `INSERT INTO invitations (email, name, token_hash, invited_by, scope_id, scope_role, scope_roles, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8)) RETURNING id, expires_at`,
    [email, name, sha256(token), inviterId, scopeId, roles[0] ?? null, roles, INVITE_DAYS],
  );
  const inviter = (await db.query<{ name: string }>("SELECT coalesce(display_name, email) AS name FROM users WHERE id = $1", [inviterId])).rows[0]?.name ?? "A teammate";
  const link = `#/invite/${token}`;
  const emailed = sendEmail(settings, email, {
    subject: `${inviter} invited you to Thaliyola`,
    body: `${inviter} invited you to your team's knowledge base on Thaliyola${input.scope ? ` (${input.scope})` : ""}. Choose a password to finish setting up your account. The link works once and expires in ${INVITE_DAYS} days.`,
    link,
    openLabel: "Accept invitation",
    footer: "If you weren't expecting this, you can ignore it.",
  });
  return {
    id: rows[0]!.id,
    email,
    expires_at: rows[0]!.expires_at,
    emailed,
    // Shown to the admin so they can share it another way when email isn't set up.
    link: settings.publicUrl ? `${settings.publicUrl}/${link}` : link,
  };
}

export async function listInvitations(db: Queryable) {
  const { rows } = await db.query(
    `SELECT i.id, i.email, i.name, i.created_at, i.expires_at, i.accepted_at, coalesce(u.display_name, u.email) AS invited_by, s.slug AS scope, s.name AS scope_name,
            i.scope_role, i.scope_roles,
            ARRAY(SELECT coalesce(r.name, k.key) FROM unnest(i.scope_roles) WITH ORDINALITY AS k (key, n) LEFT JOIN roles r ON r.key = k.key ORDER BY k.n) AS scope_role_names,
            CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted' WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN i.expires_at < now() THEN 'expired' ELSE 'open' END AS state
       FROM invitations i JOIN users u ON u.id = i.invited_by LEFT JOIN scopes s ON s.id = i.scope_id
      ORDER BY i.created_at DESC LIMIT 200`,
  );
  return rows;
}

export async function revokeInvitation(db: Queryable, id: string) {
  const { rowCount } = await db.query("UPDATE invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [id]);
  if (!rowCount) throw new NotFoundError(`open invitation ${id}`);
  return { id, state: "revoked" };
}

async function openInvitation(db: Queryable, token: string, lock = false) {
  const { rows } = await db.query<{
    id: string;
    email: string;
    name: string | null;
    scope_id: string | null;
    scope_role: string | null;
    scope_roles: string[];
    inviter: string;
  }>(
    `SELECT i.id, i.email, i.name, i.scope_id, i.scope_role, i.scope_roles, coalesce(u.display_name, u.email) AS inviter
       FROM invitations i JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now() ${lock ? "FOR UPDATE OF i" : ""}`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

/** What the accept page shows; null when the link is unknown, used, revoked or expired. */
export async function describeInvitation(db: Queryable, token: string) {
  const inv = await openInvitation(db, token);
  return inv ? { email: inv.email, name: inv.name, inviter: inv.inviter } : null;
}

/** Creates the account with the invitee's password and returns the user id, or null if the link is no longer valid. */
export async function acceptInvitation(db: Db, token: string, input: { password: string; name?: string }) {
  return withTx(db, async (tx) => {
    const inv = await openInvitation(tx, token, true);
    if (!inv) return null;
    // A name the invitee types is checked like any name they choose, and marked as theirs. The one on the invitation came
    // from a manager and was free then; someone may have taken it since, and then the account starts without a name.
    await lockNames(tx);
    const own = cleanName(input.name);
    if (own) await assertNameFree(tx, own, { email: inv.email });
    let given = own ? null : safeName(inv.name);
    if (given && !(await nameIsFree(tx, given, { email: inv.email }))) given = null;
    const { user } = await createLocalUser(tx, { email: inv.email, name: own ?? given ?? undefined, password: input.password });
    if (own) await tx.query("UPDATE users SET name_self_set = true WHERE id = $1", [user.id]);
    if (inv.scope_id) {
      // scope_roles is the only source (migration 033 copied scope_role into it). deleteRole strips a deleted role from
      // it, so a new role reusing the key gives nothing; only roles that still exist as project roles are given.
      const { rows: still } = await tx.query<{ key: string }>("SELECT key FROM roles WHERE kind = 'project' AND key = ANY ($1::text[])", [inv.scope_roles]);
      for (const { key } of still) {
        await tx.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [inv.scope_id, user.id, key]);
      }
    }
    await tx.query("UPDATE invitations SET accepted_at = now() WHERE id = $1", [inv.id]);
    return { userId: user.id, email: inv.email };
  });
}

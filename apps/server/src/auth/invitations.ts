import { createHash, randomBytes } from "node:crypto";
import type { Settings } from "../config.js";
import { NotFoundError, ValidationError } from "../core/context.js";
import { sendEmail } from "../core/notify.js";
import type { Db, Queryable } from "../db/pool.js";
import { withTx } from "../db/pool.js";
import { createLocalUser } from "./local.js";

/**
 * Invitations for local sign-in: an admin enters an email, Cairn emails a
 * one-time link, and the invitee sets their own password (no temporary
 * password to pass around). Links are stored hashed and expire.
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const INVITE_DAYS = 7;

export async function createInvitation(
  db: Db,
  settings: Settings,
  inviterId: string,
  input: { email: string; name?: string; scope?: string; role?: "reader" | "writer" | "owner" },
) {
  if (settings.authMode !== "local") throw new ValidationError("invitations need local sign-in (AUTH_MODE=local); with SSO, people just sign in");
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ValidationError("invalid email");
  const existing = await db.query("SELECT 1 FROM users WHERE subject = $1", [`local:${email}`]);
  if (existing.rowCount) throw new ValidationError(`${email} already has an account`);
  let scopeId: string | null = null;
  if (input.scope) {
    const s = await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1", [input.scope]);
    if (!s.rows[0]) throw new NotFoundError(`scope ${input.scope}`);
    scopeId = s.rows[0].id;
  }
  const token = randomBytes(32).toString("base64url");
  // A new invitation replaces any open one for the same address.
  await db.query("UPDATE invitations SET revoked_at = now() WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [email]);
  const { rows } = await db.query<{ id: string; expires_at: string }>(
    `INSERT INTO invitations (email, name, token_hash, invited_by, scope_id, scope_role, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7)) RETURNING id, expires_at`,
    [email, input.name?.trim() || null, sha256(token), inviterId, scopeId, scopeId ? (input.role ?? "writer") : null, INVITE_DAYS],
  );
  const inviter = (await db.query<{ name: string }>("SELECT coalesce(display_name, email) AS name FROM users WHERE id = $1", [inviterId])).rows[0]?.name ?? "A teammate";
  const link = `#/invite/${token}`;
  const emailed = sendEmail(settings, email, {
    subject: `${inviter} invited you to Cairn`,
    body: `${inviter} invited you to your team's knowledge base on Cairn${input.scope ? ` (${input.scope})` : ""}. Choose a password to finish setting up your account. The link works once and expires in ${INVITE_DAYS} days.`,
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
    `SELECT i.id, i.email, i.name, i.created_at, i.expires_at, i.accepted_at, coalesce(u.display_name, u.email) AS invited_by, s.slug AS scope, i.scope_role,
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
  const { rows } = await db.query<{ id: string; email: string; name: string | null; scope_id: string | null; scope_role: string | null; inviter: string }>(
    `SELECT i.id, i.email, i.name, i.scope_id, i.scope_role, coalesce(u.display_name, u.email) AS inviter
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
    const { user } = await createLocalUser(tx, { email: inv.email, name: input.name?.trim() || inv.name || undefined, password: input.password });
    if (inv.scope_id) {
      await tx.query(
        `INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (scope_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [inv.scope_id, user.id, inv.scope_role],
      );
    }
    await tx.query("UPDATE invitations SET accepted_at = now() WHERE id = $1", [inv.id]);
    return { userId: user.id, email: inv.email };
  });
}

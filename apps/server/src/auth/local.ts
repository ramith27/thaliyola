import { createHash, randomBytes } from "node:crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "../core/context.js";
import { withTx, type Db, type Queryable } from "../db/pool.js";
import { checkPasswordStrength, generatePassword, hashPassword, verifyPassword } from "./passwords.js";

/**
 * Built-in accounts for AUTH_MODE=local: users with scrypt password hashes,
 * browser sessions (random token in an HttpOnly cookie, stored hashed) and
 * personal API tokens for MCP clients (stored hashed, shown once).
 */

export const SESSION_COOKIE = "thaliyola_session";
export const API_TOKEN_PREFIX = "thaliyola_pat_";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface LocalUser {
  id: string;
  email: string;
  display_name: string | null;
  is_admin: boolean;
  must_change_password: boolean;
  disabled_at: string | null;
  created_at: string;
}

const USER_COLUMNS = "id, email, display_name, is_admin, must_change_password, disabled_at, created_at";

// ---- Users -----------------------------------------------------------------

/** Creates (or claims a placeholder for) a local account. Without a password, a temporary one is generated. */
export async function createLocalUser(
  db: Queryable,
  input: { email: string; name?: string; isAdmin?: boolean; password?: string },
): Promise<{ user: LocalUser; temporaryPassword: string | null }> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ValidationError("invalid email");
  const temporary = input.password ? null : generatePassword();
  const password = input.password ?? temporary!;
  const weak = checkPasswordStrength(password);
  if (weak) throw new ValidationError(weak);
  const hash = await hashPassword(password);

  const existing = await db.query<{ id: string; subject: string }>("SELECT id, subject FROM users WHERE subject IN ($1, $2)", [
    `local:${email}`,
    `pending:${email}`,
  ]);
  const row = existing.rows.find((r) => r.subject === `local:${email}`) ?? existing.rows[0];
  if (row?.subject === `local:${email}`) throw new ValidationError(`a user with email ${email} already exists`);

  const { rows } = row
    ? await db.query<LocalUser>(
        `UPDATE users SET subject = $2, display_name = coalesce($3, display_name), name_self_set = name_self_set AND $3::text IS NULL, is_admin = $4, password_hash = $5,
                must_change_password = $6, kind = 'human' WHERE id = $1 RETURNING ${USER_COLUMNS}`,
        [row.id, `local:${email}`, input.name ?? null, !!input.isAdmin, hash, !!temporary],
      )
    : await db.query<LocalUser>(
        `INSERT INTO users (subject, email, display_name, kind, is_admin, password_hash, must_change_password)
         VALUES ($1, $2, $3, 'human', $4, $5, $6) RETURNING ${USER_COLUMNS}`,
        [`local:${email}`, email, input.name ?? null, !!input.isAdmin, hash, !!temporary],
      );
  return { user: rows[0]!, temporaryPassword: temporary };
}

export async function listLocalUsers(db: Queryable): Promise<(LocalUser & { last_seen_at: string | null })[]> {
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS.split(", ").map((c) => `u.${c}`).join(", ")},
            (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at
       FROM users u WHERE u.subject LIKE 'local:%' ORDER BY u.email`,
  );
  return rows;
}

async function localUserById(db: Queryable, id: string): Promise<LocalUser & { password_hash: string | null }> {
  const { rows } = await db.query(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE id = $1 AND subject LIKE 'local:%'`, [id]);
  if (!rows[0]) throw new NotFoundError(`local user ${id}`);
  return rows[0];
}

/** New temporary password (must be changed at next login); signs the user out everywhere. */
export async function resetPassword(db: Db, userId: string): Promise<string> {
  await localUserById(db, userId);
  const temporary = generatePassword();
  await db.query("UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1", [userId, await hashPassword(temporary)]);
  await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  return temporary;
}

export async function changePassword(db: Db, userId: string, current: string, next: string, keepSessionHash?: string) {
  const user = await localUserById(db, userId);
  if (!(await verifyPassword(current, user.password_hash))) throw new ValidationError("current password is incorrect");
  const weak = checkPasswordStrength(next);
  if (weak) throw new ValidationError(weak);
  if (current === next) throw new ValidationError("choose a different password");
  await db.query("UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1", [userId, await hashPassword(next)]);
  // Other sessions are signed out; the one changing the password stays.
  await db.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> coalesce($2, '')", [userId, keepSessionHash ?? null]);
}

/**
 * Changes to any account (local or not): the admin flag, disabled, name (null clears it; undefined keeps it; a name set
 * here counts as set by a manager, not chosen by the person). Callers check who may and clean the name (core/users.ts
 * updatePerson).
 */
export async function updateUser(db: Queryable, actorId: string, userId: string, patch: { isAdmin?: boolean; disabled?: boolean; name?: string | null }) {
  const found = await db.query<{ kind: string }>("SELECT kind FROM users WHERE id = $1", [userId]);
  if (!found.rows[0]) throw new NotFoundError(`user ${userId}`);
  if (patch.isAdmin && found.rows[0].kind !== "human") throw new ValidationError("only people can be admins");
  if (actorId === userId && (patch.isAdmin === false || patch.disabled === true)) {
    throw new ForbiddenError("you can't remove your own admin rights or disable yourself");
  }
  const { rows } = await db.query<LocalUser>(
    `UPDATE users SET is_admin = coalesce($2, is_admin),
            disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN coalesce(disabled_at, now()) ELSE NULL END,
            display_name = CASE WHEN $5::boolean THEN $4::text ELSE display_name END,
            name_self_set = name_self_set AND NOT $5::boolean
      WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [userId, patch.isAdmin ?? null, patch.disabled ?? null, patch.name ?? null, patch.name !== undefined],
  );
  if (patch.disabled) {
    await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await db.query("UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1", [userId]);
    await db.query("UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1", [userId]);
  }
  return rows[0]!;
}

// ---- Sessions ----------------------------------------------------------------

export async function login(db: Db, email: string, password: string, opts: { ttlHours: number; userAgent?: string }) {
  const { rows } = await db.query<{ id: string; password_hash: string | null; disabled_at: string | null; must_change_password: boolean }>(
    "SELECT id, password_hash, disabled_at, must_change_password FROM users WHERE subject = $1",
    [`local:${normalizeEmail(email)}`],
  );
  const user = rows[0];
  // Hash even for unknown users so timing doesn't reveal which emails exist.
  const ok = await verifyPassword(password, user?.password_hash ?? "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  if (!user || !ok || user.disabled_at) return null;
  const token = await startSession(db, user.id, opts);
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  return { token, userId: user.id, mustChangePassword: user.must_change_password };
}

/** A new browser session for an account (password or OpenID Connect sign-in); returns the cookie value. */
export async function startSession(db: Queryable, userId: string, opts: { ttlHours: number; userAgent?: string }) {
  const token = randomToken();
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(hours => $3), $4)", [
    sha256(token),
    userId,
    opts.ttlHours,
    (opts.userAgent ?? "").slice(0, 300),
  ]);
  return token;
}

export async function logout(db: Db, token: string) {
  await db.query("DELETE FROM sessions WHERE token_hash = $1", [sha256(token)]);
}

export function sessionHash(token: string) {
  return sha256(token);
}

/** The signed-in user for a session cookie, or null if unknown, expired or disabled. */
export async function userForSession(db: Db, token: string): Promise<{ subject: string; email: string; kind: "human" } | null> {
  const { rows } = await db.query<{ subject: string; email: string; last_seen_at: Date }>(
    `SELECT u.subject, u.email, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > 5 * 60_000) {
    await db.query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1", [sha256(token)]);
  }
  return { subject: row.subject, email: row.email, kind: "human" };
}

// ---- API tokens --------------------------------------------------------------

export async function createApiToken(db: Queryable, userId: string, name: string, expiresInDays?: number) {
  const clean = name.trim().slice(0, 100);
  if (!clean) throw new ValidationError("give the token a name, e.g. 'Claude Code on laptop'");
  const token = `${API_TOKEN_PREFIX}${randomToken(30)}`;
  const { rows } = await db.query<{ id: string; created_at: string; expires_at: string | null }>(
    `INSERT INTO api_tokens (user_id, name, token_hash, prefix, expires_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(days => $5) END)
     RETURNING id, created_at, expires_at`,
    [userId, clean, sha256(token), token.slice(0, API_TOKEN_PREFIX.length + 6), expiresInDays ?? null],
  );
  return { ...rows[0]!, name: clean, token };
}

/** A working token nobody has used for this long (or never used, and this old) is flagged as unused. */
export const UNUSED_AFTER_DAYS = 90;

/**
 * Token columns for lists: never the hash. `unused` flags a working token not used for UNUSED_AFTER_DAYS (or never
 * used and older than that); `rotated_at` / `replaced_by` mark a token replaced by rotation (it works until expires_at).
 */
export const TOKEN_LIST_COLUMNS = `id, name, prefix, created_at, last_used_at, expires_at, revoked_at, rotated_at, replaced_by,
  (revoked_at IS NULL AND rotated_at IS NULL AND (expires_at IS NULL OR expires_at > now())
   AND coalesce(last_used_at, created_at) < now() - make_interval(days => ${UNUSED_AFTER_DAYS})) AS unused`;

export async function listApiTokens(db: Queryable, userId: string) {
  const { rows } = await db.query(
    `SELECT ${TOKEN_LIST_COLUMNS} FROM api_tokens
      WHERE user_id = $1 ORDER BY revoked_at NULLS FIRST, created_at DESC`,
    [userId],
  );
  return rows;
}

/** How long a rotated token keeps working: not at all, one day or seven days. */
export const ROTATION_GRACE_DAYS = { none: 0, "1d": 1, "7d": 7 } as const;
export type RotationGrace = keyof typeof ROTATION_GRACE_DAYS;

/**
 * Rotation: a new token with the same name and lifetime (returned once, like any new token), and the old one stops
 * at the end of the grace period (at once for "none"; never later than it would have anyway). Revoked, expired and
 * already rotated tokens can't be rotated. Callers check who may rotate whose tokens.
 */
export async function rotateApiToken(db: Db, userId: string, tokenId: string, grace: RotationGrace) {
  const days = ROTATION_GRACE_DAYS[grace];
  if (days === undefined) throw new ValidationError("grace is none, 1d or 7d");
  return withTx(db, async (tx) => {
    const { rows } = await tx.query<{ id: string; name: string; created_at: Date; expires_at: Date | null; revoked_at: Date | null; rotated_at: Date | null; expired: boolean }>(
      `SELECT id, name, created_at, expires_at, revoked_at, rotated_at, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
         FROM api_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE`,
      [tokenId, userId],
    );
    const old = rows[0];
    if (!old) throw new NotFoundError(`token ${tokenId}`);
    if (old.revoked_at) throw new ValidationError("this token was revoked; create a new one instead");
    if (old.rotated_at) throw new ValidationError("this token was already rotated; rotate its replacement instead");
    if (old.expired) throw new ValidationError("this token has expired; create a new one instead");
    const lifetime = old.expires_at ? Math.max(1, Math.round((old.expires_at.getTime() - old.created_at.getTime()) / 86_400_000)) : undefined;
    const created = await createApiToken(tx, userId, old.name, lifetime);
    const { rows: updated } = await tx.query<{ expires_at: Date }>(
      `UPDATE api_tokens SET rotated_at = now(), replaced_by = $2,
              expires_at = CASE WHEN $3::int = 0 THEN now() ELSE least(coalesce(expires_at, 'infinity'::timestamptz), now() + make_interval(days => $3)) END
        WHERE id = $1 RETURNING expires_at`,
      [old.id, created.id, days],
    );
    return {
      ...created,
      lifetime_days: lifetime ?? null,
      replaced: { id: old.id, name: old.name, grace, works_until: days ? updated[0]!.expires_at : null },
    };
  });
}

export async function revokeApiToken(db: Queryable, userId: string, tokenId: string) {
  const { rows } = await db.query<{ name: string }>("UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING name", [
    tokenId,
    userId,
  ]);
  if (!rows[0]) throw new NotFoundError(`token ${tokenId}`);
  return { id: tokenId, name: rows[0].name, revoked: true };
}

/** The owner of a valid API token. Works in every auth mode (e.g. scheduled jobs behind Cloudflare). */
export async function userForApiToken(db: Db, token: string): Promise<{ subject: string; email: string | null; kind: "human" | "service" } | null> {
  if (!token.startsWith(API_TOKEN_PREFIX)) return null;
  const { rows } = await db.query<{ id: string; subject: string; email: string | null; kind: "human" | "service"; last_used_at: Date | null }>(
    `SELECT t.id, u.subject, u.email, u.kind, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > now()) AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
    await db.query("UPDATE api_tokens SET last_used_at = now() WHERE id = $1", [row.id]);
  }
  return { subject: row.subject, email: row.email, kind: row.kind };
}

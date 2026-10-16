import { createHash, randomBytes } from "node:crypto";
import { ForbiddenError, NotFoundError, ValidationError } from "../core/context.js";
import type { Db, Queryable } from "../db/pool.js";
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
        `UPDATE users SET subject = $2, display_name = coalesce($3, display_name), is_admin = $4, password_hash = $5,
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

export async function updateLocalUser(db: Db, actorId: string, userId: string, patch: { isAdmin?: boolean; disabled?: boolean; name?: string }) {
  await localUserById(db, userId);
  if (actorId === userId && (patch.isAdmin === false || patch.disabled === true)) {
    throw new ForbiddenError("you can't remove your own admin rights or disable yourself");
  }
  const { rows } = await db.query<LocalUser>(
    `UPDATE users SET is_admin = coalesce($2, is_admin),
            disabled_at = CASE WHEN $3::boolean IS NULL THEN disabled_at WHEN $3 THEN coalesce(disabled_at, now()) ELSE NULL END,
            display_name = coalesce($4, display_name)
      WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    [userId, patch.isAdmin ?? null, patch.disabled ?? null, patch.name ?? null],
  );
  if (patch.disabled) {
    await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await db.query("UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1", [userId]);
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
  const token = randomToken();
  await db.query("INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(hours => $3), $4)", [
    sha256(token),
    user.id,
    opts.ttlHours,
    (opts.userAgent ?? "").slice(0, 300),
  ]);
  await db.query("DELETE FROM sessions WHERE expires_at < now()");
  return { token, userId: user.id, mustChangePassword: user.must_change_password };
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

export async function listApiTokens(db: Queryable, userId: string) {
  const { rows } = await db.query(
    `SELECT id, name, prefix, created_at, last_used_at, expires_at, revoked_at FROM api_tokens
      WHERE user_id = $1 ORDER BY revoked_at NULLS FIRST, created_at DESC`,
    [userId],
  );
  return rows;
}

export async function revokeApiToken(db: Queryable, userId: string, tokenId: string) {
  const { rowCount } = await db.query("UPDATE api_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE id = $1 AND user_id = $2", [tokenId, userId]);
  if (!rowCount) throw new NotFoundError(`token ${tokenId}`);
  return { id: tokenId, revoked: true };
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

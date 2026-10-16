import type { Queryable } from "../db/pool.js";
import type { Actor } from "./context.js";

const ACTOR_COLUMNS = `id, subject, email, kind, is_admin AS "isAdmin", disabled_at IS NOT NULL AS disabled, must_change_password AS "mustChangePassword"`;

/**
 * Finds or creates the user for an authenticated identity. A placeholder
 * created by an admin granting a role by email ("pending:<email>") is claimed
 * on that person's first sign-in.
 */
export async function upsertUser(
  db: Queryable,
  identity: { subject: string; email: string | null; kind: Actor["kind"] },
): Promise<Actor> {
  if (identity.email) {
    const claimed = await db.query<Actor>(
      `UPDATE users SET subject = $1, kind = $3 WHERE subject = 'pending:' || lower($2)
         AND NOT EXISTS (SELECT 1 FROM users WHERE subject = $1)
       RETURNING ${ACTOR_COLUMNS}`,
      [identity.subject, identity.email, identity.kind],
    );
    if (claimed.rows[0]) return claimed.rows[0];
  }
  const { rows } = await db.query<Actor>(
    `INSERT INTO users (subject, email, kind) VALUES ($1, $2, $3)
     ON CONFLICT (subject) DO UPDATE SET email = coalesce(EXCLUDED.email, users.email)
     RETURNING ${ACTOR_COLUMNS}`,
    [identity.subject, identity.email, identity.kind],
  );
  return rows[0]!;
}

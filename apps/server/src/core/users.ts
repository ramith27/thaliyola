import type { Queryable } from "../db/pool.js";
import type { Actor } from "./context.js";

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
       RETURNING id, subject, email, kind`,
      [identity.subject, identity.email, identity.kind],
    );
    if (claimed.rows[0]) return claimed.rows[0];
  }
  const { rows } = await db.query<Actor>(
    `INSERT INTO users (subject, email, kind) VALUES ($1, $2, $3)
     ON CONFLICT (subject) DO UPDATE SET email = coalesce(EXCLUDED.email, users.email)
     RETURNING id, subject, email, kind`,
    [identity.subject, identity.email, identity.kind],
  );
  return rows[0]!;
}

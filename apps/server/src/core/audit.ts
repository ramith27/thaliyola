import type { Queryable } from "../db/pool.js";

export async function audit(db: Queryable, actorId: string, tool: string, targetId?: string | null): Promise<void> {
  await db.query("INSERT INTO audit_log (actor_id, tool, target_id) VALUES ($1, $2, $3)", [actorId, tool, targetId ?? null]);
}

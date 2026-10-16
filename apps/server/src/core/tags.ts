import type { Queryable } from "../db/pool.js";

const MAX_TAGS = 20;

/** Lowercase, hyphenated, de-duplicated tags, so variants of one name don't fragment results. */
export function normalizeTags(tags: string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of tags ?? []) {
    const tag = raw
      .trim()
      .replace(/^#+/, "")
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
      .replace(/[^a-z0-9.:/-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    if (tag) out.add(tag);
  }
  return [...out].slice(0, MAX_TAGS);
}

export interface EntityRef {
  kind: string;
  name: string;
}

/** Links a target to entities, matching existing names or aliases case-insensitively before creating new ones. */
export async function linkEntities(db: Queryable, target: { kind: string; id: string }, refs: EntityRef[] | undefined): Promise<void> {
  for (const ref of refs ?? []) {
    const name = ref.name.trim();
    if (!name) continue;
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM entities
        WHERE kind = $1 AND (lower(name) = lower($2) OR lower($2) = ANY(SELECT lower(a) FROM unnest(aliases) a))
        LIMIT 1`,
      [ref.kind, name],
    );
    const id =
      existing.rows[0]?.id ??
      (await db.query<{ id: string }>("INSERT INTO entities (kind, name) VALUES ($1, $2) RETURNING id", [ref.kind, name])).rows[0]!.id;
    await db.query("INSERT INTO entity_links (entity_id, target_kind, target_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [
      id,
      target.kind,
      target.id,
    ]);
  }
}

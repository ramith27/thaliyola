import { audit } from "./audit.js";
import { ValidationError, type RequestContext } from "./context.js";
import { emitChanged } from "./events.js";
import { assertCanRead, assertCanVerify } from "./permissions.js";
import { checkDate } from "./search.js";
import { findItem } from "./writes.js";

/**
 * When an article or finding is true: from (inclusive) until (exclusive). Expired items drop out of search (an
 * as_of search still finds them); a future start shows as "takes effect on". People who may verify the item set them.
 * null clears a date; a missing field keeps it.
 */
export async function setValidDates(ctx: RequestContext, input: { id: string; valid_from?: string | null; valid_until?: string | null }) {
  const item = await findItem(ctx.db, input.id);
  await assertCanRead(ctx, item.scope_id, `${item.kind} ${input.id}`);
  await assertCanVerify(ctx, item.scope_id);
  if (input.valid_from === undefined && input.valid_until === undefined) throw new ValidationError("give valid_from, valid_until, or both (null clears one)");
  const table = item.kind === "article" ? "articles" : "findings";
  const cur = (await ctx.db.query<{ valid_from: string | null; valid_until: string | null }>(`SELECT valid_from::text, valid_until::text FROM ${table} WHERE id = $1`, [item.id])).rows[0]!;
  const from = input.valid_from === undefined ? cur.valid_from : input.valid_from === null ? null : checkDate(input.valid_from);
  const until = input.valid_until === undefined ? cur.valid_until : input.valid_until === null ? null : checkDate(input.valid_until);
  if (from && until && until <= from) throw new ValidationError("valid_until must be after valid_from");
  await ctx.db.query(`UPDATE ${table} SET valid_from = $2, valid_until = $3 WHERE id = $1`, [item.id, from, until]);
  await audit(ctx.db, ctx.actor.id, "set_valid_dates", item.id, { targetKind: item.kind, targetLabel: item.title, details: { valid_from: from, valid_until: until } });
  emitChanged();
  return { id: item.id, valid_from: from, valid_until: until };
}

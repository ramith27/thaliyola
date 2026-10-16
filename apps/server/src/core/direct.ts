import type { RequestContext } from "./context.js";
import { canApprove } from "./permissions.js";
import { approveRevision } from "./review.js";
import {
  createArticle,
  findItem,
  proposeArticleEdit,
  proposeFinding,
  updateFinding,
  type ArticleEditInput,
  type CreateArticleInput,
  type ProposeFindingInput,
  type UpdateFindingInput,
} from "./writes.js";

/**
 * Edits made by people in the web UI. They go through the same validation,
 * redaction and version checks as agent proposals; when the editor may
 * approve in that scope the change is approved on the spot ("human edits
 * skip review"), otherwise it waits in the queue like any proposal.
 */

async function settle<T extends { revision_id: string }>(ctx: RequestContext, scopeId: string, proposal: T) {
  if (!(await canApprove(ctx, scopeId))) return { ...proposal, published: false };
  const approved = await approveRevision(ctx, proposal.revision_id);
  return { ...proposal, ...approved, status: "published" as const, published: true };
}

export async function editArticle(ctx: RequestContext, input: ArticleEditInput) {
  const item = await findItem(ctx.db, input.id);
  return settle(ctx, item.scope_id, await proposeArticleEdit(ctx, input));
}

export async function editFinding(ctx: RequestContext, input: UpdateFindingInput) {
  const item = await findItem(ctx.db, input.id);
  return settle(ctx, item.scope_id, await updateFinding(ctx, input));
}

export async function newArticle(ctx: RequestContext, input: CreateArticleInput) {
  const created = await createArticle(ctx, input);
  const item = await findItem(ctx.db, created.article_id);
  return settle(ctx, item.scope_id, created);
}

export async function newFinding(ctx: RequestContext, input: ProposeFindingInput) {
  const created = await proposeFinding(ctx, input);
  if (created.status !== "pending_review") return created;
  const item = await findItem(ctx.db, created.finding_id);
  return settle(ctx, item.scope_id, created);
}

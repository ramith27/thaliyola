import type { RequestContext } from "./context.js";
import { onProposal, track } from "./notify.js";
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

export async function settleProposal<T extends { revision_id: string }>(ctx: RequestContext, scopeId: string, proposal: T) {
  if (!(await canApprove(ctx, scopeId))) {
    // Not self-approvable after all: now tell the reviewers.
    if (ctx.quietProposals) track(onProposal(ctx.db, ctx.settings, proposal.revision_id).catch(() => undefined));
    return { ...proposal, published: false };
  }
  const approved = await approveRevision(ctx, proposal.revision_id);
  return { ...proposal, ...approved, status: "published" as const, published: true };
}

/** Proposals made here notify reviewers only if the editor can't approve them on the spot. */
const quiet = (ctx: RequestContext): RequestContext => ({ ...ctx, quietProposals: true });

export async function editArticle(ctx: RequestContext, input: ArticleEditInput) {
  const item = await findItem(ctx.db, input.id);
  ctx = quiet(ctx);
  return settleProposal(ctx, item.scope_id, await proposeArticleEdit(ctx, input));
}

export async function editFinding(ctx: RequestContext, input: UpdateFindingInput) {
  const item = await findItem(ctx.db, input.id);
  ctx = quiet(ctx);
  return settleProposal(ctx, item.scope_id, await updateFinding(ctx, input));
}

export async function newArticle(ctx: RequestContext, input: CreateArticleInput) {
  ctx = quiet(ctx);
  const created = await createArticle(ctx, input);
  const item = await findItem(ctx.db, created.article_id);
  return settleProposal(ctx, item.scope_id, created);
}

export async function newFinding(ctx: RequestContext, input: ProposeFindingInput) {
  ctx = quiet(ctx);
  const created = await proposeFinding(ctx, input);
  if (created.status !== "pending_review") return created;
  const item = await findItem(ctx.db, created.finding_id);
  return settleProposal(ctx, item.scope_id, created);
}

import { ForbiddenError, type RequestContext } from "./context.js";

/**
 * Approvals from Claude. A person who may review decides through Claude (MCP tools, or a REST call with a personal API
 * token or OAuth token, what Claude Code holds) with exactly the permissions they have in the web app, while the
 * "Approvals from Claude" system setting is on. Off, every such decision is refused, as in 1.0.1. Two more guards:
 * work this person wrote through Claude minutes ago waits for the user's say-so (confirmed_by_user), and skill
 * versions always need a second person when decided through Claude (core/skills/review.ts).
 */

/** How long after it was written through Claude a proposal counts as "this session's own work". */
export const FRESH_MINUTES = 10;

/** The call is Claude acting for the person: an MCP call, or a REST call with an API or OAuth token. */
export const viaClaude = (ctx: RequestContext): boolean => !!ctx.viaAgent || !!ctx.viaToken;

/** What review history records about where a decision was made (null: the web app). */
export const decidedVia = (ctx: RequestContext): "mcp" | "token" | null => (ctx.viaAgent ? "mcp" : ctx.viaToken ? "token" : null);

/** For audit details: { via: "mcp" | "token" } when decided through Claude, nothing in the web app. */
export const viaDetails = (ctx: RequestContext): { via?: "mcp" | "token" } => {
  const via = decidedVia(ctx);
  return via ? { via } : {};
};

/**
 * Read from the database, not the settings object, so switching it off stops every instance at once (the others
 * reload settings only every 30 seconds).
 */
async function stored(ctx: RequestContext, key: string): Promise<unknown> {
  const { rows } = await ctx.db.query<{ value: unknown }>("SELECT value FROM system_settings WHERE key = $1", [key]);
  return rows[0] ? rows[0].value : undefined;
}

/** Admin › System › Approvals from Claude (ALLOW_MCP_APPROVALS, on by default). */
export async function mcpApprovalsOn(ctx: RequestContext): Promise<boolean> {
  const v = await stored(ctx, "mcp_approvals");
  return v === undefined ? ctx.settings.mcpApprovals ?? true : v === true;
}

/** Admin › System › Reviewers may approve their own proposals (REVIEW_SELF_APPROVAL, on by default). */
export async function reviewSelfApprovalOn(ctx: RequestContext): Promise<boolean> {
  const v = await stored(ctx, "review_self_approval");
  return v === undefined ? ctx.settings.reviewSelfApproval ?? true : v === true;
}

export const MCP_APPROVALS_OFF = "an Administrator switched off Approvals from Claude (Admin › System)";

/**
 * Refuses a decision made through Claude while Approvals from Claude is off; the web app is never affected. With it
 * off, exactly what 1.0.1 refused is refused again: MCP calls always, and REST calls with an API or OAuth token for
 * skill reviews (`tokens`), which 1.0.1 kept for people in the web app. Proposals and releases took tokens in 1.0.1.
 */
export async function assertClaudeMayDecide(ctx: RequestContext, what: string, opts: { tokens?: boolean } = {}): Promise<void> {
  if (!ctx.viaAgent && !(opts.tokens && ctx.viaToken)) return;
  if (await mcpApprovalsOn(ctx)) return;
  throw new ForbiddenError(`${what} is a person's decision in the Thaliyola web app, not something Claude can do: ${MCP_APPROVALS_OFF}`);
}

/**
 * A proposal the caller wrote through Claude in the last FRESH_MINUTES minutes is approved over MCP only with
 * the user's explicit say-so: Claude may have written it in this same conversation, so approving it there without
 * asking would publish an agent's work with no human look at all.
 */
export function assertNotFreshOwnWork(
  ctx: RequestContext,
  row: { author_id: string | null; created_via: string | null; created_at: Date | string },
  confirmed: boolean | undefined,
  what: string,
): void {
  if (!ctx.viaAgent || confirmed) return;
  if (row.author_id !== ctx.actor.id || row.created_via !== "mcp") return;
  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > FRESH_MINUTES * 60_000) return;
  throw new ForbiddenError(
    `you wrote this ${what} through Claude ${Math.max(1, Math.round(age / 60_000))} minute(s) ago: show the user what it says and ask whether they want to approve it themselves; only if they say yes, call again with confirmed_by_user: true`,
  );
}

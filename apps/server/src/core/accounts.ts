import type { Settings } from "../config.js";

/**
 * Where an account stands, for results and lists: active, added but not signed in yet, waiting for a User manager or
 * Administrator to approve it, or disabled. A leaf module: no imports beyond types.
 */

export type AccountStatus = "active" | "not_signed_in" | "waiting_for_approval" | "disabled";

export const ACCOUNT_STATUS_TEXT: Record<AccountStatus, string> = {
  active: "active",
  not_signed_in: "hasn't signed in yet",
  waiting_for_approval: "waiting for approval",
  disabled: "disabled",
};

/** disabled_at → "disabled"; subject 'pending:%' → "not_signed_in"; approved_at null → "waiting_for_approval"; else "active". */
export function accountStatus(u: { subject: string; approved_at: unknown; disabled_at: unknown }): AccountStatus {
  if (u.disabled_at) return "disabled";
  if (u.subject.startsWith("pending:")) return "not_signed_in";
  if (!u.approved_at) return "waiting_for_approval";
  return "active";
}

/**
 * approved_at is null and approval is required: a User manager or Administrator must approve them first.
 * ADMIN_EMAILS never wait, so they never need approval.
 */
export function needsApproval(u: { approved_at: unknown; email?: string | null }, settings: Settings): boolean {
  if (u.approved_at || !settings.requireApproval) return false;
  return !(u.email && settings.adminEmails.includes(u.email.toLowerCase()));
}

/** Text for results; null when the account is active. `what` is e.g. "these roles" or "the team's access". */
export function accountNote(
  u: { email: string | null; subject: string; approved_at: unknown; disabled_at: unknown },
  settings: Settings,
  what: string,
): string | null {
  const who = u.email ?? u.subject;
  switch (accountStatus(u)) {
    case "not_signed_in":
      return `${who} hasn't signed in yet; they get ${what} when they first do${needsApproval(u, settings) ? ", once a User manager or Administrator approves them" : ""}.`;
    case "waiting_for_approval":
      return `${who} is waiting for approval; ${what} count once a User manager or Administrator approves them.`;
    case "disabled":
      return `${who}'s account is disabled; ${what} count only if it's enabled again.`;
    default:
      return null;
  }
}

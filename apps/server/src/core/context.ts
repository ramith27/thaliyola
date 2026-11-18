import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import type { Embedder } from "./embeddings.js";

export interface Actor {
  id: string;
  subject: string;
  email: string | null;
  /** Display name: set by the person (Account page, set_my_name), by someone with Manage people, or taken from the sign-in. */
  name?: string | null;
  kind: "human" | "service";
  /** Admin flag stored on the account (local mode); ADMIN_EMAILS also grants admin. */
  isAdmin?: boolean;
  disabled?: boolean;
  /** Approved by an admin (or created by one). People who arrive on their own start unapproved. */
  approved?: boolean;
  /** Signed in with a temporary password that must be changed before doing anything else. */
  mustChangePassword?: boolean;
  /** Organisation permissions from the person's organisation roles (Administrators hold all of them regardless). */
  permissions?: string[];
}

/** How a person is named in messages others read: their display name, else their email, else `fallback`. */
export function nameOf(who: { name?: string | null; email?: string | null } | null | undefined, fallback = "Someone"): string {
  return who?.name?.trim() || who?.email || fallback;
}

/**
 * How a person is named where someone decides on their work (review emails, Slack, the one-click approve page, comments):
 * "Name (email)", because anyone can choose their own name; just the email (or `fallback`) without a name.
 */
export function nameWithEmail(who: { name?: string | null; email?: string | null } | null | undefined, fallback = "Someone"): string {
  const name = who?.name?.trim();
  const email = who?.email?.trim();
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} (${email})`;
  return name || email || fallback;
}

/** Everything a core service needs to serve one call. */
export interface RequestContext {
  db: Db;
  actor: Actor;
  settings: Settings;
  /** Present when semantic search is enabled. */
  embedder?: Embedder;
  /** Wakes the background embedding indexer after a write. */
  onWrite?: () => void;
  /** Set by direct (self-approved) edits so reviewers aren't notified about a proposal that never waits. */
  quietProposals?: boolean;
  /** The writer asked for review even though they may publish directly. */
  requestReview?: boolean;
  /** Project slug from the X-Thaliyola-Project header; a tool's explicit `project` argument wins. */
  project?: string;
  /** Component slug from the X-Thaliyola-Component header. */
  component?: string;
  /** The call came through MCP: an AI agent acting for the person, not the person clicking in the app. */
  viaAgent?: boolean;
  /**
   * A REST call authenticated by a personal API token or OAuth access token (the credential Claude Code and scripts
   * hold), not a browser sign-in. Skill review decisions refuse it like viaAgent, so an agent can't approve by curl.
   */
  viaToken?: boolean;
}

export class NotFoundError extends Error {
  /** "<what> not found", unless a full message is given (e.g. "x has no roles here"). */
  constructor(what: string, message?: string) {
    super(message ?? `${what} not found`);
  }
}

export class ValidationError extends Error {}

export class ForbiddenError extends Error {}

/** A write based on a stale version; carries the current state so the caller can retry. */
export class ConflictError extends Error {
  constructor(
    message: string,
    readonly current: unknown,
  ) {
    super(message);
  }
}

import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import type { Embedder } from "./embeddings.js";

export interface Actor {
  id: string;
  subject: string;
  email: string | null;
  kind: "human" | "service";
  /** Admin flag stored on the account (local mode); ADMIN_EMAILS also grants admin. */
  isAdmin?: boolean;
  disabled?: boolean;
  /** Signed in with a temporary password that must be changed before doing anything else. */
  mustChangePassword?: boolean;
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
  /** Project slug from the X-Cairn-Project header; a tool's explicit `project` argument wins. */
  project?: string;
  /** Component slug from the X-Cairn-Component header. */
  component?: string;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
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

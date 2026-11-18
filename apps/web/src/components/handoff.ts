/**
 * Inbox → paste → editor hand-off (SPEC §5.16). Inbox stores where a draft came from before opening the paste
 * page or the editor; paste passes it on unchanged; the editor shows "From the inbox" and, after a successful
 * save, files the inbox item and clears the origin.
 *
 * Pure module: storage and the API are touched only inside the functions.
 */
import { api } from "../api";

export interface InboxOrigin {
  inbox_id: string;
  title: string;
  source_name: string;
  url: string | null;
}

const KEY = "thaliyola.inboxOrigin";

interface Stored {
  origin: InboxOrigin;
  kind: "finding" | "article";
}

function store(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Remembers the inbox item a new finding or article starts from (this tab only). */
export function setInboxOrigin(origin: InboxOrigin, kind: "finding" | "article"): void {
  try {
    store()?.setItem(KEY, JSON.stringify({ origin, kind } satisfies Stored));
  } catch {
    /* storage unavailable: the item is simply not filed automatically */
  }
}

/** The origin for this kind of draft, if one is waiting. Does not clear it. */
export function peekInboxOrigin(kind: "finding" | "article"): InboxOrigin | null {
  try {
    const raw = store()?.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Stored>;
    if (v.kind !== kind || !v.origin || typeof v.origin.inbox_id !== "string") return null;
    return v.origin;
  } catch {
    return null;
  }
}

export function clearInboxOrigin(): void {
  try {
    store()?.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Files the inbox item against what was saved, then refreshes the sidebar counts.
 * Rejects (for a toast) when the API call fails; the save itself has already succeeded.
 */
export async function completeInboxHandoff(origin: InboxOrigin, result: { item_id?: string; revision_id?: string }): Promise<void> {
  await api(`/inbox/${encodeURIComponent(origin.inbox_id)}/resolve`, {
    method: "POST",
    body: { outcome: "filed", ...(result.item_id ? { item_id: result.item_id } : {}), ...(result.revision_id ? { revision_id: result.revision_id } : {}) },
  });
  if (typeof window !== "undefined") window.dispatchEvent(new Event("thaliyola:counts"));
}

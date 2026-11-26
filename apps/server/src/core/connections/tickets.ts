import pg from "pg";
import type { Settings } from "../../config.js";
import { withTx, type Db, type Queryable } from "../../db/pool.js";
import { audit } from "../audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { emitChanged } from "../events.js";
import { ancestorsOf } from "../hierarchy.js";
import { assertCanPropose, assertCanRead, canModerate, canReadScope } from "../permissions.js";
import { redact } from "../redaction.js";
import { KINDS } from "./kinds.js";
import { RemoteError } from "./remote.js";
import { SYNC_END, SYNC_START } from "./schema.js";
import { driverEnv, errorText, openSecrets, recordOutcome, targetOf, type ConnectionRow } from "./sync.js";
import {
  isTracker,
  jiraHost,
  parseTicketUrl,
  reachesSite,
  readKeys,
  servesTicket,
  TRACKER_DRIVERS,
  TRACKERS,
  type ParsedTicketUrl,
  type TicketCategory,
  type TicketInfo,
  type Tracker,
} from "./trackers.js";

/**
 * Tickets: Jira and Linear issues that belong with a finding or an article.
 *
 * - create_ticket opens an issue through a tracker connection, with a description that links back to the item, and
 *   stores the issue's link on the item as a source link (system jira or linear).
 * - link_ticket attaches an existing issue by its URL (so does add_source_link with system jira or linear, and a new
 *   finding or article given such links). One link per issue per item, at most 25 tickets per item.
 * - Each linked issue's title and status are cached (table tickets): refreshed by the connections job (open issues
 *   every 30 minutes, closed ones daily) and when the item is viewed (when the cache is over 5 minutes old).
 *
 * Which connections an item can use: tracker connections of its project, of the projects above it, and of the Team
 * space (nearest first). A members-only project's items only go to its own trackers and those of the projects above
 * it, never the Team space's (as with notification routes). Creating and linking need Propose in the item's project
 * (Contributors and above); nothing is needed where the connection lives (its Project admins chose to connect it).
 *
 * Issues are read with the connection's credentials and their titles shown to everyone who can read the item, so a
 * connection only reads issues of its own project (Jira) or team (Linear), and of the others a Project admin allows on
 * it (allowed_projects / allowed_teams). Any other issue stays a plain link: nothing about it is fetched or shown.
 * Creating is limited to 10 issues a minute per person, linking to 30 (creations count too); both are logged.
 */

export const TICKETS_PER_MINUTE = 10;
export const LINKS_PER_MINUTE = 30;
export const TICKETS_PER_ITEM = 25;
/** On view: tickets checked longer ago than this are checked again (at most this many per view). */
export const FRESH_MS = 5 * 60_000;
export const REFRESH_ON_VIEW = 10;
/** The longest a page waits for trackers in all (a slower refresh finishes in the background, within BACKGROUND_MS). */
export const VIEW_WAIT_MS = 5_000;
const BACKGROUND_MS = 30_000;
/** The job's time for tickets each tick (it holds the connections lock meanwhile). */
export const JOB_BUDGET_MS = 60_000;
/** A tracker that says it's rate limiting, without saying for how long, is left alone this long. */
const BACKOFF_MS = 60_000;
const LABEL: Record<Tracker, string> = { jira: "Jira", linear: "Linear", clickup: "ClickUp" };
/** Per-person lock for the ticket budgets (creating and linking share it). */
const BUDGET_LOCK = 7402219;

function assertOn(ctx: RequestContext) {
  if (!ctx.settings.connections?.enabled) throw new ForbiddenError("connections are turned off on this server (CONNECTIONS=off)");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Runs `fn` in a transaction: the caller's, or a new one. */
async function inTx<T>(db: Queryable, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return db instanceof pg.Pool ? withTx(db, fn) : fn(db);
}

// ---- Rate limits from trackers -------------------------------------------------------------------------------------

/** Connection → until when its tracker asked us to wait (HTTP 429, Retry-After). Per instance. */
const backoff = new Map<string, number>();

function backingOff(connectionId: string): boolean {
  const until = backoff.get(connectionId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  backoff.delete(connectionId);
  return false;
}

function backingOffIds(): string[] {
  return [...backoff.keys()].filter(backingOff);
}

/** For tests: forget every tracker's rate limit. */
export function clearTrackerBackoff() {
  backoff.clear();
}

// ---- The item ----------------------------------------------------------------------------------------------------

interface TicketItem {
  kind: "article" | "finding";
  id: string;
  scope_id: string;
  scope_slug: string;
  scope_kind: string;
  scope_visibility: string;
  title: string;
  status: string;
  body: string | null;
  symptoms: string | null;
  root_cause: string | null;
  fix: string | null;
}

/** The item, readable by the caller; with `write`, one tickets may be added to (Propose there, not in the trash). */
async function ticketItem(ctx: RequestContext, id: string, write: boolean): Promise<TicketItem> {
  const { rows } = await ctx.db.query<TicketItem>(
    `SELECT x.*, s.slug AS scope_slug, s.kind AS scope_kind, s.visibility AS scope_visibility FROM (
       SELECT 'article' AS kind, id, scope_id, title, status, body_md AS body, NULL AS symptoms, NULL AS root_cause, NULL AS fix FROM articles WHERE id = $1
       UNION ALL
       SELECT 'finding', id, scope_id, title, status, NULL, symptoms, root_cause, fix FROM findings WHERE id = $1
     ) x JOIN scopes s ON s.id = x.scope_id`,
    [id],
  );
  const item = rows[0];
  if (!item) throw new NotFoundError(`article or finding ${id}`);
  await assertCanRead(ctx, item.scope_id, `article or finding ${id}`);
  if (item.status === "deleted" && !(await canModerate(ctx, item.scope_id))) throw new NotFoundError(`article or finding ${id}`);
  if (!write) return item;
  await assertCanPropose(ctx, item.scope_id);
  if (item.status === "deleted" || item.status === "rejected") throw new ValidationError(`this ${item.kind} is ${item.status === "deleted" ? "in the trash" : "rejected"}: restore it before adding tickets`);
  if (item.scope_kind === "personal") throw new ValidationError("tickets are for project and team entries: move this one out of your personal space first");
  return item;
}

async function mayPropose(ctx: RequestContext, scopeId: string): Promise<boolean> {
  try {
    await assertCanPropose(ctx, scopeId);
    return true;
  } catch (err) {
    if (err instanceof ForbiddenError) return false;
    throw err;
  }
}

/** Where the issue's description links back to: the item's page in Thaliyola. */
export function itemUrl(settings: Settings, item: { kind: string; id: string }): string {
  if (!settings.publicUrl) throw new ValidationError("PUBLIC_URL isn't set on this server, so the issue couldn't link back to Thaliyola; an Administrator sets it");
  return `${settings.publicUrl}/#/${item.kind}/${item.id}`;
}

/** What goes in a new issue when no description is given: the finding's parts, or the article's opening. */
export function defaultDescription(item: Pick<TicketItem, "kind" | "body" | "symptoms" | "root_cause" | "fix">): string {
  if (item.kind === "finding") {
    return [
      ["Symptoms", item.symptoms],
      ["Root cause", item.root_cause],
      ["Fix", item.fix],
    ]
      .filter(([, v]) => v?.trim())
      .map(([k, v]) => `${k}:\n${clip(v!.trim(), 2000)}`)
      .join("\n\n");
  }
  const body = (item.body ?? "")
    // A synced table's generated block (its columns) isn't the article's own words; other comments aren't text.
    .split(SYNC_START)
    .map((part, i) => (i === 0 ? part : part.slice(part.indexOf(SYNC_END) >= 0 ? part.indexOf(SYNC_END) + SYNC_END.length : part.length)))
    .join("")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(body, 1500);
}

// ---- Which connections ---------------------------------------------------------------------------------------------

interface TrackerRow extends ConnectionRow {
  scope_slug: string;
  scope_name: string;
  scope_kind: string;
  /** 0: the item's own project; 1, 2…: projects above it; 99: the Team space. */
  depth: number;
}

/** Tracker connections an item in this scope may use (to read linked issues), nearest first. */
async function trackersFor(db: Queryable, scopeId: string): Promise<TrackerRow[]> {
  const up = (await ancestorsOf(db, scopeId)).map((a) => a.id);
  const order = [scopeId, ...up];
  const { rows } = await db.query<Omit<TrackerRow, "depth">>(
    `SELECT c.*, s.slug AS scope_slug, s.name AS scope_name, s.kind AS scope_kind
       FROM connections c JOIN scopes s ON s.id = c.scope_id
      WHERE c.kind = ANY($2::text[]) AND (c.scope_id = ANY($1::uuid[]) OR s.kind = 'team')`,
    [order, TRACKERS],
  );
  return rows
    .map((r) => ({ ...r, depth: r.scope_kind === "team" && !order.includes(r.scope_id) ? 99 : order.indexOf(r.scope_id) }))
    .sort((a, b) => a.depth - b.depth || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

/**
 * The trackers an item's content may be sent to (creating an issue): a members-only project's items only go to its
 * own trackers and those of the projects above it, not the Team space's (as with notification routes).
 */
function sendable(item: Pick<TicketItem, "scope_visibility">, all: TrackerRow[]): TrackerRow[] {
  return item.scope_visibility === "members" ? all.filter((c) => c.depth !== 99) : all;
}

/** The scopes among these the caller can read (connections of a members-only project above them aren't named). */
async function readableOf(ctx: RequestContext, scopeIds: (string | null)[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const id of new Set(scopeIds)) if (id && (await canReadScope(ctx, id))) out.add(id);
  return out;
}

const trackerView = (c: TrackerRow, readable: Set<string>) => ({
  id: c.id,
  name: c.name,
  kind: c.kind as Tracker,
  label: KINDS[c.kind].label,
  // Where the connection lives: not named when it's a project above that the caller can't read.
  scope: readable.has(c.scope_id) ? c.scope_slug : null,
  scope_name: readable.has(c.scope_id) ? c.scope_name : "a project above",
  health: c.health,
  enabled: c.enabled,
  // Where new issues go (not secret: the project or team key).
  destination: c.kind === "jira" ? c.config.project_key ?? null : c.kind === "clickup" ? c.config.list_id ?? null : c.config.team ?? null,
  site: c.kind === "jira" ? jiraHost(c) : null,
});

const names = (list: TrackerRow[], readable: Set<string>) => list.map((c) => `${c.name} (${readable.has(c.scope_id) ? c.scope_slug : "a project above"})`).join(", ");
const findTracker = (list: TrackerRow[], ref: string) => list.find((c) => c.id === ref) ?? list.find((c) => c.name.toLowerCase() === ref.toLowerCase());

/** The connection to open an issue with: the one named, or the only one nearest the item. */
async function pickTracker(ctx: RequestContext, item: TicketItem, ref: string | undefined): Promise<TrackerRow> {
  const all = await trackersFor(ctx.db, item.scope_id);
  const usable = sendable(item, all);
  const readable = await readableOf(ctx, all.map((c) => c.scope_id));
  const where = item.scope_kind === "team" ? "the Team space" : item.scope_slug;
  if (ref?.trim()) {
    const r = ref.trim();
    const found = findTracker(usable, r);
    if (!found) {
      if (findTracker(all, r)) throw new ValidationError(`${item.scope_slug} is members-only, so its findings and articles don't go to the Team space's issue trackers; use one of the project's own${usable.length ? ` (${names(usable, readable)})` : ", which a Project admin adds under Settings › Connections"}`);
      throw new NotFoundError(`issue tracker connection "${r}" for ${where}${usable.length ? ` (it can use: ${names(usable, readable)})` : " (it can use none)"}`);
    }
    if (!found.enabled) throw new ValidationError(`${found.name} is paused; a Project admin resumes it in ${readable.has(found.scope_id) ? `${found.scope_slug}'s` : "its project's"} settings`);
    return found;
  }
  const enabled = usable.filter((c) => c.enabled);
  if (!enabled.length) {
    if (all.some((c) => c.enabled && !usable.includes(c)))
      throw new ValidationError(`${where} is members-only, so its findings and articles don't go to the Team space's issue trackers: a Project admin adds the project's own under Settings › Connections`);
    throw new ValidationError(`no Jira, Linear or ClickUp connection reaches ${where}${usable.length ? " (they're paused)" : ""}: a Project admin adds one in the project's settings, under Connections`);
  }
  const nearest = enabled.filter((c) => c.depth === enabled[0]!.depth);
  if (nearest.length > 1) throw new ValidationError(`${where} can use several issue trackers; pass connection (one of: ${names(nearest, readable)})`);
  return nearest[0]!;
}

/** The connection that can read an issue at this URL: nearest first, working ones before paused ones. */
function matchTracker(all: TrackerRow[], t: Pick<ParsedTicketUrl, "tracker" | "host" | "key">): TrackerRow | undefined {
  const serving = all.filter((c) => servesTicket(c, t));
  return serving.find((c) => c.enabled) ?? serving[0];
}

/** Why no connection reads an issue on a site one of them is for: the issue's project isn't one it reads. */
function outsideWhy(all: TrackerRow[], t: Pick<ParsedTicketUrl, "tracker" | "host" | "key">): string | null {
  const near = all.find((c) => reachesSite(c, t));
  if (!near) return null;
  const what = t.tracker === "jira" ? "project" : t.tracker === "clickup" ? "list" : "team";
  return `Not in this tracker's ${what}: the connection reads ${readKeys(near).join(", ")} issues only (a Project admin can allow more).`;
}

// ---- Stored tickets ----------------------------------------------------------------------------------------------

interface TicketRow {
  link_id: string;
  target_id: string;
  url: string;
  tracker: Tracker;
  key: string;
  title: string | null;
  status: string | null;
  category: TicketCategory;
  checked_at: string | null;
  error: string | null;
  connection_id: string | null;
  connection_name: string | null;
  connection_scope_id: string | null;
  created_at: string;
}

const TICKETS = `SELECT l.id AS link_id, l.target_id, l.url, t.tracker, t.key, t.title, t.status, t.category, t.checked_at, t.error, t.connection_id, c.name AS connection_name, c.scope_id AS connection_scope_id, t.created_at
                   FROM tickets t JOIN source_links l ON l.id = t.source_link_id LEFT JOIN connections c ON c.id = t.connection_id`;

/** A ticket as callers see it; the connection is named only to people who can read the project it belongs to. */
const ticketView = (t: TicketRow, readable?: Set<string>) => ({
  id: t.link_id,
  tracker: t.tracker,
  label: LABEL[t.tracker],
  key: t.key,
  url: t.url,
  title: t.title,
  status: t.status,
  category: t.category,
  checked_at: t.checked_at,
  error: t.error,
  /** Whether a connection reads this issue's status. */
  connected: !!t.connection_id,
  connection: t.connection_id && t.connection_scope_id && readable?.has(t.connection_scope_id) ? { id: t.connection_id, name: t.connection_name } : null,
});
export type TicketView = ReturnType<typeof ticketView>;

async function ticketsOf(db: Queryable, itemId: string): Promise<TicketRow[]> {
  return (await db.query<TicketRow>(`${TICKETS} WHERE l.target_id = $1 ORDER BY t.created_at, t.key`, [itemId])).rows;
}

async function viewsFor(ctx: RequestContext, rows: TicketRow[]) {
  const readable = await readableOf(ctx, rows.map((t) => t.connection_scope_id));
  return rows.map((t) => ticketView(t, readable));
}

/** The cached ticket of each of an item's source links (for get_article and get_finding). */
export async function ticketsByLink(db: Queryable, itemId: string): Promise<Map<string, TicketView>> {
  return new Map((await ticketsOf(db, itemId)).map((t) => [t.url, ticketView(t)]));
}

/** Reserves one link for the person: LINKS_PER_MINUTE a minute, creations included (under the per-person lock). */
async function reserveLink(tx: Queryable, actorId: string) {
  await tx.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [BUDGET_LOCK, actorId]);
  const { rows } = await tx.query<{ n: number }>(
    `SELECT (SELECT count(*) FROM audit_log WHERE actor_id = $1 AND tool = 'link_ticket' AND at > clock_timestamp() - interval '1 minute')
          + (SELECT count(*) FROM connection_calls WHERE actor_id = $1 AND kind = 'ticket' AND at > clock_timestamp() - interval '1 minute') AS n`,
    [actorId],
  );
  if (Number(rows[0]?.n ?? 0) >= LINKS_PER_MINUTE) throw new ValidationError(`that's ${LINKS_PER_MINUTE} tickets linked in a minute; wait a moment and try again`);
}

async function assertRoom(db: Queryable, item: { kind: string; id: string }) {
  const { rows } = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM tickets t JOIN source_links l ON l.id = t.source_link_id WHERE l.target_id = $1", [item.id]);
  if ((rows[0]?.n ?? 0) >= TICKETS_PER_ITEM) throw new ValidationError(`this ${item.kind} has ${TICKETS_PER_ITEM} tickets, the most one can have`);
}

/**
 * Stores a link of system jira or linear on an item. An issue's link (stored in one spelling) becomes a ticket, read
 * through the nearest connection that serves it (`conn`: the one the caller named; null: none). Once per issue per
 * item: a link already there is returned (`already`). Linking counts towards the person's budget (LINKS_PER_MINUTE)
 * and is audited; an item has at most TICKETS_PER_ITEM. Anything that isn't an issue's link stays a plain link.
 */
export async function attachTrackerLink(
  db: Queryable,
  target: { kind: string; id: string },
  link: { system: string; url: string; label?: string },
  actorId: string | null | undefined,
  opts: { conn?: TrackerRow | null } = {},
): Promise<{ id: string; already: boolean; ticket: ParsedTicketUrl | null }> {
  const parsed = isTracker(link.system) ? parseTicketUrl(link.url) : null;
  const ticket = parsed && parsed.tracker === link.system ? parsed : null;
  const url = ticket?.url ?? link.url;
  return inTx(db, async (tx) => {
    if (ticket && actorId) await reserveLink(tx, actorId);
    const existing = async () =>
      (await tx.query<{ id: string }>("SELECT id FROM source_links WHERE target_id = $1 AND url = $2 AND system = ANY($3::text[])", [target.id, url, TRACKERS])).rows[0];
    const was = ticket ? await existing() : undefined;
    if (was) return { id: was.id, already: true, ticket };
    if (ticket) await assertRoom(tx, target);
    const ins = await tx.query<{ id: string }>("INSERT INTO source_links (target_kind, target_id, system, url, label) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id", [
      target.kind,
      target.id,
      link.system,
      url,
      clip(oneLine(link.label ?? ""), 200),
    ]);
    // Linked at the same moment by someone else (or a plain link that's already there).
    if (!ins.rows[0]) return { id: (await existing())!.id, already: true, ticket };
    const id = ins.rows[0].id;
    if (!ticket) return { id, already: false, ticket };
    let conn = opts.conn;
    let why: string | null = null;
    if (conn === undefined) {
      const scope = (await tx.query<{ scope_id: string }>("SELECT scope_id FROM articles WHERE id = $1 UNION ALL SELECT scope_id FROM findings WHERE id = $1", [target.id])).rows[0];
      const all = scope ? await trackersFor(tx, scope.scope_id) : [];
      conn = matchTracker(all, ticket) ?? null;
      if (!conn) why = outsideWhy(all, ticket);
    }
    await tx.query("INSERT INTO tickets (source_link_id, connection_id, tracker, key, error, checked_at, created_by) VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END, $6)", [
      id,
      conn?.id ?? null,
      ticket.tracker,
      ticket.key,
      why,
      actorId ?? null,
    ]);
    if (actorId) {
      const title = (await tx.query<{ title: string }>("SELECT title FROM articles WHERE id = $1 UNION ALL SELECT title FROM findings WHERE id = $1", [target.id])).rows[0]?.title;
      await audit(tx, actorId, "link_ticket", target.id, {
        targetKind: target.kind === "article" ? "article" : "finding",
        targetLabel: title ?? null,
        details: { ticket: ticket.key, tracker: ticket.tracker, ...(conn ? { connection: conn.name } : {}) },
      });
    }
    return { id, already: false, ticket };
  });
}

// ---- Refreshing ----------------------------------------------------------------------------------------------------

/** Item → refresh under way, so a page viewed by several people at once asks the tracker once. */
const inflight = new Map<string, Promise<void>>();

async function setResult(db: Queryable, linkId: string, r: TicketInfo | { error: string }) {
  if ("error" in r) {
    await db.query("UPDATE tickets SET error = $2, checked_at = now() WHERE source_link_id = $1", [linkId, clip(r.error, 500)]);
    return;
  }
  await db.query("UPDATE tickets SET title = $2, status = $3, category = $4, error = NULL, checked_at = now() WHERE source_link_id = $1", [
    linkId,
    clip(oneLine(redact(r.title).text), 300),
    clip(oneLine(r.status), 60) || null,
    r.category,
  ]);
}

/**
 * Asks the trackers about these tickets and caches what they say: one request per connection for each 25 tickets
 * (Linear: aliased GraphQL; Jira: a key-in search). A ticket whose connection no longer reads it (the item moved to a
 * project that can't use it, the connection points at another site, or the issue's project isn't one it reads) is
 * detached, and what was cached about it forgotten; it's attached again when a connection can read it.
 *
 * Nothing is asked after `deadline`; tickets not reached wait for the next refresh. A tracker that answers 429 isn't
 * asked again (on this instance) until its Retry-After has passed.
 */
export async function refreshTickets(db: Db, settings: Settings, linkIds: string[], opts: { timeoutMs?: number; deadline?: number } = {}) {
  if (!linkIds.length || !settings.connections?.enabled) return { checked: 0, failed: 0 };
  const { rows } = await db.query<TicketRow & { scope_id: string }>(
    `${TICKETS.replace("SELECT l.id", "SELECT coalesce(a.scope_id, f.scope_id) AS scope_id, l.id")} LEFT JOIN articles a ON a.id = l.target_id LEFT JOIN findings f ON f.id = l.target_id
      WHERE l.id = ANY($1::uuid[])`,
    [linkIds],
  );
  const reach = new Map<string, TrackerRow[]>();
  const byConn = new Map<string, (TicketRow & { scope_id: string })[]>();
  let checked = 0;
  let failed = 0;
  let changed = false;
  for (const t of rows) {
    if (!t.scope_id) continue;
    if (!reach.has(t.scope_id)) reach.set(t.scope_id, await trackersFor(db, t.scope_id));
    const all = reach.get(t.scope_id)!;
    const parsed = parseTicketUrl(t.url) ?? { tracker: t.tracker, key: t.key, url: t.url, host: "" };
    let conn = t.connection_id ? all.find((c) => c.id === t.connection_id) : undefined;
    if (conn && !servesTicket(conn, parsed)) conn = undefined;
    if (!conn && parsed.host) conn = matchTracker(all, parsed);
    if (!conn) {
      // Nothing reads it: forget what was read before, and say why when a connection is for that site.
      const why = parsed.host ? outsideWhy(all, parsed) : null;
      if (t.connection_id || t.title !== null || t.status !== null || t.category !== "unknown" || t.error !== why) {
        await db.query("UPDATE tickets SET connection_id = NULL, title = NULL, status = NULL, category = 'unknown', error = $2, checked_at = now() WHERE source_link_id = $1", [t.link_id, why]);
        changed = true;
      }
      continue;
    }
    if (conn.id !== t.connection_id) await db.query("UPDATE tickets SET connection_id = $2 WHERE source_link_id = $1", [t.link_id, conn.id]);
    if (!conn.enabled || backingOff(conn.id)) continue;
    byConn.set(conn.id, [...(byConn.get(conn.id) ?? []), t]);
  }
  const base = driverEnv(settings);
  const timeLeft = () => (opts.deadline ? opts.deadline - Date.now() : Infinity);
  for (const [connId, list] of byConn) {
    if (timeLeft() <= 0) break;
    const conn = [...reach.values()].flat().find((c) => c.id === connId)!;
    let secrets: Record<string, string> = {};
    const done = new Set<string>();
    try {
      secrets = await openSecrets(db, settings, conn);
      const driver = TRACKER_DRIVERS[conn.kind as Tracker];
      for (let i = 0; i < list.length; i += 25) {
        const left = timeLeft();
        if (left <= 0) break;
        const env = { ...base, timeoutMs: Math.max(1_000, Math.min(opts.timeoutMs ?? base.timeoutMs ?? 15_000, left)) };
        const chunk = list.slice(i, i + 25);
        const results = await driver.fetch(targetOf(conn, secrets), env, chunk.map((t) => t.key), opts.deadline);
        for (const [j, t] of chunk.entries()) {
          const r = results[j];
          // Not reached this time (out of time): it waits for the next refresh.
          if (!r) continue;
          done.add(t.link_id);
          if (r instanceof Error) {
            failed++;
            await setResult(db, t.link_id, { error: errorText(r, secrets) });
            continue;
          }
          // Linear finds issues by key in the API key's own workspace: a link into another workspace isn't this one.
          const stored = parseTicketUrl(t.url);
          const got = parseTicketUrl(r.url);
          if (stored?.workspace && got?.workspace && stored.workspace !== got.workspace) {
            failed++;
            await setResult(db, t.link_id, { error: `${conn.name} is for the Linear workspace ${got.workspace}; this issue is in ${stored.workspace}` });
            continue;
          }
          checked++;
          await setResult(db, t.link_id, r);
        }
      }
    } catch (err) {
      if (err instanceof RemoteError && err.status === 429) {
        // Rate limited: stop asking this tracker (here and in the job) until it says, and keep what's cached.
        backoff.set(connId, Date.now() + Math.min(Math.max(err.retryAfterMs ?? BACKOFF_MS, 5_000), 3_600_000));
        continue;
      }
      const error = errorText(err, secrets);
      for (const t of list) {
        if (done.has(t.link_id)) continue;
        failed++;
        await setResult(db, t.link_id, { error });
      }
      // Credentials that stopped working show on the connection too.
      if (err instanceof RemoteError && err.status === 401) await recordOutcome(db, settings, conn, { ok: false, error }, { scheduled: false });
    }
  }
  if (checked || failed || changed) emitChanged();
  return { checked, failed };
}

/**
 * The connections job: tickets due a check (open ones every 30 minutes, closed ones daily), 50 at a time, within
 * `budgetMs` (the job holds the connections lock meanwhile). Items in the trash aren't checked; trackers that are
 * rate limiting are skipped until they said to come back.
 */
export async function refreshDueTickets(db: Db, settings: Settings, limit = 50, budgetMs = JOB_BUDGET_MS) {
  const deadline = Date.now() + budgetMs;
  // Tickets no connection reads yet (linked before one was added): see whether one does now.
  const { rows: orphans } = await db.query<{ id: string }>(
    `SELECT l.id FROM tickets t JOIN source_links l ON l.id = t.source_link_id
       LEFT JOIN articles a ON a.id = l.target_id LEFT JOIN findings f ON f.id = l.target_id
      WHERE t.connection_id IS NULL AND (t.checked_at IS NULL OR t.checked_at < now() - interval '1 hour')
        AND coalesce(a.status, f.status) NOT IN ('deleted', 'rejected')
      ORDER BY t.checked_at NULLS FIRST LIMIT $1`,
    [limit],
  );
  const orphanIds = orphans.map((o) => o.id);
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.source_link_id AS id FROM tickets t
       JOIN connections c ON c.id = t.connection_id JOIN scopes s ON s.id = c.scope_id
       JOIN source_links l ON l.id = t.source_link_id
       LEFT JOIN articles a ON a.id = l.target_id LEFT JOIN findings f ON f.id = l.target_id
      WHERE c.enabled AND s.status = 'active' AND coalesce(a.status, f.status) NOT IN ('deleted', 'rejected')
        AND NOT (c.id = ANY($2::uuid[]))
        AND (t.checked_at IS NULL OR t.checked_at < now() - CASE WHEN t.category IN ('done', 'canceled') THEN interval '1 day' ELSE interval '30 minutes' END)
      ORDER BY t.checked_at NULLS FIRST LIMIT $1`,
    [limit, backingOffIds()],
  );
  const r = await refreshTickets(db, settings, [...rows.map((x) => x.id), ...orphanIds], { deadline });
  // Orphans still without a connection wait an hour before the next look.
  if (orphanIds.length) await db.query("UPDATE tickets SET checked_at = now() WHERE source_link_id = ANY($1::uuid[]) AND connection_id IS NULL", [orphanIds]);
  return r;
}

/**
 * On view: tickets of the item checked over 5 minutes ago (10 at most). The viewer waits VIEW_WAIT_MS at most in all;
 * a slower tracker's answer is cached in the background (and shows on the next view, or the page's live refresh).
 */
async function refreshStale(db: Db, settings: Settings, itemId: string) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT t.source_link_id AS id FROM tickets t JOIN source_links l ON l.id = t.source_link_id
      WHERE l.target_id = $1 AND (t.checked_at IS NULL OR t.checked_at < now() - make_interval(secs => $2))
      ORDER BY t.checked_at NULLS FIRST LIMIT $3`,
    [itemId, FRESH_MS / 1000, REFRESH_ON_VIEW],
  );
  if (!rows.length) return;
  let p = inflight.get(itemId);
  if (!p) {
    p = refreshTickets(db, settings, rows.map((r) => r.id), { timeoutMs: Math.min(settings.connections?.queryTimeoutMs ?? VIEW_WAIT_MS, VIEW_WAIT_MS), deadline: Date.now() + BACKGROUND_MS })
      .then(() => undefined)
      .catch((err: unknown) => console.error(`[tickets] refreshing ${itemId} failed: ${errorText(err)}`))
      .finally(() => inflight.delete(itemId));
    inflight.set(itemId, p);
  }
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, VIEW_WAIT_MS);
    timer.unref();
  });
  await Promise.race([p, waited]);
  clearTimeout(timer);
}

// ---- What people and agents call -----------------------------------------------------------------------------------

/**
 * An item's tickets (refreshed first when the cache is old, unless `refresh` is false), and for people who may add
 * tickets, the tracker connections they can create them with.
 */
export async function listTickets(ctx: RequestContext, itemId: string, opts: { refresh?: boolean } = {}) {
  const item = await ticketItem(ctx, itemId, false);
  const on = !!ctx.settings.connections?.enabled;
  if (on && opts.refresh !== false) await refreshStale(ctx.db, ctx.settings, item.id);
  const rows = await ticketsOf(ctx.db, item.id);
  const tickets = await viewsFor(ctx, rows);
  const open = item.status !== "deleted" && item.status !== "rejected" && item.scope_kind !== "personal";
  const mayAdd = open && (await mayPropose(ctx, item.scope_id));
  const room = rows.length < TICKETS_PER_ITEM;
  const all = mayAdd && on ? (await trackersFor(ctx.db, item.scope_id)).filter((c) => c.enabled) : [];
  const usable = sendable(item, all);
  const readable = await readableOf(ctx, usable.map((c) => c.scope_id));
  const trackers = usable.map((c) => trackerView(c, readable));
  return {
    item_id: item.id,
    tickets,
    can_link: mayAdd && room,
    can_create: mayAdd && on && room && trackers.length > 0,
    trackers,
    // Why there's no Create ticket, for people who may add tickets.
    create_blocked: !mayAdd
      ? null
      : !on
        ? "Connections are turned off on this server."
        : !room
          ? `This ${item.kind} has ${TICKETS_PER_ITEM} tickets, the most one can have.`
          : trackers.length
            ? null
            : all.length
              ? "This project is members-only, so its findings and articles don't go to the Team space's issue trackers. A Project admin adds the project's own under Settings › Connections."
              : "No Jira, Linear or ClickUp connection reaches this project. A Project admin adds one under Settings › Connections.",
  };
}

/** Reserves one issue creation for the caller (10 a minute, counted on every instance under a per-person lock). */
async function reserveTicket(ctx: RequestContext, connectionId: string, text: string): Promise<string> {
  return withTx(ctx.db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [BUDGET_LOCK, ctx.actor.id]);
    const { rows } = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM connection_calls WHERE actor_id = $1 AND kind = 'ticket' AND at > clock_timestamp() - interval '1 minute'", [
      ctx.actor.id,
    ]);
    if ((rows[0]?.n ?? 0) >= TICKETS_PER_MINUTE) throw new ValidationError(`that's ${TICKETS_PER_MINUTE} tickets in a minute; wait a moment and try again`);
    const ins = await tx.query<{ id: string }>("INSERT INTO connection_calls (connection_id, actor_id, kind, text, at) VALUES ($1, $2, 'ticket', $3, clock_timestamp()) RETURNING id", [
      connectionId,
      ctx.actor.id,
      clip(text, 4000),
    ]);
    return ins.rows[0]!.id;
  });
}

async function saveTicket(db: Db, item: TicketItem, c: { id: string; kind: Tracker }, info: TicketInfo, label: string, actorId: string) {
  return withTx(db, async (tx) => {
    const link = await tx.query<{ id: string }>("INSERT INTO source_links (target_kind, target_id, system, url, label) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id", [
      item.kind,
      item.id,
      c.kind,
      info.url,
      clip(oneLine(label), 200),
    ]);
    // A new issue isn't linked yet; if it somehow is, the existing link is it.
    const id = link.rows[0]?.id ?? (await tx.query<{ id: string }>("SELECT id FROM source_links WHERE target_id = $1 AND url = $2", [item.id, info.url])).rows[0]!.id;
    await tx.query(
      `INSERT INTO tickets (source_link_id, connection_id, tracker, key, title, status, category, checked_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), $8)
       ON CONFLICT (source_link_id) DO UPDATE SET connection_id = EXCLUDED.connection_id, title = EXCLUDED.title, status = EXCLUDED.status, category = EXCLUDED.category, checked_at = now(), error = NULL`,
      [id, c.id, c.kind, info.key, clip(oneLine(redact(info.title).text), 300), clip(oneLine(info.status), 60) || null, info.category, actorId],
    );
    return id;
  });
}

async function oneTicket(ctx: RequestContext, linkId: string) {
  return (await viewsFor(ctx, (await ctx.db.query<TicketRow>(`${TICKETS} WHERE l.id = $1`, [linkId])).rows))[0]!;
}

export interface CreateTicketInput {
  item: string;
  connection?: string;
  title?: string;
  description?: string;
}

/** Opens an issue for a finding or article, linking back to it, and links the issue on the item. */
export async function createTicket(ctx: RequestContext, input: CreateTicketInput) {
  assertOn(ctx);
  const item = await ticketItem(ctx, input.item, true);
  const conn = await pickTracker(ctx, item, input.connection);
  const tracker = conn.kind as Tracker;
  const title = clip(oneLine(redact(input.title?.trim() || item.title).text), 250);
  if (!title) throw new ValidationError("a ticket needs a title");
  const link = itemUrl(ctx.settings, item);
  await assertRoom(ctx.db, item);
  const description = clip(redact((input.description?.trim() || defaultDescription(item)).replace(/\r\n/g, "\n")).text, 8000);
  const callId = await reserveTicket(ctx, conn.id, `create ${LABEL[tracker]} issue for ${item.kind} ${item.id}`);
  const started = Date.now();
  let secrets: Record<string, string> = {};
  let info: TicketInfo;
  try {
    secrets = await openSecrets(ctx.db, ctx.settings, conn);
    info = await TRACKER_DRIVERS[tracker].create(targetOf(conn, secrets), driverEnv(ctx.settings), { title, description, link, linkLabel: clip(oneLine(item.title), 200) });
  } catch (err) {
    const error = errorText(err, secrets);
    await ctx.db.query("UPDATE connection_calls SET error = $2, ms = $3, status = $4 WHERE id = $1", [callId, error, Date.now() - started, err instanceof RemoteError ? err.status : null]);
    if (err instanceof RemoteError && err.status === 401) await recordOutcome(ctx.db, ctx.settings, conn, { ok: false, error }, { scheduled: false, actorId: ctx.actor.id });
    throw new ValidationError(`${conn.name} didn't create the issue: ${error}`);
  }
  await ctx.db.query("UPDATE connection_calls SET text = $2, status = 201, ms = $3 WHERE id = $1", [callId, `create ${info.key} for ${item.kind} ${item.id}`, Date.now() - started]);
  const linkId = await saveTicket(ctx.db, item, { id: conn.id, kind: tracker }, info, `${info.key}: ${info.title || title}`, ctx.actor.id);
  await audit(ctx.db, ctx.actor.id, "create_ticket", item.id, { targetKind: item.kind, targetLabel: item.title, details: { ticket: info.key, tracker, connection: conn.name } });
  emitChanged();
  return { item_id: item.id, created: true, ticket: await oneTicket(ctx, linkId) };
}

export interface LinkTicketInput {
  item: string;
  url: string;
  connection?: string;
}

/** Attaches an existing Jira or Linear issue to a finding or article by its URL, and reads its status. */
export async function linkTicket(ctx: RequestContext, input: LinkTicketInput) {
  const item = await ticketItem(ctx, input.item, true);
  const parsed = parseTicketUrl(input.url);
  if (!parsed)
    throw new ValidationError(
      "that isn't a Jira issue link (https://<site>.atlassian.net/browse/OPS-12), a Linear issue link (https://linear.app/<workspace>/issue/ENG-42) or a ClickUp task link (https://app.clickup.com/t/86a1b2c3d)",
    );
  const all = await trackersFor(ctx.db, item.scope_id);
  let conn: TrackerRow | null | undefined;
  if (input.connection?.trim()) {
    const r = input.connection.trim();
    const readable = await readableOf(ctx, all.map((c) => c.scope_id));
    conn = findTracker(all, r);
    if (!conn) throw new NotFoundError(`issue tracker connection "${r}" for ${item.scope_slug}${all.length ? ` (it can use: ${names(all, readable)})` : ""}`);
    if (!reachesSite(conn, parsed)) throw new ValidationError(conn.kind !== parsed.tracker ? `${conn.name} is a ${KINDS[conn.kind].label} connection; that's a ${LABEL[parsed.tracker]} issue` : `${conn.name} is for ${jiraHost(conn)}; that issue is on ${parsed.host}`);
    if (!servesTicket(conn, parsed)) throw new ValidationError(`${conn.name} reads ${readKeys(conn).join(", ")} issues only; ${parsed.key} isn't one (a Project admin can allow more on the connection)`);
  }
  const r = await attachTrackerLink(ctx.db, item, { system: parsed.tracker, url: parsed.url, label: parsed.key }, ctx.actor.id, conn ? { conn } : {});
  if (r.already) return { item_id: item.id, linked: false, already_linked: true, ticket: await oneTicket(ctx, r.id) };
  const stored = (await ctx.db.query<{ connection_id: string | null; error: string | null }>("SELECT connection_id, error FROM tickets WHERE source_link_id = $1", [r.id])).rows[0];
  const reader = stored?.connection_id ? all.find((c) => c.id === stored.connection_id) : undefined;
  if (reader?.enabled && ctx.settings.connections?.enabled) {
    await refreshTickets(ctx.db, ctx.settings, [r.id], { timeoutMs: Math.min(ctx.settings.connections.queryTimeoutMs, VIEW_WAIT_MS), deadline: Date.now() + VIEW_WAIT_MS });
  }
  emitChanged();
  return {
    item_id: item.id,
    linked: true,
    ticket: await oneTicket(ctx, r.id),
    ...(reader
      ? {}
      : {
          note: stored?.error
            ? stored.error
            : `No ${LABEL[parsed.tracker]} connection${parsed.tracker === "jira" ? ` for ${parsed.host}` : ""} reaches this project, so the issue's status isn't shown. A Project admin can add one under Settings › Connections.`,
        }),
  };
}

import pg from "pg";
import type { Settings } from "../../config.js";
import { whenCommitted, type Db, type Queryable } from "../../db/pool.js";
import { audit } from "../audit.js";
import { ForbiddenError, NotFoundError, ValidationError, type RequestContext } from "../context.js";
import { digestSlot } from "../digest.js";
import { emitChanged } from "../events.js";
import { notify, settingsManagersFor, track, type NotificationInput } from "../notify.js";
import { assertCanManage, canManage } from "../permissions.js";
import { redact } from "../redaction.js";
import { getReadableScope, getScopeBySlug, type Scope } from "../scopes.js";
import { KINDS } from "./kinds.js";
import { reserveTest } from "./manage.js";
import { RemoteError } from "./remote.js";
import { postSlack, slackEscape } from "./slack.js";
import { driverEnv, errorText, openSecrets, targetOf, type ConnectionRow } from "./sync.js";
import { postTrello } from "./trello.js";

/**
 * Notification routes: which kinds of notifications also go to a Slack channel or a Trello list, team-wide (set up by
 * Administrators under Admin › Notifications) or for one project (its Project admins, under its settings). Each event
 * is delivered once per route, whoever it notifies in Thaliyola, in the background; a destination that doesn't take it
 * is marked failing, and its project's admins hear about it in Thaliyola once. A project's Slack route can also post a
 * daily or weekly digest: what was published, what waits for review (and for how long), and what is stale.
 *
 * A project's routes also get its sub-projects' events (roles flow down to sub-projects; so do notifications).
 * Team-wide routes only carry events of team-visible projects and spaces (and events with no project, like access
 * requests): a members-only project's events go to its own routes (and its parents') only, and a members-only
 * project request reaches them unnamed. Security events reach team-wide routes as their title alone; the details stay
 * with the project's writers (and its own routes, which its admins choose).
 *
 * Nothing at the top level of this module may use what it imports from notify.ts (the two import each other).
 */

export type RouteKind = "review" | "decided" | "comment" | "change" | "stale" | "security" | "connection" | "access";

/** The kinds a route can carry; `team`: only team-wide routes (the event has no project). */
export const ROUTE_KINDS: { kind: RouteKind; label: string; team?: true }[] = [
  { kind: "review", label: "Proposals waiting for review" },
  { kind: "decided", label: "Proposals approved or rejected" },
  { kind: "comment", label: "Comments on proposals" },
  { kind: "change", label: "A contract, shared design, schema or API it uses changed" },
  { kind: "stale", label: "Entries that need re-verifying" },
  { kind: "security", label: "Critical or actively exploited vulnerabilities" },
  { kind: "connection", label: "Connections that fail or recover; schema and API changes" },
  { kind: "access", label: "People waiting for access to Thaliyola", team: true },
];
const ROUTABLE = new Set<string>(ROUTE_KINDS.map((k) => k.kind));

export type DigestFrequency = "off" | "daily" | "weekly";
const DESTINATION_KINDS = ["slack", "trello"];

// ---- Managing routes ------------------------------------------------------------------------------------------

interface RouteRow {
  id: string;
  scope_id: string | null;
  connection_id: string;
  kinds: string[];
  digest: DigestFrequency;
  digest_sent_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  created_by_email: string | null;
  name: string;
  kind: string;
  health: string;
  enabled: boolean;
  last_error: string | null;
  last_ok_at: string | null;
}

const ROUTE_VIEW = `SELECT r.id, r.scope_id, r.connection_id, r.kinds, r.digest, r.digest_sent_at, r.created_at, r.updated_at,
                           coalesce(nullif(u.display_name, ''), u.email, u.subject) AS created_by, coalesce(u.email, u.subject) AS created_by_email,
                           c.name, c.kind, c.health, c.enabled, c.last_error, c.last_ok_at
                      FROM notification_routes r JOIN connections c ON c.id = r.connection_id LEFT JOIN users u ON u.id = r.created_by`;

function routeView(r: RouteRow) {
  return {
    id: r.id,
    kinds: ROUTE_KINDS.filter((k) => r.kinds.includes(k.kind)).map((k) => k.kind),
    digest: r.digest,
    digest_sent_at: r.digest !== "off" ? r.digest_sent_at : null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    created_by: r.created_by,
    created_by_email: r.created_by_email,
    destination: {
      id: r.connection_id,
      name: r.name,
      kind: r.kind,
      label: KINDS[r.kind as "slack"]?.label ?? r.kind,
      health: r.health,
      enabled: r.enabled,
      last_error: r.health === "failing" ? r.last_error : null,
      last_ok_at: r.last_ok_at,
    },
  };
}

/** The place routes belong to: a project (by slug), or the team (no slug), and whether the caller manages it. */
async function placeOf(ctx: RequestContext, project: string | null | undefined): Promise<Scope> {
  if (!project) {
    const team = await getScopeBySlug(ctx.db, "team");
    if (!(await canManage(ctx, team))) throw new ForbiddenError("team-wide notification routes are for Administrators");
    return team;
  }
  const scope = await getReadableScope(ctx, project);
  if (scope.kind !== "project") throw new ValidationError(`notification routes belong to a project (or the whole team), not ${scope.kind === "personal" ? "a personal space" : `the ${scope.name}`}`);
  await assertCanManage(ctx, scope);
  return scope;
}

/** The routes of a project, or the team-wide ones; with the destinations they can use and the kinds they can carry. */
export async function listRoutes(ctx: RequestContext, project?: string | null) {
  const place = await placeOf(ctx, project);
  const team = place.kind === "team";
  const { rows } = await ctx.db.query<RouteRow>(`${ROUTE_VIEW} WHERE ${team ? "r.scope_id IS NULL" : "r.scope_id = $1"} ORDER BY r.created_at`, team ? [] : [place.id]);
  const destinations = await ctx.db.query<{ id: string; name: string; kind: string; health: string; enabled: boolean }>(
    "SELECT id, name, kind, health, enabled FROM connections WHERE scope_id = $1 AND kind = ANY($2::text[]) ORDER BY lower(name)",
    [place.id, DESTINATION_KINDS],
  );
  return {
    scope: team ? null : { slug: place.slug, name: place.name, visibility: place.visibility },
    // Routes are kept but nothing is delivered while connections are off on the server.
    enabled: ctx.settings.connections?.enabled ?? false,
    routes: rows.map(routeView),
    destinations: destinations.rows.map((d) => ({ ...d, label: KINDS[d.kind as "slack"]?.label ?? d.kind })),
    kinds: ROUTE_KINDS.filter((k) => team || !k.team).map(({ kind, label }) => ({ kind, label })),
    // Digests are a project's (Slack only); when they go out, in server time.
    digests: team ? null : { hour: ctx.settings.digestHour, day: ctx.settings.digestDay },
  };
}

export interface RouteInput {
  project?: string | null;
  connection_id: string;
  kinds?: string[];
  digest?: DigestFrequency;
}

function checkKinds(kinds: string[] | undefined, team: boolean): RouteKind[] | undefined {
  if (kinds === undefined) return undefined;
  const out = [...new Set(kinds)];
  for (const k of out) {
    const spec = ROUTE_KINDS.find((x) => x.kind === k);
    if (!spec) throw new ValidationError(`kinds are some of ${ROUTE_KINDS.filter((x) => team || !x.team).map((x) => x.kind).join(", ")}`);
    if (spec.team && !team) throw new ValidationError(`${k} notifications aren't about one project; route them team-wide (Admin › Notifications)`);
  }
  return out as RouteKind[];
}

function checkDigest(digest: DigestFrequency | undefined, team: boolean, destinationKind: string): DigestFrequency | undefined {
  if (digest === undefined || digest === "off") return digest;
  if (!["daily", "weekly"].includes(digest)) throw new ValidationError("digest is off, daily or weekly");
  if (team) throw new ValidationError("digests summarise one project; set them up in the project's settings");
  if (destinationKind !== "slack") throw new ValidationError("digests go to Slack only");
  return digest;
}

async function routeRow(ctx: RequestContext, id: string) {
  const { rows } = await ctx.db.query<RouteRow & { connection_kind: string }>(`${ROUTE_VIEW} WHERE r.id = $1`, [id]);
  const r = rows[0];
  if (!r) throw new NotFoundError(`notification route ${id}`);
  const scope = r.scope_id ? (await ctx.db.query<Scope>("SELECT id, kind, slug, name, description, status, visibility FROM scopes WHERE id = $1", [r.scope_id])).rows[0]! : null;
  // A route of a project the caller can't read doesn't exist for them; one they can read but not manage is forbidden.
  await placeOf(ctx, scope?.slug ?? null).catch((err) => {
    if (err instanceof ForbiddenError && scope) throw err;
    if (err instanceof NotFoundError || err instanceof ValidationError) throw new NotFoundError(`notification route ${id}`);
    throw err;
  });
  return r;
}

export async function createRoute(ctx: RequestContext, input: RouteInput) {
  const place = await placeOf(ctx, input.project);
  const team = place.kind === "team";
  const conn = (await ctx.db.query<{ id: string; kind: string; scope_id: string; name: string }>("SELECT id, kind, scope_id, name FROM connections WHERE id = $1", [input.connection_id])).rows[0];
  // Only this place's own Slack and Trello connections: a project can't post into the team's channel, or another project's.
  if (!conn || conn.scope_id !== place.id || !DESTINATION_KINDS.includes(conn.kind)) {
    throw new ValidationError(team ? "choose a Slack or Trello connection of the Team space" : `choose a Slack or Trello connection of ${place.name} (add one under Connections)`);
  }
  const kinds = checkKinds(input.kinds ?? [], team)!;
  const digest = checkDigest(input.digest, team, conn.kind) ?? "off";
  if (!kinds.length && digest === "off") throw new ValidationError("choose at least one kind of notification (or a digest)");
  const { rows } = await ctx.db
    .query<{ id: string }>(
      `INSERT INTO notification_routes (scope_id, connection_id, kinds, digest, digest_sent_at, created_by)
       VALUES ($1, $2, $3, $4, CASE WHEN $4 <> 'off' THEN now() END, $5) RETURNING id`,
      [team ? null : place.id, conn.id, kinds, digest, ctx.actor.id],
    )
    .catch((err) => {
      if ((err as { code?: string }).code === "23505") throw new ValidationError(`${conn.name} already has a route here; edit it instead`);
      throw err;
    });
  await audit(ctx.db, ctx.actor.id, "create_notification_route", rows[0]!.id, {
    targetKind: "notification_route",
    targetLabel: conn.name,
    details: { project: team ? null : place.slug, team_wide: team, destination: conn.name, destination_kind: conn.kind, kinds, digest },
  });
  emitChanged();
  return routeView((await ctx.db.query<RouteRow>(`${ROUTE_VIEW} WHERE r.id = $1`, [rows[0]!.id])).rows[0]!);
}

export async function updateRoute(ctx: RequestContext, id: string, patch: { kinds?: string[]; digest?: DigestFrequency }) {
  const r = await routeRow(ctx, id);
  const team = !r.scope_id;
  const kinds = checkKinds(patch.kinds, team) ?? (r.kinds as RouteKind[]);
  const digest = checkDigest(patch.digest, team, r.kind) ?? r.digest;
  if (!kinds.length && digest === "off") throw new ValidationError("choose at least one kind of notification (or a digest); or remove the route");
  await ctx.db.query(
    `UPDATE notification_routes SET kinds = $2, digest = $3,
            digest_sent_at = CASE WHEN $3 = 'off' THEN NULL WHEN digest <> $3 THEN now() ELSE digest_sent_at END, updated_at = now()
      WHERE id = $1`,
    [id, kinds, digest],
  );
  await audit(ctx.db, ctx.actor.id, "update_notification_route", id, {
    targetKind: "notification_route",
    targetLabel: r.name,
    details: { destination: r.name, kinds_before: r.kinds, kinds, digest_before: r.digest, digest },
  });
  emitChanged();
  return routeView((await ctx.db.query<RouteRow>(`${ROUTE_VIEW} WHERE r.id = $1`, [id])).rows[0]!);
}

export async function deleteRoute(ctx: RequestContext, id: string) {
  const r = await routeRow(ctx, id);
  await ctx.db.query("DELETE FROM notification_routes WHERE id = $1", [id]);
  await audit(ctx.db, ctx.actor.id, "delete_notification_route", id, { targetKind: "notification_route", targetLabel: r.name, details: { destination: r.name, kinds: r.kinds, digest: r.digest } });
  emitChanged();
  return { deleted: id };
}

// ---- Delivering events ----------------------------------------------------------------------------------------------

type Destination = Pick<ConnectionRow, "id" | "kind" | "name" | "scope_id" | "config" | "options" | "secret"> & { team: boolean };

/** A pool to record deliveries with: notify() may run inside a transaction whose client is gone by the time one ends. */
let deliveryPool: Db | null = null;
export function useDeliveryPool(db: Db) {
  deliveryPool = db;
}

/**
 * One queue per destination, paced (Slack takes about one message a second per channel), so a burst posts in order
 * and doesn't trip rate limits. Bursts are grouped before they get here (one post per stale run and project, one per
 * schema sync), so a queue rarely holds more than a few.
 */
const queues = new Map<string, Promise<void>>();
const depth = new Map<string, number>();
/** When each destination may next be posted to (pacing, or a Retry-After it sent). */
const notBefore = new Map<string, number>();
/** Deliveries waiting for one destination; more are dropped (and logged) rather than piling up in memory. */
export const MAX_QUEUED = 50;
/**
 * Delivery timing (tests shorten it): the wait between two posts to one destination, the wait before retrying a
 * rate-limited post when the service doesn't say (Retry-After), the longest Retry-After honoured, and how many tries.
 */
export const delivery = { paceMs: { slack: 1100, trello: 150 } as Record<string, number>, retryAfterMs: 1000, maxRetryAfterMs: 30_000, attempts: 3, timeoutMs: 10_000 };

/** Still rate-limited after the retries: the post is dropped, but the destination isn't counted as failing. */
class RateLimited extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function enqueue(connId: string, job: () => Promise<void>) {
  const n = depth.get(connId) ?? 0;
  if (n >= MAX_QUEUED) {
    console.error(`[notify] ${MAX_QUEUED} notifications already wait for connection ${connId}; dropped one`);
    return;
  }
  depth.set(connId, n + 1);
  const next: Promise<void> = (queues.get(connId) ?? Promise.resolve())
    .then(job)
    .catch((err) => console.error(`[notify] delivery failed: ${errorText(err)}`))
    .finally(() => {
      const left = (depth.get(connId) ?? 1) - 1;
      if (left > 0) depth.set(connId, left);
      else depth.delete(connId);
      if (queues.get(connId) === next) queues.delete(connId);
    });
  queues.set(connId, next);
  track(next);
}

const absolute = (settings: Settings, link: string) => (settings.publicUrl ? `${settings.publicUrl}/${link.replace(/^\//, "")}` : null);
/** A URL inside Slack's <url|label>: no characters that end it early. */
const slackUrl = (url: string) => url.replace(/\|/g, "%7C").replace(/>/g, "%3E").replace(/</g, "%3C");

/**
 * Notifications name the people involved (by email when they have no display name), which is the point of them; every
 * other redaction rule (keys, tokens, passwords, phone numbers) applies before anything leaves for Slack or Trello.
 */
const outside = (text: string) => redact(text, { keep: ["email"] }).text;

/** What a destination posts: the title, the text (cut, redacted) and a link back when PUBLIC_URL is set. */
export function messageFor(settings: Settings, n: Pick<NotificationInput, "title" | "body" | "link">, kind: string) {
  const title = outside(n.title).slice(0, 300);
  const body = outside(n.body ?? "").trim().slice(0, 1500);
  const url = absolute(settings, n.link);
  if (kind === "slack") return { text: [`*${slackEscape(title)}*`, body && slackEscape(body), url && `<${slackUrl(url)}|Open in Thaliyola>`].filter(Boolean).join("\n") };
  return { name: title, desc: [body, url ? `Open in Thaliyola: ${url}` : ""].filter(Boolean).join("\n\n") };
}

/**
 * Posts one message, paced per destination. Rate limited (429): waits as long as the service asks (Retry-After, or
 * `delivery.retryAfterMs`) and tries again, up to `delivery.attempts` times; then throws RateLimited.
 */
async function send(dest: Destination, settings: Settings, secret: Record<string, string>, message: ReturnType<typeof messageFor>) {
  const env = { ...driverEnv(settings), timeoutMs: delivery.timeoutMs };
  const target = targetOf({ ...dest, options: dest.options ?? {} }, secret);
  const once = () => (dest.kind === "slack" ? postSlack(target, env, message as { text: string }) : postTrello(target, env, message as { name: string; desc: string }));
  for (let attempt = 1; ; attempt++) {
    const wait = (notBefore.get(dest.id) ?? 0) - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      await once();
      notBefore.set(dest.id, Date.now() + (delivery.paceMs[dest.kind] ?? 0));
      return;
    } catch (err) {
      if (!(err instanceof RemoteError && err.status === 429)) {
        notBefore.set(dest.id, Date.now() + (delivery.paceMs[dest.kind] ?? 0));
        throw err;
      }
      const asked = err.retryAfterMs ?? delivery.retryAfterMs;
      notBefore.set(dest.id, Date.now() + Math.min(asked, delivery.maxRetryAfterMs));
      if (attempt >= delivery.attempts || asked > delivery.maxRetryAfterMs) throw new RateLimited(`${dest.name} is rate-limiting notifications`);
    }
  }
}

/** A delivery to one destination: the post, then its outcome on the destination's health (not when rate-limited). */
async function deliver(pool: Db | null, settings: Settings, dest: Destination, secret: Record<string, string>, message: ReturnType<typeof messageFor>) {
  try {
    await send(dest, settings, secret, message);
    if (pool) await markDelivery(pool, settings, dest, { ok: true });
  } catch (err) {
    if (err instanceof RateLimited) {
      // Busy, not broken: the destination keeps its health; this post is lost (and logged).
      console.error(`[notify] ${dest.kind} connection "${dest.name}" is rate-limiting; dropped a notification`);
      return;
    }
    const error = errorText(err, secret);
    console.error(`[notify] ${dest.kind} connection "${dest.name}" didn't take a notification: ${error}`);
    if (pool) await markDelivery(pool, settings, dest, { ok: false, error });
  }
}

/**
 * Finds the routes an event goes to and queues one delivery per destination. Called by notify() for every event:
 *
 * - inside a transaction withTx opened, nothing happens until it commits (and nothing at all if it rolls back): the
 *   routes are read then, with the pool;
 * - otherwise the routes are read now; with the pool when the caller is in some other transaction, so nothing here
 *   writes into it (sealing secrets again after a key rotation happens only outside transactions).
 *
 * A project's routes get its events and its sub-projects' (roles flow down, so do notifications); team-wide routes
 * get only team-visible projects' and spaces' events, and events about no project.
 */
export async function routeExternal(db: Queryable, settings: Settings, n: NotificationInput): Promise<void> {
  if (!settings.connections?.enabled || n.route === false || !ROUTABLE.has(n.kind)) return;
  if (db instanceof pg.Pool) deliveryPool ??= db;
  const later = (pool: Db) => track(dispatch(pool, settings, n, true).catch((err) => console.error(`[notify] routing failed: ${errorText(err)}`)));
  if (whenCommitted(db, later)) return;
  const inTx = !(db instanceof pg.Pool) && db.getTransactionStatus() !== "I";
  await dispatch(inTx ? (deliveryPool ?? db) : db, settings, n, !inTx);
}

async function dispatch(db: Queryable, settings: Settings, n: NotificationInput, reseal: boolean) {
  const { rows } = await db.query<Destination>(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id, 0 AS depth FROM scopes WHERE id = $2::uuid
       UNION ALL
       SELECT s.id, s.parent_id, up.depth + 1 FROM scopes s JOIN up ON s.id = up.parent_id WHERE up.depth < 16
     )
     SELECT DISTINCT ON (c.id) c.id, c.kind, c.name, c.scope_id, c.config, c.options, c.secret, r.scope_id IS NULL AS team
       FROM notification_routes r JOIN connections c ON c.id = r.connection_id
      WHERE $1 = ANY (r.kinds) AND c.enabled AND c.kind = ANY ($3::text[])
        AND (r.scope_id IN (SELECT id FROM up)
          OR (r.scope_id IS NULL AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM scopes s WHERE s.id = $2::uuid AND s.kind <> 'personal' AND s.visibility = 'team'))))
      ORDER BY c.id, r.scope_id NULLS LAST`,
    [n.kind, n.scopeId ?? null, DESTINATION_KINDS],
  );
  const pool = db instanceof pg.Pool ? db : deliveryPool;
  // What leaves Thaliyola: the event's own words, or the outside version it carries (a members-only project request).
  const said = n.external ? { ...n, title: n.external.title, body: n.external.body } : n;
  for (const dest of rows) {
    let secret: Record<string, string>;
    try {
      secret = await openSecrets(db, settings, dest, { reseal });
    } catch (err) {
      if (pool) track(markDelivery(pool, settings, dest, { ok: false, error: errorText(err) }).catch(() => undefined));
      continue;
    }
    // Team-wide channels get a security event's title only (its details are for the project's writers).
    const message = messageFor(settings, dest.team && n.kind === "security" ? { title: said.title, link: said.link } : said, dest.kind);
    enqueue(dest.id, () => deliver(pool, settings, dest, secret, message));
  }
}

const settingsLink = (slug: string, kind: string) => (kind === "team" ? "#/admin/notifications" : `#/scope/${slug}/settings?tab=notifications`);

/**
 * A delivery's outcome on its destination's health. The second failure in a row tells the place's admins (in
 * Thaliyola only, never through a route: the destination may be the one failing); the next success tells them once
 * that it works again.
 */
export async function markDelivery(db: Db, settings: Settings, dest: Pick<Destination, "id" | "name" | "scope_id">, outcome: { ok: true } | { ok: false; error: string }) {
  type Result = { failures: number; was_alerted: boolean; slug: string; scope_kind: string; project: string };
  const r = (
    outcome.ok
      ? await db.query<Result>(
          `WITH old AS (SELECT id, coalesce((state->>'alerted')::boolean, false) AS alerted FROM connections WHERE id = $1 FOR UPDATE)
           UPDATE connections c SET health = 'ok', last_ok_at = now(), last_error = NULL, failures = 0, state = c.state - 'alerted'
             FROM old, scopes s WHERE c.id = old.id AND s.id = c.scope_id
           RETURNING c.failures, old.alerted AS was_alerted, s.slug, s.kind AS scope_kind, s.name AS project`,
          [dest.id],
        )
      : await db.query<Result>(
          `WITH old AS (SELECT id, failures, coalesce((state->>'alerted')::boolean, false) AS alerted FROM connections WHERE id = $1 FOR UPDATE)
           UPDATE connections c SET health = 'failing', last_error = $2, failures = old.failures + 1,
                  state = c.state || CASE WHEN old.failures + 1 >= 2 THEN '{"alerted": true}'::jsonb ELSE '{}'::jsonb END
             FROM old, scopes s WHERE c.id = old.id AND s.id = c.scope_id
           RETURNING c.failures, old.alerted AS was_alerted, s.slug, s.kind AS scope_kind, s.name AS project`,
          [dest.id, `Couldn't deliver a notification: ${outcome.error}`.slice(0, 500)],
        )
  ).rows[0];
  if (!r) return;
  emitChanged();
  const tell = async (title: string, body: string) =>
    notify(db, settings, await settingsManagersFor(db, settings, dest.scope_id), {
      kind: "connection",
      title,
      body,
      link: settingsLink(r.slug, r.scope_kind),
      targetId: dest.id,
      scopeId: dest.scope_id,
      route: false,
    });
  if (!outcome.ok && r.failures >= 2 && !r.was_alerted) {
    await tell(`Notifications aren't reaching ${dest.name} (${r.project})`, `${r.failures} deliveries in a row failed: ${outcome.error}\nFix the connection, then use Test to check it.`);
  } else if (outcome.ok && r.was_alerted) {
    await tell(`Notifications reach ${dest.name} again (${r.project})`, "The last notification was delivered.");
  }
}

// ---- Digests ------------------------------------------------------------------------------------------------------

/** The most recent daily slot (DIGEST_HOUR, server time) at or before `now`. */
export function dailySlot(now: Date, hour: number): Date {
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  if (slot > now) slot.setDate(slot.getDate() - 1);
  return slot;
}

const DAY = 24 * 60 * 60 * 1000;
const ageText = (since: string | Date, now: Date) => {
  const days = Math.floor((now.getTime() - new Date(since).getTime()) / DAY);
  if (days < 1) return "today";
  return days === 1 ? "1 day" : `${days} days`;
};

/**
 * A project's digest for the last day or week: what was published, what waits for review (oldest first, with how long),
 * and what needs re-verifying. Null when there's nothing to say.
 */
export async function buildDigest(db: Queryable, settings: Settings, scope: { id: string; slug: string; name: string }, frequency: "daily" | "weekly", now = new Date()) {
  const since = new Date(now.getTime() - (frequency === "daily" ? 1 : 7) * DAY);
  const LIMIT = 8;
  const published = await db.query<{ summary: string; target_kind: string; target_id: string; n: number }>(
    `SELECT r.summary, r.target_kind, r.target_id, count(*) OVER ()::int AS n FROM revisions r
      WHERE r.scope_id = $1 AND r.state = 'approved' AND r.decided_at > $2 AND r.decided_at <= $3 AND r.op IN ('create', 'update', 'promote', 'share')
      ORDER BY r.decided_at DESC LIMIT $4`,
    [scope.id, since, now, LIMIT],
  );
  const waiting = await db.query<{ id: string; summary: string; created_at: string; n: number }>(
    `SELECT r.id, r.summary, r.created_at, count(*) OVER ()::int AS n FROM revisions r
      WHERE r.scope_id = $1 AND r.state = 'pending' ORDER BY r.created_at LIMIT $2`,
    [scope.id, LIMIT],
  );
  const stale = await db.query<{ kind: string; id: string; title: string; verified: string; n: number }>(
    `SELECT *, count(*) OVER ()::int AS n FROM (
       SELECT 'article' AS kind, id, title, coalesce(last_verified_at, updated_at) AS verified FROM articles
        WHERE scope_id = $1 AND (status = 'possibly_stale' OR (status = 'published' AND review_due < current_date))
       UNION ALL
       SELECT 'finding', id, title, coalesce(last_verified_at, updated_at) FROM findings WHERE scope_id = $1 AND status = 'possibly_stale'
     ) x ORDER BY verified LIMIT $2`,
    [scope.id, LIMIT],
  );
  if (!published.rows.length && !waiting.rows.length && !stale.rows.length) return null;

  const link = (path: string, label: string) => {
    const url = absolute(settings, path);
    const text = slackEscape(outside(label).slice(0, 200));
    return url ? `<${slackUrl(url)}|${text}>` : text;
  };
  const more = (n: number, shown: number) => (n > shown ? `\n…and ${n - shown} more` : "");
  const parts = [`*${slackEscape(scope.name)}: ${frequency === "daily" ? "daily" : "weekly"} digest*`];
  const totals = { published: published.rows[0]?.n ?? 0, waiting: waiting.rows[0]?.n ?? 0, stale: stale.rows[0]?.n ?? 0 };
  if (totals.published)
    parts.push(
      `*Published ${frequency === "daily" ? "in the last day" : "this week"} (${totals.published})*\n${published.rows.map((r) => `• ${link(`#/${r.target_kind}/${r.target_id}`, r.summary)}`).join("\n")}${more(totals.published, published.rows.length)}`,
    );
  if (totals.waiting)
    parts.push(
      `*Waiting for review (${totals.waiting})*\n${waiting.rows.map((r) => `• ${link(`#/review/${r.id}`, r.summary)}: waiting ${ageText(r.created_at, now)}`).join("\n")}${more(totals.waiting, waiting.rows.length)}`,
    );
  if (totals.stale)
    parts.push(
      `*Needs re-verifying (${totals.stale})*\n${stale.rows.map((r) => `• ${link(`#/${r.kind}/${r.id}`, r.title)}: last verified ${ageText(r.verified, now)} ago`.replace(": last verified today ago", ": verified today")).join("\n")}${more(totals.stale, stale.rows.length)}`,
    );
  const open = absolute(settings, `#/project/${scope.slug}`);
  if (open) parts.push(`<${slackUrl(open)}|Open ${slackEscape(scope.name)} in Thaliyola>`);
  return { text: parts.join("\n\n"), totals };
}

type DigestRow = Destination & { route_id: string; digest: "daily" | "weekly"; digest_sent_at: string | null; slug: string; scope_name: string; route_scope: string };

const DIGEST_ROUTES = `SELECT r.id AS route_id, r.digest, r.digest_sent_at, r.scope_id AS route_scope, s.slug, s.name AS scope_name,
                              c.id, c.kind, c.name, c.scope_id, c.config, c.options, c.secret, false AS team
                         FROM notification_routes r JOIN connections c ON c.id = r.connection_id JOIN scopes s ON s.id = r.scope_id
                        WHERE r.digest <> 'off' AND c.kind = 'slack'`;

/** Builds and posts a route's digest; never throws (a failure comes back as `error`). */
async function postDigest(db: Db, settings: Settings, row: DigestRow, now: Date): Promise<{ sent: boolean; error?: string }> {
  let secret: Record<string, string> = {};
  try {
    const digest = await buildDigest(db, settings, { id: row.route_scope, slug: row.slug, name: row.scope_name }, row.digest, now);
    if (!digest) return { sent: false };
    secret = await openSecrets(db, settings, row);
    await send(row, settings, secret, { text: digest.text });
    await markDelivery(db, settings, row, { ok: true });
    return { sent: true };
  } catch (err) {
    const error = errorText(err, secret);
    // Rate-limited is busy, not broken: the destination keeps its health.
    if (!(err instanceof RateLimited)) await markDelivery(db, settings, row, { ok: false, error }).catch(() => undefined);
    return { sent: false, error };
  }
}

/** How many times a digest slot is tried (one try per tick) before it's given up on. */
export const DIGEST_TRIES = 3;

/**
 * Posts every digest that's due: one per route and slot, claimed before it's built so no instance posts it twice.
 * One that fails gives its slot back for the next tick, up to DIGEST_TRIES tries.
 */
export async function sendRouteDigests(db: Db, settings: Settings, now = new Date()) {
  if (!settings.connections?.enabled) return { sent: 0, empty: 0, failed: 0 };
  const { rows } = await db.query<DigestRow>(`${DIGEST_ROUTES} AND c.enabled AND s.status = 'active'`);
  let sent = 0;
  let empty = 0;
  let failed = 0;
  for (const row of rows) {
    const slot = row.digest === "daily" ? dailySlot(now, settings.digestHour) : digestSlot(now, settings.digestDay, settings.digestHour);
    const claimed = await db.query<{ previous: string | null; failures: number }>(
      `WITH old AS (SELECT id, digest_sent_at, digest_failures FROM notification_routes WHERE id = $1 FOR UPDATE)
       UPDATE notification_routes r SET digest_sent_at = $2 FROM old
        WHERE r.id = old.id AND (old.digest_sent_at IS NULL OR old.digest_sent_at < $3)
       RETURNING old.digest_sent_at AS previous, old.digest_failures AS failures`,
      [row.route_id, now, slot],
    );
    const claim = claimed.rows[0];
    if (!claim) continue;
    const r = await postDigest(db, settings, row, now);
    if (r.error) {
      failed++;
      const tries = claim.failures + 1;
      // Give the slot back for the next tick, unless that was the last try.
      await db
        .query(
          tries < DIGEST_TRIES
            ? "UPDATE notification_routes SET digest_sent_at = $2, digest_failures = $3 WHERE id = $1 AND digest_sent_at = $4"
            : "UPDATE notification_routes SET digest_failures = 0 WHERE id = $1",
          tries < DIGEST_TRIES ? [row.route_id, claim.previous, tries, now] : [row.route_id],
        )
        .catch((err) => console.error(`[notify] couldn't keep the digest slot for another try: ${errorText(err)}`));
      if (tries >= DIGEST_TRIES) console.error(`[notify] gave up on a digest for ${row.name} after ${tries} tries: ${r.error}`);
      continue;
    }
    if (claim.failures) await db.query("UPDATE notification_routes SET digest_failures = 0 WHERE id = $1", [row.route_id]);
    if (r.sent) sent++;
    else empty++;
  }
  return { sent, empty, failed };
}

/** Send now: posts the route's digest right away (a preview of the next one). Same budget as Test. */
export async function sendDigestNow(ctx: RequestContext, id: string) {
  if (!ctx.settings.connections?.enabled) throw new ForbiddenError("connections are turned off on this server (CONNECTIONS=off)");
  const r = await routeRow(ctx, id);
  if (r.digest === "off") throw new ValidationError("this route has no digest; choose daily or weekly first");
  const row = (await ctx.db.query<DigestRow>(`${DIGEST_ROUTES} AND r.id = $1`, [id])).rows[0];
  if (!row) throw new ValidationError("digests go to Slack only");
  if (!r.enabled) throw new ValidationError(`${r.name} is paused`);
  const done = await reserveTest(ctx, "send_digest", id, undefined, { targetKind: "notification_route", targetLabel: r.name, details: { destination: r.name, digest: r.digest } });
  try {
    const out = await postDigest(ctx.db, ctx.settings, row, new Date());
    if (out.error) return { ok: false as const, error: out.error };
    return out.sent
      ? { ok: true as const, sent: true, detail: `Posted the ${row.digest} digest to ${row.name}.` }
      : { ok: true as const, sent: false, detail: "Nothing to report: nothing was published, nothing waits for review and nothing needs re-verifying." };
  } finally {
    done();
  }
}

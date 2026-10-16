import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import { sendEmail } from "./notify.js";

/**
 * The weekly digest email: what changed in the scopes each person is part
 * of or watches, what waits for their review, what they own that needs
 * re-checking, and (for admins) the week's top knowledge gaps. Sent once
 * per week per person at DIGEST_DAY/DIGEST_HOUR server time to everyone who
 * hasn't turned it off; people with nothing to report get no email.
 */

/** The most recent digest slot at or before `now` (server local time). */
export function digestSlot(now: Date, day: number, hour: number): Date {
  const slot = new Date(now);
  slot.setHours(hour, 0, 0, 0);
  const diff = (slot.getDay() - day + 7) % 7;
  slot.setDate(slot.getDate() - diff);
  if (slot > now) slot.setDate(slot.getDate() - 7);
  return slot;
}

interface Person {
  id: string;
  email: string;
  name: string | null;
  admin: boolean;
}

async function digestFor(db: Db, p: Person) {
  // Scopes this person reads and cares about: shared scopes, projects they're in, anything they watch.
  const scopes = (
    await db.query<{ id: string }>(
      `SELECT s.id FROM scopes s
        WHERE (s.visibility = 'team' OR $2 OR s.id IN (SELECT scope_id FROM scope_roles WHERE user_id = $1))
          AND (s.kind <> 'project' OR s.id IN (SELECT scope_id FROM scope_roles WHERE user_id = $1)
               OR s.id IN (SELECT target_id FROM watches WHERE user_id = $1))`,
      [p.id, p.admin],
    )
  ).rows.map((r) => r.id);

  const changes = await db.query<{ summary: string; target_kind: string; target_id: string; scope: string }>(
    `SELECT r.summary, r.target_kind, r.target_id, s.slug AS scope FROM revisions r JOIN scopes s ON s.id = r.scope_id
      WHERE r.state = 'approved' AND r.decided_at > now() - interval '7 days' AND r.scope_id = ANY($1::uuid[]) AND r.author_id <> $2
        AND r.op IN ('create', 'update', 'promote', 'share')
      ORDER BY r.decided_at DESC LIMIT 10`,
    [scopes, p.id],
  );
  const toReview = await db.query<{ id: string; summary: string }>(
    `SELECT r.id, r.summary FROM revisions r
      WHERE r.state = 'pending' AND r.author_id <> $1
        AND ($2 OR r.scope_id IN (SELECT scope_id FROM scope_roles WHERE user_id = $1 AND role = 'owner'))
      ORDER BY r.created_at LIMIT 5`,
    [p.id, p.admin],
  );
  const stale = await db.query<{ id: string; title: string; kind: string }>(
    `SELECT id, title, 'article' AS kind FROM articles WHERE owner_id = $1 AND (status = 'possibly_stale' OR (status = 'published' AND review_due < current_date))
     UNION ALL SELECT id, title, 'finding' FROM findings WHERE author_id = $1 AND status = 'possibly_stale' LIMIT 5`,
    [p.id],
  );
  const unread = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [p.id])).rows[0]!.n;
  const gaps = p.admin
    ? (
        await db.query<{ query: string; n: number }>(
          `SELECT lower(query) AS query, count(*)::int AS n FROM search_log WHERE query IS NOT NULL AND at > now() - interval '7 days'
            GROUP BY 1 ORDER BY n DESC LIMIT 3`,
        )
      ).rows
    : [];

  const parts: string[] = [];
  if (changes.rows.length) parts.push(`New and updated (${changes.rows.length}):\n${changes.rows.map((c) => `• ${c.summary} — ${c.scope}`).join("\n")}`);
  if (toReview.rows.length) parts.push(`Waiting for your review:\n${toReview.rows.map((r) => `• ${r.summary}`).join("\n")}`);
  if (stale.rows.length) parts.push(`Yours to re-check (not verified recently):\n${stale.rows.map((s) => `• ${s.title}`).join("\n")}`);
  if (gaps.length) parts.push(`Searched for but not found this week:\n${gaps.map((g) => `• "${g.query}" (${g.n}×)`).join("\n")}`);
  if (!parts.length && !unread) return null;
  if (unread) parts.push(`${unread} unread notification${unread > 1 ? "s" : ""} in Cairn.`);
  return {
    subject: toReview.rows.length ? `Cairn weekly: ${toReview.rows.length} to review, ${changes.rows.length} updates` : `Cairn weekly: ${changes.rows.length} update${changes.rows.length === 1 ? "" : "s"}`,
    body: parts.join("\n\n"),
    link: toReview.rows.length ? "#/review" : "#/",
  };
}

export async function sendDigests(db: Db, settings: Settings, now = new Date()) {
  if (settings.mailTransport === "off") return { sent: 0, skipped: 0 };
  const slot = digestSlot(now, settings.digestDay, settings.digestHour);
  const { rows } = await db.query<Person>(
    `SELECT id, email, display_name AS name, (is_admin OR lower(email) = ANY($2::text[])) AS admin FROM users
      WHERE kind = 'human' AND disabled_at IS NULL AND email IS NOT NULL AND subject NOT LIKE 'pending:%'
        AND coalesce((prefs->>'digest')::boolean, true)
        AND (prefs->>'digest_sent_at' IS NULL OR (prefs->>'digest_sent_at')::timestamptz < $1)`,
    [slot.toISOString(), settings.adminEmails],
  );
  let sent = 0;
  for (const p of rows) {
    const d = await digestFor(db, p);
    // Mark first, so a crash mid-run never sends anyone two digests.
    await db.query("UPDATE users SET prefs = prefs || jsonb_build_object('digest_sent_at', $2::text) WHERE id = $1", [p.id, now.toISOString()]);
    if (!d) continue;
    sendEmail(settings, p.email, { subject: d.subject, body: d.body, link: d.link, openLabel: "Open Cairn", footer: "You get this weekly. Turn it off on your Cairn account page." });
    sent++;
  }
  return { sent, skipped: rows.length - sent };
}

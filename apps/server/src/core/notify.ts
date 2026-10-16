import { createHash, randomBytes } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import type { Settings } from "../config.js";
import type { Db, Queryable } from "../db/pool.js";

/**
 * Notifications: always in-app; also email (SMTP, per-user preferences) and a
 * team Slack channel (incoming webhook) when configured. Delivery is
 * asynchronous so writes never wait on a mail server.
 */

export type NotificationKind = "review" | "decided" | "change" | "watch" | "stale" | "comment" | "assigned" | "invite";

export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  /** In-app route, e.g. "#/review/<id>". */
  link: string;
  targetId?: string | null;
  /** Extra email-only action, e.g. a one-click approve link. */
  action?: { label: string; url: string };
}

export const NOTIFICATION_KINDS: { kind: NotificationKind; label: string }[] = [
  { kind: "review", label: "A proposal is waiting for my review" },
  { kind: "assigned", label: "A proposal is assigned to me" },
  { kind: "decided", label: "My proposal was approved or rejected" },
  { kind: "comment", label: "Someone commented on a proposal I'm part of" },
  { kind: "change", label: "A contract or shared design my project uses changed" },
  { kind: "watch", label: "Something I watch changed" },
  { kind: "stale", label: "Something I own needs re-verifying" },
];

const pending = new Set<Promise<unknown>>();
/** Tests and shutdown can wait for in-flight deliveries. */
export async function flushDeliveries() {
  while (pending.size) await Promise.allSettled([...pending]);
}
/** Registers background work (event handlers, deliveries) so flushDeliveries() can wait for it. */
export function track<T>(p: Promise<T>) {
  pending.add(p);
  p.finally(() => pending.delete(p)).catch(() => undefined);
  return p;
}

/** Messages captured by the "json" transport (tests and dry runs). */
export const outbox: { to: string; subject: string; text: string; html: string }[] = [];
export const slackOutbox: unknown[] = [];

let transporter: { key: string; t: Transporter | null } | null = null;
function mailer(settings: Settings): Transporter | null {
  const key = `${settings.mailTransport}:${settings.smtpUrl ?? ""}`;
  if (transporter?.key === key) return transporter.t;
  const t =
    settings.mailTransport === "smtp" && settings.smtpUrl
      ? nodemailer.createTransport(settings.smtpUrl)
      : settings.mailTransport === "json"
        ? nodemailer.createTransport({ jsonTransport: true })
        : null;
  transporter = { key, t };
  return t;
}

const abs = (settings: Settings, link: string) => (settings.publicUrl ? `${settings.publicUrl}/${link.replace(/^\//, "")}` : link);
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function emailHtml(settings: Settings, n: NotificationInput, opts: { footer?: string; openLabel?: string } = {}) {
  const open = abs(settings, n.link);
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a">
<div style="max-width:560px;margin:24px auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px">
<div style="font-weight:650;font-size:15px;margin-bottom:16px">Cairn</div>
<div style="font-size:17px;font-weight:600;margin-bottom:8px">${escapeHtml(n.title)}</div>
${n.body ? `<div style="font-size:14px;color:#334155;line-height:1.55;white-space:pre-wrap;margin-bottom:16px">${escapeHtml(n.body)}</div>` : ""}
<div>${n.action ? `<a href="${escapeHtml(n.action.url)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;margin-right:8px">${escapeHtml(n.action.label)}</a>` : ""}
<a href="${escapeHtml(open)}" style="display:inline-block;border:1px solid #d6dae1;color:#0f172a;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600">${escapeHtml(opts.openLabel ?? "Open in Cairn")}</a></div>
<div style="font-size:12px;color:#64748b;margin-top:24px">${escapeHtml(opts.footer ?? "Change which emails you get on your Cairn account page.")}</div>
</div></body></html>`;
}

interface Recipient {
  id: string;
  email: string | null;
  kind: string;
  prefs: { email?: Partial<Record<NotificationKind, boolean>> };
}

/** Creates in-app notifications for each user (deduplicated, never the actor) and sends emails per preference. */
export async function notify(db: Queryable, settings: Settings, userIds: string[], n: NotificationInput, opts: { exclude?: string; actions?: Map<string, NotificationInput["action"]> } = {}) {
  const ids = [...new Set(userIds)].filter((id) => id && id !== opts.exclude);
  if (!ids.length) return;
  const { rows } = await db.query<Recipient>("SELECT id, email, kind, prefs FROM users WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL", [ids]);
  for (const u of rows) {
    await db.query("INSERT INTO notifications (user_id, kind, title, body, link, target_id) VALUES ($1, $2, $3, $4, $5, $6)", [
      u.id,
      n.kind,
      n.title.slice(0, 300),
      (n.body ?? "").slice(0, 2000),
      n.link,
      n.targetId ?? null,
    ]);
    const t = mailer(settings);
    if (!t || !u.email || u.kind !== "human" || u.prefs?.email?.[n.kind] === false) continue;
    const msg = { ...n, action: opts.actions?.get(u.id) ?? n.action };
    track(
      t
        .sendMail({ from: settings.mailFrom, to: u.email, subject: n.title, text: `${n.title}\n\n${n.body ?? ""}\n\n${abs(settings, n.link)}`, html: emailHtml(settings, msg) })
        .then(() => {
          if (settings.mailTransport === "json") outbox.push({ to: u.email!, subject: n.title, text: n.body ?? "", html: emailHtml(settings, msg) });
        })
        .catch((err) => console.error(`[notify] email to ${u.email} failed: ${(err as Error).message}`)),
    );
  }
}

/** Sends one email that isn't tied to a user's notification preferences (invitations, digests). Returns false if mail is off. */
export function sendEmail(settings: Settings, to: string, msg: { subject: string; body: string; link: string; openLabel: string; footer: string }) {
  const t = mailer(settings);
  if (!t) return false;
  const n: NotificationInput = { kind: "invite", title: msg.subject, body: msg.body, link: msg.link };
  const html = emailHtml(settings, n, { openLabel: msg.openLabel, footer: msg.footer });
  track(
    t
      .sendMail({ from: settings.mailFrom, to, subject: msg.subject, text: `${msg.body}\n\n${abs(settings, msg.link)}`, html })
      .then(() => {
        if (settings.mailTransport === "json") outbox.push({ to, subject: msg.subject, text: msg.body, html });
      })
      .catch((err) => console.error(`[notify] email to ${to} failed: ${(err as Error).message}`)),
  );
  return true;
}

/** Posts a one-line message to the team Slack channel (incoming webhook), if configured. */
export function slack(settings: Settings, text: string, link?: string) {
  if (!settings.slackWebhookUrl) return;
  const payload = { text: link ? `${text}\n<${abs(settings, link)}|Open in Cairn>` : text };
  if (settings.slackWebhookUrl === "test") {
    slackOutbox.push(payload);
    return;
  }
  track(
    fetch(settings.slackWebhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })
      .then((r) => (r.ok ? undefined : console.error(`[notify] slack webhook returned ${r.status}`)))
      .catch((err) => console.error(`[notify] slack webhook failed: ${(err as Error).message}`)),
  );
}

// ---- Who gets what --------------------------------------------------------------

/** Scope owners plus admins (account flag or ADMIN_EMAILS). */
export async function reviewersFor(db: Queryable, settings: Settings, scopeId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.kind = 'human' AND u.disabled_at IS NULL AND (
       u.is_admin OR lower(u.email) = ANY($2::text[])
       OR u.id IN (SELECT user_id FROM scope_members WHERE scope_id = $1 AND role = 'owner'))`,
    [scopeId, settings.adminEmails],
  );
  return rows.map((r) => r.id);
}

export async function membersOf(db: Queryable, scopeId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>("SELECT user_id FROM scope_members WHERE scope_id = $1", [scopeId]);
  return rows.map((r) => r.user_id);
}

export async function watchersOf(db: Queryable, targetIds: string[]): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>("SELECT DISTINCT user_id FROM watches WHERE target_id = ANY($1::uuid[])", [targetIds]);
  return rows.map((r) => r.user_id);
}

// ---- One-click actions from email ----------------------------------------------------

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function createActionToken(db: Queryable, userId: string, revisionId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db.query(
    "INSERT INTO action_tokens (token_hash, user_id, action, revision_id, expires_at) VALUES ($1, $2, 'approve', $3, now() + interval '7 days')",
    [sha256(token), userId, revisionId],
  );
  return token;
}

/** Looks up a still-usable action token (without using it). */
export async function peekActionToken(db: Db, token: string) {
  const { rows } = await db.query<{ user_id: string; revision_id: string; action: string }>(
    "SELECT user_id, revision_id, action FROM action_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()",
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function consumeActionToken(db: Db, token: string) {
  const { rows } = await db.query<{ user_id: string; revision_id: string }>(
    "UPDATE action_tokens SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id, revision_id",
    [sha256(token)],
  );
  return rows[0] ?? null;
}

// ---- Events --------------------------------------------------------------------------

/** A new proposal: reviewers get an in-app notification and an email with a one-click approve link. */
export async function onProposal(db: Db, settings: Settings, revisionId: string) {
  const { rows } = await db.query(
    `SELECT r.id, r.scope_id, r.author_id, r.summary, r.op, r.state, r.assignee_id, s.name AS scope_name, coalesce(u.display_name, u.email, u.subject) AS author
       FROM revisions r JOIN scopes s ON s.id = r.scope_id JOIN users u ON u.id = r.author_id WHERE r.id = $1`,
    [revisionId],
  );
  const r = rows[0];
  if (!r || r.state !== "pending") return;
  const reviewers = await reviewersFor(db, settings, r.scope_id);
  const actions = new Map<string, NotificationInput["action"]>();
  if (settings.publicUrl) {
    for (const id of reviewers) {
      if (id === r.author_id) continue;
      actions.set(id, { label: "Approve", url: `${settings.publicUrl}/actions/${await createActionToken(db, id, r.id)}` });
    }
  }
  await notify(
    db,
    settings,
    reviewers,
    { kind: "review", title: `Review: ${r.summary}`, body: `${r.author} proposed a change in ${r.scope_name}.`, link: `#/review/${r.id}`, targetId: r.id },
    { exclude: r.author_id, actions },
  );
  slack(settings, `:inbox_tray: *${r.author}* proposed in *${r.scope_name}*: ${r.summary}`, `#/review/${r.id}`);
}

/** A decision: the author hears about it; watchers hear about approved changes to what they watch. */
export async function onDecision(db: Db, settings: Settings, revisionId: string, reviewerId: string) {
  const { rows } = await db.query(
    `SELECT r.id, r.author_id, r.summary, r.state, r.reason, r.target_id, r.target_kind, r.op, coalesce(u.display_name, u.email, u.subject) AS reviewer
       FROM revisions r JOIN users u ON u.id = $2 WHERE r.id = $1`,
    [revisionId, reviewerId],
  );
  const r = rows[0];
  if (!r) return;
  const itemLink = `#/${r.target_kind}/${r.target_id}`;
  await notify(
    db,
    settings,
    [r.author_id],
    {
      kind: "decided",
      title: `${r.state === "approved" ? "Approved" : "Rejected"}: ${r.summary}`,
      body: r.state === "rejected" ? `${r.reviewer} rejected it: ${r.reason ?? ""}` : `${r.reviewer} approved it.`,
      link: r.state === "approved" ? itemLink : `#/review/${r.id}`,
      targetId: r.target_id,
    },
    { exclude: reviewerId },
  );
  if (r.state === "approved" && r.op !== "create") {
    await notify(db, settings, await watchersOf(db, [r.target_id]), { kind: "watch", title: `Changed: ${r.summary}`, body: `Approved by ${r.reviewer}.`, link: itemLink, targetId: r.target_id }, { exclude: reviewerId });
  }
}

/** Impact notices raised by an approval: members and watchers of affected projects, and watchers of the source. */
export async function onImpactNotices(db: Db, settings: Settings, sourceId: string, version: number) {
  const { rows } = await db.query<{ scope_id: string; summary: string; source_title: string; project: string }>(
    `SELECT coalesce(n.scope_id, c.scope_id) AS scope_id, n.summary, coalesce(a.title, '') AS source_title, s.slug AS project
       FROM impact_notices n LEFT JOIN components c ON c.id = n.component_id
       LEFT JOIN articles a ON a.id = n.source_id
       JOIN scopes s ON s.id = coalesce(n.scope_id, c.scope_id)
      WHERE n.source_id = $1 AND n.source_version = $2`,
    [sourceId, version],
  );
  for (const n of rows) {
    const people = [...(await membersOf(db, n.scope_id)), ...(await watchersOf(db, [n.scope_id, sourceId]))];
    await notify(db, settings, people, {
      kind: "change",
      title: `Upstream change for ${n.project}: ${n.summary}`,
      body: `${n.source_title} changed. Check what your code needs to handle.`,
      link: `#/project/${n.project}`,
      targetId: sourceId,
    });
  }
  if (rows.length) slack(settings, `:bell: ${rows.length} project(s) affected by a change: ${rows[0]!.summary}`, `#/article/${sourceId}`);
}

/** Entries flagged as stale: their owners or authors. */
export async function onStale(db: Db, settings: Settings, items: { id: string; kind: string; title: string; owner_id: string | null }[]) {
  for (const it of items) {
    if (!it.owner_id) continue;
    await notify(db, settings, [it.owner_id], {
      kind: "stale",
      title: `Needs re-verifying: ${it.title}`,
      body: "Nobody has confirmed this recently. Check it still holds, then mark it still valid or fix it.",
      link: `#/${it.kind}/${it.id}`,
      targetId: it.id,
    });
  }
}

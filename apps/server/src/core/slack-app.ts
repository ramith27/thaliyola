import { createHmac } from "node:crypto";
import type { Settings } from "../config.js";
import type { Db, Queryable } from "../db/pool.js";
import { sameText } from "./connections/webhooks.js";
import type { RequestContext } from "./context.js";
import { declareIncident, type Severity } from "./incidents.js";
import { redact } from "./redaction.js";
import { searchKnowledge } from "./search.js";
import { askSession } from "./sessions.js";
import { actorById } from "./users.js";

/**
 * The /thaliyola slash command in Slack: search the team's knowledge, ask a Claude session or an expert (the answer is
 * posted in the thread when it comes), or declare an incident. Every command runs as the Thaliyola person whose
 * verified email matches the Slack user, with that person's permissions; nobody else can act through it.
 */

const HELP = [
  "*/thaliyola search* <words> — the best matches in Thaliyola (only you see them)",
  "*/thaliyola ask* <who> <question> — ask a Claude session or person: a session handle, an email, a project, or `expert:<topic>`. The answer is posted in the thread.",
  "*/thaliyola incident* <what's broken> [in <project>] [sev1-4] — declare an incident",
].join("\n");

export interface SlackAnswer {
  status: number;
  body: Record<string, unknown> | string;
  /** The command's work after the 3-second acknowledgement (tests await it). */
  work?: Promise<unknown>;
}

const api = (settings: Settings) => (settings.slackApp?.apiUrl ?? "https://slack.com/api").replace(/\/+$/, "");

async function slackCall<T>(settings: Settings, method: string, body: Record<string, unknown>): Promise<T & { ok: boolean; error?: string }> {
  const f = settings.slackApp?.fetch ?? fetch;
  const res = await f(`${api(settings)}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.slackApp?.botToken ?? ""}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return (await res.json()) as T & { ok: boolean; error?: string };
}

async function respond(settings: Settings, responseUrl: string, msg: { text: string; response_type?: "ephemeral" | "in_channel"; replace_original?: boolean }) {
  if (!/^https:\/\/hooks\.slack\.com\//.test(responseUrl) && !settings.slackApp?.apiUrl) return;
  const f = settings.slackApp?.fetch ?? fetch;
  await f(responseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", ...msg }), signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}

/** Slack's request signature: v0=HMAC-SHA256(secret, "v0:<timestamp>:<raw body>"), within 5 minutes. */
export function verifySlack(secret: string, headers: Record<string, string | undefined>, raw: Buffer, now = Date.now()): boolean {
  const ts = headers["x-slack-request-timestamp"] ?? "";
  const sig = headers["x-slack-signature"] ?? "";
  if (!secret || !/^\d+$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  return sameText(sig, `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw.toString("utf8")}`).digest("hex")}`);
}

/** The Thaliyola person for a Slack user: cached, else matched by the email Slack holds (users:read.email). */
async function personFor(db: Db, settings: Settings, slackUser: string) {
  const cached = (await db.query<{ id: string }>("SELECT id FROM users WHERE slack_user_id = $1 AND disabled_at IS NULL AND approved_at IS NOT NULL", [slackUser])).rows[0];
  if (cached) return actorById(db, cached.id);
  const info = await slackCall<{ user?: { profile?: { email?: string }; is_bot?: boolean; deleted?: boolean } }>(settings, "users.info", { user: slackUser }).catch(() => null);
  const email = info?.ok && !info.user?.is_bot && !info.user?.deleted ? info.user?.profile?.email?.toLowerCase() : undefined;
  if (!email) return undefined;
  const u = (await db.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 AND kind = 'human' AND disabled_at IS NULL AND approved_at IS NOT NULL LIMIT 1", [email])).rows[0];
  if (!u) return undefined;
  await db.query("UPDATE users SET slack_user_id = NULL WHERE slack_user_id = $1", [slackUser]);
  await db.query("UPDATE users SET slack_user_id = $2 WHERE id = $1", [u.id, slackUser]);
  return actorById(db, u.id);
}

/** A project for a channel: the one whose Slack notification route posts there. */
async function projectForChannel(db: Queryable, channel: string) {
  return (
    await db.query<{ slug: string }>(
      `SELECT s.slug FROM notification_routes r JOIN connections c ON c.id = r.connection_id JOIN scopes s ON s.id = r.scope_id
        WHERE c.kind = 'slack' AND c.config->>'channel' = $1 AND s.kind = 'project' AND s.status = 'active' ORDER BY r.created_at LIMIT 1`,
      [channel],
    )
  ).rows[0]?.slug;
}

const link = (settings: Settings, path: string) => `${settings.publicUrl?.replace(/\/+$/, "") ?? ""}/#${path}`;

/** One slash command: verified, acknowledged at once, done afterwards through response_url. */
export async function receiveSlackCommand(db: Db, settings: Settings, headers: Record<string, string | undefined>, raw: Buffer): Promise<SlackAnswer> {
  const secret = settings.slackApp?.signingSecret;
  if (!secret || !settings.slackApp?.botToken) return { status: 404, body: { error: "the Slack app isn't set up on this server" } };
  if (!verifySlack(secret, headers, raw)) return { status: 401, body: { error: "bad signature" } };
  const p = new URLSearchParams(raw.toString("utf8"));
  const text = (p.get("text") ?? "").trim();
  const [verb = "", ...rest] = text.split(/\s+/);
  const arg = rest.join(" ").trim();
  const responseUrl = p.get("response_url") ?? "";
  const channel = p.get("channel_id") ?? "";
  const slackUser = p.get("user_id") ?? "";
  if (!verb || verb === "help" || !["search", "ask", "incident"].includes(verb.toLowerCase())) return { status: 200, body: { response_type: "ephemeral", text: HELP } };

  const work = (async () => {
    const actor = await personFor(db, settings, slackUser);
    if (!actor) return respond(settings, responseUrl, { text: "There's no Thaliyola account with your Slack email (or it's waiting for approval). Ask an Administrator to add you." });
    const ctx: RequestContext = { db, settings, actor };
    try {
      switch (verb.toLowerCase()) {
        case "search": {
          if (!arg) return respond(settings, responseUrl, { text: "Search for what? `/thaliyola search refund timeout`" });
          const r = await searchKnowledge(ctx, { query: arg, scope: "all", limit: 3 });
          const hits = [...r.articles, ...r.findings].sort((a, b) => b.score - a.score).slice(0, 3);
          if (!hits.length) return respond(settings, responseUrl, { text: `Nothing in Thaliyola matches “${arg}”.` });
          const lines = hits.map((h) => `• <${link(settings, `/${h.kind}/${h.id}`)}|${h.title}> (${h.scope.slug})${h.section ? ` › ${h.section}` : ""}\n> ${redact(h.snippet.replace(/\s+/g, " ").slice(0, 280)).text}`);
          return respond(settings, responseUrl, { text: `Best matches for “${arg}”:\n${lines.join("\n")}` });
        }
        case "ask": {
          const m = /^(\S+)\s+([\s\S]+)$/.exec(arg);
          if (!m) return respond(settings, responseUrl, { text: "`/thaliyola ask <who> <question>`: who is a session handle, an email, a project, or expert:<topic>." });
          const [, to, question] = m as unknown as [string, string, string];
          // The question goes in the channel (the answer will be threaded under it); fall back to this command's response URL.
          const posted = await slackCall<{ ts?: string; channel?: string }>(settings, "chat.postMessage", { channel, text: `<@${slackUser}> asked ${to}: ${question}\n_The answer will appear in this thread._` }).catch(() => null);
          const reply = posted?.ok && posted.ts ? { channel: posted.channel ?? channel, thread_ts: posted.ts } : { response_url: responseUrl };
          const r = (await askSession(ctx, { to, question, context: "Asked from Slack.", wait_seconds: 0 })) as { id?: string; to?: string; asked?: string[] };
          if (r.id) await db.query("UPDATE session_questions SET reply_slack = $2 WHERE id = $1 OR group_id = $1", [r.id, JSON.stringify(reply)]);
          if (!posted?.ok) await respond(settings, responseUrl, { text: `Asked ${r.asked?.join(", ") ?? r.to ?? to}. I'll post the answer here when it comes (invite the Thaliyola app to this channel to get it in a thread).` });
          return;
        }
        case "incident": {
          let rest2 = arg;
          let severity: Severity | undefined;
          const sev = /\b(sev[1-4])\b/i.exec(rest2);
          if (sev) {
            severity = sev[1]!.toLowerCase() as Severity;
            rest2 = rest2.replace(sev[0], "").trim();
          }
          const inProject = /\s+in\s+([a-z0-9][a-z0-9-]*)\s*$/i.exec(rest2);
          const project = inProject?.[1] ?? (await projectForChannel(db, channel));
          const title = (inProject ? rest2.slice(0, inProject.index) : rest2).trim();
          if (!title) return respond(settings, responseUrl, { text: "`/thaliyola incident <what's broken> [in <project>] [sev1-4]`" });
          if (!project) return respond(settings, responseUrl, { text: "Which project? Add `in <project>` (this channel isn't a project's Slack channel)." });
          const r = await declareIncident(ctx, { project, title, severity, via: "slack" });
          return respond(settings, responseUrl, { response_type: "in_channel", text: `:rotating_light: ${String(r.severity).toUpperCase()} incident declared in ${r.project} by <@${slackUser}>: <${link(settings, `/incidents/${r.id}`)}|${r.title}>` });
        }
      }
    } catch (err) {
      return respond(settings, responseUrl, { text: `Couldn't do that: ${(err as Error).message}` });
    }
  })();
  return { status: 200, body: { response_type: "ephemeral", text: verb.toLowerCase() === "search" ? "Searching…" : "On it…" }, work };
}

/** An answer to a question asked from Slack: posted in the thread (or through the command's response URL). */
export async function replyInSlack(settings: Settings, reply: { channel?: string; thread_ts?: string; response_url?: string } | null, text: string) {
  if (!reply || !settings.slackApp?.botToken) return;
  const body = redact(text).text.slice(0, 3500);
  if (reply.channel && reply.thread_ts) await slackCall(settings, "chat.postMessage", { channel: reply.channel, thread_ts: reply.thread_ts, text: body }).catch(() => undefined);
  else if (reply.response_url) await respond(settings, reply.response_url, { response_type: "in_channel", text: body });
}

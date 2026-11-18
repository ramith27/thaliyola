import { ValidationError } from "../context.js";
import { base, call, callJson, failWith, RemoteError } from "./remote.js";
import type { ConnTarget, DriverEnv, TestResult } from "./types.js";

/**
 * Slack as a place notifications go: a bot token (chat.postMessage to a channel) or an incoming webhook. Test posts a
 * short test message, so people see where notifications will land (a bot token is checked with auth.test first).
 */

export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[\w/-]+$/;

/** Slack's mrkdwn treats &, < and > as markup; everything else is shown as written. */
export const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One message: `text` is mrkdwn (already escaped where it holds outside text). */
export interface SlackMessage {
  text: string;
}

/** Where a webhook URL really goes: Slack, or (tests only) the mock standing in for hooks.slack.com. */
function webhookUrl(url: string, env: DriverEnv): string {
  const mock = env.endpoints?.slack_hooks;
  return mock ? url.replace(/^https:\/\/hooks\.slack\.com/, mock.replace(/\/+$/, "")) : url;
}

/** Posts one message. Throws (a RemoteError for HTTP failures, with the status) when Slack doesn't take it. */
export async function postSlack(c: ConnTarget, env: DriverEnv, msg: SlackMessage): Promise<void> {
  if (c.secret.bot_token) {
    const r = await callJson<{ ok: boolean; error?: string }>(`${base(env, "slack", "https://slack.com")}/api/chat.postMessage`, "http", env, "Slack", {
      method: "POST",
      headers: { authorization: `Bearer ${c.secret.bot_token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: c.config.channel, text: msg.text, unfurl_links: false, unfurl_media: false }),
    });
    if (!r.ok) {
      const hint = r.error === "not_in_channel" ? " (invite the bot to the channel)" : r.error === "channel_not_found" ? " (check the channel ID)" : "";
      throw new ValidationError(`Slack said ${r.error ?? "it didn't post the message"}${hint}`);
    }
    return;
  }
  if (c.secret.webhook_url) {
    if (!SLACK_WEBHOOK.test(c.secret.webhook_url)) throw new ValidationError("a Slack incoming webhook starts with https://hooks.slack.com/");
    const res = await call(webhookUrl(c.secret.webhook_url, env), "http", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: msg.text, unfurl_links: false, unfurl_media: false }),
      // A webhook answers "ok"; a redirect would mean it isn't Slack's.
      followRedirects: false,
    });
    if (res.status === 404 || res.status === 410) throw new RemoteError("Slack doesn't know this webhook any more (it was removed or the channel archived)", res.status);
    if (res.status < 200 || res.status >= 300) failWith(res, "Slack");
    return;
  }
  throw new ValidationError("add a bot token or an incoming webhook URL");
}

export async function testSlack(c: ConnTarget, env: DriverEnv): Promise<TestResult> {
  let who = "";
  if (c.secret.bot_token) {
    const r = await callJson<{ ok: boolean; error?: string; team?: string; user?: string }>(`${base(env, "slack", "https://slack.com")}/api/auth.test`, "http", env, "Slack", {
      method: "POST",
      headers: { authorization: `Bearer ${c.secret.bot_token}`, "content-type": "application/x-www-form-urlencoded" },
      body: "",
    });
    if (!r.ok) throw new ValidationError(`Slack said ${r.error ?? "the token doesn't work"}`);
    who = ` to Slack workspace ${r.team ?? ""} as ${r.user ?? "the bot"}`.replace("  ", " ");
  } else if (!c.secret.webhook_url) throw new ValidationError("add a bot token or an incoming webhook URL");
  await postSlack(c, env, { text: ":wave: A test message from Thaliyola: notifications routed to this connection will appear here." });
  return { detail: `Connected${who}${c.config.channel && c.secret.bot_token ? ` and posted a test message to ${c.config.channel}` : " and posted a test message"}.` };
}

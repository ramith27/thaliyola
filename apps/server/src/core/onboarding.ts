import type { RequestContext } from "./context.js";
import { isAdmin } from "./permissions.js";

export interface Step {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  link: string;
}

/**
 * The first-run checklist on the home page, worked out from what has
 * actually happened (nothing to tick by hand). Admins see setup steps;
 * everyone sees the steps that make Cairn useful to them.
 */
export async function onboarding(ctx: RequestContext): Promise<{ steps: Step[]; dismissed: boolean }> {
  const db = ctx.db;
  const me = ctx.actor.id;
  const admin = isAdmin(ctx);
  const one = async (sql: string, params: unknown[] = []) => ((await db.query<{ ok: boolean }>(`SELECT EXISTS (${sql}) AS ok`, params)).rows[0]?.ok ?? false);

  const connected =
    (await one("SELECT 1 FROM api_tokens WHERE user_id = $1 AND revoked_at IS NULL", [me])) ||
    (await one("SELECT 1 FROM oauth_tokens WHERE user_id = $1 AND revoked_at IS NULL", [me])) ||
    // Any MCP tool call (web UI calls are logged as api:*).
    (await one("SELECT 1 FROM audit_log WHERE actor_id = $1 AND tool NOT LIKE 'api:%' AND tool NOT IN ('login', 'accept_invitation', 'change_password', 'approve_revision', 'reject_revision') LIMIT 1", [me]));
  const prefs = (await db.query<{ prefs: Record<string, unknown> }>("SELECT prefs FROM users WHERE id = $1", [me])).rows[0]?.prefs ?? {};

  const steps: Step[] = [];
  if (admin) {
    steps.push({
      key: "project",
      title: "Create a project",
      detail: "Projects hold design docs, contracts and findings for one product or service. Start one with a starter pack.",
      done: await one("SELECT 1 FROM scopes WHERE kind = 'project'"),
      link: "#/new/project",
    });
    if (ctx.settings.authMode === "local") {
      steps.push({
        key: "invite",
        title: "Invite your team",
        detail: "Send email invitations; people choose their own password.",
        done: await one("SELECT 1 FROM users WHERE kind = 'human' AND id <> $1 AND disabled_at IS NULL", [me]),
        link: "#/admin/users",
      });
    }
    steps.push({
      key: "email",
      title: "Set up email",
      detail: "Reviewers get proposals by email with a one-click approve link. Set MAIL_TRANSPORT=smtp and SMTP_URL on the server.",
      done: ctx.settings.mailTransport !== "off",
      link: "https://github.com/ramith27/cairn-mcp#notifications",
    });
  }
  steps.push({
    key: "connect",
    title: "Connect Claude",
    detail: "Add Cairn to Claude Code or claude.ai so your sessions search the team's knowledge first.",
    done: connected,
    link: "#/connect",
  });
  steps.push({
    key: "write",
    title: admin ? "Add your first knowledge" : "Add something you know",
    detail: "Write an article, paste a Slack thread to draft a finding, or import existing docs (Markdown, HTML, Notion, Confluence).",
    done: await one("SELECT 1 FROM revisions WHERE author_id = $1", [me]),
    link: admin ? "#/import" : "#/new/paste",
  });
  steps.push({
    key: "follow",
    title: "Follow what matters to you",
    detail: "Watch a project or favourite an article to hear about changes and keep it one click away.",
    done: (await one("SELECT 1 FROM watches WHERE user_id = $1", [me])) || (await one("SELECT 1 FROM favourites WHERE user_id = $1", [me])),
    link: "#/",
  });
  return { steps, dismissed: prefs.onboarding_dismissed === true };
}

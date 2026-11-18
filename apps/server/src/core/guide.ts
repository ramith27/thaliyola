import type { RequestContext } from "./context.js";

/**
 * The Guide's per-person progress: which features this person has used, worked out from what they (and their
 * agents) actually did (the audit log, their sessions, their projects), with a concrete next step for the rest.
 * Read-only and cheap: one EXISTS per action, on indexed columns.
 */

interface Step {
  /** Done when any of these actions appears for this person (MCP or web). */
  actions: string[];
  /** Done when this SQL (with $1 = the person) returns a row. */
  sql?: string;
  tip: string;
}

const STEPS: Record<string, Step> = {
  connect: { actions: [], sql: "SELECT 1 FROM audit_log WHERE actor_id = $1 AND via = 'mcp' LIMIT 1", tip: "Connect Claude (Connect in the sidebar) so it searches the team's knowledge before it investigates." },
  knowledge: {
    actions: ["search_knowledge", "get_project_context", "propose_finding", "create_article", "propose_article_edit"],
    tip: "Ask Claude about a problem as it first appeared: it searches Thaliyola first. When you've found a root cause, ask it to capture it.",
  },
  review: { actions: ["approve_revision", "reject_revision", "review_proposal"], tip: "Open Review to approve or reject what agents proposed (if you review a project)." },
  docs: { actions: ["docs_begin", "docs_finish"], tip: "In a repository, run /mcp__thaliyola__document-repo once; then update-docs keeps it current." },
  design: {
    actions: ["get_design_system", "update_design_system", "record_design_decision", "check_design_drift"],
    tip: "Run /mcp__thaliyola__capture-design in an app's repository, or base its design on the Library's.",
  },
  sessions: {
    actions: ["ask_session", "wait_for_questions", "answer_question", "handoff_session", "claim_work"],
    sql: "SELECT 1 FROM agent_sessions WHERE user_id = $1 AND client = 'claude-code' LIMIT 1",
    tip: "Install the Claude Code plugin: without it, /thaliyola:ask, /thaliyola:listen, /thaliyola:busy and the warnings before editing a file another session is on don't work.",
  },
  security: { actions: ["scan_dependencies", "upload_dependencies", "record_security_review"], tip: "Run /mcp__thaliyola__security-check in a repository, or add the lockfile step from the CI templates." },
  advisories: { actions: ["latest_advisories", "set_advisory_response"], tip: "Open Security → Advisories and record whether each critical one affects your projects." },
  inbox: { actions: ["resolve_inbox_item", "create_source"], tip: "Add a source (or a GitHub/Sentry webhook) on Inbox → Sources, then triage what arrives." },
  projects: { actions: [], sql: "SELECT 1 FROM scope_roles r JOIN scopes s ON s.id = r.scope_id WHERE r.user_id = $1 AND s.kind = 'project' LIMIT 1", tip: "Join or create a project (+ New project) so sessions find their project from the git remote." },
};

export async function guideProgress(ctx: RequestContext) {
  const all = [...new Set(Object.values(STEPS).flatMap((s) => s.actions))];
  const used = new Set(
    (
      await ctx.db.query<{ a: string }>(
        "SELECT a FROM unnest($2::text[]) AS a WHERE EXISTS (SELECT 1 FROM audit_log l WHERE l.actor_id = $1 AND l.action = a)",
        [ctx.actor.id, all],
      )
    ).rows.map((r) => r.a),
  );
  const out: Record<string, { done: boolean; tip?: string }> = {};
  for (const [id, step] of Object.entries(STEPS)) {
    let done = step.actions.some((a) => used.has(a));
    if (step.sql) {
      const hit = ((await ctx.db.query(step.sql, [ctx.actor.id])).rowCount ?? 0) > 0;
      // Sessions need the plugin to count as set up; elsewhere the SQL is an alternative.
      done = id === "sessions" ? hit : done || hit;
    }
    out[id] = done ? { done } : { done, tip: step.tip };
  }
  // The plugin is there but this person's sessions have never had the edit hooks run: an older plugin.
  if (out.sessions?.done) {
    const hooks = (await ctx.db.query("SELECT 1 FROM audit_log WHERE actor_id = $1 AND action IN ('check_path', 'touch_path') LIMIT 1", [ctx.actor.id])).rowCount;
    if (!hooks) out.sessions = { done: true, tip: "Update the Claude Code plugin (0.3.0 or later) to get /thaliyola:handoff and the warning before editing a file another session is working on." };
  }
  const done = Object.values(out).filter((s) => s.done).length;
  return { features: out, done, total: Object.keys(out).length };
}

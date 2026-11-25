import type { Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { NotFoundError, ValidationError, type RequestContext } from "./context.js";
import { emitChanged } from "./events.js";
import { assertCanManage } from "./permissions.js";
import { getReadableScope } from "./scopes.js";

/**
 * Rules for agents: paths in a project's repositories with something to know before editing. The Claude Code plugin
 * checks each edit (check-path) and acts on them:
 * - read_first: the first edit in a session is stopped, with what to read; once shown, edits go ahead.
 * - never_edit: the person is asked every time (they may still say yes: it's their call, recorded).
 * - heads_up: Claude is told (who to talk to, what to keep in mind); nothing is stopped.
 * Agents also see a project's rules in get_project_context, before they start.
 */

export type RuleKind = "read_first" | "never_edit" | "heads_up";

export interface Rule {
  id: string;
  component: string | null;
  kind: RuleKind;
  paths: string[];
  article: { id: string; title: string } | null;
  message: string;
  enabled: boolean;
}

/** A path glob as a regular expression: ** any depth, * within one folder, ? one character; a folder matches what's under it. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.?\/+/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      // "**/" matches zero or more folders.
      if (g[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}${g.endsWith("/") ? ".*" : "(?:/.*)?"}$`);
}

export const pathMatches = (globs: string[], path: string) => globs.some((g) => globToRegExp(g).test(path.replace(/^\.?\/+/, "")));

async function rows(db: Queryable, scopeId: string, onlyEnabled: boolean): Promise<Rule[]> {
  const { rows } = await db.query<Rule & { article_id: string | null; article_title: string | null }>(
    `SELECT r.id, r.component, r.kind, r.paths, r.article_id, a.title AS article_title, r.message, r.enabled
       FROM project_rules r LEFT JOIN articles a ON a.id = r.article_id
      WHERE r.scope_id = $1 AND ($2::boolean IS FALSE OR r.enabled) ORDER BY r.kind, r.created_at`,
    [scopeId, onlyEnabled],
  );
  return rows.map(({ article_id, article_title, ...r }) => ({ ...r, article: article_id ? { id: article_id, title: article_title ?? "" } : null }));
}

/** A project's rules (everyone who can read the project). */
export async function listRules(ctx: RequestContext, project: string) {
  const scope = await getReadableScope(ctx, project);
  return { project: scope.slug, rules: await rows(ctx.db, scope.id, false) };
}

/** Enabled rules for a project's repository, for get_project_context. */
export async function rulesFor(db: Queryable, scopeId: string, component?: string | null) {
  return (await rows(db, scopeId, true)).filter((r) => !r.component || !component || r.component === component);
}

/** Adds or changes a rule. Project admins. */
export async function setRule(
  ctx: RequestContext,
  input: { project: string; id?: string; kind: RuleKind; paths: string[]; component?: string | null; article_id?: string | null; message: string; enabled?: boolean },
) {
  const scope = await getReadableScope(ctx, input.project);
  await assertCanManage(ctx, scope);
  const paths = [...new Set(input.paths.map((p) => p.trim().replace(/^\.?\/+/, "")).filter(Boolean))];
  if (!paths.length || paths.length > 20) throw new ValidationError("paths: 1 to 20 globs, like src/payments/** or migrations/*.sql");
  for (const p of paths) if (p.length > 200 || p.includes("..")) throw new ValidationError(`${p} isn't a path glob inside the repository`);
  const message = input.message.trim();
  if (!message) throw new ValidationError("message: what Claude should know or do");
  if (input.kind === "read_first" && !input.article_id) throw new ValidationError("read_first needs article_id: the page to read first");
  if (input.article_id) {
    const a = (await ctx.db.query<{ scope_id: string }>("SELECT scope_id FROM articles WHERE id = $1 AND status IN ('published', 'possibly_stale')", [input.article_id])).rows[0];
    if (!a) throw new NotFoundError("that article (published)");
  }
  if (input.component) {
    const c = (await ctx.db.query("SELECT 1 FROM components WHERE scope_id = $1 AND slug = $2", [scope.id, input.component])).rowCount;
    if (!c) throw new NotFoundError(`repository ${input.component} in ${scope.slug}`);
  }
  const args = [scope.id, input.component ?? null, input.kind, paths, input.article_id ?? null, message.slice(0, 500), input.enabled ?? true];
  let id = input.id;
  if (id) {
    const r = await ctx.db.query(
      "UPDATE project_rules SET component = $2, kind = $3, paths = $4, article_id = $5, message = $6, enabled = $7, updated_at = now() WHERE id = $8 AND scope_id = $1",
      [...args, id],
    );
    if (!r.rowCount) throw new NotFoundError("that rule");
  } else {
    id = (
      await ctx.db.query<{ id: string }>(
        "INSERT INTO project_rules (scope_id, component, kind, paths, article_id, message, enabled, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
        [...args, ctx.actor.id],
      )
    ).rows[0]!.id;
  }
  await audit(ctx.db, ctx.actor.id, "set_project_rule", id, { targetKind: "project", targetLabel: scope.slug, details: { kind: input.kind, paths } });
  emitChanged();
  return (await rows(ctx.db, scope.id, false)).find((r) => r.id === id)!;
}

export async function deleteRule(ctx: RequestContext, project: string, id: string) {
  const scope = await getReadableScope(ctx, project);
  await assertCanManage(ctx, scope);
  const r = await ctx.db.query("DELETE FROM project_rules WHERE id = $1 AND scope_id = $2", [id, scope.id]);
  if (!r.rowCount) throw new NotFoundError("that rule");
  await audit(ctx.db, ctx.actor.id, "delete_project_rule", id, { targetKind: "project", targetLabel: scope.slug });
  emitChanged();
  return { deleted: id };
}

/** What happened with a project's rules lately: stopped, read, asked (the person decided), told. Project admins. */
export async function ruleEvents(ctx: RequestContext, project: string, limit = 50) {
  const scope = await getReadableScope(ctx, project);
  await assertCanManage(ctx, scope);
  const { rows } = await ctx.db.query(
    `SELECT e.id, e.rule_id, r.kind, r.message, e.path, e.outcome, e.created_at, s.handle AS session, coalesce(u.display_name, u.email) AS person
       FROM rule_events e JOIN project_rules r ON r.id = e.rule_id
       LEFT JOIN agent_sessions s ON s.id = e.session_id LEFT JOIN users u ON u.id = e.user_id
      WHERE r.scope_id = $1 ORDER BY e.created_at DESC LIMIT $2`,
    [scope.id, Math.min(Math.max(limit, 1), 200)],
  );
  return { project: scope.slug, events: rows };
}

export interface RuleVerdict {
  /** stop: don't edit yet (read first); ask: the person decides; tell: context for Claude. */
  action: "stop" | "ask" | "tell";
  rule_id: string;
  kind: RuleKind;
  text: string;
  article: { id: string; title: string } | null;
}

/**
 * The rules an edit to this path meets, for a session in a project (the plugin's check-path). read_first stops the
 * session's first edit under the rule, then lets it through (it has been told what to read).
 */
export async function rulesForEdit(db: Queryable, s: { id: string; user_id: string; scope_id: string | null; component: string | null }, path: string): Promise<RuleVerdict[]> {
  if (!s.scope_id) return [];
  const matching = (await rulesFor(db, s.scope_id, s.component)).filter((r) => pathMatches(r.paths, path));
  const out: RuleVerdict[] = [];
  for (const r of matching) {
    let action: RuleVerdict["action"];
    let outcome: string;
    if (r.kind === "read_first") {
      const shown = (await db.query("SELECT 1 FROM rule_events WHERE rule_id = $1 AND session_id = $2 AND outcome = 'stopped' LIMIT 1", [r.id, s.id])).rowCount;
      action = shown ? "tell" : "stop";
      outcome = shown ? "read" : "stopped";
    } else if (r.kind === "never_edit") {
      action = "ask";
      outcome = "asked";
    } else {
      action = "tell";
      outcome = "told";
    }
    // One "read" and one "told" per session and rule are enough to know it worked.
    const repeat = outcome !== "stopped" && outcome !== "asked" && (await db.query("SELECT 1 FROM rule_events WHERE rule_id = $1 AND session_id = $2 AND outcome = $3 LIMIT 1", [r.id, s.id, outcome])).rowCount;
    if (!repeat) await db.query("INSERT INTO rule_events (rule_id, session_id, user_id, path, outcome) VALUES ($1, $2, $3, $4, $5)", [r.id, s.id, s.user_id, path, outcome]);
    const read = r.article ? ` Read "${r.article.title}" first (get_article ${r.article.id}).` : "";
    const text =
      r.kind === "read_first"
        ? `${r.message}${read}${action === "stop" ? " Then make the edit again." : ""}`
        : r.kind === "never_edit"
          ? `${r.message} (a project rule: ${path} isn't edited by agents)`
          : r.message;
    out.push({ action, rule_id: r.id, kind: r.kind, text, article: r.article });
  }
  return out;
}

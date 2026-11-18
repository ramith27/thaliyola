import type { Settings } from "../config.js";
import type { Queryable } from "../db/pool.js";
import { audit } from "./audit.js";
import { ForbiddenError, ValidationError, type RequestContext } from "./context.js";
import { isAdmin } from "./roles.js";
import { approveEveryoneWaiting } from "./users.js";

/**
 * System settings admins change in the app. Each one overrides its environment variable (stored in system_settings)
 * until it is reset. Only settings read when they're used are here: everything else (database, sign-in, storage,
 * rate limits, upload sizes, network access) needs a restart and stays in the environment, shown read-only.
 * Every server instance re-reads the overrides every 30 seconds, and the one that saved them applies them at once.
 */

type Kind = "boolean" | "enum" | "int" | "number" | "string" | "secret";

interface Def {
  group: "access" | "knowledge" | "notifications" | "skills";
  label: string;
  /** Plain words for the person changing it; environment variable names belong in `technical`. */
  help: string;
  /** A technical detail (environment variables, server configuration), shown behind "Technical details". */
  technical?: string;
  env: string;
  kind: Kind;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  get: (s: Settings) => unknown;
  set: (s: Settings, v: unknown) => void;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const SYSTEM_SETTINGS: Record<string, Def> = {
  require_approval: {
    group: "access",
    label: "New people need an admin's approval",
    help: "On: people who sign in for the first time wait until an Administrator or User manager approves them (Administrators set on the server never wait). Off: anyone your sign-in lets through gets in straight away, and everyone waiting now is let in.",
    technical: "Administrators set on the server are the emails in ADMIN_EMAILS.",
    env: "REQUIRE_APPROVAL",
    kind: "boolean",
    get: (s) => s.requireApproval,
    set: (s, v) => (s.requireApproval = v as boolean),
  },
  direct_publish: {
    group: "knowledge",
    label: "Project admins publish without review",
    help: "On: people who may publish in a project (Project admins, and any role given \"Publish without review\") publish their own articles, findings and edits at once, from Claude as well as the web. Off: everything written through Claude waits for review.",
    env: "DIRECT_PUBLISH",
    kind: "boolean",
    get: (s) => s.directPublish,
    set: (s, v) => (s.directPublish = v as boolean),
  },
  mcp_approvals: {
    group: "access",
    label: "Approvals from Claude",
    help: "On: people who may review approve or reject proposals and skill versions, approve skill imports, publish release notes and sync skill sources by asking Claude, with exactly the permissions they have in the web app. Skill versions still need a second person, and Claude is told to act only when the user names the item and after showing it. Off: Claude can't decide anything (and API tokens can't decide on skills), as before 1.1: a person signed in to the web app does.",
    technical: "ALLOW_MCP_APPROVALS. Covers the MCP tools review_proposal, review_skill_version, approve_skill_import, publish_release, unpublish_release and sync_skill_source, and skill review calls made with a personal API token or OAuth token. Takes effect at once on every server instance.",
    env: "ALLOW_MCP_APPROVALS",
    kind: "boolean",
    get: (s) => s.mcpApprovals ?? true,
    set: (s, v) => (s.mcpApprovals = v as boolean),
  },
  review_self_approval: {
    group: "access",
    label: "Reviewers may approve their own proposals",
    help: "On: someone with Review in a project may approve an article or finding they proposed themselves. Off: someone else must. Skill versions always need a second person (see Skills for Claude).",
    technical: "REVIEW_SELF_APPROVAL.",
    env: "REVIEW_SELF_APPROVAL",
    kind: "boolean",
    get: (s) => s.reviewSelfApproval ?? true,
    set: (s, v) => (s.reviewSelfApproval = v as boolean),
  },
  default_project_visibility: {
    group: "access",
    label: "New projects are",
    help: "Who can read a new project unless its creator chooses otherwise.",
    env: "DEFAULT_PROJECT_VISIBILITY",
    kind: "enum",
    options: [
      { value: "members", label: "Members only" },
      { value: "team", label: "Open to everyone signed in" },
    ],
    get: (s) => s.defaultProjectVisibility,
    set: (s, v) => (s.defaultProjectVisibility = v as Settings["defaultProjectVisibility"]),
  },
  session_ttl_hours: {
    group: "access",
    label: "Browser sessions last (hours)",
    help: "Built-in sign-in only: how long someone stays signed in. Applies to new sign-ins.",
    env: "SESSION_TTL_HOURS",
    kind: "int",
    min: 1,
    max: 24 * 90,
    get: (s) => s.sessionTtlHours,
    set: (s, v) => (s.sessionTtlHours = v as number),
  },
  duplicate_threshold: {
    group: "knowledge",
    label: "Duplicate finding: shared terms",
    help: "Share of a new finding's terms an existing one must contain to be returned as a likely duplicate (0–1). Lower catches more.",
    env: "DUPLICATE_THRESHOLD",
    kind: "number",
    min: 0,
    max: 1,
    get: (s) => s.duplicateThreshold,
    set: (s, v) => (s.duplicateThreshold = v as number),
  },
  duplicate_similarity: {
    group: "knowledge",
    label: "Duplicate finding: meaning",
    help: "Semantic similarity at which an existing finding counts as a near-duplicate (0–1).",
    env: "DUPLICATE_SIMILARITY",
    kind: "number",
    min: 0,
    max: 1,
    get: (s) => s.duplicateSimilarity,
    set: (s, v) => (s.duplicateSimilarity = v as number),
  },
  search_min_similarity: {
    group: "knowledge",
    label: "Search: minimum similarity",
    help: "How close a meaning-only match must be to be shown at all (0–1). Higher shows fewer, closer results.",
    env: "SEARCH_MIN_SIMILARITY",
    kind: "number",
    min: 0,
    max: 1,
    get: (s) => s.searchMinSimilarity,
    set: (s, v) => (s.searchMinSimilarity = v as number),
  },
  search_similarity_window: {
    group: "knowledge",
    label: "Search: similarity window",
    help: "Meaning-only matches must be within this much of the best one (0–1).",
    env: "SEARCH_SIMILARITY_WINDOW",
    kind: "number",
    min: 0,
    max: 1,
    get: (s) => s.searchSimilarityWindow,
    set: (s, v) => (s.searchSimilarityWindow = v as number),
  },
  search_log_days: {
    group: "knowledge",
    label: "Keep search history (days)",
    help: "Searches are kept this long for the hit rate and the knowledge gaps report.",
    env: "SEARCH_LOG_DAYS",
    kind: "int",
    min: 1,
    max: 3650,
    get: (s) => s.searchLogDays,
    set: (s, v) => (s.searchLogDays = v as number),
  },
  slack_webhook_url: {
    group: "notifications",
    label: "Slack channel webhook",
    help: "An incoming-webhook URL for the team channel that hears about proposals and decisions. Leave empty to turn it off.",
    env: "SLACK_WEBHOOK_URL",
    kind: "secret",
    get: (s) => s.slackWebhookUrl,
    set: (s, v) => (s.slackWebhookUrl = (v as string) || undefined),
  },
  mail_from: {
    group: "notifications",
    label: "Emails come from",
    help: 'Sender of notification and digest emails, e.g. "Thaliyola <thaliyola@example.com>".',
    env: "MAIL_FROM",
    kind: "string",
    get: (s) => s.mailFrom,
    set: (s, v) => (s.mailFrom = v as string),
  },
  digest_day: {
    group: "notifications",
    label: "Weekly digest day",
    help: "When the weekly digest email goes out.",
    env: "DIGEST_DAY",
    kind: "enum",
    options: DAYS.map((d, i) => ({ value: String(i), label: d })),
    get: (s) => String(s.digestDay),
    set: (s, v) => (s.digestDay = Number(v)),
  },
  skills_delivery: {
    group: "skills",
    label: "Skills for Claude",
    help: "On: everyone gets the skills assigned to them, in Claude (through the Thaliyola connector), as downloads and in Claude Code. Administrators only: only Administrators get theirs (for a pilot). Off: Thaliyola gives Claude no skills: the skill tools say they're switched off, downloads are refused and the Claude Code sync removes the skills it installed. Skills can still be written, imported and reviewed.",
    technical: "SKILLS_ENABLED (true, admins or false). Takes effect at once on every server instance.",
    env: "SKILLS_ENABLED",
    kind: "enum",
    options: [
      { value: "on", label: "On" },
      { value: "admins", label: "Administrators only" },
      { value: "off", label: "Off" },
    ],
    get: (s) => s.skillsDelivery ?? "on",
    set: (s, v) => (s.skillsDelivery = v as Settings["skillsDelivery"]),
  },
  skills_self_approval: {
    group: "skills",
    label: "Let people approve their own skill versions",
    help: "Off (recommended): a skill version needs a second person to approve it, Administrators included, because skills are instructions Claude follows. Turn on only for a team too small to have two reviewers. Project admins' own skills in their project are covered by \"Project admins publish their own skills\" instead.",
    technical: "SKILLS_SELF_APPROVAL.",
    env: "SKILLS_SELF_APPROVAL",
    kind: "boolean",
    get: (s) => s.skillsSelfApproval ?? false,
    set: (s, v) => (s.skillsSelfApproval = v as boolean),
  },
  skills_direct_publish: {
    group: "skills",
    label: "Project admins publish their own skills",
    help: "On: a Project admin's new skill or edit in their own project is published at once, unless it has high-risk content. Off: every skill version waits for a second person.",
    technical: "SKILLS_DIRECT_PUBLISH. Also needs DIRECT_PUBLISH (Project admins publish without review). Applies to skills owned by a project, written in the editor or pushed from Claude; never to organisation-wide skills or imports.",
    env: "SKILLS_DIRECT_PUBLISH",
    kind: "boolean",
    get: (s) => s.skillsDirectPublish ?? true,
    set: (s, v) => (s.skillsDirectPublish = v as boolean),
  },
  digest_hour: {
    group: "notifications",
    label: "Weekly digest hour (server time)",
    help: "0–23.",
    env: "DIGEST_HOUR",
    kind: "int",
    min: 0,
    max: 23,
    get: (s) => s.digestHour,
    set: (s, v) => (s.digestHour = v as number),
  },
};

/**
 * Presets: a whole policy at once. Each sets the same settings (who gets in, who publishes without review, what new
 * projects look like, how long sessions last, how eagerly duplicates are caught) to a fixed value; nothing else changes.
 * "Default" is Thaliyola's own defaults, the values used when the environment sets nothing.
 */
export const SYSTEM_PRESETS: Record<"looser" | "default" | "stricter", { label: string; description: string; values: Record<string, unknown> }> = {
  looser: {
    label: "Looser",
    description: "For a small, trusted team: people get in without approval, new projects are open to everyone, and sessions last a month.",
    values: { require_approval: false, direct_publish: true, default_project_visibility: "team", session_ttl_hours: 720, duplicate_threshold: 0.7, duplicate_similarity: 0.85 },
  },
  default: {
    label: "Default",
    description: "Thaliyola's defaults: new people wait for approval, new projects are members-only, Project admins publish without review.",
    values: { require_approval: true, direct_publish: true, default_project_visibility: "members", session_ttl_hours: 168, duplicate_threshold: 0.6, duplicate_similarity: 0.8 },
  },
  stricter: {
    label: "Stricter",
    description: "For sensitive knowledge: everything written through Claude waits for review, sessions last a working day, and near-duplicates are caught sooner.",
    values: { require_approval: true, direct_publish: false, default_project_visibility: "members", session_ttl_hours: 12, duplicate_threshold: 0.5, duplicate_similarity: 0.75 },
  },
};
export type PresetName = keyof typeof SYSTEM_PRESETS;
export const PRESET_NAMES = Object.keys(SYSTEM_PRESETS) as [PresetName, ...PresetName[]];

/** What applying each preset would change now: only the settings whose value differs. */
function presetChanges(settings: Settings) {
  return PRESET_NAMES.map((name) => {
    const p = SYSTEM_PRESETS[name];
    const changes = Object.entries(p.values)
      .map(([key, to]) => {
        const def = SYSTEM_SETTINGS[key]!;
        return { key, label: def.label, from: def.get(settings), to: def.kind === "enum" ? String(to) : to };
      })
      .filter((c) => c.from !== c.to);
    return { name, label: p.label, description: p.description, values: p.values, changes, current: changes.length === 0 };
  });
}

/** What each setting was from the environment, captured before any override is applied. */
const envValues = new WeakMap<Settings, Record<string, unknown>>();

function envOf(settings: Settings) {
  let env = envValues.get(settings);
  if (!env) {
    env = Object.fromEntries(Object.entries(SYSTEM_SETTINGS).map(([k, d]) => [k, d.get(settings)]));
    envValues.set(settings, env);
  }
  return env;
}

/** Applies the stored overrides to the shared settings object (and puts back environment values for ones reset). */
export async function loadSystemSettings(db: Queryable, settings: Settings) {
  const env = envOf(settings);
  const { rows } = await db.query<{ key: string; value: unknown }>("SELECT key, value FROM system_settings");
  const stored = new Map(rows.map((r) => [r.key, r.value]));
  for (const [key, def] of Object.entries(SYSTEM_SETTINGS)) def.set(settings, stored.has(key) ? stored.get(key) : env[key]);
  return stored.size;
}

/** Keeps every instance in step with what admins saved elsewhere. */
export function startSystemSettingsSync(db: Queryable, settings: Settings, log: (msg: string) => void, intervalMs = 30_000) {
  const timer = setInterval(() => void loadSystemSettings(db, settings).catch((err) => log(`could not reload: ${(err as Error).message}`)), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

function assertAdmin(ctx: RequestContext) {
  if (!isAdmin(ctx)) throw new ForbiddenError("only admins change system settings");
}

const hint = (v: unknown) => (typeof v === "string" && v ? `…${v.slice(-4)}` : null);

/** Every editable setting with its value and where it comes from, plus read-only facts about the installation. */
export async function getSystemSettings(ctx: RequestContext) {
  assertAdmin(ctx);
  const env = envOf(ctx.settings);
  const { rows } = await ctx.db.query<{ key: string; updated_at: string; by: string | null }>(
    "SELECT s.key, s.updated_at, coalesce(u.display_name, u.email) AS by FROM system_settings s LEFT JOIN users u ON u.id = s.updated_by",
  );
  const changed = new Map(rows.map((r) => [r.key, r]));
  const settings = Object.entries(SYSTEM_SETTINGS).map(([key, d]) => {
    const value = d.get(ctx.settings);
    const secret = d.kind === "secret";
    return {
      key,
      group: d.group,
      label: d.label,
      help: d.help,
      technical: d.technical ?? null,
      env: d.env,
      kind: d.kind,
      options: d.options,
      min: d.min,
      max: d.max,
      // Secrets never leave the server: only whether one is set and its last characters.
      value: secret ? null : value,
      is_set: secret ? !!value : undefined,
      hint: secret ? hint(value) : undefined,
      env_value: secret ? (env[key] ? "set" : "not set") : env[key],
      source: changed.has(key) ? "here" : "environment",
      updated_at: changed.get(key)?.updated_at ?? null,
      updated_by: changed.get(key)?.by ?? null,
    };
  });
  const counts = (
    await ctx.db.query(
      `SELECT (SELECT count(*) FROM users WHERE kind = 'human' AND subject NOT LIKE 'pending:%' AND approved_at IS NOT NULL AND disabled_at IS NULL)::int AS people,
              (SELECT count(*) FROM users WHERE kind = 'service')::int AS services,
              (SELECT count(*) FROM users WHERE approved_at IS NULL AND subject NOT LIKE 'pending:%' AND disabled_at IS NULL)::int AS waiting,
              (SELECT count(*) FROM scopes WHERE kind = 'project' AND status = 'active')::int AS projects,
              (SELECT count(*) FROM articles WHERE status <> 'deleted')::int AS articles,
              (SELECT count(*) FROM findings WHERE status <> 'deleted')::int AS findings,
              (SELECT count(*) FROM revisions WHERE state = 'pending')::int AS pending_reviews,
              (SELECT max(name) FROM schema_migrations) AS migration`,
    )
  ).rows[0];
  const s = ctx.settings;
  return {
    settings,
    environment: {
      auth_mode: s.authMode,
      public_url: s.publicUrl ?? null,
      admin_emails: s.adminEmails.length,
      mail: s.mailTransport,
      asset_store: s.s3 ? "s3" : "local disk",
      upload_limit_mb: Math.round(s.assetMaxBytes / 1024 / 1024),
      rate_limit_per_minute: s.rateLimitPerMinute,
      sources: s.sources?.enabled ? (s.sources.allowPrivate ? "on (private networks allowed)" : "on") : "off",
      vulnerability_scan: s.security?.enabled ? "on" : "off",
      advisory_feed: s.security?.feed ? "on" : "off",
      connections: !s.connections?.enabled
        ? "off"
        : !s.connections.keys.key
          ? "on (CONNECTIONS_KEY not set: no secrets can be stored)"
          : `on${s.connections.keys.oldKey ? " (rotating: CONNECTIONS_KEY_OLD set)" : ""}${s.connections.allowPrivate ? " (APIs may reach private networks)" : ""}`,
      skills_git_hosts: s.skills?.gitHosts.length ? s.skills.gitHosts.join(", ") : "none",
      skills_import_limit_mb: Math.round((s.skills?.importMaxBytes ?? 50 * 1024 * 1024) / 1024 / 1024),
    },
    counts,
    presets: presetChanges(ctx.settings),
  };
}

function validate(def: Def, key: string, value: unknown): unknown {
  switch (def.kind) {
    case "boolean":
      if (typeof value !== "boolean") throw new ValidationError(`${key} is true or false`);
      return value;
    case "enum": {
      const v = String(value);
      if (!def.options!.some((o) => o.value === v)) throw new ValidationError(`${key} is one of ${def.options!.map((o) => o.value).join(", ")}`);
      return v;
    }
    case "int":
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || (def.kind === "int" && !Number.isInteger(n))) throw new ValidationError(`${key} must be ${def.kind === "int" ? "a whole number" : "a number"}`);
      if ((def.min !== undefined && n < def.min) || (def.max !== undefined && n > def.max)) throw new ValidationError(`${key} must be between ${def.min} and ${def.max}`);
      return n;
    }
    case "secret":
    case "string": {
      const v = String(value ?? "").trim();
      if (v.length > 1000) throw new ValidationError(`${key} is too long`);
      if (key === "slack_webhook_url" && v && !/^https:\/\/hooks\.slack\.com\//.test(v)) throw new ValidationError("a Slack incoming webhook starts with https://hooks.slack.com/");
      if (key === "mail_from" && !/@/.test(v)) throw new ValidationError("mail_from needs an email address");
      return v;
    }
  }
}

/** Saves settings (null resets one to its environment value) and applies them right away. Admins only. */
export async function updateSystemSettings(ctx: RequestContext, patch: Record<string, unknown>) {
  assertAdmin(ctx);
  const entries = Object.entries(patch);
  if (!entries.length) throw new ValidationError("nothing to change");
  const checked = entries.map(([key, value]) => {
    const def = SYSTEM_SETTINGS[key];
    if (!def) throw new ValidationError(`unknown setting '${key}'`);
    return [key, value === null ? null : validate(def, key, value)] as const;
  });
  const before = Object.fromEntries(checked.map(([key]) => [key, SYSTEM_SETTINGS[key]!.get(ctx.settings)]));
  for (const [key, value] of checked) {
    if (value === null) await ctx.db.query("DELETE FROM system_settings WHERE key = $1", [key]);
    else
      await ctx.db.query(
        `INSERT INTO system_settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), ctx.actor.id],
      );
  }
  await loadSystemSettings(ctx.db, ctx.settings);
  // Approval switched off: nobody should keep waiting for it (people already declined stay declined).
  const letIn = checked.some(([k]) => k === "require_approval") && !ctx.settings.requireApproval ? await approveEveryoneWaiting(ctx) : 0;
  // Secret settings (the Slack webhook) are recorded as changed or reset, never with their values.
  await audit(ctx.db, ctx.actor.id, "update_system_settings", null, {
    targetKind: "settings",
    targetLabel: "System settings",
    details: {
      changes: checked.map(([key, value]) => {
        const def = SYSTEM_SETTINGS[key]!;
        if (def.kind === "secret") return { setting: key, label: def.label, change: value === null ? "reset" : value ? "changed" : "cleared" };
        return { setting: key, label: def.label, from: before[key] ?? null, to: def.get(ctx.settings) ?? null, ...(value === null ? { reset: true } : {}) };
      }),
      ...(letIn ? { let_in: letIn } : {}),
    },
  });
  return { ...(await getSystemSettings(ctx)), let_in: letIn };
}

/** Applies a preset: sets each of its settings (those already at its value are left alone). Admins only. */
export async function applySystemPreset(ctx: RequestContext, name: string) {
  assertAdmin(ctx);
  if (!Object.hasOwn(SYSTEM_PRESETS, name)) throw new ValidationError(`unknown preset '${name}' (use ${PRESET_NAMES.join(", ")})`);
  const preset = SYSTEM_PRESETS[name as PresetName];
  const changes = presetChanges(ctx.settings).find((p) => p.name === name)!.changes;
  if (!changes.length) return { ...(await getSystemSettings(ctx)), preset: name, changed: [] as string[], let_in: 0 };
  const result = await updateSystemSettings(ctx, Object.fromEntries(changes.map((c) => [c.key, preset.values[c.key]])));
  // The settings change itself is recorded by updateSystemSettings (from / to); this row names the preset behind it.
  await audit(ctx.db, ctx.actor.id, "apply_system_preset", null, {
    targetKind: "settings",
    targetLabel: "System settings",
    details: { preset: name, label: preset.label, changed: changes.map((c) => c.key) },
  });
  return { ...result, preset: name, changed: changes.map((c) => c.key) };
}

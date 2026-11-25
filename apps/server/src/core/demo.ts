import { randomBytes } from "node:crypto";
import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import { createLocalUser } from "../auth/local.js";
import { migrate } from "../db/migrate.js";
import { seedDemo } from "../scripts/demo-data.js";
import { adminSetMember } from "./admin.js";
import { ensureBaseScopes } from "./bootstrap.js";
import type { RequestContext } from "./context.js";
import { checkDesignDrift } from "./design-drift.js";
import { recordDesignDecision, updateDesignSystem } from "./design.js";
import { rebuildExpertise } from "./expertise.js";
import { addIncidentNote, declareIncident, updateIncident } from "./incidents.js";
import { recordJob } from "./jobs.js";
import { startReleaseCatalog } from "./releases.js";
import { claimWork } from "./coordination.js";
import { answerQuestion, askSession, handoffSession, registerSession, waitForQuestions } from "./sessions.js";
import { actorById } from "./users.js";

/**
 * The public demo (DEMO_MODE=true): everything is wiped and re-seeded with a showcase every DEMO_RESET_HOURS (12),
 * visitors sign in with one click as a demo person (no passwords, no dev tokens), and the sign-in page and a banner
 * say when the next reset is. Run it with outbound features off (mail, Slack, connections, sources, scans).
 */

export const DEMO_PEOPLE = [
  { key: "dana", email: "dana@demo.thaliyola.app", name: "Dana Kim", role: "Administrator", admin: true },
  { key: "alex", email: "alex@demo.thaliyola.app", name: "Alex Rivera", role: "Contributor in Order service", admin: false },
  { key: "sam", email: "sam@demo.thaliyola.app", name: "Sam Okafor", role: "Contributor in Merchant portal", admin: false },
  { key: "rita", email: "rita@demo.thaliyola.app", name: "Rita Shah", role: "Viewer", admin: false },
] as const;

const LOCK = 7_402_250;

/** Hosts the demo may reach: the search model's download. Everything else visitors could point it at is refused. */
const DEMO_HOSTS = /(^|\.)(huggingface\.co|hf\.co)$/i;

/** Replaces the global fetch so the public demo can't be used to send requests anywhere (webhooks, repo URLs, feeds). */
export function lockOutbound() {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (!DEMO_HOSTS.test(url.hostname)) throw new Error(`outbound requests are off in the demo (${url.hostname})`);
    return real(input, init);
  }) as typeof fetch;
}

/** When the demo was last reset (null: never, or the table isn't there yet). */
export async function lastReset(db: Db): Promise<Date | null> {
  try {
    const r = (await db.query<{ last_run: Date }>("SELECT last_run FROM job_runs WHERE name = 'demo_reset'")).rows[0];
    return r ? new Date(r.last_run) : null;
  } catch {
    return null;
  }
}

export function nextReset(settings: Settings, last: Date | null) {
  const hours = settings.demo?.resetHours ?? 12;
  return new Date((last ?? new Date()).getTime() + hours * 3_600_000);
}

/** Wipes everything and seeds the showcase. One replica at a time (advisory lock on a dedicated connection). */
export async function resetDemo(db: Db, settings: Settings, log: (m: string) => void = console.log) {
  const client = await db.connect();
  try {
    if (!(await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [LOCK])).rows[0]?.locked) return false;
    try {
      const t0 = Date.now();
      await client.query("DROP SCHEMA public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await migrate(db, () => undefined);
      await ensureBaseScopes(db);
      await seedShowcase(db, settings);
      await startReleaseCatalog(db, () => undefined);
      await recordJob(db, "demo_reset", { ok: true, durationMs: Date.now() - t0 });
      log(`[demo] reset and re-seeded in ${Date.now() - t0} ms`);
      return true;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => undefined);
    }
  } finally {
    client.release();
  }
}

/** Resets when due (on start, then checked every 10 minutes). */
export function startDemoJobs(db: Db, settings: Settings, log: (m: string) => void = console.log) {
  const tick = async () => {
    const last = await lastReset(db);
    if (!last || Date.now() >= nextReset(settings, last).getTime()) await resetDemo(db, settings, log).catch((err: Error) => log(`[demo] reset failed: ${err.message}`));
  };
  const timer = setInterval(() => void tick(), 10 * 60_000);
  timer.unref();
  return { first: tick(), stop: () => clearInterval(timer) };
}

/** The one-click sign-in: the demo person's account id (null for anyone else). */
export async function demoAccount(db: Db, key: string) {
  const p = DEMO_PEOPLE.find((x) => x.key === key);
  if (!p) return null;
  return (await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1 AND disabled_at IS NULL", [p.email])).rows[0]?.id ?? null;
}

// ---- The showcase ------------------------------------------------------------------------------------------------

async function seedShowcase(db: Db, settings: Settings) {
  await seedDemo(db);
  const people: Record<string, RequestContext> = {};
  for (const p of DEMO_PEOPLE) {
    const { user } = await createLocalUser(db, { email: p.email, name: p.name, isAdmin: p.admin, password: randomBytes(24).toString("base64url") });
    await db.query("UPDATE users SET approved_at = now(), must_change_password = false, display_name = $2 WHERE id = $1", [user.id, p.name]);
    people[p.key] = { db, settings, actor: (await actorById(db, user.id))! };
  }
  const { dana, alex, sam, rita } = people as Record<string, RequestContext>;
  await adminSetMember(dana!, "order-service", DEMO_PEOPLE[1].email, "writer");
  await adminSetMember(dana!, "merchant-portal", DEMO_PEOPLE[2].email, "writer");
  await adminSetMember(dana!, "order-service", DEMO_PEOPLE[2].email, "writer");
  await adminSetMember(dana!, "order-service", DEMO_PEOPLE[3].email, "reader");
  void rita;

  // Design systems: the Library's, and Order service based on it with its own violet.
  await updateDesignSystem(dana!, "library", {
    source: "ui-kit/src/theme.css",
    principles: "- One primary action per screen.\n- Status colours always come with an icon and a label.\n- Body text never below 14px.",
    tokens: {
      colors: [
        { name: "primary", value: "#2563eb", dark: "#4f8cff", role: "primary", usage: "Links, focus, main action" },
        { name: "background", value: "#ffffff", dark: "#0f172a", role: "background", usage: "Page" },
        { name: "surface", value: "#f8fafc", dark: "#1e293b", role: "surface", usage: "Cards, panels" },
        { name: "text", value: "#0f172a", dark: "#e2e8f0", role: "text", usage: "Body text" },
        { name: "muted", value: "#475569", dark: "#94a3b8", role: "muted", usage: "Secondary text" },
        { name: "border", value: "#e2e8f0", dark: "#334155", role: "border" },
        { name: "success", value: "#15803d", dark: "#4ade80", role: "success" },
        { name: "warning", value: "#b45309", dark: "#fbbf24", role: "warning" },
        { name: "danger", value: "#b91c1c", dark: "#f87171", role: "danger" },
      ],
      typography: {
        fonts: [{ role: "body", family: "Inter, system-ui, sans-serif", weights: [400, 600] }],
        scale: [
          { name: "h1", size: "1.75rem", line_height: "1.2", weight: 600, font: "body" },
          { name: "body", size: "0.95rem", line_height: "1.55", weight: 400, font: "body" },
        ],
      },
      spacing: [{ name: "2", value: "8px" }, { name: "4", value: "16px" }, { name: "6", value: "24px" }],
      radii: [{ name: "md", value: "12px", usage: "Cards" }],
      components: [{ name: "Button", description: "Primary and secondary actions", path: "ui-kit/src/Button.tsx", status: "stable" }],
    },
  });
  await updateDesignSystem(alex!, "order-service", {
    based_on: "library",
    source: "web/src/styles/tokens.css",
    tokens: { colors: [{ name: "primary", value: "#6d28d9", dark: "#a78bfa", role: "primary", usage: "Order actions" }] },
  }).catch(() => undefined);
  await recordDesignDecision(alex!, {
    project: "order-service",
    title: "Order screens use a violet primary",
    context: "Merchants confused order screens with the payments product, which shares the blue.",
    choice: "Violet primary on order screens; everything else from the Library.",
    consequences: "Status colours stay shared, so order states read the same everywhere.",
  }).catch(() => undefined);
  await checkDesignDrift(alex!, "order-service", {
    tokens: { colors: [{ name: "--color-primary", value: "#6d28d9", dark: "#a78bfa" }] },
    hardcoded: [
      { value: "#7c3aed", file: "web/src/orders/Timeline.tsx", line: 88 },
      { value: "#ec4899", file: "web/src/promo/Banner.tsx", line: 12 },
    ],
    source: "github.com/example/orders-web@4f2a9c1",
  }).catch(() => undefined);

  // Sessions asking each other, a claim and a handoff.
  await registerSession(alex!, { client: "claude-code", client_session_id: "demo-alex", project: "order-service", component: "frontend", repo: "https://github.com/example/orders-web", description: "Order timeline redesign", listening: true });
  await registerSession(dana!, { client: "claude-code", client_session_id: "demo-dana", project: "order-service", component: "backend", repo: "https://github.com/example/orders-api", description: "Partial refunds in the orders API" });
  await registerSession(sam!, { client: "claude-code", client_session_id: "demo-sam", project: "merchant-portal", description: "Payout settings page" });
  const handles = (await db.query<{ handle: string; user_id: string }>("SELECT handle, user_id FROM agent_sessions")).rows;
  const h = (ctx: RequestContext) => handles.find((x) => x.user_id === ctx.actor.id)!.handle;
  const q = (await askSession(dana!, { session: h(dana!), to: h(alex!), question: "Does the order timeline read refund events from /orders/:id/events, or call /refunds separately?", context: "I'm adding partial refunds and want to emit them as order events.", wait_seconds: 0 })) as { id: string };
  await waitForQuestions(alex!, { session: h(alex!), wait_seconds: 0 });
  await answerQuestion(alex!, { session: h(alex!), id: q.id, answer: "Only /orders/:id/events (web/src/orders/useOrderEvents.ts). Emit refund.partial with amount and currency there and the timeline shows it; a new type needs a label in timelineLabels.ts." });
  await askSession(sam!, { session: h(sam!), to: "order-service", question: "Is the payout currency always the order currency, or can a merchant be paid in another one?", wait_seconds: 0 });
  await claimWork(alex!, { session: h(alex!), paths: ["web/src/orders/timeline"], note: "timeline redesign" }).catch(() => undefined);
  await handoffSession(sam!, { session: h(sam!), to: DEMO_PEOPLE[0].email, summary: "Payout settings form is done except IBAN validation", next_steps: "1. Add IBAN checksum validation\n2. Show the error under the field", files: ["src/payouts/SettingsForm.tsx"] }).catch(() => undefined);

  // Security: a few real advisories on the API's dependencies (scans are off in the demo, so they're seeded).
  const orders = (await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = 'order-service'")).rows[0]!.id;
  await db.query(
    `INSERT INTO vulnerabilities (scope_id, component, source, advisory_id, aliases, title, ecosystem, package, version, fixed_versions, severity, cvss_score, kev, location) VALUES
       ($1, 'backend', 'osv', 'GHSA-xvch-5gv4-984h', '{CVE-2021-44906}', 'Prototype Pollution in minimist', 'npm', 'minimist', '1.2.0', '{1.2.6}', 'critical', 9.8, false, NULL),
       ($1, 'backend', 'osv', 'GHSA-35jh-r3h4-6jhm', '{CVE-2021-23337}', 'Command Injection in lodash', 'npm', 'lodash', '4.17.15', '{4.17.21}', 'high', 7.2, false, NULL),
       ($1, 'backend', 'osv', 'GHSA-8cf7-32gw-wr33', '{CVE-2022-23539}', 'jsonwebtoken unrestricted key type could lead to legacy keys usage', 'npm', 'jsonwebtoken', '8.5.1', '{9.0.0}', 'high', 8.1, false, NULL),
       ($1, 'backend', 'reported', NULL, '{}', 'Refund lookup builds SQL from the order id', NULL, NULL, NULL, '{}', 'high', NULL, false, 'src/refunds/handler.ts#L22-L30')`,
    [orders],
  );

  // An incident in progress, with a timeline.
  const inc = await declareIncident(alex!, { project: "order-service", title: "Checkout returns 502 for card payments", severity: "sev2", summary: "Since 10:05 UTC about 40% of card payments fail at checkout. Wallet payments are fine." });
  await addIncidentNote(alex!, { id: inc.id, text: "Rolled back deploy 4812; no change" });
  await addIncidentNote(dana!, { id: inc.id, text: "Payment client timeout went from 30s to 3s in PR #88; the provider's p95 is 4.2s" });
  await updateIncident(dana!, { id: inc.id, status: "mitigated" });

  // A pull request briefing, as it was commented.
  await db.query(
    `INSERT INTO pr_briefings (scope_id, component, repo_key, provider, number, title, url, author, files, briefing, items, status)
     VALUES ($1, 'backend', 'github.com/example/orders-api', 'github', 214, 'Partial refunds for card payments', 'https://github.com/example/orders-api/pull/214', 'dana', '{src/refunds/handler.ts,src/refunds/retry.ts,package-lock.json}',
       '{"docs":[],"contracts":[],"known_issues":[],"vulnerabilities":[{"id":"00000000-0000-0000-0000-000000000000","title":"Refund lookup builds SQL from the order id","severity":"high","location":"src/refunds/handler.ts#L22-L30"}],"lockfiles":["package-lock.json"],"design":null,"working_here":[]}', 2, 'posted')`,
    [orders],
  );
  await db.query("UPDATE scopes SET pr_briefings = 'relevant', pr_docs_check = 'block', pr_questions = 'on' WHERE id = $1", [orders]);
  // The docs check on that pull request, and a question asked in it that a session answered.
  const doc = (await db.query<{ id: string; title: string }>("SELECT id, title FROM articles WHERE scope_id = $1 AND type <> 'decision' ORDER BY created_at LIMIT 1", [orders])).rows[0];
  if (doc) {
    const check = {
      facts: [
        { claim_id: "00000000-0000-0000-0000-000000000001", article_id: doc.id, article: doc.title, path: "src/refunds/handler.ts", start: 22, end: 41, outcome: "changed" },
        { claim_id: "00000000-0000-0000-0000-000000000002", article_id: doc.id, article: doc.title, path: "src/refunds/handler.ts", start: 60, end: 72, outcome: "moved", to: { path: "src/refunds/handler.ts", start: 68, end: 80 } },
      ],
      changed: 1,
      removed: 0,
      moved: 1,
      unknown: 0,
    };
    await db.query("UPDATE pr_briefings SET docs_check = $2, docs_state = 'failure', head_sha = '4f2a9c1' WHERE scope_id = $1", [orders, JSON.stringify(check)]);
  }
  await db.query(
    `INSERT INTO pr_questions (scope_id, component, repo_key, provider, number, comment_id, author, question, path, line, confidence, sources, status)
     VALUES ($1, 'backend', 'github.com/example/orders-api', 'github', 214, '1001', 'sam', 'Does the timeline show partial refunds once this merges?', 'src/refunds/handler.ts', 30, 'partial', 2, 'answered')`,
    [orders],
  );
  await rebuildExpertise(db);
}

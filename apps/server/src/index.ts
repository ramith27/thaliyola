import { authenticatorFor } from "./auth/index.js";
import { ensureBaseScopes } from "./core/bootstrap.js";
import { HashingEmbedder, LocalEmbedder, startIndexer } from "./core/embeddings.js";
import { startJobs } from "./core/freshness.js";
import { startSourceJobs } from "./core/sources.js";
import { startConnectionJobs } from "./core/connections/sync.js";
import { startSkillJobs } from "./core/skills/sources.js";
import { startSecurityJobs } from "./core/security.js";
import { startSessionJobs } from "./core/sessions.js";
import { loadConfig, settingsFrom, trustProxyFrom } from "./config.js";
import { changes, startChangeRelay } from "./core/events.js";
import { flushDeliveries } from "./core/notify.js";
import { startTokenJobs } from "./core/token-hygiene.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createApp } from "./http/app.js";
import { drainSteps, Lifecycle, shutdown } from "./http/lifecycle.js";
import { loadSystemSettings, startSystemSettingsSync } from "./core/system.js";
import { startReleaseCatalog } from "./core/releases.js";
import { versionLabel } from "./core/version.js";
import { lockOutbound, startDemoJobs } from "./core/demo.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
// Starting until the server listens; stopping from SIGTERM on. /readyz is 503 in both.
const lifecycle = new Lifecycle();

if (config.AUTH_MODE === "dev") {
  console.warn("WARNING: AUTH_MODE=dev accepts static bearer tokens. Use it only for local development.");
}

await migrate(db, (msg) => console.log(`[migrate] ${msg}`));
await ensureBaseScopes(db);
// Release notes: the starting catalog once, and a draft for this version from CHANGELOG.md if it has none yet.
await startReleaseCatalog(db, (msg) => console.log(`[releases] ${msg}`));
console.log(`[version] Thaliyola ${versionLabel()}`);

// One settings object for the app and every job, so what admins change on the System settings page reaches all of them.
const settings = settingsFrom(config);
const overridden = await loadSystemSettings(db, settings);
if (overridden) console.log(`[settings] ${overridden} setting${overridden === 1 ? "" : "s"} changed by admins (System settings) override the environment`);
const settingsSync = startSystemSettingsSync(db, settings, (msg) => console.error(`[settings] ${msg}`));
// The public demo: wiped and re-seeded now if due, then every DEMO_RESET_HOURS.
if (settings.demo) {
  if (config.AUTH_MODE !== "local") throw new Error("DEMO_MODE needs AUTH_MODE=local (the demo signs people in with one-click demo accounts)");
  console.warn(`[demo] DEMO_MODE is on: all data is wiped every ${settings.demo.resetHours} hours`);
  lockOutbound();
  await startDemoJobs(db, settings).first;
}

const embedder =
  config.EMBEDDINGS === "local" ? new LocalEmbedder(undefined, config.EMBEDDING_CACHE_DIR) : config.EMBEDDINGS === "hash" ? new HashingEmbedder() : undefined;
if (embedder) {
  // Load (and on first run download) the model in the background so the first search doesn't wait for it.
  const t0 = Date.now();
  embedder
    .embedQuery("warm up")
    .then(() => console.log(`[embeddings] ${embedder.model} ready in ${Date.now() - t0} ms`))
    .catch((err) => console.error(`[embeddings] model unavailable, using keyword search only: ${(err as Error).message}`));
}
const indexer = embedder ? startIndexer(db, embedder, (msg) => console.log(`[embeddings] ${msg}`)) : undefined;

const jobs = startJobs(
  db,
  {
    findingDays: config.STALE_AFTER_DAYS,
    articleDays: config.STALE_AFTER_DAYS_ARTICLES ?? config.STALE_AFTER_DAYS,
    intervalHours: config.MAINTENANCE_INTERVAL_HOURS,
    settings,
  },
  (msg) => console.log(`[maintenance] ${msg}`),
);

const sources = startSourceJobs(db, settings, (msg) => console.log(`[sources] ${msg}`));
const security = startSecurityJobs(db, settings, (msg) => console.log(`[security] ${msg}`));
const sessionJobs = startSessionJobs(db, settings, (msg) => console.log(`[sessions] ${msg}`));
// Several replicas: changes made on one reach the pages open on the others (Postgres LISTEN/NOTIFY).
const relay = startChangeRelay(db, changes, (msg) => console.error(`[events] ${msg}`));
const tokens = startTokenJobs(db, settings, (msg) => console.log(`[tokens] ${msg}`));
const connections = startConnectionJobs(db, settings, (msg) => console.log(`[connections] ${msg}`));
// Skill imports on a schedule, usage purge and token re-sealing: whether or not CONNECTIONS is on.
const skillJobs = startSkillJobs(db, settings, (msg) => console.log(`[skills] ${msg}`));
if (settings.connections?.enabled && !settings.connections.keys.key) console.warn("[connections] CONNECTIONS_KEY isn't set: connections that need a password, token or key can't be added");

const server = createApp({
  db,
  authenticate: authenticatorFor(config, db),
  settings,
  webDist: config.WEB_DIST,
  embedder,
  onWrite: indexer?.poke,
  lifecycle,
  trustProxy: trustProxyFrom(config.TRUST_PROXY),
}).listen(config.PORT, config.HOST, () => {
  lifecycle.phase = "ready";
  console.log(`thaliyola-server listening on ${config.HOST}:${config.PORT} (auth: ${config.AUTH_MODE}, embeddings: ${config.EMBEDDINGS})`);
});

/**
 * SIGTERM (a deploy, a scale-down, a node drain) or SIGINT: /readyz turns 503, background jobs start no new runs,
 * open event streams end (browsers reconnect to another replica), the server takes no new connections and lets
 * in-flight requests finish, then pending notifications go out, running jobs finish (keeping back up to 5 s for what
 * follows), their notifications go out, the change relay stops and the pool closes, all within
 * SHUTDOWN_TIMEOUT_SECONDS. A job run still going then is cut off and redone by a later run. A second signal exits
 * at once.
 */
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) {
      console.warn(`[shutdown] ${signal} again: exiting now`);
      process.exit(1);
    }
    stopping = true;
    console.log(`[shutdown] ${signal}: draining for up to ${config.SHUTDOWN_TIMEOUT_SECONDS} s`);
    const jobsDone = Promise.allSettled([indexer?.stop(), jobs.stop(), sources.stop(), security.stop(), sessionJobs.stop(), tokens.stop(), connections.stop(), skillJobs.stop(), settingsSync.stop()]);
    // Whatever happens below, don't outlive the timeout by more than a few seconds.
    setTimeout(() => {
      console.error("[shutdown] still running after the timeout: exiting");
      process.exit(1);
    }, config.SHUTDOWN_TIMEOUT_SECONDS * 1000 + 5000).unref();
    void shutdown(lifecycle, {
      server,
      timeoutMs: config.SHUTDOWN_TIMEOUT_SECONDS * 1000,
      before: [{ name: "event streams", run: () => changes.closeStreams() }],
      after: drainSteps({
        jobs: () => jobsDone,
        flush: () => flushDeliveries(),
        relay: () => relay.stop(),
        closePool: () => db.end(),
        reserveMs: Math.min(5000, (config.SHUTDOWN_TIMEOUT_SECONDS * 1000) / 4),
      }),
    }).then((clean) => {
      console.log(`[shutdown] ${clean ? "done" : "done, with the timeouts above"}`);
      process.exit(clean ? 0 : 1);
    });
  });
}

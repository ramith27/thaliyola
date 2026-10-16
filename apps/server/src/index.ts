import { authenticatorFor } from "./auth/index.js";
import { ensureBaseScopes } from "./core/bootstrap.js";
import { HashingEmbedder, LocalEmbedder, startIndexer } from "./core/embeddings.js";
import { loadConfig, settingsFrom } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { createApp } from "./http/app.js";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);

if (config.AUTH_MODE === "dev") {
  console.warn("WARNING: AUTH_MODE=dev accepts static bearer tokens. Use it only for local development.");
}

await migrate(db, (msg) => console.log(`[migrate] ${msg}`));
await ensureBaseScopes(db);

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

const server = createApp({
  db,
  authenticate: authenticatorFor(config, db),
  settings: settingsFrom(config),
  webDist: config.WEB_DIST,
  embedder,
  onWrite: indexer?.poke,
}).listen(config.PORT, config.HOST, () => {
  console.log(`cairn-server listening on ${config.HOST}:${config.PORT} (auth: ${config.AUTH_MODE}, embeddings: ${config.EMBEDDINGS})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    indexer?.stop();
    server.close(() => void db.end().then(() => process.exit(0)));
  });
}

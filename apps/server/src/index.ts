import { authenticatorFor } from "./auth/index.js";
import { ensureBaseScopes } from "./core/bootstrap.js";
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

const server = createApp(db, authenticatorFor(config), settingsFrom(config), config.WEB_DIST).listen(config.PORT, config.HOST, () => {
  console.log(`cairn-server listening on ${config.HOST}:${config.PORT} (auth: ${config.AUTH_MODE})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => void db.end().then(() => process.exit(0)));
  });
}

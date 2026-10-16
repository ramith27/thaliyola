import { migrate } from "../db/migrate.js";
import { createPool } from "../db/pool.js";
import { seedDemo } from "./demo-data.js";

const db = createPool(process.env.DATABASE_URL ?? "postgres://cairn:cairn@localhost:5432/cairn");
await migrate(db);
const existing = await db.query("SELECT 1 FROM scopes WHERE slug = 'order-service'");
if (existing.rowCount) {
  console.log("demo data already present; skipping");
} else {
  await seedDemo(db);
  console.log("seeded demo data");
}
await db.end();

/**
 * Account administration from the shell (bootstrap the first admin, recover access, bot tokens).
 *
 *   node dist/scripts/admin.js create-user --email you@example.com [--name "You"] [--admin]
 *   node dist/scripts/admin.js reset-password --email you@example.com
 *   node dist/scripts/admin.js list-users
 *   node dist/scripts/admin.js create-token --email you@example.com --name "Claude Code" [--days 90]
 *   node dist/scripts/admin.js create-token --service rca-bot --name "nightly RCA job"
 *   node dist/scripts/admin.js create-token --service docs-bot --name "CI docs" --owner-of order-service
 *   node dist/scripts/admin.js export --out thaliyola-export.zip [--scope team]
 *
 * Reads DATABASE_URL like the server.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createApiToken, createLocalUser, listLocalUsers, resetPassword } from "../auth/local.js";
import { loadConfig, settingsFrom } from "../config.js";
import { exportMarkdown } from "../core/exporter.js";
import { migrate } from "../db/migrate.js";
import { createPool, type Db } from "../db/pool.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    email: { type: "string" },
    name: { type: "string" },
    admin: { type: "boolean", default: false },
    service: { type: "string" },
    days: { type: "string" },
    out: { type: "string" },
    scope: { type: "string" },
    "owner-of": { type: "string", multiple: true },
  },
});

async function userId(db: Db, email: string) {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE subject = $1", [`local:${email.trim().toLowerCase()}`]);
  if (!rows[0]) throw new Error(`no local user ${email}`);
  return rows[0].id;
}

async function serviceUserId(db: Db, name: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) throw new Error("service names are lowercase letters, digits and hyphens");
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO users (subject, display_name, kind) VALUES ($1, $2, 'service')
     ON CONFLICT (subject) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
    [`service:${name}`, name],
  );
  return rows[0]!.id;
}

const db = createPool(process.env.DATABASE_URL ?? "postgres://thaliyola:thaliyola@localhost:5432/thaliyola");
try {
  await migrate(db);
  const command = positionals[0];
  if (command === "create-user") {
    if (!values.email) throw new Error("--email is required");
    const { user, temporaryPassword } = await createLocalUser(db, { email: values.email, name: values.name, isAdmin: values.admin });
    console.log(`Created ${user.email}${user.is_admin ? " (admin)" : ""}.`);
    console.log(`Temporary password: ${temporaryPassword}`);
    console.log("It must be changed at first sign-in.");
  } else if (command === "reset-password") {
    if (!values.email) throw new Error("--email is required");
    console.log(`Temporary password: ${await resetPassword(db, await userId(db, values.email))}`);
    console.log("All of this user's sessions were signed out; the password must be changed at next sign-in.");
  } else if (command === "list-users") {
    for (const u of await listLocalUsers(db)) {
      console.log([u.email, u.is_admin ? "admin" : "", u.disabled_at ? "disabled" : "", u.must_change_password ? "temporary password" : ""].filter(Boolean).join("  "));
    }
  } else if (command === "create-token") {
    if (!values.name) throw new Error("--name is required");
    const owner = values.service ? await serviceUserId(db, values.service) : values.email ? await userId(db, values.email) : null;
    if (!owner) throw new Error("pass --email (a person's token) or --service (a bot's token)");
    // A bot that writes docs must own its projects so pages publish without review.
    for (const slug of values["owner-of"] ?? []) {
      const scope = (await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1 AND kind = 'project'", [slug])).rows[0];
      if (!scope) throw new Error(`no project ${slug}`);
      await db.query(
        "INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT (scope_id, user_id) DO UPDATE SET role = 'owner'",
        [scope.id, owner],
      );
      console.error(`Owner of ${slug}.`);
    }
    const token = await createApiToken(db, owner, values.name, values.days ? Number(values.days) : undefined);
    console.log(token.token);
    console.error("Shown once. Use it as: Authorization: Bearer <token>");
  } else if (command === "export") {
    if (!values.out) throw new Error("--out <file.zip> is required");
    // Everything, as a system actor with admin reach (no person's read limits apply).
    const settings = settingsFrom(loadConfig());
    const actor = { id: await serviceUserId(db, "thaliyola-export"), subject: "service:thaliyola-export", email: null, kind: "service" as const };
    const out = await exportMarkdown({ db, settings, actor }, { scope: values.scope, all: true });
    writeFileSync(values.out, out.zip);
    console.log(`Wrote ${values.out}: ${out.articles} articles, ${out.findings} findings, ${out.assets} files.`);
  } else {
    console.error("commands: create-user | reset-password | list-users | create-token | export");
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}

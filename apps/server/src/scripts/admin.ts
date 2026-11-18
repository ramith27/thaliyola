/**
 * Account administration from the shell (bootstrap the first admin, recover access, bot tokens).
 *
 *   node dist/scripts/admin.js create-user --email you@example.com [--name "You"] [--admin]
 *   node dist/scripts/admin.js reset-password --email you@example.com
 *   node dist/scripts/admin.js list-users
 *   node dist/scripts/admin.js create-token --email you@example.com --name "Claude Code" [--days 90]
 *   node dist/scripts/admin.js create-token --service rca-bot --name "nightly RCA job"
 *   node dist/scripts/admin.js create-token --service docs-bot --name "CI docs" --owner-of order-service
 *   node dist/scripts/admin.js create-token --service import-bot --name "Docs import" --in team [--in library] [--role contributor]
 *   node dist/scripts/admin.js grant --service import-bot --in team [--role reviewer]
 *   node dist/scripts/admin.js export --out thaliyola-export.zip [--scope team]
 *
 * Reads DATABASE_URL like the server.
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { createApiToken, createLocalUser, listLocalUsers, resetPassword } from "../auth/local.js";
import { loadConfig, settingsFrom } from "../config.js";
import { exportMarkdown } from "../core/exporter.js";
import { serviceUserId, SYSTEM_ACCOUNTS } from "../core/users.js";
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
    in: { type: "string", multiple: true },
    role: { type: "string" },
  },
});

async function userId(db: Db, email: string) {
  const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE subject = $1", [`local:${email.trim().toLowerCase()}`]);
  if (!rows[0]) throw new Error(`no local user ${email}`);
  return rows[0].id;
}

/** Role names people use, mapped to their keys (both work). */
const ROLE_ALIASES: Record<string, string> = { contributor: "writer", viewer: "reader", "project-admin": "owner", admin: "owner" };

/** Gives an account a role in spaces or projects (any kind: team, library or project). */
async function grantRoles(db: Db, userId: string, slugs: string[], roleName = "contributor") {
  const role = ROLE_ALIASES[roleName.toLowerCase()] ?? roleName.toLowerCase();
  const known = (await db.query<{ name: string }>("SELECT name FROM roles WHERE key = $1 AND kind = 'project'", [role])).rows[0];
  if (!known) {
    const all = (await db.query<{ key: string; name: string }>("SELECT key, name FROM roles WHERE kind = 'project' ORDER BY position")).rows;
    throw new Error(`no role ${roleName}; use one of: ${all.map((r) => `${r.name.toLowerCase().replace(/ /g, "-")} (${r.key})`).join(", ")}`);
  }
  for (const slug of slugs) {
    const scope = (await db.query<{ id: string; name: string }>("SELECT id, name FROM scopes WHERE slug = $1 AND kind IN ('team', 'library', 'project') AND status = 'active'", [slug])).rows[0];
    if (!scope) throw new Error(`no space or project ${slug}`);
    await db.query("INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [scope.id, userId, role]);
    console.error(`${known.name} in ${scope.name}.`);
  }
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
    if (values.service && SYSTEM_ACCOUNTS.includes(values.service)) throw new Error(`${values.service} is reserved for Thaliyola itself`);
    const owner = values.service ? await serviceUserId(db, values.service) : values.email ? await userId(db, values.email) : null;
    if (!owner) throw new Error("pass --email (a person's token) or --service (a bot's token)");
    // A bot needs a role to write in members-only projects; its writes are proposals people review (service accounts never publish).
    for (const slug of values["owner-of"] ?? []) {
      const scope = (await db.query<{ id: string }>("SELECT id FROM scopes WHERE slug = $1 AND kind = 'project'", [slug])).rows[0];
      if (!scope) throw new Error(`no project ${slug}`);
      await db.query(
        "INSERT INTO scope_members (scope_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING",
        [scope.id, owner],
      );
      console.error(`Project admin of ${slug} (its writes still go to review: service accounts never publish).`);
    }
    if (values.in?.length) await grantRoles(db, owner, values.in, values.role);
    if (values.service && !values.in?.length && !values["owner-of"]?.length)
      console.error("No roles given: this bot can read what everyone can but can't write anywhere. Add --in <space or project> [--role contributor].");
    const token = await createApiToken(db, owner, values.name, values.days ? Number(values.days) : undefined);
    console.log(token.token);
    console.error("Shown once. Use it as: Authorization: Bearer <token>");
  } else if (command === "grant") {
    if (!values.in?.length) throw new Error("--in <space or project> is required");
    const who = values.service ? await serviceUserId(db, values.service) : values.email ? await userId(db, values.email) : null;
    if (!who) throw new Error("pass --service <bot> or --email <person>");
    await grantRoles(db, who, values.in, values.role);
  } else if (command === "export") {
    if (!values.out) throw new Error("--out <file.zip> is required");
    // Everything, as a system actor with admin reach (no person's read limits apply).
    const settings = settingsFrom(loadConfig());
    const actor = { id: await serviceUserId(db, "thaliyola-export"), subject: "service:thaliyola-export", email: null, kind: "service" as const };
    const out = await exportMarkdown({ db, settings, actor }, { scope: values.scope, all: true });
    writeFileSync(values.out, out.zip);
    console.log(`Wrote ${values.out}: ${out.articles} articles, ${out.findings} findings, ${out.assets} files.`);
  } else {
    console.error("commands: create-user | reset-password | list-users | create-token | grant | export");
    process.exitCode = 2;
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}

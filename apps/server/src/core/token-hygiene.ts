import type { Settings } from "../config.js";
import type { Db } from "../db/pool.js";
import { audit } from "./audit.js";
import { notify } from "./notify.js";
import { idsWithPermission } from "./roles.js";

/**
 * Token hygiene: a week before an API token expires, its owner hears about it (personal tokens), or everyone who
 * manages people does (service-account tokens), once per token. Tokens made to last a week or less aren't announced,
 * and neither are revoked or rotated ones (the replacement gets its own notice). Rotation and the "unused" flag are in
 * auth/local.ts.
 */

export const EXPIRY_NOTICE_DAYS = 7;

const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Sends the notices due now and marks those tokens. Returns how many tokens were announced. */
export async function notifyExpiringTokens(db: Db, settings: Settings): Promise<{ personal: number; service: number }> {
  // Claiming and marking in one statement: each token is announced once, even with several server instances.
  const { rows } = await db.query<{ id: string; name: string; expires_at: Date; user_id: string; kind: "human" | "service"; account: string }>(
    `UPDATE api_tokens t SET expiry_notified_at = now()
       FROM users u
      WHERE u.id = t.user_id AND u.disabled_at IS NULL
        AND t.expiry_notified_at IS NULL AND t.revoked_at IS NULL AND t.rotated_at IS NULL
        AND t.expires_at > now() AND t.expires_at <= now() + make_interval(days => $1)
        AND t.expires_at - t.created_at > make_interval(days => $1)
      RETURNING t.id, t.name, t.expires_at, t.user_id, u.kind, coalesce(nullif(u.display_name, ''), substr(u.subject, 9)) AS account`,
    [EXPIRY_NOTICE_DAYS],
  );
  let personal = 0;
  let service = 0;
  const managers = rows.some((r) => r.kind === "service") ? await idsWithPermission(db, settings, "manage_users") : [];
  for (const t of rows) {
    if (t.kind === "service") {
      service++;
      await notify(db, settings, managers, {
        kind: "token",
        title: `${t.account}'s token "${t.name}" expires on ${day(t.expires_at)}`,
        body: "Rotate it in Admin › Service accounts and give the new token to the system that uses it. The old one can keep working for a day or a week while you switch.",
        link: "#/admin/service-accounts",
        targetId: t.id,
      });
    } else {
      personal++;
      await notify(db, settings, [t.user_id], {
        kind: "token",
        title: `Your API token "${t.name}" expires on ${day(t.expires_at)}`,
        body: "Rotate it in Account › API tokens to keep your tools working: the new token has the same name and lifetime, and the old one can keep working for a day or a week while you switch.",
        link: "#/account?section=tokens",
        targetId: t.id,
      });
    }
    await audit(db, null, "notify_token_expiry", t.id, {
      targetKind: "token",
      targetLabel: t.name,
      details: { token_name: t.name, owner: t.kind === "service" ? `service:${t.account}` : "personal", expires_at: t.expires_at.toISOString() },
    });
  }
  return { personal, service };
}

/** Checks hourly and runs once a day (one instance at a time). */
export function startTokenJobs(db: Db, settings: Settings, log: (msg: string) => void) {
  const LOCK = 7_402_215;
  async function tick() {
    const client = await db.connect().catch((err: Error) => void log(`token checks failed: ${err.message}`));
    if (!client) return;
    try {
      const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1) AS locked", [LOCK]);
      if (!rows[0]?.locked) return;
      try {
        const last = await db.query<{ due: boolean }>("SELECT last_run < now() - interval '23 hours' AS due FROM job_runs WHERE name = 'token_expiry'");
        if (last.rows[0]?.due === false) return;
        const sent = await notifyExpiringTokens(db, settings);
        await db.query("INSERT INTO job_runs (name, last_run) VALUES ('token_expiry', now()) ON CONFLICT (name) DO UPDATE SET last_run = now()");
        if (sent.personal || sent.service) log(`warned about ${sent.personal} personal and ${sent.service} service-account token(s) expiring within ${EXPIRY_NOTICE_DAYS} days`);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK]);
      }
    } catch (err) {
      log(`token checks failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  // One run at a time, so shutdown can wait for it (like the other jobs).
  let current: Promise<void> | null = null;
  const start = () => {
    if (current) return;
    current = tick().finally(() => (current = null));
  };
  const first = setTimeout(start, 60_000);
  const timer = setInterval(start, 60 * 60_000);
  first.unref();
  timer.unref();
  return {
    tick,
    /** Starts no more runs; resolves when the one in progress (if any) has finished. */
    async stop() {
      clearTimeout(first);
      clearInterval(timer);
      await current;
    },
  };
}

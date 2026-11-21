import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifying GitHub and GitLab webhooks, shared by skill sources and git connections (PR briefings): GitHub signs the
 * raw body (X-Hub-Signature-256, HMAC-SHA256 with the secret), GitLab sends the secret itself (X-Gitlab-Token).
 */

/** Equal strings, compared in constant time whatever their lengths. */
export function sameText(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Whether a delivery carries the right secret: GitLab's token header or GitHub's body signature. */
export function verifyGitWebhook(secret: string, headers: Record<string, string | undefined>, raw: Buffer): boolean {
  if (!secret) return false;
  const gitlab = headers["x-gitlab-token"];
  const signature = headers["x-hub-signature-256"];
  return (gitlab !== undefined && sameText(gitlab, secret)) || (signature !== undefined && sameText(signature, `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`));
}

/** Requests per key per minute, counted in memory (per replica); true once over the limit. */
export function rateLimiter(perMinute: () => number) {
  const hits = new Map<string, number[]>();
  return {
    over(key: string): boolean {
      const now = Date.now();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 10_000) for (const [k, v] of hits) if (!v.some((t) => now - t < 60_000)) hits.delete(k);
      return recent.length > perMinute();
    },
    reset() {
      hits.clear();
    },
  };
}

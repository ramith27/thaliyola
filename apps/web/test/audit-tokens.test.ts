import { describe, expect, it } from "vitest";
import { canRotate, tokenExpiryText, tokenStatus, type ApiToken } from "../src/components/tokens";
import { apiQuery, detailLines, type AuditEntry } from "../src/pages/audit";

const DAY = 86_400_000;
const at = (ms: number) => new Date(Date.now() + ms).toISOString();
const token = (extra: Partial<ApiToken> = {}): ApiToken => ({
  id: "t1",
  name: "Laptop",
  prefix: "thaliyola_pat_abc",
  created_at: at(-30 * DAY),
  last_used_at: null,
  expires_at: at(60 * DAY),
  revoked_at: null,
  ...extra,
});

describe("token status", () => {
  it("tells active, expiring, expired, revoked and replaced tokens apart, and which can be rotated", () => {
    expect(tokenStatus(token())).toBe("active");
    expect(tokenStatus(token({ expires_at: null }))).toBe("active");
    expect(tokenStatus(token({ expires_at: at(3 * DAY) }))).toBe("expiring");
    expect(tokenStatus(token({ expires_at: at(-DAY) }))).toBe("expired");
    expect(tokenStatus(token({ revoked_at: at(-DAY) }))).toBe("revoked");
    expect(tokenStatus(token({ rotated_at: at(-1000), expires_at: at(DAY) }))).toBe("replaced");
    expect(tokenStatus(token({ rotated_at: at(-DAY), expires_at: at(-1000) }))).toBe("expired");
    expect([token(), token({ expires_at: at(3 * DAY) })].every(canRotate)).toBe(true);
    expect([token({ rotated_at: at(-1000) }), token({ revoked_at: at(-1) }), token({ expires_at: at(-1) })].some(canRotate)).toBe(false);
    expect(tokenExpiryText(token({ rotated_at: at(-1000), expires_at: at(DAY) }))).toMatch(/^Works until /);
    expect(tokenExpiryText(token({ expires_at: null }))).toBe("Never");
  });
});

describe("audit log page", () => {
  it("turns whole days in the URL into an API time range, and drops bad dates", () => {
    const p = apiQuery({ action: "update_user", from: "2026-11-01", to: "2026-11-02", reads: "true" });
    expect(p.get("action")).toBe("update_user");
    expect(new Date(p.get("from")!).getTime()).toBe(new Date("2026-11-01T00:00:00").getTime());
    expect(new Date(p.get("to")!).getTime()).toBe(new Date("2026-11-03T00:00:00").getTime());
    expect(p.get("reads")).toBe("true");
    expect(apiQuery({ from: "yesterday" }).has("from")).toBe(false);
  });

  it("describes changes in words", () => {
    const entry = (action: string, details: Record<string, unknown>): AuditEntry => ({
      id: "1",
      at: new Date().toISOString(),
      action,
      label: action,
      group: "people",
      actor: null,
      target: null,
      via: null,
      details,
    });
    const roles = [{ key: "auditor", name: "Auditor", kind: "org", description: "", permissions: [], builtin: true }] as never;
    expect(detailLines(entry("set_user_roles", { added: ["auditor", "admin"], removed: [] }), roles)).toEqual(["Added Auditor, Administrator"]);
    expect(detailLines(entry("update_role", { added: ["view_metrics"], removed: [] }), roles)).toEqual(["Added See usage"]);
    expect(detailLines(entry("rotate_api_token", { token_name: "Laptop", grace: "none", old_works_until: null }), roles)).toEqual(["Token “Laptop”", "Old token stopped at once"]);
    expect(
      detailLines(entry("update_system_settings", { changes: [{ setting: "slack_webhook_url", label: "Slack channel webhook", change: "changed" }, { setting: "digest_hour", label: "Digest hour", from: 8, to: 9 }] }), roles),
    ).toEqual(["Slack channel webhook: changed", "Digest hour: 8 → 9"]);
    const team = (details: Record<string, unknown>) => ({ ...entry("set_team_member", { team: "platform", person: "rita@example.com", ...details }), target: { id: "t", kind: "team" as const, label: "Platform", ref: "platform" } });
    expect(detailLines(team({ member: "added", role: "member" }), roles)).toEqual(["Added rita@example.com as a member"]);
    expect(detailLines(team({ member: "role changed", role: "lead" }), roles)).toEqual(["Made rita@example.com a lead"]);
    expect(detailLines(team({ member: "removed", role: null }), roles)).toEqual(["Removed rita@example.com"]);
    expect(detailLines(entry("oauth_authorize", { app: "Claude Desktop" }), roles)).toEqual(["App Claude Desktop"]);
    expect(detailLines(entry("system_settings", { settings: ["session_ttl_hours"] }), roles)).toEqual(["Settings: session_ttl_hours"]);
    expect(detailLines(entry("decline_project_request", { slug: "audit-demo" }), roles)).toEqual(["Short name audit-demo"]);
  });
});

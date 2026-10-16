import { describe, expect, it } from "vitest";
import { onlyRedacted, redact, redactFields } from "../src/core/redaction.js";

describe("redact", () => {
  it.each([
    ["postgres://admin:hunter2@db.internal:5432/app", "postgres://[REDACTED:credentials]@db.internal:5432/app"],
    ["key AKIAIOSFODNN7EXAMPLE leaked", "key [REDACTED:aws_key] leaked"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", "token [REDACTED:github_token]"],
    ["xoxb-123456789012-abcdefghij", "[REDACTED:slack_token]"],
    ["use sk-ant-api03-abcdefghijklmnopqrstuv", "use [REDACTED:api_key]"],
    ["Authorization: Bearer abcdef0123456789abcdef", "Authorization: Bearer [REDACTED:bearer_token]"],
    ["password=s3cretValue", "password=[REDACTED:secret]"],
    ['{"api_key": "abcd1234efgh"}', '{"api_key": "[REDACTED:secret]"}'],
    ["mail jane.doe@example.com now", "mail [REDACTED:email] now"],
    ["call (415) 555-0100 or +44 20 7946 0958", "call [REDACTED:phone] or [REDACTED:phone]"],
    [
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "jwt [REDACTED:jwt]",
    ],
  ])("redacts %s", (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it("redacts a private key block", () => {
    const r = redact("before\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\nafter");
    expect(r.text).toBe("before\n[REDACTED:private_key]\nafter");
  });

  it.each([
    "Deployed on 2026-10-16 at 14:05",
    "version 1.32.1 and order 12345678",
    "https://example.slack.com/archives/C1/p1",
    "error rate above 2% for 5 minutes; HTTP 429",
    "SELECT count(*) FROM orders WHERE token_count > 3",
  ])("leaves ordinary text alone: %s", (input) => {
    expect(redact(input)).toEqual({ text: input, redactions: [] });
  });

  it("counts redactions across fields", () => {
    const r = redactFields({ a: "a@b.co and c@d.co", b: ["password: hunter22"], n: 3 });
    expect(r.fields).toEqual({ a: "[REDACTED:email] and [REDACTED:email]", b: ["password: [REDACTED:secret]"], n: 3 });
    expect(r.redactions).toEqual([
      { kind: "email", count: 2 },
      { kind: "secret", count: 1 },
    ]);
  });

  it("detects fields that were nothing but secrets", () => {
    expect(onlyRedacted(" [REDACTED:api_key] ")).toBe(true);
    expect(onlyRedacted("key [REDACTED:api_key]")).toBe(false);
  });
});

/**
 * Rule-based redaction applied to every write. No LLM: patterns only, so the
 * behaviour is predictable and testable. Matches are replaced with
 * `[REDACTED:<kind>]` and counted so reviewers can see what was removed.
 */

interface Rule {
  kind: string;
  pattern: RegExp;
  /** Replacement; defaults to the whole match becoming the marker. */
  replace?: (match: string, ...groups: string[]) => string;
}

const marker = (kind: string) => `[REDACTED:${kind}]`;

const RULES: Rule[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  },
  {
    // scheme://user:password@host -> keep scheme and host
    kind: "credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi,
    replace: (_m, scheme) => `${scheme}${marker("credentials")}@`,
  },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "aws_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { kind: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "api_key", pattern: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|(?:sk|rk|pk)_live_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{35})\b/g },
  {
    kind: "bearer_token",
    pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
    replace: (_m, scheme) => `${scheme} ${marker("bearer_token")}`,
  },
  {
    // password=..., api_key: "...", "client_secret": "..." -> keep the key name
    kind: "secret",
    pattern:
      /((?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|auth[_-]?token|access[_-]?token|token)["']?\s*[:=]\s*)(["']?)(?!\[REDACTED:)([^\s"',;]{4,})\2/gi,
    replace: (_m, prefix, quote) => `${prefix}${quote}${marker("secret")}${quote}`,
  },
  { kind: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    kind: "phone",
    pattern:
      /(?<![\w.+-])(?:\+\d{1,3}[\s.-]?\d{2,4}[\s.-]\d{3,4}[\s.-]\d{3,4}|(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4})(?![\w.])/g,
  },
];

export interface Redaction {
  kind: string;
  count: number;
}

export function redact(text: string): { text: string; redactions: Redaction[] } {
  const counts = new Map<string, number>();
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      counts.set(rule.kind, (counts.get(rule.kind) ?? 0) + 1);
      return rule.replace ? rule.replace(match, ...(rest as string[])) : marker(rule.kind);
    });
  }
  return { text: out, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}

/** Redacts each string field of a record; merges the counts. */
export function redactFields<T extends Record<string, unknown>>(fields: T): { fields: T; redactions: Redaction[] } {
  const totals = new Map<string, number>();
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") {
      const r = redact(value);
      out[key] = r.text;
      for (const { kind, count } of r.redactions) totals.set(kind, (totals.get(kind) ?? 0) + count);
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => {
        if (typeof v !== "string") return v;
        const r = redact(v);
        for (const { kind, count } of r.redactions) totals.set(kind, (totals.get(kind) ?? 0) + count);
        return r.text;
      });
    } else {
      out[key] = value;
    }
  }
  return { fields: out as T, redactions: [...totals].map(([kind, count]) => ({ kind, count })) };
}

/** True when a required field holds nothing but redaction markers and whitespace. */
export function onlyRedacted(text: string): boolean {
  return text.replace(/\[REDACTED:[a-z_]+\]/g, "").trim() === "";
}

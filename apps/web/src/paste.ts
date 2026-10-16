/**
 * Turns pasted text (a Slack thread, an email, incident notes, a doc) into a
 * draft finding or article with simple rules. No model is involved: it finds
 * labelled parts ("Root cause:", "Fix:") and strips chat noise, and the
 * person edits the result before saving. For a smarter draft, use the
 * `draft-from-paste` prompt in an AI client.
 */

export interface FindingDraft {
  kind: "finding";
  type: string;
  title: string;
  symptoms: string;
  root_cause: string;
  fix: string;
}

export interface ArticleDraft {
  kind: "article";
  type: string;
  title: string;
  body_md: string;
}

const NOISE = [
  /^\s*\d{1,2}:\d{2}(\s?[AP]M)?\s*$/i, // bare timestamps
  /^.{1,60}\s{2,}\d{1,2}:\d{2}(\s?[AP]M)?\s*$/i, // "Name  10:42 AM"
  /^\s*\[\d{1,2}:\d{2}(\s?[AP]M)?\]/i, // "[10:42] name:" copy format
  /^\s*(:[\w+-]+:\s*\d+\s*)+$/, // reaction counts ":eyes: 2"
  /^\s*\(edited\)\s*$/i,
  /^\s*\d+ repl(y|ies)\s*(last reply.*)?$/i,
  /^\s*(view|show) (thread|more|less)\s*$/i,
  /^\s*(new messages?|today|yesterday)\s*$/i,
  /^\s*(from|to|cc|sent|date|subject):\s/i, // email headers
  /^\s*(>\s*)?on .{4,80} wrote:\s*$/i, // reply attributions
  /^\s*--\s*$/, // signature separator
];

const LABELS: { field: "symptoms" | "root_cause" | "fix"; re: RegExp }[] = [
  { field: "symptoms", re: /^\s*(?:#+\s*|\*\*)?(symptoms?|what happened|impact|issue|problem|summary|observed)\s*(?:\*\*)?\s*[:\-–]\s*(.*)$/i },
  { field: "root_cause", re: /^\s*(?:#+\s*|\*\*)?(root ?cause|cause|why it happened|why|diagnosis)\s*(?:\*\*)?\s*[:\-–]\s*(.*)$/i },
  { field: "fix", re: /^\s*(?:#+\s*|\*\*)?(fix|fixed by|resolution|solution|workaround|mitigation|remediation|next steps|action items)\s*(?:\*\*)?\s*[:\-–]\s*(.*)$/i },
];

function clean(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*--\s*$/.test(line)) break; // drop email signatures
    if (NOISE.some((re) => re.test(line))) continue;
    out.push(line.replace(/\s+$/, ""));
  }
  // Collapse runs of blank lines.
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().split("\n");
}

function titleFrom(lines: string[]): string {
  const first = lines.find((l) => l.trim() && !LABELS.some((x) => x.re.test(l))) ?? "";
  const t = first
    .replace(/^\s*(#+|[-*>]|\d+\.)\s*/, "")
    .replace(/^(subject|re|fwd?):\s*/i, "")
    .replace(/[*_`]/g, "")
    .trim();
  return t.length > 120 ? `${t.slice(0, 117).replace(/\s+\S*$/, "")}…` : t;
}

/** An email's subject makes the best title. */
function subjectOf(text: string): string | null {
  const m = /^\s*subject:\s*(.+)$/im.exec(text);
  return m ? m[1]!.replace(/^((re|fwd?):\s*)+/i, "").trim() || null : null;
}

function guessFindingType(text: string): string {
  if (/\b(select|from|where|join|group by)\b[\s\S]*\b(from|where)\b/i.test(text) && /```|select /i.test(text)) return "query_recipe";
  if (/\b(known issue|workaround|by design|wontfix)\b/i.test(text)) return "known_issue";
  if (/\b(null|duplicate rows?|timezone|utc|late[- ]arriving|backfill|double[- ]count)/i.test(text)) return "data_gotcha";
  if (/\b(root ?cause|rca|postmortem|post-mortem)\b/i.test(text)) return "rca";
  return "incident";
}

export function draftFinding(text: string): FindingDraft {
  const lines = clean(text);
  const subject = subjectOf(text);
  const title = subject ?? titleFrom(lines);
  const parts: Record<"symptoms" | "root_cause" | "fix", string[]> = { symptoms: [], root_cause: [], fix: [] };
  let current: keyof typeof parts | null = null;
  const loose: string[] = [];
  for (const line of lines) {
    const label = LABELS.find((x) => x.re.test(line));
    if (label) {
      current = label.field;
      const rest = label.re.exec(line)![2]!.trim();
      if (rest) parts[current].push(rest);
      continue;
    }
    if (current) parts[current].push(line);
    else loose.push(line);
  }
  // Unlabelled text: everything after the title describes what was seen.
  const body = subject ? loose : loose.filter((l, i) => !(i === loose.findIndex((x) => x.trim()) && titleFrom([l]) === title));
  if (!parts.symptoms.join("").trim()) parts.symptoms = body;
  else if (body.join("").trim()) parts.symptoms.push("", ...body);
  const join = (a: string[]) => a.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // A one-line report ("Checkout is throwing 502s") is its own symptom.
  if (!join(parts.symptoms)) parts.symptoms = [title];
  return { kind: "finding", type: guessFindingType(text), title, symptoms: join(parts.symptoms), root_cause: join(parts.root_cause), fix: join(parts.fix) };
}

function guessArticleType(text: string): string {
  if (/\b(step \d|steps|runbook|if .* then|rollback|alert)\b/i.test(text)) return "runbook";
  if (/\b(we decided|decision|options considered|chose|trade-?offs?)\b/i.test(text)) return "decision";
  if (/\b(GET|POST|PUT|PATCH|DELETE) \/\w/.test(text)) return "api_contract";
  if (/\b(goals?|non-goals?|proposal|design)\b/i.test(text)) return "design_doc";
  return "design_doc";
}

export function draftArticle(text: string): ArticleDraft {
  const lines = clean(text);
  const subject = subjectOf(text);
  const title = subject ?? titleFrom(lines);
  const rest = subject ? lines : lines.slice(lines.findIndex((l) => l.trim()) + 1);
  // Short lines ending in ":" read as headings in pasted docs and emails.
  const body = rest
    .map((l) => (/^[A-Z][\w ,/&()-]{1,50}:\s*$/.test(l.trim()) ? `## ${l.trim().replace(/:$/, "")}` : l))
    .join("\n")
    .trim();
  const hasHeadings = /^#{1,3} /m.test(body);
  return { kind: "article", type: guessArticleType(text), title, body_md: hasHeadings ? body : `## Context\n\n${body}` };
}

const PREFILL_KEY = "thaliyola.prefill";

export function setPrefill(draft: FindingDraft | ArticleDraft) {
  try {
    sessionStorage.setItem(PREFILL_KEY, JSON.stringify(draft));
  } catch {
    /* storage unavailable */
  }
}

export function takePrefill<K extends "finding" | "article">(kind: K): (K extends "finding" ? FindingDraft : ArticleDraft) | null {
  try {
    const raw = sessionStorage.getItem(PREFILL_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v?.kind !== kind) return null;
    sessionStorage.removeItem(PREFILL_KEY);
    return v;
  } catch {
    return null;
  }
}

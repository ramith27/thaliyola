import { splitSections } from "./chunking.js";

/** Sections each article type is expected to have, so people and agents know where to look and what is missing. */
export const ARTICLE_TEMPLATES: Record<string, string[]> = {
  system: ["Purpose", "Architecture", "Dependencies", "Owners", "Dashboards and alerts", "Known issues", "Runbooks"],
  table: ["Grain", "Key columns", "Freshness and retention", "Standard joins", "Gotchas", "Example queries"],
  metric: ["Definition", "Formula", "Source of truth", "Caveats"],
  runbook: ["Trigger", "Diagnosis steps", "Fix", "Verify", "Rollback"],
  decision: ["Context", "Options considered", "Choice", "Consequences"],
  project_overview: ["Goal", "Status", "Architecture summary", "Key decisions", "Dependencies", "Repos"],
  design_doc: ["Context", "Goals and non-goals", "Design", "Alternatives", "Risks", "Open questions"],
  tech_spec: ["Interface", "Data shapes", "Invariants", "Versioning", "Consumers"],
  api_contract: ["Interface", "Data shapes", "Errors", "Auth", "Versioning"],
  pattern: ["Problem", "Solution", "When to use", "When to avoid", "Reference implementations"],
  design_tokens: ["Colour", "Typography", "Spacing", "Usage rules"],
  ui_component: ["Purpose", "Anatomy", "States", "Variants", "Accessibility", "Do and don't"],
  ux_pattern: ["Problem", "Flow", "When to use", "Examples"],
  screen_spec: ["Purpose", "User flow", "States", "API calls"],
};

export function missingSections(type: string, body: string): string[] {
  const present = new Set(splitSections(body).map((s) => s.heading.toLowerCase()));
  return (ARTICLE_TEMPLATES[type] ?? []).filter((h) => !present.has(h.toLowerCase()));
}

/** What to write in each template section, shown in the editor as an HTML comment and removed on save. */
export const SECTION_HINTS: Record<string, string> = {
  Purpose: "What this is for, in one or two sentences. Who uses it?",
  Architecture: "Main parts and how requests flow between them. Link a diagram if there is one.",
  Dependencies: "What this needs to work (services, queues, third parties) and what breaks without them.",
  Owners: "Team and people to ask, and where to reach them.",
  "Dashboards and alerts": "Links to dashboards, and which alerts fire and what they mean.",
  "Known issues": "Problems people hit repeatedly. Link the findings.",
  Runbooks: "Links to runbooks for this system.",
  Grain: "What one row represents.",
  "Key columns": "The columns people use most, and what they mean.",
  "Freshness and retention": "How often it updates, how late data can be, and how long it's kept.",
  "Standard joins": "Which tables it joins to, and on which keys.",
  Gotchas: "Things that trip people up: duplicates, nulls, timezones, soft deletes.",
  "Example queries": "Queries that answer common questions, in code blocks.",
  Definition: "What the metric means, in plain words.",
  Formula: "The exact calculation, in a code block.",
  "Source of truth": "The table or system to compute it from (and what not to use).",
  Caveats: "Exclusions, known biases, and when the number is misleading.",
  Trigger: "The alert or symptom that starts this runbook.",
  "Diagnosis steps": "Numbered checks, most likely cause first.",
  Fix: "What to do, step by step.",
  Verify: "How to tell it worked.",
  Rollback: "How to undo the fix if it makes things worse.",
  Context: "The situation and the problem to solve. Why now?",
  "Options considered": "Each option with its pros and cons.",
  Choice: "What was decided, and the main reason.",
  Consequences: "What gets easier, what gets harder, and what to revisit later.",
  Goal: "What the project delivers, and for whom.",
  Status: "Where it is now and what's next.",
  "Architecture summary": "The main components and how they fit together.",
  "Key decisions": "Links to decision articles.",
  Repos: "Repositories and what each holds.",
  "Goals and non-goals": "What this design must do, and what it deliberately won't.",
  Design: "How it works. Diagrams, data flow, interfaces.",
  Alternatives: "Other approaches and why they weren't chosen.",
  Risks: "What could go wrong and how it's mitigated.",
  "Open questions": "What's still undecided, and who decides.",
  Interface: "Endpoints, functions or events, with request and response examples.",
  "Data shapes": "Payload and schema definitions, in code blocks.",
  Invariants: "Rules that always hold (ordering, uniqueness, idempotency).",
  Versioning: "How changes are introduced and how consumers are told.",
  Consumers: "Who calls this. Link their projects or components.",
  Errors: "Error codes, when each happens, and what the caller should do.",
  Auth: "How callers authenticate and which permissions they need.",
  Problem: "The recurring problem this solves.",
  Solution: "The approach, with a short example.",
  "When to use": "Situations where this is the right choice.",
  "When to avoid": "Situations where it isn't, and what to use instead.",
  "Reference implementations": "Links to code that does this well.",
  Colour: "Colour tokens and their roles (text, surface, accent, status).",
  Typography: "Type scale, families and weights.",
  Spacing: "Spacing scale and where each step is used.",
  "Usage rules": "Do and don't for applying the tokens.",
  Anatomy: "The parts of the component, labelled.",
  States: "Default, hover, focus, disabled, loading, empty, error.",
  Variants: "Sizes and styles, and when to use each.",
  Accessibility: "Keyboard behaviour, focus order, labels and contrast.",
  "Do and don't": "Examples of correct and incorrect use.",
  Flow: "The steps the user goes through.",
  Examples: "Screens or projects that use this pattern.",
  "User flow": "How the user arrives, what they do, and where they go next.",
  "API calls": "Endpoints this screen calls. Link the contract.",
};

const HINT_PREFIX = "<!-- Hint: ";

/** A markdown skeleton for a new article of this type, optionally with writing hints. */
export function templateFor(type: string, opts: { hints?: boolean } = {}): string {
  return (ARTICLE_TEMPLATES[type] ?? [])
    .map((h) => (opts.hints && SECTION_HINTS[h] ? `## ${h}\n\n${HINT_PREFIX}${SECTION_HINTS[h]} -->\n\n` : `## ${h}\n\n`))
    .join("");
}

/** Removes the editor's template hints (and the blank line after each) before saving. */
export function stripHints(markdown: string): string {
  return markdown.replace(/<!-- Hint: [\s\S]*?-->\n?\n?/g, "");
}

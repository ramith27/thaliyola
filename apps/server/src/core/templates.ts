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

/** A markdown skeleton for a new article of this type. */
export function templateFor(type: string): string {
  return (ARTICLE_TEMPLATES[type] ?? []).map((h) => `## ${h}\n\n`).join("");
}

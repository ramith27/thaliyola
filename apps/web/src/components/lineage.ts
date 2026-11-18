import { labelFrom, REPO_KIND } from "./labels";

/**
 * Lineage: a repository reads or writes a table (a typed link from the component to the table's article). Shared by
 * the Data view (where links are added and removed), table articles and the knowledge graph.
 */

export type LineageKind = "reads" | "writes";
export const LINEAGE_KINDS: readonly string[] = ["reads", "writes"];

export const isLineage = (relation: string) => LINEAGE_KINDS.includes(relation);

/** "reads" / "read by", "writes" / "written by": from the repository, or from the table. */
export function lineageText(kind: string, from: "repository" | "table"): string {
  if (kind === "writes") return from === "repository" ? "writes" : "written by";
  return from === "repository" ? "reads" : "read by";
}

/** The link_entries reference of a repository. */
export const componentRef = (project: string, component: string) => `component:${project}/${component}`;

export interface LineageChoice {
  project: string;
  project_name: string;
  component: string;
  kind: string;
}

/** Repositories to choose from, grouped by project (in the order given), as Select groups. */
export function lineageChoiceGroups(choices: LineageChoice[]): { label: string; options: { value: string; label: string }[] }[] {
  const groups = new Map<string, { value: string; label: string }[]>();
  for (const c of choices) {
    const list = groups.get(c.project_name) ?? [];
    list.push({ value: `${c.project}/${c.component}`, label: `${c.component} (${labelFrom(REPO_KIND, c.kind)})` });
    groups.set(c.project_name, list);
  }
  return [...groups].map(([label, options]) => ({ label, options }));
}

/** The repository's name in a related item's label ("Project name / repo"). */
export const repoOfLabel = (label: string) => label.split(" / ").pop() ?? label;

/**
 * What's new: release and feature shapes from /api/releases and /api/features, and the pure helpers the page, the
 * Help menu and the tests share. No React, no DOM.
 */
import type { BuildInfo } from "../api";

export type FeatureArea = "knowledge" | "review" | "security" | "inbox" | "projects" | "people" | "connections" | "skills" | "admin" | "mcp" | "platform";
export type FeatureKind = "new" | "improved" | "fixed";
export type Audience = "everyone" | "admins" | "project_admins";

export interface Feature {
  id: string;
  release_id: string;
  version: string;
  release_status: "draft" | "published";
  released_on: string | null;
  title: string;
  area: FeatureArea;
  area_name: string;
  kind: FeatureKind;
  kind_name: string;
  description: string;
  how_to: string;
  app_route: string | null;
  docs_url: string | null;
  audience: Audience;
  audience_name: string;
  tags: string[];
  position: number;
  screenshots: { id: string; alt_text: string; filename: string }[];
  updated_at: string;
}

export interface ReleaseCounts {
  new: number;
  improved: number;
  fixed: number;
  total: number;
}

export interface Release {
  id: string;
  version: string;
  title: string;
  summary: string;
  released_on: string | null;
  status: "draft" | "published";
  source: "manual" | "changelog" | "seed";
  published_at: string | null;
  updated_at: string;
  counts: ReleaseCounts;
  features?: Feature[];
}

export interface ReleaseList {
  releases: Release[];
  can_manage: boolean;
  current: BuildInfo;
  areas: Record<FeatureArea, string>;
  kinds: Record<FeatureKind, string>;
  audiences: Record<Audience, string>;
}

/** Catalog order (the server's order; also the fallback names for older servers). */
export const AREAS: Record<FeatureArea, string> = {
  knowledge: "Knowledge",
  review: "Review",
  security: "Security",
  inbox: "Inbox",
  projects: "Projects",
  people: "People and access",
  connections: "Connections",
  skills: "Skills",
  admin: "Admin",
  mcp: "Claude/MCP",
  platform: "Platform",
};
export const AREA_ORDER = Object.keys(AREAS) as FeatureArea[];

export const KINDS: Record<FeatureKind, string> = { new: "New", improved: "Improved", fixed: "Fixed" };
export const AUDIENCES: Record<Audience, string> = { everyone: "Everyone", admins: "Administrators", project_admins: "Project admins" };

/** Badge tones per kind. */
export const KIND_TONE: Record<FeatureKind, "accent" | "success" | "warning"> = { new: "accent", improved: "success", fixed: "warning" };

/** "1.0.0 (abc1234)" or "1.0.0". */
export function versionText(b: Pick<BuildInfo, "version" | "commit"> | null | undefined): string {
  if (!b) return "";
  return b.commit ? `${b.version} (${b.commit.slice(0, 7)})` : b.version;
}

/** "About Thaliyola: version 1.0.0 (abc1234)". */
export const aboutLine = (b: BuildInfo | null | undefined) => (b ? `About Thaliyola: version ${versionText(b)}` : "About Thaliyola");

/** "12 new features", "5 new features, 3 improvements and 1 fix" (as the release notification says it). */
export function countsText(c: Pick<ReleaseCounts, "new" | "improved" | "fixed">): string {
  const parts = [
    c.new ? `${c.new} new feature${c.new === 1 ? "" : "s"}` : "",
    c.improved ? `${c.improved} improvement${c.improved === 1 ? "" : "s"}` : "",
    c.fixed ? `${c.fixed} fix${c.fixed === 1 ? "" : "es"}` : "",
  ].filter(Boolean);
  if (!parts.length) return "No features yet";
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** Features grouped by area, areas in catalog order, each keeping its own order. */
export function byArea<T extends Pick<Feature, "area">>(features: T[]): { area: FeatureArea; items: T[] }[] {
  return AREA_ORDER.map((area) => ({ area, items: features.filter((f) => f.area === area) })).filter((g) => g.items.length > 0);
}

/** "12 Nov 2026" for a YYYY-MM-DD date; "" for none. */
export function releaseDate(d: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? "");
  if (!m) return "";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`;
}

/** Version order, newest first ("1.10.0" before "1.9.0"). */
export function compareVersionsDesc(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** The next version after `v` for a "New release" form: the next minor. */
export function nextMinor(v: string | null | undefined): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? `${m[1]}.${Number(m[2]) + 1}.0` : "1.0.0";
}

/** Valid version text for the form (the server checks again). */
export const isVersion = (v: string) => /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(v.trim());

/** "#/admin/audit" (and "/admin/audit", "admin/audit") for the form; "" stays empty. */
export function normalizeRoute(v: string): string {
  const s = v.trim();
  if (!s) return "";
  return s.startsWith("#/") ? s : `#/${s.replace(/^#?\/*/, "")}`;
}

/** "a, b , c" → ["a", "b", "c"]. */
export const parseTags = (v: string) =>
  v
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

/** The newest published release in a list (lists come newest first). */
export const latestPublished = (releases: Release[]) => releases.find((r) => r.status === "published") ?? null;

/** Features of a list matching every word (title, description, how-to, tags, area name). */
export function matchFeatures<T extends Pick<Feature, "title" | "description" | "how_to" | "tags" | "area_name">>(features: T[], q: string): T[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return features;
  return features.filter((f) => {
    const hay = `${f.title} ${f.description} ${f.how_to} ${f.tags.join(" ")} ${f.area_name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

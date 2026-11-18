import { describe, expect, it } from "vitest";
import { navIdForRoute } from "../src/components/nav";
import { can } from "../src/components/permissions";
import {
  aboutLine,
  byArea,
  compareVersionsDesc,
  countsText,
  isVersion,
  latestPublished,
  matchFeatures,
  nextMinor,
  normalizeRoute,
  parseTags,
  releaseDate,
  versionText,
  type Release,
} from "../src/components/releases";

/** What's new: the version line, counts, grouping and search the page and the Help menu share. */

describe("version text", () => {
  it("shows the version and the short commit", () => {
    expect(versionText({ version: "1.0.0", commit: "abc1234def5678" })).toBe("1.0.0 (abc1234)");
    expect(versionText({ version: "1.0.0", commit: null })).toBe("1.0.0");
    expect(aboutLine({ version: "1.0.0", commit: "abc1234ffff", built_at: null })).toBe("About Thaliyola: version 1.0.0 (abc1234)");
    expect(aboutLine(undefined)).toBe("About Thaliyola");
  });

  it("checks, orders and suggests versions", () => {
    expect(isVersion("1.2.3")).toBe(true);
    expect(isVersion("1.2")).toBe(false);
    expect(isVersion("01.2.3")).toBe(false);
    expect(["1.9.0", "1.10.0", "0.9.0"].sort(compareVersionsDesc)).toEqual(["1.10.0", "1.9.0", "0.9.0"]);
    expect(nextMinor("1.0.0")).toBe("1.1.0");
    expect(nextMinor("1.4.2")).toBe("1.5.0");
    expect(nextMinor(undefined)).toBe("1.0.0");
  });
});

describe("release notes", () => {
  it("says what a release brought, like the notification", () => {
    expect(countsText({ new: 12, improved: 0, fixed: 0 })).toBe("12 new features");
    expect(countsText({ new: 1, improved: 3, fixed: 1 })).toBe("1 new feature, 3 improvements and 1 fix");
    expect(countsText({ new: 0, improved: 0, fixed: 2 })).toBe("2 fixes");
    expect(countsText({ new: 0, improved: 0, fixed: 0 })).toBe("No features yet");
  });

  it("formats dates, routes and tags", () => {
    expect(releaseDate("2026-11-12")).toBe("12 Nov 2026");
    expect(releaseDate(null)).toBe("");
    expect(normalizeRoute("admin/audit")).toBe("#/admin/audit");
    expect(normalizeRoute("/admin/audit")).toBe("#/admin/audit");
    expect(normalizeRoute("#/admin/audit")).toBe("#/admin/audit");
    expect(normalizeRoute("  ")).toBe("");
    expect(parseTags("audit, tokens , ,admin")).toEqual(["audit", "tokens", "admin"]);
  });

  it("groups features by area in catalog order and searches every word", () => {
    const f = (title: string, area: "admin" | "knowledge" | "mcp", how_to = "") => ({ title, area, area_name: area, description: "", how_to, tags: [] as string[] });
    const features = [f("Audit log", "admin", "Open #/admin/audit"), f("Search", "knowledge"), f("whats_new", "mcp"), f("Saved views", "knowledge")];
    expect(byArea(features).map((g) => [g.area, g.items.map((x) => x.title)])).toEqual([
      ["knowledge", ["Search", "Saved views"]],
      ["admin", ["Audit log"]],
      ["mcp", ["whats_new"]],
    ]);
    expect(matchFeatures(features, "audit OPEN").map((x) => x.title)).toEqual(["Audit log"]);
    expect(matchFeatures(features, "")).toHaveLength(4);
    expect(matchFeatures(features, "nothing here")).toHaveLength(0);
  });

  it("finds the newest published release, skipping drafts", () => {
    const r = (version: string, status: "draft" | "published") => ({ version, status }) as Release;
    expect(latestPublished([r("1.1.0", "draft"), r("1.0.0", "published"), r("0.9.0", "published")])?.version).toBe("1.0.0");
    expect(latestPublished([r("1.0.0", "draft")])).toBeNull();
  });
});

describe("who writes release notes", () => {
  it("Administrators and Manage releases only", () => {
    expect(can.manageReleases({ admin: true, permissions: [] })).toBe(true);
    expect(can.manageReleases({ admin: false, permissions: ["manage_releases"] })).toBe(true);
    expect(can.manageReleases({ admin: false, permissions: ["view_metrics"] })).toBe(false);
  });

  it("#/whats-new is the What's new entry", () => {
    expect(navIdForRoute("whats-new")).toBe("whats-new");
    expect(navIdForRoute("whats-new", new URLSearchParams("tab=releases&release=1.0.0"))).toBe("whats-new");
  });
});

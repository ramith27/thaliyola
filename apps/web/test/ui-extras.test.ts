import { describe, expect, it } from "vitest";
import type { ScopeInfo } from "../src/api";
import { filledSections } from "../src/components/guide";
import { filterOptions } from "../src/components/kit/combobox";
import { projectOptions } from "../src/components/kit/form";
import { pickFilters, readableFilters, sameFilters } from "../src/components/saved-views";

const scope = (slug: string, name: string, kind: string, parent: string | null = null) => ({ slug, name, kind, parent }) as unknown as ScopeInfo;
const SCOPES = [
  scope("team", "Team", "team"),
  scope("library", "Library", "library"),
  scope("orders", "Order service", "project"),
  scope("orders-api", "Order API", "project", "orders"),
  scope("payments", "Payments", "project"),
];

describe("searchable project picker", () => {
  it("lists spaces, then projects in tree order with their full path", () => {
    const opts = projectOptions(SCOPES);
    expect(opts.map((o) => [o.group, o.label])).toEqual([
      ["Spaces", "Team"],
      ["Spaces", "Library"],
      ["Projects", "Order service"],
      ["Projects", "Order service › Order API"],
      ["Projects", "Payments"],
    ]);
    expect(projectOptions(SCOPES, { includeSpaces: false, filter: (s) => s.slug !== "payments" }).map((o) => o.value)).toEqual(["orders", "orders-api"]);
  });

  it("filters on every word typed, in the label, hint or keywords", () => {
    const opts = projectOptions(SCOPES);
    expect(filterOptions(opts, "").length).toBe(5);
    expect(filterOptions(opts, "order api").map((o) => o.value)).toEqual(["orders-api"]);
    expect(filterOptions(opts, "ORDER").map((o) => o.value)).toEqual(["orders", "orders-api"]);
    // The short name matches too.
    expect(filterOptions(opts, "orders-api").map((o) => o.value)).toEqual(["orders-api"]);
    expect(filterOptions(opts, "nothing like it")).toEqual([]);
  });
});

describe("saved views", () => {
  it("compare filters ignoring order and empty values", () => {
    expect(sameFilters({ a: "1", b: "2" }, { b: "2", a: "1" })).toBe(true);
    expect(sameFilters({ a: "1", b: "" }, { a: "1" })).toBe(true);
    expect(sameFilters({ a: "1" }, { a: "2" })).toBe(false);
    expect(sameFilters({}, {})).toBe(true);
  });

  it("read only the page's saved keys from the URL", () => {
    const q = new URLSearchParams("tab=x&scope=orders&q=&state=approved");
    expect(pickFilters(q, ["state", "scope", "q", "sort"])).toEqual({ scope: "orders", state: "approved" });
  });

  it("leave out a project or scope the person can no longer read", () => {
    const canRead = (slug: string) => slug === "orders";
    expect(readableFilters({ scope: "orders", state: "pending" }, canRead)).toEqual({ filters: { scope: "orders", state: "pending" }, dropped: [] });
    expect(readableFilters({ scope: "payments", state: "pending", q: "refund" }, canRead)).toEqual({ filters: { state: "pending", q: "refund" }, dropped: ["scope"] });
    expect(readableFilters({ project: "gone", severity: "critical" }, canRead)).toEqual({ filters: { severity: "critical" }, dropped: ["project"] });
  });
});

describe("writing guide", () => {
  it("ticks only sections with text under them (hints don't count)", () => {
    const md = "## Trigger\n\nThe alert.\n\n## Diagnosis steps\n\n<!-- Hint: Numbered checks -->\n\n## Fix\n\n### Step one\nRestart.\n";
    expect([...filledSections(md)].sort()).toEqual(["fix", "trigger"]);
    expect(filledSections("No sections here").size).toBe(0);
  });
});

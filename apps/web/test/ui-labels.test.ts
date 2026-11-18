import { describe, expect, it } from "vitest";
import {
  ARTICLE_TYPES, CATEGORY, FINDING_TYPES, GLOSSARY, OP_LABELS, STATUS, TYPE_LABELS, accessVia, humanize, orgRoleLine, plural, statusMeta, summaryText, typeLabel,
} from "../src/components/labels";

/** SPEC §1.4 plus ADDENDUM-roles §4.2: every status value the UI must label. */
const EXPECTED_STATUS: Record<string, string[]> = {
  item: ["published", "possibly_stale", "draft", "superseded", "rejected", "deleted"],
  proposal: ["pending", "approved", "rejected", "outdated", "redacted", "reviewer_edited"],
  vulnerability: ["open", "acknowledged", "fixed", "accepted", "false_positive"],
  advisory: ["investigating", "affected", "not_affected", "patched", "none"],
  inbox: ["new", "filed", "dismissed", "updated"],
  source: ["ok", "paused", "failing", "never"],
  run: ["running", "done", "noop", "failed"],
  invite: ["open", "accepted", "revoked", "expired"],
  token: ["active", "expiring", "expired", "revoked"],
  user: ["active", "disabled", "pending", "must_change_password", "not_signed_in", "waiting_for_approval"],
  member: ["lead", "member", "builtin", "custom"],
  visibility: ["members", "team"],
  connection: ["ok", "failing", "untested", "paused"],
  schema_change: ["added", "removed", "column_added", "column_removed", "type_changed", "changed"],
};

describe("labels.ts", () => {
  it("rewrites type keys in older proposal summaries and leaves the server's labelled ones alone", () => {
    expect(summaryText("New rca: Webhook retries")).toBe("New root cause analysis: Webhook retries");
    expect(summaryText("New api_contract: Orders API")).toBe("New API contract: Orders API");
    expect(summaryText("New root cause analysis: Webhook retries")).toBe("New root cause analysis: Webhook retries");
    expect(summaryText("New UI component: Button")).toBe("New UI component: Button");
  });

  it("labels and describes all 15 article types and 5 finding types", () => {
    expect(ARTICLE_TYPES).toHaveLength(15);
    expect(FINDING_TYPES).toHaveLength(5);
    for (const t of ARTICLE_TYPES) {
      expect(TYPE_LABELS[t]?.label, t).toBeTruthy();
      expect(TYPE_LABELS[t]?.description, t).toBeTruthy();
      expect(TYPE_LABELS[t]?.kind).toBe("article");
    }
    for (const t of FINDING_TYPES) {
      expect(TYPE_LABELS[t]?.label, t).toBeTruthy();
      expect(TYPE_LABELS[t]?.description, t).toBeTruthy();
      expect(TYPE_LABELS[t]?.kind).toBe("finding");
    }
    expect(typeLabel("rca")).toBe("Root cause analysis");
    expect(typeLabel("api_contract")).toBe("API contract");
  });

  it("covers every status value in §1.4 and the addendum", () => {
    for (const [domain, values] of Object.entries(EXPECTED_STATUS)) {
      const map = STATUS[domain as keyof typeof STATUS];
      expect(map, domain).toBeTruthy();
      for (const v of values) {
        expect(map[v]?.label, `${domain}.${v}`).toBeTruthy();
        expect(["neutral", "accent", "success", "warning", "danger"]).toContain(map[v]!.tone);
      }
    }
    expect(statusMeta("item", "possibly_stale")).toMatchObject({ label: "Needs a check", tone: "warning", icon: "clock" });
    expect(statusMeta("proposal", "pending").label).toBe("Waiting for review");
    expect(statusMeta("user", "waiting_for_approval")).toMatchObject({ label: "Waiting for approval", tone: "warning" });
    expect(statusMeta("item", "published").hiddenInLists).toBe(true);
  });

  it("falls back to humanized keys", () => {
    expect(humanize("possibly_stale")).toBe("Possibly stale");
    expect(humanize("known-issue")).toBe("Known issue");
    expect(humanize("")).toBe("");
    expect(humanize(undefined)).toBe("");
    expect(typeLabel("brand_new_type")).toBe("Brand new type");
    expect(typeLabel(null)).toBe("");
    expect(statusMeta("item", "something_else")).toEqual({ label: "Something else", tone: "neutral" });
  });

  it("pluralises correctly", () => {
    expect(plural(1, "proposal")).toBe("1 proposal");
    expect(plural(0, "proposal")).toBe("0 proposals");
    expect(plural(3, "proposal")).toBe("3 proposals");
    expect(plural(2, "person", "people")).toBe("2 people");
    expect(plural(1200, "item")).toBe("1,200 items");
  });

  it("has the review categories and operation words", () => {
    expect(Object.keys(CATEGORY).sort()).toEqual(["edit", "move", "new", "retire", "share"]);
    expect(CATEGORY.retire.label).toBe("Marked outdated");
    expect(OP_LABELS.promote).toBe("Added to article");
  });

  it("uses the roles wording (addendum §4)", () => {
    expect(orgRoleLine({ admin: true, role_names: ["Administrator"] })).toBe("Administrator");
    expect(orgRoleLine({ admin: false, role_names: ["User manager", "Auditor"] })).toBe("User manager, Auditor");
    expect(orgRoleLine({ admin: false })).toBe("Member");
    expect(accessVia("team", { name: "Payments" })).toBe("Through team Payments");
    expect(accessVia("inherited", { project: "Order service v2" })).toBe("From Order service v2 (above)");
    const says = GLOSSARY.map((g) => g.say).join(" ");
    expect(says).toContain("Organisation roles");
    expect(says).toContain("Project admin");
    expect(says).not.toContain("Workspace roles");
    expect(GLOSSARY.some((g) => g.term === "Roles page" && g.say.includes("Roles and access"))).toBe(true);
  });
});

describe("notification icons", () => {
  it("has an icon for every notification kind the server sends", async () => {
    const { readFileSync } = await import("node:fs");
    const { KIND_ICON } = await import("../src/components/notifications");
    const source = readFileSync(new URL("../../server/src/core/notify.ts", import.meta.url), "utf8");
    const union = source.match(/export type NotificationKind =([^;]+);/)![1]!;
    const kinds = [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(kinds).toContain("connection");
    for (const k of kinds) expect(KIND_ICON[k], `icon for ${k}`).toBeTruthy();
  });
});

import { describe, expect, it } from "vitest";
import { CONNECTION_GROUP, CONNECTION_KIND, LINK_SYSTEM, statusMeta } from "../src/components/labels";
import { can, type MeLike, type ScopeLike } from "../src/components/permissions";
import { looksLikeTicketUrl, trackerLine } from "../src/components/tickets";
import { alsoReadsText, pauseLabel, target } from "../src/pages/connections";

/** Jira and Linear tickets on findings and articles: who adds them, and how they read. */

const me = (admin = false): MeLike => ({ admin, permissions: [] });
const scope = (kind: string, permissions: string[]): ScopeLike => ({ kind, can_manage: false, effective_permissions: permissions } as ScopeLike);

describe("who can create and link tickets", () => {
  it("is people who may propose in the entry's project, never in a personal space", () => {
    expect(can.addTickets(scope("project", ["read", "propose"]), me())).toBe(true);
    expect(can.addTickets(scope("team", ["read", "propose"]), me())).toBe(true);
    expect(can.addTickets(scope("project", ["read"]), me())).toBe(false);
    expect(can.addTickets(scope("personal", ["read", "propose"]), me())).toBe(false);
    expect(can.addTickets(undefined, me(true))).toBe(false);
  });
});

describe("ticket labels", () => {
  it("names the trackers and their group, and reads each status category", () => {
    expect(LINK_SYSTEM.jira).toBe("Jira");
    expect(LINK_SYSTEM.linear).toBe("Linear");
    expect(CONNECTION_KIND.jira).toBe("Jira");
    expect(CONNECTION_GROUP.tracker).toBe("Issue trackers");
    expect(statusMeta("ticket", "done")).toMatchObject({ label: "Done", tone: "success" });
    expect(statusMeta("ticket", "in_progress").tone).toBe("accent");
    expect(statusMeta("ticket", "unknown")).toMatchObject({ label: "Status unknown", outline: true });
  });

  it("describes where a new issue goes", () => {
    expect(trackerLine({ id: "1", name: "Ops Jira", kind: "jira", label: "Jira", scope: "billing", scope_name: "Billing", health: "ok", destination: "OPS", site: "acme.atlassian.net" })).toBe("Jira issue in OPS");
    expect(trackerLine({ id: "2", name: "Eng", kind: "linear", label: "Linear", scope: "team", scope_name: "Team", health: "ok", destination: null, site: null })).toBe("Linear issue in the default project");
  });

  it("checks pasted issue addresses before sending them", () => {
    expect(looksLikeTicketUrl("https://acme.atlassian.net/browse/OPS-12")).toBe(true);
    expect(looksLikeTicketUrl("https://acme.atlassian.net/jira/software/projects/OPS/boards/1?selectedIssue=OPS-7")).toBe(true);
    expect(looksLikeTicketUrl("https://linear.app/acme/issue/ENG-42/fix-it")).toBe(true);
    expect(looksLikeTicketUrl("https://app.clickup.com/t/86a1b2c3d")).toBe(true);
    expect(looksLikeTicketUrl("https://app.clickup.com/t/9000/ENG-42")).toBe(true);
    expect(looksLikeTicketUrl("https://app.clickup.com/9000/v/li/901")).toBe(false);
    expect(looksLikeTicketUrl("https://github.com/acme/shop/issues/1")).toBe(false);
    expect(looksLikeTicketUrl("http://acme.atlassian.net/browse/OPS-12")).toBe(false);
  });

  it("pauses a tracker's scheduled checks", () => {
    expect(pauseLabel({ scheduled: true, group: "tracker", enabled: true })).toBe("Pause checks");
  });
});

describe("tracker connection rows", () => {
  it("say where new issues go, never the token", () => {
    const row = (kind: string, config: Record<string, string>) => target({ kind, config } as Parameters<typeof target>[0]);
    expect(row("jira", { site_url: "https://acme.atlassian.net", email: "bot@acme.com", project_key: "OPS", issue_type: "Bug" })).toBe("OPS · Bug on acme.atlassian.net");
    expect(row("linear", { team: "ENG" })).toBe("Team ENG");
  });

  it("say which other projects or teams a tracker reads", () => {
    expect(alsoReadsText({ kind: "jira", options: {} })).toBeNull();
    expect(alsoReadsText({ kind: "jira", options: { allowed_projects: ["HR", "SEC"] } })).toBe("Also reads HR, SEC");
    expect(alsoReadsText({ kind: "linear", options: { allowed_teams: ["*"] } })).toBe("Reads every team's issues");
    expect(alsoReadsText({ kind: "http_api", options: { allowed_projects: ["HR"] } })).toBeNull();
  });
});

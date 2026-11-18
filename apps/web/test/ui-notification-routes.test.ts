import { describe, expect, it } from "vitest";
import { can, type MeLike, type ScopeLike } from "../src/components/permissions";
import { pauseLabel } from "../src/pages/connections";
import { digestWhen, kindsText } from "../src/pages/notification-routes";
import { settingsTabs } from "../src/pages/settings";

/** Slack and Trello notification routes: who reaches them, and what the rows say. */

const member = (permissions: string[] = []): MeLike => ({ admin: false, permissions });
const project = (manageSettings: boolean): ScopeLike => ({ kind: "project", can_manage: false, can_manage_settings: manageSettings });

describe("who can set up notification routes", () => {
  it("shows a project's Notifications tab to people with Manage settings only", () => {
    const admin = project(true);
    const writer = project(false);
    expect(settingsTabs(!!can.manageSettings(admin), true)).toContain("notifications");
    expect(settingsTabs(!!can.manageSettings(writer), true)).toEqual(["access"]);
    // The Team space has no project routes: team-wide routes live under Admin › Notifications.
    expect(settingsTabs(true, false)).not.toContain("notifications");
  });

  it("gives Admin › Notifications to Administrators and people who manage all projects", () => {
    expect(can.teamNotifications({ admin: true, permissions: [] })).toBe(true);
    expect(can.teamNotifications(member(["manage_all_projects"]))).toBe(true);
    expect(can.teamNotifications(member(["read_all_projects"]))).toBe(false);
    expect(can.teamNotifications(member())).toBe(false);
  });
});

describe("pausing a connection", () => {
  it("pauses checks of scheduled kinds and notifications of Slack and Trello", () => {
    expect(pauseLabel({ scheduled: true, group: "database", enabled: true })).toBe("Pause checks");
    expect(pauseLabel({ scheduled: true, group: "database", enabled: false })).toBe("Resume checks");
    expect(pauseLabel({ scheduled: false, group: "notify", enabled: true })).toBe("Pause notifications");
    expect(pauseLabel({ scheduled: false, group: "notify", enabled: false })).toBe("Resume notifications");
    expect(pauseLabel({ scheduled: false, group: "api", enabled: true })).toBeNull();
  });
});

describe("route rows", () => {
  it("say when the digest goes out in a few words", () => {
    expect(digestWhen("daily", { hour: 8, day: 1 })).toBe("Daily digest, 08:00");
    expect(digestWhen("weekly", { hour: 17, day: 5 })).toBe("Weekly digest, Fridays 17:00");
    expect(digestWhen("weekly", null)).toBe("No digest");
    expect(digestWhen("off", { hour: 8, day: 1 })).toBe("No digest");
  });

  it("name the kinds a route gets, three at most", () => {
    expect(kindsText([])).toBe("No notifications, digest only");
    expect(kindsText(["review", "stale"])).toBe("Reviews, Needs re-verifying");
    expect(kindsText(["review", "decided", "comment", "change", "security"])).toBe("Reviews, Decisions, Comments and 2 more");
  });
});

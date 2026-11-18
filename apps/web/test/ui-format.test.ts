import { describe, expect, it } from "vitest";
import { formatRelativeTime, formatTimestamp, humanizeError } from "../src/components/labels";
import { parseHash, patchQueryState, readQueryState, routePath, serializeQuery, shortcutApplies } from "../src/hooks";

describe("relative time (SPEC §1.2 rule 10)", () => {
  const now = new Date(2026, 10, 5, 14, 3, 0); // 5 Nov 2026, 14:03 local
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const MIN = 60_000;
  const HOUR = 60 * MIN;

  it("buckets recent times", () => {
    expect(formatRelativeTime(ago(10_000), now)).toBe("just now");
    expect(formatRelativeTime(ago(12 * MIN), now)).toBe("12 min ago");
    expect(formatRelativeTime(ago(59 * MIN), now)).toBe("59 min ago");
    expect(formatRelativeTime(ago(HOUR), now)).toBe("1 hour ago");
    expect(formatRelativeTime(ago(3 * HOUR), now)).toBe("3 hours ago");
  });

  it("uses calendar days within a week", () => {
    expect(formatRelativeTime(new Date(2026, 10, 4, 9, 0), now)).toBe("yesterday");
    expect(formatRelativeTime(new Date(2026, 10, 2, 18, 0), now)).toBe("3 days ago");
    expect(formatRelativeTime(new Date(2026, 9, 30, 12, 0), now)).toBe("6 days ago");
  });

  it("switches to absolute dates after 7 days", () => {
    expect(formatRelativeTime(new Date(2026, 9, 29, 12, 0), now)).toBe("29 Oct");
    expect(formatRelativeTime(new Date(2025, 10, 4, 12, 0), now)).toBe("4 Nov 2025");
  });

  it("handles missing and invalid dates", () => {
    expect(formatRelativeTime(null, now)).toBe("Never");
    expect(formatRelativeTime("not a date", now, "No activity")).toBe("No activity");
    expect(formatTimestamp(now)).toBe("5 Nov 2026, 14:03");
    expect(formatTimestamp(undefined)).toBe("");
  });
});

describe("humanizeError (SPEC §5.8)", () => {
  const api = (status: number, message: string) => Object.assign(new Error(message), { status });

  it("maps HTTP statuses to calm messages and keeps the raw text as detail", () => {
    expect(humanizeError(api(401, "unauthorized"))).toEqual({ title: "Your session has ended. Sign in again.", detail: "unauthorized" });
    expect(humanizeError(api(403, "forbidden")).title).toBe("You don't have permission to do this.");
    expect(humanizeError(api(404, "not found")).title).toBe("We couldn't find this. It may have been moved or deleted.");
    expect(humanizeError(api(409, "conflict")).title).toBe("Someone changed this while you were working.");
    expect(humanizeError(api(413, "too large")).title).toBe("That file is too large.");
    expect(humanizeError(api(429, "slow down")).title).toBe("Too many requests. Wait a moment and try again.");
    expect(humanizeError(api(502, "bad gateway")).title).toBe("Something went wrong on the server. Try again in a moment.");
  });

  it("sentence-cases validation messages", () => {
    expect(humanizeError(api(400, "title is required")).title).toBe("Title is required.");
    expect(humanizeError(api(422, "Name already taken.")).title).toBe("Name already taken.");
  });

  it("recognises network failures", () => {
    expect(humanizeError(new TypeError("Failed to fetch")).title).toBe("Thaliyola isn't responding. Check your connection and try again.");
    expect(humanizeError("something odd").title).toBe("Something odd.");
    expect(humanizeError(null).title).toBe("Something went wrong. Try again.");
  });
});

describe("URL state helpers (SPEC §5.16)", () => {
  it("parses hashes like router.ts", () => {
    const r = parseHash("#/review/abc%20d?tab=check&scope=orders");
    expect(r.path).toEqual(["review", "abc d"]);
    expect(r.query.get("tab")).toBe("check");
    expect(parseHash("").path).toEqual([]);
    expect(routePath(r)).toBe("/review/abc%20d");
  });

  it("merges the query over defaults", () => {
    const q = new URLSearchParams("state=approved");
    expect(readQueryState(q, { state: "pending", sort: "oldest" })).toEqual({ state: "approved", sort: "oldest" });
  });

  it("drops empty and default values when patching, and keeps other keys", () => {
    const q = new URLSearchParams("state=approved&scope=orders&q=refund");
    expect(patchQueryState(q, { state: "pending", q: "" }, { state: "pending" })).toEqual({ scope: "orders" });
    expect(patchQueryState(q, { type: "rca" })).toEqual({ state: "approved", scope: "orders", q: "refund", type: "rca" });
    expect(patchQueryState(new URLSearchParams("a=1"), { a: undefined })).toEqual({});
  });

  it("serialises in a stable order", () => {
    expect(serializeQuery({ b: "2", a: "1", c: undefined, d: "" })).toBe("a=1&b=2");
  });
});

describe("shortcut rules (SPEC §2.10)", () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });
  const idle = { typing: false, activates: false };

  it("ignores single keys while typing and when switched off", () => {
    expect(shortcutApplies("j", key("j"), idle, true)).toBe(true);
    expect(shortcutApplies("j", key("j"), { typing: true, activates: false }, true)).toBe(false);
    expect(shortcutApplies("j", key("j"), idle, false)).toBe(false);
    expect(shortcutApplies("j", key("j", { metaKey: true }), idle, true)).toBe(false);
  });

  it("never takes Enter or Space from a focused button or link", () => {
    expect(shortcutApplies("Enter", key("Enter"), { typing: false, activates: true }, true)).toBe(false);
    expect(shortcutApplies("Enter", key("Enter"), idle, true)).toBe(true);
  });

  it("lets mod combos fire inside fields", () => {
    expect(shortcutApplies("mod+s", key("s", { metaKey: true }), { typing: true, activates: false }, false)).toBe(true);
    expect(shortcutApplies("mod+s", key("s", { ctrlKey: true }), idle, true)).toBe(true);
    expect(shortcutApplies("mod+s", key("s"), idle, true)).toBe(false);
  });

  it("matches Shift+letter written as the capital", () => {
    expect(shortcutApplies("A", key("A"), idle, true)).toBe(true);
    expect(shortcutApplies("A", key("a"), idle, true)).toBe(false);
  });
});

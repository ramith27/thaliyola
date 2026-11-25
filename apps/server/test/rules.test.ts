import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminAddComponent, adminCreateProject, adminSetMember } from "../src/core/admin.js";
import { insertArticle } from "../src/core/bootstrap.js";
import { checkPath } from "../src/core/coordination.js";
import { getProjectContext } from "../src/core/projects.js";
import { globToRegExp, listRules, ruleEvents, setRule } from "../src/core/rules.js";
import { registerSession } from "../src/core/sessions.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
const as = (email: string) => ctxFor(db, { email });
const REPO = "git@github.com:acme/pay.git";
let runbook: string;

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await as("admin@example.com");
  await adminCreateProject(a, { slug: "pay", name: "Payments" });
  await adminAddComponent(a, "pay", { slug: "api", kind: "backend", repo_url: REPO });
  await adminSetMember(a, "pay", "owner@example.com", "owner");
  await adminSetMember(a, "pay", "dev@example.com", "writer");
  const scope = (await db.query("SELECT id FROM scopes WHERE slug = 'pay'")).rows[0].id;
  runbook = await insertArticle(db, { scopeId: scope, type: "runbook", title: "Changing money code", body: "## Steps\nPair with payments on-call." });
  await registerSession(await as("dev@example.com"), { repo: REPO, project: "pay", component: "api", client: "claude-code", client_session_id: "s1" });
});
afterAll(() => db.end());

const check = async (path: string) => (await checkPath(await as("dev@example.com"), { client: "claude-code", client_session_id: "s1", path })).rules;

describe("path globs", () => {
  it("match like a repository path", () => {
    expect(globToRegExp("src/payments/**").test("src/payments/a/b.ts")).toBe(true);
    expect(globToRegExp("src/payments/**").test("src/paymentsx/a.ts")).toBe(false);
    expect(globToRegExp("migrations/*.sql").test("migrations/001.sql")).toBe(true);
    expect(globToRegExp("migrations/*.sql").test("migrations/old/001.sql")).toBe(false);
    expect(globToRegExp("**/secrets.ts").test("a/b/secrets.ts")).toBe(true);
    expect(globToRegExp("**/secrets.ts").test("secrets.ts")).toBe(true);
    expect(globToRegExp("infra/").test("infra/main.tf")).toBe(true);
    expect(globToRegExp("Makefile").test("Makefile")).toBe(true);
  });
});

describe("rules for agents", () => {
  it("are set by Project admins, read_first needs a page", async () => {
    await expect(setRule(await as("dev@example.com"), { project: "pay", kind: "heads_up", paths: ["src/**"], message: "x" })).rejects.toThrow();
    const owner = await as("owner@example.com");
    await expect(setRule(owner, { project: "pay", kind: "read_first", paths: ["src/money/**"], message: "Money code." })).rejects.toThrow(/article_id/);
    await expect(setRule(owner, { project: "pay", kind: "heads_up", paths: ["../etc/passwd"], message: "x" })).rejects.toThrow(/inside the repository/);
    await setRule(owner, { project: "pay", kind: "read_first", paths: ["src/money/**"], article_id: runbook, message: "Money code moves real money." });
    await setRule(owner, { project: "pay", kind: "never_edit", paths: ["migrations/*.sql"], message: "Migrations are generated; change the schema file." });
    await setRule(owner, { project: "pay", kind: "heads_up", paths: ["src/money/fx.ts"], message: "FX rates come from treasury; ping #treasury." });
    expect((await listRules(await as("dev@example.com"), "pay")).rules).toHaveLength(3);
  });

  it("stop the first edit until the page is read, ask the person every time, and tell Claude", async () => {
    const first = await check("src/money/charge.ts");
    expect(first).toEqual([expect.objectContaining({ action: "stop", kind: "read_first", text: expect.stringMatching(/Read "Changing money code" first \(get_article .+\)\. Then make the edit again\./) })]);
    expect((await check("src/money/charge.ts"))[0]).toMatchObject({ action: "tell" });
    const fx = await check("src/money/fx.ts");
    expect(fx.map((r) => r.action).sort()).toEqual(["tell", "tell"]);
    expect((await check("migrations/002.sql"))[0]).toMatchObject({ action: "ask", text: expect.stringMatching(/isn't edited by agents/) });
    expect((await check("migrations/002.sql"))[0]).toMatchObject({ action: "ask" });
    expect(await check("README.md")).toEqual([]);
    const events = (await ruleEvents(await as("owner@example.com"), "pay")).events.map((e: { outcome: string }) => e.outcome);
    expect(events.filter((o: string) => o === "stopped")).toHaveLength(1);
    expect(events.filter((o: string) => o === "asked")).toHaveLength(2);
    await expect(ruleEvents(await as("dev@example.com"), "pay")).rejects.toThrow();
  });

  it("show in the project context, so agents know before they start", async () => {
    const c = await getProjectContext(await as("dev@example.com"), "pay", "api");
    expect(c.rules.map((r) => r.kind).sort()).toEqual(["heads_up", "never_edit", "read_first"]);
    expect(c.rules.find((r) => r.kind === "read_first")!.read_first).toEqual({ id: runbook, title: "Changing money code" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addPerson, findPeople, upsertUser } from "../src/core/users.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  ({ db } = await freshDb());
  await ctxFor(db, { email: "priya.raman@example.com" });
  await db.query("UPDATE users SET display_name = 'Priya Raman' WHERE email = 'priya.raman@example.com'");
  await addPerson(await ctxFor(db, { email: "admin@example.com" }), { email: "prakash@example.com" });
  await upsertUser(db, { subject: "dev:pending.pat@example.com", email: "pending.pat@example.com", kind: "human" }, { approval: true });
  await ctxFor(db, { email: "probe-bot@example.com", service: true });
});
afterAll(() => db.end());

describe("finding people to add", () => {
  it("matches names and emails of active people, including those added ahead of sign-in", async () => {
    const me = await ctxFor(db, { email: "lead@example.com" });
    const found = await findPeople(me, "pr");
    const emails = found.map((p) => p.email);
    expect(emails).toEqual(expect.arrayContaining(["priya.raman@example.com", "prakash@example.com"]));
    expect(emails).not.toContain("probe-bot@example.com");
    expect(found.find((p) => p.email === "prakash@example.com")?.pending).toBe(true);
    expect((await findPeople(me, "raman")).map((p) => p.name)).toContain("Priya Raman");
    // Not people waiting for approval, and wildcards are taken literally.
    expect((await findPeople(me, "pending.pat")).length).toBe(0);
    expect((await findPeople(me, "%")).length).toBe(0);
  });

  it("is for people, not service identities", async () => {
    await expect(findPeople(await ctxFor(db, { email: "probe-bot@example.com", service: true }), "")).rejects.toThrow(/only people/);
  });
});

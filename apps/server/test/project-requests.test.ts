import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveProjectRequest, createOrRequestProject, declineProjectRequest, listProjectRequests } from "../src/core/project-requests.js";
import { flushDeliveries } from "../src/core/notify.js";
import { resolveRepo } from "../src/core/scopes.js";
import { listAccess } from "../src/core/teams.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
beforeAll(async () => {
  ({ db } = await freshDb());
});
afterAll(() => db.end());

const admin = () => ctxFor(db, { email: "admin@example.com" });

describe("projects created by agents", () => {
  it("creates the project at once for an admin's session, with its repositories, and makes them owner", async () => {
    const res = await createOrRequestProject(await admin(), {
      slug: "quilleaf",
      name: "Quilleaf",
      description: "Expense tracker from bank SMS",
      repos: [
        { slug: "android", kind: "mobile", repo_url: "git@github.com:acme/quilleaf-android.git" },
        { slug: "web", kind: "frontend", repo_url: "https://github.com/acme/quilleaf-web" },
      ],
    });
    expect(res).toMatchObject({ status: "created", project: "quilleaf", repositories: 2 });
    expect(await resolveRepo(db, "https://github.com/acme/quilleaf-android")).toEqual({ project: "quilleaf", component: "android" });
    expect((await listAccess(await admin(), "quilleaf")).people).toEqual([expect.objectContaining({ email: "admin@example.com", role: "owner" })]);
    await expect(createOrRequestProject(await admin(), { slug: "quilleaf", name: "Again" })).rejects.toThrow(/already exists/);
  });

  it("files a request for anyone else, which an admin approves (requester owns it) or declines", async () => {
    const dev = await ctxFor(db, { email: "dev@example.com" });
    const req = await createOrRequestProject(dev, { slug: "inkwell", name: "Inkwell", repos: [{ slug: "api", kind: "backend" }], reason: "New service" });
    expect(req.status).toBe("requested");
    expect((await createOrRequestProject(dev, { slug: "inkwell", name: "Inkwell" })).status).toBe("already_requested");
    await flushDeliveries();
    const note = await db.query("SELECT n.title FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'admin@example.com' AND n.title LIKE 'New project requested%'");
    expect(note.rowCount).toBe(1);
    expect((await listProjectRequests(await admin())).map((r: { slug: string }) => r.slug)).toEqual(["inkwell"]);
    await expect(approveProjectRequest(dev, (req as { request_id: string }).request_id)).rejects.toThrow(/only admins/);

    await approveProjectRequest(await admin(), (req as { request_id: string }).request_id);
    const access = await listAccess(await admin(), "inkwell");
    expect(access.people.map((p: { email: string }) => p.email).sort()).toEqual(["admin@example.com", "dev@example.com"]);
    expect((await listProjectRequests(await admin())).length).toBe(0);

    const other = await createOrRequestProject(dev, { slug: "scratch", name: "Scratch" });
    await expect(declineProjectRequest(await admin(), (other as { request_id: string }).request_id, "")).rejects.toThrow(/say why/);
    await declineProjectRequest(await admin(), (other as { request_id: string }).request_id, "Use the inkwell project");
    expect((await listProjectRequests(dev)).find((r: { slug: string }) => r.slug === "scratch")).toMatchObject({ state: "declined", decision_note: "Use the inkwell project" });
  });
});

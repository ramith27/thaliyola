import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import { acceptInvitation, createInvitation } from "../src/auth/invitations.js";
import { resolvePerson } from "../src/core/access.js";
import { changeMemberRoles } from "../src/core/admin.js";
import { createActionToken, flushDeliveries } from "../src/core/notify.js";
import { listProjects } from "../src/core/scopes.js";
import { addComment, listComments } from "../src/core/workflow.js";
import { addPerson, cleanName, setMyName, updatePerson, upsertUser } from "../src/core/users.js";
import { proposeFinding } from "../src/core/writes.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { ctxFor, freshDb, TEST_SETTINGS } from "./helpers.js";

/**
 * Names anyone can choose must not let them pass for someone else: not by looking like another name or another
 * person's email, and not by catching access grants meant for someone else.
 */

let db: Db;
let server: Server;
let base: string;
const TOKENS = "admin=admin@example.com,mallory=mallory@example.com,victor=victor@example.com,uma=uma@example.com";
const clients: Record<string, Client> = {};
const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints);

beforeAll(async () => {
  ({ db } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator(TOKENS), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const p of ["admin", "mallory", "victor", "uma"]) await as(p);
});
afterAll(async () => {
  for (const c of Object.values(clients)) await c.close();
  await new Promise((r) => server.close(r));
  await db.end();
});

const as = (p: string, extra = {}) => ctxFor(db, { email: p.includes("@") ? p : `${p}@example.com`, ...extra });
const idOf = async (p: string) => (await db.query("SELECT id FROM users WHERE email = $1", [p.includes("@") ? p : `${p}@example.com`])).rows[0].id as string;
const row = async (p: string) =>
  (await db.query("SELECT display_name, name_self_set FROM users WHERE email = $1", [p.includes("@") ? p : `${p}@example.com`])).rows[0] as {
    display_name: string | null;
    name_self_set: boolean;
  };
const memberOf = async (p: string, project: string) =>
  (
    await db.query("SELECT 1 FROM scope_members m JOIN scopes s ON s.id = m.scope_id JOIN users u ON u.id = m.user_id WHERE s.slug = $1 AND u.email = $2", [
      project,
      `${p}@example.com`,
    ])
  ).rowCount;

async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  if (!clients[token]) {
    clients[token] = new Client({ name: "test", version: "0" });
    await clients[token].connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  }
  const result = await clients[token].callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]!.text;
  return result.isError ? { error: text } : JSON.parse(text);
}

describe("what a name may be", () => {
  it("folds fullwidth letters into plain ones", () => {
    expect(cleanName(ch(0xff32) + "ita " + ch(0xff33) + "hah")).toBe("Rita Shah");
  });

  it("refuses characters that render as nothing, alone or inside a name", () => {
    // Hangul filler, braille blank, soft hyphen, Hangul choseong filler, zero-width space, combining grapheme joiner,
    // Mongolian vowel separator, a variation selector from the supplement, a tag character.
    const blanks = [ch(0x3164), ch(0x2800), ch(0xad), ch(0x115f), ch(0x200b), "Rita" + ch(0x34f), "Ri" + ch(0x180e) + "ta", "Rita" + ch(0xe0100), "Rita" + ch(0xe0041)];
    for (const blank of blanks) expect(() => cleanName(blank), JSON.stringify(blank)).toThrow(/control or invisible/);
    expect(() => cleanName("Rita" + ch(0xad) + "Shah")).toThrow(/control or invisible/);
    // Private use and unassigned code points.
    expect(() => cleanName("Rita" + ch(0xe000))).toThrow(/control or invisible/);
    expect(() => cleanName("Rita" + ch(0x0378))).toThrow(/control or invisible/);
  });

  it("needs a letter, and accents on letters", () => {
    expect(() => cleanName("...")).toThrow(/at least one letter/);
    expect(() => cleanName("1234")).toThrow(/at least one letter/);
    expect(() => cleanName(ch(0x301) + "Rita")).toThrow(/accent/);
    expect(() => cleanName("Rita " + ch(0x301))).toThrow(/accent/);
    expect(() => cleanName("Ri" + ch(0x301, 0x302, 0x303, 0x304, 0x305) + "ta")).toThrow(/accent/);
    // Real names keep their accents, joiners and scripts.
    expect(cleanName("Jos" + ch(0x65, 0x301))).toBe("Jos" + ch(0xe9));
    expect(cleanName("Zoë 李")).toBe("Zoë 李");
    expect(cleanName("ര" + ch(0x200d) + "മിത്")).toBe("ര" + ch(0x200d) + "മിത്");
  });
});

describe("names that would pass for someone else", () => {
  it("are refused when they only differ by case, accents, lookalike letters, fullwidth forms or spaces", async () => {
    await setMyName(await as("uma"), "Uma Iyer");
    const mallory = await as("mallory");
    const lookalikes = [
      "uma iyer",
      "Um" + ch(0x430) + " Iyer", // Cyrillic а
      "Uma " + ch(0x406) + "yer", // Cyrillic І for I
      "Uma Iyer" + ch(0x301),
      "Um" + ch(0xe1) + " Iyer",
      ch(0xff35) + "ma Iyer", // fullwidth U
      "Uma lyer", // l for I
      "Uma I.yer",
      "UmaIyer",
    ];
    for (const name of lookalikes) await expect(setMyName(mallory, name), name).rejects.toThrow(/someone else is already called/);
    expect((await row("mallory")).display_name).toBeNull();
  });

  it("are refused when they are how someone else's email starts (how people without a name are shown)", async () => {
    const mallory = await as("mallory");
    for (const name of ["victor", "Victor", "V1ctor", "Vict" + ch(0x43e) + "r"]) {
      await expect(setMyName(mallory, name), name).rejects.toThrow(/how someone else's email address starts/);
    }
    await expect(addPerson(await as("admin"), { email: "newbie@example.com", name: "Victor" })).rejects.toThrow(/email address starts/);
    expect((await tool("mallory", "set_my_name", { name: "victor" })).error).toMatch(/email address starts/);
    // Your own email's start is yours to use.
    expect((await setMyName(await as("victor"), "Victor")).name).toBe("Victor");
    await setMyName(await as("victor"), null);
  });
});

describe("names people chose themselves, in the access tools", () => {
  it("never decide who gets a role: the change is refused and lists who it could be, with emails", async () => {
    const admin = await as("admin");
    // Victor hasn't set a name; Mallory takes his.
    expect((await setMyName(await as("mallory"), "Victor Lee")).name).toBe("Victor Lee");
    expect((await row("mallory")).name_self_set).toBe(true);

    await expect(changeMemberRoles(admin, "order-service", "Victor Lee", { add: ["writer"] })).rejects.toThrow(/chose for themselves.*mallory@example\.com/);
    expect(await memberOf("mallory", "order-service")).toBe(0);
    await expect(resolvePerson(admin, "victor lee", { exact: true })).rejects.toThrow(/pass the email/);
    expect((await tool("admin", "set_user_roles", { email: "Victor Lee", add: ["Auditor"] })).error).toMatch(/chose for themselves/);
    expect((await tool("admin", "set_project_access", { project: "order-service", email: "Victor Lee", add: ["Contributor"] })).error).toMatch(
      /chose for themselves/,
    );
    expect((await tool("admin", "save_team", { team: "platform", name: "Platform" })).error).toBeUndefined();
    expect((await tool("admin", "set_team_membership", { team: "platform", email: "Victor Lee", member: true })).error).toMatch(/chose for themselves/);
    expect(await memberOf("mallory", "order-service")).toBe(0);
    // An email still works.
    expect(await changeMemberRoles(admin, "order-service", "victor@example.com", { add: ["reader"] })).toMatchObject({ email: "victor@example.com" });
  });

  it("can be taken back by someone with Manage people, and a name a manager set identifies the person", async () => {
    const admin = await as("admin");
    await expect(updatePerson(admin, await idOf("victor"), { name: "Victor Lee" })).rejects.toThrow(/already called/);
    await updatePerson(admin, await idOf("mallory"), { name: "Mallory Moss" });
    expect(await row("mallory")).toEqual({ display_name: "Mallory Moss", name_self_set: false });
    await updatePerson(admin, await idOf("victor"), { name: "Victor Lee" });
    expect(await row("victor")).toEqual({ display_name: "Victor Lee", name_self_set: false });
    const res = await changeMemberRoles(admin, "order-service", "Victor Lee", { add: ["writer"] });
    expect(res).toMatchObject({ email: "victor@example.com", name: "Victor Lee" });
    // Renaming yourself makes the name yours again, and no longer an identity.
    await setMyName(await as("victor"), "Victor A. Lee");
    expect(await row("victor")).toEqual({ display_name: "Victor A. Lee", name_self_set: true });
    await expect(changeMemberRoles(admin, "order-service", "Victor A. Lee", { add: ["writer"] })).rejects.toThrow(/chose for themselves/);
  });
});

describe("names on add_person and invitations", () => {
  const tokenOf = (link: string) => link.slice(link.indexOf("#/invite/") + "#/invite/".length);
  const local = { ...TEST_SETTINGS, authMode: "local" as const };

  it("are refused when someone already has them", async () => {
    const admin = await as("admin");
    await expect(addPerson(admin, { email: "dup1@example.com", name: "Uma Iyer" })).rejects.toThrow(/already called/);
    await expect(addPerson(admin, { email: "dup1@example.com", name: "UMA IYER" })).rejects.toThrow(/already called/);
    await expect(createInvitation(db, local, admin.actor.id, { email: "dup2@example.com", name: "uma iyer" })).rejects.toThrow(/already called/);
    expect((await db.query("SELECT 1 FROM users WHERE email = 'dup1@example.com'")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM invitations WHERE email = 'dup2@example.com'")).rowCount).toBe(0);
    // A free name works, and counts as set by a manager.
    await addPerson(admin, { email: "nadia@example.com", name: "Nadia Noor" });
    expect(await row("nadia")).toEqual({ display_name: "Nadia Noor", name_self_set: false });
  });

  it("drop an invitation's name that someone took before it was accepted, and mark a name the invitee typed as theirs", async () => {
    const admin = await as("admin");
    const a = await createInvitation(db, local, admin.actor.id, { email: "quinn@example.com", name: "Quinn Quill" });
    await setMyName(await as("mallory"), "Quinn Quill");
    await acceptInvitation(db, tokenOf(a.link), { password: "a-long-enough-passphrase-9" });
    expect(await row("quinn")).toEqual({ display_name: null, name_self_set: false });

    const b = await createInvitation(db, local, admin.actor.id, { email: "bea@example.com", name: "Bea From Admin" });
    await acceptInvitation(db, tokenOf(b.link), { password: "a-long-enough-passphrase-9", name: "Bea Typed" });
    expect(await row("bea")).toEqual({ display_name: "Bea Typed", name_self_set: true });

    const c = await createInvitation(db, local, admin.actor.id, { email: "cleo@example.com", name: "Cleo From Admin" });
    await acceptInvitation(db, tokenOf(c.link), { password: "a-long-enough-passphrase-9" });
    expect(await row("cleo")).toEqual({ display_name: "Cleo From Admin", name_self_set: false });
  });
});

describe("names from Cloudflare Access", () => {
  it("don't come back after the person cleared their name", async () => {
    const id = { subject: "cf:carol@example.com", email: "carol@example.com", kind: "human" as const, name: "Carol IdP" };
    const carol = await upsertUser(db, id);
    expect(carol.name).toBe("Carol IdP");
    await setMyName({ db, actor: carol, settings: TEST_SETTINGS }, null);
    expect((await upsertUser(db, id)).name).toBeNull();
    // Choosing one again keeps it.
    await setMyName({ db, actor: carol, settings: TEST_SETTINGS }, "Carol C");
    expect((await upsertUser(db, id)).name).toBe("Carol C");
  });
});

describe("what reviewers see", () => {
  it("the author's email next to their name in notifications, the approve page and comments", async () => {
    const admin = await as("admin");
    await as("author@example.com");
    await changeMemberRoles(admin, "order-service", "author@example.com", { set: ["writer"] });
    const author = await as("author@example.com", { project: "order-service" });
    await setMyName(author, "Arun Author");
    const res = await proposeFinding(await as("author@example.com", { project: "order-service" }), {
      type: "rca",
      title: "Who proposed this",
      symptoms: "A name only",
      root_cause: "Anyone can choose one",
      force_new: true,
    });
    await flushDeliveries();
    const note = (
      await db.query("SELECT n.body FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'admin@example.com' AND n.target_id = $1", [res.revision_id])
    ).rows[0];
    expect(note.body).toBe("Arun Author (author@example.com) proposed a change in Order service v2.");

    const token = await createActionToken(db, admin.actor.id, res.revision_id);
    const page = await (await fetch(`${base}/actions/${token}`)).text();
    expect(page).toContain("Proposed by Arun Author (author@example.com) in");

    await addComment(await as("author@example.com"), res.revision_id, "Please look");
    expect((await listComments(admin, res.revision_id))[0]).toMatchObject({ author: "Arun Author", author_name: "Arun Author", author_email: "author@example.com" });
  });
});

describe("list_projects", () => {
  it("returns each Project admin's name next to their email", async () => {
    const admin = await as("admin");
    await setMyName(await as("uma"), "Uma Iyer");
    await changeMemberRoles(admin, "order-service", "uma@example.com", { set: ["owner"] });
    const project = (await listProjects(admin)).find((p) => p.slug === "order-service")!;
    expect(project.project_admin_list).toEqual(expect.arrayContaining([{ email: "uma@example.com", name: "Uma Iyer" }]));
    expect(project.project_admins).toContain("uma@example.com");
    expect((await tool("admin", "list_projects")).projects.find((p: { slug: string }) => p.slug === "order-service").project_admin_list).toEqual(
      expect.arrayContaining([{ email: "uma@example.com", name: "Uma Iyer" }]),
    );
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminSetMember, adminUpdateScope } from "../src/core/admin.js";
import { ask, getEntity, listFavourites, searchEntities, setFavourite } from "../src/core/discover.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];

beforeAll(async () => {
  ({ db, ids } = await freshDb());
});
afterAll(() => db.end());

describe("ask", () => {
  it("answers with the best matching section, quoted from the article", async () => {
    const res = await ask(await ctxFor(db), "how is conversion rate calculated");
    expect(res.best).toMatchObject({ kind: "article", id: ids.cvr, title: "Conversion rate" });
    expect(res.best!.answer_md.length).toBeGreaterThan(10);
    expect(res.best!.answer_md).not.toMatch(/^## /);
  });

  it("answers from a finding with its symptoms, cause and fix", async () => {
    const res = await ask(await ctxFor(db), "payments failing with HTTP 429");
    const best = res.best!;
    expect(best.kind).toBe("finding");
    expect(best.answer_md).toContain("**Root cause.**");
    expect(best.answer_md).toContain("backoff");
  });

  it("returns no answer rather than a bad one", async () => {
    const res = await ask(await ctxFor(db), "zebra xylophone quokka");
    expect(res.best).toBeNull();
  });
});

describe("entities", () => {
  it("finds entities by name or alias, counting readable items", async () => {
    const byAlias = await searchEntities(await ctxFor(db), "cvr");
    expect(byAlias).toEqual([expect.objectContaining({ kind: "metric", name: "Conversion rate", items: 1 })]);
    const byName = await searchEntities(await ctxFor(db), "paym");
    expect(byName[0]).toMatchObject({ name: "Payments gateway" });
  });

  it("lists the items that mention an entity, resolving aliases", async () => {
    const e = await getEntity(await ctxFor(db), "metric", "CVR");
    expect(e.name).toBe("Conversion rate");
    expect(e.items.map((i: { id: string }) => i.id)).toEqual([ids.cvr]);
    await expect(getEntity(await ctxFor(db), "metric", "Nope")).rejects.toThrow(/not found|Nope/);
  });
});

describe("favourites", () => {
  it("pins items and scopes per person and hides ones they can no longer read", async () => {
    const me = await ctxFor(db, { email: "fan@example.com" });
    await setFavourite(me, ids.runbook, true);
    await setFavourite(me, ids.project, true);
    await setFavourite(me, ids.runbook, true); // idempotent
    expect((await listFavourites(me)).map((f: { kind: string; title: string }) => [f.kind, f.title])).toEqual([
      ["article", "Checkout error-rate alert"],
      ["scope", "Order service v2"],
    ]);
    expect(await listFavourites(await ctxFor(db, { email: "someone-else@example.com" }))).toEqual([]);

    // The project becomes members-only and the fan is not a member.
    const admin = await ctxFor(db, { email: "admin@example.com" });
    await adminSetMember(admin, "order-service", "admin@example.com", "owner");
    await adminUpdateScope(admin, "order-service", { visibility: "members" });
    const fresh = await ctxFor(db, { email: "fan@example.com" }); // readable scopes are cached per request
    expect((await listFavourites(fresh)).map((f: { kind: string }) => f.kind)).toEqual(["article"]);
    await expect(setFavourite(fresh, ids.overview, true)).rejects.toThrow(/not found/);
    await adminUpdateScope(admin, "order-service", { visibility: "team" });

    await setFavourite(me, ids.runbook, false);
    expect((await listFavourites(await ctxFor(db, { email: "fan@example.com" }))).map((f: { kind: string }) => f.kind)).toEqual(["scope"]);
  });
});

describe("search as you type", () => {
  it("matches the last word as a prefix only when asked", async () => {
    const { searchKnowledge } = await import("../src/core/search.js");
    const ctx = await ctxFor(db);
    const typed = await searchKnowledge(ctx, { query: "conv", prefix: true });
    expect(typed.articles.map((a) => a.id)).toContain(ids.cvr);
    const plain = await searchKnowledge(ctx, { query: "conv" });
    expect(plain.articles.map((a) => a.id)).not.toContain(ids.cvr);
    // Punctuation in the typed word can't break the query.
    await expect(searchKnowledge(ctx, { query: "checkout & ' :*|(", prefix: true })).resolves.toBeTruthy();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminCreateProject } from "../src/core/admin.js";
import { architectureDiagram } from "../src/core/architecture.js";
import { insertArticle, relate } from "../src/core/bootstrap.js";
import type { Db } from "../src/db/pool.js";
import { ctxFor, freshDb } from "./helpers.js";

let db: Db;

beforeAll(async () => {
  ({ db } = await freshDb());
  const a = await ctxFor(db, { email: "admin@example.com" });
  await adminCreateProject(a, { slug: "shop", name: "Shop", components: [{ slug: "api", kind: "backend", repo_url: "https://github.com/acme/api" }, { slug: "web", kind: "frontend", repo_url: "https://github.com/acme/web" }] });
  await adminCreateProject(a, { slug: "vault", name: "Vault", visibility: "members", components: [{ slug: "ledger", kind: "backend", repo_url: "https://github.com/acme/ledger" }] });
  const comp = async (slug: string) => (await db.query("SELECT id FROM components WHERE slug = $1", [slug])).rows[0].id;
  const shop = (await db.query("SELECT id FROM scopes WHERE slug = 'shop'")).rows[0].id;
  const cart = await insertArticle(db, { scopeId: shop, type: "api_contract", title: "Cart API", body: "## Interface\nPOST /cart" });
  await relate(db, { kind: "article", id: cart }, "provided_by", { kind: "component", id: await comp("api") });
  await relate(db, { kind: "article", id: cart }, "consumed_by", { kind: "component", id: await comp("web") });
  await relate(db, { kind: "article", id: cart }, "consumed_by", { kind: "component", id: await comp("ledger") });
  const draft = await insertArticle(db, { scopeId: shop, type: "api_contract", title: "Refunds API", body: "## Interface\nPOST /refunds" });
  await relate(db, { kind: "article", id: draft }, "provided_by", { kind: "component", id: await comp("api") });
});
afterAll(() => db.end());

describe("architecture diagram", () => {
  it("draws repositories, who consumes each contract, and hides projects the reader can't see", async () => {
    const d = await architectureDiagram(await ctxFor(db, { email: "reader@example.com" }), "shop");
    expect(d.repositories).toEqual(["api", "web"]);
    expect(d.mermaid).toMatch(/^flowchart LR/);
    expect(d.mermaid).toMatch(/subgraph n\d+\["Shop"\]/);
    expect(d.mermaid).toMatch(/n\d+ -- "Cart API" --> n\d+/);
    expect(d.mermaid).toMatch(/1 repository in projects you can't see/);
    expect(d.mermaid).not.toMatch(/ledger|Vault/);
    // A contract nobody consumes yet hangs off its provider.
    expect(d.mermaid).toMatch(/\[\/"Refunds API"\/\]/);
    const admin = await architectureDiagram(await ctxFor(db, { email: "admin@example.com" }), "shop");
    expect(admin.mermaid).toMatch(/subgraph n\d+\["Vault"\]/);
  });
});

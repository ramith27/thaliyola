import type { RequestContext } from "./context.js";
import { readableScopes } from "./permissions.js";
import { getReadableScope } from "./scopes.js";

/**
 * A project's architecture as a Mermaid diagram, built from what Thaliyola already knows (no code is read and no
 * model draws it): its repositories, the API contracts each provides, which repositories consume them (here and in
 * other projects), the contracts it consumes from elsewhere, and the Library items it uses. A project other people
 * can't read appears as "another project", never by name. Docs runs put it on the architecture page; the project
 * page shows it.
 */

const label = (s: string) => s.replace(/["<>]/g, "'").replace(/\s+/g, " ").slice(0, 60);

interface Comp {
  id: string;
  slug: string;
  kind: string;
  scope_id: string;
  scope_slug: string;
  scope_name: string;
  visible: boolean;
}

export async function architectureDiagram(ctx: RequestContext, project: string) {
  const scope = await getReadableScope(ctx, project);
  const readable = await readableScopes(ctx);
  const canSee = (scopeId: string) => readable === null || readable.includes(scopeId);
  const own = (
    await ctx.db.query<{ id: string; slug: string; kind: string }>("SELECT id, slug, kind FROM components WHERE scope_id = $1 ORDER BY slug", [scope.id])
  ).rows;
  // Contracts touching this project's repositories: provided here or consumed here, with every other end.
  const { rows: links } = await ctx.db.query<{ contract_id: string; contract: string; role: "provided_by" | "consumed_by"; component_id: string; slug: string; kind: string; scope_id: string; scope_slug: string; scope_name: string }>(
    `WITH mine AS (
       SELECT DISTINCT r.from_id AS contract_id FROM relations r
        WHERE r.from_kind = 'article' AND r.to_kind = 'component' AND r.kind IN ('provided_by', 'consumed_by')
          AND r.to_id IN (SELECT id FROM components WHERE scope_id = $1))
     SELECT a.id AS contract_id, a.title AS contract, r.kind AS role, c.id AS component_id, c.slug, c.kind, s.id AS scope_id, s.slug AS scope_slug, s.name AS scope_name
       FROM mine JOIN articles a ON a.id = mine.contract_id AND a.status IN ('published', 'possibly_stale')
       JOIN relations r ON r.from_id = a.id AND r.to_kind = 'component' AND r.kind IN ('provided_by', 'consumed_by')
       JOIN components c ON c.id = r.to_id JOIN scopes s ON s.id = c.scope_id AND s.status = 'active'
      ORDER BY a.title, r.kind`,
    [scope.id],
  );
  const used = (
    await ctx.db.query<{ id: string; title: string; type: string }>(
      `SELECT DISTINCT a.id, a.title, a.type FROM relations r JOIN articles a ON a.id = r.to_id JOIN scopes s ON s.id = a.scope_id
        WHERE r.kind = 'uses' AND s.kind = 'library' AND a.status IN ('published', 'possibly_stale')
          AND (r.from_id = $1 OR r.from_id IN (SELECT id FROM articles WHERE scope_id = $1))
        ORDER BY a.type, a.title LIMIT 8`,
      [scope.id],
    )
  ).rows;

  const comps = new Map<string, Comp>();
  for (const c of own) comps.set(c.id, { ...c, scope_id: scope.id, scope_slug: scope.slug, scope_name: scope.name, visible: true });
  for (const l of links)
    if (!comps.has(l.component_id))
      comps.set(l.component_id, { id: l.component_id, slug: l.slug, kind: l.kind, scope_id: l.scope_id, scope_slug: l.scope_slug, scope_name: l.scope_name, visible: canSee(l.scope_id) });

  const ids = new Map<string, string>();
  const nid = (key: string) => {
    if (!ids.has(key)) ids.set(key, `n${ids.size + 1}`);
    return ids.get(key)!;
  };
  const lines = ["flowchart LR"];
  // This project's repositories, then other projects' (hidden ones grouped as "another project").
  const groups = new Map<string, Comp[]>();
  for (const c of comps.values()) {
    const g = c.scope_id === scope.id ? `self` : c.visible ? c.scope_id : "hidden";
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const hiddenCount = groups.get("hidden")?.length ?? 0;
  for (const [g, list] of groups) {
    const title = g === "self" ? scope.name : g === "hidden" ? "Other projects" : list[0]!.scope_name;
    lines.push(`  subgraph ${nid(`g:${g}`)}["${label(title)}"]`);
    if (g === "hidden") lines.push(`    ${nid("hidden")}["${hiddenCount} repositor${hiddenCount === 1 ? "y" : "ies"} in projects you can't see"]`);
    else for (const c of list) lines.push(`    ${nid(c.id)}["${label(c.slug)}<br/><small>${label(c.kind)}</small>"]`);
    lines.push("  end");
  }
  const node = (componentId: string) => (comps.get(componentId)!.visible ? nid(componentId) : nid("hidden"));
  // Provider → consumer for each contract, labelled with it; a contract nobody consumes yet hangs off its provider.
  const byContract = new Map<string, { title: string; providers: string[]; consumers: string[] }>();
  for (const l of links) {
    const c = byContract.get(l.contract_id) ?? { title: l.contract, providers: [], consumers: [] };
    (l.role === "provided_by" ? c.providers : c.consumers).push(l.component_id);
    byContract.set(l.contract_id, c);
  }
  const edges = new Set<string>();
  for (const [id, c] of byContract) {
    for (const p of c.providers) {
      if (!c.consumers.length) {
        lines.push(`  ${nid(`c:${id}`)}[/"${label(c.title)}"/]`);
        edges.add(`  ${node(p)} -.-> ${nid(`c:${id}`)}`);
      }
      for (const k of c.consumers) edges.add(`  ${node(p)} -- "${label(c.title)}" --> ${node(k)}`);
    }
    // Consumed here, provider unknown: show the contract as a source.
    if (!c.providers.length) {
      lines.push(`  ${nid(`c:${id}`)}[/"${label(c.title)}"/]`);
      for (const k of c.consumers) edges.add(`  ${nid(`c:${id}`)} -.-> ${node(k)}`);
    }
  }
  lines.push(...edges);
  if (used.length) {
    lines.push(`  subgraph ${nid("g:library")}["Library"]`);
    for (const u of used) lines.push(`    ${nid(`u:${u.id}`)}(["${label(u.title)}"])`);
    lines.push("  end");
    const anchor = own[0] ? nid(own[0].id) : null;
    if (anchor) lines.push(`  ${nid("g:library")} -.- ${nid("g:self")}`);
  }
  return {
    project: scope.slug,
    mermaid: lines.join("\n"),
    repositories: own.map((c) => c.slug),
    contracts: [...byContract.values()].length,
    library_items: used.map((u) => ({ id: u.id, title: u.title, type: u.type })),
    note: own.length
      ? "Built from the project's repositories, contracts (provided_by / consumed_by) and Library items it uses. Add or link contracts to fill it in."
      : "This project has no repositories yet: add them in project settings › Repositories.",
  };
}

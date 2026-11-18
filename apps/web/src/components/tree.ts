/**
 * Projects in tree order: each parent followed by its sub-projects (alphabetical at each level), with their depth.
 * A project whose parent isn't in the list (e.g. one the viewer can't read) is shown at the top level.
 */
export function treeOrder<T extends { slug: string; name: string; parent?: string | null }>(items: T[]): (T & { depth: number; children: number })[] {
  const bySlug = new Map(items.map((i) => [i.slug, i]));
  const kids = new Map<string, T[]>();
  const roots: T[] = [];
  for (const i of items) {
    if (i.parent && bySlug.has(i.parent) && i.parent !== i.slug) kids.set(i.parent, [...(kids.get(i.parent) ?? []), i]);
    else roots.push(i);
  }
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const out: (T & { depth: number; children: number })[] = [];
  const seen = new Set<string>();
  const walk = (i: T, depth: number) => {
    if (seen.has(i.slug)) return;
    seen.add(i.slug);
    const children = (kids.get(i.slug) ?? []).sort(byName);
    out.push({ ...i, depth, children: children.length });
    for (const c of children) walk(c, depth + 1);
  };
  for (const r of roots.sort(byName)) walk(r, 0);
  return out;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestContext } from "../core/context.js";
import { buildMcpServer } from "./server.js";

export interface Catalog {
  instructions: string;
  tools: { name: string; title?: string; description: string; readOnly: boolean }[];
  prompts: { name: string; title?: string; description: string; arguments: string[] }[];
}

let cached: Promise<Catalog> | null = null;

/** The tools and prompts the MCP endpoint offers, read through the protocol itself (so it can't drift). */
export function mcpCatalog(ctx: RequestContext): Promise<Catalog> {
  cached ??= (async () => {
    const server = buildMcpServer(ctx);
    const client = new Client({ name: "catalog", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    const { prompts } = await client.listPrompts();
    const catalog: Catalog = {
      instructions: client.getInstructions() ?? "",
      tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description ?? "", readOnly: !!t.annotations?.readOnlyHint })),
      prompts: prompts.map((p) => ({ name: p.name, title: p.title, description: p.description ?? "", arguments: (p.arguments ?? []).map((x) => x.name) })),
    };
    await client.close();
    await server.close();
    return catalog;
  })();
  cached.catch(() => (cached = null));
  return cached;
}

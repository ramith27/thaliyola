/**
 * End-to-end smoke test against a running server with the demo data loaded.
 *
 *   CAIRN_URL=http://localhost:8080 AGENT_TOKEN=dev ADMIN_TOKEN=admin pnpm --filter @cairn/server smoke
 *
 * Plays a backend agent changing a contract, a reviewer approving it, and a
 * frontend agent picking up the change. Exits non-zero on the first failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.env.CAIRN_URL ?? "http://localhost:8080";
const agentToken = process.env.AGENT_TOKEN ?? "dev";
const adminToken = process.env.ADMIN_TOKEN ?? "admin";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n      ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

async function agent(component: string) {
  const client = new Client({ name: `smoke-${component}`, version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", base), {
      requestInit: { headers: { authorization: `Bearer ${agentToken}`, "x-cairn-project": "order-service", "x-cairn-component": component } },
    }),
  );
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { text: string }[])[0]!.text;
      return { isError: !!res.isError, body: (() => { try { return JSON.parse(text); } catch { return text; } })() };
    },
    close: () => client.close(),
  };
}

async function rest(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// 1. Health, auth, UI hosting
check("healthz", (await fetch(new URL("/healthz", base))).ok);
check("MCP rejects missing credentials", (await fetch(new URL("/mcp", base), { method: "POST" })).status === 401);
const ui = await fetch(base);
check("web UI served with CSP", ui.ok && (ui.headers.get("content-security-policy") ?? "").includes("script-src 'self'"));

// 2. Backend agent: cold start, then change the contract
const backend = await agent("backend");
const bctx = await backend.call("get_project_context");
const contract = bctx.body.contracts?.provides?.[0];
check("backend sees the contract it provides", contract?.title === "Orders API v1", bctx.body.contracts);
const search = await backend.call("search_knowledge", { query: "payments failing with 429 during a sale" });
check("search finds the team RCA for a symptom", search.body.findings?.[0]?.title?.includes("rate limit"), search.body.findings);
const article = await backend.call("get_article", { id: contract.id, section: "Errors" });
const edit = await backend.call("propose_article_edit", {
  id: contract.id,
  version: article.body.version,
  section: "Errors",
  text: "409 when the order is already refunded.\n422 when the refund exceeds the order total.",
  summary: "Smoke: POST /orders/{id}/refund can return 422",
});
check("contract edit queued for review", edit.body.status === "pending_review", edit.body);
const stale = await backend.call("propose_article_edit", { id: contract.id, version: article.body.version + 5, text: "x", summary: "x" });
check("stale version refused with current content", stale.isError && String(stale.body.error).includes("Version conflict"), stale.body);

// 3. Reviewer approves over REST; agents cannot
check("agent cannot approve", (await rest(agentToken, "POST", `/api/revisions/${edit.body.revision_id}/approve`)).status === 403);
const approved = await rest(adminToken, "POST", `/api/revisions/${edit.body.revision_id}/approve`);
check("admin approves and a notice is raised", approved.status === 200 && approved.body.impact_notices >= 1, approved.body);

// 4. Frontend agent picks up the change
const frontend = await agent("frontend");
const fctx = await frontend.call("get_project_context");
const notice = fctx.body.open_impact_notices?.find((n: { summary: string }) => n.summary.startsWith("Smoke:"));
check("frontend sees the upstream contract change", !!notice, fctx.body.open_impact_notices);
check("frontend sees shared library design it uses", fctx.body.uses?.some((u: { title: string }) => u.title === "Data table"));
const acked = await frontend.call("ack_notice", { id: notice?.id });
check("frontend acknowledges the notice", acked.body.state === "acked", acked.body);

// 5. Capture a finding: redaction, then the duplicate check
const finding = {
  type: "known_issue",
  title: `Smoke ${Date.now()}: refund dialog double-submits`,
  symptoms: "Clicking Refund twice quickly sends two refund requests. Seen by qa@example.com",
  root_cause: "The button is not disabled while the request is in flight.",
  components: ["frontend"],
};
const proposed = await frontend.call("propose_finding", finding);
check("finding proposed with redaction", proposed.body.status === "pending_review" && proposed.body.redactions?.[0]?.kind === "email", proposed.body);
const dup = await frontend.call("propose_finding", { ...finding, title: "Refund dialog sends two requests" });
check("near-duplicate detected, nothing stored", dup.body.status === "duplicates_found", dup.body);

await backend.close();
await frontend.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);

/**
 * Acceptance sweep: drives every MCP tool and prompt against a live server,
 * the way agents and reviewers use them, and checks the results. It creates
 * its own content (uniquely named), so it runs on any instance, even an empty one.
 *
 *   THALIYOLA_URL=https://thaliyola.example.com \
 *   ADMIN_TOKEN=… WRITER_TOKEN=… OUTSIDER_TOKEN=… \
 *   pnpm --filter @thaliyola/server acceptance
 *
 * ADMIN_TOKEN: an admin (creates projects, approves). WRITER_TOKEN: a normal user.
 * OUTSIDER_TOKEN: a normal user who is not added to the members-only project.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.env.THALIYOLA_URL ?? "http://localhost:8080";
const tokens = { admin: process.env.ADMIN_TOKEN!, writer: process.env.WRITER_TOKEN!, outsider: process.env.OUTSIDER_TOKEN! };
if (!tokens.admin || !tokens.writer || !tokens.outsider) {
  console.error("set ADMIN_TOKEN, WRITER_TOKEN and OUTSIDER_TOKEN");
  process.exit(2);
}
const run = Date.now().toString(36);
const project = `acc-${run}`;
const secret = `acc-secret-${run}`;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let passed = 0;
let failed = 0;
const toolsUsed = new Set<string>();
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `\n      ${JSON.stringify(detail).slice(0, 500)}`}`);
}

async function rest(who: keyof typeof tokens, method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function agent(who: keyof typeof tokens, headers: Record<string, string> = {}) {
  const client = new Client({ name: `acceptance-${who}`, version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { authorization: `Bearer ${tokens[who]}`, ...headers } } }));
  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}) {
      toolsUsed.add(name);
      const res = await client.callTool({ name, arguments: args });
      const content = res.content as { type: string; text?: string; data?: string; mimeType?: string }[];
      let body: any = content[0]?.text;
      try {
        body = JSON.parse(body);
      } catch {
        /* plain text */
      }
      return { isError: !!res.isError, body, content };
    },
  };
}

const approve = async (revisionId: string) => {
  const r = await rest("admin", "POST", `/api/revisions/${revisionId}/approve`);
  if (r.status !== 200) throw new Error(`approve ${revisionId}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

try {
  // ---- Setup by an admin: a team project with backend + frontend, and a members-only project
  check("admin creates project", (await rest("admin", "POST", "/api/projects", { slug: project, name: `Acceptance ${run}`, description: "Checkout rebuild" })).status === 200);
  await rest("admin", "POST", `/api/projects/${project}/components`, { slug: "backend", kind: "backend" });
  await rest("admin", "POST", `/api/projects/${project}/components`, { slug: "frontend", kind: "frontend" });
  await rest("admin", "POST", "/api/projects", { slug: secret, name: `Secret ${run}`, description: "Confidential" });
  check("admin makes a project members-only", (await rest("admin", "PATCH", `/api/scopes/${secret}`, { visibility: "members" })).body?.visibility === "members");
  const writerEmail = (await rest("writer", "GET", "/api/me")).body.email;
  await rest("admin", "PUT", `/api/scopes/${secret}/members`, { email: writerEmail, role: "writer" });

  const designer = await agent("writer");
  const backend = await agent("writer", { "x-thaliyola-project": project, "x-thaliyola-component": "backend" });
  const frontend = await agent("writer", { "x-thaliyola-project": project, "x-thaliyola-component": "frontend" });
  const outsider = await agent("outsider");

  // ---- Discovery and prompts
  const { tools } = await designer.client.listTools();
  check("36 tools listed", tools.length === 36, tools.map((t) => t.name));
  const { prompts } = await designer.client.listPrompts();
  check("4 prompts listed", prompts.length === 4);
  for (const p of prompts) {
    const got = await designer.client.getPrompt({ name: p.name, arguments: p.name === "investigate" ? { symptom: "x" } : p.name === "start-coding" ? { project } : {} });
    check(`prompt ${p.name} renders`, (got.messages[0]?.content as { text: string }).text.length > 100);
  }
  check("list_projects shows the new project", (await designer.call("list_projects")).body.projects.some((p: { slug: string }) => p.slug === project));

  // ---- Shared UI/UX design in the library
  const template = await designer.call("get_article_template", { type: "ui_component" });
  check("get_article_template", template.body.body_md.includes("## Accessibility"));
  const button = await designer.call("create_article", {
    scope: "library",
    type: "ui_component",
    title: `Primary button ${run}`,
    path: "UI components",
    body_md: "## Purpose\nMain call to action.\n\n## States\nDefault, hover, pressed, disabled, loading.\n\n## Accessibility\nVisible focus ring; 44px touch target.",
  });
  check("create_article (library UI component)", button.body.status === "pending_review", button.body);
  await approve(button.body.revision_id);
  const buttonId = button.body.article_id;
  const upload = await designer.call("upload_asset", { target_id: buttonId, filename: "button.png", mime_type: "image/png", data_base64: PNG.toString("base64"), alt_text: "Button states" });
  check("upload_asset (screenshot)", !!upload.body.asset_id, upload.body);
  const asset = await designer.call("get_asset", { id: upload.body.asset_id });
  check("get_asset returns the image", asset.content.some((c) => c.type === "image" && c.data === PNG.toString("base64")));
  check("add_source_link (Figma)", !(await designer.call("add_source_link", { id: buttonId, system: "figma", url: "https://www.figma.com/design/abc/DS?node-id=1-2", label: "Button" })).isError);

  // ---- Backend publishes a contract the frontend consumes
  const contract = await backend.call("create_article", {
    type: "api_contract",
    title: `Payments API ${run}`,
    path: "Contracts",
    body_md: "## Interface\nPOST /payments creates a payment.\n\n## Data shapes\nPayment: id, amount, currency, status.\n\n## Errors\n409 duplicate payment.",
    components: ["backend", "frontend"],
  });
  check("create_article (API contract, default project from header)", contract.body.scope === project, contract.body);
  await approve(contract.body.revision_id);
  const contractId = contract.body.article_id;
  check("link_entries provided_by", !(await backend.call("link_entries", { from: contractId, relation: "provided_by", to: `component:${project}/backend` })).isError);
  check("link_entries consumed_by", !(await backend.call("link_entries", { from: contractId, relation: "consumed_by", to: `component:${project}/frontend` })).isError);

  // ---- Frontend writes a screen spec using the library button and the contract
  const screen = await frontend.call("create_article", {
    type: "screen_spec",
    title: `Checkout screen ${run}`,
    body_md: "## Purpose\nPay for the cart.\n\n## User flow\nReview cart, pay, see confirmation.\n\n## States\nIdle, paying, failed.\n\n## API calls\nPOST /payments",
    components: ["frontend"],
    uses_ids: [buttonId],
  });
  await approve(screen.body.revision_id);
  check("link_entries depends_on", !(await frontend.call("link_entries", { from: screen.body.article_id, relation: "depends_on", to: contractId })).isError);
  const ctx = await frontend.call("get_project_context");
  check("get_project_context: frontend consumes the contract", ctx.body.contracts?.consumes?.some((c: { id: string }) => c.id === contractId), ctx.body.contracts);
  check("get_project_context: uses the library button", ctx.body.uses?.some((u: { id: string }) => u.id === buttonId), ctx.body.uses);

  // ---- Backend changes the contract; frontend is notified
  const current = await backend.call("get_article", { id: contractId, section: "Interface" });
  check("get_article (one section)", current.body.body_md.startsWith("## Interface"));
  const edit = await backend.call("propose_article_edit", {
    id: contractId,
    version: current.body.version,
    section: "Interface",
    text: "POST /payments creates a payment. Requires an Idempotency-Key header.",
    summary: `Payments API ${run}: POST /payments now requires Idempotency-Key`,
  });
  check("propose_article_edit", edit.body.status === "pending_review", edit.body);
  const approved = await approve(edit.body.revision_id);
  check("approval raises an impact notice", approved.impact_notices >= 1, approved);
  const notices = await frontend.call("list_impact_notices");
  const notice = notices.body.notices?.find((n: { summary: string }) => n.summary.includes(run));
  check("list_impact_notices (frontend sees it)", !!notice, notices.body);
  check("ack_notice", (await frontend.call("ack_notice", { id: notice?.id })).body.state === "acked");
  check("backend gets no notice for its own contract", !(await backend.call("list_impact_notices")).body.notices?.some((n: { summary: string }) => n.summary.includes(run)));

  // ---- Capture and reuse an investigation
  const finding = await backend.call("propose_finding", {
    type: "rca",
    title: `Card payments declined at peak ${run}`,
    symptoms: "Card payments fail with HTTP 429 from the payment provider during the evening peak.",
    root_cause: "Retries without backoff exceeded the provider's rate limit.",
    fix: "Exponential backoff with jitter; raise the provider limit before campaigns.",
    entities: [{ kind: "service", name: `Payments gateway ${run}` }],
    source_links: [{ system: "slack", url: "https://example.slack.com/archives/C1/p2" }],
  });
  check("propose_finding", finding.body.status === "pending_review", finding.body);
  await approve(finding.body.revision_id);
  const findingId = finding.body.finding_id;
  const dup = await backend.call("propose_finding", {
    type: "rca",
    title: `Payments declined at peak time ${run}`,
    symptoms: "Card payments fail with HTTP 429 from the payment provider at the evening peak.",
    root_cause: "Retries without backoff exceeded the provider rate limit.",
  });
  check("near-duplicate is caught, nothing stored", dup.body.status === "duplicates_found" && dup.body.duplicates.some((d: { id: string }) => d.id === findingId), dup.body);
  const search = await backend.call("search_knowledge", { query: "card processor throttling us when traffic peaks", scope: "all" });
  check("search_knowledge finds it by meaning", search.body.findings?.some((h: { id: string }) => h.id === findingId), search.body);
  check("verify_entry", (await backend.call("verify_entry", { id: findingId, still_valid: true })).body.status === "verified");

  const leaky = await backend.call("propose_finding", {
    type: "data_gotcha",
    title: `Export uses wrong replica ${run}`,
    symptoms: "Reported by ops@example.com. Export connects with password=Sup3rSecret! to the replica.",
    root_cause: "Hard-coded replica host in the export job.",
    force_new: true,
  });
  const leakyStored = await backend.call("get_finding", { id: leaky.body.finding_id });
  check("redaction of secrets and emails", !JSON.stringify(leakyStored.body).includes("Sup3rSecret") && !JSON.stringify(leakyStored.body).includes("ops@example.com"), leakyStored.body.symptoms);

  const f = await backend.call("get_finding", { id: findingId });
  const stale = await backend.call("update_finding", { id: findingId, version: f.body.version + 3, summary: "x", patch: { fix: "y" } });
  check("update_finding refuses a stale version", stale.isError && JSON.stringify(stale.body).includes("Version conflict"), stale.body);
  const upd = await backend.call("update_finding", { id: findingId, version: f.body.version, summary: "Add monitoring", patch: { fix: "Backoff with jitter; alert on 429 rate above 1%." } });
  check("update_finding", upd.body.status === "pending_review");
  await approve(upd.body.revision_id);
  check("get_finding shows history", (await backend.call("get_finding", { id: findingId })).body.history.length >= 2);

  // ---- Promote a recurring root cause; suggestions
  const runbook = await backend.call("create_article", {
    scope: "team",
    type: "runbook",
    title: `Payment errors runbook ${run}`,
    body_md: "## Trigger\nPayment error rate above 2%.\n\n## Diagnosis steps\nCheck provider status.\n\n## Fix\nBack off.\n\n## Verify\nError rate recovers.\n\n## Rollback\nn/a",
  });
  await approve(runbook.body.revision_id);
  await backend.call("link_entries", { from: findingId, relation: "related", to: runbook.body.article_id });
  const again = await backend.call("propose_finding", {
    type: "incident",
    title: `Campaign day payment failures ${run}`,
    symptoms: "During the spring campaign, a burst of declined card payments.",
    root_cause: "Same retry storm against the provider limit.",
    force_new: true,
  });
  await approve(again.body.revision_id);
  check("link_entries same_root_cause", !(await backend.call("link_entries", { from: again.body.finding_id, relation: "same_root_cause", to: findingId })).isError);
  const suggestions = await backend.call("list_suggestions", { scope: "all" });
  const promo = suggestions.body.promote?.find((p: { finding: { id: string } }) => p.finding.id === findingId);
  check("list_suggestions proposes promoting into the runbook", promo?.suggested_article?.id === runbook.body.article_id, suggestions.body.promote);
  const rb = await backend.call("get_article", { id: runbook.body.article_id });
  const promoted = await backend.call("promote_finding", { finding_id: findingId, article_id: runbook.body.article_id, version: rb.body.version });
  await approve(promoted.body.revision_id);
  check("promote_finding adds it to Known issues", (await backend.call("get_article", { id: runbook.body.article_id, section: "Known issues" })).body.body_md.includes(`Card payments declined at peak ${run}`));
  check("list_stale_entries", !(await backend.call("list_stale_entries", { scope: "all" })).isError);

  // ---- Share a project decision to the library
  const decision = await backend.call("create_article", {
    type: "decision",
    title: `Idempotency keys for payments ${run}`,
    body_md: "## Context\nClients retry.\n\n## Options considered\nDedup by hash; idempotency keys.\n\n## Choice\nIdempotency-Key header.\n\n## Consequences\nSafe retries.",
  });
  await approve(decision.body.revision_id);
  const share = await backend.call("share_to_library", { id: decision.body.article_id, summary: "Every payment-like API should do this", path: "Patterns" });
  check("share_to_library", share.body.status === "pending_review", share.body);
  const shared = await approve(share.body.revision_id);
  const libraryCopy = await designer.call("get_article", { id: shared.library_copy_id });
  check("library copy exists in the library", libraryCopy.body.scope?.slug === "library");
  const tree = await designer.call("browse_kb", { scope: "library" });
  check("browse_kb (library)", JSON.stringify(tree.body.tree).includes(`Idempotency keys for payments ${run}`));
  check("list_review_queue (mine, approved)", (await backend.call("list_review_queue", { mine: true, state: "approved" })).body.revisions.length >= 5);

  // ---- Members-only project
  const hidden = await backend.call("create_article", {
    scope: secret,
    type: "design_doc",
    title: `Secret pricing model ${run}`,
    body_md: "## Context\nConfidential pricing experiment zebrafruit.",
  });
  await approve(hidden.body.revision_id);
  const outsiderSearch = await outsider.call("search_knowledge", { query: "confidential pricing zebrafruit", scope: "all" });
  check("outsider can't find members-only content", ![...(outsiderSearch.body.articles ?? []), ...(outsiderSearch.body.findings ?? [])].some((h: { id: string }) => h.id === hidden.body.article_id));
  const outsiderGet = await outsider.call("get_article", { id: hidden.body.article_id });
  check("outsider gets 'not found'", outsiderGet.isError && String(outsiderGet.body).includes("not found"));
  check("outsider doesn't see the project listed", !(await outsider.call("list_projects")).body.projects.some((p: { slug: string }) => p.slug === secret));
  const memberSearch = await backend.call("search_knowledge", { query: "confidential pricing zebrafruit", scope: "all" });
  check("member can find it", memberSearch.body.articles?.some((h: { id: string }) => h.id === hidden.body.article_id));

  // ---- Errors are tool errors, not crashes
  check("bad input gives a tool error", (await designer.call("get_article", { id: "00000000-0000-0000-0000-000000000000" })).isError);

  const all = tools.map((t) => t.name);
  const missing = all.filter((t) => !toolsUsed.has(t));
  check("every tool was exercised", missing.length === 0, missing);
} catch (err) {
  failed++;
  console.error("FAIL  unexpected error:", err);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

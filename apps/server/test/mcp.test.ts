import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devAuthenticator } from "../src/auth/index.js";
import type { Db } from "../src/db/pool.js";
import { createApp } from "../src/http/app.js";
import { freshDb, TEST_SETTINGS } from "./helpers.js";

let db: Db;
let ids: Awaited<ReturnType<typeof freshDb>>["ids"];
let server: Server;
let url: URL;

beforeAll(async () => {
  ({ db, ids } = await freshDb());
  server = createApp({ db, authenticate: devAuthenticator("secret-token=alice@example.com,admin-token=admin@example.com"), settings: TEST_SETTINGS }).listen(0);
  await new Promise((r) => server.once("listening", r));
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.end();
});

async function connect(headers: Record<string, string>) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  return client;
}

function json(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

describe("MCP over streamable HTTP", () => {
  it("rejects requests without a valid token", async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("lists the read tools and carries usage instructions", async () => {
    const client = await connect({ authorization: "Bearer secret-token" });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "ack_notice", "add_incident_note", "add_person", "add_source", "add_source_link", "answer_question", "answer_sources", "approve_skill_import", "ask_session", "assign_skill", "brief_changes", "browse_kb", "call_api", "check_design_drift", "check_licenses", "claim_work", "complete_task", "create_article",
      "create_project", "create_ticket", "decide_access_request", "decide_project_request", "declare_incident", "decline_question", "delete_role", "delete_team", "describe_columns", "docs_begin", "docs_finish",
      "docs_inspect_claims", "docs_next_page", "docs_skip_page", "docs_submit_page", "docs_submit_plan", "find_experts", "find_people", "get_agents_md_block", "get_answer", "get_article", "get_article_template", "get_asset",
      "get_design_system", "get_finding", "get_guide", "get_inbox_item", "get_incident", "get_person_access", "get_personal_context", "get_pr_briefing", "get_project_access", "get_project_brief", "get_project_context", "get_proposal", "get_sbom", "get_skill", "get_skill_file",
      "get_skill_version", "get_table_schema", "get_tasks", "get_version", "get_vulnerability", "handoff_session", "latest_advisories", "link_entries", "link_ticket", "list_api_endpoints", "list_audit_log", "list_claims", "list_connections",
      "list_features", "list_impact_notices", "list_inbox", "list_incidents", "list_people", "list_project_requests", "list_projects", "list_review_queue", "list_roles", "list_sessions", "list_skill_reviews",
      "list_skill_sources", "list_skills", "list_stale_entries", "list_suggestions", "list_teams", "list_vulnerabilities", "move_entry", "promote_finding", "propose_article_edit", "propose_finding",
      "propose_skill", "propose_skill_edit", "publish_advisory", "publish_release", "query_database", "rate_source", "read_repo_file", "record_design_decision", "record_security_review", "register_session", "release_work",
      "report_skill_problem", "report_vulnerability", "resolve_claims", "resolve_decision_conflict", "resolve_inbox_item", "review_proposal", "review_skill_version", "save_personal_note", "save_role", "save_team", "scan_dependencies",
      "search_knowledge", "set_account_status", "set_advisory_response", "set_my_name", "set_project_access", "set_project_parent", "set_project_visibility", "set_revisit_date", "set_team_membership", "set_user_roles", "set_valid_dates",
      "share_to_library", "sync_skill_source", "unassign_skill", "unpublish_release", "update_design_system", "update_finding", "update_incident", "update_vulnerability", "upload_asset", "verify_entry", "wait_for_questions",
      "whats_new",
    ]);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly).not.toContain("propose_finding");
    expect(client.getInstructions()).toMatch(/search_knowledge first/);
    await client.close();
  });

  it("uses the X-Thaliyola-Project/Component headers as defaults and audits calls", async () => {
    const client = await connect({
      authorization: "Bearer secret-token",
      "x-thaliyola-project": "order-service",
      "x-thaliyola-component": "frontend",
    });
    const ctx = json(await client.callTool({ name: "get_project_context", arguments: {} }));
    expect(ctx.note).toMatch(/not instructions/);
    expect(ctx.component.slug).toBe("frontend");
    expect(ctx.contracts.consumes[0].id).toBe(ids.contract);

    const search = json(await client.callTool({ name: "search_knowledge", arguments: { query: "stuck orders refund" } }));
    expect(search.articles.map((h: { id: string }) => h.id)).toContain(ids.screen);

    const finding = json(await client.callTool({ name: "get_finding", arguments: { id: ids.rca } }));
    expect(finding.root_cause).toMatch(/rate limit/);

    const { rows } = await db.query(
      `SELECT l.tool, l.target_id, u.email FROM audit_log l JOIN users u ON u.id = l.actor_id ORDER BY l.id`,
    );
    expect(rows.map((r) => r.tool)).toEqual(["get_project_context", "search_knowledge", "get_finding"]);
    expect(rows[2]).toMatchObject({ target_id: ids.rca, email: "alice@example.com" });
    await client.close();
  });

  it("returns an article template with what each section should contain and a checklist", async () => {
    const client = await connect({ authorization: "Bearer secret-token" });
    const t = json(await client.callTool({ name: "get_article_template", arguments: { type: "decision" } }));
    expect(t.body_md).toMatch(/^## Context/);
    expect(t.sections.map((s: { heading: string }) => s.heading)).toEqual(["Context", "Options considered", "Choice", "Consequences"]);
    expect(t.sections[0].hint).toMatch(/problem/);
    expect(t.checklist).toContain("Says what was decided and why, not only the options");
    await client.close();
  });

  it("proposes over MCP, approves over REST as an admin, and refuses non-admin approval", async () => {
    const client = await connect({ authorization: "Bearer secret-token", "x-thaliyola-project": "order-service" });
    const proposed = json(
      await client.callTool({
        name: "propose_finding",
        arguments: {
          type: "known_issue",
          title: "Coupon codes are case-sensitive",
          symptoms: "Customers report valid coupon SAVE10 rejected when typed as save10.",
          root_cause: "Coupon lookup compares codes exactly.",
          components: ["backend"],
        },
      }),
    );
    expect(proposed.status).toBe("pending_review");

    const approve = (token: string) =>
      fetch(new URL(`/api/revisions/${proposed.revision_id}/approve`, url), { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const denied = await approve("secret-token");
    expect(denied.status).toBe(403);
    const ok = await approve("admin-token");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ state: "approved", item_status: "published" });

    const search = json(await client.callTool({ name: "search_knowledge", arguments: { query: "coupon rejected lowercase" } }));
    expect(search.findings[0].id).toBe(proposed.finding_id);
    await client.close();
  });

  it("returns a version conflict with the current content", async () => {
    const client = await connect({ authorization: "Bearer secret-token" });
    const res = await client.callTool({
      name: "update_finding",
      arguments: { id: ids.rca, version: 99, summary: "x", patch: { fix: "y" } },
    });
    expect(res.isError).toBe(true);
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(body.error).toMatch(/Version conflict/);
    expect(body.current.version).toBe(1);
    await client.close();
  });

  it("offers workflow prompts", async () => {
    const client = await connect({ authorization: "Bearer secret-token" });
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["capture", "capture-design", "check-design", "curate", "document-repo", "draft-from-paste", "explore-data", "fix-vulnerabilities", "investigate", "listen", "manage-access", "review-pr", "review-stale", "security-check", "start-coding", "sync-figma-design", "triage-inbox", "update-docs", "write-rca"]);
    const p = await client.getPrompt({ name: "start-coding", arguments: { project: "order-service", component: "frontend" } });
    const text = (p.messages[0]!.content as { text: string }).text;
    expect(text).toContain('get_project_context with component "frontend"');
    expect(text).toContain("impact notices");
    await client.close();
  });

  it("returns tool errors, not transport errors, for bad input", async () => {
    const client = await connect({ authorization: "Bearer secret-token" });
    const res = await client.callTool({ name: "browse_kb", arguments: { scope: "missing" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0]!.text).toMatch(/scope 'missing' not found/);
    await client.close();
  });
});

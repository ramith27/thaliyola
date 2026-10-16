import type { Queryable } from "../db/pool.js";
import {
  addSourceLink,
  createComponent,
  createScope,
  ensureBaseScopes,
  insertArticle,
  insertFinding,
  relate,
  tagEntity,
} from "../core/bootstrap.js";
import { getScopeBySlug } from "../core/scopes.js";

/**
 * Fictional demo content (an online shop) touching every scope and relation
 * kind. Returns ids for tests.
 */
export async function seedDemo(db: Queryable) {
  await ensureBaseScopes(db);
  const team = (await getScopeBySlug(db, "team")).id;
  const library = (await getScopeBySlug(db, "library")).id;
  const project = await createScope(db, "project", "order-service", "Order service v2", "Takes orders, charges payments and handles refunds");
  const backend = await createComponent(db, project, "backend", "backend", "https://github.com/example/orders-api");
  const frontend = await createComponent(db, project, "frontend", "frontend", "https://github.com/example/orders-web");
  const other = await createScope(db, "project", "merchant-portal", "Merchant portal", "Self-serve portal for merchants");

  // Team
  const cvr = await insertArticle(db, {
    scopeId: team, type: "metric", title: "Conversion rate", path: "Data and metrics/Metrics",
    body: `## Definition\nOrders divided by sessions over the same window.\n\n## Formula\n\`conversion = count(orders) / count(sessions)\`\n\n## Source of truth\nThe \`analytics.daily_orders\` table; never compute from raw page views.\n\n## Caveats\nInternal test orders are excluded.`,
  });
  await tagEntity(db, "metric", "Conversion rate", { kind: "article", id: cvr }, ["CVR"]);
  const runbook = await insertArticle(db, {
    scopeId: team, type: "runbook", title: "Checkout error-rate alert", path: "Runbooks",
    body: `## Trigger\nAlert: checkout error rate above 2% for 5 minutes.\n\n## Diagnosis steps\n1. Check payment provider status and rate-limit responses.\n2. Check recent deploys of the checkout service.\n\n## Fix\nBack off retries or roll back the deploy.\n\n## Verify\nError rate under 0.5% for 15 minutes.`,
  });
  const rca = await insertFinding(db, {
    scopeId: team, type: "rca", title: "Checkout errors spike: payment provider rate limit",
    symptoms: "Checkout errors spiked at noon during a sale; payments failing with HTTP 429.",
    rootCause: "Retry storm from the checkout service exceeded the payment provider's rate limit.",
    fix: "Add jittered exponential backoff; request a higher rate limit before sales.",
    tags: ["checkout"],
  });
  await tagEntity(db, "service", "Payments gateway", { kind: "finding", id: rca });
  await relate(db, { kind: "finding", id: rca }, "related", { kind: "article", id: runbook });
  await addSourceLink(db, { kind: "finding", id: rca }, "slack", "https://example.slack.com/archives/C1/p1", "Original thread");

  // Library: shared design + tech
  const dataTable = await insertArticle(db, {
    scopeId: library, type: "ui_component", title: "Data table", path: "UI components",
    body: `## Purpose\nDense, sortable tables for operational data.\n\n## States\nLoading skeleton, empty state with action, error with retry.\n\n## Accessibility\nSortable headers are buttons with aria-sort.\n\n## Do and don't\nDo paginate server-side past 500 rows.`,
  });
  await addSourceLink(db, { kind: "article", id: dataTable }, "figma", "https://www.figma.com/design/abc/DS?node-id=1-2", "Figma component");
  const tokens = await insertArticle(db, {
    scopeId: library, type: "design_tokens", title: "Core design tokens", path: "Design system",
    body: `## Colour\nprimary #1F6FEB, danger #D1242F.\n\n## Spacing\n4px base scale.`,
  });
  const webhookPattern = await insertArticle(db, {
    scopeId: library, type: "pattern", title: "Idempotent webhook consumer", path: "Patterns",
    body: `## Problem\nWebhook providers retry, so handlers see duplicates.\n\n## Solution\nStore the delivery id with a unique constraint and skip duplicates inside the same transaction.`,
  });

  // Project with backend + frontend
  const overview = await insertArticle(db, {
    scopeId: project, type: "project_overview", title: "Order service v2 overview",
    body: `## Goal\nSplit order handling out of the monolith.\n\n## Architecture summary\nThe backend owns orders, payments and refunds; the frontend is the support console.\n\n## Repos\norders-api (backend), orders-web (frontend).`,
  });
  const contract = await insertArticle(db, {
    scopeId: project, type: "api_contract", title: "Orders API v1", path: "Contracts",
    body: `## Interface\n\`GET /orders?status=&cursor=\` returns a page of orders.\n\`POST /orders/{id}/refund\` refunds an order.\n\n## Data shapes\nOrder: id, customer_id, status, total, created_at.\n\n## Errors\n409 when the order is already refunded.`,
    componentIds: [backend, frontend],
  });
  await relate(db, { kind: "article", id: contract }, "provided_by", { kind: "component", id: backend });
  await relate(db, { kind: "article", id: contract }, "consumed_by", { kind: "component", id: frontend });
  const screen = await insertArticle(db, {
    scopeId: project, type: "screen_spec", title: "Orders list screen", path: "Screens",
    body: `## Purpose\nSupport agents find stuck orders and refund them.\n\n## API calls\nGET /orders, POST /orders/{id}/refund.\n\n## States\nUses the library Data table empty and error states.`,
    componentIds: [frontend],
  });
  await relate(db, { kind: "article", id: screen }, "uses", { kind: "article", id: dataTable });
  await relate(db, { kind: "article", id: screen }, "depends_on", { kind: "article", id: contract });
  await relate(db, { kind: "scope", id: project }, "uses", { kind: "article", id: webhookPattern });
  await relate(db, { kind: "scope", id: project }, "uses", { kind: "article", id: tokens });
  const decision = await insertArticle(db, {
    scopeId: project, type: "decision", title: "Use idempotency keys for order creation", path: "Decisions",
    body: `## Context\nClients retry order creation on timeouts.\n\n## Choice\nRequire an Idempotency-Key header; store it with a unique constraint.\n\n## Consequences\nRetries are safe; keys expire after 24 hours.`,
  });
  const knownIssue = await insertFinding(db, {
    scopeId: project, type: "known_issue", title: "Order export times out over 50k rows",
    symptoms: "CSV export from the orders list spins and fails with a 504 for large date ranges.",
    rootCause: "Export runs synchronously in the request.",
    fix: "Narrow the date range; async export planned.",
    componentIds: [backend],
  });
  await addSourceLink(db, { kind: "finding", id: knownIssue }, "sentry", "https://sentry.io/issues/123", "Sentry issue");
  const draft = await insertFinding(db, {
    scopeId: project, type: "rca", title: "Unreviewed draft about refund failures", status: "draft",
    symptoms: "Refund returns 500.", rootCause: "Unknown", fix: "",
  });
  await db.query(
    `INSERT INTO impact_notices (source_kind, source_id, source_version, component_id, summary)
     VALUES ('article', $1, 2, $2, 'Orders API: GET /orders now requires the status filter')`,
    [contract, frontend],
  );

  // Another project's private record, outside the default search scope.
  const otherDoc = await insertArticle(db, {
    scopeId: other, type: "design_doc", title: "Merchant onboarding flow", path: "Design",
    body: `## Context\nMerchants sign up and verify their payout details.\n\n## Design\nThree-step wizard with bank account verification.`,
  });

  return { team, library, project, other, backend, frontend, cvr, runbook, rca, dataTable, tokens, webhookPattern, overview, contract, screen, decision, knownIssue, draft, otherDoc };
}

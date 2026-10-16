# Acceptance testing

Two layers check that a deployed Cairn does what it is for: a deterministic sweep of every MCP tool, and real Claude Code sessions acting as different team members.

## 1. Tool sweep (deterministic)

`apps/server/src/scripts/acceptance.ts` drives all 23 MCP tools and 4 prompts against a live server and checks each result. It builds its own uniquely named content, so it runs on any instance, including production. It needs three tokens: an admin (who creates projects and approves), a regular user, and a user who is kept out of a members-only project.

```sh
sudo cairn-admin create-user --email acc-admin@example.com --admin
sudo cairn-admin create-user --email acc-user@example.com
sudo cairn-admin create-user --email acc-outsider@example.com
# tokens: sudo cairn-admin create-token --email … --name acceptance
CAIRN_URL=https://cairn.example.com ADMIN_TOKEN=… WRITER_TOKEN=… OUTSIDER_TOKEN=… \
  pnpm --filter @cairn/server acceptance
```

What it covers, in order:
- shared UI design in the library, with a screenshot and a Figma link;
- a backend contract consumed by the frontend, with provider/consumer links;
- a screen spec that uses the library component and depends on the contract;
- a contract change raising an impact notice for the frontend only, then acknowledged;
- capture, duplicate detection, search by meaning, verification, redaction, version conflicts, history;
- promotion of a recurring root cause via suggestions;
- sharing a decision to the library;
- members-only visibility for members vs. outsiders;
- error handling.

The last check fails if any tool was not exercised.

## 2. Claude Code as the client

The real test is whether an agent, given ordinary requests, uses Cairn correctly. Add Cairn to Claude Code per persona, each with its own token and, for repo work, its project and component:

```sh
claude mcp add --transport http cairn https://cairn.example.com/mcp \
  --header "Authorization: Bearer $CAIRN_TOKEN" \
  --header "X-Cairn-Project: shop" --header "X-Cairn-Component: frontend"
claude mcp list        # cairn: … - Connected
```

Then give each persona plain-language tasks and check the stored result after each one. Use `claude -p` with `--allowedTools "mcp__cairn" "Bash(base64:*)" "Read"`; base64 lets Claude attach files. Approvals go through the Review page or `POST /api/revisions/:id/approve`.

### Results (2026-10-16, Claude Code 2.1.301, staging with local sign-in and the bge-small model)

| # | Persona | Request (paraphrased) | What Claude did in Cairn | Result |
|---|---|---|---|---|
| 1 | Designer | Add the shared Toast component to the library, attach a screenshot, link the Figma frame | Searched for an existing component, read the template, created the library UI spec with the Figma link, uploaded the screenshot | Pass |
| 2 | Backend dev | Document the Refunds API; backend provides it, frontend consumes it | Created the contract in the project from the repo header, linked `provided_by` and `consumed_by` | Pass |
| 3 | Frontend dev | Check what I need before building the refund screen, then write its spec using the shared toast | Loaded project context, read the contract and toast spec, applied the toast's accessibility rule, created the screen spec with `uses` and `depends_on` | Pass |
| 4 | Backend dev | Amounts are now cents and `reason` is required; update the contract so the frontend is notified | Proposed a section edit with a consumer-facing summary; approval raised one notice for the frontend | Pass |
| 5 | Frontend dev | `/mcp__cairn__start-coding shop frontend …` | Read the notice first, explained the code change, acknowledged the notice, proposed updating the screen spec to v2 | Pass |
| 6 | On-call | `/mcp__cairn__investigate …`, then capture the confirmed root cause | Searched first (nothing yet), captured the incident with symptoms, cause, fix, entities, Slack link, and a link to the contract | Pass |
| 7 | Backend dev | The same failure described differently; confirmed, record it | Found the incident by meaning, gave confirmation steps, held off until confirmed, then verified it and added the recurrence as an update instead of a duplicate | Pass |
| 8 | Outsider and member | What do we know about Payroll's tax engine? | Outsider: listed projects, searched every scope, browsed, found nothing and didn't learn Payroll exists. Member: found the doc | Pass |
| 9 | Backend dev | Record a money-handling decision and share it to the library | Created the decision and proposed the share. After a fix, both happen in one request | Pass |
| 10 | Another team | How should a new invoicing service store money? | Found the shared library pattern from the shop team | Pass |
| 11 | Admin | `/mcp__cairn__review-stale` after two entries went stale | Listed stale entries and verified both, back to published | Pass |
| — | Admin (browser) | Sign in with a temporary password, review the agents' work | Forced password change, then the project, search, finding and library pages showed the agents' content with no console errors | Pass |

- **Server side:** no 5xx responses across 420+ requests (321 MCP calls), and all 23 tools were used by real sessions.
- **The 400 responses** come from Claude Code probing a newer MCP protocol version (`2026-07-28`, via `server/discover`). That is answered with "unsupported version" by the 1.x MCP SDK, and Claude Code then connects with `2025-11-25`. Moving to the 2.x SDK removes the extra round trip.

### Issues the run found, all fixed

- The `investigate` prompt took a second `project` argument. Claude Code splits prompt arguments on spaces, so a multi-word symptom spilled into it. The prompt now takes only the symptom; the project comes from the client header.
- Sharing to the library required the item to be published first, so agents had to come back after review. Drafts can now be proposed for sharing, and reviewers approve the item, then the share.
- Asset uploads and deletions were written to the audit log twice.
- In the web UI's folder tree, unfiled articles looked like they belonged to the folder above them.

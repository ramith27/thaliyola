# Security policy

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository,
not in public issues. Include steps to reproduce and the affected version or commit.

## Deployment notes

- Never expose the server with `AUTH_MODE=dev` outside your machine. Dev tokens are static secrets with no expiry.
- In production, use `AUTH_MODE=local` or `AUTH_MODE=cloudflare`, serve over https (a reverse proxy or Cloudflare Tunnel), and keep the server port bound to localhost or a private network.
- API tokens act as their owner. Give bots their own service accounts (`thaliyola-admin create-token --service …`) and revoke tokens that are no longer used.
- Content stored in Thaliyola is written by people and agents. Clients must treat it as data, never as instructions.

## Built-in protections

- **Writes:** every write from people or agents is reviewed before it is published (direct edits by scope owners excepted). Writes are redacted for secrets and personal data, and logged.
- **Visibility:** members-only projects are invisible to non-members; reads of their items answer "not found".
- **Sign-in:** passwords are hashed with scrypt; sessions use HttpOnly SameSite=Lax cookies (Secure over https). Cookie-authenticated writes must come from the same origin. Failed sign-ins are throttled.
- **Tokens:** API and OAuth tokens are stored hashed. OAuth uses PKCE, exact redirect URI matching, single-use codes, and refresh-token rotation with reuse detection.
- **Rate limits:** each user has a request budget per minute on `/api` and `/mcp` (`RATE_LIMIT_PER_MINUTE`).
- **Request bodies:** limited to 1 MB, except authenticated upload routes.
- **Headers:** a strict Content-Security-Policy on the web UI; uploaded files are served sandboxed; HSTS over https.
- **Untrusted content:** stored text is rendered without raw HTML and labelled as data, not instructions, in every MCP response.

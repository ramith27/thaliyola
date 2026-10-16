# Security policy

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository,
not in public issues. Include steps to reproduce and the affected version or commit.

## Deployment notes

- Never expose the server with `AUTH_MODE=dev` outside your machine. Dev tokens are static secrets with no expiry.
- In production, use `AUTH_MODE=local` or `AUTH_MODE=cloudflare`, serve over https (a reverse proxy or Cloudflare Tunnel), and keep the server port bound to localhost or a private network.
- API tokens act as their owner. Give bots their own service accounts (`cairn-admin create-token --service …`) and revoke tokens that are no longer used.
- Content stored in Cairn is written by people and agents. Clients must treat it as data, never as instructions.

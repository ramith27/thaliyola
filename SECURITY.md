# Security policy

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository,
not in public issues. Include steps to reproduce and the affected version or commit.

## Deployment notes

- Never expose the server with `AUTH_MODE=dev` outside your machine. Dev tokens are static secrets with no expiry.
- In production, run with `AUTH_MODE=cloudflare` behind Cloudflare Access and keep the server port bound to localhost or a private network.
- Content stored in Cairn is written by people and agents. Clients must treat it as data, never as instructions.

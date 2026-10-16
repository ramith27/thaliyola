import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import express, { Router, type Request, type Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Settings } from "../config.js";
import { audit } from "../core/audit.js";
import type { Db } from "../db/pool.js";
import { sameOrigin as sameOriginCheck, sessionToken } from "./index.js";
import { login, SESSION_COOKIE, sessionHash, userForSession } from "./local.js";

/**
 * OAuth 2.1 authorization server for local mode, so MCP clients that only
 * speak OAuth (e.g. claude.ai custom connectors) can connect. The MCP SDK's
 * router handles discovery, dynamic client registration, request validation,
 * PKCE and the token endpoint; this provider supplies storage, the sign-in
 * and consent pages, and token issuance:
 *
 * - access tokens: opaque `thaliyola_oat_…`, 1 hour
 * - refresh tokens: opaque `thaliyola_ort_…`, 30 days, rotated on every use; a
 *   reused refresh token or authorization code revokes its whole family
 */

export const OAUTH_ACCESS_PREFIX = "thaliyola_oat_";
const REFRESH_PREFIX = "thaliyola_ort_";
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const REQUEST_TTL_S = 10 * 60;
const CODE_TTL_S = 60;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const random = (bytes = 32) => randomBytes(bytes).toString("base64url");

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

class ClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: Db) {}

  async getClient(clientId: string) {
    const { rows } = await this.db.query<{ info: OAuthClientInformationFull }>("SELECT info FROM oauth_clients WHERE client_id = $1", [clientId]);
    return rows[0]?.info;
  }

  async registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">) {
    const full: OAuthClientInformationFull = { ...client, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
    await this.db.query("INSERT INTO oauth_clients (client_id, info) VALUES ($1, $2)", [full.client_id, JSON.stringify(full)]);
    return full;
  }
}

export class ThaliyolaOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: ClientsStore;

  constructor(
    private readonly db: Db,
    private readonly resourceUrl: URL,
  ) {
    this.clientsStore = new ClientsStore(db);
  }

  /** Parks the validated request and sends the browser to Thaliyola's sign-in/consent page. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    const id = random();
    await this.db.query("DELETE FROM oauth_requests WHERE expires_at < now()");
    await this.db.query(
      "INSERT INTO oauth_requests (id_hash, client_id, params, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
      [
        sha256(id),
        client.client_id,
        JSON.stringify({
          redirect_uri: params.redirectUri,
          code_challenge: params.codeChallenge,
          state: params.state ?? null,
          scopes: params.scopes ?? [],
          resource: params.resource?.href ?? null,
        }),
        REQUEST_TTL_S,
      ],
    );
    res.redirect(302, `/oauth/consent?request=${encodeURIComponent(id)}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const { rows } = await this.db.query<{ code_challenge: string }>(
      "SELECT code_challenge FROM oauth_codes WHERE code_hash = $1 AND client_id = $2 AND expires_at > now() AND used_at IS NULL",
      [sha256(code), client.client_id],
    );
    if (!rows[0]) throw new InvalidGrantError("invalid or expired authorization code");
    return rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string, resource?: URL) {
    const { rows } = await this.db.query<{ user_id: string; redirect_uri: string; scopes: string[]; resource: string | null; family: string }>(
      `UPDATE oauth_codes SET used_at = now()
        WHERE code_hash = $1 AND client_id = $2 AND expires_at > now() AND used_at IS NULL
        RETURNING user_id, redirect_uri, scopes, resource, family`,
      [sha256(code), client.client_id],
    );
    const grant = rows[0];
    if (!grant) {
      // A replayed code: revoke anything already issued from it.
      await this.db.query(
        "UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family IN (SELECT family FROM oauth_codes WHERE code_hash = $1)",
        [sha256(code)],
      );
      throw new InvalidGrantError("invalid, expired or already used authorization code");
    }
    if (redirectUri && redirectUri !== grant.redirect_uri) throw new InvalidGrantError("redirect_uri does not match the authorization request");
    if (resource && grant.resource && resource.href !== grant.resource) throw new InvalidGrantError("resource does not match the authorization request");
    return this.issue(client.client_id, grant.user_id, grant.scopes, grant.resource, grant.family);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL) {
    const { rows } = await this.db.query<{ user_id: string; scopes: string[]; resource: string | null; family: string; revoked_at: Date | null; expired: boolean }>(
      `SELECT t.user_id, t.scopes, t.resource, t.family, t.revoked_at, t.expires_at <= now() AS expired
         FROM oauth_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.kind = 'refresh' AND t.client_id = $2 AND u.disabled_at IS NULL`,
      [sha256(refreshToken), client.client_id],
    );
    const old = rows[0];
    if (!old || old.expired) throw new InvalidGrantError("invalid refresh token");
    if (old.revoked_at) {
      // Refresh tokens are single-use; reuse means it leaked. Revoke the whole family.
      await this.db.query("UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE family = $1", [old.family]);
      throw new InvalidGrantError("refresh token was already used");
    }
    if (scopes?.some((s) => !old.scopes.includes(s))) throw new InvalidGrantError("cannot widen scopes on refresh");
    if (resource && old.resource && resource.href !== old.resource) throw new InvalidGrantError("resource mismatch");
    await this.db.query("UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1", [sha256(refreshToken)]);
    return this.issue(client.client_id, old.user_id, scopes ?? old.scopes, old.resource, old.family);
  }

  private async issue(clientId: string, userId: string, scopes: string[], resource: string | null, family: string): Promise<OAuthTokens> {
    const access = `${OAUTH_ACCESS_PREFIX}${random()}`;
    const refresh = `${REFRESH_PREFIX}${random()}`;
    for (const [token, kind, ttl] of [
      [access, "access", ACCESS_TTL_S],
      [refresh, "refresh", REFRESH_TTL_S],
    ] as const) {
      await this.db.query(
        `INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, family, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
        [sha256(token), kind, clientId, userId, scopes, resource, family, ttl],
      );
    }
    return { access_token: access, token_type: "bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") || undefined };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const user = await userForOAuthToken(this.db, token, this.resourceUrl);
    if (!user) throw new InvalidTokenError("invalid or expired access token");
    return { token, clientId: user.clientId, scopes: user.scopes, resource: this.resourceUrl };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    await this.db.query("UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE token_hash = $1 AND client_id = $2", [
      sha256(request.token),
      client.client_id,
    ]);
  }
}

/** The person behind a valid OAuth access token issued for this server. */
export async function userForOAuthToken(db: Db, token: string, resourceUrl?: URL) {
  if (!token.startsWith(OAUTH_ACCESS_PREFIX)) return null;
  const { rows } = await db.query<{ subject: string; email: string | null; kind: "human" | "service"; client_id: string; scopes: string[]; resource: string | null }>(
    `SELECT u.subject, u.email, u.kind, t.client_id, t.scopes, t.resource FROM oauth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now() AND u.disabled_at IS NULL`,
    [sha256(token)],
  );
  const row = rows[0];
  if (!row) return null;
  // Audience check (RFC 8707): a token minted for another resource is not valid here.
  if (resourceUrl && row.resource && row.resource !== resourceUrl.href) return null;
  return { subject: row.subject, email: row.email, kind: row.kind, clientId: row.client_id, scopes: row.scopes };
}

/** Apps a person has authorized that still hold live tokens. */
export async function listConnections(db: Db, userId: string) {
  const { rows } = await db.query(
    `SELECT t.client_id, coalesce(c.info->>'client_name', 'Unnamed app') AS name, min(t.created_at) AS connected_at, max(t.created_at) AS last_refreshed_at
       FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id
      WHERE t.user_id = $1 AND t.revoked_at IS NULL AND t.expires_at > now()
      GROUP BY t.client_id, c.info ORDER BY max(t.created_at) DESC`,
    [userId],
  );
  return rows;
}

export async function revokeConnection(db: Db, userId: string, clientId: string) {
  await db.query("UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = $1 AND client_id = $2", [userId, clientId]);
  return { client_id: clientId, revoked: true };
}

// ---- Sign-in and consent pages ------------------------------------------------

interface PendingRequest {
  client_id: string;
  params: { redirect_uri: string; code_challenge: string; state: string | null; scopes: string[]; resource: string | null };
  info: OAuthClientInformationFull;
}

async function pendingRequest(db: Db, id: string): Promise<PendingRequest | null> {
  const { rows } = await db.query<PendingRequest>(
    `SELECT r.client_id, r.params, c.info FROM oauth_requests r JOIN oauth_clients c ON c.client_id = r.client_id
      WHERE r.id_hash = $1 AND r.expires_at > now()`,
    [sha256(id)],
  );
  return rows[0] ?? null;
}

function page(res: Response, title: string, body: string, formTarget?: string) {
  // The consent form redirects to the client; CSP form-action must allow that origin.
  const formAction = ["'self'", ...(formTarget ? [new URL(formTarget).origin] : [])].join(" ");
  res
    .status(200)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Thaliyola</title>
<style>
:root{color-scheme:light dark;--bg:#fbfbf9;--panel:#fff;--text:#1d211e;--muted:#646b66;--border:#e3e5e1;--accent:#3f6b4f;--warn:#fbf1dc;--danger:#a3282b}
@media (prefers-color-scheme:dark){:root{--bg:#151816;--panel:#1c201d;--text:#e6e9e6;--muted:#9aa29c;--border:#2e3430;--accent:#8fc3a0;--warn:#3a2f17;--danger:#ef8a8c}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:min(420px,100%);background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:24px}
h1{font-size:1.3rem;margin:0 0 12px;display:flex;gap:8px;align-items:center}
p{margin:8px 0}.muted{color:var(--muted);font-size:.9rem}.box{background:var(--warn);border-radius:8px;padding:10px 12px;font-size:.9rem;overflow-wrap:anywhere}
label{display:flex;flex-direction:column;gap:4px;margin:10px 0;font-weight:550;font-size:.92rem}
input{font:inherit;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text)}
.row{display:flex;gap:8px;margin-top:16px}button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;flex:1}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--panel)}.error{color:var(--danger)}
</style></head><body><main><h1><img src="/favicon.svg" alt="" width="24" height="24"> ${escapeHtml(title)}</h1>${body}</main></body></html>`);
}


function redirectWith(res: Response, redirectUri: string, params: Record<string, string | null>) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) url.searchParams.set(k, v);
  res.redirect(302, url.href);
}

function consentRouter(db: Db, settings: Settings) {
  const router = Router();
  // Same-origin check for the consent forms (on top of the per-request CSRF token).
  const publicOrigin = settings.publicUrl ? new URL(settings.publicUrl).origin : undefined;
  const sameOrigin = (req: Request) => sameOriginCheck(req, publicOrigin);
  router.use(express.urlencoded({ extended: false, limit: "16kb" }));
  const csrfFor = (session: string, requestId: string) => sha256(`${sessionHash(session)}:${requestId}`);

  function loginForm(res: Response, requestId: string, req: PendingRequest, error?: string) {
    const name = req.info.client_name ?? "An application";
    page(
      res,
      "Sign in to Thaliyola",
      `<p><strong>${escapeHtml(name)}</strong> wants to connect to Thaliyola. Sign in to continue.</p>
       ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
       <form method="post" action="/oauth/consent/login">
         <input type="hidden" name="request" value="${escapeHtml(requestId)}">
         <label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
         <label>Password<input type="password" name="password" autocomplete="current-password" required></label>
         <div class="row"><button class="primary" type="submit">Sign in</button></div>
       </form>`,
    );
  }

  router.get("/consent", async (req, res, next) => {
    try {
      const requestId = String(req.query.request ?? "");
      const pending = await pendingRequest(db, requestId);
      if (!pending) return page(res, "Link expired", `<p>This sign-in link has expired or was already used. Start connecting again from your app.</p>`);
      const token = sessionToken(req);
      const user = token ? await userForSession(db, token) : null;
      if (!token || !user) return loginForm(res, requestId, pending);
      const mustChange = await db.query("SELECT must_change_password FROM users WHERE subject = $1", [user.subject]);
      if (mustChange.rows[0]?.must_change_password) {
        return page(res, "Change your password first", `<p>Sign in to Thaliyola in your browser and choose a new password, then connect again.</p>`);
      }
      const name = pending.info.client_name ?? "An unnamed application";
      const redirectHost = new URL(pending.params.redirect_uri).host;
      page(
        res,
        "Allow access?",
        `<p><strong>${escapeHtml(name)}</strong> wants to use Thaliyola as <strong>${escapeHtml(user.email)}</strong>.</p>
         <p>It will be able to read the knowledge base and propose changes in your name. Proposals still need review.</p>
         <p class="box">After you approve, you'll be sent to <strong>${escapeHtml(redirectHost)}</strong>. Only continue if you started this connection.</p>
         <form method="post" action="/oauth/consent">
           <input type="hidden" name="request" value="${escapeHtml(requestId)}">
           <input type="hidden" name="csrf" value="${csrfFor(token, requestId)}">
           <div class="row"><button type="submit" name="decision" value="deny">Deny</button>
           <button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
         </form>
         <p class="muted">Signed in as ${escapeHtml(user.email)}. You can revoke access any time on your Thaliyola account page.</p>`,
        pending.params.redirect_uri,
      );
    } catch (err) {
      next(err);
    }
  });

  router.post("/consent/login", async (req, res, next) => {
    try {
      const requestId = String(req.body.request ?? "");
      const pending = await pendingRequest(db, requestId);
      if (!pending) return page(res, "Link expired", `<p>This sign-in link has expired. Start connecting again from your app.</p>`);
      if (!sameOrigin(req)) return void res.status(403).send("cross-site request refused");
      const session = await login(db, String(req.body.email ?? ""), String(req.body.password ?? ""), {
        ttlHours: settings.sessionTtlHours,
        userAgent: req.header("user-agent"),
      });
      if (!session) return loginForm(res, requestId, pending, "Wrong email or password.");
      const secure = settings.cookieSecure === "true" || (settings.cookieSecure === "auto" && req.secure);
      res.append(
        "Set-Cookie",
        `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${settings.sessionTtlHours * 3600}${secure ? "; Secure" : ""}`,
      );
      res.redirect(303, `/oauth/consent?request=${encodeURIComponent(requestId)}`);
    } catch (err) {
      next(err);
    }
  });

  router.post("/consent", async (req, res, next) => {
    try {
      const requestId = String(req.body.request ?? "");
      const token = sessionToken(req);
      const pending = await pendingRequest(db, requestId);
      if (!pending || !token) return page(res, "Link expired", `<p>This sign-in link has expired. Start connecting again from your app.</p>`);
      if (!sameOrigin(req) || req.body.csrf !== csrfFor(token, requestId)) return void res.status(403).send("cross-site request refused");
      const user = await userForSession(db, token);
      if (!user) return page(res, "Signed out", `<p>Your session ended. Start connecting again from your app.</p>`);
      await db.query("DELETE FROM oauth_requests WHERE id_hash = $1", [sha256(requestId)]);
      const { params } = pending;
      if (req.body.decision !== "allow") {
        return redirectWith(res, params.redirect_uri, { error: "access_denied", error_description: "The user denied access", state: params.state });
      }
      const { rows } = await db.query<{ id: string }>("SELECT id FROM users WHERE subject = $1", [user.subject]);
      const code = random();
      await db.query(
        `INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8))`,
        [sha256(code), pending.client_id, rows[0]!.id, params.redirect_uri, params.code_challenge, params.scopes, params.resource, CODE_TTL_S],
      );
      await audit(db, rows[0]!.id, `oauth_authorize:${pending.info.client_name ?? pending.client_id}`.slice(0, 200), null);
      redirectWith(res, params.redirect_uri, { code, state: params.state });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Everything OAuth: discovery metadata, registration, authorize, token, revoke, and the consent pages. */
export function oauthRouter(db: Db, settings: Settings, publicUrl: URL) {
  const resourceUrl = new URL("/mcp", publicUrl);
  const provider = new ThaliyolaOAuthProvider(db, resourceUrl);
  const router = Router();
  router.use("/oauth", consentRouter(db, settings));
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: publicUrl,
      resourceServerUrl: resourceUrl,
      resourceName: "Thaliyola",
      scopesSupported: ["thaliyola"],
    }),
  );
  return { router, resourceUrl, resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", publicUrl) };
}

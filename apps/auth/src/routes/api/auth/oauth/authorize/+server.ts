import { json, redirect, type RequestHandler } from '@sveltejs/kit';
import { TokenScope, ALL_SCOPES } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { oauthServer } from '$lib/server/oauth/server';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { storeOidcContext } from '$lib/server/oauth/oidc-nonce';
import { getOrCreateDeviceId, touchAccount } from '$lib/server/auth/device';
import { redirectUriMatches } from '$lib/server/oauth/redirect-uri';
import { hasScope } from '$lib/server/oauth/scope';
import { isAppBlockOauthClientId } from '$lib/server/oauth/block-guard';
import { resolveClientLite, authorizeRedirectUriStore } from '$lib/server/oauth/model';
import { parseBody, toOAuthRequest, newOAuthResponse } from '$lib/server/oauth/http';

// GET /api/auth/oauth/authorize — return-after-consent + issue the authorization code.
// Ported from the main app's src/pages/api/auth/oauth/authorize.ts. The session gate uses the hub's
// locals.user (hooks.server.ts resolves it from the civ-token cookie) instead of getServerAuthSession.
//
// SECURITY (carried-forward §D.x): PKCE is REQUIRED and S256-only (the library only *verifies* a stored
// challenge, never *requires* one — a public client omitting code_challenge would otherwise get a bare,
// interceptable code); `state` is required; app-block (`appblk-`) clients are rejected before load.

const oauthError = (status: number, error: string, description?: string) =>
  json({ error, ...(description ? { error_description: description } : {}) }, { status });

async function handle(event: Parameters<RequestHandler>[0]): Promise<Response> {
  const { request, url, locals, getClientAddress, cookies } = event;
  const method = request.method;

  const params: Record<string, string> =
    method === 'GET' ? Object.fromEntries(url.searchParams.entries()) : await parseBody(request);

  // Rebuild this endpoint's URL from the params so an unauthenticated user (or a consent redirect) is
  // sent somewhere that round-trips back here with the full request intact, regardless of GET vs POST.
  const self = new URL(`${url.origin}/api/auth/oauth/authorize`);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') self.searchParams.set(key, value);
  }
  const selfUrl = `${self.pathname}${self.search}`;

  // Session gate. 303 so a POST from the consent form is downgraded to GET on /login.
  const user = locals.user;
  if (!user) {
    redirect(303, `/login?returnUrl=${encodeURIComponent(selfUrl)}`);
  }

  // Rate limit by user id.
  if (!(await checkOAuthRateLimit('authorize', String(user.id)))) {
    return oauthError(429, 'rate_limited', 'Too many authorization requests');
  }

  const clientId = params.client_id;
  if (!clientId) return oauthError(400, 'invalid_request', 'Missing client_id');

  // SECURITY (A1): app-block clients can never drive the interactive authorize flow — reject before load.
  if (isAppBlockOauthClientId(clientId)) {
    return oauthError(
      400,
      'invalid_client',
      'This client cannot be used for interactive authorization'
    );
  }

  // Resolve the client: a DB OauthClient (third-party), or a first-party client by the redirect_uri's
  // ORIGIN (its host checked against the TrustedSpokeDomain registry — exact / subdomain-wildcard / dev
  // loopback). Shared with getAuthorizationCode.
  const redirectUri = params.redirect_uri;
  const client = await resolveClientLite(clientId, redirectUri);
  if (!client) return oauthError(400, 'invalid_client', 'Unknown client_id');

  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return oauthError(400, 'invalid_request', 'redirect_uri does not match any registered URI');
  }

  // PKCE required + S256-only (§D.x #1). Never enable plain PKCE.
  if (!params.code_challenge || !params.code_challenge_method) {
    return oauthError(
      400,
      'invalid_request',
      'PKCE required: provide code_challenge and code_challenge_method=S256'
    );
  }
  if (params.code_challenge_method !== 'S256') {
    return oauthError(400, 'invalid_request', 'Only S256 code_challenge_method is supported');
  }

  if (!params.state) {
    return oauthError(400, 'invalid_request', 'state parameter is required');
  }

  const rawScope = parseInt(params.scope, 10);
  // Bound against ALL_SCOPES (incl. opt-in AppBlocksSubmit), NOT `Full`; the per-client allowedScopes
  // intersection (validateScope) is the real auth gate.
  if (isNaN(rawScope) || rawScope < 0 || rawScope > ALL_SCOPES) {
    return oauthError(400, 'invalid_scope', 'Invalid scope value');
  }
  // UserRead is the mandatory baseline (createOAuthTokenPair forces it on the issued token); force it
  // here too so the stored consent + consent screen reflect what the token actually carries.
  const requestedScope = rawScope | TokenScope.UserRead;

  // Consent — approval MUST arrive via POST (prevents a GET-param CSRF bypass). First-party (trusted)
  // spoke clients SKIP the consent screen entirely (Phase 2): they're our own apps, so we never prompt.
  // First-party-ness is the resolved client's IDENTITY (a hub-synthesized client with no OauthClient row),
  // NOT the redirect origin — so a registered third-party client can't skip consent by claiming an owned
  // redirect host (it has a DB row → isFirstParty=false). See resolveClientLite.
  const isFirstParty = client.isFirstParty;
  const isApproval = method === 'POST' && params.approved === 'true';
  const existingConsent = isFirstParty
    ? undefined
    : await db
        .selectFrom('OauthConsent')
        .select(['scope'])
        .where('userId', '=', user.id)
        .where('clientId', '=', clientId)
        .executeTakeFirst();

  if (isFirstParty) {
    // Trusted: no consent record, no consent screen — fall straight through to code issuance.
  } else if (isApproval) {
    // Buzz spend-limit at consent (AIServicesWrite) is a fast-follow (§E) — not parsed in this first
    // pass, so buzzLimit is left null. Persist the consent only when "remember" was checked.
    if (params.remember === 'true') {
      await db
        .insertInto('OauthConsent')
        .values({ userId: user.id, clientId, scope: requestedScope })
        .onConflict((oc) =>
          oc
            .columns(['userId', 'clientId'])
            .doUpdateSet({ scope: requestedScope, updatedAt: new Date() })
        )
        .execute();
    }
  } else if (!existingConsent || !hasScope(existingConsent.scope, requestedScope)) {
    // No prior consent, or the request asks for MORE than was remembered → bounce to the consent page.
    // (A subset of an already-granted scope is covered by the stored consent — honor "remember", no
    // re-prompt.) 303 → always GET.
    const consentUrl = new URL(`${url.origin}/login/oauth/authorize`);
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') consentUrl.searchParams.set(key, value);
    }
    redirect(303, consentUrl.toString());
  }

  // Issue the authorization code via the library (PKCE challenge stored, code hashed in Redis).
  let code;
  try {
    const oauthReq = toOAuthRequest({
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: { ...params, response_type: 'code' },
    });
    // The library's authorize handler calls model.getClient(clientId, null) without the request, so a
    // synthesized first-party client (resolved by redirect_uri origin) can't be found. Carry redirectUri
    // through AsyncLocalStorage so getClient can fall back to it for this in-flight call.
    code = await authorizeRedirectUriStore.run(redirectUri, () =>
      oauthServer.authorize(oauthReq, newOAuthResponse(), {
        authenticateHandler: { handle: () => ({ id: user.id }) },
      })
    );
  } catch (err) {
    const status =
      typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : 500;
    return oauthError(status, (err as Error).name || 'server_error', (err as Error).message);
  }

  // Stash code-keyed context for the exchange:
  //  - OIDC nonce + auth_time → /token mints the id_token (no-op unless the request carried a `nonce`).
  //  - FIRST-PARTY device id → /session hands the SAME hub `.civitai.com` device id to the spoke so its
  //    civ-device joins ONE shared device set (the spoke can't read the `.civitai.com` cookie itself, and the
  //    server-to-server /session can't see it either — so it has to ride the code from here). `getOrCreateDeviceId`
  //    reads/rolls the hub's own device cookie on this browser nav. Third-party clients never touch the device set.
  // getOrCreateDeviceId WRITES the hub's civ-device cookie as a side effect, so REGISTER it here (atomic with
  // the write) — every other device-cookie writer (establishSession, /switch) pairs the two. Relying solely on
  // /session's touchAccount left an ORPHANED civ-device (cookie set, but no device:accounts entry) whenever
  // that /session touchAccount didn't fire for this exact id (abandoned/re-run consent, a post-redirect error,
  // or a session established another way) — and the switcher (/api/auth/accounts) then showed nothing.
  // /session re-touches the same id; that's idempotent.
  const deviceId = isFirstParty ? getOrCreateDeviceId(cookies) : undefined;
  if (deviceId) await touchAccount(deviceId, user.id);
  await storeOidcContext(code.authorizationCode, {
    nonce: typeof params.nonce === 'string' ? params.nonce : undefined,
    authTime: Math.floor(Date.now() / 1000),
    deviceId,
  });

  logOAuthEvent({
    type: 'authorization.granted',
    userId: user.id,
    clientId,
    scope: requestedScope,
    ip: getClientAddress(),
  });

  // RFC 6749 §4.1.2 — GET redirect back to the client. Use the validated redirect_uri, never raw params.
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set('code', code.authorizationCode);
  redirectUrl.searchParams.set('state', params.state);
  redirect(303, redirectUrl.toString());
}

export const GET: RequestHandler = (event) => handle(event);
export const POST: RequestHandler = (event) => handle(event);

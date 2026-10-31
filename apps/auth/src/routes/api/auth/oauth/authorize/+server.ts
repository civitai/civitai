import { json, redirect, type RequestHandler } from '@sveltejs/kit';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { oauthServer } from '$lib/server/oauth/server';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { storeOidcContext } from '$lib/server/oauth/oidc-nonce';
import { getOrCreateDeviceId, touchAccount } from '$lib/server/auth/device';
import { familyId } from '@civitai/auth';
import { markFamilyLive } from '$lib/server/auth/lineage';
import { preUpgradeHubSession } from '$lib/server/auth/legacy-upgrade';
import { resolveAuthorizingUser } from '$lib/server/auth/pending-authz';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import {
  clientErrorUrl,
  isSkipConsentRedirectUri,
  redirectUriMatches,
} from '$lib/server/oauth/redirect-uri';
import { carriesNonUserScope, hasScope, parseScopeRequest } from '$lib/server/oauth/scope';
import { isAppBlockOauthClientId } from '$lib/server/oauth/block-guard';
import { resolveClientLite, authorizeRedirectUriStore } from '$lib/server/oauth/model';
import { checkClientAccess } from '$lib/server/oauth/access';
import { parseBody, toOAuthRequest, newOAuthResponse } from '$lib/server/oauth/http';
import { isHubPageRequest } from '$lib/server/auth/same-origin';
import { getClientIp } from '$lib/server/auth/request';
import { logAxiomError } from '$lib/server/axiom';
import { parsePrompt } from '$lib/server/oauth/prompt';

// GET /api/auth/oauth/authorize — return-after-consent + issue the authorization code.
// Ported from the main app's src/pages/api/auth/oauth/authorize.ts. The session gate uses the hub's
// locals.user (hooks.server.ts resolves it from the civ-token cookie) instead of getServerAuthSession.
//
// SECURITY (carried-forward §D.x): PKCE is REQUIRED and S256-only (the library only *verifies* a stored
// challenge, never *requires* one — a public client omitting code_challenge would otherwise get a bare,
// interceptable code); `state` is required; app-block (`appblk-`) clients are rejected before load.
//
// ERRORS (RFC 6749 §4.1.2.1): until the client and its redirect_uri check out, an error is shown here as
// JSON — redirecting to an unverified URI would make this an open redirect. After that, a registered
// client's errors go back to its redirect_uri as `?error=…&state=…`, so the app can handle it. A
// first-party spoke's errors stay JSON: its callback sends an error to its own /login, which bounces a
// signed-in user straight back here, so a redirect would loop.
//
// PROMPT (OIDC Core §3.1.2.1), space-separated:
//   none           — no hub UI at all: login_required / consent_required back to the client instead.
//   login          — a signed-out user signs in as usual. A signed-in one gets login_required: the hub
//                    doesn't record when a session last signed in, so it can't make them do it again or
//                    prove they did (OIDC Core §3.1.2.1 asks for the error when it can't).
//   consent        — show the consent screen even when a remembered consent covers the request, or the app
//                    skips consent.
//   select_account — show the consent screen's account picker, even when a remembered consent covers it.
// First-party clients have no consent screen, so `consent` and `select_account` don't apply to them.

const oauthError = (status: number, error: string, description?: string) =>
  json({ error, ...(description ? { error_description: description } : {}) }, { status });

type ResolvedClient = NonNullable<Awaited<ReturnType<typeof resolveClientLite>>>;
type VerifiedClient =
  | { error: Response }
  | { clientId: string; client: ResolvedClient; redirectUri: string };

/** An error for a client whose redirect_uri is verified: redirected back to it, or JSON for a first-party spoke. */
function clientError(
  { client, redirectUri }: { client: ResolvedClient; redirectUri: string },
  state: string | undefined,
  error: string,
  description?: string,
  status = 400
): Response {
  if (client.isFirstParty) return oauthError(status, error, description);
  redirect(303, clientErrorUrl(redirectUri, state, error, description));
}

/** Resolve the client and verify the redirect_uri — or the JSON error to show when either fails. */
async function resolveVerifiedClient(params: Record<string, string>): Promise<VerifiedClient> {
  const clientId = params.client_id;
  if (!clientId) return { error: oauthError(400, 'invalid_request', 'Missing client_id') };

  // SECURITY (A1): app-block clients can never drive the interactive authorize flow — reject before load.
  if (isAppBlockOauthClientId(clientId)) {
    return {
      error: oauthError(
        400,
        'invalid_client',
        'This client cannot be used for interactive authorization'
      ),
    };
  }

  // Resolve the client: a DB OauthClient (third-party), or a first-party client by the redirect_uri's
  // ORIGIN (its host checked against the TrustedSpokeDomain registry — exact / subdomain-wildcard / dev
  // loopback). Shared with getAuthorizationCode.
  const redirectUri = params.redirect_uri;
  const client = await resolveClientLite(clientId, redirectUri);
  if (!client) return { error: oauthError(400, 'invalid_client', 'Unknown client_id') };

  if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
    return {
      error: oauthError(400, 'invalid_request', 'redirect_uri does not match any registered URI'),
    };
  }
  return { clientId, client, redirectUri };
}

async function handle(event: Parameters<RequestHandler>[0]): Promise<Response> {
  const { request, url, locals, getClientAddress, cookies } = event;
  const method = request.method;

  const params: Record<string, string> =
    method === 'GET' ? Object.fromEntries(url.searchParams.entries()) : await parseBody(request);

  // Only the hub's consent page may approve. A third-party POST without `approved` is handled like a GET.
  if (method === 'POST' && params.approved === 'true' && !isHubPageRequest(request, url)) {
    return oauthError(403, 'access_denied', 'Approval must come from the consent page');
  }
  const isApproval = method === 'POST' && params.approved === 'true';
  // The consent page's Approve form doesn't carry `prompt`, so an approval has none.
  const prompt = parsePrompt(params.prompt);

  // Rebuild this endpoint's URL from the params so an unauthenticated user (or a consent redirect) is
  // sent somewhere that round-trips back here with the full request intact, regardless of GET vs POST.
  // The sign-in redirect below is built from it: a signed-out user who just signed in has satisfied `login`,
  // so that value is dropped; `consent` and `select_account` are still owed after signing in, so they stay.
  const self = new URL(`${url.origin}/api/auth/oauth/authorize`);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && key !== 'prompt') self.searchParams.set(key, value);
  }
  const promptAfterLogin = [...prompt].filter((p) => p !== 'login');
  if (promptAfterLogin.length > 0) self.searchParams.set('prompt', promptAfterLogin.join(' '));
  const selfUrl = `${self.pathname}${self.search}`;

  // Session gate. 303 so a POST from the consent form is downgraded to GET on /login.
  //
  // A login destined for a spoke outside this hub's cookie scope (civitai.red) deliberately does NOT write the
  // hub session — that cookie is civitai.com's session too, and re-pointing it is the cross-domain switch bug
  // (ClickUp 868kxch09). Such a login hands its identity over here instead, as a single-use record bound to
  // the spoke's registrable domain. resolveAuthorizingUser owns the precedence and the fail-closed rule.
  const user = await resolveAuthorizingUser({
    cookies,
    redirectUri: typeof params.redirect_uri === 'string' ? params.redirect_uri : undefined,
    sessionUser: locals.user,
    resolveUser: getOrProduceSessionUser,
  });
  if (!user) {
    if (prompt.has('none')) {
      // Answering needs the client looked up, which a signed-out request never did before: charge the
      // caller's IP first, as there's no user to charge.
      if (!(await checkOAuthRateLimit('authorize-anon', getClientIp(request)))) {
        return oauthError(429, 'rate_limited', 'Too many authorization requests');
      }
      const verified = await resolveVerifiedClient(params);
      if ('error' in verified) return verified.error;
      return clientError(verified, params.state, 'login_required', 'The user is not signed in');
    }
    redirect(303, `/login?returnUrl=${encodeURIComponent(selfUrl)}`);
  }

  // Rate limit by user id.
  if (!(await checkOAuthRateLimit('authorize', String(user.id)))) {
    return oauthError(429, 'rate_limited', 'Too many authorization requests');
  }

  const verified = await resolveVerifiedClient(params);
  if ('error' in verified) return verified.error;
  const { clientId, client, redirectUri } = verified;
  // From here on the redirect_uri is verified, so errors go back to the client (see ERRORS above).
  const failToClient = (error: string, description?: string, status?: number) =>
    clientError(verified, params.state, error, description, status);

  if (prompt.has('none') && prompt.size > 1) {
    return failToClient(
      'invalid_request',
      'prompt=none cannot be combined with other prompt values'
    );
  }

  // Login gating (admin-managed per client). "disabled" → nobody; "testers" → only users holding the
  // "tester" role. First-party (spoke) clients resolve to accessMode "open", so the main-site login is never
  // gated here — only third-party clients like the Comfy app. Managed at /admin/access.
  const access = await checkClientAccess(client.accessMode, user.id);
  if (!access.allowed) {
    logOAuthEvent({
      type: 'authorization.denied',
      userId: user.id,
      clientId,
      ip: getClientAddress(),
      metadata: { reason: access.reason },
    });
    return failToClient(
      'access_denied',
      access.reason === 'disabled'
        ? 'This application is not currently available.'
        : 'Access to this application is currently limited to testers.',
      403
    );
  }

  // PKCE required + S256-only (§D.x #1). Never enable plain PKCE.
  if (!params.code_challenge || !params.code_challenge_method) {
    return failToClient(
      'invalid_request',
      'PKCE required: provide code_challenge and code_challenge_method=S256'
    );
  }
  if (params.code_challenge_method !== 'S256') {
    return failToClient('invalid_request', 'Only S256 code_challenge_method is supported');
  }

  if (!params.state) {
    return failToClient('invalid_request', 'state parameter is required');
  }

  // A bitmask (`5`), scope names (`ModelsRead MediaRead`) or OIDC scopes (`openid profile`). Bounded
  // against ALL_SCOPES (incl. opt-in AppBlocksSubmit), NOT `Full`; the per-client allowedScopes
  // intersection (validateScope) is the real auth gate.
  const scopeRequest = params.scope ? parseScopeRequest(params.scope) : null;
  if (!scopeRequest) {
    return failToClient('invalid_scope', 'Invalid scope value');
  }
  // Refused before the consent screen, so a user is never asked for it and no consent row stores it.
  if (carriesNonUserScope(scopeRequest.scope)) {
    return failToClient('invalid_scope', 'This scope cannot be granted by a user');
  }
  // UserRead is the mandatory baseline (createOAuthTokenPair forces it on the issued token); force it
  // here too so the stored consent + consent screen reflect what the token actually carries.
  const requestedScope = scopeRequest.scope | TokenScope.UserRead;

  // prompt=login with a session: the hub can't force a fresh sign-in (see PROMPT above).
  if (prompt.has('login')) {
    return failToClient('login_required', 'Signing in again is not supported');
  }

  // Consent — approval MUST arrive via POST (prevents a GET-param CSRF bypass). First-party (trusted)
  // spoke clients SKIP the consent screen entirely (Phase 2): they're our own apps, so we never prompt.
  // First-party-ness is the resolved client's IDENTITY (a hub-synthesized client with no OauthClient row),
  // NOT the redirect origin — so a registered third-party client can't skip consent by claiming an owned
  // redirect host (it has a DB row → isFirstParty=false). See resolveClientLite.
  // A registered app staff marked `skipConsent` (one Civitai runs; set on /admin/access) skips it the same way,
  // but only for an https, non-loopback redirect_uri exactly as registered, and never when the request asks
  // for the consent screen (prompt=consent or select_account). Otherwise it gets the usual consent flow.
  const isFirstParty = client.isFirstParty;
  const skipsConsent = isFirstParty
    ? client.skipConsent
    : client.skipConsent &&
      client.redirectUris.includes(redirectUri) &&
      isSkipConsentRedirectUri(redirectUri) &&
      !prompt.has('consent') &&
      !prompt.has('select_account');
  const existingConsent = skipsConsent
    ? undefined
    : await db
        .selectFrom('OauthConsent')
        .select(['scope'])
        .where('userId', '=', user.id)
        .where('clientId', '=', clientId)
        .executeTakeFirst();

  if (skipsConsent) {
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
  } else if (
    !existingConsent ||
    !hasScope(existingConsent.scope, requestedScope) ||
    prompt.has('consent') ||
    prompt.has('select_account')
  ) {
    // No prior consent, the request asks for MORE than was remembered, or the client asked for the screen
    // → bounce to the consent page. (A subset of an already-granted scope is covered by the stored consent —
    // honor "remember", no re-prompt.) prompt=none forbids the screen, so it's an error instead. 303 →
    // always GET. The page gets `prompt` so it can open its account picker for select_account.
    if (prompt.has('none'))
      return failToClient('consent_required', 'The user has not approved this application');
    const consentUrl = new URL(`${url.origin}/login/oauth/authorize`);
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') consentUrl.searchParams.set(key, value);
    }
    redirect(303, consentUrl.toString());
  }

  // Issue the authorization code via the library (PKCE challenge stored, code hashed in Redis). The
  // library reads `scope` as the decimal bitmask, so it gets the parsed value, not the raw names.
  let code;
  try {
    const oauthReq = toOAuthRequest({
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: { ...params, scope: String(scopeRequest.scope), response_type: 'code' },
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
    // The library's 4xx carry a spec error name (invalid_scope, unauthorized_client…); never pass on a
    // 5xx's internal message.
    if (status >= 400 && status < 500) {
      return failToClient((err as Error).name || 'invalid_request', (err as Error).message, status);
    }
    void logAxiomError(err, { event: '[oauth/authorize] handler error' });
    return failToClient('server_error', undefined, status);
  }

  // Stash code-keyed context for the exchange:
  //  - OIDC openid/nonce + auth_time → /token mints the id_token (no-op unless the request asked for `openid`
  //    or carried a `nonce`).
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
  // The child session joins the hub session's family only when it is minted for the hub session's own user.
  const hubSession =
    isFirstParty && locals.session && Number(locals.session.sub) === user.id
      ? locals.session
      : undefined;
  const family = hubSession ? familyId(hubSession) : undefined;
  await markFamilyLive(family);
  if (locals.session && locals.sessionSlot === 'shared') {
    await preUpgradeHubSession(cookies, locals.session).catch(() => undefined);
  }
  await storeOidcContext(code.authorizationCode, {
    nonce: typeof params.nonce === 'string' ? params.nonce : undefined,
    openid: scopeRequest.openid || undefined,
    authTime: Math.floor(Date.now() / 1000),
    deviceId,
    family,
    iat0: hubSession?.iat0,
    impersonatedBy: hubSession?.impersonatedBy,
    impExp: hubSession?.impExp,
    proofFamily: isFirstParty && locals.session ? familyId(locals.session) : undefined,
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

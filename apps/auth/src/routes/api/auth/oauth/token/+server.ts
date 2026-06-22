import { json, type RequestHandler } from '@sveltejs/kit';
import { maybeCreateSessionSigner } from '@civitai/auth';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { oauthServer } from '$lib/server/oauth/server';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { OriginNotAllowedError } from '$lib/server/oauth/errors';
import { ACCESS_TOKEN_TTL } from '$lib/server/oauth/constants';
import { consumeOidcContext } from '$lib/server/oauth/oidc-nonce';
import { hasScope } from '$lib/server/oauth/scope';
import { parseBody, toOAuthRequest, newOAuthResponse, setWildcardCors, setPublicClientCors } from '$lib/server/oauth/http';

// POST /api/auth/oauth/token — authorization_code + refresh_token (+ client_credentials) grants.
// Ported from src/pages/api/auth/oauth/token.ts.
//
// OIDC id_token signer: undefined unless the hub ES256 keys are set (they always are when sessions
// work, but mirror the main app's opt-in so discovery + issuance stay in lockstep). authorization_code
// grants carrying UserRead also receive a signed id_token ("Sign in with Civitai").
const idTokenSigner = maybeCreateSessionSigner();

export const OPTIONS: RequestHandler = () => {
  const headers = new Headers();
  setWildcardCors(headers); // preflight stays permissive — we can't classify the client until the POST body
  return new Response(null, { status: 204, headers });
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const body = await parseBody(request);
  const clientId = typeof body.client_id === 'string' && body.client_id ? body.client_id : 'unknown';
  const ip = getClientAddress() || 'unknown';
  const origin = request.headers.get('origin') ?? undefined;

  // Rate-limit by IP before any DB work — keying on client_id would let an attacker rotate ids for a
  // fresh bucket each request.
  if (!(await checkOAuthRateLimit('token', ip))) {
    const headers = new Headers();
    setWildcardCors(headers);
    return json({ error: 'rate_limited', error_description: 'Too many token requests' }, { status: 429, headers });
  }

  // §D.x #2 — refresh grant must NOT forward a `scope` param. Scope is a bitmask-as-decimal-string; the
  // library's string-`.includes()` subset check is meaningless for it, so dropping `scope` lets the
  // stored scope pass through unchanged (no silent escalation or broken downgrade).
  if (body.grant_type === 'refresh_token') delete body.scope;

  // The library's token handler hard-requires `request.is('application/x-www-form-urlencoded')`, which in
  // turn needs a body-length signal (Content-Length / Transfer-Encoding). We've already parsed the body,
  // so guarantee both on the carrier headers — otherwise a reverse proxy that re-buffers the request and
  // drops Content-Length would make the library reject otherwise-valid token requests with a misleading
  // content-type error. The endpoint is form-urlencoded-only by spec, so forcing the type is correct.
  const oauthHeaders = new Headers(request.headers);
  oauthHeaders.set('content-type', 'application/x-www-form-urlencoded');
  oauthHeaders.set('content-length', String(Buffer.byteLength(new URLSearchParams(body).toString())));

  const oauthReq = toOAuthRequest({ method: 'POST', headers: oauthHeaders, body });
  const respHeaders = new Headers();

  try {
    const token = await oauthServer.token(oauthReq, newOAuthResponse());

    // getClient stashes the looked-up client on the request so we can drive CORS without a 2nd lookup.
    // Fail-closed with a fallback lookup if it's missing (library wiring change) rather than defaulting
    // to wildcard and risking a cross-origin leak of a public-client token response.
    let attached = (
      oauthReq as typeof oauthReq & {
        oauthClient?: { id: string; isConfidential: boolean; allowedOrigins: string[] };
      }
    ).oauthClient;
    if (!attached && clientId !== 'unknown') {
      attached =
        (await db
          .selectFrom('OauthClient')
          .select(['id', 'isConfidential', 'allowedOrigins'])
          .where('id', '=', clientId)
          .executeTakeFirst()) ?? undefined;
    }
    // §D.x #3 — only echo the request Origin when it's actually in the client's allowlist (defense in
    // depth: getClient already throws OriginNotAllowedError on a mismatch on the success path).
    if (attached && !attached.isConfidential && origin && attached.allowedOrigins.includes(origin)) {
      setPublicClientCors(respHeaders, origin);
    } else {
      setWildcardCors(respHeaders);
    }

    const grantType = body.grant_type;
    const scopeNum = token.scope
      ? parseInt(Array.isArray(token.scope) ? token.scope[0] : token.scope, 10)
      : undefined;
    logOAuthEvent({
      type: grantType === 'refresh_token' ? 'token.refreshed' : 'token.issued',
      userId: typeof token.user?.id === 'number' ? token.user.id : undefined,
      clientId,
      scope: scopeNum,
      ip,
    });

    // OIDC id_token — only on authorization_code (not refresh), and ONLY when the client actually requested
    // OIDC, signalled by a `nonce` on the /authorize request (our "Sign in with Civitai" flow always sets
    // one; UserRead is force-added to every token, so it can't be the openid signal). Plain OAuth API
    // clients (no nonce) get just access/refresh tokens — no signed identity assertion. The OIDC context is
    // consumed exactly once here regardless (single-use cleanup). NOTE: a nonce-less OIDC client wouldn't get
    // an id_token; if that's ever needed, add an explicit `openid` request marker.
    let idToken: string | undefined;
    if (
      idTokenSigner &&
      grantType === 'authorization_code' &&
      typeof token.user?.id === 'number' &&
      scopeNum !== undefined &&
      hasScope(scopeNum, TokenScope.UserRead)
    ) {
      const code = typeof body.code === 'string' ? body.code : undefined;
      const ctx = code ? await consumeOidcContext(code) : {};
      if (ctx.nonce) {
        idToken = await idTokenSigner.mintIdToken({
          sub: token.user.id,
          aud: clientId,
          nonce: ctx.nonce,
          authTime: ctx.authTime,
          expiresIn: token.accessTokenLifetime ?? ACCESS_TOKEN_TTL,
        });
      }
    }

    return json(
      {
        access_token: token.accessToken,
        token_type: 'Bearer',
        expires_in: token.accessTokenLifetime ?? ACCESS_TOKEN_TTL,
        refresh_token: token.refreshToken,
        scope: token.scope,
        ...(idToken ? { id_token: idToken } : {}),
      },
      { headers: respHeaders }
    );
  } catch (err) {
    if (err instanceof OriginNotAllowedError) {
      logOAuthEvent({
        type: 'origin.rejected',
        clientId: err.clientId,
        ip,
        metadata: { origin: err.origin ?? null, endpoint: 'token' },
      });
      // No CORS on a rejected origin — the browser surfaces a network error to the offending page.
      return json({ error: 'origin_not_allowed', error_description: err.message }, { status: 403 });
    }
    console.error('[oauth/token] handler error:', err);
    setWildcardCors(respHeaders);
    const e = err as { code?: number; statusCode?: number; name?: string; message?: string };
    const status = typeof e.statusCode === 'number' ? e.statusCode : typeof e.code === 'number' ? e.code : 500;
    return json(
      { error: e.name || 'server_error', error_description: e.message },
      { status, headers: respHeaders }
    );
  }
};

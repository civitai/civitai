import type {
  AuthorizationCode,
  Client,
  RefreshToken,
  Request,
  Token,
  User,
} from '@node-oauth/oauth2-server';
import { createHash, timingSafeEqual } from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { pack } from 'msgpackr';
import { REDIS_KEYS } from '@civitai/redis';
import { generateSecretHash } from '@civitai/auth/secret-hash';
import { TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { getRedis } from '$lib/server/redis';
import { ACCESS_TOKEN_TTL, AUTH_CODE_TTL, REFRESH_TOKEN_TTL } from './constants';
import { createOAuthTokenPair } from './token-helpers';
import { OriginNotAllowedError } from './errors';
import { redirectUriMatches } from './redirect-uri';
import { firstPartyClientForOrigin, originOf } from './first-party';
import { hasScope, scopeToString, stringToScope } from './scope';
import { hSetWithTTL, type EvalCapableClient } from './redis-atomic';

// Ported from the main app's src/server/oauth/model.ts. Every `prisma.*` call is rewritten to Kysely
// against the shared `DB` schema; redis comes from the hub's getRedis(); hashing + scope + token TTLs are
// the SHARED definitions (@civitai/auth, ./constants), so tokens the hub mints validate in the main app's
// bearer path unchanged. Behaviour is intended to be 1:1 with the Prisma original — see the parity tests.

/** Hash auth code for Redis storage (separate from API key hashing) */
function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

// @node-oauth/oauth2-server's authorize handler calls `model.getClient(clientId, null)` WITHOUT forwarding the
// request (authorize-handler.js — only the token handler passes it). A SYNTHESIZED first-party client has no
// DB row and is resolved from the redirect_uri's ORIGIN, so without the request getClient has nothing to
// resolve from and the library throws "Invalid client: client credentials are invalid". The /authorize
// endpoint sets the request's redirect_uri here around the `oauthServer.authorize()` call so getClient can
// fall back to it. AsyncLocalStorage scopes it to the in-flight request (no cross-request race on the shared
// model singleton).
export const authorizeRedirectUriStore = new AsyncLocalStorage<string>();

// Combined model interface — the library accepts any object with these methods
export const oauthModel = {
  // ─── Client ─────────────────────────────────────────────────

  async getClient(
    clientId: string,
    clientSecret: string | null,
    request?: Request
  ): Promise<Client | false> {
    const client = await db
      .selectFrom('OauthClient')
      .selectAll()
      .where('id', '=', clientId)
      .executeTakeFirst();
    if (!client) {
      // First-party clients have no generic OauthClient row. Resolve by the request's redirect_uri ORIGIN
      // (its host checked against the TrustedSpokeDomain registry — exact / subdomain-wildcard / dev
      // loopback), requiring the client_id to be the one derived from that origin (consistency). They're
      // public (no secret) and only reached on the /authorize nav, so return the synthesized client.
      // The library's authorize handler doesn't forward the request, so fall back to the redirect_uri the
      // /authorize endpoint stashed in AsyncLocalStorage for exactly this call.
      const origin =
        redirectOriginFromRequest(request) ?? originOf(authorizeRedirectUriStore.getStore());
      const fp = origin ? await firstPartyClientForOrigin(origin) : undefined;
      if (!fp || fp.clientId !== clientId) return false;
      return {
        id: fp.clientId,
        grants: fp.grants,
        redirectUris: [fp.redirectUri],
        accessTokenLifetime: ACCESS_TOKEN_TTL,
        refreshTokenLifetime: REFRESH_TOKEN_TTL,
        allowedScopes: fp.allowedScopes,
        isConfidential: fp.isConfidential,
      } as Client;
    }

    // The library passes `null` from the authorize handler (client_secret is not
    // sent on /authorize per OAuth spec) and a string (or undefined) from the
    // token handler. Only validate the secret when the library actually had one
    // to pass — i.e. the token-endpoint code path.
    if (clientSecret !== null) {
      if (client.isConfidential) {
        if (!clientSecret || !client.secret) return false;
        const hashedSecret = generateSecretHash(clientSecret);
        // timingSafeEqual THROWS on a length mismatch (→ a 500 instead of an auth failure). Both are
        // 128-char sha512 hex in practice, but a legacy/plaintext stored secret would differ in length;
        // guard the length so we fail CLOSED rather than 500.
        const a = Buffer.from(hashedSecret);
        const b = Buffer.from(client.secret);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
      }
    }

    // For public clients on the token-exchange path, enforce the per-client
    // origin allowlist — but only when the request actually carries an
    // Origin header. Confidential clients skip this entirely; their auth
    // boundary is `client_secret`, not the browser.
    //
    // Policy: an Origin that *is* sent must be in the registered allowlist.
    // A missing Origin is allowed because:
    //   - Native/mobile PKCE clients don't send one — they're public clients
    //     too and must work through the same /token endpoint as browser SPAs.
    //   - A browser that mysteriously strips its own Origin is already
    //     compromised at a level where this check can't help.
    // This also lets a single OAuth client back both a browser SPA (covered
    // by the allowlist) and a native app (covered by the no-Origin branch)
    // so end users don't have to consent twice.
    //
    // The /authorize flow also calls getClient with a Request (constructed
    // server-side with synthetic headers) but it's a top-level browser nav,
    // not an XHR, so PKCE alone handles its security boundary. Detect
    // token-exchange by the presence of `grant_type` in the request body —
    // set on /api/auth/oauth/token requests. /revoke uses
    // `token`/`token_type_hint` per RFC 7009 and doesn't go through this
    // model at all (it's hand-coded against the OauthClient table directly).
    const body = request ? (request as Request & { body?: unknown }).body : undefined;
    const isTokenExchange =
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { grant_type?: unknown }).grant_type === 'string';
    if (request && !client.isConfidential && isTokenExchange) {
      const headers = (request as Request).headers;
      const origin =
        headers && typeof headers.origin === 'string' ? (headers.origin as string) : undefined;
      if (origin && !client.allowedOrigins.includes(origin)) {
        throw new OriginNotAllowedError(client.id, origin);
      }
    }

    // Stash the looked-up client on the Request so the handler can drive
    // post-success CORS without a second DB lookup. The OAuth library treats
    // `request` as an opaque carrier, so attaching a property is safe.
    if (request) {
      (request as Request & { oauthClient?: typeof client }).oauthClient = client;
    }

    return {
      id: client.id,
      grants: client.grants,
      redirectUris: client.redirectUris,
      accessTokenLifetime: ACCESS_TOKEN_TTL,
      refreshTokenLifetime: REFRESH_TOKEN_TTL,
      allowedScopes: client.allowedScopes,
      isConfidential: client.isConfidential,
    } as Client;
  },

  // The library validates redirect_uri against client.redirectUris with an exact
  // `includes` by default; override so loopback redirects get RFC 8252 §7.3 port
  // flexibility (matching the custom pre-check in /api/auth/oauth/authorize).
  async validateRedirectUri(redirectUri: string, client: Client): Promise<boolean> {
    const registeredUris = Array.isArray(client.redirectUris)
      ? client.redirectUris
      : client.redirectUris
      ? [client.redirectUris]
      : [];
    return redirectUriMatches(registeredUris, redirectUri);
  },

  // ─── Authorization Code ─────────────────────────────────────

  async saveAuthorizationCode(
    code: AuthorizationCode,
    client: Client,
    user: User
  ): Promise<AuthorizationCode> {
    const redis = getRedis();
    // Fail closed: an authorization code we cannot store is worse than no code — issuing one we can't
    // later validate would hand the client an un-redeemable code (and the original relied on Redis being
    // present for OAuth at all).
    if (!redis)
      throw new Error('OAuth authorization code store unavailable (REDIS_URL not configured)');

    const hashedCode = hashCode(code.authorizationCode);
    // Normalize to the canonical single decimal-string bitmask via the shared scope decoder, rather than blindly
    // taking scope[0]: stringToScope validates + range-clamps (out-of-range/NaN → 0/deny) and collapses the
    // string|string[] representation consistently with how getAuthorizationCode reads it back. Avoids silently
    // storing an unvalidated or multi-element scope value.
    const scopeValue = String(stringToScope(code.scope as string | string[] | undefined));

    const data = {
      clientId: client.id,
      userId: user.id,
      scope: scopeValue,
      redirectUri: code.redirectUri,
      codeChallenge: code.codeChallenge,
      codeChallengeMethod: code.codeChallengeMethod,
      expiresAt: code.expiresAt.toISOString(),
    };

    // Atomic packed-write: pack the value and pipe it through the single-EVAL helper (HSET + HPEXPIRE).
    // Replaces a sequential hSet + hExpire, which could leave a no-TTL authorization code in Redis if the
    // process is killed between awaits — a security finding for OAuth codes that are intended to be
    // single-use and short-lived (AUTH_CODE_TTL = 10 minutes).
    await hSetWithTTL(
      redis as unknown as EvalCapableClient,
      REDIS_KEYS.OAUTH.AUTHORIZATION_CODES,
      hashedCode,
      pack(data),
      AUTH_CODE_TTL * 1000
    );

    return { ...code, client, user };
  },

  async getAuthorizationCode(authorizationCode: string): Promise<AuthorizationCode | false> {
    const redis = getRedis();
    if (!redis) return false;

    const hashedCode = hashCode(authorizationCode);
    const data = await redis.packed.hGet<{
      clientId: string;
      userId: number;
      scope: string;
      redirectUri: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
      expiresAt: string;
    }>(REDIS_KEYS.OAUTH.AUTHORIZATION_CODES, hashedCode);

    if (!data) return false;

    // Resolve the code's client (DB, or first-party by the stored redirect_uri origin) — shared with /authorize.
    const client = await resolveClientLite(data.clientId, data.redirectUri);
    if (!client) return false;

    return {
      authorizationCode,
      expiresAt: new Date(data.expiresAt),
      redirectUri: data.redirectUri,
      scope: [data.scope],
      codeChallenge: data.codeChallenge,
      codeChallengeMethod: data.codeChallengeMethod,
      client: client as Client,
      user: { id: data.userId },
    } as unknown as AuthorizationCode;
  },

  async revokeAuthorizationCode(code: AuthorizationCode): Promise<boolean> {
    const redis = getRedis();
    if (!redis) return true; // nothing to revoke
    const hashedCode = hashCode(code.authorizationCode);
    // Return whether THIS call actually removed the field. HDEL is atomic in Redis, so under concurrent
    // redemption of the same code exactly one caller gets a non-zero count — the others get 0. Callers can
    // gate single-use on this (the first-party /session exchange does, closing a get-then-delete TOCTOU),
    // and it also tightens the library's authorization_code replay protection.
    const removed = await redis.hDel(REDIS_KEYS.OAUTH.AUTHORIZATION_CODES, hashedCode);
    return Number(removed) > 0;
  },

  // ─── Tokens ─────────────────────────────────────────────────

  async saveToken(token: Token, client: Client, user: User): Promise<Token> {
    const scope = stringToScope(token.scope as unknown as string);

    const pair = await createOAuthTokenPair(user.id, client.id, scope);

    return {
      accessToken: pair.accessToken,
      accessTokenExpiresAt: pair.accessTokenExpiresAt,
      refreshToken: pair.refreshToken,
      refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
      scope: scopeToString(scope),
      client,
      user,
    } as Token;
  },

  async getAccessToken(accessToken: string): Promise<Token | false> {
    const hash = generateSecretHash(accessToken);
    const now = new Date();

    const apiKey = await db
      .selectFrom('ApiKey')
      .select(['userId', 'tokenScope', 'expiresAt', 'clientId'])
      .where('key', '=', hash)
      .where('type', '=', 'Access')
      .where((eb) => eb.or([eb('expiresAt', '>=', now), eb('expiresAt', 'is', null)]))
      .executeTakeFirst();

    if (!apiKey) return false;

    return {
      accessToken,
      accessTokenExpiresAt: apiKey.expiresAt ?? undefined,
      scope: scopeToString(apiKey.tokenScope),
      client: { id: apiKey.clientId ?? '' } as Client,
      user: { id: apiKey.userId },
    } as unknown as Token;
  },

  async getRefreshToken(refreshToken: string): Promise<RefreshToken | false> {
    const hash = generateSecretHash(refreshToken);
    const now = new Date();

    const apiKey = await db
      .selectFrom('ApiKey')
      .select(['userId', 'tokenScope', 'expiresAt', 'clientId'])
      .where('key', '=', hash)
      .where('type', '=', 'Refresh')
      .where((eb) => eb.or([eb('expiresAt', '>=', now), eb('expiresAt', 'is', null)]))
      .executeTakeFirst();

    if (!apiKey) return false;

    return {
      refreshToken,
      refreshTokenExpiresAt: apiKey.expiresAt ?? undefined,
      scope: scopeToString(apiKey.tokenScope),
      client: { id: apiKey.clientId ?? '' } as Client,
      user: { id: apiKey.userId },
    } as unknown as RefreshToken;
  },

  async revokeToken(token: RefreshToken): Promise<boolean> {
    // Called by @node-oauth on ROUTINE refresh-token rotation — the library retires the old refresh
    // token here before minting the new pair. Delete ONLY the rotated refresh token; already-issued
    // access tokens age out on their 1h TTL.
    //
    // We deliberately do NOT cascade-delete every Access row for this (user, client) here. That blunt
    // cascade is the EXPLICIT-revocation semantic — "remove this app's access" — and now lives solely in
    // the /revoke endpoint handler (RFC 7009), where it's the intended action. Doing it on every routine
    // rotation logged a user out of a second concurrent session under the same client (e.g. phone +
    // laptop). Resolved 2026-06-19 — see docs/auth/oauth-provider-implementation-checklist.md §D.x.
    const hash = generateSecretHash(token.refreshToken);
    const deleted = await db
      .deleteFrom('ApiKey')
      .where('key', '=', hash)
      .where('type', '=', 'Refresh')
      .executeTakeFirst();

    return Number(deleted.numDeletedRows ?? 0n) > 0;
  },

  // ─── Client Credentials ─────────────────────────────────────

  async getUserFromClient(client: Client): Promise<User | false> {
    // For client_credentials grant, the "user" is the client owner
    const oauthClient = await db
      .selectFrom('OauthClient')
      .select(['userId', 'grants'])
      .where('id', '=', client.id)
      .executeTakeFirst();

    if (!oauthClient || !oauthClient.grants.includes('client_credentials')) {
      return false;
    }

    return { id: oauthClient.userId };
  },

  // ─── Scope Validation ──────────────────────────────────────

  async validateScope(_user: User, client: Client, scope: string[]): Promise<string[] | false> {
    // UserRead is always granted as a baseline (see createOAuthTokenPair).
    // Force it into both the requested and allowed sets so it propagates to
    // the issued token and never trips the allowed-scope check even for
    // clients that didn't register UserRead in allowedScopes.
    const requestedScope = stringToScope(scope) | TokenScope.UserRead;
    // Default a MISSING ceiling to UserRead (read-only), NOT Full — the safer fallback for third-party
    // clients. First-party clients are unaffected: they carry an explicit `Full` ceiling (the synthesized
    // first-party client). The OauthClient.allowedScopes column is NOT NULL, so this fallback is unreachable
    // for real rows — it's purely fail-safe.
    const allowedScopes =
      ((client as Client & { allowedScopes?: number }).allowedScopes ?? TokenScope.UserRead) |
      TokenScope.UserRead;

    if (!hasScope(allowedScopes, requestedScope)) {
      return false;
    }

    return scopeToString(requestedScope);
  },

  async verifyScope(token: Token, scope: string | string[]): Promise<boolean> {
    const tokenScope = stringToScope(token.scope as unknown as string);
    const requiredScope = stringToScope(scope as unknown as string);
    return hasScope(tokenScope, requiredScope);
  },
};

/**
 * Resolve a client to the lite shape ({ id, grants, redirectUris }) needed for code issuance + redirect_uri
 * validation, from the DB OR the first-party source seam. Single definition so the DB→first-party fallback
 * can't drift across `getAuthorizationCode` and the `/authorize` endpoint. (`getClient` keeps its own
 * resolution because it returns the richer Client + runs the secret/origin checks.)
 */
export async function resolveClientLite(
  clientId: string,
  redirectUri?: string
): Promise<
  | { id: string; grants: string[]; redirectUris: string[]; isFirstParty: boolean; accessMode: string }
  | undefined
> {
  const dbClient = await db
    .selectFrom('OauthClient')
    .select(['id', 'grants', 'redirectUris', 'accessMode'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (dbClient) {
    // A REGISTERED client (it has an OauthClient row) is third-party BY DEFINITION — `isFirstParty: false`
    // even if its redirect_uri origin is a trusted spoke domain. First-party-ness is a client IDENTITY (a
    // hub-synthesized client with no DB row), never a property of the redirect host, which a third-party
    // picks freely at registration. The /authorize consent-skip and /session session-mint gate on THIS flag,
    // so a third-party can never inherit first-party privileges by claiming an owned redirect origin.
    return {
      id: dbClient.id,
      grants: dbClient.grants,
      redirectUris: dbClient.redirectUris,
      isFirstParty: false,
      accessMode: dbClient.accessMode,
    };
  }
  // First-party: NO DB row, resolved purely from the redirect_uri ORIGIN (host checked against the registry),
  // requiring the client_id to be the one derived from that origin. This synthesized path is the ONLY
  // first-party case.
  const origin = originOf(redirectUri);
  const fp = origin ? await firstPartyClientForOrigin(origin) : undefined;
  return fp && fp.clientId === clientId
    ? {
        id: fp.clientId,
        grants: fp.grants,
        redirectUris: [fp.redirectUri],
        isFirstParty: true,
        // First-party (spoke) clients are never gated — they're our own login hosts.
        accessMode: 'open',
      }
    : undefined;
}

/** Extract the redirect_uri's origin from an OAuth library Request (body or query). */
function redirectOriginFromRequest(request?: Request): string | undefined {
  if (!request) return undefined;
  const r = request as Request & {
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
  };
  const ru = (r.body && r.body.redirect_uri) ?? (r.query && r.query.redirect_uri);
  return typeof ru === 'string' ? originOf(ru) : undefined;
}

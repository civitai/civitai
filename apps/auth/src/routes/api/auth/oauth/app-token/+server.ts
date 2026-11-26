import { json, type RequestHandler } from '@sveltejs/kit';
import { parseTokenScope, TokenScope } from '@civitai/auth/token-scope';
import { isAppAssistantClientAllowedFor } from '@civitai/auth/app-assistant-client';
import { db } from '$lib/server/db/db';
import { isInternalRequest } from '$lib/server/auth/internal';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { getClientIp } from '$lib/server/auth/request';
import { parseBody } from '$lib/server/oauth/http';
import { hasScope, isScopeGrantable, scopeFromColumn } from '$lib/server/oauth/scope';
import {
  checkOAuthRateLimit,
  oauthRetryAfter,
  rateLimitedResponse,
} from '$lib/server/oauth/rate-limit';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { AppBlockSuspendedError, createAppAccessToken } from '$lib/server/oauth/token-helpers';
import { MemorializedAccountError } from '$lib/server/auth/account-refusal';
import { isOfflineGrantOn } from '$lib/server/oauth/offline-grant';
import {
  APP_TOKEN_DEFAULT_TTL,
  APP_TOKEN_MAX_TTL,
  SERVICE_GRANT,
} from '$lib/server/oauth/constants';

// Consent is re-checked here (not trusted from the caller) so a leaked AUTH_INTERNAL_TOKEN can't mint beyond
// what the user granted.

const bad = (error: string, description?: string, status = 400) =>
  json({ error, ...(description ? { error_description: description } : {}) }, { status });

export const POST: RequestHandler = async ({ request }) => {
  if (!isInternalRequest(request)) return bad('unauthorized', undefined, 401);

  const body = (await parseBody(request)) as Record<string, unknown>;
  if (body.impersonatedBy != null)
    return bad('impersonation_refused', 'Apps are paused while impersonating', 403);
  const userId = Number(body.userId);
  const clientId = typeof body.clientId === 'string' ? body.clientId : '';
  // A JSON number (or a decimal string), bounded against ALL_SCOPES (incl. the opt-in bits).
  const requestedScope = parseTokenScope(body.scope);
  const ttlSeconds =
    body.ttlSeconds === undefined ? APP_TOKEN_DEFAULT_TTL : Number(body.ttlSeconds);

  if (!Number.isInteger(userId) || userId <= 0 || !clientId) {
    return bad('invalid_request', 'userId and clientId are required');
  }
  // An App Assistant client mints only for the user its id names, whatever consents exist.
  if (!isAppAssistantClientAllowedFor(clientId, userId)) {
    return bad('invalid_client', 'Unknown client');
  }
  if (requestedScope === null) {
    return bad('invalid_scope', 'Invalid scope value');
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > APP_TOKEN_MAX_TTL) {
    return bad('invalid_request', `ttlSeconds must be between 1 and ${APP_TOKEN_MAX_TTL}`);
  }

  if (!(await checkOAuthRateLimit('app-token', `${userId}:${clientId}`))) {
    return rateLimitedResponse(
      oauthRetryAfter('app-token'),
      undefined,
      'Too many app token requests'
    );
  }

  const client = await db
    .selectFrom('OauthClient')
    .select(['allowedScopes', 'accessMode', 'grants'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!client) return bad('invalid_client', 'Unknown client');
  // A service client acts only as itself, never for a user.
  if (client.grants.includes(SERVICE_GRANT)) return bad('invalid_client', 'Unknown client');
  if (client.accessMode === 'disabled') {
    return bad('access_denied', 'This application is not currently available.', 403);
  }

  const scope = requestedScope | TokenScope.UserRead;
  if (!isScopeGrantable(scopeFromColumn(client.allowedScopes), scope, 'user')) {
    return bad('invalid_scope', 'Scope exceeds what the client is allowed');
  }

  const consent = await db
    .selectFrom('OauthConsent')
    .select(['scope'])
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .executeTakeFirst();
  if (!consent || !hasScope(scopeFromColumn(consent.scope), scope))
    return bad('consent_required', undefined, 403);

  const user = await getOrProduceSessionUser(userId).catch(() => null);
  if (!user || user.bannedAt || user.deletedAt) {
    return bad('access_denied', 'Account unavailable', 403);
  }

  let minted: Awaited<ReturnType<typeof createAppAccessToken>>;
  try {
    minted = await createAppAccessToken(userId, clientId, scope, ttlSeconds, {
      refuseSuspendedAppBlock: true,
      // Offline-grant flag on: the token records that it was minted for a user on the site.
      ...((await isOfflineGrantOn()) && { mintOrigin: 'app_token' as const }),
    });
  } catch (err) {
    if (err instanceof AppBlockSuspendedError) {
      return bad('access_denied', 'This application is not currently available.', 403);
    }
    if (err instanceof MemorializedAccountError) {
      return bad('access_denied', 'Account unavailable', 403);
    }
    throw err;
  }
  const { accessToken, expiresAt } = minted;

  logOAuthEvent({
    type: 'token.issued',
    userId,
    clientId,
    scope,
    ip: getClientIp(request) ?? 'unknown',
    metadata: { grant_type: 'app_token' },
  });

  return json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: ttlSeconds,
    expires_at: expiresAt.toISOString(),
    scope: Number(scope),
  });
};

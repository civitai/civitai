import { json, type RequestHandler } from '@sveltejs/kit';
import { ALL_SCOPES, TokenScope } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { isInternalRequest } from '$lib/server/auth/internal';
import { getOrProduceSessionUser } from '$lib/server/auth/session-producer';
import { getClientIp } from '$lib/server/auth/request';
import { parseBody } from '$lib/server/oauth/http';
import { hasScope } from '$lib/server/oauth/scope';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { createAppAccessToken } from '$lib/server/oauth/token-helpers';
import { APP_TOKEN_DEFAULT_TTL, APP_TOKEN_MAX_TTL } from '$lib/server/oauth/constants';

// Consent is re-checked here (not trusted from the caller) so a leaked AUTH_INTERNAL_TOKEN can't mint beyond
// what the user granted.

const bad = (error: string, description?: string, status = 400) =>
  json({ error, ...(description ? { error_description: description } : {}) }, { status });

export const POST: RequestHandler = async ({ request }) => {
  if (!isInternalRequest(request)) return bad('unauthorized', undefined, 401);

  const body = (await parseBody(request)) as Record<string, unknown>;
  const userId = Number(body.userId);
  const clientId = typeof body.clientId === 'string' ? body.clientId : '';
  const requestedScope = Number(body.scope);
  const ttlSeconds =
    body.ttlSeconds === undefined ? APP_TOKEN_DEFAULT_TTL : Number(body.ttlSeconds);

  if (!Number.isInteger(userId) || userId <= 0 || !clientId) {
    return bad('invalid_request', 'userId and clientId are required');
  }
  if (!Number.isInteger(requestedScope) || requestedScope < 0 || requestedScope > ALL_SCOPES) {
    return bad('invalid_scope', 'Invalid scope value');
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > APP_TOKEN_MAX_TTL) {
    return bad('invalid_request', `ttlSeconds must be between 1 and ${APP_TOKEN_MAX_TTL}`);
  }

  if (!(await checkOAuthRateLimit('app-token', `${userId}:${clientId}`))) {
    return bad('rate_limited', 'Too many app token requests', 429);
  }

  const client = await db
    .selectFrom('OauthClient')
    .select(['allowedScopes', 'accessMode'])
    .where('id', '=', clientId)
    .executeTakeFirst();
  if (!client) return bad('invalid_client', 'Unknown client');
  if (client.accessMode === 'disabled') {
    return bad('access_denied', 'This application is not currently available.', 403);
  }

  const scope = requestedScope | TokenScope.UserRead;
  if (!hasScope(client.allowedScopes | TokenScope.UserRead, scope)) {
    return bad('invalid_scope', 'Scope exceeds what the client is allowed');
  }

  const consent = await db
    .selectFrom('OauthConsent')
    .select(['scope'])
    .where('userId', '=', userId)
    .where('clientId', '=', clientId)
    .executeTakeFirst();
  if (!consent || !hasScope(consent.scope, scope)) return bad('consent_required', undefined, 403);

  const user = await getOrProduceSessionUser(userId).catch(() => null);
  if (!user || user.bannedAt || user.deletedAt) {
    return bad('access_denied', 'Account unavailable', 403);
  }

  const { accessToken, expiresAt } = await createAppAccessToken(
    userId,
    clientId,
    scope,
    ttlSeconds
  );

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
    scope,
  });
};

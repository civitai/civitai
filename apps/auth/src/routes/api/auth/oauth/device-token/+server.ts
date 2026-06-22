import { json, type RequestHandler } from '@sveltejs/kit';
import { REDIS_KEYS } from '@civitai/redis';
import { TokenScope, ALL_SCOPES } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { getRedis } from '$lib/server/redis';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { logOAuthEvent } from '$lib/server/oauth/audit-log';
import { createOAuthTokenPair } from '$lib/server/oauth/token-helpers';
import { ACCESS_TOKEN_TTL } from '$lib/server/oauth/constants';
import { hasScope } from '$lib/server/oauth/scope';
import { parseBody, setWildcardCors } from '$lib/server/oauth/http';

// POST /api/auth/oauth/device-token — device-flow token poll. Ported from device-token.ts.
const DEVICE_CODE_KEY = REDIS_KEYS.OAUTH.DEVICE_CODES;

export const OPTIONS: RequestHandler = () => {
  const headers = new Headers();
  setWildcardCors(headers);
  return new Response(null, { status: 204, headers });
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
  const headers = new Headers();
  setWildcardCors(headers);

  const { grant_type, device_code, client_id } = await parseBody(request);

  if (grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
    return json({ error: 'unsupported_grant_type' }, { status: 400, headers });
  }
  if (!device_code || !client_id) {
    return json({ error: 'invalid_request' }, { status: 400, headers });
  }

  if (!(await checkOAuthRateLimit('token', client_id))) {
    return json({ error: 'rate_limited' }, { status: 429, headers });
  }

  const redis = getRedis();
  if (!redis) return json({ error: 'expired_token', error_description: 'Device code expired' }, { status: 400, headers });

  const data = await redis.packed.hGet<{
    clientId: string;
    userCode: string;
    scope: string;
    status: 'pending' | 'approved' | 'denied';
    userId: number | null;
    expiresAt: string;
  }>(DEVICE_CODE_KEY, device_code);

  if (!data) return json({ error: 'expired_token', error_description: 'Device code expired' }, { status: 400, headers });
  if (data.clientId !== client_id) return json({ error: 'invalid_grant' }, { status: 400, headers });
  if (new Date(data.expiresAt) < new Date()) {
    await redis.hDel(DEVICE_CODE_KEY, device_code);
    return json({ error: 'expired_token' }, { status: 400, headers });
  }
  if (data.status === 'denied') {
    await redis.hDel(DEVICE_CODE_KEY, device_code);
    return json({ error: 'access_denied' }, { status: 400, headers });
  }
  if (data.status === 'pending') {
    return json({ error: 'authorization_pending' }, { status: 400, headers });
  }

  // status === 'approved'
  if (!data.userId) return json({ error: 'server_error' }, { status: 400, headers });

  const rawScope = parseInt(data.scope, 10);
  // Bound against ALL_SCOPES (incl. opt-in AppBlocksSubmit), NOT `Full`; the client allowedScopes gate below
  // is the real authorization.
  if (isNaN(rawScope) || rawScope < 0 || rawScope > ALL_SCOPES) {
    return json({ error: 'invalid_scope' }, { status: 400, headers });
  }
  const scope = rawScope;

  const client = await db
    .selectFrom('OauthClient')
    .select(['allowedScopes'])
    .where('id', '=', client_id)
    .executeTakeFirst();
  // Fail closed: the client may have been deleted within the device-code TTL window. Never mint a token
  // for an unknown client (the main app proceeded here — tightened for the reusable provider).
  if (!client) {
    return json({ error: 'invalid_grant', error_description: 'Unknown client' }, { status: 400, headers });
  }
  // Allow UserRead as the mandatory baseline (consistent with /device init), then enforce the ceiling.
  if (!hasScope(client.allowedScopes | TokenScope.UserRead, scope)) {
    return json({ error: 'invalid_scope', error_description: 'Requested scope exceeds client permissions' }, { status: 400, headers });
  }

  const pair = await createOAuthTokenPair(data.userId, client_id, scope);
  await redis.hDel(DEVICE_CODE_KEY, device_code);

  logOAuthEvent({
    type: 'token.issued',
    userId: data.userId,
    clientId: client_id,
    scope,
    ip: getClientAddress(),
    metadata: { grant_type: 'device_code' },
  });

  return json(
    {
      access_token: pair.accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: pair.refreshToken,
      scope: scope.toString(),
    },
    { headers }
  );
};

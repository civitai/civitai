import { json, type RequestHandler } from '@sveltejs/kit';
import { randomBytes, randomInt } from 'crypto';
import { REDIS_KEYS } from '@civitai/redis';
import { TokenScope, ALL_SCOPES } from '@civitai/auth/token-scope';
import { db } from '$lib/server/db/db';
import { getRedis } from '$lib/server/redis';
import { checkOAuthRateLimit } from '$lib/server/oauth/rate-limit';
import { DEVICE_CODE_TTL, DEVICE_POLL_INTERVAL } from '$lib/server/oauth/constants';
import { hasScope } from '$lib/server/oauth/scope';
import { isAppBlockOauthClientId } from '$lib/server/oauth/block-guard';
import { setWildcardCors } from '$lib/server/oauth/http';

// POST /api/auth/oauth/device — RFC 8628 device authorization. Ported from
// src/pages/api/auth/oauth/device.ts.
const DEVICE_CODE_KEY = REDIS_KEYS.OAUTH.DEVICE_CODES;

function generateUserCode(): string {
  // 8 chars from a 32-char no-confusable alphabet (no I/O/0/1), grouped XXXX-XXXX. randomInt does
  // rejection sampling internally → no modulo bias regardless of alphabet size.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[randomInt(chars.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export const OPTIONS: RequestHandler = () => {
  const headers = new Headers();
  setWildcardCors(headers);
  return new Response(null, { status: 204, headers });
};

export const POST: RequestHandler = async ({ request, url }) => {
  const headers = new Headers();
  setWildcardCors(headers);

  const body = await request.formData().then(
    (f) => Object.fromEntries([...f.entries()].map(([k, v]) => [k, String(v)])),
    () => ({}) as Record<string, string>
  );
  const client_id = body.client_id;
  const scope = body.scope;

  if (!client_id) {
    return json({ error: 'invalid_request', error_description: 'Missing client_id' }, { status: 400, headers });
  }
  // SECURITY (A1): app-block clients can never use the device flow (they carry grants:[] too, but reject
  // explicitly before the DB lookup).
  if (isAppBlockOauthClientId(client_id)) {
    return json({ error: 'invalid_client', error_description: 'This client cannot be used for the device flow' }, { status: 400, headers });
  }

  if (!(await checkOAuthRateLimit('token', client_id))) {
    return json({ error: 'rate_limited' }, { status: 429, headers });
  }

  const client = await db.selectFrom('OauthClient').selectAll().where('id', '=', client_id).executeTakeFirst();
  if (!client) {
    return json({ error: 'invalid_client', error_description: 'Unknown client' }, { status: 400, headers });
  }
  if (!client.grants.includes('urn:ietf:params:oauth:grant-type:device_code')) {
    return json({ error: 'unauthorized_client', error_description: 'Client not authorized for device flow' }, { status: 400, headers });
  }

  const rawScope = parseInt(scope, 10) || 0;
  // Bound against ALL_SCOPES (incl. opt-in AppBlocksSubmit), NOT `Full`; allowedScopes is the real gate.
  if (rawScope < 0 || rawScope > ALL_SCOPES) {
    return json({ error: 'invalid_scope' }, { status: 400, headers });
  }
  // UserRead baseline, always allowed.
  const requestedScope = rawScope | TokenScope.UserRead;
  const allowedScopes = client.allowedScopes | TokenScope.UserRead;
  if (requestedScope > 0 && !hasScope(allowedScopes, requestedScope)) {
    return json({ error: 'invalid_scope', error_description: 'Requested scope exceeds client permissions' }, { status: 400, headers });
  }

  const redis = getRedis();
  if (!redis) {
    // Fail closed: the device flow can't function without its Redis store.
    return json({ error: 'server_error' }, { status: 500, headers });
  }

  const deviceCode = randomBytes(32).toString('hex');
  const userCode = generateUserCode();

  await redis.packed.hSet(DEVICE_CODE_KEY, deviceCode, {
    clientId: client_id,
    userCode,
    scope: requestedScope.toString(),
    status: 'pending',
    userId: null,
    expiresAt: new Date(Date.now() + DEVICE_CODE_TTL * 1000).toISOString(),
  });
  await redis.hExpire(DEVICE_CODE_KEY, deviceCode, DEVICE_CODE_TTL);
  await redis.packed.hSet(REDIS_KEYS.OAUTH.DEVICE_USER_CODES, userCode, deviceCode);
  await redis.hExpire(REDIS_KEYS.OAUTH.DEVICE_USER_CODES, userCode, DEVICE_CODE_TTL);

  return json(
    {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${url.origin}/login/oauth/device`,
      verification_uri_complete: `${url.origin}/login/oauth/device?code=${userCode}`,
      expires_in: DEVICE_CODE_TTL,
      interval: DEVICE_POLL_INTERVAL,
    },
    { headers }
  );
};

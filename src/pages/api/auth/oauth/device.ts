import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { randomBytes, randomInt } from 'crypto';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { dbRead } from '~/server/db/client';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';
import { checkOAuthRateLimit, sendRateLimitResponse } from '~/server/oauth/rate-limit';
import { DEVICE_CODE_TTL, DEVICE_POLL_INTERVAL } from '~/server/oauth/constants';
import { Flags } from '~/shared/utils/flags';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { isAppBlockOauthClientId } from '~/shared/constants/block-scope.constants';
import { env } from '~/env/server';

const DEVICE_CODE_KEY = REDIS_KEYS.OAUTH.DEVICE_CODES;

function generateUserCode(): string {
  // 8-char alphanumeric code, grouped as XXXX-XXXX for readability.
  // Using `crypto.randomInt(chars.length)` instead of `randomBytes() % len`
  // avoids modulo bias — safe regardless of alphabet size, since
  // randomInt does rejection sampling internally. Today the alphabet is 32
  // chars (a power of 2, so a plain modulo would also be unbiased), but the
  // rejection-sampling path is robust if the alphabet ever changes.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 to avoid confusion
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[randomInt(chars.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  const shouldStop = addCorsHeaders(req, res, ['POST']);
  if (shouldStop) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { client_id, scope } = req.body;

  if (!client_id) {
    return res
      .status(400)
      .json({ error: 'invalid_request', error_description: 'Missing client_id' });
  }

  // SECURITY (audit A1): App-Blocks-provisioned OauthClients (`appblk-<slug>`)
  // are block-token-only. They carry grants:[] so the device-flow grant check
  // below already rejects them, but reject explicitly here too (and before the
  // DB lookup) so the boundary is unambiguous and defense-in-depth. Scoped to
  // `appblk-` ids only — genuine OAuth-apps clients are unaffected.
  if (isAppBlockOauthClientId(client_id)) {
    return res.status(400).json({
      error: 'invalid_client',
      error_description: 'This client cannot be used for the device flow',
    });
  }

  // Rate limit
  const allowed = await checkOAuthRateLimit(req, res, 'token', client_id);
  if (!allowed) return sendRateLimitResponse(res);

  // Validate client
  const client = await dbRead.oauthClient.findUnique({ where: { id: client_id } });
  if (!client) {
    return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client' });
  }

  // Verify client supports device flow
  if (!client.grants.includes('urn:ietf:params:oauth:grant-type:device_code')) {
    return res.status(400).json({
      error: 'unauthorized_client',
      error_description: 'Client not authorized for device flow',
    });
  }

  // Validate scope early (also validated at token exchange, but fail fast for UX)
  const rawScope = parseInt(scope as string, 10) || 0;
  if (rawScope < 0 || rawScope > TokenScope.Full) {
    return res.status(400).json({ error: 'invalid_scope' });
  }
  // UserRead is a mandatory baseline on every grant — force it on and treat it
  // as always-allowed so a device client that omitted it still gets it.
  const requestedScope = rawScope | TokenScope.UserRead;
  const allowedScopes = client.allowedScopes | TokenScope.UserRead;
  if (requestedScope > 0 && !Flags.hasFlag(allowedScopes, requestedScope)) {
    return res.status(400).json({
      error: 'invalid_scope',
      error_description: 'Requested scope exceeds client permissions',
    });
  }

  // Generate codes
  const deviceCode = randomBytes(32).toString('hex');
  const userCode = generateUserCode();

  // Store in Redis
  await redis.packed.hSet(DEVICE_CODE_KEY, deviceCode, {
    clientId: client_id,
    userCode,
    scope: requestedScope.toString(),
    status: 'pending', // pending | approved | denied
    userId: null,
    expiresAt: new Date(Date.now() + DEVICE_CODE_TTL * 1000).toISOString(),
  });
  await redis.hExpire(DEVICE_CODE_KEY, deviceCode, DEVICE_CODE_TTL);

  // Also store a reverse lookup: userCode -> deviceCode
  await redis.packed.hSet(REDIS_KEYS.OAUTH.DEVICE_USER_CODES, userCode, deviceCode);
  await redis.hExpire(REDIS_KEYS.OAUTH.DEVICE_USER_CODES, userCode, DEVICE_CODE_TTL);

  const baseUrl = env.NEXTAUTH_URL;

  return res.status(200).json({
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: `${baseUrl}/login/oauth/device`,
    verification_uri_complete: `${baseUrl}/login/oauth/device?code=${userCode}`,
    expires_in: DEVICE_CODE_TTL,
    interval: DEVICE_POLL_INTERVAL,
  });
}

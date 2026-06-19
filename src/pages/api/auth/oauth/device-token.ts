import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';
import { checkOAuthRateLimit, sendRateLimitResponse } from '~/server/oauth/rate-limit';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import { createOAuthTokenPair } from '~/server/oauth/token-helpers';
import { ACCESS_TOKEN_TTL } from '~/server/oauth/constants';
import { Flags } from '~/shared/utils/flags';
import { TokenScope, ALL_SCOPES } from '~/shared/constants/token-scope.constants';
import { dbRead } from '~/server/db/client';
import requestIp from 'request-ip';

const DEVICE_CODE_KEY = REDIS_KEYS.OAUTH.DEVICE_CODES;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  const shouldStop = addCorsHeaders(req, res, ['POST']);
  if (shouldStop) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { grant_type, device_code, client_id } = req.body;

  if (grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  if (!device_code || !client_id) {
    return res.status(400).json({ error: 'invalid_request' });
  }

  // Rate limit
  const allowed = await checkOAuthRateLimit(req, res, 'token', client_id);
  if (!allowed) return sendRateLimitResponse(res);

  // Look up device code
  const data = await redis.packed.hGet<{
    clientId: string;
    userCode: string;
    scope: string;
    status: 'pending' | 'approved' | 'denied';
    userId: number | null;
    expiresAt: string;
  }>(DEVICE_CODE_KEY, device_code);

  if (!data) {
    return res
      .status(400)
      .json({ error: 'expired_token', error_description: 'Device code expired' });
  }

  if (data.clientId !== client_id) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  if (new Date(data.expiresAt) < new Date()) {
    await redis.hDel(DEVICE_CODE_KEY, device_code);
    return res.status(400).json({ error: 'expired_token' });
  }

  if (data.status === 'denied') {
    await redis.hDel(DEVICE_CODE_KEY, device_code);
    return res.status(400).json({ error: 'access_denied' });
  }

  if (data.status === 'pending') {
    return res.status(400).json({ error: 'authorization_pending' });
  }

  // status === 'approved' — issue tokens via shared helper
  if (!data.userId) {
    return res.status(400).json({ error: 'server_error' });
  }

  const rawScope = parseInt(data.scope, 10);
  // Bound against ALL_SCOPES (incl. opt-in AppBlocksSubmit), NOT `Full` — the
  // approved device code may legitimately carry AppBlocksSubmit (bit 25), which
  // is outside `Full`. The per-client allowedScopes intersection below is the
  // real authorization gate.
  if (isNaN(rawScope) || rawScope < 0 || rawScope > ALL_SCOPES) {
    return res.status(400).json({ error: 'invalid_scope' });
  }
  const scope = rawScope;

  // Validate scope against client's allowedScopes
  const client = await dbRead.oauthClient.findUnique({
    where: { id: client_id },
    select: { allowedScopes: true },
  });
  if (client && !Flags.hasFlag(client.allowedScopes, scope)) {
    return res
      .status(400)
      .json({
        error: 'invalid_scope',
        error_description: 'Requested scope exceeds client permissions',
      });
  }

  const pair = await createOAuthTokenPair(data.userId, client_id, scope);

  // Clean up device code
  await redis.hDel(DEVICE_CODE_KEY, device_code);

  logOAuthEvent({
    type: 'token.issued',
    userId: data.userId,
    clientId: client_id,
    scope,
    ip: requestIp.getClientIp(req) ?? '',
    metadata: { grant_type: 'device_code' },
  });

  return res.status(200).json({
    access_token: pair.accessToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL,
    refresh_token: pair.refreshToken,
    scope: scope.toString(),
  });
}

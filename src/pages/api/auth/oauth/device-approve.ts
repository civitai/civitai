import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { logOAuthEvent } from '~/server/oauth/audit-log';
import requestIp from 'request-ip';

const DEVICE_CODE_KEY = REDIS_KEYS.OAUTH.DEVICE_CODES;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getServerAuthSession({ req, res });
  if (!session?.user) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { user_code } = req.body;
  if (!user_code) {
    return res
      .status(400)
      .json({ error: 'invalid_request', error_description: 'Missing user_code' });
  }

  // Look up device code from user code
  const deviceCode = await redis.packed.hGet<string>(
    REDIS_KEYS.OAUTH.DEVICE_USER_CODES,
    user_code.toUpperCase()
  );

  if (!deviceCode) {
    return res
      .status(400)
      .json({ error: 'invalid_code', error_description: 'Invalid or expired code' });
  }

  // Get device code data
  const data = await redis.packed.hGet<{
    clientId: string;
    userCode: string;
    scope: string;
    status: string;
    userId: number | null;
    expiresAt: string;
  }>(DEVICE_CODE_KEY, deviceCode);

  if (!data || data.status !== 'pending') {
    return res
      .status(400)
      .json({ error: 'invalid_code', error_description: 'Code already used or expired' });
  }

  // Approve — update the device code with user info
  await redis.packed.hSet(DEVICE_CODE_KEY, deviceCode, {
    ...data,
    status: 'approved',
    userId: session.user.id,
  });

  // Clean up user code reverse lookup
  await redis.hDel(REDIS_KEYS.OAUTH.DEVICE_USER_CODES, user_code.toUpperCase());

  logOAuthEvent({
    type: 'authorization.granted',
    userId: session.user.id,
    clientId: data.clientId,
    scope: parseInt(data.scope, 10),
    ip: requestIp.getClientIp(req) ?? '',
    metadata: { grant_type: 'device_code' },
  });

  return res.status(200).json({ success: true });
}

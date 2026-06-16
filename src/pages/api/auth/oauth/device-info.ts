import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { dbRead } from '~/server/db/client';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { tokenScopeLabels } from '~/shared/constants/token-scope.constants';
import { Flags } from '~/shared/utils/flags';

/**
 * Look up device code info by user code — returns app name, description, and requested scopes.
 * Used by the device verification page to show what the user is authorizing.
 */
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
    scope: string;
    status: string;
  }>(REDIS_KEYS.OAUTH.DEVICE_CODES, deviceCode);

  if (!data || data.status !== 'pending') {
    return res
      .status(400)
      .json({ error: 'invalid_code', error_description: 'Code already used or expired' });
  }

  // Get client details
  const client = await dbRead.oauthClient.findUnique({
    where: { id: data.clientId },
    select: { name: true, description: true, logoUrl: true, isVerified: true },
  });

  if (!client) {
    return res
      .status(400)
      .json({ error: 'invalid_code', error_description: 'Unknown application' });
  }

  // Parse scopes into human-readable list
  const scope = parseInt(data.scope, 10) || 0;
  const scopeList = Object.entries(tokenScopeLabels)
    .filter(([bit]) => Flags.hasFlag(scope, parseInt(bit)))
    .map(([, label]) => label);

  return res.status(200).json({
    client: {
      name: client.name,
      description: client.description,
      logoUrl: client.logoUrl,
      isVerified: client.isVerified,
    },
    scopes: scopeList,
  });
}

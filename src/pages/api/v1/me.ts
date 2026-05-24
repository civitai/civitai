import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from 'next-auth';

import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';

// Note: App Blocks do NOT call /api/v1/me directly. Layering withBlockScope
// over AuthedEndpoint would dead-code the block-token path (the inner
// session check 401s before block claims do anything). Blocks use the
// dedicated /api/v1/blocks/me route which is built on top of withBlockScope.
export default AuthedEndpoint(async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) {
  const context = (req as any).context ?? {};
  const tokenScope: number | undefined = context.tokenScope;
  const buzzLimit = context.buzzLimit ?? null;
  const subject = context.subject ?? null;

  res.send({
    id: user.id,
    username: user.username,
    tier: user.tier,
    status: user.bannedAt ? 'banned' : user.muted ? 'muted' : 'active',
    isMember: user.tier ? user.tier !== 'free' : false,
    subscriptions: Object.keys(user.subscriptions ?? {}),
    // Token-specific fields (only present when auth is via API key/OAuth token).
    // `subject` carries the (type, id) pair the orchestrator buckets spend by.
    // For OAuth-issued tokens the id is the clientId (stable across refresh
    // rotations); for User-type keys it's the ApiKey row id.
    ...(subject !== null ? { tokenScope, buzzLimit, subject } : {}),
  });
});

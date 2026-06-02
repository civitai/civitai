import type { NextApiRequest, NextApiResponse } from 'next';
import type { SessionUser } from 'next-auth';

import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { Flags } from '~/shared/utils/flags';
import { TokenScope } from '~/shared/constants/token-scope.constants';

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

  // Release email for session auth (no token) or when the token carries the
  // UserRead scope — same gate the OIDC userinfo endpoint uses.
  const canReadProfile = subject === null || Flags.hasFlag(tokenScope ?? 0, TokenScope.UserRead);

  res.send({
    id: user.id,
    username: user.username,
    tier: user.tier,
    status: user.bannedAt ? 'banned' : user.muted ? 'muted' : 'active',
    isMember: user.tier ? user.tier !== 'free' : false,
    subscriptions: Object.keys(user.subscriptions ?? {}),
    ...(canReadProfile && user.email
      ? { email: user.email, emailVerified: !!user.emailVerified }
      : {}),
    // Token-specific fields (only present when auth is via API key/OAuth token).
    // `subject` carries the (type, id) pair the orchestrator buckets spend by.
    // For OAuth-issued tokens the id is the clientId (stable across refresh
    // rotations); for User-type keys it's the ApiKey row id.
    ...(subject !== null ? { tokenScope, buzzLimit, subject } : {}),
  });
});

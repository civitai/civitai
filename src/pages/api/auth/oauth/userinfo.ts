import type { NextApiRequest, NextApiResponse } from 'next';
import { instrumentApiResponse } from '~/server/prom/http-errors';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { Flags } from '~/shared/utils/flags';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { addCorsHeaders } from '~/server/utils/endpoint-helpers';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // 5xx attribution: bypasses the endpoint wrappers, so its 500s were
  // counter-blind. Listener-only (res.once('finish')); no behavior change.
  instrumentApiResponse(req, res);
  const shouldStop = addCorsHeaders(req, res, ['GET']);
  if (shouldStop) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Extract bearer token
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res
      .status(401)
      .json({ error: 'invalid_token', error_description: 'Missing bearer token' });
  }

  const token = auth.slice(7);
  const session = await getSessionFromBearerToken(token);

  if (!session?.user) {
    return res
      .status(401)
      .json({ error: 'invalid_token', error_description: 'Invalid or expired token' });
  }

  // Requires UserRead scope — deny if scope is missing (fail-safe for bearer tokens)
  const tokenScope = 'tokenScope' in session ? ((session as any).tokenScope as number) : 0;
  if (!Flags.hasFlag(tokenScope, TokenScope.UserRead)) {
    return res.status(403).json({
      error: 'insufficient_scope',
      error_description: 'Token does not have UserRead scope',
    });
  }

  const user = session.user;

  // Standard OIDC UserInfo claims (OIDC Core §5.1). `email`/`email_verified`
  // are released under the same UserRead scope checked above — the consent
  // screen's "Read profile & settings" permission covers profile + email.
  // Only emit claims we actually have so clients can distinguish absent
  // values from empty ones.
  return res.status(200).json({
    sub: user.id.toString(),
    id: user.id,
    username: user.username,
    // OIDC standard profile claims. `name` intentionally mirrors the username
    // rather than `user.name`: the display name is only ever populated by our
    // own OAuth ingestion from upstream providers (Google, etc.), is not
    // user-settable, and we don't want to hand that PII to third-party apps.
    preferred_username: user.username ?? undefined,
    name: user.username ?? undefined,
    picture: user.image ?? undefined,
    image: user.image,
    ...(user.email ? { email: user.email, email_verified: !!user.emailVerified } : {}),
  });
}

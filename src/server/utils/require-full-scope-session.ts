import type { NextApiRequest, NextApiResponse } from 'next';
import { isFullScopeUserKey, type BearerCredential } from '~/server/auth/full-user-credential';
import { requestCarriesQueryToken } from '~/server/utils/endpoint-helpers';

type CredentialContext = BearerCredential & { apiKeyId?: number | null };

/**
 * True when the request was authenticated by a browser session, or by a bearer credential
 * `isFullScopeUserKey` accepts. Any non-empty `?token=` is refused.
 *
 * Reads `req.context`, so it must run after `getServerAuthSession` (which `AuthedEndpoint`
 * calls). Any sign of a bearer credential — the header or a context field — counts as one, so
 * a request whose context was not populated is refused rather than treated as a session.
 */
export function isFullScopeSession(req: NextApiRequest): boolean {
  if (requestCarriesQueryToken(req)) return false;

  const context = (req as NextApiRequest & { context?: CredentialContext }).context;
  const presentedBearer =
    !!req.headers?.authorization ||
    context?.apiKeyId != null ||
    context?.apiKeyType != null ||
    context?.subject != null ||
    context?.tokenScope != null;
  if (!presentedBearer) return true;

  return isFullScopeUserKey(context);
}

/** Sends a 403 and returns false unless `isFullScopeSession(req)`. */
export function requireFullScopeSession(req: NextApiRequest, res: NextApiResponse): boolean {
  if (isFullScopeSession(req)) return true;
  res.status(403).json({
    error: 'This action requires a signed-in session or a full-access personal API key',
  });
  return false;
}

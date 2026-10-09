import type { NextApiRequest, NextApiResponse } from 'next';
import { requestCarriesQueryToken } from '~/server/utils/endpoint-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';

type CredentialContext = {
  tokenScope?: number | null;
  apiKeyId?: number | null;
  subject?: { type: 'apiKey' | 'oauth'; id: number | string } | null;
};

/**
 * True when the request was authenticated by a browser session, or by an API key that was not
 * issued to an OAuth client (a `User` or `System` key) and holds the full scope. OAuth-issued tokens (at any scope), reduced-scope keys and
 * query-string tokens (any value) are refused.
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
    context?.subject != null ||
    context?.tokenScope != null;
  if (!presentedBearer) return true;

  return context?.subject?.type === 'apiKey' && context.tokenScope === TokenScope.Full;
}

/** Sends a 403 and returns false unless `isFullScopeSession(req)`. */
export function requireFullScopeSession(req: NextApiRequest, res: NextApiResponse): boolean {
  if (isFullScopeSession(req)) return true;
  res.status(403).json({
    error: 'This action requires a signed-in session or a full-access personal API key',
  });
  return false;
}

import type { NextApiRequest, NextApiResponse } from 'next';
import { getRequestCredential } from '~/server/auth/request-credential';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import { matchedScope } from '~/server/services/oauth/enforce-token-scope';
import { AuthedEndpoint, handleEndpointError } from '~/server/utils/endpoint-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

/** Every /api/v1 gift route: authed, ModelsWrite-scoped, behind `modelGiftLinks`, never cached. */
export function GiftEndpoint(
  handler: (req: NextApiRequest, res: NextApiResponse, user: SessionUser) => Promise<unknown>,
  allowedMethods: string[]
) {
  return AuthedEndpoint(async (req, res, user) => {
    const { tokenScope } = getRequestCredential(req);
    if (
      tokenScope !== TokenScope.Full &&
      matchedScope(tokenScope, [TokenScope.ModelsWrite]) === undefined
    )
      return res.status(403).json({ error: 'This token lacks the ModelsWrite scope.' });

    if (!(await getFeatureFlagsAsync({ user, req })).modelGiftLinks)
      return res.status(404).json({ error: 'Not Found' });

    res.setHeader('Cache-Control', 'private, no-store');
    try {
      await handler(req, res, user);
    } catch (error) {
      return handleEndpointError(res, error);
    }
  }, allowedMethods);
}

export function parseVersionId(req: NextApiRequest) {
  const id = Number(req.query.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

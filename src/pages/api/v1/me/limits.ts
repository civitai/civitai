import type { NextApiRequest, NextApiResponse } from 'next';
import { getRequestCredential } from '~/server/auth/request-credential';
import { getUsageLimitsSchema } from '~/server/schema/user.schema';
import { matchedScope } from '~/server/services/oauth/enforce-token-scope';
import { getUsageLimits, USAGE_LIMITS_SCOPES } from '~/server/services/usage-limits.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';

/** `?ids=posts.daily,posts.hourly` or `?ids=posts.daily&ids=posts.hourly`. */
function parseIds(value: string | string[] | undefined) {
  if (value === undefined) return undefined;
  return (Array.isArray(value) ? value : [value])
    .flatMap((part) => part.split(','))
    .map((id) => id.trim())
    .filter(Boolean);
}

export default AuthedEndpoint(
  async function handler(req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    // AuthedEndpoint checks no scope; mirror the anyOfScopes rule on user.getUsageLimits.
    const { tokenScope } = getRequestCredential(req);
    if (
      tokenScope !== TokenScope.Full &&
      matchedScope(tokenScope, USAGE_LIMITS_SCOPES) === undefined
    ) {
      return res.status(403).json({ error: 'This token lacks the scope to read usage limits.' });
    }

    const parsed = getUsageLimitsSchema.safeParse({ ids: parseIds(req.query.ids) });
    if (!parsed.success) return res.status(400).json({ error: 'Invalid ids.' });

    res.setHeader('Cache-Control', 'private, no-store');
    return res
      .status(200)
      .json(await getUsageLimits({ user, req, tokenScope, ids: parsed.data?.ids }));
  },
  ['GET']
);

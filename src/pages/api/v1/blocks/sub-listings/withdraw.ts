import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  subListingErrorResponse,
  withdrawSubListing,
} from '~/server/services/blocks/app-sub-listing.service';

export const config = { api: { bodyParser: { sizeLimit: '2kb' } } };

/**
 * POST /api/v1/blocks/sub-listings/withdraw — scope `apps:store:items:write`.
 *
 * Takes the viewer's own store item out of the store. Body: `{ itemKey }`.
 * Returns `{ ok, withdrawn }`; `withdrawn: false` when there was nothing of theirs to withdraw
 * (or a moderator has hidden it, which the app cannot change).
 */
export const baseHandler = withAxiom(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    res.status(401).json({ error: 'Block token required' });
    return;
  }
  let userId: number | null;
  try {
    userId = parseSubjectUserId(claims.sub);
  } catch {
    res.status(403).json({ error: 'Invalid subject claim' });
    return;
  }
  try {
    const result = await withdrawSubListing({
      appBlockId: claims.appBlockId,
      userId,
      body: req.body,
    });
    res.status(200).json(result);
  } catch (err) {
    const mapped = subListingErrorResponse(err);
    if (!mapped) throw err;
    if (mapped.retryAfter) res.setHeader('Retry-After', String(mapped.retryAfter));
    res.status(mapped.status).json(mapped.body);
  }
});

export default withBlockScope(baseHandler, {
  endpoint: 'sub_listings_withdraw',
  requiredScope: 'apps:store:items:write',
  allowOpaqueOrigin: true,
});

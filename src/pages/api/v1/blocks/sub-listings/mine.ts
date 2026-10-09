import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  listMySubListings,
  subListingErrorResponse,
} from '~/server/services/blocks/app-sub-listing.service';

/**
 * GET /api/v1/blocks/sub-listings/mine — scope `apps:store:items:write`.
 *
 * The viewer's own store items for the calling app, with their review status, so the app can
 * show "In the store: pending" and reconcile. Scoped to the calling app and the token subject;
 * there is no parameter that can widen it.
 */
export const baseHandler = withAxiom(async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
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
    res.status(200).json(await listMySubListings({ appBlockId: claims.appBlockId, userId }));
  } catch (err) {
    const mapped = subListingErrorResponse(err);
    if (!mapped) throw err;
    res.status(mapped.status).json(mapped.body);
  }
});

export default withBlockScope(baseHandler, {
  endpoint: 'sub_listings_mine',
  requiredScope: 'apps:store:items:write',
  allowOpaqueOrigin: true,
});

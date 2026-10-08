import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import { sessionClient } from '~/server/auth/session-client';
import { dbRead } from '~/server/db/client';
import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import {
  subListingErrorResponse,
  upsertSubListing,
} from '~/server/services/blocks/app-sub-listing.service';
import type { SessionUser } from '~/types/session';

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

/**
 * POST /api/v1/blocks/sub-listings/upsert — scope `apps:store:items:write`.
 *
 * Publishes (or edits) the viewer's own app item as an App Store card under the calling app.
 * The parent app comes from the token, never the body. Every check is in `upsertSubListing`;
 * 503 while the tables are not yet applied.
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
    let subjectUser: SessionUser | null = null;
    let hasLinkedOAuth = false;
    if (userId != null) {
      subjectUser = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
      if (subjectUser && !subjectUser.emailVerified) {
        hasLinkedOAuth = (await dbRead.account.count({ where: { userId } })) > 0;
      }
      if (!subjectUser) {
        res.status(403).json({ error: 'Token subject could not be resolved' });
        return;
      }
    }
    const result = await upsertSubListing({
      appBlockId: claims.appBlockId,
      subjectUser,
      hasLinkedOAuth,
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
  endpoint: 'sub_listings_upsert',
  requiredScope: 'apps:store:items:write',
  allowOpaqueOrigin: true,
});

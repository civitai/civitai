import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';

import {
  parseSubjectUserId,
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { listBlockGoodEntitlements } from '~/server/services/blocks/block-goods.service';
import { checkBlockGoodReadRateLimit } from '~/server/utils/block-goods-rate-limit';

/**
 * GET /api/v1/blocks/entitlements — scope `goods:read:self`.
 *
 * Returns the DIGITAL GOODS the viewer owns FROM THE CALLING APP:
 * `{ entitlements: [{ goodId, kind, payload, grantedAt }] }`.
 *
 * 🔴 SCOPED TO `claims.appBlockId`, IN THE QUERY. An app can only ever read
 * what it sold — the reply is its own sales ledger filtered to one viewer, not
 * a view of what that viewer has bought anywhere else. There is no body and no
 * query parameter that can widen it.
 *
 * `payload` is the app's OWN opaque blob, copied from the manifest the
 * moderator approved. The platform never interprets it; the app is expected to
 * keep the semantics of a good in its own storage and use this only to know
 * WHICH goods the viewer holds.
 *
 * Revoked entitlements are excluded — "what do I own" must not include what was
 * refunded. Self-bound: anonymous tokens are rejected (there is nobody to own
 * anything).
 *
 * 🔴 RATE LIMITED ON ITS OWN BUCKET, KEYED PER (instance, VIEWER) — deliberately
 * NOT the shared catalog bucket the sibling block reads use. That bucket keys on
 * `blockInstanceId` alone, and for a PAGE app that is the synthetic
 * `page_<appBlockId>` shared by every concurrent viewer platform-wide. Since this
 * is read on mount, a viewer would be refused because of strangers' traffic —
 * and a refused entitlements read renders as "you own nothing", which is the
 * worst failure this surface has. See `checkBlockGoodReadRateLimit`.
 *
 * CORS: withBlockScope + allowOpaqueOrigin (an unverified block direct-fetches
 * this from `Origin: null`; the Bearer block-JWT is the sole authz gate).
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
    // withBlockScope only invokes this handler with a valid block JWT; defense
    // in depth.
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  let subjectUserId: number | null;
  try {
    subjectUserId = parseSubjectUserId(claims.sub);
  } catch {
    res.status(403).json({ error: 'Invalid subject claim' });
    return;
  }
  if (subjectUserId == null) {
    res.status(403).json({ error: 'Anonymous block tokens hold no entitlements' });
    return;
  }

  const rateLimit = await checkBlockGoodReadRateLimit(claims.blockInstanceId, subjectUserId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  const entitlements = await listBlockGoodEntitlements({
    userId: subjectUserId,
    appBlockId: claims.appBlockId,
  });
  res.status(200).json({ entitlements });
});

export default withBlockScope(baseHandler, {
  endpoint: 'entitlements',
  requiredScope: 'goods:read:self',
  allowOpaqueOrigin: true,
});

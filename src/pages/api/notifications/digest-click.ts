import type { NextApiRequest, NextApiResponse } from 'next';
import {
  DIGEST_FALLBACK_PATH,
  recordDigestEvents,
  verifyDigestClick,
} from '~/server/notifications/digest-tracking';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * A link in the weekly missed-notification digest: records the click, then redirects to the item.
 *
 * The user and pass come from the signed link, not the session. Only a same-site path is ever
 * redirected to, and a link that fails any check (tampered, truncated, unsigned) still redirects,
 * to the notifications page, and records nothing. A HEAD (a link checker) redirects without
 * recording.
 */
export default PublicEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const click = verifyDigestClick(req.query);
    if (click && req.method === 'GET') {
      await recordDigestEvents([
        {
          event: 'click',
          userId: click.userId,
          cycleStartedAt: click.cycleStartedAt,
          position: click.position,
          notificationType: click.notificationType,
          userAgent: String(req.headers['user-agent'] ?? ''),
        },
      ]);
    }
    return res.redirect(302, click?.to ?? DIGEST_FALLBACK_PATH);
  },
  ['GET', 'HEAD']
);

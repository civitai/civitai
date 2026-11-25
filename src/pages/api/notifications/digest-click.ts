import type { NextApiRequest, NextApiResponse } from 'next';
import { recordEmailEvents } from '~/server/email/send-tracking';
import {
  DIGEST_EMAIL_TEMPLATE,
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
 * recording. A link that carries the email's send id is also an emailEvents `click` row.
 */
export default PublicEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const click = verifyDigestClick(req.query);
    if (click && req.method === 'GET') {
      const userAgent = String(req.headers['user-agent'] ?? '');
      await Promise.all([
        recordDigestEvents([
          {
            event: 'click',
            userId: click.userId,
            cycleStartedAt: click.cycleStartedAt,
            position: click.position,
            notificationType: click.notificationType,
            userAgent,
          },
        ]),
        click.sendId
          ? recordEmailEvents([
              {
                event: 'click',
                sendId: click.sendId,
                template: DIGEST_EMAIL_TEMPLATE,
                mailClass: 'lifecycle',
                // The send row's campaign: the pass, as an ISO timestamp.
                campaign: click.cycleStartedAt.toISOString(),
                variant: '',
                userId: click.userId,
                position: click.position,
                userAgent,
              },
            ])
          : undefined,
      ]);
    }
    return res.redirect(302, click?.to ?? DIGEST_FALLBACK_PATH);
  },
  ['GET', 'HEAD']
);

import type { NextApiRequest, NextApiResponse } from 'next';
import { EMAIL_CLICK_FALLBACK_PATH, verifyEmailClick } from '~/server/email/link-tracking';
import { recordEmailEvents } from '~/server/email/send-tracking';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * A tracked link in an email (~/server/email/link-tracking): records the click, then redirects to
 * the link's own path.
 *
 * The send, template, recipient and position come from the signed link, never the session. Only a
 * same-site path is ever redirected to, and a link that fails any check (tampered, truncated,
 * unsigned) still redirects, to the home page, and records nothing. A HEAD (a link checker)
 * redirects without recording.
 */
export async function handleEmailClick(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const click = verifyEmailClick(req.query);
  if (click && req.method === 'GET') {
    await recordEmailEvents([
      {
        event: 'click',
        sendId: click.sendId,
        template: click.template,
        mailClass: click.mailClass,
        campaign: click.campaign,
        variant: click.variant,
        userId: click.userId,
        position: click.position,
        userAgent: String(req.headers['user-agent'] ?? ''),
      },
    ]);
  }
  res.redirect(302, click?.to ?? EMAIL_CLICK_FALLBACK_PATH);
}

export default PublicEndpoint(handleEmailClick, ['GET', 'HEAD']);

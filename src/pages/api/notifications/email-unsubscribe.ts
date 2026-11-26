import type { NextApiRequest, NextApiResponse } from 'next';
import { escape as escapeHtml } from 'he';
import * as z from 'zod';
import { lifecycleTemplateForOptOut } from '~/server/email/lifecycle-opt-outs';
import { recordEmailEvents } from '~/server/email/send-tracking';
import { notificationSettingsUrl } from '~/server/email/templates/notification.email';
import { digestCycleParam, recordDigestEvents } from '~/server/notifications/digest-tracking';
import { MISSED_DIGEST_EMAIL_TYPE } from '~/server/notifications/missed-digest.constants';
import {
  emailOptOutDisplayName,
  isEmailOptOutType,
} from '~/server/notifications/utils.notifications';
import {
  optOutOfNotificationEmail,
  verifyEmailUnsubscribe,
} from '~/server/services/notification-email.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';

const query = z.object({
  u: z.coerce.number().int().positive(),
  t: z.string(),
  s: z.string(),
});

const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Civitai email settings</title></head>
<body style="font-family: Helvetica, Arial, sans-serif; max-width: 480px; margin: 48px auto; padding: 0 16px; color: #444;">
${body}
<p><a href="${notificationSettingsUrl()}">Manage all notification emails</a></p>
</body></html>`;

// GET only shows a confirm button: link scanners and prefetchers follow GETs and must not
// unsubscribe anyone.
export default PublicEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = query.safeParse(req.query);
    const valid =
      parsed.success &&
      isEmailOptOutType(parsed.data.t) &&
      verifyEmailUnsubscribe(parsed.data.u, parsed.data.t, parsed.data.s);
    if (!valid) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(page('<p>This unsubscribe link is not valid.</p>'));
    }

    const { u, t } = parsed.data;
    const name = escapeHtml(emailOptOutDisplayName(t));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'POST') {
      const turnedOff = await optOutOfNotificationEmail(u, t);
      // A digest's links also carry the pass it was sent in (`c`), so its unsubscribes count per
      // pass. A lifecycle email's opt-out is also an emailEvents row, against the send its link
      // names (`e`, added per send by base.email.ts). Both are unsigned: they can only mislabel the
      // user's own row. The campaign is the send row's, joined on the send id. Only the call that
      // turned it off records: a repeat POST counts nothing.
      const template = lifecycleTemplateForOptOut(t);
      if (turnedOff)
        await Promise.all([
          t === MISSED_DIGEST_EMAIL_TYPE
            ? recordDigestEvents([
                { event: 'unsubscribe', userId: u, cycleStartedAt: digestCycleParam(req.query.c) },
              ])
            : undefined,
          template
            ? recordEmailEvents([
                {
                  event: 'unsubscribe',
                  sendId: typeof req.query.e === 'string' ? req.query.e : '',
                  template,
                  mailClass: 'lifecycle',
                  campaign: '',
                  variant: '',
                  userId: u,
                },
              ])
            : undefined,
        ]);
      return res.status(200).send(page(`<p>You won't get emails for "${name}" any more.</p>`));
    }
    return res.status(200).send(
      page(`<p>Stop emails for "${name}"?</p>
<form method="post"><button type="submit" style="padding: 8px 16px;">Unsubscribe</button></form>`)
    );
  },
  ['GET', 'POST']
);

import type { NextApiRequest, NextApiResponse } from 'next';
import { escape as escapeHtml } from 'he';
import * as z from 'zod';
import { notificationSettingsUrl } from '~/server/email/templates/notification.email';
import {
  isEmailNotificationType,
  notificationProcessors,
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

// GET only shows a confirm button: link scanners and prefetchers follow GETs, and must not
// unsubscribe anyone. POST is the RFC 8058 one-click request a mail client sends, and the button.
export default PublicEndpoint(
  async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = query.safeParse(req.query);
    const valid =
      parsed.success &&
      isEmailNotificationType(parsed.data.t) &&
      verifyEmailUnsubscribe(parsed.data.u, parsed.data.t, parsed.data.s);
    if (!valid) {
      res.status(400).setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.send(page('<p>This unsubscribe link is not valid.</p>'));
    }

    const { u, t } = parsed.data;
    const name = escapeHtml(notificationProcessors[t]?.displayName ?? t);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'POST') {
      await optOutOfNotificationEmail(u, t);
      return res.status(200).send(page(`<p>You won't get emails for "${name}" any more.</p>`));
    }
    return res.status(200).send(
      page(`<p>Stop emails for "${name}"?</p>
<form method="post"><button type="submit" style="padding: 8px 16px;">Unsubscribe</button></form>`)
    );
  },
  ['GET', 'POST']
);

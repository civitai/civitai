/**
 * Sends the non-commercial earnings notices: a site notification and an email per creator.
 *
 * Hidden ops route, guarded like klein9b-notice: `Authorization: Bearer <WEBHOOK_TOKEN>`.
 *
 * Usage:
 *   POST /api/admin/nc-earnings-notice
 *   Body: { "action": "<action>", "notice": "nc-recent" | "nc-older", ...params }
 *
 * Sends are paced (NOTICE_MIN_INTERVAL_MS in notice-ledger.service) and one call sends at most
 * `count` (max 100), so send a larger audience in several calls.
 *
 * Actions:
 *   send      - {userIds, date, dryRun?, count?, batchSize?}  Notify up to `count` not-yet-sent
 *               creators. dryRun defaults to TRUE (counts only); pass `"dryRun": false` to send.
 *   send-test - {email, date, username?, baseModels?, versions?}  One email to `email`. Not recorded.
 *   preview   - {date, username?, baseModels?, versions?}         The email HTML, as text/html
 *   sent      - {}                  How many creators have been sent this notice
 *   unmark    - {userId}            Forget that one creator was sent it
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { isEmailConfigured } from '~/server/email/client';
import { ncEarningsNoticeEmail } from '~/server/email/templates/ncEarningsNotice.email';
import { countNoticeSent, removeNoticeSent } from '~/server/services/notice-ledger.service';
import { ncEarningsNoticeSchema as schema } from '~/server/schema/nc-earnings-notice.schema';
import {
  ncEarningsNoticeLedger,
  sendNcEarningsNotice,
} from '~/server/services/nc-earnings-notice.service';
import { NC_EARNINGS_NOTICE } from '~/shared/constants/nc-earnings-notice.constants';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const input = parsed.data;
  const key = ncEarningsNoticeLedger(input.notice);

  switch (input.action) {
    case 'send':
      return res.status(200).json(await sendNcEarningsNotice(input));
    case 'send-test':
    case 'preview': {
      const data = {
        to: input.action === 'send-test' ? input.email : '',
        notice: input.notice,
        username: input.username,
        date: input.date,
        baseModels: input.baseModels ?? NC_EARNINGS_NOTICE[input.notice].baseModels.slice(0, 1),
        versions: input.versions,
      };
      if (input.action === 'preview') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(ncEarningsNoticeEmail.getHtml(data));
      }
      if (!isEmailConfigured())
        return res.status(503).json({ error: 'Email is not configured on this server' });
      await ncEarningsNoticeEmail.send(data);
      return res.status(200).json({ sent: input.email });
    }
    case 'sent': {
      return res.status(200).json({ sent: await countNoticeSent(key) });
    }
    case 'unmark': {
      const removed = await removeNoticeSent(key, input.userId);
      return res.status(200).json({ removed });
    }
  }
});

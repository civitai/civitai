/**
 * Sends the Flux.2 Klein 9B creator notice: a site notification and an email per creator.
 * =============================================================================
 *
 * Hidden ops route. Guarded by the WEBHOOK_TOKEN, sent as `Authorization: Bearer <token>` so it stays out
 * of URLs and access logs. Under /api/admin, not /api/testing, because the send runs in production and
 * /api/testing/* is redirected there.
 *
 * Usage:
 *   POST /api/admin/klein9b-notice
 *   Authorization: Bearer $WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   send      - {date, dryRun?, count?, batchSize?}  Notify up to `count` (default 50, max 1000)
 *                                 not-yet-sent creators. The audience is recounted on every call:
 *                                 "charged" creators (a 9B / 9B-base version with a fee or open paid
 *                                 access, any status) and "uncharged" ones (a published 9B / 9B-base
 *                                 version, nothing charged); charged wins; banned or deleted accounts
 *                                 are skipped. `date` fills the copy ("November 4th"). dryRun defaults
 *                                 to TRUE and returns the counts only; pass `"dryRun": false` to send.
 *                                 Each creator is recorded before their notice goes out, so re-running
 *                                 never notifies anyone twice; a failed send is un-recorded and retried
 *                                 by the next run, except `stuckUserIds`: unmark those.
 *   send-test - {email, variant, date, username?}  Send one email copy to `email`. Not recorded.
 *   preview   - {variant, date, username?}         The email HTML, as text/html
 *   sent      - {}                  How many creators have been sent the notice
 *   unmark    - {userId}            Forget that one creator was sent it, so the next run sends again
 *
 * The send actions refuse to run on a server with no email transport configured.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { klein9bNoticeSchema as schema } from '~/server/schema/klein9b-notice.schema';
import { isEmailConfigured } from '~/server/email/client';
import { klein9bNoticeEmail } from '~/server/email/templates/klein9bNotice.email';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { sendKlein9bNotice } from '~/server/services/klein9b-notice.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const KEY = REDIS_SYS_KEYS.NOTICES.KLEIN9B_SENT;
const SAMPLE_VERSIONS = ['Example LoRA: v1', 'Example LoRA: v2'];

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const input = parsed.data;

  switch (input.action) {
    case 'send':
      return res.status(200).json(await sendKlein9bNotice(input));
    case 'send-test': {
      if (!isEmailConfigured())
        return res.status(503).json({ error: 'Email is not configured on this server' });
      await klein9bNoticeEmail.send({
        to: input.email,
        variant: input.variant,
        username: input.username,
        date: input.date,
        versions: input.variant === 'charged' ? SAMPLE_VERSIONS : [],
      });
      return res.status(200).json({ sent: input.email });
    }
    case 'preview': {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(
        klein9bNoticeEmail.getHtml({
          to: '',
          variant: input.variant,
          username: input.username,
          date: input.date,
          versions: input.variant === 'charged' ? SAMPLE_VERSIONS : [],
        })
      );
    }
    case 'sent': {
      const all = await sysRedis.hGetAll(KEY);
      return res.status(200).json({ sent: Object.keys(all).length });
    }
    case 'unmark': {
      const removed = await sysRedis.hDel(KEY, String(input.userId));
      return res.status(200).json({ removed });
    }
  }
});

/**
 * Sends the Creator Program banking-change notice email.
 * =============================================================================
 *
 * Hidden ops route. Guarded by the WEBHOOK_TOKEN via `?token=` query param. Under /api/admin, not
 * /api/testing, because the send runs in production and /api/testing/* is redirected there.
 *
 * Usage:
 *   POST /api/admin/banking-change-notice?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions:
 *   send      - {dryRun?, count?, batchSize?}  Email up to `count` (default 50, max 1000) of the
 *                                 audience who have not been sent it yet: accounts that banked in the
 *                                 last 12 months plus current paid Creator Program members, skipping
 *                                 banned or deleted accounts. dryRun defaults to TRUE and returns the
 *                                 counts only; pass `"dryRun": false` to send. Each user is recorded
 *                                 before their email goes out, so re-running never emails anyone
 *                                 twice; a failed send is un-recorded and retried by the next run,
 *                                 except `stuckUserIds`, whose un-recording failed: unmark those.
 *   send-test - {email, username?}  Send one copy to `email`. Not recorded, not audience-checked.
 *   preview   - {username?}         The email HTML, as text/html
 *   sent      - {}                  How many users have been sent the notice
 *   unmark    - {userId}            Forget that one user was sent it, so the next run sends again
 *
 * Both send actions refuse to run on a server with no email transport configured.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { isEmailConfigured } from '~/server/email/client';
import { bankingChangeNoticeEmail } from '~/server/email/templates/bankingChangeNotice.email';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { sendBankingChangeNotice } from '~/server/services/banking-change-notice.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const KEY = REDIS_SYS_KEYS.NOTICES.BANKING_CHANGE_SENT;

const schema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('send'),
    dryRun: z.boolean().default(true),
    count: z.coerce.number().int().min(1).max(1000).default(50),
    batchSize: z.coerce.number().int().min(1).max(50).default(25),
  }),
  z.object({
    action: z.literal('send-test'),
    email: z.email(),
    username: z.string().min(1).default('there'),
  }),
  z.object({ action: z.literal('preview'), username: z.string().min(1).default('there') }),
  z.object({ action: z.literal('sent') }),
  z.object({ action: z.literal('unmark'), userId: z.coerce.number().int().positive() }),
]);

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: z.prettifyError(parsed.error) });
  const input = parsed.data;

  switch (input.action) {
    case 'send':
      return res.status(200).json(await sendBankingChangeNotice(input));
    case 'send-test': {
      if (!isEmailConfigured())
        return res.status(503).json({ error: 'Email is not configured on this server' });
      await bankingChangeNoticeEmail.send({ to: input.email, username: input.username });
      return res.status(200).json({ sent: input.email });
    }
    case 'preview': {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res
        .status(200)
        .send(bankingChangeNoticeEmail.getHtml({ to: '', username: input.username }));
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

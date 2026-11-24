import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { loadAuthEnv } from '@civitai/auth';
import { MAIL_CLASSES, type EmailSendRecord } from '@civitai/email';
import { insertEmailSend } from '~/server/email/send-tracking';
import { TokenSecuredEndpoint } from '~/server/utils/endpoint-helpers';

/**
 * Send rows from the apps that have no ClickHouse access of their own (the auth hub and the
 * moderator app POST them through @civitai/email's createRemoteSendRecorder). Each row is a send's
 * tags and our send id, never an address, and lands in emailEvents as that app's `send` row.
 *
 * Authenticated by AUTH_INTERNAL_TOKEN, the service credential the hub, the moderator app and this
 * app already share, as the Bearer. Unset or blank here, every call is refused (503).
 */

/** At most this many rows per call. */
export const EMAIL_EVENTS_MAX_ROWS = 50;
/** A row's send time this far from now is recorded as now. */
const MAX_CLOCK_SKEW_MS = 60 * 60 * 1000;

// Strict: a row naming anything beyond the send's tags (an address, say) is refused whole.
const sendRow = z.strictObject({
  sendId: z.uuid(),
  sentAt: z.iso.datetime(),
  template: z.string().min(1).max(100),
  mailClass: z.union([z.enum(MAIL_CLASSES), z.literal('')]),
  campaign: z.string().max(200),
  variant: z.string().max(200),
  userId: z
    .number()
    .int()
    .min(0)
    .max(2 ** 32 - 1),
});
const body = z.object({ sends: z.array(sendRow).min(1).max(EMAIL_EVENTS_MAX_ROWS) });

export async function handleEmailEvents(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const parsed = body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid send rows' });
    return;
  }

  const now = Date.now();
  const { clickhouse } = await import('~/server/clickhouse/client');
  await Promise.all(
    parsed.data.sends.map((row) => {
      const sentAt = new Date(row.sentAt);
      const record: EmailSendRecord = {
        ...row,
        sentAt: Math.abs(sentAt.getTime() - now) > MAX_CLOCK_SKEW_MS ? new Date(now) : sentAt,
      };
      return insertEmailSend(clickhouse, record);
    })
  );
  res.status(204).end();
}

// The token is read per request, so the route never parses the auth env at import.
export default function emailEventsRoute(req: NextApiRequest, res: NextApiResponse) {
  return TokenSecuredEndpoint(loadAuthEnv().AUTH_INTERNAL_TOKEN ?? '', handleEmailEvents)(req, res);
}

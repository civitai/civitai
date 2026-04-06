import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { unlockPrepaidTokensForDate } from '~/server/services/subscriptions.service';

const schema = z.object({
  date: z.coerce.date(),
});

/**
 * Admin endpoint to run the unlock-prepaid-tokens job for a specific date.
 * Uses the same core logic as the daily cron job but for an arbitrary date.
 *
 * GET /api/admin/unlock-prepaid-tokens?token=<WEBHOOK_TOKEN>&date=2026-03-28
 */
export default WebhookEndpoint(async (req, res) => {
  const { date } = schema.parse(req.query);
  const result = await unlockPrepaidTokensForDate({ date });
  return res.status(200).json(result);
});

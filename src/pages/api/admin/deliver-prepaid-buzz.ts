import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { unlockTokensForUser } from '~/server/services/subscriptions.service';
import { commaDelimitedNumberArray } from '~/utils/zod-helpers';

const schema = z.object({
  userIds: commaDelimitedNumberArray(),
  force: z.coerce.boolean().optional(),
});

type UnlockResult = {
  userId: number;
  status: 'success' | 'error' | 'skipped';
  unlocked?: number;
  totalBuzz?: number;
  message?: string;
  error?: string;
};

/**
 * Admin endpoint to unlock prepaid tokens for specific users.
 * Replaces the old deliver-prepaid-buzz endpoint.
 *
 * GET /api/admin/deliver-prepaid-buzz?userIds=1,2,3
 *
 * For each user:
 * 1. Reads subscription metadata (supports legacy prepaids + new tokens)
 * 2. Unlocks any locked tokens whose unlock date has passed
 * 3. Sends notification email
 */
export default WebhookEndpoint(async (req, res) => {
  try {
    const { userIds: targetUserIds, force } = schema.parse(req.query);

    if (targetUserIds.length === 0) {
      return res.status(400).json({ error: 'userIds is required' });
    }

    const results: UnlockResult[] = [];

    for (const userId of targetUserIds) {
      try {
        const result = await unlockTokensForUser({ userId, force });

        if (result.unlocked === 0) {
          results.push({
            userId,
            status: 'skipped',
            message: result.message,
          });
        } else {
          results.push({
            userId,
            status: 'success',
            unlocked: result.unlocked,
            totalBuzz: result.totalBuzz,
          });
        }
      } catch (err) {
        results.push({
          userId,
          status: 'error',
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    const successful = results.filter((r) => r.status === 'success');
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'error');

    return res.status(200).json({
      message: `Processed ${targetUserIds.length} users`,
      summary: {
        total: targetUserIds.length,
        successful: successful.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      results,
    });
  } catch (error) {
    console.error('Error unlocking prepaid tokens:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

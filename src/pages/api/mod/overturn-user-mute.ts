/**
 * POST /api/mod/overturn-user-mute
 *
 * "They shouldn't have been muted." Overturns the user's open generation
 * restriction rather than just clearing `muted`, so the review queue doesn't
 * keep a stale Pending row — and picks up the subscription reinstate and the
 * violation-count reset that come with an overturn.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { trackModActivity } from '~/server/services/moderator.service';
import { overturnPendingReviewMute } from '~/server/services/user-restriction-resolve.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  source: z.string().trim().min(1).max(100).default('orchestrator'),
});

const SYSTEM_ACTOR_ID = -1;

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const { userId, reason, source } = parsed.data;

  try {
    const result = await overturnPendingReviewMute({
      userId,
      resolvedMessage: reason,
      moderatorId: SYSTEM_ACTOR_ID,
    });

    if (result.unmuted) {
      await trackModActivity(SYSTEM_ACTOR_ID, {
        entityType: 'user',
        entityId: userId,
        activity: 'overturnPendingReviewMute',
      });
      const tracker = new Tracker(req, res, null);
      await tracker.userActivity({
        type: 'Unmuted',
        targetUserId: userId,
        source: `overturn-pending-review-mute (${source}: ${reason})`,
      });
    }

    return res.status(200).json({ userId, ...result });
  } catch (e) {
    const err = e as Error;
    logToAxiom({
      type: 'error',
      name: 'mod-overturn-user-mute-error',
      message: err.message,
      details: { userId, source, reason },
    });
    return res.status(500).json({ error: err.message });
  }
});

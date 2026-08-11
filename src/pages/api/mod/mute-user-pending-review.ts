/**
 * POST /api/mod/mute-user-pending-review
 *
 * Pauses an account and files a Pending UserRestriction for the moderator queue.
 * It does NOT set `mutedAt`, so `confirm-mutes` leaves the user's memberships
 * alone — only a moderator upholding the restriction cancels them.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { logToAxiom } from '~/server/logging/client';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  applyPendingReviewMute,
  buildManualMuteTriggers,
} from '~/server/services/user-restriction.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  source: z.string().trim().min(1).max(100).default('orchestrator'),
  prompts: z.array(z.string().max(5000)).max(50).optional(),
});

// Fixed, not derived from the caller-supplied `source`: it labels a Prometheus
// counter, so a free-text value would let the caller blow up its cardinality.
const UPDATE_SOURCE = 'webhook:mutePendingReview';

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
  const { userId, reason, source, prompts } = parsed.data;

  try {
    const result = await applyPendingReviewMute({
      userId,
      triggers: buildManualMuteTriggers({ reason, source, prompts }),
      updateSource: UPDATE_SOURCE,
    });

    if (result.muted && !result.deduped) {
      await trackModActivity(SYSTEM_ACTOR_ID, {
        entityType: 'user',
        entityId: userId,
        activity: 'mutePendingReview',
      });
      const tracker = new Tracker(req, res, null);
      await tracker.userActivity({
        type: 'Muted',
        targetUserId: userId,
        source: `mute-pending-review (${source}: ${reason})`,
      });
    }

    return res.status(200).json({ userId, ...result });
  } catch (e) {
    const err = e as Error;
    logToAxiom({
      type: 'error',
      name: 'mod-mute-user-pending-review-error',
      message: err.message,
      details: { userId, source, reason },
    });
    return res.status(500).json({ error: err.message });
  }
});

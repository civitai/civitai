/**
 * Service-callable pending-review mute (Orchestrator strike escalation).
 * =============================================================================
 *
 * Auth: WEBHOOK_TOKEN (`?token=`), the same control as `/api/mod/ban-user`.
 *
 * POST /api/mod/mute-user-pending-review?token=...
 * Body/query: {
 *   userId: number,
 *   reason: string,          // surfaced to the moderator as the restriction trigger
 *   source?: string,         // free-text caller detail, defaults to "orchestrator"
 *   prompts?: string[]       // offending prompts, one trigger row each
 * }
 *
 * Pauses the account and files a Pending UserRestriction for the review queue.
 * It does NOT set `mutedAt`, so `confirm-mutes` leaves the user's memberships
 * alone — only a moderator upholding the restriction cancels them.
 *
 * There is deliberately no unmute counterpart. Clearing a pending-review mute
 * means judging the case, and the only path that may do that is a moderator
 * overturning it via `userRestriction.resolve`, which also reinstates the
 * subscription and resets the violation count.
 *
 * Responses:
 *   200 { userId, muted: true, userRestrictionId }
 *   200 { userId, muted: false, skipped: 'moderator' }
 *   400 invalid payload
 *   500 { error } — safe for the caller to retry
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
  const parsed = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
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

    if (result.muted) {
      await trackModActivity(SYSTEM_ACTOR_ID, {
        entityType: 'user',
        entityId: userId,
        activity: 'mutePendingReview',
      });
      const tracker = new Tracker(req, res);
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

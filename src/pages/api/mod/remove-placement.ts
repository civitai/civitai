/**
 * POST /api/mod/remove-placement
 *
 * Takes a reported sticker placement off the image for everyone.
 *
 * Exists because the moderator app cannot call this: `removePlacementByModerator` settles escrow —
 * a pending placement forfeits, an approved one is taken down after the owner has already been paid —
 * and that decision must not be reimplemented against the tables from a second service. The web
 * moderator UI reaches the same service through `placement.removePlacement`; this is the REST door
 * for the spoke, and both land on one implementation.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { logToAxiom } from '~/server/logging/client';
import { trackModActivity } from '~/server/services/moderator.service';
import { removePlacementByModerator } from '~/server/services/placement-moderation.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  placementId: z.coerce.number().int().positive(),
  /** The acting moderator. Recorded on the row as `takenDownById`, so it must be a real id. */
  moderatorId: z.coerce.number().int().positive(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const { placementId, moderatorId } = parsed.data;

  try {
    const result = await removePlacementByModerator({ placementId, actorId: moderatorId });

    // Only on a real removal: the service returns `removed: false` when someone else already settled
    // it, and logging that would put a takedown in the record for an action that did not happen.
    if (result.removed) {
      await trackModActivity(moderatorId, {
        // 'placement', not 'image': entity ids are per-type, and filing this under image would put a
        // takedown on whatever image happens to share the id.
        entityType: 'placement',
        entityId: placementId,
        activity: 'removePlacement',
      });
    }

    return res.status(200).json({ placementId, ...result });
  } catch (e) {
    const err = e as Error;
    // The service throws for "no longer exists" and "already <status>" — both are the caller's
    // problem to report, not server faults, so they come back as 400 with the message intact.
    const expected = err.message.startsWith('placement:');
    if (!expected) {
      logToAxiom({
        type: 'error',
        name: 'mod-remove-placement-error',
        message: err.message,
        details: { placementId, moderatorId },
      });
    }
    return res.status(expected ? 400 : 500).json({ error: err.message });
  }
});

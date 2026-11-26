import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { PURGE_ARCHIVE_REFUSAL } from '@civitai/shared/account-action-texts';
import { Tracker } from '~/server/clickhouse/client';
import { ProfileArchiveRefusedError, removeAllContent } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
  /** Who the caller says ordered the wipe. Unverified: named on alerts, never stored as the actor. */
  moderatorId: z.coerce.number().int().positive().optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId, moderatorId } = schema.parse(req.query);

  let incomplete: string[];
  try {
    ({ incomplete } = await removeAllContent({
      id: userId,
      claimedModeratorId: moderatorId ?? null,
    }));
  } catch (e) {
    // A 503 the moderator app tells apart from a lost answer by its message: nothing was deleted.
    if (e instanceof ProfileArchiveRefusedError)
      return res.status(503).json({ message: PURGE_ARCHIVE_REFUSAL });
    throw e;
  }
  new Tracker(req, res).userActivity({ type: 'RemoveContent', targetUserId: userId });

  return res.status(200).json({ userId, incomplete });
});

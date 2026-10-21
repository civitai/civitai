import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import { LEGAL_HOLD_REFUSAL, LegalHoldError } from '~/server/services/legal-hold.service';
import { removeAllContent } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId } = schema.parse(req.query);

  try {
    await removeAllContent({ id: userId });
  } catch (e) {
    if (e instanceof LegalHoldError) return res.status(403).json({ error: LEGAL_HOLD_REFUSAL });
    throw e;
  }
  const tracker = new Tracker(req, res);
  tracker.userActivity({
    type: 'RemoveContent',
    targetUserId: userId,
  });

  return res.status(200).json({
    userId,
  });
});

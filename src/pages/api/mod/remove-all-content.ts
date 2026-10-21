import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { Tracker } from '~/server/clickhouse/client';
import {
  LEGAL_HOLD_REFUSAL,
  LEGAL_HOLD_STOPPED,
  LegalHoldError,
  LegalHoldStoppedError,
} from '~/server/services/legal-hold.service';
import { removeAllContent } from '~/server/services/user.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  userId: z.coerce.number(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId } = schema.parse(req.query);

  const track = () =>
    new Tracker(req, res).userActivity({
      type: 'RemoveContent',
      targetUserId: userId,
    });
  try {
    await removeAllContent({ id: userId });
  } catch (e) {
    // Part of the account was deleted, so it is recorded like a wipe that finished.
    if (e instanceof LegalHoldStoppedError) {
      track();
      return res.status(409).json({ error: LEGAL_HOLD_STOPPED });
    }
    if (e instanceof LegalHoldError) return res.status(403).json({ error: LEGAL_HOLD_REFUSAL });
    throw e;
  }
  track();

  return res.status(200).json({
    userId,
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { refreshSession } from '~/server/auth/session-invalidation';
import { zc } from '~/utils/schema-helpers';

const schema = z.object({
  userId: zc.numberString,
  reset: zc.booleanString.optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId, reset } = schema.parse(req.query);
  if (reset) await refreshSession(userId);

  const hiddenPreferences = await getAllHiddenForUser({ userId, refreshCache: reset });

  return res.status(200).json({
    reset,
    ...hiddenPreferences,
  });
});

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { getAllHiddenForUser } from '~/server/services/user-preferences.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { invalidateSession } from '~/server/utils/session-helpers';
import { zc } from '~/utils/schema-helpers';

const schema = z.object({
  userId: zc.numberString,
  reset: zc.booleanString.optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId, reset } = schema.parse(req.query);
  if (reset) await invalidateSession(userId);

  const hiddenPreferences = await getAllHiddenForUser({ userId, refreshCache: reset });
  const sessionCache = await redis.get(`${REDIS_KEYS.SESSION.BASE}:${userId}`);

  return res.status(200).json({
    sessionCache,
    reset,
    ...hiddenPreferences,
  });
});

import { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { redis } from '~/server/redis/client';
import { userCache } from '~/server/services/user-cache.service';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { invalidateSession } from '~/server/utils/session-helpers';
import { zc } from '~/utils/schema-helpers';

const schema = z.object({
  userId: zc.numberString,
  reset: zc.booleanString.optional(),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { userId, reset } = schema.parse(req.query);
  const cache = userCache(userId);
  if (reset) {
    await invalidateSession(userId);
    cache.hidden.all.refresh();
  }
  const sessionCache = await redis.get(`session:${userId}`);

  return res.status(200).json({
    sessionCache,
    reset,
    ...(await cache.hidden.all.get()),
  });
});

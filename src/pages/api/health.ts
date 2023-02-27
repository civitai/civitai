import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const handler = WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const dbCheck = await dbWrite.user.findUnique({ where: { id: 1 } });
  const redisCheck = await redis.get('session:1');

  return res.status(200).json({ healthy: true, db: dbCheck !== null, redis: redisCheck !== null });
});

export default handler;

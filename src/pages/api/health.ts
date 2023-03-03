import { NextApiRequest, NextApiResponse } from 'next';
import { dbWrite, dbRead } from '~/server/db/client';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const handler = WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const writeDbCheck = await dbWrite.user.update({
    where: { id: -1 },
    data: { username: 'civitai' },
    select: { id: true },
  });
  const readDbCheck = await dbRead.user.findUnique({ where: { id: 1 }, select: { id: true } });
  const redisCheck = await redis.get('session:1');

  return res.status(200).json({
    healthy: true,
    writeDb: writeDbCheck !== null,
    readDb: readDbCheck !== null,
    redis: redisCheck !== null,
  });
});

export default handler;

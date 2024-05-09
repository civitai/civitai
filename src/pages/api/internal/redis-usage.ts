import { NextApiRequest, NextApiResponse } from 'next';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { formatBytes } from '~/utils/number-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const memoryByType: Record<string, number> = {};
  const stream = redis.scanIterator({
    MATCH: req.query.pattern as string,
    COUNT: 10000,
  });
  const i = 0;
  for await (const key of stream) {
    const keyType = await redis.type(key);
    const memoryUsage = (await redis.memoryUsage(key)) || 0;

    // Accumulate memory usage by type
    if (!memoryByType[keyType]) memoryByType[keyType] = 0;
    memoryByType[keyType] += memoryUsage;
  }

  return res
    .status(200)
    .json([
      ...Object.entries(memoryByType).map(([key, value]) => ({ key, value: formatBytes(value) })),
    ]);
});

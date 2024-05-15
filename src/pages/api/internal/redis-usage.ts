import { NextApiRequest, NextApiResponse } from 'next';
import { redis } from '~/server/redis/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { formatBytes } from '~/utils/number-helpers';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const memoryByType: Record<string, number> = {};
  const stats = {
    total: 0,
    no_ttl: 0,
  };
  const stream = redis.scanIterator({
    MATCH: req.query.pattern as string,
    COUNT: 10000,
  });
  for await (const key of stream) {
    stats.total++;

    const keyType = await redis.type(key);
    const memoryUsage = (await redis.memoryUsage(key)) || 0;
    const ttl = await redis.ttl(key);
    if (ttl === -1) stats.no_ttl++;

    // Accumulate memory usage by type
    if (!memoryByType[keyType]) memoryByType[keyType] = 0;
    memoryByType[keyType] += memoryUsage;
  }

  return res.status(200).json({
    memory_use: Object.fromEntries(
      Object.entries(memoryByType).map(([key, value]) => [key, formatBytes(value)])
    ),
    ...stats,
  });
});

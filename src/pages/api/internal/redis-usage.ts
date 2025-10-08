import type { NextApiRequest, NextApiResponse } from 'next';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
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
  for await (const keys of stream) {
    // scanIterator yields arrays of keys in v5
    for (const key_ of keys) {
      const key = key_ as RedisKeyTemplateCache;

      stats.total++;

      const [keyType, memoryUsage, ttl] = await Promise.all([
        redis.type(key),
        redis.memoryUsage(key),
        redis.ttl(key),
      ]);
      if (ttl === -1) stats.no_ttl++;

      // Accumulate memory usage by type
      if (!memoryByType[keyType]) memoryByType[keyType] = 0;
      memoryByType[keyType] += memoryUsage ?? 0;
    }
  }

  return res.status(200).json({
    memory_use: Object.fromEntries(
      Object.entries(memoryByType).map(([key, value]) => [key, formatBytes(value)])
    ),
    ...stats,
  });
});

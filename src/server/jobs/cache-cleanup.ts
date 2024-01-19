import { createJob } from './job';
import { redis, REDIS_KEYS } from '~/server/redis/client';

export const cacheCleanup = createJob('cache-cleanup', '0 */1 * * *', async () => {
  // Clear limiter counts
  // Don't need to worry about loss because they recover from clickhouse data
  await redis.del(REDIS_KEYS.DOWNLOAD.COUNT);
  await redis.del(REDIS_KEYS.GENERATION.COUNT);
});

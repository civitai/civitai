import { createJob } from './job';
import { redis, REDIS_KEYS } from '~/server/redis/client';

export const cacheCleanup = createJob('cache-cleanup', '0 5 * * *', async () => {
  await redis.del(REDIS_KEYS.DOWNLOAD.COUNT);
});

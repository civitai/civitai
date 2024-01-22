import { createJob } from './job';
import { redis, REDIS_KEYS } from '~/server/redis/client';

export const cacheCleanup = createJob('cache-cleanup', '0 */1 * * *', async () => {
  // Nothing to do here for now since we're not using an hSet anymore...
});

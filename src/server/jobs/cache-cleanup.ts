import { createJob } from './job';
import { redis } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';

export const cacheCleanup = createJob('cache-cleanup', '0 */1 * * *', async () => {
  // Clean rate limit keys
  const limitKeys = await redis.sMembers('trpc:limit:keys');
  const limitCutoff = Date.now() - CacheTTL.day * 1000; // 24 hours
  for (const limitKey of limitKeys) {
    const keys = await redis.hGetAll(limitKey);
    const toRemove = new Set<string>();
    for (const [key, attempts] of Object.entries(keys)) {
      const relevantAttempts = JSON.parse(attempts).filter((x: number) => x > limitCutoff);
      if (relevantAttempts.length === 0) toRemove.add(key);
    }
    if (toRemove.size > 0) await redis.hDel(limitKey, [...toRemove]);
  }
});

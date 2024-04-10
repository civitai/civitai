import { createJob } from './job';
import { redis } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';

export const cacheCleanup = createJob('cache-cleanup', '0 */1 * * *', async () => {
  // Clean rate limit keys
  const limitKeys = await redis.sMembers('trpc:limit:keys');
  const limitCutoff = Date.now() - CacheTTL.day * 1000;
  for (const limitKey of limitKeys) {
    const keys = await redis.hGetAll(limitKey);
    const toRemove = new Set<string>();
    for (const [key, attempts] of Object.entries(keys)) {
      const relevantAttempts = JSON.parse(attempts).filter((x: number) => x > limitCutoff);
      if (relevantAttempts.length === 0) toRemove.add(key);
    }
    if (toRemove.size > 0) await redis.hDel(limitKey, [...toRemove]);
  }

  // Clean invalid token ids
  const invalidTokenIds = await redis.hGetAll('session:invalid-tokens');
  const toRemove = new Set<string>();
  const tokenCutoff = Date.now() - CacheTTL.month * 1000;
  for (const [key, value] of Object.entries(invalidTokenIds)) {
    if (Number(value) < tokenCutoff) toRemove.add(key);
  }
  if (toRemove.size > 0) await redis.hDel('session:invalid-tokens', [...toRemove]);
});

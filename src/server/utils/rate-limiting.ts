import type { RedisKeyStringsCache, RedisKeyStringsSys } from '~/server/redis/client';
import { redis, sysRedis } from '~/server/redis/client';

export function createLimiter({
  counterKey,
  limitKey,
  fetchCount,
  refetchInterval = 60 * 60,
  fetchOnUnknown = false,
}: {
  counterKey: RedisKeyStringsCache;
  limitKey: RedisKeyStringsSys;
  fetchCount: (userKey: string) => Promise<number>;
  refetchInterval?: number; // in seconds
  fetchOnUnknown?: boolean;
}) {
  async function populateCount(userKey: string) {
    const fetchedCount = await fetchCount(userKey);
    await redis.set(`${counterKey}:${userKey}`, fetchedCount, {
      EX: refetchInterval,
    });
    return fetchedCount;
  }

  async function getCount(userKey: string) {
    const countStr = await redis.get(`${counterKey}:${userKey}`);
    if (!countStr) return fetchOnUnknown ? await populateCount(userKey) : undefined;

    // Handle missing TTL
    const ttl = await redis.ttl(`${counterKey}:${userKey}`);
    if (ttl < 0) return await populateCount(userKey);

    return Number(countStr);
  }

  async function setLimitHitTime(userKey: string) {
    await sysRedis.set(`${limitKey}:${userKey}`, Date.now(), {
      EX: refetchInterval,
    });
  }

  async function getLimit(userKey: string, fallbackKey = 'default') {
    const cachedLimit = await sysRedis.hmGet(limitKey, [userKey, fallbackKey]);
    return Number(cachedLimit?.[0] ?? cachedLimit?.[1] ?? 0);
  }

  async function hasExceededLimit(userKey: string, fallbackKey = 'default') {
    const count = await getCount(userKey);
    if (count === undefined) return false;

    const limit = await getLimit(userKey, fallbackKey);
    return limit !== 0 && count > limit;
  }

  async function increment(userKey: string, by = 1) {
    // Ensure key exists before incrementing
    const exists = await redis.exists(`${counterKey}:${userKey}`);
    if (!exists) await populateCount(userKey);

    // Increment and get new count
    const newCount = await redis.incrBy(`${counterKey}:${userKey}`, by);

    // Check if limit exceeded and set limit hit time
    const limit = await getLimit(userKey);
    if (limit !== 0 && newCount > limit) await setLimitHitTime(userKey);
    return newCount;
  }

  async function getLimitHitTime(userKey: string) {
    const limitHitTime = await sysRedis.get(`${limitKey}:${userKey}`);
    if (!limitHitTime) return undefined;
    return new Date(Number(limitHitTime));
  }

  async function reset(userKey: string) {
    await redis.del(`${counterKey}:${userKey}`);
    await sysRedis.del(`${limitKey}:${userKey}`);
  }

  return {
    hasExceededLimit,
    getLimitHitTime,
    increment,
    getCount,
    reset,
  };
}

import { redis } from '~/server/redis/client';

type GetLimiterOptions = {
  counterKey: string;
  limitKey: string;
  fetchCount: (userKey: string) => Promise<number>;
  refetchInterval?: number; // in seconds
  fetchOnUnknown?: boolean;
};
export function createLimiter({
  counterKey,
  limitKey,
  fetchCount,
  refetchInterval = 60 * 60,
  fetchOnUnknown = false,
}: GetLimiterOptions) {
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
    await redis.set(`${limitKey}:${userKey}`, Date.now(), {
      EX: refetchInterval,
    });
  }

  async function getLimit(userKey: string, fallbackKey = 'default') {
    const cachedLimit = await redis.hmGet(limitKey, [userKey, fallbackKey]);
    return Number(cachedLimit?.[0] ?? cachedLimit?.[1] ?? 0);
  }

  async function hasExceededLimit(userKey: string, fallbackKey = 'default') {
    const count = await getCount(userKey);
    if (count === undefined) return false;

    const limit = await getLimit(userKey, fallbackKey);
    return limit !== 0 && count > limit;
  }

  async function increment(userKey: string, by = 1) {
    let count = await getCount(userKey);
    if (count === undefined) count = await populateCount(userKey);
    await redis.incrBy(`${counterKey}:${userKey}`, by);

    const limit = await getLimit(userKey);
    if (limit !== 0 && count && count + by > limit) await setLimitHitTime(userKey);
  }

  async function getLimitHitTime(userKey: string) {
    const limitHitTime = await redis.get(`${limitKey}:${userKey}`);
    if (!limitHitTime) return undefined;
    return new Date(Number(limitHitTime));
  }

  return {
    hasExceededLimit,
    getLimitHitTime,
    increment,
  };
}

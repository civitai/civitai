import { NextApiRequest, NextApiResponse } from 'next';
import { getServerAuthSession } from '~/server/utils/get-server-auth-session';
import requestIp from 'request-ip';
import { redis, redisLegacy } from '~/server/redis/client';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { env } from '~/env/server.mjs';

const limiterOptions = {
  points: 30, // allow points
  duration: 60, // per second
};
const unauthedPointCost = 6;
const rateLimiter = new RateLimiterRedis({
  storeClient: redisLegacy,
  keyPrefix: 'rate-limiter',
  inMemoryBlockOnConsumed: limiterOptions.points,
  ...limiterOptions,
});

const isRateLimited = async (req: NextApiRequest, res: NextApiResponse, resourceKey = 'base') => {
  if (!env.RATE_LIMITING) return false;

  const session = await getServerAuthSession({ req, res });
  const requesterKey = session?.user?.id ?? requestIp.getClientIp(req);
  const pointCost = !!session?.user ? 1 : unauthedPointCost;

  res.setHeader('X-RateLimit-Limit', Math.floor(limiterOptions.points / pointCost));
  try {
    const rateLimiterRes = await rateLimiter.consume(`${resourceKey}:${requesterKey}`, pointCost);
    res.setHeader('X-RateLimit-Remaining', Math.floor(rateLimiterRes.remainingPoints / pointCost));
  } catch (e: any) {
    if (e instanceof Error) {
      // Some redis error
      console.error(e);
      return false;
    }

    const secs = Math.ceil(e.msBeforeNext / 1000) || 1;
    res.setHeader('Retry-After', String(secs));
    res.setHeader('X-RateLimit-Remaining', 0);
    res.status(429).json({ error: 'Too Many Requests' });

    return true;
  }

  return false;
};

export const RateLimitedEndpoint =
  (
    handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void | NextApiResponse<any>>,
    allowedMethods: string[] = ['GET'],
    resourceKey = 'base'
  ) =>
  async (req: NextApiRequest, res: NextApiResponse) => {
    if (!req.method || !allowedMethods.includes(req.method))
      return res.status(405).json({ error: 'Method not allowed' });

    if (await isRateLimited(req, res, resourceKey)) return;

    await handler(req, res);
  };

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

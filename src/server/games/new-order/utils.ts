import dayjs from 'dayjs';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { handleLogError } from '~/server/utils/errorHandling';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

type NewOrderRedisKeyString = Values<typeof REDIS_SYS_KEYS.NEW_ORDER>;
type NewOrderRedisKey = `${NewOrderRedisKeyString}${'' | `:${string}`}`;

type CounterOptions = {
  key: NewOrderRedisKey;
  fetchCount: (id: number | string) => Promise<number>;
  ttl?: number;
  ordered?: boolean;
};

export type NewOrderCounter = ReturnType<typeof createCounter>;

function createCounter({ key, fetchCount, ttl = CacheTTL.day, ordered }: CounterOptions) {
  async function populateCount(id: number | string) {
    const fetchedCount = await fetchCount(id);
    if (ordered) {
      const promises: Promise<unknown>[] = [
        sysRedis.zAdd(key, { score: fetchedCount, value: id.toString() }),
      ];
      if (ttl !== 0) promises.push(sysRedis.expire(key, ttl));
      await Promise.all(promises);
    } else {
      const promises: Promise<unknown>[] = [sysRedis.hSet(key, id.toString(), fetchedCount)];
      if (ttl !== 0) promises.push(sysRedis.hExpire(key, id.toString(), ttl));
      await Promise.all(promises);
    }

    return fetchedCount;
  }

  async function getAll(opts?: { limit?: number; offset?: number }): Promise<string[]>;
  async function getAll(opts?: {
    limit?: number;
    offset?: number;
    withCount: true;
  }): Promise<{ score: number; value: string }[]>;
  async function getAll(opts?: { limit?: number; offset?: number; withCount?: boolean }) {
    const { limit = 100, offset = 0, withCount = false } = opts ?? {};
    // Returns all ids in the range of min and max
    // If ordered, returns the ids by the score in descending order.
    if (ordered) {
      const data = await sysRedis.zRangeWithScores(key, Infinity, -Infinity, {
        BY: 'SCORE',
        REV: true,
        LIMIT: { offset, count: limit },
      });

      return withCount ? data : data.map((x) => x.value);
    }

    const data = await sysRedis.hGetAll(key);
    return withCount
      ? Object.entries(data)
          .map(([value, score]) => ({ score, value }))
          .slice(offset, offset + limit)
      : Object.values(data).slice(offset, offset + limit);
  }

  async function getCount(id: number | string) {
    const countStr = ordered
      ? await sysRedis.zScore(key, id.toString())
      : await sysRedis.hGet(key, id.toString());
    if (!countStr) return await populateCount(id);

    return Number(countStr);
  }

  async function increment({ id, value = 1 }: { id: number | string; value?: number }) {
    let count = await getCount(id);
    if (!count) count = await populateCount(id);

    const absValue = Math.abs(value); // Make sure we are using positive number
    if (ordered) await sysRedis.zIncrBy(key, absValue, id.toString());
    else await sysRedis.hIncrBy(key, id.toString(), absValue);

    return count + absValue;
  }

  async function decrement({ id, value = 1 }: { id: number | string; value?: number }) {
    let count = await getCount(id);
    if (!count) count = await populateCount(id);

    const absValue = Math.abs(value); // Make sure we are using positive number
    const newValue = Math.max(0, count - absValue); // Ensure we don't go below 0
    if (newValue > 0) {
      if (ordered) await sysRedis.zIncrBy(key, absValue * -1, id.toString());
      else await sysRedis.hIncrBy(key, id.toString(), absValue * -1);
    } else {
      await reset({ id }); // Reset the count if it goes below 0
    }

    return newValue;
  }

  async function reset({
    id,
    all,
  }: { id: number | string | (number | string)[]; all?: never } | { all: true; id?: never }) {
    if (all) return sysRedis.del(key);

    const ids = Array.isArray(id) ? id : [id];
    const stringIds = ids.map(String);

    return ordered ? sysRedis.zRem(key, stringIds) : sysRedis.hDel(key, stringIds);
  }

  async function exists(id: number | string) {
    const countStr = ordered
      ? await sysRedis.zScore(key, id.toString())
      : await sysRedis.hGet(key, id.toString());

    return countStr !== null && countStr !== undefined;
  }

  return { increment, decrement, reset, getCount, getAll, exists, key };
}

export const correctJudgmentsCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.CORRECT,
  fetchCount: async (id) => {
    if (!clickhouse) return 0;

    const player = await dbRead.newOrderPlayer.findUnique({
      where: { userId: Number(id) },
      select: { startAt: true },
    });
    if (!player) return 0;

    // Use 7-day rolling window for fervor calculation, but respect career resets
    const sevenDaysAgo = dayjs().subtract(7, 'days').toDate();
    const effectiveStartDate = player.startAt > sevenDaysAgo ? player.startAt : sevenDaysAgo;

    const data = await clickhouse.$query<{ count: number }>`
      SELECT
        COUNT(*) as count
      FROM knights_new_order_image_rating
      WHERE userId = ${id}
        AND createdAt >= ${effectiveStartDate}
        AND status = '${NewOrderImageRatingStatus.Correct}'
    `;
    if (!data) return 0;

    return data[0]?.count ?? 0;
  },
  ttl: CacheTTL.day, // Shorter TTL for rolling window
});

export const allJudgmentsCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.ALL,
  fetchCount: async (id) => {
    if (!clickhouse) return 0;

    const player = await dbRead.newOrderPlayer.findUnique({
      where: { userId: Number(id) },
      select: { startAt: true },
    });
    if (!player) return 0;

    // Use 7-day rolling window for fervor calculation, but respect career resets
    const sevenDaysAgo = dayjs().subtract(7, 'days').toDate();
    const effectiveStartDate = player.startAt > sevenDaysAgo ? player.startAt : sevenDaysAgo;

    const data = await clickhouse.$query<{ count: number }>`
      SELECT
        COUNT(*) as count
      FROM knights_new_order_image_rating
      WHERE userId = ${id}
        AND createdAt >= ${effectiveStartDate}
        AND status IN ('${NewOrderImageRatingStatus.Correct}', '${NewOrderImageRatingStatus.Failed}', '${NewOrderImageRatingStatus.Inconclusive}')
    `;
    if (!data) return 0;

    return data[0]?.count ?? 0;
  },
  ttl: CacheTTL.day, // Shorter TTL for rolling window
});

export const acolyteFailedJudgments = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.ACOLYTE_FAILED,
  fetchCount: async () => 0,
  ttl: CacheTTL.week,
});

export const sanityCheckFailuresCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.FAILURES,
  fetchCount: async () => 0,
  ttl: CacheTTL.day,
});

export const fervorCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.FERVOR,
  fetchCount: async (id) => {
    const data = await dbRead.newOrderPlayer.findUnique({
      where: { userId: Number(id) },
      select: { fervor: true },
    });
    if (!data) return 0;

    return data.fervor;
  },
  ttl: CacheTTL.week,
  ordered: true,
});

export const smitesCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.SMITE,
  fetchCount: async (id) => {
    const data = await dbRead.newOrderSmite.count({
      where: { targetPlayerId: Number(id), cleansedAt: null },
    });

    return data;
  },
  ttl: CacheTTL.week,
});

export const blessedBuzzCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.BUZZ,
  fetchCount: async () => 0,
  ttl: CacheTTL.week,
});

export const expCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.EXP,
  fetchCount: async (id) => {
    const data = await dbRead.newOrderPlayer.findUnique({
      where: { userId: Number(id) },
      select: { exp: true },
    });
    if (!data) return 0;

    return data.exp;
  },
  ttl: CacheTTL.week,
});

export const poolKeys = {
  [NewOrderRankType.Acolyte]: [
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte1`,
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte2`,
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte3`,
  ],
  [NewOrderRankType.Knight]: [
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight1`,
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight2`,
    // Temporarily disabled Knight3 queue
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight3`,
  ],
  [NewOrderRankType.Templar]: [
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar1`,
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar2`,
    `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar3`,
  ],
};

export const poolCounters = {
  [NewOrderRankType.Acolyte]: poolKeys[NewOrderRankType.Acolyte].map((key) =>
    createCounter({
      key: key as NewOrderRedisKey,
      fetchCount: async () => 0,
      ttl: 0,
      ordered: true,
    })
  ),
  [NewOrderRankType.Knight]: poolKeys[NewOrderRankType.Knight].map((key) =>
    createCounter({
      key: key as NewOrderRedisKey,
      fetchCount: async () => 0,
      ttl: CacheTTL.week,
      ordered: true,
    })
  ),
  [NewOrderRankType.Templar]: poolKeys[NewOrderRankType.Templar].map((key) =>
    createCounter({
      key: key as NewOrderRedisKey,
      fetchCount: async () => 0,
      ttl: CacheTTL.week,
      ordered: true,
    })
  ),
  Inquisitor: [
    createCounter({
      key: `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Inquisitor`,
      fetchCount: async () => 0,
      ttl: 0,
      ordered: true,
    }),
  ],
};

export const getImageRatingsCounter = (imageId: number) => {
  const key = `${REDIS_SYS_KEYS.NEW_ORDER.RATINGS}:${imageId}`;
  const counter = createCounter({
    key: key as NewOrderRedisKey,
    fetchCount: async (id: number | string) => {
      if (typeof id !== 'string') {
        return 0; // Do nothing, this is not intended here.
      }

      const [rank, nsfwLevel] = id.split('-');
      if (!rank || !nsfwLevel) {
        return 0;
      }

      if (!clickhouse) {
        return 0;
      }

      const data = await clickhouse.$query<{ count: number }>`
        SELECT
          COUNT(*) as count
        FROM knights_new_order_image_rating
        WHERE "imageId" = ${imageId} AND rank = '${rank}' AND rating = ${nsfwLevel}
      `;

      const count = data[0]?.count ?? 0;
      return count;
    },
    ttl: CacheTTL.day,
    ordered: true,
  });

  return counter;
};

// Rate limiting configuration for voting
export const VOTING_RATE_LIMITS = {
  perMinute: 75, // Max votes per minute
  perHour: 4500, // Max votes per hour
  abuseThreshold: 4510, // Auto-reset career threshold per hour
} as const;

// Simple sliding window rate limiter for voting
export async function checkVotingRateLimit(userId: number): Promise<{
  allowed: boolean;
  remaining: number;
  resetTime: number;
  isAbuse: boolean;
}> {
  if (!redis) {
    return {
      allowed: true,
      remaining: VOTING_RATE_LIMITS.perMinute,
      resetTime: Date.now() + 60000,
      isAbuse: false,
    };
  }

  const now = Date.now();
  const minuteKey = `${REDIS_KEYS.CACHES.NEW_ORDER.RATE_LIMIT.MINUTE}:${userId}` as const;
  const hourKey = `${REDIS_KEYS.CACHES.NEW_ORDER.RATE_LIMIT.HOUR}:${userId}` as const;
  const minuteWindow = 60 * 1000; // 1 minute
  const hourWindow = 60 * 60 * 1000; // 1 hour

  try {
    // Clean up old entries
    await redis.zRemRangeByScore(minuteKey, '-inf', now - minuteWindow);
    await redis.zRemRangeByScore(hourKey, '-inf', now - hourWindow);

    // Count current requests
    const [minuteCount, hourCount] = await Promise.all([
      redis.zCard(minuteKey),
      redis.zCard(hourKey),
    ]);

    // Check limits
    const minuteAllowed = minuteCount < VOTING_RATE_LIMITS.perMinute;
    const hourAllowed = hourCount < VOTING_RATE_LIMITS.perHour;
    const isAbuse = hourCount >= VOTING_RATE_LIMITS.abuseThreshold;
    const allowed = minuteAllowed && hourAllowed && !isAbuse;

    if (allowed) {
      // Add current request
      const requestId = `${now}-${Math.random()}`;
      await Promise.all([
        redis.zAdd(minuteKey, { score: now, value: requestId }),
        redis.zAdd(hourKey, { score: now, value: requestId }),
        redis.expire(minuteKey, 60),
        redis.expire(hourKey, 3600),
      ]);
    }

    return {
      allowed,
      remaining: Math.max(0, VOTING_RATE_LIMITS.perMinute - minuteCount - (allowed ? 1 : 0)),
      resetTime: now + minuteWindow,
      isAbuse,
    };
  } catch (error) {
    handleLogError(error as Error, `Rate limiting failed for user ${userId}`);
    // Fallback to allow if Redis fails
    return {
      allowed: true,
      remaining: VOTING_RATE_LIMITS.perMinute,
      resetTime: now + 60000,
      isAbuse: false,
    };
  }
}

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
    const { limit, offset = 0, withCount = false } = opts ?? {};
    // Returns all ids in the range of min and max
    // If ordered, returns the ids by the score in descending order.
    if (ordered) {
      const data = await sysRedis.zRangeWithScores(key, Infinity, -Infinity, {
        BY: 'SCORE',
        REV: true,
        LIMIT: limit ? { offset, count: limit } : undefined,
      });

      return withCount ? data : data.map((x) => x.value);
    }

    const data = await sysRedis.hGetAll(key);
    const entries = withCount
      ? Object.entries(data).map(([value, score]) => ({ value, score: Number(score) }))
      : Object.values(data);

    return limit ? entries.slice(offset, offset + limit) : entries;
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

    // Optimized query using argMax instead of FINAL for better performance
    // Groups by imageId to get latest status per rating, then counts Correct ones
    const data = await clickhouse.$query<{ count: number }>`
      SELECT COUNT(*) as count
      FROM (
        SELECT
          imageId,
          argMax(status, createdAt) as latest_status
        FROM knights_new_order_image_rating
        WHERE userId = ${id}
          AND createdAt >= ${effectiveStartDate}
        GROUP BY imageId
      )
      WHERE latest_status = '${NewOrderImageRatingStatus.Correct}'
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

    // Optimized query using argMax instead of FINAL for better performance
    // Groups by imageId to get latest status per rating, then counts finalized judgments
    const data = await clickhouse.$query<{ count: number }>`
      SELECT COUNT(*) as count
      FROM (
        SELECT
          imageId,
          argMax(status, createdAt) as latest_status
        FROM knights_new_order_image_rating
        WHERE userId = ${id}
          AND createdAt >= ${effectiveStartDate}
        GROUP BY imageId
      )
      WHERE latest_status IN ('${NewOrderImageRatingStatus.Correct}', '${NewOrderImageRatingStatus.Failed}', '${NewOrderImageRatingStatus.Inconclusive}')
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
  ttl: 0, // Changed from CacheTTL.week - recalculated daily by newOrderDailyReset job
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
  fetchCount: async (id) => {
    if (!clickhouse) return 0;

    // Query player's career start date to respect resets
    const player = await dbRead.newOrderPlayer.findUnique({
      where: { userId: Number(id) },
      select: { startAt: true },
    });
    if (!player) return 0;

    // Query ClickHouse for exp from last 3 days that hasn't been granted yet
    // Anything older than 3 days should have been granted already
    // Only count judgments after player's career start date
    const startDate = dayjs().subtract(3, 'days').startOf('day').toDate();
    const endDate = dayjs().endOf('day').toDate();

    const result = await clickhouse.$query<{ totalExp: number }>`
      SELECT SUM(grantedExp * multiplier) as totalExp
      FROM knights_new_order_image_rating
      WHERE userId = ${Number(id)}
        AND createdAt >= ${player.startAt}
        AND createdAt BETWEEN ${startDate} AND ${endDate}
        AND status IN ('${NewOrderImageRatingStatus.Correct}', '${
      NewOrderImageRatingStatus.Failed
    }')
    `.catch(handleLogError);

    return result?.[0]?.totalExp ?? 0;
  },
  ttl: 0, // Never expire - granting jobs handle cleanup
});

export const pendingBuzzCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.PENDING_BUZZ,
  fetchCount: async (id) => {
    if (!clickhouse) return 0;

    // Query player's career start date to respect resets
    const player = await dbRead.newOrderPlayer.findUnique({
      where: { userId: Number(id) },
      select: { startAt: true },
    });
    if (!player) return 0;

    // Calculate what will be granted in the next cycle
    // Next job run is tomorrow at 00:00 UTC, which grants exactly 3 days before that
    const nextGrantDate = dayjs().add(1, 'day').startOf('day'); // Tomorrow 00:00 UTC
    const grantingDate = nextGrantDate.subtract(3, 'days'); // 3 days before next run
    const startDate = grantingDate.startOf('day').toDate();
    const endDate = grantingDate.endOf('day').toDate();

    const result = await clickhouse.$query<{ totalExp: number }>`
      SELECT SUM(grantedExp * multiplier) as totalExp
      FROM knights_new_order_image_rating
      WHERE userId = ${Number(id)}
        AND createdAt >= ${player.startAt}
        AND createdAt BETWEEN ${startDate} AND ${endDate}
        AND status IN ('${NewOrderImageRatingStatus.Correct}', '${
      NewOrderImageRatingStatus.Failed
    }')
    `.catch(handleLogError);

    return result?.[0]?.totalExp ?? 0;
  },
  ttl: CacheTTL.day,
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
  [NewOrderRankType.Acolyte]: {
    a: [
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte1:a`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte2:a`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte3:a`,
    ],
    b: [
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte1:b`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte2:b`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Acolyte3:b`,
    ],
  },
  [NewOrderRankType.Knight]: {
    a: [
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight1:a`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight2:a`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight3:a`,
    ],
    b: [
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight1:b`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight2:b`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Knight3:b`,
    ],
  },
  [NewOrderRankType.Templar]: {
    a: [
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar1:a`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar2:a`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar3:a`,
    ],
    b: [
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar1:b`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar2:b`,
      `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Templar3:b`,
    ],
  },
};

export const poolCounters = {
  [NewOrderRankType.Acolyte]: {
    a: poolKeys[NewOrderRankType.Acolyte].a.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: async () => 0,
        ttl: 0,
        ordered: true,
      })
    ),
    b: poolKeys[NewOrderRankType.Acolyte].b.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: async () => 0,
        ttl: 0,
        ordered: true,
      })
    ),
  },
  [NewOrderRankType.Knight]: {
    a: poolKeys[NewOrderRankType.Knight].a.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: async () => 0,
        ttl: 0,
        ordered: true,
      })
    ),
    b: poolKeys[NewOrderRankType.Knight].b.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: async () => 0,
        ttl: 0,
        ordered: true,
      })
    ),
  },
  [NewOrderRankType.Templar]: {
    a: poolKeys[NewOrderRankType.Templar].a.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: async () => 0,
        ttl: 0,
        ordered: true,
      })
    ),
    b: poolKeys[NewOrderRankType.Templar].b.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: async () => 0,
        ttl: 0,
        ordered: true,
      })
    ),
  },
  Inquisitor: {
    a: [
      createCounter({
        key: `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Inquisitor:a`,
        fetchCount: async () => 0,
        ttl: 0,
        ordered: true,
      }),
    ],
    b: [
      createCounter({
        key: `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Inquisitor:b`,
        fetchCount: async () => 0,
        ttl: 0,
        ordered: true,
      }),
    ],
  },
};

type NewOrderSlot = 'a' | 'b';
export type NewOrderHighRankType = NewOrderRankType | 'Inquisitor';

/**
 * Get the currently active slot for a rank and purpose (filling or rating)
 * @param rank - The rank type to check
 * @param purpose - Whether this is for filling (adding images) or rating (fetching images)
 * @returns The active slot ('a' or 'b')
 */
export async function getActiveSlot(
  rank: NewOrderHighRankType,
  purpose: 'filling' | 'rating'
): Promise<NewOrderSlot> {
  if (!sysRedis) return 'a'; // Default fallback

  const key = `${REDIS_SYS_KEYS.NEW_ORDER.ACTIVE_SLOT}:${rank}:${purpose}` as const;
  const slot = await sysRedis.get(key);
  return (slot as NewOrderSlot) || 'a'; // Default to 'a' if not set
}

/**
 * Set the active slot for a rank and purpose
 * @param rank - The rank type to update
 * @param purpose - Whether this is for filling or rating
 * @param slot - The slot to set as active ('a' or 'b')
 */
export async function setActiveSlot(
  rank: NewOrderHighRankType,
  purpose: 'filling' | 'rating',
  slot: NewOrderSlot
): Promise<void> {
  if (!sysRedis) return;

  const key = `${REDIS_SYS_KEYS.NEW_ORDER.ACTIVE_SLOT}:${rank}:${purpose}` as const;
  await sysRedis.set(key, slot);
}

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

      // Uses the by_imageId projection via GROUP BY imageId, userId with argMax
      const data = await clickhouse.$query<{ count: number }>`
        SELECT count() as count
        FROM (
          SELECT 1
          FROM knights_new_order_image_rating
          WHERE imageId = ${imageId}
          GROUP BY imageId, userId
          HAVING argMax(rank, createdAt) = '${rank}' AND argMax(rating, createdAt) = ${nsfwLevel}
        )
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

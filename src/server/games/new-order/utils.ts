import dayjs from 'dayjs';
import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { NewOrderImageRatingStatus } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS, REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { hSetWithTTL, zAddWithTTL } from '~/server/redis/atomic';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { logToAxiom } from '~/server/logging/client';
import { handleLogError } from '~/server/utils/errorHandling';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

type NewOrderRedisKeyString = Values<typeof REDIS_SYS_KEYS.NEW_ORDER>;
type NewOrderRedisKey = `${NewOrderRedisKeyString}${'' | `:${string}`}`;

type CounterOptions<TId extends number | string = number | string> = {
  key: NewOrderRedisKey;
  /**
   * Fetch counts for one or more IDs. Write this once to handle both single and batch cases.
   * The counter system will call this with [id] for single fetches and ids[] for batch fetches.
   */
  fetchCount: (ids: TId[]) => Promise<Map<TId, number>>;
  ttl?: number;
  ordered?: boolean;
};

export type NewOrderCounter = ReturnType<typeof createCounter>;

function createCounter<TId extends number | string = number | string>({
  key,
  fetchCount,
  ttl = CacheTTL.day,
  ordered,
}: CounterOptions<TId>) {
  async function setCacheValue(id: TId, value: number) {
    // Fail-open wrappers (PR #2332 round-4 audit fix): a sysRedis
    // failover (Phase 4) during a judgment write would otherwise 500 the
    // submission. The counter is a cache mirror of ClickHouse-truth
    // counts (the `fetchCount` callback) — a missed write reverts to a
    // cache miss on the next read and re-hydrates from source. Subtype
    // `write-degraded` matches session-invalidation.updateSessionState.
    // Preserve the `ttl === 0` bypass: PEXPIRE/HPEXPIRE with 0ms would
    // DELETE the key/field (see atomic.ts header — that's why the
    // helpers' ttlMs > 0 guard exists).
    if (ordered) {
      if (ttl !== 0) {
        // Atomic single-EVAL replaces racy Promise.all([zAdd, expire]).
        // ttl===0 path stays bare zAdd — PEXPIRE with 0ms would DELETE the key.
        try {
          await zAddWithTTL(sysRedis, key, value, id.toString(), ttl * 1000);
        } catch (error) {
          logSysRedisFailOpen(
            'write-degraded',
            'new-order.createCounter.zAdd',
            error,
            { key, id }
          );
        }
      } else {
        await sysRedis.zAdd(key, { score: value, value: id.toString() });
      }
    } else {
      if (ttl !== 0) {
        // Atomic single-EVAL replaces racy Promise.all([hSet, hExpire]).
        try {
          await hSetWithTTL(sysRedis, key, id.toString(), value, ttl * 1000);
        } catch (error) {
          logSysRedisFailOpen(
            'write-degraded',
            'new-order.createCounter.hSet',
            error,
            { key, id }
          );
        }
      } else {
        await sysRedis.hSet(key, id.toString(), value);
      }
    }
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

      // The HA/Sentinel sysRedis client hands back BLOB_STRING replies (zset
      // members) as Buffers, which have no string methods. `checkWeightedConsensus`
      // does `vote.value.split('-')` on these → `value.split is not a function`,
      // which was swallowed and returned undefined for EVERY image that reached
      // consensus → mass Inconclusive purges + earnings collapse. Decode members to
      // utf8 so callers get the string they're typed to receive (same coercion as
      // redis/queues.ts getBucketNames).
      const rows = data.map((x) => ({
        value: Buffer.isBuffer(x.value) ? x.value.toString('utf8') : x.value,
        score: x.score,
      }));
      return withCount ? rows : rows.map((x) => x.value);
    }

    const data = await sysRedis.hGetAll(key);
    const entries = withCount
      ? Object.entries(data).map(([value, score]) => ({ value, score: Number(score) }))
      : Object.values(data);

    return limit ? entries.slice(offset, offset + limit) : entries;
  }

  /**
   * Get count for a single ID. Checks cache first, fetches on miss.
   */
  async function getCount(id: TId): Promise<number> {
    const countStr = ordered
      ? await sysRedis.zScore(key, id.toString())
      : await sysRedis.hGet(key, id.toString());

    if (countStr !== null && countStr !== undefined) {
      return Number(countStr);
    }

    // Cache miss - fetch and populate
    const fetched = await fetchCount([id]);
    const count = fetched.get(id) ?? 0;
    await setCacheValue(id, count);
    return count;
  }

  /**
   * Batch fetch counts for multiple IDs efficiently.
   * - First checks Redis cache for all IDs
   * - For cache misses, calls fetchCount once with all missing IDs
   * - Populates cache with fetched values
   * - Returns Map<id, count> for all requested IDs
   */
  async function getCountBatch(ids: TId[]): Promise<Map<TId, number>> {
    if (ids.length === 0) return new Map();

    const result = new Map<TId, number>();
    const cacheMisses: TId[] = [];

    // Check cache for all IDs
    if (ordered) {
      // For sorted sets, we need to check each score individually
      const cacheChecks = await Promise.all(
        ids.map(async (id) => {
          const score = await sysRedis.zScore(key, id.toString());
          return { id, score };
        })
      );

      for (const { id, score } of cacheChecks) {
        if (score !== null && score !== undefined) {
          result.set(id, Number(score));
        } else {
          cacheMisses.push(id);
        }
      }
    } else {
      // For hash sets, we can use hMGet for efficiency
      const stringIds = ids.map((id) => id.toString());
      const cachedValues = await sysRedis.hmGet(key, stringIds);

      for (let i = 0; i < ids.length; i++) {
        const cachedValue = cachedValues[i];
        if (cachedValue !== null && cachedValue !== undefined) {
          result.set(ids[i], Number(cachedValue));
        } else {
          cacheMisses.push(ids[i]);
        }
      }
    }

    // Fetch all cache misses in one call
    if (cacheMisses.length > 0) {
      const fetchedCounts = await fetchCount(cacheMisses);

      // Populate cache and result
      const cachePromises: Promise<void>[] = [];
      for (const id of cacheMisses) {
        const count = fetchedCounts.get(id) ?? 0;
        result.set(id, count);
        cachePromises.push(setCacheValue(id, count));
      }
      await Promise.all(cachePromises);
    }

    return result;
  }

  async function increment({ id, value = 1 }: { id: TId; value?: number }) {
    const count = await getCount(id);

    const absValue = Math.abs(value); // Make sure we are using positive number
    if (ordered) await sysRedis.zIncrBy(key, absValue, id.toString());
    else await sysRedis.hIncrBy(key, id.toString(), absValue);

    return count + absValue;
  }

  async function decrement({ id, value = 1 }: { id: TId; value?: number }) {
    const count = await getCount(id);

    const absValue = Math.abs(value); // Make sure we are using positive number
    const newValue = Math.max(0, count - absValue); // Ensure we don't go below 0
    if (newValue > 0) {
      if (ordered) await sysRedis.zIncrBy(key, absValue * -1, id.toString());
      else await sysRedis.hIncrBy(key, id.toString(), absValue * -1);
    } else {
      // Sorted sets: remove member to clean up leaderboards
      // Hashes: set to 0 to prevent re-fetching stale data
      if (ordered) await reset({ id });
      else await setCacheValue(id, 0);
    }

    return newValue;
  }

  async function reset({ id, all }: { id: TId | TId[]; all?: never } | { all: true; id?: never }) {
    if (all) return sysRedis.del(key);

    const ids = Array.isArray(id) ? id : [id];
    const stringIds = ids.map(String);

    // Redis errors with "wrong number of arguments" if ZREM/HDEL is called with
    // no members. Empty id arrays are a valid no-op (nothing to remove).
    if (stringIds.length === 0) return 0;

    return ordered ? sysRedis.zRem(key, stringIds) : sysRedis.hDel(key, stringIds);
  }

  async function exists(id: TId) {
    const countStr = ordered
      ? await sysRedis.zScore(key, id.toString())
      : await sysRedis.hGet(key, id.toString());

    return countStr !== null && countStr !== undefined;
  }

  return { increment, decrement, reset, getCount, getCountBatch, getAll, exists, key };
}

/**
 * Internal batch fetch for judgment counts.
 * Fetches both correct and all judgment counts in a single ClickHouse query.
 * Used by both judgment counters' fetchCountBatch functions.
 */
async function fetchJudgmentCountsBatchInternal(
  userIds: number[]
): Promise<Map<number, { correctJudgments: number; allJudgments: number }>> {
  const result = new Map<number, { correctJudgments: number; allJudgments: number }>();

  if (!clickhouse || userIds.length === 0) {
    for (const userId of userIds) {
      result.set(userId, { correctJudgments: 0, allJudgments: 0 });
    }
    return result;
  }

  // Get player start dates to determine effective window per user
  const players = await dbRead.newOrderPlayer.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, startAt: true },
  });

  const playerStartDates = new Map(players.map((p) => [p.userId, p.startAt]));
  const sevenDaysAgo = dayjs().subtract(7, 'days').startOf('day').toDate();

  // Initialize all users with zeros
  for (const userId of userIds) {
    result.set(userId, { correctJudgments: 0, allJudgments: 0 });
  }

  // Filter to only users that exist in NewOrderPlayer
  const validUserIds = userIds.filter((id) => playerStartDates.has(id));
  if (validUserIds.length === 0) return result;

  // Single batched query to get all judgment counts
  // Uses countIf to get both correct and all finalized judgments in one pass
  const data = await clickhouse.$query<{
    userId: number;
    correctJudgments: number;
    allJudgments: number;
  }>`
    SELECT
      userId,
      countIf(latest_status = '${NewOrderImageRatingStatus.Correct}') as correctJudgments,
      countIf(latest_status IN ('${NewOrderImageRatingStatus.Correct}', '${
    NewOrderImageRatingStatus.Failed
  }', '${NewOrderImageRatingStatus.Inconclusive}')) as allJudgments
    FROM (
      SELECT
        userId,
        imageId,
        argMax(status, createdAt) as latest_status
      FROM knights_new_order_image_rating
      WHERE userId IN (${validUserIds.join(',')})
        AND createdAt >= ${sevenDaysAgo}
      GROUP BY userId, imageId
    )
    GROUP BY userId
  `;

  // Populate results from query
  for (const row of data) {
    result.set(row.userId, {
      correctJudgments: row.correctJudgments,
      allJudgments: row.allJudgments,
    });
  }

  return result;
}

// Helper to create a zero-returning fetchCount for pool counters
const zeroFetchCount = async (ids: (number | string)[]) => {
  const result = new Map<number | string, number>();
  for (const id of ids) result.set(id, 0);
  return result;
};

export const correctJudgmentsCounter = createCounter<number | string>({
  key: REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.CORRECT,
  fetchCount: async (ids) => {
    const numericIds = ids.map(Number);
    const combined = await fetchJudgmentCountsBatchInternal(numericIds);
    const result = new Map<number | string, number>();
    for (let i = 0; i < ids.length; i++) {
      const counts = combined.get(numericIds[i]);
      result.set(ids[i], counts?.correctJudgments ?? 0);
    }
    return result;
  },
  ttl: CacheTTL.day,
});

export const allJudgmentsCounter = createCounter<number | string>({
  key: REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.ALL,
  fetchCount: async (ids) => {
    const numericIds = ids.map(Number);
    const combined = await fetchJudgmentCountsBatchInternal(numericIds);
    const result = new Map<number | string, number>();
    for (let i = 0; i < ids.length; i++) {
      const counts = combined.get(numericIds[i]);
      result.set(ids[i], counts?.allJudgments ?? 0);
    }
    return result;
  },
  ttl: CacheTTL.day,
});

export const acolyteFailedJudgments = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.ACOLYTE_FAILED,
  fetchCount: zeroFetchCount,
  ttl: CacheTTL.week,
});

export const sanityCheckFailuresCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.SANITY_CHECKS.FAILURES,
  fetchCount: zeroFetchCount,
  ttl: CacheTTL.day,
});

export const fervorCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.FERVOR,
  fetchCount: async (ids) => {
    const numericIds = ids.map(Number);
    const players = await dbRead.newOrderPlayer.findMany({
      where: { userId: { in: numericIds } },
      select: { userId: true, fervor: true },
    });
    const playerMap = new Map(players.map((p) => [p.userId, p.fervor]));

    const result = new Map<number | string, number>();
    for (let i = 0; i < ids.length; i++) {
      result.set(ids[i], playerMap.get(numericIds[i]) ?? 0);
    }
    return result;
  },
  ttl: 0, // Changed from CacheTTL.week - recalculated daily by newOrderDailyReset job
  ordered: true,
});

export const smitesCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.SMITE,
  fetchCount: async (ids) => {
    const numericIds = ids.map(Number);
    // Count smites per player in a single query
    const smiteCounts = await dbRead.newOrderSmite.groupBy({
      by: ['targetPlayerId'],
      where: { targetPlayerId: { in: numericIds }, cleansedAt: null },
      _count: true,
    });
    const countMap = new Map(smiteCounts.map((s) => [s.targetPlayerId, s._count]));

    const result = new Map<number | string, number>();
    for (let i = 0; i < ids.length; i++) {
      result.set(ids[i], countMap.get(numericIds[i]) ?? 0);
    }
    return result;
  },
  ttl: CacheTTL.week,
});

export const blessedBuzzCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.BUZZ,
  fetchCount: async (ids) => {
    const result = new Map<number | string, number>();
    for (const id of ids) result.set(id, 0);

    if (!clickhouse || ids.length === 0) return result;

    const numericIds = ids.map(Number);

    // Query player's career start dates to respect resets
    const players = await dbRead.newOrderPlayer.findMany({
      where: { userId: { in: numericIds } },
      select: { userId: true, startAt: true },
    });
    if (!players.length) return result;

    const validUserIds = players.map((p) => p.userId);

    // Build CASE clauses for each player to filter by their startAt
    const caseClauses = players
      .map((player) => {
        const startAtISO = player.startAt.toISOString();
        return `WHEN userId = ${player.userId} AND createdAt >= parseDateTimeBestEffort('${startAtISO}') THEN grantedExp * multiplier`;
      })
      .join('\n');

    const caseExpression = caseClauses
      ? `
        CASE
          ${caseClauses}
          ELSE 0
        END
      `
      : '0';

    // Query from 2 days ago (not 3) to exclude just-granted data
    // The grant job processes 3-days-ago data at midnight, so after midnight:
    // - 3 days ago = just granted (exclude)
    // - 2 days ago to today = not yet granted (include)
    const startDate = dayjs().subtract(2, 'days').startOf('day').toDate();
    const endDate = dayjs().endOf('day').toDate();

    const data = await clickhouse.$query<{ userId: number; totalExp: number }>`
      SELECT userId, SUM(${caseExpression}) as totalExp
      FROM knights_new_order_image_rating FINAL
      WHERE userId IN (${validUserIds.join(',')})
        AND createdAt BETWEEN ${startDate} AND ${endDate}
        AND status IN ('${NewOrderImageRatingStatus.Correct}', '${
      NewOrderImageRatingStatus.Failed
    }')
      GROUP BY userId
    `.catch(handleLogError);

    if (data) {
      for (const row of data) {
        const idx = ids.findIndex((id) => Number(id) === row.userId);
        if (idx !== -1) result.set(ids[idx], row.totalExp ?? 0);
      }
    }
    return result;
  },
  ttl: 0, // Never expire - granting jobs handle cleanup
});

export const pendingBuzzCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.PENDING_BUZZ,
  fetchCount: async (ids) => {
    const result = new Map<number | string, number>();
    for (const id of ids) result.set(id, 0);

    if (!clickhouse || ids.length === 0) return result;

    const numericIds = ids.map(Number);

    // Query player's career start dates to respect resets
    const players = await dbRead.newOrderPlayer.findMany({
      where: { userId: { in: numericIds } },
      select: { userId: true, startAt: true },
    });
    if (!players.length) return result;

    const validUserIds = players.map((p) => p.userId);

    // Build CASE clauses for each player to filter by their startAt
    const caseClauses = players
      .map((player) => {
        const startAtISO = player.startAt.toISOString();
        return `WHEN userId = ${player.userId} AND createdAt >= parseDateTimeBestEffort('${startAtISO}') THEN grantedExp * multiplier`;
      })
      .join('\n');

    const caseExpression = caseClauses
      ? `
        CASE
          ${caseClauses}
          ELSE 0
        END
      `
      : '0';

    // Calculate what will be granted in the next cycle
    const nextGrantDate = dayjs().add(1, 'day').startOf('day');
    const grantingDate = nextGrantDate.subtract(3, 'days');
    const startDate = grantingDate.startOf('day').toDate();
    const endDate = grantingDate.endOf('day').toDate();

    const data = await clickhouse.$query<{ userId: number; totalExp: number }>`
      SELECT userId, SUM(${caseExpression}) as totalExp
      FROM knights_new_order_image_rating FINAL
      WHERE userId IN (${validUserIds.join(',')})
        AND createdAt BETWEEN ${startDate} AND ${endDate}
        AND status IN ('${NewOrderImageRatingStatus.Correct}', '${
      NewOrderImageRatingStatus.Failed
    }')
      GROUP BY userId
    `.catch(handleLogError);

    if (data) {
      for (const row of data) {
        const idx = ids.findIndex((id) => Number(id) === row.userId);
        if (idx !== -1) result.set(ids[idx], row.totalExp ?? 0);
      }
    }
    return result;
  },
  ttl: CacheTTL.day,
});

export const recentlyGrantedBuzzCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.RECENTLY_GRANTED_BUZZ,
  fetchCount: async (ids) => {
    const result = new Map<number | string, number>();
    for (const id of ids) result.set(id, 0);

    if (!clickhouse || ids.length === 0) return result;

    const numericIds = ids.map(Number);
    const sevenDaysAgo = dayjs().subtract(7, 'days').startOf('day').toDate();

    const data = await clickhouse.$query<{ toAccountId: number; totalBuzz: number }>`
      SELECT toAccountId, sum(amount) as totalBuzz
      FROM buzzTransactions
      WHERE toAccountId IN (${numericIds.join(',')})
        AND externalTransactionId LIKE 'new-order-%'
        AND date >= ${sevenDaysAgo}
      GROUP BY toAccountId
    `.catch(handleLogError);

    if (data) {
      for (const row of data) {
        const idx = ids.findIndex((id) => Number(id) === row.toAccountId);
        if (idx !== -1) result.set(ids[idx], row.totalBuzz ?? 0);
      }
    }
    return result;
  },
  ttl: CacheTTL.day,
});

export const expCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.EXP,
  fetchCount: async (ids) => {
    const numericIds = ids.map(Number);
    const players = await dbRead.newOrderPlayer.findMany({
      where: { userId: { in: numericIds } },
      select: { userId: true, exp: true },
    });
    const playerMap = new Map(players.map((p) => [p.userId, p.exp]));

    const result = new Map<number | string, number>();
    for (let i = 0; i < ids.length; i++) {
      result.set(ids[i], playerMap.get(numericIds[i]) ?? 0);
    }
    return result;
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
        fetchCount: zeroFetchCount,
        ttl: 0,
        ordered: true,
      })
    ),
    b: poolKeys[NewOrderRankType.Acolyte].b.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: zeroFetchCount,
        ttl: 0,
        ordered: true,
      })
    ),
  },
  [NewOrderRankType.Knight]: {
    a: poolKeys[NewOrderRankType.Knight].a.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: zeroFetchCount,
        ttl: 0,
        ordered: true,
      })
    ),
    b: poolKeys[NewOrderRankType.Knight].b.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: zeroFetchCount,
        ttl: 0,
        ordered: true,
      })
    ),
  },
  [NewOrderRankType.Templar]: {
    a: poolKeys[NewOrderRankType.Templar].a.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: zeroFetchCount,
        ttl: 0,
        ordered: true,
      })
    ),
    b: poolKeys[NewOrderRankType.Templar].b.map((key) =>
      createCounter({
        key: key as NewOrderRedisKey,
        fetchCount: zeroFetchCount,
        ttl: 0,
        ordered: true,
      })
    ),
  },
  Inquisitor: {
    a: [
      createCounter({
        key: `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Inquisitor:a`,
        fetchCount: zeroFetchCount,
        ttl: 0,
        ordered: true,
      }),
    ],
    b: [
      createCounter({
        key: `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:Inquisitor:b`,
        fetchCount: zeroFetchCount,
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
  const counter = createCounter<string>({
    key: key as NewOrderRedisKey,
    fetchCount: async (ids) => {
      const result = new Map<string, number>();
      for (const id of ids) result.set(id, 0);

      if (!clickhouse || ids.length === 0) return result;

      // IDs are in format "rank-nsfwLevel", e.g. "Knight-3"
      // Parse and validate all IDs
      const validIds = ids.filter((id) => {
        const [rank, nsfwLevel] = id.split('-');
        return rank && nsfwLevel;
      });

      if (validIds.length === 0) return result;

      // Fetch all ratings for this image in one query
      const data = await clickhouse.$query<{ rank: string; rating: number; count: number }>`
        SELECT
          argMax(rank, createdAt) as rank,
          argMax(rating, createdAt) as rating,
          count() as count
        FROM knights_new_order_image_rating
        WHERE imageId = ${imageId}
        GROUP BY imageId, userId
      `;

      // Group counts by rank-rating combination
      const countsByKey = new Map<string, number>();
      for (const row of data) {
        const key = `${row.rank}-${row.rating}`;
        countsByKey.set(key, (countsByKey.get(key) ?? 0) + row.count);
      }

      // Populate results for requested IDs
      for (const id of ids) {
        result.set(id, countsByKey.get(id) ?? 0);
      }

      return result;
    },
    ttl: CacheTTL.day,
    ordered: true,
  });

  return counter;
};

export type VotingRateLimitConfig = {
  perMinute: number;
  perHour: number;
  perDay: number;
  /** Have the daily abuse-detection job auto-smite suspects matching strict signals. Off by default. */
  autoSmiteAbusers?: boolean;
  /**
   * Tunable thresholds for the daily abuse-detection job. Live values come
   * from Redis so they're not leaked via the public source tree — defaults
   * here are a non-load-bearing fallback for first-boot before ops seeds the
   * config. Calibrate against real queue composition and revisit as the
   * NSFW sampling rate / pool mix shifts.
   */
  abuseDetection?: {
    /** HAVING totalRatings >= X — minimum daily vote count to be considered. */
    minTotalRatings?: number;
    /** HAVING dominantPct >= X — detection-pool floor for skewed distributions. */
    havingDominantPct?: number;
    /** HAVING avgPerMinute > X — detection-pool floor for burst voting. */
    havingAvgPerMinute?: number;
    /** Smite filter — issue smite when dominantPct >= X. */
    smiteDominantPct?: number;
    /** Smite filter — issue smite when uniqueRatings <= X. */
    smiteMaxUniqueRatings?: number;
  };
  /**
   * Per-rank weight array indexed by priority slot (index 0 = priority 1, etc.).
   * Used by `getImagesQueue` to mix images across pools instead of draining
   * them in strict priority order — fixes the case where one pool dominates
   * (e.g. Knight1 SFW flood starves Knight2 NSFW). Weights are renormalized
   * over non-empty pools at read time, and missing/zero entries are treated
   * as "do not pull from this pool". When the rank key is absent, the loop
   * falls back to the legacy sequential drain.
   */
  poolQuotas?: Partial<Record<NewOrderRankType, number[]>>;
};

// Re-export the pure quota math from a side-effect-free module so unit tests
// can import it without booting Redis/ClickHouse/DB modules transitively.
export { DEFAULT_POOL_QUOTAS, computePoolTargets } from './pool-quotas';

const DENIED_RESPONSE = { allowed: false, remaining: 0, cooldownUntil: 0 } as const;
const MINUTE_WINDOW = 60 * 1000;
const HOUR_WINDOW = 60 * MINUTE_WINDOW;
const DAY_WINDOW = 24 * HOUR_WINDOW;

// Cooldown durations matching each tripped window. Bots that hammer the
// endpoint get locked out for wall-clock time rather than a 60s slide so
// retry spam becomes uneconomical.
const COOLDOWN_MS = {
  minute: 10 * MINUTE_WINDOW,
  hour: HOUR_WINDOW,
  day: DAY_WINDOW,
} as const;

/**
 * Read the active voting cooldown for a user. Returns the cooldown expiry
 * timestamp (ms epoch) or null if no cooldown is active. Used by getPlayer
 * to hydrate the UI so the countdown survives a page reload.
 */
export async function getVotingCooldownUntil(userId: number): Promise<number | null> {
  if (!redis) return null;
  try {
    const key = `${REDIS_KEYS.CACHES.NEW_ORDER.RATE_LIMIT.COOLDOWN}:${userId}` as const;
    const pttl = await redis.pTTL(key);
    return pttl > 0 ? Date.now() + pttl : null;
  } catch {
    return null;
  }
}

/**
 * Conservative fallback limits used ONLY when the Redis config key is *absent*
 * (wiped, never seeded, or sysRedis data loss) — NOT when Redis itself is down.
 *
 * A missing `new-order:config` must degrade the game to sane limits instead of
 * locking every voter out. On 2026-06-15 the key vanished and the rate limiter
 * fail-closed on every vote, surfacing a permanent fake "60s cooldown" (the
 * `cooldownUntil: 0` → `: 60` fallback in the service) that never cleared.
 * These defaults keep prolific legit voters playing while still capping bots;
 * mods re-tune the live values via the `mod/new-order/rate-limit-config` PUT.
 */
export const DEFAULT_VOTING_RATE_LIMIT_CONFIG: VotingRateLimitConfig = {
  perMinute: 40,
  perHour: 600,
  perDay: 3000,
};

/**
 * Get rate limit config from Redis. Returns null when the key is absent or
 * sysRedis errors. `checkVotingRateLimit` treats null as "use defaults" (the
 * game stays up); a truly unavailable `redis` client still fails closed.
 */
export async function getVotingRateLimitConfig(): Promise<VotingRateLimitConfig | null> {
  try {
    return await sysRedis.packed.get<VotingRateLimitConfig>(REDIS_SYS_KEYS.NEW_ORDER.CONFIG);
  } catch {
    return null;
  }
}

// Simple sliding window rate limiter for voting
export async function checkVotingRateLimit(userId: number): Promise<{
  allowed: boolean;
  remaining: number;
  cooldownUntil: number;
}> {
  if (!redis) {
    logToAxiom({
      type: 'error',
      name: 'new-order-rate-limit-unavailable',
      details: { userId, reason: 'redis-client-unavailable' },
      message: `Rate limiter denied vote for user ${userId}: Redis client unavailable`,
    }).catch(() => null);
    return DENIED_RESPONSE;
  }

  // Missing config is NOT the same failure as "Redis is down". A wiped/unseeded
  // `new-order:config` must degrade to defaults so the game stays playable —
  // fail-closing here locked every voter out on 2026-06-15. The `!redis` guard
  // above and the catch below still fail closed for genuine Redis outages.
  const configuredLimits = await getVotingRateLimitConfig();
  const limits = configuredLimits ?? DEFAULT_VOTING_RATE_LIMIT_CONFIG;
  if (!configuredLimits && Math.random() < 0.01) {
    // Sampled — this is the steady-state degraded path while the key is missing,
    // so it must stay observable (re-seed signal) without flooding Axiom.
    logToAxiom({
      type: 'warning',
      name: 'new-order-rate-limit-config-missing',
      details: { userId, reason: 'config-not-set-using-defaults' },
      message: `new-order:config missing — rate limiter using built-in defaults for user ${userId}; re-seed the Redis config`,
    }).catch(() => null);
  }

  const now = Date.now();
  const minuteKey = `${REDIS_KEYS.CACHES.NEW_ORDER.RATE_LIMIT.MINUTE}:${userId}` as const;
  const hourKey = `${REDIS_KEYS.CACHES.NEW_ORDER.RATE_LIMIT.HOUR}:${userId}` as const;
  const dayKey = `${REDIS_KEYS.CACHES.NEW_ORDER.RATE_LIMIT.DAY}:${userId}` as const;
  const cooldownKey = `${REDIS_KEYS.CACHES.NEW_ORDER.RATE_LIMIT.COOLDOWN}:${userId}` as const;

  try {
    // Short-circuit if cooldown is active — bots can't slide past with retries.
    const cooldownPttl = await redis.pTTL(cooldownKey);
    if (cooldownPttl > 0) {
      return { allowed: false, remaining: 0, cooldownUntil: now + cooldownPttl };
    }

    // Clean up old entries
    await Promise.all([
      redis.zRemRangeByScore(minuteKey, '-inf', now - MINUTE_WINDOW),
      redis.zRemRangeByScore(hourKey, '-inf', now - HOUR_WINDOW),
      redis.zRemRangeByScore(dayKey, '-inf', now - DAY_WINDOW),
    ]);

    // Count current requests
    const [minuteCount, hourCount, dayCount] = await Promise.all([
      redis.zCard(minuteKey),
      redis.zCard(hourKey),
      redis.zCard(dayKey),
    ]);

    // Check limits — narrowest window first so the cooldown matches the trip
    const minuteAllowed = minuteCount < limits.perMinute;
    const hourAllowed = hourCount < limits.perHour;
    const dayAllowed = dayCount < limits.perDay;
    const allowed = minuteAllowed && hourAllowed && dayAllowed;

    if (allowed) {
      // Add current request — use individual commands instead of multi() to avoid
      // CROSSSLOT errors in Redis Cluster (keys hash to different slots)
      const requestId = `${now}-${Math.random()}`;
      await Promise.all([
        redis.zAdd(minuteKey, { score: now, value: requestId }),
        redis.zAdd(hourKey, { score: now, value: requestId }),
        redis.zAdd(dayKey, { score: now, value: requestId }),
      ]);
      await Promise.all([
        redis.expire(minuteKey, 60),
        redis.expire(hourKey, 3600),
        redis.expire(dayKey, 86400),
      ]);

      return {
        allowed: true,
        remaining: Math.max(0, limits.perMinute - minuteCount - 1),
        cooldownUntil: 0,
      };
    }

    // Trip → set cooldown matching the narrowest tripped window.
    // Max-merge atomically via Lua: never shrink an active longer cooldown. A naive
    // check-then-SET races when two trips on different windows land concurrently —
    // the second SET could overwrite a longer cooldown with a shorter one.
    const cooldownMs = !minuteAllowed
      ? COOLDOWN_MS.minute
      : !hourAllowed
      ? COOLDOWN_MS.hour
      : COOLDOWN_MS.day;

    const maxMergeScript = `
      local cur = redis.call('PTTL', KEYS[1])
      local req = tonumber(ARGV[1])
      if cur < req then
        redis.call('SET', KEYS[1], '1', 'PX', req)
        return req
      end
      return cur
    `;
    const effectiveCooldownMs = (await redis.eval(maxMergeScript, {
      keys: [cooldownKey],
      arguments: [cooldownMs.toString()],
    })) as number;

    return {
      allowed: false,
      remaining: 0,
      cooldownUntil: now + effectiveCooldownMs,
    };
  } catch (error) {
    handleLogError(error as Error, `Rate limiting failed for user ${userId}`);
    logToAxiom({
      type: 'error',
      name: 'new-order-rate-limit-unavailable',
      details: { userId, reason: 'redis-operation-failed', error: (error as Error).message },
      message: `Rate limiter denied vote for user ${userId}: Redis operation failed`,
    }).catch(() => null);
    return DENIED_RESPONSE;
  }
}

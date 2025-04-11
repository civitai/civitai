import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';

type NewOrderRedisKeyString = Values<typeof REDIS_SYS_KEYS.NEW_ORDER>;
type NewOrderRedisKey = `${NewOrderRedisKeyString}${'' | `:${string}`}`;

type CounterOptions = {
  key: NewOrderRedisKey;
  fetchCount: (id: number | string) => Promise<number>;
  ttl?: number;
  ordered?: boolean;
};

function createCounter({ key, fetchCount, ttl = CacheTTL.day, ordered }: CounterOptions) {
  async function populateCount(id: number | string) {
    const fetchedCount = await fetchCount(id);
    if (ordered) {
      await Promise.all([
        sysRedis.zAdd(key, { score: fetchedCount, value: id.toString() }),
        sysRedis.expire(key, ttl),
      ]);
    } else {
      await Promise.all([
        sysRedis.hSet(key, id.toString(), fetchedCount),
        sysRedis.hExpire(key, id.toString(), ttl),
      ]);
    }

    return fetchedCount;
  }

  async function getAll(limit?: number) {
    // Returns all ids in the range of min and max
    // If ordered, returns the ids by the score in descending order.
    if (ordered) {
      const data = await sysRedis.zRangeWithScores(key, Infinity, -Infinity, {
        BY: 'SCORE',
        REV: true,
        LIMIT: { offset: 0, count: limit ?? 100 },
      });

      return data.map((x) => x.value);
    }

    const data = await sysRedis.hGetAll(key);
    return Object.values(data).slice(0, limit ?? 100);
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
    if (ordered) await sysRedis.zIncrBy(key, absValue * -1, id.toString());
    else await sysRedis.hIncrBy(key, id.toString(), absValue * -1);

    return count - absValue;
  }

  function reset({ id, all }: { id: number; all?: never } | { all: true; id?: never }) {
    if (all) return sysRedis.del(key);
    return ordered ? sysRedis.zRem(key, id.toString()) : sysRedis.hDel(key, id.toString());
  }

  async function exists(id: number | string) {
    const countStr = ordered
      ? await sysRedis.zScore(key, id.toString())
      : await sysRedis.hGet(key, id.toString());

    return countStr !== null && countStr !== undefined;
  }

  return { increment, decrement, reset, getCount, getAll, exists, key };
}

export const correctJudgementsCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.CORRECT,
  fetchCount: async () => 0,
});

export const allJudmentsCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.JUDGEMENTS.ALL,
  fetchCount: async () => 0,
});

export const fervorCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.FERVOR,
  fetchCount: async () => 0,
  ttl: CacheTTL.week,
  ordered: true,
});

export const smitesCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.SMITE,
  fetchCount: async () => 0,
});

export const blessedBuzzCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.BUZZ,
  fetchCount: async () => 0,
});

export const expCounter = createCounter({
  key: REDIS_SYS_KEYS.NEW_ORDER.EXP,
  fetchCount: async () => 0,
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
      ttl: CacheTTL.week,
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
  God: [
    createCounter({
      key: `${REDIS_SYS_KEYS.NEW_ORDER.QUEUES}:God`,
      fetchCount: async () => 0,
      ttl: CacheTTL.week,
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
        WHERE "imageId" = ${imageId} AND "rank" = ${rank} AND "nsfwLevel" = ${nsfwLevel}
      `;

      const count = data[0]?.count ?? 0;
      return count;
    },
    ttl: CacheTTL.day,
    ordered: true,
  });

  return counter;
};

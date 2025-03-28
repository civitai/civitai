import { CacheTTL } from '~/server/common/constants';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';

type NewOrderRedisKeyString = Values<typeof REDIS_SYS_KEYS.NEW_ORDER>;
type NewOrderRedisKey = `${NewOrderRedisKeyString}${'' | `:${string}`}`;

type CounterOptions = {
  key: NewOrderRedisKey;
  fetchCount: (id: number) => Promise<number>;
  ttl?: number;
  ordered?: boolean;
};

function createCounter({ key, fetchCount, ttl = CacheTTL.day, ordered }: CounterOptions) {
  async function populateCount(id: number) {
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

  async function getCount(id: number) {
    const countStr = ordered
      ? await sysRedis.zScore(key, id.toString())
      : await sysRedis.hGet(key, id.toString());
    if (!countStr) return await populateCount(id);

    return Number(countStr);
  }

  async function increment({ id, value = 1 }: { id: number; value?: number }) {
    let count = await getCount(id);
    if (!count) count = await populateCount(id);

    const absValue = Math.abs(value); // Make sure we are using positive number
    if (ordered) await sysRedis.zIncrBy(key, absValue, id.toString());
    else await sysRedis.hIncrBy(key, id.toString(), absValue);

    return count + absValue;
  }

  async function decrement({ id, value = 1 }: { id: number; value?: number }) {
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

  return { increment, decrement, reset, getCount };
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

import type { RedisKeyStringsSys } from '~/server/redis/client';
import { sysRedis } from '~/server/redis/client';
import { withSysReadDeadline } from '~/server/redis/sys-read-deadline';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';

export function createLimiter({
  counterKey,
  limitKey,
  fetchCount,
  refetchInterval = 60 * 60,
  fetchOnUnknown = false,
}: {
  counterKey: RedisKeyStringsSys;
  limitKey: RedisKeyStringsSys;
  fetchCount: (userKey: string) => Promise<number>;
  refetchInterval?: number; // in seconds
  fetchOnUnknown?: boolean;
}) {
  async function populateCount(userKey: string) {
    const fetchedCount = await fetchCount(userKey);
    await sysRedis.set(`${counterKey}:${userKey}`, fetchedCount, {
      EX: refetchInterval,
    });
    return fetchedCount;
  }

  async function getCount(userKey: string) {
    // Fan-out reduction: the count value and its TTL used to be two sequential
    // sysRedis round-trips (GET then TTL). On a silent sys half-open each parks
    // up to the OS-keepalive teardown — stacking the wait. Batch them into one
    // MULTI exec (single round-trip) so a wedge stacks ~1× the read latency, not
    // 2×. The sys client is single-node / Sentinel (NEVER a cluster — see
    // client.ts `isCluster = type === 'cache' && env.REDIS_CLUSTER`), so a MULTI
    // across the counter key carries no CROSSSLOT risk. Bounded by
    // withSysReadDeadline (the sys client has no socketTimeout; a pipeline exec
    // is not bounded by any per-command timeout). Semantics are byte-identical to
    // the prior GET-then-TTL flow.
    const key = `${counterKey}:${userKey}` as const;
    const pipeline = sysRedis.multi();
    pipeline.get(key);
    pipeline.ttl(key);
    const results = await withSysReadDeadline(pipeline.exec());

    const countStr = results?.[0] as unknown as string | null;
    const ttl = Number(results?.[1] ?? -1);

    if (!countStr) return fetchOnUnknown ? await populateCount(userKey) : undefined;

    // Handle missing TTL
    if (ttl < 0) return await populateCount(userKey);

    return Number(countStr);
  }

  async function setLimitHitTime(userKey: string) {
    await sysRedis.set(`${limitKey}:${userKey}`, Date.now(), {
      EX: refetchInterval,
    });
  }

  async function getLimit(userKey: string, fallbackKey = 'default') {
    const cachedLimit = await withSysReadDeadline(sysRedis.hmGet(limitKey, [userKey, fallbackKey]));
    return Number(cachedLimit?.[0] ?? cachedLimit?.[1] ?? 0);
  }

  async function hasExceededLimit(userKey: string, fallbackKey = 'default') {
    // Fail-open: a sysRedis error/timeout (silent half-open, failover) must NOT
    // 429/500 every request for the pod's wedged lifetime. A wedge is rare and
    // transient; letting a few requests through unlimited is strictly better than
    // blocking all of them. Mirrors middleware.trpc.recordAttempt (PR #2332) and
    // refreshToken (token-refresh.ts) — log via logSysRedisFailOpen so a SUSTAINED
    // fail-open (= abuse protection effectively disabled) is dashboardable, then
    // return false (= not exceeded = serve).
    try {
      const count = await getCount(userKey);
      if (count === undefined) return false;

      const limit = await getLimit(userKey, fallbackKey);
      return limit !== 0 && count > limit;
    } catch (error) {
      logSysRedisFailOpen('rate-limit-write-degraded', 'createLimiter.hasExceededLimit', error, {
        counterKey,
        userKey,
      });
      return false;
    }
  }

  async function increment(userKey: string, by = 1) {
    // Fail-open: the limiter increment runs AFTER the protected action (e.g. the
    // download is already being served), so a sysRedis error here must not surface
    // as a 500 / stall. On failure we log and return the would-be count (best
    // effort) — the only consequence is this attempt is under-counted in the
    // sliding window until the next successful write, identical to the
    // recordAttempt fail-open trade-off.
    try {
      const key = `${counterKey}:${userKey}` as const;

      // Ensure key exists before incrementing
      const exists = await withSysReadDeadline(sysRedis.exists(key));
      if (!exists) await populateCount(userKey);

      // Fan-out reduction: INCRBY and the limit HMGET used to be two sequential
      // round-trips. Batch them into one MULTI exec. (INCRBY mutates the counter
      // key; HMGET reads the limit hash — both on the single-node sys client, no
      // CROSSSLOT.) The result order matches the queue order.
      const pipeline = sysRedis.multi();
      pipeline.incrBy(key, by);
      pipeline.hmGet(limitKey, [userKey, 'default']);
      const results = await withSysReadDeadline(pipeline.exec());

      const newCount = Number(results?.[0] ?? 0);
      const cachedLimit = results?.[1] as unknown as (string | null)[] | undefined;
      const limit = Number(cachedLimit?.[0] ?? cachedLimit?.[1] ?? 0);

      // Check if limit exceeded and set limit hit time
      if (limit !== 0 && newCount > limit) await setLimitHitTime(userKey);
      return newCount;
    } catch (error) {
      logSysRedisFailOpen('rate-limit-write-degraded', 'createLimiter.increment', error, {
        counterKey,
        userKey,
      });
      return by;
    }
  }

  async function getLimitHitTime(userKey: string) {
    const limitHitTime = await withSysReadDeadline(sysRedis.get(`${limitKey}:${userKey}`));
    if (!limitHitTime) return undefined;
    return new Date(Number(limitHitTime));
  }

  async function reset(userKey: string) {
    await sysRedis.del(`${counterKey}:${userKey}`);
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

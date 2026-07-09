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

  // A MULTI reply must arrive as a fixed-length array (one entry per queued
  // command). If exec() ever returns an unexpected shape — a future node-redis
  // change, or someone attaching a typeMapping to the sys client — silently
  // parsing it via `Number(badShape ?? 0)` yields NaN/0 and the limiter degrades
  // to "serve unlimited, never log" with NO `rate-limit-write-degraded` signal.
  // Assert the arity BEFORE parsing and THROW on mismatch so it routes into the
  // caller's existing logged fail-open instead of disabling abuse protection
  // silently. (Throws on a genuine null exec too — same desired routing.)
  function assertMultiArity(results: unknown, expected: number): unknown[] {
    if (!Array.isArray(results) || results.length !== expected) {
      throw new Error(
        `sysRedis MULTI exec returned unexpected shape (expected array of ${expected}, got ${
          Array.isArray(results) ? `array of ${results.length}` : typeof results
        })`
      );
    }
    return results;
  }

  // Internal core of getCount: may THROW (on sysRedis error/timeout or a
  // malformed MULTI reply). Callers that own a fail-open catch (hasExceededLimit)
  // use this directly so the error is logged under their fn name; the PUBLIC
  // getCount wraps this in its own fail-open below.
  async function getCountCore(userKey: string) {
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
    const results = assertMultiArity(await withSysReadDeadline(pipeline.exec()), 2);

    const countStr = results[0] as unknown as string | null;
    const ttl = Number(results[1] ?? -1);

    if (!countStr) return fetchOnUnknown ? await populateCount(userKey) : undefined;

    // Handle missing TTL
    if (ttl < 0) return await populateCount(userKey);

    return Number(countStr);
  }

  // Public getCount: fail-open like the other public methods (hasExceededLimit /
  // increment). It has no direct caller today — the `*.getCount` hits elsewhere
  // are a different `createCounter` abstraction (server/games/new-order/utils.ts),
  // not this one — but as a public return it must not throw on a sysRedis wedge
  // and surface a 500. On a redis error it logs and returns `undefined`, matching
  // the "count unknown" branch the happy path already produces.
  async function getCount(userKey: string) {
    try {
      return await getCountCore(userKey);
    } catch (error) {
      logSysRedisFailOpen('rate-limit-write-degraded', 'createLimiter.getCount', error, {
        counterKey,
        userKey,
      });
      return undefined;
    }
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
      // Use the throwing core (not the fail-open public getCount) so a sysRedis
      // error/malformed-reply on the count read routes into THIS catch and logs
      // under fn `createLimiter.hasExceededLimit`.
      const count = await getCountCore(userKey);
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
      // Assert arity BEFORE parsing — a malformed reply would otherwise make
      // newCount NaN and silently disable the limit-hit-time write with no
      // fail-open log. A throw routes into the catch below (logged fail-open).
      const results = assertMultiArity(await withSysReadDeadline(pipeline.exec()), 2);

      const newCount = Number(results[0] ?? 0);
      const cachedLimit = results[1] as unknown as (string | null)[] | undefined;
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

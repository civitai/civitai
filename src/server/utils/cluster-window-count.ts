import { redis, type RedisKeyTemplateCache } from '~/server/redis/client';
import { clusterCacheGuard, type CallOptions } from '~/server/redis/cluster-cache-guard';

/** The deadline a request-path cache-cluster call gets unless its caller names another. */
export const CLUSTER_CALL_DEADLINE_MS = 1_000;

/**
 * Runs `op` on the cache cluster through the cluster cache guard, with
 * {@link CLUSTER_CALL_DEADLINE_MS} unless `opts.deadlineMs` says otherwise. Throws
 * `ClusterCacheUnavailableError` on a failure, timeout or open breaker.
 */
export function boundedClusterCall<T>(
  fn: string,
  op: () => Promise<T>,
  opts: CallOptions = {}
): Promise<T> {
  return clusterCacheGuard.call(fn, op, { deadlineMs: CLUSTER_CALL_DEADLINE_MS, ...opts });
}

/**
 * Adds one (`INCR`), or `by` when given (`INCRBY`; negative releases), to a fixed window on the
 * cache cluster and answers the total after it.
 *
 * `SET NX EX` + `INCR`/`INCRBY` in one single-key MULTI, so the key always carries its TTL: a
 * crash between the two cannot strand a TTL-less counter, and a release that lands after the key
 * was evicted or expired re-creates it with the TTL rather than as an immortal negative. Bounded
 * by {@link boundedClusterCall}. A reply that is not a number answers `NaN`. Each caller decides
 * what a throw or `NaN` means (fail open or closed).
 *
 * Not `claimRateLimitAttempt` (rate-limit-bucket.ts): that one buckets a REQUEST's caller (user id
 * or client IP) against configured rules, exempts moderators, dev and preview, refuses with a
 * TRPCError, and decides fail-open or closed by scope. The callers here count their own subject
 * (an app slug, a provider, a credential, a day's spend), choose their own window and failure
 * policy, and some are not requests at all.
 */
export async function takeClusterWindowCount(
  fn: string,
  key: RedisKeyTemplateCache,
  windowSeconds: number,
  opts: CallOptions & { by?: number } = {}
): Promise<number> {
  const { by, ...callOpts } = opts;
  const created = { NX: true, EX: windowSeconds } as const;
  const reply: unknown = await boundedClusterCall<unknown>(
    fn,
    () =>
      by === undefined
        ? redis.multi().set(key, '0', created).incr(key).exec()
        : redis.multi().set(key, '0', created).incrBy(key, by).exec(),
    callOpts
  );
  return Number((reply as unknown[] | null)?.[1]);
}

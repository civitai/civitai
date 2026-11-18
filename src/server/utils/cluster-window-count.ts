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
 * Adds `by` (default 1; negative releases) to a fixed window on the cache cluster and answers the
 * total after it.
 *
 * `SET NX EX` + `INCR`/`INCRBY` in one single-key MULTI, so the key always carries its TTL: a
 * crash between the two cannot strand a TTL-less counter, and a release that lands after the key
 * was evicted or expired re-creates it with the TTL rather than as an immortal negative. Bounded
 * by {@link boundedClusterCall}. A reply that is not a number answers `NaN`. Each caller decides
 * what a throw or `NaN` means (fail open or closed).
 */
export async function takeClusterWindowCount(
  fn: string,
  key: RedisKeyTemplateCache,
  windowSeconds: number,
  opts: CallOptions & { by?: number } = {}
): Promise<number> {
  const { by = 1, ...callOpts } = opts;
  const created = { NX: true, EX: windowSeconds } as const;
  const reply: unknown = await boundedClusterCall<unknown>(
    fn,
    () =>
      by === 1
        ? redis.multi().set(key, '0', created).incr(key).exec()
        : redis.multi().set(key, '0', created).incrBy(key, by).exec(),
    callOpts
  );
  return Number((reply as unknown[] | null)?.[1]);
}

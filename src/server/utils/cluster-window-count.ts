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
 * `SET NX EX` + `INCR`/`INCRBY` in one single-key MULTI, so the key always carries its TTL. A
 * negative total after a release is brought back to zero. Bounded by {@link boundedClusterCall}. A
 * reply that is not a number answers `NaN`; each caller decides whether a throw or `NaN` fails open
 * or closed.
 *
 * Not claimRateLimitAttempt: counts any subject, not a request's caller.
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
  const total = Number((reply as unknown[] | null)?.[1]);
  // A release that lands after the key was evicted would leave a negative total, which admits
  // that much over the limit for the rest of the window. Add the deficit back (INCRBY keeps the
  // TTL) rather than SET 0, so a take that lands in between is not erased.
  if (by !== undefined && by < 0 && total < 0) {
    return Number(await boundedClusterCall(fn, () => redis.incrBy(key, -total), callOpts));
  }
  return total;
}

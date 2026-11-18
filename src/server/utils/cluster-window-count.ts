import { redis, type RedisKeyTemplateCache } from '~/server/redis/client';
import { clusterCacheGuard, type CallOptions } from '~/server/redis/cluster-cache-guard';

/**
 * Counts one hit against a fixed window on the cache cluster and answers the count after it.
 *
 * `SET NX EX` + `INCR` in one single-key MULTI, so the key is always created with its TTL and a
 * crash between the two cannot strand a TTL-less counter. Bounded by the cluster cache guard:
 * a failure, timeout or open breaker throws `ClusterCacheUnavailableError`. A reply that is not a
 * number answers `NaN`. Each caller decides what either means (fail open or closed).
 */
export async function takeClusterWindowCount(
  fn: string,
  key: RedisKeyTemplateCache,
  windowSeconds: number,
  opts: CallOptions
): Promise<number> {
  const reply = await clusterCacheGuard.call(
    fn,
    () => redis.multi().set(key, '0', { NX: true, EX: windowSeconds }).incr(key).exec(),
    opts
  );
  return Number((reply as unknown[] | null)?.[1]);
}

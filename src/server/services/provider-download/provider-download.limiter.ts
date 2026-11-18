import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import {
  ClusterCacheUnavailableError,
  clusterCacheGuard,
} from '~/server/redis/cluster-cache-guard';

const HOUR_MS = 60 * 60 * 1000;
/** Two hours, so a key outlives the hour it counts. */
const KEY_TTL_S = 2 * 60 * 60;
// The download waits on this, so a stalled socket must not hold it.
const COUNTER_DEADLINE_MS = 1_000;

/**
 * Counts one request for `provider` in the current clock hour and says whether it is within
 * `hourlyCeiling`. A Redis error or timeout allows the download: the counter is a ceiling on a
 * trusted caller, not a credential check.
 *
 * A rate window, so it lives on the cache cluster; the MULTI touches the one hour key.
 */
export async function takeProviderDownload(
  provider: string,
  hourlyCeiling: number,
  now = Date.now()
): Promise<boolean> {
  const key = `${REDIS_KEYS.DOWNLOAD.PROVIDER}:${provider}:${Math.floor(now / HOUR_MS)}` as const;
  try {
    // One MULTI, so the key never exists without its TTL.
    const reply = await clusterCacheGuard.call(
      'takeProviderDownload',
      () => redis.multi().set(key, '0', { NX: true, EX: KEY_TTL_S }).incr(key).exec(),
      { deadlineMs: COUNTER_DEADLINE_MS, logExtra: { provider } }
    );
    const count = Number(reply?.[1]);
    if (!Number.isFinite(count)) throw new Error('unexpected counter reply');
    return count <= hourlyCeiling;
  } catch (error) {
    // The guard has already counted and logged its own failures.
    if (error instanceof ClusterCacheUnavailableError) return true;
    logToAxiom({
      name: 'provider-download',
      type: 'warning',
      message: 'hourly counter unavailable; allowing',
      provider,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

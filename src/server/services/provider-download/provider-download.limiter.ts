import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { ClusterCacheUnavailableError } from '~/server/redis/cluster-cache-guard';
import { takeClusterWindowCount } from '~/server/utils/cluster-window-count';

const HOUR_MS = 60 * 60 * 1000;
/** Two hours, so a key outlives the hour it counts. */
const KEY_TTL_S = 2 * 60 * 60;

/**
 * Counts one request for `provider` in the current clock hour and says whether it is within
 * `hourlyCeiling`. A Redis error or timeout allows the download: the counter is a ceiling on a
 * trusted caller, not a credential check.
 */
export async function takeProviderDownload(
  provider: string,
  hourlyCeiling: number,
  now = Date.now()
): Promise<boolean> {
  const key = `${REDIS_KEYS.DOWNLOAD.PROVIDER}:${provider}:${Math.floor(now / HOUR_MS)}` as const;
  try {
    const count = await takeClusterWindowCount('takeProviderDownload', key, KEY_TTL_S, {
      logExtra: { provider },
    });
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

import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { withSysReadDeadline } from '~/server/redis/sys-read-deadline';

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
  const key = `${REDIS_SYS_KEYS.DOWNLOAD.PROVIDER}:${provider}:${Math.floor(
    now / HOUR_MS
  )}` as const;
  try {
    // One MULTI, so the key never exists without its TTL.
    const reply = await withSysReadDeadline(
      sysRedis.multi().set(key, '0', { NX: true, EX: KEY_TTL_S }).incr(key).exec()
    );
    const count = Number(reply?.[1]);
    if (!Number.isFinite(count)) throw new Error('unexpected counter reply');
    return count <= hourlyCeiling;
  } catch (error) {
    logToAxiom({
      name: 'provider-download',
      type: 'warning',
      message: 'hourly counter unavailable; allowing',
      provider,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined);
    return true;
  }
}

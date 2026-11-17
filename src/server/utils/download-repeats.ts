import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import {
  ClusterCacheUnavailableError,
  clusterCacheGuard,
} from '~/server/redis/cluster-cache-guard';

/**
 * Repeat requests for one file a user gets free each day before they count again. A resume of a
 * large download, or a client re-resolving its link, re-enters through the download route.
 */
export const FREE_FILE_REPEATS = 10;
// The window the download limiter's count covers (`fetchDownloadCount`).
const REPEAT_WINDOW_SECONDS = 24 * 60 * 60;
// The download waits on this before it redirects, so a slow cache answers "counts" after this long
// rather than after the cluster client's much longer per-command deadline.
const REPEAT_COUNT_DEADLINE_MS = 1_000;

/**
 * Whether this request for `fileId` counts toward the user's download limit: the first request for
 * a file in a day does, the next `FREE_FILE_REPEATS` for the same file don't, and every one past
 * that does again, so looping one file is still limited. Fails open to counting.
 *
 * The count is a cache: losing it costs at most one extra counted download, so it lives on the
 * cache cluster. The MULTI touches one key, so it never spans slots.
 */
export async function countsTowardDownloadLimit(userKey: string, fileId: number) {
  const key = `${REDIS_KEYS.DOWNLOAD.REPEATS}:${userKey}:${fileId}` as const;
  try {
    const results = await clusterCacheGuard.call(
      'countsTowardDownloadLimit',
      () => {
        const pipeline = redis.multi();
        pipeline.set(key, 0, { NX: true, EX: REPEAT_WINDOW_SECONDS });
        pipeline.incr(key);
        return pipeline.exec();
      },
      // userKey is the caller's IP for an anonymous download, so it stays out of the logs.
      { deadlineMs: REPEAT_COUNT_DEADLINE_MS, logExtra: { fileId } }
    );
    const requests = Array.isArray(results) && results.length === 2 ? Number(results[1]) : NaN;
    if (!Number.isInteger(requests) || requests < 1)
      throw new Error('redis MULTI exec returned an unexpected repeat count');
    return requests === 1 || requests > FREE_FILE_REPEATS + 1;
  } catch (error) {
    if (error instanceof ClusterCacheUnavailableError) return true;
    logToAxiom({
      name: 'download-repeats',
      type: 'warning',
      message: 'repeat counter unavailable; counting',
      fileId,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

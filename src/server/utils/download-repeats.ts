import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import { withSysReadDeadline } from '~/server/redis/sys-read-deadline';

/**
 * Repeat requests for one file a user gets free each day before they count again. A resume of a
 * large download, or a client re-resolving its link, re-enters through the download route.
 */
export const FREE_FILE_REPEATS = 10;
// The window the download limiter's count covers (`fetchDownloadCount`).
const REPEAT_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Whether this request for `fileId` counts toward the user's download limit: the first request for
 * a file in a day does, the next `FREE_FILE_REPEATS` for the same file don't, and every one past
 * that does again, so looping one file is still limited. Fails open to counting.
 */
export async function countsTowardDownloadLimit(userKey: string, fileId: number) {
  const key = `${REDIS_SYS_KEYS.DOWNLOAD.REPEATS}:${userKey}:${fileId}` as const;
  try {
    const pipeline = sysRedis.multi();
    pipeline.set(key, 0, { NX: true, EX: REPEAT_WINDOW_SECONDS });
    pipeline.incr(key);
    const results = await withSysReadDeadline(pipeline.exec());
    const requests = Array.isArray(results) && results.length === 2 ? Number(results[1]) : NaN;
    if (!Number.isInteger(requests) || requests < 1)
      throw new Error('sysRedis MULTI exec returned an unexpected repeat count');
    return requests === 1 || requests > FREE_FILE_REPEATS + 1;
  } catch (error) {
    logSysRedisFailOpen('rate-limit-write-degraded', 'countsTowardDownloadLimit', error, {
      userKey,
      fileId,
    });
    return true;
  }
}

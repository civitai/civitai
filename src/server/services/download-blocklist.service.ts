import { CacheTTL } from '~/server/common/constants';
import { dbRead } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

/** The two operator-maintained KeyValue rows every download route checks. */
export type DownloadBlocklistKey = 'ip-blacklist' | 'user-blacklist';

/**
 * How long an edit to either row can take to reach the download routes.
 *
 * A TTL rather than a bust-on-write because nothing in this codebase writes these rows: they are
 * edited directly in the database, so there is no writer to hang a bust on. `fetchThroughCache`
 * treats an entry older than this as stale and the next read refreshes it from the replica; while
 * that one refresh is in flight, other reads are served the old entry. So an edit lands within
 * this TTL plus one refresh (milliseconds normally, at most the refill lock's own 10 s expiry if
 * the refreshing request dies mid-read). The refresh reads the replica, as the routes always have,
 * so replica lag adds to that: a refresh that lands before the replica has the edit caches the old
 * value for one more TTL.
 */
export const DOWNLOAD_BLOCKLIST_TTL = CacheTTL.xs;

async function readBlocklistRow(key: DownloadBlocklistKey): Promise<unknown> {
  const row = await dbRead.keyValue.findUnique({ where: { key } });
  // `null` rather than `undefined` for a missing row: `fetchThroughCache` treats an `undefined`
  // payload as a malformed entry and would re-read the database on every request.
  return row?.value ?? null;
}

/**
 * The raw `value` of a download blocklist row, through a short-lived Redis cache.
 *
 * Returns the value UNPARSED, exactly what `keyValue.findUnique(...)?.value` returned before, so
 * `parseIpBlocklist` / `parseUserBlocklist` keep running per request at the call site and a
 * malformed row still refuses the request the same way.
 *
 * Every cache failure resolves to a database read, never to an empty list:
 * - Redis read errors: `fetchThroughCache` already fails open to the origin fetch.
 * - A cold key whose refill lock another request holds: `retryCount: 0` makes that throw at once
 *   instead of sleeping, and the catch below reads the row directly, as the routes did before.
 * A database error is rethrown unchanged, so the routes fail exactly as they did without the cache.
 */
export async function getDownloadBlocklistValue(key: DownloadBlocklistKey): Promise<unknown> {
  let originFailed = false;
  try {
    return await fetchThroughCache(
      `${REDIS_KEYS.CACHES.DOWNLOAD_BLOCKLIST}:${key}`,
      async () => {
        try {
          return await readBlocklistRow(key);
        } catch (error) {
          originFailed = true;
          throw error;
        }
      },
      { ttl: DOWNLOAD_BLOCKLIST_TTL, retryCount: 0 }
    );
  } catch (error) {
    if (originFailed) throw error;
    return readBlocklistRow(key);
  }
}

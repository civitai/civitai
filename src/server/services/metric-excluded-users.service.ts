import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { logToAxiom } from '~/server/logging/client';

/**
 * Users suppressed from metrics by the reaction-abuse detector
 * (`/api/admin/reaction-abuse`). Every ClickHouse path that produces a metric total
 * filters them, as of #4584 so does the event-engine's Redis cache, and the reaction
 * sums in `src/server/metrics/*.metrics.ts` read this list through
 * `getMetricExcludedUserIdsOrThrow`.
 *
 * These accounts are NOT banned, deleted or muted: the list suppresses metrics only.
 */
const CACHE_TTL = CacheTTL.sm;

/**
 * Returns [] rather than throwing, and that is the point rather than caution.
 *
 * `fetchThroughCache` rejects when the origin fails with nothing cached, and the one
 * caller runs as `createReactionNotification(input).catch(handleLogError)` — so a
 * propagated rejection would silently skip the notification. Skipping is the failure
 * mode this approach was chosen to avoid: an empty list means the count is computed
 * unfiltered, which is exactly how the milestone behaved before this change. Degrade
 * to the old bug, never to silence.
 */
export async function getMetricExcludedUserIds(): Promise<number[]> {
  if (!clickhouse) return [];

  try {
    return await fetchExcludedUserIds();
  } catch (error) {
    reportUnavailable(error);
    return [];
  }
}

/**
 * Same list, but a read failure rejects instead of degrading to `[]`.
 *
 * The lenient reader above is right for the notification path, where an unfiltered
 * count is a wrong number shown once. It is wrong for a metric job: the Postgres
 * reaction sums never decay, so a total written unfiltered during an outage stays
 * wrong until that entity happens to receive another reaction — which for a quiet
 * post is never. `createMetricProcessor` calls `setLastUpdate()` and `queue.commit()`
 * only after `update()` resolves, so rejecting leaves the cursor and the queue where
 * they were and the window is recomputed on the next run.
 */
export async function getMetricExcludedUserIdsOrThrow(): Promise<number[]> {
  if (!clickhouse) throw new Error('clickhouse client unavailable');
  return fetchExcludedUserIds();
}

async function fetchExcludedUserIds(): Promise<number[]> {
  const cached = await fetchThroughCache(
    REDIS_KEYS.CACHES.METRIC_EXCLUDED_USERS,
    async () => {
      const rows = await clickhouse!.$query<{ userId: number }>`
        SELECT userId FROM metricExcludedUsers FINAL WHERE active = 1
      `;
      // > 0 because `Number(null)` is 0, not NaN: a null column would otherwise
      // enter the list as user 0 and silently suppress whatever writes that id.
      // `isFinite` is belt-and-braces here, kept for parity with the identical
      // guard in metric-reaction-repair.service.ts and the event-engine copy.
      return rows.map((r) => Number(r.userId)).filter((id) => Number.isFinite(id) && id > 0);
    },
    // Passed explicitly, not because it differs from fetchThroughCache's default —
    // it does not — but so a change to that default cannot silently widen this past
    // the "within ~5 min" the admin endpoint promises.
    { ttl: CACHE_TTL }
  );

  // `fetchThroughCache` returns any present `data` unvalidated, so a `null` would
  // otherwise reach a caller's `.length` as a thrown TypeError from outside the
  // lenient reader's catch — which its caller's `.catch(handleLogError)` turns into
  // the silent skip that design exists to avoid. Validate the shape rather than
  // trust the type.
  if (!Array.isArray(cached)) throw new Error('cached exclusion list was not an array');
  unavailable = false;
  return cached;
}

/**
 * Logged once per outage — on the first failure, and again only after a success has
 * reset the flag. This runs on every created reaction, so once an outage outlives the
 * cache entry every reaction would otherwise emit its own Axiom ingest, turning the
 * busiest write path into a log amplifier exactly when infrastructure is degraded.
 */
let unavailable = false;
function reportUnavailable(error: unknown) {
  if (unavailable) return;
  unavailable = true;
  logToAxiom({
    type: 'warning',
    name: 'metric-excluded-users-unavailable',
    message: 'Falling back to an unfiltered count',
    details: { error: (error as Error)?.message },
  }).catch(() => undefined);
}

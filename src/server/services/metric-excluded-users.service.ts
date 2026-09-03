import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';
import { logToAxiom } from '~/server/logging/client';

/**
 * Users suppressed from metrics by the reaction-abuse detector
 * (`/api/admin/reaction-abuse`). Every ClickHouse path that produces a metric total
 * filters them, and as of #4584 so does the event-engine's Redis cache — but a
 * Postgres `count()` over `ImageReaction` does not, which is why the reaction
 * milestone fires on numbers no displayed count agrees with.
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

    // The cache read is the one failure this function's own try does NOT cover:
    // `fetchThroughCache` returns any present `data` unvalidated, and a `null` would
    // reach the caller's `.length` outside this catch — a thrown TypeError, which the
    // caller's `.catch(handleLogError)` turns into the silent skip this whole design
    // exists to avoid. Validate the shape rather than trust the type.
    if (!Array.isArray(cached)) throw new Error('cached exclusion list was not an array');
    unavailable = false;
    return cached;
  } catch (error) {
    reportUnavailable(error);
    return [];
  }
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

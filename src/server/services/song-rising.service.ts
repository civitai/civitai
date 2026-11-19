import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS } from '~/server/redis/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

/**
 * The ids of the songs with the most plays today and the 6 days before, most first, ties newest
 * first; one list for every viewer and genre. Owners' and moderators' plays count. Ids only: the
 * client reads them through the image feed, which applies visibility and the viewer's hidden
 * users and tags.
 */
export async function getRisingSongIds({
  features,
}: {
  features: { music?: boolean };
}): Promise<number[]> {
  if (!features.music) return [];
  return fetchThroughCache(
    REDIS_KEYS.CACHES.RISING_SONGS as RedisKeyTemplateCache,
    async () => {
      if (!clickhouse) return [];
      // The `_prev` view holds one row per entity and day; `entityMetricDailyAgg_v2` holds
      // all-time totals stamped today, so it cannot bound a window.
      const rows = await clickhouse.$query<{ entityId: number; plays: string }>`
        SELECT entityId, sum(total) AS plays
        FROM entityMetricDailyAgg_v2_prev
        WHERE entityType = 'Image' AND metricType = 'Play' AND day >= today() - 6
        GROUP BY entityId
        HAVING plays > 0
        ORDER BY plays DESC, entityId DESC
        LIMIT 100
      `;
      return rows.map((row) => row.entityId);
    },
    { ttl: CacheTTL.md }
  );
}

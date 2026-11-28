import { clickhouse } from '~/server/clickhouse/client';
import { CacheTTL } from '~/server/common/constants';
import { REDIS_KEYS } from '~/server/redis/client';
import type { RedisKeyTemplateCache } from '~/server/redis/client';
import { getVisibleSongIds } from '~/server/services/image-visibility.service';
import { fetchThroughCache } from '~/server/utils/cache-helpers';

/**
 * Song ids by plays in the last week, most first, ties newest first; one cached list for every
 * viewer and genre, narrowed per request to the songs the viewer may open. Owners' and
 * moderators' plays count. Ids only: the client reads them through the image feed, which also
 * applies the viewer's hidden users and tags.
 */
export async function getRisingSongIds({
  features,
  user,
}: {
  features: { music?: boolean };
  user?: { id: number; isModerator?: boolean | null };
}): Promise<number[]> {
  if (!features.music) return [];
  const ids = await fetchThroughCache(
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
  if (!ids.length) return [];
  const visible = await getVisibleSongIds({ ids, viewer: { features, user } });
  return visible ? ids.filter((id) => visible.has(id)) : [];
}

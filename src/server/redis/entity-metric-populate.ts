import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { createLogger } from '~/utils/logging';
import { buildEntityMetricPerDaySource, getEntityMetricAggSource } from '~/server/flipt/client';
import type {
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
} from '~/shared/utils/prisma/enums';
import type { CachedObject } from '~/server/utils/cache-helpers';

const log = createLogger('entity-metric-populate', 'magenta');

interface MetricData {
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
  total: number;
}

/**
 * Bulk populate Redis with entity metrics from ClickHouse
 * Uses per-ID locks to prevent thundering herd without blocking unrelated requests
 * @param forceRefresh - If true, skip exists check and overwrite existing values
 */
export async function populateEntityMetrics(
  entityType: EntityMetric_EntityType_Type,
  entityIds: number[],
  forceRefresh = false
): Promise<void> {
  if (!clickhouse || entityIds.length === 0) return;

  let idsToProcess = entityIds;

  // Only check existence if not force refreshing
  if (!forceRefresh) {
    const existsChecks = await Promise.all(
      entityIds.map((id) => entityMetricRedis.exists(entityType, id))
    );

    idsToProcess = entityIds.filter((_, index) => !existsChecks[index]);

    if (idsToProcess.length === 0) {
      return; // All entities already populated
    }
  }

  // Try to acquire per-ID locks for entities to process
  const lockPrefix = `${REDIS_KEYS.ENTITY_METRICS.BASE}:lock:${entityType}`;
  const lockResults = await Promise.all(
    idsToProcess.map((id) => redis.setNX(`${lockPrefix}:${id}` as RedisKeyTemplateCache, '1'))
  );

  // Only load entities where we got the lock
  const idsToLoad = idsToProcess.filter((_, index) => lockResults[index]);
  const lockedKeys: RedisKeyTemplateCache[] = idsToLoad.map(
    (id) => `${lockPrefix}:${id}` as RedisKeyTemplateCache
  );

  // Set TTL on acquired locks
  if (lockedKeys.length > 0) {
    await Promise.all(
      lockedKeys.map((key) => redis.expire(key, 10)) // 10 seconds per ID
    );
  }

  if (idsToLoad.length === 0) {
    // No locks acquired, another process is handling all these IDs
    log(`All ${idsToProcess.length} entities are being loaded by other processes`);
    return;
  }

  try {
    log(
      `${forceRefresh ? 'Refreshing' : 'Loading'} ${idsToLoad.length} entities from ClickHouse (${
        idsToProcess.length - idsToLoad.length
      } handled by other processes)`
    );

    // Process in batches to avoid overwhelming ClickHouse
    const batches = chunk(idsToLoad, 1000);

    for (const batchIds of batches) {
      const metrics = await clickhouse.$query<MetricData>(`
        SELECT
          entityId,
          metricType,
          sum(total) as total
        FROM entityMetricDailyAgg
        WHERE entityType = '${entityType}'
          AND entityId IN (${batchIds.join(',')})
        GROUP BY entityId, metricType
        HAVING total > 0
      `);

      // Group metrics by entityId
      const groupedMetrics = new Map<number, Record<EntityMetric_MetricType_Type, number>>();

      for (const metric of metrics) {
        if (!groupedMetrics.has(metric.entityId)) {
          groupedMetrics.set(metric.entityId, {} as Record<EntityMetric_MetricType_Type, number>);
        }
        const entityMetrics = groupedMetrics.get(metric.entityId)!;
        entityMetrics[metric.metricType] = metric.total;
      }

      // Bulk set in Redis
      const promises: Promise<void>[] = [];
      for (const [entityId, metrics] of groupedMetrics.entries()) {
        promises.push(entityMetricRedis.setMultipleMetrics(entityType, entityId, metrics));
      }

      await Promise.all(promises);
    }

    log(`Completed bulk load for ${idsToLoad.length} entities`);
  } catch (error) {
    log('Error during bulk population:', error);
    // Don't throw - other processes might succeed
  } finally {
    // Always release the locks we acquired
    if (lockedKeys.length > 0) {
      await redis.del(lockedKeys);
    }
  }
}

/**
 * Pre-warm cache for popular/recent images
 * This could be called periodically or during low-traffic times
 */
export async function preWarmEntityMetrics(
  entityType: EntityMetric_EntityType_Type = 'Image',
  limit = 10000
): Promise<void> {
  if (!clickhouse) return;

  log(`Pre-warming cache for top ${limit} entities`);

  try {
    // Get the most accessed entities from the last 24 hours
    const recentEntities = await clickhouse.$query<{ entityId: number }>(`
      SELECT DISTINCT entityId
      FROM entityMetricDailyAgg
      WHERE entityType = '${entityType}'
        AND day >= today() - 1
      ORDER BY entityId DESC
      LIMIT ${limit}
    `);

    const entityIds = recentEntities.map((e) => e.entityId);

    if (entityIds.length > 0) {
      await populateEntityMetrics(entityType, entityIds);
      log(`Pre-warmed cache for ${entityIds.length} entities`);
    }
  } catch (error) {
    log('Error during pre-warming:', error);
  }
}

type ImageMetricLookup = {
  imageId: number;
  reactionLike: number | null;
  reactionHeart: number | null;
  reactionLaugh: number | null;
  reactionCry: number | null;
  comment: number | null;
  collection: number | null;
  buzz: number | null;
};

// Comic metrics come from two watcher handlers and land under two
// `entityType` labels in ClickHouse:
//   * 'Comic'        — comicEngagementHandler (reads / followers / hides)
//   * 'ComicProject' — buzzTipHandler (tip count + amount)
// We unify them under a single 'Comic' Redis key so consumers don't have
// to know which handler emitted which counter. Names are kept verbatim
// from the watcher output so the populator can read straight from
// entityMetricDailyAgg_new without a translation map.
const COMIC_ENTITY_TYPES = ['Comic', 'ComicProject'] as const;
const COMIC_REDIS_TYPE = 'Comic' as EntityMetric_EntityType_Type;

type ComicMetricKey =
  | 'chapterReadCount'
  | 'followerCount'
  | 'hiddenCount'
  | 'readerCount'
  | 'tippedAmount'
  | 'tippedCount';

type ComicMetricLookup = {
  comicId: number;
  chapterReadCount: number | null;
  followerCount: number | null;
  hiddenCount: number | null;
  readerCount: number | null;
  tippedAmount: number | null;
  tippedCount: number | null;
};
// Direct Redis entity metrics fetch with ClickHouse population
// Implements the same interface as CachedObject for compatibility
export const imageMetricsCache: Pick<
  CachedObject<ImageMetricLookup>,
  'fetch' | 'bust' | 'refresh' | 'flush'
> = {
  fetch: async (ids: number | number[]): Promise<Record<string, ImageMetricLookup>> => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return {};

    // Populate missing metrics from ClickHouse (uses per-ID locks internally)
    await populateEntityMetrics('Image', ids);

    // Fetch from Redis
    const metricsMap = await entityMetricRedis.getBulkMetrics('Image', ids);

    const results: Record<string, ImageMetricLookup> = {};
    for (const id of ids) {
      const metrics = metricsMap.get(id);
      results[id] = {
        imageId: id,
        reactionLike: metrics?.ReactionLike || null,
        reactionHeart: metrics?.ReactionHeart || null,
        reactionLaugh: metrics?.ReactionLaugh || null,
        reactionCry: metrics?.ReactionCry || null,
        comment: metrics?.Comment || null,
        collection: metrics?.Collection || null,
        buzz: metrics?.Buzz || null,
      };
    }
    return results;
  },

  bust: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Delete from Redis to force re-fetch from ClickHouse
    await Promise.all(ids.map((id) => entityMetricRedis.delete('Image', id)));
  },

  refresh: async (ids: number | number[], skipCache?: boolean) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;

    // Force refresh from ClickHouse with forceRefresh=true to overwrite existing values
    await populateEntityMetrics('Image', ids, true);
  },

  flush: async () => {
    // Clear all image metrics from Redis - Not Supported
  },
};

/**
 * Mirror of `populateEntityMetrics` for comics: queries the `_new` aggregate
 * (which is the only one carrying non-Image data) for BOTH `Comic` and
 * `ComicProject` entityType rows, then stores everything under the
 * unified `Comic` Redis key. Uses per-id locks like the image path so a
 * burst of requests for the same comic doesn't fan out to ClickHouse.
 */
export async function populateComicMetrics(
  comicIds: number[],
  forceRefresh = false
): Promise<void> {
  if (!clickhouse || comicIds.length === 0) return;

  let idsToProcess = comicIds;

  if (!forceRefresh) {
    const existsChecks = await Promise.all(
      comicIds.map((id) => entityMetricRedis.exists(COMIC_REDIS_TYPE, id))
    );
    idsToProcess = comicIds.filter((_, index) => !existsChecks[index]);
    if (idsToProcess.length === 0) return;
  }

  const lockPrefix = `${REDIS_KEYS.ENTITY_METRICS.BASE}:lock:${COMIC_REDIS_TYPE}`;
  const lockResults = await Promise.all(
    idsToProcess.map((id) => redis.setNX(`${lockPrefix}:${id}` as RedisKeyTemplateCache, '1'))
  );
  const idsToLoad = idsToProcess.filter((_, index) => lockResults[index]);
  const lockedKeys: RedisKeyTemplateCache[] = idsToLoad.map(
    (id) => `${lockPrefix}:${id}` as RedisKeyTemplateCache
  );
  if (lockedKeys.length > 0) {
    await Promise.all(lockedKeys.map((key) => redis.expire(key, 10)));
  }
  if (idsToLoad.length === 0) {
    log(`All ${idsToProcess.length} comics are being loaded by other processes`);
    return;
  }

  try {
    log(
      `${forceRefresh ? 'Refreshing' : 'Loading'} ${idsToLoad.length} comics from ClickHouse (${
        idsToProcess.length - idsToLoad.length
      } handled by other processes)`
    );

    const batches = chunk(idsToLoad, 1000);
    for (const batchIds of batches) {
      // `entityMetricDailyAgg_new` is a materialized view that retains
      // multiple `refreshedAt` snapshots per `(entityId, metricType, day)`.
      // We have to argMax-dedup per day before summing across days, or a
      // refresh that lands while we read will double-count. Same pattern
      // as `getEntityMetricTasks` in src/server/metrics/metric-helpers.ts.
      //
      // Both 'Comic' (engagement counters) and 'ComicProject' (tip
      // counters) buckets are merged into a single per-id totals row so
      // the Redis layer only knows about a unified 'Comic' key.
      const entityTypeList = COMIC_ENTITY_TYPES.map((t) => `'${t}'`).join(',');
      const aggSource = await getEntityMetricAggSource();
      const perDaySource = buildEntityMetricPerDaySource(
        aggSource,
        `WHERE entityType IN (${entityTypeList})
            AND entityId IN (${batchIds.join(',')})`
      );
      const metrics = await clickhouse.$query<MetricData>(`
        SELECT
          entityId,
          metricType,
          sum(total) AS total
        FROM ${perDaySource}
        GROUP BY entityId, metricType
        HAVING total > 0
      `);

      const grouped = new Map<number, Record<EntityMetric_MetricType_Type, number>>();
      for (const metric of metrics) {
        if (!grouped.has(metric.entityId)) {
          grouped.set(metric.entityId, {} as Record<EntityMetric_MetricType_Type, number>);
        }
        grouped.get(metric.entityId)![metric.metricType] = metric.total;
      }

      const promises: Promise<void>[] = [];
      for (const [entityId, m] of grouped.entries()) {
        promises.push(entityMetricRedis.setMultipleMetrics(COMIC_REDIS_TYPE, entityId, m));
      }
      await Promise.all(promises);
    }

    log(`Completed bulk load for ${idsToLoad.length} comics`);
  } catch (error) {
    log('Error during comic bulk population:', error);
  } finally {
    if (lockedKeys.length > 0) {
      await redis.del(lockedKeys);
    }
  }
}

/**
 * Comic equivalent of `imageMetricsCache`. Same shape (`fetch`/`bust`/
 * `refresh`/`flush`) so consumers can swap entity types without learning
 * a new API. Returns one row per requested comic id with each tracked
 * counter normalized to `number | null` (`null` when the row exists in
 * Redis but the counter has no entry).
 */
export const comicMetricsCache: Pick<
  CachedObject<ComicMetricLookup>,
  'fetch' | 'bust' | 'refresh' | 'flush'
> = {
  fetch: async (ids: number | number[]): Promise<Record<string, ComicMetricLookup>> => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return {};

    await populateComicMetrics(ids);
    const metricsMap = await entityMetricRedis.getBulkMetrics(COMIC_REDIS_TYPE, ids);

    const results: Record<string, ComicMetricLookup> = {};
    for (const id of ids) {
      const metrics = metricsMap.get(id);
      const pick = (key: ComicMetricKey): number | null => {
        const v = metrics?.[key];
        return typeof v === 'number' && v !== 0 ? v : v === 0 ? 0 : null;
      };
      results[id] = {
        comicId: id,
        chapterReadCount: pick('chapterReadCount'),
        followerCount: pick('followerCount'),
        hiddenCount: pick('hiddenCount'),
        readerCount: pick('readerCount'),
        tippedAmount: pick('tippedAmount'),
        tippedCount: pick('tippedCount'),
      };
    }
    return results;
  },

  bust: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;
    await Promise.all(ids.map((id) => entityMetricRedis.delete(COMIC_REDIS_TYPE, id)));
  },

  refresh: async (ids: number | number[]) => {
    if (!Array.isArray(ids)) ids = [ids];
    if (ids.length === 0) return;
    await populateComicMetrics(ids, true);
  },

  flush: async () => {
    // Clear all comic metrics from Redis - Not Supported
  },
};

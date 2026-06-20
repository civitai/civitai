import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { createLogger } from '~/utils/logging';
import { buildEntityMetricPerDaySource } from '~/server/flipt/client';
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

// NOTE: the image-legacy read path was removed after the watcher/v2 cutover.
// `populateEntityMetrics`, `preWarmEntityMetrics`, and `imageMetricsCache` (which
// read the in-app `entitymetric:*` Redis cache, populated from ClickHouse's
// legacy `entityMetricDailyAgg` table) are gone. Image metric reads now go
// through the watcher-fed `metrics:*` cache via MetricService. The comic path
// below is unrelated and still uses this file's helpers + entityMetricRedis.

// Comic metrics come from two watcher handlers and land under two
// `entityType` labels in ClickHouse:
//   * 'Comic'        — comicEngagementHandler (reads / followers / hides)
//   * 'ComicProject' — buzzTipHandler (tip count + amount)
// We unify them under a single 'Comic' Redis key so consumers don't have
// to know which handler emitted which counter. Names are kept verbatim
// from the watcher output so the populator can read straight from
// entityMetricDailyAgg_v2 without a translation map.
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
/**
 * Comic metrics populator: queries the entity-metric aggregate for BOTH `Comic`
 * and `ComicProject` entityType rows, then stores everything under the unified
 * `Comic` Redis key. Uses per-id locks so a burst of requests for the same comic
 * doesn't fan out to ClickHouse.
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
      // Reads `entityMetricDailyAgg_v2` (the already-FINAL read view) via the
      // shared `buildEntityMetricPerDaySource` helper — no argMax dedup needed.
      //
      // Both 'Comic' (engagement counters) and 'ComicProject' (tip
      // counters) buckets are merged into a single per-id totals row so
      // the Redis layer only knows about a unified 'Comic' key.
      const entityTypeList = COMIC_ENTITY_TYPES.map((t) => `'${t}'`).join(',');
      const perDaySource = buildEntityMetricPerDaySource(
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
 * Comic entity-metric read cache backed by `entityMetricRedis` + ClickHouse
 * population (via `populateComicMetrics`). Exposes a CachedObject-shaped
 * (`fetch`/`bust`/`refresh`/`flush`) API. Returns one row per requested comic id
 * with each tracked counter normalized to `number | null` (`null` when the row
 * exists in Redis but the counter has no entry).
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

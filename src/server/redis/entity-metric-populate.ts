import { chunk } from 'lodash-es';
import { clickhouse } from '~/server/clickhouse/client';
import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { createLogger } from '~/utils/logging';
import type {
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
} from '~/shared/utils/prisma/enums';

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
          SUM(metricValue) as total
        FROM entityMetricEvents
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
      FROM entityMetricEvents
      WHERE entityType = '${entityType}'
        AND createdAt > now() - INTERVAL 1 DAY
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

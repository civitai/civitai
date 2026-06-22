import { EntityMetric_MetricType_Type } from '~/shared/utils/prisma/enums';
import type { EntityMetric_EntityType_Type } from '~/shared/utils/prisma/enums';
import { clickhouse } from '~/server/clickhouse/client';
import type { ProtectedContext } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { redis, REDIS_KEYS, type RedisKeyTemplateCache } from '~/server/redis/client';
import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import { isFlipt } from '../flipt/client';

const logError = (name: string, details: Record<string, unknown>) => {
  logToAxiom({ type: 'error', name, details }, 'clickhouse').catch(() => {
    // Ignore logging failures
  });
};

const getAllMetricsFromClickHouse = async (
  entityType: EntityMetric_EntityType_Type,
  entityId: number
): Promise<Record<EntityMetric_MetricType_Type, number>> => {
  if (!clickhouse) {
    return {} as Record<EntityMetric_MetricType_Type, number>;
  }

  const cData = await clickhouse.$query<{ metricType: string; total: number }>`
    SELECT metricType, sum(total) as total
    FROM entityMetricDailyAgg_v2
    WHERE entityType = '${entityType}' AND entityId = ${entityId}
    GROUP BY metricType
  `;

  // Initialize all possible metrics to 0
  const metrics: Record<string, number> = {};
  const allMetricTypes: EntityMetric_MetricType_Type[] = Object.values(
    EntityMetric_MetricType_Type
  );
  allMetricTypes.forEach((metricType) => {
    metrics[metricType] = 0;
  });

  // Update with actual values from ClickHouse
  cData?.forEach((row) => {
    if (row.metricType && typeof row.total === 'number') {
      metrics[row.metricType] = row.total;
    }
  });

  return metrics as Record<EntityMetric_MetricType_Type, number>;
};

export const updateEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
  amount = 1,
}: {
  ctx: ProtectedContext;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
  amount?: number;
}) => {
  if (await isFlipt('disable-app-entity-metrics')) return;

  const logData = JSON.stringify({
    userId: ctx.user?.id,
    entityType,
    entityId,
    metricType,
    metricValue: amount,
  });

  // Update Redis EntityMetric
  try {
    // Use existing helper method for consistent key generation
    const key =
      `${REDIS_KEYS.ENTITY_METRICS.BASE}:${entityType}:${entityId}` as RedisKeyTemplateCache;

    // Check if specific metric exists and sync from ClickHouse if missing
    if (clickhouse) {
      const metricExists = await redis.hExists(key, metricType);

      if (!metricExists) {
        const lockKey = `${key}:lock:${metricType}` as RedisKeyTemplateCache;
        const lockAcquired = await redis.setNX(lockKey, '1');

        if (lockAcquired) {
          await redis.expire(lockKey, 5);
          try {
            const allMetrics = await getAllMetricsFromClickHouse(entityType, entityId);
            await entityMetricRedis.setMultipleMetrics(entityType, entityId, allMetrics);
          } catch (error) {
            // Simple error logging - don't block the operation
            logToAxiom(
              {
                type: 'warning',
                name: 'ClickHouse metric sync failed',
                details: { entityType, entityId, metricType },
              },
              'clickhouse'
            ).catch(() => {
              // Ignore logging failures
            });
          } finally {
            await redis.unlink(lockKey);
          }
        }
      }
    }

    // Now perform the atomic increment
    const newValue = await entityMetricRedis.increment(entityType, entityId, metricType, amount);

    // Prevent negative values by checking and correcting if needed
    if (newValue < 0) {
      await entityMetricRedis.setMetric(entityType, entityId, metricType, 0);
    }

    // NOTE: the legacy `imageMetricsCache.bust(entityId)` call was removed here
    // after the watcher/v2 cutover — nothing reads that in-app `entitymetric:*`
    // image read cache anymore (image reads now go through the watcher-fed
    // `metrics:*` MetricService cache). The `entityMetricRedis` increment above
    // and the `ctx.track.entityMetric(...)` emission below are intentionally
    // kept: the latter is what feeds the watcher (reactions -> metrics).
  } catch (e) {
    const error = e as Error;
    logError('Failed to increment metric', {
      data: logData,
      error: error.message,
      cause: error.cause,
      stack: error.stack,
    });
  }

  // Queue with clickhouse tracker
  try {
    await ctx.track.entityMetric({ entityType, entityId, metricType, metricValue: amount });
  } catch (e) {
    const error = e as Error;
    logError('Failed to queue metric into CH', {
      data: logData,
      error: error.message,
      cause: error.cause,
      stack: error.stack,
    });
  }
};

export const incrementEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
}: {
  ctx: ProtectedContext;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
}) => {
  await updateEntityMetric({ ctx, entityType, entityId, metricType, amount: 1 });
};

export const decrementEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
}: {
  ctx: ProtectedContext;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
}) => {
  await updateEntityMetric({ ctx, entityType, entityId, metricType, amount: -1 });
};

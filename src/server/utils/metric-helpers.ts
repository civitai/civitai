import type {
  EntityMetric_EntityType_Type,
  EntityMetric_MetricType_Type,
} from '~/shared/utils/prisma/enums';
import { clickhouse } from '~/server/clickhouse/client';
import type { Context } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { redis, type RedisKeyTemplateCache } from '~/server/redis/client';
import { imageMetricsCache } from '~/server/redis/caches';
import { entityMetricRedis } from '~/server/redis/entity-metric.redis';
import FliptSingleton, { FLIPT_FEATURE_FLAGS } from '../flipt/client';

export const updateEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
  amount = 1,
}: {
  ctx: DeepNonNullable<Context>;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
  amount?: number;
}) => {
  const logData = JSON.stringify({
    userId: ctx.user?.id,
    entityType,
    entityId,
    metricType,
    metricValue: amount,
  });

  // Update Redis EntityMetric
  try {
    // Atomic increment in Redis
    const newValue = await entityMetricRedis.increment(
      entityType,
      entityId,
      metricType,
      amount
    );

    // If this is the first write (value equals amount), check ClickHouse for existing data
    // This handles the case where Redis doesn't have the data yet
    if (newValue === amount && amount > 0 && clickhouse) {
      // Use a distributed lock to prevent concurrent ClickHouse queries for the same metric
      const lockKey = `entitymetric:lock:${entityType}:${entityId}:${metricType}` as RedisKeyTemplateCache;
      const lockAcquired = await redis.setNX(lockKey, '1');

      if (lockAcquired) {
        try {
          // Set a short TTL on the lock (5 seconds)
          await redis.expire(lockKey, 5);

          // Double-check the value hasn't been set by another process
          const currentValue = await entityMetricRedis.getMetric(entityType, entityId, metricType);
          if (currentValue === amount) {
            const cData = await clickhouse.$query<{ total: number }>(`
              SELECT sum(metricValue) as total
              FROM entityMetricEvents
              WHERE entityType = '${entityType}' AND entityId = ${entityId} AND metricType = '${metricType}'
            `);
            const existingVal = cData?.[0]?.total ?? 0;

            if (existingVal > 0) {
              // Set to correct value if we have historical data
              await entityMetricRedis.setMetric(
                entityType,
                entityId,
                metricType,
                existingVal + amount
              );
            }
          }
        } finally {
          // Release the lock
          await redis.del(lockKey);
        }
      }
      // If we couldn't acquire the lock, another process is handling it
    }

    if (entityType === 'Image') {
      let shouldBustCache = true;
      const fliptClient = await FliptSingleton.getInstance();
      if (fliptClient) {
        const flag = fliptClient.evaluateBoolean({
          flagKey: FLIPT_FEATURE_FLAGS.ENTITY_METRIC_NO_CACHE_BUST,
          entityId: ctx.user?.id.toString() || 'anonymous',
          context: {},
        });
        shouldBustCache = !flag.enabled;
      }

      if (shouldBustCache) {
        await imageMetricsCache.bust(entityId);
      }
    }
  } catch (e) {
    const error = e as Error;
    // putting this into the clickhouse dataset for now
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to increment metric',
        details: { data: logData },
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'clickhouse'
    ).catch();
  }

  // Queue with clickhouse tracker
  try {
    await ctx.track.entityMetric({ entityType, entityId, metricType, metricValue: amount });
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to queue metric into CH',
        details: { data: logData },
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'clickhouse'
    ).catch();
  }
};

export const incrementEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
}: {
  ctx: DeepNonNullable<Context>;
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
  ctx: DeepNonNullable<Context>;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
}) => {
  await updateEntityMetric({ ctx, entityType, entityId, metricType, amount: -1 });
};

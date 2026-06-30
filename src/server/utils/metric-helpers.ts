import type { EntityMetric_MetricType_Type } from '~/shared/utils/prisma/enums';
import type { EntityMetric_EntityType_Type } from '~/shared/utils/prisma/enums';
import type { ProtectedContext } from '~/server/createContext';
import { logToAxiom } from '~/server/logging/client';
import { isFlipt } from '../flipt/client';

const logError = (name: string, details: Record<string, unknown>) => {
  logToAxiom({ type: 'error', name, details }, 'clickhouse').catch(() => {
    // Ignore logging failures
  });
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

  // NOTE: the legacy `entityMetricRedis` increment + CH-sync-on-miss block that
  // used to live here was removed after the v2 + watcher cutover went permanent
  // (v5.0.1871). It wrote the in-app `entitymetric:Image:*` Redis cache, which
  // nothing reads anymore — image metric reads go through the watcher-fed
  // `metrics:*` cache via MetricService (`getImageMetricsObject`,
  // `bitdex-stats.ts`). Comics no longer use this path either: every comic counter
  // (incl. reads) is now Postgres-owned via `ComicProjectMetric`, and the old
  // `entitymetric:Comic:*` Redis cache + its populator were removed.
  //
  // The `ctx.track.entityMetric(...)` emission below is intentionally KEPT: it is
  // the Kafka event that feeds the watcher (reactions/comments/collects/buzz ->
  // metrics). It is the entire metric pipeline — do not remove it.

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

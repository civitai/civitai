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

/**
 * What this helper actually needs, which is the tracker and — for the error log
 * only — who did it.
 *
 * Widened from `ProtectedContext` so a metric can be emitted from a settlement
 * that no request is waiting on: a sticker placement is approved from a review
 * queue, from an auto-approving space, and from a bulk action, and the money it
 * moves is the same money in each. Narrowing to a request context would mean
 * emitting the metric at three call sites that happen to have one, and silently
 * not emitting it wherever a job settles the same placement.
 */
type EntityMetricContext = { track: ProtectedContext['track']; user?: { id: number } | null };

export const updateEntityMetric = async ({
  ctx,
  entityType = 'Image',
  entityId,
  metricType,
  amount = 1,
  awaitDelivery = false,
}: {
  ctx: EntityMetricContext;
  entityType?: EntityMetric_EntityType_Type;
  entityId: number;
  metricType: EntityMetric_MetricType_Type;
  amount?: number;
  /**
   * Wait for the tracker to accept the row, and raise if it does not.
   *
   * For a caller that records afterwards that this counter moved. The default
   * dispatches and returns, so `await` on this function otherwise says the
   * event was *sent*, not that it arrived — a caller that wrote "counted" off
   * that would bury a dropped event under a record saying it was fine.
   */
  awaitDelivery?: boolean;
}): Promise<boolean> => {
  // Reported rather than swallowed: with the flag on nothing is counted, and a
  // caller that stamped the row anyway would lose the whole window's placements
  // instead of counting them when it comes back off.
  if (await isFlipt('disable-app-entity-metrics')) return false;

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
    await ctx.track.entityMetric(
      { entityType, entityId, metricType, metricValue: amount },
      { awaitDelivery }
    );
    return true;
  } catch (e) {
    const error = e as Error;
    logError('Failed to queue metric into CH', {
      data: logData,
      error: error.message,
      cause: error.cause,
      stack: error.stack,
    });
    // Swallowed for the fire-and-forget callers, who have nothing to do with
    // it. A caller that asked to wait is deciding something on the answer.
    if (awaitDelivery) throw error;
    return false;
  }
};

/**
 * The same emission, for a caller with no request behind it.
 *
 * The tracker is pulled in dynamically rather than imported at the top of this
 * module: `~/server/clickhouse/client` is a heavy graph to attach to every
 * module that only wants to move a counter, and importing it statically from a
 * service drags it into that service's tests, where it is neither mocked nor
 * wanted. Loaded once by the module cache on first use.
 */
export const updateEntityMetricDetached = async ({
  userId,
  ...input
}: Omit<Parameters<typeof updateEntityMetric>[0], 'ctx'> & {
  /**
   * Who caused it. Worth threading through rather than letting a request-less
   * `Tracker` default to 0: `userId` is part of the dedupe key the metric
   * pipeline replaces rows on, so several events attributed to the same
   * non-user, on the same entity and metric, within the same millisecond
   * collapse into one and silently undercount. A real id makes them distinct
   * for the same reason a tip's does.
   */
  userId?: number;
}) => {
  const { Tracker } = await import('~/server/clickhouse/client');
  const track = new Tracker(
    undefined,
    undefined,
    userId ? ({ user: { id: userId } } as ConstructorParameters<typeof Tracker>[2]) : undefined
  );
  return updateEntityMetric({ ...input, ctx: { track } });
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

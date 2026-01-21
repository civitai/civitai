import { useMemo } from 'react';
import { useMetricSignalsStore } from '~/store/metric-signals.store';
import type { MetricEntityType, MetricType } from '~/components/Signals/metric-signals.types';
import { useLiveMetricsEnabled } from './MetricSubscriptionProvider';

type MetricsInput = Partial<Record<MetricType, number | undefined>>;

/**
 * Hook for components that display multiple metrics.
 * Works with MetricSubscriptionProvider for in-view subscription,
 * or can be used standalone if subscription is handled elsewhere.
 *
 * Deltas are always applied regardless of subscription state
 * (they persist in the store from when the card was visible).
 *
 * @example
 * ```tsx
 * const liveMetrics = useLiveMetrics('Model', data.id, {
 *   downloadCount: data.rank?.downloadCount ?? 0,
 *   thumbsUpCount: data.rank?.thumbsUpCount ?? 0,
 * });
 * // Use liveMetrics.downloadCount, liveMetrics.thumbsUpCount
 * ```
 */
export function useLiveMetrics<T extends MetricsInput>(
  entityType: MetricEntityType,
  entityId: number | undefined,
  baseMetrics: T
): T {
  const featureEnabled = useLiveMetricsEnabled();

  // Get all relevant deltas from store (only when feature is enabled)
  const deltas = useMetricSignalsStore((state) => {
    if (!featureEnabled || !entityId) return {} as Partial<Record<MetricType, number>>;
    const result: Partial<Record<MetricType, number>> = {};
    for (const metricType of Object.keys(baseMetrics) as MetricType[]) {
      result[metricType] = state.getDelta(entityType, entityId, metricType);
    }
    return result;
  });

  // Apply deltas to base metrics
  return useMemo(() => {
    if (!featureEnabled || !entityId) return baseMetrics;

    const result = { ...baseMetrics } as T;
    for (const key of Object.keys(baseMetrics) as MetricType[]) {
      const baseValue = (baseMetrics as MetricsInput)[key] ?? 0;
      const delta = deltas[key] || 0;
      (result as MetricsInput)[key] = baseValue + delta;
    }
    return result;
  }, [featureEnabled, entityId, baseMetrics, deltas]);
}

/**
 * Hook for getting a single live metric value.
 *
 * @example
 * ```tsx
 * const downloadCount = useLiveMetric('Model', data.id, 'downloadCount', data.rank?.downloadCount ?? 0);
 * ```
 */
export function useLiveMetric(
  entityType: MetricEntityType,
  entityId: number | undefined,
  metricType: MetricType,
  baseValue = 0
): number {
  const featureEnabled = useLiveMetricsEnabled();
  const delta = useMetricSignalsStore((state) =>
    featureEnabled && entityId ? state.getDelta(entityType, entityId, metricType) : 0
  );
  return baseValue + delta;
}
